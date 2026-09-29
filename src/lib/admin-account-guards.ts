import { AccessRole, type Prisma, type PrismaClient } from "@prisma/client";

/** A Prisma client or an interactive-transaction client. */
type GuardDbClient = PrismaClient | Prisma.TransactionClient;

/**
 * The last-admin guards (issue #1604) treat "Full Admin" as exactly what
 * `requireAdmin` grants on: an active, login-enabled member holding the ADMIN
 * access-role row. A legacy `role:"ADMIN"` value without a matching
 * access-role row confers no admin access at runtime (`hasAdminAccess` reads
 * the rows, not the legacy column), so it is deliberately NOT counted here —
 * keeping this predicate in lockstep with the runtime grant means the count
 * and the actual set of working admins cannot silently desync.
 */
export const ACTIVE_FULL_ADMIN_WHERE = {
  active: true,
  canLogin: true,
  accessRoles: { some: { role: AccessRole.ADMIN } },
} satisfies Prisma.MemberWhereInput;

export const PRIVILEGED_TARGET_GUARD_MESSAGE =
  "Only a Full Admin can deactivate, disable login for, or archive an account with privileged access.";

export const LAST_FULL_ADMIN_GUARD_MESSAGE =
  "This is the last Full Admin account, which must stay active with login enabled. Give another active account Full Admin access first.";

export const LAST_FULL_ADMIN_BULK_GUARD_MESSAGE =
  "This change would remove every remaining Full Admin. At least one Full Admin must stay active with login enabled.";

/**
 * Thrown by the last-admin guards from inside a mutation transaction so the
 * transaction rolls back. Each caller maps it to its own error shape (the
 * member-edit/bulk/deletion routes) or re-throws the native lifecycle error;
 * `statusCode` carries the intended HTTP status (409 for the invariant).
 */
export class AdminAccountGuardError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 409) {
    super(message);
    this.name = "AdminAccountGuardError";
    this.statusCode = statusCode;
  }
}

/**
 * Count of active, login-enabled Full Admins, optionally excluding a set of
 * member ids (the ids about to be deactivated). Runs on the passed client, so
 * a caller inside a transaction gets that transaction's read view.
 */
export async function countActiveFullAdmins(
  db: GuardDbClient,
  options: { excludeMemberIds?: readonly string[] } = {},
): Promise<number> {
  const exclude = options.excludeMemberIds ?? [];
  return db.member.count({
    where: exclude.length
      ? { ...ACTIVE_FULL_ADMIN_WHERE, id: { notIn: [...exclude] } }
      : ACTIVE_FULL_ADMIN_WHERE,
  });
}

/**
 * True when deactivating / de-logging / archiving `memberId` would leave zero
 * active, login-enabled Full Admins: the member is currently such an admin and
 * no OTHER one exists. Two counts on the passed client keep the check inside
 * the caller's transaction read view (issue #1604).
 */
export async function wouldRemoveLastFullAdmin(
  db: GuardDbClient,
  memberId: string,
): Promise<boolean> {
  const targetIsActiveFullAdmin =
    (await db.member.count({
      where: { ...ACTIVE_FULL_ADMIN_WHERE, id: memberId },
    })) > 0;
  if (!targetIsActiveFullAdmin) return false;

  const others = await countActiveFullAdmins(db, {
    excludeMemberIds: [memberId],
  });
  return others === 0;
}

/**
 * Bulk end-state check (issue #1604): true when deactivating every id in the
 * set would remove all remaining active Full Admins. Evaluated over the whole
 * set (not per row), so a bulk deactivate that collectively strands the club
 * fails as a whole. Returns false when there are no active Full Admins to
 * begin with, so a set of non-admins never trips it.
 */
export async function wouldRemoveAllFullAdmins(
  db: GuardDbClient,
  memberIds: readonly string[],
): Promise<boolean> {
  const currentCount = await countActiveFullAdmins(db);
  if (currentCount === 0) return false;

  const remaining = await countActiveFullAdmins(db, {
    excludeMemberIds: memberIds,
  });
  return remaining === 0;
}

/**
 * True when the actor is a Full Admin in the sense above: active,
 * login-enabled, holding the ADMIN access role. Used by the lifecycle
 * privileged-target guard and the member-merge guard, which — unlike the
 * member-edit/bulk/deletion routes — are not handed the actor's session roles,
 * so they resolve them from the database by actor id. It shares
 * `ACTIVE_FULL_ADMIN_WHERE` so an actor whose login was switched off is not a
 * Full Admin here either (#3603).
 */
export async function actorIsFullAdmin(
  db: GuardDbClient,
  actorMemberId: string,
): Promise<boolean> {
  const count = await db.member.count({
    where: {
      id: actorMemberId,
      ...ACTIVE_FULL_ADMIN_WHERE,
    },
  });
  return count > 0;
}
