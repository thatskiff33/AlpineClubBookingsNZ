import {
  BookingRequestQuoteStatus,
  BookingRequestStatus,
  BookingStatus,
} from "@prisma/client";
import { issueActionToken } from "@/lib/action-tokens";
import { logAudit } from "@/lib/audit";
import { reconcileBedAllocationsForBookingWithGlobalLockHeld } from "@/lib/bed-allocation-lifecycle";
import {
  getBookingRequestSettings,
  parseBookingRequestGuests,
} from "@/lib/booking-request";
import { parseBookingRequestQuoteOptions } from "@/lib/booking-request-quotes";
import { sendBookingRequestQuoteEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Send a single pre-expiry reminder for public booking-request quotes that are
 * still awaiting a response. The reminder rotates the quote's response token and
 * emails a fresh working link, so the requester never has to find the original
 * quote email. Each quote is reminded at most once (tracked by `reminderSentAt`).
 *
 * Reminders are disabled when the admin sets `quoteReminderLeadDays` to 0.
 */
export async function sendQuoteExpiryReminders(): Promise<{
  remindedCount: number;
  failedCount: number;
  releasedHoldCount: number;
}> {
  const now = new Date();
  const settings = await getBookingRequestSettings();
  const leadDays = settings.quoteReminderLeadDays;

  let remindedCount = 0;
  let failedCount = 0;

  // Phase 1: pre-expiry reminders. Disabled when leadDays <= 0, but the hold
  // release in phase 2 still runs — an ignored quote's held bed must be freed
  // regardless of the reminder setting (issue #1254).
  const reminderQuotes =
    leadDays > 0
      ? await prisma.bookingRequestQuote.findMany({
          where: {
            status: BookingRequestQuoteStatus.SENT,
            reminderSentAt: null,
            responseTokenExpiresAt: {
              gt: now,
              lte: new Date(now.getTime() + leadDays * DAY_MS),
            },
          },
          include: { bookingRequest: true },
        })
      : [];

  for (const quote of reminderQuotes) {
    const request = quote.bookingRequest;
    const expiresAt = quote.responseTokenExpiresAt;
    if (!expiresAt) continue;

    // Rotate the response token first so the reminder email carries a working
    // link. `reminderSentAt` is only set after a successful send, so a delivery
    // failure is retried on the next run rather than silently swallowed.
    const { token, tokenHash } = issueActionToken();
    await prisma.bookingRequestQuote.update({
      where: { id: quote.id },
      data: { responseTokenHash: tokenHash },
    });

    try {
      const options = parseBookingRequestQuoteOptions(quote.options);
      const outcome = await sendBookingRequestQuoteEmail({
        // A quote reminder is sent before any booking exists (#2258).
        bookingContext: "none",
        email: request.contactEmail,
        firstName: request.contactFirstName,
        lodgeId: request.lodgeId ?? null,
        token,
        checkIn: request.checkIn,
        checkOut: request.checkOut,
        guestCount: parseBookingRequestGuests(request.guests).length,
        requestType: request.type,
        schoolName: request.schoolName,
        options: options.map((option) => ({
          label: option.label,
          totalCents: option.totalCents,
        })),
        message: quote.message,
        expiresAt,
        isReminder: true,
      });

      /*
        NOTHING IS STAMPED AND NO SUCCESS IS AUDITED FOR A MESSAGE THAT DID NOT
        GO OUT (#3035). `sendEmail` returns rather than throws when it withholds,
        so this used to write `reminderSentAt` AND an audit row reading
        `outcome: "success"`, "Sent a pre-expiry reminder" — a false record of a
        reminder the requester never received, on a quote about to expire.

        Leaving `reminderSentAt` null is the right shape for every fault: the
        token was rotated before the send, so the next run rotates again and
        re-sends, exactly as the pre-existing comment above promises for a
        delivery failure.

        THE ONE EXCEPTION is the confirmed copy, which DOES get its stamp. That
        outcome is terminal — a copy is a copy until somebody re-declares it — and
        without the stamp a staging box would re-claim, re-rotate and re-suppress
        the same quote on every run, writing a new counted `SKIPPED_NON_PRODUCTION`
        row each pass. That count is what tells a live club wrongly declared a copy
        from an idle staging one (owner decision 1, 23 Aug 2026), so an idle copy
        must not manufacture it.
      */
      const sent = outcome.status === "sent";
      const terminalForThisInstallation =
        outcome.status === "withheld_for_environment" &&
        outcome.reason === "environment_non_production";

      if (sent || terminalForThisInstallation) {
        await prisma.bookingRequestQuote.update({
          where: { id: quote.id },
          data: { reminderSentAt: now },
        });
      }

      if (sent) {
        remindedCount += 1;
      } else {
        failedCount += 1;
        logger.warn(
          {
            quoteId: quote.id,
            bookingRequestId: quote.bookingRequestId,
            outcome: outcome.status,
            reason: "reason" in outcome ? outcome.reason : undefined,
            willRetry: !terminalForThisInstallation,
          },
          "Booking request quote reminder was not transmitted",
        );
      }

      logAudit({
        action: "booking_request.quote_reminder_sent",
        targetId: request.id,
        entityType: "BookingRequest",
        entityId: request.id,
        category: "booking",
        outcome: sent ? "success" : "failure",
        summary: sent
          ? "Sent a pre-expiry reminder for an outstanding quote"
          : "A pre-expiry quote reminder was not delivered, so the requester has not been reminded",
        metadata: {
          quoteId: quote.id,
          version: quote.version,
          expiresAt: expiresAt.toISOString(),
          emailOutcome: outcome.status,
          // The mailer's own reason, so an operator reading the audit trail can
          // tell an environment withhold from a bounced address without going to
          // the email log.
          ...("reason" in outcome ? { emailWithheldReason: outcome.reason } : {}),
        },
      });
    } catch (err) {
      failedCount += 1;
      logger.error(
        { err, quoteId: quote.id, bookingRequestId: quote.bookingRequestId },
        "Failed to send booking request quote reminder",
      );
    }
  }

  // Phase 2: release beds held for SENT quotes past their response window
  // (issue #1254). Auto-hold-on-send means an unanswered quote would otherwise
  // sterilise a bed until check-in; free it once the link lapses. The request
  // stays QUOTE_SENT so an admin can re-quote (which re-holds); nothing here
  // charges, emails, or cancels the request.
  const releasedExpiredCount = await releaseExpiredQuoteHolds(now);

  // Phase 3: release beds still held for requests the requester sent back into
  // MODIFICATION_REQUESTED / QUERY_PENDING (their quote was superseded) once
  // their last response window has lapsed and no fresh quote is outstanding
  // (#1254 follow-up). Without this the hold would never auto-release — the
  // expiry phase above only selects SENT quotes.
  const releasedStaleModificationCount =
    await releaseStaleModificationHolds(now);

  return {
    remindedCount,
    failedCount,
    releasedHoldCount: releasedExpiredCount + releasedStaleModificationCount,
  };
}

/**
 * Free the AWAITING_REVIEW hold behind any SENT quote whose response token has
 * expired (issue #1254). Idempotent and concurrency-safe: each release runs
 * under the GLOBAL booking advisory lock (`pg_advisory_xact_lock(1)`) — the
 * same lock the quote-accept now takes FIRST under the two-tier protocol
 * (#1881; booking-request.ts, before its per-lodge lock) — re-verifies under
 * it, and status-guards the CANCELLED flip. So a race with a late accept
 * (quote → ACCEPTED, held row → PENDING) or a requester cancel is a no-op
 * rather than cancelling a live booking.
 */
async function releaseExpiredQuoteHolds(now: Date): Promise<number> {
  const expiredHeldQuotes = await prisma.bookingRequestQuote.findMany({
    where: {
      status: BookingRequestQuoteStatus.SENT,
      responseTokenExpiresAt: { lte: now },
      bookingRequest: { heldBookingId: { not: null } },
    },
    select: {
      id: true,
      version: true,
      bookingRequestId: true,
      bookingRequest: { select: { heldBookingId: true } },
    },
  });

  let releasedHoldCount = 0;

  for (const quote of expiredHeldQuotes) {
    const heldBookingId = quote.bookingRequest.heldBookingId;
    if (!heldBookingId) continue;

    try {
      const released = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

        // Re-read under the lock: only act while the request still points at
        // this exact hold and the hold is still an unaccepted AWAITING_REVIEW
        // row. An accept converts it to PENDING (and the quote to ACCEPTED), so
        // we must never cancel that live booking.
        const request = await tx.bookingRequest.findUnique({
          where: { id: quote.bookingRequestId },
          select: { heldBookingId: true },
        });
        if (request?.heldBookingId !== heldBookingId) return false;

        const held = await tx.booking.findUnique({
          where: { id: heldBookingId },
          select: { status: true },
        });
        if (!held || held.status !== BookingStatus.AWAITING_REVIEW) {
          return false;
        }

        // Status-guarded release (#1881): flip only while still AWAITING_REVIEW
        // so a concurrent accept that slipped the lock can never be clobbered.
        const releasedRows = await tx.booking.updateMany({
          where: { id: heldBookingId, status: BookingStatus.AWAITING_REVIEW },
          data: { status: BookingStatus.CANCELLED, nonMemberHoldUntil: null },
        });
        if (releasedRows.count === 0) return false;
        await reconcileBedAllocationsForBookingWithGlobalLockHeld({
          bookingId: heldBookingId,
          db: tx,
        });
        await tx.bookingRequest.update({
          where: { id: quote.bookingRequestId },
          data: { heldBookingId: null, version: { increment: 1 } },
        });
        return true;
      });

      if (released) {
        releasedHoldCount += 1;
        logAudit({
          action: "booking_request.quote_hold_released_on_expiry",
          targetId: quote.bookingRequestId,
          entityType: "BookingRequest",
          entityId: quote.bookingRequestId,
          category: "booking",
          outcome: "success",
          summary:
            "Released the bed held for an unanswered quote after its link expired",
          metadata: {
            quoteId: quote.id,
            version: quote.version,
            releasedBookingId: heldBookingId,
          },
        });
      }
    } catch (err) {
      logger.error(
        { err, quoteId: quote.id, bookingRequestId: quote.bookingRequestId },
        "Failed to release expired quote hold",
      );
    }
  }

  return releasedHoldCount;
}

/**
 * Free the AWAITING_REVIEW hold behind a request the requester bounced into
 * MODIFICATION_REQUESTED / QUERY_PENDING (its quote was superseded) once its
 * last response window has lapsed and no fresh quote is outstanding
 * (#1254 follow-up). The expiry phase only selects SENT quotes, so without
 * this a "please change X / I have a question" request would hold its bed
 * indefinitely.
 *
 * The deadline mirrors the sent-quote window: we release only once the latest
 * response-token window across the request's quotes (`max(responseTokenExpiresAt)`)
 * has passed. An active DRAFT (null window) never keeps a hold alive on its own,
 * but a currently-SENT quote does — those requests are excluded and handled by
 * the expiry/accept paths instead.
 *
 * A hold is only released when it was placed on or before that deadline. A hold
 * that post-dates the lapsed window — e.g. an admin manually re-held a SCHOOL
 * request via the "Hold slots" button (now a school-only UI action, #1385) after
 * its original quote window had passed — is kept, so the next cron tick never
 * undoes a deliberate re-hold (#1296).
 *
 * Idempotent and concurrency-safe: each release runs under the GLOBAL booking
 * advisory lock (`pg_advisory_xact_lock(1)`) — the same lock the quote-accept
 * takes FIRST under the two-tier protocol (#1881) — re-verifies the request is
 * still in a modify/query state with no SENT quote and a live AWAITING_REVIEW
 * hold, and status-guards the CANCELLED flip, so a race with a re-quote or an
 * accept is a no-op rather than cancelling a live booking.
 */
async function releaseStaleModificationHolds(now: Date): Promise<number> {
  const candidates = await prisma.bookingRequest.findMany({
    where: {
      status: {
        in: [
          BookingRequestStatus.MODIFICATION_REQUESTED,
          BookingRequestStatus.QUERY_PENDING,
        ],
      },
      heldBookingId: { not: null },
      // No quote is currently outstanding — a live SENT quote means the ball is
      // back in the requester's court and the expiry phase owns that hold.
      quotes: { none: { status: BookingRequestQuoteStatus.SENT } },
    },
    select: {
      id: true,
      heldBookingId: true,
      // The hold's own age gates release: a re-hold that post-dates the lapsed
      // window is kept (#1296).
      heldBooking: { select: { createdAt: true } },
      quotes: { select: { responseTokenExpiresAt: true } },
    },
  });

  let releasedHoldCount = 0;

  for (const request of candidates) {
    const heldBookingId = request.heldBookingId;
    if (!heldBookingId) continue;

    // Deadline = the latest response window ever offered on this request. If a
    // quote was never sent (no window) or the newest window is still open, keep
    // holding.
    const windows = request.quotes
      .map((quote) => quote.responseTokenExpiresAt)
      .filter((date): date is Date => date != null);
    if (windows.length === 0) continue;
    const deadline = new Date(
      Math.max(...windows.map((date) => date.getTime())),
    );
    if (deadline > now) continue;

    // Keep a hold placed *after* the lapsed window — an admin manually re-held
    // the (school) request via "Hold slots" (a school-only UI action as of #1385)
    // once its original quote window had already passed. Only release holds placed
    // on or before the deadline; releasing a fresh re-hold on the next tick would
    // defeat the admin's intent (#1296). The under-lock re-read re-confirms this
    // defensively.
    if (request.heldBooking && request.heldBooking.createdAt > deadline) {
      continue;
    }

    try {
      const released = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

        // Re-read under the lock. Bail unless the request still points at this
        // exact hold, is still in a modify/query state, still has no SENT quote,
        // and the hold is still an unaccepted AWAITING_REVIEW row.
        const current = await tx.bookingRequest.findUnique({
          where: { id: request.id },
          select: { heldBookingId: true, status: true },
        });
        if (current?.heldBookingId !== heldBookingId) return false;
        if (
          current.status !== BookingRequestStatus.MODIFICATION_REQUESTED &&
          current.status !== BookingRequestStatus.QUERY_PENDING
        ) {
          return false;
        }

        const activeSentQuotes = await tx.bookingRequestQuote.count({
          where: {
            bookingRequestId: request.id,
            status: BookingRequestQuoteStatus.SENT,
          },
        });
        if (activeSentQuotes > 0) return false;

        const held = await tx.booking.findUnique({
          where: { id: heldBookingId },
          select: { status: true, createdAt: true },
        });
        if (!held || held.status !== BookingStatus.AWAITING_REVIEW) {
          return false;
        }
        // Defensive re-check: keep a hold that post-dates the lapsed window (a
        // manual re-hold via "Hold slots", a school-only UI action as of #1385);
        // only release holds placed on or before the deadline (#1296).
        if (held.createdAt > deadline) return false;

        // Status-guarded release (#1881): flip only while still AWAITING_REVIEW.
        const releasedRows = await tx.booking.updateMany({
          where: { id: heldBookingId, status: BookingStatus.AWAITING_REVIEW },
          data: { status: BookingStatus.CANCELLED, nonMemberHoldUntil: null },
        });
        if (releasedRows.count === 0) return false;
        await reconcileBedAllocationsForBookingWithGlobalLockHeld({
          bookingId: heldBookingId,
          db: tx,
        });
        await tx.bookingRequest.update({
          where: { id: request.id },
          data: { heldBookingId: null, version: { increment: 1 } },
        });
        return true;
      });

      if (released) {
        releasedHoldCount += 1;
        logAudit({
          action: "booking_request.quote_hold_released_stale_modification",
          targetId: request.id,
          entityType: "BookingRequest",
          entityId: request.id,
          category: "booking",
          outcome: "success",
          summary:
            "Released the bed held for a modification/query request after its last quote window lapsed with no outstanding quote",
          metadata: {
            releasedBookingId: heldBookingId,
            deadline: deadline.toISOString(),
          },
        });
      }
    } catch (err) {
      logger.error(
        { err, bookingRequestId: request.id },
        "Failed to release stale modification/query quote hold",
      );
    }
  }

  return releasedHoldCount;
}
