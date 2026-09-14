import type { XeroSyncOperation } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  readBookingInvoiceEvidenceForPayment,
  type BookingInvoiceEvidence,
} from "@/lib/xero-booking-invoice-evidence";
import { buildXeroBookingInvoiceCorrelationKey } from "@/lib/xero-booking-invoice-key";
import {
  readXeroInvoiceOperationOutcome,
  type XeroInvoiceEmailFailureCause,
} from "@/lib/xero-booking-invoice-outcome";
import { getXeroOperationRetryMeta } from "@/lib/xero-operation-retry";
import {
  isStaleRunningXeroOperation,
  XERO_ORPHANED_STALE_RUNNING_ERROR_CODE,
} from "@/lib/xero-stale-operations";

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
 * joins through `booking.payment` — and a booking whose payment row has not been
 * created yet would then match nothing and the page would report all-clear over
 * a failed invoice. The correlation key is scoped to the BOOKING and is stable
 * across that whole life, so it is what is matched here.
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
 * Only CREATE operations are matched. A failed invoice UPDATE (a re-priced or
 * re-dated booking's edit push) is a different question with a different remedy
 * and is out of this issue's scope; it stays visible under Admin -> Xero ->
 * Operations, and the release note says so.
 *
 * ## "DID THE INVOICE REACH XERO" IS NOT ANSWERED BY THE OPERATION ROW
 *
 * It is answered by `xero-booking-invoice-evidence.ts`, which is its one home
 * and which states the whole argument. In one line: `failXeroSyncOperation`
 * never writes `xeroObjectId`, so reading the question off that column answers
 * *no* for every first-attempt failure — including the failures that happened
 * AFTER Xero accepted the invoice, where telling an officer no invoice exists
 * walks them into raising a second one. The evidence is what the workflow
 * persisted before it could fail.
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
 * decisions (or not the club's decision at all), and reporting them here as "the
 * invoice email failed" is how a support call gets misdiagnosed into chasing a
 * provider that did exactly what it was told. `booking-invoice-sync-status.test.ts`
 * holds that apart.
 *
 * The first two are recorded as withheld emails and an officer sees them in the
 * booking's withheld-emails banner (#2259). The THIRD raises nothing anywhere:
 * the environment-safety branch writes no withheld row at all and only logs
 * (`xero-booking-invoices.ts` says so at the branch), so on a copy of the real
 * site an unsent invoice email is invisible by design.
 *
 * ## WHY THE REASON TEXT IS TAKEN ONLY FROM A FAILED ROW
 *
 * `lastErrorMessage` is the one field that has been through
 * `redactSensitiveText` — `failXeroSyncOperation` redacts on the way in, which
 * is what makes it safe to show a person (`INV-INT-005`). The stored
 * `responsePayload` has only been through `sanitizeForJson`, a serialisation
 * guard and not a redactor, so no error VALUE is read out of it here; the
 * payload is read only for its booleans and for the email-failure CAUSE, which
 * is a fixed enum the writer chooses rather than provider text.
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
 * about the same row.
 *
 * What this module DOES decide is whether an officer should be offered that
 * retry at all, and it is decided ONCE, as {@link BookingInvoiceSyncAction}. A
 * surface cannot then print "do not repeat the action" beside a Retry button,
 * because the sentence and the label come from the same field.
 */

/**
 * What went wrong, in the terms the person reading it has to act in.
 *
 * The distinction that matters most is whether anything reached Xero, because
 * the remedy inverts on it: an invoice that never existed should be raised, and
 * one that exists must NOT be raised again.
 */
export type BookingInvoiceSyncFaultKind =
  /** Nothing reached Xero that the club has any record of. */
  | "INVOICE_NOT_RAISED"
  /** Nobody can tell from here whether Xero has an invoice. Check before acting. */
  | "INVOICE_STATE_UNKNOWN"
  /** The invoice is in Xero; recording the club's payment against it failed. */
  | "PAYMENT_NOT_RECORDED"
  /** The invoice is in Xero and correct; sending it to the member failed. */
  | "MEMBER_NOT_SENT_INVOICE"
  /** The invoice is in Xero, and some other step of the same operation did not finish. */
  | "PARTLY_COMPLETED";

/**
 * THE ONE AFFORDANCE, so a surface cannot offer two.
 *
 * The kind and "is a retry supported" used to be independent fields, and a
 * surface appending "you can retry it" from the second while printing "do not
 * repeat the action" from the first is a contradiction the types permitted —
 * only a convention kept them agreeing. This is that convention made
 * unrepresentable: the sentence an officer reads and the label on the link both
 * come from here.
 *
 * `RETRY` is offered only where repeating the action is safe AND the engine will
 * run it: nothing reached Xero, or the invoice exists and it is the club's
 * PAYMENT that is missing — the one case where "do not raise a second invoice"
 * and a retry legitimately coexist, because the retry records a payment and
 * raises nothing.
 */
export type BookingInvoiceSyncAction =
  | { type: "RETRY" }
  | {
      type: "RESOLVE";
      /** The recovery engine's own prose, when IT is what refuses. */
      engineReason: string | null;
    };

interface BookingInvoiceSyncFaultShape {
  /** The canonical operation this reading came from. */
  operationId: string;
  /**
   * Whether the invoice itself exists in Xero, corroborated from what the
   * workflow persisted before it could fail rather than inferred from the
   * operation's status. See `xero-booking-invoice-evidence.ts`.
   */
  invoiceReachedXero: boolean;
  /** The Xero invoice number, when the club recorded one. */
  invoiceNumber: string | null;
  /** Redacted operator-facing reason; `null` unless the row is `FAILED`. */
  reason: string | null;
  /** The single affordance offered for this fault. */
  action: BookingInvoiceSyncAction;
}

export type BookingInvoiceSyncFault = BookingInvoiceSyncFaultShape &
  (
    | {
        kind: Exclude<
          BookingInvoiceSyncFaultKind,
          "MEMBER_NOT_SENT_INVOICE"
        >;
      }
    | {
        kind: "MEMBER_NOT_SENT_INVOICE";
        /**
         * WHICH of the three email faults it was, so the remedy printed is the
         * one that fits. `null` on a row written before the writer recorded it.
         */
        emailFailureCause: XeroInvoiceEmailFailureCause | null;
      }
  );

type BookingInvoiceSyncDb = {
  xeroSyncOperation: {
    findFirst(args: unknown): Promise<unknown>;
  };
};

export interface BookingInvoiceSyncDependencies {
  db: BookingInvoiceSyncDb;
  readBookingInvoiceEvidenceForPayment: typeof readBookingInvoiceEvidenceForPayment;
  now: () => Date;
}

const defaultDependencies: BookingInvoiceSyncDependencies = {
  db: prisma as unknown as BookingInvoiceSyncDb,
  readBookingInvoiceEvidenceForPayment,
  now: () => new Date(),
};

/**
 * The columns this reading needs.
 *
 * Most of them are here because `getXeroOperationRetryMeta` needs them — it is
 * handed the row, so the row has to carry what it reads. Selecting a narrower
 * shape and casting would hand the engine a partial row and get a confidently
 * wrong answer about whether a retry is possible.
 *
 * `startedAt` and `lastErrorCode` are this module's own: a RUNNING row says
 * nothing about whether it is ten seconds or a week old, and a row the operator
 * reset out of RUNNING is a worker death rather than a provider refusal.
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
  lastErrorCode: true,
  lastErrorMessage: true,
  startedAt: true,
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
 * What the classifier must be told that the operation row does not say.
 *
 * A REQUIRED argument rather than an optional one, deliberately: a caller that
 * forgot it would get the old, wrong answer — "no invoice exists" for every
 * failure — and nothing would break. Unrepresentable beats policed (`INV-SSOT`).
 */
export interface BookingInvoiceSyncContext {
  /** What the club's own records say about the invoice existing. */
  evidence: BookingInvoiceEvidence;
  /** The instant staleness is measured against. */
  now: Date;
}

/** The affordance for one kind, decided once. */
function resolveAction(
  kind: BookingInvoiceSyncFaultKind,
  retryMeta: { supported: boolean; reason: string | null },
): BookingInvoiceSyncAction {
  /*
    Repeating the action is only ever safe where no invoice can be duplicated by
    it. `PAYMENT_NOT_RECORDED` is the exception that proves the rule: the invoice
    DOES exist, and the retry records the missing payment against that invoice
    rather than raising another.

    The remaining kinds all carry "do not repeat the action", so none of them may
    reach a surface as a Retry even if the engine happens to say it would run —
    which for `PARTLY_COMPLETED` it does.
  */
  const repeatable =
    kind === "INVOICE_NOT_RAISED" || kind === "PAYMENT_NOT_RECORDED";

  if (repeatable && retryMeta.supported) return { type: "RETRY" };

  return {
    type: "RESOLVE",
    // The engine's refusal is worth printing; "we do not offer it here" is not,
    // because the surface says that itself in words an officer can act on.
    engineReason: retryMeta.supported ? null : retryMeta.reason,
  };
}

/**
 * Classify a failed, stalled or partial invoice-create operation.
 *
 * Separated from the query so the rule can be read — and tested — without a
 * database.
 */
export function classifyBookingInvoiceSyncFault(
  operation: BookingInvoiceOperation,
  context: BookingInvoiceSyncContext,
): BookingInvoiceSyncFault | null {
  /*
    An operator who resolved this directly in Xero has already said so, and that
    is the existing way to clear a failure without touching booking, payment or
    invoice state. The active-failure overview and the stuck-state count both
    exclude these rows; a warning on the booking that kept shouting after the
    override would make the override useless exactly where it is most needed.
  */
  if (operation.manuallyResolvedAt) return null;

  /*
    A RUNNING row is the outbox working normally — until it is not. The worker
    claims a row by flipping it to RUNNING and stamping `startedAt`, and if the
    process dies there the row stays RUNNING for ever: the exact scenario this
    issue opens with, and until #3001 it rendered as all-clear. The threshold is
    the one the stuck-state dashboard and the operator's reset already use, so a
    booking and the club-wide count cannot disagree about the same row.
  */
  const stalled =
    operation.status === "RUNNING" &&
    isStaleRunningXeroOperation(operation.startedAt, context.now);

  if (
    !stalled &&
    operation.status !== "FAILED" &&
    operation.status !== "PARTIAL"
  ) {
    // PENDING, a fresh RUNNING and WAITING_PAYMENT are the outbox working
    // normally, and SUCCEEDED is the answer everyone wants. None is a fault.
    return null;
  }

  const invoiceReachedXero =
    operation.xeroObjectId != null || context.evidence.exists;
  const retryMeta = getXeroOperationRetryMeta(operation);
  const invoiceNumber =
    operation.xeroObjectNumber ?? context.evidence.invoiceNumber;

  const build = (
    kind: Exclude<BookingInvoiceSyncFaultKind, "MEMBER_NOT_SENT_INVOICE">,
    reason: string | null,
  ): BookingInvoiceSyncFault => ({
    kind,
    operationId: operation.id,
    invoiceReachedXero,
    invoiceNumber,
    reason,
    action: resolveAction(kind, retryMeta),
  });

  if (stalled) {
    /*
      Nothing local says whether Xero was reached, unless the workflow got far
      enough to persist evidence. With evidence the invoice exists and the
      operation simply never finished; without it, the honest answer is that
      NOBODY KNOWS — and the one thing an officer must not do is repeat the
      action on a guess.
    */
    return build(
      invoiceReachedXero ? "PARTLY_COMPLETED" : "INVOICE_STATE_UNKNOWN",
      null,
    );
  }

  if (operation.status === "FAILED") {
    /*
      An operator's stale-RUNNING reset is a worker death, not a provider
      refusal: the row was abandoned mid-flight and its stored message says only
      that. Whether Xero was reached is unknown for the same reason it is unknown
      above, so it is reported as unknown rather than as "no invoice was raised".
    */
    const abandoned =
      operation.lastErrorCode === XERO_ORPHANED_STALE_RUNNING_ERROR_CODE;

    if (invoiceReachedXero) {
      // It failed AFTER Xero accepted the invoice. Calling that "no invoice was
      // raised" would send an officer to raise a second one.
      return build("PARTLY_COMPLETED", operation.lastErrorMessage);
    }

    return build(
      abandoned ? "INVOICE_STATE_UNKNOWN" : "INVOICE_NOT_RAISED",
      operation.lastErrorMessage,
    );
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
    return build("PAYMENT_NOT_RECORDED", null);
  }

  if (outcome?.invoiceEmailFailed) {
    return {
      kind: "MEMBER_NOT_SENT_INVOICE",
      emailFailureCause: outcome.invoiceEmailFailureCause,
      operationId: operation.id,
      invoiceReachedXero,
      invoiceNumber,
      reason: null,
      action: resolveAction("MEMBER_NOT_SENT_INVOICE", retryMeta),
    };
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
  return build("PARTLY_COMPLETED", null);
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

  /*
    The payment id comes off the operation row's own `localId`, which is where
    the workflow stored it — not from a join back through the booking. The row is
    already found by then, so this corroborates what it says rather than deciding
    whether it is found at all.
  */
  const evidence =
    operation.localModel === "Payment" && operation.localId
      ? await deps.readBookingInvoiceEvidenceForPayment(operation.localId)
      : { exists: false, invoiceNumber: null };

  return classifyBookingInvoiceSyncFault(operation, {
    evidence,
    now: deps.now(),
  });
}
