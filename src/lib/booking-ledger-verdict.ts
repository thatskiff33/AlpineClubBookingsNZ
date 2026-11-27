/**
 * What a booking ledger residual MEANS (`INV-PAY-047`), and the Xero billing
 * evidence that tells an Internet Banking residual billed on a Xero invoice
 * from one nothing is asking for (#5288). The identity itself - its terms, the
 * residual, the census SQL - is `additional-payment-ask.ts`'s; that module
 * folds `bookingBilledInXeroSql` below into its census.
 *
 * Pure: no client, no logger, no `server-only`.
 */
import type { XeroSyncOperation } from "@prisma/client";

import { INTERNET_BANKING_PAYMENT_SOURCE } from "@/lib/booking-payment-state";

/**
 * #5288: what the census reads to tell an Internet Banking residual billed in
 * Xero from one nothing is asking for. An Internet Banking increase is never a
 * card ask, so it is not in the identity's ask term: it is billed on the
 * booking's primary invoice or an edit's supplementary invoice, and collected
 * when Xero reconciles the transfer.
 */
export interface BookingXeroBillingFacts {
  /** `Payment.source`. */
  paymentSource: string;
  /** `Payment.xeroInvoiceId`: the primary invoice's link. */
  xeroInvoiceId: string | null;
  /** An active link to one of the {@link BOOKING_XERO_BILLING_INVOICES}. */
  activeInvoiceLink: boolean;
  /** A create of one of them still PENDING or RUNNING ({@link BOOKING_XERO_BILLING_QUEUED_STATUSES}). */
  queuedInvoiceCreate: boolean;
}

/**
 * The invoices that bill an Internet Banking booking, by where each is anchored:
 * the primary on the payment, a supplementary on the edit it bills. The typed
 * census's reads (`loadBookingLedgerCensus`) and the SQL twin below both take
 * them from here.
 */
export const BOOKING_XERO_BILLING_INVOICES = [
  { localModel: "Payment", role: "PRIMARY_INVOICE" },
  { localModel: "BookingModification", role: "SUPPLEMENTARY_INVOICE" },
] as const;

/**
 * An invoice create in these states is still going out; a FAILED one is not
 * evidence. Narrower than `XERO_ACTIVE_OPERATION_STATUSES` by `WAITING_PAYMENT`,
 * which only a card capture releases and so never bills a bank transfer.
 */
export const BOOKING_XERO_BILLING_QUEUED_STATUSES = ["PENDING", "RUNNING"] as const satisfies readonly XeroSyncOperation["status"][];

/** The SQL of one billing invoice's local id, over the census aliases `b` and `p`. */
function billingInvoiceLocalIdSql(localModel: (typeof BOOKING_XERO_BILLING_INVOICES)[number]["localModel"], column: string): string {
  return localModel === "Payment"
    ? `${column} = p."id"`
    : `${column} IN (SELECT m."id" FROM "BookingModification" m WHERE m."bookingId" = b."id")`;
}

function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

/**
 * #5288: the evidence that a positive residual is billed in Xero, as signed
 * terms are for the identity: the TypeScript and SQL forms are both folded
 * from this list (`INV-SSOT-001`). Any one is enough.
 */
export const BOOKING_XERO_BILLING_EVIDENCE: readonly {
  label: string;
  ts: (facts: BookingXeroBillingFacts) => boolean;
  sql: string;
}[] = [
  {
    label: "the payment carries its primary invoice's id",
    ts: (facts) => facts.xeroInvoiceId !== null,
    sql: 'p."xeroInvoiceId" IS NOT NULL',
  },
  {
    label: "an active primary or supplementary invoice link",
    ts: (facts) => facts.activeInvoiceLink,
    sql: `EXISTS (SELECT 1 FROM "XeroObjectLink" l WHERE l."active" AND l."xeroObjectType" = 'INVOICE' AND (${BOOKING_XERO_BILLING_INVOICES.map(
      (invoice) => `(l."localModel" = '${invoice.localModel}' AND l."role" = '${invoice.role}' AND ${billingInvoiceLocalIdSql(invoice.localModel, 'l."localId"')})`,
    ).join(" OR ")}))`,
  },
  {
    label: "a primary or supplementary invoice create queued or running",
    ts: (facts) => facts.queuedInvoiceCreate,
    sql: `EXISTS (SELECT 1 FROM "XeroSyncOperation" o WHERE o."direction" = 'OUTBOUND' AND o."entityType" = 'INVOICE' AND o."operationType" = 'CREATE' AND o."status" IN (${sqlList(BOOKING_XERO_BILLING_QUEUED_STATUSES)}) AND (${BOOKING_XERO_BILLING_INVOICES.map(
      (invoice) => `(o."localModel" = '${invoice.localModel}' AND ${billingInvoiceLocalIdSql(invoice.localModel, 'o."localId"')})`,
    ).join(" OR ")}))`,
  },
];

/** #5288: an Internet Banking payment with any {@link BOOKING_XERO_BILLING_EVIDENCE}. */
export function bookingBilledInXero(facts: BookingXeroBillingFacts): boolean {
  return facts.paymentSource === INTERNET_BANKING_PAYMENT_SOURCE && BOOKING_XERO_BILLING_EVIDENCE.some((evidence) => evidence.ts(facts));
}

/** The SQL twin of {@link bookingBilledInXero}, over `b` and `p`. */
export function bookingBilledInXeroSql(): string {
  return `(p."source" = '${INTERNET_BANKING_PAYMENT_SOURCE}' AND (${BOOKING_XERO_BILLING_EVIDENCE.map((evidence) => evidence.sql).join(" OR ")}))`;
}

/**
 * What a residual MEANS, named once so the guard, the operator census and the
 * docs cannot describe the same number three different ways.
 *
 * - `balanced` - the books add up.
 * - `unasked` - **the #3340 class**: money the price says is owed that nothing is
 *   asking for. A guard failure, always.
 * - `billedInXero` - #5288: owed on an Internet Banking booking whose primary or
 *   supplementary invoice is linked or still going out
 *   (`bookingBilledInXero`). Asked, by the invoice, and collected when Xero
 *   reconciles the transfer; REPORTED under its own heading so an operator
 *   checks Xero before invoicing by hand.
 * - `retained` - the club holds more than the price. Expected after a
 *   policy-tiered reduction (`INV-MOD-011` keeps a slice) or a reduction settled
 *   as account credit, so it is REPORTED to an operator and never failed.
 */
export type BookingLedgerVerdict = "balanced" | "unasked" | "billedInXero" | "retained";

export function bookingLedgerVerdict(
  residualCents: number,
  billing: BookingXeroBillingFacts,
): BookingLedgerVerdict {
  if (residualCents === 0) return "balanced";
  if (residualCents < 0) return "retained";
  return bookingBilledInXero(billing) ? "billedInXero" : "unasked";
}
