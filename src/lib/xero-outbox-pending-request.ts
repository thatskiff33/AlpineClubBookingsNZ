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
import { readQueuedOutboxRequestFor } from "@/lib/xero-operation-outbox-payload";

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
 * - `{ replace }`: this queued request (a Retry's rebuilt one);
 * - `{ keep }`: the stored request when it is claimable, else `fallback` - the
 *   queued request the dispatch claimed - so a handler's valid checkpoint
 *   stands and only an execution request is put back.
 */
export type OutboxPendingRequest =
  | { replace: Prisma.InputJsonObject }
  | { keep: true; fallback?: Prisma.JsonValue | null };

/** A filter matching exactly the stored request read, database NULL included: the compare-and-set's half. */
export function sameStoredRequest(stored: Prisma.JsonValue | null): Prisma.JsonNullableFilter<"XeroSyncOperation"> {
  return stored === null ? { equals: Prisma.DbNull } : { equals: stored as Prisma.InputJsonValue };
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
    written = fallback as Prisma.InputJsonValue;
  }

  const returned = await store.xeroSyncOperation.updateMany({
    where: { AND: [params.where, { id: params.operationId, requestPayload: sameStoredRequest(row.requestPayload) }] },
    data: { ...params.data, status: "PENDING", ...(written !== undefined ? { requestPayload: written } : {}) },
  });
  return returned.count === 1 ? { outcome: "pending", requestWritten: written !== undefined } : { outcome: "lost" };
}
