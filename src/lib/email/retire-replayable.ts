/**
 * Retire a `FAILED` email row so the email retry cron never replays it: its
 * attempts raised to the ceiling, its bodies dropped, and `errorMessage` saying
 * why. Guarded on the row exactly as the caller read it (status, attempts,
 * bodies), the same guard as the cron's own pre-send claim
 * (`emailRetryClaimWhere`): if the cron claims the row first, this matches
 * nothing; if this goes first, the cron's claim matches nothing. One write for
 * every retirement (`INV-SSOT`): the cron's unverifiable booking email
 * (`cron-email-retry.ts`) and a waitlist offer that is over (#5433 review).
 */
import type { Prisma } from "@prisma/client";

import { EMAIL_RETRY_MAX_ATTEMPTS } from "@/lib/email/retry-selection";
import { prisma } from "@/lib/prisma";

export async function retireReplayableEmailRow(
  row: {
    id: string;
    attempts: number;
    htmlBody: string | null;
    bookingRetryHtmlBody: string | null;
    errorMessage: string;
  },
  /** A transaction's client when the retirement must commit with a decision (the waitlist's lapse). */
  db: Pick<Prisma.TransactionClient, "emailLog"> = prisma,
): Promise<{ count: number }> {
  return db.emailLog.updateMany({
    where: {
      id: row.id,
      status: "FAILED",
      attempts: row.attempts,
      htmlBody: row.htmlBody,
      bookingRetryHtmlBody: row.bookingRetryHtmlBody,
    },
    data: {
      attempts: EMAIL_RETRY_MAX_ATTEMPTS,
      lastAttemptAt: new Date(),
      htmlBody: null,
      bookingRetryHtmlBody: null,
      errorMessage: row.errorMessage,
      // #3035: whatever held this row back before, it is now retired for a
      // different reason and `errorMessage` says which. A stale
      // `deliveryBlockReason` would keep it inside the environment-withheld
      // count for the life of the installation.
      deliveryBlockReason: null,
    },
  });
}
