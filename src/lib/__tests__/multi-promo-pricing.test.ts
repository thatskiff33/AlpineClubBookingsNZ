/**
 * #3827 (epic #3813, C2): several promo codes priced on one booking, in the
 * booker's order, each over the nights no earlier code claimed — through the
 * ONE orchestrator, `applyBookingPromotions`, which runs the unchanged
 * single-code engine once per code. The owner's decisions on #3492 are the
 * oracle: D-3813-1 (any combination), D-3813-2 (the booker's order decides an
 * overlap; a code left with nothing is "already covered"), D-3813-3 (the
 * work-party discount claims its nights first) and D-3813-4 (a pending guest
 * takes no code until they accept).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  applyBookingPromotions,
  promoAlreadyCoveredMessage,
  repriceBookingPromotions,
  PROMO_PENDING_GUEST_MESSAGE,
  type PromotionApplicationInput,
  type PromotionGuest,
  type RepricedRedemption,
} from "../booking-promotions";
import { validateAndCalculatePromoDiscount, type PromoApplicationSubject } from "../promo";
import { resolvePromotionsInTransaction } from "../booking-create-promo";
import { applyPromoCodeChanges } from "../booking-modify-plan";
import { requestedPromoCodeListFor } from "../booking-modify-promo-request";
import { requireCalendarDate } from "@/lib/club-time";

const TODAY = requireCalendarDate("2026-07-01");
const N1 = new Date("2026-08-01T00:00:00.000Z");
const N2 = new Date("2026-08-02T00:00:00.000Z");
const N3 = new Date("2026-08-03T00:00:00.000Z");

function subject(id: string, overrides: Partial<PromoApplicationSubject> = {}): PromoApplicationSubject {
  return {
    id,
    active: true,
    validFrom: null,
    validUntil: null,
    maxRedemptionsTotal: null,
    currentRedemptions: 0,
    membersOnly: false,
    maxUsesPerMember: null,
    maxUniqueMembersTotal: null,
    type: "FREE_NIGHTS",
    valueCents: null,
    percentOff: null,
    freeNightsPerIndividual: 1,
    lifetimeFreeNightsCap: null,
    fixedNightlyPriceCents: null,
    fixedNightlyMode: null,
    maxGuestsPerBooking: null,
    maxNightlyValueCents: null,
    memberGuestsOnly: false,
    assignedMembersOnlyOwnNights: true,
    lodges: [],
    ...overrides,
  };
}

/** Usage tables empty: every cap has room; the work party's window covers N2..N3. */
function usageDb() {
  return {
    promoRedemptionAllocation: {
      count: vi.fn(async () => 0),
      aggregate: vi.fn(async () => ({ _sum: { freeNightsUsed: 0 } })),
      findMany: vi.fn(async () => []),
      groupBy: vi.fn(async () => []),
    },
    workPartyEvent: {
      findUnique: vi.fn(async () => ({ startDate: N2, endDate: N3 })),
    },
  };
}

function guest(memberId: string | null, rates: number[], consentStatus: PromotionGuest["consentStatus"] = null): PromotionGuest {
  return {
    memberId,
    isMember: memberId !== null,
    perNightRates: rates,
    nightDates: [N1, N2, N3].slice(0, rates.length),
    firstNight: N1,
    consentStatus,
    bookingGuestId: `bg-${memberId ?? "x"}`,
  };
}

// Ann's free night is code ANN (assigned to ann), Bob's is code BOB.
const ANN = subject("promo-ann");
const BOB = subject("promo-bob");
const PCT = subject("promo-pct", { type: "PERCENTAGE", percentOff: 50, freeNightsPerIndividual: null });

function application(
  code: string,
  promoCode: PromoApplicationSubject,
  assignedMemberIds: string[] | null,
  extra: Partial<PromotionApplicationInput> = {},
): PromotionApplicationInput {
  return { code, promoCode, assignedMemberIds, capOverflow: "reject", ...extra };
}

async function price(applications: PromotionApplicationInput[], guests: PromotionGuest[]) {
  return applyBookingPromotions(applications, {
    memberId: "ann",
    bookingCheckIn: N1,
    totalPriceCents: guests.reduce((sum, g) => sum + g.perNightRates.reduce((a, b) => a + b, 0), 0),
    guests,
    db: usageDb() as never,
    lodgeId: null,
    todayAtClub: TODAY,
  });
}

/** Every night key a priced booking would write a PROMO row on. */
function nightKeys(targets: Array<{ guestIndex: number; scope: string; stayDate: Date | null }>) {
  return targets
    .filter((target) => target.scope === "night")
    .map((target) => `${target.guestIndex}|${target.stayDate?.toISOString()}`);
}

describe("two members' own free-night codes on one booking (D-3813-1)", () => {
  it("each code covers only its holder's nights, with its own allocations, and the totals add", async () => {
    const guests = [guest("ann", [10000, 9000]), guest("bob", [8000, 7000])];
    const result = await price(
      [application("ANN", ANN, ["ann"]), application("BOB", BOB, ["bob"])],
      guests,
    );
    const [ann, bob] = result.outcomes;
    expect(ann?.result.error).toBeUndefined();
    expect(bob?.result.error).toBeUndefined();
    expect(ann?.result.discount?.allocations).toEqual([
      expect.objectContaining({ memberId: "ann", discountCents: 10000, freeNightsUsed: 1 }),
    ]);
    expect(bob?.result.discount?.allocations).toEqual([
      expect.objectContaining({ memberId: "bob", discountCents: 8000, freeNightsUsed: 1 }),
    ]);
    // Integer cents per code, summed with no cross-code rounding.
    expect(result.discountCents).toBe(18000);
    expect(result.priceAdjustmentCents).toBe(-18000);
    // Each target names the code that decided it, on its holder's own guest.
    expect(result.adjustmentTargets).toEqual([
      expect.objectContaining({ promoCodeId: "promo-ann", guestIndex: 0, amountCents: -10000 }),
      expect.objectContaining({ promoCodeId: "promo-bob", guestIndex: 1, amountCents: -8000 }),
    ]);
  });
});

describe("a night is discounted at most once, and the booker's order decides (D-3813-2)", () => {
  const guests = () => [guest("ann", [10000, 9000]), guest("bob", [8000, 7000])];

  it("never lets two codes claim the same night", async () => {
    const result = await price(
      [application("PCT", PCT, null), application("ANN", ANN, ["ann"]), application("BOB", BOB, ["bob"])],
      guests(),
    );
    const keys = nightKeys(result.adjustmentTargets);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("refuses a later code whose every night is taken, naming the code that took them", async () => {
    const result = await price(
      [application("PCT", PCT, null), application("ANN", ANN, ["ann"])],
      guests(),
    );
    expect(result.outcomes[1]?.result.error).toBe(promoAlreadyCoveredMessage("PCT"));
    // PCT alone: half of every night.
    expect(result.discountCents).toBe(17000);
  });

  it("reordering changes the winner: the free night first, the percentage over what is left", async () => {
    const result = await price(
      [application("ANN", ANN, ["ann"]), application("PCT", PCT, null)],
      guests(),
    );
    expect(result.outcomes.map((o) => o.result.error)).toEqual([undefined, undefined]);
    // Ann's 10000 night is free; PCT halves the other three nights.
    expect(result.discountCents).toBe(10000 + 4500 + 4000 + 3500);
    const pctTargets = result.adjustmentTargets.filter((t) => t.promoCodeId === "promo-pct");
    expect(nightKeys(pctTargets)).not.toContain(`0|${N1.toISOString()}`);
  });
});

describe("the work-party discount claims its in-window nights first (D-3813-3)", () => {
  it("runs before a code listed ahead of it, and the code covers the rest", async () => {
    const workParty = subject("promo-wp", {
      type: "PERCENTAGE",
      percentOff: 100,
      freeNightsPerIndividual: null,
      internal: true,
    });
    const guests = [guest("ann", [10000, 9000, 8000])];
    const result = await price(
      [application("PCT", PCT, null), application("WORKBEE", workParty, null)],
      guests,
    );
    // Effective order: the work party first, whatever the list says.
    expect(result.outcomes.map((o) => o.application.code)).toEqual(["WORKBEE", "PCT"]);
    // The window is N2..N3, free; PCT halves N1 only.
    expect(result.discountCents).toBe(9000 + 8000 + 5000);
    expect(result.outcomes[0]?.applicationOrder).toBe(0);
  });
});

describe("a pending guest's nights take no code until they accept (D-3813-4)", () => {
  it("a typed booking-wide code leaves the pending guest's nights alone", async () => {
    const result = await price(
      [application("PCT", PCT, null)],
      [guest("ann", [10000]), guest("cara", [6000], "PENDING")],
    );
    expect(result.discountCents).toBe(5000);
    expect(result.adjustmentTargets.every((t) => t.guestIndex === 0)).toBe(true);
  });

  it("a code that only a pending holder could use does not apply, and applies once they accept", async () => {
    const pending = await price(
      [application("CARA", subject("promo-cara"), ["cara"])],
      [guest("ann", [10000]), guest("cara", [6000], "PENDING")],
    );
    expect(pending.outcomes[0]?.result.error).toMatch(/assigned member is staying/);

    const accepted = await price(
      [application("CARA", subject("promo-cara"), ["cara"])],
      [guest("ann", [10000]), guest("cara", [6000], "CONFIRMED")],
    );
    expect(accepted.outcomes[0]?.result.error).toBeUndefined();
    expect(accepted.discountCents).toBe(6000);
  });

  it("a booker-picks-guests choice of only a pending guest says why, and keeps the choice", async () => {
    const pick = subject("promo-pick", { assignedMembersOnlyOwnNights: false });
    const guests = [guest("ann", [10000]), guest("cara", [6000], "PENDING")];
    const result = await price(
      [application("PICK", pick, ["ann"], { selectedGuestIndexes: [1] })],
      guests,
    );
    expect(result.outcomes[0]?.result.error).toBe(PROMO_PENDING_GUEST_MESSAGE);
  });
});

describe("one code, everyone staying: the engine's own answer (byte-identical)", () => {
  it("hands the engine the same arguments and returns its result, targets naming the code", async () => {
    const guests = [guest("ann", [10000, 9000]), guest("bob", [8000, 7000])];
    const direct = await validateAndCalculatePromoDiscount(PCT, {
      memberId: "ann",
      bookingCheckIn: N1,
      totalPriceCents: 34000,
      guests,
    }, null, { db: usageDb() as never, lodgeId: null, todayAtClub: TODAY, capOverflow: "reject" });
    const viaOrchestrator = await price([application("PCT", PCT, null)], guests);
    const outcome = viaOrchestrator.outcomes[0]!.result;
    expect(outcome.discount).toEqual({
      ...direct.discount,
      adjustmentTargets: direct.discount!.adjustmentTargets.map((t) => ({ ...t, promoCodeId: "promo-pct" })),
    });
    expect(outcome.beneficiaryMemberIds).toEqual(direct.beneficiaryMemberIds);
  });
});

describe("a per-guest fixed amount after a partial claim (INV-MONEY-038)", () => {
  it("takes min(value, the guest's unclaimed total) and claims the guest's remaining nights", async () => {
    const fixed = subject("promo-fixed", {
      type: "FIXED_AMOUNT",
      valueCents: 20000,
      freeNightsPerIndividual: null,
    });
    const later = subject("promo-later", { type: "PERCENTAGE", percentOff: 10, freeNightsPerIndividual: null });
    const result = await price(
      [application("ANN", ANN, ["ann"]), application("FIXED", fixed, null), application("LATER", later, null)],
      [guest("ann", [10000, 9000])],
    );
    // ANN frees the 10000 night; FIXED takes min(20000, 9000) off the rest.
    expect(result.outcomes[1]?.result.discount?.discountCents).toBe(9000);
    // Nothing is left for LATER.
    expect(result.outcomes[2]?.result.error).toBe(promoAlreadyCoveredMessage("FIXED"));
  });
});

describe("re-pricing a stored booking releases only the code whose holder left", () => {
  it("deletes the departed holder's redemption and re-prices the other in place", async () => {
    const calls: string[] = [];
    const tx = {
      ...usageDb(),
      $executeRaw: vi.fn(async (_strings: TemplateStringsArray, id: string) => {
        calls.push(`lock:${id}`);
        return 1;
      }),
      promoCode: {
        findUnique: vi.fn(async () => ({ currentRedemptions: 1 })),
        update: vi.fn(async ({ where }: { where: { id: string } }) => {
          calls.push(`counter:${where.id}`);
        }),
      },
      promoRedemption: {
        delete: vi.fn(async ({ where }: { where: { id: string } }) => {
          calls.push(`delete:${where.id}`);
        }),
        update: vi.fn(async ({ where }: { where: { id: string } }) => {
          calls.push(`update:${where.id}`);
        }),
      },
      promoRedemptionGuestTarget: { deleteMany: vi.fn(), createMany: vi.fn() },
      member: { findMany: vi.fn(async () => []) },
    };
    Object.assign(tx.promoRedemptionAllocation, {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
      count: vi.fn(async () => 1),
    });
    const redemption = (id: string, promoCode: PromoApplicationSubject, code: string, holder: string) =>
      ({
        id,
        promoCodeId: promoCode.id,
        bookingId: "booking-1",
        memberId: "ann",
        guestTargets: [],
        promoCode: { ...promoCode, code, assignments: [{ memberId: holder }], lodges: [] },
      }) as unknown as RepricedRedemption;

    const result = await repriceBookingPromotions(tx as never, {
      bookingId: "booking-1",
      redemptions: [redemption("r-ann", ANN, "ANN", "ann"), redemption("r-bob", BOB, "BOB", "bob")],
      memberId: "ann",
      bookingCheckIn: N1,
      totalPriceCents: 19000,
      // Bob was removed: only Ann is left.
      guests: [guest("ann", [10000, 9000])],
      lodgeId: null,
      todayAtClub: TODAY,
    });

    expect(result.releasedPromoCodes).toEqual(["BOB"]);
    expect(result.remainingPromoCodeLabel).toBe("ANN");
    expect(calls).toContain("delete:r-bob");
    expect(calls).not.toContain("delete:r-ann");
    expect(calls).toContain("update:r-ann");
    // Both code rows were locked in ONE sorted pass before anything was written.
    expect(calls.slice(0, 2)).toEqual(["lock:promo-ann", "lock:promo-bob"]);
    expect(result.promoCoverage?.message).toMatch(/Promo code BOB no longer applies/);
    expect(result.newDiscountCents).toBe(10000);
  });
});

describe("a concurrent two-code create takes the code rows in one global order", () => {
  it("locks by sorted id whatever order the booker chose, then re-reads under the lock", async () => {
    const order: string[] = [];
    const rows = [
      { ...subject("zz-promo-bob"), code: "BOB", internal: false, archivedAt: null },
      { ...subject("aa-promo-ann"), code: "ANN", internal: false, archivedAt: null },
    ];
    const tx = {
      ...usageDb(),
      $executeRaw: vi.fn(async (_strings: TemplateStringsArray, id: string) => {
        order.push(`lock:${id}`);
        return 1;
      }),
      promoCode: {
        findMany: vi.fn(async ({ where }: { where: { code?: unknown; id?: unknown } }) => {
          order.push(where.id ? "read-by-id" : "resolve-by-code");
          return where.id ? rows : rows.map(({ id, code }) => ({ id, code }));
        }),
      },
      promoCodeAssignment: {
        findMany: vi.fn(async () => [
          { promoCodeId: "aa-promo-ann", memberId: "ann" },
          { promoCodeId: "zz-promo-bob", memberId: "bob" },
        ]),
      },
      promoCodeLodge: { findMany: vi.fn(async () => []) },
    };
    const resolved = await resolvePromotionsInTransaction(tx as never, {
      // The booker put BOB first.
      sources: [
        { promoCodeStr: "bob", allowInternal: false },
        { promoCodeStr: "ann", allowInternal: false },
      ],
      lockRows: true,
      effectiveMemberId: "ann",
      checkIn: N1,
      guests: [
        { firstName: "A", lastName: "A", ageTier: "ADULT", isMember: true, memberId: "ann" },
        { firstName: "B", lastName: "B", ageTier: "ADULT", isMember: true, memberId: "bob" },
      ] as never,
      totalPriceCents: 19000,
      perNightCentsByGuest: [[10000], [9000]],
      nightDatesByGuest: [[N1], [N1]],
      lodgeId: "lodge-1",
      todayAtClub: TODAY,
    });
    expect(order).toEqual([
      "resolve-by-code",
      "lock:aa-promo-ann",
      "lock:zz-promo-bob",
      "read-by-id",
    ]);
    // The booker's order is what is stored.
    expect(resolved.redemptions.map((r) => [r.promoCodeId, r.applicationOrder])).toEqual([
      ["zz-promo-bob", 0],
      ["aa-promo-ann", 1],
    ]);
  });

  it("shows a typed code no guest whose place is still pending (D-3813-4, no back door)", async () => {
    const pct = { ...PCT, code: "PCT", internal: false, archivedAt: null };
    const tx = {
      ...usageDb(),
      $executeRaw: vi.fn(async () => 1),
      promoCode: {
        findMany: vi.fn(async ({ where }: { where: { id?: unknown } }) =>
          where.id ? [pct] : [{ id: pct.id, code: "PCT" }],
        ),
      },
      promoCodeAssignment: { findMany: vi.fn(async () => []) },
      promoCodeLodge: { findMany: vi.fn(async () => []) },
    };
    const resolved = await resolvePromotionsInTransaction(tx as never, {
      sources: [{ promoCodeStr: "pct", allowInternal: false }],
      lockRows: true,
      effectiveMemberId: "ann",
      checkIn: N1,
      guests: [
        { firstName: "A", lastName: "A", ageTier: "ADULT", isMember: true, memberId: "ann" },
        // A cross-family guest this create adds as PENDING.
        {
          firstName: "C",
          lastName: "C",
          ageTier: "ADULT",
          isMember: true,
          memberId: "cara",
          memberGuestConsent: { consentStatus: "PENDING" },
        },
      ] as never,
      totalPriceCents: 16000,
      perNightCentsByGuest: [[10000], [6000]],
      nightDatesByGuest: [[N1], [N1]],
      lodgeId: "lodge-1",
      todayAtClub: TODAY,
    });
    expect(resolved.discountCents).toBe(5000);
    expect(resolved.promoAdjustmentTargets.map((t) => t.guestIndex)).toEqual([0]);
  });

  it("refuses a code renamed between the unlocked read and the lock", async () => {
    const tx = {
      ...usageDb(),
      $executeRaw: vi.fn(async () => 1),
      promoCode: {
        findMany: vi.fn(async ({ where }: { where: { id?: unknown } }) =>
          where.id
            ? [{ ...subject("p1"), code: "RENAMED", internal: false }]
            : [{ id: "p1", code: "ANN" }],
        ),
      },
      promoCodeAssignment: { findMany: vi.fn(async () => []) },
      promoCodeLodge: { findMany: vi.fn(async () => []) },
    };
    await expect(
      resolvePromotionsInTransaction(tx as never, {
        sources: [{ promoCodeStr: "ann", allowInternal: false }],
        lockRows: true,
        effectiveMemberId: "ann",
        checkIn: N1,
        guests: [{ firstName: "A", lastName: "A", ageTier: "ADULT", isMember: true, memberId: "ann" }] as never,
        totalPriceCents: 10000,
        perNightCentsByGuest: [[10000]],
        nightDatesByGuest: [[N1]],
        lodgeId: "lodge-1",
        todayAtClub: TODAY,
      }),
    ).rejects.toThrow("Promo code not found");
  });
});

describe("an edit's code list (D-3813-2: add, remove or reorder in one field)", () => {
  it("reads the plural list in order, re-applying a code sent with a guest choice", () => {
    expect(
      requestedPromoCodeListFor(
        { promoCodes: [{ code: " bob " }, { code: "ann", promoGuestIds: ["g1"] }] },
        [],
      ),
    ).toEqual([
      { code: "BOB", reapply: false },
      { code: "ANN", promoGuestIds: ["g1"], reapply: true },
    ]);
  });

  it("keeps the legacy fields' meaning: one code replaces, removal removes, silence re-prices", () => {
    expect(requestedPromoCodeListFor({ promoCode: "ann" }, [])).toEqual([
      { code: "ANN", reapply: true },
    ]);
    expect(requestedPromoCodeListFor({ removePromoCode: true }, [])).toEqual([]);
    expect(requestedPromoCodeListFor({}, [])).toBeNull();
  });

  it("carries a stored working-bee discount the booker's list leaves out", () => {
    expect(
      requestedPromoCodeListFor({ promoCodes: [{ code: "ann" }] }, [
        { code: "WB-INTERNAL", internal: true },
        { code: "BOB", internal: false },
      ]),
    ).toEqual([
      { code: "WB-INTERNAL", reapply: false },
      { code: "ANN", reapply: false },
    ]);
  });
});

describe("an edit that reorders the booking's codes stores the new order", () => {
  it("re-prices both codes in the new order and writes the moved positions", async () => {
    const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
    const tx = {
      ...usageDb(),
      $executeRaw: vi.fn(async () => 1),
      clubModuleSettings: { findUnique: vi.fn(async () => ({ multiPromoCodes: true, promoCodes: true })) },
      promoCode: {
        findUnique: vi.fn(async () => ({ currentRedemptions: 1 })),
        findMany: vi.fn(async () => []),
        update: vi.fn(),
      },
      promoRedemption: {
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          updates.push({ id: where.id, data });
        }),
        delete: vi.fn(),
      },
      promoRedemptionGuestTarget: { deleteMany: vi.fn(), createMany: vi.fn() },
      member: { findMany: vi.fn(async () => []) },
    };
    Object.assign(tx.promoRedemptionAllocation, {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
      count: vi.fn(async () => 1),
    });
    const stored = (id: string, promoCode: PromoApplicationSubject, code: string, holders: string[] | null, order: number) => ({
      id,
      promoCodeId: promoCode.id,
      bookingId: "booking-1",
      memberId: "ann",
      applicationOrder: order,
      guestTargets: [],
      promoCode: {
        ...promoCode,
        code,
        internal: false,
        assignments: (holders ?? []).map((memberId) => ({ memberId })),
        lodges: [],
      },
    });
    const result = await applyPromoCodeChanges(tx as never, {
      booking: {
        memberId: "ann",
        lodgeId: "lodge-1",
        promoRedemptions: [stored("r-pct", PCT, "PCT", null, 0), stored("r-ann", ANN, "ANN", ["ann"], 1)],
      } as never,
      bookingId: "booking-1",
      // The booker moves ANN ahead of PCT.
      input: { promoCodes: [{ code: "ANN" }, { code: "PCT" }] } as never,
      inProgressPlan: null,
      newCheckIn: N1,
      newTotalPriceCents: 19000,
      guestNightRates: [{ ...guest("ann", [10000, 9000]) }],
      todayAtClub: TODAY,
    });
    expect(result.promoChanged).toBe(true);
    expect(result.promoRemoved).toBe(false);
    // ANN frees the 10000 night, PCT halves the 9000 one.
    expect(result.newDiscountCents).toBe(10000 + 4500);
    expect(result.promoCodeLabel).toBe("ANN, PCT");
    const orderWrites = updates.filter((update) => "applicationOrder" in update.data);
    expect(orderWrites).toEqual([
      { id: "r-ann", data: { applicationOrder: 0 } },
      { id: "r-pct", data: { applicationOrder: 1 } },
    ]);
  });
});
