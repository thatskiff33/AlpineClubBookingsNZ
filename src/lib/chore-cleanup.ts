/**
 * CHR-01: Chore cleanup on booking date changes.
 *
 * Deletes SUGGESTED ChoreAssignment records for dates no longer in the booking
 * range. CONFIRMED and COMPLETED assignments are NOT auto-deleted; instead they
 * are returned as warnings for admin attention.
 */

import type { PrismaClient } from "@prisma/client";

type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

export interface ChoreCleanupResult {
  deletedCount: number;
  choreWarnings: string[];
}

/**
 * Clean up chore assignments when booking dates change.
 *
 * @param tx - Prisma transaction client
 * @param bookingId - The booking whose dates changed
 * @param newCheckIn - New check-in date
 * @param newCheckOut - New check-out date
 * @returns Count of deleted assignments and warnings for non-deletable ones
 */
export async function cleanupChoreAssignmentsForDateChange(
  tx: Tx,
  bookingId: string,
  newCheckIn: Date,
  newCheckOut: Date
): Promise<ChoreCleanupResult> {
  const choreWarnings: string[] = [];
  let deletedCount = 0;

  // Find assignments outside the new date range
  const outOfRangeAssignments = await tx.choreAssignment.findMany({
    where: {
      bookingId,
      OR: [{ date: { lt: newCheckIn } }, { date: { gte: newCheckOut } }],
    },
    include: { choreTemplate: true },
  });

  for (const assignment of outOfRangeAssignments) {
    if (assignment.status === "SUGGESTED") {
      await tx.choreAssignment.delete({ where: { id: assignment.id } });
      deletedCount++;
    } else {
      choreWarnings.push(
        `${assignment.choreTemplate.name} on ${assignment.date.toISOString().split("T")[0]} is ${assignment.status} and was not auto-removed`
      );
    }
  }

  return { deletedCount, choreWarnings };
}
