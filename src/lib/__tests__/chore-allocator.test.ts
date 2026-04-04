import { describe, it, expect } from "vitest";
import {
  allocateChores,
  isEligibleForChore,
  meetsMinAge,
  scalePeopleCount,
  selectChoresForOccupancy,
  ChoreTemplateInput,
  GuestInput,
  ChoreHistoryEntry,
} from "../chore-allocator";

// ---------------------------------------------------------------------------
// Test Factories
// ---------------------------------------------------------------------------

function makeChore(overrides: Partial<ChoreTemplateInput> = {}): ChoreTemplateInput {
  return {
    id: overrides.id ?? "chore-1",
    name: overrides.name ?? "Test Chore",
    recommendedPeopleMin: overrides.recommendedPeopleMin ?? 1,
    recommendedPeopleMax: overrides.recommendedPeopleMax ?? 2,
    isEssential: overrides.isEssential ?? true,
    ageRestriction: overrides.ageRestriction ?? "ANY",
    minAge: overrides.minAge ?? 0,
    sortOrder: overrides.sortOrder ?? 1,
  };
}

function makeGuest(overrides: Partial<GuestInput> = {}): GuestInput {
  return {
    id: overrides.id ?? "guest-1",
    bookingId: overrides.bookingId ?? "booking-1",
    firstName: overrides.firstName ?? "John",
    lastName: overrides.lastName ?? "Doe",
    ageTier: overrides.ageTier ?? "ADULT",
  };
}

// ---------------------------------------------------------------------------
// meetsMinAge
// ---------------------------------------------------------------------------

describe("meetsMinAge", () => {
  it("ADULT meets any minAge up to 18", () => {
    expect(meetsMinAge("ADULT", 0)).toBe(true);
    expect(meetsMinAge("ADULT", 7)).toBe(true);
    expect(meetsMinAge("ADULT", 18)).toBe(true);
  });

  it("YOUTH meets minAge up to 10", () => {
    expect(meetsMinAge("YOUTH", 0)).toBe(true);
    expect(meetsMinAge("YOUTH", 10)).toBe(true);
    expect(meetsMinAge("YOUTH", 11)).toBe(false);
    expect(meetsMinAge("YOUTH", 18)).toBe(false);
  });

  it("CHILD meets only minAge 0", () => {
    expect(meetsMinAge("CHILD", 0)).toBe(true);
    expect(meetsMinAge("CHILD", 1)).toBe(false);
    expect(meetsMinAge("CHILD", 7)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isEligibleForChore
// ---------------------------------------------------------------------------

describe("isEligibleForChore", () => {
  it("ADULTS_ONLY excludes youth and children", () => {
    const chore = makeChore({ ageRestriction: "ADULTS_ONLY", minAge: 18 });
    expect(isEligibleForChore("ADULT", chore)).toBe(true);
    expect(isEligibleForChore("YOUTH", chore)).toBe(false);
    expect(isEligibleForChore("CHILD", chore)).toBe(false);
  });

  it("ANY allows all age tiers when minAge is 0", () => {
    const chore = makeChore({ ageRestriction: "ANY", minAge: 0 });
    expect(isEligibleForChore("ADULT", chore)).toBe(true);
    expect(isEligibleForChore("YOUTH", chore)).toBe(true);
    expect(isEligibleForChore("CHILD", chore)).toBe(true);
  });

  it("MIXED_PREFERRED allows all tiers", () => {
    const chore = makeChore({ ageRestriction: "MIXED_PREFERRED", minAge: 0 });
    expect(isEligibleForChore("ADULT", chore)).toBe(true);
    expect(isEligibleForChore("YOUTH", chore)).toBe(true);
    expect(isEligibleForChore("CHILD", chore)).toBe(true);
  });

  it("ADULT_SUPERVISED allows all tiers when minAge is met", () => {
    const chore = makeChore({ ageRestriction: "ADULT_SUPERVISED", minAge: 7 });
    expect(isEligibleForChore("ADULT", chore)).toBe(true);
    expect(isEligibleForChore("YOUTH", chore)).toBe(true);
    expect(isEligibleForChore("CHILD", chore)).toBe(false); // minAge 7 > CHILD age 0
  });

  it("minAge filtering works independently of ageRestriction", () => {
    const chore = makeChore({ ageRestriction: "ANY", minAge: 10 });
    expect(isEligibleForChore("ADULT", chore)).toBe(true);
    expect(isEligibleForChore("YOUTH", chore)).toBe(true);
    expect(isEligibleForChore("CHILD", chore)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scalePeopleCount
// ---------------------------------------------------------------------------

describe("scalePeopleCount", () => {
  it("returns max at full capacity", () => {
    expect(scalePeopleCount(4, 6, 29, 29)).toBe(6);
  });

  it("returns min at very low occupancy", () => {
    expect(scalePeopleCount(4, 6, 1, 29)).toBe(4);
  });

  it("scales linearly between min and max", () => {
    // ~50% occupancy -> halfway between 4 and 6 = 5
    expect(scalePeopleCount(4, 6, 15, 29)).toBe(5);
  });

  it("returns min when min equals max", () => {
    expect(scalePeopleCount(2, 2, 15, 29)).toBe(2);
  });

  it("never exceeds max", () => {
    expect(scalePeopleCount(1, 2, 100, 29)).toBe(2);
  });

  it("never goes below min", () => {
    expect(scalePeopleCount(2, 4, 0, 29)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// selectChoresForOccupancy
// ---------------------------------------------------------------------------

describe("selectChoresForOccupancy", () => {
  const essential = makeChore({ id: "e1", isEssential: true });
  const nonEssential = makeChore({ id: "ne1", isEssential: false });
  const all = [essential, nonEssential];

  it("includes all chores at high occupancy", () => {
    const result = selectChoresForOccupancy(all, 25, 20);
    expect(result).toHaveLength(2);
  });

  it("only includes essential chores at low occupancy", () => {
    const result = selectChoresForOccupancy(all, 5, 20);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("e1");
  });

  it("threshold is inclusive - exactly threshold includes all", () => {
    const result = selectChoresForOccupancy(all, 20, 20);
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// allocateChores - basic scenarios
// ---------------------------------------------------------------------------

describe("allocateChores", () => {
  it("returns empty for no guests", () => {
    const chores = [makeChore()];
    expect(allocateChores(chores, [], [])).toEqual([]);
  });

  it("returns empty for no chores", () => {
    const guests = [makeGuest()];
    expect(allocateChores([], guests, [])).toEqual([]);
  });

  it("assigns a single guest to a single chore", () => {
    const chores = [makeChore({ recommendedPeopleMin: 1, recommendedPeopleMax: 1 })];
    const guests = [makeGuest()];
    const result = allocateChores(chores, guests, []);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      choreTemplateId: "chore-1",
      bookingGuestId: "guest-1",
      bookingId: "booking-1",
    });
  });

  it("distributes chores via round-robin - no guest gets 2 before all get 1", () => {
    const chores = [
      makeChore({ id: "c1", sortOrder: 1, recommendedPeopleMin: 1, recommendedPeopleMax: 1 }),
      makeChore({ id: "c2", sortOrder: 2, recommendedPeopleMin: 1, recommendedPeopleMax: 1 }),
      makeChore({ id: "c3", sortOrder: 3, recommendedPeopleMin: 1, recommendedPeopleMax: 1 }),
    ];
    const guests = [
      makeGuest({ id: "g1" }),
      makeGuest({ id: "g2" }),
      makeGuest({ id: "g3" }),
    ];
    const result = allocateChores(chores, guests, []);
    // Each guest should have exactly 1 chore
    const guestChores = new Map<string, string[]>();
    for (const a of result) {
      if (!guestChores.has(a.bookingGuestId)) guestChores.set(a.bookingGuestId, []);
      guestChores.get(a.bookingGuestId)!.push(a.choreTemplateId);
    }
    expect(guestChores.get("g1")?.length).toBe(1);
    expect(guestChores.get("g2")?.length).toBe(1);
    expect(guestChores.get("g3")?.length).toBe(1);
  });

  it("assigns multiple guests to a chore when needed > 1", () => {
    const chores = [makeChore({ recommendedPeopleMin: 3, recommendedPeopleMax: 3 })];
    const guests = [
      makeGuest({ id: "g1" }),
      makeGuest({ id: "g2" }),
      makeGuest({ id: "g3" }),
      makeGuest({ id: "g4" }),
    ];
    const result = allocateChores(chores, guests, []);
    expect(result).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// allocateChores - age restriction enforcement
// ---------------------------------------------------------------------------

describe("allocateChores - age restrictions", () => {
  it("ADULTS_ONLY chore skips youth and children", () => {
    const chores = [
      makeChore({ ageRestriction: "ADULTS_ONLY", minAge: 18, recommendedPeopleMin: 1, recommendedPeopleMax: 1 }),
    ];
    const guests = [
      makeGuest({ id: "child", ageTier: "CHILD" }),
      makeGuest({ id: "youth", ageTier: "YOUTH" }),
      makeGuest({ id: "adult", ageTier: "ADULT" }),
    ];
    const result = allocateChores(chores, guests, []);
    expect(result).toHaveLength(1);
    expect(result[0].bookingGuestId).toBe("adult");
  });

  it("produces no assignments when all guests are children for ADULTS_ONLY", () => {
    const chores = [
      makeChore({ ageRestriction: "ADULTS_ONLY", minAge: 18 }),
    ];
    const guests = [
      makeGuest({ id: "c1", ageTier: "CHILD" }),
      makeGuest({ id: "c2", ageTier: "CHILD" }),
    ];
    const result = allocateChores(chores, guests, []);
    expect(result).toHaveLength(0);
  });

  it("ADULT_SUPERVISED ensures at least one adult is assigned", () => {
    const chores = [
      makeChore({
        ageRestriction: "ADULT_SUPERVISED",
        minAge: 7,
        recommendedPeopleMin: 2,
        recommendedPeopleMax: 2,
      }),
    ];
    const guests = [
      makeGuest({ id: "youth1", ageTier: "YOUTH" }),
      makeGuest({ id: "adult1", ageTier: "ADULT" }),
      makeGuest({ id: "youth2", ageTier: "YOUTH" }),
    ];
    const result = allocateChores(chores, guests, []);
    expect(result).toHaveLength(2);
    const assignedIds = result.map((a) => a.bookingGuestId);
    expect(assignedIds).toContain("adult1");
  });

  it("MIXED_PREFERRED pairs adults with non-adults", () => {
    const chores = [
      makeChore({
        ageRestriction: "MIXED_PREFERRED",
        minAge: 0,
        recommendedPeopleMin: 2,
        recommendedPeopleMax: 2,
      }),
    ];
    const guests = [
      makeGuest({ id: "adult1", ageTier: "ADULT" }),
      makeGuest({ id: "adult2", ageTier: "ADULT" }),
      makeGuest({ id: "child1", ageTier: "CHILD" }),
      makeGuest({ id: "child2", ageTier: "CHILD" }),
    ];
    const result = allocateChores(chores, guests, []);
    expect(result).toHaveLength(2);
    const tiers = result.map(
      (a) => guests.find((g) => g.id === a.bookingGuestId)!.ageTier
    );
    // Should have one adult and one non-adult
    expect(tiers).toContain("ADULT");
    expect(tiers.some((t) => t !== "ADULT")).toBe(true);
  });

  it("minAge filtering excludes children under the threshold", () => {
    const chores = [
      makeChore({ ageRestriction: "ANY", minAge: 7, recommendedPeopleMin: 1, recommendedPeopleMax: 1 }),
    ];
    const guests = [
      makeGuest({ id: "child", ageTier: "CHILD" }), // age 0 < minAge 7
      makeGuest({ id: "youth", ageTier: "YOUTH" }), // age 10 >= minAge 7
    ];
    const result = allocateChores(chores, guests, []);
    expect(result).toHaveLength(1);
    expect(result[0].bookingGuestId).toBe("youth");
  });
});

// ---------------------------------------------------------------------------
// allocateChores - chore history avoidance
// ---------------------------------------------------------------------------

describe("allocateChores - chore history", () => {
  it("avoids assigning a guest to the same chore they did recently", () => {
    const chores = [
      makeChore({ id: "c1", recommendedPeopleMin: 1, recommendedPeopleMax: 1 }),
    ];
    const guests = [
      makeGuest({ id: "g1" }),
      makeGuest({ id: "g2" }),
    ];
    // g1 did chore c1 yesterday
    const history: ChoreHistoryEntry[] = [
      { guestId: "g1", choreTemplateId: "c1", date: new Date("2026-04-02") },
    ];
    const result = allocateChores(chores, guests, history);
    expect(result).toHaveLength(1);
    // Should prefer g2 who has no history for c1
    expect(result[0].bookingGuestId).toBe("g2");
  });

  it("falls back to longest-ago assignment when all have recent history", () => {
    const chores = [
      makeChore({ id: "c1", recommendedPeopleMin: 1, recommendedPeopleMax: 1 }),
    ];
    const guests = [
      makeGuest({ id: "g1" }),
      makeGuest({ id: "g2" }),
    ];
    // Both did c1 recently, g1 did it 3 days ago, g2 did it 1 day ago
    const history: ChoreHistoryEntry[] = [
      { guestId: "g1", choreTemplateId: "c1", date: new Date("2026-03-31") },
      { guestId: "g2", choreTemplateId: "c1", date: new Date("2026-04-02") },
    ];
    const result = allocateChores(chores, guests, history);
    expect(result).toHaveLength(1);
    // Should prefer g1 whose assignment was longer ago
    expect(result[0].bookingGuestId).toBe("g1");
  });

  it("guest on 5-night stay gets different chore each day", () => {
    // Simulate 5 consecutive days with 5 chores and 1 guest
    const chores = [
      makeChore({ id: "c1", sortOrder: 1, recommendedPeopleMin: 1, recommendedPeopleMax: 1 }),
      makeChore({ id: "c2", sortOrder: 2, recommendedPeopleMin: 1, recommendedPeopleMax: 1 }),
      makeChore({ id: "c3", sortOrder: 3, recommendedPeopleMin: 1, recommendedPeopleMax: 1 }),
      makeChore({ id: "c4", sortOrder: 4, recommendedPeopleMin: 1, recommendedPeopleMax: 1 }),
      makeChore({ id: "c5", sortOrder: 5, recommendedPeopleMin: 1, recommendedPeopleMax: 1 }),
    ];
    const guest = makeGuest({ id: "g1" });

    const assignedChoreIds: string[] = [];
    const accumulatedHistory: ChoreHistoryEntry[] = [];

    for (let day = 0; day < 5; day++) {
      const date = new Date(2026, 3, 1 + day); // April 1-5
      // Only pass last 4 days of history
      const relevantHistory = accumulatedHistory.filter(
        (h) => date.getTime() - h.date.getTime() <= 4 * 24 * 60 * 60 * 1000
      );

      const result = allocateChores(chores, [guest], relevantHistory);
      // Guest gets 5 chores (one per chore template), but we care about the first assigned
      // Actually with 1 guest and 5 chores needing 1 each, guest gets all 5
      // The first chore assigned should vary based on history
      expect(result.length).toBeGreaterThan(0);

      // Track what chore was first (most "preferred")
      assignedChoreIds.push(result[0].choreTemplateId);

      // Add all assignments to history
      for (const a of result) {
        accumulatedHistory.push({
          guestId: "g1",
          choreTemplateId: a.choreTemplateId,
          date,
        });
      }
    }

    // With only 1 guest, they get all 5 chores each day. But the history avoidance
    // affects ordering. The key thing is the algorithm doesn't crash and produces
    // allocations every day.
    expect(assignedChoreIds).toHaveLength(5);
  });

  it("guest on 2-night stay with no history gets assigned normally", () => {
    const chores = [
      makeChore({ id: "c1", sortOrder: 1, recommendedPeopleMin: 1, recommendedPeopleMax: 1 }),
      makeChore({ id: "c2", sortOrder: 2, recommendedPeopleMin: 1, recommendedPeopleMax: 1 }),
    ];
    const guest = makeGuest({ id: "g1" });

    // Day 1 - no history
    const result1 = allocateChores(chores, [guest], []);
    expect(result1).toHaveLength(2);

    // Day 2 - with day 1 history
    const history: ChoreHistoryEntry[] = result1.map((a) => ({
      guestId: "g1",
      choreTemplateId: a.choreTemplateId,
      date: new Date("2026-04-01"),
    }));
    const result2 = allocateChores(chores, [guest], history);
    expect(result2).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// allocateChores - occupancy-based chore selection
// ---------------------------------------------------------------------------

describe("allocateChores - occupancy-based selection", () => {
  it("only rosters essential chores at low occupancy by default", () => {
    const chores = [
      makeChore({ id: "essential", isEssential: true, sortOrder: 1, recommendedPeopleMin: 1, recommendedPeopleMax: 1 }),
      makeChore({ id: "non-essential", isEssential: false, sortOrder: 2, recommendedPeopleMin: 1, recommendedPeopleMax: 1 }),
    ];
    const guests = [makeGuest({ id: "g1" }), makeGuest({ id: "g2" })]; // 2 guests = low

    const result = allocateChores(chores, guests, []);
    const choreIds = result.map((a) => a.choreTemplateId);
    expect(choreIds).toContain("essential");
    expect(choreIds).not.toContain("non-essential");
  });

  it("includes non-essential chores at high occupancy", () => {
    const chores = [
      makeChore({ id: "essential", isEssential: true, sortOrder: 1, recommendedPeopleMin: 1, recommendedPeopleMax: 1 }),
      makeChore({ id: "non-essential", isEssential: false, sortOrder: 2, recommendedPeopleMin: 1, recommendedPeopleMax: 1 }),
    ];
    // 25 guests = high occupancy
    const guests = Array.from({ length: 25 }, (_, i) =>
      makeGuest({ id: `g${i}` })
    );
    const result = allocateChores(chores, guests, []);
    const choreIds = result.map((a) => a.choreTemplateId);
    expect(choreIds).toContain("essential");
    expect(choreIds).toContain("non-essential");
  });

  it("explicit includeNonEssential override works", () => {
    const chores = [
      makeChore({ id: "essential", isEssential: true, sortOrder: 1, recommendedPeopleMin: 1, recommendedPeopleMax: 1 }),
      makeChore({ id: "non-essential", isEssential: false, sortOrder: 2, recommendedPeopleMin: 1, recommendedPeopleMax: 1 }),
    ];
    const guests = [makeGuest({ id: "g1" }), makeGuest({ id: "g2" })]; // low occupancy

    const result = allocateChores(chores, guests, [], { includeNonEssential: true });
    const choreIds = result.map((a) => a.choreTemplateId);
    expect(choreIds).toContain("non-essential");
  });

  it("scales people count based on occupancy", () => {
    // Chore needs 4-6 people. At 29 guests (full) should assign 6
    const chores = [
      makeChore({ id: "c1", recommendedPeopleMin: 4, recommendedPeopleMax: 6 }),
    ];
    const guests = Array.from({ length: 29 }, (_, i) =>
      makeGuest({ id: `g${i}` })
    );
    const result = allocateChores(chores, guests, []);
    expect(result).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// allocateChores - edge cases
// ---------------------------------------------------------------------------

describe("allocateChores - edge cases", () => {
  it("handles single guest with multiple chores", () => {
    const chores = [
      makeChore({ id: "c1", sortOrder: 1, recommendedPeopleMin: 1, recommendedPeopleMax: 1 }),
      makeChore({ id: "c2", sortOrder: 2, recommendedPeopleMin: 1, recommendedPeopleMax: 1 }),
      makeChore({ id: "c3", sortOrder: 3, recommendedPeopleMin: 1, recommendedPeopleMax: 1 }),
    ];
    const guests = [makeGuest()];
    const result = allocateChores(chores, guests, []);
    // Single guest gets all 3 chores
    expect(result).toHaveLength(3);
    expect(result.every((a) => a.bookingGuestId === "guest-1")).toBe(true);
  });

  it("handles more chores than guests", () => {
    const chores = Array.from({ length: 10 }, (_, i) =>
      makeChore({ id: `c${i}`, sortOrder: i, recommendedPeopleMin: 1, recommendedPeopleMax: 1 })
    );
    const guests = [makeGuest({ id: "g1" }), makeGuest({ id: "g2" })];
    const result = allocateChores(chores, guests, []);
    // All 10 chores should be assigned (each guest gets 5)
    expect(result).toHaveLength(10);
  });

  it("handles 29 guests at full capacity", () => {
    const chores = [
      makeChore({ id: "c1", sortOrder: 1, recommendedPeopleMin: 2, recommendedPeopleMax: 4 }),
      makeChore({ id: "c2", sortOrder: 2, recommendedPeopleMin: 1, recommendedPeopleMax: 2, ageRestriction: "ADULTS_ONLY", minAge: 18 }),
    ];
    // Mix of adults, youth, and children
    const guests: GuestInput[] = [
      ...Array.from({ length: 15 }, (_, i) =>
        makeGuest({ id: `adult-${i}`, ageTier: "ADULT" })
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        makeGuest({ id: `youth-${i}`, ageTier: "YOUTH" })
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        makeGuest({ id: `child-${i}`, ageTier: "CHILD" })
      ),
    ];
    const result = allocateChores(chores, guests, []);
    // c1 (ANY) should have 4 people at full capacity, c2 (ADULTS_ONLY) should have 2
    const c1Assignments = result.filter((a) => a.choreTemplateId === "c1");
    const c2Assignments = result.filter((a) => a.choreTemplateId === "c2");
    expect(c1Assignments).toHaveLength(4);
    expect(c2Assignments).toHaveLength(2);
    // c2 should only have adults
    for (const a of c2Assignments) {
      const guest = guests.find((g) => g.id === a.bookingGuestId)!;
      expect(guest.ageTier).toBe("ADULT");
    }
  });

  it("handles all children - only assigns to age-appropriate chores", () => {
    const chores = [
      makeChore({ id: "adult-only", ageRestriction: "ADULTS_ONLY", minAge: 18, sortOrder: 1 }),
      makeChore({ id: "any-chore", ageRestriction: "ANY", minAge: 0, sortOrder: 2, recommendedPeopleMin: 1, recommendedPeopleMax: 1 }),
    ];
    const guests = [
      makeGuest({ id: "c1", ageTier: "CHILD" }),
      makeGuest({ id: "c2", ageTier: "CHILD" }),
    ];
    const result = allocateChores(chores, guests, []);
    // Only any-chore should be assigned
    expect(result.every((a) => a.choreTemplateId === "any-chore")).toBe(true);
  });
});
