/**
 * #5228: THE OUTBOX ROWS A GIVE-BACK LEFT STUCK ON PENDING, AND THEIR RELEASE.
 *
 * Before #5228 a pre-HTTP cooldown refusal returned a queued Xero row to
 * PENDING still holding the execution request its handler had saved over the
 * queued one. The outbox claims from the immutable `queueType` column now, but
 * a row holding no queued request is not sent from a guess: it stays PENDING,
 * is skipped and counted (`unclaimableRequest`), and is listed here.
 *
 * `findStuckQueuedRequestRows` only reads. `releaseStuckQueuedRequestRows`
 * moves exactly the rows a report listed from PENDING to FAILED, so an officer
 * sees each and Retry replays it from what it holds (`INV-INT-025`). Each row
 * is re-read and must still be the row reported - outbound, PENDING, never
 * claimed (`startedAt` null), unresolved, the same queue type and the same
 * stored request - and the write is guarded on all of it, so a row an outbox
 * pass, a cancel, a restate or a resolve changed in between is skipped, never
 * failed. Nothing else on the row is touched: its request, response, Xero ids,
 * correlation and idempotency keys stay, so Retry still answers to the same
 * document and key. Nothing calls Xero.
 *
 * Whether such a row ever reached Xero is not inferred from its request: a
 * pre-HTTP refusal is how it got here, but the message tells the officer to
 * check Xero before Retry, as for any FAILED row.
 *
 * Runbook (owner-only on a live site): docs/MAINTENANCE.md, "Release Xero
 * outbox rows stuck without a queued request (#5228)". No advisory lock: every
 * counterpart writer is a status-guarded compare-and-set on the same row
 * (`docs/CONCURRENCY_AND_LOCKING.md`).
 */
import type { Prisma } from "@prisma/client";

import { XERO_STUCK_QUEUED_REQUEST_RELEASED_CODE } from "@/lib/xero-operation-error-codes";
import { sameStoredRequest } from "@/lib/xero-outbox-pending-request";
import { readQueuedOutboxPayload, readQueuedOutboxRequestFor, readQueueType, XERO_OUTBOX_QUEUE_TYPES } from "@/lib/xero-operation-outbox-payload";

type OperationStore = Pick<Prisma.TransactionClient, "xeroSyncOperation">;

/** Why the stored request is not one the outbox can send under the row's column. */
export type StuckQueuedRequestReason =
  /** An execution request (`invoices`, `creditNotes`, ...): what a pre-#5228 give-back left. */
  | "no-queue-type"
  /** Names the row's queue type, but too incomplete to read. */
  | "unreadable"
  /** Names another queue type than the row's column. */
  | "other-queue-type";

export interface StuckQueuedRequestRow {
  id: string;
  queueType: string;
  localModel: string | null;
  localId: string | null;
  createdAt: Date;
  reason: StuckQueuedRequestReason;
}

export const STUCK_QUEUED_REQUEST_RELEASE_MESSAGE =
  "Released from the outbox queue: its stored request was not one the outbox could send, so it was never sent from the queue. Check Xero for the document before you retry it.";

/** Null when the outbox can claim and send the request under `queueType`. */
export function stuckQueuedRequestReason(queueType: string | null, requestPayload: unknown): StuckQueuedRequestReason | null {
  if (readQueuedOutboxRequestFor(queueType, requestPayload)) return null;
  const named = readQueueType(requestPayload);
  if (named === null) return "no-queue-type";
  return named === queueType && !readQueuedOutboxPayload(requestPayload) ? "unreadable" : "other-queue-type";
}

/** The rows the outbox scans that no pass can send: outbound, PENDING, never claimed, unresolved. */
const SCANNED_PENDING_WHERE = {
  direction: "OUTBOUND",
  status: "PENDING",
  startedAt: null,
  manuallyResolvedAt: null,
  queueType: { in: [...XERO_OUTBOX_QUEUE_TYPES] },
} satisfies Prisma.XeroSyncOperationWhereInput;

/** Read-only: every stuck row, oldest first. */
export async function findStuckQueuedRequestRows(db: OperationStore): Promise<StuckQueuedRequestRow[]> {
  const rows = await db.xeroSyncOperation.findMany({
    where: SCANNED_PENDING_WHERE,
    select: { id: true, queueType: true, localModel: true, localId: true, createdAt: true, requestPayload: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.flatMap((row) => {
    const reason = stuckQueuedRequestReason(row.queueType, row.requestPayload);
    return reason && row.queueType
      ? [{ id: row.id, queueType: row.queueType, localModel: row.localModel, localId: row.localId, createdAt: row.createdAt, reason }]
      : [];
  });
}

export interface StuckQueuedRequestRelease {
  released: string[];
  /** Rows the report listed that changed since: left exactly as they are now. */
  skipped: Array<{ id: string; why: string }>;
}

/** PENDING -> FAILED for exactly the reported rows that are still as reported. */
export async function releaseStuckQueuedRequestRows(
  db: OperationStore,
  reported: readonly Pick<StuckQueuedRequestRow, "id" | "queueType">[],
  now: Date,
): Promise<StuckQueuedRequestRelease> {
  const result: StuckQueuedRequestRelease = { released: [], skipped: [] };
  for (const { id, queueType } of reported) {
    const row = await db.xeroSyncOperation.findFirst({
      where: { ...SCANNED_PENDING_WHERE, id, queueType },
      select: { requestPayload: true },
    });
    if (!row) {
      result.skipped.push({ id, why: "no longer an unclaimed, unresolved PENDING outbox row of this queue type" });
      continue;
    }
    if (!stuckQueuedRequestReason(queueType, row.requestPayload)) {
      result.skipped.push({ id, why: "its request is now one the outbox can send" });
      continue;
    }
    const written = await db.xeroSyncOperation.updateMany({
      where: {
        ...SCANNED_PENDING_WHERE,
        id,
        queueType,
        requestPayload: sameStoredRequest(row.requestPayload),
      },
      data: {
        status: "FAILED",
        completedAt: now,
        lastErrorCode: XERO_STUCK_QUEUED_REQUEST_RELEASED_CODE,
        lastErrorMessage: STUCK_QUEUED_REQUEST_RELEASE_MESSAGE,
      },
    });
    if (written.count === 1) result.released.push(id);
    else result.skipped.push({ id, why: "changed while it was being released" });
  }
  return result;
}

/**
 * The command line (`scripts/xero-stuck-queued-request-report.ts`): the list by
 * default; `--release` then releases exactly the rows it listed and reports
 * what changed. Exit 0 done, 1 a refused argument. Output names rows and the
 * records they belong to, so it stays off public channels.
 */
export async function runStuckQueuedRequestReportCli(
  argv: readonly string[],
  io: { db: OperationStore; now: () => Date; out: (text: string) => void; err: (text: string) => void },
): Promise<number> {
  const unknown = argv.filter((arg) => arg !== "--release");
  if (unknown.length > 0) {
    io.err(`Unknown argument ${unknown[0]}. Usage: pnpm run xero:stuck-queued-report [--release]`);
    return 1;
  }
  const rows = await findStuckQueuedRequestRows(io.db);
  io.out(`${rows.length} PENDING Xero outbox row(s) hold no request the outbox can send.`);
  for (const row of rows) {
    io.out(`${row.id}  ${row.queueType}  ${row.localModel ?? "-"}:${row.localId ?? "-"}  created ${row.createdAt.toISOString()}  ${row.reason}`);
  }
  if (!argv.includes("--release")) {
    if (rows.length > 0) io.out("Nothing was changed. Run again with --release to move exactly these rows to FAILED for an officer's Retry.");
    return 0;
  }
  const release = await releaseStuckQueuedRequestRows(io.db, rows, io.now());
  io.out(`Released ${release.released.length} row(s) to FAILED; skipped ${release.skipped.length}. No Xero call was made.`);
  for (const skipped of release.skipped) io.out(`skipped ${skipped.id}: ${skipped.why}`);
  return 0;
}
