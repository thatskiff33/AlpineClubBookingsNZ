/**
 * AI Diagnostics — AID-6C finance pack, part 1: BOUNDED RECORD SELECTION (#2377,
 * epic #2369).
 *
 * TWO ENTRIES, AND THEY ARE THE ONLY WAY INTO THE PACK. Every other finance tool
 * takes an exact record id, so an operator (and the model acting for them) has to
 * FIND the record before any detail is retrievable. That ordering is the shape
 * #2377 asks for — "require selection of a specific record before detailed
 * evidence" — and it is what makes "no bulk extraction" a property of the pack
 * rather than a promise about how it will be used.
 *
 *   diagnostics.finance_payment_search         finance
 *   diagnostics.finance_payment_amount_search  finance
 *
 * PERMISSION: `finance:view`, and only `finance:view`. NOT `support:view` as
 * well — #2375's owner decision is explicit that a domain tool must not demand a
 * support permission merely because it appears inside AI Diagnostics, and a
 * Finance Officer investigating a payment is doing their own job. (The AID-6A
 * audit-CORRELATION entries do require both, because they read the platform's own
 * audit trail, which is a Support & System surface. This pack reads finance
 * tables, which are not.)
 *
 * WHY A SEARCH IS SAFE HERE, stated as the properties rather than the intention.
 * Each is pinned by a test:
 *
 *  - EXACT, NEVER A PATTERN. Every predicate is `=`. There is no `LIKE`, no
 *    `ILIKE`, no `similar to`, no regex operator and no wildcard anywhere in this
 *    module, so there is nothing a `%` or a `_` in a search term could mean even
 *    if the argument schema let one through — which it does not.
 *  - BLANK IS A REJECTION. `EXACT_REFERENCE` requires six characters; the
 *    booking-reference kind requires exactly eight; the record-id kinds require a
 *    cuid shape. `{}` does not parse. There is no "show all", no optional-term
 *    arm, and no default that would list recent payments.
 *  - THE RANGE IS A CLOSED ENUM. The amount search's window is `7d`, `30d` or
 *    `90d` and nothing else, so #2377's ban on an unrestricted date range is a
 *    type rather than a check.
 *  - CAPPED AND DETERMINISTIC. Ten rows, newest first, with the payment id as the
 *    tiebreaker so the ordering is total and identical evidence hashes
 *    identically for the audit trail.
 *  - AMBIGUITY IS REPORTED, NOT RESOLVED. A booking reference is the uppercase
 *    first eight characters of a cuid and is NOT unique, so a search on one can
 *    legitimately match several bookings. The tool returns them all (up to the
 *    cap) and the model is told to make the operator choose; it never picks one.
 *
 * WHAT A SEARCH ROW DELIBERATELY DOES NOT CARRY. No member name, email address,
 * phone number or member id; no booking notes; no Stripe customer or payment
 * method identifier; no free text of any kind except the internet-banking
 * reference, which is bounded to 64 characters and stripped. A search result is
 * for RECOGNISING the right record — the reference, the money, the state and the
 * instant — and a harvested page of them is worth nothing without the per-record
 * tools, which each need their own exact id.
 *
 * THE PLAN, AND WHY IT IS ACCEPTABLE. The reference search's predicate is a
 * disjunction across differently-indexed columns, so PostgreSQL will usually
 * satisfy it with one sequential scan of `Payment` rather than an index scan.
 * That is a deliberate trade: this platform holds at most one `Payment` row per
 * booking, so the relation is in the tens of thousands of rows at club scale and
 * the scan is milliseconds. The 5-second `statement_timeout` is the backstop, and
 * a timeout is reported honestly as `query_failed` rather than as an absence. The
 * alternative — nine separate registry entries, one per reference kind, each with
 * its own index — was rejected as nine tools the model has to choose between for
 * one question.
 */

import "server-only";

import { z } from "zod";

import { BOOKING_REFERENCE_SHAPE, SHORT_BOOKING_ID_LENGTH } from "@/lib/booking-reference";
import { defineDiagnosticsTool, type DiagnosticsToolEntry } from "../define";
import {
  AMOUNT_CENTS,
  DEFAULT_FINANCE_SEARCH_WINDOW,
  EXACT_REFERENCE,
  FINANCE_BYTE_LIMIT,
  FINANCE_DESCRIPTION_TAIL,
  FINANCE_SEARCH_ROW_LIMIT,
  FINANCE_SEARCH_WINDOW_KEYS,
  FINANCE_SEARCH_WINDOWS,
  NOW_UTC,
  STORED_EVIDENCE_DISCLOSURE,
  boolOf,
  centsOrZero,
  instantOrNull,
  providerRefOrNull,
  recordRefOrNull,
  stableCodeOrNull,
  untrustedTextOrNull,
  utcInstant,
} from "./finance-shared";

export const DIAGNOSTICS_FINANCE_PAYMENT_SEARCH_TOOL_ID =
  "diagnostics.finance_payment_search";
export const DIAGNOSTICS_FINANCE_AMOUNT_SEARCH_TOOL_ID =
  "diagnostics.finance_payment_amount_search";

/**
 * The closed set of references an operator may search on, and the column each
 * one really means. A closed enum rather than a free "field" argument, so the
 * predicate is fixed at review time: the model chooses WHICH of nine
 * server-written equalities to evaluate, never what to compare or where.
 *
 * Two of them need a note because the obvious reading is wrong:
 *
 *  - `booking_reference` is NOT a column. It is the uppercase first eight
 *    characters of the booking's cuid (`formatBookingReference`), which is what
 *    an operator reads off a confirmation email, and it is not unique. The
 *    predicate compares `left("bookingId", 8)` against the lower-cased term.
 *  - `bank_reference` matches the internet-banking reference on EITHER the
 *    payment row or any of its transaction rows. `PaymentTransaction.reference`
 *    is the indexed one; `Payment.reference` is not indexed, and is included
 *    anyway because the older internet-banking rows carry it there.
 */
export const FINANCE_SEARCH_REFERENCE_KINDS = [
  "payment_id",
  "booking_id",
  "booking_reference",
  "stripe_payment_intent",
  "stripe_charge",
  "stripe_refund",
  "bank_reference",
  "xero_invoice_id",
  "xero_invoice_number",
] as const;

/** The cuid shape the two record-id kinds require. */
const CUID_SHAPE = /^[a-z0-9]{20,40}$/;

/**
 * Per-kind term validation, applied AFTER the shared shape.
 *
 * It exists so a search cannot be turned into a scan by supplying a
 * six-character term for a kind whose real values are 25 characters long: a
 * `payment_id` that is not cuid-shaped can match nothing, so refusing it costs
 * an operator nothing and denies a prober a cheap way to make the executor do
 * work. A refusal is `invalid_args`, which echoes no input.
 */
const referenceSearchArgsSchema = z
  .object({
    referenceKind: z.enum(FINANCE_SEARCH_REFERENCE_KINDS),
    reference: EXACT_REFERENCE,
  })
  .strict()
  .superRefine((value, ctx) => {
    const { referenceKind, reference } = value;
    if (
      (referenceKind === "payment_id" || referenceKind === "booking_id") &&
      !CUID_SHAPE.test(reference)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["reference"],
        message: "expected a record id",
      });
      return;
    }
    if (
      referenceKind === "booking_reference" &&
      !BOOKING_REFERENCE_SHAPE.test(reference)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["reference"],
        message: "expected an eight-character booking reference",
      });
    }
  });

type ReferenceSearchArgs = z.infer<typeof referenceSearchArgsSchema>;

const referenceSearchInputSchema = {
  type: "object" as const,
  properties: {
    referenceKind: {
      type: "string",
      enum: [...FINANCE_SEARCH_REFERENCE_KINDS],
      description:
        "Which kind of reference the search term is. booking_reference is the eight-character handle a member sees on their confirmation (it is NOT unique — several bookings can share one).",
    },
    reference: {
      type: "string",
      description:
        "The EXACT reference to look up. At least 6 characters; exactly 8 for booking_reference; a full record id for payment_id and booking_id. No wildcards, no partial matches, no blank searches.",
    },
  },
  required: ["referenceKind", "reference"],
  additionalProperties: false as const,
};

/**
 * The columns every search row carries, shared by both entries so the model sees
 * one row shape whichever way it found the record.
 *
 * `booking_reference` is computed rather than stored, and `has_stripe_intent` /
 * `has_xero_invoice` are BOOLEANS rather than the identifiers: a search result
 * says whether a linkage exists so the operator can tell two candidates apart,
 * and the identifiers themselves are per-record evidence that
 * `diagnostics.payment_diagnostic_summary` returns once a record has been chosen.
 */
const SEARCH_COLUMNS = `p."id" AS payment_ref,
  p."bookingId" AS booking_id,
  pg_catalog.upper(pg_catalog.left(p."bookingId", ${SHORT_BOOKING_ID_LENGTH})) AS booking_reference,
  p."status"::text AS payment_status,
  p."source"::text AS payment_source,
  p."amountCents" AS amount_cents,
  p."refundedAmountCents" AS refunded_amount_cents,
  p."creditAppliedCents" AS credit_applied_cents,
  p."additionalAmountCents" AS additional_amount_cents,
  p."additionalPaymentStatus" AS additional_payment_status,
  (p."stripePaymentIntentId" IS NOT NULL) AS has_stripe_intent,
  (p."xeroInvoiceId" IS NOT NULL) AS has_xero_invoice,
  p."xeroInvoiceNumber" AS xero_invoice_number,
  p."reference" AS bank_reference,
  (p."manuallyMarkedPaidAt" IS NOT NULL) AS manually_marked_paid,
  ${utcInstant('p."createdAt"')} AS created_at_utc,
  ${utcInstant('p."updatedAt"')} AS updated_at_utc`;

/**
 * The nine equalities, written out once and fixed at review time. `$2` selects
 * which arm is live; `$1` is the term. Both are bound parameters — nothing is
 * formatted into this statement, and the kind cannot name a column.
 *
 * `pg_catalog.` qualification throughout for the same reason `database.ts` pins
 * `search_path`: the statement that decides which records an operator can reach
 * must not depend on schema-resolution order.
 */
const REFERENCE_SEARCH_SQL = `SELECT
  ${SEARCH_COLUMNS}
FROM public."Payment" p
WHERE (
  ($2::text = 'payment_id' AND p."id" = $1::text)
  OR ($2::text = 'booking_id' AND p."bookingId" = $1::text)
  OR ($2::text = 'booking_reference' AND pg_catalog.left(p."bookingId", ${SHORT_BOOKING_ID_LENGTH}) = pg_catalog.lower($1::text))
  OR ($2::text = 'stripe_payment_intent' AND (p."stripePaymentIntentId" = $1::text OR p."additionalPaymentIntentId" = $1::text))
  OR ($2::text = 'xero_invoice_id' AND p."xeroInvoiceId" = $1::text)
  OR ($2::text = 'xero_invoice_number' AND p."xeroInvoiceNumber" = $1::text)
  OR ($2::text = 'bank_reference' AND (
    p."reference" = $1::text
    OR EXISTS (
      SELECT 1 FROM public."PaymentTransaction" t
      WHERE t."paymentId" = p."id" AND t."reference" = $1::text
    )
  ))
  OR ($2::text = 'stripe_payment_intent' AND EXISTS (
    SELECT 1 FROM public."PaymentTransaction" t2
    WHERE t2."paymentId" = p."id" AND t2."stripePaymentIntentId" = $1::text
  ))
  OR ($2::text = 'stripe_charge' AND EXISTS (
    SELECT 1 FROM public."PaymentRefund" r
    WHERE r."paymentId" = p."id" AND r."stripeChargeId" = $1::text
  ))
  OR ($2::text = 'stripe_refund' AND EXISTS (
    SELECT 1 FROM public."PaymentRefund" r2
    WHERE r2."paymentId" = p."id" AND r2."stripeRefundId" = $1::text
  ))
)
ORDER BY p."createdAt" DESC, p."id" ASC`;

/**
 * THE `$1 > 0` GUARD ON THE ADDITIONAL LEG IS A SECURITY CONTROL, not a
 * micro-optimisation.
 *
 * `Payment."additionalAmountCents"` is `Int @default(0)` and NOT NULL, so almost
 * every payment in the table holds a literal zero in it. Without the guard,
 * `{amountCents: 0}` matched that column on essentially the whole relation and
 * returned the ten most recent payments club-wide to a caller who had identified
 * no record at all — a blank "show me recent payments" listing, which is exactly
 * what #2377 forbids ("no blank searches", "no wildcard show-all searches", "no
 * bulk extraction") and what acceptance criterion 5 turns on.
 *
 * A zero-amount search still WORKS, and still should: a fully credit-covered
 * booking really does settle as a zero-amount payment and is one of the states an
 * operator is most likely to be confused by. It now matches only rows whose
 * PRIMARY amount is zero, which is the record they are looking for. There is no
 * such thing as a zero-cent additional payment worth searching for — the
 * platform's own owed test requires `additionalAmountCents > 0` before an
 * addition exists at all.
 */
const AMOUNT_SEARCH_SQL = `SELECT
  ${SEARCH_COLUMNS}
FROM public."Payment" p
WHERE (
    p."amountCents" = $1::int
    OR ($1::int > 0 AND p."additionalAmountCents" = $1::int)
  )
  AND p."createdAt" >= ${NOW_UTC} - (($2)::int * INTERVAL '1 day')
ORDER BY p."createdAt" DESC, p."id" ASC`;

/** The projection both search entries share. Flat scalars, one fixed shape. */
function projectSearchRow(row: Record<string, unknown>) {
  return {
    paymentRef: recordRefOrNull(row.payment_ref) ?? "",
    bookingId: recordRefOrNull(row.booking_id) ?? "",
    bookingReference: recordRefOrNull(row.booking_reference) ?? "",
    paymentStatus: stableCodeOrNull(row.payment_status),
    paymentSource: stableCodeOrNull(row.payment_source),
    amountCents: centsOrZero(row.amount_cents),
    refundedAmountCents: centsOrZero(row.refunded_amount_cents),
    creditAppliedCents: centsOrZero(row.credit_applied_cents),
    additionalAmountCents: centsOrZero(row.additional_amount_cents),
    additionalPaymentStatus: stableCodeOrNull(row.additional_payment_status),
    hasStripeIntent: boolOf(row.has_stripe_intent),
    hasXeroInvoice: boolOf(row.has_xero_invoice),
    xeroInvoiceNumber: providerRefOrNull(row.xero_invoice_number),
    // The one genuinely free-text value a search row carries: whatever the payer
    // typed into their own bank. Bounded and stripped, never trusted.
    bankReference: untrustedTextOrNull(row.bank_reference),
    manuallyMarkedPaid: boolOf(row.manually_marked_paid),
    createdAtUtc: instantOrNull(row.created_at_utc) ?? "",
    updatedAtUtc: instantOrNull(row.updated_at_utc) ?? "",
  };
}

/**
 * The scope sentence both searches carry, and it does real work.
 *
 * A finance search that matches nothing carries the state `not_found` —
 * "Nothing matched, so there is no evidence of this to report." — which, unqualified,
 * is a claim that no such payment exists. It is not: this pack searches `Payment`
 * rows, and a club's money also moves through membership subscription charges and
 * group-booking settlements, which are their own relations and are NOT searched
 * here. Saying so is the difference between "I could not find it with this tool"
 * and "it does not exist", and only one of those is true.
 */
const SEARCH_SCOPE_TAIL =
  "It searched BOOKING payment records only. Membership subscription charges, entrance-fee invoices and group-booking settlements are separate records this tool does not search, so nothing matching here does NOT mean no such payment exists — say which records were searched. A booking reference is only the first eight characters of the booking id and is NOT unique, so more than one row can legitimately match: if it does, ask the operator which booking they mean rather than choosing one.";

const referenceSearch = defineDiagnosticsTool<ReferenceSearchArgs>({
  id: DIAGNOSTICS_FINANCE_PAYMENT_SEARCH_TOOL_ID,
  source: "select_only_sql",
  label: "Find a booking payment by reference",
  description: `Finds a booking's payment record from ONE exact reference — a payment id, a booking id, the eight-character booking reference a member sees, a Stripe PaymentIntent, charge or refund id, an internet-banking reference, or a Xero invoice id or number. Use it FIRST: every other finance tool needs the exact payment or booking id this returns. Exact matches only — there are no partial, wildcard or blank searches, and it returns at most ${FINANCE_SEARCH_ROW_LIMIT} rows, newest first. Each row carries the payment and booking ids, the booking reference, the payment status and source, the amounts in integer cents, whether a Stripe or Xero linkage exists, the Xero invoice number, the internet-banking reference, whether it was settled by hand, and when it was created and last changed. It returns no member name, email address or phone number. ${FINANCE_DESCRIPTION_TAIL}`,
  requiredAreas: ["finance"],
  evidenceScope: `Booking payment records matching ONE exact reference. ${SEARCH_SCOPE_TAIL} ${STORED_EVIDENCE_DISCLOSURE}`,
  argsSchema: referenceSearchArgsSchema,
  inputSchema: referenceSearchInputSchema,
  sql: REFERENCE_SEARCH_SQL,
  // Two parameters, always, in this order. The executor appends the row cap as $3.
  bind: (args) => [args.reference, args.referenceKind],
  project: projectSearchRow,
  rowLimit: FINANCE_SEARCH_ROW_LIMIT,
  byteLimit: FINANCE_BYTE_LIMIT,
  // A booking's internet-banking reference is whatever the payer typed, and payers
  // routinely type their own name into it. That makes this projection capable of
  // identifying a person, so ADR-004's per-invocation opt-in applies.
  surfacesPersonalData: true,
  // A SEARCH: it is the entry that turns a payment reference, a Stripe id or an
  // internet-banking reference into the exact payment id every other finance tool
  // needs. See `operatorOnly` in `define.ts` for the gate.
  operatorOnly: true,
});

const amountSearchArgsSchema = z
  .object({
    amountCents: AMOUNT_CENTS,
    window: z
      .enum(FINANCE_SEARCH_WINDOW_KEYS)
      .default(DEFAULT_FINANCE_SEARCH_WINDOW),
  })
  .strict();

type AmountSearchArgs = z.infer<typeof amountSearchArgsSchema>;

const amountSearch = defineDiagnosticsTool<AmountSearchArgs>({
  id: DIAGNOSTICS_FINANCE_AMOUNT_SEARCH_TOOL_ID,
  source: "select_only_sql",
  label: "Find a booking payment by exact amount and date range",
  description: `Finds booking payments whose amount is EXACTLY the integer cents given, created inside a narrow window ending now (7d, 30d or 90d — 30d by default). Use it when a member or a bank statement gives an amount and a rough date but no reference. The amount must be exact integer cents (for example 12345 for $123.45) — there is no range, no rounding and no "about". At most ${FINANCE_SEARCH_ROW_LIMIT} rows, newest first; if several match, ask which booking is meant rather than choosing one. It matches the primary amount OR an additional-payment amount, except that an amount of 0 matches only payments whose PRIMARY amount is zero — a fully credit-covered booking. It returns no member name, email address or phone number. ${FINANCE_DESCRIPTION_TAIL}`,
  requiredAreas: ["finance"],
  evidenceScope: `Booking payments with that EXACT amount in integer cents, created inside the chosen window. ${SEARCH_SCOPE_TAIL} An amount that differs by a single cent will not match — if nothing is found, consider that the payment may carry a change fee, an additional-payment amount or applied credit that makes its stored amount different from the figure the operator has. ${STORED_EVIDENCE_DISCLOSURE}`,
  argsSchema: amountSearchArgsSchema,
  inputSchema: {
    type: "object",
    properties: {
      amountCents: {
        type: "integer",
        description:
          "The EXACT amount in integer cents (12345 means $123.45). Whole cents only — a decimal is rejected.",
      },
      window: {
        type: "string",
        enum: [...FINANCE_SEARCH_WINDOW_KEYS],
        description:
          "How far back to look, ending now. Defaults to 30d. 90d is the maximum.",
      },
    },
    required: ["amountCents"],
    additionalProperties: false,
  },
  sql: AMOUNT_SEARCH_SQL,
  bind: (args) => [args.amountCents, FINANCE_SEARCH_WINDOWS[args.window]],
  project: projectSearchRow,
  rowLimit: FINANCE_SEARCH_ROW_LIMIT,
  byteLimit: FINANCE_BYTE_LIMIT,
  surfacesPersonalData: true,
  // A SEARCH by AMOUNT — a bounded list of payments and the people behind them.
  operatorOnly: true,
});

/** The AID-6C search half, in presentation order. */
export const DIAGNOSTICS_FINANCE_SEARCH_TOOLS: readonly DiagnosticsToolEntry[] =
  [referenceSearch, amountSearch];
