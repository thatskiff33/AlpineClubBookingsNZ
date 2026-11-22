import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #5066, owner decision of 20 Nov 2026: with Xero off, a booking whose tax
 * anchor falls in a GST-registered period the club recorded gets the
 * ask-the-club line, not the generated "Invoice", until the "Tax invoice" form
 * exists (#5291). This runs the offer's real tax read — `resolveAnchoredClubTax`
 * over `loadClubTaxSchedule` and `readBookingTaxAnchorInstant` — against a
 * prisma double, so the anchor (when the booking was made; a group place's
 * organiser's booking) and the recorded/baseline distinction are main's own.
 */
const mocks = vi.hoisted(() => ({ booking: vi.fn(), periods: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: mocks.booking },
    clubTaxSettings: { findMany: mocks.periods },
  },
}));
vi.mock("@/lib/club-time-zone-runtime", () => ({ readClubTimeZoneOutsideRequest: vi.fn(async () => "Pacific/Auckland") }));
vi.mock("@/lib/xero-api-client", () => ({ callXeroApi: vi.fn(), getAuthenticatedXeroClient: vi.fn() }));
vi.mock("@/lib/xero-token-store", () => ({ isXeroConnected: vi.fn() }));
vi.mock("@/lib/booking-supplementary-invoice-identities", () => ({
  bookingHasAnySupplementaryInvoiceEvidence: vi.fn(async () => false),
}));
vi.mock("../_lib/load-booking-detail", () => ({ loadBookingDetail: vi.fn() }));
vi.mock("@/lib/module-settings", () => ({ loadEffectiveModuleFlagsStrict: vi.fn() }));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));
vi.mock("@/lib/booking-credit-notes", () => ({ readBookingCreditNotes: vi.fn(async () => []) }));
vi.mock("@/lib/club-identity-settings", () => ({ getClubIdentity: vi.fn() }));

import { BookingInvoiceSettingsUnavailableError, resolveBookingInvoiceOffer } from "../_lib/booking-invoice-download";

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const booking = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "ckbooking1234567",
    memberId: "owner-1",
    member: { id: "owner-1", firstName: "Ada", lastName: "Owner" },
    organisationId: null,
    organisation: null,
    status: "CONFIRMED",
    organiserSettled: false,
    parentBookingId: null,
    checkIn: day("2026-08-03"),
    checkOut: day("2026-08-04"),
    finalPriceCents: 10_000,
    promoAdjustmentCents: 0,
    promoRedemptions: [],
    groupBookingAsOrganiser: null,
    guests: [{ firstName: "Ada", lastName: "Owner", ageTier: "ADULT", isMember: true, priceCents: 10_000, nights: [{ stayDate: day("2026-08-03"), priceCents: 10_000 }] }],
    modifications: [],
    payment: { id: "payment-1", source: "STRIPE", xeroInvoiceId: null, xeroInvoiceNumber: null, transactions: [] },
    ...overrides,
  }) as never;

const OWNER = { canSeeOwnerCredit: true, nonOwnerAdminViewer: false };
const offer = (b = booking()) => resolveBookingInvoiceOffer({ booking: b, viewer: OWNER, modules: { xeroIntegration: false } });
const GENERATED = { kind: "GENERATED", notYetApproved: false };
const ASK_CLUB = { kind: "ASK_CLUB", staffViewer: false, reason: "REGISTERED_TAX_PERIOD" };

const row = (id: string, effectiveFrom: string, registered: boolean) => ({
  id,
  gstRegistered: registered,
  taxRateBasisPoints: registered ? 1500 : 0,
  xeroTaxType: registered ? "OUTPUT2" : null,
  effectiveFrom: day(effectiveFrom),
});
/** The club records registration from 1 Sep 2026 (NZST), and records it ends from 1 Oct 2026 (NZDT). */
const REGISTERED_FROM_SEP = row("registered", "2026-09-01", true);
const DEREGISTERED_FROM_OCT = row("deregistered", "2026-10-01", false);
/** Either side of NZ midnight on each change date. */
const BEFORE_SEP = new Date("2026-08-31T11:30:00.000Z");
const AFTER_SEP = new Date("2026-08-31T12:30:00.000Z");
const BEFORE_OCT = new Date("2026-09-30T10:30:00.000Z");
const AFTER_OCT = new Date("2026-09-30T11:30:00.000Z");

const madeAt = (createdAt: Date, organiserCreatedAt?: Date) =>
  mocks.booking.mockResolvedValue({ createdAt, parentBooking: organiserCreatedAt ? { createdAt: organiserCreatedAt } : null });

describe("the generated invoice's offer reads the tax period at the booking's anchor (#5066, 20 Nov 2026)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.periods.mockResolvedValue([]);
  });

  it("offers the Invoice to a club that never recorded a status, though the code baseline is registered", async () => {
    madeAt(AFTER_OCT);
    expect(await offer()).toEqual(GENERATED);
    expect(mocks.booking).toHaveBeenCalledWith({
      where: { id: "ckbooking1234567" },
      select: { createdAt: true, parentBooking: { select: { createdAt: true } } },
    });
  });

  it("offers the Invoice in a period the club recorded as not registered", async () => {
    mocks.periods.mockResolvedValue([row("default", "2010-10-01", false)]);
    madeAt(AFTER_OCT);
    expect(await offer()).toEqual(GENERATED);
  });

  it("points a booking in a recorded registered period at the club, a stored baseline included", async () => {
    mocks.periods.mockResolvedValue([REGISTERED_FROM_SEP]);
    madeAt(AFTER_SEP);
    expect(await offer()).toEqual(ASK_CLUB);
    mocks.periods.mockResolvedValue([row("default", "2010-10-01", true)]);
    expect(await offer()).toEqual(ASK_CLUB);
  });

  it("a booking made before a recorded registration keeps the baseline it was made under: the Invoice", async () => {
    mocks.periods.mockResolvedValue([REGISTERED_FROM_SEP]);
    madeAt(BEFORE_SEP);
    expect(await offer()).toEqual(GENERATED);
    madeAt(AFTER_SEP);
    expect(await offer()).toEqual(ASK_CLUB);
  });

  it("a booking made before a recorded deregistration keeps the registered period it was made under: ask the club", async () => {
    mocks.periods.mockResolvedValue([REGISTERED_FROM_SEP, DEREGISTERED_FROM_OCT]);
    madeAt(BEFORE_OCT);
    expect(await offer()).toEqual(ASK_CLUB);
    madeAt(AFTER_OCT);
    expect(await offer()).toEqual(GENERATED);
  });

  it("a group place takes its organiser's booking's anchor, in both directions", async () => {
    mocks.periods.mockResolvedValue([REGISTERED_FROM_SEP, DEREGISTERED_FROM_OCT]);
    const place = booking({ parentBookingId: "organiser-booking" });
    madeAt(AFTER_OCT, BEFORE_OCT);
    expect(await offer(place)).toEqual(ASK_CLUB);
    madeAt(BEFORE_OCT, AFTER_OCT);
    expect(await offer(place)).toEqual(GENERATED);
  });

  it("refuses, never generating, when the schedule or the anchor cannot be read", async () => {
    madeAt(AFTER_OCT);
    mocks.periods.mockRejectedValueOnce(new Error("database is down"));
    await expect(offer()).rejects.toBeInstanceOf(BookingInvoiceSettingsUnavailableError);
    // A schedule the reader refuses as a defect: a later period on or before the baseline.
    mocks.periods.mockResolvedValueOnce([row("default", "2026-09-01", false), row("early", "2026-08-01", true)]);
    await expect(offer()).rejects.toBeInstanceOf(BookingInvoiceSettingsUnavailableError);
    // A date the schedule does not cover.
    mocks.periods.mockResolvedValueOnce([row("default", "2026-12-01", false)]);
    await expect(offer()).rejects.toBeInstanceOf(BookingInvoiceSettingsUnavailableError);
    mocks.booking.mockRejectedValueOnce(new Error("database is down"));
    await expect(offer()).rejects.toBeInstanceOf(BookingInvoiceSettingsUnavailableError);
  });
});
