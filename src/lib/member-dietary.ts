/**
 * The ONE door to a member's stored dietary/allergy information (#2941,
 * `INV-PRIV-022`).
 *
 * `Member.dietaryRequirements` is special-category personal data, and some of
 * the people it describes are children. The primary Prisma client omits it from
 * every Member read by default (`src/lib/prisma-global-omit.ts`), so a broad
 * `findMany()`, a nested `include`, or the row an `update()` hands back never
 * carries it. This module is the only place allowed to opt back in, and it does
 * so only for a caller holding a {@link DietaryAccessGrant}.
 *
 * WHO MAY READ THE PROFILE VALUE (stage 1):
 *  - the subject themself, for their own profile and onboarding
 *    ({@link grantSelfDietaryAccess}), while the club has the field ON;
 *  - the subject's own full data export ({@link grantSelfDataExportDietaryAccess}),
 *    even while the field is OFF (owner decision, 20 Sep 2026 — self disclosure);
 *  - an admin holding `membership` access ({@link grantMembershipAdminDietaryAccess}),
 *    for the member editor, member CSV and member merge, while the field is ON.
 *
 * THE BOOKING VALUE (stage 2, #3029). `BookingGuest.dietaryRequirements` is the
 * same kind of data for one stay: a snapshot seeded once from the linked
 * member's profile when the guest row is first created, then independent
 * (`INV-MOD-059`). This module extends to it rather than a second one beside it:
 *  - an admin holding `bookings` access ({@link grantBookingAdminDietaryAccess}),
 *    to view (`bookings:view`) or edit (`bookings:edit`) a booking's values;
 *  - the kiosk's `admin` and `hut-leader` tiers ({@link grantKioskDietaryAccess}),
 *    for the guests operationally present that day at that lodge;
 *  - the subject's own data export, for rows where the guest IS the subject.
 * A booking grant never reads a profile value and a profile grant never reads a
 * booking value (the two record kinds below), and while the field is OFF only
 * the export grant is issued.
 *
 * THE WRITE SIDE for booking guests is this boundary's other half,
 * `src/lib/member-dietary-booking-writes.ts` (split out only for size): it
 * decides what a new or rewritten guest row carries and mints no grant.
 *
 * Everybody else is denied by construction rather than by a filter: a family
 * member, a member viewing their own booking, a shared screen, a roster, a
 * booking or finance export, Xero, Stripe, the analytics tag, a notification or
 * a log has no grant to present and no other way to select the column.
 * `member-dietary-access-census.test.ts` proves that no other file selects it,
 * overrides the omission, reads it through raw SQL or constructs an application
 * Prisma client without the omission.
 *
 * `import "server-only"`: this module must never reach a browser bundle.
 */
import "server-only";

import type { AgeTier, Prisma, PrismaClient } from "@prisma/client";
import { actorIsFullAdmin } from "@/lib/admin-account-guards";
import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { loadMemberFieldsFlags } from "@/lib/member-fields-settings";
import {
  DIETARY_REQUIREMENTS_TOO_LONG_MESSAGE,
  isDietaryRequirementsWithinLimit,
  normalizeDietaryRequirements,
} from "@/lib/member-dietary-field";
import { prisma } from "@/lib/prisma";
import { addDaysDateOnly } from "@/lib/date-only";
import type { KioskTier } from "@/lib/kiosk-access";

declare const DIETARY_GRANT_BRAND: unique symbol;

/**
 * Evidence that a caller has been authorised to read dietary/allergy data for a
 * named purpose. The object itself carries NOTHING: its purpose, actor and
 * scope live in a module-private `WeakMap` keyed by the object's identity, and
 * only an object this module minted is in that map. So a copy (`{ ...grant }`),
 * a copy with a widened scope (`{ ...grant, memberIds: null }`) or a literal is
 * not a grant at all, and every reader refuses it. The brand below exists only
 * for the type checker.
 */
export interface DietaryAccessGrant {
  readonly [DIETARY_GRANT_BRAND]: true;
}

/**
 * What a minted grant may read. Two KINDS, so a booking grant can never be
 * presented to a profile reader (a booking admin does not see the profile) and
 * a profile grant can never be presented to a booking reader. The subject's own
 * data export is the one purpose both sides accept, each for the subject's own
 * rows only.
 */
type MemberGrantRecord = {
  readonly kind: "member";
  readonly purpose: "self" | "self-data-export" | "membership-admin" | "member-merge";
  readonly actorMemberId: string;
  /**
   * The members this grant may read: the subject for a self grant, the two
   * merge participants for a merge grant, and null (any member) only for
   * membership administration.
   */
  readonly memberIds: readonly string[] | null;
};

type BookingGuestGrantRecord = {
  readonly kind: "booking-guest";
  readonly purpose: "booking-admin-view" | "booking-admin-edit" | "kiosk";
  readonly actorMemberId: string;
  /**
   * The guest rows this grant may read: the kiosk day list's present guests for
   * a kiosk grant, and null (any booking's guests) for a booking admin.
   */
  readonly guestIds: readonly string[] | null;
};

type GrantRecord = MemberGrantRecord | BookingGuestGrantRecord;

const MINTED_GRANTS = new WeakMap<object, GrantRecord>();

function registerGrant(record: GrantRecord): DietaryAccessGrant {
  if (!record.actorMemberId) {
    throw new Error("A dietary access grant needs an authenticated actor");
  }
  const grant = Object.freeze({}) as DietaryAccessGrant;
  MINTED_GRANTS.set(grant, Object.freeze(record));
  return grant;
}

function mintGrant(
  purpose: MemberGrantRecord["purpose"],
  actorMemberId: string,
  memberIds: readonly string[] | null,
): DietaryAccessGrant {
  return registerGrant({
    kind: "member",
    purpose,
    actorMemberId,
    memberIds: memberIds ? Object.freeze([...memberIds]) : null,
  });
}

function mintBookingGuestGrant(
  purpose: BookingGuestGrantRecord["purpose"],
  actorMemberId: string,
  guestIds: readonly string[] | null,
): DietaryAccessGrant {
  return registerGrant({
    kind: "booking-guest",
    purpose,
    actorMemberId,
    guestIds: guestIds ? Object.freeze([...guestIds]) : null,
  });
}

/**
 * The signed-in member's session, as `auth()` returns it. The subject IS the
 * session's user: there is no separate member id to pass, so a self grant
 * cannot be pointed at somebody else.
 */
type SignedInSession = { user: { id: string } };

/** The signed-in member reading or editing their OWN profile/onboarding. */
export function grantSelfDietaryAccess(session: SignedInSession): DietaryAccessGrant {
  return mintGrant("self", session.user.id, [session.user.id]);
}

/** The signed-in member's own full data export (`/api/member/data-export`). */
export function grantSelfDataExportDietaryAccess(
  session: SignedInSession,
): DietaryAccessGrant {
  return mintGrant("self-data-export", session.user.id, [session.user.id]);
}

type GrantDb = Prisma.TransactionClient | PrismaClient;

/**
 * An admin holding `membership` access at `level`, judged from the DATABASE:
 * the actor's own Member row and access-role assignments (definitions joined)
 * are re-read here, the same way `requireAdmin` derives its matrix, and any
 * matrix carried on the argument is ignored. So neither a JWT-carried matrix
 * (`requireActiveSessionUser`'s result has the same shape) nor a literal one can
 * produce a grant. The argument is the successful `requireAdmin` result, used
 * only for WHO is asking. An inactive or non-login actor gets nothing, and a
 * missing row fails closed.
 */
export async function grantMembershipAdminDietaryAccess(
  guard: { ok: true; session: { user: { id: string } } },
  level: "view" | "edit",
  db: GrantDb = prisma,
): Promise<DietaryAccessGrant | null> {
  if (guard.ok !== true) return null;
  const actorMemberId = guard.session.user.id;
  if (!actorMemberId) return null;
  if (!(await actorHoldsAdminArea(db, actorMemberId, { area: "membership", level }))) {
    return null;
  }
  return mintGrant("membership-admin", actorMemberId, null);
}

/**
 * Member merge, Full Admin only, scoped to the two participants. The Full Admin
 * check is made HERE, against the database, rather than trusted from the
 * caller, and the grant reads nobody but `masterId` and `loserId`. Merge reads
 * the value so the loser's entry survives when the master's is blank: a merge
 * deletes the loser row, so not reading it would destroy data the toggle
 * promises to keep.
 */
export async function grantMemberMergeDietaryAccess(
  db: GrantDb,
  scope: { actorMemberId: string; masterId: string; loserId: string },
): Promise<DietaryAccessGrant | null> {
  if (!scope.masterId || !scope.loserId || scope.masterId === scope.loserId) {
    return null;
  }
  if (!(await actorIsFullAdmin(db, scope.actorMemberId))) return null;
  return mintGrant("member-merge", scope.actorMemberId, [
    scope.masterId,
    scope.loserId,
  ]);
}

/**
 * What a PERSISTED record (an audit row, a log) may say about a dietary value:
 * that one is recorded, never what it is (`INV-PRIV-022`).
 */
export const DIETARY_VALUE_REDACTION = "[REDACTED]";

export function redactDietaryValueForRecord(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return DIETARY_VALUE_REDACTION;
}

/**
 * Member merge reads Member rows from a client that OMITS the column, so the
 * field merge would see it blank on both sides and the loser's value would die
 * with the loser row. This attaches both values through this door so the
 * ordinary fill-if-blank rule applies: master wins, and the loser's value
 * survives only when the master has none. The merge grant makes its own
 * DB-verified Full Admin check; without it nothing is read, which can only ever
 * keep the master's value.
 */
export async function attachMergeDietaryRequirements<T extends { id: string }>(
  db: Prisma.TransactionClient | PrismaClient,
  actorMemberId: string,
  master: T,
  loser: T,
): Promise<
  [T & { dietaryRequirements?: string }, T & { dietaryRequirements?: string }]
> {
  const grant = await grantMemberMergeDietaryAccess(db, {
    actorMemberId,
    masterId: master.id,
    loserId: loser.id,
  });
  const values = grant
    ? await readMemberDietaryRequirementsByIds(grant, [master.id, loser.id], db)
    : new Map<string, string | null>();
  // Only a STORED value is attached. A member with none gains no key, which the
  // field merge reads as blank exactly as it reads null, and which leaves the
  // diff row identical to the one a pre-#2941 row produced. Both derivations of
  // one merge go through here, so the preview token and the execute-time
  // re-derivation still agree.
  const attach = <R extends { id: string }>(row: R) => {
    const value = values.get(row.id);
    return (typeof value === "string"
      ? { ...row, dietaryRequirements: value }
      : { ...row }) as R & { dietaryRequirements?: string };
  };
  return [attach(master), attach(loser)];
}

/**
 * A merge diff row as a PERSISTED record (or an OFF screen) may hold it: the
 * dietary row keeps its field and source, and its three values become
 * "recorded / not recorded". Every other row is returned untouched, because
 * `INV-PRIV-011` lets an audit row keep names and addresses.
 */
export function redactDietaryMergeRow<
  R extends { field: string; master: unknown; loser: unknown; result: unknown },
>(row: R): R {
  if (row.field !== "dietaryRequirements") return row;
  return {
    ...row,
    master: redactDietaryValueForRecord(row.master),
    loser: redactDietaryValueForRecord(row.loser),
    result: redactDietaryValueForRecord(row.result),
  };
}

function grantRecord(grant: unknown): GrantRecord | undefined {
  return typeof grant === "object" && grant !== null
    ? MINTED_GRANTS.get(grant)
    : undefined;
}

function assertCovers(
  grant: DietaryAccessGrant,
  memberIds: readonly string[],
): MemberGrantRecord {
  const record = grantRecord(grant);
  if (!record) {
    throw new Error("Dietary data requested without an access grant");
  }
  if (record.kind !== "member") {
    throw new Error("A booking dietary access grant cannot read a member profile");
  }
  if (record.memberIds === null) return record;
  const allowed = record.memberIds;
  if (!memberIds.every((id) => allowed.includes(id))) {
    throw new Error(
      record.purpose === "member-merge"
        ? "A merge dietary access grant covers only its two participants"
        : "A self dietary access grant covers only its own member",
    );
  }
  return record;
}

type DietaryReadDb = Pick<Prisma.TransactionClient, "member">;

/**
 * Is the club collecting and displaying the field? Defaults OFF on a missing
 * row and on a read failure (`loadMemberFieldsFlags` falls back to defaults).
 */
export async function isDietaryFieldEnabled(): Promise<boolean> {
  return (await loadMemberFieldsFlags()).showDietaryRequirements;
}

/** One member's stored value, for a grant that covers them. */
export async function readMemberDietaryRequirements(
  grant: DietaryAccessGrant,
  memberId: string,
  db: DietaryReadDb = prisma,
): Promise<string | null> {
  assertCovers(grant, [memberId]);
  const row = await db.member.findUnique({
    where: { id: memberId },
    select: { dietaryRequirements: true },
  });
  return row?.dietaryRequirements ?? null;
}

/**
 * Several members' stored values keyed by id, for membership administration
 * (member CSV export) or a merge grant's own two participants. A self grant is
 * refused here rather than silently narrowed.
 */
export async function readMemberDietaryRequirementsByIds(
  grant: DietaryAccessGrant,
  memberIds: readonly string[],
  db: DietaryReadDb = prisma,
): Promise<Map<string, string | null>> {
  const record = grantRecord(grant);
  if (
    !record ||
    (record.purpose !== "membership-admin" && record.purpose !== "member-merge")
  ) {
    throw new Error(
      "Bulk dietary reads need a membership administration or merge grant",
    );
  }
  assertCovers(grant, memberIds);
  const result = new Map<string, string | null>();
  if (memberIds.length === 0) return result;
  const rows = await db.member.findMany({
    where: { id: { in: [...new Set(memberIds)] } },
    select: { id: true, dietaryRequirements: true },
  });
  for (const row of rows) result.set(row.id, row.dietaryRequirements ?? null);
  return result;
}

/**
 * What a screen may show: the value while the field is ON, and nothing at all
 * while it is OFF. OFF hides; it never clears (`INV-PRIV-022`).
 */
export async function loadDietaryRequirementsForDisplay(
  grant: DietaryAccessGrant,
  memberId: string,
  options: { enabled?: boolean; db?: DietaryReadDb } = {},
): Promise<{ enabled: false } | { enabled: true; value: string | null }> {
  const enabled = options.enabled ?? (await isDietaryFieldEnabled());
  if (!enabled) return { enabled: false };
  return {
    enabled: true,
    value: await readMemberDietaryRequirements(grant, memberId, options.db),
  };
}

/**
 * What account erasure writes (#2941, `INV-PRIV-022`). An approved self-service
 * deletion anonymises the Member row, and the dietary/allergy value is personal
 * data like the address beside it: it goes too, whatever the toggle says.
 * Exported as a constant so the anonymising update spreads it rather than
 * naming the column itself.
 */
// The same patch erases the subject's BOOKING values too (#3029, W16): the
// guest rows the anonymisation renames to "Deleted Member" spread it in the same
// update, so a booking snapshot does not outlive the profile it came from.
export const DIETARY_ERASURE_PATCH = Object.freeze({
  dietaryRequirements: null,
} as const);

/**
 * The write half every writer shares. Returns the patch to spread into a
 * Member `data` object, or an empty patch when the field is OFF or the value
 * was not sent — so OFF writes nothing and the stored value survives.
 */
export function buildDietaryRequirementsPatch(input: {
  enabled: boolean;
  value: string | null | undefined;
}): { dietaryRequirements?: string | null } {
  if (!input.enabled || input.value === undefined) return {};
  return { dietaryRequirements: normalizeDietaryRequirements(input.value) };
}

/**
 * Did applying `patch` change the stored value? Audit rows record THAT the
 * field changed, never what it holds (`INV-PRIV-022`, `INV-PRIV-011`).
 */
export function dietaryRequirementsChanged(
  before: string | null,
  patch: { dietaryRequirements?: string | null },
): boolean {
  if (!("dietaryRequirements" in patch)) return false;
  return (before ?? null) !== (patch.dietaryRequirements ?? null);
}

// ===========================================================================
// BOOKING-GUEST VALUES (#3029). Who may read one stay's note is `INV-PRIV-022`
// (extended in place, not a second rule); its lifecycle is `INV-MOD-059`.
// ===========================================================================

type BookingGuestDb = Pick<Prisma.TransactionClient, "bookingGuest">;

/**
 * Does the actor, re-read from the DATABASE, hold `area` at `level`? The one
 * derivation both admin grants use: the actor's own Member row and access-role
 * assignments (definitions joined) are read here the way `requireAdmin` derives
 * its matrix, and any matrix carried by the caller is ignored. An inactive or
 * non-login actor holds nothing, and a missing row fails closed.
 */
async function actorHoldsAdminArea(
  db: GrantDb,
  actorMemberId: string,
  requirement: { area: "membership" | "bookings"; level: "view" | "edit" },
): Promise<boolean> {
  const actor = await db.member.findUnique({
    where: { id: actorMemberId },
    select: {
      active: true,
      canLogin: true,
      accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
    },
  });
  if (!actor?.active) return false;
  // No `adminPermissionMatrix` key is passed, so the matrix is derived from the
  // rows just read and never from an embedded (JWT) copy.
  return hasAdminAreaAccess(
    { canLogin: actor.canLogin, accessRoles: actor.accessRoles },
    requirement,
  );
}

/**
 * A booking administrator: `bookings:view` to see a booking's values,
 * `bookings:edit` to change them (the issue's "existing booking permissions").
 * Judged from the database exactly like the membership grant, and NOT issued
 * while the field is OFF — OFF hides the booking values from every screen
 * without clearing one.
 */
export async function grantBookingAdminDietaryAccess(
  guard: { ok: true; session: { user: { id: string } } },
  level: "view" | "edit",
  options: { enabled?: boolean; db?: GrantDb } = {},
): Promise<DietaryAccessGrant | null> {
  if (guard.ok !== true) return null;
  const actorMemberId = guard.session.user.id;
  if (!actorMemberId) return null;
  const enabled = options.enabled ?? (await isDietaryFieldEnabled());
  if (!enabled) return null;
  const requirement = { area: "bookings", level } as const;
  if (!(await actorHoldsAdminArea(options.db ?? prisma, actorMemberId, requirement))) {
    return null;
  }
  const purpose = level === "edit" ? "booking-admin-edit" : "booking-admin-view";
  return mintBookingGuestGrant(purpose, actorMemberId, null);
}

/**
 * The kiosk tiers that may read the booking values of the guests on that day's
 * list: `admin` (a Full Admin, who already holds `bookings:edit`) and
 * `hut-leader` (the member running that stay). Deliberately the same set as
 * `kioskTierManagesRoster`, and deliberately NOT computed from it — the two are
 * separate rules asserted equal by `member-dietary-booking-privacy.test.ts`, so
 * widening one cannot silently widen the other. The unattended `lodge` wall
 * tier, `staying-guest` and `none` are denied: disclosure to a shared screen is
 * disclosure to everybody standing at it.
 */
export const KIOSK_DIETARY_TIERS: readonly KioskTier[] = Object.freeze(["admin", "hut-leader"]);

/**
 * The kiosk day list's grant, scoped to exactly the guests that list shows
 * (the route computes the operationally present population for that date and
 * lodge first, then asks). The tier is the one `checkLodgeAuth` resolved from
 * the database — an assignment window, a PIN session or an admin role — so
 * there is no second permission rule here, only a narrower set of tiers. An
 * admin's read-only preview of a kiosk account is always denied, whatever tier
 * the previewed account resolves to. Not issued while the field is OFF.
 * A hut leader on their own account (no PIN session) must also hold an
 * assignment at THIS lodge covering THIS day, re-read here: defence in depth
 * behind the route's lodge resolution (#3029 S1).
 */
export async function grantKioskDietaryAccess(
  access: KioskDietaryAccess & { presentGuestIds: readonly string[] },
  options: { enabled?: boolean; db?: Pick<PrismaClient, "hutLeaderAssignment"> } = {},
): Promise<DietaryAccessGrant | null> {
  if (!KIOSK_DIETARY_TIERS.includes(access.tier)) return null;
  if (access.preview) return null;
  if (!access.actorMemberId) return null;
  const enabled = options.enabled ?? (await isDietaryFieldEnabled());
  if (!enabled) return null;
  if (access.tier === "hut-leader" && !access.pinSession) {
    const leads = await (options.db ?? prisma).hutLeaderAssignment.count({
      where: {
        memberId: access.actorMemberId,
        lodgeId: access.lodgeId,
        startDate: { lte: addDaysDateOnly(access.date, 1) },
        endDate: { gte: access.date },
      },
    });
    if (leads === 0) return null;
  }
  return mintBookingGuestGrant("kiosk", access.actorMemberId, access.presentGuestIds);
}

/** Who is at the kiosk, as `checkLodgeAuth` / `resolveKioskLodgeId` decided it. */
type KioskDietaryAccess = {
  tier: KioskTier;
  preview?: unknown;
  pinSession?: unknown;
  actorMemberId: string | null;
  lodgeId: string;
  date: Date;
};

function bookingGuestGrantRecord(
  grant: DietaryAccessGrant,
  purposes: readonly BookingGuestGrantRecord["purpose"][],
): BookingGuestGrantRecord {
  const record = grantRecord(grant);
  if (!record) {
    throw new Error("Booking dietary data requested without an access grant");
  }
  if (record.kind !== "booking-guest" || !purposes.includes(record.purpose)) {
    throw new Error(
      `A ${record.purpose} dietary access grant cannot read or edit these booking values`,
    );
  }
  return record;
}

/** Every guest's stored value on one booking, for a booking administrator. */
export async function readBookingGuestDietaryForAdmin(
  grant: DietaryAccessGrant,
  bookingId: string,
  db: BookingGuestDb = prisma,
): Promise<Map<string, string | null>> {
  bookingGuestGrantRecord(grant, ["booking-admin-view", "booking-admin-edit"]);
  const rows = await db.bookingGuest.findMany({
    where: { bookingId },
    select: { id: true, dietaryRequirements: true },
  });
  return new Map(rows.map((row) => [row.id, row.dietaryRequirements ?? null]));
}

/**
 * The present guests' stored values for the kiosk day list. A guest id the
 * grant was not minted for is refused rather than silently dropped, so a
 * widened query cannot turn into a widened disclosure.
 */
export async function readKioskGuestDietaryRequirements(
  grant: DietaryAccessGrant,
  guestIds: readonly string[],
  db: BookingGuestDb = prisma,
): Promise<Map<string, string | null>> {
  const record = bookingGuestGrantRecord(grant, ["kiosk"]);
  const allowed = record.guestIds ?? [];
  if (!guestIds.every((id) => allowed.includes(id))) {
    throw new Error("A kiosk dietary access grant covers only that day's present guests");
  }
  const result = new Map<string, string | null>();
  if (guestIds.length === 0) return result;
  const rows = await db.bookingGuest.findMany({
    where: { id: { in: [...new Set(guestIds)] } },
    select: { id: true, dietaryRequirements: true },
  });
  for (const row of rows) result.set(row.id, row.dietaryRequirements ?? null);
  return result;
}

/**
 * The kiosk day list's cards with each present guest's value attached — for the
 * `admin` and `hut-leader` tiers only, and only while the field is ON. For every
 * other tier (or an admin's preview) the cards come back untouched: their guests
 * carry NO `dietaryRequirements` key, and nothing is read.
 */
export async function attachKioskGuestDietary<
  C extends { guests: ReadonlyArray<{ id: string }> },
>(
  access: KioskDietaryAccess,
  cards: readonly C[],
): Promise<Array<C & { guests: Array<C["guests"][number] & { dietaryRequirements?: string | null }> }>> {
  const presentGuestIds = cards.flatMap((card) => card.guests.map((guest) => guest.id));
  const grant = await grantKioskDietaryAccess({ ...access, presentGuestIds });
  // Untouched: the key is optional, and a denied tier's guests never gain it.
  if (!grant) return cards as Awaited<ReturnType<typeof attachKioskGuestDietary<C>>>;
  const values = await readKioskGuestDietaryRequirements(grant, presentGuestIds);
  return cards.map((card) => ({
    ...card,
    guests: card.guests.map((guest) => ({
      ...guest,
      dietaryRequirements: values.get(guest.id) ?? null,
    })),
  }));
}

/**
 * The subject's OWN booking values, for their own full data export: only rows
 * where the guest IS the subject, never the other people on their bookings.
 * Issued even while the field is OFF, like the profile value beside it (owner
 * decision on #2941, 20 Sep 2026 — self disclosure).
 */
export type OwnBookingGuestDietaryExportRow = {
  stayStart: Date;
  stayEnd: Date;
  dietaryRequirements: string;
};

export async function readOwnBookingGuestDietaryForExport(
  grant: DietaryAccessGrant,
  db: BookingGuestDb = prisma,
): Promise<OwnBookingGuestDietaryExportRow[]> {
  const record = grantRecord(grant);
  if (!record || record.kind !== "member" || record.purpose !== "self-data-export") {
    throw new Error("Own booking dietary values need the subject's data-export grant");
  }
  // The subject's own guest rows on ANY booking (their own, or somebody else's
  // they were added to), identified by the stay dates only: another member's
  // booking id is not the subject's data.
  const rows = await db.bookingGuest.findMany({
    where: { memberId: record.actorMemberId, dietaryRequirements: { not: null } },
    select: { stayStart: true, stayEnd: true, dietaryRequirements: true },
    orderBy: [{ stayStart: "asc" }, { id: "asc" }],
  });
  return rows.flatMap(({ stayStart, stayEnd, dietaryRequirements }) =>
    dietaryRequirements ? [{ stayStart, stayEnd, dietaryRequirements }] : [],
  );
}

export type BookingGuestDietaryEditResult =
  | { status: "updated"; changed: boolean; cleared: boolean; value: string | null }
  | { status: "not-found" }
  | { status: "occupant-changed" };

/** Who the editor saw on the row; the write is refused if it is not them now. */
export type BookingGuestOccupant = {
  memberId: string | null;
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
};

/**
 * The ONE direct edit of a stored booking value: one guest row, matched on its
 * booking, its own id AND the occupant the editor was shown (C2) — so a row
 * rewritten in place since the page loaded (a held-party substitution, a
 * placeholder link, an erasure) is refused as "occupant-changed", never written
 * onto somebody else. It never touches the member profile (`INV-MOD-059`) and is
 * not a booking modification (`INV-MOD-001`). The caller audits each edit,
 * never the value.
 */
export async function updateBookingGuestDietaryRequirements(
  grant: DietaryAccessGrant,
  input: { bookingId: string; guestId: string; value: string | null; occupant: BookingGuestOccupant },
  db: BookingGuestDb = prisma,
): Promise<BookingGuestDietaryEditResult> {
  bookingGuestGrantRecord(grant, ["booking-admin-edit"]);
  if (!isDietaryRequirementsWithinLimit(input.value)) throw new Error(DIETARY_REQUIREMENTS_TOO_LONG_MESSAGE);
  const value = normalizeDietaryRequirements(input.value);
  const where = { id: input.guestId, bookingId: input.bookingId, booking: { deletedAt: null } };
  const before = await db.bookingGuest.findFirst({ where, select: { dietaryRequirements: true } });
  if (!before) return { status: "not-found" };
  const updated = await db.bookingGuest.updateMany({
    where: { ...where, ...input.occupant },
    data: { dietaryRequirements: value },
  });
  if (updated.count !== 1) {
    const still = await db.bookingGuest.findFirst({ where, select: { id: true } });
    return { status: still ? "occupant-changed" : "not-found" };
  }
  const changed = (before.dietaryRequirements ?? null) !== value;
  return { status: "updated", changed, cleared: value === null, value };
}
