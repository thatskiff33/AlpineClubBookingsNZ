import {
  ADMIN_PERMISSION_AREAS,
  type AdminPermissionArea,
} from "@/lib/admin-permissions";

/**
 * ONE ACCESS-ROLE-DEFINITION GRID BUILDER for the suites that need a member
 * holding an exact slice of the permission lattice (#2975).
 *
 * ## What it is for, and what it is NOT
 *
 * `helpers/admin-area-gate-sessions.ts` carries the SHIPPED role bundles —
 * `ADMIN_READONLY`, `ADMIN_CONTENT`, `FINANCE_ADMIN` — as session fixtures. Those
 * are the right tool for a route suite proving its own gate, because they are
 * what a club actually deploys. They cannot express "this member holds
 * `finance: view` and literally nothing else", which is what a sweep over the
 * whole route tree needs: a bundle carrying `overview: view` alongside its own
 * area admits half the tree for reasons that have nothing to do with the route
 * under test.
 *
 * So this builds a definition row directly, every area explicitly `NONE` unless
 * the caller names it.
 *
 * ## The baseline is DERIVED, not typed out
 *
 * `matrixFromAccessRoleDefinition` reads `${area.key}Level` for every area in
 * `ADMIN_PERMISSION_AREAS`. A hand-written baseline listing the seven columns is
 * a second statement of the same list, and the failure it produces is silent: add
 * an eighth area and the hand-written baseline leaves it `undefined` rather than
 * `NONE`, so a grid that was meant to hold one area holds an unset one too and
 * every "refused everywhere else" assertion quietly stops covering it.
 */

export type AccessRoleGridLevel = "NONE" | "VIEW" | "EDIT";

/** A definition row shaped as `MEMBER_ACCESS_ROLE_SELECT` joins it. */
export type AccessRoleDefinitionGrid = Record<string, AccessRoleGridLevel | string>;

/**
 * A definition row with every admin area at `NONE` except those named.
 *
 * @param levels the areas this grid holds, keyed by `${area}Level`
 * @param id the definition id, when a suite needs it to match a fixture
 */
export function accessRoleDefinitionGrid(
  levels: Partial<Record<`${AdminPermissionArea}Level`, AccessRoleGridLevel>>,
  id = "ardef_grid",
): AccessRoleDefinitionGrid {
  const baseline: AccessRoleDefinitionGrid = { id };
  for (const area of ADMIN_PERMISSION_AREAS) {
    baseline[`${area.key}Level`] = "NONE";
  }
  return { ...baseline, ...levels };
}
