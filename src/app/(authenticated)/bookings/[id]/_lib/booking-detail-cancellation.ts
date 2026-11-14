import { loadCancellationPolicy } from "@/lib/cancellation";
import {
  describeCancellationSchedule,
  type CancellationScheduleRow,
} from "@/lib/cancellation-schedule";
import type { ClubFormat } from "@/lib/club-format";
import type { BookingDetailEditAccess } from "./booking-detail-edit-access";
import type { BookingDetailPayment } from "./booking-detail-payment";
import type { BookingDetailRecord } from "./load-booking-detail";

/**
 * What the booking page tells a member about cancelling (#1371 F28, #4946).
 *
 * The exact per-booking amount shows inside the cancel flow; this is the tier
 * schedule behind it, shown on the page beside the Cancel action and in the
 * help widget. It is THIS booking's lodge's schedule, the one the cancel
 * settles with, never the club default lodge's.
 *
 * The schedule shows only once a payment has been captured: otherwise its tier
 * percentages imply a refund the member will never get, so an unpaid but
 * cancellable booking says plainly that no refund applies (owner review of
 * PR #1389).
 */
export async function loadBookingDetailCancellation(input: {
  booking: Pick<BookingDetailRecord, "checkIn" | "lodgeId">;
  access: Pick<BookingDetailEditAccess, "canCancel" | "isDeleted">;
  payment: Pick<BookingDetailPayment, "originalPaymentCaptured">;
  format: ClubFormat;
}): Promise<{
  cancellationSchedule: CancellationScheduleRow[] | undefined;
  cancellationHasNoPayment: boolean;
}> {
  const { booking, access, payment, format } = input;
  const showCancellationInfo = access.canCancel && !access.isDeleted;
  const cancellationSchedule =
    showCancellationInfo && payment.originalPaymentCaptured
      ? describeCancellationSchedule(
          await loadCancellationPolicy(booking.checkIn, booking.lodgeId),
          format,
        )
      : undefined;
  return {
    cancellationSchedule,
    cancellationHasNoPayment:
      showCancellationInfo && !payment.originalPaymentCaptured,
  };
}
