import type { EmailHandoverState, Prisma } from "@prisma/client";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { alertOfficersOfUndeliveredEmail } from "./delivery-failed-alert";
import { isCallerRetriedAlertTemplate } from "./internal";
import { replayInFlightWindowMs } from "./replay-in-flight";
import { EMAIL_RETRY_MAX_ATTEMPTS, FIRST_EMAIL_ATTEMPT, RETAINS_REPLAYABLE_EMAIL_BODY } from "./retry-selection";

/**
 * #5298 (INV-INT-043): an email is recorded `QUEUED` before it is handed to the
 * mail server, and a crash between the two used to leave it `QUEUED` for good,
 * unsent and unreported. `EmailLog.handoverState` says how far it got:
 *
 *   PENDING  recorded, never handed over. Only the sender's
 *            `claimEmailHandover` or this sweep can move it, through one guarded
 *            write, so exactly one of them acts.
 *   STARTED  a sender won that write and may have reached the mail server.
 *   null     written by the previous release, so unknown.
 *
 * The mail server gives no idempotency key, and the app hears back only about
 * bounces and complaints, so a row that may have reached it cannot be checked.
 * The sweep therefore re-sends only a row that provably never did, and flags
 * every other one to officers instead of sending it twice.
 */

/**
 * How long after its last attempt a `QUEUED` row counts as stranded: 30
 * minutes, or the longest a send can still be in flight under the configured
 * transport timeouts (`replayInFlightWindowMs`, 20.5 minutes by default, at
 * most 110) if that is longer, so a send still in flight is never mistaken for
 * one a crash interrupted.
 */
export function strandedQueuedAfterMs(): number {
  return Math.max(30 * 60 * 1000, replayInFlightWindowMs());
}

/**
 * Older stranded rows are left alone: a week-old email is stale news, and
 * flagging months of history at the first run would bury the review queue.
 */
export const STRANDED_QUEUED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const STRANDED_QUEUED_BATCH = 50;

/**
 * The sender's licence to hand this row to the mail server: moves it from
 * PENDING to STARTED, and answers the stamp it wrote only for the one caller
 * whose write landed (null when it lost). The stamp restarts the stranded
 * clock, so a send that was slow to get here is not swept while it is in
 * flight, and it identifies this claim to the writes that follow it. Throws on
 * a database error; the caller then sends nothing.
 */
export async function claimEmailHandover(emailLogId: string): Promise<Date | null> {
  const claimedAt = new Date();
  const claim = await prisma.emailLog.updateMany({
    where: { id: emailLogId, status: "QUEUED", handoverState: "PENDING" },
    data: { handoverState: "STARTED", lastAttemptAt: claimedAt },
  });
  return claim.count === 1 ? claimedAt : null;
}

/**
 * The row one `sendEmail` call recorded, written to only while it is still
 * that sender's (#5298, `INV-INT-043`). Before the hand-over a write is guarded
 * on `QUEUED` and `PENDING`, after it on the claim (`STARTED` at the claim's
 * stamp), so a sender that stalls past `strandedQueuedAfterMs()` cannot undo
 * the sweep: the row the sweep handed to the retry job, or flagged, is no
 * longer the sender's, and its late gate, failure or SENT write matches
 * nothing. A deferred row is the retry job's from the start and never swept,
 * so it is written by id, as before.
 */
export interface SenderEmailRow {
  readonly id: string;
  /**
   * Write `data` while the row is still this sender's; false when it is not,
   * or the write failed (both logged with `what`). Never throws.
   */
  write(data: Prisma.EmailLogUpdateManyMutationInput, what: string): Promise<boolean>;
  /**
   * `claimEmailHandover`: true only when this sender may now send. A lost
   * claim or a database error both answer false, and the row is then the
   * sweep's, so the email is late rather than sent twice.
   */
  claimHandover(templateName: string): Promise<boolean>;
}

export function senderEmailRow(id: string, options: { deferred: boolean }): SenderEmailRow {
  let guard: Prisma.EmailLogWhereInput = options.deferred
    ? { id }
    : { id, status: "QUEUED", handoverState: "PENDING" };
  return {
    id,
    async write(data, what) {
      try {
        const { count } = await prisma.emailLog.updateMany({ where: guard, data });
        if (count === 1) return true;
        logger.warn({ emailLogId: id, what }, "Left an email row as it is: the stranded-email sweep had already settled it (#5298)");
      } catch (err) {
        logger.error({ err, emailLogId: id }, `Failed to update EmailLog: ${what}`);
      }
      return false;
    },
    async claimHandover(templateName) {
      try {
        const claimedAt = await claimEmailHandover(id);
        if (claimedAt) {
          guard = { id, status: "QUEUED", handoverState: "STARTED", lastAttemptAt: claimedAt };
          return true;
        }
        logger.warn({ emailLogId: id, templateName }, "Email not sent: the stranded-email sweep had already taken its row (#5298)");
      } catch (err) {
        logger.error({ err, emailLogId: id, templateName }, "Email not sent: its hand-over could not be recorded; the stranded-email sweep settles it later (#5298)");
      }
      return false;
    },
  };
}

/** What the sweep did with one stranded row. */
type StrandedOutcome = "requeued" | "released_to_owner" | "never_sent" | "unconfirmed";

/** Stranded rows settled this run, by outcome. */
type StrandedSweepResult = Record<StrandedOutcome, number>;

interface StrandedRow {
  id: string;
  to: string;
  templateName: string;
  attempts: number;
  lastAttemptAt: Date;
  handoverState: EmailHandoverState | null;
}

/**
 * Settle every `QUEUED` row stranded for longer than `strandedQueuedAfterMs()`
 * (and younger than `STRANDED_QUEUED_MAX_AGE_MS`), up to 50 a run:
 *
 * - never handed over, an alert its owner sends again when nobody received it
 *   (`isCallerRetriedAlertTemplate`, #4669): released to that owner the way
 *   `releaseUnreceivedAlertCopies` releases one, `FAILED` at its first attempt
 *   with no body, so the owner's retry is the only one; officers are not told;
 * - never handed over, body kept: back to `FAILED` with its attempts unchanged,
 *   so the email retry job, which runs this first, replays it with all its
 *   usual checks: in the same run, or a later one when 50 older failures fill
 *   that run's batch;
 * - never handed over, no body kept: `FAILED` at the retry ceiling, into the
 *   review queue, and officers are told it was never sent;
 * - anything else: `FAILED` at the ceiling and `UNCONFIRMED`, never sent again
 *   automatically, and officers are told it may already have arrived.
 *
 * "Never handed over" is PENDING at attempts 1: the previous release's retry
 * job can claim a new row without moving it off PENDING, and its claim raises
 * attempts. Each write is guarded on the row exactly as read, so it races the
 * sender's claim and another sweep, and only one wins. Never throws.
 */
export async function sweepStrandedQueuedEmails(now: Date = new Date()): Promise<StrandedSweepResult> {
  const result: StrandedSweepResult = { requeued: 0, released_to_owner: 0, never_sent: 0, unconfirmed: 0 };
  try {
    const rows = await prisma.emailLog.findMany({
      where: {
        status: "QUEUED",
        lastAttemptAt: {
          lt: new Date(now.getTime() - strandedQueuedAfterMs()),
          gte: new Date(now.getTime() - STRANDED_QUEUED_MAX_AGE_MS),
        },
      },
      orderBy: { lastAttemptAt: "asc" },
      take: STRANDED_QUEUED_BATCH,
      select: { id: true, to: true, templateName: true, attempts: true, lastAttemptAt: true, handoverState: true },
    });
    if (rows.length === 0) return result;
    // Which rows keep a body, asked as a filter so no body is read.
    const withBody = await prisma.emailLog.findMany({
      where: { id: { in: rows.map((row) => row.id) }, ...RETAINS_REPLAYABLE_EMAIL_BODY },
      select: { id: true },
    });
    const keepsBody = new Set(withBody.map((row) => row.id));
    for (const row of rows) {
      const outcome = await settleStrandedRow(row, keepsBody.has(row.id), now).catch((err) => {
        logger.error({ err, emailLogId: row.id }, "Could not settle a stranded QUEUED email; the next run tries again");
        return null;
      });
      if (outcome) result[outcome]++;
    }
  } catch (err) {
    logger.error({ err }, "The stranded QUEUED email sweep failed; the next run tries again");
  }
  return result;
}

async function settleStrandedRow(row: StrandedRow, keepsBody: boolean, now: Date): Promise<StrandedOutcome | null> {
  // The row exactly as read: a sender's claim, a SENT write or another sweep
  // that landed since changes one of these, and this write then matches nothing.
  const asRead = {
    id: row.id,
    status: "QUEUED" as const,
    handoverState: row.handoverState,
    attempts: row.attempts,
    lastAttemptAt: row.lastAttemptAt,
  };
  const neverHandedOver = row.handoverState === "PENDING" && row.attempts === FIRST_EMAIL_ATTEMPT;
  const outcome: StrandedOutcome = !neverHandedOver
    ? "unconfirmed"
    : isCallerRetriedAlertTemplate(row.templateName)
      ? "released_to_owner"
      : keepsBody
        ? "requeued"
        : "never_sent";

  const data =
    outcome === "released_to_owner"
      ? {
          status: "FAILED" as const,
          htmlBody: null,
          bookingRetryHtmlBody: null,
          errorMessage:
            "No recipient received this alert: the app stopped before handing it to the mail server, so the alert's own retry sends it again, not the email retry job (#5298).",
        }
      : outcome === "requeued"
      ? {
          status: "FAILED" as const,
          errorMessage:
            "Interrupted before it reached the mail server, so it is being sent again by the email retry job (#5298).",
        }
      : outcome === "never_sent"
        ? {
            status: "FAILED" as const,
            attempts: EMAIL_RETRY_MAX_ATTEMPTS,
            lastAttemptAt: now,
            errorMessage:
              "Never sent: the app stopped before handing it to the mail server, and no copy was kept to send again. Some features send it again themselves, so check the recipient has not had a newer copy before you send a fresh one (#5298).",
          }
        : {
            status: "FAILED" as const,
            attempts: Math.max(row.attempts, EMAIL_RETRY_MAX_ATTEMPTS),
            lastAttemptAt: now,
            handoverState: "UNCONFIRMED" as const,
            errorMessage:
              "Delivery not confirmed: the app stopped while sending this email, so it may already have reached the recipient. It is not sent again automatically; check with them before you press Try again (#5298).",
          };
  const claim = await prisma.emailLog.updateMany({
    where: outcome === "requeued" ? { ...asRead, ...RETAINS_REPLAYABLE_EMAIL_BODY } : asRead,
    data,
  });
  if (claim.count !== 1) return null;

  logger.warn(
    { emailLogId: row.id, templateName: row.templateName, handoverState: row.handoverState, outcome },
    "Settled an email a crash left QUEUED (#5298)",
  );
  if (outcome === "never_sent" || outcome === "unconfirmed") {
    await alertOfficersOfUndeliveredEmail({
      recipient: row.to,
      templateName: row.templateName,
      attemptCount: row.attempts,
      stranded: outcome,
    });
  }
  return outcome;
}
