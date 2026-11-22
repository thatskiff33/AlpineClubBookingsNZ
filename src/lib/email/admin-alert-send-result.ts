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
 * What `sendToAdmins` reports (#5407): its result, and how many of the
 * `notDelivered` recipients have no EmailLog row to show for it: the send
 * threw before the row existed, or an environment fault withheld a copy
 * whose row write had failed. Nothing replays such a copy, so sending the
 * alert again reaches that recipient for the first time; every other
 * undelivered copy was refused or withheld on purpose.
 */
export interface AdminAlertRecipientsResult extends AdminAlertSendResult {
  failedBeforeLogged: number;
}

/**
 * True only when nobody received the alert, nothing will replay it, and at
 * least one recipient failed before its attempt was logged (#5407): sending
 * it again is then the only way it reaches anyone. A policy skip, an empty
 * audience, or copies refused or withheld on purpose are final.
 */
export function adminAlertNeedsResend(result: AdminAlertRecipientsResult): boolean {
  return adminAlertSendOutcome(result) === "undelivered" && result.failedBeforeLogged > 0;
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

/**
 * What `sendUnmuteableAdminAlert` reports: it reads no delivery policy and its
 * recipient set is never empty. `queued-for-retry` (#4669) is a caller-retried
 * alert nobody received whose copies the email retry cron already holds, so
 * its owner must not send it again.
 */
export type UnmuteableAdminAlertOutcome = Extract<
  AdminAlertSendOutcome,
  "sent" | "queued-for-retry" | "undelivered"
>;

/**
 * What a once-only caller reads after an UNMUTEABLE alert's send returned
 * (#4149): the caller discards the unmuteable sender's outcome; it sends to a fallback
 * audience when the owning area has nobody, and records its own escalation when
 * no copy went out, so a send that returns has done all it can and the claim is
 * kept. One that throws is given back by `sendAdminAlertOnceEver`.
 */
export const UNMUTEABLE_ALERT_SENT: AdminAlertSendResult = {
  deliveryAllowed: true,
  recipients: 1,
  sent: 1,
  queuedForRetry: 0,
  notDelivered: 0,
};
