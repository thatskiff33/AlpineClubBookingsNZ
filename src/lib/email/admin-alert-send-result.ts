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

/**
 * The four-way reading of a send (#3643), for a caller that re-sends an alert
 * nobody received rather than holding its claim for a day. Derived from
 * `AdminAlertSendResult`, never counted separately. A recipient whose FAILED
 * copy the email retry cron will re-send counts as `queued-for-retry`, not
 * `undelivered`, so re-sending never duplicates it.
 */
export type AdminAlertSendOutcome =
  | "sent"
  | "queued-for-retry"
  | "skipped-by-policy"
  | "no-recipients"
  | "undelivered";

export function adminAlertSendOutcome(result: AdminAlertSendResult): AdminAlertSendOutcome {
  if (!result.deliveryAllowed) return "skipped-by-policy";
  if (result.recipients === 0) return "no-recipients";
  if (result.sent > 0) return "sent";
  if (result.queuedForRetry > 0) return "queued-for-retry";
  return "undelivered";
}
