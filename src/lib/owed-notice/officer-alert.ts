/**
 * #5433: an officers' owed alert, answered for the mechanism from what
 * `sendToAdmins` did (`AdminAlertRecipientsResult`). One rule for every
 * officer kind (`INV-SSOT-001`): the bump's (`booking-bump-alert.ts`), the
 * waitlist offer's and the rest of the confirm-pending job's:
 * - `settled` clears the marker: an officer has it, a failed copy's `FAILED`
 *   row is the email retry cron's to replay, or nobody is meant to get it (the
 *   alert switched off, nobody opted in, every copy refused or withheld on
 *   purpose);
 * - `unreached` holds it for the kind's longer retry: nobody got it and at
 *   least one officer's copy failed before its `EmailLog` row existed, so
 *   nothing will replay it (`adminAlertNeedsResend`);
 * - `threw` keeps it for the kind's usual wait.
 * At least once, not exactly once: an officers' alert has no event key, so a
 * stop after the send and before the clear repeats it on a later run (the
 * trade-off accepted for the bump alert in #5407). Never throws.
 */
import { adminAlertNeedsResend, type AdminAlertRecipientsResult } from "@/lib/email/admin-alert-send-result";
import logger from "@/lib/logger";
import type { OwedNoticeOutcome } from "@/lib/owed-notice/deliver";

export async function owedOfficerAlertOutcome(
  label: string,
  log: Record<string, unknown>,
  dispatch: () => Promise<AdminAlertRecipientsResult>,
): Promise<OwedNoticeOutcome> {
  try {
    const result = await dispatch();
    if (!adminAlertNeedsResend(result)) return "settled";
    logger.warn({ ...log, failedBeforeLogged: result.failedBeforeLogged }, `No officer received the ${label} and nothing will replay it; it stays owed for a day`);
    return "unreached";
  } catch (err) {
    logger.error({ err, ...log }, `Failed to send the ${label}; it stays owed`);
    return "threw";
  }
}
