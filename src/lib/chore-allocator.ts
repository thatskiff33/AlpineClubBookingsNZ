/**
 * Chore Roster Auto-Suggest Algorithm
 *
 * Allocates guests to chores for a given date, respecting age restrictions,
 * chore history (4-day lookback), and round-robin fairness.
 */

import { AgeTier, AgeRestriction } from "@prisma/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChoreTemplateInput {
  id: string;
  name: string;
  recommendedPeopleMin: number;
  recommendedPeopleMax: number;
  isEssential: boolean;
  ageRestriction: AgeRestriction;
  minAge: number;
  sortOrder: number;
}

export interface GuestInput {
  id: string;
  bookingId: string;
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
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

const FULL_LODGE_CAPACITY = 29;
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
    case "CHILD":
      return 0;
  }
}

/** Check if a guest meets the minimum age for a chore */
export function meetsMinAge(guestAgeTier: AgeTier, minAge: number): boolean {
  return ageForTier(guestAgeTier) >= minAge;
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
  capacity: number = FULL_LODGE_CAPACITY
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
// Main Allocation Algorithm
// ---------------------------------------------------------------------------

export function allocateChores(
  chores: ChoreTemplateInput[],
  guests: GuestInput[],
  history: ChoreHistoryEntry[],
  options: {
    includeNonEssential?: boolean;
    highOccupancyThreshold?: number;
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

    // Find eligible guests for this chore
    const eligible = guests.filter((g) =>
      isEligibleForChore(g.ageTier, chore)
    );

    if (eligible.length === 0) continue;

    // Sort eligible guests by: fewest assignments first, then prefer those
    // who haven't done this chore recently
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

    // For MIXED_PREFERRED, try to interleave adults and children/youth
    const assigned: GuestInput[] = [];
    if (
      chore.ageRestriction === "MIXED_PREFERRED" &&
      needed >= 2
    ) {
      const adults = sorted.filter((g) => g.ageTier === "ADULT");
      const nonAdults = sorted.filter((g) => g.ageTier !== "ADULT");

      // Alternate: adult, non-adult, adult, non-adult...
      let ai = 0,
        ni = 0;
      let pickAdult = true;
      while (assigned.length < needed && (ai < adults.length || ni < nonAdults.length)) {
        if (pickAdult && ai < adults.length) {
          assigned.push(adults[ai++]);
        } else if (!pickAdult && ni < nonAdults.length) {
          assigned.push(nonAdults[ni++]);
        } else if (ai < adults.length) {
          assigned.push(adults[ai++]);
        } else if (ni < nonAdults.length) {
          assigned.push(nonAdults[ni++]);
        }
        pickAdult = !pickAdult;
      }
    } else if (chore.ageRestriction === "ADULT_SUPERVISED") {
      // Ensure at least one adult is included
      const adults = sorted.filter((g) => g.ageTier === "ADULT");
      const others = sorted.filter((g) => g.ageTier !== "ADULT");

      if (adults.length > 0) {
        assigned.push(adults[0]);
        // Fill remaining slots from combined pool (excluding the assigned adult)
        const remaining = sorted.filter((g) => g.id !== adults[0].id);
        for (const g of remaining) {
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
      // ANY or ADULTS_ONLY - just take from sorted list
      for (const g of sorted) {
        if (assigned.length >= needed) break;
        assigned.push(g);
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
