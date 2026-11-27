/**
 * The outbox payload for a mid-season age-up credit (#5190 PR 3,
 * `INV-MONEY-053`). A leaf, so the payload registry can recognise the queue
 * type without taking the worker, as `admin-grant-credit-note-payload.ts` is.
 */
import { asRecord, readString } from "@/lib/xero-json";

export const XERO_OUTBOX_AGE_UP_CREDIT_TYPE = "AGE_UP_CREDIT" as const;

/** The row the credit's outbox operation is anchored on. */
export const AGE_UP_ADJUSTMENT_LOCAL_MODEL = "MemberSubscriptionAgeUpAdjustment";

export interface AgeUpCreditPayload {
  queueType: typeof XERO_OUTBOX_AGE_UP_CREDIT_TYPE;
  adjustmentId: string;
}

/** The one builder of the queued request (`INV-SSOT`). */
export function buildAgeUpCreditPayload(adjustmentId: string): AgeUpCreditPayload {
  return { queueType: XERO_OUTBOX_AGE_UP_CREDIT_TYPE, adjustmentId };
}

export function readAgeUpCreditPayload(value: unknown): AgeUpCreditPayload | null {
  const payload = asRecord(value);
  if (!payload || payload.queueType !== XERO_OUTBOX_AGE_UP_CREDIT_TYPE) return null;
  const adjustmentId = readString(payload.adjustmentId);
  return adjustmentId ? buildAgeUpCreditPayload(adjustmentId) : null;
}
