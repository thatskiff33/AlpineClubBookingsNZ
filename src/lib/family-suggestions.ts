import { prisma } from "./prisma";
import logger from "./logger";
import { formatMemberIdentityAge } from "@/lib/member-age";
import { clubTime } from "@/lib/club-time/server";

export interface SuggestedFamilyGroup {
  signature: string;
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
    /**
     * #2568: calculated age, for the duplicate-prevention decision this screen
     * exists to support — creating a group here binds specific member records
     * together, and two ungrouped people who share a surname and an email are
     * exactly the case where a parent and a child get confused. Server-side
     * only; the stored date of birth is never returned.
     */
    ageLabel: string;
  }>;
}

export class FamilySuggestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FamilySuggestionError";
  }
}

function normalizeFamilySuggestionMemberIds(memberIds: string[]): string[] {
  return [...new Set(memberIds.map((id) => id.trim()).filter(Boolean))].sort();
}

export function buildFamilySuggestionSignature(memberIds: string[]): string {
  const sortedMemberIds = normalizeFamilySuggestionMemberIds(memberIds);
  if (sortedMemberIds.length < 2) {
    throw new FamilySuggestionError("A family suggestion must include at least 2 unique members");
  }
  return sortedMemberIds.join("|");
}

function withSignature(
  suggestion: Omit<SuggestedFamilyGroup, "signature">
): SuggestedFamilyGroup {
  return {
    ...suggestion,
    signature: buildFamilySuggestionSignature(
      suggestion.members.map((member) => member.id)
    ),
  };
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
  hiddenCount: number;
}> {
  // #3123: one club "today" for every suggestion on the screen. The age label
  // is what an administrator uses to tell a parent from a child before binding
  // records together (#2568), so all of them are judged against the same day —
  // and against the CLUB's day, not the container's. Measured: this module is
  // reachable from no CLI entry point and no instrumentation edge, so the
  // request-scoped `server-only` reader applies.
  const clubDay = (await clubTime()).today();
  const [allMembers, hiddenSuggestions] = await Promise.all([
    prisma.member.findMany({
      where: { active: true },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        ageTier: true,
        canLogin: true,
        xeroContactId: true,
        // #2568: read to calculate `ageLabel`; never returned as-is.
        dateOfBirth: true,
        familyGroupMemberships: { select: { familyGroupId: true } },
      },
    }),
    prisma.hiddenFamilySuggestion.findMany({
      select: { signature: true },
    }),
  ]);
  const hiddenSignatures = new Set(
    hiddenSuggestions.map((hidden) => hidden.signature)
  );
  const hiddenCount = hiddenSignatures.size;

  const totalMembers = allMembers.length;

  // Filter to ungrouped members only
  const ungrouped = allMembers.filter(
    (m) => m.familyGroupMemberships.length === 0
  );
  const ungroupedCount = ungrouped.length;

  if (ungrouped.length < 2) {
    return { suggestions: [], ungroupedCount, totalMembers, hiddenCount };
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

    const suggestion = withSignature({
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
        ageLabel: formatMemberIdentityAge(m.dateOfBirth, clubDay),
      })),
    });

    if (!hiddenSignatures.has(suggestion.signature)) {
      suggestions.push(suggestion);

      for (const m of members) {
        assignedMemberIds.add(m.id);
      }
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

    suggestions.push(
      withSignature({
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
          ageLabel: formatMemberIdentityAge(m.dateOfBirth, clubDay),
        })),
      })
    );
  }

  const visibleSuggestions = suggestions.filter(
    (suggestion) => !hiddenSignatures.has(suggestion.signature)
  );

  // Sort: highest score first, then by member count
  visibleSuggestions.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return b.members.length - a.members.length;
  });

  logger.info(
    {
      suggestions: visibleSuggestions.length,
      hiddenCount,
      ungroupedCount,
      totalMembers,
    },
    "Family group suggestions generated"
  );

  return {
    suggestions: visibleSuggestions,
    ungroupedCount,
    totalMembers,
    hiddenCount,
  };
}

export async function hideFamilySuggestion(
  memberIds: string[],
  hiddenByMemberId: string
): Promise<{ signature: string; memberIds: string[] }> {
  const sortedMemberIds = normalizeFamilySuggestionMemberIds(memberIds);
  const signature = buildFamilySuggestionSignature(sortedMemberIds);

  const activeMembers = await prisma.member.findMany({
    where: { id: { in: sortedMemberIds }, active: true },
    select: { id: true },
  });
  if (activeMembers.length !== sortedMemberIds.length) {
    throw new FamilySuggestionError("Some members not found or inactive");
  }

  await prisma.hiddenFamilySuggestion.upsert({
    where: { signature },
    create: {
      signature,
      memberIds: sortedMemberIds,
      hiddenByMemberId,
    },
    update: {
      memberIds: sortedMemberIds,
      hiddenByMemberId,
    },
  });

  return { signature, memberIds: sortedMemberIds };
}

export async function resetHiddenFamilySuggestions(): Promise<{
  count: number;
}> {
  const result = await prisma.hiddenFamilySuggestion.deleteMany();
  return { count: result.count };
}

/**
 * Create a family group from a suggestion. Every suggested member is added as a
 * plain membership: #2520 removed the "pick a lead and mark them ADMIN" step,
 * because the `FamilyGroupMember.role` column it wrote granted nothing (#2284)
 * and 20260803030000 has since dropped the column. There is no rank to assign.
 */
export async function createFamilyGroupFromSuggestion(
  name: string,
  memberIds: string[]
): Promise<{ groupId: string; memberCount: number }> {
  if (memberIds.length < 2) {
    throw new FamilySuggestionError("A family group must have at least 2 members");
  }

  // Verify all members exist and are active
  const members = await prisma.member.findMany({
    where: { id: { in: memberIds }, active: true },
    select: { id: true, canLogin: true, ageTier: true },
  });

  if (members.length !== memberIds.length) {
    throw new FamilySuggestionError("Some members not found or inactive");
  }

  const group = await prisma.$transaction(async (tx) => {
    const newGroup = await tx.familyGroup.create({ data: { name } });

    await tx.familyGroupMember.createMany({
      // #2520: no `role` is written, so nothing here distinguishes one member
      // from another. The lead-picking that used to precede this block existed
      // ONLY to choose who got role "ADMIN" — the group's name is a parameter
      // and never depended on it — so it went with the write.
      data: members.map((m) => ({
        familyGroupId: newGroup.id,
        memberId: m.id,
      })),
      skipDuplicates: true,
    });

    return newGroup;
  });

  return { groupId: group.id, memberCount: members.length };
}
