/**
 * The role-to-hubs rule (epic #4468, C14 #4811).
 *
 * Pinned against the seeded definitions, not the legacy bundles: a club that
 * edits a definition changes that role's menu, and this table is the default
 * before any edit. Full Admin is not a definition; its matrix is the hardcoded
 * bundle.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_ACCESS_ROLE_DEFINITIONS } from "@/lib/access-role-definitions";
import type { PrivilegeCheckInput } from "@/lib/access-roles";
import { ADMIN_HUBS } from "@/lib/admin-hubs";
import {
  emptyAdminPermissionMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";
import {
  hubsForRoleMatrix,
  parseMenuRoleCookie,
  resolveAdminMenu,
} from "@/lib/admin-menu-role";

const HUB_LABELS: Record<string, readonly string[]> = {
  ADMIN: [
    "Home",
    "Bookings",
    "Fees & booking rules",
    "Finance",
    "Members",
    "Lodge",
    "Website",
    "Messages & email",
    "Help & system",
    "Club settings",
  ],
  ADMIN_READONLY: [
    "Home",
    "Bookings",
    "Fees & booking rules",
    "Finance",
    "Members",
    "Lodge",
    "Website",
    "Messages & email",
    "Help & system",
    "Club settings",
  ],
  ADMIN_BOOKINGS: ["Home", "Bookings", "Fees & booking rules", "Lodge"],
  ADMIN_MEMBERSHIP: ["Home", "Members", "Lodge", "Messages & email"],
  ADMIN_CONTENT: ["Home", "Website"],
  FINANCE_ADMIN: ["Home", "Fees & booking rules", "Finance", "Club settings"],
  FINANCE_USER: ["Fees & booking rules", "Finance", "Club settings"],
};

function labels(keys: readonly string[]): string[] {
  const byKey = new Map<string, string>(
    ADMIN_HUBS.map((hub) => [hub.key, hub.label]),
  );
  return keys.map((key) => byKey.get(key) ?? key);
}

function memberWith(
  roles: PrivilegeCheckInput["accessRoles"],
): PrivilegeCheckInput {
  return { canLogin: true, accessRoles: roles };
}

function definedRole(systemRole: string) {
  const definition = DEFAULT_ACCESS_ROLE_DEFINITIONS.find(
    (row) => row.systemRole === systemRole,
  );
  if (!definition) throw new Error(`no seeded definition for ${systemRole}`);
  return memberWith([{ role: definition.systemRole, roleDefinition: definition }]);
}

describe("hubs for each seeded admin role", () => {
  it("gives Full Admin every hub", () => {
    const menu = resolveAdminMenu(
      memberWith([{ role: "ADMIN" }]),
      null,
    );
    expect(labels(menu.hubKeys)).toEqual(HUB_LABELS.ADMIN);
    expect(menu.roles.map((role) => role.label)).toEqual(["Full Admin"]);
  });

  it.each(DEFAULT_ACCESS_ROLE_DEFINITIONS.map((row) => row.systemRole))(
    "pins the %s menu to the seeded table",
    (systemRole) => {
      const menu = resolveAdminMenu(definedRole(systemRole), null);
      expect(labels(menu.hubKeys)).toEqual(HUB_LABELS[systemRole]);
    },
  );

  it("leaves Home out when overview is none, even if something is editable", () => {
    const matrix: AdminPermissionMatrix = {
      ...emptyAdminPermissionMatrix(),
      finance: "edit",
    };
    expect(labels(hubsForRoleMatrix(matrix))).toEqual([
      "Fees & booking rules",
      "Finance",
      "Club settings",
    ]);
  });

  it("uses the view fallback when the role can edit nothing", () => {
    const matrix: AdminPermissionMatrix = {
      ...emptyAdminPermissionMatrix(),
      finance: "view",
    };
    expect(labels(hubsForRoleMatrix(matrix))).toEqual(
      HUB_LABELS.FINANCE_USER,
    );
    expect(labels(hubsForRoleMatrix(emptyAdminPermissionMatrix()))).toEqual([]);
  });
});

describe("no choice, a stale choice, and a Full Admin's cookie", () => {
  const both = memberWith([
    {
      role: "ADMIN_BOOKINGS",
      roleDefinition: DEFAULT_ACCESS_ROLE_DEFINITIONS.find(
        (row) => row.systemRole === "ADMIN_BOOKINGS",
      ),
    },
    {
      role: "FINANCE_ADMIN",
      roleDefinition: DEFAULT_ACCESS_ROLE_DEFINITIONS.find(
        (row) => row.systemRole === "FINANCE_ADMIN",
      ),
    },
    { role: "USER" },
    { role: "LODGE" },
  ]);

  const union = [
    "Home",
    "Bookings",
    "Fees & booking rules",
    "Finance",
    "Lodge",
    "Club settings",
  ];

  it("unions the menus when nothing is chosen, and drops roles that edit and view nothing", () => {
    const menu = resolveAdminMenu(both, null);
    expect(labels(menu.hubKeys)).toEqual(union);
    expect(menu.selected).toBeNull();
    expect(menu.roles.map((role) => role.token)).toEqual([
      "ADMIN_BOOKINGS",
      "FINANCE_ADMIN",
    ]);
  });

  it("keeps the union for a stale, forged or empty cookie", () => {
    for (const cookie of [undefined, "", "ADMIN_CONTENT", "not-a-role", ";;;"]) {
      const menu = resolveAdminMenu(both, cookie);
      expect(labels(menu.hubKeys)).toEqual(union);
      expect(menu.selected).toBeNull();
    }
    expect(parseMenuRoleCookie("ADMIN_CONTENT", ["FINANCE_ADMIN"])).toBeNull();
    expect(parseMenuRoleCookie("FINANCE_ADMIN", ["FINANCE_ADMIN"])).toBe(
      "FINANCE_ADMIN",
    );
  });

  it("shows the chosen role's hubs, and a custom role under its own label", () => {
    const menu = resolveAdminMenu(both, "FINANCE_ADMIN");
    expect(labels(menu.hubKeys)).toEqual(HUB_LABELS.FINANCE_ADMIN);
    expect(menu.selected).toBe("FINANCE_ADMIN");

    const roleDefinition = {
      id: "ardef_custom",
      label: "Hut editor",
      contentLevel: "EDIT" as const,
      overviewLevel: "VIEW" as const,
    };
    const custom = resolveAdminMenu(
      memberWith([
        { role: null, roleDefinitionId: "ardef_custom", roleDefinition },
      ]),
      null,
    );
    expect(custom.roles).toEqual([
      { token: "ardef_custom", label: "Hut editor" },
    ]);
    expect(labels(custom.hubKeys)).toEqual(["Home", "Website"]);
  });

  it("ignores the cookie for a Full Admin and still shows every hub", () => {
    const menu = resolveAdminMenu(
      memberWith([{ role: "ADMIN" }, { role: "FINANCE_ADMIN" }]),
      "FINANCE_ADMIN",
    );
    expect(labels(menu.hubKeys)).toEqual(HUB_LABELS.ADMIN);
    expect(menu.selected).toBeNull();
  });
});
