import { z } from "zod";
import type { Prisma } from "@prisma/client";
import {
  ADMIN_PERMISSION_LEVELS,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";
import type { AccessRoleDefinitionRecord } from "@/lib/access-role-definitions";

/** Zod schema for the seven-area permission matrix in app levels. */
export const accessRolePermissionsSchema = z
  .object({
    overview: z.enum(ADMIN_PERMISSION_LEVELS),
    bookings: z.enum(ADMIN_PERMISSION_LEVELS),
    membership: z.enum(ADMIN_PERMISSION_LEVELS),
    finance: z.enum(ADMIN_PERMISSION_LEVELS),
    lodge: z.enum(ADMIN_PERMISSION_LEVELS),
    content: z.enum(ADMIN_PERMISSION_LEVELS),
    support: z.enum(ADMIN_PERMISSION_LEVELS),
  })
  .strict();

/**
 * The role editor's two-factor choice (#4618): null is Default, true is
 * Required, false is Not required. Optional, so an older page still saves.
 */
export const accessRoleRequiresTwoFactorSchema = z.boolean().nullable().optional();

const LEVEL_TO_DB = {
  none: "NONE",
  view: "VIEW",
  edit: "EDIT",
} as const;

/** App-level permissions object -> AccessRoleDefinition level columns. */
export function definitionLevelDataFromPermissions(
  permissions: AdminPermissionMatrix,
) {
  return {
    overviewLevel: LEVEL_TO_DB[permissions.overview],
    bookingsLevel: LEVEL_TO_DB[permissions.bookings],
    membershipLevel: LEVEL_TO_DB[permissions.membership],
    financeLevel: LEVEL_TO_DB[permissions.finance],
    lodgeLevel: LEVEL_TO_DB[permissions.lodge],
    contentLevel: LEVEL_TO_DB[permissions.content],
    supportLevel: LEVEL_TO_DB[permissions.support],
  };
}

type MemberAccessRoleCounter = {
  memberAccessRole: Pick<
    Prisma.TransactionClient["memberAccessRole"],
    "findMany"
  >;
};

/**
 * Holder counts per definition. Counts distinct members holding the
 * definition via the link OR via a bare enum row for its systemRole (rows
 * written before backfill/re-link), so delete guards never undercount.
 */
export async function accessRoleDefinitionHolderCounts(
  db: MemberAccessRoleCounter,
  definitions: ReadonlyArray<AccessRoleDefinitionRecord>,
): Promise<Map<string, number>> {
  const systemRoles = definitions
    .map((definition) => definition.systemRole)
    .filter((role): role is NonNullable<typeof role> => role !== null);

  const rows = await db.memberAccessRole.findMany({
    where: {
      OR: [
        { roleDefinitionId: { in: definitions.map(({ id }) => id) } },
        ...(systemRoles.length > 0 ? [{ role: { in: systemRoles } }] : []),
      ],
    },
    select: { memberId: true, role: true, roleDefinitionId: true },
  });

  const holders = new Map<string, Set<string>>();
  const bySystemRole = new Map(
    definitions
      .filter((definition) => definition.systemRole)
      .map((definition) => [definition.systemRole, definition.id] as const),
  );

  for (const row of rows) {
    const definitionId =
      row.roleDefinitionId ??
      (row.role ? (bySystemRole.get(row.role) ?? null) : null);
    if (!definitionId) continue;
    const set = holders.get(definitionId) ?? new Set<string>();
    set.add(row.memberId);
    holders.set(definitionId, set);
  }

  return new Map(
    [...holders.entries()].map(([definitionId, members]) => [
      definitionId,
      members.size,
    ]),
  );
}
