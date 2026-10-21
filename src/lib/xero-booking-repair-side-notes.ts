import { recordedCreditGiveBack } from "@/lib/booking-credit-give-back-marker";
import {
  recordedBilledOffsetOwnNoteExpected,
  recordedReissuedAskInvoiceUnsureCents,
  recordedUnpaidAskBilledOffsetCents,
  recordedUnpaidAskBilledOffsetUnsureCents,
  REISSUED_ASK_INVOICE_UNSURE_SUMMARY,
  UNPAID_ASK_BILLED_OFFSET_UNSURE_SUMMARY,
} from "@/lib/unpaid-ask-offset-marker";
import {
  APPLIED_CREDIT_GIVE_BACK_NOTE_SCOPE,
  isGiveBackNoteScope,
  isUnpaidAskBilledOffsetNoteScope,
  linkReviewTaskId,
  queuedReviewTaskId,
  UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE,
} from "@/lib/xero-review-task-key";
import { awaitsMissingOwnNote, OWN_NOTE_EXPECTED_KEY, queuedOwnNoteExpected } from "@/lib/unpaid-ask-billed-offset-order";
import type {
  BookingXeroRepairAction,
  MutableFinding,
  XeroObjectLinkRecord,
  XeroOperationRecord,
} from "./xero-booking-repair-types";
import { addAction, addFinding, buildManualReviewAction, buildRetryAction } from "./xero-booking-repair-findings";
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
    linkReviewTaskId({ metadata: item.metadata }),
  ];
}

function isGiveBackScoped(item: { requestPayload?: unknown; metadata?: unknown }): boolean {
  return noteScopes(item).some(isGiveBackNoteScope);
}

function isBilledOffsetScoped(item: { requestPayload?: unknown; metadata?: unknown }): boolean {
  return noteScopes(item).some(isUnpaidAskBilledOffsetNoteScope);
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
  /**
   * #4049, a billed-offset note only: whether the edit expected an own note
   * beside it, as its history row records it; null on a row written before #4049.
   */
  recordedOwnNoteExpected?: boolean | null;
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
    recordedOwnNoteExpected: recordedBilledOffsetOwnNoteExpected(newData),
  };
}

/** Round 7: a billed-offset note that stopped waiting for the edit's own note. */
export const BILLED_OFFSET_AWAITS_OWN_NOTE_SUMMARY =
  "A booking modification's invoice-correction credit note is waiting for the modification's own credit note, which was never queued. Check that note first - raise or retry it - then retry this one.";

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
      "Queue the missing Xero invoice-correction credit note for the part of a cancelled or reduced unpaid additional payment the booking's invoice had already billed.",
    summary:
      "A booking modification cancelled part of an unpaid additional payment the booking's Xero invoice had already billed, but no invoice-correction credit note for it exists.",
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
  edit,
  ownNoteDue = false,
  actionMap,
  findings,
}: {
  bookingId: string;
  modificationId: string;
  note: ScopedSideNote<XeroOperationRecord>;
  /** The edit's own operations and links, for whether its own note exists (round 7). */
  edit: { operations: readonly XeroOperationRecord[]; links: readonly XeroObjectLinkRecord[] };
  /**
   * Round 8, for a row written before #4049 only: the repair pass's own
   * reading that the edit owes an own note (the reduction left something
   * after the ask). Broader than the edit's rule (`repairOwnNoteExpected`).
   */
  ownNoteDue?: boolean;
  actionMap: Map<string, BookingXeroRepairAction>;
  findings: MutableFinding[];
}): void {
  const repair = SIDE_NOTE_REPAIR[note.kind];
  const blocking = getBlockingOperation(note.operations, "CREDIT_NOTE", "CREATE");
  if (blocking?.kind === "retryable" && note.kind === "billed-offset" && awaitsMissingOwnNote(blocking.operation, edit)) {
    // #3954 round 7: it stopped waiting for the edit's own note, which never
    // appeared. Retrying it now could raise it first, so a person decides.
    const action = addAction(actionMap, { ...buildRetryAction(bookingId, blocking), safeToAutoApply: false });
    addFinding(findings, {
      code: "BLOCKED_BY_XERO_OPERATION",
      severity: "manual_review",
      summary: BILLED_OFFSET_AWAITS_OWN_NOTE_SUMMARY,
      safeToAutoApply: false,
      details: { modificationId, operationId: blocking.operation.id, operationStatus: blocking.operation.status },
      actionKeys: [action.key],
    });
  } else if (blocking?.kind === "retryable") {
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
      payload: {
        bookingId,
        bookingModificationId: modificationId,
        refundAmountCents: note.cents,
        ...repair.payload,
        ...(note.kind === "billed-offset" && repairOwnNoteExpected(note.operations, note.recordedOwnNoteExpected ?? null, ownNoteDue)
          ? { [OWN_NOTE_EXPECTED_KEY]: true }
          : {}),
      },
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

/**
 * #3954 round 8, #4049: whether a billed-offset note the repair pass queues
 * waits for the edit's own note. The edit decides, once (`ownNoteExpected`):
 *
 * 1. RECORDED on its history row (#4049) - read as written;
 * 2. else CARRIED from any earlier operation of the note, whose payload holds
 *    the answer it was queued with;
 * 3. else, for a history row written before #4049 with no operation, the
 *    round-8 reading that an own note is due (`ownNoteDue`). It is broader than
 *    the edit's rule - it cannot see an organiser's card refund, or a
 *    reduction settled by giving back applied credit - so such a note may wait
 *    `BILLED_OFFSET_OWN_NOTE_WAIT_MS` and then go to a person
 *    (`awaitsMissingOwnNote`); it is never raised first.
 */
export function repairOwnNoteExpected(
  billedOffsetOperations: readonly { requestPayload: unknown }[],
  recordedOwnNoteExpected: boolean | null,
  ownNoteDue: boolean,
): boolean {
  if (recordedOwnNoteExpected !== null) return recordedOwnNoteExpected;
  return billedOffsetOperations.length > 0 ? billedOffsetOperations.some(queuedOwnNoteExpected) : ownNoteDue;
}

/**
 * #3954 rounds 6 and 7: where a reduction could not establish what the
 * primary invoice billed of its offset (`unpaidAskBilledOffsetUnsureCents`),
 * or what the smaller re-issue's own invoice owes beyond what it queued
 * (`reissuedAskInvoiceUnsureCents`), it credit-noted and invoiced nothing on a
 * guess. Each is reported for a person, never queued.
 */
export function addUnpaidAskUnsureFindings({
  bookingId,
  modification,
  reissueRetired,
  xeroInvoiceId,
  actionMap,
  findings,
}: {
  bookingId: string;
  modification: { id: string; newData: unknown };
  /**
   * Round 8: a later reduction retired this one's re-issue - directly, or the
   * increase that folded it in - and carried its uncertainty into its own
   * history, so the re-issue's own unsure invoice is not reported twice.
   */
  reissueRetired: boolean;
  xeroInvoiceId: string;
  actionMap: Map<string, BookingXeroRepairAction>;
  findings: MutableFinding[];
}): void {
  const unsure = [
    {
      code: "MISSING_MODIFICATION_CREDIT_NOTE" as const,
      summary: UNPAID_ASK_BILLED_OFFSET_UNSURE_SUMMARY,
      cents: recordedUnpaidAskBilledOffsetUnsureCents(modification.newData),
      detailKey: "billedOffsetUnsureCents",
    },
    {
      code: "MISSING_SUPPLEMENTARY_INVOICE" as const,
      summary: REISSUED_ASK_INVOICE_UNSURE_SUMMARY,
      cents: reissueRetired ? 0 : recordedReissuedAskInvoiceUnsureCents(modification.newData),
      detailKey: "reissuedAskInvoiceUnsureCents",
    },
  ];
  for (const { code, summary, cents, detailKey } of unsure) {
    if (cents <= 0) continue;
    const manualAction = addAction(actionMap, buildManualReviewAction(bookingId, summary));
    addFinding(findings, {
      code,
      severity: "manual_review",
      summary,
      safeToAutoApply: false,
      details: { modificationId: modification.id, [detailKey]: cents, xeroInvoiceId },
      actionKeys: [manualAction.key],
    });
  }
}
