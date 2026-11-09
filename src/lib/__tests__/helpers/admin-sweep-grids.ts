import {
  ADMIN_PERMISSION_AREAS,
  type AdminPermissionArea,
} from "@/lib/admin-permissions";
import {
  accessRoleDefinitionGrid,
  type AccessRoleDefinitionGrid,
  type AccessRoleGridLevel,
} from "@/lib/__tests__/helpers/access-role-definition-grid";

/**
 * THE SIXTEEN SWEEP GRIDS, in one place (#4799).
 *
 * `admin-route-authorization-proof.test.ts` puts every admin path to the real
 * guards for these grids, and `admin-hub-route-parity.test.ts` proves a hub path
 * answers exactly as its old path for the same grids. Both must mean the same
 * sixteen, so neither writes its own.
 *
 * Built from explicit per-area levels rather than from the shipped bundles, so
 * an edit to a bundle cannot quietly change what a sweep proves.
 */

export type Grid = {
  label: string;
  /** The shape both guards read off the mocked `member` row. */
  member: {
    id: string;
    role: "ADMIN" | "USER";
    active: boolean;
    canLogin: boolean;
    forcePasswordChange: boolean;
    twoFactorEnabled: boolean;
    accessRoles: Array<{
      role: string | null;
      roleDefinitionId: string | null;
      roleDefinition: AccessRoleDefinitionGrid | null;
    }>;
  };
};

export function customGrid(
  label: string,
  levels: Partial<Record<`${AdminPermissionArea}Level`, AccessRoleGridLevel>>,
): Grid {
  return {
    label,
    member: {
      id: "member-1",
      role: "USER",
      active: true,
      canLogin: true,
      forcePasswordChange: false,
      twoFactorEnabled: false,
      accessRoles: [
        {
          role: null,
          roleDefinitionId: "ardef_grid",
          roleDefinition: accessRoleDefinitionGrid(levels),
        },
      ],
    },
  };
}

export const FULL_ADMIN: Grid = {
  label: "Full Admin",
  member: {
    id: "member-1",
    role: "ADMIN",
    active: true,
    canLogin: true,
    forcePasswordChange: false,
    twoFactorEnabled: false,
    accessRoles: [
      { role: "ADMIN", roleDefinitionId: null, roleDefinition: null },
    ],
  },
};

export const PLAIN_MEMBER: Grid = {
  label: "plain member",
  member: {
    id: "member-1",
    role: "USER",
    active: true,
    canLogin: true,
    forcePasswordChange: false,
    twoFactorEnabled: false,
    accessRoles: [
      { role: "USER", roleDefinitionId: null, roleDefinition: null },
    ],
  },
};

/** One grid per area at `view`, and one per area at `edit`. */
export const AREA_GRIDS: Array<{
  area: AdminPermissionArea;
  level: "view" | "edit";
  grid: Grid;
}> = ADMIN_PERMISSION_AREAS.map((area) => area.key).flatMap((area) =>
  (["view", "edit"] as const).map((level) => ({
    area,
    level,
    grid: customGrid(`${area}:${level} only`, {
      [`${area}Level`]: level === "view" ? "VIEW" : "EDIT",
    }),
  })),
);

/**
 * The sixteen grids every sweep runs: fourteen single-area holders (seven areas
 * at `view`, seven at `edit`), a Full Admin and a plain member.
 */
export const SWEEP_GRIDS: Grid[] = [
  FULL_ADMIN,
  PLAIN_MEMBER,
  ...AREA_GRIDS.map((entry) => entry.grid),
];
