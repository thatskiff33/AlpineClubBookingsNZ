/**
 * Chore Roster Auto-Suggest Algorithm
 *
 * Allocates guests to chores for a given date, respecting age restrictions,
 * chore history (4-day lookback), and round-robin fairness.
 */

import { AgeTier, AgeRestriction } from "@prisma/client";
import { FALLBACK_LODGE_CAPACITY } from "@/lib/lodge-capacity";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChoreTimeOfDay = "MORNING" | "EVENING" | "ANYTIME";
export type ChoreFrequencyMode = "DAILY" | "EVERY_X_DAYS" | "SPECIFIC_DAYS";

export interface ChoreTemplateInput {
  id: string;
  name: string;
  recommendedPeopleMin: number;
  recommendedPeopleMax: number;
  isEssential: boolean;
  ageRestriction: AgeRestriction;
  minAge: number;
  sortOrder: number;
  timeOfDay?: ChoreTimeOfDay;
  frequencyMode?: ChoreFrequencyMode;
  frequencyDays?: number | null;
  frequencyDaysOfWeek?: number[];
}

export interface GuestInput {
  id: string;
  bookingId: string;
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isArriving?: boolean;
  isDeparting?: boolean;
}

/** A record of a past chore assignment for a guest */
export interface ChoreHistoryEntry {
  guestId: string;
  choreTemplateId: string;
  date: Date;
}

export interface ChoreAllocation {
  choreTemplateId: string;
  bookingGuestId: string;
  bookingId: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HIGH_OCCUPANCY_THRESHOLD = 20;
const AGE_FOR_ADULT = 18;
const AGE_FOR_YOUTH = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the effective age (in years) for an AgeTier for comparison purposes */
function ageForTier(tier: AgeTier): number {
  switch (tier) {
    case "ADULT":
      return AGE_FOR_ADULT;
    case "YOUTH":
      return AGE_FOR_YOUTH;
    case "INFANT":
    case "CHILD":
      return 0;
  }
}

/** Check if a guest meets the minimum age for a chore */
export function meetsMinAge(guestAgeTier: AgeTier, minAge: number): boolean {
  return ageForTier(guestAgeTier) >= minAge;
}

/** Check if a guest is eligible for a chore based on time-of-day routing */
export function isEligibleForTimeOfDay(
  guest: Pick<GuestInput, "isArriving" | "isDeparting">,
  choreTimeOfDay: ChoreTimeOfDay | undefined
): boolean {
  const tod = choreTimeOfDay ?? "ANYTIME";
  if (guest.isArriving && tod === "MORNING") return false;
  if (guest.isDeparting && tod === "EVENING") return false;
  return true;
}

/** Check if a guest is eligible for a chore based on age restriction */
export function isEligibleForChore(
  guestAgeTier: AgeTier,
  chore: Pick<ChoreTemplateInput, "ageRestriction" | "minAge">
): boolean {
  // First check hard minimum age
  if (!meetsMinAge(guestAgeTier, chore.minAge)) {
    return false;
  }

  switch (chore.ageRestriction) {
    case "ADULTS_ONLY":
      return guestAgeTier === "ADULT";
    case "ANY":
    case "MIXED_PREFERRED":
    case "ADULT_SUPERVISED":
      return true;
    default:
      return true;
  }
}

/** Determine how many people to assign to a chore based on occupancy */
export function scalePeopleCount(
  min: number,
  max: number,
  guestCount: number,
  capacity: number = FALLBACK_LODGE_CAPACITY,
): number {
  if (guestCount >= capacity) return max;
  if (min === max) return min;

  // Linear interpolation between min and max based on occupancy ratio
  const ratio = guestCount / capacity;
  const scaled = Math.round(min + (max - min) * ratio);
  return Math.max(min, Math.min(max, scaled));
}

/** Select which chores to roster based on occupancy */
export function selectChoresForOccupancy(
  chores: ChoreTemplateInput[],
  guestCount: number,
  highOccupancyThreshold: number = HIGH_OCCUPANCY_THRESHOLD
): ChoreTemplateInput[] {
  if (guestCount >= highOccupancyThreshold) {
    // High occupancy: include all active chores
    return chores;
  }
  // Low occupancy: only essential chores
  return chores.filter((c) => c.isEssential);
}

/**
 * Build a map of guestId -> Set<choreTemplateId> for chores done in the
 * lookback window (last 4 days).
 */
function buildHistoryMap(
  history: ChoreHistoryEntry[]
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const entry of history) {
    if (!map.has(entry.guestId)) {
      map.set(entry.guestId, new Set());
    }
    map.get(entry.guestId)!.add(entry.choreTemplateId);
  }
  return map;
}

/**
 * Build a map of guestId -> Map<choreTemplateId, mostRecentDate>
 * for determining which guest did a specific chore longest ago.
 */
function buildHistoryDateMap(
  history: ChoreHistoryEntry[]
): Map<string, Map<string, Date>> {
  const map = new Map<string, Map<string, Date>>();
  for (const entry of history) {
    if (!map.has(entry.guestId)) {
      map.set(entry.guestId, new Map());
    }
    const choreMap = map.get(entry.guestId)!;
    const existing = choreMap.get(entry.choreTemplateId);
    if (!existing || entry.date > existing) {
      choreMap.set(entry.choreTemplateId, entry.date);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Frequency Filtering
// ---------------------------------------------------------------------------

/**
 * Filter chores by their frequency settings.
 * Returns only chores that are "due" on the given date.
 *
 * - DAILY: always included
 * - EVERY_X_DAYS: included only if last rostered >= X days ago (or never rostered)
 * - SPECIFIC_DAYS: included only if currentDate's ISO day-of-week is in the array
 */
export function filterChoresByFrequency(
  chores: ChoreTemplateInput[],
  choreLastRosteredDates: Map<string, Date>,
  currentDate: Date
): ChoreTemplateInput[] {
  const currentDayOfWeek = currentDate.getDay() === 0 ? 7 : currentDate.getDay(); // ISO: 1=Mon, 7=Sun

  return chores.filter((chore) => {
    const mode = chore.frequencyMode ?? "DAILY";

    if (mode === "DAILY") return true;

    if (mode === "EVERY_X_DAYS") {
      const interval = chore.frequencyDays;
      if (!interval || interval < 2) return true; // fallback to daily
      const lastDate = choreLastRosteredDates.get(chore.id);
      if (!lastDate) return true; // never rostered, include it
      const daysSince = Math.floor(
        (currentDate.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24)
      );
      return daysSince >= interval;
    }

    if (mode === "SPECIFIC_DAYS") {
      const days = chore.frequencyDaysOfWeek;
      if (!days || days.length === 0) return true; // no days specified, fallback to daily
      return days.includes(currentDayOfWeek);
    }

    return true;
  });
}

// ---------------------------------------------------------------------------
// Main Allocation Algorithm
// ---------------------------------------------------------------------------

export function allocateChores(
  chores: ChoreTemplateInput[],
  guests: GuestInput[],
  history: ChoreHistoryEntry[],
  options: {
    includeNonEssential?: boolean;
    highOccupancyThreshold?: number;
    choreLastRosteredDates?: Map<string, Date>;
    currentDate?: Date;
  } = {}
): ChoreAllocation[] {
  if (guests.length === 0 || chores.length === 0) {
    return [];
  }

  const threshold = options.highOccupancyThreshold ?? HIGH_OCCUPANCY_THRESHOLD;

  // 1. Select which chores to roster
  let selectedChores: ChoreTemplateInput[];
  if (options.includeNonEssential !== undefined) {
    // Explicit override from hut leader
    selectedChores = options.includeNonEssential
      ? chores
      : chores.filter((c) => c.isEssential);
  } else {
    selectedChores = selectChoresForOccupancy(chores, guests.length, threshold);
  }

  // 1b. Apply frequency filtering (F11)
  if (options.choreLastRosteredDates && options.currentDate) {
    selectedChores = filterChoresByFrequency(
      selectedChores,
      options.choreLastRosteredDates,
      options.currentDate
    );
  }

  // Sort by sortOrder
  selectedChores = [...selectedChores].sort((a, b) => a.sortOrder - b.sortOrder);

  // 2. Build history lookback maps
  const historySet = buildHistoryMap(history);
  const historyDates = buildHistoryDateMap(history);

  // 3. Track how many chores each guest has been assigned (for round-robin)
  const assignmentCount = new Map<string, number>();
  for (const guest of guests) {
    assignmentCount.set(guest.id, 0);
  }

  const allocations: ChoreAllocation[] = [];

  // 4. For each chore, allocate the required number of guests
  for (const chore of selectedChores) {
    const needed = scalePeopleCount(
      chore.recommendedPeopleMin,
      chore.recommendedPeopleMax,
      guests.length
    );

    // Find eligible guests for this chore (age + time-of-day routing)
    const eligible = guests.filter(
      (g) =>
        isEligibleForChore(g.ageTier, chore) &&
        isEligibleForTimeOfDay(g, chore.timeOfDay)
    );

    if (eligible.length === 0) continue;

    // Sort eligible guests by: fewest assignments first, then prefer those
    // who haven't done this chore recently, then family grouping
    const guestHistory = historySet;
    const guestHistoryDates = historyDates;

    const sorted = [...eligible].sort((a, b) => {
      // Primary: fewest total assignments
      const countDiff =
        (assignmentCount.get(a.id) ?? 0) - (assignmentCount.get(b.id) ?? 0);
      if (countDiff !== 0) return countDiff;

      // Secondary: prefer those who haven't done THIS chore recently
      const aDidRecently =
        guestHistory.get(a.id)?.has(chore.id) ?? false;
      const bDidRecently =
        guestHistory.get(b.id)?.has(chore.id) ?? false;
      if (aDidRecently !== bDidRecently) {
        return aDidRecently ? 1 : -1;
      }

      // Tertiary: if both did it recently, prefer the one who did it longest ago
      if (aDidRecently && bDidRecently) {
        const aDate =
          guestHistoryDates.get(a.id)?.get(chore.id) ?? new Date(0);
        const bDate =
          guestHistoryDates.get(b.id)?.get(chore.id) ?? new Date(0);
        return aDate.getTime() - bDate.getTime(); // earlier date = preferred
      }

      // Stable tie-breaker by guest ID for deterministic ordering
      return a.id.localeCompare(b.id);
    });

    /**
     * Family grouping helper: after picking the first guest, re-sort remaining
     * candidates to prefer same-booking guests (secondary to fairness).
     */
    function familySortRemaining(
      remaining: GuestInput[],
      firstBookingId: string
    ): GuestInput[] {
      return [...remaining].sort((a, b) => {
        // Primary: fewest total assignments (preserve fairness)
        const countDiff =
          (assignmentCount.get(a.id) ?? 0) - (assignmentCount.get(b.id) ?? 0);
        if (countDiff !== 0) return countDiff;

        // Secondary: prefer same booking as first picked guest
        const aFamily = a.bookingId === firstBookingId ? 0 : 1;
        const bFamily = b.bookingId === firstBookingId ? 0 : 1;
        if (aFamily !== bFamily) return aFamily - bFamily;

        return a.id.localeCompare(b.id);
      });
    }

    // For MIXED_PREFERRED, try to interleave adults and children/youth
    // with family grouping preference
    const assigned: GuestInput[] = [];
    if (
      chore.ageRestriction === "MIXED_PREFERRED" &&
      needed >= 2
    ) {
      const adults = sorted.filter((g) => g.ageTier === "ADULT");
      const nonAdults = sorted.filter((g) => g.ageTier !== "ADULT");

      // Pick first adult
      if (adults.length > 0) {
        assigned.push(adults[0]);
        // Prefer non-adults from same booking as first adult
        const familyNonAdults = familySortRemaining(nonAdults, adults[0].bookingId);
        const familyAdults = adults.slice(1);

        let ni = 0;
        let ai = 0;
        let pickNonAdult = true;
        while (assigned.length < needed && (ni < familyNonAdults.length || ai < familyAdults.length)) {
          if (pickNonAdult && ni < familyNonAdults.length) {
            assigned.push(familyNonAdults[ni++]);
          } else if (!pickNonAdult && ai < familyAdults.length) {
            assigned.push(familyAdults[ai++]);
          } else if (ni < familyNonAdults.length) {
            assigned.push(familyNonAdults[ni++]);
          } else if (ai < familyAdults.length) {
            assigned.push(familyAdults[ai++]);
          }
          pickNonAdult = !pickNonAdult;
        }
      } else {
        // No adults, just fill from non-adults
        for (const g of nonAdults) {
          if (assigned.length >= needed) break;
          assigned.push(g);
        }
      }
    } else if (chore.ageRestriction === "ADULT_SUPERVISED") {
      // Ensure at least one adult is included, prefer same-booking members
      const adults = sorted.filter((g) => g.ageTier === "ADULT");

      if (adults.length > 0) {
        assigned.push(adults[0]);
        // Fill remaining slots preferring same booking
        const remaining = sorted.filter((g) => g.id !== adults[0].id);
        const familyRemaining = familySortRemaining(remaining, adults[0].bookingId);
        for (const g of familyRemaining) {
          if (assigned.length >= needed) break;
          assigned.push(g);
        }
      } else {
        // No adults available - assign the most senior guests
        for (const g of sorted) {
          if (assigned.length >= needed) break;
          assigned.push(g);
        }
      }
    } else {
      // ANY or ADULTS_ONLY - take first, then prefer family for remaining slots
      if (needed >= 2 && sorted.length >= 2) {
        assigned.push(sorted[0]);
        const remaining = familySortRemaining(
          sorted.slice(1),
          sorted[0].bookingId
        );
        for (const g of remaining) {
          if (assigned.length >= needed) break;
          assigned.push(g);
        }
      } else {
        for (const g of sorted) {
          if (assigned.length >= needed) break;
          assigned.push(g);
        }
      }
    }

    // Record allocations and update counts
    for (const guest of assigned) {
      allocations.push({
        choreTemplateId: chore.id,
        bookingGuestId: guest.id,
        bookingId: guest.bookingId,
      });
      assignmentCount.set(guest.id, (assignmentCount.get(guest.id) ?? 0) + 1);
    }
  }

  return allocations;
}
