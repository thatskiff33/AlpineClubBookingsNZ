import { recordedCreditGiveBack } from "@/lib/booking-credit-give-back-marker";
import { recordedUnpaidAskBilledOffsetCents } from "@/lib/unpaid-ask-offset-marker";
import { asRecord, readString } from "@/lib/xero-json";
import {
  APPLIED_CREDIT_GIVE_BACK_NOTE_SCOPE,
  isGiveBackNoteScope,
  queuedReviewTaskId,
  UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE,
} from "@/lib/xero-review-task-key";
import type { BookingXeroRepairAction, MutableFinding, XeroOperationRecord } from "./xero-booking-repair-types";
import { addAction, addFinding, buildRetryAction } from "./xero-booking-repair-findings";
import { getBlockingOperation } from "./xero-booking-repair-object-resolution";
import { isSuccessfulXeroOperation } from "./xero-booking-repair-utils";

/**
 * An edit's SCOPED SIDE NOTES, each an invoice-allocated modification note of
 * its own beside the edit's own, always scoped on its operation's payload and
 * on the links it records, so the repair pass reads the edit's own note
 * without them and checks each separately - neither hides the other:
 *
 * - #3809: applied credit given back (`giveBackNoteScope`) - alone, or beside
 *   a card or bank refund's note or a credit election's unallocated one;
 * - #3954 (owner decision 10 Oct 2026, "Auto credit note", `INV-PAY-120`): the
 *   part of a reduction's unpaid-ask offset the primary invoice had already
 *   billed, an invoice correction (`UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE`).
 */
function noteScopes(item: { requestPayload?: unknown; metadata?: unknown }): (string | undefined)[] {
  return [
    "requestPayload" in item ? queuedReviewTaskId({ requestPayload: item.requestPayload }) : undefined,
    readString(asRecord(item.metadata)?.reviewTaskId) ?? undefined,
  ];
}

function isGiveBackScoped(item: { requestPayload?: unknown; metadata?: unknown }): boolean {
  return noteScopes(item).some(isGiveBackNoteScope);
}

function isBilledOffsetScoped(item: { requestPayload?: unknown; metadata?: unknown }): boolean {
  return noteScopes(item).includes(UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE);
}

function isScopedSideNote(item: { requestPayload?: unknown; metadata?: unknown }): boolean {
  return isGiveBackScoped(item) || isBilledOffsetScoped(item);
}

/** An edit's links and operations without its scoped side notes'. */
export function withoutScopedSideNotes<L extends { metadata?: unknown }, O extends { requestPayload: unknown }>(
  links: L[],
  operations: O[],
): { links: L[]; operations: O[] } {
  return {
    links: links.filter((link) => !isScopedSideNote(link)),
    operations: operations.filter((operation) => !isScopedSideNote(operation)),
  };
}

/** A scoped side note an edit's history row says is due, and its operations. */
export type ScopedSideNote<O> = {
  kind: "give-back" | "billed-offset";
  cents: number;
  operations: O[];
};

function isNoteCreate(operation: { entityType: string; operationType: string }): boolean {
  return operation.entityType === "CREDIT_NOTE" && operation.operationType === "CREATE";
}

/**
 * Where the edit's history row records applied credit given back - which
 * always takes an allocated note of its own, scoped - that note's operations.
 * `null` means none is due.
 */
export function scopedGiveBackNote<O extends { entityType: string; operationType: string; requestPayload: unknown }>({
  newData,
  operations,
}: {
  newData: unknown;
  operations: O[];
}): ScopedSideNote<O> | null {
  const recorded = recordedCreditGiveBack(newData);
  if (!recorded || recorded.givenBackCents <= 0) return null;
  return {
    kind: "give-back",
    cents: recorded.givenBackCents,
    operations: operations.filter((operation) => isNoteCreate(operation) && isGiveBackScoped(operation)),
  };
}

/**
 * #3954: where the reduction's history row records an offset the primary
 * invoice had already billed (`recordedUnpaidAskBilledOffsetCents`), the
 * invoice-correction note the edit queued for it, by its scope. `null` means
 * none is due - the ask was cancelled before anything billed it, or the
 * increase's own supplementary invoice was retired instead.
 */
export function scopedBilledOffsetNote<O extends { entityType: string; operationType: string; requestPayload: unknown }>({
  newData,
  operations,
}: {
  newData: unknown;
  operations: O[];
}): ScopedSideNote<O> | null {
  const cents = recordedUnpaidAskBilledOffsetCents(newData);
  if (cents <= 0) return null;
  return {
    kind: "billed-offset",
    cents,
    operations: operations.filter((operation) => isNoteCreate(operation) && isBilledOffsetScoped(operation)),
  };
}

const SIDE_NOTE_REPAIR = {
  "give-back": {
    keyPrefix: "queue:give-back-note",
    label: "give-back",
    description: "Queue the missing Xero credit note for the applied credit a booking modification gave back.",
    summary: "A booking modification gave back applied credit, but no Xero credit note for it exists.",
    payload: { refundMethod: "account-credit", reviewTaskId: APPLIED_CREDIT_GIVE_BACK_NOTE_SCOPE },
    refundAmountSource: "recorded-give-back",
  },
  "billed-offset": {
    keyPrefix: "queue:billed-offset-note",
    label: "invoice-correction",
    description:
      "Queue the missing Xero invoice-correction credit note for the part of a cancelled or reduced unpaid extra payment the booking's invoice had already billed.",
    summary:
      "A booking modification cancelled part of an unpaid extra payment the booking's Xero invoice had already billed, but no invoice-correction credit note for it exists.",
    payload: { noteWording: "invoice-correction", reviewTaskId: UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE },
    refundAmountSource: "recorded-billed-offset",
  },
} as const;

/**
 * VERIFY THE SCOPED SIDE NOTE EXISTS, OR QUEUE IT. A failed or partial one is
 * retried; a pending, running or officer-resolved one answers for itself; one
 * that never ran is queued under its own scope, so the enqueue's own-key dedupe
 * finds the edit's row and adds no second note. Nothing is reported once it
 * has succeeded.
 */
export function addScopedSideNoteFindings({
  bookingId,
  modificationId,
  note,
  actionMap,
  findings,
}: {
  bookingId: string;
  modificationId: string;
  note: ScopedSideNote<XeroOperationRecord>;
  actionMap: Map<string, BookingXeroRepairAction>;
  findings: MutableFinding[];
}): void {
  const repair = SIDE_NOTE_REPAIR[note.kind];
  const blocking = getBlockingOperation(note.operations, "CREDIT_NOTE", "CREATE");
  if (blocking?.kind === "retryable") {
    const action = addAction(actionMap, buildRetryAction(bookingId, blocking));
    addFinding(findings, {
      code: "BLOCKED_BY_XERO_OPERATION",
      severity: "warning",
      summary: `A failed or partial Xero ${repair.label} credit note operation is blocking modification ${modificationId}.`,
      safeToAutoApply: true,
      details: { modificationId, operationId: blocking.operation.id, operationStatus: blocking.operation.status },
      actionKeys: [action.key],
    });
  } else if (!blocking && !note.operations.some(isSuccessfulXeroOperation)) {
    const action = addAction(actionMap, {
      key: `${repair.keyPrefix}:${modificationId}`,
      bookingId,
      type: "QUEUE_MODIFICATION_CREDIT_NOTE",
      description: repair.description,
      safeToAutoApply: true,
      payload: { bookingId, bookingModificationId: modificationId, refundAmountCents: note.cents, ...repair.payload },
    });
    addFinding(findings, {
      code: "MISSING_MODIFICATION_CREDIT_NOTE",
      severity: "critical",
      summary: repair.summary,
      safeToAutoApply: true,
      details: { modificationId, refundAmountCents: note.cents, refundAmountSource: repair.refundAmountSource },
      actionKeys: [action.key],
    });
  }
}
