import { beforeEach, describe, expect, it, vi } from "vitest";

// Fork #115: who gets the invoice, and which invoice they get.

const mocks = vi.hoisted(() => ({
  loadBookingDetail: vi.fn(),
  resolveViewer: vi.fn(),
  lodgeFindUnique: vi.fn(),
  readBookingAmountOwed: vi.fn(),
  netCollected: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("../_lib/load-booking-detail", () => ({ loadBookingDetail: mocks.loadBookingDetail }));
vi.mock("../_lib/booking-detail-viewer", () => ({ resolveBookingDetailViewer: mocks.resolveViewer }));
vi.mock("@/lib/prisma", () => ({ prisma: { lodge: { findUnique: mocks.lodgeFindUnique } } }));
vi.mock("@/lib/booking-amount-owed", () => ({ readBookingAmountOwed: mocks.readBookingAmountOwed }));
vi.mock("@/lib/payment-net-collected", () => ({ getNetCollectedCashParts: mocks.netCollected }));
vi.mock("@/lib/club-format-settings", () => ({
  getClubFormat: async () => ({ currencyCode: "NZD", locale: "en-NZ" }),
}));
vi.mock("@/lib/club-time/server", async () => {
  const { requireCalendarDate } = await import("@/lib/club-time");
  return { clubTime: async () => ({ today: () => requireCalendarDate("2026-07-01") }) };
});
vi.mock("@/lib/club-tax-settings", () => ({ loadClubTaxSettings: async () => ({ gstRegistered: true }) }));
vi.mock("@/lib/age-tier", () => ({ getAgeTierSettings: async () => [{ tier: "ADULT", label: "Adult" }] }));
vi.mock("@/lib/rate-membership-label", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/rate-membership-label")),
  loadRateMembershipLabelResolver: async () => ({ nonMemberTypeId: null }),
}));
vi.mock("@/lib/xero-api-client", () => ({ getAuthenticatedXeroClient: vi.fn() }));

import { prepareBookingInvoiceDownload } from "../_lib/booking-invoice-download";

const session = { user: { id: "member-1" } } as never;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: "ckbooking1234567",
    lodgeId: "lodge-1",
    deletedAt: null,
    status: "CONFIRMED",
    organiserSettled: false,
    checkIn: day("2026-07-03"),
    checkOut: day("2026-07-05"),
    finalPriceCents: 6000,
    guests: [
      {
        firstName: "Aroha",
        lastName: "Smith",
        ageTier: "ADULT",
        isMember: true,
        rateMembershipTypeId: null,
        priceCents: 6000,
        nights: [
          { stayDate: day("2026-07-03"), priceCents: 3000 },
          { stayDate: day("2026-07-04"), priceCents: 3000 },
        ],
      },
    ],
    promoRedemptions: [],
    payment: null,
    member: { firstName: "Aroha", lastName: "Smith" },
    organisation: null,
    ...overrides,
  };
}

const viewer = (overrides: Record<string, boolean> = {}) => ({
  isAdmin: false,
  canManageBooking: true,
  canViewAsAdmin: false,
  isLinkedGuestViewer: false,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadBookingDetail.mockResolvedValue(booking());
  mocks.resolveViewer.mockReturnValue(viewer());
  mocks.lodgeFindUnique.mockResolvedValue({
    name: "Summit Lodge",
    address: "1 Mountain Road",
    postalAddress: null,
    bankAccountName: null,
    bankAccountDetails: null,
    gstNumber: null,
  });
  mocks.readBookingAmountOwed.mockResolvedValue({ owedCents: 6000, dueCents: 6000, appliedCreditCents: 0 });
  mocks.netCollected.mockReturnValue({ heldCashCents: 0 });
});

const neverXero = () => ({
  xeroReachable: vi.fn(async () => true),
  fetchXeroInvoicePdf: vi.fn(async () => Buffer.from("unused")),
});

describe("prepareBookingInvoiceDownload", () => {
  it("refuses an unknown booking", async () => {
    mocks.loadBookingDetail.mockResolvedValue(null);
    expect((await prepareBookingInvoiceDownload("missing", session, neverXero())).kind).toBe("NOT_FOUND");
  });

  it("refuses a guest linked to someone else's booking, as not found", async () => {
    mocks.resolveViewer.mockReturnValue(
      viewer({ canManageBooking: false, isLinkedGuestViewer: true }),
    );
    expect((await prepareBookingInvoiceDownload("b", session, neverXero())).kind).toBe("NOT_FOUND");
  });

  it("refuses an unrelated member", async () => {
    mocks.resolveViewer.mockReturnValue(viewer({ canManageBooking: false }));
    expect((await prepareBookingInvoiceDownload("b", session, neverXero())).kind).toBe("NOT_FOUND");
  });

  it("keeps a deleted booking admin-only, as the page does", async () => {
    mocks.loadBookingDetail.mockResolvedValue(booking({ deletedAt: new Date() }));
    expect((await prepareBookingInvoiceDownload("b", session, neverXero())).kind).toBe("NOT_FOUND");
    mocks.resolveViewer.mockReturnValue(viewer({ isAdmin: true }));
    expect((await prepareBookingInvoiceDownload("b", session, neverXero())).kind).toBe("PDF");
  });

  it("lets a bookings-view admin who does not manage the booking download it", async () => {
    mocks.resolveViewer.mockReturnValue(viewer({ canManageBooking: false, canViewAsAdmin: true }));
    const result = await prepareBookingInvoiceDownload("b", session, neverXero());
    expect(result).toMatchObject({ kind: "PDF", source: "GENERATED" });
  });

  it("downloads Xero's own PDF when the booking has a Xero invoice", async () => {
    mocks.loadBookingDetail.mockResolvedValue(
      booking({ payment: { xeroInvoiceId: "xero-inv-1", xeroInvoiceNumber: "INV-0042" } }),
    );
    const xero = { xeroReachable: async () => true, fetchXeroInvoicePdf: vi.fn(async () => Buffer.from("%PDF-xero")) };
    const result = await prepareBookingInvoiceDownload("b", session, xero);
    expect(xero.fetchXeroInvoicePdf).toHaveBeenCalledWith("xero-inv-1");
    expect(result).toMatchObject({ kind: "PDF", source: "XERO", fileName: "Invoice-INV-0042.pdf" });
    expect(mocks.lodgeFindUnique).not.toHaveBeenCalled();
  });

  it("fails rather than generating a second invoice when Xero cannot be reached", async () => {
    mocks.loadBookingDetail.mockResolvedValue(
      booking({ payment: { xeroInvoiceId: "xero-inv-1", xeroInvoiceNumber: "INV-0042" } }),
    );
    const xero = {
      xeroReachable: async () => true,
      fetchXeroInvoicePdf: vi.fn(async () => {
        throw new Error("Xero down");
      }),
    };
    expect((await prepareBookingInvoiceDownload("b", session, xero)).kind).toBe("XERO_UNAVAILABLE");
    expect(mocks.lodgeFindUnique).not.toHaveBeenCalled();
  });

  it("generates a PDF from the booking when there is no Xero invoice, billing the organisation", async () => {
    mocks.netCollected.mockReturnValue({ heldCashCents: 2000 });
    mocks.loadBookingDetail.mockResolvedValue(
      booking({
        organisation: { name: "Hilltop School" },
        member: null,
        payment: { xeroInvoiceId: null, changeFeeCents: null },
      }),
    );
    const result = await prepareBookingInvoiceDownload("b", session, neverXero());
    expect(result).toMatchObject({ kind: "PDF", source: "GENERATED", fileName: "Invoice-CKBOOKIN.pdf" });
    const content = (result as { body: Buffer }).body.toString("latin1");
    expect(content).toContain("Hilltop School");
    expect(content).toContain("Amount paid");
  });

  it("says Xero is not connected, and generates nothing, when Xero is off for a Xero-invoiced booking", async () => {
    mocks.loadBookingDetail.mockResolvedValue(
      booking({ payment: { xeroInvoiceId: "xero-inv-1", xeroInvoiceNumber: "INV-0042" } }),
    );
    const xero = { xeroReachable: async () => false, fetchXeroInvoicePdf: vi.fn() };
    expect((await prepareBookingInvoiceDownload("b", session, xero)).kind).toBe("XERO_NOT_CONNECTED");
    expect(xero.fetchXeroInvoicePdf).not.toHaveBeenCalled();
    expect(mocks.lodgeFindUnique).not.toHaveBeenCalled();
  });

  it("does not invoice a joiner for a booking the group organiser pays for", async () => {
    mocks.loadBookingDetail.mockResolvedValue(booking({ organiserSettled: true }));
    const result = await prepareBookingInvoiceDownload("b", session, neverXero());
    expect(result).toMatchObject({ kind: "CANNOT_GENERATE" });
    expect((result as { message: string }).message).toContain("group organiser");
  });

  it("does not invoice a cancelled booking", async () => {
    mocks.loadBookingDetail.mockResolvedValue(booking({ status: "CANCELLED" }));
    expect((await prepareBookingInvoiceDownload("b", session, neverXero())).kind).toBe("CANNOT_GENERATE");
  });

  it("refuses to generate while a night is still awaiting a price", async () => {
    mocks.loadBookingDetail.mockResolvedValue(
      booking({
        guests: [
          {
            ...booking().guests[0],
            nights: [{ stayDate: day("2026-07-03"), priceCents: null }],
          },
        ],
      }),
    );
    expect((await prepareBookingInvoiceDownload("b", session, neverXero())).kind).toBe("CANNOT_GENERATE");
  });
});
