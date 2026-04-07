import { prisma } from "./prisma";
import logger from "./logger";

export interface SuggestedFamilyGroup {
  suggestedName: string;
  reason: string;
  score: number; // Higher = more confident
  members: Array<{
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    ageTier: string;
    canLogin: boolean;
    xeroContactId: string | null;
  }>;
}

/**
 * Suggest family groups from ungrouped members.
 *
 * Scoring:
 * - Same email address: 10 pts (very high confidence — likely parent + dependents)
 * - Same last name among ungrouped members: 3 pts (lower confidence)
 *
 * Only suggests groups with 2+ members. Members already in a family group are excluded.
 */
export async function suggestFamilyGroups(): Promise<{
  suggestions: SuggestedFamilyGroup[];
  ungroupedCount: number;
  totalMembers: number;
}> {
  // Get all active members with their family group status
  const allMembers = await prisma.member.findMany({
    where: { active: true },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      ageTier: true,
      canLogin: true,
      xeroContactId: true,
      familyGroupMemberships: { select: { familyGroupId: true } },
    },
  });

  const totalMembers = allMembers.length;

  // Filter to ungrouped members only
  const ungrouped = allMembers.filter(
    (m) => m.familyGroupMemberships.length === 0
  );
  const ungroupedCount = ungrouped.length;

  if (ungrouped.length < 2) {
    return { suggestions: [], ungroupedCount, totalMembers };
  }

  const suggestions: SuggestedFamilyGroup[] = [];
  const assignedMemberIds = new Set<string>();

  // Pass 1: Group by shared email (score 10)
  const emailGroups = new Map<string, typeof ungrouped>();
  for (const m of ungrouped) {
    const email = m.email.toLowerCase();
    if (!emailGroups.has(email)) {
      emailGroups.set(email, []);
    }
    emailGroups.get(email)!.push(m);
  }

  for (const [email, members] of emailGroups) {
    if (members.length < 2) continue;

    // Determine group name from the most common last name
    const lastNameCounts = new Map<string, number>();
    for (const m of members) {
      const ln = m.lastName;
      lastNameCounts.set(ln, (lastNameCounts.get(ln) || 0) + 1);
    }
    const commonLastName = [...lastNameCounts.entries()].sort(
      (a, b) => b[1] - a[1]
    )[0][0];

    suggestions.push({
      suggestedName: `${commonLastName} Family`,
      reason: `${members.length} members share email ${email}`,
      score: 10,
      members: members.map((m) => ({
        id: m.id,
        firstName: m.firstName,
        lastName: m.lastName,
        email: m.email,
        ageTier: m.ageTier,
        canLogin: m.canLogin,
        xeroContactId: m.xeroContactId,
      })),
    });

    for (const m of members) {
      assignedMemberIds.add(m.id);
    }
  }

  // Pass 2: Group remaining ungrouped members by last name (score 3)
  const remainingUngrouped = ungrouped.filter(
    (m) => !assignedMemberIds.has(m.id)
  );
  const lastNameGroups = new Map<string, typeof remainingUngrouped>();
  for (const m of remainingUngrouped) {
    const ln = m.lastName.toLowerCase();
    if (!lastNameGroups.has(ln)) {
      lastNameGroups.set(ln, []);
    }
    lastNameGroups.get(ln)!.push(m);
  }

  for (const [, members] of lastNameGroups) {
    if (members.length < 2) continue;

    suggestions.push({
      suggestedName: `${members[0].lastName} Family`,
      reason: `${members.length} ungrouped members share last name "${members[0].lastName}"`,
      score: 3,
      members: members.map((m) => ({
        id: m.id,
        firstName: m.firstName,
        lastName: m.lastName,
        email: m.email,
        ageTier: m.ageTier,
        canLogin: m.canLogin,
        xeroContactId: m.xeroContactId,
      })),
    });
  }

  // Sort: highest score first, then by member count
  suggestions.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return b.members.length - a.members.length;
  });

  logger.info(
    { suggestions: suggestions.length, ungroupedCount, totalMembers },
    "Family group suggestions generated"
  );

  return { suggestions, ungroupedCount, totalMembers };
}

/**
 * Create a family group from a suggestion.
 * Sets the first canLogin adult as ADMIN, rest as MEMBER.
 */
export async function createFamilyGroupFromSuggestion(
  name: string,
  memberIds: string[]
): Promise<{ groupId: string; memberCount: number }> {
  if (memberIds.length < 2) {
    throw new Error("A family group must have at least 2 members");
  }

  // Verify all members exist and are active
  const members = await prisma.member.findMany({
    where: { id: { in: memberIds }, active: true },
    select: { id: true, canLogin: true, ageTier: true },
  });

  if (members.length !== memberIds.length) {
    throw new Error("Some members not found or inactive");
  }

  // Pick the lead: first canLogin adult, else first canLogin member, else first member
  const lead =
    members.find((m) => m.canLogin && m.ageTier === "ADULT") ??
    members.find((m) => m.canLogin) ??
    members[0];

  const group = await prisma.$transaction(async (tx) => {
    const newGroup = await tx.familyGroup.create({ data: { name } });

    await tx.familyGroupMember.createMany({
      data: members.map((m) => ({
        familyGroupId: newGroup.id,
        memberId: m.id,
        role: m.id === lead.id ? "ADMIN" : "MEMBER",
      })),
      skipDuplicates: true,
    });

    return newGroup;
  });

  return { groupId: group.id, memberCount: members.length };
}
