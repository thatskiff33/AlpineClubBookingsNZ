import "server-only";

/**
 * Who last changed a settings singleton, for the admin panels that show it
 * (club format, club timezone, environment safety).
 */

import { prisma } from "@/lib/prisma";

/**
 * Name fields ONLY. A panel says WHO last changed the setting, so it needs a
 * display name and nothing else: selecting the email, or the whole row, would
 * put a contact address into a configuration payload with no use for one.
 */
const MEMBER_NAME_SELECT = {
  firstName: true,
  lastName: true,
} as const;

/**
 * The display name of the member who last saved, or `null`. Defensive because
 * the column carries no foreign key (the house shape for a settings singleton),
 * so the member may since have been merged or deleted: a missing member, a blank
 * name and an unreachable database all mean "we cannot name them", never a
 * failed read of the setting.
 */
export async function readChangedByName(
  memberId: string | null,
): Promise<string | null> {
  if (!memberId) return null;
  try {
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: MEMBER_NAME_SELECT,
    });
    if (!member) return null;
    return `${member.firstName} ${member.lastName}`.trim() || null;
  } catch {
    return null;
  }
}
