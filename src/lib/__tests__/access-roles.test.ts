import { describe, expect, it } from "vitest";
import {
  accessRolesFromCompatibilityFields,
  accessRoleTokensForUserType,
  authorizationRoleFromAccessRoles,
  deriveUserType,
  legacyRoleFromAccessRoles,
  hasPrivilegedAccess,
  normalizeAssignableAccessRoles,
  normalizeAssignableAccessRoleTokens,
  resolveAccessRoles,
  resolveAccessRoleTokens,
  storedAccessRolesForFullAdminGate,
  accessRoleChangeRequiresFullAdmin,
} from "@/lib/access-roles";

describe("access role compatibility helpers", () => {
  it("maps legacy member and finance fields only through the compatibility helper", () => {
    expect(
      accessRolesFromCompatibilityFields({
        role: "USER",
        financeAccessLevel: "MANAGER",
        canLogin: true,
      }),
    ).toEqual(["USER", "FINANCE_ADMIN"]);
    expect(accessRolesFromCompatibilityFields({ role: "SCHOOL", canLogin: true })).toEqual([
      "ORG",
    ]);
    expect(accessRolesFromCompatibilityFields({ role: "SCHOOL", canLogin: false })).toEqual([]);
  });

  it("does not authorize from legacy fields in runtime access resolution", () => {
    expect(
      resolveAccessRoles({
        role: "ADMIN",
        financeAccessLevel: "MANAGER",
        canLogin: true,
      }),
    ).toEqual([]);
    expect(
      resolveAccessRoles({
        accessRoles: [{ role: "ADMIN" }, { role: "FINANCE_ADMIN" }],
        role: "USER",
        financeAccessLevel: "NONE",
        canLogin: true,
      }),
    ).toEqual(["ADMIN", "FINANCE_ADMIN"]);
  });

  it("normalizes explicit role lists before writing compatibility fields", () => {
    const roles = normalizeAssignableAccessRoles(
      ["USER", "FINANCE_USER", "FINANCE_ADMIN", "ADMIN_BOOKINGS", "USER"],
      { canLogin: true },
    );

    expect(roles).toEqual(["USER", "FINANCE_ADMIN", "ADMIN_BOOKINGS"]);
    expect(legacyRoleFromAccessRoles(roles)).toBe("USER");
  });

  it("projects a runtime authorization role from access role rows only", () => {
    expect(
      authorizationRoleFromAccessRoles({
        canLogin: true,
        role: "USER",
        accessRoles: [{ role: "ADMIN" }],
      }),
    ).toBe("ADMIN");
    expect(
      authorizationRoleFromAccessRoles({
        canLogin: true,
        role: "ADMIN",
        accessRoles: [{ role: "USER" }],
      }),
    ).toBe("USER");
    expect(
      authorizationRoleFromAccessRoles({
        canLogin: true,
        role: "ADMIN",
        financeAccessLevel: "MANAGER",
        accessRoles: [],
      }),
    ).toBe("USER");
  });

  it("does not project bundled admin roles into the legacy full-admin role", () => {
    expect(legacyRoleFromAccessRoles(["ADMIN_READONLY"])).toBe("USER");
    expect(legacyRoleFromAccessRoles(["ADMIN_BOOKINGS"])).toBe("USER");
    expect(authorizationRoleFromAccessRoles({
      canLogin: true,
      accessRoles: [{ role: "ADMIN_MEMBERSHIP" }],
    })).toBe("USER");
  });

  it("clears access roles for non-login records", () => {
    expect(
      normalizeAssignableAccessRoles(["USER", "FINANCE_ADMIN"], {
        canLogin: false,
      }),
    ).toEqual([]);
  });
});

describe("definition-backed role tokens", () => {
  const customRow = {
    role: null,
    roleDefinitionId: "ardef_custom",
  };

  it("keeps custom-role rows as definition-id tokens", () => {
    expect(
      resolveAccessRoleTokens({
        accessRoles: [{ role: "USER" }, customRow],
        canLogin: true,
      }),
    ).toEqual(["USER", "ardef_custom"]);
    expect(
      resolveAccessRoleTokens({
        accessRoles: [{ role: "USER" }, customRow],
        canLogin: false,
      }),
    ).toEqual([]);
  });

  it("counts members holding only a custom role as privileged", () => {
    expect(
      hasPrivilegedAccess({ accessRoles: [customRow], canLogin: true }),
    ).toBe(true);
    expect(
      hasPrivilegedAccess({
        accessRoles: [{ role: "USER" }],
        canLogin: true,
      }),
    ).toBe(false);
  });

  it("includes definition tokens in the stored-role Full Admin gate", () => {
    expect(
      storedAccessRolesForFullAdminGate({
        accessRoles: [customRow],
        role: "USER",
        financeAccessLevel: "NONE",
      }),
    ).toContain("ardef_custom");
  });

  it("requires Full Admin to grant or revoke a custom role", () => {
    expect(accessRoleChangeRequiresFullAdmin(["USER"], ["USER", "ardef_custom"])).toBe(
      true,
    );
    expect(
      accessRoleChangeRequiresFullAdmin(
        ["USER", "ardef_custom"],
        ["USER", "ardef_custom"],
      ),
    ).toBe(false);
    expect(accessRoleChangeRequiresFullAdmin(["USER"], ["USER", "ORG"])).toBe(
      false,
    );
  });

  it("normalizes token lists with the legacy finance rule and canLogin clearing", () => {
    expect(
      normalizeAssignableAccessRoleTokens(
        ["FINANCE_USER", "FINANCE_ADMIN", "ardef_custom", "ardef_custom"],
        { canLogin: true },
      ),
    ).toEqual(["FINANCE_ADMIN", "ardef_custom"]);
    expect(
      normalizeAssignableAccessRoleTokens(["ADMIN"], { canLogin: false }),
    ).toEqual([]);
  });
});

describe("derived user type (#1439)", () => {
  it("classifies plain users, including token-less non-login records", () => {
    expect(deriveUserType(["USER"])).toBe("user");
    expect(deriveUserType([])).toBe("user");
    expect(deriveUserType(["USER"], true)).toBe("user");
  });

  it("clears tokens for canLogin=false, matching resolveAccessRoleTokens", () => {
    expect(deriveUserType(["ADMIN"], false)).toBe("user");
    expect(deriveUserType(["ORG"], false)).toBe("user");
  });

  it("classifies organisations", () => {
    expect(deriveUserType(["ORG"])).toBe("organisation");
    expect(deriveUserType(["ORG"], true)).toBe("organisation");
  });

  it("classifies any privileged token as admin, including finance-only and custom definitions", () => {
    expect(deriveUserType(["USER", "ADMIN"])).toBe("admin");
    expect(deriveUserType(["ADMIN_BOOKINGS"])).toBe("admin");
    expect(deriveUserType(["FINANCE_ADMIN"])).toBe("admin");
    expect(deriveUserType(["USER", "ardef_custom"])).toBe("admin");
  });

  it("treats an org holding a privileged role as admin (invalid state surfaces, not hides)", () => {
    expect(deriveUserType(["ORG", "ADMIN"])).toBe("admin");
  });

  it("classifies lodge kiosk accounts, with privileged roles taking precedence", () => {
    expect(deriveUserType(["LODGE"])).toBe("lodge");
    expect(deriveUserType(["USER", "LODGE"])).toBe("lodge");
    expect(deriveUserType(["LODGE", "ADMIN"])).toBe("admin");
  });
});

describe("user type token mapping (#1439)", () => {
  it("maps user and organisation to single-token classifications", () => {
    expect(accessRoleTokensForUserType("user", ["USER", "ADMIN"])).toEqual([
      "USER",
    ]);
    expect(
      accessRoleTokensForUserType("organisation", ["USER", "FINANCE_ADMIN"]),
    ).toEqual(["ORG"]);
  });

  it("keeps privileged tokens and holds USER by default when switching to admin", () => {
    expect(
      accessRoleTokensForUserType("admin", ["USER", "ADMIN", "FINANCE_ADMIN"]),
    ).toEqual(["USER", "ADMIN", "FINANCE_ADMIN"]);
    expect(accessRoleTokensForUserType("admin", ["USER"])).toEqual(["USER"]);
  });

  it("drops USER when the member is admin-only, and ORG always (orgs cannot hold admin roles)", () => {
    expect(
      accessRoleTokensForUserType("admin", ["USER", "ADMIN"], {
        alsoClubMember: false,
      }),
    ).toEqual(["ADMIN"]);
    expect(accessRoleTokensForUserType("admin", ["ORG", "ADMIN"])).toEqual([
      "USER",
      "ADMIN",
    ]);
  });

  it("keeps definition-id custom role tokens across the admin mapping", () => {
    expect(
      accessRoleTokensForUserType("admin", ["USER", "ardef_custom"], {
        alsoClubMember: false,
      }),
    ).toEqual(["ardef_custom"]);
  });

  it("composes with normalizeAssignableAccessRoleTokens for the wire format", () => {
    expect(
      normalizeAssignableAccessRoleTokens(
        accessRoleTokensForUserType("admin", [
          "USER",
          "FINANCE_USER",
          "FINANCE_ADMIN",
        ]),
        { canLogin: true },
      ),
    ).toEqual(["USER", "FINANCE_ADMIN"]);
  });
});
