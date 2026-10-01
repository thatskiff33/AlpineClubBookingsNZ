// Action and finding builders (including Xero amount-evidence mismatch
// detection and booking summary assembly) for the booking-vs-Xero repair tool.
// Extracted verbatim from xero-booking-repair.ts (#1208 item 2).
import { bookingOwner } from "@/lib/booking-owner";
import type {
  BookingClassificationContext,
  BookingXeroRepairAction,
  BookingXeroRepairBookingSummary,
  MutableFinding,
  ResolvedLocalObject,
  RetryableOperationMatch,
  XeroAmountEvidence,
  XeroObjectLinkRecord,
  XeroOperationRecord,
} from "./xero-booking-repair-types";
import { buildMemberName } from "./xero-booking-repair-analysis";
import {
  getOperationQueueTypeHint,
  isSuccessfulXeroOperation,
  readStoredXeroAmountCents,
  toIsoDate,
} from "./xero-booking-repair-utils";
import { unsettledRefundNoteRows } from "@/lib/xero-refund-note-unsettled";

export function addAction(
  actionMap: Map<string, BookingXeroRepairAction>,
  action: Omit<BookingXeroRepairAction, "status" | "resultMessage">
) {
  const existing = actionMap.get(action.key);
  if (existing) {
    return existing;
  }

  const nextAction: BookingXeroRepairAction = {
    ...action,
    status: action.type === "MARK_MANUAL_REVIEW" ? "manual_review" : "planned",
    resultMessage: null,
  };
  actionMap.set(action.key, nextAction);
  return nextAction;
}

export function addFinding(
  findings: MutableFinding[],
  input: MutableFinding
) {
  findings.push(input);
}

/**
 * A repair offer to re-run an operation. It is auto-applied, so it takes only
 * the `retryable` match (#3635, `INV-INT-025`): a row an officer resolved in
 * Xero, or one the retry helper refuses, cannot reach here.
 */
export function buildRetryAction(
  bookingId: string,
  match: RetryableOperationMatch
) {
  const { operation } = match;
  return {
    key: `retry:${operation.id}`,
    bookingId,
    type: "REQUEUE_XERO_OPERATION" as const,
    description: `Requeue Xero operation ${operation.id} (${operation.entityType}/${operation.operationType}).`,
    safeToAutoApply: match.retryMeta.supported,
    payload: {
      operationId: operation.id,
    },
  };
}

/**
 * #3635 (orchestrator decision 2, `INV-INT-025`): an operation an officer
 * resolved in Xero, where the club's records hold no document for it. Resolved
 * means "never re-run", not "never reported": info level, no action, nothing
 * auto-applied - the shape of `MANUALLY_SETTLED_NO_XERO_EXPECTED` - so a wrong
 * resolve can still be seen and put right by hand.
 */
export function addResolvedInXeroFinding(
  findings: MutableFinding[],
  operation: XeroOperationRecord,
  document: string,
  extraDetails: Record<string, unknown> = {}
) {
  addFinding(findings, {
    code: "RESOLVED_IN_XERO_BY_OFFICER",
    severity: "info",
    summary: `An officer marked this booking's Xero ${document} operation resolved in Xero, so it is treated as done and is never re-run. The club's records hold no Xero ${document} for it; if the resolve was a mistake, raise it by hand in Xero.`,
    safeToAutoApply: false,
    details: {
      ...extraDetails,
      operationId: operation.id,
      operationStatus: operation.status,
      manuallyResolvedAt: operation.manuallyResolvedAt,
      manuallyResolvedReason: operation.manuallyResolvedReason,
    },
    actionKeys: [],
  });
}

/**
 * #3548 (review F5/F6): a completed refund-note row whose note has neither its
 * settling payment nor a skip on record (a pre-#3548 early return closed it
 * with neither), or one Xero shows part-settled. Report-first: the settle is
 * never auto-applied, because an officer may have left an old note open on
 * purpose; an operator applies it by key (`--apply-action`), and it runs the
 * one read-back-then-settle. A part-settled note's remainder is settled in
 * Xero by hand; its action then only reads the note back and records it, never
 * paying. `refundPaymentLinks` are the payment's `REFUND_PAYMENT` links active
 * or not (`refundPaymentLinkWhere`), the evidence the report reads too.
 */
export function addUnsettledRefundCreditNoteFindings(
  findings: MutableFinding[],
  actionMap: Map<string, BookingXeroRepairAction>,
  bookingId: string,
  refundPaymentLinks: XeroObjectLinkRecord[],
  paymentOperations: XeroOperationRecord[],
) {
  for (const row of unsettledRefundNoteRows(paymentOperations, refundPaymentLinks)) {
    const partSettled = row.kind === "part-settled";
    const note = row.creditNoteNumber ?? row.creditNoteId;
    const action = addAction(actionMap, {
      key: `settle-refund-note:${row.paymentId}:${row.creditNoteId}`,
      bookingId,
      type: "SETTLE_REFUND_CREDIT_NOTE",
      description: partSettled
        ? `Read part-settled refund credit note ${note} back from Xero and record the payments it now shows on operation ${row.operationId}; never pays.`
        : `Read refund credit note ${note} back from Xero and record its settling payment, or why none is due, on operation ${row.operationId}.`,
      safeToAutoApply: false,
      payload: { operationId: row.operationId, paymentId: row.paymentId, creditNoteId: row.creditNoteId },
    });
    addFinding(findings, {
      code: "REFUND_CREDIT_NOTE_UNSETTLED",
      severity: "warning",
      summary: partSettled
        ? "A refund credit note is part-settled in Xero. Settle the remainder in Xero by hand, then apply the action by key to record it."
        : "A refund credit note's operation completed with neither its settling payment nor a reason none is due. Review it, then apply the settle action by key if the note should be paid.",
      safeToAutoApply: false,
      details: { ...row },
      actionKeys: [action.key],
    });
  }
}

export function buildManualReviewAction(bookingId: string, reason: string) {
  return {
    key: `manual:${bookingId}:${reason}`,
    bookingId,
    type: "MARK_MANUAL_REVIEW" as const,
    description: reason,
    safeToAutoApply: false,
    payload: {
      reason,
    },
  };
}

function collectXeroAmountEvidence(params: {
  resolved: ResolvedLocalObject;
  links: XeroObjectLinkRecord[];
  operations: XeroOperationRecord[];
  xeroObjectType: string;
  role: string;
  entityType: string;
  operationType: string;
  payloadQueueType?: string;
}): XeroAmountEvidence[] {
  const evidence: XeroAmountEvidence[] = [];

  for (const link of params.links) {
    if (
      link.xeroObjectType !== params.xeroObjectType ||
      link.role !== params.role ||
      link.xeroObjectId !== params.resolved.objectId
    ) {
      continue;
    }

    const amountCents = readStoredXeroAmountCents(link.metadata);
    if (amountCents !== null) {
      evidence.push({
        source: "link",
        amountCents,
        linkId: link.id,
      });
    }
  }

  for (const operation of params.operations) {
    if (
      operation.entityType !== params.entityType ||
      operation.operationType !== params.operationType ||
      !isSuccessfulXeroOperation(operation) ||
      (operation.xeroObjectId && operation.xeroObjectId !== params.resolved.objectId) ||
      // #1427: an op of a DIFFERENT queueType is another money object's
      // ledger (e.g. an account-credit note beside the invoice-applied
      // note) — it must not pollute this object's evidence.
      !operationQueueTypeCompatible(operation, params.payloadQueueType)
    ) {
      continue;
    }

    const requestAmountCents = readStoredXeroAmountCents(operation.requestPayload);
    if (requestAmountCents !== null) {
      evidence.push({
        source: "operation-request",
        amountCents: requestAmountCents,
        operationId: operation.id,
      });
    }

    const responseAmountCents = readStoredXeroAmountCents(operation.responsePayload);
    if (responseAmountCents !== null) {
      evidence.push({
        source: "operation-response",
        amountCents: responseAmountCents,
        operationId: operation.id,
      });
    }
  }

  return evidence;
}

// #1427: is this operation the queueType we are recovering evidence for? A
// DIFFERENT queueType belongs to another money object (a modification holds
// BOTH an invoice-applied credit-note op and an account-credit-note op —
// same entityType and operationType, different amounts) and must never be
// read as this object's evidence. getOperationQueueTypeHint resolves the
// kind across every ledger era (column, payload, correlation-key segment —
// executors overwrite payloads at dispatch and the #1347 column backfill
// copied from those overwritten payloads, so the key segment is decisive
// for pre-column executed rows). Rows carrying no hint at all stay
// admissible.
function operationQueueTypeCompatible(
  operation: XeroOperationRecord,
  payloadQueueType: string | undefined
): boolean {
  if (!payloadQueueType) {
    return true;
  }
  const queueType = getOperationQueueTypeHint(operation);
  return queueType === null || queueType === payloadQueueType;
}

// #1427: recover the amount a Xero money object was actually enqueued or
// executed with. The policy-limited settlement a modification credit note
// carries is NOT reconstructable from the modification row (the
// cancellation-policy tier depended on days-until-check-in at modification
// time), so the stored ledger is the record of record. Priority:
//  1. the best-ranked typed enqueue payload — replaying that amount rebuilds
//     the identical amount-embedding correlation key, keeping Xero-side
//     dedup intact on a requeue (the #1354 queued-payload-first rule);
//  2. link metadata;
//  3. an executed object's response totals;
//  4. last resort, an untyped legacy enqueue payload (no queueType named).
// Operation rank within each arm: an op tied to the resolved object's own
// id beats null-id rows from other attempts; CANCELLED attempts rank last
// (a deliberately retired row — often a mis-sized re-queue an operator
// killed — is the weakest record); then OLDEST first, because the first
// enqueue is the primary-path settlement decision and later rows are
// re-queues and repair attempts; then id, so equal timestamps stay
// deterministic across runs. Unlike collectXeroAmountEvidence this reads
// operations in ANY status: a FAILED or CANCELLED attempt still records
// what the app decided the settlement was.
export function recoverStoredXeroAmountCents(params: {
  links: XeroObjectLinkRecord[];
  operations: XeroOperationRecord[];
  xeroObjectType: string;
  role: string;
  entityType: string;
  operationType: string;
  objectId?: string | null;
  payloadQueueType?: string;
}): {
  amountCents: number;
  source: "operation-request" | "link" | "operation-response";
} | null {
  const operations = params.operations
    .filter(
      (operation) =>
        operation.entityType === params.entityType &&
        operation.operationType === params.operationType &&
        (!params.objectId ||
          !operation.xeroObjectId ||
          operation.xeroObjectId === params.objectId) &&
        operationQueueTypeCompatible(operation, params.payloadQueueType)
    )
    .sort((a, b) => {
      const aExact = params.objectId && a.xeroObjectId === params.objectId ? 0 : 1;
      const bExact = params.objectId && b.xeroObjectId === params.objectId ? 0 : 1;
      const aCancelled = a.status === "CANCELLED" ? 1 : 0;
      const bCancelled = b.status === "CANCELLED" ? 1 : 0;
      return (
        aExact - bExact ||
        aCancelled - bCancelled ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id)
      );
    });

  // The list above is queue-type-vetted, so the loose read is safe here:
  // both request-payload generations carry the settlement under
  // refundAmountCents — the enqueue-time typed shape AND the shape the
  // invoice-applied executor overwrites at dispatch (which readQueuedOutbox-
  // Payload could not parse, having lost its queueType key).
  for (const operation of operations) {
    const amountCents = readStoredXeroAmountCents(operation.requestPayload);
    if (amountCents !== null) {
      return { amountCents, source: "operation-request" };
    }
  }

  for (const link of params.links) {
    if (
      link.xeroObjectType !== params.xeroObjectType ||
      link.role !== params.role ||
      (params.objectId ? link.xeroObjectId !== params.objectId : false)
    ) {
      continue;
    }

    const amountCents = readStoredXeroAmountCents(link.metadata);
    if (amountCents !== null) {
      return { amountCents, source: "link" };
    }
  }

  for (const operation of operations) {
    const amountCents = readStoredXeroAmountCents(operation.responsePayload);
    if (amountCents !== null) {
      return { amountCents, source: "operation-response" };
    }
  }

  return null;
}

export function addXeroAmountMismatchFinding(params: {
  findings: MutableFinding[];
  actionMap: Map<string, BookingXeroRepairAction>;
  bookingId: string;
  expectedAmountCents: number;
  resolved: ResolvedLocalObject;
  links: XeroObjectLinkRecord[];
  operations: XeroOperationRecord[];
  xeroObjectType: string;
  role: string;
  entityType: string;
  operationType: string;
  payloadQueueType?: string;
  summary: string;
  details: Record<string, unknown>;
}) {
  const evidence = collectXeroAmountEvidence({
    resolved: params.resolved,
    links: params.links,
    operations: params.operations,
    xeroObjectType: params.xeroObjectType,
    role: params.role,
    entityType: params.entityType,
    operationType: params.operationType,
    payloadQueueType: params.payloadQueueType,
  });
  const mismatches = evidence.filter(
    (item) => item.amountCents !== params.expectedAmountCents
  );

  if (mismatches.length === 0) {
    return;
  }

  const action = addAction(
    params.actionMap,
    buildManualReviewAction(params.bookingId, params.summary)
  );

  addFinding(params.findings, {
    code: "XERO_AMOUNT_MISMATCH",
    severity: "manual_review",
    summary: params.summary,
    safeToAutoApply: false,
    details: {
      ...params.details,
      xeroObjectType: params.xeroObjectType,
      xeroObjectId: params.resolved.objectId,
      expectedAmountCents: params.expectedAmountCents,
      evidence,
      mismatches,
    },
    actionKeys: [action.key],
  });
}

export function buildLinkRepairAction(params: {
  bookingId: string;
  localModel: "Payment" | "Booking" | "BookingModification";
  localId: string;
  xeroObjectType: string;
  xeroObjectId: string;
  xeroObjectNumber?: string | null;
  xeroObjectUrl?: string | null;
  role: string;
  description: string;
}): Omit<BookingXeroRepairAction, "status" | "resultMessage"> {
  return {
    key: `link:${params.localModel}:${params.localId}:${params.xeroObjectType}:${params.role}:${params.xeroObjectId}`,
    bookingId: params.bookingId,
    type: "SYNC_BOOKING_SCOPED_LINK",
    description: params.description,
    safeToAutoApply: true,
    payload: {
      localModel: params.localModel,
      localId: params.localId,
      xeroObjectType: params.xeroObjectType,
      xeroObjectId: params.xeroObjectId,
      xeroObjectNumber: params.xeroObjectNumber ?? null,
      xeroObjectUrl: params.xeroObjectUrl ?? null,
      role: params.role,
    },
  };
}

export function buildBookingSummary(
  context: BookingClassificationContext,
  findings: MutableFinding[],
  actionMap: Map<string, BookingXeroRepairAction>
): BookingXeroRepairBookingSummary {
  const actions = [...actionMap.values()];
  return {
    bookingId: context.booking.id,
    bookingStatus: context.booking.status,
    paymentId: context.booking.payment?.id ?? null,
    paymentStatus: context.booking.payment?.status ?? null,
    memberId: bookingOwner(context.booking).memberId,
    memberName: buildMemberName(context.booking),
    memberEmail: bookingOwner(context.booking).member.email,
    checkIn: toIsoDate(context.booking.checkIn),
    checkOut: toIsoDate(context.booking.checkOut),
    findings: findings.map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      summary: finding.summary,
      safeToAutoApply: finding.safeToAutoApply,
      details: finding.details,
      actions: finding.actionKeys
        .map((actionKey) => actionMap.get(actionKey))
        .filter((action): action is BookingXeroRepairAction => Boolean(action)),
    })),
    actions,
  };
}
