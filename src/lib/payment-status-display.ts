export interface CancellationCreditEntry {
  amountCents: number;
  description?: string | null;
}

export interface PaymentDisplayStatusInput {
  bookingStatus?: string;
  paymentStatus: string;
  refundedAmountCents: number;
  credits?: CancellationCreditEntry[];
}

export interface PaymentDisplayStatus {
  label: string;
  toneStatus: string;
  detail: string | null;
}

const CANCELLATION_CREDIT_PREFIX = "Cancellation refund for booking";
const RESTORED_CREDIT_PREFIX = "Credit restored from cancelled booking";

function humanizeStatus(status: string): string {
  return status
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function getCancellationSettlementBreakdown(
  refundedAmountCents: number,
  credits: CancellationCreditEntry[] = []
) {
  let accountCreditCents = 0;
  let restoredAppliedCreditCents = 0;

  for (const credit of credits) {
    const description = credit.description ?? "";
    if (description.startsWith(CANCELLATION_CREDIT_PREFIX)) {
      accountCreditCents += credit.amountCents;
      continue;
    }
    if (description.startsWith(RESTORED_CREDIT_PREFIX)) {
      restoredAppliedCreditCents += credit.amountCents;
    }
  }

  return {
    accountCreditCents,
    restoredAppliedCreditCents,
    refundToOriginalMethodCents: Math.max(
      refundedAmountCents - accountCreditCents,
      0
    ),
  };
}

export function getPaymentDisplayStatus({
  bookingStatus,
  paymentStatus,
  refundedAmountCents,
  credits = [],
}: PaymentDisplayStatusInput): PaymentDisplayStatus {
  const { accountCreditCents, refundToOriginalMethodCents } =
    getCancellationSettlementBreakdown(refundedAmountCents, credits);

  if (paymentStatus === "REFUNDED" || paymentStatus === "PARTIALLY_REFUNDED") {
    if (accountCreditCents > 0 && refundToOriginalMethodCents > 0) {
      return {
        label:
          paymentStatus === "REFUNDED"
            ? "Credit Issued + Card Refund"
            : "Partial Credit + Card Refund",
        toneStatus: paymentStatus,
        detail:
          "Returned partly as member credit and partly to the original payment method.",
      };
    }

    if (accountCreditCents > 0) {
      return {
        label:
          paymentStatus === "REFUNDED"
            ? "Credit Issued"
            : "Partial Credit Issued",
        toneStatus: paymentStatus,
        detail: "Held as member credit for a future booking.",
      };
    }

    return {
      label:
        paymentStatus === "REFUNDED"
          ? "Refunded to Card"
          : "Partially Refunded to Card",
      toneStatus: paymentStatus,
      detail: "Returned to the original payment method.",
    };
  }

  if (
    bookingStatus === "CANCELLED" &&
    paymentStatus === "SUCCEEDED" &&
    refundedAmountCents === 0
  ) {
    return {
      label: "Cancelled - No Refund",
      toneStatus: "SUCCEEDED",
      detail: "Original payment was retained under the cancellation policy.",
    };
  }

  if (
    bookingStatus === "CANCELLED" &&
    (
      paymentStatus === "PENDING" ||
      paymentStatus === "FAILED" ||
      paymentStatus === "PROCESSING"
    )
  ) {
    return {
      label: "Cancelled Before Payment",
      toneStatus: paymentStatus,
      detail: "No successful original payment was captured for this booking.",
    };
  }

  if (paymentStatus === "PROCESSING") {
    return {
      label: "Awaiting Payment Confirmation",
      toneStatus: "PROCESSING",
      detail:
        "Charge attempt created and waiting on Stripe confirmation or cardholder authentication.",
    };
  }

  const labels: Record<string, string> = {
    PENDING: "Pending",
    SUCCEEDED: "Paid",
    FAILED: "Payment Failed",
  };

  return {
    label: labels[paymentStatus] ?? humanizeStatus(paymentStatus),
    toneStatus: paymentStatus,
    detail: null,
  };
}
