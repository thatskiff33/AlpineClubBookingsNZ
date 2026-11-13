/**
 * The server half of the member CSV import's Membership Type and Family Key
 * columns (#4988): judging each row's two values against the club's active
 * types and the file's family sizes, grouping the members an import created by
 * Family Key, and assigning their current-season type after commit. The
 * browser-safe comparisons live in `member-csv-import-type-family.ts`.
 */
import type { Prisma } from "@prisma/client";

import { createFamilyGroupWithMembers } from "@/lib/admin-family-group-create";
import { createAuditLog, getAuditRequestContext } from "@/lib/audit";
import logger from "@/lib/logger";
import {
  matchMemberImportMembershipType,
  normalizeMemberImportFamilyKey,
} from "@/lib/member-csv-import-type-family";
import { prisma } from "@/lib/prisma";

/**
 * One import row's Membership Type and Family Key, resolved: the matched
 * ACTIVE type's id and the normalised key. A refusal is pushed onto
 * `rowErrors`, which blocks the row.
 */
export function resolveImportTypeAndFamily({
  membershipType,
  familyKey,
  activeMembershipTypes,
  oversizedFamilyKeys,
  columnContext,
  rowErrors,
}: {
  membershipType: string | null | undefined;
  familyKey: string | null | undefined;
  activeMembershipTypes: ReadonlyArray<{ id: string; name: string }>;
  oversizedFamilyKeys: ReadonlyMap<string, string>;
  columnContext: (key: "membershipType" | "familyKey") => string;
  rowErrors: string[];
}): { membershipTypeId: string | null; familyKey: string | null } {
  let membershipTypeId: string | null = null;
  const membershipTypeInput = membershipType?.trim();
  if (membershipTypeInput) {
    const match = matchMemberImportMembershipType(membershipTypeInput, activeMembershipTypes);
    if (match.ok) {
      membershipTypeId = match.type.id;
    } else {
      rowErrors.push(`Membership Type${columnContext("membershipType")} ${match.error}`);
    }
  }

  const familyKeyInput = familyKey?.trim();
  const normalizedKey = familyKeyInput ? normalizeMemberImportFamilyKey(familyKeyInput) : null;
  const oversizedMessage = normalizedKey ? oversizedFamilyKeys.get(normalizedKey) : undefined;
  if (oversizedMessage) {
    rowErrors.push(`Family Key${columnContext("familyKey")} "${familyKeyInput}" ${oversizedMessage}`);
  }
  return { membershipTypeId, familyKey: normalizedKey };
}

/**
 * Inside the import's transaction: the members it created that share a
 * Family Key become one new family group, through the admin family-group
 * writer. Only rows this import created join, so a re-import of the same file
 * adds nothing. No partner or parent link is written. Returns how many groups.
 */
export async function createImportFamilyGroups(
  tx: Prisma.TransactionClient,
  created: ReadonlyArray<{ id: string; lastName: string; familyKey: string | null }>,
  adminMemberId: string,
): Promise<number> {
  const familyMembersByKey = new Map<string, Array<(typeof created)[number]>>();
  for (const member of created) {
    if (!member.familyKey) continue;
    familyMembersByKey.set(member.familyKey, [...(familyMembersByKey.get(member.familyKey) ?? []), member]);
  }
  let familyGroupsCreated = 0;
  for (const familyMembers of familyMembersByKey.values()) {
    const [firstMember] = familyMembers;
    if (!firstMember) continue;
    const name = `${firstMember.lastName} Family`;
    const memberIds = familyMembers.map((member) => member.id);
    const group = await createFamilyGroupWithMembers(tx, { name, memberIds });
    familyGroupsCreated++;
    await createAuditLog(
      {
        action: "FAMILY_GROUP_CREATED",
        category: "family",
        memberId: adminMemberId,
        targetId: group.id,
        entityType: "FamilyGroup",
        entityId: group.id,
        summary: "Family group created by member import",
        details: JSON.stringify({ name, memberIds, source: "IMPORT" }),
      },
      tx,
    );
  }
  return familyGroupsCreated;
}

/**
 * After the import commits, give each member it created the current-season
 * membership type its row named, through the hardened save path (age
 * exemptions, audit). Mirrors the Xero import (#2108): an existing assignment
 * is never overwritten, and each save goes through the preview token and
 * `saveSeasonalMembershipAssignment` with source `IMPORT`. The members are
 * new, so they have no Xero contact to regroup and that sync is skipped. A
 * member imported as cancelled gets no assignment, only a row note.
 */
export async function assignImportedMembershipTypes({
  members: createdMembers,
  seasonYear,
  clubTodayDateOnly,
  adminMemberId,
  request,
}: {
  members: ReadonlyArray<{
    id: string;
    email: string;
    rowNum: number;
    membershipTypeId: string | null;
    cancelled: boolean;
  }>;
  seasonYear: number;
  clubTodayDateOnly: Date;
  adminMemberId: string;
  request: Request;
}) {
  const failures: Array<{ row: number; email: string; error: string }> = [];
  const rowNotes = createdMembers
    .filter((member) => member.membershipTypeId && member.cancelled)
    .map((member) => ({
      row: member.rowNum,
      email: member.email,
      note: "Membership Type not applied because the member was imported as cancelled",
    }));
  const members = createdMembers.filter((member) => member.membershipTypeId && !member.cancelled);
  let assigned = 0;
  if (members.length === 0) return { assigned, failures, rowNotes };
  const existing = await prisma.seasonalMembershipAssignment.findMany({
    where: { seasonYear, memberId: { in: members.map((member) => member.id) } },
    select: { memberId: true },
  });
  const alreadyAssigned = new Set(existing.map((row) => row.memberId));
  const { getSeasonalMembershipChangePreview, saveSeasonalMembershipAssignment } =
    await import("@/lib/seasonal-membership-assignments");

  for (const member of members) {
    const membershipTypeId = member.membershipTypeId;
    if (!membershipTypeId || alreadyAssigned.has(member.id)) continue;
    const fail = (error: string) =>
      failures.push({ row: member.rowNum, email: member.email, error });
    try {
      const previewResult = await getSeasonalMembershipChangePreview({
        memberId: member.id,
        seasonYear,
        membershipTypeId,
        now: clubTodayDateOnly,
        clubCurrentSeasonYear: seasonYear,
      });
      if (previewResult.init?.status && previewResult.init.status >= 400) {
        fail(
          (previewResult.body as { error?: string } | undefined)?.error ??
            "Failed to preview the membership type assignment",
        );
        continue;
      }
      const previewToken = (
        previewResult.body as { preview: { previewToken: string } }
      ).preview.previewToken;
      const saveResult = await saveSeasonalMembershipAssignment({
        memberId: member.id,
        seasonYear,
        membershipTypeId,
        adminMemberId,
        reason: "Member CSV import",
        previewToken,
        source: "IMPORT",
        skipXeroContactGroupSync: true,
        request: getAuditRequestContext(request),
      });
      if (saveResult.init?.status && saveResult.init.status >= 400) {
        fail(
          (saveResult.body as { error?: string } | undefined)?.error ??
            "Failed to save the membership type assignment",
        );
        continue;
      }
      assigned++;
    } catch (err) {
      logger.error(
        { err, memberId: member.id, membershipTypeId },
        "Failed to assign membership type during member import",
      );
      fail("Failed to save the membership type assignment");
    }
  }
  return { assigned, failures, rowNotes };
}
