import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #5066 slice 1: the booking page's Download invoice — who is offered it, for
 * which bookings, and what the download does. The real
 * `resolveBookingDetailViewer` runs, so the audience is the page's own
 * `canSeeOwnerCredit` answer rather than a mocked one.
 */
vi.mock("server-only", () => ({}));
vi.mock("@/lib/xero-api-client", () => ({ callXeroApi: vi.fn(), getAuthenticatedXeroClient: vi.fn() }));
vi.mock("@/lib/xero-token-store", () => ({ isXeroConnected: vi.fn() }));
vi.mock("@/lib/booking-supplementary-invoice-identities", () => ({
  readBookingSupplementaryInvoiceIdentities: vi.fn(),
}));
vi.mock("../_lib/load-booking-detail", () => ({ loadBookingDetail: vi.fn() }));
vi.mock("@/lib/module-settings", () => ({ loadEffectiveModuleFlags: vi.fn() }));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));

import {
  bookingInvoiceFileName,
  prepareBookingInvoiceDownload,
  resolveBookingInvoiceOffer,
} from "../_lib/booking-invoice-download";
import { resolveBookingDetailViewer } from "../_lib/booking-detail-viewer";

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
    payment: {
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

const noSupplementary = { readSupplementary: vi.fn(async () => ({ invoiceIds: [], incomplete: false, revision: "r" })) };
const XERO_ON = { xeroIntegration: true };

function offer(b: never, id = OWNER_ID, role = "USER", modules = XERO_ON, deps = noSupplementary) {
  return resolveBookingInvoiceOffer({ booking: b, viewer: viewerFor(b, id, role), modules }, deps);
}

describe("resolveBookingInvoiceOffer: the one rule for the button and the route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("offers the primary Xero invoice to the owner, an officer and a full admin", async () => {
    for (const [id, role] of [[OWNER_ID, "USER"], ["officer-1", "ADMIN_BOOKINGS"], ["admin-1", "ADMIN"]]) {
      expect(await offer(booking(), id, role)).toEqual({ kind: "XERO_INVOICE", invoiceNumber: "INV-0042" });
    }
  });

  it("offers nothing to a linked guest or a stranger (the owner-credit audience)", async () => {
    expect(await offer(booking(), "guest-1", "USER")).toEqual({ kind: "NONE" });
    expect(await offer(booking(), "stranger-1", "USER")).toEqual({ kind: "NONE" });
    expect(noSupplementary.readSupplementary).not.toHaveBeenCalled();
  });

  it("offers nothing while the club's Xero module is off", async () => {
    expect(await offer(booking(), OWNER_ID, "USER", { xeroIntegration: false })).toEqual({ kind: "NONE" });
  });

  it("offers nothing on a cancelled or bumped booking", async () => {
    expect(await offer(booking({ status: "CANCELLED" }))).toEqual({ kind: "NONE" });
    expect(await offer(booking({ status: "BUMPED" }))).toEqual({ kind: "NONE" });
  });

  it("keeps a deleted booking admin-only", async () => {
    const deleted = booking({ status: "CANCELLED", deletedAt: new Date("2026-06-30T00:00:00.000Z") });
    expect(await offer(deleted, "officer-1", "ADMIN_BOOKINGS")).toEqual({ kind: "NONE" });
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
    expect(await offer(asked)).toEqual({ kind: "ASK_CLUB" });
    expect(noSupplementary.readSupplementary).not.toHaveBeenCalled();
  });

  it("asks the member to contact the club when a supplementary invoice exists or cannot be ruled out", async () => {
    const withId = { readSupplementary: vi.fn(async () => ({ invoiceIds: ["xero-supp"], incomplete: false, revision: "r" })) };
    const unknown = { readSupplementary: vi.fn(async () => ({ invoiceIds: [], incomplete: true, revision: "r" })) };
    expect(await offer(booking(), OWNER_ID, "USER", XERO_ON, withId)).toEqual({ kind: "ASK_CLUB" });
    expect(await offer(booking(), OWNER_ID, "USER", XERO_ON, unknown)).toEqual({ kind: "ASK_CLUB" });
    expect(withId.readSupplementary).toHaveBeenCalledWith("ckbooking1234567");
  });
});

describe("bookingInvoiceFileName", () => {
  it("names the file by the Xero number, header-safe", () => {
    expect(bookingInvoiceFileName("ckbooking1234567", "INV-0042")).toBe("Invoice-INV-0042.pdf");
    expect(bookingInvoiceFileName("ckbooking1234567", 'INV "1"\r\n')).toBe("Invoice-INV--1-.pdf");
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
      fetchXeroInvoicePdf: vi.fn(async () => pdf),
      writeAudit: vi.fn(async () => undefined),
      ...overrides,
    } as never as Parameters<typeof prepareBookingInvoiceDownload>[3];
  }
  const request = { ipAddress: "203.0.113.9" };

  beforeEach(() => vi.clearAllMocks());

  it("returns Xero's PDF of the booking's own primary invoice and writes one audit row after the read", async () => {
    const d = deps();
    const result = await prepareBookingInvoiceDownload("ckbooking1234567", session(OWNER_ID, "USER"), request, d);
    expect(result).toEqual({ kind: "PDF", body: pdf, fileName: "Invoice-INV-0042.pdf" });
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
    await prepareBookingInvoiceDownload("ckbooking1234567", session("officer-1", "ADMIN_BOOKINGS"), request, d);
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
    const result = await prepareBookingInvoiceDownload("ckbooking1234567", session(id as string, "USER"), request, d);
    expect(result).toEqual({ kind: "NOT_FOUND" });
    expect(d.fetchXeroInvoicePdf).not.toHaveBeenCalled();
    expect(d.writeAudit).not.toHaveBeenCalled();
  });

  it("refuses a booking that does not exist", async () => {
    const d = deps({ loadBooking: vi.fn(async () => null) });
    expect(await prepareBookingInvoiceDownload("missing", session(OWNER_ID, "USER"), request, d)).toEqual({ kind: "NOT_FOUND" });
  });

  it("says Xero is not connected without calling it", async () => {
    const d = deps({ xeroConnected: vi.fn(async () => false) });
    expect(await prepareBookingInvoiceDownload("ckbooking1234567", session(OWNER_ID, "USER"), request, d)).toEqual({ kind: "XERO_NOT_CONNECTED" });
    expect(d.fetchXeroInvoicePdf).not.toHaveBeenCalled();
    expect(d.writeAudit).not.toHaveBeenCalled();
  });

  it("reports a failed or empty Xero read, writing no audit row", async () => {
    for (const fetchXeroInvoicePdf of [vi.fn(async () => { throw new Error("503"); }), vi.fn(async () => Buffer.alloc(0))]) {
      const d = deps({ fetchXeroInvoicePdf });
      expect(await prepareBookingInvoiceDownload("ckbooking1234567", session(OWNER_ID, "USER"), request, d)).toEqual({ kind: "XERO_UNAVAILABLE" });
      expect(d.writeAudit).not.toHaveBeenCalled();
    }
  });

  it("withholds the PDF when the audit row cannot be written", async () => {
    const d = deps({ writeAudit: vi.fn(async () => { throw new Error("db down"); }) });
    expect(await prepareBookingInvoiceDownload("ckbooking1234567", session(OWNER_ID, "USER"), request, d)).toEqual({ kind: "AUDIT_FAILED" });
  });

  it("records no subject member on an organisation-owned booking (INV-PRIV-019)", async () => {
    const school = booking({ memberId: null, member: null, organisationId: "org-1", organisation: { name: "School", email: null } });
    const d = deps({ loadBooking: vi.fn(async () => school) });
    const result = await prepareBookingInvoiceDownload("ckbooking1234567", session("officer-1", "ADMIN_BOOKINGS"), request, d);
    expect(result).toMatchObject({ kind: "PDF" });
    expect(d.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ subjectMemberId: null }));
  });
});
