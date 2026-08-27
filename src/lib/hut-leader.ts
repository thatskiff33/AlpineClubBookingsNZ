import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
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
  // The club's own day, date-only, matching
  // hasCurrentOrUpcomingHutLeaderAssignment in lodge-instructions.ts so nav
  // visibility and reader access agree (#3123).
  const today = await clubTodayDateOnlyInstant();
  const count = await prisma.hutLeaderAssignment.count({
    where: {
      memberId,
      endDate: { gte: today },
    },
  });
  return count > 0;
}
