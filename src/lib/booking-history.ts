import { hasCapturedPayment } from "@/lib/booking-payment-state";
import { formatCents } from "@/lib/utils";

export type BookingHistoryTone = "default" | "success" | "warning" | "danger";

export interface BookingHistoryAuditLog {
  id: string;
  action: string;
  details: string | null;
  createdAt: Date;
}

export interface BookingHistoryPayment {
  status: string;
  amountCents: number;
  refundedAmountCents: number;
  additionalAmountCents: number;
  additionalPaymentStatus: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BookingHistoryModification {
  id: string;
  modificationType: string;
  previousData: unknown;
  newData: unknown;
  priceDiffCents: number;
  changeFeeCents: number;
  createdAt: Date;
}

export interface BookingHistoryRefundRequest {
  id: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  reason: string;
  requestedAmountCents: number | null;
  approvedAmountCents: number | null;
  adminNotes: string | null;
  createdAt: Date;
  reviewedAt: Date | null;
}

export interface BookingHistoryItem {
  id: string;
  occurredAt: Date;
  category: "Booking" | "Payment" | "Refund" | "Modification";
  title: string;
  detail: string | null;
  amountDisplay: string | null;
  tone: BookingHistoryTone;
}

interface BuildBookingHistoryOptions {
  createdAt: Date;
  payment: BookingHistoryPayment | null;
  modifications: BookingHistoryModification[];
  refundRequests: BookingHistoryRefundRequest[];
  auditLogs: BookingHistoryAuditLog[];
}

const MODIFICATION_LABELS: Record<string, string> = {
  DATE_CHANGE: "Dates Changed",
  GUEST_ADD: "Guests Added",
  GUEST_REMOVE: "Guest Removed",
  EXTEND_STAY: "Stay Extended",
  BATCH_MODIFY: "Booking Modified",
};

function formatSignedCents(cents: number): string {
  if (cents === 0) {
    return formatCents(0);
  }

  return `${cents > 0 ? "+" : "-"}${formatCents(Math.abs(cents))}`;
}

function parseAuditDetails(details: string | null): Record<string, unknown> | null {
  if (!details) {
    return null;
  }

  try {
    const parsed = JSON.parse(details) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function isRemovedGuest(
  value: unknown
): value is { firstName?: string; lastName?: string } {
  return Boolean(value) && typeof value === "object";
}

function describeModification(modification: BookingHistoryModification): string | null {
  const previous =
    modification.previousData && typeof modification.previousData === "object"
      ? (modification.previousData as Record<string, unknown>)
      : {};
  const next =
    modification.newData && typeof modification.newData === "object"
      ? (modification.newData as Record<string, unknown>)
      : {};

  switch (modification.modificationType) {
    case "DATE_CHANGE":
      return `${String(previous.checkIn)} to ${String(next.checkIn)} and ${String(previous.checkOut)} to ${String(next.checkOut)}`;
    case "GUEST_ADD":
      return `${String(previous.guestCount)} to ${String(next.guestCount)} guests.`;
    case "GUEST_REMOVE": {
      const removedGuest = previous.removedGuest;
      const name = isRemovedGuest(removedGuest)
        ? [removedGuest.firstName, removedGuest.lastName]
            .filter(Boolean)
            .join(" ")
        : "guest";
      return `Removed ${name}; ${String(previous.guestCount)} to ${String(next.guestCount)} guests.`;
    }
    case "BATCH_MODIFY": {
      const parts: string[] = [];
      if (previous.checkIn !== next.checkIn || previous.checkOut !== next.checkOut) {
        parts.push(
          `${String(previous.checkIn)}-${String(previous.checkOut)} to ${String(next.checkIn)}-${String(next.checkOut)}`
        );
      }
      if (previous.guestCount !== next.guestCount) {
        parts.push(`${String(previous.guestCount)} to ${String(next.guestCount)} guests`);
      }
      return parts.length > 0 ? `${parts.join(" and ")}.` : "Booking details were updated.";
    }
    default:
      return "Booking details were updated.";
  }
}

export function buildBookingHistoryItems({
  createdAt,
  payment,
  modifications,
  refundRequests,
  auditLogs,
}: BuildBookingHistoryOptions): BookingHistoryItem[] {
  const items: BookingHistoryItem[] = [
    {
      id: "booking-created",
      occurredAt: createdAt,
      category: "Booking",
      title: "Booking created",
      detail: "This booking was created.",
      amountDisplay: null,
      tone: "default",
    },
  ];

  let hasPrimaryPaymentSuccess = false;
  let hasPrimaryPaymentFailure = false;
  let hasAdditionalPaymentSuccess = false;
  let hasAdditionalPaymentFailure = false;

  for (const auditLog of auditLogs) {
    const parsedDetails = parseAuditDetails(auditLog.details);

    switch (auditLog.action) {
      case "booking.payment.confirmed": {
        hasPrimaryPaymentSuccess = true;
        const amountCents =
          typeof parsedDetails?.amountCents === "number"
            ? parsedDetails.amountCents
            : null;

        items.push({
          id: `audit-${auditLog.id}`,
          occurredAt: auditLog.createdAt,
          category: "Payment",
          title: "Payment successful",
          detail: "Original booking payment was captured successfully.",
          amountDisplay: amountCents != null ? formatCents(amountCents) : null,
          tone: "success",
        });
        break;
      }
      case "booking.payment.failed": {
        hasPrimaryPaymentFailure = true;
        const amountCents =
          typeof parsedDetails?.amountCents === "number"
            ? parsedDetails.amountCents
            : null;
        const errorMessage =
          typeof parsedDetails?.errorMessage === "string"
            ? parsedDetails.errorMessage
            : auditLog.details;

        items.push({
          id: `audit-${auditLog.id}`,
          occurredAt: auditLog.createdAt,
          category: "Payment",
          title: "Payment failed",
          detail: errorMessage ?? "The payment attempt did not complete successfully.",
          amountDisplay: amountCents != null ? formatCents(amountCents) : null,
          tone: "danger",
        });
        break;
      }
      case "booking.modification.payment.confirmed": {
        hasAdditionalPaymentSuccess = true;
        const amountCents =
          typeof parsedDetails?.additionalAmountCents === "number"
            ? parsedDetails.additionalAmountCents
            : null;

        items.push({
          id: `audit-${auditLog.id}`,
          occurredAt: auditLog.createdAt,
          category: "Payment",
          title: "Additional payment successful",
          detail: "Extra payment for a booking change was captured successfully.",
          amountDisplay: amountCents != null ? formatCents(amountCents) : null,
          tone: "success",
        });
        break;
      }
      case "booking.modification.payment.failed": {
        hasAdditionalPaymentFailure = true;
        const amountCents =
          typeof parsedDetails?.additionalAmountCents === "number"
            ? parsedDetails.additionalAmountCents
            : typeof parsedDetails?.amountCents === "number"
              ? parsedDetails.amountCents
              : null;
        const errorMessage =
          typeof parsedDetails?.errorMessage === "string"
            ? parsedDetails.errorMessage
            : auditLog.details;

        items.push({
          id: `audit-${auditLog.id}`,
          occurredAt: auditLog.createdAt,
          category: "Payment",
          title: "Additional payment failed",
          detail:
            errorMessage ?? "The extra payment required by a booking change failed.",
          amountDisplay: amountCents != null ? formatCents(amountCents) : null,
          tone: "danger",
        });
        break;
      }
      case "booking.cancel":
        items.push({
          id: `audit-${auditLog.id}`,
          occurredAt: auditLog.createdAt,
          category: "Booking",
          title: "Booking cancelled",
          detail: auditLog.details ?? "This booking was cancelled.",
          amountDisplay: null,
          tone: "warning",
        });
        break;
      default:
        break;
    }
  }

  for (const modification of modifications) {
    const detailParts = [describeModification(modification)];
    if (modification.changeFeeCents > 0) {
      detailParts.push(`Change fee applied: ${formatCents(modification.changeFeeCents)}.`);
    }

    items.push({
      id: `modification-${modification.id}`,
      occurredAt: modification.createdAt,
      category: "Modification",
      title:
        MODIFICATION_LABELS[modification.modificationType] ??
        modification.modificationType,
      detail: detailParts.filter(Boolean).join(" "),
      amountDisplay:
        modification.priceDiffCents !== 0
          ? formatSignedCents(modification.priceDiffCents)
          : null,
      tone:
        modification.priceDiffCents > 0
          ? "warning"
          : modification.priceDiffCents < 0
            ? "success"
            : "default",
    });
  }

  for (const refundRequest of refundRequests) {
    items.push({
      id: `refund-request-created-${refundRequest.id}`,
      occurredAt: refundRequest.createdAt,
      category: "Refund",
      title: "Refund appeal submitted",
      detail: refundRequest.reason,
      amountDisplay:
        refundRequest.requestedAmountCents != null
          ? formatCents(refundRequest.requestedAmountCents)
          : null,
      tone: refundRequest.status === "PENDING" ? "warning" : "default",
    });

    if (refundRequest.reviewedAt) {
      items.push({
        id: `refund-request-reviewed-${refundRequest.id}`,
        occurredAt: refundRequest.reviewedAt,
        category: "Refund",
        title:
          refundRequest.status === "APPROVED"
            ? "Refund appeal approved"
            : "Refund appeal rejected",
        detail:
          refundRequest.adminNotes ??
          (refundRequest.status === "APPROVED"
            ? "An admin approved this refund appeal."
            : "An admin rejected this refund appeal."),
        amountDisplay:
          refundRequest.status === "APPROVED" &&
          refundRequest.approvedAmountCents != null
            ? formatCents(refundRequest.approvedAmountCents)
            : null,
        tone: refundRequest.status === "APPROVED" ? "success" : "danger",
      });
    }
  }

  if (payment && hasCapturedPayment(payment) && !hasPrimaryPaymentSuccess) {
    items.push({
      id: "payment-fallback-success",
      occurredAt: payment.updatedAt,
      category: "Payment",
      title: "Payment recorded",
      detail: "A successful payment is attached to this booking.",
      amountDisplay: formatCents(payment.amountCents),
      tone: "success",
    });
  }

  if (payment?.status === "FAILED" && !hasPrimaryPaymentFailure) {
    items.push({
      id: "payment-fallback-failure",
      occurredAt: payment.updatedAt,
      category: "Payment",
      title: "Payment failed",
      detail: "The latest payment attempt did not complete successfully.",
      amountDisplay:
        payment.amountCents > 0 ? formatCents(payment.amountCents) : null,
      tone: "danger",
    });
  }

  if (
    payment &&
    payment.additionalAmountCents > 0 &&
    payment.additionalPaymentStatus === "SUCCEEDED" &&
    !hasAdditionalPaymentSuccess
  ) {
    items.push({
      id: "payment-fallback-additional-success",
      occurredAt: payment.updatedAt,
      category: "Payment",
      title: "Additional payment recorded",
      detail: "A booking change increased the total and the extra payment succeeded.",
      amountDisplay: formatCents(payment.additionalAmountCents),
      tone: "success",
    });
  }

  if (
    payment &&
    payment.additionalAmountCents > 0 &&
    payment.additionalPaymentStatus === "FAILED" &&
    !hasAdditionalPaymentFailure
  ) {
    items.push({
      id: "payment-fallback-additional-failure",
      occurredAt: payment.updatedAt,
      category: "Payment",
      title: "Additional payment failed",
      detail: "The latest extra payment required by a booking change failed.",
      amountDisplay: formatCents(payment.additionalAmountCents),
      tone: "danger",
    });
  }

  return items.sort(
    (left, right) => right.occurredAt.getTime() - left.occurredAt.getTime()
  );
}
