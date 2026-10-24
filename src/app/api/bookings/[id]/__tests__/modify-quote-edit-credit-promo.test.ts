import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// #2266 (epic #2245, E2): the modify-quote preview gains the two create-flow
// surfaces the edit path lost —
//
//  (a) `availableCreditCents` on the response (the BOOKING OWNER's live
//      balance), so the edit panel's credit card mirrors the create quote;
//  (b) promo beneficiaries on the request (MED-4: `promoGuestIds` for
//      existing guests, `promoAddedGuestIndexes` for to-be-added ones),
//      resolved and threaded into the promo validator so a guest-targeted
//      code previews against the same beneficiaries the apply route will
//      redeem for — and a stale id 400s at preview exactly as at apply;
//
// plus the price-preserving contract for a credit-only preview (no repricing,
// no capacity check — a season-rate change must never surface a phantom price
// diff on an untouched booking), and the DRAFT rules a member's Resume journey
// now exercises: drafts quote with no change fee.

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  authorizationRole: vi.fn(),
  bookingFindUnique: vi.fn(),
  seasonFindMany: vi.fn(),
  groupDiscountFindUnique: vi.fn(),
  bookingRequestFindFirst: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  findConflicts: vi.fn(),
  getDefaultLodgeId: vi.fn(),
  getLodgeCapacity: vi.fn(),
  priceGuests: vi.fn(),
  calculateChangeFee: vi.fn(),
  loadModuleFlags: vi.fn(),
  isXeroConnected: vi.fn(),
  getXeroLockDates: vi.fn(),
  validateMinimumStay: vi.fn(),
  getMemberCreditBalance: vi.fn(),
  promoCodeFindUnique: vi.fn(),
  validateAndCalculatePromoDiscount: vi.fn(),
  findUnpaidMemberGuestNames: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: h.requireActiveSessionUser,
}));
vi.mock("@/lib/admin-permissions", () => ({
  bookingManagementAuthorizationRole: h.authorizationRole,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    // #3032: the preview half of the pending-review fence reads this. Empty by
    // default - no financial review is open - so this suite asserts exactly what
    // it asserted before.
    manualRefundTask: { findFirst: vi.fn().mockResolvedValue(null) },
    booking: { findUnique: h.bookingFindUnique },
    // #3827: the preview reads a typed code itself, as the save does.
    promoCode: { findUnique: h.promoCodeFindUnique },
    season: { findMany: h.seasonFindMany },
    groupDiscountSetting: { findUnique: h.groupDiscountFindUnique },
    bookingRequest: { findFirst: h.bookingRequestFindFirst },
    // #3123: the route resolves the CLUB's day before it quotes anything. The
    // delegate is present rather than absent on purpose — `getClubTimeZone` is
    // fail-soft on a missing one and degrades silently to the environment, so
    // omitting it would mean this suite exercised a fallback while appearing to
    // exercise the real read (A4's trap).
    clubTimeSettings: {
      findUnique: vi.fn().mockResolvedValue({ timeZone: "America/Denver" }),
    },
  },
}));
vi.mock("@/lib/capacity", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/capacity");
  return { ...actual, checkCapacityForGuestRanges: h.checkCapacityForGuestRanges };
});
vi.mock("@/lib/booking-member-night-conflicts", () => ({
  findBookingMemberNightConflicts: h.findConflicts,
  getBookingMemberNightConflictResponse: (conflicts: unknown[]) => ({
    code: "BOOKING_MEMBER_NIGHT_CONFLICT",
    conflicts,
  }),
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: h.getDefaultLodgeId,
  lodgeNullTolerantScope: () => ({}),
}));
// #3032: PARTIAL mock. The pending-review fence added an import to
// `modify-quote/route.ts`, which widened this suite's module graph until
// `club-identity.ts` read `FALLBACK_LODGE_CAPACITY` at import time and the whole
// file died before a single test ran. `importOriginal` keeps every other export
// real, so the next widening cannot break it the same way (docs/TESTING.md).
vi.mock("@/lib/lodge-capacity", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/lodge-capacity");
  return { ...actual, getLodgeCapacity: h.getLodgeCapacity };
});
vi.mock("@/lib/membership-type-policy", () => ({
  assertMembershipTypeBookingAllowed: vi.fn().mockResolvedValue(undefined),
  resolveGuestRateMembershipTypes: vi
    .fn()
    .mockImplementation((_db: unknown, { guests }: { guests: Array<Record<string, unknown>> }) =>
      Promise.resolve(
        guests.map((g) => ({
          ...g,
          rateMembershipTypeId: "type-full",
          rateSource: "MEMBERSHIP_TYPE",
        })),
      ),
    ),
  priceBookingGuestsWithMembershipTypePolicy: h.priceGuests,
  MembershipTypeBookingPolicyError: class extends Error {},
  getMembershipTypeBookingPolicyErrorBody: (e: Error) => ({ error: e.message }),
}));
vi.mock("@/lib/booking-modify", async () => {
  // The REAL beneficiary resolver (MED-4): id binding is the behaviour under
  // test, so it must not be stubbed away.
  const { resolvePromoBeneficiarySelection } = (await vi.importActual("@/lib/booking-modify-plan")) as typeof import("@/lib/booking-modify-plan");
  return {
    isQuotePricedBooking: vi.fn().mockResolvedValue(false),
    // #2337: no link in these fixtures, so both new gate collaborators are inert.
    isMemberWholeLodgeBooking: vi.fn().mockResolvedValue(false),
    resolveGuestMemberLinks: vi.fn().mockReturnValue([]),
    resolveGuestNameUpdates: vi.fn().mockReturnValue([]),
    // #3531: the route reaches the reader through this wrapper; the null it
    // answers is exactly what the reader stub above answers.
    editedGuestPricingLocks: vi.fn().mockReturnValue({ lockedNightPrices: null }),
    calculateModificationSettlementOptions: vi.fn().mockResolvedValue(null),
    // #3653: the organiser-card increase refusal; none of these is one.
    organiserChildChargeRefusal: vi.fn().mockReturnValue(null),
    resolvePromoBeneficiarySelection,
    QUOTE_PRICED_EDIT_BLOCK_MESSAGE: "quote-priced",
  };
});
vi.mock("@/lib/booking-guests", () => ({
  // MG3 (#2308) C1: `markCrossFamilyGuestsOnBooking` re-derives the D-8 marker
  // over the WHOLE proposed party from this function. These fixtures are about
  // pricing/payment rather than family boundaries, and were written when every
  // member-linked guest in them was family scope, so an empty boundary states
  // that assumption explicitly. The C1 behaviour itself is covered by
  // `member-guest-cross-family-refusals.test.ts` and by the source contract in
  // `review-findings-contracts.test.ts`.
  computeMemberGuestBoundary: vi.fn().mockResolvedValue({
    scopeByMemberId: new Map(),
    beyondFamilyMemberIds: [],
  }),
  resolveLinkedBookingMembers: vi.fn().mockResolvedValue([]),
  // MG2 (#2307): the widened call sites use the boundary-returning variant. An
  // empty boundary is "everybody is inside the booker's family", which is this
  // test's world unchanged. Added when #2266 and #2307 met in the merge.
  resolveLinkedBookingMembersWithBoundary: vi.fn().mockResolvedValue({
    members: new Map(),
    boundary: { scopeByMemberId: new Map(), beyondFamilyMemberIds: [] },
  }),
  assertLinkedBookingMembersCanBeBooked: vi.fn().mockResolvedValue(undefined),
  normalizeBookingGuestInputs: vi.fn().mockReturnValue([]),
  BookingGuestValidationError: class extends Error {},
  getBookingGuestValidationErrorResponse: (e: Error) => ({ error: e.message }),
}));
vi.mock("@/lib/booking-member-guest-subscriptions", () => ({
  findUnpaidMemberGuestNames: h.findUnpaidMemberGuestNames,
}));
vi.mock("@/lib/cancellation", () => ({
  loadCancellationPolicy: vi.fn().mockResolvedValue([]),
  daysUntilDate: vi.fn().mockReturnValue(5),
}));
vi.mock("@/lib/change-fee", () => ({ calculateChangeFee: h.calculateChangeFee }));
// Partial rather than replacing the module wholesale: this route's graph reaches
// `admin-modules.ts`, which re-exports `normalizeClubModuleSettings` at module
// scope, so a mock that returns only `loadEffectiveModuleFlags` makes the whole
// file fail to import the moment anything else in the graph pulls
// `admin-modules` in (#2307's member-guest add policy did exactly that). Keeping
// the real module underneath means a future export cannot break this suite for a
// reason that has nothing to do with what it tests.
vi.mock("@/lib/module-settings", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/module-settings");
  return { ...actual, loadEffectiveModuleFlags: h.loadModuleFlags };
});
vi.mock("@/lib/xero-token-store", () => ({
  isXeroConnected: h.isXeroConnected,
}));
vi.mock("@/lib/xero-organisation", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@/lib/xero-organisation");
  return { ...actual, getXeroLockDates: h.getXeroLockDates };
});
vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: h.validateMinimumStay,
  formatViolationsDetail: (violations: unknown[]) =>
    `minimum-stay violations: ${violations.length}`,
  formatViolationMessage: () => "minimum-stay violation",
}));
vi.mock("@/lib/member-credit", () => ({
  getMemberCreditBalance: h.getMemberCreditBalance,
  // #3369: the one home for the account-credit refusal four settlement paths
  // share. Real, not stubbed: the mock must not turn a refusal into a pass.
  requireMemberCreditRecipient: (memberId: string | null) => {
    if (!memberId) throw new Error("no account to credit (#3369)");
    return memberId;
  },
}));
// #3827: the preview prices through the several-code orchestrator, which runs
// the single-code engine once per code — so the engine is what is stubbed, and
// every other export (the guest-count refusal it reads) stays real.
vi.mock("@/lib/promo", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/promo")),
  validateAndCalculatePromoDiscount: h.validateAndCalculatePromoDiscount,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { POST } from "@/app/api/bookings/[id]/modify-quote/route";
import { SEVERAL_PROMO_CODES_ONE_CODE_EDIT_MESSAGE } from "@/lib/promo-code-list-rules";

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const NOW = new Date("2026-08-01T06:00:00.000Z");

function req(body: unknown) {
  return new NextRequest("http://localhost/api/bookings/b1/modify-quote", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const params = Promise.resolve({ id: "b1" });

// Aroha's draft (the signed-off mockup scenario): 14–16 Aug 2026, one member
// guest, $200.00 stored price, $86.50 of account credit.
function memberDraft() {
  return {
    id: "b1",
    status: "DRAFT",
    memberId: "m1",
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
        memberId: "m1",
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  // A member editing their OWN draft — the journey #2266 opens up.
  h.auth.mockResolvedValue({ user: { id: "m1" } });
  h.requireActiveSessionUser.mockResolvedValue(null);
  h.authorizationRole.mockReturnValue("USER");
  h.bookingFindUnique.mockResolvedValue(memberDraft());
  h.seasonFindMany.mockResolvedValue([
    {
      id: "season-1",
      startDate: D("2026-06-01"),
      endDate: D("2026-10-31"),
      membershipTypeRates: [
        { membershipTypeId: "type-full", ageTier: "ADULT", pricePerNightCents: 10_000 },
      ],
    },
  ]);
  h.groupDiscountFindUnique.mockResolvedValue(null);
  h.bookingRequestFindFirst.mockResolvedValue(null);
  h.getDefaultLodgeId.mockResolvedValue("lodge-1");
  h.getLodgeCapacity.mockResolvedValue(29);
  h.findConflicts.mockResolvedValue([]);
  h.findUnpaidMemberGuestNames.mockResolvedValue([]);
  h.checkCapacityForGuestRanges.mockResolvedValue({
    available: true,
    minAvailable: 5,
    nightDetails: [],
  });
  h.priceGuests.mockResolvedValue({
    totalPriceCents: 30_000,
    guests: [
      {
        priceCents: 30_000,
        perNightCents: [10_000, 10_000, 10_000],
        nightDates: [D("2026-08-14"), D("2026-08-15"), D("2026-08-16")],
      },
    ],
  });
  h.calculateChangeFee.mockReturnValue({ feeCents: 12_345 });
  h.loadModuleFlags.mockResolvedValue({ xeroIntegration: false });
  h.isXeroConnected.mockResolvedValue(false);
  h.getXeroLockDates.mockResolvedValue({
    periodLockDate: null,
    endOfYearLockDate: null,
  });
  h.validateMinimumStay.mockResolvedValue({ valid: true, violations: [] });
  h.getMemberCreditBalance.mockResolvedValue(8_650);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("POST /api/bookings/[id]/modify-quote — credit surfacing (#2266)", () => {
  it("echoes the stored money for a credit-only preview — no repricing, no capacity check", async () => {
    const res = await POST(req({ applyCreditCents: 8_650 }), { params });

    expect(res.status).toBe(200);
    const body = await res.json();
    // Price-preserving echo: the stored booking, zero deltas.
    expect(body.newFinalPriceCents).toBe(20_000);
    expect(body.priceDiffCents).toBe(0);
    expect(body.changeFeeCents).toBe(0);
    expect(body.capacityAvailable).toBe(true);
    // The create-parity credit field, and it is the OWNER's live balance.
    expect(body.availableCreditCents).toBe(8_650);
    expect(h.getMemberCreditBalance).toHaveBeenCalledWith("m1");
    // The whole point: nothing repriced, nothing capacity-checked.
    expect(h.priceGuests).not.toHaveBeenCalled();
    expect(h.checkCapacityForGuestRanges).not.toHaveBeenCalled();
  });

  it("returns availableCreditCents on a full (repriced) preview too", async () => {
    const res = await POST(req({ checkOut: "2026-08-17" }), { params });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.availableCreditCents).toBe(8_650);
    expect(h.priceGuests).toHaveBeenCalled();
  });

  it("never charges a change fee on a DRAFT, even when the check-in moves", async () => {
    const res = await POST(
      req({ checkIn: "2026-08-15", checkOut: "2026-08-17" }),
      { params },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changeFeeCents).toBe(0);
    expect(h.calculateChangeFee).not.toHaveBeenCalled();
  });

  it("rejects a credit election riding an admin override (date-only contract)", async () => {
    h.auth.mockResolvedValue({ user: { id: "admin1" } });
    h.authorizationRole.mockReturnValue("ADMIN");

    const res = await POST(
      req({
        adminOverride: true,
        pricingMode: "shift",
        checkIn: "2026-08-20",
        applyCreditCents: 0,
      }),
      { params },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/dates only/);
  });
});

/** The typed code as the preview reads it (#3827). */
const MATES50_ROW = {
  id: "promo-mates50",
  code: "MATES50",
  internal: false,
  type: "PERCENTAGE",
  assignments: [],
  lodges: [],
};

describe("POST /api/bookings/[id]/modify-quote — promo guest targeting (#2266)", () => {
  it("resolves promoGuestIds to indexes and threads them into the promo validator", async () => {
    h.promoCodeFindUnique.mockResolvedValue(MATES50_ROW);
    h.validateAndCalculatePromoDiscount.mockResolvedValue({
      beneficiaryMemberIds: [],
      selectedGuestIndexes: [0],
      discount: {
        discountCents: 5_000,
        priceAdjustmentCents: -5_000,
        freeNightsUsed: 0,
        eligibleGuestCount: 1,
        allocations: [],
        targets: [],
        adjustmentTargets: [],
      },
    });

    const res = await POST(
      req({ promoCode: "MATES50", promoGuestIds: ["g1"] }),
      { params },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.promoValidation).toMatchObject({ valid: true, code: "MATES50" });
    expect(body.newPromoAdjustmentCents).toBe(-5_000);

    expect(h.validateAndCalculatePromoDiscount).toHaveBeenCalledTimes(1);
    const [subject, details, assigned, options] =
      h.validateAndCalculatePromoDiscount.mock.calls[0]!;
    expect(subject).toMatchObject({ code: "MATES50" });
    expect(assigned).toBeNull();
    // #3827: the preview now dates the code's booking window from the new
    // check-in, exactly as the save does — the retired validator did not.
    expect(details).toMatchObject({ memberId: expect.any(String) });
    // #3123 — the CLUB's calendar day. This suite pins its own instant (`NOW`,
    // 2026-08-01T06:00:00Z) and under it the persisted `America/Denver` and the
    // environment's Pacific/Auckland happen to agree on the day, so the value
    // below cannot tell the two apart: WHICH zone the day came from is proven in
    // `src/lib/__tests__/promo-validity-window-club-day.test.ts` and
    // `src/app/api/bookings/[id]/cancel-preview/__tests__/club-time-authority.test.ts`.
    expect(options).toMatchObject({
      todayAtClub: "2026-08-01",
      excludeBookingId: "b1", // this booking
      lodgeId: "lodge-1",
      selectedGuestIndexes: [0],
      // A code applied now refuses at its cap: nobody holds it yet.
      capOverflow: "reject",
    });
  });

  it("400s a stale promoGuestId (the concurrent-edit drift scenario) instead of re-pointing it", async () => {
    const res = await POST(
      req({ promoCode: "MATES50", promoGuestIds: ["g-gone"] }),
      { params },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/no longer on this booking/);
    expect(h.validateAndCalculatePromoDiscount).not.toHaveBeenCalled();
  });

  it("surfaces a selection-needed refusal as its plain error text (INFO-9)", async () => {
    // The panel does not re-open guest selection from the quote —
    // PromoCodeInput owns selection via /api/promo-codes/validate and the
    // panel resets an applied code when the guest set changes — so the quote
    // carries no requiresGuestSelection machinery, only the honest error.
    h.promoCodeFindUnique.mockResolvedValue(MATES50_ROW);
    h.validateAndCalculatePromoDiscount.mockResolvedValue({
      error: "Choose which guests should receive this promo code",
      requiresGuestSelection: true,
      beneficiaryMemberIds: [],
    });

    const res = await POST(req({ promoCode: "MATES50" }), { params });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.promoValidation).toEqual({
      valid: false,
      error: "Choose which guests should receive this promo code",
    });
    // An invalid new promo contributes no discount.
    expect(body.newPromoAdjustmentCents).toBe(0);
  });
});

describe("POST /api/bookings/[id]/modify-quote — one-code fields on a several-code booking (#3828)", () => {
  function twoCodeDraft() {
    const code = (id: string, value: string, order: number) => ({
      id: `r-${id}`,
      promoCodeId: `pc-${id}`,
      applicationOrder: order,
      priceAdjustmentCents: -2_500,
      guestTargets: [],
      promoCode: { id: `pc-${id}`, code: value, internal: false, assignments: [], lodges: [] },
    });
    return {
      ...memberDraft(),
      discountCents: 5_000,
      promoAdjustmentCents: -5_000,
      finalPriceCents: 15_000,
      promoRedemptions: [code("a", "SPRING10", 0), code("b", "GUESTFREE", 1)],
    };
  }

  it.each([
    ["a single code, which would replace both", { promoCode: "MATES50" }],
    ["a removal, which would release both", { removePromoCode: true }],
  ])("refuses %s, as the save does", async (_label, fields) => {
    h.bookingFindUnique.mockResolvedValue(twoCodeDraft());

    const res = await POST(req(fields), { params });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.promoValidation).toEqual({
      valid: false,
      error: SEVERAL_PROMO_CODES_ONE_CODE_EDIT_MESSAGE,
    });
    expect(h.validateAndCalculatePromoDiscount).not.toHaveBeenCalled();
  });
});


/*
  #4197 — the breakdown adds up to `priceDiffCents` with promotions too. The
  difference is measured from the stored final price, which carries the
  booking's previous promo adjustment, so the breakdown reverses that
  adjustment whether its code is kept or removed.
*/
describe("POST /api/bookings/[id]/modify-quote — the breakdown sums with promotions (#4197)", () => {
  /** Aroha's draft carrying one code, SPRING10, at -$25.00. */
  function oneCodeDraft() {
    return {
      ...memberDraft(),
      discountCents: 2_500,
      promoAdjustmentCents: -2_500,
      finalPriceCents: 17_500,
      promoRedemptions: [
        {
          id: "r-a",
          promoCodeId: "pc-a",
          applicationOrder: 0,
          priceAdjustmentCents: -2_500,
          guestTargets: [],
          promoCode: { id: "pc-a", code: "SPRING10", internal: false, assignments: [], lodges: [] },
        },
      ],
    };
  }

  /** The promo engine adjusts the price by `cents` for whichever code it runs. */
  function engineAdjusts(cents: number) {
    h.validateAndCalculatePromoDiscount.mockResolvedValue({
      beneficiaryMemberIds: [],
      selectedGuestIndexes: [0],
      discount: {
        discountCents: -cents,
        priceAdjustmentCents: cents,
        freeNightsUsed: 0,
        eligibleGuestCount: 1,
        allocations: [],
        targets: [],
        adjustmentTargets: [],
      },
    });
  }

  /** The stay as stored: two nights at their locked $100.00. */
  function pricesTheStoredStay() {
    h.priceGuests.mockResolvedValue({
      totalPriceCents: 20_000,
      guests: [
        {
          priceCents: 20_000,
          perNightCents: [10_000, 10_000],
          nightDates: [D("2026-08-14"), D("2026-08-15")],
        },
      ],
    });
  }

  async function quote(body: Record<string, unknown>) {
    const res = await POST(req(body), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    const lines = json.itemizedChanges as Array<{ label: string; amountCents: number }>;
    expect(lines.reduce((sum, line) => sum + line.amountCents, 0)).toBe(json.priceDiffCents);
    return json;
  }

  it("a kept code re-priced on a longer stay: one net line", async () => {
    h.bookingFindUnique.mockResolvedValue(oneCodeDraft());
    engineAdjusts(-3_000);

    const body = await quote({ checkOut: "2026-08-17" });

    // $300.00 - $30.00 against the stored $175.00.
    expect(body.priceDiffCents).toBe(9_500);
    expect(body.itemizedChanges).toEqual([
      { label: "Date change: 2 nights → 3 nights", amountCents: 10_000 },
      { label: "Promo 'SPRING10' (re-priced)", amountCents: -500 },
    ]);
  });

  it("a removed code: its previous adjustment reversed, and nothing else", async () => {
    h.bookingFindUnique.mockResolvedValue(oneCodeDraft());
    pricesTheStoredStay();

    const body = await quote({ removePromoCode: true });

    expect(body.priceDiffCents).toBe(2_500);
    expect(body.itemizedChanges).toEqual([
      { label: "Removed promo 'SPRING10'", amountCents: 2_500 },
    ]);
    expect(h.validateAndCalculatePromoDiscount).not.toHaveBeenCalled();
  });

  it("a newly applied code on a booking with none: its line alone", async () => {
    h.promoCodeFindUnique.mockResolvedValue(MATES50_ROW);
    engineAdjusts(-5_000);

    const body = await quote({ promoCode: "MATES50", checkOut: "2026-08-17" });

    expect(body.priceDiffCents).toBe(5_000);
    expect(body.itemizedChanges).toEqual([
      { label: "Date change: 2 nights → 3 nights", amountCents: 10_000 },
      { label: "Promo 'MATES50'", amountCents: -5_000 },
    ]);
  });

  it("a new code replacing the stored one: the new line, and the old one reversed", async () => {
    h.bookingFindUnique.mockResolvedValue(oneCodeDraft());
    h.promoCodeFindUnique.mockResolvedValue(MATES50_ROW);
    pricesTheStoredStay();
    engineAdjusts(-5_000);

    const body = await quote({ promoCode: "MATES50" });

    expect(body.priceDiffCents).toBe(-2_500);
    expect(body.itemizedChanges).toEqual([
      { label: "Promo 'MATES50'", amountCents: -5_000 },
      { label: "Previous promo 'SPRING10' reversed", amountCents: 2_500 },
    ]);
  });

  it("a kept code that re-prices to the same amount adds no promo line", async () => {
    h.bookingFindUnique.mockResolvedValue(oneCodeDraft());
    pricesTheStoredStay();
    engineAdjusts(-2_500);

    const body = await quote({ checkOut: "2026-08-16" });

    expect(body.priceDiffCents).toBe(0);
    expect(body.itemizedChanges).toEqual([]);
  });

  it("a kept code that lapses reads as removed", async () => {
    h.bookingFindUnique.mockResolvedValue(oneCodeDraft());
    h.validateAndCalculatePromoDiscount.mockResolvedValue({
      error: "This promo code has expired",
      beneficiaryMemberIds: [],
    });

    const body = await quote({ checkOut: "2026-08-17" });

    expect(body.promoStillValid).toBe(false);
    expect(body.priceDiffCents).toBe(30_000 - 17_500);
    expect(body.itemizedChanges).toEqual([
      { label: "Date change: 2 nights → 3 nights", amountCents: 10_000 },
      { label: "Removed promo 'SPRING10'", amountCents: 2_500 },
    ]);
  });

  it("a refused code keeps the stored promotion in the totals, with no promo line", async () => {
    // The save refuses the whole edit, which leaves SPRING10 where it is, so the
    // preview keeps it too; the promo card shows `promoValidation.error`.
    h.bookingFindUnique.mockResolvedValue(oneCodeDraft());
    h.promoCodeFindUnique.mockResolvedValue(null);
    pricesTheStoredStay();

    const body = await quote({ promoCode: "NOPE" });

    expect(body.promoValidation).toEqual({ valid: false, error: "Promo code not found" });
    expect(body.newPromoAdjustmentCents).toBe(-2_500);
    expect(body.newDiscountCents).toBe(2_500);
    expect(body.priceDiffCents).toBe(0);
    expect(body.itemizedChanges).toEqual([]);
  });

  it("a refused code beside a date change: the date line alone, the stored promotion kept", async () => {
    h.bookingFindUnique.mockResolvedValue(oneCodeDraft());
    h.promoCodeFindUnique.mockResolvedValue(null);

    const body = await quote({ promoCode: "NOPE", checkOut: "2026-08-17" });

    expect(body.priceDiffCents).toBe(10_000);
    expect(body.itemizedChanges).toEqual([
      { label: "Date change: 2 nights → 3 nights", amountCents: 10_000 },
    ]);
  });

  it("a kept code that now discounts nothing is re-priced, not removed", async () => {
    h.bookingFindUnique.mockResolvedValue(oneCodeDraft());
    pricesTheStoredStay();
    engineAdjusts(0);

    const body = await quote({ checkOut: "2026-08-16" });

    expect(body.priceDiffCents).toBe(2_500);
    expect(body.itemizedChanges).toEqual([
      { label: "Promo 'SPRING10' (re-priced)", amountCents: 2_500 },
    ]);
  });
});
