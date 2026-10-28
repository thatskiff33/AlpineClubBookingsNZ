/**
 * #3403 (owner decision 26 Oct 2026, "follow the money"; `INV-PAY-140`,
 * `INV-PAY-104`): A SUPERSEDED CARD CHANGE'S WAITING SUPPLEMENTARY INVOICE
 * MOVES TO THE REQUEST THAT NOW CARRIES ITS BALANCE.
 *
 * On the card route a change's Xero supplementary invoice waits
 * `WAITING_PAYMENT` on the change's own PaymentIntent and is released only by a
 * capture of that intent. A later request B that supersedes an unpaid ask A
 * carries A's balance (`INV-PAY-098`) and cancels A (`INV-ADDPAY-023`), so
 * nothing could ever release A's invoice: the reaper retired it a day later
 * while B collected the money. Now A's waiting invoice is re-pointed at B, so
 * B's capture releases BOTH invoices, each for its own amount - never folded
 * onto B's invoice. If B is never paid, nothing is invoiced, as for every
 * other card change. If B was already captured when the move happens, the
 * late-capture release runs for B at once.
 *
 * WHO CALLS IT, each holding nothing (no transaction, no advisory key):
 * - the supersede's durable cancel step, both of its terminal branches
 *   (`processCancelPaymentIntentOperation`, and the Stripe webhook's
 *   `completeCanceledSupersededPaymentIntentRecovery`), after A is FAILED and
 *   before the recovery row completes, so a crash replays it - and, where A
 *   was captured instead, its hand-off to the refund
 *   (`handoffSucceededSupersededIntentToRefund`, review 2 F1);
 * - every superseding minter, after its cancels and before the new client
 *   secret is returned (`cancelSupersededAdditionalIntentsNow` with the new
 *   intent named), which also covers an A whose card was DECLINED - FAILED,
 *   so carried at once, though its cancel (#4422) may not finish now (a
 *   Stripe outage, a backoff) or finished at an earlier supersede;
 * - an edit's Xero leg (`queueXeroBookingEditSettlement`) that parked its
 *   invoice on an ask already FAILED, through
 *   `followSupersededAskInvoicesForIntentSafely`: a leg landing after the
 *   supersession's own move;
 * - the waiting-invoice reaper, before it retires an invoice whose booking no
 *   longer names its intent: the backstop for a crash between the others.
 *
 * WHAT MOVES, and what is refused (each refusal leaves the row exactly as it
 * was, to the reaper and the booking-vs-Xero repair pass as before):
 * - the CARRIER of a FAILED (or superseded and captured late), unwithdrawn ask
 *   is the first later ADDITIONAL card row that can carry money - still
 *   payable, or captured - and that no superseded-intent operation names (`supersededAskCarriers`), on a booking
 *   that has not ended (CANCELLED or BUMPED) or been deleted; a caller naming
 *   its new intent must be naming the payment's newest row;
 * - the INVOICES are supplementary-invoice creates anchored on a booking
 *   change, still `WAITING_PAYMENT` on one of the carried asks' intents,
 *   carrying no error code and no resolve mark (`INV-INT-025`);
 * - under the change's key and the carrier's (`moveLockKeys`), the change must
 *   have no active supplementary-invoice link and no other outstanding
 *   operation;
 * - the carrier must cover what would then wait on it: everything naming it
 *   bills at most its `amountCents`, and what bills changes other than its own
 *   (`captureChangeId`) at most its `carriedAskCents`.
 *
 * A CAPTURE OF THE CARRIED ASK ITSELF. Since #4422 a supersede cancels a
 * declined ask too, so a stale tab's capture of one races a live cancel row and
 * takes the superseded-capture path - refunded, or held for a treasurer on a
 * cancelled booking - and its invoice stays on the carrier. Only a capture no
 * live cancel row owns (a declined ask superseded before #4422, one whose row a
 * manual mark-paid reversal deleted) settles as a late capture, and that
 * takes its invoice back: the release returns every invoice first parked on
 * that intent to it before it releases (`returnMovedInvoicesToCapturedIntent`),
 * so the capture that paid the change is the one it records.
 *
 * THE WRITE is a status-guarded `updateMany` (`WAITING_PAYMENT`, the intent it
 * waited on, no error code, no resolve mark), so a row a reduction retired, a
 * capture released or another caller moved in the meantime matches nothing. It
 * records the intent the invoice first waited on
 * (`SUPPLEMENTARY_INVOICE_PARKED_FROM_KEY`, kept through a later move), which
 * is how a reduction still reads the invoice as the superseded row's own money
 * (`supplementaryInvoiceWaitedFirstOn`). One short transaction per anchor holding
 * its keys; no provider call runs inside, and the late-capture release runs
 * after it commits.
 *
 * NOT TOUCHED: an invoice the reaper already retired (`STALE_WAITING_PAYMENT`)
 * on a superseded intent. With these callers no new one is retired while
 * a live carrier exists; one retired before this change is left to the repair
 * pass's `MISSING_SUPPLEMENTARY_INVOICE`, because a retired row is revived only
 * by a capture of its OWN intent, and widening that to another intent would
 * give the re-queue a second trigger it was never reviewed for.
 */
import { PaymentSource, PaymentStatus, PaymentTransactionKind, type Prisma } from "@prisma/client";

import { isAdditionalAskRetiredBookingStatus } from "@/lib/additional-payment-chase";
import { anchorCaptureHasReceipt, captureChangeId } from "@/lib/additional-capture-receipt-link";
import { keptCaptureAnchorId } from "@/lib/kept-late-capture-change-receipt";
import { findActiveSupplementaryInvoiceLink } from "@/lib/late-capture-xero-receipt";
import logger from "@/lib/logger";
import { LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";
import { isCapturedTransactionStatus, isOpenIntentTransactionStatus } from "@/lib/payment-transaction-status";
import { prisma } from "@/lib/prisma";
import { SUPERSEDED_INTENT_OPERATION_TYPES } from "@/lib/superseded-intent-ownership";
import { asRecord } from "@/lib/xero-json";
import { kickQueuedXeroOutboxOperationsIfConnected, lockSupplementaryInvoiceAnchor } from "@/lib/xero-operation-outbox";
import { supplementaryInvoiceBilledCents } from "@/lib/xero-operation-outbox-payload";
import {
  SUPPLEMENTARY_INVOICE_MOVED_UNPAID_KEY,
  SUPPLEMENTARY_INVOICE_PARKED_FROM_KEY,
  supplementaryInvoiceWaitedFirstOn,
} from "@/lib/supplementary-invoice-parked-from";
import {
  SUPPLEMENTARY_INVOICE_CREATE_WHERE,
  outstandingSupplementaryInvoiceOperationsWhere,
  supplementaryInvoicesNamingIntentWhere,
} from "@/lib/xero-supplementary-invoice-statuses";
import { releaseXeroSupplementaryInvoiceForCapturedPaymentIntent } from "@/lib/xero-supplementary-invoice-late-capture";

export type SupersededAskInvoiceRefusal =
  | "not-the-carrier"
  | "booking-ended"
  | "invoice-already-linked"
  | "another-invoice-queued"
  | "unreadable-invoice"
  | "carrier-would-overbill"
  | "changed-under-lock";

export type SupersededAskInvoiceCarryResult = {
  /** The requests invoices now wait on (each carrier something moved onto, or would have). */
  carrierPaymentIntentIds: string[];
  /** How many waiting invoices were moved onto a carrier by this call. */
  moved: number;
  /** One entry per anchor (or the whole call) left as it was, and why. */
  refusals: Array<{ anchorId: string | null; reason: SupersededAskInvoiceRefusal }>;
  /** True when a carrier was already captured and its late-capture release ran. */
  releasedOnCapturedCarrier: boolean;
};

type LedgerRow = {
  id: string;
  status: PaymentStatus;
  amountCents: number;
  carriedAskCents: number;
  stripePaymentIntentId: string | null;
  withdrawnAt: Date | null;
  bookingModificationId: string | null;
  reason: string | null;
};

const LEDGER_ROW_SELECT = {
  id: true,
  status: true,
  amountCents: true,
  carriedAskCents: true,
  stripePaymentIntentId: true,
  withdrawnAt: true,
  bookingModificationId: true,
  reason: true,
} as const;

/** One request and the superseded asks whose balance it carried. */
export type CarriedChain = { carrier: LedgerRow; superseded: LedgerRow[] };

/**
 * WHICH REQUEST CARRIED WHICH, read from one payment's ADDITIONAL card ledger,
 * oldest first. A FAILED, unwithdrawn ask was carried by the FIRST later row
 * that can carry money: one still payable (`isOpenIntentTransactionStatus`) or
 * captured (`isCapturedTransactionStatus`, refunded or not - its capture
 * happened), which is the row whose `carriedAskCents` absorbed it
 * (`INV-PAY-098`). Each FAILED ask it passes on the way is carried there too:
 * a request superseded in turn hands its whole carried balance on.
 *
 * A row a superseded-intent operation names (`supersededIntentIds`) never
 * carries: the money it asked for is carried by the request after it. Once
 * captured late - and so refunded (`lateCaptureRefundState`) - it is CARRIED
 * like a FAILED one, with whatever was already moved onto it (review 2, F1);
 * while its cancel is still in flight it is passed over, and the cancel
 * step's two terminal branches (FAILED, or the captured hand-off to its
 * refund) run the move once it lands.
 *
 * Passed over, neither carrying nor carried: a row a price reduction withdrew
 * (`retireUnpaidAskChain` retires and counts its own invoices).
 *
 * Not `unpaidChain` (`additional-ask-reduction.ts`, review S3): that asks what
 * the payment still owes NOW (the rows after the last capture, ending in the
 * live ask); this asks, for every carried ask, which row took its balance -
 * including a capture since, which the reduction's chain starts after.
 */
export function supersededAskCarriers(
  rows: readonly LedgerRow[],
  supersededIntentIds: ReadonlySet<string>,
): CarriedChain[] {
  const chains: CarriedChain[] = [];
  let carried: LedgerRow[] = [];
  for (const row of rows) {
    if (row.withdrawnAt || !row.stripePaymentIntentId) continue;
    const superseded = supersededIntentIds.has(row.stripePaymentIntentId);
    // Review 2 (F1): a superseded row captured late is refunded, and the
    // request after it carries its balance - with every invoice already moved
    // onto it - exactly as for one whose cancel landed FAILED.
    if (row.status === PaymentStatus.FAILED || (superseded && isCapturedTransactionStatus(row.status))) {
      carried.push(row);
      continue;
    }
    const canCarry = isOpenIntentTransactionStatus(row.status) || isCapturedTransactionStatus(row.status);
    if (!canCarry || superseded) continue;
    if (carried.length > 0) chains.push({ carrier: row, superseded: carried });
    carried = [];
  }
  return chains;
}

/** The payment's ADDITIONAL card ledger, and the intents a superseded-intent operation names. */
async function readLedger(
  store: Pick<Prisma.TransactionClient, "paymentTransaction" | "paymentRecoveryOperation">,
  paymentId: string,
): Promise<{ rows: LedgerRow[]; chains: CarriedChain[] }> {
  const rows = await store.paymentTransaction.findMany({
    where: { paymentId, kind: PaymentTransactionKind.ADDITIONAL, source: PaymentSource.STRIPE },
    orderBy: [...LEDGER_ROWS_OLDEST_FIRST],
    select: LEDGER_ROW_SELECT,
  });
  const intentIds = rows.flatMap((row) => (row.stripePaymentIntentId ? [row.stripePaymentIntentId] : []));
  const supersededOps =
    intentIds.length === 0
      ? []
      : await store.paymentRecoveryOperation.findMany({
          where: { paymentIntentId: { in: intentIds }, type: { in: [...SUPERSEDED_INTENT_OPERATION_TYPES] } },
          select: { paymentIntentId: true },
        });
  const supersededIntentIds = new Set(supersededOps.flatMap((op) => (op.paymentIntentId ? [op.paymentIntentId] : [])));
  return { rows, chains: supersededAskCarriers(rows, supersededIntentIds) };
}

function intentsOf(rows: readonly LedgerRow[]): string[] {
  return rows.flatMap((row) => (row.stripePaymentIntentId ? [row.stripePaymentIntentId] : []));
}

function waitingOnIntentsWhere(intentIds: readonly string[]): Prisma.XeroSyncOperationWhereInput {
  return {
    ...SUPPLEMENTARY_INVOICE_CREATE_WHERE,
    status: "WAITING_PAYMENT",
    localModel: "BookingModification",
    localId: { not: null },
    manuallyResolvedAt: null,
    lastErrorCode: null,
    OR: intentIds.map((intentId) => ({ requestPayload: { path: ["paymentIntentId"], equals: intentId } })),
  };
}

/**
 * Move the waiting supplementary invoices of a payment's superseded card asks
 * onto the request that carries their balance. Throws only on a database
 * failure; `followSupersededAskInvoicesSafely` is the callers' spelling.
 */
export async function followSupersededAskInvoicesToCarrier({
  paymentId,
  carrierPaymentIntentId,
}: {
  paymentId: string;
  /** A minter names the intent it just wrote; it must still be the payment's newest row. */
  carrierPaymentIntentId?: string;
}): Promise<SupersededAskInvoiceCarryResult> {
  const result: SupersededAskInvoiceCarryResult = {
    carrierPaymentIntentIds: [],
    moved: 0,
    refusals: [],
    releasedOnCapturedCarrier: false,
  };
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: { bookingId: true, booking: { select: { status: true, deletedAt: true } } },
  });
  if (!payment) return result;

  const { rows, chains } = await readLedger(prisma, paymentId);
  if (chains.length === 0) return result;
  if (carrierPaymentIntentId && rows.at(-1)?.stripePaymentIntentId !== carrierPaymentIntentId) {
    result.refusals.push({ anchorId: null, reason: "not-the-carrier" });
    return result;
  }
  if (isAdditionalAskRetiredBookingStatus(payment.booking.status) || payment.booking.deletedAt) {
    result.refusals.push({ anchorId: null, reason: "booking-ended" });
    return result;
  }

  const movedOnto = new Map<string, string>();
  for (const { carrier, superseded } of chains) {
    const carrierIntentId = carrier.stripePaymentIntentId as string;
    const waiting = await prisma.xeroSyncOperation.findMany({
      where: waitingOnIntentsWhere(intentsOf(superseded)),
      select: { localId: true },
    });
    const anchors = [...new Set(waiting.flatMap((row) => (row.localId ? [row.localId] : [])))].sort();
    if (anchors.length === 0) continue;
    result.carrierPaymentIntentIds.push(carrierIntentId);
    let movedHere = 0;
    for (const anchorId of anchors) {
      const verdict = await moveAnchorOntoCarrier({
        bookingId: payment.bookingId,
        paymentId,
        anchorId,
        carrier: { id: carrier.id, paymentIntentId: carrierIntentId, key: keptCaptureAnchorId(carrier, payment.bookingId) },
      });
      if (verdict.moved > 0) movedHere += verdict.moved;
      else if (verdict.refusal) result.refusals.push({ anchorId, reason: verdict.refusal });
    }
    result.moved += movedHere;
    if (movedHere > 0) movedOnto.set(carrier.id, carrierIntentId);
  }

  // Read AFTER the moves committed: a capture whose own release ran before
  // them could not see these invoices, and its row is committed before that
  // release reads, so either it released them or this read sees it captured.
  // The one release (`INV-PAY-104`) then decides them, outside any lock,
  // exactly as a capture would; a second release finds nothing waiting.
  for (const [carrierId, carrierIntentId] of movedOnto) {
    const now = await prisma.paymentTransaction.findUnique({ where: { id: carrierId }, select: { status: true } });
    if (!now || !isCapturedTransactionStatus(now.status)) continue;
    const released = await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent(carrierIntentId);
    result.releasedOnCapturedCarrier = true;
    if (released.released > 0) void kickQueuedXeroOutboxOperationsIfConnected({ limit: released.released }).catch(() => null);
  }
  if (result.moved > 0) {
    logger.info(
      { paymentId, ...result },
      "Moved a superseded card change's waiting Xero supplementary invoices onto the request that carries its balance (#3403)",
    );
  }
  if (result.refusals.length > 0) {
    logger.warn(
      { paymentId, ...result },
      "A superseded card change's waiting Xero supplementary invoice was left where it was (#3403); the reaper and the booking-vs-Xero repair pass decide it as before",
    );
  }
  return result;
}

/**
 * The keys a move takes, in the one order (`INV-LOCK-002`): the booking's
 * before any change's, and two changes' sorted. The change's key decides "is
 * an invoice already going out for it?" (the enqueue's question); the
 * CARRIER's - the change its capture pays for, else the booking, where its
 * receipt decides who records it (`INV-PAY-139`) - makes the cover check and
 * the recorder decision one act with every other move onto it and with that
 * receipt (review C2, C3).
 */
function moveLockKeys(anchorId: string, carrierKey: string, bookingId: string): string[] {
  if (carrierKey === anchorId) return [anchorId];
  if (carrierKey === bookingId) return [bookingId, anchorId];
  return [anchorId, carrierKey].sort();
}

/**
 * One anchor's move, in one short transaction holding that anchor's key and
 * the carrier's and nothing else. Everything decided here is re-read under them.
 */
async function moveAnchorOntoCarrier(input: {
  bookingId: string;
  paymentId: string;
  anchorId: string;
  carrier: { id: string; paymentIntentId: string; key: string };
}): Promise<{ moved: number; refusal: SupersededAskInvoiceRefusal | null }> {
  return prisma.$transaction(async (tx) => {
    for (const key of moveLockKeys(input.anchorId, input.carrier.key, input.bookingId)) {
      await lockSupplementaryInvoiceAnchor(tx, key);
    }

    // The ledger again, under the keys: a reduction may have withdrawn the
    // rows, a cancel ended the booking, or a newer request superseded the carrier.
    const [{ chains }, booking] = await Promise.all([
      readLedger(tx, input.paymentId),
      tx.booking.findUnique({ where: { id: input.bookingId }, select: { status: true, deletedAt: true } }),
    ]);
    const chain = chains.find((candidate) => candidate.carrier.id === input.carrier.id);
    if (!chain) return { moved: 0, refusal: "changed-under-lock" as const };
    if (!booking || isAdditionalAskRetiredBookingStatus(booking.status) || booking.deletedAt) {
      return { moved: 0, refusal: "booking-ended" as const };
    }
    const { carrier } = chain;
    const carrierIntentId = input.carrier.paymentIntentId;

    const moving = await tx.xeroSyncOperation.findMany({
      where: { ...waitingOnIntentsWhere(intentsOf(chain.superseded)), localId: input.anchorId },
      select: { id: true, requestPayload: true, correlationKey: true },
    });
    if (moving.length === 0) return { moved: 0, refusal: null };
    const movingIds = moving.map((operation) => operation.id);

    const anchor = { localModel: "BookingModification" as const, localId: input.anchorId };
    if (await findActiveSupplementaryInvoiceLink([anchor], tx)) {
      return { moved: 0, refusal: "invoice-already-linked" as const };
    }
    const otherOutstanding = await tx.xeroSyncOperation.findFirst({
      where: { ...outstandingSupplementaryInvoiceOperationsWhere(anchor), id: { notIn: movingIds } },
      select: { id: true },
    });
    if (otherOutstanding) return { moved: 0, refusal: "another-invoice-queued" as const };

    // NEVER BILL MORE THAN THE CARRIER ASKS FOR. What already names it plus
    // what moves must fit its amount, and what bills changes other than its
    // own (`captureChangeId`; with none, every change's) must fit the part it
    // carried (review M3: the sum, never one change at a time).
    const movingBilled = moving.map((operation) => supplementaryInvoiceBilledCents(operation.requestPayload));
    if (movingBilled.some((cents) => cents === null)) return { moved: 0, refusal: "unreadable-invoice" as const };
    const onCarrier = await tx.xeroSyncOperation.findMany({
      where: { ...supplementaryInvoicesNamingIntentWhere(carrierIntentId), id: { notIn: movingIds } },
      select: { localId: true, requestPayload: true },
    });
    const onCarrierBilled = onCarrier.map((operation) => ({
      localId: operation.localId,
      cents: supplementaryInvoiceBilledCents(operation.requestPayload),
    }));
    if (onCarrierBilled.some((entry) => entry.cents === null)) return { moved: 0, refusal: "unreadable-invoice" as const };
    const sum = (values: Array<number | null>) => values.reduce<number>((total, cents) => total + (cents ?? 0), 0);
    const movingCents = sum(movingBilled);
    const ownChangeId = captureChangeId(carrier);
    const carriedOnCarrierCents =
      (ownChangeId === input.anchorId ? 0 : movingCents) +
      sum(onCarrierBilled.filter((entry) => entry.localId !== ownChangeId).map((entry) => entry.cents));
    if (
      movingCents + sum(onCarrierBilled.map((entry) => entry.cents)) > carrier.amountCents ||
      carriedOnCarrierCents > carrier.carriedAskCents
    ) {
      return { moved: 0, refusal: "carrier-would-overbill" as const };
    }

    // A capture already recorded by its own receipt (`INV-PAY-139`) keeps one
    // recorder: the moved invoice then goes out unpaid, as the late-capture
    // re-queue revives one. Decided under the carrier's key, where that
    // receipt decides too, and marked, so a return to the superseded ask
    // decides it again for that ask's capture (review 2, F2).
    const carrierCaptured = isCapturedTransactionStatus(carrier.status);
    // Review 2 (F6): a receipt for the carrier's capture still queued counts
    // too. A paid invoice moved onto it would read as the whole capture's
    // recorder (`readCaptureRecorder`), and that receipt would stand down with
    // the carrier's own part recorded nowhere; unpaid, the receipt records it all.
    const carrierReceiptActive =
      carrierCaptured &&
      (await anchorCaptureHasReceipt(
        tx,
        { bookingId: input.bookingId, bookingModificationId: null, paymentIntentId: carrierIntentId },
        { queuedCounts: true },
      ));
    let moved = 0;
    for (const operation of moving) {
      const payload = asRecord(operation.requestPayload) ?? {};
      const unpaid =
        carrierCaptured &&
        payload.recordPayment !== false &&
        (carrierReceiptActive ||
          (await anchorCaptureHasReceipt(tx, {
          bookingId: input.bookingId,
          bookingModificationId: input.anchorId,
          paymentIntentId: carrierIntentId,
        })));
      // Guarded on what was read: the status, the intent and the correlation
      // key, which an unlocked restate rewrites whenever it raises the amount
      // (review C1) - so a raise landing since is never written back over.
      const written = await tx.xeroSyncOperation.updateMany({
        where: {
          id: operation.id,
          status: "WAITING_PAYMENT",
          manuallyResolvedAt: null,
          lastErrorCode: null,
          correlationKey: operation.correlationKey,
          requestPayload: { path: ["paymentIntentId"], equals: payload.paymentIntentId as string },
        },
        data: {
          requestPayload: {
            ...payload,
            paymentIntentId: carrierIntentId,
            [SUPPLEMENTARY_INVOICE_PARKED_FROM_KEY]: supplementaryInvoiceWaitedFirstOn(payload),
            ...(unpaid ? { recordPayment: false, [SUPPLEMENTARY_INVOICE_MOVED_UNPAID_KEY]: true } : {}),
          } as Prisma.InputJsonObject,
        },
      });
      moved += written.count;
    }
    return { moved, refusal: moved > 0 ? null : ("changed-under-lock" as const) };
  });
}

/**
 * Move the superseded asks' invoices for the payment whose card request this
 * is, when that request is itself a FAILED ask (review M5): an edit's Xero leg
 * that parks its invoice on an ask a later request already superseded - and
 * whose move already ran, finding nothing - follows it at once, rather than
 * waiting for the reaper's backstop.
 */
export async function followSupersededAskInvoicesForIntentSafely(paymentIntentId: string): Promise<void> {
  try {
    const row = await prisma.paymentTransaction.findUnique({
      where: { stripePaymentIntentId: paymentIntentId },
      select: { paymentId: true, status: true },
    });
    if (row?.status === PaymentStatus.FAILED) await followSupersededAskInvoicesSafely({ paymentId: row.paymentId });
  } catch (err) {
    logger.error({ err, paymentIntentId }, "Could not check whether an edit's parked Xero invoice waits on a superseded ask (#3403); the reaper moves it before it would retire it");
  }
}

/**
 * `followSupersededAskInvoicesToCarrier` for the callers, which must never
 * fail on it: a supersede's cancel, a minter's secret and the reaper's sweep
 * all stand whatever happens here. A failure is logged; the reaper retries it
 * before it would retire the invoice, and the repair pass reports what is left.
 */
export async function followSupersededAskInvoicesSafely(input: {
  paymentId: string;
  carrierPaymentIntentId?: string;
}): Promise<SupersededAskInvoiceCarryResult | null> {
  try {
    return await followSupersededAskInvoicesToCarrier(input);
  } catch (err) {
    logger.error(
      { err, ...input },
      "Could not move a superseded card change's waiting Xero supplementary invoice onto the request that carries its balance (#3403); the waiting-invoice reaper tries again before it would retire it",
    );
    return null;
  }
}
