import type { LodgeAccessKind, PrismaClient } from "@prisma/client";

// Per-lodge access grants (phase 4 of docs/multi-lodge/implementation-plan.md,
// ADR-001 resolved questions 2 and 5). Callers pass their own Prisma
// client/transaction so this module stays free of the app prisma singleton
// and safe to import from seeds and tests.

type LodgeAccessDb = Pick<PrismaClient, "memberLodgeAccess">;

export class LodgeBookingEligibilityError extends Error {
  status: number;

  constructor(message = "This member cannot book the selected lodge.") {
    super(message);
    this.name = "LodgeBookingEligibilityError";
    this.status = 403;
  }
}

/**
 * The lodges a member may book, resolved once from their BOOKING_RESTRICTION
 * rows. Default-open (ADR-001 resolved question 2): a member with no such rows
 * can book every active lodge (`allLodges: true`); any rows narrow eligibility
 * to exactly the listed lodges. This is the single source of the eligibility
 * rule — isMemberEligibleToBookLodge derives from it — so the lodge-targeted
 * 403 gate and the cross-lodge listing filter cannot drift.
 */
export async function getEligibleLodgeIdsForMember(
  db: LodgeAccessDb,
  memberId: string,
): Promise<{ allLodges: true } | { allLodges: false; lodgeIds: string[] }> {
  const restrictions = await db.memberLodgeAccess.findMany({
    where: { memberId, kind: "BOOKING_RESTRICTION" },
    select: { lodgeId: true },
  });
  if (restrictions.length === 0) return { allLodges: true };
  return { allLodges: false, lodgeIds: restrictions.map((row) => row.lodgeId) };
}

/**
 * Whether a member may book one named lodge. Derived from
 * getEligibleLodgeIdsForMember so the single-lodge gate and any batch listing
 * filter share one rule: a member with no BOOKING_RESTRICTION rows can book
 * every active lodge; a member with any such rows can book only the listed
 * lodges.
 */
export async function isMemberEligibleToBookLodge(
  db: LodgeAccessDb,
  /** The BOOKER, or null when the booking is owned by an Organisation (#3369). */
  memberId: string | null,
  lodgeId: string,
): Promise<boolean> {
  // #3369: a booking restriction is a MEMBER grant, held as rows against a
  // person. An organisation has none, which is the default-open case — exactly
  // the answer the invented school member gave, since it never carried a
  // restriction row either. No school's lodge access changes today.
  if (memberId === null) return true;
  const eligible = await getEligibleLodgeIdsForMember(db, memberId);
  return eligible.allLodges || eligible.lodgeIds.includes(lodgeId);
}

/**
 * Enforcement wrapper for booking mutation paths. Admin-created bookings on
 * behalf of a member bypass the restriction deliberately: the restriction is
 * an admin-configured policy, and an admin choosing to book anyway is the
 * override path (the action is audit-logged by the booking flow).
 */
export async function assertMemberMayBookLodge(
  db: LodgeAccessDb,
  input: { memberId: string; lodgeId: string; isOnBehalf?: boolean },
): Promise<void> {
  if (input.isOnBehalf) return;
  const eligible = await isMemberEligibleToBookLodge(
    db,
    input.memberId,
    input.lodgeId,
  );
  if (!eligible) {
    throw new LodgeBookingEligibilityError();
  }
}

/**
 * Thrown when a kiosk (STAFF) account is bound to more than one lodge. A
 * shared kiosk device must belong to exactly one property; serving the
 * default lodge's data instead would leak the wrong property's guest
 * list/roster and accept the wrong lodge's hut-leader PINs. Callers deny
 * until an admin fixes the MemberLodgeAccess grants.
 */
export class AmbiguousKioskLodgeError extends Error {
  status: number;

  constructor(
    message = "This kiosk account is assigned to multiple lodges — an admin must fix the assignment.",
  ) {
    super(message);
    this.name = "AmbiguousKioskLodgeError";
    this.status = 403;
  }
}

/**
 * A hut leader signed in with their own account asked for a day none of their
 * assignments covers (#3029 S1). Denied with a 403 rather than served the
 * default lodge, whose guest list is somebody else's operational data.
 */
export class KioskLodgeUnresolvedError extends Error {
  status: number;

  constructor(message = "You are not the hut leader at any lodge on this date.") {
    super(message);
    this.name = "KioskLodgeUnresolvedError";
    this.status = 403;
  }
}

/**
 * How a lodge-operational (kiosk) account is bound to a lodge via STAFF grants:
 * - "none": zero grants. The caller falls back to the club's default lodge,
 *   preserving single-lodge behaviour.
 * - "bound": exactly one grant. The kiosk is bound to that lodge.
 * - "ambiguous": two or more grants. A shared device cannot belong to more
 *   than one property, so the caller MUST deny (an admin misselection is one
 *   click away) rather than silently serve the default lodge's data.
 */
export type StaffLodgeBinding =
  | { kind: "none" }
  | { kind: "bound"; lodgeId: string }
  | { kind: "ambiguous" };

export async function getStaffLodgeBinding(
  db: LodgeAccessDb,
  memberId: string,
): Promise<StaffLodgeBinding> {
  const grants = await db.memberLodgeAccess.findMany({
    where: { memberId, kind: "STAFF" },
    select: { lodgeId: true },
    take: 2,
  });
  // @@unique([memberId, lodgeId, kind]) guarantees two rows = two distinct
  // lodges, so a length of 2 is genuinely ambiguous, not a duplicate.
  if (grants.length === 0) return { kind: "none" };
  const [onlyGrant] = grants;
  if (grants.length === 1 && onlyGrant) {
    return { kind: "bound", lodgeId: onlyGrant.lodgeId };
  }
  return { kind: "ambiguous" };
}

export function serializeLodgeAccessRows(
  rows: ReadonlyArray<{
    id: string;
    lodgeId: string;
    kind: LodgeAccessKind;
    createdAt: Date;
  }>,
) {
  return rows.map((row) => ({
    id: row.id,
    lodgeId: row.lodgeId,
    kind: row.kind,
    createdAt: row.createdAt.toISOString(),
  }));
}
