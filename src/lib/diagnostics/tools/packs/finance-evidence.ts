/**
 * AI Diagnostics — AID-6C finance pack, part 3: THE AUTHORITATIVE BOOKING-FINANCE
 * CALCULATION (#2377, epic #2369).
 *
 * ONE `server_owned` evidence source, and the entry that reads it lives in
 * `finance-state.ts`. This module is the source itself.
 *
 * WHY THIS IS NOT A `select_only_sql` ENTRY, which is the question a reviewer
 * should ask first and which #2375 answers as a rule rather than a preference:
 * "Do not ask the model to infer finance state from raw rows where the
 * application already has authoritative services or stable reason codes. Reuse or
 * safely expose authoritative results." Every number and every classification
 * below already has exactly one definition in this codebase, and re-deriving any
 * of them in SQL would create a SECOND definition that can drift from the admin
 * screen a Finance Officer trusts:
 *
 *  - `deriveBookingAppliedCreditCents` (`member-credit.ts`) is the ledger truth of
 *    account credit applied to a booking. It is a signed aggregate over
 *    `MemberCredit` rows of type `BOOKING_APPLIED`, negated and floored at zero —
 *    NOT the denormalised `Payment."creditAppliedCents"` column. This module
 *    reports both, and their difference, precisely because they can disagree.
 *  - `getMemberCreditBalance` (`member-credit.ts`) is the one function every write
 *    path validates against before spending credit.
 *  - `hasCapturedPayment` and `getRemainingRefundableCents`
 *    (`booking-payment-state.ts`) decide whether money actually moved and how
 *    much of it can still be handed back. The refund-appeal review route uses the
 *    same two.
 *  - `getPaymentDisplayStatus` (`payment-status-display.ts`) is the label the
 *    admin screens render — "Paid", "Credit Issued + Card Refund", "Cancelled
 *    Before Payment". A diagnostic that invented its own vocabulary would send an
 *    operator looking for a state the UI never shows.
 *  - `deriveSettlementKind`, `deriveXeroState`, `buildXeroActivityByRecord` and
 *    `isXeroInvoiceExpectedPaymentStatus` (`admin-operational-state.ts`) are the
 *    stable classifications behind the `/admin/payments` filters, and this module
 *    calls all four with the SAME inputs the screen builds — the same
 *    `Payment:{id}` operation scope, and the same OR of
 *    `Payment."xeroInvoiceId"` with an active `PRIMARY_INVOICE`
 *    `XeroObjectLink`. A diagnostic answer and the screen the operator then
 *    opens have to agree about what "invoice missing" means, and an
 *    authoritative-consistency test asserts that agreement by running
 *    `listAdminPayments` over the same fixture row.
 *  - `isAdditionalPaymentOwed` (`additional-payment-chase.ts`) is the one
 *    definition of "an upward modification is still owing". It CONJOINS a
 *    booking-lifecycle half with the money half precisely so a cancelled booking
 *    is not dunned for a delta nothing zeroed, and this module reports its
 *    answer rather than a second reading of the two columns.
 *
 * A `server_owned` entry is NOT a way around the substrate's gates: registry
 * lookup, loop budget, fresh AND-ed authorization, `.strict()` argument parsing
 * with the reserved-key scan, the metering breaker, the fixed projection with
 * redaction and per-field caps, the row and byte ceilings, truncation honesty and
 * the approved-metadata audit row all apply identically. The only gate it skips is
 * the SELECT-only credential check, which does not govern it.
 *
 * WHAT THAT COSTS, STATED PLAINLY, because AID-6A's pack doc requires it of any
 * server-owned source. This one queries application tables on the application's
 * own FULL-PRIVILEGE Prisma connection, so unlike the SQL entries there is no
 * column grant behind it and the registry projection in `finance-state.ts` is the
 * ONLY boundary. Nothing leaks today — the row this source returns is built field
 * by field from named columns, and it never selects a note, a reason, a payload or
 * a person — but that makes every edit to this file or to that projection a
 * security-relevant change that needs the review a grant would get. Two specific
 * columns sit one `select` away and must never be added: `MemberCredit.description`
 * (free text, and it is READ here to classify the settlement — see
 * `readCancellationCredits` — but never returned) and
 * `Payment."manualPaymentNote"`.
 *
 * EIGHT RELATIONS ARE READ, all by named `select`: `Booking`, `Payment`,
 * `MemberCredit`, `XeroSyncOperation`, `XeroObjectLink`,
 * `PaymentRecoveryOperation`, `ManualRefundTask` and `RefundRequest`. The
 * `XeroObjectLink` read is made by the one invoice-evidence reader
 * (`xero-booking-invoice-evidence.ts`, #3001/#3467), handed this transaction
 * as its client, because "is there an invoice" is an OR every other surface
 * performs and the column alone is the wrong answer (see `readInvoiceLinked`).
 *
 * READ ONLY AT THE DATABASE SINCE #2786, NOT ONLY BY INSPECTION. Every call below
 * is a Prisma `findUnique`, `findMany` or `aggregate`, and every one of them now
 * runs inside the ONE read-only transaction the shared seam
 * (`../read-only-transaction.ts`) opens per invocation: PostgreSQL is told
 * `SET TRANSACTION READ ONLY` before the first data statement, so a write on this
 * path fails with SQLSTATE `25006` rather than depending on a reviewer noticing.
 * That matters more here than almost anywhere in the pack, because this module runs
 * on the application's own FULL-PRIVILEGE connection where nothing else would stop
 * one. There is no data write, no Stripe call, no Xero call and no HTTP request of
 * any kind. The two authoritative helpers that are async are read-only aggregates
 * over `MemberCredit`, and both are handed the transaction client.
 *
 * ONE SNAPSHOT, WHICH THIS SOURCE NEEDS MORE THAN IT LOOKS. The seam's transaction
 * is `REPEATABLE READ`, so every read below sees one instant. Before that, this
 * source read `Payment."creditAppliedCents"` and the `MemberCredit` ledger
 * aggregate as separate statements at separate instants, and reported their
 * difference as `credit_ledger_variance` — a stable, named blocker code. A credit
 * application landing between the two reads would have manufactured that finding
 * out of nothing, and the operator's next step is to go looking for a ledger
 * corruption that never happened. What remains, and what the entry discloses, is
 * that two INVOCATIONS see different instants.
 *
 * MONEY IS INTEGER CENTS THROUGHOUT. Every value here is an `Int` column or a sum
 * of them. There is no division, no fixed-point rounding, no floating-point
 * parsing and no currency formatting in this module — a contract test scans this
 * file's source for all four.
 */

import "server-only";

import type { Prisma } from "@prisma/client";

import {
  isAdditionalAmountUncollected,
  isAdditionalPaymentOwed,
} from "@/lib/additional-payment-chase";
import {
  buildXeroActivityByRecord,
  deriveSettlementKind,
  deriveXeroState,
  emptyXeroActivitySummary,
  isXeroInvoiceExpectedPaymentStatus,
  type XeroActivitySummary,
} from "@/lib/admin-operational-state";
import {
  getRemainingRefundableCents,
  hasCapturedPayment,
  isSettledBookingStatus,
} from "@/lib/booking-payment-state";
import { bookingOwner } from "@/lib/booking-owner";
import { formatBookingReference } from "@/lib/booking-reference";
import {
  deriveBookingAppliedCreditCents,
  getMemberCreditBalance,
} from "@/lib/member-credit";
import { getPaymentDisplayStatus } from "@/lib/payment-status-display";
import { readBookingInvoiceEvidence } from "@/lib/xero-booking-invoice-evidence";

import type { DiagnosticsToolRawRow } from "../define";
import { withBoundedReadOnlyTransaction } from "../read-only-transaction";
import { DIAGNOSTICS_TOOL_BOUNDS } from "../types";

/**
 * This source's OWN deadline, below the executor's outer race.
 *
 * The executor's `Promise.race` does not cancel the loser and nothing propagates
 * a cancellation into Prisma, so a source that can be slow has to bound its own
 * WORK. This one's fan-out is constant — six point reads and aggregates, all on
 * indexed columns, for exactly one booking — so the deadline is a backstop for a
 * database that has stopped answering rather than for a query that is doing too
 * much. It REFUSES rather than returning a partial row: a finance state assembled
 * from some of its inputs would be a fabricated answer, not an absent one, and
 * `evidence_unavailable` is the honest outcome.
 *
 * IT IS THE OUTERMOST OF THREE BOUNDS SINCE #2786, and the only one this file owns.
 * A `Promise.race` stops this process WAITING and cancels nothing — no cancellation
 * propagates into an in-flight Prisma statement — so on its own it left the eight
 * reads below still running against the database after the operator had already been
 * told the evidence was unavailable. The seam's transaction now carries a
 * PostgreSQL `statement_timeout` and an interactive-transaction ceiling that fire
 * whether or not anyone is still waiting, and both sit BELOW this deadline so the
 * database refuses first and the operator gets the specific `57014 query_canceled`
 * cause rather than a race.
 */
const BOOKING_FINANCE_DEADLINE_MS =
  DIAGNOSTICS_TOOL_BOUNDS.serverEvidenceDeadlineMs;

/**
 * The maximum attempts the payment-recovery cron makes before a `FAILED`
 * operation is terminal. Mirrors `MAX_PAYMENT_RECOVERY_ATTEMPTS` in
 * `payment-recovery-constants.ts`; kept as a local constant so this module does
 * not drag the recovery module's Stripe imports into the diagnostics graph, and
 * pinned by a test against the real constant so the two cannot drift.
 */
export const FINANCE_RECOVERY_ATTEMPT_CEILING = 5;

/**
 * The stable blocker codes this source can emit, in the PRIORITY ORDER an
 * operator should act on them.
 *
 * A closed, ordered, server-owned catalogue is what #2377 asks for in place of
 * asking a model to read a blocker out of raw columns. The order is the whole
 * point: several of these can be true at once, and telling a Finance Officer that
 * "the Xero invoice is missing" when the real problem is that a refund the
 * platform owes has exhausted its retries sends them to the wrong screen. So the
 * projection reports the FIRST code in this order as the primary blocker and the
 * full list beside it.
 *
 * `none` is not in this list: an empty list IS "nothing is blocking", and a code
 * meaning "no code" would let a caller treat the healthy case as a finding.
 */
export const FINANCE_BLOCKER_CODES = [
  /** The booking has no payment record at all — nothing can settle. */
  "payment_record_missing",
  /**
   * A refund this platform undertook to execute has FAILED at the attempt
   * ceiling. It will never retry on its own. This is the most urgent state in the
   * pack: a member is owed money and nothing automatic will move it.
   */
  "refund_execution_exhausted",
  /** A refund is queued but has not executed yet. The money has NOT moved. */
  "refund_execution_pending",
  /** Money must be handed back by a human — there is no card to refund. */
  "manual_refund_open",
  /** A member asked for a refund and nobody has decided. */
  "refund_appeal_pending",
  /** A Xero sync operation for this booking or payment failed. */
  "xero_operation_failed",
  /** A Xero sync operation partially completed. */
  "xero_operation_partial",
  /** A Xero sync operation is still queued or running. */
  "xero_operation_pending",
  /** The booking has reached a settled status but has no Xero invoice linked. */
  "xero_invoice_missing",
  /** An upward modification was never collected. */
  "additional_payment_outstanding",
  /** The payment attempt failed at the provider. */
  "payment_failed",
  /** A charge is in flight and unconfirmed. */
  "payment_processing",
  /** No charge has been attempted or captured yet. */
  "payment_pending",
  /**
   * The stored ledger identity does not hold:
   * `amountCents + creditAppliedCents + uncollectedAdditionalCents` is not
   * `finalPriceCents`. An integer-cent discrepancy that no other code explains.
   */
  "ledger_variance",
  /**
   * The denormalised `Payment."creditAppliedCents"` disagrees with the
   * `MemberCredit` ledger. One of the two is wrong and a human has to say which.
   */
  "credit_ledger_variance",
] as const;

export type FinanceBlockerCode = (typeof FINANCE_BLOCKER_CODES)[number];

/**
 * The raw row this source hands the executor. Every field is a flat scalar
 * already — a `Date` is not one, so the instants are formatted here.
 */
export interface BookingFinanceStateRow extends DiagnosticsToolRawRow {
  booking_id: string;
  booking_reference: string;
  booking_status: string;
  payment_ref: string | null;
  payment_status: string | null;
  payment_source: string | null;
  payment_display_label: string;
  settlement_kind: string;
  xero_state: string;
  amount_due_cents: number;
  credit_applied_cents: number;
  amount_paid_cents: number;
  refunded_amount_cents: number;
  outstanding_cents: number;
  uncollected_additional_cents: number;
  remaining_refundable_cents: number;
  ledger_variance_cents: number;
  credit_ledger_variance_cents: number;
  member_credit_balance_cents: number;
  blocker_codes: string;
  blocker_count: number;
  manually_marked_paid: boolean;
  /**
   * The booking has reached a status where nothing more can be collected —
   * CANCELLED or BUMPED. Reported explicitly because it changes how three other
   * fields must be read: `outstanding_cents` is forced to zero, no
   * payment-progress blocker is emitted, and any residual delta on the payment
   * row is bookkeeping rather than money the member owes.
   */
  booking_lifecycle_terminal: boolean;
  observed_at_utc: string;
}

/**
 * The booking statuses at which nothing further can be collected and nothing is
 * blocking "completion", because there is no completion to reach.
 *
 * Cancelling or bumping a booking leaves `Payment`'s money columns exactly as
 * they were — nothing zeroes `additionalAmountCents`, and a PENDING payment row
 * stays PENDING — so a diagnostic that reads those columns without the lifecycle
 * reports a cancelled booking as still owing money. That is the same defect
 * `isAdditionalPaymentOwed` exists to prevent for the chase email, and the same
 * self-contradiction that had this source emit `payment_pending` beside the
 * authoritative display label "Cancelled Before Payment".
 */
const TERMINAL_BOOKING_STATUSES = new Set(["CANCELLED", "BUMPED"]);

/** The booking columns this source reads. Named explicitly, never `include`. */
const BOOKING_SELECT = {
  id: true,
  memberId: true,
  status: true,
  finalPriceCents: true,
} as const;

/** The payment columns this source reads. */
const PAYMENT_SELECT = {
  id: true,
  status: true,
  source: true,
  amountCents: true,
  refundedAmountCents: true,
  creditAppliedCents: true,
  additionalAmountCents: true,
  additionalPaymentStatus: true,
  xeroInvoiceId: true,
  manuallyMarkedPaidAt: true,
} as const;

/**
 * The cancellation-credit rows the authoritative display-status and
 * settlement-kind helpers need.
 *
 * `description` is READ and never RETURNED. Those two helpers classify a
 * settlement by matching the description against two server-written prefixes
 * ("Cancellation refund for booking…", "Credit restored from cancelled
 * booking…"), so the classification cannot be reproduced without it. It is
 * consumed inside this function and dropped; nothing downstream of
 * `readBookingFinanceStateEvidence` ever sees it, and the registry projection has
 * no field for it.
 *
 * `type` is read for the same reason and is likewise never returned: a
 * `BOOKING_MODIFICATION_REFUND` row is the evidence that this booking was
 * REPRICED DOWNWARD after it was paid, which is what stops the ledger identity
 * being asserted against a row where it legitimately cannot hold.
 *
 * THE CEILING IS 51, NOT 50, AND THAT IS THE WHOLE POINT. These rows are SUMMED
 * by `getPaymentDisplayStatus` and `deriveSettlementKind`, so a row beyond the
 * ceiling does not truncate a listing — it silently changes a CLASSIFICATION,
 * and the executor's `truncated` flag counts projected rows and would stay
 * false. Reading one more than the limit is how this source can TELL, and it
 * refuses rather than classifying from an incomplete sum.
 */
const CANCELLATION_CREDIT_CEILING = 50;

async function readCancellationCredits(
  tx: Prisma.TransactionClient,
  bookingId: string,
): Promise<
  { amountCents: number; description: string | null; type: string }[]
> {
  const rows = await tx.memberCredit.findMany({
    where: { sourceBookingId: bookingId },
    select: { amountCents: true, description: true, type: true },
    take: CANCELLATION_CREDIT_CEILING + 1,
  });
  if (rows.length > CANCELLATION_CREDIT_CEILING) {
    throw new Error(
      "Booking finance state: more credit rows than this source can classify from.",
    );
  }
  return rows.map((row) => ({
    amountCents: row.amountCents,
    description: row.description,
    type: String(row.type),
  }));
}

/**
 * The Xero-operation ceiling. Read one beyond it for the same reason
 * `readCancellationCredits` does: these rows are COUNTED into a classification,
 * so a row past the limit changes the answer silently rather than shortening a
 * list.
 */
const XERO_ACTIVITY_CEILING = 50;

/**
 * The Xero sync operations for this booking's PAYMENT, summarised by the SAME
 * function `/admin/payments` calls.
 *
 * TWO THINGS CHANGED HERE AND BOTH ARE ABOUT AGREEING WITH THE SCREEN (#2377
 * review):
 *
 *  - THE SCOPE is `Payment:{paymentId}`, exactly as `listAdminPayments` keys it.
 *    An earlier revision also read `localModel: "Booking"` on the theory that a
 *    booking's invoice work is recorded against the booking. It is not: every
 *    `startXeroSyncOperation` on the booking-invoice path
 *    (`xero-booking-invoices.ts`, `xero-credit-notes.ts`,
 *    `xero-applied-credit-allocation.ts`, `xero-invoice-payments.ts` and the
 *    outbox) writes `localModel: "Payment"`. So the wider scope matched nothing
 *    extra in practice while making the tool's own "the same classification the
 *    admin screen shows" claim untrue by construction.
 *  - THE SUMMARY comes from `buildXeroActivityByRecord`, the exported helper the
 *    screen uses, instead of a line-for-line copy of `summarizeXeroActivity`.
 *    This file's header says its classifications are never re-derived here; a
 *    copied summariser was exactly that.
 */
async function readXeroActivity(
  tx: Prisma.TransactionClient,
  paymentId: string | null,
): Promise<XeroActivitySummary> {
  if (!paymentId) return emptyXeroActivitySummary();
  const operations = await tx.xeroSyncOperation.findMany({
    where: {
      localModel: "Payment",
      localId: paymentId,
      // An operation an administrator resolved by hand in Xero is deliberately
      // excluded from the failure counts, exactly as the admin overview excludes
      // it — otherwise a fixed problem keeps being reported as a live one.
      manuallyResolvedAt: null,
    },
    select: {
      id: true,
      status: true,
      createdAt: true,
      localModel: true,
      localId: true,
    },
    orderBy: { createdAt: "desc" },
    take: XERO_ACTIVITY_CEILING + 1,
  });
  if (operations.length > XERO_ACTIVITY_CEILING) {
    throw new Error(
      "Booking finance state: more Xero operations than this source can classify from.",
    );
  }

  return (
    buildXeroActivityByRecord(operations).get(`Payment:${paymentId}`) ??
    emptyXeroActivitySummary()
  );
}

/**
 * Is there an invoice for this payment — the column OR an active
 * primary-invoice link?
 *
 * THE COLUMN IS NOT THE ONLY SOURCE, and treating it as one was the most
 * expensive defect in this file. `Payment."xeroInvoiceId"` and the
 * `XeroObjectLink` row are written by SEPARATE steps of the invoice mint
 * (`xero-booking-invoices.ts`), so a booking can legitimately hold the link and
 * not the column. This platform names that state `XERO_LINK_MISMATCH` and ships
 * an auto-applicable backfill for it (`xero-booking-repair-classify.ts`).
 *
 * The OR itself is not spelled here (#3467, `INV-SSOT-001`): it is asked of the
 * one reader in `xero-booking-invoice-evidence.ts`, which the admin payments
 * and bookings screens, the booking page and the enqueue fence also ask. The
 * transaction is handed in as its client so the read stays inside the one
 * read-only transaction. Reading the column alone made this tool report
 * `xero_invoice_missing` for a booking that HAS an invoice — and the next step
 * an operator takes from that is to raise a second one.
 */
async function readInvoiceLinked(
  tx: Prisma.TransactionClient,
  payment: { id: string; xeroInvoiceId: string | null } | null,
): Promise<boolean> {
  if (!payment) return false;
  const evidence = await readBookingInvoiceEvidence(payment, {
    deps: { db: tx },
  });
  return evidence.exists;
}

/**
 * The refund-side state that decides three of the blocker codes.
 *
 * The recovery ceiling is read one beyond as well: `executionExhausted` is a
 * `some()` over these rows, so an exhausted refund sitting past the limit would
 * be an urgent blocker this source silently failed to report.
 */
const RECOVERY_OPERATION_CEILING = 50;

async function readRefundPosture(
  tx: Prisma.TransactionClient,
  bookingId: string,
  paymentId: string | null,
): Promise<{
  executionExhausted: boolean;
  executionPending: boolean;
  manualOpen: boolean;
  appealPending: boolean;
}> {
  const [recovery, manualOpen, appealPending] = await Promise.all([
    paymentId
      ? tx.paymentRecoveryOperation.findMany({
          where: {
            paymentId,
            type: { not: "CREATE_ADDITIONAL_PAYMENT_INTENT" },
            status: { in: ["PENDING", "PROCESSING", "FAILED"] },
          },
          select: { status: true, attempts: true },
          take: RECOVERY_OPERATION_CEILING + 1,
        })
      : Promise.resolve([]),
    // #2797 (criterion 15): count OPEN manual-refund tasks by BOOKING, not by
    // payment. An EDIT_FINANCIAL_REVIEW task raised for an unpriceable edit can
    // be credit-only (`paymentId` null, owner decision D2), so keying on the
    // booking's payment would miss exactly the pending financial adjustment this
    // posture exists to surface — a reconciliation reader would then mistake a
    // booking with money held for review for a settled one. Booking-scoped
    // catches both the payment-linked and the credit-only task.
    tx.manualRefundTask.count({
      where: { bookingId, status: "OPEN" },
    }),
    tx.refundRequest.count({
      where: { bookingId, status: "PENDING" },
    }),
  ]);

  if (recovery.length > RECOVERY_OPERATION_CEILING) {
    throw new Error(
      "Booking finance state: more recovery operations than this source can classify from.",
    );
  }

  return {
    executionExhausted: recovery.some(
      (row) =>
        row.status === "FAILED" &&
        row.attempts >= FINANCE_RECOVERY_ATTEMPT_CEILING,
    ),
    executionPending: recovery.some(
      (row) => row.status === "PENDING" || row.status === "PROCESSING",
    ),
    manualOpen: manualOpen > 0,
    appealPending: appealPending > 0,
  };
}

/**
 * Assemble the authoritative booking-finance state. Returns ZERO rows when the
 * booking does not exist — which the executor reports as `not_found`, the honest
 * "we looked and there is nothing" — and exactly one row otherwise, including
 * when the booking has no payment at all.
 *
 * It REJECTS rather than returning a partial row on any failure, so the executor
 * reports `evidence_unavailable`. A finance state assembled from some of its
 * inputs would read as authoritative and be wrong.
 */
async function assembleBookingFinanceState(
  tx: Prisma.TransactionClient,
  bookingId: string,
): Promise<readonly BookingFinanceStateRow[]> {
  const observedAtUtc = new Date().toISOString();

  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    select: BOOKING_SELECT,
  });
  if (!booking) return [];

  const payment = await tx.payment.findUnique({
    where: { bookingId },
    select: PAYMENT_SELECT,
  });

  // BOTH AUTHORITATIVE CREDIT HELPERS TAKE THE TRANSACTION CLIENT, and passing it
  // is not optional politeness. Each defaults to the global client when handed
  // nothing, so an omission is silent: the aggregate would run outside this
  // snapshot and outside the statement timeout, and `creditLedgerVarianceCents`
  // below — the denormalised column measured against the ledger truth — would
  // compare two instants and report a variance on a booking where none exists.
  // A test asserts by IDENTITY that each received THIS client.
  const [appliedCreditCents, credits, memberCreditBalanceCents] =
    await Promise.all([
      deriveBookingAppliedCreditCents(bookingId, tx),
      readCancellationCredits(tx, bookingId),
      // #3369: an organisation holds no account credit, so the evidence pack
      // reports zero rather than reading a ledger that does not exist.
      bookingOwner(booking).memberId
        ? getMemberCreditBalance(bookingOwner(booking).memberId as string, tx)
        : Promise.resolve(0),
    ]);

  const [xeroActivity, refundPosture, invoiceLinked] = await Promise.all([
    readXeroActivity(tx, payment?.id ?? null),
    readRefundPosture(tx, bookingId, payment?.id ?? null),
    readInvoiceLinked(tx, payment ?? null),
  ]);

  // ---- Money. Integer cents only, no division anywhere. ------------------
  const amountDueCents = booking.finalPriceCents;
  const refundedAmountCents = payment?.refundedAmountCents ?? 0;
  const storedCreditAppliedCents = payment?.creditAppliedCents ?? 0;
  const capturedCents = hasCapturedPayment(
    payment
      ? {
          status: payment.status,
          amountCents: payment.amountCents,
          refundedAmountCents: payment.refundedAmountCents,
        }
      : null,
  )
    ? (payment?.amountCents ?? 0)
    : 0;
  const terminalLifecycle = TERMINAL_BOOKING_STATUSES.has(booking.status);

  // ---- The two DIFFERENT questions an uncollected addition can answer. -----
  //
  // They differ by exactly the booking-lifecycle half of the shared owed test,
  // and both are needed, so both are computed and each is used in one place
  // only. Collapsing them is what this source did before, and it dunned a
  // cancelled booking.
  //
  //  - THE LEDGER TERM is the MONEY half alone (`isAdditionalAmountUncollected`).
  //    It is legitimately status-independent: the write-time identity it
  //    reconstructs is a property of what was WRITTEN — see the "GENERALISED
  //    LEDGER MIRROR" note in `payment-reconciliation.ts`, where every cent of
  //    the price is collected, paid with credit, or still recorded as owed. A
  //    cancelled booking's delta columns are left exactly as they were, so the
  //    identity still holds over them and gating this half would manufacture a
  //    variance on every cancelled booking that carried one.
  //  - THE OWED TERM is the FULL shared predicate (`isAdditionalPaymentOwed`),
  //    status half and money half. It is what the projection reports and what
  //    gates the blocker, because "is money still owing" is the question every
  //    other surface asks — the admin bookings list, the finance metrics, both
  //    chase crons, the reports route and the booking panel all call this exact
  //    function, and its docblock names the failure being avoided: a cancelled
  //    booking must not read as still owing.
  const uncollectedAdditionalLedgerCents = isAdditionalAmountUncollected(payment)
    ? payment.additionalAmountCents
    : 0;
  const additionalPaymentOwed = isAdditionalPaymentOwed({
    bookingStatus: booking.status,
    payment,
  });
  const uncollectedAdditionalCents = additionalPaymentOwed
    ? uncollectedAdditionalLedgerCents
    : 0;

  // The identity `prepareManualSettlement` CONSTRUCTS at write time:
  //   amountCents + creditAppliedCents + uncollectedAdditionalCents === finalPriceCents
  // Reported as a signed integer-cent variance rather than re-asserted, because a
  // diagnostic exists precisely for the rows where it does NOT hold — and because
  // the writer itself is explicit that it builds the identity rather than
  // asserting it, so nothing re-establishes it after a later reprice.
  // The LEDGER term, not the owed term: see the note above.
  const ledgerVarianceCents = payment
    ? payment.amountCents +
      storedCreditAppliedCents +
      uncollectedAdditionalLedgerCents -
      amountDueCents
    : 0;

  /**
   * Was this booking REPRICED DOWNWARD after money was captured?
   *
   * If it was, the write-time identity above no longer describes the row and a
   * `ledger_variance` reported from it is a false finding. `Payment.amountCents`
   * is GROSS captured and is never reduced by a refund
   * (`syncPaymentAggregate`/`payment-transactions.ts`), while a downward guest,
   * date or batch modification DOES rewrite `Booking.finalPriceCents` and settles
   * the difference as a refund or a `BOOKING_MODIFICATION_REFUND` credit. The row
   * is then permanently and legitimately `amountCents > finalPriceCents`, and no
   * writer re-establishes the identity afterwards — `payment-reconciliation.ts`
   * is explicit that it constructs the identity rather than asserting it.
   *
   * Two cheap signals, either of which means a reprice-or-refund happened after
   * capture. Neither is a guess about the amount: they only suppress a variance
   * this source cannot distinguish from a healthy repriced booking.
   */
  const repricedAfterCapture =
    refundedAmountCents > 0 ||
    credits.some((credit) => credit.type === "BOOKING_MODIFICATION_REFUND");

  // The denormalised column against the ledger truth. Signed, in cents.
  const creditLedgerVarianceCents = storedCreditAppliedCents - appliedCreditCents;

  /**
   * What is still owed, in integer cents.
   *
   * NET of refunds, because `capturedCents` is GROSS. A booking that lost a guest
   * after it was paid has `finalPriceCents` 8 000, `amountCents` 12 000 and
   * `refundedAmountCents` 4 000: gross arithmetic reports -4 000, which reads as a
   * $40 overpayment on a perfectly healthy booking, and the next thing a Finance
   * Officer does about an overpayment is refund it a second time.
   *
   * ZERO on a CANCELLED or BUMPED booking. Nothing can be collected against a
   * booking that has no completion to reach, and `booking_lifecycle_terminal`
   * says so beside it rather than leaving the zero to be read as "settled".
   */
  const outstandingCents = terminalLifecycle
    ? 0
    : amountDueCents -
      appliedCreditCents -
      (capturedCents - refundedAmountCents);

  const remainingRefundableCents = getRemainingRefundableCents(
    payment
      ? {
          status: payment.status,
          amountCents: payment.amountCents,
          refundedAmountCents: payment.refundedAmountCents,
        }
      : null,
  );

  // ---- Authoritative classifications, never re-derived here. -------------
  const displayStatus = getPaymentDisplayStatus({
    bookingStatus: booking.status,
    paymentStatus: payment?.status ?? "PENDING",
    refundedAmountCents,
    credits,
  });
  const settlementKind = deriveSettlementKind({
    refundedAmountCents,
    credits,
  });
  // "Is there an invoice?" — `invoiceLinked` above came from the one reader
  // every other surface uses; see `readInvoiceLinked`.

  /**
   * The Xero classification, computed with the SCREEN's own expectation
   * predicate so this field and `/admin/payments` cannot disagree about one
   * payment. `isXeroInvoiceExpectedPaymentStatus` is the single definition, and
   * the screen calls it too.
   */
  const xeroState = deriveXeroState({
    invoiceExpected: isXeroInvoiceExpectedPaymentStatus(payment?.status),
    invoiceLinked,
    activity: xeroActivity,
  });

  /**
   * The BOOKING-lifecycle answer to the same question, which is deliberately
   * WIDER and is used only for the blocker.
   *
   * `isSettledBookingStatus` includes PAYMENT_PENDING, and that is not a
   * disagreement with the screen — it is a different question. An
   * internet-banking booking's Xero invoice is HOW the member pays, so a
   * PAYMENT_PENDING booking with no invoice is a real, actionable problem that
   * the screen's payment-status test cannot see. The blocker's own catalogue
   * sentence says "reached a status where an invoice is expected", which is the
   * lifecycle statement, so this is the predicate that belongs behind it.
   *
   * Both are `deriveXeroState`, so the activity precedence (a failed or pending
   * sync outranks "missing") is identical and neither is re-derived here.
   */
  const lifecycleXeroState = deriveXeroState({
    invoiceExpected: isSettledBookingStatus(booking.status),
    invoiceLinked,
    activity: xeroActivity,
  });

  // ---- Blockers. ----------------------------------------------------------
  //
  // Built by FILTERING the declared catalogue rather than by pushing onto a list
  // and sorting it afterwards. The previous shape carried a `sort` that could
  // never reorder anything (the checks already ran in catalogue order) and a
  // dedupe that could never fire (every code was reachable once) — code that
  // looks load-bearing and is not. Filtering the catalogue makes the priority
  // order STRUCTURAL: it is the order of `FINANCE_BLOCKER_CODES` by
  // construction, whatever order the predicates below are written in.
  //
  // A CANCELLED or BUMPED booking emits no payment-progress blocker. Its money
  // columns are frozen where the cancellation left them, so "no charge has been
  // attempted" is true of the columns and false as an answer: there is nothing
  // to charge. Reporting `payment_pending` beside the authoritative display
  // label "Cancelled Before Payment" was the tool contradicting itself in one
  // row. The bookkeeping blockers (Xero, refunds, variances) are NOT suppressed
  // — a cancelled booking can still owe a refund and still be wrong in Xero.
  const blockerActive: Record<FinanceBlockerCode, boolean> = {
    payment_record_missing: !payment,
    refund_execution_exhausted: refundPosture.executionExhausted,
    refund_execution_pending: refundPosture.executionPending,
    manual_refund_open: refundPosture.manualOpen,
    refund_appeal_pending: refundPosture.appealPending,
    xero_operation_failed: lifecycleXeroState === "operationFailed",
    xero_operation_partial: lifecycleXeroState === "operationPartial",
    xero_operation_pending: lifecycleXeroState === "operationPending",
    xero_invoice_missing: lifecycleXeroState === "invoiceMissing",
    // Already false for a terminal booking: the shared owed test's status half
    // excludes CANCELLED and BUMPED. Stated through the shared predicate rather
    // than restated here, so there is one definition of "still owing".
    additional_payment_outstanding: uncollectedAdditionalCents > 0,
    payment_failed: !terminalLifecycle && payment?.status === "FAILED",
    payment_processing: !terminalLifecycle && payment?.status === "PROCESSING",
    payment_pending: !terminalLifecycle && payment?.status === "PENDING",
    // Suppressed on a booking repriced downward after capture, where the
    // write-time identity legitimately no longer holds. See `repricedAfterCapture`.
    ledger_variance: ledgerVarianceCents !== 0 && !repricedAfterCapture,
    credit_ledger_variance: creditLedgerVarianceCents !== 0,
  };

  const blockers = FINANCE_BLOCKER_CODES.filter((code) => blockerActive[code]);

  return [
    {
      booking_id: booking.id,
      booking_reference: formatBookingReference(booking.id),
      booking_status: booking.status,
      payment_ref: payment?.id ?? null,
      payment_status: payment?.status ?? null,
      payment_source: payment?.source ?? null,
      payment_display_label: displayStatus.label,
      settlement_kind: settlementKind,
      xero_state: xeroState,
      amount_due_cents: amountDueCents,
      credit_applied_cents: appliedCreditCents,
      amount_paid_cents: capturedCents,
      refunded_amount_cents: refundedAmountCents,
      outstanding_cents: outstandingCents,
      uncollected_additional_cents: uncollectedAdditionalCents,
      remaining_refundable_cents: remainingRefundableCents,
      ledger_variance_cents: ledgerVarianceCents,
      credit_ledger_variance_cents: creditLedgerVarianceCents,
      member_credit_balance_cents: memberCreditBalanceCents,
      // A stable, comma-joined list in priority order — the same shape AID-6A's
      // readiness entry uses, so a consumer parses one convention.
      blocker_codes: blockers.length > 0 ? blockers.join(",") : "none",
      blocker_count: blockers.length,
      manually_marked_paid: payment?.manuallyMarkedPaidAt != null,
      booking_lifecycle_terminal: terminalLifecycle,
      observed_at_utc: observedAtUtc,
    },
  ];
}

/**
 * The evidence source the registry entry names, with this module's own deadline
 * wrapped around it.
 *
 * The work promise gets its own no-op `catch` BEFORE the race, so a rejection
 * that arrives after the deadline is handled rather than surfacing as an
 * unhandled rejection — the same discipline `invoke.ts` applies to the executor's
 * own race, and for the same reason: an unhandled rejection can take the process
 * down.
 *
 * READING THIS FUNCTION DIRECTLY IS OUTSIDE THE SUBSTRATE'S GUARANTEES. It is an
 * ordinary module export, and a server-side caller could import it and get none of
 * the ten gates. The module is marked `server-only`, so no such import can reach a
 * browser bundle, but the guarantee the substrate makes is about the registry
 * ENTRY — which exposes no handle on this function at all — not about the
 * reachability of the function.
 */
export async function readBookingFinanceStateEvidence(args: {
  bookingId: string;
}): Promise<readonly DiagnosticsToolRawRow[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = withBoundedReadOnlyTransaction((tx) =>
    assembleBookingFinanceState(tx, args.bookingId),
  );
  void work.catch(() => {});
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Booking finance state evidence did not assemble in time.",
              ),
            ),
          BOOKING_FINANCE_DEADLINE_MS,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
