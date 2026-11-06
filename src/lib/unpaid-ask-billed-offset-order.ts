/**
 * #3954 review round 7: A REDUCTION'S BILLED-OFFSET NOTE IS RAISED AFTER THE
 * EDIT'S OWN NOTE, NOT MERELY AFTER ONE THAT HAPPENS TO BE QUEUED ALREADY.
 *
 * The billed-offset invoice-correction note (`queueUnpaidAskBilledOffsetNote`)
 * is queued inside the edit's transaction; the edit's own note - for what it
 * refunded or credited of the reduction left after the ask - is queued after
 * commit by its Xero leg (`queueXeroBookingEditSettlement`). An outbox run in
 * between found no own note to wait for and raised the billed offset first.
 *
 * So the edit records on the billed-offset note's payload whether an own note
 * is EXPECTED (`OWN_NOTE_EXPECTED_KEY`): a primary invoice exists and the
 * reduction left something after the ask for its Xero leg to note
 * (`xeroRefundAmountCents`), not one an organiser's card refund raises later.
 * While one is expected and neither an own-note operation nor an unscoped
 * own-note link exists, the note waits (`createXeroCreditNoteForModification`
 * returns it to PENDING, looked at again every `BILLED_OFFSET_OWN_NOTE_RECHECK_MS`
 * rather than on every kick). After `BILLED_OFFSET_OWN_NOTE_WAIT_MS` it stops
 * waiting and fails, and the booking-vs-Xero repair pass hands it to a person
 * (`awaitsMissingOwnNote`) rather than retrying it automatically. An
 * operator's retry raises it without the wait.
 *
 * Pure: the outbox's builder and the repair pass read the same predicates.
 */
import { asRecord } from "@/lib/xero-json";
import {
  XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE,
} from "@/lib/xero-operation-outbox-payload";
import { linkReviewTaskId, queuedReviewTaskId } from "@/lib/xero-review-task-key";
import { scanSpacesWaitCode } from "@/lib/xero-operation-wait-spacing";

/** The billed-offset note's payload key: the edit expects an own note of its own. */
export const OWN_NOTE_EXPECTED_KEY = "ownNoteExpected" as const;

/** How long a billed-offset note waits for an expected own note before a person decides. */
export const BILLED_OFFSET_OWN_NOTE_WAIT_MS = 6 * 60 * 60 * 1000;

/**
 * Round 8: the code a billed-offset note carries while it waits for an own
 * note that is not queued yet, and how long the outbox leaves it before
 * looking again. It returns to PENDING with its `createdAt` unchanged, so the
 * oldest-first scan would otherwise hand it a slot on every kick, for up to
 * `BILLED_OFFSET_OWN_NOTE_WAIT_MS`, ahead of work that can run.
 */
export const BILLED_OFFSET_AWAITING_OWN_NOTE_CODE = "BILLED_OFFSET_AWAITING_OWN_NOTE" as const;
export const BILLED_OFFSET_OWN_NOTE_RECHECK_MS = 5 * 60 * 1000;

/**
 * The outbox scan's filter (round 8): leave out a note returned to wait for an
 * own note until its recheck is due. Every other row - a null code included,
 * which `not` alone would drop - is scanned as before.
 */
export function outboxScanLeavesAwaitingOwnNote(now: Date) {
  return scanSpacesWaitCode(BILLED_OFFSET_AWAITING_OWN_NOTE_CODE, BILLED_OFFSET_OWN_NOTE_RECHECK_MS, now);
}

/** The message a billed-offset note fails with once it has waited too long. */
export const BILLED_OFFSET_OWN_NOTE_MISSING_MESSAGE =
  "Invoice-correction credit note held: the edit's own credit note was expected first and has not been queued. Check that note, then retry this one.";

/** Whether the edit expects an own note beside its billed-offset note. */
export function ownNoteExpected(settled: {
  hasIssuedXeroInvoice: boolean;
  xeroRefundAmountCents: number;
  organiserChildRefund: unknown;
}): boolean {
  return settled.hasIssuedXeroInvoice && settled.xeroRefundAmountCents > 0 && !settled.organiserChildRefund;
}

/** Whether a queued billed-offset note's payload records that an own note is expected. */
export function queuedOwnNoteExpected(operation: { requestPayload: unknown }): boolean {
  return asRecord(operation.requestPayload)?.[OWN_NOTE_EXPECTED_KEY] === true;
}

const OWN_NOTE_QUEUE_TYPES: readonly string[] = [
  XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE,
];
const OWN_NOTE_LINK_ROLES: readonly string[] = ["MODIFICATION_CREDIT_NOTE", "MODIFICATION_ACCOUNT_CREDIT_NOTE"];

/**
 * An edit's own (unscoped) note operation - either kind, any status but
 * CANCELLED. THE ONE DEFINITION (round 8, `INV-SSOT-001`): the outbox's wait
 * (`createXeroCreditNoteForModification`) and the repair pass both read it.
 * An account-credit note counts like an invoice-applied one: the edit's Xero
 * leg raises whichever its settlement chose, and `ownNoteExpected` cannot tell
 * them apart. A FAILED own note counts as present, so the billed-offset note
 * is then raised beside it rather than held behind a retry nobody has made.
 */
export function isOwnModificationNoteOperation(operation: {
  entityType: string;
  operationType: string;
  queueType: string | null;
  status: string;
  requestPayload: unknown;
}): boolean {
  return (
    operation.entityType === "CREDIT_NOTE" &&
    operation.operationType === "CREATE" &&
    operation.queueType !== null &&
    OWN_NOTE_QUEUE_TYPES.includes(operation.queueType) &&
    operation.status !== "CANCELLED" &&
    !queuedReviewTaskId(operation)
  );
}

/** An edit's own (unscoped) note link - either kind. */
export function isOwnModificationNoteLink(link: {
  xeroObjectType: string;
  role: string | null;
  active?: boolean;
  metadata: unknown;
}): boolean {
  return (
    link.xeroObjectType === "CREDIT_NOTE" &&
    link.role !== null &&
    OWN_NOTE_LINK_ROLES.includes(link.role) &&
    link.active !== false &&
    !linkReviewTaskId(link)
  );
}

/**
 * The repair pass's reading: a billed-offset note that expected an own note
 * which neither an operation nor a link shows. Its retry is a person's call.
 */
export function awaitsMissingOwnNote(
  billedOffsetOperation: { requestPayload: unknown },
  edit: {
    operations: readonly Parameters<typeof isOwnModificationNoteOperation>[0][];
    links: readonly Parameters<typeof isOwnModificationNoteLink>[0][];
  },
): boolean {
  return (
    queuedOwnNoteExpected(billedOffsetOperation) &&
    !edit.operations.some(isOwnModificationNoteOperation) &&
    !edit.links.some(isOwnModificationNoteLink)
  );
}
