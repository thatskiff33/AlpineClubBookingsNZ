/**
 * Queueing a booking change's supplementary invoice, and the per-anchor
 * advisory key that makes "one supplementary invoice per anchor" true (#3170,
 * #3641). Moved out of `xero-operation-outbox.ts` unchanged (#4930): the
 * primary-invoice gap check and the change-capture receipt both queue through
 * here, and the outbox worker's booking-invoice handler reaches both, so while
 * this lived in the outbox the worker and its own handlers imported each other
 * in a loop (INV-SSOT-008). The outbox imports this module; nothing here imports
 * the outbox. The lock is the same statement on the same key, taken by the same
 * callers on the same transaction client (docs/CONCURRENCY_AND_LOCKING.md,
 * "Xero supplementary invoice per anchor").
 */
import { resolveOrganiserBilling } from "@/lib/organiser-billing";
import { organiserExtraWaivedBeforeRaised } from "@/lib/organiser-extra-state";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildXeroSupplementaryInvoiceKey, type XeroSupplementaryInvoiceAnchorModel } from "@/lib/xero-supplementary-invoice-key";
import { startXeroSyncOperation } from "@/lib/xero-sync";
import { primaryInvoiceGapPayload } from "@/lib/additional-capture-receipt-payload";
import { anchorCaptureHasReceipt, bookingHasUnattributedCaptures, keptInvoiceBillsChangeCapture } from "@/lib/additional-capture-receipt-link";
import { supplementaryInvoiceBilledCents, XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE } from "@/lib/xero-operation-outbox-payload";
import { outstandingSupplementaryInvoiceOperationsWhere, RESTATABLE_SUPPLEMENTARY_INVOICE_STATUSES, restatableSupplementaryInvoiceOperationsWhere, type XeroSupplementaryInvoiceEnqueueOutcome } from "@/lib/xero-supplementary-invoice-statuses";
/**
 * Single-flights the link-check -> queued-check -> raise-or-create transaction
 * (#3170). All callers, composed lock orders and the transaction client's P2002
 * constraint are documented in docs/CONCURRENCY_AND_LOCKING.md under
 * "Xero supplementary invoice per anchor". Keep that inventory authoritative:
 * some callers enqueue inside an existing transaction, after its other locks.
 */
const XERO_SUPPLEMENTARY_INVOICE_LOCK_NAMESPACE = "xero-supplementary-invoice";

/**
 * TAKE THE PER-ANCHOR SUPPLEMENTARY-INVOICE LOCK, the one spelling of it
 * (#3641 review round). The anchor is the operation's `localId`: the
 * BookingModification id, or the review task id for a second ask. The enqueue
 * below and the late-capture re-queue
 * (`xero-supplementary-invoice-late-capture.ts`) both call this, so they cannot
 * drift onto two different keys and stop contending without anyone noticing.
 */
export async function lockSupplementaryInvoiceAnchor(
  tx: Prisma.TransactionClient,
  anchorId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${XERO_SUPPLEMENTARY_INVOICE_LOCK_NAMESPACE}), hashtext(${anchorId}))`;
}

/**
 * THE SECOND ASK (#3193, epic #2797): raise a settled review share's OWN small
 * supplementary invoice, because the booking change's invoice had already left
 * the queue and could not be raised to include it.
 *
 * The owner decided on 31 Aug 2026 that the difference is billed through the
 * system rather than chased by hand. That NARROWS #3170's "one booking edit, one
 * ask" rather than overturning it: while the invoice is still in the queue a
 * second settlement RAISES it and the member is asked once, which remains the
 * ordinary case. Only once the invoice has been claimed for sending or sent -
 * the window where the alternative was billing the member too little - does the
 * difference become its own ask.
 *
 * WHY IT CANNOT DOUBLE-BILL, which is the whole design and not a caveat:
 *
 *   * IT BILLS THE SHARE, NEVER THE TOTAL. This function is reached only when
 *     `enqueueXeroSupplementaryInvoiceOperation` answered `short-sent`: an
 *     invoice EXISTS and its amount is fixed forever, and a restate found
 *     nothing restatable or already covering - so this share is provably NOT in it.
 *     Every settled share is therefore billed exactly once: by the change's
 *     invoice if it was in it, by its own invoice if it was not. The shares sum
 *     to the derived total by construction, with no figure read back off a sent
 *     invoice and no difference computed from anything the club would have to
 *     guess.
 *   * IT ANCHORS ON THE TASK, NOT THE CHANGE. The outbox row and the resulting
 *     `XeroObjectLink` sit on `ManualRefundTask/<taskId>`, so the link-check and
 *     the queued-check below fence THIS SHARE'S ask - one per share, whatever
 *     order shares settle in and however many there are. Two shares racing after
 *     the invoice went out are two different keys doing two independent, correct
 *     things; they cannot both bill the same difference, because neither of them
 *     bills a difference at all.
 *   * IT IS INVISIBLE TO THE ORDINARY PATH, and that is load-bearing rather than
 *     tidy. A pending second ask found by the change's own restate would be
 *     RAISED to the combined total - $30 becoming $230 on top of a $200 invoice
 *     already sent. It cannot be found there, because every one of those reads is
 *     scoped to `BookingModification/<modificationId>`.
 *
 * Safe to run twice, which a settlement's fire-and-forget dispatch needs: a
 * second call for the same task finds its own queued operation or its own active
 * link and queues nothing.
 *
 * A NAMED PATH, not a relaxation of the refusal. It reaches the same locked
 * decision the ordinary enqueue makes - one transaction, one advisory key, one
 * link-check -> queued-check -> write - with a different anchor, so there is
 * still exactly one place that answers "does this ask already have an invoice
 * going out?".
 */
export async function enqueueXeroSecondSupplementaryInvoiceOperation(
  params: {
    bookingId: string;
    bookingModificationId: string;
    /** The review task whose settled share this invoice bills. The anchor. */
    reviewTaskId: string;
    /** That share, and only that share. Never the edit's combined total. */
    shareCents: number;
  },
  options?: { createdByMemberId?: string }
) {
  return enqueueSupplementaryInvoiceForAnchor(
    {
      bookingId: params.bookingId,
      priceDiffCents: params.shareCents,
      changeFeeCents: 0,
      bookingModificationId: params.bookingModificationId,
    },
    {
      createdByMemberId: options?.createdByMemberId,
      /**
       * UNPAID AND SENT NOW, on both routes, and the card route is the one worth
       * arguing. `short-sent` on the card route requires the change's invoice to
       * have left WAITING_PAYMENT, which only the additional payment confirming
       * can do - so the card has already been taken at the EARLIER figure and
       * this share is genuinely unbilled. Recording a payment against it would
       * invent money nobody sent, and waiting for a payment would wait for a
       * confirmation that has already happened.
       */
      recordPayment: false,
      waitForConfirmedAdditionalPayment: false,
      paymentIntentId: null,
      shortfallReviewTaskId: params.reviewTaskId,
    }
  );
}

interface XeroSupplementaryInvoiceEnqueueParams {
  bookingId: string;
  priceDiffCents: number;
  changeFeeCents: number;
  bookingModificationId?: string;
}

interface XeroSupplementaryInvoiceEnqueueOptions {
  createdByMemberId?: string;
  paymentIntentId?: string | null;
  waitForConfirmedAdditionalPayment?: boolean;
  recordPayment?: boolean;
  /**
   * #3953 (`INV-PAY-139`): a #3980 gap invoice, and the captures its own payment takes (none when unpaid).
   * #4324 (4384-R2): `billedChangeIds`, every racing edit its combined amount bills (its anchors).
   */
  primaryInvoiceGap?: {
    coveredCaptures: ReadonlyArray<{ paymentIntentId: string; cents: number }>;
    billedChangeIds?: readonly string[];
  };
}

/**
 * QUEUE THE BOOKING CHANGE'S OWN SUPPLEMENTARY INVOICE.
 *
 * The public entry point, and it cannot be asked for a task-anchored invoice
 * (#3193 fix round, `INV-SSOT`). The anchor flag used to be an option on THIS
 * signature, with a docblock asserting that only the second-ask wrapper set it -
 * true of the code as written, and policed by nothing: any caller could have
 * passed a review task id together with the edit's COMBINED total and got a
 * second invoice for the whole amount on top of one already sent. It is now a
 * parameter of the module-private implementation below, which the wrapper is the
 * only thing that can reach, so the misuse is unrepresentable rather than
 * discouraged - but only because the options are forwarded FIELD BY FIELD
 * below, which is the half that actually closes it.
 */
export async function enqueueXeroSupplementaryInvoiceOperation(
  params: XeroSupplementaryInvoiceEnqueueParams,
  options?: XeroSupplementaryInvoiceEnqueueOptions
) {
  /**
   * NOT `options` (#3193 fix round, second pass). Narrowing the parameter to a
   * type without `shortfallReviewTaskId` does NOT stop a value reaching the
   * implementation: TypeScript's excess-property check fires only on a FRESH
   * OBJECT LITERAL at the call site. A caller that assembles its options into a
   * variable first - the ordinary shape as soon as one field is conditional -
   * or spreads one, passes the check with the flag still on the object, and
   * forwarding the object wholesale then hands it straight to the private
   * implementation, which reads the key. Verified against this project's own
   * `tsc --strict`: both a pre-built variable and a spread compile clean.
   *
   * The cost of that is the whole reason the flag is fenced. A caller reaching
   * it with an edit's COMBINED total gets a task-anchored invoice for the whole
   * amount - invisible to every change-scoped read by design - on top of the one
   * already sent: $560 billed for a $280 edit. Listing the four legitimate
   * options is what makes the misuse unrepresentable rather than merely typed
   * against.
   *
   * Each is passed as `undefined` when absent, which every read below treats
   * identically to omitting it (`?? default`).
   */
  return enqueueSupplementaryInvoiceForAnchor(params, {
    createdByMemberId: options?.createdByMemberId,
    paymentIntentId: options?.paymentIntentId,
    waitForConfirmedAdditionalPayment: options?.waitForConfirmedAdditionalPayment,
    recordPayment: options?.recordPayment,
    primaryInvoiceGap: options?.primaryInvoiceGap,
  });
}

/**
 * #3947 (owner decision 22 Oct 2026): a review charge's `invoice` route queues the
 * edit's invoice for its combined total, unpaid (it IS the ask), inside the
 * completion's transaction - so the next share, behind it on `lock(1)`, sees it.
 * The same anchor-locked decision as every caller; the kick is after the commit.
 */
export async function enqueueEditReviewChargeInvoiceInTransaction(
  params: { bookingId: string; bookingModificationId: string; totalCents: number; createdByMemberId: string },
  store: Prisma.TransactionClient,
) {
  return enqueueSupplementaryInvoiceForAnchor(
    { bookingId: params.bookingId, bookingModificationId: params.bookingModificationId, priceDiffCents: params.totalCents, changeFeeCents: 0 },
    { createdByMemberId: params.createdByMemberId, paymentIntentId: null, waitForConfirmedAdditionalPayment: false, recordPayment: false },
    store,
  );
}

/**
 * The one implementation behind both entry points, so there is still exactly one
 * place that answers "does this ask already have an invoice going out?".
 *
 * Module-private: the only way to reach its `shortfallReviewTaskId` is
 * `enqueueXeroSecondSupplementaryInvoiceOperation`, which supplies the share and
 * the anchor together.
 */
async function enqueueSupplementaryInvoiceForAnchor(
  params: XeroSupplementaryInvoiceEnqueueParams,
  options?: XeroSupplementaryInvoiceEnqueueOptions & {
    /**
     * #3193: anchor this invoice on a review task instead of the booking change,
     * because it bills that task's settled share alone. Reachable only through
     * `enqueueXeroSecondSupplementaryInvoiceOperation` above, which is where the
     * reasoning lives.
     */
    shortfallReviewTaskId?: string;
  },
  /** #3947: the caller's transaction (`enqueueEditReviewChargeInvoiceInTransaction`); absent, its own. */
  store?: Prisma.TransactionClient,
) {
  const {
    bookingId,
    priceDiffCents,
    changeFeeCents,
    bookingModificationId,
  } = params;

  // Net-based guard (#1356): the components are signed, and a supplementary
  // invoice exists only to bill a positive net. A mixed-sign edit whose net is
  // not positive settles via the credit-note paths; queueing it here would
  // gross-bill the fee while dropping the larger reduction.
  if (priceDiffCents + changeFeeCents <= 0) {
    return {
      queueOperationId: null,
      outcome: "none" as XeroSupplementaryInvoiceEnqueueOutcome,
      message: "No supplementary invoice is required for this modification.",
    };
  }

  const booking = await (store ?? prisma).booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      organiserSettled: true,
      parentBookingId: true,
      payment: {
        select: {
          xeroInvoiceId: true,
          source: true,
        },
      },
    },
  });

  if (!booking) {
    throw new Error(`Booking not found: ${bookingId}`);
  }

  const organiserBilling = await resolveOrganiserBilling(store ?? prisma, booking);
  if (!booking.payment?.xeroInvoiceId && !organiserBilling) {
    return {
      queueOperationId: null,
      outcome: "none" as XeroSupplementaryInvoiceEnqueueOutcome,
      message: "No original Xero invoice exists for this booking.",
    };
  }

  // #3193: a second ask anchors on the review task whose share it bills, so
  // every read below - the link check, the queued check, the advisory key - is
  // scoped to that share rather than to the booking change's own invoice.
  const shortfallReviewTaskId = options?.shortfallReviewTaskId ?? null;
  const localModel: XeroSupplementaryInvoiceAnchorModel = shortfallReviewTaskId
    ? "ManualRefundTask"
    : bookingModificationId
      ? "BookingModification"
      : "Booking";
  const localId = shortfallReviewTaskId ?? bookingModificationId ?? bookingId;

  const correlationKey = buildXeroSupplementaryInvoiceKey({
    localModel,
    localId,
    priceDiffCents,
    changeFeeCents,
  });

  /**
   * ONE SUPPLEMENTARY INVOICE PER ANCHOR, decided under a lock (#3170 fix round).
   *
   * Two things changed here and they only work together. The lock
   * (`XERO_SUPPLEMENTARY_INVOICE_LOCK_NAMESPACE`) serialises the whole
   * link-check -> queued-check -> write against another settlement of the same
   * edit; and the queued check is now scoped to the ANCHOR rather than to a
   * `correlationKey` that embeds the amount, so a second share arriving with a
   * larger total FINDS the first invoice instead of queueing a second one beside
   * it. Either alone leaves a way to send two invoices for one edit.
   *
   * Finding one does not mean leaving it alone: an operation asking for LESS is
   * raised to this total through the one restate function, so the second share is
   * billed rather than silently dropped. That function refuses to LOWER, so a
   * stale, smaller total arriving second changes nothing.
   */
  const decide = async (tx: Prisma.TransactionClient) => {
    // #3953 round 7: where the booking has a change capture no change can be read from, its receipt decides under the BOOKING's key, so this takes that key first (booking, then anchor - the one order; nothing takes them the other way). Round 9: only for an invoice naming no capture, the one kind that might record such a capture.
    if (localId !== bookingId && (options?.recordPayment ?? true) && !options?.primaryInvoiceGap && !options?.paymentIntentId && (await bookingHasUnattributedCaptures(tx, bookingId))) await lockSupplementaryInvoiceAnchor(tx, bookingId);
    // #4324 (4384-R2, `INV-PAY-144`): a gap invoice bills every anchor its amount covers, so it takes each one's key, sorted (the one order), before asking whether a kept capture's own invoice bills any of them.
    const billedChangeIds = [...new Set([localId, ...(options?.primaryInvoiceGap?.billedChangeIds ?? [])])].sort();
    for (const anchorId of billedChangeIds) await lockSupplementaryInvoiceAnchor(tx, anchorId);
    // #4299 S1 (`INV-PAY-148`): a waiver retired this organiser extra whole before it was raised; nothing is owed, so no row raises it.
    if (organiserBilling && localModel === "BookingModification" && (await organiserExtraWaivedBeforeRaised(tx, localId))) {
      return { queueOperationId: null, outcome: "none" as XeroSupplementaryInvoiceEnqueueOutcome, refusedBy: "organiser-extra-waived" as const, message: "This organiser extra was waived whole before it was raised, so no invoice is queued." };
    }

    const existingLink = await tx.xeroObjectLink.findFirst({
      where: {
        localModel,
        localId,
        xeroObjectType: "INVOICE",
        role: "SUPPLEMENTARY_INVOICE",
        active: true,
      },
      select: { id: true },
    });

    if (existingLink) {
      // `short-sent`, not `covers-total`, and the caller acts on the difference.
      // The invoice has been SENT, so what it bills is whatever the payload said
      // when the worker picked it up - a figure this row no longer holds, because
      // the handler replaced this anchor's payload with the Xero invoice body. An
      // edit-review share only reaches here after failing to restate, which on
      // that path means the ask went out before this share was settled; treating
      // that as covered would be the silent drop the whole round removed.
      //
      // THIS IS THE DURABLE HALF of what used to be one `short`. An active link
      // means an invoice exists and what it bills can never change again, which
      // is exactly what makes a second, separate invoice for this share safe.
      return {
        queueOperationId: null,
        outcome: "short-sent" as XeroSupplementaryInvoiceEnqueueOutcome,
        message: "Xero supplementary invoice already linked for this modification.",
      };
    }

    // #3947 review round 2: named, and shared with the review charge's chooser.
    const existingQueuedOperation = await tx.xeroSyncOperation.findFirst({
      where: outstandingSupplementaryInvoiceOperationsWhere({ localModel, localId }),
      orderBy: {
        createdAt: "desc",
      },
    });

    if (existingQueuedOperation) {
      const raised = await restatePendingSupplementaryInvoiceAmount({
        bookingModificationId: localId,
        // `localId` is the BOOKING id when no modification id was supplied, so
        // the model has to travel with it. Hard-coding `BookingModification`
        // there matched nothing and silently skipped the raise (#3170 fix round,
        // nit 3).
        localModel,
        priceDiffCents,
        changeFeeCents,
        store: tx,
      });
      // Raised, or already asking for at least this much: either way the queued
      // invoice bills the requested net. Zero on BOTH counters is the one case
      // that does not - the operation is RUNNING, outside the restatable set, so
      // the outbox is trying to send the earlier figure right now.
      //
      // `short-in-flight`, NOT `short-sent`, and the difference is load-bearing
      // rather than descriptive: nothing has reached Xero, this row can be
      // returned to PENDING un-attempted, and the next settlement would then
      // raise it to the combined total. A separate invoice raised on the
      // strength of this answer would be billed a second time inside that
      // raise. The outcome type above carries the worked example.
      const coversTotal = raised.restated + raised.alreadyCovering > 0;
      return {
        queueOperationId: existingQueuedOperation.id,
        outcome: (coversTotal
          ? "covers-total"
          : "short-in-flight") as XeroSupplementaryInvoiceEnqueueOutcome,
        message:
          raised.restated > 0
            ? "Xero supplementary invoice already queued for this change was raised to the combined amount."
            : coversTotal
              ? "Xero supplementary invoice is already queued for background processing."
              : "Xero supplementary invoice for this change is already being sent and could not be raised.",
      };
    }

    // #4324 (`INV-PAY-144`): a change its kept late capture's own invoice bills gets no second invoice, paid or unpaid.
    let keptBilledChangeId: string | undefined;
    for (const id of localModel === "BookingModification" ? billedChangeIds : []) if (!keptBilledChangeId && (await keptInvoiceBillsChangeCapture(tx, id))) keptBilledChangeId = id;
    if (keptBilledChangeId) return { queueOperationId: null, outcome: "none" as XeroSupplementaryInvoiceEnqueueOutcome, refusedBy: "kept-late-capture-invoice" as const, keptBilledChangeId, message: "A kept late card payment's own Xero invoice already bills this booking change." };
    // #3953 round 6: a capture its own receipt records (or is recording) is never recorded again here; a gap invoice decides its own cash.
    const recordPayment = (options?.recordPayment ?? true) && (Boolean(options?.primaryInvoiceGap) || !(await anchorCaptureHasReceipt(tx, { bookingId, bookingModificationId: localModel === "BookingModification" ? localId : null, paymentIntentId: options?.paymentIntentId ?? null })));
    const queuedOperation = await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel,
      localId,
      status: options?.waitForConfirmedAdditionalPayment ? "WAITING_PAYMENT" : "PENDING",
      idempotencyKey: correlationKey,
      correlationKey,
      requestPayload: {
        queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
        bookingId,
        priceDiffCents,
        changeFeeCents,
        bookingModificationId: bookingModificationId ?? null,
        recordPayment,
        paymentIntentId: options?.paymentIntentId ?? null,
        waitForConfirmedAdditionalPayment:
          options?.waitForConfirmedAdditionalPayment ?? false,
        // #3193: the handler reads this to anchor the link, scope the Xero
        // idempotency key and tell the member why they are being asked twice.
        shortfallReviewTaskId,
        ...primaryInvoiceGapPayload(options?.primaryInvoiceGap),
      },
      createdByMemberId: options?.createdByMemberId ?? null,
      store: tx,
    });

    return {
      queueOperationId: queuedOperation.id,
      outcome: "covers-total" as XeroSupplementaryInvoiceEnqueueOutcome,
      message: options?.waitForConfirmedAdditionalPayment
        ? "Xero supplementary invoice is waiting for confirmed additional payment."
        : "Xero supplementary invoice queued for background processing.",
    };
  };
  // #3947: a caller's transaction holds lock(1); this key comes after it, last.
  return store ? decide(store) : prisma.$transaction(decide);
}

/**
 * #3170 (epic #2797): raise what an already-queued supplementary invoice will
 * bill, in place, instead of queueing a second one for the same booking edit.
 *
 * ONE EDIT, ONE ASK. A booking edit whose money could not be valued can raise TWO
 * review tasks, and an officer may settle both as money owed to the club. The
 * owner's 30 Aug 2026 decision on #3170 is that both contribute to a single
 * request for the total, so the Xero leg has to move with it: the supplementary
 * invoice must bill $230, not $200 and then $30.
 *
 * QUEUEING THE SECOND ONE DOES NOT WORK, which is why this exists rather than a
 * second `enqueueXeroSupplementaryInvoiceOperation` call.
 * `enqueueXeroSupplementaryInvoiceOperation` refuses an anchor that already has
 * an active `SUPPLEMENTARY_INVOICE` link and returns a message rather than an
 * error, so the second share would be dropped in silence; and where it did NOT
 * refuse, the club would send two invoices for one edit while the member's card
 * is asked for one combined figure.
 *
 * ONLY OPERATIONS THAT HAVE NOT RUN. PENDING and WAITING_PAYMENT are the two
 * states in which nothing has reached Xero yet, so restating the amount changes
 * what will be billed rather than contradicting what was. An operation in any
 * other state - RUNNING, SUCCEEDED, FAILED - is left alone, and the caller's
 * pre-claim refusal (`REVIEW_CHARGE_REQUEST_CLOSED_MESSAGE`) is what stops a
 * share reaching an ask that has already gone out.
 *
 * THE STATUS FILTER IS ON THE READ **AND** ON THE WRITE (#3170 fix round, F3).
 * It was on the read alone, which is a check-then-act: an operation that left
 * PENDING between the two statements was rewritten anyway, contradicting the
 * paragraph above. The write is now an `updateMany` carrying the same status
 * predicate, so a row that has moved on matches nothing and is counted as not
 * restated.
 *
 * THE STATUS GUARD ONLY MEANS ANYTHING BECAUSE THE WORKER RE-READS AFTER ITS
 * CLAIM (#3170 fix round, F1). The guard alone was not enough and the gap was
 * not the one previously documented here. `processQueuedXeroOutboxOperations`
 * loaded each operation's `requestPayload` in its SCAN and claimed the row only
 * when the loop reached it - one Xero round trip per row later. In that window
 * the row is still PENDING, so a restate MATCHES and WRITES and honestly reports
 * `restated: 1`, while the send that follows uses the scanned figure. Its caller
 * then returns early believing the combined total is billed. On the
 * internet-banking route, where the supplementary invoice IS the ask, that
 * invoiced $200 of a $230 edit and left the $30 recorded nowhere. The worker now
 * re-reads the payload after the claim commits, so a restate either lands and is
 * sent, or matches nothing and reports `restated: 0`. There is no third outcome.
 *
 * WHAT IS STILL NOT GUARANTEED, STATED RATHER THAN IMPLIED: that a restate can
 * always land at all. Once the worker has claimed the row it is RUNNING, and
 * once the invoice exists the anchor carries an active `SUPPLEMENTARY_INVOICE`
 * link; a share settled after either point meets an ask that has left the
 * building. This function reports `restated: 0` and `alreadyCovering: 0`, the
 * caller falls through to the ordinary enqueue, and the enqueue refuses to queue
 * a second invoice behind the first. That refusal is correct - two invoices for
 * one edit is the failure this whole round exists to remove - but it is not
 * free: the invoice bills the earlier figure, and the club has to collect the
 * difference by hand. The settlement path therefore reads the enqueue's own
 * verdict and writes an audit row when the ask is short
 * (`recordUncollectedEditReviewChargeShare`, leg `xero-invoice`), which is the
 * only reason this residual is a recoverable shortfall rather than lost money.
 *
 * IT NEVER LOWERS AN ASK. The combined total is derived from settled shares and
 * a settled share is terminal, so the figure only ever grows and a SMALLER one is
 * always the older answer. Two settlements racing can compute their totals in
 * either order, so without this comparison the stale run's restate could land
 * last and take a queued $230 invoice back down to $200 - and its caller would
 * then return early, having "restated", so nothing re-queued the difference. An
 * operation already asking for at least this much is counted in
 * `alreadyCovering` instead: nothing is written, and the caller still knows not
 * to queue a second invoice behind it.
 *
 * The correlation key moves with the amount, because it is built FROM the amount:
 * leaving it stale would let a later enqueue for the new total find no match and
 * queue a duplicate.
 *
 * Returns how many operations this raised and how many already asked for at least
 * this much. `restated + alreadyCovering === 0` means "nothing is queued for this
 * edit", which is the FIRST share's ordinary answer and tells the caller to
 * enqueue normally.
 */
export async function restatePendingSupplementaryInvoiceAmount({
  bookingModificationId,
  localModel = "BookingModification",
  priceDiffCents,
  changeFeeCents,
  store = prisma,
}: {
  bookingModificationId: string;
  /**
   * The anchor's model, because `localId` alone does not identify a row.
   *
   * Defaults to `BookingModification`, which is every edit-review caller and was
   * the hard-coded value. It is a parameter because
   * `enqueueXeroSupplementaryInvoiceOperation` also anchors on the BOOKING when
   * no modification id is supplied: passing that booking id under a hard-coded
   * `BookingModification` matched nothing by construction, so the enqueue's own
   * docblock claim that a queued operation asking for LESS is raised was false
   * on exactly that branch - quietly, because "nothing matched" and "nothing
   * needed raising" return the same zeroes.
   *
   * `ManualRefundTask` is #3193's second ask. A raise there is only ever a
   * no-op: a settled share is a terminal, fixed figure, so a repeat arrives with
   * the amount already queued and is counted as `alreadyCovering`. It is passed
   * through rather than special-cased because the enqueue's decision is one
   * decision for all three anchors, and a carve-out would be a second answer to
   * the same question.
   */
  localModel?: XeroSupplementaryInvoiceAnchorModel;
  priceDiffCents: number;
  changeFeeCents: number;
  /**
   * The enqueue calls this from INSIDE its advisory-locked transaction, so the
   * raise and the decision not to queue a second invoice are one atomic act.
   * Every other caller runs post-commit on the module client.
   */
  store?: Prisma.TransactionClient | typeof prisma;
}): Promise<{ restated: number; alreadyCovering: number }> {
  // #3947: the one read, shared with the review charge's route chooser.
  const operations = await store.xeroSyncOperation.findMany({
    where: restatableSupplementaryInvoiceOperationsWhere({
      localModel,
      localId: bookingModificationId,
    }),
    select: { id: true, requestPayload: true },
  });

  // The SAME shape the enqueue mints, prefix included: it derives the prefix
  // from the anchor's model, so restating a Booking-anchored operation under a
  // `booking-mod` prefix would leave the row describing an anchor it does not
  // have. #3193 collapsed the three copies of that shape into one mint rather
  // than adding a fourth anchor to each of them (`INV-SSOT`).
  const correlationKey = buildXeroSupplementaryInvoiceKey({
    localModel,
    localId: bookingModificationId,
    priceDiffCents,
    changeFeeCents,
  });

  const requestedNetCents = priceDiffCents + changeFeeCents;

  let restated = 0;
  let alreadyCovering = 0;
  for (const operation of operations) {
    const payload = supplementaryInvoicePayload(operation.requestPayload);
    if (!payload) continue;
    // What the queued invoice would BILL (`supplementaryInvoiceBilledCents`, the
    // one reading of it). Comparing the net rather than one component is what
    // makes "never lower" mean what it says on a queued row carrying a change
    // fee. An unreadable row bills nothing, so it is raised to this total.
    const queuedNetCents =
      supplementaryInvoiceBilledCents(operation.requestPayload) ?? 0;
    if (queuedNetCents >= requestedNetCents) {
      // Already asking for at least this much: an exact replay, or a stale,
      // smaller total arriving after a larger one. Neither may write.
      alreadyCovering += 1;
      continue;
    }
    // `updateMany` rather than `update`, carrying the same status predicate the
    // read used: an operation the outbox claimed between the two statements
    // matches nothing and is left exactly as the worker found it.
    const raised = await store.xeroSyncOperation.updateMany({
      where: {
        id: operation.id,
        status: { in: [...RESTATABLE_SUPPLEMENTARY_INVOICE_STATUSES] },
        // #3403 review (C1): still waiting on the request it was read on; an invoice a supersession moved since is not written back.
        ...(typeof payload.paymentIntentId === "string" ? { requestPayload: { path: ["paymentIntentId"], equals: payload.paymentIntentId } } : {}),
      },
      data: {
        requestPayload: {
          ...payload,
          priceDiffCents,
          changeFeeCents,
        } as Prisma.InputJsonValue,
        idempotencyKey: correlationKey,
        correlationKey,
      },
    });
    if (raised.count === 1) restated += 1;
  }

  return { restated, alreadyCovering };
}

/** The operation's payload as an object, or `null` if it is not one. */
export function supplementaryInvoicePayload(
  requestPayload: Prisma.JsonValue | null,
): Record<string, unknown> | null {
  return requestPayload &&
    typeof requestPayload === "object" &&
    !Array.isArray(requestPayload)
    ? (requestPayload as Record<string, unknown>)
    : null;
}

/** #4299: the edit queues its organiser invoice in its own transaction. */
export async function enqueueOrganiserExtraInvoiceInTransaction(params: { bookingId: string; bookingModificationId: string; priceDiffCents: number; changeFeeCents: number; createdByMemberId?: string }, store: Prisma.TransactionClient) {
  return enqueueSupplementaryInvoiceForAnchor(params, { recordPayment: false, createdByMemberId: params.createdByMemberId }, store);
}
