/**
 * The WRITE half of the booking-guest dietary/allergy boundary (#3029,
 * `INV-MOD-059`, `INV-PRIV-022`).
 *
 * `src/lib/member-dietary.ts` is the one door through which a PERSON reads a
 * dietary value, for a caller holding a grant. This file is the same boundary's
 * other half, split out only to keep that door inside its size budget: it
 * decides what a booking guest row carries when it is created or rewritten, and
 * it is the only other file allowed to name the column. It mints no grant.
 *
 * HOW STRONG THE FENCE IS, stated exactly. A writer hands identities in and gets
 * opaque decisions back, but the fragment builders
 * ({@link bookingGuestDietaryCreateData}, {@link bookingGuestDietaryUpdateData})
 * necessarily return the plain value for Prisma to write. So the real fence is
 * WHO may import this file: `member-dietary-access-census.test.ts` confines that
 * to a closed list of booking writers, refuses any of them naming a grant or
 * reader, allows the two builders only as the operand of a `...` spread,
 * refuses renaming anything imported from here, and confines the seeding
 * constructor to this file. It is a text scan: a listed
 * writer that spread a fragment into an object it then logged would stay green.
 * Carries are scoped to the booking they are read from, which stops an
 * ACCIDENTAL cross-booking capture; it does not stop a listed writer that
 * deliberately passes another booking's id. The importer list plus review is
 * the fence.
 *
 * No function here calls `auth()`: scheduled code (the waitlist cron) reaches
 * it. `import "server-only"` for the same reason as the door.
 */
import "server-only";

import type { AgeTier, Prisma } from "@prisma/client";
import {
  lockBookingGuestRowsForUpdate,
  type BookingGuestRowLockDb,
} from "@/lib/booking-guest-row-lock";
import { isLikelyTypoCorrection } from "@/lib/guest-name-similarity";
import { isDietaryFieldEnabled } from "@/lib/member-dietary";
import { isPlaceholderGuestName } from "@/lib/placeholder-guest-names";

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

/**
 * Exported for tests only: the census refuses a call anywhere else in the
 * application, so production seeding always comes from the toggle below.
 */
export function bookingGuestDietarySeeding(enabled: boolean): BookingGuestDietarySeeding {
  return Object.freeze({ seedFromProfile: enabled }) as BookingGuestDietarySeeding;
}

/** Read the toggle (outside any transaction) and return the seeding value. */
export async function resolveBookingGuestDietarySeeding(): Promise<BookingGuestDietarySeeding> {
  return bookingGuestDietarySeeding(await isDietaryFieldEnabled());
}

/**
 * S5 (coordinator decision): a member whose consent to be on the booking is
 * still PENDING has not agreed to be there, so their profile's health data is
 * not copied onto the row. The consent grant fills it later, if still empty.
 */
type ConsentShape = { memberGuestConsent?: { consentStatus: string | null } | null };
const consentPending = (guest: ConsentShape) =>
  guest.memberGuestConsent?.consentStatus === "PENDING";

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

/**
 * Capture the stored values of the named guest rows OF ONE BOOKING, keyed by
 * guest id. A guest id from any other booking matches nothing (S3).
 */
export async function captureBookingGuestDietaryCarries(
  db: BookingGuestDb,
  sourceBookingId: string,
  guestIds: readonly string[],
): Promise<Map<string, CarriedBookingGuestDietary>> {
  const result = new Map<string, CarriedBookingGuestDietary>();
  if (guestIds.length === 0) return result;
  const rows = await db.bookingGuest.findMany({
    where: { id: { in: [...new Set(guestIds)] }, bookingId: sourceBookingId },
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
export type BookingGuestDietarySubject = ConsentShape & {
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
 *  - otherwise, while seeding is ON, a linked member's CURRENT profile value —
 *    unless their consent to be on the booking is still PENDING (S5);
 *  - otherwise nothing (a non-member, seeding OFF, or consent pending).
 * Runs inside the caller's booking transaction, through its client.
 */
export async function resolveBookingGuestDietary(
  db: ProfileDb,
  seeding: BookingGuestDietarySeeding,
  guests: readonly BookingGuestDietarySubject[],
): Promise<BookingGuestDietaryWrite[]> {
  const seeds = (guest: BookingGuestDietarySubject) =>
    seeding.seedFromProfile && !guest.carriedDietary && !consentPending(guest) && guest.memberId
      ? guest.memberId
      : null;
  const profiles = await readProfileValues(
    db,
    guests.flatMap((guest) => seeds(guest) ?? []),
  );
  return guests.map((guest) => {
    if (guest.carriedDietary) {
      const carried = CARRIED_VALUES.get(guest.carriedDietary);
      if (carried === undefined) {
        throw new Error("A carried booking dietary value must come from captureBookingGuestDietaryCarries");
      }
      return mintWrite(carried);
    }
    const memberId = seeds(guest);
    return mintWrite(memberId ? (profiles.get(memberId) ?? null) : null);
  });
}

/**
 * The create-data fragment for one new guest row, to be SPREAD into the Prisma
 * create and nowhere else (the census holds that). An empty value writes no key
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

/** The identity a planner matches on. */
export type BookingGuestDietaryIdentity = ConsentShape & {
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
 * Call BEFORE the delete: it first locks the party's rows `FOR UPDATE` (C3), so
 * an admin edit committing between this read and the delete is either captured
 * here or waits and then finds its row gone — never silently lost. A new row
 * carries an old row's value only when they are unambiguously the same person:
 * the same member id, or for a non-member the same first name, last name and age
 * tier — and that key unique on BOTH sides. Never by position. Anybody not
 * matched is seeded (or left empty) as a new guest.
 */
export async function planHeldPartyRebuildDietary(
  db: ProfileDb & BookingGuestDb & BookingGuestRowLockDb,
  seeding: BookingGuestDietarySeeding,
  bookingId: string,
  incoming: readonly BookingGuestDietaryIdentity[],
): Promise<BookingGuestDietaryWrite[]> {
  await lockBookingGuestRowsForUpdate(db, bookingId);
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
    const base = { memberId: guest.memberId, memberGuestConsent: guest.memberGuestConsent };
    return old ? { ...base, carriedDietary: mintCarry(old.dietaryRequirements ?? null) } : base;
  });
  return resolveBookingGuestDietary(db, seeding, subjects);
}

declare const UPDATE_BRAND: unique symbol;

/** What one REWRITTEN guest row does with its value (W14, a rename). */
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

type OccupantIdentity = Omit<BookingGuestDietaryIdentity, "memberGuestConsent">;

/**
 * THE one same-occupant rule (S2, `INV-SSOT`): is the row still the same person
 * after it is rewritten or renamed? The held-party rewrite (W14) and a
 * non-member rename on a modification both ask it, so they cannot disagree.
 *  - a member row: the same member id, and nothing else;
 *  - a non-member row becoming a member: a different person (the caller decides
 *    what that does to the value — see W14's non-member-to-member rule);
 *  - a non-member row: the same person when a generated placeholder is being
 *    named, or the name is the same or an unambiguous spelling correction of it
 *    at the same age tier. Anything that could be somebody else is not.
 */
export function isSameBookingGuestOccupant(
  previous: OccupantIdentity,
  next: OccupantIdentity,
): boolean {
  if (previous.memberId) return (next.memberId ?? null) === previous.memberId;
  if (next.memberId) return false;
  return nonMemberNameIsSamePerson(previous, next);
}

/**
 * The non-member half of {@link isSameBookingGuestOccupant}, with membership
 * ignored: a generated placeholder being named, or the same name or an
 * unambiguous spelling correction at the same age tier. The one place this
 * judgement is written — the rename path, W14's same-occupant check and its
 * non-member-to-member keep (N1) all reach it.
 */
function nonMemberNameIsSamePerson(previous: OccupantIdentity, next: OccupantIdentity): boolean {
  if (isPlaceholderGuestName({ ...previous, memberId: null })) return true;
  if (previous.ageTier !== next.ageTier) return false;
  if (nonMemberIdentityKey(previous) === nonMemberIdentityKey(next)) return true;
  return isLikelyTypoCorrection(previous.firstName, previous.lastName, next.firstName, next.lastName);
}

/**
 * A held party whose rows are REWRITTEN IN PLACE at approval, paired by
 * position (W14). Pairing by position is the existing rule for identity, price
 * and nights; this refuses to let it carry one person's value onto another:
 *  - the same person still on the row ({@link isSameBookingGuestOccupant}): left
 *    exactly as it is;
 *  - a non-member row that has become a member who is plausibly the SAME person
 *    (a placeholder being linked, or the same name or a spelling correction of
 *    it at the same age tier; L1/N1): a value already on the row is kept, an
 *    empty row is seeded. A member who is somebody else is a new occupant;
 *  - a different member now on the row: seeded from THAT member's profile while
 *    seeding is ON (and their consent is not pending), otherwise cleared;
 *  - the row has become a different non-member: cleared.
 */
export async function planHeldPartyRewriteDietary(
  db: ProfileDb & BookingGuestDb & BookingGuestRowLockDb,
  seeding: BookingGuestDietarySeeding,
  bookingId: string,
  pairs: readonly {
    previous: OccupantIdentity & { id: string };
    next: BookingGuestDietaryIdentity;
  }[],
): Promise<BookingGuestDietaryUpdate[]> {
  // F1: the rows are locked before their stored values are read, so an admin
  // edit committing between this read and the rewrite cannot be overwritten
  // unseen. The approval already holds the global and lodge keys, and the
  // rewrite's own UPDATEs take these row locks anyway.
  await lockBookingGuestRowsForUpdate(db, bookingId);
  const becomesSamePersonAsMember = ({ previous, next }: (typeof pairs)[number]) =>
    !previous.memberId && Boolean(next.memberId) && nonMemberNameIsSamePerson(previous, next);
  const stored = new Map<string, string | null>();
  const becoming = pairs.filter(becomesSamePersonAsMember).map(({ previous }) => previous.id);
  if (becoming.length > 0) {
    const rows = await db.bookingGuest.findMany({
      where: { id: { in: becoming } },
      select: { id: true, dietaryRequirements: true },
    });
    for (const row of rows) stored.set(row.id, row.dietaryRequirements ?? null);
  }
  const seeds = ({ previous, next }: (typeof pairs)[number]) =>
    seeding.seedFromProfile && next.memberId && !consentPending(next) &&
    !isSameBookingGuestOccupant(previous, next)
      ? next.memberId
      : null;
  const profiles = await readProfileValues(db, pairs.flatMap((pair) => seeds(pair) ?? []));
  return pairs.map((pair) => {
    if (isSameBookingGuestOccupant(pair.previous, pair.next)) return mintUpdate(UNTOUCHED);
    if (becomesSamePersonAsMember(pair) && stored.get(pair.previous.id)) {
      return mintUpdate(UNTOUCHED);
    }
    const memberId = seeds(pair);
    return mintUpdate(memberId ? (profiles.get(memberId) ?? null) : null);
  });
}

/**
 * A non-member guest RENAMED by a modification (S2). A spelling correction, or a
 * generated placeholder being named, is the same person and keeps the value;
 * any other rename is somebody else, and their predecessor's note is cleared.
 * Returns a decision for every guest id, UNTOUCHED where nothing was renamed.
 */
export function planGuestRenameDietary(
  renames: readonly {
    guestId: string;
    previous: OccupantIdentity;
    next: { firstName: string; lastName: string };
  }[],
): (guestId: string) => BookingGuestDietaryUpdate {
  const cleared = new Set(
    renames
      .filter(({ previous, next }) =>
        !isSameBookingGuestOccupant(previous, { ...previous, ...next }),
      )
      .map(({ guestId }) => guestId),
  );
  return (guestId) => mintUpdate(cleared.has(guestId) ? null : UNTOUCHED);
}

/**
 * The update-data fragment for one rewritten row, to be SPREAD into the Prisma
 * update and nowhere else: nothing, or the new value.
 */
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
 * A guest row that has just BECOME a linked member's — a placeholder linked to a
 * member (W15), or a member guest whose pending consent was just granted (S5).
 * That is the moment the row first belongs to that member, so it is filled from
 * their CURRENT profile — but ONLY if it holds no value yet (an admin's entry is
 * kept), only while seeding is ON, and never while the member's consent is
 * still pending. The null check is in the update's own WHERE, so a value
 * written concurrently is never overwritten.
 */
export async function fillBookingGuestDietaryFromProfileIfEmpty(
  db: ProfileDb & BookingGuestDb,
  seeding: BookingGuestDietarySeeding,
  links: readonly (ConsentShape & { guestId: string; memberId: string })[],
): Promise<void> {
  const eligible = links.filter((link) => !consentPending(link));
  if (!seeding.seedFromProfile || eligible.length === 0) return;
  const profiles = await readProfileValues(
    db,
    eligible.map((link) => link.memberId),
  );
  for (const link of eligible) {
    const value = profiles.get(link.memberId) ?? null;
    if (value === null) continue;
    // N3: matched on the member too, so a row rewritten in place for somebody
    // else between the caller's read and this write is never filled with this
    // member's note.
    await db.bookingGuest.updateMany({
      where: { id: link.guestId, memberId: link.memberId, dietaryRequirements: null },
      data: { dietaryRequirements: value },
    });
  }
}
