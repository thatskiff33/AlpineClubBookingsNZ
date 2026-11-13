/**
 * The one admin writer that creates a family group with its members (#4988).
 *
 * Shared by the admin "create family group" route and the member CSV import's
 * Family Key column, so both name the same size limit and write the same rows.
 * Type-only Prisma imports keep the limit usable in the browser preview.
 */
import type { Prisma } from "@prisma/client";

/** The most members an administrator may put in one new family group. */
export const ADMIN_FAMILY_GROUP_MAX_MEMBERS = 10;

/** Longest family group name an administrator may set. */
export const ADMIN_FAMILY_GROUP_NAME_MAX_LENGTH = 200;

/**
 * Create the group and its memberships inside the caller's transaction. The
 * caller has already checked every member exists and is not archived, and
 * that there are at most {@link ADMIN_FAMILY_GROUP_MAX_MEMBERS} of them.
 */
export async function createFamilyGroupWithMembers(
  tx: Prisma.TransactionClient,
  { name, memberIds }: { name: string; memberIds: readonly string[] },
): Promise<{ id: string }> {
  const created = await tx.familyGroup.create({
    data: { name: name.trim() },
    select: { id: true },
  });

  await tx.familyGroupMember.createMany({
    data: memberIds.map((memberId) => ({
      familyGroupId: created.id,
      memberId,
    })),
    skipDuplicates: true,
  });

  return created;
}
