import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolvePromoInTransaction } from "@/lib/booking-create-promo";
import { BookingPromoError } from "@/lib/booking-create-types";
import { requireCalendarDate } from "@/lib/club-time";

// #3123 — the transaction-bound promo and refund helpers take the CLUB's
// calendar day as a REQUIRED value now: the club timezone is one of the two
// reads that cannot happen under a lock (`INV-LOCK-004`), so it is resolved by
// the caller and threaded in. These call sites are not about a date boundary,
// so the frozen clock's own club day is used.
const CLUB_TODAY_FOR_TEST = requireCalendarDate("2026-07-01");

// #2289 REGRESSION TEST — the raw-SQL shape that cost real money.
//
// Booking creation used to take its promo row with
// `tx.$queryRaw<LockedPromoRow[]>\`SELECT * FROM "PromoCode" … FOR UPDATE\``.
// The generic is an unchecked CAST. Raw SQL returns the PHYSICAL column names;
// `LockedPromoRow` declared the PRISMA ones. Where a deployment's columns
// differed, every property the type promised arrived `undefined`, and undefined
// is quietly harmless-looking in exactly the two comparisons that matter:
//
//   * `maxRedemptionsTotal` undefined -> `undefined !== null` is TRUE and
//     `n > undefined` is FALSE, so the total-redemption cap never fired;
//   * `freeNightsPerIndividual` undefined -> `?? 0` yields 0, so FREE_NIGHTS
//     promos applied NO discount at booking creation, while the quote path
//     (an ordinary mapped Prisma read) showed the member one. Members were
//     quoted a discount and then charged without it.
//
// Nothing threw and nothing was logged. The fix is structural: the raw statement
// takes the LOCK ONLY (`$executeRaw`, result never read) and the promo is read
// back through `tx.promoCode.findUnique`, which Prisma maps.
//
// So these tests hand the transaction BOTH shapes at once: `$queryRaw` returns
// the lying row exactly as the broken deployment did, and `promoCode.findUnique`
// returns the true one. Code that reads the raw result gets the silent wrong
// answer; code that reads through the model gets the right one. Revert the fix
// and every test in the first block fails.

const LYING_RAW_ROW = {
  // What `SELECT *` really returned where the physical names had not been
  // migrated to match the Prisma field names.
  id: "promo-1",
  code: "WINTER",
  active: true,
  internal: false,
  type: "FREE_NIGHTS",
  valid_from: null,
  valid_until: null,
  booking_start_from: null,
  booking_start_until: null,
  max_redemptions_total: 1,
  max_unique_members_total: null,
  max_uses_per_member: null,
  current_redemptions: 1,
  members_only: false,
  member_guests_only: false,
  value_cents: null,
  percent_off: null,
  free_nights_per_individual: 2,
  lifetime_free_nights_cap: null,
  fixed_nightly_price_cents: null,
  fixed_nightly_mode: null,
  max_guests_per_booking: null,
  max_nightly_value_cents: null,
  assigned_members_only_own_nights: true,
};

/** The same promotion as Prisma reads it: names the application actually uses. */
function truePromoRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "promo-1",
    code: "WINTER",
    description: null,
    active: true,
    internal: false,
    archivedAt: null,
    type: "FREE_NIGHTS",
    validFrom: null,
    validUntil: null,
    bookingStartFrom: null,
    bookingStartUntil: null,
    maxRedemptionsTotal: null,
    maxUniqueMembersTotal: null,
    maxUsesPerMember: null,
    currentRedemptions: 0,
    membersOnly: false,
    memberGuestsOnly: false,
    valueCents: null,
    percentOff: null,
    freeNightsPerIndividual: 2,
    lifetimeFreeNightsCap: null,
    fixedNightlyPriceCents: null,
    fixedNightlyMode: null,
    maxGuestsPerBooking: null,
    maxNightlyValueCents: null,
    assignedMembersOnlyOwnNights: true,
    xeroItemCode: null,
    xeroAccountCode: null,
    ...overrides,
  };
}

function makeTx(
  promoRow: Record<string, unknown> | null,
  options: { lockedRowCount?: number } = {},
) {
  const { lockedRowCount = 1 } = options;
  const calls: string[] = [];
  const tx = {
    // The lock. Returns an affected-row count, like the real `$executeRaw`, and
    // carries no column names at all — which is the entire point of the fix.
    // The count is the load-bearing part: `FOR UPDATE` locks nothing when it
    // matches nothing, so 0 means this transaction holds no lock on the code.
    $executeRaw: vi.fn(async () => {
      calls.push("lock");
      return lockedRowCount;
    }),
    // Kept on the stub deliberately: if the production code ever reads a promo
    // through raw SQL again, it gets the lying row and these tests fail.
    $queryRaw: vi.fn(async () => {
      calls.push("queryRaw");
      return [LYING_RAW_ROW];
    }),
    promoCode: {
      findUnique: vi.fn(async () => {
        calls.push("promoCode.findUnique");
        return promoRow;
      }),
    },
    promoCodeAssignment: { findMany: vi.fn(async () => []) },
    promoCodeLodge: { findMany: vi.fn(async () => []) },
    promoRedemption: { findMany: vi.fn(async () => []) },
    promoRedemptionAllocation: {
      count: vi.fn(async () => 0),
      aggregate: vi.fn(async () => ({ _sum: { freeNightsUsed: 0 } })),
      findMany: vi.fn(async () => []),
      groupBy: vi.fn(async () => []),
    },
  };
  return { tx, calls };
}

type ResolveTx = Parameters<typeof resolvePromoInTransaction>[0];

const CHECK_IN = new Date(Date.UTC(2026, 6, 1));

function resolve(tx: ReturnType<typeof makeTx>["tx"]) {
  return resolvePromoInTransaction(tx as unknown as ResolveTx, {
      todayAtClub: CLUB_TODAY_FOR_TEST,
    promoCodeStr: "winter",
    effectiveMemberId: "member-1",
    checkIn: CHECK_IN,
    guests: [
      {
        firstName: "Ada",
        lastName: "Lovelace",
        ageTier: "ADULT",
        isMember: true,
        memberId: "member-1",
        stayStart: CHECK_IN,
        stayEnd: new Date(Date.UTC(2026, 6, 3)),
      },
    ],
    totalPriceCents: 10_000,
    perNightCentsByGuest: [[5_000, 5_000]],
    lodgeId: "lodge-1",
  });
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    promoRedemptionAllocation: {
      aggregate: vi.fn(),
      count: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

describe("booking creation reads the locked promo through Prisma, not the raw row (#2289)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("locks with $executeRaw and reads with promoCode.findUnique, in that order", async () => {
    const { tx, calls } = makeTx(truePromoRow());

    await resolve(tx);

    expect(calls.slice(0, 2)).toEqual(["lock", "promoCode.findUnique"]);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    // The lock is a real FOR UPDATE on the normalised code, not a bare read.
    const [strings, ...values] = tx.$executeRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(strings.join("?")).toContain("FOR UPDATE");
    expect(strings.join("?")).toContain('"PromoCode"');
    expect(values[0]).toBe("WINTER");
  });

  it("ENFORCES the total-redemption cap that the lying row silently disabled", async () => {
    // One slot, already taken. The raw row says the same thing — under
    // `max_redemptions_total`, which the application never looks at.
    const { tx } = makeTx(
      truePromoRow({ maxRedemptionsTotal: 1, currentRedemptions: 1 }),
    );

    await expect(resolve(tx)).rejects.toBeInstanceOf(BookingPromoError);
  });

  it("APPLIES the FREE_NIGHTS discount that the lying row silently zeroed", async () => {
    const { tx } = makeTx(truePromoRow());

    const resolved = await resolve(tx);

    // Two free nights at 5,000 cents each. Under the raw read,
    // `freeNightsPerIndividual` was undefined, `?? 0` made it zero free nights,
    // and the member was charged the full 10,000 having been quoted this.
    expect(resolved.promoFreeNightsUsed).toBe(2);
    expect(resolved.discountCents).toBe(10_000);
  });

  it("still admits a booking that sits inside the cap", async () => {
    const { tx } = makeTx(
      truePromoRow({ maxRedemptionsTotal: 5, currentRedemptions: 1 }),
    );

    await expect(resolve(tx)).resolves.toMatchObject({ discountCents: 10_000 });
  });

  it("treats an unknown code as not found even though the raw statement 'returns' a row", async () => {
    const { tx } = makeTx(null);

    await expect(resolve(tx)).rejects.toBeInstanceOf(BookingPromoError);
  });

  it("still rejects an internal (work party) promo entered by hand", async () => {
    const { tx } = makeTx(truePromoRow({ internal: true }));

    await expect(resolve(tx)).rejects.toThrow("Promo code not found");
  });
});

// The half of "lock raw, read typed" that only exists because the statement was
// SPLIT. One `SELECT * … FOR UPDATE` returned the row and the lock together, so
// a row this transaction had not locked could not be in its result. Two
// statements can disagree: `FOR UPDATE` locks nothing when it matches nothing,
// and READ COMMITTED (the repo default, relied on deliberately — see
// `member-merge.ts`) gives the follow-up read a FRESH snapshot, so a promo code
// INSERTED or RENAMED between them comes back unlocked. Applying it would let
// two concurrent bookings both read `currentRedemptions = 0` and both redeem a
// single-use code.
//
// The affected-row count `$executeRaw` already returns is what closes that, so
// these tests drive it directly. Delete the `lockedRowCount > 0` check in
// `booking-create-promo.ts` and the first two fail: the promo is applied, at a
// full discount, with nothing holding its row lock.
describe("a promo the lock did not match is never applied unlocked (#2289)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses when the lock matched no row but the read would find one", async () => {
    // The race, exactly: `SELECT 1 … FOR UPDATE` matched nothing (count 0), the
    // admin's INSERT then committed, and the unlocked row is now visible.
    const { tx } = makeTx(truePromoRow(), { lockedRowCount: 0 });

    await expect(resolve(tx)).rejects.toThrow("Promo code not found");
    // Same refusal the single-statement form produced for this interleaving.
    await expect(resolve(tx)).rejects.toBeInstanceOf(BookingPromoError);
  });

  it("does not even read a promo it failed to lock", async () => {
    const { tx, calls } = makeTx(
      truePromoRow({ maxRedemptionsTotal: 1, currentRedemptions: 0 }),
      { lockedRowCount: 0 },
    );

    await expect(resolve(tx)).rejects.toThrow("Promo code not found");

    // No lock means no read and therefore no cap decision: a slot cannot be
    // consumed off a row nothing is serialising on.
    expect(tx.promoCode.findUnique).not.toHaveBeenCalled();
    expect(calls).toEqual(["lock"]);
  });

  it("reads and applies normally as soon as the lock matched its row", async () => {
    const { tx, calls } = makeTx(truePromoRow(), { lockedRowCount: 1 });

    await expect(resolve(tx)).resolves.toMatchObject({ discountCents: 10_000 });
    expect(calls.slice(0, 2)).toEqual(["lock", "promoCode.findUnique"]);
  });
});
