// Booking-level analysis helpers (cancellation credit, modification amounts,
// refund candidates, member name) for the booking-vs-Xero repair tool.
// Extracted verbatim from xero-booking-repair.ts (#1208 item 2).
import { CreditType } from "@prisma/client";
import type {
  BookingModificationRecord,
  BookingRepairRecord,
  XeroOperationRecord,
} from "./xero-booking-repair-types";
import { readJsonRecord, readJsonString } from "./xero-booking-repair-utils";

export function buildMemberName(booking: BookingRepairRecord) {
  return `${booking.member.firstName} ${booking.member.lastName}`.trim();
}

function getCancellationCreditEntries(booking: BookingRepairRecord) {
  const bookingLabel = booking.id.slice(0, 8);
  return booking.creditsFromCancellation.filter(
    (credit) =>
      credit.type === CreditType.CANCELLATION_REFUND &&
      credit.description === `Cancellation refund for booking ${bookingLabel}`
  );
}

export function getCancellationCreditAmountCents(booking: BookingRepairRecord) {
  return getCancellationCreditEntries(booking).reduce(
    (sum, credit) => sum + credit.amountCents,
    0
  );
}

// Pick<> keeps this callable from the retry stack's slim modification select
// (#1356) — one shared definition of a modification's signed net.
export function getModificationNetAmountCents(
  modification: Pick<BookingModificationRecord, "priceDiffCents" | "changeFeeCents">
) {
  return modification.priceDiffCents + modification.changeFeeCents;
}

/**
 * WHAT THIS EDIT'S SUPPLEMENTARY XERO INVOICE SHOULD BILL - the components and
 * the net, as ONE object, so the gate, the queued payload and the finding's
 * detail cannot come from three separate expressions (#3187).
 *
 * They used to be three reads of `modification.priceDiffCents` /
 * `.changeFeeCents`, which agreed only because they were copies of each other.
 * The moment part of the ask comes from somewhere ELSE - a completed financial
 * review, whose money is on the review task and not on the modification row -
 * three copies is three chances to widen the gate without widening the action,
 * and a critical finding whose action silently does nothing is worse than the
 * silence it replaced: it teaches an operator to ignore the tool.
 *
 * The review total joins `priceDiffCents` rather than `changeFeeCents` because
 * that is the component the live settlement dispatches it as
 * (`edit-financial-review-xero-leg.ts` sends `priceDiffCents: <combined total>,
 * changeFeeCents: 0`), and the invoice bills their sum either way. On a parked
 * edit both modification components are 0 by construction, so the ask IS the
 * review total; on every booking with no review the review total is 0 and this
 * returns exactly what the modification row always said.
 */
export function getExpectedSupplementaryInvoiceAsk(
  modification: Pick<BookingModificationRecord, "priceDiffCents" | "changeFeeCents">,
  editReviewChargeCents: number
) {
  const priceDiffCents = modification.priceDiffCents + editReviewChargeCents;
  return {
    priceDiffCents,
    changeFeeCents: modification.changeFeeCents,
    netAmountCents: priceDiffCents + modification.changeFeeCents,
    editReviewChargeCents,
  };
}

function modificationChangedBookingDates(modification: BookingModificationRecord) {
  if (modification.modificationType === "DATE_CHANGE") {
    return true;
  }

  const previousData = readJsonRecord(modification.previousData);
  const newData = readJsonRecord(modification.newData);
  if (!previousData || !newData) {
    return false;
  }

  const previousCheckIn = readJsonString(previousData.checkIn);
  const previousCheckOut = readJsonString(previousData.checkOut);
  const newCheckIn = readJsonString(newData.checkIn);
  const newCheckOut = readJsonString(newData.checkOut);

  return (
    Boolean(previousCheckIn && newCheckIn && previousCheckIn !== newCheckIn) ||
    Boolean(previousCheckOut && newCheckOut && previousCheckOut !== newCheckOut)
  );
}

export function getLatestDateChangingModification(booking: BookingRepairRecord) {
  return [...booking.modifications]
    .filter(modificationChangedBookingDates)
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null;
}

export function hasSuccessfulPrimaryInvoiceUpdateAfter(
  operations: XeroOperationRecord[],
  changedAt: Date
) {
  return operations.some(
    (operation) =>
      operation.entityType === "INVOICE" &&
      operation.operationType === "UPDATE" &&
      ["SUCCEEDED", "PARTIAL"].includes(operation.status) &&
      operation.createdAt >= changedAt
  );
}

export function hasSuccessfulPrimaryInvoiceCreateAfter(
  operations: XeroOperationRecord[],
  changedAt: Date
) {
  return operations.some(
    (operation) =>
      operation.entityType === "INVOICE" &&
      operation.operationType === "CREATE" &&
      ["SUCCEEDED", "PARTIAL"].includes(operation.status) &&
      operation.createdAt >= changedAt
  );
}

export function getKnownModificationRefundTotalCents(booking: BookingRepairRecord) {
  return booking.modifications.reduce((sum, modification) => {
    const netAmount = getModificationNetAmountCents(modification);
    return netAmount < 0 ? sum + Math.abs(netAmount) : sum;
  }, 0);
}

export function getUnpaidCancellationClearingAmountCents(booking: BookingRepairRecord) {
  if (!booking.payment?.xeroInvoiceId) {
    return 0;
  }

  return Math.max(
    booking.payment.amountCents - booking.payment.refundedAmountCents,
    booking.finalPriceCents + booking.payment.changeFeeCents
  );
}

export function getCashCancellationRefundCandidateCents(booking: BookingRepairRecord) {
  if (!booking.payment) {
    return null;
  }

  if (getCancellationCreditAmountCents(booking) > 0) {
    return null;
  }

  const knownModificationRefundCents = getKnownModificationRefundTotalCents(booking);
  const candidate = booking.payment.refundedAmountCents - knownModificationRefundCents;
  if (candidate <= 0) {
    return 0;
  }

  if (knownModificationRefundCents > 0) {
    return null;
  }

  return candidate;
}
