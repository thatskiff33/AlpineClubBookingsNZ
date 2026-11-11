/**
 * The outbox payload for a manual credit grant's Xero note (#4431).
 *
 * A leaf so the payload registry can recognise the queue type without taking
 * the worker, and so the registry file stays inside its size budget.
 */
import { ADMIN_CREDIT_GRANT_MAPPING } from "@/lib/admin-credit-grant-account";
import { asRecord, readNumber, readString } from "@/lib/xero-json";

export const XERO_OUTBOX_ADMIN_GRANT_CREDIT_NOTE_TYPE = "ADMIN_GRANT_CREDIT_NOTE" as const;

const MAPPING_KEYS = Object.values(ADMIN_CREDIT_GRANT_MAPPING);

export type AdminGrantNoteMappingKey = (typeof ADMIN_CREDIT_GRANT_MAPPING)[keyof typeof ADMIN_CREDIT_GRANT_MAPPING];

export interface AdminGrantCreditNotePayload {
  queueType: typeof XERO_OUTBOX_ADMIN_GRANT_CREDIT_NOTE_TYPE;
  amountCents: number;
  mappingKey: AdminGrantNoteMappingKey;
  memberCreditId: string;
}

export function isAdminGrantNoteMappingKey(value: unknown): value is AdminGrantNoteMappingKey {
  return typeof value === "string" && MAPPING_KEYS.some((key) => key === value);
}

/** A positive integer amount, a credit id, and one of the two mapping keys. */
export function readAdminGrantCreditNotePayload(value: unknown): AdminGrantCreditNotePayload | null {
  const payload = asRecord(value);
  if (!payload || payload.queueType !== XERO_OUTBOX_ADMIN_GRANT_CREDIT_NOTE_TYPE) return null;
  const amountCents = readNumber(payload.amountCents);
  const memberCreditId = readString(payload.memberCreditId);
  if (amountCents === null || !Number.isInteger(amountCents) || amountCents <= 0) return null;
  if (!memberCreditId || !isAdminGrantNoteMappingKey(payload.mappingKey)) return null;
  return {
    queueType: XERO_OUTBOX_ADMIN_GRANT_CREDIT_NOTE_TYPE,
    amountCents,
    mappingKey: payload.mappingKey,
    memberCreditId,
  };
}
