import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    promoRedemptionAllocation: {
      aggregate: vi.fn(),
      count: vi.fn(),
      findMany: vi.fn(),
    },
    promoCodeAssignment: {
      findMany: vi.fn(),
    },
  },
}));

import {
  calculatePromoDiscountForGuestRates,
  deletePromoRedemptionAndAdjustCount,
  getAssignedPromoCodeSummariesForMember,
  lockPromoCodeRowsForUpdate,
  redeemPromoCode,
  replacePromoRedemptionAllocations,
  shouldPersistPromoRedemption,
  validateAndCalculatePromoDiscount,
  type PromoApplicationSubject,
  type PromoBeneficiaryAllocation,
} from "../promo";
import {
  BENEFICIAL_PROMO_ALLOCATION_FILTER,
  isBeneficialPromoAllocation,
} from "../promo-usage-counts";
import type { PromoCodeInput } from "../pricing";
import { requireCalendarDate } from "@/lib/club-time";

// #3123 — the transaction-bound promo and refund helpers take the CLUB's
// calendar day as a REQUIRED value now: the club timezone is one of the two
// reads that cannot happen under a lock (`INV-LOCK-004`), so it is resolved by
// the caller and threaded in. These call sites are not about a date boundary,
// so the frozen clock's own club day is used.
const CLUB_TODAY_FOR_TEST = requireCalendarDate("2026-07-01");

// #2299: a promo application that delivered NO benefit must not consume any of
// the three usage caps (uses per member, total redemptions, unique members).
// The single structural rule that makes that true is "an allocation row exists
// only where the member actually got something" — everything below pins one
// consequence of it.

// --- Fake transaction client -------------------------------------------------

type CallLog = string[];

function makeTx(options: { existingAllocationCount?: number } = {}) {
  const calls: CallLog = [];
  const createdAllocations: PromoBeneficiaryAllocation[] = [];
  const counterUpdates: unknown[] = [];
  const lockedStatements: string[] = [];

  const tx = {
    promoCodeLodge: {
      findMany: vi.fn(async () => []),
    },
    promoRedemption: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        calls.push("promoRedemption.create");
        return { id: "redemption-1", ...data };
      }),
      update: vi.fn(async () => {
        calls.push("promoRedemption.update");
        return {};
      }),
      delete: vi.fn(async () => {
        calls.push("promoRedemption.delete");
        return {};
      }),
    },
    promoRedemptionAllocation: {
      count: vi.fn(async () => {
        calls.push("allocation.count");
        return options.existingAllocationCount ?? 0;
      }),
      deleteMany: vi.fn(async () => {
        calls.push("allocation.deleteMany");
        return { count: 0 };
      }),
      createMany: vi.fn(
        async ({ data }: { data: PromoBeneficiaryAllocation[] }) => {
          calls.push("allocation.createMany");
          createdAllocations.push(...data);
          return { count: data.length };
        }
      ),
    },
    promoRedemptionGuestTarget: {
      createMany: vi.fn(async () => ({ count: 0 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    promoCode: {
      update: vi.fn(async (args: unknown) => {
        calls.push("promoCode.update");
        counterUpdates.push(args);
        return {};
      }),
    },
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push("lock");
      lockedStatements.push(strings.join("?"));
      lockedIds.push(String(values[0]));
      // $executeRaw returns an affected-row count, never rows (#2289).
      return 1;
    }),
  };
  const lockedIds: string[] = [];

  return { tx, calls, createdAllocations, counterUpdates, lockedStatements, lockedIds };
}

type RedeemTx = Parameters<typeof redeemPromoCode>[0];

function asTx(tx: ReturnType<typeof makeTx>["tx"]): RedeemTx {
  return tx as unknown as RedeemTx;
}

// --- The benefit test itself -------------------------------------------------

describe("isBeneficialPromoAllocation (#2299 owner decision 1: any price effect)", () => {
  it("counts money off, a price change in EITHER direction, and a subsidised night", () => {
    expect(
      isBeneficialPromoAllocation({
        discountCents: 500,
        priceAdjustmentCents: -500,
        freeNightsUsed: 0,
      })
    ).toBe(true);
    expect(
      isBeneficialPromoAllocation({
        discountCents: 0,
        priceAdjustmentCents: -500,
        freeNightsUsed: 0,
      })
    ).toBe(true);
    // A price-RAISING fixed-nightly application still changed what the member
    // pays, so it is a real use (the rejected alternative counted reductions
    // only).
    expect(
      isBeneficialPromoAllocation({
        discountCents: 0,
        priceAdjustmentCents: 500,
        freeNightsUsed: 0,
      })
    ).toBe(true);
    // A free night on an already-free night moves no money but does consume
    // the member's lifetime free-night allowance, so it counts.
    expect(
      isBeneficialPromoAllocation({
        discountCents: 0,
        priceAdjustmentCents: 0,
        freeNightsUsed: 1,
      })
    ).toBe(true);
  });

  it("rejects an application that moved nothing at all", () => {
    expect(
      isBeneficialPromoAllocation({
        discountCents: 0,
        priceAdjustmentCents: 0,
        freeNightsUsed: 0,
      })
    ).toBe(false);
  });
});

// --- Every shape that can produce a zero-benefit application -----------------

describe("zero-benefit applications produce no allocation row", () => {
  it("percentage off guest-nights that are already free", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 25 };
    const result = calculatePromoDiscountForGuestRates(promo, 0, "member-1", [
      { memberId: "member-1", isMember: true, perNightRates: [0, 0] },
    ]);

    expect(result.discountCents).toBe(0);
    // Guests WERE eligible — this is exactly the case the old forced fallback
    // turned into a burnt use.
    expect(result.eligibleGuestCount).toBe(1);
    expect(result.allocations).toEqual([]);
    // The redemption row is still written: it is the audit trail (decision 3).
    expect(shouldPersistPromoRedemption(result)).toBe(true);
  });

  it("fixed amount off a zero-dollar stay", () => {
    const promo: PromoCodeInput = { type: "FIXED_AMOUNT", valueCents: 5000 };
    const result = calculatePromoDiscountForGuestRates(promo, 0, "member-1", [
      { memberId: "member-1", isMember: true, perNightRates: [0] },
    ]);

    expect(result.discountCents).toBe(0);
    expect(result.eligibleGuestCount).toBe(1);
    expect(result.allocations).toEqual([]);
    expect(shouldPersistPromoRedemption(result)).toBe(true);
  });

  it("fixed nightly SET_PRICE where the guest already pays exactly that price", () => {
    const promo: PromoCodeInput = {
      type: "FIXED_NIGHTLY_PRICE",
      fixedNightlyPriceCents: 3000,
      fixedNightlyMode: "SET_PRICE",
    };
    const result = calculatePromoDiscountForGuestRates(promo, 6000, "member-1", [
      { memberId: "member-1", isMember: true, perNightRates: [3000, 3000] },
    ]);

    expect(result.priceAdjustmentCents).toBe(0);
    expect(result.eligibleGuestCount).toBe(1);
    expect(result.allocations).toEqual([]);
  });

  it("still allocates when the promo really does change the price", () => {
    const promo: PromoCodeInput = { type: "PERCENTAGE", percentOff: 25 };
    const result = calculatePromoDiscountForGuestRates(promo, 8000, "member-1", [
      { memberId: "member-1", isMember: true, perNightRates: [4000, 4000] },
    ]);

    expect(result.discountCents).toBe(2000);
    expect(result.allocations).toEqual([
      {
        memberId: "member-1",
        discountCents: 2000,
        priceAdjustmentCents: -2000,
        freeNightsUsed: 0,
      },
    ]);
  });

  it("keeps a free night on an already-free night as a real use", () => {
    // freeNightsUsed > 0 is a benefit even at $0: it draws down the member's
    // lifetime free-night allowance.
    const promo: PromoCodeInput = { type: "FREE_NIGHTS", freeNightsPerIndividual: 1 };
    const result = calculatePromoDiscountForGuestRates(promo, 0, "member-1", [
      { memberId: "member-1", isMember: true, perNightRates: [0] },
    ]);

    expect(result.freeNightsUsed).toBe(1);
    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]).toMatchObject({
      memberId: "member-1",
      discountCents: 0,
      freeNightsUsed: 1,
    });
    // Negative zero: pricing computes -discountCents, so a $0 free night
    // yields -0 here. It must be read as "no price change" (and it is — the
    // benefit test uses !== 0, and -0 !== 0 is false), otherwise every
    // zero-discount application would look like a price effect.
    expect(result.allocations[0].priceAdjustmentCents === 0).toBe(true);
  });

  it("does not mistake negative zero for a price effect", () => {
    expect(
      isBeneficialPromoAllocation({
        discountCents: 0,
        priceAdjustmentCents: -0,
        freeNightsUsed: 0,
      })
    ).toBe(false);
  });

  // DECIDED, #2299: a SET_PRICE application whose per-guest adjustments net to
  // exactly zero counts as NO use. In SET_PRICE mode every night is re-priced,
  // so increases and decreases can cancel; the member's total is byte-identical
  // with and without the code, so under the owner's "any price effect" rule
  // there is no effect. The accepted consequence — such a stay can carry the
  // code indefinitely — costs nothing, because it gives nothing.
  it("counts a SET_PRICE stay whose nights cancel out as no use", () => {
    const promo: PromoCodeInput = {
      type: "FIXED_NIGHTLY_PRICE",
      fixedNightlyPriceCents: 3000,
      fixedNightlyMode: "SET_PRICE",
    };
    // $50 night comes DOWN to $30, $10 night goes UP to $30: -2000 + 2000 = 0.
    const result = calculatePromoDiscountForGuestRates(promo, 6000, "member-1", [
      { memberId: "member-1", isMember: true, perNightRates: [5000, 1000] },
    ]);

    expect(result.priceAdjustmentCents).toBe(0);
    expect(result.discountCents).toBe(0);
    // The guest WAS re-priced, so pricing still counts them as eligible...
    expect(result.eligibleGuestCount).toBe(1);
    // ...but no allowance is consumed.
    expect(result.allocations).toEqual([]);
    // The application is still recorded as an audit row (decision 3).
    expect(shouldPersistPromoRedemption(result)).toBe(true);
  });

  it("counts a SET_PRICE member whose two guest rows cancel each other as no use", () => {
    const promo: PromoCodeInput = {
      type: "FIXED_NIGHTLY_PRICE",
      fixedNightlyPriceCents: 3000,
      fixedNightlyMode: "SET_PRICE",
    };
    // The same member owns both rows, so their two adjustments are summed into
    // one allocation before the benefit test sees them.
    const result = calculatePromoDiscountForGuestRates(promo, 6000, "member-1", [
      { memberId: "member-1", isMember: true, perNightRates: [5000] },
      { memberId: "member-1", isMember: true, perNightRates: [1000] },
    ]);

    expect(result.priceAdjustmentCents).toBe(0);
    expect(result.allocations).toEqual([]);
  });

  it("still counts a SET_PRICE stay that only RAISES the price as a real use", () => {
    const promo: PromoCodeInput = {
      type: "FIXED_NIGHTLY_PRICE",
      fixedNightlyPriceCents: 3000,
      fixedNightlyMode: "SET_PRICE",
    };
    const result = calculatePromoDiscountForGuestRates(promo, 2000, "member-1", [
      { memberId: "member-1", isMember: true, perNightRates: [1000, 1000] },
    ]);

    expect(result.discountCents).toBe(0);
    expect(result.priceAdjustmentCents).toBe(4000);
    expect(result.allocations).toEqual([
      {
        memberId: "member-1",
        discountCents: 0,
        priceAdjustmentCents: 4000,
        freeNightsUsed: 0,
      },
    ]);
  });
});

// The assigned-member path returns BEFORE normalizeAllocations, so the in-memory
// allocation list it hands back is NOT benefit-filtered: pricing deliberately
// emits a zero entry for a SET_PRICE guest whose rate already equals the fixed
// price (`includeWhenZero`, src/lib/policies/pricing.ts). The filter is applied
// at WRITE time instead. Both halves are pinned here, end to end.
describe("assigned-member path: unfiltered in memory, filtered at write time", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const assignedSetPricePromo: PromoCodeInput = {
    type: "FIXED_NIGHTLY_PRICE",
    fixedNightlyPriceCents: 3000,
    fixedNightlyMode: "SET_PRICE",
  };

  it("hands back a zero allocation for a guest whose rate already equals the fixed price", () => {
    const result = calculatePromoDiscountForGuestRates(
      assignedSetPricePromo,
      11000,
      "booker-1",
      [
        // Benefits: $50 night down to $30.
        { memberId: "member-a", isMember: true, perNightRates: [5000] },
        // Benefits from nothing: already at the fixed price.
        { memberId: "member-b", isMember: true, perNightRates: [3000, 3000] },
      ],
      ["member-a", "member-b"]
    );

    // TRAP for future callers: member-b is present with a zero entry.
    // (Ordered by descending guest total, so member-b's two $30 nights sort
    // first.)
    expect(result.allocations).toEqual([
      {
        memberId: "member-b",
        discountCents: 0,
        priceAdjustmentCents: 0,
        freeNightsUsed: 0,
      },
      {
        memberId: "member-a",
        discountCents: 2000,
        priceAdjustmentCents: -2000,
        freeNightsUsed: 0,
      },
    ]);
    expect(result.allocations.filter(isBeneficialPromoAllocation)).toHaveLength(1);
  });

  it("writes only the beneficial one, so member-b keeps their allowance", async () => {
    const result = calculatePromoDiscountForGuestRates(
      assignedSetPricePromo,
      11000,
      "booker-1",
      [
        { memberId: "member-a", isMember: true, perNightRates: [5000] },
        { memberId: "member-b", isMember: true, perNightRates: [3000, 3000] },
      ],
      ["member-a", "member-b"]
    );

    const { tx, createdAllocations, counterUpdates } = makeTx();
    await redeemPromoCode(
      asTx(tx),
      "promo-1",
      "booking-1",
      "booker-1",
      result.discountCents,
      result.priceAdjustmentCents,
      result.freeNightsUsed,
      result.eligibleGuestCount,
      result.allocations
    );

    expect(createdAllocations.map((a) => a.memberId)).toEqual(["member-a"]);
    expect(counterUpdates).toEqual([
      {
        where: { id: "promo-1" },
        data: { currentRedemptions: { increment: 1 } },
      },
    ]);
  });
});

// --- The persistence layer ---------------------------------------------------

describe("redeemPromoCode consumes a cap slot only for a real benefit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes the redemption but NO allocation row, and takes no slot, at zero benefit", async () => {
    const { tx, createdAllocations, counterUpdates } = makeTx();

    await redeemPromoCode(asTx(tx), "promo-1", "booking-1", "member-1", 0, 0, 0, 2);

    expect(tx.promoRedemption.create).toHaveBeenCalledTimes(1);
    expect(tx.promoRedemptionAllocation.createMany).not.toHaveBeenCalled();
    expect(createdAllocations).toEqual([]);
    // Not "increment: 0" — the promo code row is not written AT ALL. Writing it
    // would bump `updatedAt` and make an application that consumed nothing look
    // like an admin edit of the code; both sibling counter writers guard the
    // same way, and the repair migration avoids `updatedAt` for the same reason.
    expect(counterUpdates).toEqual([]);
    expect(tx.promoCode.update).not.toHaveBeenCalled();
  });

  it("takes exactly one slot for a beneficial application", async () => {
    const { tx, createdAllocations, counterUpdates } = makeTx();

    await redeemPromoCode(asTx(tx), "promo-1", "booking-1", "member-1", 2000, -2000, 0, 1);

    expect(createdAllocations).toHaveLength(1);
    expect(counterUpdates).toEqual([
      {
        where: { id: "promo-1" },
        data: { currentRedemptions: { increment: 1 } },
      },
    ]);
  });

  it("drops a zero-benefit member from a mixed allocation set", async () => {
    // Pricing emits a deliberately zero entry for a SET_PRICE guest whose rate
    // already equals the fixed price; that member benefited from nothing and
    // must not occupy a unique-member place.
    const { tx, createdAllocations, counterUpdates } = makeTx();

    await redeemPromoCode(
      asTx(tx),
      "promo-1",
      "booking-1",
      "member-1",
      1500,
      -1500,
      0,
      2,
      [
        {
          memberId: "member-1",
          discountCents: 1500,
          priceAdjustmentCents: -1500,
          freeNightsUsed: 0,
        },
        {
          memberId: "member-2",
          discountCents: 0,
          priceAdjustmentCents: 0,
          freeNightsUsed: 0,
        },
      ]
    );

    expect(createdAllocations.map((a) => a.memberId)).toEqual(["member-1"]);
    expect(counterUpdates).toEqual([
      {
        where: { id: "promo-1" },
        data: { currentRedemptions: { increment: 1 } },
      },
    ]);
  });
});

// The `PromoRedemption_sync_allocation_insert` / `..._update` triggers
// (20260527120000_add_promo_redemption_allocations) upsert a booker allocation
// row straight from the redemption's own scalars whenever a PromoRedemption is
// written — they exist so an old blue/green colour that writes only
// PromoRedemption still gets an allocation. For a zero-benefit application that
// row is all-zero, so the statement order in these two writers is load-bearing:
// remove it and the database quietly puts back the row #2299 deletes.
describe("the allocation-sync triggers cannot resurrect a zero-benefit row", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes the trigger's row AFTER creating the redemption", async () => {
    const { tx, calls } = makeTx();

    await redeemPromoCode(asTx(tx), "promo-1", "booking-1", "member-1", 0, 0, 0, 2);

    expect(calls.indexOf("allocation.deleteMany")).toBeGreaterThan(
      calls.indexOf("promoRedemption.create")
    );
    expect(calls).not.toContain("allocation.createMany");
  });

  it("deletes the trigger's row BEFORE writing its own beneficial rows", async () => {
    // The delete is scoped by promoRedemptionId, so it takes out EVERY row for
    // the redemption. Sequenced after the createMany it would silently wipe the
    // beneficial set this call just wrote — the same failure class the ordering
    // above guards, in the opposite direction.
    const { tx, calls, createdAllocations } = makeTx();

    await redeemPromoCode(asTx(tx), "promo-1", "booking-1", "member-1", 2000, -2000, 0, 1);

    expect(createdAllocations).toHaveLength(1);
    expect(calls.indexOf("allocation.deleteMany")).toBeLessThan(
      calls.indexOf("allocation.createMany")
    );
    expect(calls.indexOf("allocation.deleteMany")).toBeGreaterThan(
      calls.indexOf("promoRedemption.create")
    );
  });

  it("deletes before creating on a reprice too", async () => {
    const { tx, calls, createdAllocations } = makeTx({ existingAllocationCount: 1 });

    await replacePromoRedemptionAllocations(
      asTx(tx),
      {
        id: "redemption-1",
        promoCodeId: "promo-1",
        bookingId: "booking-1",
        memberId: "member-1",
      },
      2000,
      -2000,
      0,
      1
    );

    expect(createdAllocations).toHaveLength(1);
    expect(calls.indexOf("allocation.deleteMany")).toBeLessThan(
      calls.indexOf("allocation.createMany")
    );
  });

  it("deletes the trigger's row AFTER updating the redemption on a reprice", async () => {
    const { tx, calls } = makeTx({ existingAllocationCount: 1 });

    await replacePromoRedemptionAllocations(
      asTx(tx),
      {
        id: "redemption-1",
        promoCodeId: "promo-1",
        bookingId: "booking-1",
        memberId: "member-1",
      },
      0,
      0,
      0,
      2
    );

    expect(calls.indexOf("allocation.deleteMany")).toBeGreaterThan(
      calls.indexOf("promoRedemption.update")
    );
  });

  it("counts the existing rows BEFORE the update, so the trigger cannot skew the delta", async () => {
    const { tx, calls } = makeTx({ existingAllocationCount: 1 });

    await replacePromoRedemptionAllocations(
      asTx(tx),
      {
        id: "redemption-1",
        promoCodeId: "promo-1",
        bookingId: "booking-1",
        memberId: "member-1",
      },
      0,
      0,
      0,
      2
    );

    expect(calls.indexOf("allocation.count")).toBeLessThan(
      calls.indexOf("promoRedemption.update")
    );
  });
});

describe("currentRedemptions stays symmetric with the allocation rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("releases the slot when a reprice destroys the whole benefit", async () => {
    const { tx, createdAllocations, counterUpdates } = makeTx({
      existingAllocationCount: 1,
    });

    await replacePromoRedemptionAllocations(
      asTx(tx),
      {
        id: "redemption-1",
        promoCodeId: "promo-1",
        bookingId: "booking-1",
        memberId: "member-1",
      },
      0,
      0,
      0,
      2
    );

    expect(createdAllocations).toEqual([]);
    expect(counterUpdates).toEqual([
      {
        where: { id: "promo-1" },
        data: { currentRedemptions: { decrement: 1 } },
      },
    ]);
  });

  it("measures the delta against the RAW row count, so a legacy all-zero row nets out", async () => {
    // A pre-#2299 database has an all-zero allocation row that the old code
    // counted (and incremented the counter for). Repricing it into a real
    // benefit replaces one row with one row: the counter must not move.
    const { tx, counterUpdates } = makeTx({ existingAllocationCount: 1 });

    await replacePromoRedemptionAllocations(
      asTx(tx),
      {
        id: "redemption-1",
        promoCodeId: "promo-1",
        bookingId: "booking-1",
        memberId: "member-1",
      },
      2500,
      -2500,
      0,
      1
    );

    expect(tx.promoRedemptionAllocation.count).toHaveBeenCalledWith({
      where: { promoRedemptionId: "redemption-1" },
    });
    expect(counterUpdates).toEqual([]);
  });

  it("gives back exactly what was taken when the redemption is deleted", async () => {
    const { tx, counterUpdates } = makeTx({ existingAllocationCount: 2 });

    await deletePromoRedemptionAndAdjustCount(asTx(tx), {
      id: "redemption-1",
      promoCodeId: "promo-1",
    });

    expect(counterUpdates).toEqual([
      {
        where: { id: "promo-1" },
        data: { currentRedemptions: { decrement: 2 } },
      },
    ]);
  });

  it("touches the counter not at all when a benefit-free redemption is deleted", async () => {
    const { tx, counterUpdates } = makeTx({ existingAllocationCount: 0 });

    await deletePromoRedemptionAndAdjustCount(asTx(tx), {
      id: "redemption-1",
      promoCodeId: "promo-1",
    });

    expect(tx.promoRedemption.delete).toHaveBeenCalledTimes(1);
    expect(counterUpdates).toEqual([]);
  });
});

// --- The cap queries ---------------------------------------------------------

function makePromoSubject(
  overrides: Partial<PromoApplicationSubject> = {}
): PromoApplicationSubject {
  return {
    id: "promo-1",
    active: true,
    validFrom: null,
    validUntil: null,
    maxRedemptionsTotal: null,
    currentRedemptions: 0,
    membersOnly: false,
    maxUsesPerMember: null,
    maxUniqueMembersTotal: null,
    type: "PERCENTAGE",
    valueCents: null,
    percentOff: 20,
    freeNightsPerIndividual: null,
    lifetimeFreeNightsCap: null,
    fixedNightlyPriceCents: null,
    fixedNightlyMode: null,
    maxGuestsPerBooking: null,
    maxNightlyValueCents: null,
    memberGuestsOnly: false,
    ...overrides,
  };
}

describe("usage-cap counts ignore historical zero-benefit rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lets a member reuse a single-use code their only prior application did nothing for", async () => {
    const { prisma } = await import("@/lib/prisma");
    // The benefit filter is what makes this 0: the member has one stored
    // allocation row, but it carries no benefit.
    vi.mocked(prisma.promoRedemptionAllocation.count).mockResolvedValue(0);
    vi.mocked(prisma.promoRedemptionAllocation.aggregate).mockResolvedValue({
      _sum: { freeNightsUsed: 0 },
    } as never);
    vi.mocked(prisma.promoRedemptionAllocation.findMany).mockResolvedValue([] as never);

    const result = await validateAndCalculatePromoDiscount(
      makePromoSubject({ maxUsesPerMember: 1 }),
      {
        memberId: "member-1",
        totalPriceCents: 10000,
        guests: [{ memberId: "member-1", isMember: true, perNightRates: [5000, 5000] }],
      }
    ,
      null,
      { todayAtClub: CLUB_TODAY_FOR_TEST }
    );

    expect(result.error).toBeUndefined();
    expect(result.discount?.discountCents).toBe(2000);
    // Every per-member count is asked for beneficial rows only.
    expect(vi.mocked(prisma.promoRedemptionAllocation.count)).toHaveBeenCalledWith({
      where: {
        promoCodeId: "promo-1",
        memberId: "member-1",
        ...BENEFICIAL_PROMO_ALLOCATION_FILTER,
      },
    });
  });

  it("still refuses when the member's prior application DID give them something", async () => {
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.promoRedemptionAllocation.count).mockResolvedValue(1);
    vi.mocked(prisma.promoRedemptionAllocation.aggregate).mockResolvedValue({
      _sum: { freeNightsUsed: 0 },
    } as never);
    vi.mocked(prisma.promoRedemptionAllocation.findMany).mockResolvedValue([] as never);

    const result = await validateAndCalculatePromoDiscount(
      makePromoSubject({ maxUsesPerMember: 1 }),
      {
        memberId: "member-1",
        totalPriceCents: 10000,
        guests: [{ memberId: "member-1", isMember: true, perNightRates: [5000, 5000] }],
      }
    ,
      null,
      { todayAtClub: CLUB_TODAY_FOR_TEST }
    );

    expect(result.error).toBe("You have already used this promo code");
  });

  it("counts unique members and prior beneficiaries on beneficial rows only", async () => {
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.promoRedemptionAllocation.count).mockResolvedValue(0);
    vi.mocked(prisma.promoRedemptionAllocation.aggregate).mockResolvedValue({
      _sum: { freeNightsUsed: 0 },
    } as never);
    vi.mocked(prisma.promoRedemptionAllocation.findMany).mockResolvedValue([] as never);

    await validateAndCalculatePromoDiscount(
      makePromoSubject({ maxUniqueMembersTotal: 5 }),
      {
        memberId: "member-1",
        totalPriceCents: 10000,
        guests: [{ memberId: "member-1", isMember: true, perNightRates: [5000, 5000] }],
      }
    ,
      null,
      { todayAtClub: CLUB_TODAY_FOR_TEST }
    );

    const findManyCalls = vi.mocked(prisma.promoRedemptionAllocation.findMany).mock.calls;
    expect(findManyCalls.length).toBeGreaterThan(0);
    for (const [args] of findManyCalls) {
      expect(args?.where).toMatchObject(BENEFICIAL_PROMO_ALLOCATION_FILTER);
    }
  });

  it("does not benefit-filter the lifetime free-nights sum (fail-safe direction)", async () => {
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.promoRedemptionAllocation.count).mockResolvedValue(0);
    vi.mocked(prisma.promoRedemptionAllocation.aggregate).mockResolvedValue({
      _sum: { freeNightsUsed: 0 },
    } as never);
    vi.mocked(prisma.promoRedemptionAllocation.findMany).mockResolvedValue([] as never);

    await validateAndCalculatePromoDiscount(makePromoSubject(), {
      memberId: "member-1",
      totalPriceCents: 10000,
      guests: [{ memberId: "member-1", isMember: true, perNightRates: [5000, 5000] }],
    },
      null,
      { todayAtClub: CLUB_TODAY_FOR_TEST }
    );

    expect(vi.mocked(prisma.promoRedemptionAllocation.aggregate)).toHaveBeenCalledWith({
      where: { promoCodeId: "promo-1", memberId: "member-1" },
      _sum: { freeNightsUsed: true },
    });
  });
});

describe("member-facing status is benefit-gated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not say "Already used by member" for a benefit-free application', async () => {
    const { prisma } = await import("@/lib/prisma");
    // The filtered include returns no rows: the member's only stored
    // allocation for this code carried no benefit.
    vi.mocked(prisma.promoCodeAssignment.findMany).mockResolvedValue([
      {
        createdAt: new Date("2026-07-01T00:00:00Z"),
        promoCode: {
          id: "promo-1",
          // A SET_PRICE code, NOT a never-biting CAP_ONLY one. A cap that never
          // bites produces no eligible guest at all, so it wrote neither an
          // allocation nor a redemption even before #2299 and never burned
          // anyone's use; the cases that did burn one are a percentage or
          // fixed amount over already-free nights, and a SET_PRICE code whose
          // price already equals what the member pays.
          code: "FLAT80",
          description: null,
          type: "FIXED_NIGHTLY_PRICE",
          percentOff: null,
          valueCents: null,
          freeNightsPerIndividual: null,
          lifetimeFreeNightsCap: null,
          fixedNightlyPriceCents: 8000,
          fixedNightlyMode: "SET_PRICE",
          active: true,
          archivedAt: null,
          validFrom: null,
          validUntil: null,
          bookingStartFrom: null,
          bookingStartUntil: null,
          assignedMembersOnlyOwnNights: true,
          maxRedemptionsTotal: null,
          currentRedemptions: 0,
          maxUsesPerMember: 1,
          allocations: [],
        },
      },
    ] as never);

    const summaries = await getAssignedPromoCodeSummariesForMember(
      "member-1",
      new Date("2026-07-15T00:00:00Z")
    );

    expect(summaries).toHaveLength(1);
    expect(summaries[0].redemptionCount).toBe(0);
    expect(summaries[0].statusReason).toBe("Available to member");
    expect(summaries[0].visibleToMember).toBe(true);
  });
});

// --- The concurrency guard ---------------------------------------------------

describe("lockPromoCodeRowsForUpdate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("locks every promo row in a deterministic id order, one statement each", async () => {
    const { tx, lockedIds, lockedStatements } = makeTx();

    await lockPromoCodeRowsForUpdate(asTx(tx), ["promo-z", "promo-a", "promo-m"]);

    // Sorted in the application, so two transactions doing opposite promo
    // swaps take the rows in the same order and cannot build a lock cycle.
    expect(lockedIds).toEqual(["promo-a", "promo-m", "promo-z"]);
    for (const statement of lockedStatements) {
      expect(statement).toContain("FOR UPDATE");
      // A CONSTANT is selected through $executeRaw and the result is discarded:
      // the statement exists for its lock, never for its shape (#2289). Naming
      // a column here would make it look like a read somebody could trust.
      expect(statement).toContain('SELECT 1 FROM "PromoCode"');
    }
  });

  it("de-duplicates and ignores absent ids", async () => {
    const { tx, lockedIds } = makeTx();

    await lockPromoCodeRowsForUpdate(asTx(tx), [
      "promo-a",
      null,
      undefined,
      "promo-a",
      "",
    ]);

    expect(lockedIds).toEqual(["promo-a"]);
  });

  it("locks nothing at all when there is nothing to lock", async () => {
    const { tx } = makeTx();

    await lockPromoCodeRowsForUpdate(asTx(tx), [null, undefined]);

    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
});

// --- The repair migration ----------------------------------------------------

const repairSql = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20260731140000_repair_zero_benefit_promo_allocations/migration.sql"
  ),
  "utf8"
);

describe("zero-benefit repair migration", () => {
  it("deletes exactly the negation of the application's benefit test", () => {
    expect(repairSql).toMatch(
      /DELETE FROM "PromoRedemptionAllocation"\s+WHERE "discountCents" <= 0\s+AND "priceAdjustmentCents" = 0\s+AND "freeNightsUsed" <= 0;/
    );
  });

  it("keeps the PromoRedemption audit rows", () => {
    expect(repairSql).not.toContain('DELETE FROM "PromoRedemption"');
    expect(repairSql).not.toContain('DELETE FROM "PromoRedemptionGuestTarget"');
  });

  it("rebases currentRedemptions by recounting, so re-running it is a no-op", () => {
    expect(repairSql).toContain('UPDATE "PromoCode"');
    expect(repairSql).toContain('SET "currentRedemptions" = COALESCE(counted."allocationCount", 0)');
    expect(repairSql).toContain('SELECT COUNT(*) FROM "PromoRedemptionAllocation" a');
    // Guarded so untouched codes are not written at all.
    expect(repairSql).toContain(
      'AND "PromoCode"."currentRedemptions" <> COALESCE(counted."allocationCount", 0)'
    );
  });

  it("tells the operator to re-run it after a blue/green drain", () => {
    // The drift an old colour can leave behind does NOT self-heal on its own —
    // only if that booking happens to be repriced or removed later. The
    // migration file has to say so, because the migration will not re-run
    // itself.
    expect(repairSql).toMatch(/OPERATOR STEP/);
    expect(repairSql).toMatch(/RE-RUN BOTH STATEMENTS BELOW ONCE/);
  });

  it("makes no schema change and writes no session clock", () => {
    expect(repairSql).not.toMatch(/\b(CREATE|ALTER|DROP)\s+(TABLE|TYPE|INDEX|CONSTRAINT)/i);
    expect(repairSql).not.toMatch(/CURRENT_TIMESTAMP|[^A-Za-z_]now\s*\(/i);
  });
});
