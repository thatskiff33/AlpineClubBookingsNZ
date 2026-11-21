/**
 * #5228 (`INV-INT-025`, `INV-INT-029`): the one guarded write that puts an
 * outbound row with an outbox queue type back on PENDING without leaving it in
 * a shape the next outbox pass cannot claim and send.
 *
 * The outbox claims a PENDING row from its immutable `queueType` column and
 * sends what `readQueuedOutboxRequestFor` reads from the stored request. Several
 * handlers save their execution request (`invoices`, `creditNotes`, no
 * `queueType`) over the queued one before their first Xero call, so a writer
 * that returns such a row to PENDING as it stands strands it: before #5228 the
 * outbox read no queue type, built the wrong claim and skipped the row on every
 * pass, silently. Every writer of that transition goes through here
 * (`docs/xero/ARCHITECTURE.md`, "What a PENDING row holds").
 *
 * No advisory lock: the write is the caller's own status/claim-guarded
 * `updateMany`, narrowed to the request this call read (a compare-and-set), so
 * a request changed in between is never overwritten and the caller learns it
 * lost. Callers keep their locks and guards as they were.
 */
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { asRecord } from "@/lib/xero-json";
import { PRIMARY_INVOICE_FEE_AT_LINK_KEY } from "@/lib/xero-primary-invoice-fee-at-link";
import { readQueuedOutboxPayload, readQueuedOutboxRequestFor } from "@/lib/xero-operation-outbox-payload";

type OperationStore = Pick<Prisma.TransactionClient, "xeroSyncOperation">;

/** What the write did. `unclaimable` and `lost` wrote nothing. */
export type OutboxPendingWrite =
  /** The row is PENDING with a request the next pass can claim and send. */
  | { outcome: "pending"; requestWritten: boolean }
  /** No request the next pass could claim: the row was left as it stood, for the caller to fail or refuse. */
  | { outcome: "unclaimable" }
  /** The caller's guard, or the request read, no longer matched: another writer moved the row first. */
  | { outcome: "lost" };

/**
 * The request the row is left holding:
 * - `{ replace }`: this queued request (a Retry's rebuilt one), as it is;
 * - `{ keep }`: the stored request when it is claimable, so a handler's valid
 *   checkpoint stands; else `fallback` - the queued request the dispatch
 *   claimed - laid over the stored record (`layeredOverStored`).
 */
export type OutboxPendingRequest =
  | { replace: Prisma.InputJsonObject }
  | { keep: true; fallback?: Prisma.JsonValue | null };

/** #5228: a row put back to run, as one never picked up - the rest of most PENDING writes. */
export const UNCLAIMED = { startedAt: null, completedAt: null, lastErrorCode: null, lastErrorMessage: null } as const;

/**
 * A filter matching exactly the stored request read: the compare-and-set's
 * half. A null read matches database or JSON null alike (`AnyNull`), as the
 * stuck-row filter selects both (`NAMES_NO_QUEUE_TYPE`).
 */
export function sameStoredRequest(stored: Prisma.JsonValue | null): Prisma.JsonNullableFilter<"XeroSyncOperation"> {
  return stored === null ? { equals: Prisma.AnyNull } : { equals: stored as Prisma.InputJsonValue };
}

/**
 * #5228 review: the execution-record keys a handler writes for one attempt -
 * the document it built, its allocation and the figures it recorded at link.
 * Only these may override the claimed request's own value, so on a second
 * refusal the newer attempt's record wins over an earlier give-back's. An
 * allow-list: a key dispatch reads straight from the stored request
 * (`refundRequestId`, `reviewTaskId`) is never one of them.
 */
const EXECUTION_RECORD_KEYS: ReadonlySet<string> = new Set([
  "creditNotes", // xero-credit-notes.ts, xero-modification-credit-notes.ts
  "allocation", // xero-credit-notes.ts (refund note)
  "allocations", // xero-modification-credit-notes.ts (booking note)
  "invoices", // booking, group settlement and entrance-fee invoices
  "priceLines", // itemised credit notes
  "promoLines", // booking and group settlement invoices
  "moneyBuildUp", // xero-booking-invoices.ts
  "moneyReconciliation", // xero-booking-invoices.ts
  "moneyReconciliationOnReplay", // xero-booking-invoices.ts
  PRIMARY_INVOICE_FEE_AT_LINK_KEY, // persistPrimaryInvoiceLink
]);

/**
 * #5228 review: the queued request laid over the stored record. A handler can
 * record what it did on the same request before a later call is refused - the
 * booking invoice's figures at link (`persistPrimaryInvoiceLink`), which say
 * which card captures its payment already holds. Those stay. A stored key is
 * taken only when it leaves the queued reading (`readQueuedOutboxPayload`)
 * unchanged, so the next run is driven by exactly the request the dispatch
 * claimed - never by an execution-time `refundMethod` or watermark - and only
 * where the claimed request lacks the key, or the key is an execution record
 * (`EXECUTION_RECORD_KEYS`). Any other value the claimed request holds stands,
 * so `refundRequestId` and `reviewTaskId`, which dispatch reads outside the
 * queued reading, always come from the claimed request. If the whole still
 * reads differently, the queued request is written alone. Execution records
 * override because the claimed request can itself be an earlier give-back's
 * layering: on a second refusal the newer attempt's `creditNotes`,
 * `allocation`, `invoices` or figures at link win. The handler's "create
 * reached" markers (`creditNotes`, `invoices`) stay too: a pre-HTTP refusal
 * may have hit a call after a create that landed, and the give-back cannot
 * tell which, so their readers keep answering "may be in Xero" rather than
 * risk a second document.
 */
function layeredOverStored(stored: Prisma.JsonValue | null, queued: Prisma.JsonValue): Prisma.JsonValue {
  const storedRecord = asRecord(stored);
  const queuedRecord = asRecord(queued);
  if (!storedRecord || !queuedRecord) return queued;
  const reading = JSON.stringify(readQueuedOutboxPayload(queuedRecord));
  const readsAsQueued = (candidate: Record<string, unknown>) => JSON.stringify(readQueuedOutboxPayload(candidate)) === reading;
  const layered: Record<string, unknown> = { ...queuedRecord };
  for (const [key, value] of Object.entries(storedRecord)) {
    if (Object.hasOwn(queuedRecord, key) && !EXECUTION_RECORD_KEYS.has(key)) continue;
    if (readsAsQueued({ ...layered, [key]: value })) layered[key] = value;
  }
  return readsAsQueued(layered) ? (layered as Prisma.JsonObject) : queued;
}

export async function returnOutboxRowToPending(params: {
  operationId: string;
  /** The caller's own guard (status, claim, resolved, repair marker), unchanged. */
  where: Prisma.XeroSyncOperationWhereInput;
  /** The rest of the PENDING write (`startedAt`, `completedAt`, error fields). */
  data: Omit<Prisma.XeroSyncOperationUpdateManyMutationInput, "status" | "requestPayload">;
  request: OutboxPendingRequest;
  store?: OperationStore;
}): Promise<OutboxPendingWrite> {
  const store = params.store ?? prisma;
  const row = await store.xeroSyncOperation.findUnique({
    where: { id: params.operationId },
    select: { queueType: true, requestPayload: true },
  });
  if (!row) return { outcome: "lost" };

  let written: Prisma.InputJsonValue | undefined;
  if ("replace" in params.request) {
    if (!readQueuedOutboxRequestFor(row.queueType, params.request.replace)) return { outcome: "unclaimable" };
    written = params.request.replace;
  } else if (!readQueuedOutboxRequestFor(row.queueType, row.requestPayload)) {
    const fallback = params.request.fallback ?? null;
    if (fallback === null || !readQueuedOutboxRequestFor(row.queueType, fallback)) return { outcome: "unclaimable" };
    written = layeredOverStored(row.requestPayload, fallback) as Prisma.InputJsonValue;
  }

  const returned = await store.xeroSyncOperation.updateMany({
    where: { AND: [params.where, { id: params.operationId, requestPayload: sameStoredRequest(row.requestPayload) }] },
    data: { ...params.data, status: "PENDING", ...(written !== undefined ? { requestPayload: written } : {}) },
  });
  return returned.count === 1 ? { outcome: "pending", requestWritten: written !== undefined } : { outcome: "lost" };
}
