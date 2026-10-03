import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { prisma } from "./prisma";
import {
  hutLeaderAccessWindowCoversDayWhere,
  hutLeaderAccessWindowNotClosedByWhere,
} from "./hut-leader-access-window";

/**
 * Is the member inside a hut-leader assignment's ACCESS window on `date` — from
 * the day before its first night to the day after its last (#3817)? `date` is a
 * date-only club calendar day.
 */
export async function isHutLeader(
  memberId: string,
  date: Date
): Promise<boolean> {
  const count = await prisma.hutLeaderAssignment.count({
    where: {
      memberId,
      ...hutLeaderAccessWindowCoversDayWhere(date),
    },
  });
  return count > 0;
}

/**
 * Check if a member has any current or upcoming hut leader assignment — one
 * whose access window, which runs to the departure day, has not closed (#3817).
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
      ...hutLeaderAccessWindowNotClosedByWhere(today),
    },
  });
  return count > 0;
}
