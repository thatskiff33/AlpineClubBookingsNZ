import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #5066: the booking's invoice offer rides the editor payload, as a conditional
 * spread — present only when something is offered, so a club with Xero off
 * ships exactly the payload it did before.
 */
const mocks = vi.hoisted(() => ({ offer: vi.fn(), modules: vi.fn(), account: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/module-settings", () => ({ loadEffectiveModuleFlags: mocks.modules }));
vi.mock("../_lib/booking-invoice-download", () => ({ resolveBookingInvoiceOffer: mocks.offer }));
vi.mock("../_lib/booking-invoice-account", () => ({ resolveBookingInvoiceAccount: mocks.account }));
vi.mock("@/lib/admin-modules", () => ({ isEffectiveModuleEnabled: async () => false }));
vi.mock("@/lib/member-guest-settings", () => ({ loadMemberGuestSettings: vi.fn() }));
vi.mock("@/lib/member-credit", () => ({ getMemberCreditBalance: vi.fn() }));
vi.mock("@/lib/booking-modify", () => ({ isMemberWholeLodgeBooking: vi.fn() }));
vi.mock("@/lib/booking-request", () => ({ getPublicOtherLodges: vi.fn() }));
vi.mock("@/lib/financial-year-server", () => ({ refreshFinancialYearConfig: vi.fn() }));
vi.mock("@/lib/membership-type-policy", () => ({ resolveOtherLodgeRateEligibleGuestIds: vi.fn() }));

import { buildBookingDetailEditorData } from "../_lib/booking-detail-editor-data";

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const booking = {
  id: "bk-1",
  memberId: "owner-1",
  member: { id: "owner-1" },
  organisationId: null,
  organisation: null,
  lodge: { name: "Lodge" },
  lodgeId: "lodge-1",
  checkIn: day("2026-08-03"),
  checkOut: day("2026-08-05"),
  status: "CONFIRMED",
  guests: [],
  promoRedemptions: [],
  payment: null,
  organiserSettled: false,
  creditElectionCents: null,
  totalPriceCents: 1000,
  discountCents: 0,
  promoAdjustmentCents: 0,
  finalPriceCents: 1000,
  hasNonMembers: false,
  nonMemberHoldUntil: null,
  requiresAdminReview: false,
  adminReviewStatus: null,
  noEmails: false,
  otherLodgeId: null,
};
const viewer = { viewerAuthorizationRole: "USER", canSeeOwnerCredit: true, nonOwnerAdminViewer: false };
const input = {
  session: { user: { id: "owner-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } },
  booking,
  club: { zone: "Pacific/Auckland", format: {} },
  nights: 2,
  viewer,
  consent: { consentBadgeAudience: "OWNER", consentResponderNameById: new Map() },
  access: {
    isDeleted: false,
    canModify: false,
    canAdminOverride: false,
    canRequestFinishedStayPromoCorrection: false,
    canEditNonMemberGuestNames: false,
    canFixNonMemberGuestNameTypos: false,
    editPolicy: { mode: "future", today: day("2026-07-01"), editableFrom: null, checkInEditable: true },
  },
  amountOwed: { owedCents: 1000, dueCents: 1000, appliedCreditCents: 0 },
} as never;
const ACCOUNT = {
  summary: { totalCents: 1000, changeFeeCents: 0, creditAppliedCents: 0, paidCents: 1000, keptCents: 0, balanceCents: 0, balanceWhen: "NOW" },
  invoiceUpdateNotice: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.modules.mockResolvedValue({ xeroIntegration: true });
  mocks.account.mockResolvedValue(ACCOUNT);
});

describe("buildBookingDetailEditorData carries the invoice offer", () => {
  it("adds the offer resolved from the render's module flags, the booking and the viewer", async () => {
    mocks.offer.mockResolvedValue({ kind: "XERO_INVOICE", invoiceNumber: "INV-1", creditNotes: [] });
    const data = await buildBookingDetailEditorData(input);
    expect(data.invoiceOffer).toEqual({ kind: "XERO_INVOICE", invoiceNumber: "INV-1", creditNotes: [] });
    expect(data.id).toBe("bk-1");
    expect(mocks.offer).toHaveBeenCalledWith({ booking, viewer, modules: { xeroIntegration: true } });
  });

  it("adds the invoice's account lines from the page's own amount-owed read", async () => {
    mocks.offer.mockResolvedValue({ kind: "XERO_INVOICE", invoiceNumber: "INV-1", creditNotes: [] });
    const data = await buildBookingDetailEditorData(input);
    expect(data.invoiceAccount).toEqual(ACCOUNT);
    expect(mocks.account).toHaveBeenCalledWith(booking, { owedCents: 1000, dueCents: 1000, appliedCreditCents: 0 });
  });

  it("carries an ask-the-club line with no account lines", async () => {
    mocks.offer.mockResolvedValue({ kind: "ASK_CLUB", staffViewer: false });
    const data = await buildBookingDetailEditorData(input);
    expect(data.invoiceOffer).toEqual({ kind: "ASK_CLUB", staffViewer: false });
    expect("invoiceAccount" in data).toBe(false);
    expect(mocks.account).not.toHaveBeenCalled();
  });

  it("leaves the key out entirely when nothing is offered", async () => {
    mocks.offer.mockResolvedValue({ kind: "NONE" });
    const data = await buildBookingDetailEditorData(input);
    expect("invoiceOffer" in data).toBe(false);
    expect("invoiceAccount" in data).toBe(false);
  });
});
