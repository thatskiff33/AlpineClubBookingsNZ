import type { Role } from "@prisma/client";

export const ROLE_VALUES = [
  "USER",
  "ADMIN",
  "LODGE",
  "NON_MEMBER",
  "SCHOOL",
] as const satisfies readonly Role[];

export type AppRole = (typeof ROLE_VALUES)[number];

export const MEMBER_LEVEL_ROLE_VALUES = [
  "USER",
] as const satisfies readonly Role[];

export type MemberLevelRole = (typeof MEMBER_LEVEL_ROLE_VALUES)[number];

export const OPERATIONAL_ROLE_VALUES = [
  "ADMIN",
  "LODGE",
] as const satisfies readonly Role[];

// Non-member categories created by booking-request flows. These carry NO access:
// they are deliberately excluded from MEMBER_LEVEL and OPERATIONAL role sets, so
// every existing allowlist permission check treats them as "no access". They are
// also excluded from member rosters and exempt from subscription obligations.
export const NON_MEMBER_ROLE_VALUES = [
  "NON_MEMBER",
  "SCHOOL",
] as const satisfies readonly Role[];

export const MEMBER_IMPORT_ROLE_VALUES = [
  "USER",
  "ADMIN",
] as const satisfies readonly Role[];

export const ROLE_LABELS: Record<AppRole, string> = {
  USER: "User",
  ADMIN: "Admin",
  LODGE: "Lodge",
  NON_MEMBER: "Non-Member",
  SCHOOL: "School",
};

export function isRole(value: string | null | undefined): value is AppRole {
  return ROLE_VALUES.includes(value as AppRole);
}

export function isMemberLevelRole(
  role: string | null | undefined,
): role is MemberLevelRole {
  return MEMBER_LEVEL_ROLE_VALUES.includes(role as MemberLevelRole);
}

/**
 * True for the shared lodge kiosk device login (legacy role or normalized
 * access-role rows). Kiosk accounts never hold bookings; members holding
 * the admin role are real people and remain bookable-on-behalf.
 */
export function isLodgeKioskAccount(
  role: string | null | undefined,
  accessRoles?: readonly string[] | null,
): boolean {
  return role === "LODGE" || (accessRoles ?? []).includes("LODGE");
}

export function isOperationalRole(
  role: string | null | undefined,
): role is (typeof OPERATIONAL_ROLE_VALUES)[number] {
  return OPERATIONAL_ROLE_VALUES.includes(
    role as (typeof OPERATIONAL_ROLE_VALUES)[number],
  );
}

/**
 * Whether an admin may open a membership-cancellation request for this
 * member: member-level role, active, not already cancelled, not archived.
 *
 * Mirrors the member-state half of `createAdminMembershipCancellationRequest`
 * (see the pointer beside its checks). The server additionally rejects a
 * missing member and an existing open participant; a caller that can already
 * see an open request must keep its own `!openCancellationRequest` conjunct,
 * or the action it offers will 409.
 *
 * Deliberately NOT an access-role check (#2354): access roles are cleared for
 * anyone who cannot log in, so dependants and non-login adults resolve to
 * zero roles while their memberships remain cancellable. The admin path
 * confirms every participant on their behalf, whatever their login state.
 */
export function canAdminRequestMembershipCancellation(member: {
  role: string | null | undefined;
  active: boolean;
  cancelledAt: string | Date | null | undefined;
  archivedAt: string | Date | null | undefined;
}): boolean {
  return (
    isMemberLevelRole(member.role) &&
    member.active &&
    !member.cancelledAt &&
    !member.archivedAt
  );
}

/**
 * Whether the admin cancellation flow refuses this membership PURELY because
 * the account is classed as an Admin — the member is otherwise an ordinary
 * active, not-cancelled, not-archived person.
 *
 * The stored `role` is derived from the account's access roles every time the
 * Account & Access group is saved (`legacyRoleFromAccessRoles`), so a real
 * person granted admin access is stored as `ADMIN`, and
 * `createAdminMembershipCancellationRequest` answers 422 "Only member accounts
 * can be cancelled". Before #2355 the page offered the action anyway and the
 * admin met that 422 on click; after it the action is correctly withheld, but
 * silence reads as "this membership has no cancellation path at all". This
 * predicate is what lets the page state the reason and the remedy instead
 * (#2356): reclassify the account's User Type from Admin to User under
 * Account & Access — which rewrites `role` to `USER` — then request the
 * cancellation.
 *
 * Operational-but-not-a-person accounts are deliberately excluded, so their
 * pages stay silent: `LODGE` is the shared lodge kiosk device login, and
 * `SCHOOL`/`NON_MEMBER` are the organisation and guest records created by
 * booking-request flows. None of them holds a membership, so "this membership
 * cannot be cancelled" would be noise rather than an explanation.
 */
export function isMembershipCancellationBlockedByAdminRole(member: {
  role: string | null | undefined;
  active: boolean;
  cancelledAt: string | Date | null | undefined;
  archivedAt: string | Date | null | undefined;
}): boolean {
  return (
    isOperationalRole(member.role) &&
    !isLodgeKioskAccount(member.role) &&
    member.active &&
    !member.cancelledAt &&
    !member.archivedAt
  );
}
