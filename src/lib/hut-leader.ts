import { prisma } from "./prisma";

/**
 * Check if a member has an active hut leader assignment for the given date.
 */
export async function isHutLeader(
  memberId: string,
  date: Date
): Promise<boolean> {
  const count = await prisma.hutLeaderAssignment.count({
    where: {
      memberId,
      startDate: { lte: date },
      endDate: { gte: date },
    },
  });
  return count > 0;
}

/**
 * Check if a member has any active hut leader assignment (today or future).
 * Used for showing the "Hut Leader" nav link.
 */
export async function hasActiveHutLeaderAssignment(
  memberId: string
): Promise<boolean> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const count = await prisma.hutLeaderAssignment.count({
    where: {
      memberId,
      endDate: { gte: today },
    },
  });
  return count > 0;
}
