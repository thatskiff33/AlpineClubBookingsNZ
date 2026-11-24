/**
 * The one `AlertCooldown` key holding the Xero sync error alert's window
 * (#5407 item 37): one key for every error type and operation, so the limit
 * stays one alert per window across all Xero errors.
 *
 * A leaf with no imports, so the real-database test set-up can clear the key
 * without loading the mailer (`realdb-alert-window-reset.ts`).
 */
export const XERO_SYNC_ERROR_ALERT_COOLDOWN_KEY = "xero-sync-error";
