import type { XeroSyncOperation } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { buildXeroBookingInvoiceCorrelationKey } from "@/lib/xero-booking-invoice-key";
import { readXeroInvoiceOperationOutcome } from "@/lib/xero-booking-invoice-outcome";
import { getXeroOperationRetryMeta } from "@/lib/xero-operation-retry";

/**
 * WHAT THE CLUB'S ACCOUNTING SYSTEM IS MISSING FOR ONE BOOKING (#3001, MAD epic
 * #2725).
 *
 * ## The problem this exists for
 *
 * A booking can sit `CONFIRMED` with its payment `PENDING` while the Xero
 * operation that should have raised its invoice has already failed. The booking
 * page then implies everything is progressing normally, and the only evidence
 * to the contrary is several clicks away under Admin -> Xero -> Operations.
 *
 * This module answers, for one booking, the question the officer looking at it
 * actually has: **does Xero have what it should, and if not, what do I do?**
 *
 * ## It projects, it does not decide
 *
 * The canonical truth is the `XeroSyncOperation` row and nothing else. Nothing
 * here writes, and no booking, payment or invoice state is changed because a
 * provider operation failed — a failed Xero call does not mean the booking was
 * cancelled, or paid, or invoiced. This returns a bounded READING, so that the
 * React tree never interprets a raw operation row for itself.
 *
 * ## How the booking is correlated to its operation
 *
 * By `correlationKey`, minted in `xero-booking-invoice-key.ts`. The row is
 * STORED against the payment (`localModel: "Payment"`), so the obvious query
 * joins through `booking.payment` — and a booking whose payment row is missing,
 * replaced, or not created yet would then match nothing and the page would
 * report all-clear over a failed invoice. The correlation key is scoped to the
 * BOOKING and is stable across that whole life, so it is what is matched here.
 *
 * ## CURRENT STATE, not history: which row wins
 *
 * The LATEST create operation by `createdAt`, with the id as a deterministic
 * tie-break. An older failure can therefore never outvote a later success, which
 * is the behaviour the issue names.
 *
 * That is safe rather than merely convenient, because a second create row can
 * only exist where the first one's result is gone:
 * `enqueueXeroBookingInvoiceOperation` refuses to queue another while the
 * payment carries a `xeroInvoiceId` or an active `PRIMARY_INVOICE` link. So a
 * newer failure after an older success means the link really was voided or
 * removed and the newer failure is the live state. A successful operator retry
 * does not create a row at all — `retryXeroSyncOperation` updates the SAME row
 * in place — so a retry that works clears this warning while the operation's own
 * history and audit trail stay exactly where they were.
 *
 * ## THREE REASONS SOMETHING DID NOT HAPPEN, AND ONLY ONE OF THEM IS A FAULT
 *
 * By this epic's own work there are now several reasons an invoice-related
 * action did not complete, and they are not interchangeable:
 *
 *  - the per-booking "No emails" switch (#2258) withheld the invoice email;
 *  - the officer creating the booking chose not to email the member (#2929);
 *  - this installation is a copy, so nothing was transmitted (#3035,
 *    `INV-CONFIG-004`).
 *
 * All three are complete, INTENDED outcomes. The operation completes SUCCEEDED,
 * and **this module reports no fault for any of them** — they are the club's own
 * decisions (or not the club's decision at all), and an officer already sees
 * what was withheld through `getWithheldBookingEmailSummary` (#2259), which is
 * where that belongs. Reporting them here as "the invoice email failed" is how a
 * support call gets misdiagnosed into chasing a provider that did exactly what
 * it was told. `booking-invoice-sync-status.test.ts` holds that apart.
 *
 * ## WHY THE REASON TEXT IS TAKEN ONLY FROM A FAILED ROW
 *
 * `lastErrorMessage` is the one field that has been through
 * `redactSensitiveText` — `failXeroSyncOperation` redacts on the way in, which
 * is what makes it safe to show a person (`INV-INT-005`). The stored
 * `responsePayload` has only been through `sanitizeForJson`, a serialisation
 * guard and not a redactor, so no error VALUE is read out of it here; the
 * payload is read only for its booleans.
 *
 * And `lastErrorMessage` is read ONLY on a `FAILED` row, because
 * `completeXeroSyncOperation` never clears it. A row that failed, was retried,
 * and came back `PARTIAL` still carries the previous attempt's message — so
 * showing it beside a partial result would describe the wrong event with
 * authority.
 *
 * ## THE RETRY QUESTION IS NOT ANSWERED HERE
 *
 * `getXeroOperationRetryMeta` already decides whether the existing recovery path
 * will run for a given operation, and refuses in prose written for an operator —
 * including the money fence that refuses to "repair" an invoice whose EMAIL
 * failed, because recording a payment there would falsely settle an invoice the
 * member has not paid. This module asks it rather than re-deriving it, so the
 * booking page and the Xero operations screen can never offer different answers
 * about the same row, and a surface showing a failure never offers a Retry the
 * engine would refuse.
 */

/**
 * What went wrong, in the terms the person reading it has to act in.
 *
 * The distinction that matters most is whether anything reached Xero, because
 * the remedy inverts on it: an invoice that never existed should be raised, and
 * one that exists must NOT be raised again.
 */
export type BookingInvoiceSyncFaultKind =
  /** Nothing reached Xero. The club's ledger has no invoice for this booking. */
  | "INVOICE_NOT_RAISED"
  /** The invoice is in Xero; recording the club's payment against it failed. */
  | "PAYMENT_NOT_RECORDED"
  /** The invoice is in Xero and correct; sending it to the member failed. */
  | "MEMBER_NOT_SENT_INVOICE"
  /** The invoice is in Xero, and some other step of the same operation did not finish. */
  | "PARTLY_COMPLETED";

export interface BookingInvoiceSyncFault {
  kind: BookingInvoiceSyncFaultKind;
  /** The canonical operation this reading came from. */
  operationId: string;
  /**
   * Whether the invoice itself exists in Xero, taken from the operation's own
   * stored Xero object id rather than inferred from its status. A row can fail
   * AFTER the provider call succeeded, and an officer told to "retry" one of
   * those without being told the invoice already exists is being walked toward
   * a duplicate.
   */
  invoiceReachedXero: boolean;
  /** The Xero invoice number, when the operation recorded one. */
  invoiceNumber: string | null;
  /** Redacted operator-facing reason; `null` unless the row is `FAILED`. */
  reason: string | null;
  /** Whether the existing recovery path will run for this operation. */
  retrySupported: boolean;
  /** When it will not, the engine's own prose saying why. */
  retryBlockedReason: string | null;
}

type BookingInvoiceSyncDb = {
  xeroSyncOperation: {
    findFirst(args: unknown): Promise<unknown>;
  };
};

export interface BookingInvoiceSyncDependencies {
  db: BookingInvoiceSyncDb;
}

const defaultDependencies: BookingInvoiceSyncDependencies = {
  db: prisma as unknown as BookingInvoiceSyncDb,
};

/**
 * The columns this reading needs.
 *
 * Most of them are here because `getXeroOperationRetryMeta` needs them — it is
 * handed the row, so the row has to carry what it reads. Selecting a narrower
 * shape and casting would hand the engine a partial row and get a confidently
 * wrong answer about whether a retry is possible.
 */
const OPERATION_SELECT = {
  id: true,
  status: true,
  replayable: true,
  direction: true,
  entityType: true,
  operationType: true,
  localModel: true,
  localId: true,
  queueType: true,
  requestPayload: true,
  responsePayload: true,
  xeroObjectId: true,
  xeroObjectNumber: true,
  lastErrorMessage: true,
  manuallyResolvedAt: true,
} as const;

/**
 * Derived from the Prisma row rather than hand-written, so the columns this
 * reading takes stay exactly the columns the table has — and so the JSON fields
 * keep the type `getXeroOperationRetryMeta` expects when the row is handed on.
 */
type BookingInvoiceOperation = Pick<
  XeroSyncOperation,
  keyof typeof OPERATION_SELECT
>;

/**
 * Classify a failed or partial invoice-create operation.
 *
 * Separated from the query so the rule can be read — and tested — without a
 * database.
 */
export function classifyBookingInvoiceSyncFault(
  operation: BookingInvoiceOperation,
): BookingInvoiceSyncFault | null {
  /*
    An operator who resolved this directly in Xero has already said so, and that
    is the existing way to clear a failure without touching booking, payment or
    invoice state. The active-failure overview and the stuck-state count both
    exclude these rows; a warning on the booking that kept shouting after the
    override would make the override useless exactly where it is most needed.
  */
  if (operation.manuallyResolvedAt) return null;

  if (operation.status !== "FAILED" && operation.status !== "PARTIAL") {
    // PENDING, RUNNING and WAITING_PAYMENT are the outbox working normally, and
    // SUCCEEDED is the answer everyone wants. None of them is a fault.
    return null;
  }

  // Evidence, not inference: the operation recorded a Xero object id only if the
  // provider call really returned one.
  const invoiceReachedXero = operation.xeroObjectId != null;
  const retryMeta = getXeroOperationRetryMeta(operation);
  const base = {
    operationId: operation.id,
    invoiceReachedXero,
    invoiceNumber: operation.xeroObjectNumber,
    retrySupported: retryMeta.supported,
    retryBlockedReason: retryMeta.supported ? null : retryMeta.reason,
  };

  if (operation.status === "FAILED") {
    return {
      ...base,
      // A FAILED row that nonetheless carries an invoice id failed AFTER Xero
      // accepted the invoice. Calling that "no invoice was raised" would send an
      // officer to raise a second one.
      kind: invoiceReachedXero ? "PARTLY_COMPLETED" : "INVOICE_NOT_RAISED",
      reason: operation.lastErrorMessage,
    };
  }

  const outcome = readXeroInvoiceOperationOutcome(operation.responsePayload);

  /*
    PAYMENT BEFORE EMAIL when both faults are recorded, deliberately. They are
    ordered by what the club stands to lose: an invoice in Xero showing as
    awaiting payment for money the club already holds misstates the ledger,
    while an invoice the member was not sent is a message an officer can relay.
    The retry fence acts on the payment leg too, so leading with it keeps the
    warning and the available remedy describing the same thing.
  */
  if (outcome?.paymentFailed) {
    return { ...base, kind: "PAYMENT_NOT_RECORDED", reason: null };
  }

  if (outcome?.invoiceEmailFailed) {
    return { ...base, kind: "MEMBER_NOT_SENT_INVOICE", reason: null };
  }

  /*
    Reached when the row says PARTIAL but its payload records no FAULT — and note
    what that includes: a payload whose only "the email did not go out" entry is
    one of the three DELIBERATE ones (the "No emails" switch, the creation-time
    choice, the non-production suppression). None of those is a failure, none of
    them is read here, and none of them can reach this line labelled as one.

    The writer completes such an operation SUCCEEDED, so a PARTIAL row carrying
    only a deliberate withhold should not exist at all. If one does, its status
    and its payload disagree, and the honest thing to tell an officer is that
    some step did not finish and a person should look — never that the club's own
    decision to withhold an email was a provider failure.
  */
  return { ...base, kind: "PARTLY_COMPLETED", reason: null };
}

/**
 * The current invoice-sync fault for one booking, or `null` when there is
 * nothing an officer needs to act on.
 */
export async function getBookingInvoiceSyncFault(
  bookingId: string,
  input?: { deps?: Partial<BookingInvoiceSyncDependencies> },
): Promise<BookingInvoiceSyncFault | null> {
  const deps = { ...defaultDependencies, ...input?.deps };

  const operation = (await deps.db.xeroSyncOperation.findFirst({
    where: {
      correlationKey: buildXeroBookingInvoiceCorrelationKey(bookingId),
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: OPERATION_SELECT,
  })) as BookingInvoiceOperation | null;

  if (!operation) return null;

  return classifyBookingInvoiceSyncFault(operation);
}
