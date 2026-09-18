import type { Role } from "@prisma/client";
import {
  deriveUserType,
  storedAccessRolesForFullAdminGate,
  type AccessRoleAssignmentInput,
  type UserType,
} from "@/lib/access-roles";

export const ROLE_VALUES = [
  "USER",
  "ADMIN",
  "LODGE",
  "NON_MEMBER",
  "SCHOOL",
] as const satisfies readonly Role[];

export type AppRole = (typeof ROLE_VALUES)[number];

/**
 * `as const satisfies readonly Role[]` above checks only that each listed value
 * IS a Role — assignability, not coverage — so on its own it permits an
 * unlisted enum value (#2383). The other direction is closed in
 * `src/lib/__tests__/member-roles.test.ts`: its
 * `expectTypeOf<Exclude<Role, AppRole>>().toBeNever()` is checked by
 * `npm run typecheck` (the test project) and fails the moment the enum grows
 * past this list, and the runtime assertion beside it pins the same property
 * against the generated enum object so a stale build cannot hide it either.
 * It used to be an unreferenced type alias here; `noUnusedLocals` (#2693) has
 * no room for a declaration whose whole job is never to be read.
 */

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
//
// NOTE (#2383): this set is about ACCESS, not about who holds a membership.
// `SCHOOL` accounts are in here yet do hold real, fee-paying memberships, so it
// must never be reused to answer "is there a membership here to cancel?" — use
// `isMembershipHolderRecord` below.
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
 * Access-role tokens a record's stored classification confers, evaluated
 * login-blind, and the User Type the whole app derives from them (#1439).
 *
 * Accepts either shape the codebase carries: raw `MemberAccessRole` rows
 * (`{ role, roleDefinitionId }`, what a server-side `select` yields) or the
 * already-resolved string tokens the admin pages are served
 * (`resolveAccessRoleTokens`). Both collapse to the same token list, which is
 * what lets the client gate and the server check agree (#2383).
 */
export type AccountClassificationInput = {
  role: string | null | undefined;
  accessRoles?: ReadonlyArray<AccessRoleAssignmentInput | string> | null;
  financeAccessLevel?: string | null;
};

export function classifyAccountRecord(
  member: AccountClassificationInput,
): UserType {
  return deriveUserType(
    storedAccessRolesForFullAdminGate({
      role: member.role,
      accessRoles: member.accessRoles ?? [],
      financeAccessLevel: member.financeAccessLevel,
    }),
    // Login-blind: this classifies what the record IS, not what it can
    // currently do. Callers apply their own `canLogin` policy.
    true,
  );
}

/**
 * True for the shared lodge kiosk device login: a device, not a person.
 * Kiosk accounts never hold bookings and hold no membership.
 *
 * This is a record-CLASS test, not a "has lodge access" test (#2383). `LODGE`
 * is a freely tickable checkbox in the member editor, described there as "Can
 * use lodge kiosk and lodge operations tools", with no exclusivity guard — so a
 * Booking Officer who also runs the lodge screen carries a `LODGE` row while
 * being an entirely ordinary fee-paying person. Testing for the mere presence
 * of the token swept those people up with the device.
 *
 * The rule is therefore the app's own classification: the record is the kiosk
 * only when `LODGE` is its ENTIRE classification, which is exactly when the
 * admin UI labels its User Type "Lodge (kiosk account)". Anything carrying a
 * second privileged token (any admin bundle, a finance role, a club-defined
 * custom role) classifies as "admin" and is treated as the person it is.
 */
export function isLodgeKioskAccount(
  role: string | null | undefined,
  accessRoles?: ReadonlyArray<AccessRoleAssignmentInput | string> | null,
  financeAccessLevel?: string | null,
): boolean {
  return (
    classifyAccountRecord({ role, accessRoles, financeAccessLevel }) === "lodge"
  );
}

export function isOperationalRole(
  role: string | null | undefined,
): role is (typeof OPERATIONAL_ROLE_VALUES)[number] {
  return OPERATIONAL_ROLE_VALUES.includes(
    role as (typeof OPERATIONAL_ROLE_VALUES)[number],
  );
}

/**
 * Whether this record is an account holder at all — a real person, or an
 * organisation the club can hold a membership for — and so has a membership
 * that could be cancelled (#2383).
 *
 * A record-CLASS test, not a capability test: it is true of archived,
 * cancelled, inactive and subscription-exempt records alike, because all of
 * those are still account holders. `canAdminRequestMembershipCancellation`
 * below adds the member-state terms. Named for exactly what it tests, because
 * the rule it replaced was not. The old gate was `isMemberLevelRole` — legacy
 * `role === "USER"` — whose name suggested "this is a member" but whose
 * behaviour was "this account holds no Full Admin bundle". That caught one of
 * the five admin classes (a Membership Officer, Booking Officer, Treasurer,
 * Content Manager or custom-role holder all store `role = "USER"` and were
 * always cancellable), and it also swept up organisation accounts, which hold
 * real fee-paying memberships.
 *
 * This asks an identity question, never a permissions or seniority one: what
 * admin access somebody holds says nothing about whether they pay for and hold
 * a membership. Who may APPROVE a cancellation against a privileged account,
 * and the rule that the club is never left without a Full Admin, are separate
 * questions enforced at approval time by the #1604/#1622 admin-account guards
 * (`@/lib/admin-account-guards`).
 *
 * Only two kinds of record are refused:
 *
 * 1. **The lodge kiosk device login** — a shared device, not a person. Matched
 *    on the record's whole classification (see `isLodgeKioskAccount`), so a
 *    kiosk identified by the legacy `LODGE` role or by a `LODGE` access-role
 *    row alone is caught, while a real person who merely also holds the lodge
 *    tools is not.
 * 2. **Booking-request contact records** — the guest and school contacts minted
 *    by the public booking-request flows (`src/lib/booking-request.ts`,
 *    `src/lib/school-booking-request.ts`). They hold no membership: they exist
 *    only to own a converted booking.
 *
 * The `canLogin` test applies to `SCHOOL` alone, and is not a login gate in
 * disguise. `SCHOOL` is genuinely two different things in this schema: the
 * legacy role of a real **organisation account** (User Type "Organisation",
 * which stores an `ORG` access-role row; the admin UI only ever sets it on a
 * login-capable account, though nothing in `createMemberSchema` enforces that
 * on write), and the role stamped on every **school booking-request contact** —
 * the school's owner contact and each named teacher — which is always created
 * `canLogin: false`. Non-login is precisely the line the rest of the codebase
 * already draws between the two (`MAPPABLE_CONTACT_SCOPE` in
 * `@/lib/non-member-contact`; a public booking request is never mapped onto a
 * login-capable member). `NON_MEMBER` needs no such test — it is only ever a
 * booking-request guest record — so it is refused outright.
 *
 * This must NOT be generalised into "no login means not cancellable": family
 * dependants and non-login adults are ordinary `USER` members whose
 * memberships are cancellable, which was the whole point of #2354.
 *
 * INPUT CONTRACT (#2383). `accessRoles` accepts either raw `MemberAccessRole`
 * rows or resolved string tokens, and the rows are consulted only when
 * `canLogin` is true. That is not cosmetic: the admin page is served
 * `resolveAccessRoleTokens` output, which is EMPTY for a non-login member,
 * while the server reads the stored rows, which are not cleared when login is
 * disabled (e.g. the family login-holder transfer). Applying the same
 * login-clearing here makes both callers feed structurally identical input, so
 * the page can never offer an action the server then refuses. Rows are used
 * only to BLOCK (the kiosk) and to widen the classification away from the
 * kiosk, never as evidence that a membership exists.
 */
export function isMembershipHolderRecord(member: {
  role: string | null | undefined;
  canLogin: boolean;
  accessRoles?: ReadonlyArray<AccessRoleAssignmentInput | string> | null;
  financeAccessLevel?: string | null;
}): boolean {
  const isDevice = member.canLogin
    ? isLodgeKioskAccount(
        member.role,
        member.accessRoles,
        member.financeAccessLevel,
      )
    : // Login-cleared: the stored rows are ignored, exactly as the resolved
      // tokens the admin page is served already are. The legacy role column is
      // not cleared and still identifies a de-logined kiosk.
      isLodgeKioskAccount(member.role);
  if (isDevice) return false;
  if (member.role === "NON_MEMBER") return false;
  if (member.role === "SCHOOL") return member.canLogin;
  return true;
}

/**
 * Whether an admin may open a membership-cancellation request for this
 * member: an account that can hold a membership, active, not already
 * cancelled, not archived.
 *
 * Mirrors the member-state half of `createAdminMembershipCancellationRequest`
 * (see the pointer beside its checks). The server additionally rejects a
 * missing member and an existing open participant; a caller that can already
 * see an open request must keep its own `!openCancellationRequest` conjunct,
 * or the action it offers will 409.
 *
 * Deliberately NOT a permissions check (#2354, #2383). Access roles are cleared
 * for anyone who cannot log in, so dependants and non-login adults resolve to
 * zero roles while their memberships remain cancellable; and holding admin
 * access is not a reason to refuse — an admin is a fee-paying member like
 * anyone else. The admin path confirms every participant on their behalf,
 * whatever their login state.
 */
export function canAdminRequestMembershipCancellation(member: {
  role: string | null | undefined;
  canLogin: boolean;
  accessRoles?: ReadonlyArray<AccessRoleAssignmentInput | string> | null;
  financeAccessLevel?: string | null;
  active: boolean;
  cancelledAt: string | Date | null | undefined;
  archivedAt: string | Date | null | undefined;
}): boolean {
  return (
    isMembershipHolderRecord(member) &&
    member.active &&
    !member.cancelledAt &&
    !member.archivedAt
  );
}
