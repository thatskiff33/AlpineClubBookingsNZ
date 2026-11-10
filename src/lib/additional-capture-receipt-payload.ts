/**
 * #3953 (`INV-PAY-139`): the queued payload of the operation that records a
 * booking change's card capture against the Xero invoice that bills it, when
 * no supplementary invoice was waiting on that capture. A leaf - it imports
 * nothing of the outbox - so the outbox's payload parser and the worker
 * (`additional-capture-xero-receipt.ts`) read one shape (`INV-SSOT`).
 */
import { asRecord, readNumber, readString } from "@/lib/xero-json";

export const XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE = "ADDITIONAL_CAPTURE_RECEIPT";

/** Which invoice the capture is recorded against. */
export type AdditionalCaptureReceiptTarget = "GAP_INVOICE" | "CHANGE_INVOICE" | "PRIMARY_INVOICE";

/** One invoice's share of the capture. The top-level plan fields are always this list's first leg. */
export interface AdditionalCaptureReceiptLeg {
  target: AdditionalCaptureReceiptTarget;
  invoiceId: string;
  amountCents: number;
}

/**
 * The payments the worker decided to write, stored on the row BEFORE it calls
 * Xero. A retry re-uses them as they stand - the same invoices, amounts, date
 * and Xero keys - and never decides again. The top-level fields copy the first
 * leg, so a previous release that does not know about `legs` still sends that
 * leg and only that leg. A row stored before legs existed has no `legs` field:
 * it is one leg, the top-level fields.
 */
export interface AdditionalCaptureReceiptPlan {
  target: AdditionalCaptureReceiptTarget;
  invoiceId: string;
  amountCents: number;
  /** The capture's cents this receipt records; more than the legs' sum when some is left for an officer. */
  capturedCents: number;
  /** `YYYY-MM-DD`, the club day of the payment. */
  date: string;
  /** Every invoice this receipt pays, in order. Always present once the payload has been read. */
  legs: AdditionalCaptureReceiptLeg[];
  /**
   * The invoices the decision was taken against, in order, including one this
   * receipt did not need because an earlier invoice had room. Absent on a
   * legacy row: that row's one invoice is `invoiceId`.
   */
  targetInvoiceIds?: string[];
}

export interface QueuedAdditionalCaptureReceiptOutboxPayload {
  queueType: typeof XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE;
  bookingId: string;
  paymentId: string;
  paymentTransactionId: string;
  paymentIntentId: string;
  plan?: AdditionalCaptureReceiptPlan;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function readTarget(value: unknown): AdditionalCaptureReceiptTarget | null {
  return value === "GAP_INVOICE" || value === "CHANGE_INVOICE" || value === "PRIMARY_INVOICE" ? value : null;
}

function readLeg(value: unknown): AdditionalCaptureReceiptLeg | null {
  const leg = asRecord(value);
  if (!leg) return null;
  const target = readTarget(leg.target);
  const invoiceId = readString(leg.invoiceId);
  const amountCents = readNumber(leg.amountCents);
  if (!target || !invoiceId || amountCents === null || !Number.isInteger(amountCents) || amountCents <= 0) return null;
  return { target, invoiceId, amountCents };
}

/**
 * The plan, or null when it cannot be trusted. A legacy plan with no `legs`
 * is one leg. A plan whose legs repeat an invoice, sum to more than the
 * capture, or disagree with the top-level copy of the first leg is unreadable:
 * a retry must not invent a second reading.
 */
function readPlan(value: unknown): AdditionalCaptureReceiptPlan | null {
  const plan = asRecord(value);
  if (!plan) return null;
  const target = readTarget(plan.target);
  const invoiceId = readString(plan.invoiceId);
  const amountCents = readNumber(plan.amountCents);
  const capturedCents = readNumber(plan.capturedCents);
  const date = readString(plan.date);
  if (
    !target ||
    !invoiceId ||
    amountCents === null ||
    !Number.isInteger(amountCents) ||
    amountCents <= 0 ||
    capturedCents === null ||
    !Number.isInteger(capturedCents) ||
    capturedCents < amountCents ||
    !date ||
    !DATE_PATTERN.test(date)
  ) {
    return null;
  }
  let legs: AdditionalCaptureReceiptLeg[];
  if (plan.legs === undefined) {
    legs = [{ target, invoiceId, amountCents }];
  } else if (!Array.isArray(plan.legs) || plan.legs.length === 0) {
    return null;
  } else {
    const parsed: AdditionalCaptureReceiptLeg[] = [];
    const seen = new Set<string>();
    for (const raw of plan.legs) {
      const leg = readLeg(raw);
      if (!leg || seen.has(leg.invoiceId)) return null;
      seen.add(leg.invoiceId);
      parsed.push(leg);
    }
    const sum = parsed.reduce((total, leg) => total + leg.amountCents, 0);
    const first = parsed[0];
    if (!first || sum > capturedCents || first.target !== target || first.invoiceId !== invoiceId || first.amountCents !== amountCents) {
      return null;
    }
    legs = parsed;
  }
  if (plan.targetInvoiceIds === undefined) return { target, invoiceId, amountCents, capturedCents, date, legs };
  if (!Array.isArray(plan.targetInvoiceIds) || plan.targetInvoiceIds.some((id) => typeof id !== "string" || id.length === 0)) return null;
  const targetInvoiceIds = plan.targetInvoiceIds as string[];
  if (new Set(targetInvoiceIds).size !== targetInvoiceIds.length) return null;
  let from = 0;
  for (const leg of legs) {
    const at = targetInvoiceIds.indexOf(leg.invoiceId, from);
    if (at < 0) return null;
    from = at + 1;
  }
  return { target, invoiceId, amountCents, capturedCents, date, legs, targetInvoiceIds };
}

/** What of a stored plan no invoice could take. */
export function receiptUnrecordedCents(plan: AdditionalCaptureReceiptPlan): number {
  const recorded = plan.legs.reduce((total, leg) => total + leg.amountCents, 0);
  return Math.max(0, plan.capturedCents - recorded);
}

/**
 * A receipt that decided on more than one invoice and has not linked them all.
 * The repair tool's dry run says so, including a crash between the payments.
 * Null when there is nothing to show.
 */
export function splitReceiptLegsSummary(plan: AdditionalCaptureReceiptPlan | null, linkedCount: number): string | null {
  if (!plan || plan.legs.length < 2 || linkedCount >= plan.legs.length) return null;
  return `receipt planned ${plan.legs.length} legs, ${linkedCount} linked`;
}

/**
 * The payload, or null when it is not a readable one. A stored plan that does
 * not parse makes the whole payload unreadable rather than silently dropping
 * it: a dropped plan would let a retry decide again.
 */
export function readAdditionalCaptureReceiptPayload(
  value: unknown,
): QueuedAdditionalCaptureReceiptOutboxPayload | null {
  const payload = asRecord(value);
  if (!payload || payload.queueType !== XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE) return null;
  const bookingId = readString(payload.bookingId);
  const paymentId = readString(payload.paymentId);
  const paymentTransactionId = readString(payload.paymentTransactionId);
  const paymentIntentId = readString(payload.paymentIntentId);
  if (!bookingId || !paymentId || !paymentTransactionId || !paymentIntentId) return null;
  const base = {
    queueType: XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
    bookingId,
    paymentId,
    paymentTransactionId,
    paymentIntentId,
  } as const;
  if (payload.plan === undefined || payload.plan === null) return base;
  const plan = readPlan(payload.plan);
  return plan ? { ...base, plan } : null;
}

/**
 * #3953 review round 1: the #3980 gap invoice's queued payload names itself,
 * and the captures its own Stripe payment takes (`attributeGapCash`), so each
 * of those captures has one recorder. The supplementary handler keeps its
 * queued payload when it sends, so the names survive the send.
 */
export const GAP_COVERED_INTENTS_KEY = "coveredPaymentIntentIds";
export const GAP_COVERED_CENTS_KEY = "coveredCaptureCents";

export function primaryInvoiceGapPayload(
  gap: { coveredCaptures: ReadonlyArray<{ paymentIntentId: string; cents: number }> } | undefined,
): Record<string, unknown> {
  if (!gap) return {};
  return {
    primaryInvoiceGap: true,
    [GAP_COVERED_INTENTS_KEY]: gap.coveredCaptures.map((capture) => capture.paymentIntentId),
    [GAP_COVERED_CENTS_KEY]: Object.fromEntries(gap.coveredCaptures.map((capture) => [capture.paymentIntentId, capture.cents])),
  };
}

/**
 * #4494 (`INV-ADDPAY-046`): a gap invoice's queued payload turned unpaid at
 * its send, because a capture it would pay from overlaps the credit-release
 * sweep's share. Where its payment provably never reached Xero it names no
 * capture, as the enqueue writes an unpaid one. Where an earlier attempt's
 * payment may be in Xero (`keepCoverage`) it keeps the captures it named, so
 * the sweep's overlap hold still sees them and never records on top.
 */
export function unpaidPrimaryInvoiceGapPayload(
  payload: Record<string, unknown>,
  options: { keepCoverage: boolean },
): Record<string, unknown> {
  return {
    ...payload,
    recordPayment: false,
    ...(options.keepCoverage ? {} : primaryInvoiceGapPayload({ coveredCaptures: [] })),
  };
}
