/**
 * What `sendToAdmins` did with one alert (#3672), for a caller holding a
 * once-only claim; a leaf module, so that caller need not load the mailer.
 * Every recipient lands in exactly one of `sent`, `queuedForRetry` and
 * `notDelivered`, which sum to `recipients`.
 */
export interface AdminAlertSendResult {
  /** False when the club-wide delivery policy skipped the alert before any recipient was read. */
  deliveryAllowed: boolean;
  /** Admins opted in to the category (0 with `deliveryAllowed`: nobody opted in). */
  recipients: number;
  sent: number;
  /**
   * Not sent now, but left as a FAILED EmailLog row holding its body, which
   * `cron-email-retry` re-sends: a transport failure, or an environment fault
   * that clears when the installation is corrected. Sending the alert again
   * would duplicate it.
   */
  queuedForRetry: number;
  /** Never going out: suppressed, a terminal withhold, or a failure nothing replays. */
  notDelivered: number;
}

/**
 * Whether anyone has the alert or will get it from the retry cron, so a
 * once-only claim is spent (#3672). False only when nobody could receive it.
 */
export function adminAlertIsDeliveredOrQueued(result: AdminAlertSendResult): boolean {
  return result.sent + result.queuedForRetry > 0;
}
