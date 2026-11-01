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
 *    and names the captures that cash came from on its own queued payload
 *    (`coveredPaymentIntentIds`, {@link attributeGapCash}).
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
import { readCreditReleaseCaptureShare } from "@/lib/credit-release-capture-share";
import { LIVE_KEPT_LATE_CAPTURE_INVOICE_WHERE } from "@/lib/late-capture-kept-xero-rules";
import { prisma } from "@/lib/prisma";
import { asRecord } from "@/lib/xero-json";
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
  if (figures?.atLink.paymentIntentIdsRecordedAtLink?.includes(input.paymentIntentId)) {
    return { kind: "primary-invoice" };
  }
  const partial = figures?.atLink.partiallyRecordedCaptureAtLink;
  const primaryPartCents = partial?.paymentIntentId === input.paymentIntentId ? partial.cents : 0;

  // Then a gap invoice whose payment took some of it (F2). GROSS, round 4
  // (item 3): what the gap and the primary took, against the capture as it
  // was captured - the receipt records the gross rest, and a refund is its
  // own note - so the stand-down and the remainder read the one figure.
  let gapCoveredCents = 0;
  const covering = await store.xeroSyncOperation.findFirst({
    where: {
      queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
      status: { not: "CANCELLED" },
      requestPayload: { path: [GAP_COVERED_INTENTS_KEY], array_contains: [input.paymentIntentId] },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, requestPayload: true },
  });
  if (covering) {
    const covered = asRecord(asRecord(covering.requestPayload)?.[GAP_COVERED_CENTS_KEY])?.[input.paymentIntentId];
    if (typeof covered !== "number") return { kind: "supplementary-invoice", operationId: covering.id };
    const capture = await store.paymentTransaction.findUnique({
      where: { stripePaymentIntentId: input.paymentIntentId },
      select: { amountCents: true },
    });
    if (covered + primaryPartCents >= (capture?.amountCents ?? 0)) {
      return { kind: "supplementary-invoice", operationId: covering.id };
    }
    gapCoveredCents = covered;
  }
  const alreadyRecordedCents = gapCoveredCents + primaryPartCents;
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

/** The booking's captured Stripe cash, by intent, oldest first: what `attributeGapCash` walks. */
export async function readCapturedStripeCash(
  bookingId: string,
  store: Pick<Prisma.TransactionClient, "paymentTransaction"> = prisma,
): Promise<Array<{ paymentIntentId: string; netCents: number; bookingModificationId: string | null }>> {
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
  return rows.flatMap((row) =>
    row.stripePaymentIntentId
      ? [
          {
            paymentIntentId: row.stripePaymentIntentId,
            netCents: Math.max(0, row.amountCents - row.refundedAmountCents),
            bookingModificationId: row.bookingModificationId,
          },
        ]
      : [],
  );
}

/**
 * WHICH CASH THE GAP INVOICE MAY PAY ITSELF FROM, AND WHOSE IT IS. Pure.
 *
 * Each capture's net cash, less what the primary recorded of it, and less
 * every capture another writer claims (a receipt row, or a supplementary
 * invoice that records it), is the leftover. What the primary recorded is the
 * record its link stored (review round 3, F4: `recordedAtLink`, the captures it
 * covered wholly and the part of one it reached); only a record from before
 * that list is walked from `primaryCashCents`, oldest first. The gap takes its
 * whole figure from the leftover, oldest first, or nothing; the captures it
 * takes from are named, with the cents, so their receipts stand down or
 * record only the rest.
 */
export function attributeGapCash(input: {
  captures: ReadonlyArray<{ paymentIntentId: string; netCents: number }>;
  claimed: ReadonlySet<string>;
  primaryCashCents: number;
  recordedAtLink?: { recorded: readonly string[]; partial: { paymentIntentId: string; cents: number } | null };
  gapCents: number;
}): { leftoverCents: number; covered: Array<{ paymentIntentId: string; cents: number }> } {
  let primaryLeft = Math.max(0, input.primaryCashCents);
  const recordedAtLink = input.recordedAtLink;
  const leftover: Array<{ paymentIntentId: string; cents: number }> = [];
  for (const capture of input.captures) {
    let toPrimary: number;
    if (recordedAtLink) {
      toPrimary = recordedAtLink.recorded.includes(capture.paymentIntentId)
        ? capture.netCents
        : recordedAtLink.partial?.paymentIntentId === capture.paymentIntentId
          ? Math.min(capture.netCents, recordedAtLink.partial.cents)
          : 0;
    } else {
      toPrimary = Math.min(primaryLeft, capture.netCents);
      primaryLeft -= toPrimary;
    }
    const rest = capture.netCents - toPrimary;
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
