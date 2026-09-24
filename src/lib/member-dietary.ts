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
 * WHO MAY READ IT (stage 1; #3029 extends this module, never a second one):
 *  - the subject themself, for their own profile and onboarding
 *    ({@link grantSelfDietaryAccess}), while the club has the field ON;
 *  - the subject's own full data export ({@link grantSelfDataExportDietaryAccess}),
 *    even while the field is OFF (owner decision, 20 Sep 2026 — self disclosure);
 *  - an admin holding `membership` access ({@link grantMembershipAdminDietaryAccess}),
 *    for the member editor, member CSV and member merge, while the field is ON.
 *
 * Everybody else is denied by construction rather than by a filter: a family
 * member, a hut leader, a shared screen, a booking or finance export, Xero, the
 * analytics tag, a notification or a log has no grant to present and no other
 * way to select the column. `member-dietary-access-census.test.ts` proves that
 * no other file selects it, overrides the omission, reads it through raw SQL or
 * constructs an application Prisma client without the omission.
 *
 * `import "server-only"`: this module must never reach a browser bundle.
 */
import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";
import { actorIsFullAdmin } from "@/lib/admin-account-guards";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { loadMemberFieldsFlags } from "@/lib/member-fields-settings";
import { normalizeDietaryRequirements } from "@/lib/member-dietary-field";
import { prisma } from "@/lib/prisma";

const DIETARY_GRANT = Symbol("member-dietary-access-grant");

export type DietaryAccessPurpose =
  | "self"
  | "self-data-export"
  | "membership-admin"
  | "member-merge";

/**
 * Evidence that a caller has been authorised to read dietary/allergy data for a
 * named purpose. It cannot be written as an object literal anywhere else: the
 * brand is a module-private `unique symbol`, so the only way to hold one is to
 * be handed it by a `grant*` function below.
 */
export interface DietaryAccessGrant {
  readonly [DIETARY_GRANT]: true;
  readonly purpose: DietaryAccessPurpose;
  /**
   * The members this grant may read: the subject for a self grant, the two
   * merge participants for a merge grant, and null (any member) only for
   * membership administration.
   */
  readonly memberIds: readonly string[] | null;
  readonly actorMemberId: string;
}

function mintGrant(
  purpose: DietaryAccessPurpose,
  actorMemberId: string,
  memberIds: readonly string[] | null,
): DietaryAccessGrant {
  if (!actorMemberId) {
    throw new Error("A dietary access grant needs an authenticated actor");
  }
  return Object.freeze({
    [DIETARY_GRANT]: true as const,
    purpose,
    actorMemberId,
    memberIds: memberIds ? Object.freeze([...memberIds]) : null,
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

/**
 * An admin holding `membership` access at `level`, judged from the permission
 * matrix on the SUCCESSFUL `requireAdmin` result: the DB-verified matrix the
 * guard re-read for this request, never a JWT claim. The argument is the
 * guard's own result shape, so a caller has to have run the guard to have one.
 * Returns null, and so grants nothing, when the matrix does not reach it; a
 * missing or malformed matrix resolves to no access (fail closed).
 */
export function grantMembershipAdminDietaryAccess(
  guard: {
    ok: true;
    session: { user: { id: string; adminPermissionMatrix?: unknown } };
  },
  level: "view" | "edit",
): DietaryAccessGrant | null {
  if (guard.ok !== true) return null;
  const user = guard.session.user;
  if (
    !hasAdminAreaAccess(
      { adminPermissionMatrix: user.adminPermissionMatrix },
      { area: "membership", level },
    )
  ) {
    return null;
  }
  return mintGrant("membership-admin", user.id, null);
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
  db: Prisma.TransactionClient | PrismaClient,
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

function isGrant(grant: unknown): grant is DietaryAccessGrant {
  return (
    typeof grant === "object" &&
    grant !== null &&
    (grant as Record<symbol, unknown>)[DIETARY_GRANT] === true
  );
}

function assertCovers(grant: DietaryAccessGrant, memberIds: readonly string[]): void {
  if (!isGrant(grant)) {
    throw new Error("Dietary data requested without an access grant");
  }
  if (grant.memberIds === null) return;
  const allowed = grant.memberIds;
  if (!memberIds.every((id) => allowed.includes(id))) {
    throw new Error(
      grant.purpose === "member-merge"
        ? "A merge dietary access grant covers only its two participants"
        : "A self dietary access grant covers only its own member",
    );
  }
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
  if (
    !isGrant(grant) ||
    (grant.purpose !== "membership-admin" && grant.purpose !== "member-merge")
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
