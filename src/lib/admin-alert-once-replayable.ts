import type { Prisma } from "@prisma/client";

import { readOnceEverClaimState, sendAdminAlertOnceEver } from "@/lib/admin-alert-once";
import { markAlertOwed, settleOwedAlert } from "@/lib/alert-cooldown";
import type { ClubFormat } from "@/lib/club-format";
import type { AdminAlertSendResult } from "@/lib/email/admin-alert-send-result";
import logger from "@/lib/logger";

/**
 * #5255 (`INV-INT-041`): A ONCE-EVER ALERT RAISED ONLY ONCE. Its caller fires
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
 * claim, and only while no claim holds it. Never throws; returns whether the
 * claim was kept.
 */
export async function sendReplayableAdminAlertOnceEver({
  key,
  label,
  context,
  alert,
  format,
}: {
  key: string;
  label: string;
  context: Record<string, unknown>;
  alert: ReplayableAdminAlert;
  /** The club's format, when the caller has it; a replay reads it afresh. */
  format?: ClubFormat;
}): Promise<boolean> {
  const now = new Date();
  try {
    const state = await readOnceEverClaimState(key, now);
    if (state === "kept" || state === "deferred") return false;
  } catch (err) {
    // The claim below reads the same row and says what it can.
    logger.error({ ...context, err }, `Failed to read the ${label} claim before sending it`);
  }
  const stored: StoredReplayableAlert = { label, alert };
  try {
    await markAlertOwed({ key: onceEverOwedKey(key), due: "after-retry", retryAfterMs: 0, replayAlert: stored, now });
  } catch (err) {
    logger.error({ ...context, err }, `Failed to store the ${label} for the sweep; sending it once without a retry`);
  }
  return sendStoredAlertOnceEver({ key, context, stored, format });
}

/**
 * What a raised-once caller sends: one of the two admin alerts these callers
 * use, as plain JSON so the sweep can rebuild it. The Xero alert's timestamp is
 * an ISO string; the payment alert's club format is read when it is sent.
 */
export type ReplayableAdminAlert =
  | {
      kind: "payment-recovery";
      bookingId: string;
      operationId?: string;
      amountCents: number;
      paymentIntentId: string;
      errorMessage: string;
    }
  | { kind: "xero-sync-error"; errorType: string; operation: string; errorMessage: string; timestamp: string };

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
  } else {
    return null;
  }
  return { label, alert: alert as ReplayableAdminAlert };
}

/** Send a stored alert through the one rule, and settle its owed row once the claim is kept. Never throws. */
export async function sendStoredAlertOnceEver({
  key,
  context,
  stored,
  format,
}: {
  key: string;
  context: Record<string, unknown>;
  stored: StoredReplayableAlert;
  format?: ClubFormat;
}): Promise<boolean> {
  const kept = await sendAdminAlertOnceEver({
    key,
    label: stored.label,
    context,
    send: () => sendReplayableAlert(stored.alert, format),
  });
  if (!kept) return false;
  try {
    await settleOwedAlert({ key: onceEverOwedKey(key) });
  } catch (err) {
    logger.error({ ...context, err }, `Failed to settle the sent ${stored.label}; the sweep settles it`);
  }
  return true;
}

/** Loaded on use: the payment ledger reaches some callers, and these senders reach back to it. */
async function sendReplayableAlert(alert: ReplayableAdminAlert, format?: ClubFormat): Promise<AdminAlertSendResult> {
  if (alert.kind === "xero-sync-error") {
    const { sendAdminXeroSyncErrorAlert } = await import("@/lib/email");
    return sendAdminXeroSyncErrorAlert({
      errorType: alert.errorType,
      operation: alert.operation,
      errorMessage: alert.errorMessage,
      timestamp: new Date(alert.timestamp),
    });
  }
  const [{ alertPaymentRecoveryOfficers, NOBODY_ALERTED }, { clubFormatValues }] = await Promise.all([
    import("@/lib/payment-recovery-alert"),
    import("@/lib/club-format-server"),
  ]);
  const { bookingId, operationId, amountCents, paymentIntentId, errorMessage } = alert;
  return (
    (await alertPaymentRecoveryOfficers(
      { bookingId, ...(operationId === undefined ? {} : { operationId }), amountCents, paymentIntentId, errorMessage },
      format ?? (await clubFormatValues()),
    )) ?? NOBODY_ALERTED
  );
}
