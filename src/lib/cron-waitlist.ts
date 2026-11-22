import { prisma } from "./prisma";
import { BookingStatus } from "@prisma/client";
import { expireStaleOffers } from "./waitlist";
import { clubToday, dateOnlyInstantOf } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import logger from "@/lib/logger";
import { reconcileBedAllocationsForBookingWithLodgeLockHeld } from "@/lib/bed-allocation-lifecycle";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { releaseBookingPromoRedemptions } from "@/lib/promo";
import { clubFormatValues } from "@/lib/club-format-server";
import { LOCK1_HOLDER_TRANSACTION_BUDGET } from "@/lib/db-transaction";

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

/**
 * #5410: after a sweep whose other work committed, some lapsed places could not
 * be re-offered (each failure is logged with its booking and lodge). Never
 * retried, since a retry finds nothing left to re-offer: those places wait for
 * the next offer pass that covers their nights.
 */
class WaitlistReofferFailedError extends Error {
  constructor(
    readonly failedReofferCount: number,
    readonly completed: { expiredOffers: number; newOffers: number; autoCancelled: number },
  ) {
    super(
      `${failedReofferCount} waitlist re-offer pass(es) failed after their offers lapsed; ` +
        "those places were not offered on. The rest of the run completed.",
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

async function processWaitlistCronOnce(): Promise<{
  expiredOffers: number;
  newOffers: number;
  autoCancelled: number;
}> {
  // The club's format (#3565), resolved once per run, before the first
  // transaction; the re-offer emails render with it.
  const format = await clubFormatValues();

  // 1. Expire stale offers and re-offer
  const { expiredCount, reofferedCount, failedReofferCount } = await expireStaleOffers(format);

  // 2. Auto-cancel waitlisted bookings where all dates are in the past.
  // checkOut is @db.Date (the NZ calendar date stored at UTC midnight), so
  // compare it against the date-only "today" rather than a local-midnight
  // instant. A raw new Date() + setHours(0,0,0,0) resolves to NZ-local midnight
  // (D-1)T12:00Z under the TZ=Pacific/Auckland server pin, which excludes a stay
  // checking out today until tomorrow — a day late. The stay whose dates are all
  // in the past includes one checking out today, so it must cancel today
  // (F32, #1888).
  const today = dateOnlyInstantOf(clubToday(await readClubTimeZoneOutsideRequest()));

  const candidates = await prisma.booking.findMany({
    where: {
      status: { in: [BookingStatus.WAITLISTED, BookingStatus.WAITLIST_OFFERED] },
      checkOut: { lte: today },
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
        booking.checkOut > today
      ) {
        return null;
      }
      const claimed = await tx.booking.updateMany({
        where: {
          id: booking.id,
          status: { in: [BookingStatus.WAITLISTED, BookingStatus.WAITLIST_OFFERED] },
          checkOut: { lte: today },
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

  // #5410: a re-offer pass that threw was logged and skipped so the others still
  // ran. Fail the run once step 2 has also run, so the cron record and the error
  // report show it. The message never matches `isTransactionStartFailure`: a
  // retry would find the reverted offers already WAITLISTED and re-offer nothing.
  if (failedReofferCount > 0) {
    throw new WaitlistReofferFailedError(failedReofferCount, {
      expiredOffers: expiredCount,
      newOffers: reofferedCount,
      autoCancelled: pastWaitlisted.length,
    });
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

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await processWaitlistCronOnce();
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

  return processWaitlistCronOnce();
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
