// Xero object resolution across local fields, links, and past operations for
// the booking-vs-Xero repair tool. Extracted verbatim from
// xero-booking-repair.ts (#1208 item 2).
import { XERO_ACTIVE_OPERATION_STATUSES, XERO_RERUNNABLE_OPERATION_STATUSES } from "./xero-active-operation-statuses";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import { getXeroOperationRetryMeta } from "@/lib/xero-operation-retry";
import { isResolvedInXero } from "@/lib/xero-operation-resolution";
import { CLEARING_TARGET_LINK_ROLES, partialClearingNoteIsIncomplete } from "@/lib/xero-clearing-allocations";
import {
  isAdmissibleRepairOperation,
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
  // legacy payload naming none) — link/field candidates are unaffected. A
  // refund request's own note is never a candidate (`isAdmissibleRepairOperation`).
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
    if (!isAdmissibleRepairOperation(operation, params.payloadQueueType)) {
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

/**
 * A credit note's own create row, as the arm that would allocate the note reads
 * it (#3535, #4259, #4757). The worker that made the note also allocates it; a
 * refused allocation leaves that row PARTIAL, and its retry replays the
 * recorded plan, so a fresh allocation sized by the repair tool would be a
 * second one. In order:
 *
 * - `resolved`: an officer resolved the PARTIAL row in Xero and allocated by
 *   hand (`INV-INT-025`) - nothing retried or queued;
 * - `repairing`: a RUNNING row naming the note - a retry holds its PARTIAL
 *   repair claim - reported, never queued beside;
 * - `retry` / `unretryable`: a PARTIAL row with a planned invoice still
 *   unallocated, by `partialClearingNoteIsIncomplete`, so a row repaired
 *   before #4259 that stays PARTIAL stops counting once it is whole.
 *
 * Null when no row of the note's says it is unfinished.
 */
export type OwnNoteRowState =
  | { kind: "resolved" | "repairing"; operation: XeroOperationRecord }
  | { kind: "retry"; operation: XeroOperationRecord; retry: RetryableOperationMatch }
  | { kind: "unretryable"; operation: XeroOperationRecord; reason: string | null };

/**
 * The allocation links a note's PARTIAL retry reads (`unallocatedClearingTargets`'s
 * roles): the note's own and, since #4767, the role-less one, which
 * `linkAllocatesClearingTarget` counts only for the same note, invoice and amount.
 */
export function noteAllocationLinks(links: XeroObjectLinkRecord[]): XeroObjectLinkRecord[] {
  return links.filter(
    (link) => link.xeroObjectType === "ALLOCATION" && CLEARING_TARGET_LINK_ROLES.includes(link.role)
  );
}

export function readOwnNoteRowState(
  operations: XeroOperationRecord[],
  links: XeroObjectLinkRecord[],
  creditNoteId: string
): OwnNoteRowState | null {
  const noteRow = (status: string) =>
    operations.find(
      (operation) =>
        operation.entityType === "CREDIT_NOTE" &&
        operation.operationType === "CREATE" &&
        operation.status === status &&
        operation.xeroObjectId === creditNoteId
    );
  const partial = noteRow("PARTIAL");
  if (partial && isResolvedInXero(partial)) return { kind: "resolved", operation: partial };
  const repairing = noteRow("RUNNING");
  if (repairing) return { kind: "repairing", operation: repairing };
  if (!partial || !partialClearingNoteIsIncomplete(partial.requestPayload, creditNoteId, noteAllocationLinks(links))) {
    return null;
  }
  const retry = toRetryableOperationMatch(partial);
  return retry
    ? { kind: "retry", operation: partial, retry }
    : { kind: "unretryable", operation: partial, reason: getXeroOperationRetryMeta(partial).reason };
}

/**
 * The rows of one kind that can stand in a repair's way: live (PENDING,
 * RUNNING, WAITING_PAYMENT) or ended FAILED or PARTIAL, and admissible - the
 * one population `getBlockingOperation` ranks and `getLiveOperation` reads
 * (#4757, `INV-SSOT`). Rows resolved in Xero are kept; callers decide.
 */
export function blockingCandidates(
  operations: XeroOperationRecord[],
  entityType: string,
  operationType: string,
  options?: { payloadQueueType?: string }
): XeroOperationRecord[] {
  // WAITING_PAYMENT blocks like PENDING/RUNNING (#1356): a supplementary
  // invoice legitimately parked on its additional Stripe payment must not be
  // classified as "missing" — re-queueing it would mint a second operation
  // (under a different correlation key when the amounts differ) whose default
  // recordPayment books money before any capture exists.
  return operations.filter(
    (operation) =>
      operation.entityType === entityType &&
      operation.operationType === operationType &&
      (XERO_RERUNNABLE_OPERATION_STATUSES as readonly string[]).includes(operation.status) &&
      isAdmissibleRepairOperation(operation, options?.payloadQueueType)
  );
}

export function getBlockingOperation(
  operations: XeroOperationRecord[],
  entityType: string,
  operationType: string,
  options?: { payloadQueueType?: string }
): BlockingOperationMatch | null {
  const relevant = blockingCandidates(operations, entityType, operationType, options);

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

/**
 * #4757: a row of this kind in flight now (PENDING, RUNNING or WAITING_PAYMENT),
 * read directly: `getBlockingOperation` ranks a failed row ahead of a live one,
 * so a caller that must never act beside work in flight asks this instead.
 */
export function getLiveOperation(
  operations: XeroOperationRecord[],
  entityType: string,
  operationType: string
): XeroOperationRecord | null {
  return (
    blockingCandidates(operations, entityType, operationType).find(
      (operation) =>
        (XERO_ACTIVE_OPERATION_STATUSES as readonly string[]).includes(operation.status) &&
        !isResolvedInXero(operation)
    ) ?? null
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
