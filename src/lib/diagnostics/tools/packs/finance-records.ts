/**
 * AI Diagnostics — AID-6C finance pack, part 2: PER-RECORD STORED EVIDENCE
 * (#2377, epic #2369).
 *
 * Seven entries, each taking an EXACT identifier that `finance-search.ts` had to
 * produce first. There is no listing tool here, no window that returns "recent
 * payments", and no argument that widens a predicate — so the pack has no shape
 * that could be walked to extract a ledger.
 *
 *   diagnostics.payment_diagnostic_summary     finance
 *   diagnostics.payment_attempt_ledger         finance
 *   diagnostics.payment_refund_state           finance
 *   diagnostics.finance_webhook_timeline       finance
 *   diagnostics.xero_invoice_linkage           finance
 *   diagnostics.xero_contact_linkage           finance + membership
 *   diagnostics.finance_record_audit_history   finance
 *
 * PERMISSION, and the one line that decides it. `finance:view` is the area that
 * already governs Admin > Payments, Refund Appeals, Internet Banking and Xero
 * Sync. It is required, and — for six of the seven — it is ALL that is required:
 * #2375's owner decision is explicit that a domain tool must not also demand
 * `support:view`, and a Finance Officer investigating a payment is doing their
 * own job, not a support one.
 *
 * `diagnostics.xero_contact_linkage` is the exception and it is deliberate. It is
 * keyed on a MEMBER, and the epic's rule for a tool that combines finance and
 * membership evidence is that it requires both areas, AND-ed. Tying a member to a
 * Xero contact is exactly that combination, so it declares `finance` and
 * `membership` and the executor re-reads both on every invocation. There is no
 * argument that could move an entry between the two permission sets: the areas
 * are fixed on the entry, and `invoke.ts` authorizes before it parses arguments.
 *
 * STORED EVIDENCE ONLY. Nothing in this module calls Stripe, Xero, a bank or any
 * other provider. Every provider value is what this platform last WROTE DOWN, and
 * every entry says so in its own scope line, because the difference between "the
 * stored Stripe state is SUCCEEDED" and "Stripe says this succeeded" is the whole
 * difference between evidence and a claim the pack is not entitled to make.
 *
 * FOUR CLASSES OF COLUMN ARE NEVER READ, and they are not merely unprojected —
 * with the exceptions argued below they are outside the SELECT grant, so
 * PostgreSQL refuses them (42501) to this credential in a `psql` session as
 * readily as in a tool:
 *
 *  1. RAW PROVIDER PAYLOADS. `XeroInboundEvent."payload"` is the only column in
 *     this schema that stores a raw provider webhook body, and it is the single
 *     most important omission in the pack. `XeroSyncOperation."requestPayload"`
 *     and `"responsePayload"` are the raw Xero request/response bodies. None is
 *     granted.
 *  2. RAW PROVIDER OR HANDLER ERROR TEXT. `PaymentRecoveryOperation."lastError"`
 *     (`@db.Text`, routinely a stack), `XeroSyncOperation."lastErrorMessage"`,
 *     `XeroInboundEvent."errorMessage"`, `WebhookLog."error"`. The pack reports
 *     `XeroSyncOperation."lastErrorCode"` — a stable code — and nothing else.
 *  3. OPERATOR AND MEMBER FREE TEXT. `Payment."manualPaymentNote"`,
 *     `ManualRefundTask."reason"`/`"note"`, `RefundRequest."reason"`/
 *     `"adminNotes"`, `PaymentTransaction."reason"`,
 *     `XeroSyncOperation."manuallyResolvedReason"`, `MemberCredit."description"`.
 *     One free-text value IS projected — the internet-banking reference — and it
 *     is bounded to 64 characters and stripped, because it is the only way to
 *     match a bank line to a booking and #2377 lists it as approved evidence.
 *  4. PEOPLE. No member name, email address, phone number or member id reaches a
 *     projected row from any entry here except `xero_contact_linkage`, which
 *     projects the member id it was GIVEN and requires `membership:view` to run.
 *     `Payment."manuallyMarkedPaidByMemberId"`, `ManualRefundTask.`
 *     `"completedByMemberId"`, `RefundRequest."memberId"`/`"reviewedBy"`,
 *     `XeroSyncOperation."createdByMemberId"`/`"manuallyResolvedById"` and
 *     `AuditLog."actorMemberId"`/`"subjectMemberId"`/`"memberId"` are all
 *     ungranted.
 *
 * ONE COLUMN IS GRANTED SO THAT IT NEVER HAS TO BE PROJECTED, and it is worth
 * calling out because it is the pattern #2377 asks for by name.
 * `PaymentRecoveryOperation."idempotencyKey"` is the ONLY thing that says WHY a
 * refund was queued — the operation `type` is `REFUND_BOOKING_MODIFICATION` for a
 * cancellation refund, a refund-appeal refund, a capacity-race refund and a
 * duplicate-capture refund alike, so a tool that reported the type alone would
 * mislabel every one of them. The key's PREFIX is a server-written scenario
 * marker. So the statement classifies it against a closed list of prefixes from
 * this repository's own `payment-recovery-keys.ts` and projects the resulting
 * CODE; the key itself never leaves the database. That is "map the stable code
 * through a server-owned catalogue" implemented one layer lower than usual, and
 * it means a future projection bug cannot leak the key either.
 *
 * NO WILDCARD REACHES SQL. `pg_catalog.starts_with` is used for the prefix
 * classification above, with literals this module owns; there is no `LIKE`, no
 * `ILIKE` and no regex operator anywhere in the pack, and no caller-supplied
 * value is ever used as a pattern. Every caller-supplied value is an equality
 * against an indexed column.
 */

import "server-only";

import { z } from "zod";

import { auditCategoriesForCorrelationDomain } from "@/lib/audit-categories";

import { defineDiagnosticsTool, type DiagnosticsToolEntry } from "../define";
import {
  EXACT_REFERENCE,
  FINANCE_BYTE_LIMIT,
  FINANCE_DESCRIPTION_TAIL,
  FINANCE_SINGLE_ROW_BYTE_LIMIT,
  RECORD_ID,
  STORED_EVIDENCE_DISCLOSURE,
  boolOf,
  centsOrNull,
  centsOrZero,
  countOf,
  instantOrNull,
  providerRefOrNull,
  recordRefOrNull,
  stableCodeOrNull,
  untrustedTextOrNull,
  utcInstant,
} from "./finance-shared";

export const DIAGNOSTICS_PAYMENT_SUMMARY_TOOL_ID =
  "diagnostics.payment_diagnostic_summary";
export const DIAGNOSTICS_PAYMENT_ATTEMPT_LEDGER_TOOL_ID =
  "diagnostics.payment_attempt_ledger";
export const DIAGNOSTICS_PAYMENT_REFUND_STATE_TOOL_ID =
  "diagnostics.payment_refund_state";
export const DIAGNOSTICS_FINANCE_WEBHOOK_TIMELINE_TOOL_ID =
  "diagnostics.finance_webhook_timeline";
export const DIAGNOSTICS_XERO_INVOICE_LINKAGE_TOOL_ID =
  "diagnostics.xero_invoice_linkage";
export const DIAGNOSTICS_XERO_CONTACT_LINKAGE_TOOL_ID =
  "diagnostics.xero_contact_linkage";
export const DIAGNOSTICS_FINANCE_AUDIT_HISTORY_TOOL_ID =
  "diagnostics.finance_record_audit_history";

/** One record id, and nothing else. The shape six of these seven entries take. */
const paymentIdArgsSchema = z.object({ paymentId: RECORD_ID }).strict();
type PaymentIdArgs = z.infer<typeof paymentIdArgsSchema>;

const paymentIdInputSchema = {
  type: "object" as const,
  properties: {
    paymentId: {
      type: "string",
      description:
        "The EXACT payment record id, as returned by diagnostics.finance_payment_search. Not a booking reference and not a Stripe id.",
    },
  },
  required: ["paymentId"],
  additionalProperties: false as const,
};

// ---------------------------------------------------------------------------
// 1. The payment's own stored state.
// ---------------------------------------------------------------------------

/**
 * ONE ROW: everything this platform has written down about one booking payment.
 *
 * Every amount here is an `Int` column in PostgreSQL — integer cents, checked on
 * the way out by `centsOrZero`, which returns null rather than a rounded number
 * if a non-integer ever arrives. There is no currency column on `Payment`: this
 * platform is single-currency NZD, and inventing a currency field here would be
 * asserting something the database does not record. The scope line says so, and
 * `payment_refund_state` DOES project the per-refund `currency` column, which is
 * the one place a currency really is stored.
 *
 * WHAT IS PROJECTED AND WHY IT IS SAFE:
 *  - the payment and booking ids, and the eight-character booking reference an
 *    operator reads off a confirmation email;
 *  - the closed `PaymentStatus` and `PaymentSource` enums;
 *  - the five money columns, in cents;
 *  - the stored Stripe PaymentIntent ids (primary and additional). #2377 lists
 *    stored Stripe references as approved evidence, and a PaymentIntent id is
 *    what a Finance Officer types into the Stripe dashboard. The Stripe CUSTOMER
 *    and PAYMENT METHOD ids are NOT projected and NOT granted — they identify the
 *    stored instrument rather than this transaction, and no diagnostic question
 *    needs them;
 *  - the stored Xero invoice id, invoice number and refund credit-note id;
 *  - the internet-banking reference, bounded and stripped;
 *  - the internet-banking hold state, which is what decides whether a bed is
 *    still being held for an unpaid bank transfer;
 *  - whether the payment was settled BY HAND, which is the single most
 *    misread fact in this domain: a manually marked-paid row is an ordinary
 *    `INTERNET_BANKING` payment with no Stripe leg, so "refund it" means "hand the
 *    money back", not "click refund".
 */
const PAYMENT_SUMMARY_SQL = `SELECT
  p."id" AS payment_ref,
  p."bookingId" AS booking_id,
  pg_catalog.upper(pg_catalog.left(p."bookingId", 8)) AS booking_reference,
  p."status"::text AS payment_status,
  p."source"::text AS payment_source,
  p."amountCents" AS amount_cents,
  p."refundedAmountCents" AS refunded_amount_cents,
  p."changeFeeCents" AS change_fee_cents,
  p."additionalAmountCents" AS additional_amount_cents,
  p."creditAppliedCents" AS credit_applied_cents,
  p."additionalPaymentStatus" AS additional_payment_status,
  p."stripePaymentIntentId" AS stripe_payment_intent_id,
  p."additionalPaymentIntentId" AS additional_payment_intent_id,
  p."xeroInvoiceId" AS xero_invoice_id,
  p."xeroInvoiceNumber" AS xero_invoice_number,
  p."xeroRefundCreditNoteId" AS xero_refund_credit_note_id,
  p."reference" AS bank_reference,
  p."internetBankingHoldSlots" AS internet_banking_hold_slots,
  ${utcInstant('p."internetBankingHoldUntil"')} AS internet_banking_hold_until_utc,
  ${utcInstant('p."internetBankingHoldReleasedAt"')} AS internet_banking_hold_released_at_utc,
  ${utcInstant('p."manuallyMarkedPaidAt"')} AS manually_marked_paid_at_utc,
  ${utcInstant('p."createdAt"')} AS created_at_utc,
  ${utcInstant('p."updatedAt"')} AS updated_at_utc
FROM public."Payment" p
WHERE p."id" = $1::text`;

const paymentSummary = defineDiagnosticsTool<PaymentIdArgs>({
  id: DIAGNOSTICS_PAYMENT_SUMMARY_TOOL_ID,
  source: "select_only_sql",
  label: "Payment diagnostic summary",
  description: `Returns everything this platform has stored about ONE booking payment: its status and source (Stripe or internet banking), the amounts in integer cents (charged, refunded, change fee, additional payment, account credit applied), the additional-payment status, the stored Stripe PaymentIntent ids, the stored Xero invoice id, invoice number and refund credit-note id, the internet-banking reference and bed-hold state, whether it was settled by hand, and when it was created and last changed. Use it after finding a payment. It returns no Stripe customer or payment method id, no card data, no operator notes and no member name or email. ${FINANCE_DESCRIPTION_TAIL}`,
  requiredAreas: ["finance"],
  evidenceScope: `The stored state of ONE payment record. Amounts are integer cents; this platform records no currency on a payment because it is single-currency NZD, so do not report a currency for these figures. It does NOT include the payment's attempts, refunds, webhook history or Xero sync operations — those are separate tools, and a question about "what went wrong" usually needs them. A payment with manuallyMarkedPaidAtUtc set was settled BY HAND (cash or an off-Xero transfer) and has no Stripe leg to refund. updatedAtUtc is when ANY column on this row last changed — it is NOT when the provider status was last confirmed, and this platform stores no such instant, so never present updatedAtUtc as the freshness of the Stripe or Xero state. ${STORED_EVIDENCE_DISCLOSURE}`,
  argsSchema: paymentIdArgsSchema,
  inputSchema: paymentIdInputSchema,
  sql: PAYMENT_SUMMARY_SQL,
  bind: (args) => [args.paymentId],
  project: (row) => ({
    paymentRef: recordRefOrNull(row.payment_ref) ?? "",
    bookingId: recordRefOrNull(row.booking_id) ?? "",
    bookingReference: recordRefOrNull(row.booking_reference) ?? "",
    paymentStatus: stableCodeOrNull(row.payment_status),
    paymentSource: stableCodeOrNull(row.payment_source),
    amountCents: centsOrZero(row.amount_cents),
    refundedAmountCents: centsOrZero(row.refunded_amount_cents),
    changeFeeCents: centsOrZero(row.change_fee_cents),
    additionalAmountCents: centsOrZero(row.additional_amount_cents),
    creditAppliedCents: centsOrZero(row.credit_applied_cents),
    additionalPaymentStatus: stableCodeOrNull(row.additional_payment_status),
    stripePaymentIntentId: providerRefOrNull(row.stripe_payment_intent_id),
    additionalPaymentIntentId: providerRefOrNull(
      row.additional_payment_intent_id,
    ),
    xeroInvoiceId: providerRefOrNull(row.xero_invoice_id),
    xeroInvoiceNumber: providerRefOrNull(row.xero_invoice_number),
    xeroRefundCreditNoteId: providerRefOrNull(row.xero_refund_credit_note_id),
    bankReference: untrustedTextOrNull(row.bank_reference),
    internetBankingHoldSlots: boolOf(row.internet_banking_hold_slots),
    internetBankingHoldUntilUtc: instantOrNull(
      row.internet_banking_hold_until_utc,
    ),
    internetBankingHoldReleasedAtUtc: instantOrNull(
      row.internet_banking_hold_released_at_utc,
    ),
    manuallyMarkedPaidAtUtc: instantOrNull(row.manually_marked_paid_at_utc),
    createdAtUtc: instantOrNull(row.created_at_utc) ?? "",
    updatedAtUtc: instantOrNull(row.updated_at_utc) ?? "",
  }),
  rowLimit: 1,
  byteLimit: FINANCE_SINGLE_ROW_BYTE_LIMIT,
  // The internet-banking reference is whatever the payer typed into their bank,
  // and payers routinely type their own name.
  surfacesPersonalData: true,
  consentRecordKind: "payment",
  consentRecordArgKey: "paymentId",
  // The booking this payment is for. The Stripe/Xero references projected beside it
  // are PROVIDER references, not local records, and are deliberately not declared.
  relatedRecordRefs: [{ field: "bookingId", kind: "booking" }],
});

// ---------------------------------------------------------------------------
// 2. Attempts: the transaction ledger and the recovery queue, in one timeline.
// ---------------------------------------------------------------------------

/**
 * The closed catalogue that turns a `PaymentRecoveryOperation."idempotencyKey"`
 * prefix into a stable SCENARIO code, evaluated in SQL so the key itself is never
 * projected.
 *
 * Every prefix below is copied from `src/lib/payment-recovery-keys.ts` and
 * `src/lib/payment-recovery.ts`, which are the only writers. A key that matches
 * none of them projects `other_recovery`, which is honest: it means the platform
 * queued a recovery this catalogue does not recognise, and reporting an unknown
 * as one of the known scenarios would be worse than reporting it as unknown.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. Five different situations enqueue
 * `REFUND_BOOKING_MODIFICATION`: a booking cancellation, an approved refund
 * appeal, a capacity-race auto-refund, a duplicate-capture auto-refund and an
 * actual modification refund. A Finance Officer told "a booking modification
 * refund is pending" when the truth is "a duplicate card capture is being handed
 * back" will look in the wrong place, and the operation type is the only field
 * that would have told them — wrongly.
 */
const RECOVERY_SCENARIO_SQL = `CASE
    WHEN pg_catalog.starts_with(o."idempotencyKey", 'booking_cancel_refund_recovery_') THEN 'booking_cancellation_refund'
    WHEN pg_catalog.starts_with(o."idempotencyKey", 'capacity_claim_failed_refund_recovery_') THEN 'capacity_claim_failed_refund'
    WHEN pg_catalog.starts_with(o."idempotencyKey", 'duplicate_capture_') THEN 'duplicate_capture_refund'
    WHEN pg_catalog.starts_with(o."idempotencyKey", 'refund_request_refund_') THEN 'refund_appeal_refund'
    WHEN pg_catalog.starts_with(o."idempotencyKey", 'payment_recovery_cancel_') THEN 'payment_intent_cancel'
    WHEN pg_catalog.starts_with(o."idempotencyKey", 'payment_recovery_refund_') THEN 'booking_modification_refund'
    WHEN pg_catalog.starts_with(o."idempotencyKey", 'payment_recovery_additional_intent_') THEN 'additional_payment_intent'
    ELSE 'other_recovery'
  END`;

/**
 * ATTEMPTS, as one timeline across two relations that answer different halves of
 * "what has this platform tried".
 *
 *  - `PaymentTransaction` is the LEDGER: one row per captured or attempted
 *    charge, PRIMARY or ADDITIONAL, with its own Stripe intent, Xero invoice and
 *    internet-banking reference. Several rows with the same amount and different
 *    intents is what a duplicate attempt looks like.
 *  - `PaymentRecoveryOperation` is the QUEUE: the durable debt the platform owes
 *    itself — a cancel or a refund it has undertaken to execute at Stripe, with
 *    an attempt count. A `FAILED` row at five attempts is EXHAUSTED and will not
 *    retry, which is the single most important operational fact in this pack and
 *    is why `attemptCount` is projected on every row.
 *
 * They are UNIONed rather than offered as two tools because the question an
 * operator asks — "why is this payment stuck?" — is answered by the interleaving.
 * The `entryKind` column keeps them distinguishable, and no field means two
 * different things across the arms.
 */
const ATTEMPT_LEDGER_SQL = `SELECT
  'transaction' AS entry_kind,
  t."id" AS entry_ref,
  t."kind"::text AS kind_code,
  t."source"::text AS source_code,
  t."status"::text AS status_code,
  t."amountCents" AS amount_cents,
  t."refundedAmountCents" AS refunded_amount_cents,
  t."stripePaymentIntentId" AS provider_ref,
  t."xeroInvoiceNumber" AS xero_invoice_number,
  t."reference" AS bank_reference,
  NULL::text AS scenario_code,
  0 AS attempt_count,
  NULL::text AS settled_at_utc,
  ${utcInstant('t."createdAt"')} AS occurred_at_utc,
  ${utcInstant('t."updatedAt"')} AS updated_at_utc
FROM public."PaymentTransaction" t
WHERE t."paymentId" = $1::text
UNION ALL
SELECT
  'recovery_operation' AS entry_kind,
  o."id" AS entry_ref,
  o."type"::text AS kind_code,
  NULL::text AS source_code,
  o."status"::text AS status_code,
  o."amountCents" AS amount_cents,
  0 AS refunded_amount_cents,
  NULL::text AS provider_ref,
  NULL::text AS xero_invoice_number,
  NULL::text AS bank_reference,
  ${RECOVERY_SCENARIO_SQL} AS scenario_code,
  o."attempts" AS attempt_count,
  ${utcInstant('o."succeededAt"')} AS settled_at_utc,
  ${utcInstant('o."createdAt"')} AS occurred_at_utc,
  ${utcInstant('o."updatedAt"')} AS updated_at_utc
FROM public."PaymentRecoveryOperation" o
WHERE o."paymentId" = $1::text
ORDER BY occurred_at_utc DESC, entry_ref ASC`;

/**
 * Fourteen rows. A payment with more than fourteen ledger and recovery entries
 * between them is pathological, and the executor reports the truncation honestly
 * rather than presenting a partial timeline as complete. Measured against this
 * projection's own widest values by the registry contract test.
 */
const ATTEMPT_LEDGER_ROW_LIMIT = 14;

const attemptLedger = defineDiagnosticsTool<PaymentIdArgs>({
  id: DIAGNOSTICS_PAYMENT_ATTEMPT_LEDGER_TOOL_ID,
  source: "select_only_sql",
  label: "Payment attempts and recovery queue",
  description: `Returns ONE payment's charge attempts and the platform's own pending recovery work, newest first. Two kinds of row: "transaction" is a charge attempt (primary or additional) with its own Stripe PaymentIntent, Xero invoice number, internet-banking reference and amount in cents; "recovery_operation" is a cancel or refund this platform has undertaken to execute at Stripe, with the number of attempts made and a scenario code saying WHY it was queued. A recovery operation with status FAILED and attemptCount 5 is EXHAUSTED — it will not retry on its own and needs an administrator. Use it to see duplicate or failed attempts, an unfinished refund, or an uncollected additional payment. It returns no error text, no Stripe idempotency keys and no operator notes. ${FINANCE_DESCRIPTION_TAIL}`,
  requiredAreas: ["finance"],
  evidenceScope: `The charge attempts and queued recovery operations for ONE payment, at most ${ATTEMPT_LEDGER_ROW_LIMIT} of them, newest first. A recovery operation's scenarioCode comes from the platform's own queue key: several very different situations share the operation type REFUND_BOOKING_MODIFICATION, so report the scenarioCode and NOT the type when you say why a refund is pending. attemptCount is the recovery queue's own counter; a transaction row always shows 0 because charge attempts are not retried by a counter. The maximum recovery attempt count is 5, after which a FAILED operation is exhausted and will never retry. An empty result means EITHER that no payment with that id exists OR that the payment exists and has no attempts or recovery work recorded — this tool cannot tell those apart, and a booking id looks exactly like a payment id, so confirm the id with the payment search or the payment summary before reporting an absence. ${STORED_EVIDENCE_DISCLOSURE}`,
  argsSchema: paymentIdArgsSchema,
  inputSchema: paymentIdInputSchema,
  sql: ATTEMPT_LEDGER_SQL,
  bind: (args) => [args.paymentId],
  project: (row) => ({
    entryKind: stableCodeOrNull(row.entry_kind) ?? "unknown",
    entryRef: recordRefOrNull(row.entry_ref) ?? "",
    kindCode: stableCodeOrNull(row.kind_code),
    sourceCode: stableCodeOrNull(row.source_code),
    statusCode: stableCodeOrNull(row.status_code),
    amountCents: centsOrZero(row.amount_cents),
    refundedAmountCents: centsOrZero(row.refunded_amount_cents),
    providerRef: providerRefOrNull(row.provider_ref),
    xeroInvoiceNumber: providerRefOrNull(row.xero_invoice_number),
    bankReference: untrustedTextOrNull(row.bank_reference),
    scenarioCode: stableCodeOrNull(row.scenario_code),
    attemptCount: countOf(row.attempt_count),
    settledAtUtc: instantOrNull(row.settled_at_utc),
    occurredAtUtc: instantOrNull(row.occurred_at_utc) ?? "",
    updatedAtUtc: instantOrNull(row.updated_at_utc) ?? "",
  }),
  rowLimit: ATTEMPT_LEDGER_ROW_LIMIT,
  byteLimit: FINANCE_BYTE_LIMIT,
  surfacesPersonalData: true,
  // No related ref: `entryRef` is the ledger row's own id, whose kind varies with
  // `entryKind`, and `providerRef` is a provider reference. Neither is a local
  // record this ledger could be asked about.
  consentRecordKind: "payment",
  consentRecordArgKey: "paymentId",
});

// ---------------------------------------------------------------------------
// 3. Refunds: four different things that are all called "the refund".
// ---------------------------------------------------------------------------

/**
 * FOUR RELATIONS, ONE ANSWER, because this domain has four separate records that
 * an operator will all call "the refund" and that mean different things:
 *
 *  - `refund_appeal` (`RefundRequest`) — the MEMBER asked. `PENDING` means nobody
 *    has decided yet. Approving it does not move money by itself.
 *  - `refund_execution` (`PaymentRecoveryOperation`, refund types only) — the
 *    platform's undertaking to execute a refund at Stripe. `PENDING`/`PROCESSING`
 *    is money that has NOT moved yet; `FAILED` at five attempts is exhausted.
 *  - `stripe_refund` (`PaymentRefund`) — the immutable ledger of a refund Stripe
 *    actually performed, with its own id, amount, CURRENCY and Stripe status.
 *    This is the only relation in the pack that stores a currency.
 *  - `manual_refund_task` (`ManualRefundTask`) — money that must be handed back
 *    BY A HUMAN because there is no card to refund (a cash or bank-transfer
 *    settlement). `OPEN` means somebody still owes the member money.
 *
 * A model that collapses these will tell a Finance Officer a refund is done when
 * a member has merely asked for one, or that one is pending when the platform has
 * already paid it. So the `entryKind` is projected on every row, each arm's own
 * status vocabulary is preserved rather than normalised into a common one, and
 * the description spells the four apart.
 *
 * `RefundRequest` is reached through the payment's own `bookingId` rather than
 * being keyed separately, so the whole answer still hangs off one exact payment
 * id and there is still no way to list refunds across bookings.
 */
const REFUND_STATE_SQL = `SELECT
  'stripe_refund' AS entry_kind,
  r."id" AS entry_ref,
  r."status" AS status_code,
  r."amountCents" AS amount_cents,
  NULL::int AS secondary_amount_cents,
  r."currency" AS currency_code,
  r."stripeRefundId" AS provider_ref,
  r."stripeChargeId" AS secondary_provider_ref,
  (r."xeroRefundCreditNoteId" IS NOT NULL) AS has_xero_credit_note,
  NULL::text AS scenario_code,
  0 AS attempt_count,
  ${utcInstant('r."stripeCreatedAt"')} AS settled_at_utc,
  ${utcInstant('r."createdAt"')} AS occurred_at_utc
FROM public."PaymentRefund" r
WHERE r."paymentId" = $1::text
UNION ALL
SELECT
  'refund_execution' AS entry_kind,
  o."id" AS entry_ref,
  o."status"::text AS status_code,
  o."amountCents" AS amount_cents,
  NULL::int AS secondary_amount_cents,
  NULL::text AS currency_code,
  NULL::text AS provider_ref,
  NULL::text AS secondary_provider_ref,
  false AS has_xero_credit_note,
  ${RECOVERY_SCENARIO_SQL} AS scenario_code,
  o."attempts" AS attempt_count,
  ${utcInstant('o."succeededAt"')} AS settled_at_utc,
  ${utcInstant('o."createdAt"')} AS occurred_at_utc
FROM public."PaymentRecoveryOperation" o
WHERE o."paymentId" = $1::text
  AND o."type"::text <> 'CREATE_ADDITIONAL_PAYMENT_INTENT'
UNION ALL
SELECT
  'manual_refund_task' AS entry_kind,
  m."id" AS entry_ref,
  m."status"::text AS status_code,
  m."amountCents" AS amount_cents,
  NULL::int AS secondary_amount_cents,
  NULL::text AS currency_code,
  NULL::text AS provider_ref,
  NULL::text AS secondary_provider_ref,
  false AS has_xero_credit_note,
  'hand_back_required' AS scenario_code,
  0 AS attempt_count,
  ${utcInstant('m."completedAt"')} AS settled_at_utc,
  ${utcInstant('m."createdAt"')} AS occurred_at_utc
FROM public."ManualRefundTask" m
WHERE m."paymentId" = $1::text
UNION ALL
SELECT
  'refund_appeal' AS entry_kind,
  q."id" AS entry_ref,
  q."status"::text AS status_code,
  q."requestedAmountCents" AS amount_cents,
  q."approvedAmountCents" AS secondary_amount_cents,
  NULL::text AS currency_code,
  NULL::text AS provider_ref,
  NULL::text AS secondary_provider_ref,
  false AS has_xero_credit_note,
  'member_requested' AS scenario_code,
  0 AS attempt_count,
  ${utcInstant('q."reviewedAt"')} AS settled_at_utc,
  ${utcInstant('q."createdAt"')} AS occurred_at_utc
FROM public."RefundRequest" q
JOIN public."Payment" p2 ON p2."bookingId" = q."bookingId"
WHERE p2."id" = $1::text
ORDER BY occurred_at_utc DESC, entry_ref ASC`;

const REFUND_STATE_ROW_LIMIT = 14;

const refundState = defineDiagnosticsTool<PaymentIdArgs>({
  id: DIAGNOSTICS_PAYMENT_REFUND_STATE_TOOL_ID,
  source: "select_only_sql",
  label: "Refund state for a payment",
  description: `Returns every refund record attached to ONE payment, newest first, keeping FOUR different things apart that people all call "the refund". refund_appeal is the member ASKING (PENDING means undecided; approving it does not itself move money). refund_execution is this platform's queued undertaking to refund at Stripe (PENDING or PROCESSING means the money has NOT moved; FAILED at 5 attempts is exhausted and needs an administrator). stripe_refund is a refund Stripe actually performed, with its own id, amount, currency and Stripe status. manual_refund_task is money a HUMAN must hand back because there is no card to refund — OPEN means somebody still owes the member. Never merge these four or report one as another. It returns no refund reasons, no admin notes and no member name. ${FINANCE_DESCRIPTION_TAIL}`,
  requiredAreas: ["finance"],
  evidenceScope: `Refund records for ONE payment, at most ${REFUND_STATE_ROW_LIMIT}, newest first. amountCents means the refunded amount on a stripe_refund, the queued amount on a refund_execution, the amount owed on a manual_refund_task, and the amount REQUESTED on a refund_appeal — where secondaryAmountCents is the amount approved. currencyCode is stored only on a Stripe refund; a null there means the platform recorded none, not that it is not NZD. A booking whose payment was settled by hand has no Stripe leg, so its refund appears as a manual_refund_task and NOT as a stripe_refund. An empty result means EITHER that no payment with that id exists OR that the payment exists and no refund of any of the four kinds was ever recorded against it — this tool cannot tell those apart, and a booking id looks exactly like a payment id, so confirm the id with the payment search or the payment summary before reporting that no refund happened. ${STORED_EVIDENCE_DISCLOSURE}`,
  argsSchema: paymentIdArgsSchema,
  inputSchema: paymentIdInputSchema,
  sql: REFUND_STATE_SQL,
  bind: (args) => [args.paymentId],
  project: (row) => ({
    entryKind: stableCodeOrNull(row.entry_kind) ?? "unknown",
    entryRef: recordRefOrNull(row.entry_ref) ?? "",
    statusCode: stableCodeOrNull(row.status_code),
    amountCents: centsOrNull(row.amount_cents),
    secondaryAmountCents: centsOrNull(row.secondary_amount_cents),
    currencyCode: stableCodeOrNull(row.currency_code),
    providerRef: providerRefOrNull(row.provider_ref),
    secondaryProviderRef: providerRefOrNull(row.secondary_provider_ref),
    hasXeroCreditNote: boolOf(row.has_xero_credit_note),
    scenarioCode: stableCodeOrNull(row.scenario_code),
    attemptCount: countOf(row.attempt_count),
    settledAtUtc: instantOrNull(row.settled_at_utc),
    occurredAtUtc: instantOrNull(row.occurred_at_utc) ?? "",
  }),
  rowLimit: REFUND_STATE_ROW_LIMIT,
  byteLimit: FINANCE_BYTE_LIMIT,
  // No free text and no member reference reaches this projection.
  surfacesPersonalData: false,
  // It is still evidence about ONE named payment, so the investigation has to cover
  // that payment (#2785 review). Without this declaration the refund amounts,
  // statuses and provider references of a payment the ledger has just refused for
  // `payment_summary` would still be readable through this entry.
  consentRecordKind: "payment",
  consentRecordArgKey: "paymentId",
});

// ---------------------------------------------------------------------------
// 4. Webhooks: what arrived, whether it was processed, and how many times.
// ---------------------------------------------------------------------------

const WEBHOOK_PROVIDERS = ["stripe", "xero"] as const;

const webhookArgsSchema = z
  .object({
    provider: z.enum(WEBHOOK_PROVIDERS),
    eventRef: EXACT_REFERENCE,
  })
  .strict();

type WebhookArgs = z.infer<typeof webhookArgsSchema>;

const WEBHOOK_TIMELINE_ROW_LIMIT = 14;

/**
 * THREE LEDGERS, and the reason all three are needed to answer one question.
 *
 *  - `ProcessedWebhookEvent` is the idempotency LEASE, one row per
 *    (provider, event id). `PROCESSING` means a handler took the lease and has
 *    not finished — a `PROCESSING` row much older than the lease window is a
 *    crashed attempt, which is what "the webhook arrived and nothing happened"
 *    actually looks like. It carries no attempt COUNTER, and this pack does not
 *    invent one: `WebhookLog` rows are the redelivery evidence.
 *  - `WebhookLog` is the delivery log, one row per delivery ATTEMPT with a
 *    success/failure outcome and a duration. SEVERAL rows for one event id is a
 *    provider redelivery — which is what a duplicate event looks like — and their
 *    order is what an out-of-order delivery looks like. Its `error` column is raw
 *    handler text and is neither granted nor projected.
 *  - `XeroInboundEvent` is Xero's own inbound ledger, matched on the Xero
 *    RESOURCE id or the correlation key, so an operator holding a Xero invoice id
 *    can ask what arrived for it. Its `payload` column is the only raw provider
 *    body in this schema and is not granted.
 *
 * MISSING IS AN ANSWER TOO. An empty result means no webhook was recorded for
 * that reference at all, which — for a payment that Stripe says succeeded — is
 * the finding, not a failure of the tool. The scope line says so, because
 * `not_found` alone would read as "there is nothing to report".
 *
 * THE LEASE ARM'S ENTRY REFERENCE IS ITS EVENT ID, NOT ITS SURROGATE KEY.
 * `ProcessedWebhookEvent."id"` is not granted: the row's identity is its
 * `(source, eventId)` unique constraint, both halves of which this statement
 * filters to one value, so the arm contributes at most one row and the ordering
 * stays total without it. Leaving the surrogate ungranted also keeps every
 * column-granted relation in the allowlist strictly narrower than its table,
 * which is the property the real-PostgreSQL proof asserts relation by relation.
 */
const WEBHOOK_TIMELINE_SQL = `SELECT
  'processing_lease' AS entry_kind,
  w."eventId" AS entry_ref,
  w."source" AS provider_code,
  w."eventType" AS event_type,
  w."eventId" AS event_ref,
  w."status" AS status_code,
  NULL::text AS category_code,
  0 AS duration_ms,
  ${utcInstant('w."processingStartedAt"')} AS started_at_utc,
  ${utcInstant('w."processedAt"')} AS processed_at_utc,
  ${utcInstant('w."processedAt"')} AS occurred_at_utc
FROM public."ProcessedWebhookEvent" w
WHERE w."source" = $1::text AND w."eventId" = $2::text
UNION ALL
SELECT
  'delivery_attempt' AS entry_kind,
  l."id" AS entry_ref,
  l."source" AS provider_code,
  l."eventType" AS event_type,
  l."eventId" AS event_ref,
  l."status" AS status_code,
  NULL::text AS category_code,
  l."durationMs" AS duration_ms,
  NULL::text AS started_at_utc,
  NULL::text AS processed_at_utc,
  ${utcInstant('l."createdAt"')} AS occurred_at_utc
FROM public."WebhookLog" l
WHERE l."source" = $1::text AND l."eventId" = $2::text
UNION ALL
SELECT
  'xero_inbound_event' AS entry_kind,
  x."id" AS entry_ref,
  'xero' AS provider_code,
  x."eventType" AS event_type,
  x."resourceId" AS event_ref,
  x."status" AS status_code,
  x."eventCategory" AS category_code,
  0 AS duration_ms,
  ${utcInstant('x."eventCreatedAt"')} AS started_at_utc,
  ${utcInstant('x."processedAt"')} AS processed_at_utc,
  ${utcInstant('x."createdAt"')} AS occurred_at_utc
FROM public."XeroInboundEvent" x
WHERE $1::text = 'xero'
  AND (x."resourceId" = $2::text OR x."correlationKey" = $2::text)
ORDER BY occurred_at_utc DESC, entry_ref ASC`;

const webhookTimeline = defineDiagnosticsTool<WebhookArgs>({
  id: DIAGNOSTICS_FINANCE_WEBHOOK_TIMELINE_TOOL_ID,
  source: "select_only_sql",
  label: "Webhook receipt and processing timeline",
  description: `Returns what this platform recorded when a Stripe or Xero webhook arrived for ONE exact provider event id (for Xero, also a Xero resource id or correlation key). Three kinds of row: "processing_lease" is the idempotency claim — status PROCESSING means a handler took it and did not finish, status COMPLETED means it did; "delivery_attempt" is one delivery, with success or failure and how long it took — SEVERAL of these for one event id is a provider REDELIVERY, and that is what a duplicate event looks like; "xero_inbound_event" is Xero's own inbound record with its category and processed instant. An EMPTY result means no webhook was recorded for that reference at all, which for a payment the provider believes succeeded is itself the finding. It returns no webhook payloads, no signatures and no error text — only the stable status codes. ${FINANCE_DESCRIPTION_TAIL}`,
  requiredAreas: ["finance"],
  evidenceScope: `Webhook records matching ONE exact provider event reference, at most ${WEBHOOK_TIMELINE_ROW_LIMIT}, newest first. Nothing matching means nothing was RECORDED for that exact reference — it does not mean the provider never sent one, and it does not mean the payment did not happen; say which reference was searched. Only Stripe and Xero are searched. There is no per-event attempt counter in this platform: count the delivery_attempt rows instead. Webhook logs are pruned after about 30 days, so an old event legitimately has a processing lease and no delivery attempts. ${STORED_EVIDENCE_DISCLOSURE}`,
  argsSchema: webhookArgsSchema,
  inputSchema: {
    type: "object",
    properties: {
      provider: {
        type: "string",
        enum: [...WEBHOOK_PROVIDERS],
        description: "Which provider's webhook records to search.",
      },
      eventRef: {
        type: "string",
        description:
          "The EXACT provider event id. For Xero this may also be a Xero resource id or a correlation key. At least 6 characters; no wildcards.",
      },
    },
    required: ["provider", "eventRef"],
    additionalProperties: false,
  },
  sql: WEBHOOK_TIMELINE_SQL,
  bind: (args) => [args.provider, args.eventRef],
  project: (row) => ({
    entryKind: stableCodeOrNull(row.entry_kind) ?? "unknown",
    entryRef: recordRefOrNull(row.entry_ref) ?? "",
    providerCode: stableCodeOrNull(row.provider_code),
    eventType: stableCodeOrNull(row.event_type),
    eventRef: providerRefOrNull(row.event_ref),
    statusCode: stableCodeOrNull(row.status_code),
    categoryCode: stableCodeOrNull(row.category_code),
    durationMs: countOf(row.duration_ms),
    startedAtUtc: instantOrNull(row.started_at_utc),
    processedAtUtc: instantOrNull(row.processed_at_utc),
    occurredAtUtc: instantOrNull(row.occurred_at_utc),
  }),
  rowLimit: WEBHOOK_TIMELINE_ROW_LIMIT,
  byteLimit: FINANCE_BYTE_LIMIT,
  surfacesPersonalData: false,
  // NO CONSENT RECORD, and deliberately (#2785 review) — now stated as a DECLARATION
  // rather than a comment, because `defineDiagnosticsTool` refuses to define an entry
  // that takes an exact identifier and answers none of the three ways (#2785 delta
  // review). What bounds this one instead: it reads webhook plumbing only — arrival,
  // lease, delivery attempts, status codes — with no person, no amount and no record
  // id of a consentable kind in the projection.
  consentRecordExemption:
    "eventRef is a PROVIDER event reference — a Stripe event id, a Xero resource id or a correlation key — not a platform record id. It is not a kind the investigation ledger can hold and not something an operator can select, so no inclusion decision could ever cover it; declaring a record kind here would refuse every invocation while pretending to be a gate.",
});

// ---------------------------------------------------------------------------
// 5. Xero linkage for a local record.
// ---------------------------------------------------------------------------

/**
 * The local record kinds this entry will look up, and `Member` is DELIBERATELY
 * ABSENT.
 *
 * A member's Xero linkage is membership evidence as well as finance evidence, and
 * the epic's rule is that a tool combining the two requires both areas. An
 * argument cannot decide an authorization rule — `invoke.ts` authorizes before it
 * parses arguments — so the member case is a SEPARATE entry with a separate,
 * stricter permission set (`xero_contact_linkage` below) rather than one more
 * value in this enum. Adding `Member` here would silently move member-linked
 * evidence behind `finance:view` alone.
 */
const XERO_LOCAL_MODELS = [
  "Booking",
  "Payment",
  "PaymentTransaction",
  "MemberCredit",
  "MemberCreditNoteAllocation",
  "MembershipSubscriptionCharge",
  "GroupBookingSettlement",
] as const;

const xeroLinkageArgsSchema = z
  .object({
    localModel: z.enum(XERO_LOCAL_MODELS),
    localId: RECORD_ID,
  })
  .strict();

type XeroLinkageArgs = z.infer<typeof xeroLinkageArgsSchema>;

const XERO_LINKAGE_ROW_LIMIT = 14;

/**
 * `XeroObjectLink` is WHAT IS LINKED; `XeroSyncOperation` is WHAT WAS TRIED.
 * Neither alone answers "why has this invoice not appeared in Xero", so both are
 * returned as one timeline keyed on the same local record.
 *
 * An inactive link is kept rather than filtered: a link that WAS active and is
 * not any more is the evidence that something was unlinked, and hiding it would
 * make a re-link look like a first attempt.
 *
 * `lastErrorCode` is projected and `lastErrorMessage` is not. The code is a
 * stable classification; the message is Xero's own prose, which can quote a
 * payload and is not granted to this credential at all.
 */
const XERO_LINKAGE_SQL = `SELECT
  'object_link' AS entry_kind,
  k."id" AS entry_ref,
  k."xeroObjectType" AS xero_object_type,
  k."xeroObjectId" AS xero_object_id,
  k."xeroObjectNumber" AS xero_object_number,
  k."role" AS role_code,
  k."active" AS is_active,
  NULL::text AS status_code,
  NULL::text AS operation_type_code,
  NULL::text AS direction_code,
  0 AS attempt_count,
  false AS is_replayable,
  NULL::text AS last_error_code,
  false AS manually_resolved,
  NULL::text AS started_at_utc,
  NULL::text AS completed_at_utc,
  ${utcInstant('k."createdAt"')} AS occurred_at_utc,
  ${utcInstant('k."updatedAt"')} AS updated_at_utc
FROM public."XeroObjectLink" k
WHERE k."localModel" = $1::text AND k."localId" = $2::text
UNION ALL
SELECT
  'sync_operation' AS entry_kind,
  s."id" AS entry_ref,
  s."xeroObjectType" AS xero_object_type,
  s."xeroObjectId" AS xero_object_id,
  s."xeroObjectNumber" AS xero_object_number,
  NULL::text AS role_code,
  false AS is_active,
  s."status" AS status_code,
  s."operationType" AS operation_type_code,
  s."direction" AS direction_code,
  s."attemptCount" AS attempt_count,
  s."replayable" AS is_replayable,
  s."lastErrorCode" AS last_error_code,
  (s."manuallyResolvedAt" IS NOT NULL) AS manually_resolved,
  ${utcInstant('s."startedAt"')} AS started_at_utc,
  ${utcInstant('s."completedAt"')} AS completed_at_utc,
  ${utcInstant('s."createdAt"')} AS occurred_at_utc,
  ${utcInstant('s."updatedAt"')} AS updated_at_utc
FROM public."XeroSyncOperation" s
WHERE s."localModel" = $1::text AND s."localId" = $2::text
ORDER BY occurred_at_utc DESC, entry_ref ASC`;

function projectXeroLinkageRow(row: Record<string, unknown>) {
  return {
    entryKind: stableCodeOrNull(row.entry_kind) ?? "unknown",
    entryRef: recordRefOrNull(row.entry_ref) ?? "",
    xeroObjectType: stableCodeOrNull(row.xero_object_type),
    xeroObjectId: providerRefOrNull(row.xero_object_id),
    xeroObjectNumber: providerRefOrNull(row.xero_object_number),
    roleCode: stableCodeOrNull(row.role_code),
    isActive: boolOf(row.is_active),
    statusCode: stableCodeOrNull(row.status_code),
    operationTypeCode: stableCodeOrNull(row.operation_type_code),
    directionCode: stableCodeOrNull(row.direction_code),
    attemptCount: countOf(row.attempt_count),
    isReplayable: boolOf(row.is_replayable),
    lastErrorCode: stableCodeOrNull(row.last_error_code),
    manuallyResolved: boolOf(row.manually_resolved),
    startedAtUtc: instantOrNull(row.started_at_utc),
    completedAtUtc: instantOrNull(row.completed_at_utc),
    occurredAtUtc: instantOrNull(row.occurred_at_utc) ?? "",
    updatedAtUtc: instantOrNull(row.updated_at_utc) ?? "",
  };
}

const XERO_LINKAGE_SCOPE_TAIL =
  "An object_link row is WHAT IS LINKED in Xero; a sync_operation row is WHAT THIS PLATFORM TRIED. Inactive links are included on purpose — a link that was active and is not any more is the evidence that something was unlinked. An ACTIVE object_link is NOT history: an active link sitting beside a member_contact row that carries no xeroObjectId is this platform's documented partial-unlink state (see the Xero architecture notes), where the member record was unlinked and the object links were not, and it needs an administrator rather than a re-read. A sync operation carries a stable lastErrorCode only; Xero's own error message is never retrieved. A manually resolved operation was closed by an administrator who fixed it directly in Xero, so it is deliberately excluded from the platform's own failure counts. \"Linked\" here means only that THIS PLATFORM holds the identifier: it cannot tell you whether the Xero contact has since been archived or the invoice voided in Xero, and neither can any other diagnostics tool. An empty result means EITHER that no record with that id exists OR that the record exists and has never been linked to Xero or had a sync run for it — this tool cannot tell those apart, so confirm the id first.";

const xeroInvoiceLinkage = defineDiagnosticsTool<XeroLinkageArgs>({
  id: DIAGNOSTICS_XERO_INVOICE_LINKAGE_TOOL_ID,
  source: "select_only_sql",
  label: "Xero invoice and sync state for a record",
  description: `Returns what this platform has linked to Xero for ONE local record (a booking, payment, transaction, member credit, credit allocation, subscription charge or group settlement), and every Xero sync operation it ran for that record, newest first. "object_link" rows carry the Xero object type, id, number, the role it plays and whether the link is still active — an INACTIVE one is history, an ACTIVE one is a live claim about what exists in Xero right now. "sync_operation" rows carry the operation's status, type, direction, attempt count, whether it can be replayed, a stable error code, and whether an administrator resolved it by hand in Xero. Use it to answer why an invoice, credit note or allocation has not appeared in Xero. Member-to-Xero-contact linkage is a DIFFERENT tool that also needs membership access. It returns no Xero payloads, no Xero error messages and no operator notes. ${FINANCE_DESCRIPTION_TAIL}`,
  requiredAreas: ["finance"],
  evidenceScope: `Xero links and sync operations for ONE local record, at most ${XERO_LINKAGE_ROW_LIMIT}, newest first. ${XERO_LINKAGE_SCOPE_TAIL} This tool does NOT cover a member's Xero CONTACT linkage — that needs membership access as well as finance access, and is its own tool. ${STORED_EVIDENCE_DISCLOSURE}`,
  argsSchema: xeroLinkageArgsSchema,
  inputSchema: {
    type: "object",
    properties: {
      localModel: {
        type: "string",
        enum: [...XERO_LOCAL_MODELS],
        description:
          "Which kind of local record to look up. Member is deliberately not available here — use diagnostics.xero_contact_linkage, which needs membership access too.",
      },
      localId: {
        type: "string",
        description: "The EXACT id of that local record.",
      },
    },
    required: ["localModel", "localId"],
    additionalProperties: false,
  },
  sql: XERO_LINKAGE_SQL,
  bind: (args) => [args.localModel, args.localId],
  project: projectXeroLinkageRow,
  rowLimit: XERO_LINKAGE_ROW_LIMIT,
  byteLimit: FINANCE_BYTE_LIMIT,
  surfacesPersonalData: false,
  // Per-record evidence whose record KIND is the `localModel` argument (#2785
  // review). Two of the seven models are kinds an operator can include in an
  // investigation; the other five are finance sub-records the ledger cannot express,
  // so they are declared `null` and refuse. That is the fail-closed reading of
  // ADR-004 §1's bound rather than a gap: a PaymentTransaction or a credit-note
  // allocation is reachable through the payment or member it belongs to, and if an
  // operator needs to name one directly that is a record-picker decision for #2378,
  // not something this gate should quietly allow.
  consentRecordArgKey: "localId",
  consentRecordKindByArg: {
    argKey: "localModel",
    kinds: {
      Booking: "booking",
      Payment: "payment",
      PaymentTransaction: null,
      MemberCredit: null,
      MemberCreditNoteAllocation: null,
      MembershipSubscriptionCharge: null,
      GroupBookingSettlement: null,
    },
  },
});

// ---------------------------------------------------------------------------
// 6. A member's Xero contact linkage — the one entry that needs two areas.
// ---------------------------------------------------------------------------

const memberIdArgsSchema = z.object({ memberId: RECORD_ID }).strict();
type MemberIdArgs = z.infer<typeof memberIdArgsSchema>;

/**
 * THE ONE ENTRY IN THIS PACK THAT REQUIRES TWO AREAS, and the one that reads a
 * column of `Member`.
 *
 * The authoritative contact linkage is `Member."xeroContactId"` — the link table
 * carries the history, but the column is what the sync code reads — so answering
 * "is this member linked to a Xero contact" honestly needs it. TWO columns of
 * `Member` are granted to the diagnostics role, `"id"` and `"xeroContactId"`, and
 * they are the ONLY columns of that relation this credential may read: as the
 * diagnostics role, `SELECT "email" FROM "Member"` is refused by PostgreSQL
 * itself (42501), and so is `SELECT *`. The runtime self-check re-verifies the
 * granted columns against the same allowlist on a sixty-second TTL and refuses
 * the role if the grant ever widens to the table.
 *
 * NO NAME, NO EMAIL, NO PHONE, NO MEMBERSHIP STATE. The tool answers a linkage
 * question, not a "who is this" question: the operator supplied the member id, so
 * echoing it back discloses nothing they did not have, and everything else it
 * returns is a Xero identifier or a sync status. An operator who needs to see who
 * the member is opens the member's own admin screen, where the same permission
 * shows them far more. The alternative — granting `"firstName"`/`"lastName"` so a
 * diagnostic could confirm the person by name — was rejected: it widens a
 * least-privilege credential's reach into member PII to save one click, and #2377
 * permits identifying information without requiring it.
 *
 * `surfacesPersonalData` is TRUE regardless. A member id plus a Xero contact id is
 * a correlation about a specific person, which is exactly what ADR-004's
 * per-invocation opt-in exists for.
 */
const XERO_CONTACT_LINKAGE_SQL = `SELECT
  'member_contact' AS entry_kind,
  mb."id" AS entry_ref,
  'Contact' AS xero_object_type,
  mb."xeroContactId" AS xero_object_id,
  NULL::text AS xero_object_number,
  'MEMBER_CONTACT' AS role_code,
  (mb."xeroContactId" IS NOT NULL) AS is_active,
  NULL::text AS status_code,
  NULL::text AS operation_type_code,
  NULL::text AS direction_code,
  0 AS attempt_count,
  false AS is_replayable,
  NULL::text AS last_error_code,
  false AS manually_resolved,
  NULL::text AS started_at_utc,
  NULL::text AS completed_at_utc,
  NULL::text AS occurred_at_utc,
  NULL::text AS updated_at_utc
FROM public."Member" mb
WHERE mb."id" = $1::text
UNION ALL
SELECT
  'object_link' AS entry_kind,
  k."id" AS entry_ref,
  k."xeroObjectType" AS xero_object_type,
  k."xeroObjectId" AS xero_object_id,
  k."xeroObjectNumber" AS xero_object_number,
  k."role" AS role_code,
  k."active" AS is_active,
  NULL::text AS status_code,
  NULL::text AS operation_type_code,
  NULL::text AS direction_code,
  0 AS attempt_count,
  false AS is_replayable,
  NULL::text AS last_error_code,
  false AS manually_resolved,
  NULL::text AS started_at_utc,
  NULL::text AS completed_at_utc,
  ${utcInstant('k."createdAt"')} AS occurred_at_utc,
  ${utcInstant('k."updatedAt"')} AS updated_at_utc
FROM public."XeroObjectLink" k
WHERE k."localModel" = 'Member' AND k."localId" = $1::text
UNION ALL
SELECT
  'sync_operation' AS entry_kind,
  s."id" AS entry_ref,
  s."xeroObjectType" AS xero_object_type,
  s."xeroObjectId" AS xero_object_id,
  s."xeroObjectNumber" AS xero_object_number,
  NULL::text AS role_code,
  false AS is_active,
  s."status" AS status_code,
  s."operationType" AS operation_type_code,
  s."direction" AS direction_code,
  s."attemptCount" AS attempt_count,
  s."replayable" AS is_replayable,
  s."lastErrorCode" AS last_error_code,
  (s."manuallyResolvedAt" IS NOT NULL) AS manually_resolved,
  ${utcInstant('s."startedAt"')} AS started_at_utc,
  ${utcInstant('s."completedAt"')} AS completed_at_utc,
  ${utcInstant('s."createdAt"')} AS occurred_at_utc,
  ${utcInstant('s."updatedAt"')} AS updated_at_utc
FROM public."XeroSyncOperation" s
WHERE s."localModel" = 'Member' AND s."localId" = $1::text
ORDER BY occurred_at_utc DESC NULLS FIRST, entry_ref ASC`;

const xeroContactLinkage = defineDiagnosticsTool<MemberIdArgs>({
  id: DIAGNOSTICS_XERO_CONTACT_LINKAGE_TOOL_ID,
  source: "select_only_sql",
  label: "Member Xero contact linkage",
  description: `Returns whether ONE member is linked to a Xero contact, and every Xero contact sync this platform ran for them. The "member_contact" row is the authoritative link — isActive false with no xeroObjectId means the member has NO Xero contact, which is why their invoices cannot be created. "object_link" rows include links that were unlinked, but an ACTIVE one is not history: an active CONTACT link beside a member_contact row with no xeroObjectId is a partial unlink — the member's pointer was cleared and the ledger rows were left active — and it needs an administrator to finish, not a re-read. "sync_operation" rows carry the sync status, attempt count and a stable error code. Needs BOTH finance and membership access, because it ties a member to a finance record. It returns no member name, email address, phone number or membership state — only the member id you supplied and Xero identifiers. ${FINANCE_DESCRIPTION_TAIL}`,
  requiredAreas: ["finance", "membership"],
  evidenceScope: `The Xero CONTACT linkage and contact sync operations for ONE member. ${XERO_LINKAGE_SCOPE_TAIL} It does not include the member's invoices or payments; those hang off the booking or payment record and are separate tools. It returns no member name, email address or phone number — this platform's diagnostics never do. ${STORED_EVIDENCE_DISCLOSURE}`,
  argsSchema: memberIdArgsSchema,
  inputSchema: {
    type: "object",
    properties: {
      memberId: {
        type: "string",
        description: "The EXACT member record id.",
      },
    },
    required: ["memberId"],
    additionalProperties: false,
  },
  sql: XERO_CONTACT_LINKAGE_SQL,
  bind: (args) => [args.memberId],
  project: projectXeroLinkageRow,
  rowLimit: XERO_LINKAGE_ROW_LIMIT,
  byteLimit: FINANCE_BYTE_LIMIT,
  // A member id correlated with a Xero contact id is a fact about a person.
  surfacesPersonalData: true,
  consentRecordKind: "member",
  consentRecordArgKey: "memberId",
});

// ---------------------------------------------------------------------------
// 7. The finance audit trail for one record.
// ---------------------------------------------------------------------------

/**
 * The record kinds an operator can ask for the finance audit history of, and the
 * `AuditLog."entityType"` values each one really means.
 *
 * THE ARGUMENT IS A NORMALISED DOMAIN WORD, never the raw column value: `bind`
 * closes over the server-owned array of column values each word covers, so the
 * model cannot name a column value at all and the mapping is reviewable in one
 * place.
 *
 * FOUR SUBJECTS WERE REMOVED HERE AND THE REASON MATTERS (#2377 review). An
 * earlier revision listed `xero_invoice → ["INVOICE"]`, `xero_contact →
 * ["CONTACT"]` and `xero_allocation → ["ALLOCATION"]`, and paired `"PAYMENT"`
 * with `"Payment"` and `"SUBSCRIPTION"` with `"MemberSubscription"`, on the
 * stated theory that this platform's audit writers use two casings. THEY DO NOT.
 * Every uppercase value of that shape in this tree is an argument to
 * `startXeroSyncOperation`, which writes `XeroSyncOperation."entityType"` — a
 * DIFFERENT relation that this entry does not query and is not granted. Every
 * real `AuditLog."entityType"` writer uses PascalCase. So those three subjects
 * could only ever return zero rows, and an empty result from a tool whose own
 * scope line says "nothing matching means nothing in THOSE categories matched"
 * is worse than no tool: it reads as evidence of absence.
 *
 * Xero sync history has a real home already — `diagnostics.xero_invoice_linkage`
 * and `diagnostics.xero_contact_linkage` read `XeroSyncOperation` directly, with
 * status, attempt count and a stable error code. Pointing an operator there is
 * the honest answer, and the entry's description says so.
 *
 * A SECOND REASON those three could not have worked: `RECORD_ID` accepts a
 * lowercase-alphanumeric cuid, and a Xero object id is a hyphenated GUID. The
 * argument shape could not express the id the subject needed.
 */
const FINANCE_AUDIT_SUBJECTS = {
  payment: ["Payment"],
  booking: ["Booking"],
  manual_refund_task: ["ManualRefundTask"],
  membership_subscription: ["MemberSubscription"],
} as const;

type FinanceAuditSubject = keyof typeof FINANCE_AUDIT_SUBJECTS;

const FINANCE_AUDIT_SUBJECT_KEYS = Object.keys(FINANCE_AUDIT_SUBJECTS) as [
  FinanceAuditSubject,
  ...FinanceAuditSubject[],
];

/**
 * The audit categories this entry may read — DERIVED from `audit-categories.ts`
 * rather than written out, exactly as AID-6A's correlation entries derive theirs.
 *
 * That keeps this tool in lockstep with #2581's canonical taxonomy: if a category
 * is reclassified into or out of the finance domain, this tool follows without an
 * edit, and it can never read a category the finance domain does not own. It is
 * `payment` and `xero` today.
 */
const FINANCE_AUDIT_CATEGORIES = auditCategoriesForCorrelationDomain("finance");

const financeAuditArgsSchema = z
  .object({
    subject: z.enum(FINANCE_AUDIT_SUBJECT_KEYS),
    recordId: RECORD_ID,
  })
  .strict();

type FinanceAuditArgs = z.infer<typeof financeAuditArgsSchema>;

const FINANCE_AUDIT_ROW_LIMIT = 18;

/**
 * PER-RECORD finance audit history — the thing AID-6A deliberately could not do.
 *
 * AID-6A granted eight columns of `AuditLog` and pointedly withheld `entityId`,
 * recording in its own pack doc that "per-record evidence — the member, the
 * booking, the payment — is AID-6B and AID-6C work, under their own area
 * permission and their own privacy review". This is that review, and its outcome
 * is: `entityId` is added to the column grant, and this is the only entry that
 * uses it.
 *
 * WHAT THAT DOES AND DOES NOT WIDEN. `entityId` is the id of the record an event
 * concerned; for the seven subjects above it is a payment, booking, invoice,
 * contact, allocation, task or subscription id. It is used here as a PREDICATE
 * against an id the caller already supplied — so the tool discloses which events
 * touched a record the operator is already looking at, and never enumerates. It
 * is NOT projected: the row carries the audit row's own id as its evidence
 * reference, and echoing the caller's own argument back on every row would only
 * spend the entry's byte ceiling.
 *
 * The three member-identifying columns (`memberId`, `actorMemberId`,
 * `subjectMemberId`), the free text (`summary`, `details`), the arbitrary
 * `metadata` JSON, and `ipAddress`/`userAgent` all remain ungranted, exactly as
 * AID-6A left them. So this entry can say that a refund event occurred on this
 * payment, at this instant, with this outcome — and cannot say who did it, from
 * where, or what they typed.
 *
 * THE CATEGORY FILTER IS THE PERMISSION BOUNDARY, and it carries AID-6A's
 * disclosure with it: an audit row written with NO category is matched by nothing
 * here. #2581's second child classified all 82 previously-uncategorised write
 * sites at the source, so the census now reads 455 write sites and ZERO
 * uncategorised (`scripts/audit/audit-writer-census-manifest.ts`, pinned by
 * `src/lib/__tests__/audit-writer-census.test.ts`) and no NEW row is born
 * invisible here. The gap has stopped growing, not closed: every row written
 * before that runtime deployed still carries `category = NULL`, including
 * money-adjacent ones (subscription billing, member-credit adjustments, fee
 * configuration, Xero settings and retries), and the historical backfill is
 * #2581's third child, outstanding. So an empty result here is still not
 * evidence that nothing happened, and the scope line says so in as many words.
 */
const FINANCE_AUDIT_SQL = `SELECT
  a."id" AS event_ref,
  a."action" AS action_code,
  a."category" AS category_code,
  a."severity" AS severity_code,
  a."outcome" AS outcome_code,
  a."entityType" AS entity_type,
  ${utcInstant('a."createdAt"')} AS occurred_at_utc
FROM public."AuditLog" a
WHERE a."entityType" = ANY ($1::text[])
  AND a."entityId" = $2::text
  AND a."category" = ANY ($3::text[])
ORDER BY a."createdAt" DESC, a."id" ASC`;

const financeAuditHistory = defineDiagnosticsTool<FinanceAuditArgs>({
  id: DIAGNOSTICS_FINANCE_AUDIT_HISTORY_TOOL_ID,
  source: "select_only_sql",
  label: "Finance audit history for a record",
  description: `Returns the platform's own finance audit events for ONE record — a payment, booking, manual refund task or membership subscription — newest first. Each row carries only stable codes and an instant: the event reference, the action code, the audit category, severity and outcome, what kind of record it concerned, and when it happened in UTC. Use it to see what the platform recorded happening to this record and in what order. The recordId is this platform's own record id, not a Xero identifier: there is no Xero-object subject here, because Xero work is recorded as sync operations rather than audit events — use the Xero invoice or contact linkage tools for that. It searches ONLY the finance audit categories (${FINANCE_AUDIT_CATEGORIES.join(", ")}); an administrator's change to payment SETTINGS is recorded under "admin" and is not here. It never returns who did it, event descriptions, stored metadata, IP addresses or error text. ${FINANCE_DESCRIPTION_TAIL}`,
  requiredAreas: ["finance"],
  evidenceScope: `Audit events recorded against ONE record, in the finance categories ${FINANCE_AUDIT_CATEGORIES.join(" and ")} only, at most ${FINANCE_AUDIT_ROW_LIMIT}, newest first. Nothing matching means nothing in THOSE categories matched — not that nothing happened. Two gaps make that qualification necessary rather than polite: an administrator's change to payment or internet-banking SETTINGS is recorded under the "admin" category, which this tool cannot read; and the audit category is optional, so a row recorded with NO category is matched by no diagnostics tool at all. Every write site now sets one, so no NEW row is born invisible — but every row written before that change deployed still carries no category, money-adjacent ones included (subscription billing, member-credit adjustments, fee configuration, Xero settings and retries), and backfilling them is outstanding. Never report that something did not happen on the strength of an empty result here; say that no categorised finance audit event matched, and point at Admin > Audit Log, which lists uncategorised rows as well. ${STORED_EVIDENCE_DISCLOSURE}`,
  argsSchema: financeAuditArgsSchema,
  inputSchema: {
    type: "object",
    properties: {
      subject: {
        type: "string",
        enum: [...FINANCE_AUDIT_SUBJECT_KEYS],
        description: "Which kind of record the id belongs to.",
      },
      recordId: {
        type: "string",
        description: "The EXACT id of that record.",
      },
    },
    required: ["subject", "recordId"],
    additionalProperties: false,
  },
  sql: FINANCE_AUDIT_SQL,
  // Three parameters, always: the entity-type values this subject covers (a
  // module constant closed over here, never an argument), the record id, and the
  // finance categories (derived from the canonical taxonomy, never an argument).
  bind: (args) => [
    [...FINANCE_AUDIT_SUBJECTS[args.subject]],
    args.recordId,
    [...FINANCE_AUDIT_CATEGORIES],
  ],
  project: (row) => ({
    eventRef: recordRefOrNull(row.event_ref) ?? "",
    action: stableCodeOrNull(row.action_code),
    categoryCode: stableCodeOrNull(row.category_code),
    severityCode: stableCodeOrNull(row.severity_code),
    outcomeCode: stableCodeOrNull(row.outcome_code),
    entityType: stableCodeOrNull(row.entity_type),
    occurredAtUtc: instantOrNull(row.occurred_at_utc) ?? "",
  }),
  rowLimit: FINANCE_AUDIT_ROW_LIMIT,
  byteLimit: FINANCE_BYTE_LIMIT,
  // Stable codes and an instant. No person, no free text, no identifier beyond
  // the audit row's own.
  surfacesPersonalData: false,
  // The history of ONE named record, so the investigation must cover that record
  // (#2785 review) — and the KIND is the `subject` argument, which is why the map
  // exists at all. A manual refund task and a membership subscription are not kinds
  // the ledger holds, so they refuse rather than running for any id the model can
  // name.
  consentRecordArgKey: "recordId",
  consentRecordKindByArg: {
    argKey: "subject",
    kinds: {
      payment: "payment",
      booking: "booking",
      manual_refund_task: null,
      membership_subscription: null,
    },
  },
});

/** The AID-6C per-record half, in presentation order. */
export const DIAGNOSTICS_FINANCE_RECORD_TOOLS: readonly DiagnosticsToolEntry[] =
  [
    paymentSummary,
    attemptLedger,
    refundState,
    webhookTimeline,
    xeroInvoiceLinkage,
    xeroContactLinkage,
    financeAuditHistory,
  ];
