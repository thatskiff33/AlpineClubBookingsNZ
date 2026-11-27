import type { Prisma } from "@prisma/client";

import { readOnceEverClaimState, sendAdminAlertOnceEver } from "@/lib/admin-alert-once";
import { markAlertOwed, settleOwedAlert } from "@/lib/alert-cooldown";
import type { ClubFormat } from "@/lib/club-format";
import type { AdminAlertSendResult } from "@/lib/email/admin-alert-send-result";
import type { ComplaintType } from "@/lib/email/delivery-feedback";
import logger from "@/lib/logger";

/**
 * #5255 (`INV-INT-042`): A ONCE-EVER ALERT RAISED ONLY ONCE. Its caller fires
 * it at the moment something goes wrong and nothing raises it again, so a
 * claim given back, deferred or lost would leave the error log as the only
 * record. This stores the alert first as an owed row (`once-ever-owed:<key>`)
 * the payments cron's sweep re-sends (`admin-alert-once-sweep.ts`) until its
 * claim is kept, then sends it through `sendAdminAlertOnceEver`, the one rule.
 *
 * - The claim is already kept, or deferred for a day: nothing is written or
 *   sent (a deferred alert's owed row was stored by the call that deferred).
 * - The owed row cannot be stored: logged, and the alert is still sent once,
 *   exactly as before #5255.
 * - The claim is kept: the owed row is settled. Otherwise it stays for the sweep.
 *
 * Re-sending never doubles an alert: the sweep sends only through the same
 * claim, and only while no claim holds it. Returns whether the claim was kept.
 * Never throws, unless the caller passes `throwIfUnstored` (#5469): a caller
 * whose own trigger is redelivered (a provider webhook) then gets a throw when
 * the alert could not be stored and its claim was not kept, so the trigger
 * comes back rather than the alert being lost. On such a redelivery a claim
 * deferred for the day by the unstored attempt has its owed row stored now.
 */
export async function sendReplayableAdminAlertOnceEver({
  key,
  label,
  context,
  throwIfUnstored = false,
  ...send
}: {
  key: string;
  label: string;
  context: Record<string, unknown>;
  throwIfUnstored?: boolean;
} & ReplayableAlertSend): Promise<boolean> {
  const { alert } = send;
  const now = new Date();
  const stored: StoredReplayableAlert = { label, alert };
  const store = () => markAlertOwed({ key: onceEverOwedKey(key), due: "after-retry", retryAfterMs: 0, replayAlert: stored, now });
  try {
    const state = await readOnceEverClaimState(key, now);
    if (state === "kept") return false;
    if (state === "deferred") {
      // Stored by the call that deferred; or, for a caller that throws when it
      // cannot store, stored now (a duplicate key is ignored).
      if (throwIfUnstored) {
        await store().catch((err) => {
          logger.error({ ...context, err }, `Failed to store the ${label} for the sweep`);
          throw new ReplayableAlertNotStoredError(label);
        });
      }
      return false;
    }
  } catch (err) {
    if (err instanceof ReplayableAlertNotStoredError) throw err;
    // The claim below reads the same row and says what it can.
    logger.error({ ...context, err }, `Failed to read the ${label} claim before sending it`);
  }
  let unstored = false;
  try {
    await store();
  } catch (err) {
    unstored = true;
    logger.error({ ...context, err }, `Failed to store the ${label} for the sweep; sending it once without a retry`);
  }
  const kept = await sendStoredAlertOnceEver({ key, context, label, send });
  if (!kept && unstored && throwIfUnstored) throw new ReplayableAlertNotStoredError(label);
  return kept;
}

/** #5469: the alert was neither stored for the sweep nor kept; the caller's trigger must come again. */
export class ReplayableAlertNotStoredError extends Error {
  constructor(label: string) {
    super(`The ${label} could not be stored for the sweep and was not sent; its trigger must be delivered again`);
    this.name = "ReplayableAlertNotStoredError";
  }
}

/**
 * #5469: what a replayable sender returns when what its alert reported no
 * longer holds (a complaint alert whose block was lifted before it went). The
 * alert is withdrawn for good: its claim is kept and its owed row settled, so
 * it is never sent later, even if the same condition returns.
 */
export const ALERT_WITHDRAWN = "withdrawn" as const;

/** The result a withdrawn alert hands the claim rule, so the claim is kept (as `UNMUTEABLE_ALERT_SENT` does). */
const WITHDRAWN_CLAIM_KEPT: AdminAlertSendResult = { deliveryAllowed: true, recipients: 1, sent: 1, queuedForRetry: 0, notDelivered: 0 };

/**
 * What a raised-once caller sends: one of the two admin alerts these callers
 * use, as plain JSON so the sweep can rebuild it. The Xero alert's timestamp is
 * an ISO string. The club's format is not stored: the caller passes its own,
 * and a re-send reads it afresh (`replayableAlertSend`).
 */
type PaymentRecoveryReplayAlert = {
  kind: "payment-recovery";
  bookingId: string;
  operationId?: string;
  amountCents: number;
  paymentIntentId: string;
  errorMessage: string;
};
type XeroSyncErrorReplayAlert = { kind: "xero-sync-error"; errorType: string; operation: string; errorMessage: string; timestamp: string };
/**
 * #5469: the officers' complaint alert, by ids only (the address and member
 * names are read at send time, never stored here): the address's suppression
 * row, the complaint's type, and the email it named, if any.
 */
export type EmailComplaintReplayAlert = {
  kind: "email-complaint";
  suppressionId: string;
  complaintType: ComplaintType;
  complainedEmailLogId: string | null;
};
export type ReplayableAdminAlert = PaymentRecoveryReplayAlert | XeroSyncErrorReplayAlert | EmailComplaintReplayAlert;

/** An alert ready to send: a payment alert always with the club's format. */
type ReplayableAlertSend =
  | { alert: PaymentRecoveryReplayAlert; format: ClubFormat }
  | { alert: XeroSyncErrorReplayAlert }
  | { alert: EmailComplaintReplayAlert };

/** A stored alert ready for the sweep to re-send, with the club's format read now for a payment alert. */
export async function replayableAlertSend(alert: ReplayableAdminAlert): Promise<ReplayableAlertSend> {
  if (alert.kind === "xero-sync-error") return { alert };
  if (alert.kind === "email-complaint") return { alert };
  const { clubFormatValues } = await import("@/lib/club-format-server");
  return { alert, format: await clubFormatValues() };
}

/** The owed row's `replayAlert`: the alert and the label its log lines use. */
export type StoredReplayableAlert = { label: string; alert: ReplayableAdminAlert };

export const ONCE_EVER_OWED_PREFIX = "once-ever-owed:";

export function onceEverOwedKey(key: string): string {
  return `${ONCE_EVER_OWED_PREFIX}${key}`;
}

/** The stored alert, or null when the row holds something this release cannot send. */
export function parseStoredReplayableAlert(value: Prisma.JsonValue | null): StoredReplayableAlert | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { label, alert } = value as { label?: unknown; alert?: unknown };
  if (typeof label !== "string" || !alert || typeof alert !== "object" || Array.isArray(alert)) return null;
  const fields = alert as Record<string, unknown>;
  const strings = (...names: string[]) => names.every((name) => typeof fields[name] === "string");
  if (fields.kind === "payment-recovery") {
    if (!strings("bookingId", "paymentIntentId", "errorMessage") || !Number.isInteger(fields.amountCents)) return null;
    if (fields.operationId !== undefined && typeof fields.operationId !== "string") return null;
  } else if (fields.kind === "xero-sync-error") {
    if (!strings("errorType", "operation", "errorMessage", "timestamp")) return null;
  } else if (fields.kind === "email-complaint") {
    if (!strings("suppressionId", "complaintType")) return null;
    if (fields.complainedEmailLogId !== null && typeof fields.complainedEmailLogId !== "string") return null;
  } else {
    return null;
  }
  return { label, alert: alert as ReplayableAdminAlert };
}

/** Send a stored alert through the one rule, and settle its owed row once the claim is kept. Never throws. */
export async function sendStoredAlertOnceEver({
  key,
  context,
  label,
  send,
}: {
  key: string;
  context: Record<string, unknown>;
  label: string;
  send: ReplayableAlertSend;
}): Promise<boolean> {
  let withdrawn = false;
  const kept = await sendAdminAlertOnceEver({
    key,
    label,
    context,
    send: async () => {
      const result = await sendReplayableAlert(send);
      if (result !== ALERT_WITHDRAWN) return result;
      withdrawn = true;
      return WITHDRAWN_CLAIM_KEPT;
    },
  });
  if (!kept) return false;
  if (withdrawn) logger.info(context, `The ${label} was withdrawn: what it reported no longer holds, so nothing was sent and it is closed`);
  try {
    await settleOwedAlert({ key: onceEverOwedKey(key) });
  } catch (err) {
    logger.error({ ...context, err }, `Failed to settle the sent ${label}; the sweep settles it`);
  }
  return true;
}

/** Loaded on use: the payment ledger reaches some callers, and these senders reach back to it. */
async function sendReplayableAlert(send: ReplayableAlertSend): Promise<AdminAlertSendResult | typeof ALERT_WITHDRAWN> {
  if (send.alert.kind === "email-complaint") {
    const { sendAdminEmailComplaintAlert } = await import("@/lib/email/admin-alerts-email-complaint");
    return sendAdminEmailComplaintAlert(send.alert);
  }
  if (!("format" in send)) {
    const { sendAdminXeroSyncErrorAlert } = await import("@/lib/email");
    const { errorType, operation, errorMessage, timestamp } = send.alert;
    return sendAdminXeroSyncErrorAlert({ errorType, operation, errorMessage, timestamp: new Date(timestamp) });
  }
  const { alertPaymentRecoveryOfficers, NOBODY_ALERTED } = await import("@/lib/payment-recovery-alert");
  const { bookingId, operationId, amountCents, paymentIntentId, errorMessage } = send.alert;
  return (
    (await alertPaymentRecoveryOfficers(
      { bookingId, ...(operationId === undefined ? {} : { operationId }), amountCents, paymentIntentId, errorMessage },
      send.format,
    )) ?? NOBODY_ALERTED
  );
}
