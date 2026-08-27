import { beforeEach, describe, expect, it, vi } from "vitest";

// #2299: the batch-modification promo path can charge AND refund promo usage
// caps, so its cap read and its counter writes must be serialised by the same
// FOR UPDATE row lock booking creation has always taken
// (docs/CONCURRENCY_AND_LOCKING.md -> "Narrow row-lock protocols"). Without it
// two concurrent modifications can both pass a "one use left" check.

vi.mock("@/lib/prisma", () => ({
  prisma: {
    promoRedemptionAllocation: {
      aggregate: vi.fn(),
      count: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

import { applyPromoCodeChanges } from "../booking-modify-plan";
import { requireCalendarDate } from "@/lib/club-time";

// #3123 — the transaction-bound promo and refund helpers take the CLUB's
// calendar day as a REQUIRED value now: the club timezone is one of the two
// reads that cannot happen under a lock (`INV-LOCK-004`), so it is resolved by
// the caller and threaded in. These call sites are not about a date boundary,
// so the frozen clock's own club day is used.
const CLUB_TODAY_FOR_TEST = requireCalendarDate("2026-07-01");

type Call = { op: string; id?: string };

function makeTx(promoRows: Record<string, Record<string, unknown>>) {
  const calls: Call[] = [];

  const tx = {
    $executeRaw: vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ op: "lock", id: String(values[0]) });
      // $executeRaw returns an affected-row count, never rows (#2289).
      return 1;
    }),
    promoCode: {
      findUnique: vi.fn(async ({ where }: { where: { code?: string; id?: string } }) => {
        calls.push({ op: "promoCode.findUnique" });
        const row = Object.values(promoRows).find(
          (candidate) => candidate.code === where.code || candidate.id === where.id
        );
        return row ?? null;
      }),
      update: vi.fn(async ({ where }: { where: { id: string } }) => {
        calls.push({ op: "promoCode.update", id: where.id });
        return {};
      }),
    },
    promoCodeLodge: { findMany: vi.fn(async () => []) },
    promoRedemption: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        calls.push({ op: "promoRedemption.create" });
        return { id: "redemption-new", ...data };
      }),
      update: vi.fn(async () => ({})),
      delete: vi.fn(async () => {
        calls.push({ op: "promoRedemption.delete" });
        return {};
      }),
    },
    promoRedemptionAllocation: {
      // 1 stored allocation row for the outgoing redemption; no prior
      // beneficial use of the incoming code by this member.
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        where.promoRedemptionId ? 1 : 0
      ),
      aggregate: vi.fn(async () => ({ _sum: { freeNightsUsed: 0 } })),
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async () => ({ count: 1 })),
    },
    promoRedemptionGuestTarget: {
      createMany: vi.fn(async () => ({ count: 0 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  };

  return { tx, calls };
}

type ApplyArgs = Parameters<typeof applyPromoCodeChanges>;

const newPromoRow = {
  id: "promo-a",
  code: "NEWCODE",
  internal: false,
  active: true,
  validFrom: null,
  validUntil: null,
  bookingStartFrom: null,
  bookingStartUntil: null,
  maxRedemptionsTotal: null,
  maxUniqueMembersTotal: null,
  maxUsesPerMember: 1,
  currentRedemptions: 0,
  membersOnly: false,
  memberGuestsOnly: false,
  type: "PERCENTAGE",
  valueCents: null,
  percentOff: 20,
  freeNightsPerIndividual: null,
  lifetimeFreeNightsCap: null,
  fixedNightlyPriceCents: null,
  fixedNightlyMode: null,
  maxGuestsPerBooking: null,
  maxNightlyValueCents: null,
  assignedMembersOnlyOwnNights: true,
  assignments: [],
  lodges: [],
};

function runSwap(tx: ReturnType<typeof makeTx>["tx"]) {
  return applyPromoCodeChanges(tx as unknown as ApplyArgs[0], {
      todayAtClub: CLUB_TODAY_FOR_TEST,
    booking: {
      memberId: "member-1",
      lodgeId: "lodge-1",
      // Outgoing code sorts AFTER the incoming one, so a naive
      // "lock what you are about to use" would take them out of order.
      promoRedemption: {
        id: "redemption-old",
        promoCodeId: "promo-z",
        bookingId: "booking-1",
        memberId: "member-1",
      },
    } as unknown as ApplyArgs[1]["booking"],
    bookingId: "booking-1",
    input: { promoCode: "newcode" } as unknown as ApplyArgs[1]["input"],
    inProgressPlan: null,
    newCheckIn: new Date("2026-08-01T00:00:00Z"),
    newTotalPriceCents: 10000,
    guestNightRates: [
      {
        bookingGuestId: "bg-1",
        memberId: "member-1",
        isMember: true,
        perNightRates: [5000, 5000],
      },
    ],
  });
}

describe("applyPromoCodeChanges promo row locking (#2299)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("locks both promo rows in id order before the first counter write", async () => {
    const { tx, calls } = makeTx({ new: newPromoRow });

    const result = await runSwap(tx);
    expect(result.promoChanged).toBe(true);

    const lockIds = calls.filter((call) => call.op === "lock").map((call) => call.id);
    // Sorted globally, so two transactions swapping in opposite directions
    // take the rows in the same order and cannot deadlock each other.
    expect(lockIds).toEqual(["promo-a", "promo-z"]);

    const lastLockIndex = calls.map((call) => call.op).lastIndexOf("lock");
    const firstCounterWrite = calls.findIndex((call) => call.op === "promoCode.update");
    const redemptionDelete = calls.findIndex((call) => call.op === "promoRedemption.delete");
    expect(firstCounterWrite).toBeGreaterThan(lastLockIndex);
    expect(redemptionDelete).toBeGreaterThan(lastLockIndex);
  });

  it("re-reads the promo row under the lock, so the caps checked are the caps consumed", async () => {
    const { tx, calls } = makeTx({ new: newPromoRow });

    await runSwap(tx);

    // The id-only pre-lookup, then the lock, then the authoritative read.
    const ops = calls.map((call) => call.op);
    const firstLookup = ops.indexOf("promoCode.findUnique");
    const lastLock = ops.lastIndexOf("lock");
    const lockedRead = ops.indexOf("promoCode.findUnique", lastLock);
    expect(firstLookup).toBeLessThan(lastLock);
    expect(lockedRead).toBeGreaterThan(lastLock);
  });

  it("locks only the outgoing code when the promo is simply removed", async () => {
    const { tx, calls } = makeTx({});

    await applyPromoCodeChanges(tx as unknown as ApplyArgs[0], {
      todayAtClub: CLUB_TODAY_FOR_TEST,
      booking: {
        memberId: "member-1",
        lodgeId: "lodge-1",
        promoRedemption: {
          id: "redemption-old",
          promoCodeId: "promo-z",
          bookingId: "booking-1",
          memberId: "member-1",
        },
      } as unknown as ApplyArgs[1]["booking"],
      bookingId: "booking-1",
      input: { removePromoCode: true } as unknown as ApplyArgs[1]["input"],
      inProgressPlan: null,
      newCheckIn: new Date("2026-08-01T00:00:00Z"),
      newTotalPriceCents: 10000,
      guestNightRates: [],
    });

    expect(calls.filter((call) => call.op === "lock").map((call) => call.id)).toEqual([
      "promo-z",
    ]);
  });
});
