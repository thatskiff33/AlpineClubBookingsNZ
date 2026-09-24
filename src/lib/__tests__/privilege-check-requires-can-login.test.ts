import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  authorizationRoleFromAccessRoles,
  hasAdminAccess,
  hasLodgeAccess,
  hasPrivilegedAccess,
  isFullAdmin,
  memberHoldsFullAdminRole,
  sessionAccessRoleClaim,
} from "@/lib/access-roles";
import {
  MEMBER_ACCESS_ROLE_SELECT,
  MEMBER_PRIVILEGE_CHECK_SELECT,
} from "@/lib/access-role-definitions";
import {
  getAdminPermissionMatrix,
  hasAdminAreaAccess,
  hasAdminPortalAccess,
} from "@/lib/admin-permissions";

/**
 * `canLogin` is REQUIRED on every privilege check (#3603), so a gate that
 * re-reads a member without selecting it does not compile. That was the defect:
 * a query that left the field out handed the checks `undefined`, and the stored
 * roles of a login-disabled member resolved in full.
 *
 * The `@ts-expect-error` lines ARE the test. `npm run typecheck` fails on an
 * UNUSED `@ts-expect-error`, so if `canLogin` ever becomes optional again on
 * any of these, the directive stops being needed and the build goes red here.
 * The runtime assertions then pin what each check answers once the field is
 * handed over.
 */

type RowsOnlyMember = Prisma.MemberGetPayload<{
  select: { accessRoles: { select: typeof MEMBER_ACCESS_ROLE_SELECT } };
}>;
type PrivilegeCheckMember = Prisma.MemberGetPayload<{
  select: typeof MEMBER_PRIVILEGE_CHECK_SELECT;
}>;

const FULL_ADMIN_ROWS = [
  { role: "ADMIN" as const, roleDefinitionId: null, roleDefinition: null },
];

describe("privilege checks require canLogin (#3603)", () => {
  it("refuses to compile a privilege check over a member read without canLogin", () => {
    const rowsOnly = { accessRoles: FULL_ADMIN_ROWS } as RowsOnlyMember;

    // @ts-expect-error - canLogin is required: select it with MEMBER_PRIVILEGE_CHECK_SELECT.
    hasAdminAccess(rowsOnly);
    // @ts-expect-error - canLogin is required on isFullAdmin.
    isFullAdmin(rowsOnly);
    // @ts-expect-error - canLogin is required on hasPrivilegedAccess.
    hasPrivilegedAccess(rowsOnly);
    // @ts-expect-error - canLogin is required on hasLodgeAccess.
    hasLodgeAccess(rowsOnly);
    // @ts-expect-error - canLogin is required on authorizationRoleFromAccessRoles.
    authorizationRoleFromAccessRoles(rowsOnly);
    // @ts-expect-error - canLogin is required on the admin permission matrix.
    getAdminPermissionMatrix(rowsOnly);
    // @ts-expect-error - canLogin is required on an area check.
    hasAdminAreaAccess(rowsOnly, { area: "bookings", level: "view" });
    // @ts-expect-error - canLogin is required on portal standing.
    hasAdminPortalAccess(rowsOnly);
  });

  it("compiles over the shared select, and clears every check when login is off", () => {
    const disabled: PrivilegeCheckMember = {
      canLogin: false,
      accessRoles: FULL_ADMIN_ROWS,
    };

    expect(hasAdminAccess(disabled)).toBe(false);
    expect(isFullAdmin(disabled)).toBe(false);
    expect(hasPrivilegedAccess(disabled)).toBe(false);
    expect(hasLodgeAccess(disabled)).toBe(false);
    expect(authorizationRoleFromAccessRoles(disabled)).toBe("USER");
    expect(hasAdminPortalAccess(disabled)).toBe(false);
    expect(hasAdminAreaAccess(disabled, { area: "bookings", level: "view" })).toBe(false);
    expect(sessionAccessRoleClaim(disabled)).toEqual([]);
  });

  it("grants the same member everything with login enabled", () => {
    const enabled: PrivilegeCheckMember = {
      canLogin: true,
      accessRoles: FULL_ADMIN_ROWS,
    };

    expect(hasAdminAccess(enabled)).toBe(true);
    expect(isFullAdmin(enabled)).toBe(true);
    expect(hasPrivilegedAccess(enabled)).toBe(true);
    expect(hasLodgeAccess(enabled)).toBe(true);
    expect(authorizationRoleFromAccessRoles(enabled)).toBe("ADMIN");
    expect(hasAdminPortalAccess(enabled)).toBe(true);
    expect(hasAdminAreaAccess(enabled, { area: "bookings", level: "edit" })).toBe(true);
    expect(sessionAccessRoleClaim(enabled)).toEqual(["ADMIN"]);
  });

  it("keeps the canLogin-blind blocker check explicit, and blind", () => {
    // The member-merge and hard-delete blockers must keep refusing an account
    // that stores the Full Admin row after its login was switched off, so they
    // use a check that says so by name and needs no canLogin.
    const rowsOnly = { accessRoles: FULL_ADMIN_ROWS } as RowsOnlyMember;
    expect(memberHoldsFullAdminRole(rowsOnly)).toBe(true);
    expect(
      memberHoldsFullAdminRole({ canLogin: false, accessRoles: FULL_ADMIN_ROWS } as PrivilegeCheckMember),
    ).toBe(true);
    expect(memberHoldsFullAdminRole({ accessRoles: [{ role: "ADMIN_BOOKINGS" }] })).toBe(false);
    expect(memberHoldsFullAdminRole({ accessRoles: [] })).toBe(false);
  });
});
