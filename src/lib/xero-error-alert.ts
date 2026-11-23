import { sendAdminXeroSyncErrorAlert } from "./email";
import logger from "@/lib/logger";
import { sendAdminAlertOncePerWindow } from "@/lib/admin-alert-window";
import { redactSensitiveText } from "@/lib/redact-sensitive-json";
import { XERO_SYNC_ERROR_ALERT_COOLDOWN_KEY } from "@/lib/xero-sync-error-alert-key";

const XERO_SYNC_ERROR_ALERT_WINDOW_MS = 60 * 60 * 1000;

/**
 * N-05: Xero sync error alert, at most one per window across every error type:
 * an hour, or a day while nobody can receive it.
 *
 * The hour is held by an `AlertCooldown` claim (#5407 item 37), through the
 * sequence the repeated-failure alert shares (`sendAdminAlertOncePerWindow`).
 * It used to read the mail log for a SENT or QUEUED row in the last hour, so
 * two instances failing at once both alerted, and a copy left FAILED for the
 * retry cron, or withheld, did not count as raised. Now: raised (sent, queued
 * for the retry cron, bounced or withheld on a copy) holds the hour; nobody
 * could receive it (switched off, or nobody opted in) holds it for a day;
 * every copy failed before its mail log row existed (a transient mail fault)
 * holds it for the hour only; a send that threw gives it back.
 *
 * Direct sends neither hold nor are held by this hour. The old lookup read any
 * `admin-xero-sync-error` mail log row, so an alert another module sent
 * straight through `sendAdminXeroSyncErrorAlert` also held it; only this
 * function's own claim does now. Those modules each report one record an
 * officer must act on (a card payment Xero could not record, a credit-release
 * payment, a group settlement hand-back, a membership cancellation that
 * refunded nothing or stranded an invoice, a change paid twice, a capture the
 * waiting-invoice reaper found unrecorded, a Xero success after a resolved
 * failure); most are limited by a claim of their own, once ever or per key.
 *
 * Never throws: every failure is logged.
 */
export async function notifyXeroSyncError(data: {
  errorType: string;
  operation: string;
  errorMessage: string;
}): Promise<void> {
  try {
    const attempt = await sendAdminAlertOncePerWindow({
      key: XERO_SYNC_ERROR_ALERT_COOLDOWN_KEY,
      windowMs: XERO_SYNC_ERROR_ALERT_WINDOW_MS,
      label: "Xero sync error alert",
      context: { operation: data.operation, errorType: data.errorType },
      raiseAlert: () =>
        sendAdminXeroSyncErrorAlert({
          ...data,
          errorMessage: redactSensitiveText(data.errorMessage),
          timestamp: new Date(),
        }),
    });
    if (attempt.raised) return;
    if (attempt.reason === "held") {
      logger.info({ operation: data.operation }, "Xero error alert suppressed (window held)");
      return;
    }
    logger.error({ err: attempt.error }, "Failed to send Xero sync error alert");
  } catch (err) {
    logger.error({ err }, "Failed to send Xero sync error alert");
  }
}
