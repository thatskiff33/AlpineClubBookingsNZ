import { prisma } from "./prisma";
import { BookingStatus } from "@prisma/client";
import { expireStaleOffers } from "./waitlist";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import logger from "@/lib/logger";
import { reconcileBedAllocationsForBookingWithLodgeLockHeld } from "@/lib/bed-allocation-lifecycle";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { releaseBookingPromoRedemptions } from "@/lib/promo";
import { clubFormatValues } from "@/lib/club-format-server";
import { LOCK1_HOLDER_TRANSACTION_BUDGET } from "@/lib/db-transaction";
import { clubTodayAsStoredDate, waitlistStayEndedWhere, waitlistStayHasEnded } from "@/lib/waitlist-stay-ended";

const DEFAULT_WAITLIST_TRANSACTION_RETRY_ATTEMPTS = 3;
const DEFAULT_WAITLIST_TRANSACTION_RETRY_DELAY_MS = 500;

function getWaitlistTransactionRetryAttempts() {
  const configured = Number.parseInt(
    process.env.WAITLIST_TRANSACTION_RETRY_ATTEMPTS ?? "",
    10
  );

  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_WAITLIST_TRANSACTION_RETRY_ATTEMPTS;
}

function getWaitlistTransactionRetryDelayMs() {
  const configured = Number.parseInt(
    process.env.WAITLIST_TRANSACTION_RETRY_DELAY_MS ?? "",
    10
  );

  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_WAITLIST_TRANSACTION_RETRY_DELAY_MS;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WaitlistProcessorCronDependencies {
  isModuleEnabled?: () => boolean | Promise<boolean>;
}

export type WaitlistProcessorCronResult =
  | {
      cronStatus: "SUCCESS";
      expiredOffers: number;
      newOffers: number;
      autoCancelled: number;
    }
  | {
      cronStatus: "SKIPPED";
      expiredOffers: 0;
      newOffers: 0;
      autoCancelled: 0;
      reason: string;
    };

/** What the expiry sweeps of every attempt in one cron run did (#5410). */
type ReofferTally = { failedReoffers: number; expiredOffers: number; newOffers: number };

/**
 * #5410: some lapsed places could not be re-offered (each failure is logged
 * with its booking and lodge). Thrown by `processWaitlistCron` after its retry
 * loop, so it is never retried: a retry would find nothing left to re-offer, and
 * those places wait for the next offer pass that covers their nights.
 */
class WaitlistReofferFailedError extends Error {
  constructor(tally: ReofferTally, autoCancelled: number) {
    super(
      `${tally.failedReoffers} waitlist re-offer pass(es) failed after their offers lapsed; ` +
        "those places were not offered on. The rest of the run completed: " +
        `${tally.expiredOffers} offer(s) expired, ${tally.newOffers} new offer(s), ` +
        `${autoCancelled} past-date booking(s) cancelled.`,
    );
    this.name = "WaitlistReofferFailedError";
  }
}

function isTransactionStartFailure(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  return /unable to start a transaction|transaction api error|pool_timeout|timed out fetching a new connection/i.test(
    message
  );
}

async function processWaitlistCronOnce(tally: ReofferTally): Promise<{
  expiredOffers: number;
  newOffers: number;
  autoCancelled: number;
}> {
  // The club's format (#3565), resolved once per run, before the first
  // transaction; the re-offer emails render with it.
  const format = await clubFormatValues();

  // 1. Expire stale offers and re-offer
  const { expiredCount, reofferedCount, failedReofferCount } = await expireStaleOffers(format);
  // Recorded before step 2, so a retryable failure later in this attempt cannot
  // lose it (#5410).
  tally.failedReoffers += failedReofferCount;
  tally.expiredOffers += expiredCount;
  tally.newOffers += reofferedCount;

  // 2. Auto-cancel waitlisted bookings where all dates are in the past.
  // checkOut is @db.Date (the NZ calendar date stored at UTC midnight), so
  // compare it against the date-only "today" rather than a local-midnight
  // instant. A raw new Date() + setHours(0,0,0,0) resolves to NZ-local midnight
  // (D-1)T12:00Z under the TZ=Pacific/Auckland server pin, which excludes a stay
  // checking out today until tomorrow — a day late. The stay whose dates are all
  // in the past includes one checking out today, so it must cancel today
  // (F32, #1888).
  const today = clubTodayAsStoredDate(await readClubTimeZoneOutsideRequest());

  const candidates = await prisma.booking.findMany({
    where: {
      status: { in: [BookingStatus.WAITLISTED, BookingStatus.WAITLIST_OFFERED] },
      ...waitlistStayEndedWhere(today),
    },
    select: { id: true },
  });
  const pastWaitlisted: Array<{
    id: string;
    checkIn: Date;
    checkOut: Date;
    lodgeId: string;
  }> = [];
  for (const candidate of candidates) {
    const cancelled = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      const key = await tx.booking.findUnique({
        where: { id: candidate.id },
        select: { lodgeId: true },
      });
      if (!key) return null;
      await acquireLodgeCapacityLock(tx, key.lodgeId);
      const booking = await tx.booking.findUnique({
        where: { id: candidate.id },
        select: { id: true, checkIn: true, checkOut: true, lodgeId: true, status: true },
      });
      if (
        !booking ||
        (booking.status !== BookingStatus.WAITLISTED &&
          booking.status !== BookingStatus.WAITLIST_OFFERED) ||
        !waitlistStayHasEnded(booking.checkOut, today)
      ) {
        return null;
      }
      const claimed = await tx.booking.updateMany({
        where: {
          id: booking.id,
          status: { in: [BookingStatus.WAITLISTED, BookingStatus.WAITLIST_OFFERED] },
          ...waitlistStayEndedWhere(today),
        },
        data: {
          status: BookingStatus.CANCELLED,
          waitlistPosition: null,
          waitlistOfferedAt: null,
          waitlistOfferExpiresAt: null,
        },
      });
      if (claimed.count === 0) return null;
      await reconcileBedAllocationsForBookingWithLodgeLockHeld({
        bookingId: booking.id,
        db: tx,
        previousRange: {
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        },
      });
      await releaseBookingPromoRedemptions(tx, booking.id);
      return booking;
    }, LOCK1_HOLDER_TRANSACTION_BUDGET);
    if (cancelled) pastWaitlisted.push(cancelled);
  }

  if (pastWaitlisted.length > 0) {

    logger.info(
      { count: pastWaitlisted.length, job: "processWaitlistCron" },
      "Auto-cancelled past-date waitlisted bookings"
    );
  }

  return {
    expiredOffers: expiredCount,
    newOffers: reofferedCount,
    autoCancelled: pastWaitlisted.length,
  };
}

// test seam
/**
 * Waitlist processor cron job.
 * - Expires stale WAITLIST_OFFERED bookings and re-offers to next candidates
 * - Auto-cancels WAITLISTED and WAITLIST_OFFERED bookings whose dates passed
 * - Retries transient Prisma transaction-start failures; each attempt is safe
 *   because waitlist mutations are guarded by statuses and advisory locks.
 */
export async function processWaitlistCron(): Promise<{
  expiredOffers: number;
  newOffers: number;
  autoCancelled: number;
}> {
  const maxAttempts = getWaitlistTransactionRetryAttempts();
  const delayMs = getWaitlistTransactionRetryDelayMs();
  // #5410: summed across attempts, and judged only after the loop, so a failed
  // re-offer in an attempt that is later retried still fails the run, and that
  // failure is never itself retried.
  const tally: ReofferTally = { failedReoffers: 0, expiredOffers: 0, newOffers: 0 };
  let result: Awaited<ReturnType<typeof processWaitlistCronOnce>> | undefined;

  for (let attempt = 1; attempt <= maxAttempts && result === undefined; attempt += 1) {
    try {
      result = await processWaitlistCronOnce(tally);
    } catch (error) {
      if (!isTransactionStartFailure(error) || attempt >= maxAttempts) {
        throw error;
      }

      logger.warn(
        { err: error, attempt, maxAttempts, delayMs, job: "processWaitlistCron" },
        "Waitlist cron transaction start failed; retrying"
      );

      if (delayMs > 0) {
        await wait(delayMs);
      }
    }
  }

  result ??= await processWaitlistCronOnce(tally);
  if (tally.failedReoffers > 0) {
    throw new WaitlistReofferFailedError(tally, result.autoCancelled);
  }
  return result;
}

export async function runWaitlistProcessorCron(
  dependencies: WaitlistProcessorCronDependencies = {}
): Promise<WaitlistProcessorCronResult> {
  if (dependencies.isModuleEnabled && !(await dependencies.isModuleEnabled())) {
    const reason = "Waitlist effective module state is disabled";

    logger.info({ job: "waitlist-processor", reason }, "Waitlist cron skipped");
    return {
      cronStatus: "SKIPPED",
      expiredOffers: 0,
      newOffers: 0,
      autoCancelled: 0,
      reason,
    };
  }

  const result = await processWaitlistCron();
  return {
    cronStatus: "SUCCESS",
    ...result,
  };
}
