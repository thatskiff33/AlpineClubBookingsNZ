import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { editRefundHandBackOccurrenceKey, isEditRefundHandBackTask } from "@/lib/manual-refund-task-settlement-rules";
import { readModificationNoteWording, type ModificationNoteWording } from "@/lib/xero-refund-method";
import { isUnpaidAskBilledOffsetNoteScope, queuedReviewTaskId } from "@/lib/xero-review-task-key";
import { getJsonRecord } from "./amounts";
import {
  XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE,
} from "@/lib/xero-operation-outbox-payload";

/**
 * The modification credit notes, of these, that moved no cash, so they must not
 * fold into `Payment.refundedAmountCents`. They are allocated against the
 * invoice like a refund's note, but no money left. Read from the note's own
 * outbound operation, which records the wording and scope it was built with:
 *
 * - #3809 (review M2): worded as account credit when raised (`INV-PAY-101`) -
 *   applied credit given back, or a review's share given back;
 * - #3954 (owner decision 10 Oct 2026): a reduction's invoice correction for the
 *   part of its unpaid-ask offset the primary invoice had billed
 *   (`UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE`) - money the member never paid;
 * - #3979 (owner decision 13 Oct 2026, `INV-PAY-126`): any note worded as an
 *   invoice correction (`INV-PAY-116`). The edit words a note so only when it
 *   lowers an invoice nobody had paid - the payment was not captured and no
 *   Stripe refund went back - so the note is a price correction, not a refund.
 *   The wording is recorded on the note's own operation when it is RAISED, so
 *   the answer does not depend on whether the payment was captured by the time
 *   the inbound sync reads it: a note raised before the bank transfer still
 *   refunds nothing once the transfer settles, and a refund raised after it
 *   never carries this wording. One exception, decided per payment by the
 *   refunded-total repair (`invoiceCorrectionNoteIds`): against a bank receipt
 *   recorded at the stored figure the correction is still counted.
 * - #4315 (`INV-PAY-117`): an edit's own note whose refund hand-back has
 *   not completed. Allocating the note corrects the invoice; only completing
 *   the task records the bank refund. A dismissed task moved no cash either.
 */
export async function noCashModificationNoteIds(
  creditNoteIds: string[],
  db: Pick<Prisma.TransactionClient, "xeroSyncOperation" | "manualRefundTask"> = prisma,
): Promise<Set<string>> {
  const operations = await readNoteOperations(creditNoteIds, db);
  // #4315: an edit's invoice-applied note can arrive before its bank refund.
  // Only the edit's own note answers its hand-back; a review on the same edit
  // has its own settlement. Keep legacy notes without a hand-back unchanged.
  const ownEditKeys = new Map(operations.flatMap((operation) =>
    operation.localModel === "BookingModification" && operation.localId && !queuedReviewTaskId(operation)
      ? [[operation, editRefundHandBackOccurrenceKey(operation.localId)] as const] : [],
  ));
  const unpaidTasks = ownEditKeys.size === 0 ? [] : await db.manualRefundTask.findMany({
    where: {
      occurrenceKey: { in: [...ownEditKeys.values()] },
      status: { not: "COMPLETED" },
    },
    select: { kind: true, occurrenceKey: true },
  });
  const unpaidKeys = new Set(unpaidTasks.filter(isEditRefundHandBackTask).map((task) => task.occurrenceKey));
  return new Set(
    operations
      .filter((operation) => noteCashOf(operation) !== "refund" ||
        unpaidKeys.has(ownEditKeys.get(operation) ?? ""))
      .map((operation) => operation.xeroObjectId)
      .filter((id): id is string => id !== null),
  );
}

/**
 * #3979: of these notes, the invoice corrections (`INV-PAY-116` wording) - the
 * one no-cash class whose count depends on the payment: against a bank receipt
 * recorded at the stored figure (before #3979, or kept by the settle) the
 * receipt still includes the corrected amount, so the correction is counted as
 * refunded there to keep the payment's net at the cash (`INV-PAY-126`).
 * #3954's billed-offset corrections are not in it: they have never counted.
 */
export async function invoiceCorrectionNoteIds(
  creditNoteIds: string[],
  db: Pick<Prisma.TransactionClient, "xeroSyncOperation"> = prisma,
): Promise<Set<string>> {
  const operations = await readNoteOperations(creditNoteIds, db);
  return new Set(
    operations
      .filter((operation) => noteCashOf(operation) === "correction")
      .map((operation) => operation.xeroObjectId)
      .filter((id): id is string => id !== null),
  );
}

/** What a modification credit note did with cash: refunded it, corrected a price, or neither. */
export type ModificationNoteCash = "refund" | "correction" | "no-cash";

/**
 * #3979: the booking modification credit notes among these (an edit's note, or
 * the booking-anchored clearing note), and what each did with cash. A note the
 * app did not raise as a modification note is absent. The inbound settle reads
 * it for the notes Xero lists as applied to a paid invoice (`INV-PAY-125`).
 */
export async function readModificationNoteCash(
  creditNoteIds: string[],
  db: Pick<Prisma.TransactionClient, "xeroSyncOperation"> = prisma,
): Promise<Map<string, ModificationNoteCash>> {
  const operations = await readNoteOperations(creditNoteIds, db);
  const notes = new Map<string, ModificationNoteCash>();
  for (const operation of operations) {
    if (!operation.xeroObjectId || !MODIFICATION_NOTE_MODELS.has(operation.localModel ?? "")) continue;
    notes.set(operation.xeroObjectId, isAccountCreditNote(operation) ? "no-cash" : noteCashOf(operation));
  }
  return notes;
}

/**
 * The account-credit notes: credit kept on the member's account, raised for a
 * cancellation or an edit, never cash out. Their payload names the queue type,
 * not a refund method, so `noteCashOf` alone would read one as a refund (#3979
 * final review). Applied to a paid invoice, such a note is the member's own
 * credit. Read here, for the settle, and not in `noteCashOf`: the refunded-total
 * repair never reaches an account-credit note through a modification note's
 * role, and the Xero repair tool's known modification refunds must keep
 * counting an edit kept as credit, which the refunded total also counts.
 */
const ACCOUNT_CREDIT_NOTE_QUEUE_TYPES: ReadonlySet<string> = new Set([
  XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE,
]);

function isAccountCreditNote(operation: NoteOperation): boolean {
  const payloadQueueType = getJsonRecord(operation.requestPayload)?.queueType;
  return (
    ACCOUNT_CREDIT_NOTE_QUEUE_TYPES.has(operation.queueType ?? "") ||
    (typeof payloadQueueType === "string" && ACCOUNT_CREDIT_NOTE_QUEUE_TYPES.has(payloadQueueType))
  );
}

/** Where a modification credit note's operation is anchored: an edit, or the booking (a clearing note). */
const MODIFICATION_NOTE_MODELS = new Set(["BookingModification", "Booking"]);

type NoteOperation = {
  xeroObjectId: string | null;
  localId: string | null;
  localModel: string | null;
  queueType: string | null;
  requestPayload: unknown;
};

async function readNoteOperations(
  creditNoteIds: string[],
  db: Pick<Prisma.TransactionClient, "xeroSyncOperation">,
): Promise<NoteOperation[]> {
  if (creditNoteIds.length === 0) return [];
  return db.xeroSyncOperation.findMany({
    where: { direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", xeroObjectId: { in: creditNoteIds } },
    select: { xeroObjectId: true, localId: true, localModel: true, queueType: true, requestPayload: true },
  });
}

/** What one note's own operation says it did with cash. Pure: the Xero repair tool reads it over loaded rows. */
export function modificationNoteCashOf(operation: { requestPayload: unknown }): ModificationNoteCash {
  return noteCashOf(operation);
}

function noteCashOf(operation: { requestPayload: unknown }): ModificationNoteCash {
  if (isUnpaidAskBilledOffsetNoteScope(queuedReviewTaskId(operation))) return "no-cash";
  const wording = readModificationNoteWording(getJsonRecord(operation.requestPayload));
  if (wording.refundMethod === "account-credit") return "no-cash";
  return isInvoiceCorrectionWording(wording) ? "correction" : "refund";
}

/** The #3536 wording that says the note lowered an unpaid invoice and refunded nothing. */
function isInvoiceCorrectionWording(wording: ModificationNoteWording): boolean {
  return wording.noteWording === "invoice-correction";
}
