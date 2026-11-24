/**
 * ALP-794 (`INV-MCP-006`): the booking previews an AI app connection may run,
 * each held to the contract it exposes (`expectActionContract`):
 *
 * - the connection is answered with exactly the action's `returns` fields (or,
 *   where a route has several answers, within them);
 * - it acts as the signed-in member only, though that member is also a Full
 *   Admin (`officerMemberSession`): another member's booking, or an on-behalf
 *   target, is refused to the connection and still open to the officer's
 *   browser;
 * - the browser's answer keeps what the website needs and the connection never
 *   sees.
 *
 * The pricing, promo and capacity engines are fixtures; the routes, the
 * connection projection and the member-only session are real.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  bookingFindUnique: vi.fn(),
  seasonFindMany: vi.fn(),
  groupDiscountFindUnique: vi.fn(),
  bookingRequestFindFirst: vi.fn(),
  promoCodeFindUnique: vi.fn(),
  promoCodeFindMany: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  findConflicts: vi.fn(),
  getLodgeCapacity: vi.fn(),
  priceGuests: vi.fn(),
  calculateChangeFee: vi.fn(),
  loadModuleFlags: vi.fn(),
  validateMinimumStay: vi.fn(),
  getMemberCreditBalance: vi.fn(),
  validateAndCalculatePromoDiscount: vi.fn(),
  settlementOptions: vi.fn(),
  organiserChildChargeRefusal: vi.fn(),
  estimateAddedGuests: vi.fn(),
  nonMemberPricing: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({ requireActiveSessionUser: vi.fn(async () => null) }));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn(async () => null),
  checkRateLimit: vi.fn(async () => ({ success: true, resetAt: 0 })),
  rateLimiters: { bookingQuery: {} },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    manualRefundTask: { findFirst: vi.fn().mockResolvedValue(null) },
    booking: { findUnique: h.bookingFindUnique },
    promoCode: { findUnique: h.promoCodeFindUnique, findMany: h.promoCodeFindMany },
    season: { findMany: h.seasonFindMany },
    groupDiscountSetting: { findUnique: h.groupDiscountFindUnique },
    bookingRequest: { findFirst: h.bookingRequestFindFirst },
    bookingGuest: { findMany: vi.fn().mockResolvedValue([]) },
    // The club's day: present, so the real reader runs rather than its fail-soft fallback.
    clubTimeSettings: { findUnique: vi.fn().mockResolvedValue({ timeZone: "Pacific/Auckland" }) },
  },
}));
vi.mock("@/lib/capacity", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/capacity")),
  checkCapacityForGuestRanges: h.checkCapacityForGuestRanges,
}));
vi.mock("@/lib/lodge-capacity", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/lodge-capacity")),
  getLodgeCapacity: h.getLodgeCapacity,
}));
vi.mock("@/lib/booking-member-night-conflicts", () => ({
  findBookingMemberNightConflicts: h.findConflicts,
  getBookingMemberNightConflictResponse: (conflicts: unknown[]) => ({ code: "CONFLICT", conflicts }),
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: vi.fn(async () => "lodge-1"),
  resolveOptionalActiveLodgeId: vi.fn(async () => "lodge-1"),
  lodgeNullTolerantScope: () => ({}),
}));
vi.mock("@/lib/lodge-access", () => ({ isMemberEligibleToBookLodge: vi.fn(async () => true) }));
vi.mock("@/lib/membership-type-policy", () => ({
  assertMembershipTypeBookingAllowed: vi.fn().mockResolvedValue(undefined),
  resolveGuestRateMembershipTypes: vi.fn(async (_db: unknown, { guests }: { guests: Array<Record<string, unknown>> }) =>
    guests.map((guest) => ({ ...guest, rateMembershipTypeId: "type-full", rateSource: "MEMBERSHIP_TYPE" })),
  ),
  priceBookingGuestsWithMembershipTypePolicy: h.priceGuests,
  MembershipTypeBookingPolicyError: class extends Error {},
  getMembershipTypeBookingPolicyErrorBody: (error: Error) => ({ error: error.message }),
}));
vi.mock("@/lib/booking-modify", async () => {
  // The real beneficiary resolver: id binding is not what these tests are about.
  const { resolvePromoBeneficiarySelection } = (await vi.importActual(
    "@/lib/booking-modify-plan",
  )) as typeof import("@/lib/booking-modify-plan");
  return {
    isQuotePricedBooking: vi.fn().mockResolvedValue(false),
    isMemberWholeLodgeBooking: vi.fn().mockResolvedValue(false),
    resolveGuestMemberLinks: vi.fn().mockReturnValue([]),
    resolveGuestNameUpdates: vi.fn().mockReturnValue([]),
    editedGuestPricingLocks: vi.fn().mockReturnValue({ lockedNightPrices: null }),
    calculateModificationSettlementOptions: h.settlementOptions,
    organiserChildChargeRefusal: h.organiserChildChargeRefusal,
    resolvePromoBeneficiarySelection,
    QUOTE_PRICED_EDIT_BLOCK_MESSAGE: "quote-priced",
  };
});
vi.mock("@/lib/booking-guests", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/booking-guests")),
  computeMemberGuestBoundary: vi.fn().mockResolvedValue({ scopeByMemberId: new Map(), beyondFamilyMemberIds: [] }),
  resolveLinkedBookingMembers: vi.fn().mockResolvedValue([]),
  resolveLinkedBookingMembersWithBoundary: vi.fn().mockResolvedValue({
    members: new Map(),
    boundary: { scopeByMemberId: new Map(), beyondFamilyMemberIds: [] },
  }),
  assertLinkedBookingMembersCanBeBooked: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/member-guest-add-policy", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/member-guest-add-policy")),
  loadMemberGuestAddPolicy: vi.fn(async () => ({
    wideningEnabled: false,
    approvalRequired: true,
    pendingHoldExpiryDays: 0,
  })),
}));
vi.mock("@/lib/booking-member-guest-subscriptions", () => ({ findUnpaidMemberGuestNames: vi.fn(async () => []) }));
vi.mock("@/lib/cancellation", () => ({
  loadCancellationPolicy: vi.fn().mockResolvedValue([]),
  daysUntilDate: vi.fn().mockReturnValue(5),
  getNonMemberHoldPolicy: vi.fn().mockResolvedValue({ enabled: true, holdDays: 7, source: "default" }),
}));
vi.mock("@/lib/change-fee", () => ({ calculateChangeFee: h.calculateChangeFee }));
vi.mock("@/lib/module-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/module-settings")),
  loadEffectiveModuleFlags: h.loadModuleFlags,
}));
vi.mock("@/lib/xero-token-store", () => ({ isXeroConnected: vi.fn(async () => false) }));
vi.mock("@/lib/xero-organisation", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-organisation")),
  getXeroLockDates: vi.fn(async () => ({ periodLockDate: null, endOfYearLockDate: null })),
}));
vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: h.validateMinimumStay,
  formatViolationsDetail: (violations: unknown[]) => `minimum-stay violations: ${violations.length}`,
  formatViolationMessage: () => "minimum-stay violation",
}));
vi.mock("@/lib/member-credit", () => ({
  getMemberCreditBalance: h.getMemberCreditBalance,
  requireMemberCreditRecipient: (memberId: string | null) => {
    if (!memberId) throw new Error("no account to credit");
    return memberId;
  },
}));
// The several-code engine is the real orchestrator over this one stubbed rule.
vi.mock("@/lib/promo", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/promo")),
  validateAndCalculatePromoDiscount: h.validateAndCalculatePromoDiscount,
}));
vi.mock("@/lib/policies/booking-route-decisions", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/policies/booking-route-decisions")),
  priceDeferredNonMemberPortion: vi.fn(async () => ({ totalPriceCents: 4000 })),
}));
vi.mock("@/lib/subscription-lockout-enforcement", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/subscription-lockout-enforcement")),
  evaluateNonMemberPricingRequirements: h.nonMemberPricing,
}));
vi.mock("@/lib/member-subscription-eligibility", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/member-subscription-eligibility")),
  resolveSubscriptionLockoutMode: vi.fn(async () => "NON_MEMBER_PRICING"),
}));
vi.mock("@/lib/booking-change-request-estimate", () => ({ estimateChangeRequestAddedGuests: h.estimateAddedGuests }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { POST as quoteChangeRequest } from "@/app/api/bookings/[id]/change-requests/quote/route";
import { POST as quoteChange } from "@/app/api/bookings/[id]/modify-quote/route";
import { POST as quoteStay } from "@/app/api/bookings/quote/route";
import { POST as checkPromo } from "@/app/api/promo-codes/validate/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";
import { MCP_PRINCIPAL_HEADER } from "@/lib/mcp/principal";

/** Every key anywhere in a JSON value. */
function allKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, keys);
  } else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      keys.add(key);
      allKeys(inner, keys);
    }
  }
  return keys;
}

/** The same POST as a connection and as the officer's browser, for a request the member may not make. */
async function statusesFor(
  handler: (request: never, context: never) => Promise<Response>,
  path: string,
  params: Record<string, string>,
  body: unknown,
): Promise<{ connection: number; browser: number }> {
  const call = handler as unknown as (r: Request, c: unknown) => Promise<Response>;
  const run = async (viaConnection: boolean) => {
    const request = new NextRequest(new URL(path, "https://club.example.test"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(viaConnection ? { [MCP_PRINCIPAL_HEADER]: "contract-test-principal" } : {}),
      },
      body: JSON.stringify(body),
    });
    return (await call(request, { params: Promise.resolve(params) })).status;
  };
  return { connection: await run(true), browser: await run(false) };
}

const D = (value: string) => new Date(`${value}T00:00:00.000Z`);

/** A draft stay for one member guest, 14 to 16 August 2026, $200.00 stored. */
function draftOwnedBy(memberId: string) {
  return {
    id: "b1",
    status: "DRAFT",
    memberId,
    lodgeId: "lodge-1",
    checkIn: D("2026-08-14"),
    checkOut: D("2026-08-16"),
    totalPriceCents: 20_000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 20_000,
    payment: null,
    promoRedemption: null,
    guests: [
      {
        id: "g1",
        ageTier: "ADULT",
        isMember: true,
        memberId,
        stayStart: D("2026-08-14"),
        stayEnd: D("2026-08-16"),
        priceCents: 20_000,
        nights: [
          { stayDate: D("2026-08-14"), priceCents: 10_000, priceSource: "SOLD" },
          { stayDate: D("2026-08-15"), priceCents: 10_000, priceSource: "SOLD" },
        ],
      },
    ],
  };
}

/** The price the engine gives each route's party: the member rate row carries ids the app never sees. */
function pricedGuest(overrides: Record<string, unknown> = {}) {
  return {
    ageTier: "ADULT",
    isMember: true,
    nights: 3,
    priceCents: 30_000,
    perNightCents: [10_000, 10_000, 10_000],
    nightDates: [D("2026-08-14"), D("2026-08-15"), D("2026-08-16")],
    rateMembershipTypeId: "type-full",
    memberId: "member-9",
    ...overrides,
  };
}

const MATES50_ROW = {
  id: "promo-mates50",
  code: "MATES50",
  description: "Fifty off for mates",
  internal: false,
  type: "PERCENTAGE",
  assignments: [],
  lodges: [],
};

const PROMO_DISCOUNT = {
  beneficiaryMemberIds: [],
  selectedGuestIndexes: [0],
  remainingFreeNights: null,
  discount: {
    discountCents: 5_000,
    priceAdjustmentCents: -5_000,
    freeNightsUsed: 0,
    eligibleGuestCount: 1,
    allocations: [],
    targets: [],
    adjustmentTargets: [],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue(officerMemberSession());
  h.bookingFindUnique.mockResolvedValue(draftOwnedBy("officer-1"));
  h.seasonFindMany.mockResolvedValue([]);
  h.groupDiscountFindUnique.mockResolvedValue(null);
  h.bookingRequestFindFirst.mockResolvedValue(null);
  h.promoCodeFindUnique.mockResolvedValue(MATES50_ROW);
  h.promoCodeFindMany.mockResolvedValue([MATES50_ROW]);
  h.getLodgeCapacity.mockResolvedValue(29);
  h.findConflicts.mockResolvedValue([]);
  h.checkCapacityForGuestRanges.mockResolvedValue({ available: true, minAvailable: 5, nightDetails: [] });
  h.priceGuests.mockResolvedValue({ totalPriceCents: 30_000, guests: [pricedGuest()] });
  h.calculateChangeFee.mockReturnValue({ feeCents: 0 });
  h.loadModuleFlags.mockResolvedValue({ xeroIntegration: false, mcpServer: true });
  h.validateMinimumStay.mockResolvedValue({ valid: true, violations: [] });
  h.getMemberCreditBalance.mockResolvedValue(8_650);
  h.settlementOptions.mockResolvedValue(null);
  h.organiserChildChargeRefusal.mockReturnValue(null);
  h.validateAndCalculatePromoDiscount.mockResolvedValue(PROMO_DISCOUNT);
  h.nonMemberPricing.mockResolvedValue({ memberRateNotice: "Unpaid subscriptions pay the non-member rate", violation: null });
});

describe("quote_booking", () => {
  const ARGS = {
    checkIn: "2026-08-14",
    checkOut: "2026-08-17",
    guests: [
      { ageTier: "ADULT", isMember: true, memberId: "member-9" },
      { ageTier: "CHILD", isMember: false },
    ],
  };

  beforeEach(() => {
    h.priceGuests.mockResolvedValue({
      totalPriceCents: 45_000,
      guests: [
        pricedGuest(),
        pricedGuest({ ageTier: "CHILD", isMember: false, priceCents: 15_000, memberId: null, rateMembershipTypeId: "type-non" }),
      ],
    });
  });

  it("answers with each guest's price and the hold decision, never the rate type or member ids", async () => {
    const { connection, browser } = await expectActionContract({
      actionId: "quote_booking",
      handler: quoteStay,
      args: ARGS,
    });
    expect(connection).toMatchObject({
      totalPriceCents: 45_000,
      availableCreditCents: 8_650,
      deferredGuestPortionCents: 4_000,
      subscriptionMemberRateNotice: "Unpaid subscriptions pay the non-member rate",
      paidUpAdultMemberMissing: false,
      nonMemberHoldDecision: { enabled: true, holdDays: 7 },
    });
    // The website keeps the rate identity and where the hold policy came from.
    expect(allKeys(browser).has("rateMembershipTypeId")).toBe(true);
    expect(allKeys(browser).has("source")).toBe(true);
    for (const withheld of ["rateMembershipTypeId", "memberId", "source"]) {
      expect(allKeys(connection).has(withheld), withheld).toBe(false);
    }
  });

  it("prices the signed-in member's own account, though they are a Full Admin", async () => {
    await expectActionContract({ actionId: "quote_booking", handler: quoteStay, args: ARGS });
    expect(h.getMemberCreditBalance).toHaveBeenCalledWith("officer-1");
  });

  it("refuses the connection an on-behalf target, which the officer's browser may quote", async () => {
    const body = { ...ARGS, forMemberId: "someone-else" };
    expect(await statusesFor(quoteStay, "/api/bookings/quote", {}, body)).toEqual({ connection: 403, browser: 200 });
    // The refused connection priced nobody; the officer's browser priced the target.
    expect(h.getMemberCreditBalance.mock.calls.map(([memberId]) => memberId)).toEqual(["someone-else"]);
  });
});

describe("check_promo_code", () => {
  const STAY = {
    checkIn: "2026-08-14",
    checkOut: "2026-08-17",
    guests: [{ ageTier: "ADULT", isMember: true, memberId: "officer-1" }],
  };

  it("answers for one code with what it takes off, never the code's own record", async () => {
    const { connection, browser } = await expectActionContract({
      actionId: "check_promo_code",
      handler: checkPromo,
      args: { ...STAY, code: "MATES50" },
      oneOfSeveralAnswers: true,
    });
    expect(connection).toMatchObject({
      valid: true,
      code: "MATES50",
      description: "Fifty off for mates",
      type: "PERCENTAGE",
      discountCents: 5_000,
      promoAdjustmentCents: -5_000,
      totalPriceCents: 30_000,
      finalPriceCents: 25_000,
    });
    expect(connection).toEqual(browser);
    for (const withheld of ["id", "internal", "assignments", "lodges", "promoCode"]) {
      expect(allKeys(connection).has(withheld), withheld).toBe(false);
    }
    // The member's own account is the one the code is judged against.
    expect(h.validateAndCalculatePromoDiscount.mock.calls[0]?.[1]).toMatchObject({ memberId: "officer-1" });
  });

  it("answers for several codes, each with its own outcome and the booking's totals", async () => {
    const { connection } = await expectActionContract({
      actionId: "check_promo_code",
      handler: checkPromo,
      args: { ...STAY, codes: [{ code: "MATES50" }] },
      oneOfSeveralAnswers: true,
    });
    expect(connection).toMatchObject({
      valid: true,
      codes: [{ code: "MATES50", valid: true, discountCents: 5_000, description: "Fifty off for mates" }],
      discountCents: 5_000,
      promoAdjustmentCents: -5_000,
      totalPriceCents: 30_000,
      finalPriceCents: 25_000,
    });
    for (const withheld of ["id", "internal", "assignments", "lodges", "promoCode"]) {
      expect(allKeys(connection).has(withheld), withheld).toBe(false);
    }
  });

  it("answers a code that needs the guests chosen with the guests it may go to", async () => {
    h.validateAndCalculatePromoDiscount.mockResolvedValue({
      error: "Choose which guests should receive this promo code",
      requiresGuestSelection: true,
      selectableGuestIndexes: [0],
      beneficiaryMemberIds: [],
    });
    const { connection } = await expectActionContract({
      actionId: "check_promo_code",
      handler: checkPromo,
      args: { ...STAY, code: "MATES50" },
      oneOfSeveralAnswers: true,
    });
    expect(connection).toMatchObject({ valid: false, requiresGuestSelection: true, selectableGuestIndexes: [0] });
  });

  it("refuses the connection an on-behalf target, which the officer's browser may check", async () => {
    const body = { ...STAY, code: "MATES50", forMemberId: "someone-else" };
    expect(await statusesFor(checkPromo, "/api/promo-codes/validate", {}, body)).toEqual({
      connection: 403,
      browser: 200,
    });
  });

  it("answers the connection as if another member's booking did not exist, which the officer's browser may check", async () => {
    h.bookingFindUnique.mockResolvedValue(draftOwnedBy("someone-else"));
    const body = { ...STAY, code: "MATES50", bookingId: "booking-2" };
    const { connection, browser } = await statusesFor(checkPromo, "/api/promo-codes/validate", {}, body);
    expect(connection).toBe(404);
    expect(browser).not.toBe(404);
  });
});

describe("quote_booking_change", () => {
  const SETTLEMENT = {
    basisAmountCents: 10_000,
    paymentMethod: "STRIPE",
    options: [{ kind: "REFUND_TO_CARD", amountCents: 10_000 }],
  };

  it("answers with the figures, the promo outcome and the line items, never the settlement step", async () => {
    h.settlementOptions.mockResolvedValue(SETTLEMENT);
    const { connection, browser } = await expectActionContract({
      actionId: "quote_booking_change",
      handler: quoteChange,
      args: { id: "b1", checkOut: "2026-08-17", promoCodes: [{ code: "MATES50" }] },
      oneOfSeveralAnswers: true,
    });
    expect(connection).toMatchObject({
      newTotalPriceCents: 30_000,
      newPromoAdjustmentCents: -5_000,
      newFinalPriceCents: 25_000,
      priceDiffCents: 5_000,
      availableCreditCents: 8_650,
      capacityAvailable: true,
      minimumStayValid: true,
      promoStillValid: true,
      promoValidation: { valid: true, code: "MATES50", discountCents: 5_000, promoAdjustmentCents: -5_000 },
    });
    // The website's save step works through these with the member.
    expect(browser).toMatchObject({
      settlementOptions: SETTLEMENT,
      quotedFigures: { newFinalPriceCents: 25_000, priceDiffCents: 5_000, changeFeeCents: 0, netChargeCents: 5_000 },
    });
    for (const withheld of ["settlementOptions", "quotedFigures", "exceptionReview", "billedToOrganiser", "promoChangeNotApplied"]) {
      expect(allKeys(connection).has(withheld), withheld).toBe(false);
    }
  });

  it("tells the app a requested promo code was refused, so the change is not previewed as clean", async () => {
    h.validateAndCalculatePromoDiscount.mockResolvedValue({
      error: "This promo code has expired",
      beneficiaryMemberIds: [],
    });
    const { connection, browser } = await expectActionContract({
      actionId: "quote_booking_change",
      handler: quoteChange,
      args: { id: "b1", checkOut: "2026-08-17", promoCodes: [{ code: "MATES50" }] },
      oneOfSeveralAnswers: true,
    });
    expect(connection).toMatchObject({
      promoValidation: { valid: false, error: "This promo code has expired" },
      // A refused code takes nothing off.
      newPromoAdjustmentCents: 0,
    });
    expect((browser as { promoValidation: unknown }).promoValidation).toEqual({
      valid: false,
      error: "This promo code has expired",
    });
  });

  it("tells the app the nights that are full, and not the beds on them", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue({
      available: false,
      minAvailable: -1,
      nightDetails: [
        { date: D("2026-08-14"), occupiedBeds: 30, availableBeds: -1, wholeLodgeHeld: false },
        { date: D("2026-08-15"), occupiedBeds: 25, availableBeds: 4, wholeLodgeHeld: false },
      ],
    });
    const { connection } = await expectActionContract({
      actionId: "quote_booking_change",
      handler: quoteChange,
      args: { id: "b1", checkOut: "2026-08-17" },
      oneOfSeveralAnswers: true,
    });
    expect(connection).toMatchObject({ capacityAvailable: false, capacityFullNights: ["2026-08-14"] });
    for (const withheld of ["nightDetails", "minAvailable", "occupiedBeds", "availableBeds"]) {
      expect(allKeys(connection).has(withheld), withheld).toBe(false);
    }
  });

  it("tells the app the organiser refusal the save would give", async () => {
    h.organiserChildChargeRefusal.mockReturnValue("The organiser is billed for this place");
    const { connection } = await expectActionContract({
      actionId: "quote_booking_change",
      handler: quoteChange,
      args: { id: "b1", checkOut: "2026-08-17" },
      oneOfSeveralAnswers: true,
    });
    expect(connection).toMatchObject({ chargeRefusal: "The organiser is billed for this place" });
  });

  it("refuses the connection another member's booking, which the officer's browser may quote", async () => {
    h.bookingFindUnique.mockResolvedValue(draftOwnedBy("someone-else"));
    expect(await statusesFor(quoteChange, "/api/bookings/b1/modify-quote", { id: "b1" }, { checkOut: "2026-08-17" })).toEqual({
      connection: 403,
      browser: 200,
    });
  });
});

describe("quote_booking_change_request", () => {
  const BOOKING = {
    memberId: "officer-1",
    deletedAt: null,
    checkIn: D("2026-06-30"),
    checkOut: D("2026-07-03"),
    lodgeId: "lodge-1",
    guests: [
      {
        id: "g1",
        firstName: "Existing",
        lastName: "Guest",
        stayStart: D("2026-06-30"),
        stayEnd: D("2026-07-03"),
        ageTier: "ADULT",
        isMember: true,
        nights: [{ stayDate: D("2026-06-30") }, { stayDate: D("2026-07-01") }, { stayDate: D("2026-07-02") }],
      },
    ],
  };
  const ARGS = {
    id: "booking-1",
    addGuests: [{ firstName: "Ari", lastName: "Example", ageTier: "CHILD", isMember: false }],
  };

  beforeEach(() => {
    h.bookingFindUnique.mockResolvedValue(BOOKING);
  });

  it("answers with each added guest's estimate and the total", async () => {
    h.estimateAddedGuests.mockResolvedValue({
      outcome: "priced",
      guests: [{ priceCents: 6_000, nights: 3 }],
      totalCents: 6_000,
      excludesMemberGuests: false,
    });
    const { connection, browser } = await expectActionContract({
      actionId: "quote_booking_change_request",
      handler: quoteChangeRequest,
      args: ARGS,
      oneOfSeveralAnswers: true,
    });
    expect(connection).toEqual(browser);
    expect(connection).toEqual({
      estimate: { outcome: "priced", guests: [{ priceCents: 6_000, nights: 3 }], totalCents: 6_000, excludesMemberGuests: false },
    });
  });

  it("answers a stay that cannot be priced with the reason in words", async () => {
    h.estimateAddedGuests.mockResolvedValue({ outcome: "unpriced", message: "These nights can't be priced at the moment" });
    const { connection } = await expectActionContract({
      actionId: "quote_booking_change_request",
      handler: quoteChangeRequest,
      args: ARGS,
      oneOfSeveralAnswers: true,
    });
    expect(connection).toEqual({ estimate: { outcome: "unpriced", message: "These nights can't be priced at the moment" } });
  });

  it("refuses the connection another member's booking, which the officer's browser may estimate", async () => {
    h.estimateAddedGuests.mockResolvedValue({
      outcome: "priced",
      guests: [{ priceCents: 6_000, nights: 3 }],
      totalCents: 6_000,
      excludesMemberGuests: false,
    });
    h.bookingFindUnique.mockResolvedValue({ ...BOOKING, memberId: "someone-else" });
    expect(
      await statusesFor(quoteChangeRequest, "/api/bookings/booking-2/change-requests/quote", { id: "booking-2" }, {
        addGuests: ARGS.addGuests,
      }),
    ).toEqual({ connection: 403, browser: 200 });
  });
});
