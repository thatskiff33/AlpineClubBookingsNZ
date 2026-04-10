import { describe, it, expect } from "vitest";
import {
  allocateChores,
  isEligibleForTimeOfDay,
  ChoreTemplateInput,
  GuestInput,
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
    timeOfDay: overrides.timeOfDay,
    frequencyMode: overrides.frequencyMode,
    frequencyDays: overrides.frequencyDays,
    frequencyDaysOfWeek: overrides.frequencyDaysOfWeek,
  };
}

function makeGuest(overrides: Partial<GuestInput> = {}): GuestInput {
  return {
    id: overrides.id ?? "guest-1",
    bookingId: overrides.bookingId ?? "booking-1",
    firstName: overrides.firstName ?? "John",
    lastName: overrides.lastName ?? "Doe",
    ageTier: overrides.ageTier ?? "ADULT",
    isArriving: overrides.isArriving,
    isDeparting: overrides.isDeparting,
  };
}

// ---------------------------------------------------------------------------
// F7: isEligibleForTimeOfDay
// ---------------------------------------------------------------------------

describe("isEligibleForTimeOfDay", () => {
  it("arriving guest is ineligible for MORNING chores", () => {
    const guest = makeGuest({ isArriving: true });
    expect(isEligibleForTimeOfDay(guest, "MORNING")).toBe(false);
  });

  it("arriving guest is eligible for EVENING chores", () => {
    const guest = makeGuest({ isArriving: true });
    expect(isEligibleForTimeOfDay(guest, "EVENING")).toBe(true);
  });

  it("arriving guest is eligible for ANYTIME chores", () => {
    const guest = makeGuest({ isArriving: true });
    expect(isEligibleForTimeOfDay(guest, "ANYTIME")).toBe(true);
  });

  it("departing guest is ineligible for EVENING chores", () => {
    const guest = makeGuest({ isDeparting: true });
    expect(isEligibleForTimeOfDay(guest, "EVENING")).toBe(false);
  });

  it("departing guest is eligible for MORNING chores", () => {
    const guest = makeGuest({ isDeparting: true });
    expect(isEligibleForTimeOfDay(guest, "MORNING")).toBe(true);
  });

  it("departing guest is eligible for ANYTIME chores", () => {
    const guest = makeGuest({ isDeparting: true });
    expect(isEligibleForTimeOfDay(guest, "ANYTIME")).toBe(true);
  });

  it("staying-through guest is eligible for all time-of-day", () => {
    const guest = makeGuest({ isArriving: false, isDeparting: false });
    expect(isEligibleForTimeOfDay(guest, "MORNING")).toBe(true);
    expect(isEligibleForTimeOfDay(guest, "EVENING")).toBe(true);
    expect(isEligibleForTimeOfDay(guest, "ANYTIME")).toBe(true);
  });

  it("undefined timeOfDay treated as ANYTIME (always eligible)", () => {
    expect(isEligibleForTimeOfDay(makeGuest({ isArriving: true }), undefined)).toBe(true);
    expect(isEligibleForTimeOfDay(makeGuest({ isDeparting: true }), undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F7: Arriving/departing routing in allocateChores
// ---------------------------------------------------------------------------

describe("allocateChores with arriving/departing routing", () => {
  it("arriving guest skipped for MORNING chore", () => {
    const morningChore = makeChore({
      id: "morning-1",
      name: "Breakfast",
      timeOfDay: "MORNING",
      recommendedPeopleMin: 1,
      recommendedPeopleMax: 1,
    });
    const arrivingGuest = makeGuest({ id: "g1", isArriving: true });
    const stayingGuest = makeGuest({ id: "g2", isArriving: false, isDeparting: false });

    const result = allocateChores([morningChore], [arrivingGuest, stayingGuest], []);
    expect(result).toHaveLength(1);
    expect(result[0].bookingGuestId).toBe("g2");
  });

  it("departing guest skipped for EVENING chore", () => {
    const eveningChore = makeChore({
      id: "evening-1",
      name: "Dinner",
      timeOfDay: "EVENING",
      recommendedPeopleMin: 1,
      recommendedPeopleMax: 1,
    });
    const departingGuest = makeGuest({ id: "g1", isDeparting: true });
    const stayingGuest = makeGuest({ id: "g2", isArriving: false, isDeparting: false });

    const result = allocateChores([eveningChore], [departingGuest, stayingGuest], []);
    expect(result).toHaveLength(1);
    expect(result[0].bookingGuestId).toBe("g2");
  });

  it("MORNING chore unassigned when all guests are arriving", () => {
    const morningChore = makeChore({
      id: "morning-1",
      timeOfDay: "MORNING",
      recommendedPeopleMin: 1,
      recommendedPeopleMax: 1,
    });
    const g1 = makeGuest({ id: "g1", isArriving: true });
    const g2 = makeGuest({ id: "g2", isArriving: true });

    const result = allocateChores([morningChore], [g1, g2], []);
    expect(result).toHaveLength(0);
  });

  it("ANYTIME chore assigned to both arriving and departing guests", () => {
    const anytimeChore = makeChore({
      id: "anytime-1",
      timeOfDay: "ANYTIME",
      recommendedPeopleMin: 2,
      recommendedPeopleMax: 2,
    });
    const arriving = makeGuest({ id: "g1", isArriving: true, bookingId: "b1" });
    const departing = makeGuest({ id: "g2", isDeparting: true, bookingId: "b2" });

    const result = allocateChores([anytimeChore], [arriving, departing], []);
    expect(result).toHaveLength(2);
  });

  it("guests without isArriving/isDeparting flags are eligible for all chores", () => {
    const morningChore = makeChore({
      id: "morning-1",
      timeOfDay: "MORNING",
      recommendedPeopleMin: 1,
      recommendedPeopleMax: 1,
    });
    const guest = makeGuest({ id: "g1" }); // no flags set

    const result = allocateChores([morningChore], [guest], []);
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// F11: Chore history lookback with frequency filtering in allocateChores
// ---------------------------------------------------------------------------

describe("allocateChores with choreLastRosteredDates (F11)", () => {
  const today = new Date("2026-07-10");

  it("EVERY_X_DAYS chore excluded when rostered within interval", () => {
    const chore = makeChore({
      id: "c1",
      frequencyMode: "EVERY_X_DAYS",
      frequencyDays: 3,
    });
    const guest = makeGuest({ id: "g1" });
    const choreLastRosteredDates = new Map([
      ["c1", new Date("2026-07-09")], // 1 day ago
    ]);

    const result = allocateChores([chore], [guest], [], {
      choreLastRosteredDates,
      currentDate: today,
    });
    expect(result).toHaveLength(0);
  });

  it("EVERY_X_DAYS chore included when interval has passed", () => {
    const chore = makeChore({
      id: "c1",
      frequencyMode: "EVERY_X_DAYS",
      frequencyDays: 3,
    });
    const guest = makeGuest({ id: "g1" });
    const choreLastRosteredDates = new Map([
      ["c1", new Date("2026-07-07")], // 3 days ago
    ]);

    const result = allocateChores([chore], [guest], [], {
      choreLastRosteredDates,
      currentDate: today,
    });
    expect(result).toHaveLength(1);
  });

  it("SPECIFIC_DAYS chore excluded on non-matching day", () => {
    // 2026-07-10 is a Friday (day 5 ISO)
    const chore = makeChore({
      id: "c1",
      frequencyMode: "SPECIFIC_DAYS",
      frequencyDaysOfWeek: [1, 4], // Monday, Thursday
    });
    const guest = makeGuest({ id: "g1" });

    const result = allocateChores([chore], [guest], [], {
      choreLastRosteredDates: new Map(),
      currentDate: today,
    });
    expect(result).toHaveLength(0);
  });

  it("SPECIFIC_DAYS chore included on matching day", () => {
    // 2026-07-10 is a Friday (day 5 ISO)
    const chore = makeChore({
      id: "c1",
      frequencyMode: "SPECIFIC_DAYS",
      frequencyDaysOfWeek: [5, 7], // Friday, Sunday
    });
    const guest = makeGuest({ id: "g1" });

    const result = allocateChores([chore], [guest], [], {
      choreLastRosteredDates: new Map(),
      currentDate: today,
    });
    expect(result).toHaveLength(1);
  });

  it("DAILY chore always included regardless of last rostered", () => {
    const chore = makeChore({
      id: "c1",
      frequencyMode: "DAILY",
    });
    const guest = makeGuest({ id: "g1" });
    const choreLastRosteredDates = new Map([
      ["c1", new Date("2026-07-09")],
    ]);

    const result = allocateChores([chore], [guest], [], {
      choreLastRosteredDates,
      currentDate: today,
    });
    expect(result).toHaveLength(1);
  });

  it("frequency filtering skipped when options not provided", () => {
    const chore = makeChore({
      id: "c1",
      frequencyMode: "EVERY_X_DAYS",
      frequencyDays: 3,
    });
    const guest = makeGuest({ id: "g1" });

    // No choreLastRosteredDates or currentDate => no filtering
    const result = allocateChores([chore], [guest], []);
    expect(result).toHaveLength(1);
  });

  it("never-rostered chore is included for EVERY_X_DAYS", () => {
    const chore = makeChore({
      id: "c1",
      frequencyMode: "EVERY_X_DAYS",
      frequencyDays: 5,
    });
    const guest = makeGuest({ id: "g1" });

    const result = allocateChores([chore], [guest], [], {
      choreLastRosteredDates: new Map(), // empty = never rostered
      currentDate: today,
    });
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// F7 + F11 combined: time-of-day routing with frequency filtering
// ---------------------------------------------------------------------------

describe("combined F7 + F11: arriving/departing + frequency", () => {
  const today = new Date("2026-07-10"); // Friday

  it("arriving guest excluded from MORNING chore even when chore is due", () => {
    const morningChore = makeChore({
      id: "m1",
      timeOfDay: "MORNING",
      frequencyMode: "DAILY",
      recommendedPeopleMin: 1,
      recommendedPeopleMax: 1,
    });
    const arriving = makeGuest({ id: "g1", isArriving: true });

    const result = allocateChores([morningChore], [arriving], [], {
      choreLastRosteredDates: new Map(),
      currentDate: today,
    });
    expect(result).toHaveLength(0);
  });

  it("frequency-excluded chore not assigned even to staying guests", () => {
    const chore = makeChore({
      id: "c1",
      timeOfDay: "EVENING",
      frequencyMode: "EVERY_X_DAYS",
      frequencyDays: 3,
      recommendedPeopleMin: 1,
      recommendedPeopleMax: 1,
    });
    const guest = makeGuest({ id: "g1" });

    const result = allocateChores([chore], [guest], [], {
      choreLastRosteredDates: new Map([["c1", new Date("2026-07-09")]]),
      currentDate: today,
    });
    expect(result).toHaveLength(0);
  });
});
