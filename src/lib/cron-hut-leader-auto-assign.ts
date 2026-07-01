import { prisma } from "./prisma";
import { eachDayOfInterval, addDays } from "date-fns";
import { calculateOverlapDays } from "./hut-leader-overlap";
import { getNZSTToday } from "@/lib/nzst-date";
import { loadHutLeaderLookaheadDays } from "./lodge-settings";
import { loadEffectiveModuleFlags } from "./module-settings";
import logger from "./logger";

/**
 * Auto-assign hut leaders when only 1 adult member is booked for a date.
 * Uses the configured lookahead, finds dates without an assignment, and
 * auto-assigns if exactly 1 distinct adult member is staying. No-op when the
 * Hut leaders module is disabled.
 */
export async function autoAssignHutLeaders(): Promise<{
  assignedCount: number;
  assignedDates: string[];
}> {
  const modules = await loadEffectiveModuleFlags();
  if (!modules.hutLeaders) {
    return { assignedCount: 0, assignedDates: [] };
  }

  const lookAheadDays = await loadHutLeaderLookaheadDays();
  const today = getNZSTToday();
  const endDate = addDays(today, lookAheadDays);
  const days = eachDayOfInterval({ start: today, end: endDate });

  const assignedDates: string[] = [];

  for (const day of days) {
    // Check if there's already an assignment for this date
    const existingAssignment = await prisma.hutLeaderAssignment.findFirst({
      where: {
        startDate: { lte: day },
        endDate: { gte: day },
      },
    });

    if (existingAssignment) continue;

    // Find distinct adult members with PAID bookings for this date
    const nextDay = new Date(day);
    nextDay.setDate(nextDay.getDate() + 1);

    const bookingsForDate = await prisma.booking.findMany({
      where: {
        status: "PAID",
        checkIn: { lte: day },
        checkOut: { gt: day },
        guests: {
          some: {
            ageTier: "ADULT",
            isMember: true,
            memberId: { not: null },
            stayStart: { lte: day },
            stayEnd: { gt: day },
          },
        },
      },
      include: {
        guests: {
          where: {
            ageTier: "ADULT",
            isMember: true,
            memberId: { not: null },
            stayStart: { lte: day },
            stayEnd: { gt: day },
          },
          select: {
            memberId: true,
            stayStart: true,
            stayEnd: true,
            member: { select: { id: true, firstName: true, lastName: true, active: true } },
          },
        },
      },
    });

    // Collect distinct active adult members
    const adultMembers = new Map<string, {
      id: string;
      name: string;
      checkIn: Date;
      checkOut: Date;
    }>();

    for (const booking of bookingsForDate) {
      for (const guest of booking.guests) {
        if (guest.memberId && guest.member && guest.member.active && !adultMembers.has(guest.memberId)) {
          adultMembers.set(guest.memberId, {
            id: guest.memberId,
            name: `${guest.member.firstName} ${guest.member.lastName}`,
            checkIn: guest.stayStart,
            checkOut: guest.stayEnd,
          });
        }
      }
    }

    // Only auto-assign if exactly 1 adult member
    if (adultMembers.size !== 1) continue;

    const [, member] = [...adultMembers.entries()][0];

    // Check overlap validation before creating
    const potentialOverlaps = await prisma.hutLeaderAssignment.findMany({
      where: {
        startDate: { lte: member.checkOut },
        endDate: { gte: member.checkIn },
      },
    });

    let hasInvalidOverlap = false;
    for (const existing of potentialOverlaps) {
      const overlapDays = calculateOverlapDays(
        member.checkIn,
        member.checkOut,
        existing.startDate,
        existing.endDate
      );
      if (overlapDays > 1) {
        hasInvalidOverlap = true;
        break;
      }
    }

    if (hasInvalidOverlap) continue;

    // Create the assignment
    try {
      await prisma.hutLeaderAssignment.create({
        data: {
          memberId: member.id,
          startDate: member.checkIn,
          endDate: member.checkOut,
        },
      });

      const dateStr = day.toISOString().split("T")[0];
      assignedDates.push(dateStr);
      logger.info(
        { memberId: member.id, memberName: member.name, date: dateStr },
        "Auto-assigned hut leader"
      );
    } catch (err) {
      logger.error({ err, memberId: member.id }, "Failed to auto-assign hut leader");
    }
  }

  return { assignedCount: assignedDates.length, assignedDates };
}
