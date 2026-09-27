export const PAYMENT_RECEIVED_STATUS_UNCONFIRMED_CODE =
  "PAYMENT_RECEIVED_STATUS_UNCONFIRMED" as const;

export const PAYMENT_RECEIVED_STATUS_UNCONFIRMED_MESSAGE =
  "Your card payment was received, but we could not confirm the booking status. Reload the booking and check its payment status before trying any payment again.";

export const PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY = Object.freeze({
  code: PAYMENT_RECEIVED_STATUS_UNCONFIRMED_CODE,
  error: PAYMENT_RECEIVED_STATUS_UNCONFIRMED_MESSAGE,
  paymentReceived: true as const,
  bookingStatusUnconfirmed: true as const,
});

export const EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_CODE =
  "EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED" as const;

export const EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_MESSAGE =
  "An existing successful card transaction was found, but we could not confirm whether it is still paid or has been refunded. Reload the booking and verify its payment status before trying any payment again.";

export const EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_BODY = Object.freeze({
  code: EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_CODE,
  error: EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_MESSAGE,
  existingCardTransactionFound: true as const,
  paymentStatusUnconfirmed: true as const,
});

// #3567: an intent in the club's previous currency is still `processing` (a bank
// debit, say), so it is neither handed back nor superseded; the member waits.
export const PAYMENT_PROCESSING_CODE = "PAYMENT_PROCESSING" as const;

export const PAYMENT_PROCESSING_MESSAGE =
  "This payment is being processed. Refresh the page in a minute to see it confirmed.";

export const PAYMENT_PROCESSING_BODY = Object.freeze({
  code: PAYMENT_PROCESSING_CODE,
  error: PAYMENT_PROCESSING_MESSAGE,
});

export function isPaymentProcessing(value: unknown): value is { code: typeof PAYMENT_PROCESSING_CODE; error: string } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.code === PAYMENT_PROCESSING_CODE && typeof candidate.error === "string";
}

export const REFUNDED_CARD_TRANSACTION_REPAYMENT_REQUIRED_CODE =
  "REFUNDED_CARD_TRANSACTION_REPAYMENT_REQUIRED" as const;

export const REFUNDED_CARD_TRANSACTION_REPAYMENT_REQUIRED_MESSAGE =
  "This card payment was already refunded. Reload the booking before starting a new payment.";

export const REFUNDED_CARD_TRANSACTION_REPAYMENT_REQUIRED_BODY = Object.freeze({
  code: REFUNDED_CARD_TRANSACTION_REPAYMENT_REQUIRED_CODE,
  error: REFUNDED_CARD_TRANSACTION_REPAYMENT_REQUIRED_MESSAGE,
  paymentRefunded: true as const,
  repaymentRequired: true as const,
});

export type PaymentReceivedFinalisationPending = Readonly<{
  paymentReceived: true;
  finalisationPending: true;
}>;

/**
 * Positive, provider-safe proof that money was received before a later local
 * finalisation step failed. Consumers must suppress every payment action as
 * soon as these two facts are present; the error code identifies the local
 * cause, but is not what proves the captured-money phase.
 */
export function isPaymentReceivedFinalisationPending(
  value: unknown,
): value is PaymentReceivedFinalisationPending {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.paymentReceived === true &&
    candidate.finalisationPending === true
  );
}

export function isPaymentReceivedStatusUnconfirmed(
  value: unknown,
): value is typeof PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.code === PAYMENT_RECEIVED_STATUS_UNCONFIRMED_CODE &&
    candidate.paymentReceived === true &&
    candidate.bookingStatusUnconfirmed === true &&
    candidate.finalisationPending !== true
  );
}

export function isExistingCardTransactionStatusUnconfirmed(
  value: unknown,
): value is typeof EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_BODY {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.code === EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_CODE ||
      candidate.code === "HOSTING_COVERAGE_PARTICIPANT_RETRY") &&
    candidate.existingCardTransactionFound === true &&
    candidate.paymentStatusUnconfirmed === true &&
    candidate.paymentReceived !== true &&
    candidate.finalisationPending !== true
  );
}

export function isRefundedCardTransactionRepaymentRequired(
  value: unknown,
): value is typeof REFUNDED_CARD_TRANSACTION_REPAYMENT_REQUIRED_BODY {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.code === REFUNDED_CARD_TRANSACTION_REPAYMENT_REQUIRED_CODE &&
    candidate.paymentRefunded === true &&
    candidate.repaymentRequired === true &&
    candidate.paymentReceived !== true
  );
}
