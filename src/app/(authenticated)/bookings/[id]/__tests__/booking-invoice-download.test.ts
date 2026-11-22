import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #5066: the booking page's Download invoice and credit-note downloads —
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
vi.mock("@/lib/module-settings", () => ({ loadEffectiveModuleFlagsStrict: vi.fn() }));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));
vi.mock("@/lib/booking-credit-notes", () => ({ readBookingCreditNotes: vi.fn() }));
vi.mock("@/lib/club-identity-settings", () => ({ getClubIdentity: vi.fn() }));

import {
  BookingInvoiceSettingsUnavailableError,
  bookingInvoiceFileName,
  prepareBookingInvoiceDownload,
  resolveBookingInvoiceOffer,
} from "../_lib/booking-invoice-download";
import { resolveBookingDetailViewer } from "../_lib/booking-detail-viewer";
import { BookingInvoiceNotAvailableError } from "@/lib/booking-invoice";
import { createAuditLog } from "@/lib/audit";
import { readBookingCreditNotes } from "@/lib/booking-credit-notes";
import { getClubIdentity } from "@/lib/club-identity-settings";
import { bookingHasAnySupplementaryInvoiceEvidence } from "@/lib/booking-supplementary-invoice-identities";
import { loadEffectiveModuleFlagsStrict } from "@/lib/module-settings";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { isXeroConnected } from "@/lib/xero-token-store";
import { loadBookingDetail } from "../_lib/load-booking-detail";

const OWNER_ID = "owner-1";
const GUEST = {
  memberId: "guest-1",
  consentStatus: "ACCEPTED",
  firstName: "Tama",
  lastName: "Guest",
  ageTier: "ADULT",
  isMember: true,
  priceCents: 20_000,
  nights: [
    { stayDate: new Date("2026-08-03T00:00:00.000Z"), priceCents: 10_000 },
    { stayDate: new Date("2026-08-04T00:00:00.000Z"), priceCents: 10_000 },
  ],
};

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
    // The stored figures the generated document (Xero off) prints: one guest, two nights.
    checkIn: new Date("2026-08-03T00:00:00.000Z"),
    checkOut: new Date("2026-08-05T00:00:00.000Z"),
    finalPriceCents: 20_000,
    promoAdjustmentCents: 0,
    promoRedemptions: [],
    groupBookingAsOrganiser: null,
    lodge: { name: "Summit Lodge" },
    guests: [GUEST],
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
/** The tax period at the booking's anchor: a club that never recorded a status (the code baseline). */
const NO_RECORDED_STATUS = { recorded: false, registered: true };
const RECORDED_REGISTERED = { recorded: true, registered: true };
const RECORDED_NOT_REGISTERED = { recorded: true, registered: false };
const taxIs = (period: typeof NO_RECORDED_STATUS) => vi.fn(async () => period);
const noSupplementary = {
  hasAnySupplementaryInvoice: vi.fn(async () => false),
  creditNotes: vi.fn(async () => [CREDIT_NOTE]),
  generatedInvoiceTax: taxIs(NO_RECORDED_STATUS),
};
const XERO_ON = { xeroIntegration: true };
const XERO_OFF = { xeroIntegration: false };
const ON_OFFER = { kind: "XERO_INVOICE", invoiceNumber: "INV-0042", creditNotes: [CREDIT_NOTE] };

/** A Xero-off club's booking: no Xero invoice id, no Xero documents. */
const offBooking = (overrides: Record<string, unknown> = {}, payment: Record<string, unknown> = {}) =>
  booking(overrides, { xeroInvoiceId: null, xeroInvoiceNumber: null, ...payment });
const noXeroDocuments = {
  hasAnySupplementaryInvoice: vi.fn(async () => false),
  creditNotes: vi.fn(async () => []),
  generatedInvoiceTax: taxIs(NO_RECORDED_STATUS),
};

function offer(b: never, id = OWNER_ID, role = "USER", modules = XERO_ON, deps: typeof noSupplementary = noSupplementary) {
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

  it("offers the app's generated document while the club's Xero module is off, never Xero's invoice (slice 2)", async () => {
    expect(await offer(offBooking(), OWNER_ID, "USER", XERO_OFF, noXeroDocuments)).toEqual({ kind: "GENERATED", notYetApproved: false });
    // It looks for Xero documents left from when the module was on.
    expect(noXeroDocuments.hasAnySupplementaryInvoice).toHaveBeenCalledWith("ckbooking1234567");
  });

  it("with Xero off, keeps the same audience and refusals", async () => {
    const off = (b: never, id = OWNER_ID, role = "USER") => offer(b, id, role, XERO_OFF, noXeroDocuments);
    expect(await off(offBooking(), "guest-1")).toEqual({ kind: "NONE" });
    expect(await off(offBooking(), "content-1", "ADMIN_CONTENT")).toEqual({ kind: "NONE" });
    expect(await off(offBooking(), "officer-1", "ADMIN_BOOKINGS")).toEqual({ kind: "GENERATED", notYetApproved: false });
    expect(await off(offBooking({ status: "CANCELLED" }))).toEqual({ kind: "NONE" });
    expect(await off(offBooking({ status: "AWAITING_REVIEW" }))).toEqual({ kind: "GENERATED", notYetApproved: true });
    const organiserPaid = offBooking({ organiserSettled: true, parentBookingId: "organiser-booking" }, { source: "STRIPE" });
    expect(await off(organiserPaid)).toEqual({ kind: "NONE" });
  });

  it("with Xero off, offers the organiser's own booking in an organiser-pays group", async () => {
    const organiser = offBooking({ groupBookingAsOrganiser: { paymentMode: "ORGANISER_PAYS" } });
    expect(await offer(organiser, OWNER_ID, "USER", XERO_OFF, noXeroDocuments)).toEqual({ kind: "GENERATED", notYetApproved: false });
  });

  it("with Xero off, points a booking that already has Xero documents at the club, never a second Invoice", async () => {
    const ask = { kind: "ASK_CLUB", staffViewer: false, reason: "XERO_DOCUMENTS" };
    // A primary Xero invoice from when the module was on: no read needed.
    expect(await offer(booking(), OWNER_ID, "USER", XERO_OFF, noXeroDocuments)).toEqual(ask);
    // A supplementary invoice, or a credit note, found by the existing readers.
    const supplementary = { ...noXeroDocuments, hasAnySupplementaryInvoice: vi.fn(async () => true) };
    expect(await offer(offBooking(), OWNER_ID, "USER", XERO_OFF, supplementary)).toEqual(ask);
    const creditNote = { ...noXeroDocuments, creditNotes: vi.fn(async () => [CREDIT_NOTE]) };
    expect(await offer(offBooking(), OWNER_ID, "USER", XERO_OFF, creditNote)).toEqual(ask);
    expect(await offer(booking(), "officer-1", "ADMIN_BOOKINGS", XERO_OFF, noXeroDocuments)).toEqual({ ...ask, staffViewer: true });
  });

  describe("with Xero off, the tax period at the booking's anchor (owner decision, 20 Nov 2026)", () => {
    const withTax = (generatedInvoiceTax: ReturnType<typeof taxIs>) => ({ ...noXeroDocuments, generatedInvoiceTax });

    it("offers the generated Invoice to a club that never recorded a status", async () => {
      const tax = withTax(taxIs(NO_RECORDED_STATUS));
      expect(await offer(offBooking(), OWNER_ID, "USER", XERO_OFF, tax)).toEqual({ kind: "GENERATED", notYetApproved: false });
      expect(tax.generatedInvoiceTax).toHaveBeenCalledWith("ckbooking1234567");
    });

    it("offers the generated Invoice in a period the club recorded as not registered", async () => {
      expect(await offer(offBooking(), OWNER_ID, "USER", XERO_OFF, withTax(taxIs(RECORDED_NOT_REGISTERED)))).toEqual({
        kind: "GENERATED",
        notYetApproved: false,
      });
    });

    it("points a booking in a recorded GST-registered period at the club, in the reader's voice", async () => {
      const tax = withTax(taxIs(RECORDED_REGISTERED));
      const ask = { kind: "ASK_CLUB", staffViewer: false, reason: "REGISTERED_TAX_PERIOD" };
      expect(await offer(offBooking(), OWNER_ID, "USER", XERO_OFF, tax)).toEqual(ask);
      expect(await offer(offBooking({ status: "AWAITING_REVIEW" }), OWNER_ID, "USER", XERO_OFF, tax)).toEqual(ask);
      expect(await offer(offBooking(), "officer-1", "ADMIN_BOOKINGS", XERO_OFF, tax)).toEqual({ ...ask, staffViewer: true });
    });

    it("refuses when the schedule cannot be read, never counting it as no recorded status", async () => {
      const failing = withTax(vi.fn(async () => { throw new Error("schedule unreadable"); }));
      await expect(offer(offBooking(), OWNER_ID, "USER", XERO_OFF, failing)).rejects.toBeInstanceOf(BookingInvoiceSettingsUnavailableError);
    });

    it("reads the schedule only when the answer would otherwise be the generated document", async () => {
      const tax = withTax(taxIs(RECORDED_REGISTERED));
      await offer(booking(), OWNER_ID, "USER", XERO_ON, tax);
      await offer(offBooking(), "guest-1", "USER", XERO_OFF, tax);
      await offer(offBooking({}, { transactions: [{}] }), OWNER_ID, "USER", XERO_OFF, tax);
      await offer(booking(), OWNER_ID, "USER", XERO_OFF, tax);
      await offer(offBooking(), OWNER_ID, "USER", XERO_OFF, { ...tax, hasAnySupplementaryInvoice: vi.fn(async () => true) });
      expect(tax.generatedInvoiceTax).not.toHaveBeenCalled();
    });
  });

  it("with Xero off, explains an extra charge asked instead of offering nothing", async () => {
    expect(await offer(offBooking({}, { transactions: [{}] }), OWNER_ID, "USER", XERO_OFF, noXeroDocuments)).toEqual({
      kind: "ASK_CLUB",
      staffViewer: false,
      reason: "EXTRA_CHARGE",
    });
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
    const receiptOnly = { ...noXeroDocuments, hasAnySupplementaryInvoice: vi.fn(async () => true) };
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

const GENERATED_RENDER = {
  body: Buffer.from("%PDF-1.3 generated"),
  data: { documentDate: "1 July 2026", totalCents: 20_000 },
  balanceCents: 5_000,
};

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
      renderGenerated: vi.fn(async () => GENERATED_RENDER),
      ...overrides,
    } as never as NonNullable<Parameters<typeof prepareBookingInvoiceDownload>[4]>;
  }
  const allowed = { success: true, limit: 20, remaining: 19, resetAt: 0 };
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
    expect(createAuditLog).toHaveBeenCalledTimes(1);
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
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
    const auditOrder = vi.mocked(createAuditLog).mock.invocationCallOrder[0];
    expect(fetchOrder).toBeLessThan(auditOrder);
  });

  it("marks an officer's download as on behalf of the owner", async () => {
    const d = deps();
    await prepareBookingInvoiceDownload("ckbooking1234567", session("officer-1", "ADMIN_BOOKINGS"), INVOICE, request, d);
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      actorMemberId: "officer-1",
      subjectMemberId: OWNER_ID,
      metadata: expect.objectContaining({ onBehalf: true }),
    }));
  });

  it.each([
    ["a linked guest", booking(), "guest-1", XERO_ON],
    ["a stranger", booking(), "stranger-1", XERO_ON],
    ["a draft booking with Xero off", booking({ status: "DRAFT" }), OWNER_ID, XERO_OFF],
    ["a cancelled booking", booking({ status: "CANCELLED" }), OWNER_ID, XERO_ON],
    ["a booking with a further invoice", booking({}, { transactions: [{}] }), OWNER_ID, XERO_ON],
  ])("refuses %s as not found, with no Xero read and no audit row", async (_label, b, id, modules) => {
    const d = deps({ loadBooking: vi.fn(async () => b), modules: vi.fn(async () => modules) });
    const result = await prepareBookingInvoiceDownload("ckbooking1234567", session(id as string, "USER"), INVOICE, request, d);
    expect(result).toEqual({ kind: "NOT_FOUND" });
    expect(d.fetchXeroInvoicePdf).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
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
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
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
    expect(createAuditLog).not.toHaveBeenCalled();
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
    const spent = { success: false, limit: 20, remaining: 0, resetAt: 60_000 };
    const d = deps();
    const result = await prepareBookingInvoiceDownload("ckbooking1234567", session(OWNER_ID, "USER"), INVOICE, { ipAddress: null, chargeBookingLimit: vi.fn(async () => spent) }, d);
    expect(result).toEqual({ kind: "RATE_LIMITED", limit: spent });
    expect(d.xeroConnected).not.toHaveBeenCalled();
    expect(d.fetchXeroInvoicePdf).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it("refuses a booking that does not exist", async () => {
    const d = deps({ loadBooking: vi.fn(async () => null) });
    expect(await prepareBookingInvoiceDownload("missing", session(OWNER_ID, "USER"), INVOICE, request, d)).toEqual({ kind: "NOT_FOUND" });
  });

  it("says Xero is not connected without calling it", async () => {
    const d = deps({ xeroConnected: vi.fn(async () => false) });
    expect(await prepareBookingInvoiceDownload("ckbooking1234567", session(OWNER_ID, "USER"), INVOICE, request, d)).toEqual({ kind: "XERO_NOT_CONNECTED" });
    expect(d.fetchXeroInvoicePdf).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it("reports a failed or empty Xero read, writing no audit row", async () => {
    for (const fetchXeroInvoicePdf of [vi.fn(async () => { throw new Error("503"); }), vi.fn(async () => Buffer.alloc(0))]) {
      const d = deps({ fetchXeroInvoicePdf });
      expect(await prepareBookingInvoiceDownload("ckbooking1234567", session(OWNER_ID, "USER"), INVOICE, request, d)).toEqual({ kind: "XERO_UNAVAILABLE" });
      expect(createAuditLog).not.toHaveBeenCalled();
    }
  });

  it("withholds the PDF when the audit row cannot be written", async () => {
    vi.mocked(createAuditLog).mockRejectedValueOnce(new Error("db down"));
    const d = deps();
    expect(await prepareBookingInvoiceDownload("ckbooking1234567", session(OWNER_ID, "USER"), INVOICE, request, d)).toEqual({ kind: "AUDIT_FAILED" });
  });

  describe("with the Xero module off: the app's generated document (slice 2)", () => {
    const off = (overrides: Record<string, unknown> = {}) =>
      deps({
        modules: vi.fn(async () => XERO_OFF),
        loadBooking: vi.fn(async () => offBooking()),
        offer: (input: Parameters<typeof resolveBookingInvoiceOffer>[0]) => resolveBookingInvoiceOffer(input, noXeroDocuments),
        ...overrides,
      });

    it("renders the generated document, never reads Xero, and audits it as generated with its figures", async () => {
      const d = off();
      const result = await prepareBookingInvoiceDownload("ckbooking1234567", session("officer-1", "ADMIN_BOOKINGS"), INVOICE, request, d);
      expect(result).toEqual({ kind: "PDF", body: GENERATED_RENDER.body, fileName: "tac-invoice-CKBOOKIN.pdf" });
      expect(d.renderGenerated).toHaveBeenCalledWith(expect.objectContaining({ id: "ckbooking1234567" }), { kind: "GENERATED", notYetApproved: false });
      expect(d.xeroConnected).not.toHaveBeenCalled();
      expect(d.fetchXeroInvoicePdf).not.toHaveBeenCalled();
      expect(chargeBookingLimit).toHaveBeenCalledTimes(1);
      expect(createAuditLog).toHaveBeenCalledTimes(1);
      expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
        action: "booking.invoice.downloaded",
        category: "booking",
        actorMemberId: "officer-1",
        subjectMemberId: OWNER_ID,
        summary: "Booking invoice generated and downloaded",
        metadata: {
          bookingId: "ckbooking1234567",
          source: "GENERATED",
          notYetApproved: false,
          documentDate: "1 July 2026",
          totalCents: 20_000,
          balanceCents: 5_000,
          onBehalf: true,
        },
      }));
      const renderOrder = (d.renderGenerated as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      const auditOrder = vi.mocked(createAuditLog).mock.invocationCallOrder[0];
      expect(renderOrder).toBeLessThan(auditOrder);
    });

    it("marks a booking awaiting review as not yet approved, in the document and the audit row", async () => {
      const d = off({ loadBooking: vi.fn(async () => offBooking({ status: "AWAITING_REVIEW" })) });
      await prepareBookingInvoiceDownload("ckbooking1234567", session(OWNER_ID, "USER"), INVOICE, request, d);
      expect(d.renderGenerated).toHaveBeenCalledWith(expect.anything(), { kind: "GENERATED", notYetApproved: true });
      expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ notYetApproved: true }) }));
    });

    it.each([
      ["a cancelled booking", offBooking({ status: "CANCELLED" })],
      ["a waitlisted booking", offBooking({ status: "WAITLISTED" })],
      ["a place the organiser pays for", offBooking({ organiserSettled: true, parentBookingId: "organiser-booking" })],
      ["a booking with a night awaiting a price (#3170)", offBooking({ guests: [{ ...GUEST, nights: [{ stayDate: new Date("2026-08-03T00:00:00.000Z"), priceCents: null }] }] })],
      ["a booking with an extra charge asked", offBooking({}, { transactions: [{}] })],
      ["a booking with a Xero invoice from when Xero was on", booking()],
    ])("refuses %s as not found, before any limit, render or audit", async (_label, b) => {
      const d = off({ loadBooking: vi.fn(async () => b) });
      expect(await prepareBookingInvoiceDownload("ckbooking1234567", session(OWNER_ID, "USER"), INVOICE, request, d)).toEqual({ kind: "NOT_FOUND" });
      expect(d.renderGenerated).not.toHaveBeenCalled();
      expect(chargeBookingLimit).not.toHaveBeenCalled();
      expect(createAuditLog).not.toHaveBeenCalled();
    });

    it("refuses when the module settings cannot be read, rather than treating Xero as off (#5066 review)", async () => {
      const d = deps({ modules: vi.fn(async () => { throw new Error("database is down"); }) });
      expect(await prepareBookingInvoiceDownload("ckbooking1234567", session(OWNER_ID, "USER"), INVOICE, request, d)).toEqual({ kind: "SETTINGS_UNAVAILABLE" });
      expect(d.renderGenerated).not.toHaveBeenCalled();
      expect(d.fetchXeroInvoicePdf).not.toHaveBeenCalled();
      expect(chargeBookingLimit).not.toHaveBeenCalled();
      expect(createAuditLog).not.toHaveBeenCalled();
    });

    it("refuses a booking in a recorded GST-registered period as not found, before any limit, render or audit", async () => {
      const d = off({
        offer: (input: Parameters<typeof resolveBookingInvoiceOffer>[0]) =>
          resolveBookingInvoiceOffer(input, { ...noXeroDocuments, generatedInvoiceTax: taxIs(RECORDED_REGISTERED) }),
      });
      expect(await prepareBookingInvoiceDownload("ckbooking1234567", session(OWNER_ID, "USER"), INVOICE, request, d)).toEqual({ kind: "NOT_FOUND" });
      expect(d.renderGenerated).not.toHaveBeenCalled();
      expect(chargeBookingLimit).not.toHaveBeenCalled();
      expect(createAuditLog).not.toHaveBeenCalled();
    });

    it("refuses when the tax schedule cannot be read, rather than generating (#5066, 20 Nov 2026)", async () => {
      const d = off({
        offer: (input: Parameters<typeof resolveBookingInvoiceOffer>[0]) =>
          resolveBookingInvoiceOffer(input, { ...noXeroDocuments, generatedInvoiceTax: vi.fn(async () => { throw new Error("schedule unreadable"); }) }),
      });
      expect(await prepareBookingInvoiceDownload("ckbooking1234567", session(OWNER_ID, "USER"), INVOICE, request, d)).toEqual({ kind: "SETTINGS_UNAVAILABLE" });
      expect(d.renderGenerated).not.toHaveBeenCalled();
      expect(chargeBookingLimit).not.toHaveBeenCalled();
      expect(createAuditLog).not.toHaveBeenCalled();
    });

    it("lets any other failure of the offer propagate", async () => {
      const d = off({ offer: vi.fn(async () => { throw new Error("supplementary read failed"); }) });
      await expect(prepareBookingInvoiceDownload("ckbooking1234567", session(OWNER_ID, "USER"), INVOICE, request, d)).rejects.toThrow("supplementary read failed");
    });

    it("serves no credit note while Xero is off", async () => {
      const d = off();
      expect(await prepareBookingInvoiceDownload("ckbooking1234567", session(OWNER_ID, "USER"), creditNote("xero-cn-1"), request, d)).toEqual({ kind: "NOT_FOUND" });
      expect(d.fetchXeroCreditNotePdf).not.toHaveBeenCalled();
      expect(d.renderGenerated).not.toHaveBeenCalled();
    });

    it("answers a booking that changed under the offer as no longer available, writing no audit row", async () => {
      const d = off({ renderGenerated: vi.fn(async () => { throw new BookingInvoiceNotAvailableError("LINES_DO_NOT_ADD_UP"); }) });
      expect(await prepareBookingInvoiceDownload("ckbooking1234567", session(OWNER_ID, "USER"), INVOICE, request, d)).toEqual({ kind: "NOT_FOUND" });
      expect(createAuditLog).not.toHaveBeenCalled();
    });

    it("withholds the generated PDF when its audit row cannot be written", async () => {
      vi.mocked(createAuditLog).mockRejectedValueOnce(new Error("db down"));
      const d = off();
      expect(await prepareBookingInvoiceDownload("ckbooking1234567", session(OWNER_ID, "USER"), INVOICE, request, d)).toEqual({ kind: "AUDIT_FAILED" });
    });
  });

  it("records no subject member on an organisation-owned booking (INV-PRIV-019)", async () => {
    const school = booking({ memberId: null, member: null, organisationId: "org-1", organisation: { name: "School", email: null } });
    const d = deps({ loadBooking: vi.fn(async () => school) });
    const result = await prepareBookingInvoiceDownload("ckbooking1234567", session("officer-1", "ADMIN_BOOKINGS"), INVOICE, request, d);
    expect(result).toMatchObject({ kind: "PDF" });
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ subjectMemberId: null }));
  });
});

describe("prepareBookingInvoiceDownload with its real dependencies", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads Xero's PDF once through the metered client: no retries, no breaker arming", async () => {
    const getInvoiceAsPdf = vi.fn(async () => ({ body: Buffer.from("%PDF-1.4") }));
    vi.mocked(loadBookingDetail).mockResolvedValue(booking());
    vi.mocked(loadEffectiveModuleFlagsStrict).mockResolvedValue({ xeroIntegration: true } as never);
    vi.mocked(bookingHasAnySupplementaryInvoiceEvidence).mockResolvedValue(false);
    vi.mocked(isXeroConnected).mockResolvedValue(true);
    vi.mocked(getAuthenticatedXeroClient).mockResolvedValue({ xero: { accountingApi: { getInvoiceAsPdf } }, tenantId: "tenant-1" } as never);
    vi.mocked(callXeroApi).mockImplementation(async (call: () => Promise<unknown>) => call() as never);
    vi.mocked(readBookingCreditNotes).mockResolvedValue([]);
    vi.mocked(getClubIdentity).mockResolvedValue({ shortName: "TAC" } as never);

    const result = await prepareBookingInvoiceDownload("ckbooking1234567", session(OWNER_ID, "USER"), { kind: "INVOICE" }, { ipAddress: null, chargeBookingLimit: async () => ({ success: true, limit: 20, remaining: 1, resetAt: 0 }) });

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
    vi.mocked(loadEffectiveModuleFlagsStrict).mockResolvedValue({ xeroIntegration: true } as never);
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
      { ipAddress: null, chargeBookingLimit: async () => ({ success: true, limit: 20, remaining: 1, resetAt: 0 }) },
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
