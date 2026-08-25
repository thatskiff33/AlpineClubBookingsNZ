import {
  ADDITIONAL_PAYMENT_FINAL_REMINDER_DAYS_BEFORE_CHECK_IN,
  ADDITIONAL_PAYMENT_REMINDER_DAYS,
  ADDITIONAL_PAYMENT_RESEND_COOLDOWN_MINUTES,
  additionalPaymentEpisodeStartedAt,
  isAdditionalPaymentOwed,
  resolveAdditionalPaymentChase,
  type AdditionalPaymentReminderKind,
} from "@/lib/additional-payment-chase";
import { readBookingNoEmails } from "@/lib/booking-email-suppression";
import { getTodayDateOnly } from "@/lib/date-only";
import { sendAdditionalPaymentReminderEmail } from "@/lib/email";
import { getActiveEmailSuppression } from "@/lib/email-suppression";
import {
  describeDeliveryDecision,
  resolveDeliveryPolicy,
} from "@/lib/environment-delivery-policy";
import type { GeneralCronJobName } from "@/lib/general-cron-runner";
import logger from "@/lib/logger";
import { isPlaceholderContactEmail } from "@/lib/placeholder-contact-email";
import { prisma } from "@/lib/prisma";
import {
  buildAdditionalOwedPaymentWhere,
  buildAdditionalOwedWhere,
} from "@/lib/unpaid-finished-stays";

/**
 * Chase an uncollected additional payment (#2350).
 *
 * A booking change that raises the price after the booking was already paid
 * records the extra on the `Payment` row and, until this job existed, waited
 * silently for the member to notice. This cron emails them twice at most: a few
 * days after the change, and once more shortly before check-in. It never
 * cancels, never expires anything, and stops entirely once the stay is over —
 * that phase belongs to the admin dashboard's unpaid-finished-stays queue.
 *
 * Idempotent by claim-then-send, the same shape as the pre-arrival cron: the
 * reminder stamp is written with a guarded `updateMany` whose WHERE still
 * requires the money to be owed and the stamp to be unset for THIS obligation,
 * so a rerun (or two runners racing) claims nothing and therefore sends nothing.
 * The claim also pins the amount and the episode the read decided on, and a lost
 * claim is re-read rather than assumed to be someone else's win — otherwise a
 * modification landing in that window would be emailed at its old amount while
 * its new, larger delta was stamped as already chased.
 *
 * Checks up front, BEFORE claiming, every reason this member cannot be reached:
 * the per-booking "No emails" switch, a walk-in placeholder address, and an
 * active bounce/complaint suppression. Letting the mailer withhold instead would
 * burn the stamp on a message nobody received, so a booking silenced (or an
 * address suppressed) during the reminder window would never be chased once the
 * switch came off or the suppression was cleared. Skipping leaves the stamp
 * unset and the reminder due, and costs one cheap read per candidate — the same
 * shape as the pre-check `cron-email-retry` already does.
 *
 * ONE RULE ABOUT STAMPS, shared with the manual re-send
 * (src/lib/additional-payment-resend-service.ts): a stamp is only ever spent on
 * a message that actually went out, or one that something else will replay. Any
 * other non-`sent` outcome hands the stamps straight back.
 */

export interface AdditionalPaymentReminderResult {
  reminderDays: number;
  finalReminderDaysBeforeCheckIn: number;
  /**
   * The first-deploy cutover this pass used, or null when this pass WAS the
   * first run and therefore established it (and so sent nothing).
   */
  chaseStartsAt: Date | null;
  /** Booking ids emailed, split by which reminder went out. */
  initialSentBookingIds: string[];
  finalSentBookingIds: string[];
  /** Owed bookings that were considered but were not due, or were silenced. */
  skippedBookingIds: string[];
  suppressedBookingIds: string[];
  failedBookingIds: string[];
}

export async function sendAdditionalPaymentReminders(): Promise<AdditionalPaymentReminderResult> {
  const now = new Date();
  const today = getTodayDateOnly();

  const chaseStartsAt = await resolveAdditionalPaymentChaseStartedAt();

  const result: AdditionalPaymentReminderResult = {
    reminderDays: ADDITIONAL_PAYMENT_REMINDER_DAYS,
    finalReminderDaysBeforeCheckIn:
      ADDITIONAL_PAYMENT_FINAL_REMINDER_DAYS_BEFORE_CHECK_IN,
    chaseStartsAt,
    initialSentBookingIds: [],
    finalSentBookingIds: [],
    skippedBookingIds: [],
    suppressedBookingIds: [],
    failedBookingIds: [],
  };

  // This pass IS the cutover (or we could not read it). Either way, emailing
  // now would be the bulk mailing the guard exists to prevent.
  if (!chaseStartsAt) {
    return result;
  }

  /*
    NOTHING IS CLAIMED ON AN INSTALLATION THAT CANNOT SEND (#3035 review), and
    this is about the DETECTOR rather than about the mail.

    The stamp-restoring path below is correct, and it is also why this early
    return is needed. Without it a copy re-claims every eligible booking on every
    run, has each message suppressed, restores each stamp, and starts again three
    hours later — writing N NEW counted `SKIPPED_NON_PRODUCTION` rows per pass,
    with `mostRecentAt` always minutes old. That is exactly the signature owner
    decision 1 asks the withheld-email count to MEAN: "a live club is being held
    back, steadily and right now". An ordinary idle staging box would produce it
    forever, and a detector that fires on every legitimate copy is a detector
    nobody reads.

    The pre-existing justification for restoring a stamp is that the checks above
    the claim have already skipped an unreachable recipient, so reaching the
    restore at all means the state changed under this very pass. That is not true
    of an environment withhold: it is a standing fact about the installation, not
    a race. So it is answered where standing facts belong — before any work.

    The email retry cron got the same early return for the same reason. Note the
    asymmetry with the withhold-handling below, which stays: this check reads the
    policy ONCE per run, and an administrator can switch the safer override on
    mid-pass, so the per-message handling is still the thing that catches it.

    WHICH PER-MESSAGE HANDLING, NAMED, because leaving it implicit let the same
    sentence be read as a claim about the retry cron, where it was not true
    (#3071 review, hoppers99). THIS job sends through `sendEmail`, which asks the
    delivery boundary for every individual message, so the early return above is
    only an optimisation and the guarantee comes from `sendEmail`. The RETRY cron
    does not go through `sendEmail` at all — it re-transmits a stored body on its
    own transport — so it has to re-ask inside its own loop, and now does.
  */
  const delivery = await resolveDeliveryPolicy();
  if (delivery.kind !== "allow") {
    logger.info(
      { job: "additionalPaymentReminders", outcome: delivery.kind },
      `Skipped the additional-payment reminder run: ${describeDeliveryDecision(delivery)}`,
    );
    return result;
  }

  const bookings = await prisma.booking.findMany({
    where: {
      deletedAt: null,
      // The stay is still ahead of (or in) the current NZ day. A finished stay
      // is the dashboard queue's business, not this job's.
      checkOut: { gt: today },
      ...buildAdditionalOwedWhere(),
    },
    include: CHASE_BOOKING_INCLUDE,
    orderBy: [{ checkIn: "asc" }, { createdAt: "asc" }],
  });

  for (const found of bookings) {
    // The owed predicate above already guarantees a payment row; the guard is
    // for the type, not for a case that can happen.
    if (!found.payment) continue;

    // Decided in memory as well as in SQL, so a widened query can never start
    // emailing about a cancelled booking or a settled extra.
    if (
      !isAdditionalPaymentOwed({
        bookingStatus: found.status,
        payment: found.payment,
      })
    ) {
      result.skippedBookingIds.push(found.id);
      continue;
    }

    const dueOnRead = resolveChaseFor({
      booking: found,
      now,
      today,
      chaseStartsAt,
    });
    if (!dueOnRead) {
      result.skippedBookingIds.push(found.id);
      continue;
    }

    let silenced: boolean;
    try {
      silenced = await readBookingNoEmails(found.id);
    } catch (err) {
      // Fail closed, the same direction as the mailer gate: an unreadable
      // switch means we do not know whether silence was asked for.
      logger.error(
        { err, bookingId: found.id, job: "additionalPaymentReminders" },
        'Could not read the booking "No emails" switch; skipping the additional-payment reminder',
      );
      result.suppressedBookingIds.push(found.id);
      continue;
    }
    if (silenced) {
      result.suppressedBookingIds.push(found.id);
      continue;
    }

    if (!(await canReceiveChaseEmail(found.member.email, found.id))) {
      result.suppressedBookingIds.push(found.id);
      continue;
    }

    /*
      Claim, and on failure re-read rather than assuming another runner won.
      The claim fences the EPISODE (no ADDITIONAL transaction newer than the one
      we read) as well as pinning the amount, so anything that starts a new
      obligation in the read→claim window fails it. The episode fence is the
      load-bearing half: a member retrying a failed charge mints a new Stripe
      intent and therefore a new ADDITIONAL transaction row carrying the SAME
      amount, which an amount-only pin would sail straight through — and
      carrying on would email the old obligation while stamping the new one as
      already chased, burning its first reminder for good. One re-read is
      enough: the decision is then made on the current truth, and a second
      collision in the same instant simply waits for the next pass.
    */
    let booking = found;
    let claim: ClaimedAdditionalPaymentReminder | null = null;

    for (let attempt = 0; attempt < 2 && !claim; attempt += 1) {
      if (attempt > 0) {
        const fresh = await reloadChaseBooking(found.id);
        if (!fresh?.payment) break;
        booking = fresh;
        if (
          !isAdditionalPaymentOwed({
            bookingStatus: booking.status,
            payment: booking.payment,
          })
        ) {
          break;
        }
      }

      const due = resolveChaseFor({ booking, now, today, chaseStartsAt });
      if (!due) break;

      claim = await claimAdditionalPaymentReminder({ ...due, now });
    }

    if (!claim) {
      result.skippedBookingIds.push(found.id);
      continue;
    }

    const { kind, episodeStartedAt, additionalAmountCents } = claim;

    try {
      const outcome = await sendAdditionalPaymentReminderEmail({
        bookingId: booking.id,
        recipientMemberId: booking.memberId,
        email: booking.member.email,
        firstName: booking.member.firstName,
        additionalAmountCents,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        requestedOn: episodeStartedAt,
        lodgeId: booking.lodgeId,
      });

      if (outcome.status !== "sent") {
        /*
          The mailer RETURNS rather than throws when nothing was transmitted —
          a suppressed (bounced/complained) address, a walk-in placeholder
          `.invalid` address, or the per-booking "No emails" switch flipping on
          between our own checks above and the send. Treating that as a send
          would leave the stamp burned and this obligation never chased again,
          which is the opposite of what the stamp is for.

          ONE rule, identical to the manual re-send's: the stamp is handed back
          unless something else will replay the message. The single exception is
          an UNREADABLE "No emails" switch, which leaves a FAILED EmailLog row
          that the email retry cron picks up (and re-checks the switch before
          replaying) — restoring there would risk the member getting two copies.

          Every other case gets its stamp back because every one of them can be
          fixed by a person: the switch is turned off again, a suppression is
          cleared, a real address replaces the walk-in placeholder. This does
          not put the job into a three-hourly bounce loop, because the checks
          above skip an unreachable recipient BEFORE the claim; reaching here at
          all means the state changed under this very pass.
        */
        const replayable =
          (outcome.status === "withheld_for_booking" &&
            outcome.reason === "booking_flag_unreadable") ||
          // #3035: every environment-safety withhold except the confirmed-copy
          // one leaves the same replayable FAILED EmailLog row, so the stamp stays
          // for the same reason. Only the terminal case gets its stamp back.
          (outcome.status === "withheld_for_environment" &&
            outcome.reason !== "environment_non_production");
        if (!replayable) {
          await restoreAdditionalPaymentStamps({ claim, now });
        }
        logger.warn(
          {
            bookingId: booking.id,
            job: "additionalPaymentReminders",
            outcome: outcome.status,
            stampRestored: !replayable,
          },
          "Additional-payment reminder was not transmitted",
        );
        result.suppressedBookingIds.push(booking.id);
        continue;
      }

      if (kind === "final") {
        result.finalSentBookingIds.push(booking.id);
      } else {
        result.initialSentBookingIds.push(booking.id);
      }
    } catch (err) {
      // The stamp stays written, exactly as the pre-arrival cron leaves it: a
      // transport failure is replayed by the email retry cron from its FAILED
      // EmailLog row, and an admin can always re-send by hand from the booking.
      logger.error(
        { err, bookingId: booking.id, job: "additionalPaymentReminders" },
        "Failed to send an additional-payment reminder",
      );
      result.failedBookingIds.push(booking.id);
    }
  }

  return result;
}

/**
 * The cron's own name in `CronJobRun`. Typed as the runner's own job-name union
 * (a type-only import, so no runtime cycle with the module that calls this one)
 * so renaming the job in the runner without renaming it here fails to compile
 * rather than silently resetting the cutover below.
 */
const CHASE_JOB_NAME: GeneralCronJobName = "additional-payment-reminders";

/**
 * When automatic chasing began ON THIS DEPLOYMENT — the first-deploy guard,
 * derived rather than hand-written.
 *
 * The problem with a constant: it has to be set to a date somebody predicts, and
 * nothing enforces the prediction. Pinned to the migration date it is wrong the
 * moment the deploy slips, and then every obligation raised in the gap is
 * backlog the first pass mails at once — precisely the failure the guard exists
 * to prevent. "Remember to raise it before releasing" is not a control.
 *
 * So the cutover is a fact rather than a plan: the FIRST time this job ran here.
 * The runner records a `CronJobRun` row for every pass, success or failure, so:
 *
 *  - no row at all ⇒ this pass is the first. It sends nothing and the row it is
 *    about to write becomes the cutover, so the pre-existing backlog is behind
 *    it by construction — whenever the deploy actually happens;
 *  - a row exists ⇒ its `startedAt` is the cutover, forever, with no human in
 *    the loop.
 *
 * Run rows are pruned after 90 days, which can only move the cutover FORWARD to
 * the oldest surviving run — still months behind any obligation this job chases
 * (they are chased three days after they are raised), so the pruning cannot
 * resurrect the backlog or silence a live obligation.
 *
 * A read failure returns null, and the caller then sends nothing this pass: not
 * knowing where the cutover is must never mean "email everyone".
 */
async function resolveAdditionalPaymentChaseStartedAt(): Promise<Date | null> {
  try {
    const firstRun = await prisma.cronJobRun.findFirst({
      where: { jobName: CHASE_JOB_NAME },
      orderBy: { startedAt: "asc" },
      select: { startedAt: true },
    });
    return firstRun?.startedAt ?? null;
  } catch (err) {
    logger.error(
      { err, job: "additionalPaymentReminders" },
      "Could not read the first-deploy cutover for the additional-payment chase; sending nothing this pass",
    );
    return null;
  }
}

/**
 * Can this member actually be reached, before anything is claimed?
 *
 * A walk-in placeholder `.invalid` address and an active bounce/complaint
 * suppression both mean the mailer will withhold. Finding that out AFTER the
 * claim would mean handing the stamp back on every pass and manufacturing a
 * bounce row each time; finding it out first costs one indexed read and leaves
 * the reminder cleanly due for whenever the address is fixed or the suppression
 * cleared. A suppression read that fails is treated as "cannot reach", the same
 * fail-closed direction as the "No emails" switch above.
 */
async function canReceiveChaseEmail(
  email: string,
  bookingId: string,
): Promise<boolean> {
  if (isPlaceholderContactEmail(email)) {
    logger.info(
      { bookingId, job: "additionalPaymentReminders" },
      "Skipped an additional-payment reminder to a walk-in placeholder address",
    );
    return false;
  }

  try {
    const suppression = await getActiveEmailSuppression(email);
    if (suppression) {
      logger.warn(
        { bookingId, job: "additionalPaymentReminders" },
        "Skipped an additional-payment reminder to a suppressed address",
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.error(
      { err, bookingId, job: "additionalPaymentReminders" },
      "Could not check the member's email suppression state; skipping the additional-payment reminder",
    );
    return false;
  }
}

/**
 * Everything one pass needs about a booking, read the same way whether it came
 * from the sweep or from a re-read after a lost claim.
 */
const CHASE_BOOKING_INCLUDE = {
  member: { select: { email: true, firstName: true } },
  payment: {
    select: {
      id: true,
      additionalAmountCents: true,
      additionalPaymentStatus: true,
      additionalReminderSentAt: true,
      additionalFinalReminderSentAt: true,
      createdAt: true,
      transactions: {
        where: { kind: "ADDITIONAL" },
        select: { createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  },
} as const;

type ChaseBooking = Awaited<ReturnType<typeof reloadChaseBooking>>;

function reloadChaseBooking(bookingId: string) {
  return prisma.booking.findUnique({
    where: { id: bookingId },
    include: CHASE_BOOKING_INCLUDE,
  });
}

interface DueAdditionalPaymentReminder {
  paymentId: string;
  kind: AdditionalPaymentReminderKind;
  episodeStartedAt: Date;
  /** The amount as read; the claim pins it so the email cannot quote a stale one. */
  additionalAmountCents: number;
  /** Stamp values before the claim, so a withheld send can hand them back. */
  previousReminderSentAt: Date | null;
  previousFinalReminderSentAt: Date | null;
}

type ClaimedAdditionalPaymentReminder = DueAdditionalPaymentReminder;

/** Which reminder (if any) this booking is due, as its current row reads. */
function resolveChaseFor(params: {
  booking: NonNullable<ChaseBooking>;
  now: Date;
  today: Date;
  chaseStartsAt: Date;
}): DueAdditionalPaymentReminder | null {
  const payment = params.booking.payment;
  if (!payment) return null;

  const episodeStartedAt = additionalPaymentEpisodeStartedAt({
    paymentCreatedAt: payment.createdAt,
    latestAdditionalTransactionCreatedAt:
      payment.transactions[0]?.createdAt ?? null,
  });

  const kind = resolveAdditionalPaymentChase({
    now: params.now,
    today: params.today,
    checkIn: params.booking.checkIn,
    checkOut: params.booking.checkOut,
    episodeStartedAt,
    reminderSentAt: payment.additionalReminderSentAt,
    finalReminderSentAt: payment.additionalFinalReminderSentAt,
    chaseStartsAt: params.chaseStartsAt,
  });
  if (!kind) return null;

  return {
    paymentId: payment.id,
    kind,
    episodeStartedAt,
    additionalAmountCents: payment.additionalAmountCents,
    previousReminderSentAt: payment.additionalReminderSentAt,
    previousFinalReminderSentAt: payment.additionalFinalReminderSentAt,
  };
}

/**
 * Hand the stamp(s) back after a send that never transmitted. Guarded on the
 * value this pass wrote, so a reminder that landed in between is not clobbered.
 */
async function restoreAdditionalPaymentStamps(params: {
  claim: ClaimedAdditionalPaymentReminder;
  now: Date;
}): Promise<void> {
  const { claim, now } = params;
  const isFinal = claim.kind === "final";

  await prisma.payment
    .updateMany({
      where: {
        id: claim.paymentId,
        additionalReminderSentAt: now,
        ...(isFinal ? { additionalFinalReminderSentAt: now } : {}),
      },
      data: {
        additionalReminderSentAt: claim.previousReminderSentAt,
        ...(isFinal
          ? { additionalFinalReminderSentAt: claim.previousFinalReminderSentAt }
          : {}),
      },
    })
    .catch((err) =>
      logger.error(
        { err, paymentId: claim.paymentId, job: "additionalPaymentReminders" },
        "Failed to restore the additional-payment reminder stamp after a withheld send",
      ),
    );
}

/**
 * Write the stamp(s) for one reminder, but only if the money is still owed, the
 * obligation is still the one we read, and nothing has already stamped it.
 * Returns null when another runner (or an admin's manual re-send) got there
 * first, or when the delta moved under us.
 *
 * The WHERE pins FOUR things the read decided on, not just the stamp:
 *  - the owed test in full, booking lifecycle status included, so a
 *    cancellation landing in the window cannot be emailed about;
 *  - the exact `additionalAmountCents`, so an email can never quote an amount
 *    the member no longer owes;
 *  - that no ADDITIONAL transaction newer than this episode exists, so a second
 *    upward modification starts a fresh chase instead of inheriting a stamp
 *    that would suppress its first reminder for good;
 *  - the cooldown, on BOTH stamps, so an admin's manual re-send landing in the
 *    read→claim window cannot be followed by this email minutes later. The read
 *    already refuses inside the cooldown; this is the same test where it counts.
 *
 * The final reminder stamps BOTH columns: once the member has been told inside
 * the pre-arrival window, the gentler day-N nudge has nothing left to say, and
 * leaving its stamp unset would let a later run send it as well.
 *
 * ACCEPTED RESIDUAL: claim-then-send means a crash (or a pod eviction) between
 * the stamp and the mailer loses that reminder permanently — no EmailLog row
 * exists yet, so the email retry cron has nothing to replay, and for the final
 * branch BOTH stamps are already spent. The alternative, send-then-stamp, trades
 * a lost reminder for a duplicate one on every retry, and this is a chase for
 * money the club already has a record of: the delta stays on the booking panel,
 * the bookings list, the dashboard card and the sidebar badge, and an admin can
 * re-send by hand. Same trade as the pre-arrival cron (#1651), deliberately.
 */
async function claimAdditionalPaymentReminder(
  params: DueAdditionalPaymentReminder & { now: Date },
): Promise<ClaimedAdditionalPaymentReminder | null> {
  const unstampedForThisEpisode = (
    field: "additionalReminderSentAt" | "additionalFinalReminderSentAt",
  ) => ({
    OR: [
      { [field]: null },
      { [field]: { lt: params.episodeStartedAt } },
    ],
  });

  const cooldownCutoff = new Date(
    params.now.getTime() - ADDITIONAL_PAYMENT_RESEND_COOLDOWN_MINUTES * 60_000,
  );
  const outsideCooldown = (
    field: "additionalReminderSentAt" | "additionalFinalReminderSentAt",
  ) => ({
    OR: [{ [field]: null }, { [field]: { lte: cooldownCutoff } }],
  });

  const claimed = await prisma.payment.updateMany({
    where: {
      id: params.paymentId,
      AND: [
        buildAdditionalOwedPaymentWhere(),
        { additionalAmountCents: params.additionalAmountCents },
        {
          transactions: {
            none: {
              kind: "ADDITIONAL",
              createdAt: { gt: params.episodeStartedAt },
            },
          },
        },
        unstampedForThisEpisode(
          params.kind === "final"
            ? "additionalFinalReminderSentAt"
            : "additionalReminderSentAt",
        ),
        outsideCooldown("additionalReminderSentAt"),
        outsideCooldown("additionalFinalReminderSentAt"),
      ],
    },
    data:
      params.kind === "final"
        ? {
            additionalFinalReminderSentAt: params.now,
            additionalReminderSentAt: params.now,
          }
        : { additionalReminderSentAt: params.now },
  });

  return claimed.count > 0
    ? {
        paymentId: params.paymentId,
        kind: params.kind,
        episodeStartedAt: params.episodeStartedAt,
        additionalAmountCents: params.additionalAmountCents,
        previousReminderSentAt: params.previousReminderSentAt,
        previousFinalReminderSentAt: params.previousFinalReminderSentAt,
      }
    : null;
}
