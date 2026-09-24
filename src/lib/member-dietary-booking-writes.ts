/**
 * The WRITE half of the booking-guest dietary/allergy boundary (#3029,
 * `INV-MOD-059`, `INV-PRIV-022`).
 *
 * `src/lib/member-dietary.ts` is the one door through which a PERSON reads a
 * dietary value, for a caller holding a grant. This file is the same boundary's
 * other half, split out only to keep that door inside its size budget: it
 * decides what a booking guest row carries when it is created or rewritten, and
 * it is the only other file allowed to name the column. It mints no grant and
 * returns no value to anybody — a writer hands identities in and spreads opaque
 * decisions out, so no booking writer ever holds a value in readable form. The
 * census (`member-dietary-access-census.test.ts`) confines who imports it, and
 * refuses a booking writer that reaches for a grant or reader.
 *
 * No function here calls `auth()`: scheduled code (the waitlist cron) reaches
 * it. `import "server-only"` for the same reason as the door.
 */
import "server-only";

import type { AgeTier, Prisma } from "@prisma/client";
import { isDietaryFieldEnabled } from "@/lib/member-dietary";

type BookingGuestDb = Pick<Prisma.TransactionClient, "bookingGuest">;
type ProfileDb = Pick<Prisma.TransactionClient, "member">;

declare const SEEDING_BRAND: unique symbol;

/**
 * Whether new linked-member guest rows are seeded from the profile: the field
 * toggle, read BEFORE the booking transaction opens and passed in as a value
 * (`INV-LOCK-004`) — a settings read under the capacity lock would take a second
 * pooled connection. REQUIRED by every booking create, request, modify and
 * add-guest pipeline, so a pipeline that forgot it does not compile.
 */
export interface BookingGuestDietarySeeding {
  readonly [SEEDING_BRAND]: true;
  readonly seedFromProfile: boolean;
}

export function bookingGuestDietarySeeding(enabled: boolean): BookingGuestDietarySeeding {
  return Object.freeze({ seedFromProfile: enabled }) as BookingGuestDietarySeeding;
}

/** Read the toggle (outside any transaction) and return the seeding value. */
export async function resolveBookingGuestDietarySeeding(): Promise<BookingGuestDietarySeeding> {
  return bookingGuestDietarySeeding(await isDietaryFieldEnabled());
}

declare const CARRY_BRAND: unique symbol;

/**
 * An existing guest row's stored value, captured before that row is replaced,
 * so the replacement row carries it as it is — null included, and even while
 * the field is OFF (carrying preserves; it never seeds). Opaque: the value
 * lives in a module-private map, so the writer holding a carry cannot read it.
 */
export interface CarriedBookingGuestDietary {
  readonly [CARRY_BRAND]: true;
}

const CARRIED_VALUES = new WeakMap<object, string | null>();

function mintCarry(value: string | null): CarriedBookingGuestDietary {
  const carry = Object.freeze({}) as CarriedBookingGuestDietary;
  CARRIED_VALUES.set(carry, value);
  return carry;
}

/** Capture the stored values of the named guest rows, keyed by guest id. */
export async function captureBookingGuestDietaryCarries(
  db: BookingGuestDb,
  guestIds: readonly string[],
): Promise<Map<string, CarriedBookingGuestDietary>> {
  const result = new Map<string, CarriedBookingGuestDietary>();
  if (guestIds.length === 0) return result;
  const rows = await db.bookingGuest.findMany({
    where: { id: { in: [...new Set(guestIds)] } },
    select: { id: true, dietaryRequirements: true },
  });
  for (const row of rows) result.set(row.id, mintCarry(row.dietaryRequirements ?? null));
  return result;
}

declare const WRITE_BRAND: unique symbol;

/** What one new guest row carries, decided by {@link resolveBookingGuestDietary}. */
export interface BookingGuestDietaryWrite {
  readonly [WRITE_BRAND]: true;
}

const WRITE_VALUES = new WeakMap<object, string | null>();

function mintWrite(value: string | null): BookingGuestDietaryWrite {
  const write = Object.freeze({}) as BookingGuestDietaryWrite;
  WRITE_VALUES.set(write, value);
  return write;
}

/** The person a new guest row is for, as far as seeding is concerned. */
export type BookingGuestDietarySubject = {
  memberId?: string | null;
  carriedDietary?: CarriedBookingGuestDietary;
};

async function readProfileValues(
  db: ProfileDb,
  memberIds: readonly string[],
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (memberIds.length === 0) return result;
  // One indexed read through the caller's transaction client (`INV-LOCK-004`).
  const rows = await db.member.findMany({
    where: { id: { in: [...new Set(memberIds)] } },
    select: { id: true, dietaryRequirements: true },
  });
  for (const row of rows) result.set(row.id, row.dietaryRequirements ?? null);
  return result;
}

/**
 * Decide what each NEW guest row carries, in input order (`INV-MOD-059`):
 *  - a carried value, as it is (null included), whatever the toggle says;
 *  - otherwise, while seeding is ON, a linked member's CURRENT profile value;
 *  - otherwise nothing (a non-member, or seeding OFF).
 * Runs inside the caller's booking transaction, through its client.
 */
export async function resolveBookingGuestDietary(
  db: ProfileDb,
  seeding: BookingGuestDietarySeeding,
  guests: readonly BookingGuestDietarySubject[],
): Promise<BookingGuestDietaryWrite[]> {
  const toSeed = seeding.seedFromProfile
    ? guests.flatMap((guest) =>
        !guest.carriedDietary && guest.memberId ? [guest.memberId] : [],
      )
    : [];
  const profiles = await readProfileValues(db, toSeed);
  return guests.map((guest) => {
    if (guest.carriedDietary) {
      const carried = CARRIED_VALUES.get(guest.carriedDietary);
      if (carried === undefined) {
        throw new Error("A carried booking dietary value must come from captureBookingGuestDietaryCarries");
      }
      return mintWrite(carried);
    }
    if (seeding.seedFromProfile && guest.memberId) {
      return mintWrite(profiles.get(guest.memberId) ?? null);
    }
    return mintWrite(null);
  });
}

/**
 * The create-data fragment for one new guest row. An empty value writes no key
 * at all (the column defaults to NULL), so every create payload that carries
 * nothing is byte-identical to one written before the column existed.
 */
export function bookingGuestDietaryCreateData(
  write: BookingGuestDietaryWrite | undefined,
): { dietaryRequirements?: string } {
  const value = write ? WRITE_VALUES.get(write) : undefined;
  if (value === undefined) {
    throw new Error(
      "A new booking guest row needs a dietary decision from resolveBookingGuestDietary (INV-MOD-059)",
    );
  }
  return value === null ? {} : { dietaryRequirements: value };
}

/** The identity a held-party planner matches on. */
export type BookingGuestDietaryIdentity = {
  memberId?: string | null;
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
};

function nonMemberIdentityKey(guest: BookingGuestDietaryIdentity): string {
  return JSON.stringify([guest.firstName, guest.lastName, guest.ageTier]);
}

function countKeys<T>(items: readonly T[], keyOf: (item: T) => string | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

const memberKey = (guest: BookingGuestDietaryIdentity) =>
  guest.memberId ? `m:${guest.memberId}` : null;
const nonMemberKey = (guest: BookingGuestDietaryIdentity) =>
  guest.memberId ? null : `n:${nonMemberIdentityKey(guest)}`;

/**
 * A held party DELETED AND RECREATED at approval (the head-count differs; W13).
 * Call BEFORE the delete. A new row carries an old row's value only when they
 * are unambiguously the same person: the same member id, or for a non-member
 * the same first name, last name and age tier — and that key unique on BOTH
 * sides. Never by position: two lists of different lengths do not line up, and
 * lining them up is how one person's allergy lands on somebody else. Anybody
 * not matched is seeded (or left empty) as a new guest.
 */
export async function planHeldPartyRebuildDietary(
  db: ProfileDb & BookingGuestDb,
  seeding: BookingGuestDietarySeeding,
  bookingId: string,
  incoming: readonly BookingGuestDietaryIdentity[],
): Promise<BookingGuestDietaryWrite[]> {
  const existing = await db.bookingGuest.findMany({
    where: { bookingId },
    select: {
      memberId: true,
      firstName: true,
      lastName: true,
      ageTier: true,
      dietaryRequirements: true,
    },
  });
  const keyOf = (guest: BookingGuestDietaryIdentity) => memberKey(guest) ?? nonMemberKey(guest);
  const oldCounts = countKeys(existing, keyOf);
  const newCounts = countKeys(incoming, keyOf);
  const oldByKey = new Map(existing.map((row) => [keyOf(row), row]));
  const subjects = incoming.map((guest): BookingGuestDietarySubject => {
    const key = keyOf(guest);
    const old = key !== null && oldCounts.get(key) === 1 && newCounts.get(key) === 1
      ? oldByKey.get(key)
      : undefined;
    return old
      ? { memberId: guest.memberId, carriedDietary: mintCarry(old.dietaryRequirements ?? null) }
      : { memberId: guest.memberId };
  });
  return resolveBookingGuestDietary(db, seeding, subjects);
}

declare const UPDATE_BRAND: unique symbol;

/** What one REWRITTEN guest row does with its value (W14). */
export interface BookingGuestDietaryUpdate {
  readonly [UPDATE_BRAND]: true;
}

const UNTOUCHED = Symbol("untouched");
const UPDATE_VALUES = new WeakMap<object, string | null | typeof UNTOUCHED>();

function mintUpdate(value: string | null | typeof UNTOUCHED): BookingGuestDietaryUpdate {
  const update = Object.freeze({}) as BookingGuestDietaryUpdate;
  UPDATE_VALUES.set(update, value);
  return update;
}

function isSameOccupant(
  previous: BookingGuestDietaryIdentity,
  next: BookingGuestDietaryIdentity,
): boolean {
  if (previous.memberId) return (next.memberId ?? null) === previous.memberId;
  return !next.memberId && nonMemberIdentityKey(previous) === nonMemberIdentityKey(next);
}

/**
 * A held party whose rows are REWRITTEN IN PLACE at approval, paired by
 * position (W14). Pairing by position is the existing rule for identity, price
 * and nights; this refuses to let it carry one person's value onto another:
 *  - the same person still on the row (same member, or the same non-member
 *    name and age tier): the value is left exactly as it is;
 *  - a different member now on the row: seeded from THAT member's profile
 *    while seeding is ON, otherwise cleared;
 *  - the row has become somebody who is not a member: cleared.
 */
export async function planHeldPartyRewriteDietary(
  db: ProfileDb,
  seeding: BookingGuestDietarySeeding,
  pairs: readonly {
    previous: BookingGuestDietaryIdentity;
    next: BookingGuestDietaryIdentity;
  }[],
): Promise<BookingGuestDietaryUpdate[]> {
  const toSeed = seeding.seedFromProfile
    ? pairs.flatMap(({ previous, next }) =>
        !isSameOccupant(previous, next) && next.memberId ? [next.memberId] : [],
      )
    : [];
  const profiles = await readProfileValues(db, toSeed);
  return pairs.map(({ previous, next }) => {
    if (isSameOccupant(previous, next)) return mintUpdate(UNTOUCHED);
    if (seeding.seedFromProfile && next.memberId) {
      return mintUpdate(profiles.get(next.memberId) ?? null);
    }
    return mintUpdate(null);
  });
}

/** The update-data fragment for one rewritten row: nothing, or the new value. */
export function bookingGuestDietaryUpdateData(
  update: BookingGuestDietaryUpdate | undefined,
): { dietaryRequirements?: string | null } {
  const value = update ? UPDATE_VALUES.get(update) : undefined;
  if (value === undefined) {
    throw new Error(
      "A rewritten booking guest row needs a dietary decision from planHeldPartyRewriteDietary (INV-MOD-059)",
    );
  }
  return value === UNTOUCHED ? {} : { dietaryRequirements: value };
}

/**
 * A placeholder guest later linked to a member (W15). That is the moment the
 * row first becomes a linked-member guest, so it is seeded from the linked
 * profile — but ONLY if it holds no value yet (an admin's entry is kept) and
 * only while seeding is ON. The null check is in the update's own WHERE, so a
 * value written concurrently is never overwritten.
 */
export async function fillBookingGuestDietaryFromProfileIfEmpty(
  db: ProfileDb & BookingGuestDb,
  seeding: BookingGuestDietarySeeding,
  links: readonly { guestId: string; memberId: string }[],
): Promise<void> {
  if (!seeding.seedFromProfile || links.length === 0) return;
  const profiles = await readProfileValues(
    db,
    links.map((link) => link.memberId),
  );
  for (const link of links) {
    const value = profiles.get(link.memberId) ?? null;
    if (value === null) continue;
    await db.bookingGuest.updateMany({
      where: { id: link.guestId, dietaryRequirements: null },
      data: { dietaryRequirements: value },
    });
  }
}
