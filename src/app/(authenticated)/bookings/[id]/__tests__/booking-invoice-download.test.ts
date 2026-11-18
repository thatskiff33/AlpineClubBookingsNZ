import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #5066 slice 1: the booking page's Download invoice and credit-note downloads —
 * who is offered them, for which bookings, and what a download does. The real
 * `resolveBookingDetailViewer` runs, so the audience is the page's own
 * `canSeeOwnerCredit` answer rather than a mocked one.
 */
vi.mock("server-only", () => ({}));
vi.mock("@/lib/xero-api-client", () => ({ callXeroApi: vi.fn(), getAuthenticatedXeroClient: vi.fn() }));
vi.mock("@/lib/xero-token-store", () => ({ isXeroConnected: vi.fn() }));
vi.mock("@/lib/booking-supplementary-invoice-identities", () => ({
  bookingHasAnySupplementaryInvoiceEvidence: vi.fn(),
}));
vi.mock("../_lib/load-booking-detail", () => ({ loadBookingDetail: vi.fn() }));
vi.mock("@/lib/module-settings", () => ({ loadEffectiveModuleFlags: vi.fn() }));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));
vi.mock("@/lib/booking-credit-notes", () => ({ readBookingCreditNotes: vi.fn() }));
vi.mock("@/lib/club-identity-settings", () => ({ getClubIdentity: vi.fn() }));

import {
  bookingInvoiceFileName,
  prepareBookingInvoiceDownload,
  resolveBookingInvoiceOffer,
} from "../_lib/booking-invoice-download";
import { resolveBookingDetailViewer } from "../_lib/booking-detail-viewer";
import { createAuditLog } from "@/lib/audit";
import { readBookingCreditNotes } from "@/lib/booking-credit-notes";
import { getClubIdentity } from "@/lib/club-identity-settings";
import { bookingHasAnySupplementaryInvoiceEvidence } from "@/lib/booking-supplementary-invoice-identities";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { isXeroConnected } from "@/lib/xero-token-store";
import { loadBookingDetail } from "../_lib/load-booking-detail";

const OWNER_ID = "owner-1";

function booking(overrides: Record<string, unknown> = {}, payment: Record<string, unknown> = {}) {
  return {
    id: "ckbooking1234567",
    memberId: OWNER_ID,
    member: { id: OWNER_ID, firstName: "Ada", lastName: "Owner" },
    organisationId: null,
    organisation: null,
    deletedAt: null,
    status: "CONFIRMED",
    organiserSettled: false,
    parentBookingId: null,
    guests: [{ memberId: "guest-1", consentStatus: "ACCEPTED" }],
    modifications: [{ id: "mod-1" }],
    payment: {
      id: "payment-1",
      source: "STRIPE",
      xeroInvoiceId: "xero-primary-id",
      xeroInvoiceNumber: "INV-0042",
      transactions: [],
      ...payment,
    },
    ...overrides,
  } as never;
}

const session = (id: string, role: string) =>
  ({ user: { id, role: role === "ADMIN" ? "ADMIN" : "MEMBER", accessRoles: [{ role }] } }) as never;

const viewerFor = (b: never, id: string, role: string) =>
  resolveBookingDetailViewer({ session: session(id, role), booking: b });

const CREDIT_NOTE = { creditNoteId: "xero-cn-1", creditNoteNumber: "CN-0007", kind: "CHANGE" as const };
const noSupplementary = {
  hasAnySupplementaryInvoice: vi.fn(async () => false),
  creditNotes: vi.fn(async () => [CREDIT_NOTE]),
};
const XERO_ON = { xeroIntegration: true };
const ON_OFFER = { kind: "XERO_INVOICE", invoiceNumber: "INV-0042", creditNotes: [CREDIT_NOTE] };

function offer(b: never, id = OWNER_ID, role = "USER", modules = XERO_ON, deps = noSupplementary) {
  return resolveBookingInvoiceOffer({ booking: b, viewer: viewerFor(b, id, role), modules }, deps);
}

describe("resolveBookingInvoiceOffer: the one rule for the button and the route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("offers the primary Xero invoice to the owner, an officer and a full admin", async () => {
    for (const [id, role] of [[OWNER_ID, "USER"], ["officer-1", "ADMIN_BOOKINGS"], ["admin-1", "ADMIN"]]) {
      expect(await offer(booking(), id, role)).toEqual(ON_OFFER);
    }
  });

  it("follows bookings-area view: a Read-only Admin and a membership officer are offered it, a content officer is not", async () => {
    // ADMIN_MEMBERSHIP's seeded bundle carries bookings:view (and finance:view), so
    // the page already shows it the owner's money; one audience, not a second rule.
    expect(await offer(booking(), "readonly-1", "ADMIN_READONLY")).toEqual(ON_OFFER);
    expect(await offer(booking(), "membership-1", "ADMIN_MEMBERSHIP")).toEqual(ON_OFFER);
    expect(await offer(booking(), "content-1", "ADMIN_CONTENT")).toEqual({ kind: "NONE" });
  });

  it("offers nothing to a linked guest or a stranger (the owner-credit audience)", async () => {
    expect(await offer(booking(), "guest-1", "USER")).toEqual({ kind: "NONE" });
    expect(await offer(booking(), "stranger-1", "USER")).toEqual({ kind: "NONE" });
    expect(noSupplementary.hasAnySupplementaryInvoice).not.toHaveBeenCalled();
    expect(noSupplementary.creditNotes).not.toHaveBeenCalled();
  });

  it("lists the booking's credit notes from its own anchors: booking, payment, modifications and owner", async () => {
    await offer(booking());
    expect(noSupplementary.creditNotes).toHaveBeenCalledWith({
      id: "ckbooking1234567",
      paymentId: "payment-1",
      ownerMemberId: OWNER_ID,
      modificationIds: ["mod-1"],
    });
  });

  it("keeps offering the invoice when credit notes exist, rather than asking the club (owner decision, 17 Nov 2026)", async () => {
    expect(await offer(booking())).toMatchObject({ kind: "XERO_INVOICE", creditNotes: [CREDIT_NOTE] });
  });

  it("offers nothing while the club's Xero module is off", async () => {
    expect(await offer(booking(), OWNER_ID, "USER", { xeroIntegration: false })).toEqual({ kind: "NONE" });
  });

  it("offers nothing on a cancelled or bumped booking", async () => {
    expect(await offer(booking({ status: "CANCELLED" }))).toEqual({ kind: "NONE" });
    expect(await offer(booking({ status: "BUMPED" }))).toEqual({ kind: "NONE" });
  });

  it("offers nothing on a deleted booking, which is always a cancelled one, even to a full admin", async () => {
    const deleted = booking({ status: "CANCELLED", deletedAt: new Date("2026-06-30T00:00:00.000Z") });
    expect(await offer(deleted, "admin-1", "ADMIN")).toEqual({ kind: "NONE" });
  });

  it("offers nothing when no Xero invoice is on record", async () => {
    expect(await offer(booking({}, { xeroInvoiceId: null }))).toEqual({ kind: "NONE" });
    expect(await offer(booking({ payment: null }))).toEqual({ kind: "NONE" });
  });

  it("offers nothing on a place the organiser paid by internet banking (INV-PAY-148)", async () => {
    const place = booking({ organiserSettled: true, parentBookingId: "organiser-booking" }, { source: "INTERNET_BANKING" });
    expect(await offer(place)).toEqual({ kind: "NONE" });
  });

  it("asks the member to contact the club when the payment has any additional ask", async () => {
    const asked = booking({}, { transactions: [{ withdrawnAt: new Date("2026-06-30T00:00:00.000Z") }] });
    expect(await offer(asked)).toEqual({ kind: "ASK_CLUB", staffViewer: false });
    expect(noSupplementary.hasAnySupplementaryInvoice).not.toHaveBeenCalled();
    expect(noSupplementary.creditNotes).not.toHaveBeenCalled();
  });

  it("frames the further-invoice line for staff on someone else's booking, not as the booker", async () => {
    const asked = booking({}, { transactions: [{}] });
    expect(await offer(asked, "officer-1", "ADMIN_BOOKINGS")).toEqual({ kind: "ASK_CLUB", staffViewer: true });
    expect(await offer(asked, "readonly-1", "ADMIN_READONLY")).toEqual({ kind: "ASK_CLUB", staffViewer: true });
  });

  it("asks the member to contact the club when any supplementary invoice exists — a card receipt with no ADDITIONAL row included", async () => {
    const receiptOnly = { hasAnySupplementaryInvoice: vi.fn(async () => true), creditNotes: vi.fn(async () => []) };
    expect(await offer(booking(), OWNER_ID, "USER", XERO_ON, receiptOnly)).toEqual({ kind: "ASK_CLUB", staffViewer: false });
    expect(receiptOnly.hasAnySupplementaryInvoice).toHaveBeenCalledWith("ckbooking1234567");
  });
});

describe("bookingInvoiceFileName", () => {
  it("names the file with the club's short name and the Xero number, header-safe (INV-CONFIG-001)", () => {
    expect(bookingInvoiceFileName("TAC", "ckbooking1234567", { kind: "INVOICE", number: "INV-0042" })).toBe("tac-invoice-INV-0042.pdf");
    expect(bookingInvoiceFileName("TAC", "ckbooking1234567", { kind: "INVOICE", number: 'INV "1"\r\n' })).toBe("tac-invoice-INV--1-.pdf");
    expect(bookingInvoiceFileName("Mt Ruapehu SC", "ckbooking1234567", { kind: "CREDIT_NOTE", number: "CN-0007" })).toBe(
      "mt-ruapehu-sc-credit-note-CN-0007.pdf",
    );
  });

  it("falls back to the booking reference when Xero gave no number", () => {
    expect(bookingInvoiceFileName("TAC", "ckbooking1234567", { kind: "CREDIT_NOTE", number: null })).toMatch(/^tac-credit-note-[A-Za-z0-9._-]+\.pdf$/);
  });
});

describe("prepareBookingInvoiceDownload", () => {
  const pdf = Buffer.from("%PDF-1.4");
  function deps(overrides: Record<string, unknown> = {}) {
    return {
      loadBooking: vi.fn(async () => booking()),
      modules: vi.fn(async () => XERO_ON),
      offer: (input: Parameters<typeof resolveBookingInvoiceOffer>[0]) => resolveBookingInvoiceOffer(input, noSupplementary),
      xeroConnected: vi.fn(async () => true),
      clubShortName: vi.fn(async () => "TAC"),
      fetchXeroInvoicePdf: vi.fn(async () => pdf),
      fetchXeroCreditNotePdf: vi.fn(async () => pdf),
      writeAudit: vi.fn(async () => undefined),
      ...overrides,
    } as never as NonNullable<Parameters<typeof prepareBookingInvoiceDownload>[4]>;
  }
  const allowed = { success: true, remaining: 19, resetAt: 0 };
  const chargeBookingLimit = vi.fn(async () => allowed);
  const request = { ipAddress: "203.0.113.9", chargeBookingLimit };
  const INVOICE = { kind: "INVOICE" } as const;
  const creditNote = (creditNoteId: string) => ({ kind: "CREDIT_NOTE", creditNoteId }) as const;

  beforeEach(() => vi.clearAllMocks());

  it("returns Xero's PDF of the booking's own primary invoice and writes one audit row after the read", async () => {
    const d = deps();
    const result = await prepareBookingInvoiceDownload("ckbooking1234567", session(OWNER_ID, "USER"), INVOICE, request, d);
    expect(result).toEqual({ kind: "PDF", body: pdf, fileName: "tac-invoice-INV-0042.pdf" });
    expect(d.fetchXeroInvoicePdf).toHaveBeenCalledWith("xero-primary-id");
    expect(d.writeAudit).toHaveBeenCalledTimes(1);
    expect(d.writeAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "booking.invoice.downloaded",
      category: "booking",
      actorMemberId: OWNER_ID,
      subjectMemberId: OWNER_ID,
      entityType: "Booking",
      entityId: "ckbooking1234567",
      ipAddress: "203.0.113.9",
      metadata: { bookingId: "ckbooking1234567", source: "XERO", xeroInvoiceNumber: "INV-0042", onBehalf: false },
    }));
    const fetchOrder = (d.fetchXeroInvoicePdf as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const auditOrder = (d.writeAudit as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(fetchOrder).toBeLessThan(auditOrder);
  });

  it("marks an officer's download as on behalf of the owner", async () => {
    const d = deps();
    await prepareBookingInvoiceDownload("ckbooking1234567", session("officer-1", "ADMIN_BOOKINGS"), INVOICE, request, d);
    expect(d.writeAudit).toHaveBeenCalledWith(expect.objectContaining({
      actorMemberId: "officer-1",
      subjectMemberId: OWNER_ID,
      metadata: expect.objectContaining({ onBehalf: true }),
    }));
  });

  it.each([
    ["a linked guest", booking(), "guest-1", XERO_ON],
    ["a stranger", booking(), "stranger-1", XERO_ON],
    ["Xero off", booking(), OWNER_ID, { xeroIntegration: false }],
    ["a cancelled booking", booking({ status: "CANCELLED" }), OWNER_ID, XERO_ON],
    ["a booking with a further invoice", booking({}, { transactions: [{}] }), OWNER_ID, XERO_ON],
  ])("refuses %s as not found, with no Xero read and no audit row", async (_label, b, id, modules) => {
    const d = deps({ loadBooking: vi.fn(async () => b), modules: vi.fn(async () => modules) });
    const result = await prepareBookingInvoiceDownload("ckbooking1234567", session(id as string, "USER"), INVOICE, request, d);
    expect(result).toEqual({ kind: "NOT_FOUND" });
    expect(d.fetchXeroInvoicePdf).not.toHaveBeenCalled();
    expect(d.writeAudit).not.toHaveBeenCalled();
    // L2: an unauthorised caller never spends the booking's allowance.
    expect(chargeBookingLimit).not.toHaveBeenCalled();
  });

  it("downloads a credit note the booking lists, with its own audit row and club-named file", async () => {
    const d = deps();
    const result = await prepareBookingInvoiceDownload("ckbooking1234567", session("officer-1", "ADMIN_BOOKINGS"), creditNote("xero-cn-1"), request, d);
    expect(result).toEqual({ kind: "PDF", body: pdf, fileName: "tac-credit-note-CN-0007.pdf" });
    expect(d.fetchXeroCreditNotePdf).toHaveBeenCalledWith("xero-cn-1");
    expect(d.fetchXeroInvoicePdf).not.toHaveBeenCalled();
    expect(chargeBookingLimit).toHaveBeenCalledTimes(1);
    expect(d.writeAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "booking.credit_note.downloaded",
      category: "booking",
      actorMemberId: "officer-1",
      subjectMemberId: OWNER_ID,
      metadata: { bookingId: "ckbooking1234567", source: "XERO", xeroCreditNoteNumber: "CN-0007", creditNoteKind: "CHANGE", onBehalf: true },
    }));
  });

  it("refuses a credit note id the booking does not list, before any limit, Xero read or audit", async () => {
    const d = deps();
    const result = await prepareBookingInvoiceDownload("ckbooking1234567", session(OWNER_ID, "USER"), creditNote("someone-elses-note"), request, d);
    expect(result).toEqual({ kind: "NOT_FOUND" });
    expect(chargeBookingLimit).not.toHaveBeenCalled();
    expect(d.fetchXeroCreditNotePdf).not.toHaveBeenCalled();
    expect(d.writeAudit).not.toHaveBeenCalled();
  });

  it.each([
    ["a linked guest", "guest-1"],
    ["a stranger", "stranger-1"],
  ])("refuses a listed credit note to %s", async (_label, id) => {
    const d = deps();
    expect(await prepareBookingInvoiceDownload("ckbooking1234567", session(id, "USER"), creditNote("xero-cn-1"), request, d)).toEqual({ kind: "NOT_FOUND" });
    expect(d.fetchXeroCreditNotePdf).not.toHaveBeenCalled();
    expect(chargeBookingLimit).not.toHaveBeenCalled();
  });

  it("charges the per-booking limit only once on offer, and stops before Xero when it is spent", async () => {
    const spent = { success: false, remaining: 0, resetAt: 60_000 };
    const d = deps();
    const result = await prepareBookingInvoiceDownload("ckbooking1234567", session(OWNER_ID, "USER"), INVOICE, { ipAddress: null, chargeBookingLimit: vi.fn(async () => spent) }, d);
    expect(result).toEqual({ kind: "RATE_LIMITED", limit: spent });
    expect(d.xeroConnected).not.toHaveBeenCalled();
    expect(d.fetchXeroInvoicePdf).not.toHaveBeenCalled();
    expect(d.writeAudit).not.toHaveBeenCalled();
  });

  it("refuses a booking that does not exist", async () => {
    const d = deps({ loadBooking: vi.fn(async () => null) });
    expect(await prepareBookingInvoiceDownload("missing", session(OWNER_ID, "USER"), INVOICE, request, d)).toEqual({ kind: "NOT_FOUND" });
  });

  it("says Xero is not connected without calling it", async () => {
    const d = deps({ xeroConnected: vi.fn(async () => false) });
    expect(await prepareBookingInvoiceDownload("ckbooking1234567", session(OWNER_ID, "USER"), INVOICE, request, d)).toEqual({ kind: "XERO_NOT_CONNECTED" });
    expect(d.fetchXeroInvoicePdf).not.toHaveBeenCalled();
    expect(d.writeAudit).not.toHaveBeenCalled();
  });

  it("reports a failed or empty Xero read, writing no audit row", async () => {
    for (const fetchXeroInvoicePdf of [vi.fn(async () => { throw new Error("503"); }), vi.fn(async () => Buffer.alloc(0))]) {
      const d = deps({ fetchXeroInvoicePdf });
      expect(await prepareBookingInvoiceDownload("ckbooking1234567", session(OWNER_ID, "USER"), INVOICE, request, d)).toEqual({ kind: "XERO_UNAVAILABLE" });
      expect(d.writeAudit).not.toHaveBeenCalled();
    }
  });

  it("withholds the PDF when the audit row cannot be written", async () => {
    const d = deps({ writeAudit: vi.fn(async () => { throw new Error("db down"); }) });
    expect(await prepareBookingInvoiceDownload("ckbooking1234567", session(OWNER_ID, "USER"), INVOICE, request, d)).toEqual({ kind: "AUDIT_FAILED" });
  });

  it("records no subject member on an organisation-owned booking (INV-PRIV-019)", async () => {
    const school = booking({ memberId: null, member: null, organisationId: "org-1", organisation: { name: "School", email: null } });
    const d = deps({ loadBooking: vi.fn(async () => school) });
    const result = await prepareBookingInvoiceDownload("ckbooking1234567", session("officer-1", "ADMIN_BOOKINGS"), INVOICE, request, d);
    expect(result).toMatchObject({ kind: "PDF" });
    expect(d.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ subjectMemberId: null }));
  });
});

describe("prepareBookingInvoiceDownload with its real dependencies", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads Xero's PDF once through the metered client: no retries, no breaker arming", async () => {
    const getInvoiceAsPdf = vi.fn(async () => ({ body: Buffer.from("%PDF-1.4") }));
    vi.mocked(loadBookingDetail).mockResolvedValue(booking());
    vi.mocked(loadEffectiveModuleFlags).mockResolvedValue({ xeroIntegration: true } as never);
    vi.mocked(bookingHasAnySupplementaryInvoiceEvidence).mockResolvedValue(false);
    vi.mocked(isXeroConnected).mockResolvedValue(true);
    vi.mocked(getAuthenticatedXeroClient).mockResolvedValue({ xero: { accountingApi: { getInvoiceAsPdf } }, tenantId: "tenant-1" } as never);
    vi.mocked(callXeroApi).mockImplementation(async (call: () => Promise<unknown>) => call() as never);
    vi.mocked(readBookingCreditNotes).mockResolvedValue([]);
    vi.mocked(getClubIdentity).mockResolvedValue({ shortName: "TAC" } as never);

    const result = await prepareBookingInvoiceDownload("ckbooking1234567", session(OWNER_ID, "USER"), { kind: "INVOICE" }, { ipAddress: null, chargeBookingLimit: async () => ({ success: true, remaining: 1, resetAt: 0 }) });

    expect(result).toMatchObject({ kind: "PDF", fileName: "tac-invoice-INV-0042.pdf" });
    expect(getInvoiceAsPdf).toHaveBeenCalledWith("tenant-1", "xero-primary-id");
    expect(callXeroApi).toHaveBeenCalledTimes(1);
    expect(vi.mocked(callXeroApi).mock.calls[0][1]).toEqual({
      operation: "getInvoiceAsPdf",
      resourceType: "INVOICE",
      workflow: "bookingInvoiceDownload",
      maxRetries: 0,
      maxTransientRetries: 0,
      maxWaitSec: 0,
      armTransientBreaker: false,
    });
    expect(createAuditLog).toHaveBeenCalledTimes(1);
  });

  it("reads a credit note's PDF through the CreditNotes endpoint, the same metered way", async () => {
    const getCreditNoteAsPdf = vi.fn(async () => ({ body: Buffer.from("%PDF-1.4") }));
    vi.mocked(loadBookingDetail).mockResolvedValue(booking());
    vi.mocked(loadEffectiveModuleFlags).mockResolvedValue({ xeroIntegration: true } as never);
    vi.mocked(bookingHasAnySupplementaryInvoiceEvidence).mockResolvedValue(false);
    vi.mocked(readBookingCreditNotes).mockResolvedValue([CREDIT_NOTE]);
    vi.mocked(isXeroConnected).mockResolvedValue(true);
    vi.mocked(getClubIdentity).mockResolvedValue({ shortName: "TAC" } as never);
    vi.mocked(getAuthenticatedXeroClient).mockResolvedValue({ xero: { accountingApi: { getCreditNoteAsPdf } }, tenantId: "tenant-1" } as never);
    vi.mocked(callXeroApi).mockImplementation(async (call: () => Promise<unknown>) => call() as never);

    const result = await prepareBookingInvoiceDownload(
      "ckbooking1234567",
      session(OWNER_ID, "USER"),
      { kind: "CREDIT_NOTE", creditNoteId: "xero-cn-1" },
      { ipAddress: null, chargeBookingLimit: async () => ({ success: true, remaining: 1, resetAt: 0 }) },
    );

    expect(result).toMatchObject({ kind: "PDF", fileName: "tac-credit-note-CN-0007.pdf" });
    expect(getCreditNoteAsPdf).toHaveBeenCalledWith("tenant-1", "xero-cn-1");
    expect(vi.mocked(callXeroApi).mock.calls[0][1]).toEqual({
      operation: "getCreditNoteAsPdf",
      resourceType: "CREDIT_NOTE",
      workflow: "bookingInvoiceDownload",
      maxRetries: 0,
      maxTransientRetries: 0,
      maxWaitSec: 0,
      armTransientBreaker: false,
    });
  });
});
