import { prisma } from "./prisma";
import { sendAdminCapacityWarningAlert } from "./email";
import { computeNightOccupancy } from "./capacity";
import { getLodgeCapacity } from "./lodge-capacity";
import { addDaysDateOnly, eachDateOnlyInRange } from "./date-only";
import { clubToday, dateOnlyInstantOf } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import logger from "@/lib/logger";

const WARN_THRESHOLD_BEDS = 5; // Alert when <= 5 beds remaining

/**
 * N-03: Check capacity for the next 14 days and alert admins
 * about high-occupancy days.
 * Runs daily at 7:00 AM NZST.
 *
 * Per lodge (lodge-scoping contract): each active lodge's occupancy is
 * compared against that lodge's own capacity — occupied beds are never
 * summed across lodges — and each lodge with warning days gets its own
 * alert naming the lodge (name shown only when a second active lodge
 * exists, ADR-002). Lodges resolving to capacity 0 (unconfigured) are
 * skipped: they cannot be overbooked and would otherwise alarm daily.
 */
export async function checkCapacityWarnings(): Promise<{ alertedDays: number }> {
  // The club's own day, read through the runtime reader rather than the
  // request-scoped binding: `src/instrumentation.node.ts` loads this job with a
  // lazy `await import`, and `@/lib/club-time/server` is `server-only`, which
  // throws on that graph (#3123, docs/CLUB_TIME_KERNEL.md).
  const today = dateOnlyInstantOf(clubToday(await readClubTimeZoneOutsideRequest()));
  const endDate = addDaysDateOnly(today, 14);

  // UTC date-only nights, stepped with the domain's own helper (#2286 review
  // L3). date-fns `eachDayOfInterval` returns LOCAL-midnight dates, so on a host
  // whose clock is not UTC every night in this list was shifted off the
  // date-only grid the rest of the capacity code keys on — a pre-existing bug
  // that the custodian night index would have inherited.
  const nights = eachDateOnlyInRange(today, endDate);

  const activeLodges = await prisma.lodge.findMany({
    where: { active: true },
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });
  const showLodgeName = activeLodges.length > 1;

  let alertedDays = 0;

  for (const lodge of activeLodges) {
    const lodgeCapacity = await getLodgeCapacity(lodge.id);
    if (lodgeCapacity <= 0) continue;

    // THE occupancy calculation (#2681), shared with the four admission and
    // availability engines. Until #2681 this cron computed occupancy itself and
    // was three terms behind them — it missed policy-exception reservations
    // (#2525), whole-lodge holds (ADR-001 #118), and explicit guest nights
    // (#713, because it loaded `guests: true` rather than the night rows).
    //
    // The first two made it UNDER-report and stay silent about a lodge that was
    // genuinely close to full. The third went the OTHER way: with no night rows
    // a sparse, non-contiguous stay fell back to its stayStart/stayEnd
    // envelope, so the cron OVER-reported on the gap nights and could warn
    // about a night that was free.
    //
    // Custodian occupancy (#2286) is one of the shared terms, so it IS counted
    // here: this cron's whole job is to warn about fullness, and a bed held for
    // a season by a custodian is genuinely unavailable — excluding it would
    // under-fire the warning by the custodian count every night, all season.
    // (The admin utilisation report deliberately goes the other way; see its
    // own note and the who-counts-what tables in docs/CAPACITY_MODEL.md.)
    const occupancy = await computeNightOccupancy({
      lodgeId: lodge.id,
      from: today,
      toExclusive: endDate,
      nights,
    });

    const highOccupancyDays: Array<{
      date: Date;
      occupiedBeds: number;
      availableBeds: number;
    }> = [];

    for (const night of nights) {
      const reading = occupancy(night);
      // A whole-lodge-held night is full by definition and is pinned to the
      // lodge's ceiling, exactly as checkCapacity pins it (ADR-001 decision 6):
      // an exclusive hold leaves no bookable bed, so the warning must fire even
      // when the holding booking's own headcount is small.
      const occupiedBeds = reading.wholeLodgeHeld
        ? lodgeCapacity
        : reading.occupiedBeds;

      const availableBeds = lodgeCapacity - occupiedBeds;
      if (availableBeds <= WARN_THRESHOLD_BEDS) {
        highOccupancyDays.push({ date: night, occupiedBeds, availableBeds });
      }
    }

    if (highOccupancyDays.length === 0) continue;

    try {
      await sendAdminCapacityWarningAlert(
        highOccupancyDays,
        lodgeCapacity,
        showLodgeName ? lodge.name : null,
      );
      alertedDays += highOccupancyDays.length;
    } catch (err) {
      logger.error(
        { err, lodgeId: lodge.id },
        "Failed to send capacity warning admin alert",
      );
    }
  }

  return { alertedDays };
}
