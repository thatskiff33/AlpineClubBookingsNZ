import { sendAdminXeroSyncErrorAlert } from "./email";
import logger from "@/lib/logger";
import { sendAdminAlertOncePerWindow } from "@/lib/admin-alert-window";
import { redactSensitiveText } from "@/lib/redact-sensitive-json";

/**
 * The one `AlertCooldown` key holding the sync error alert's hourly window
 * (#5407 item 37). One key for every error type and operation, so the limit
 * stays what it always was: one alert an hour across all Xero errors.
 */
export const XERO_SYNC_ERROR_ALERT_COOLDOWN_KEY = "xero-sync-error";

const XERO_SYNC_ERROR_ALERT_WINDOW_MS = 60 * 60 * 1000;

/**
 * N-05: Xero sync error alert, at most one an hour across every error type.
 *
 * The hour is held by an `AlertCooldown` claim (#5407 item 37), through the
 * sequence the repeated-failure alert shares (`sendAdminAlertOncePerWindow`).
 * It used to read the mail log for a SENT or QUEUED row in the last hour, so
 * two instances failing at once both alerted, and a copy left FAILED for the
 * retry cron, or withheld, did not count as raised. Now: raised (sent, queued
 * for the retry cron, bounced or withheld on a copy) holds the hour; nobody
 * could receive it (switched off, nobody opted in, or every copy failed before
 * its mail log row existed) holds it for a day; a send that threw gives it
 * back. Callers that send `sendAdminXeroSyncErrorAlert` directly are not
 * limited by this.
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
      send: () =>
        sendAdminXeroSyncErrorAlert({
          ...data,
          errorMessage: redactSensitiveText(data.errorMessage),
          timestamp: new Date(),
        }),
    });
    if (attempt.raised) return;
    if (attempt.reason === "held") {
      logger.info({ operation: data.operation }, "Xero error alert suppressed (one per hour limit)");
      return;
    }
    logger.error({ err: attempt.error }, "Failed to send Xero sync error alert");
  } catch (err) {
    logger.error({ err }, "Failed to send Xero sync error alert");
  }
}
