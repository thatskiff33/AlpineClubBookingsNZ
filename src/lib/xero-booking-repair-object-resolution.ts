// Xero object resolution across local fields, links, and past operations for
// the booking-vs-Xero repair tool. Extracted verbatim from
// xero-booking-repair.ts (#1208 item 2).
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import { getXeroOperationRetryMeta } from "@/lib/xero-operation-retry";
import { isResolvedInXero } from "@/lib/xero-operation-resolution";
import {
  getOperationQueueTypeHint,
  isSuccessfulXeroOperation,
} from "./xero-booking-repair-utils";
import type {
  BlockingOperationMatch,
  RetryableOperationMatch,
  ResolvedLocalObject,
  XeroObjectLinkRecord,
  XeroOperationRecord,
} from "./xero-booking-repair-types";

const STUCK_OPERATION_MS = 30 * 60 * 1000;

function buildObjectUrl(
  xeroObjectType: string,
  objectId: string,
  fallbackUrl: string | null
) {
  if (fallbackUrl) {
    return fallbackUrl;
  }

  if (xeroObjectType === "INVOICE" || xeroObjectType === "ALLOCATION") {
    return buildXeroInvoiceUrl(objectId);
  }

  return null;
}

// #1427: an operation of a DIFFERENT queueType belongs to another money
// object that happens to share entityType/operationType (a modification
// holds both an invoice-applied credit-note op and an account-credit-note
// op). getOperationQueueTypeHint resolves the kind across every ledger era
// (column, payload, correlation-key segment — executors overwrite payloads
// at dispatch and the #1347 column backfill copied from those overwritten
// payloads, so the key segment is decisive for pre-column executed rows).
// Rows carrying no hint at all stay admissible.
function payloadQueueTypeCompatible(
  operation: XeroOperationRecord,
  payloadQueueType: string | undefined
): boolean {
  if (!payloadQueueType) {
    return true;
  }
  const queueType = getOperationQueueTypeHint(operation);
  return queueType === null || queueType === payloadQueueType;
}

export function resolveObjectFromCandidates(params: {
  fieldObjectId?: string | null;
  fieldObjectNumber?: string | null;
  fieldObjectUrl?: string | null;
  links: XeroObjectLinkRecord[];
  operations: XeroOperationRecord[];
  xeroObjectType: string;
  role?: string;
  entityType?: string;
  operationType?: string;
  // When set, operation candidates must carry this payload queueType (or a
  // legacy payload naming none) — link/field candidates are unaffected.
  payloadQueueType?: string;
}): ResolvedLocalObject | null {
  const candidates: ResolvedLocalObject[] = [];

  if (params.fieldObjectId) {
    candidates.push({
      objectId: params.fieldObjectId,
      objectNumber: params.fieldObjectNumber ?? null,
      objectUrl: params.fieldObjectUrl ?? buildObjectUrl(
        params.xeroObjectType,
        params.fieldObjectId,
        null
      ),
      source: "field",
      link: null,
      operation: null,
      conflicts: [],
    });
  }

  for (const link of params.links) {
    if (link.xeroObjectType !== params.xeroObjectType) {
      continue;
    }
    if (params.role && link.role !== params.role) {
      continue;
    }

    candidates.push({
      objectId: link.xeroObjectId,
      objectNumber: link.xeroObjectNumber ?? null,
      objectUrl: buildObjectUrl(params.xeroObjectType, link.xeroObjectId, link.xeroObjectUrl),
      source: "link",
      link,
      operation: null,
      conflicts: [],
    });
  }

  for (const operation of params.operations) {
    if (params.entityType && operation.entityType !== params.entityType) {
      continue;
    }
    if (params.operationType && operation.operationType !== params.operationType) {
      continue;
    }
    if (!isSuccessfulXeroOperation(operation)) {
      continue;
    }
    if (operation.xeroObjectType && operation.xeroObjectType !== params.xeroObjectType) {
      continue;
    }
    if (!operation.xeroObjectId) {
      continue;
    }
    if (!payloadQueueTypeCompatible(operation, params.payloadQueueType)) {
      continue;
    }

    candidates.push({
      objectId: operation.xeroObjectId,
      objectNumber: operation.xeroObjectNumber ?? null,
      objectUrl: buildObjectUrl(
        params.xeroObjectType,
        operation.xeroObjectId,
        operation.xeroObjectUrl ?? null
      ),
      source: "operation",
      link: null,
      operation,
      conflicts: [],
    });
  }

  const priority = { field: 0, link: 1, operation: 2 } satisfies Record<ResolvedLocalObject["source"], number>;
  // Reading the highest-priority candidate is what says there is a candidate
  // at all, so the "no local object" answer and the chosen one come from the
  // same read (#2800).
  const [chosen] = [...candidates].sort(
    (left, right) => priority[left.source] - priority[right.source]
  );
  if (chosen === undefined) {
    return null;
  }
  const uniqueIds = [...new Set(candidates.map((candidate) => candidate.objectId))];

  return {
    ...chosen,
    conflicts: uniqueIds.filter((objectId) => objectId !== chosen.objectId),
  };
}

/**
 * #3635 (`INV-INT-025`): the one way to turn an operation into a repair
 * retry offer. A row the retry helper refuses - including one an officer
 * resolved in Xero, which `getXeroOperationRetryMeta` refuses first - gives
 * null, so `buildRetryAction`, which accepts only this shape, can never
 * auto-apply a re-run of it.
 */
export function toRetryableOperationMatch(
  operation: XeroOperationRecord
): RetryableOperationMatch | null {
  const retryMeta = getXeroOperationRetryMeta(operation);
  return retryMeta.supported
    ? { kind: "retryable", operation, retryMeta: { ...retryMeta, supported: true } }
    : null;
}

export function getBlockingOperation(
  operations: XeroOperationRecord[],
  entityType: string,
  operationType: string,
  options?: { payloadQueueType?: string }
): BlockingOperationMatch | null {
  // WAITING_PAYMENT blocks like PENDING/RUNNING (#1356): a supplementary
  // invoice legitimately parked on its additional Stripe payment must not be
  // classified as "missing" — re-queueing it would mint a second operation
  // (under a different correlation key when the amounts differ) whose default
  // recordPayment books money before any capture exists.
  const relevant = operations.filter(
    (operation) =>
      operation.entityType === entityType &&
      operation.operationType === operationType &&
      ["FAILED", "PARTIAL", "PENDING", "RUNNING", "WAITING_PAYMENT"].includes(
        operation.status
      ) &&
      payloadQueueTypeCompatible(operation, options?.payloadQueueType)
  );

  // #3635 (`INV-INT-025`): a row an officer resolved in Xero is done. It never
  // outranks a live row - an old resolved FAILED row picked ahead of a newer
  // live failure would hide that failure - and it is never dropped either:
  // when it is all there is, "nothing blocking" would send the caller on to
  // mint a rival to the document the officer made by hand.
  const live = relevant.filter((operation) => !isResolvedInXero(operation));

  // The first live operation is read here: it is the fallback below, and its
  // absence is the "nothing live" answer (#2800).
  const [firstLive] = live;
  if (firstLive === undefined) {
    const [firstResolved] = relevant;
    return firstResolved === undefined
      ? null
      : { kind: "resolved", resolvedOperation: firstResolved };
  }

  const failedOrPartial = live.find((operation) =>
    ["FAILED", "PARTIAL"].includes(operation.status)
  );
  const chosen = failedOrPartial ?? firstLive;
  return (
    toRetryableOperationMatch(chosen) ?? {
      kind: "blocked",
      operation: chosen,
      retryMeta: getXeroOperationRetryMeta(chosen),
    }
  );
}

export function isStuckOperation(operation: XeroOperationRecord) {
  if (!["PENDING", "RUNNING"].includes(operation.status)) {
    return false;
  }

  return Date.now() - operation.createdAt.getTime() >= STUCK_OPERATION_MS;
}

/**
 * #3639: has the cancellation already answered the booking's invoice with a
 * credit note on the PAYMENT? The cancelled-open-invoice arm asks this before
 * it queues a clearing note, because its own lookup is for the booking-level
 * `MODIFICATION_CREDIT_NOTE` and sees neither payment-level shape:
 *
 * - the ACCOUNT-credit note an internet-banking cancel records on the payment
 *   (`enqueueXeroAccountCreditNoteOperation`);
 * - the REFUND note an internet-banking hold released before #3535 raised
 *   against the payment to answer its unpaid invoice.
 *
 * Either means a second, full clearing note would clear the same invoice twice.
 * A payment-level credit-note operation still queued, running or failed counts
 * too: it produces that note when it runs, and an operator retries it from the
 * outbox rather than this tool minting a rival. `refundCreditNote` is the
 * classifier's own resolution of the refund note, passed in so the two cannot
 * disagree about it.
 */
export function paymentNoteAnswersInvoice(
  refundCreditNote: ResolvedLocalObject | null,
  paymentLinks: XeroObjectLinkRecord[],
  paymentOperations: XeroOperationRecord[]
): boolean {
  return (
    refundCreditNote !== null ||
    resolveObjectFromCandidates({
      links: paymentLinks,
      operations: paymentOperations,
      xeroObjectType: "CREDIT_NOTE",
      role: "ACCOUNT_CREDIT_NOTE",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
    }) !== null ||
    getBlockingOperation(paymentOperations, "CREDIT_NOTE", "CREATE") !== null
  );
}
