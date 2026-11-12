// ---------------------------------------------------------------------------
// LOAD VOLUME PLAN — the pure half of `prisma/load-volume-seed.ts` (#4940).
//
// Decides, without touching a database, which members exist and which past
// bookings they made, so the seeder only has to write the plan out. Kept pure so
// `src/lib/__tests__/load-volume-plan.test.ts` can prove the properties a load
// run relies on: no night ever holds more guests than its lodge's capacity, no
// member sleeps in two places on one night, every night is strictly before
// today, and the same seed always yields the same history.
//
// Dates are club calendar days (`CalendarDate`, `INV-DATE`); the caller passes
// the club's today, so nothing here reads a clock.
// ---------------------------------------------------------------------------
import {
  addCalendarDays,
  addCalendarMonths,
  compareCalendarDates,
  countClubNights,
  eachCalendarDate,
  type CalendarDate,
} from "../src/lib/club-time";

import { volumeMemberLocal } from "../load/lib/volume-users.js";

export { LOAD_VOLUME_EMAIL_PREFIX } from "../load/lib/volume-users.js";

export interface LoadVolumeLodge {
  readonly id: string;
  readonly capacity: number;
  /** The lodge's current seasons; past seasons are these shifted back whole years. */
  readonly seasons: ReadonlyArray<{ start: CalendarDate; endExclusive: CalendarDate }>;
  /** Guests already holding each night (any status), so the plan stays under capacity. */
  readonly occupied: ReadonlyMap<CalendarDate, number>;
}

export interface LoadVolumeOptions {
  readonly seed: number;
  readonly memberCount: number;
  readonly seasonsBack: number;
  readonly today: CalendarDate;
  readonly lodges: readonly LoadVolumeLodge[];
  /** Share of each night's free beds the plan tries to fill, 0..1. */
  readonly targetOccupancy: number;
  readonly maxNights: number;
  readonly maxPartySize: number;
  /** Share of bookings that end cancelled with a refund or credit, 0..1. */
  readonly cancelRate: number;
  /** Share of bookings paid by Internet Banking rather than card, 0..1. */
  readonly internetBankingRate: number;
}

export const LOAD_VOLUME_DEFAULTS = {
  seed: 4940,
  memberCount: 2000,
  seasonsBack: 5,
  targetOccupancy: 0.6,
  maxNights: 4,
  maxPartySize: 4,
  cancelRate: 0.12,
  internetBankingRate: 0.35,
} as const;

export type LoadVolumeGuest =
  | { readonly kind: "member"; readonly memberIndex: number }
  | { readonly kind: "guest"; readonly firstName: string; readonly lastName: string; readonly ageTier: "ADULT" | "YOUTH" | "CHILD" };

export interface LoadVolumeBooking {
  readonly index: number;
  readonly lodgeId: string;
  readonly ownerIndex: number;
  readonly checkIn: CalendarDate;
  readonly checkOut: CalendarDate;
  readonly guests: readonly LoadVolumeGuest[];
  readonly outcome: "COMPLETED" | "CANCELLED";
  readonly paymentSource: "STRIPE" | "INTERNET_BANKING";
  /** CANCELLED only: a card refund, or account credit (always credit for Internet Banking). */
  readonly cancellationSettlement: "STRIPE_REFUND" | "CREDIT" | null;
}

export interface LoadVolumeMember {
  readonly index: number;
  readonly local: string;
  readonly firstName: string;
  readonly lastName: string;
}

export interface LoadVolumePlan {
  readonly members: readonly LoadVolumeMember[];
  readonly bookings: readonly LoadVolumeBooking[];
}

const FIRST_NAMES = ["Aroha", "Ben", "Chloe", "Daniel", "Ella", "Finn", "Grace", "Hemi", "Isla", "Jack", "Kiri", "Liam", "Mia", "Noah", "Olivia", "Rangi", "Sophie", "Tama", "Zoe", "Wiremu"];
const LAST_NAMES = ["Anderson", "Brown", "Campbell", "Davies", "Edwards", "Fraser", "Gray", "Harris", "Ngata", "Parata", "Robinson", "Smith", "Taylor", "Walker", "Wilson", "Young"];

// mulberry32: a small, well-mixed 32-bit PRNG, so one seed reproduces one plan.
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error("load volume plan: pick from an empty list");
  return item;
}

function requireShare(name: string, value: number) {
  if (!(value >= 0 && value <= 1)) throw new Error(`load volume plan: ${name} must be between 0 and 1`);
}

function requirePositiveInt(name: string, value: number) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`load volume plan: ${name} must be a positive integer`);
}

/**
 * The past seasons the plan books into: each current season shifted back 1..N
 * whole years, clipped so the last night is strictly before `today`.
 */
export function pastSeasonWindows(
  seasons: LoadVolumeLodge["seasons"],
  seasonsBack: number,
  today: CalendarDate,
): Array<{ start: CalendarDate; endExclusive: CalendarDate }> {
  const windows: Array<{ start: CalendarDate; endExclusive: CalendarDate }> = [];
  for (let back = 1; back <= seasonsBack; back += 1) {
    for (const season of seasons) {
      const start = addCalendarMonths(season.start, -12 * back);
      const shiftedEnd = addCalendarMonths(season.endExclusive, -12 * back);
      const endExclusive = compareCalendarDates(shiftedEnd, today) > 0 ? today : shiftedEnd;
      if (compareCalendarDates(start, endExclusive) < 0) windows.push({ start, endExclusive });
    }
  }
  return windows.sort((a, b) => compareCalendarDates(a.start, b.start));
}

export function planLoadVolume(options: LoadVolumeOptions): LoadVolumePlan {
  requirePositiveInt("memberCount", options.memberCount);
  requirePositiveInt("seasonsBack", options.seasonsBack);
  requirePositiveInt("maxNights", options.maxNights);
  requirePositiveInt("maxPartySize", options.maxPartySize);
  requireShare("targetOccupancy", options.targetOccupancy);
  requireShare("cancelRate", options.cancelRate);
  requireShare("internetBankingRate", options.internetBankingRate);

  const random = prng(options.seed);
  const members: LoadVolumeMember[] = Array.from({ length: options.memberCount }, (_, index) => ({
    index,
    local: volumeMemberLocal(index),
    firstName: pick(random, FIRST_NAMES),
    lastName: pick(random, LAST_NAMES),
  }));

  // Nights each member already sleeps somewhere, across every lodge.
  const memberNights = new Map<number, Set<CalendarDate>>();
  const memberFree = (memberIndex: number, nights: readonly CalendarDate[]) => {
    const taken = memberNights.get(memberIndex);
    return !taken || nights.every((night) => !taken.has(night));
  };
  const claimMember = (memberIndex: number, nights: readonly CalendarDate[]) => {
    const taken = memberNights.get(memberIndex) ?? new Set<CalendarDate>();
    for (const night of nights) taken.add(night);
    memberNights.set(memberIndex, taken);
  };

  const bookings: LoadVolumeBooking[] = [];
  const meanParty = (1 + options.maxPartySize) / 2;
  const meanNights = (1 + options.maxNights) / 2;

  for (const lodge of options.lodges) {
    const used = new Map<CalendarDate, number>();
    const held = (night: CalendarDate) => (lodge.occupied.get(night) ?? 0) + (used.get(night) ?? 0);

    for (const window of pastSeasonWindows(lodge.seasons, options.seasonsBack, options.today)) {
      const windowNights = countClubNights(window.start, window.endExclusive);
      const freeGuestNights = eachCalendarDate(window.start, window.endExclusive).reduce(
        (sum, night) => sum + Math.max(0, lodge.capacity - (lodge.occupied.get(night) ?? 0)),
        0,
      );
      const attempts = Math.ceil((freeGuestNights * options.targetOccupancy) / (meanParty * meanNights));

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const length = Math.min(windowNights, 1 + Math.floor(random() * options.maxNights));
        const checkIn = addCalendarDays(window.start, Math.floor(random() * (windowNights - length + 1)));
        const checkOut = addCalendarDays(checkIn, length);
        const nights = eachCalendarDate(checkIn, checkOut);
        const partySize = 1 + Math.floor(random() * options.maxPartySize);

        // Every night must have room for the whole party, counting what is
        // already there; a party that does not fit is simply not booked.
        if (nights.some((night) => held(night) + partySize > lodge.capacity)) continue;

        const ownerIndex = Math.floor(random() * options.memberCount);
        if (!memberFree(ownerIndex, nights)) continue;

        const guests: LoadVolumeGuest[] = [{ kind: "member", memberIndex: ownerIndex }];
        const partyMembers = new Set([ownerIndex]);
        while (guests.length < partySize) {
          const candidate = Math.floor(random() * options.memberCount);
          if (random() < 0.5 && !partyMembers.has(candidate) && memberFree(candidate, nights)) {
            partyMembers.add(candidate);
            guests.push({ kind: "member", memberIndex: candidate });
          } else {
            guests.push({
              kind: "guest",
              firstName: pick(random, FIRST_NAMES),
              lastName: pick(random, LAST_NAMES),
              ageTier: pick(random, ["ADULT", "ADULT", "YOUTH", "CHILD"] as const),
            });
          }
        }

        for (const memberIndex of partyMembers) claimMember(memberIndex, nights);
        for (const night of nights) used.set(night, (used.get(night) ?? 0) + partySize);

        const paymentSource = random() < options.internetBankingRate ? "INTERNET_BANKING" : "STRIPE";
        const cancelled = random() < options.cancelRate;
        bookings.push({
          index: bookings.length,
          lodgeId: lodge.id,
          ownerIndex,
          checkIn,
          checkOut,
          guests,
          outcome: cancelled ? "CANCELLED" : "COMPLETED",
          paymentSource,
          cancellationSettlement: !cancelled
            ? null
            : paymentSource === "STRIPE" && random() < 0.5
              ? "STRIPE_REFUND"
              : "CREDIT",
        });
      }
    }
  }

  return { members, bookings };
}
