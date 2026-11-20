import {
  isOrganisationMember,
  resolveAccessRoleTokens,
} from "@/lib/access-roles";
import type { AdminPermissionInput } from "@/lib/admin-permissions";

/**
 * Is this signed-in account an organisation (a school or similar group) rather
 * than a club member? The ONE body for the question every member-only surface
 * asks of a session user (INV-SSOT): the events calendar (#2241) and food orders
 * (fork #121) both route here.
 *
 * `session.user` carries both `accessRoles` and the legacy `role` claim, so the
 * real call sites decide correctly; an input with neither is not an
 * organisation. The classification itself is `isOrganisationMember`.
 */
export function isOrganisationAccount(input: AdminPermissionInput): boolean {
  return isOrganisationMember({
    accessRoleTokens: resolveAccessRoleTokens(input),
    legacyRole: typeof input.role === "string" ? input.role : null,
  });
}
