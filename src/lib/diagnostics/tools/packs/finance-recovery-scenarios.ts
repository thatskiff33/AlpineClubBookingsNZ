// The closed catalogue behind the attempt ledger's and the refund state's
// `scenarioCode` (#4076). Split from `finance-records.ts`, which is over its
// size budget, along the seam the catalogue already had: it is data plus two
// strings derived from it, and nothing else in that file reads its entries.

import "server-only";

import {
  ADDITIONAL_INTENT_RECOVERY_PREFIX,
  BOOKING_CANCELLATION_REFUND_RECOVERY_PREFIX,
  BOOKING_MODIFICATION_REFUND_RECOVERY_PREFIX,
  CAPACITY_CLAIM_FAILED_REFUND_RECOVERY_PREFIX,
  CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX,
  CARD_REFUND_STILL_OWED_RECOVERY_PREFIX,
  CREDIT_RELEASE_ASK_RECOVERY_PREFIX,
  DUPLICATE_CAPTURE_REFUND_RECOVERY_PREFIX,
  EDIT_FINANCIAL_REVIEW_ADDITIONAL_INTENT_RECOVERY_PREFIX,
  EDIT_FINANCIAL_REVIEW_REFUND_RECOVERY_PREFIX,
  GROUP_SETTLEMENT_REFUND_RECOVERY_PREFIX,
  LATE_CAPTURE_APPROVAL_REFUND_RECOVERY_PREFIX,
  ORGANISER_CARD_APPEAL_REFUND_KEY_PREFIX,
  ORGANISER_CHILD_REFUND_KEY_PREFIX,
  PAYMENT_INTENT_CANCEL_RECOVERY_PREFIX,
  REFUND_REQUEST_REFUND_RECOVERY_PREFIX,
  SUPERSEDED_PAYMENT_REFUND_RECOVERY_PREFIX,
} from "@/lib/payment-recovery-keys";

/**
 * The closed catalogue that turns a `PaymentRecoveryOperation."idempotencyKey"`
 * prefix into a stable SCENARIO code and a plain-English label, evaluated in SQL
 * so the key itself is never projected.
 *
 * Every prefix below is imported from `src/lib/payment-recovery-keys.ts`, the
 * one place a recovery key's shape is spelled (`INV-SSOT`); none is copied. A key that matches
 * none of them projects `other_recovery`, which is honest: it means the platform
 * queued a recovery this catalogue does not recognise, and reporting an unknown
 * as one of the known scenarios would be worse than reporting it as unknown.
 * The finance-pack test fails when an export of that module is neither mapped
 * to an entry here nor declared not-a-recovery-key (#4076), so a new writer
 * cannot silently land in `other_recovery`. The scenario codes exist only in
 * this query's output: nothing stores them.
 *
 * ORDER IS SIGNIFICANT: the SQL is a `CASE`, so the first prefix that matches
 * wins and a longer prefix must precede a shorter one it starts with. The
 * finance-pack test pins that. `pg_catalog.starts_with` compares literally, so a
 * `_` in a prefix needs no `LIKE` escaping.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. Several different situations enqueue
 * `REFUND_BOOKING_MODIFICATION`: a booking cancellation, an approved refund
 * appeal, a capacity-race auto-refund, a duplicate-capture auto-refund and an
 * actual modification refund. A Finance Officer told "a booking modification
 * refund is pending" when the truth is "a duplicate card capture is being handed
 * back" will look in the wrong place, and the operation type is the only field
 * that would have told them — wrongly.
 */
export const RECOVERY_SCENARIO_CATALOGUE = [
  {
    prefix: BOOKING_CANCELLATION_REFUND_RECOVERY_PREFIX,
    code: "booking_cancellation_refund",
    label: "the card refund for a cancelled booking",
  },
  {
    prefix: CAPACITY_CLAIM_FAILED_REFUND_RECOVERY_PREFIX,
    code: "capacity_claim_failed_refund",
    label: "an automatic refund of a payment that arrived after the beds had gone",
  },
  {
    prefix: DUPLICATE_CAPTURE_REFUND_RECOVERY_PREFIX,
    code: "duplicate_capture_refund",
    label: "an automatic refund of a second card payment on an already-paid booking",
  },
  {
    prefix: REFUND_REQUEST_REFUND_RECOVERY_PREFIX,
    code: "refund_appeal_refund",
    label: "the card refund for an approved refund appeal",
  },
  {
    prefix: PAYMENT_INTENT_CANCEL_RECOVERY_PREFIX,
    code: "payment_intent_cancel",
    label: "cancelling a card payment request that was replaced or withdrawn",
  },
  {
    prefix: SUPERSEDED_PAYMENT_REFUND_RECOVERY_PREFIX,
    code: "superseded_payment_refund",
    label:
      "the refund of a card payment that was made on a payment request already cancelled or replaced",
  },
  {
    prefix: BOOKING_MODIFICATION_REFUND_RECOVERY_PREFIX,
    code: "booking_modification_refund",
    label: "the card refund for a booking edit that lowered the price",
  },
  {
    prefix: ADDITIONAL_INTENT_RECOVERY_PREFIX,
    code: "additional_payment_intent",
    label: "raising the card payment request for a booking edit that raised the price",
  },
  {
    prefix: EDIT_FINANCIAL_REVIEW_REFUND_RECOVERY_PREFIX,
    code: "edit_financial_review_refund",
    label: "the card refund an officer confirmed after reviewing a booking edit",
  },
  {
    prefix: EDIT_FINANCIAL_REVIEW_ADDITIONAL_INTENT_RECOVERY_PREFIX,
    code: "edit_financial_review_additional_intent",
    label: "the card payment request an officer raised after reviewing a booking edit",
  },
  {
    prefix: CREDIT_RELEASE_ASK_RECOVERY_PREFIX,
    code: "credit_release_ask",
    label: "the card payment request for credit that was used in Xero",
  },
  {
    prefix: LATE_CAPTURE_APPROVAL_REFUND_RECOVERY_PREFIX,
    code: "late_capture_approval_refund",
    label: "the refund of a late card payment on a cancelled booking, approved by an officer",
  },
  {
    prefix: ORGANISER_CHILD_REFUND_KEY_PREFIX,
    code: "organiser_child_refund",
    label:
      "a refund to the group organiser's card for a joiner's booking edit or a group cancellation",
  },
  {
    prefix: ORGANISER_CARD_APPEAL_REFUND_KEY_PREFIX,
    code: "organiser_card_appeal_refund",
    label: "a refund to the group organiser's card for a joiner's approved refund appeal",
  },
  {
    prefix: CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX,
    code: "card_refund_failed_later",
    label: "a card refund the card provider accepted and later reported as failed, asked for again",
  },
  {
    prefix: CARD_REFUND_STILL_OWED_RECOVERY_PREFIX,
    code: "card_refund_still_owed",
    label: "the rest of a card refund the treasurer paid back in part another way and said is still owed to the member",
  },
  {
    prefix: GROUP_SETTLEMENT_REFUND_RECOVERY_PREFIX,
    code: "group_settlement_refund",
    label: "a retry of an older whole-group refund to the organiser's card",
  },
] as const;

/** The scenario code a key that matches no catalogue prefix projects. */
const UNRECOGNISED_RECOVERY_SCENARIO_CODE = "other_recovery";

export const RECOVERY_SCENARIO_SQL = `CASE
${RECOVERY_SCENARIO_CATALOGUE.map(
  ({ prefix, code }) =>
    `    WHEN pg_catalog.starts_with(o."idempotencyKey", '${prefix}') THEN '${code}'`,
).join("\n")}
    ELSE '${UNRECOGNISED_RECOVERY_SCENARIO_CODE}'
  END`;

/**
 * The catalogue as the model reads it, so a bare scenario code is never left to
 * be paraphrased ("a refund to the group organiser's card" must not become "an
 * unrecognised recovery"). One source with the SQL above.
 */
export const RECOVERY_SCENARIO_GLOSS = `scenarioCode means: ${RECOVERY_SCENARIO_CATALOGUE.map(
  ({ code, label }) => `${code} is ${label}`,
).join("; ")}; ${UNRECOGNISED_RECOVERY_SCENARIO_CODE} is a queued recovery this catalogue does not recognise.`;
