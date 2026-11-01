/**
 * #3953 review round 1 (`INV-PAY-139`): ONE RECORDER PER CAPTURE.
 *
 * Four writers can record a booking's Stripe cash against a Xero invoice: the
 * primary invoice's create, the #3980 gap invoice (paid from the cash the
 * primary left), a booking change's own supplementary invoice, and a change
 * capture's own receipt. Each capture's cash is recorded by exactly one, and
 * every writer knows which captures it took:
 *
 *  - THE PRIMARY'S CREATE records the snapshot's captures, oldest first, while
 *    its recorded cash covers them (`paymentIntentIdsRecordedAtLink`).
 *  - EVERY OTHER CAPTURED CHANGE gets a receipt row as soon as the primary's
 *    link is saved (`queueReceiptsForUnrecordedCaptures`), and later ones as
 *    they land (the late-success release).
 *  - THE GAP INVOICE pays itself only from cash no receipt row has claimed,
 *    and never from the credit-release sweep's share of a capture (#4494,
 *    `INV-ADDPAY-046`), and names the captures that cash came from on its own
 *    queued payload (`coveredPaymentIntentIds`, {@link attributeGapCash}).
 *  - A CHANGE'S OWN SUPPLEMENTARY INVOICE - one on the change, or one naming
 *    the capture's intent - is that capture's document.
 *  - #4324 (`INV-PAY-144`): A KEPT LATE CAPTURE'S OWN INVOICE
 *    (`KEPT_LATE_CAPTURE_INVOICE`, in any status but CANCELLED) records the
 *    capture it was queued for, where the treasurer's keep found nothing
 *    billing its change.
 *
 * {@link readCaptureRecorder} is the one reading of that: the receipt's
 * enqueue asks it under the per-anchor supplementary-invoice lock, its worker
 * before it plans, and the repair tool before it reports anything.
 */
import type { Prisma } from "@prisma/client";
import {
  creditReleaseSweptCents,
  readCreditReleaseCaptureShare,
  type CreditReleaseCaptureShare,
} from "@/lib/credit-release-capture-share";
import { LIVE_KEPT_LATE_CAPTURE_INVOICE_WHERE } from "@/lib/late-capture-kept-xero-rules";
import { prisma } from "@/lib/prisma";
import { asRecord, responseNamesXeroInvoice } from "@/lib/xero-json";
import { XERO_ORPHANED_STALE_RUNNING_ERROR_CODE } from "@/lib/xero-operation-error-codes";
import { isRerunnableOperation } from "@/lib/xero-active-operation-statuses";
import type { PrimaryInvoiceFeeAtLink } from "@/lib/xero-primary-invoice-fee-at-link";
import { CAPTURED_TRANSACTION_STATUS_LIST } from "@/lib/payment-transaction-status";
import { LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";
import { XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE } from "@/lib/xero-operation-outbox-payload";
import {
  GAP_COVERED_CENTS_KEY,
  GAP_COVERED_INTENTS_KEY,
  XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
} from "@/lib/additional-capture-receipt-payload";
import {
  findPrimaryInvoiceGapInvoice,
  readPrimaryInvoiceFeeAtLink,
  type GapAnchorStore,
} from "@/lib/xero-primary-invoice-gap-anchors";


export type RecorderStore = GapAnchorStore & Pick<Prisma.TransactionClient, "paymentTransaction">;

type SupplementaryOperation = {
  id: string;
  status: string;
  requestPayload: Prisma.JsonValue | null;
  responsePayload: Prisma.JsonValue | null;
  manuallyResolvedAt: Date | null;
};

/**
 * The supplementary invoice a receipt records against instead of the primary
 * (`kind`): the #3980 gap invoice where the capture's change is one it bills
 * for, or (review round 3, F1) the change's own invoice raised UNPAID - one
 * that bills the change and records no payment, so the capture is its money.
 */
export type ReceiptTarget = {
  kind: "GAP_INVOICE" | "CHANGE_INVOICE";
  operation: SupplementaryOperation | null;
  link: { id: string; xeroObjectId: string; active: boolean } | null;
};

export type CaptureRecorder =
  /** The primary invoice's create recorded it in its own payment. */
  | { kind: "primary-invoice" }
  /** The credit-release sweep records all of it (or holds it for an officer): #4253, `INV-ADDPAY-046`. */
  | { kind: "credit-release-sweep" }
  /** A supplementary invoice records it: one naming the intent, covering all of it, or the change's own paid one. */
  | { kind: "supplementary-invoice"; operationId: string | null }
  /** #4324: the kept-capture invoice a treasurer's keep queued for it records it. */
  | { kind: "kept-late-capture-invoice"; operationId: string }
  /**
   * Nothing else records all of it, so the capture's own receipt records the
   * rest: against `target` where there is one, otherwise the primary.
   */
  | {
      kind: "receipt";
      figures: Awaited<ReturnType<typeof readPrimaryInvoiceFeeAtLink>>;
      /** The primary's gap invoice, whichever change it is anchored on, or null. */
      gap: NonNullable<Awaited<ReturnType<typeof findPrimaryInvoiceGapInvoice>>> | null;
      target: ReceiptTarget | null;
      /**
       * Cents of this capture another writer already recorded: the part the
       * primary's payment reached (`partiallyRecordedCaptureAtLink`), and
       * (review round 3, F2) the part the gap invoice's payment took
       * (`coveredCaptureCents`). The receipt records only the rest.
       */
      alreadyRecordedCents: number;
    };

const SUPPLEMENTARY_SELECT = {
  id: true,
  status: true,
  requestPayload: true,
  responsePayload: true,
  manuallyResolvedAt: true,
} as const;

/** Whether a supplementary invoice's queued payload records a Stripe payment (the enqueue's default). */
function recordsPayment(requestPayload: Prisma.JsonValue | null): boolean {
  return asRecord(requestPayload)?.recordPayment !== false;
}

/**
 * #3403 review 2 (F3): whether a change's own supplementary invoice records
 * THIS capture of the change. It records a payment, and names no other
 * capture: a superseded change's invoice moved onto the request carrying its
 * balance (`INV-PAY-140`) records that request's capture, never the change's
 * own superseded ask, so a stale-tab capture of that ask is recorded by its
 * own receipt instead of standing down to an invoice that paid with other money.
 */
function changeInvoiceRecordsCapture(requestPayload: Prisma.JsonValue | null, paymentIntentId: string): boolean {
  const named = asRecord(requestPayload)?.paymentIntentId;
  return recordsPayment(requestPayload) && (typeof named !== "string" || named === paymentIntentId);
}

/**
 * #4324 review (money F3, `INV-SSOT`): whether a change's own supplementary
 * invoice is THIS capture's document by the reading below - raised unpaid, so
 * the capture's receipt records against it, or recording this capture
 * ({@link changeInvoiceRecordsCapture}). One recording another capture (moved
 * onto a carrier and released there, or waiting on a different intent) is not:
 * the recorder falls through to the primary, which never billed the change.
 * The keep's evidence reads the change's invoices by this
 * (`readKeptChangeCaptureEvidence`).
 */
export function changeInvoiceBillsCapture(requestPayload: Prisma.JsonValue | null, paymentIntentId: string): boolean {
  return !recordsPayment(requestPayload) || changeInvoiceRecordsCapture(requestPayload, paymentIntentId);
}

/**
 * The recorder of a capture, with the credit-release sweep's share taken out
 * (#4253, `INV-ADDPAY-046`): the money of a credit-release request inside the
 * capture is recorded by the sweep against the booking's own invoice, so the
 * receipt records only the rest, and stands down where the sweep has all of it.
 */
export async function readCaptureRecorder(
  input: {
    bookingId: string;
    primaryInvoiceId: string;
    paymentIntentId: string;
    bookingModificationId: string | null;
  },
  store: RecorderStore = prisma,
): Promise<CaptureRecorder> {
  const base = await readBaseCaptureRecorder(input, store);
  if (base.kind !== "receipt") return base;
  const share = await readCreditReleaseCaptureShare(input.paymentIntentId, store);
  if (share.held) return { kind: "credit-release-sweep" };
  if (share.ownCents <= 0) return base;
  const capture = await store.paymentTransaction.findUnique({
    where: { stripePaymentIntentId: input.paymentIntentId },
    select: { amountCents: true },
  });
  const alreadyRecordedCents = base.alreadyRecordedCents + share.ownCents;
  if (alreadyRecordedCents >= (capture?.amountCents ?? 0)) return { kind: "credit-release-sweep" };
  return { ...base, alreadyRecordedCents };
}

async function readBaseCaptureRecorder(
  input: {
    bookingId: string;
    primaryInvoiceId: string;
    paymentIntentId: string;
    bookingModificationId: string | null;
  },
  store: RecorderStore = prisma,
): Promise<CaptureRecorder> {
  // Round 4 (item 4): a supplementary invoice naming the intent first. Round 5
  // (item 1): it records the capture only where it records a payment; one
  // raised UNPAID naming the intent (the repair tool's invoice for a priced
  // edit, say) bills the capture's money and is the receipt's target instead.
  const naming = await store.xeroSyncOperation.findFirst({
    where: {
      queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
      status: { not: "CANCELLED" },
      requestPayload: { path: ["paymentIntentId"], equals: input.paymentIntentId },
    },
    orderBy: { createdAt: "desc" },
    select: { ...SUPPLEMENTARY_SELECT, localModel: true, localId: true },
  });
  if (naming && recordsPayment(naming.requestPayload)) return { kind: "supplementary-invoice", operationId: naming.id };
  // #4324: the kept-capture invoice queued for it - its payload names the intent.
  const kept = await store.xeroSyncOperation.findFirst({
    where: {
      ...LIVE_KEPT_LATE_CAPTURE_INVOICE_WHERE,
      requestPayload: { path: ["paymentIntentId"], equals: input.paymentIntentId },
    },
    select: { id: true },
  });
  if (kept) return { kind: "kept-late-capture-invoice", operationId: kept.id };

  const figures = await readPrimaryInvoiceFeeAtLink(input.bookingId, input.primaryInvoiceId, store);
  const recorded = await readRecordedByPrimaryOrGap(input.paymentIntentId, figures?.atLink, store);
  if (recorded.kind === "primary-invoice") return { kind: "primary-invoice" };
  if (recorded.kind === "gap-invoice") return { kind: "supplementary-invoice", operationId: recorded.operationId };
  const alreadyRecordedCents = recorded.cents;
  if (naming) {
    const { localModel, localId, ...operation } = naming;
    const link =
      localModel && localId
        ? await store.xeroObjectLink.findFirst({
            where: { localModel, localId, xeroObjectType: "INVOICE", role: "SUPPLEMENTARY_INVOICE", active: true },
            select: { id: true, xeroObjectId: true, active: true },
          })
        : null;
    return {
      kind: "receipt",
      figures,
      gap: figures ? await findPrimaryInvoiceGapInvoice(input.bookingId, figures, store) : null,
      target: { kind: "CHANGE_INVOICE", operation, link },
      alreadyRecordedCents,
    };
  }
  const gap = figures ? await findPrimaryInvoiceGapInvoice(input.bookingId, figures, store) : null;
  const modificationId = input.bookingModificationId;
  if (gap && modificationId && gap.anchorIds.includes(modificationId)) {
    return {
      kind: "receipt",
      figures,
      gap,
      target: { kind: "GAP_INVOICE", operation: gap.operation, link: gap.link },
      alreadyRecordedCents,
    };
  }
  if (modificationId) {
    // A change the gap does not bill for raised its own invoice, if any. One
    // that records a payment (or a link with no row to say) is the capture's
    // recorder; one raised UNPAID bills the change and the receipt records the
    // capture against it (round 3, F1), never a second document.
    const [own, ownLink] = await Promise.all([
      store.xeroSyncOperation.findFirst({
        where: {
          queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
          localModel: "BookingModification",
          localId: modificationId,
          status: { not: "CANCELLED" },
        },
        orderBy: { createdAt: "desc" },
        select: SUPPLEMENTARY_SELECT,
      }),
      store.xeroObjectLink.findFirst({
        where: {
          localModel: "BookingModification",
          localId: modificationId,
          xeroObjectType: "INVOICE",
          role: "SUPPLEMENTARY_INVOICE",
          active: true,
        },
        select: { id: true, xeroObjectId: true, active: true },
      }),
    ]);
    if (own && !recordsPayment(own.requestPayload)) {
      return {
        kind: "receipt",
        figures,
        gap,
        target: { kind: "CHANGE_INVOICE", operation: own, link: ownLink },
        alreadyRecordedCents,
      };
    }
    // Review 2 (F3): a paid one naming another capture records that one; its link is that invoice's.
    if (own ? changeInvoiceRecordsCapture(own.requestPayload, input.paymentIntentId) : ownLink) {
      return { kind: "supplementary-invoice", operationId: own?.id ?? null };
    }
  }
  return { kind: "receipt", figures, gap, target: null, alreadyRecordedCents };
}

/**
 * #4494 (`INV-SSOT`): WHAT OF ONE CAPTURE THE PRIMARY'S AND THE GAP INVOICE'S
 * PAYMENTS ALREADY RECORDED - the one reading the receipt's recorder and the
 * credit-release sweep's overlap hold share. `primary-invoice`: the primary's
 * create covered it wholly at the link. `gap-invoice`: a gap invoice in any
 * status but CANCELLED names it with no cents figure (a legacy row), or its
 * cents and the part the primary's payment reached together make the whole
 * capture. Otherwise `part`: those two cents, maybe 0. GROSS, round 4 (item 3):
 * against the capture as it was captured - a refund is its own note - so the
 * stand-down and the remainder read the one figure.
 *
 * WHY THE TWO CALLERS ASK DIFFERENT THINGS OF A QUEUED GAP ROW (#4494 fix
 * round). The receipt counts a gap row's cents whatever its status: that row
 * will pay them when it sends, so the receipt records only the rest. The sweep
 * must also know whether those cents can be in Xero YET, and whether the row
 * can still send (`withGapSendState`: `gapSend`, {@link gapPaymentMayBeInXero},
 * {@link gapRowCanStillSend}), because a gap that has not sent is re-checked at
 * its send and raised unpaid there - the sweep waits for it while it can.
 */
/** `rerunnable`: it can still run again (only the wait bound has passed), which decides what an officer is told. */
export type GapSendState = { operationId: string; mayBeInXero: boolean; canStillSend: boolean; rerunnable: boolean };
export type RecordedByPrimaryOrGap =
  | { kind: "primary-invoice" }
  | { kind: "gap-invoice"; operationId: string; gapSend?: GapSendState }
  | { kind: "part"; cents: number; gapSend?: GapSendState };

/**
 * #4494 fix round: WHETHER A GAP INVOICE'S OWN STRIPE PAYMENT CAN BE IN XERO.
 * Yes for a row that SUCCEEDED, went PARTIAL (a payment call that errored may
 * still have landed) or was resolved by hand, and for any row with evidence an
 * attempt reached Xero: a Xero id on the row, a response naming an invoice or
 * carrying a payment, a stale-RUNNING reset (it died mid-call), a live
 * `SUPPLEMENTARY_INVOICE` or `SUPPLEMENTARY_INVOICE_PAYMENT` link on its change,
 * or (delta review d-1) the Xero invoice body a send stores on the row before
 * any Xero call (`requestPayload.invoices`; the enqueued payload never has
 * one) - so a payment that landed before its completion failed still counts.
 * No only for a row that provably never reached Xero. The one rule the sweep's
 * hold and every send-time rewrite of a gap row use.
 */
export async function gapPaymentMayBeInXero(
  row: {
    status: string;
    requestPayload: Prisma.JsonValue | null;
    xeroObjectId: string | null;
    responsePayload: Prisma.JsonValue | null;
    lastErrorCode: string | null;
    manuallyResolvedAt: Date | null;
    localModel: string | null;
    localId: string | null;
  },
  store: Pick<Prisma.TransactionClient, "xeroObjectLink"> = prisma,
): Promise<boolean> {
  if (row.status === "SUCCEEDED" || row.status === "PARTIAL" || row.manuallyResolvedAt) return true;
  if (row.xeroObjectId || row.lastErrorCode === XERO_ORPHANED_STALE_RUNNING_ERROR_CODE) return true;
  if (responseNamesXeroInvoice(row.responsePayload) || asRecord(asRecord(row.responsePayload)?.payment)) return true;
  if (asRecord(row.requestPayload)?.invoices !== undefined) return true;
  if (!row.localModel || !row.localId) return false;
  const link = await store.xeroObjectLink.findFirst({
    where: {
      localModel: row.localModel,
      localId: row.localId,
      role: { in: ["SUPPLEMENTARY_INVOICE", "SUPPLEMENTARY_INVOICE_PAYMENT"] },
      active: true,
    },
    select: { id: true },
  });
  return link !== null;
}

/**
 * #4494 delta review (d-3): how long the sweep waits, silently, for a gap
 * invoice that has not sent, counted from when it was queued. Past it - or
 * once the row can no longer send (resolved by hand, marked non-replayable) -
 * the sweep holds and tells an officer, naming the row.
 */
export const GAP_SEND_WAIT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether an unsent gap invoice can still send: it can run again
 * (`isRerunnableOperation`, the outbox's own rule) and was queued within
 * {@link GAP_SEND_WAIT_MS} - the bound is the only gap-specific part. Pure.
 */
export function gapRowCanStillSend(
  row: { status: string; replayable: boolean; manuallyResolvedAt: Date | null; createdAt: Date },
  now: Date,
): boolean {
  return isRerunnableOperation(row) && now.getTime() - row.createdAt.getTime() <= GAP_SEND_WAIT_MS;
}

/** The row fields {@link gapPaymentMayBeInXero} and {@link gapRowCanStillSend} read. */
export const GAP_SEND_STATE_SELECT = {
  status: true,
  requestPayload: true,
  replayable: true,
  createdAt: true,
  xeroObjectId: true,
  responsePayload: true,
  lastErrorCode: true,
  manuallyResolvedAt: true,
  localModel: true,
  localId: true,
} as const;

export async function readRecordedByPrimaryOrGap(
  paymentIntentId: string,
  atLink: PrimaryInvoiceFeeAtLink | null | undefined,
  store: Pick<RecorderStore, "xeroSyncOperation" | "paymentTransaction" | "xeroObjectLink"> = prisma,
  options: { withGapSendState?: { now: Date } } = {},
): Promise<RecordedByPrimaryOrGap> {
  if (atLink?.paymentIntentIdsRecordedAtLink?.includes(paymentIntentId)) return { kind: "primary-invoice" };
  const partial = atLink?.partiallyRecordedCaptureAtLink;
  const primaryPartCents = partial?.paymentIntentId === paymentIntentId ? partial.cents : 0;
  const covering = await store.xeroSyncOperation.findFirst({
    where: {
      queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
      status: { not: "CANCELLED" },
      requestPayload: { path: [GAP_COVERED_INTENTS_KEY], array_contains: [paymentIntentId] },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      requestPayload: true,
      ...(options.withGapSendState ? GAP_SEND_STATE_SELECT : {}),
    },
  });
  if (!covering) return { kind: "part", cents: primaryPartCents };
  let sendState: { gapSend?: GapSendState } = {};
  if (options.withGapSendState) {
    const row = covering as typeof covering & Parameters<typeof gapPaymentMayBeInXero>[0] & Parameters<typeof gapRowCanStillSend>[0];
    sendState = {
      gapSend: {
        operationId: covering.id,
        mayBeInXero: await gapPaymentMayBeInXero(row, store),
        canStillSend: gapRowCanStillSend(row, options.withGapSendState.now),
        rerunnable: isRerunnableOperation(row),
      },
    };
  }
  const covered = asRecord(asRecord(covering.requestPayload)?.[GAP_COVERED_CENTS_KEY])?.[paymentIntentId];
  if (typeof covered !== "number") return { kind: "gap-invoice", operationId: covering.id, ...sendState };
  const capture = await store.paymentTransaction.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
    select: { amountCents: true },
  });
  if (covered + primaryPartCents >= (capture?.amountCents ?? 0)) return { kind: "gap-invoice", operationId: covering.id, ...sendState };
  return { kind: "part", cents: covered + primaryPartCents, ...sendState };
}


/**
 * #4494 (`INV-ADDPAY-046`, `INV-PAY-139`): whether the credit-release sweep's
 * share of a capture, beside what the primary's or the gap invoice's payment
 * recorded of it ({@link readRecordedByPrimaryOrGap}), would record more than
 * the card took. A capture the sweep holds overlaps anything recorded of it;
 * one with no share overlaps nothing. Pure.
 */
export function creditReleaseShareOverlaps(
  recorded: RecordedByPrimaryOrGap,
  share: CreditReleaseCaptureShare,
  amountCents: number,
): boolean {
  if (!share.held && share.ownCents <= 0) return false;
  if (recorded.kind !== "part") return true;
  if (share.held) return recorded.cents > 0;
  return recorded.cents + share.ownCents > amountCents;
}

/**
 * Review round 3 (F3): the captures a supplementary invoice records - one
 * naming the intent, or the change's own invoice that records a payment - so
 * the gap invoice never counts their cash as spare. The gap invoice itself is
 * not one (it is being decided).
 */
export async function readSupplementaryRecordedIntents(
  bookingId: string,
  captures: ReadonlyArray<{ paymentIntentId: string; bookingModificationId: string | null }>,
  store: Pick<Prisma.TransactionClient, "xeroSyncOperation"> = prisma,
): Promise<Set<string>> {
  const rows = await store.xeroSyncOperation.findMany({
    where: {
      queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
      status: { not: "CANCELLED" },
      requestPayload: { path: ["bookingId"], equals: bookingId },
    },
    select: { localModel: true, localId: true, requestPayload: true },
  });
  const named = new Set<string>();
  const changeInvoices = new Map<string, Prisma.JsonValue[]>();
  for (const row of rows) {
    const payload = asRecord(row.requestPayload);
    if (payload?.primaryInvoiceGap === true) continue;
    if (typeof payload?.paymentIntentId === "string" && recordsPayment(row.requestPayload)) named.add(payload.paymentIntentId);
    if (row.localModel === "BookingModification" && row.localId) {
      changeInvoices.set(row.localId, [...(changeInvoices.get(row.localId) ?? []), row.requestPayload]);
    }
  }
  // Review 2 (F3): the change's own invoice counts for a capture only where it records that capture.
  const recordedByChangeInvoice = (capture: { paymentIntentId: string; bookingModificationId: string | null }) =>
    capture.bookingModificationId !== null &&
    (changeInvoices.get(capture.bookingModificationId) ?? []).some((payload) =>
      changeInvoiceRecordsCapture(payload, capture.paymentIntentId),
    );
  return new Set(
    captures
      .filter((capture) => named.has(capture.paymentIntentId) || recordedByChangeInvoice(capture))
      .map((capture) => capture.paymentIntentId),
  );
}

/**
 * The captures whose cash a receipt row has claimed (any status but
 * CANCELLED): the gap invoice never pays itself from those.
 */
export async function readReceiptClaimedIntents(
  bookingId: string,
  store: Pick<Prisma.TransactionClient, "xeroSyncOperation"> = prisma,
): Promise<Set<string>> {
  const rows = await store.xeroSyncOperation.findMany({
    where: {
      queueType: XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
      status: { not: "CANCELLED" },
      requestPayload: { path: ["bookingId"], equals: bookingId },
    },
    select: { requestPayload: true },
  });
  return new Set(
    rows.flatMap((row) => {
      const id = asRecord(row.requestPayload)?.paymentIntentId;
      return typeof id === "string" ? [id] : [];
    }),
  );
}

/**
 * The booking's captured Stripe cash, by intent, oldest first: what
 * `attributeGapCash` walks. #4494: each with the cents of it that are the
 * credit-release sweep's (`sweptCents`, read through
 * `readCreditReleaseCaptureShare`, all of it where the sweep holds it).
 */
export async function readCapturedStripeCash(
  bookingId: string,
  store: Pick<Prisma.TransactionClient, "paymentTransaction"> = prisma,
): Promise<Array<{ paymentIntentId: string; netCents: number; sweptCents: number; bookingModificationId: string | null }>> {
  const rows = await store.paymentTransaction.findMany({
    where: {
      payment: { bookingId },
      source: "STRIPE",
      status: { in: [...CAPTURED_TRANSACTION_STATUS_LIST] },
      stripePaymentIntentId: { not: null },
    },
    orderBy: [...LEDGER_ROWS_OLDEST_FIRST],
    select: { stripePaymentIntentId: true, amountCents: true, refundedAmountCents: true, bookingModificationId: true },
  });
  const captures = [];
  for (const row of rows) {
    if (!row.stripePaymentIntentId) continue;
    const netCents = Math.max(0, row.amountCents - row.refundedAmountCents);
    const share = await readCreditReleaseCaptureShare(row.stripePaymentIntentId, store);
    captures.push({
      paymentIntentId: row.stripePaymentIntentId,
      netCents,
      sweptCents: creditReleaseSweptCents(share, netCents),
      bookingModificationId: row.bookingModificationId,
    });
  }
  return captures;
}

/**
 * WHICH CASH THE GAP INVOICE MAY PAY ITSELF FROM, AND WHOSE IT IS. Pure.
 *
 * Each capture's net cash, less the credit-release sweep's share of it
 * (#4494: `sweptCents`, taken out first, so neither the primary's walk nor the
 * gap ever counts it), less what the primary recorded of it, and less every
 * capture another writer claims (a receipt row, or a supplementary invoice
 * that records it), is the leftover. What the primary recorded is the
 * record its link stored (review round 3, F4: `recordedAtLink`, the captures it
 * covered wholly and the part of one it reached); only a record from before
 * that list is walked from `primaryCashCents`, oldest first. The gap takes its
 * whole figure from the leftover, oldest first, or nothing; the captures it
 * takes from are named, with the cents, so their receipts stand down or
 * record only the rest.
 */
export function attributeGapCash(input: {
  captures: ReadonlyArray<{ paymentIntentId: string; netCents: number; sweptCents: number }>;
  claimed: ReadonlySet<string>;
  primaryCashCents: number;
  recordedAtLink?: { recorded: readonly string[]; partial: { paymentIntentId: string; cents: number } | null };
  gapCents: number;
}): { leftoverCents: number; covered: Array<{ paymentIntentId: string; cents: number }> } {
  let primaryLeft = Math.max(0, input.primaryCashCents);
  const recordedAtLink = input.recordedAtLink;
  const leftover: Array<{ paymentIntentId: string; cents: number }> = [];
  for (const capture of input.captures) {
    const available = Math.max(0, capture.netCents - capture.sweptCents);
    let toPrimary: number;
    if (recordedAtLink) {
      toPrimary = recordedAtLink.recorded.includes(capture.paymentIntentId)
        ? available
        : recordedAtLink.partial?.paymentIntentId === capture.paymentIntentId
          ? Math.min(available, recordedAtLink.partial.cents)
          : 0;
    } else {
      toPrimary = Math.min(primaryLeft, available);
      primaryLeft -= toPrimary;
    }
    const rest = available - toPrimary;
    if (rest > 0 && !input.claimed.has(capture.paymentIntentId)) {
      leftover.push({ paymentIntentId: capture.paymentIntentId, cents: rest });
    }
  }
  const leftoverCents = leftover.reduce((sum, entry) => sum + entry.cents, 0);
  if (input.gapCents <= 0 || leftoverCents < input.gapCents) return { leftoverCents, covered: [] };
  const covered: Array<{ paymentIntentId: string; cents: number }> = [];
  let need = input.gapCents;
  for (const entry of leftover) {
    if (need <= 0) break;
    const cents = Math.min(need, entry.cents);
    covered.push({ paymentIntentId: entry.paymentIntentId, cents });
    need -= cents;
  }
  return { leftoverCents, covered };
}
