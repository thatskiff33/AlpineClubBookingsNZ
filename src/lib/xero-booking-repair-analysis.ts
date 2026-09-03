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

/**
 * WHEN WAS THIS BOOKING'S PRIMARY XERO INVOICE RAISED, RELATIVE TO ONE EDIT
 * (#3199, epic #2797)?
 *
 * The supplementary-invoice arm of the repair tool used to ask only "is there a
 * primary invoice now, and is this edit's net positive". That question has no
 * notion of WHEN the primary invoice was raised, and the two orderings need
 * opposite answers:
 *
 * - invoice FIRST, then the edit — the invoice bills the old total, so the
 *   difference needs its own supplementary invoice. This is the ordinary case,
 *   because the primary invoice is enqueued at confirmation.
 * - edit FIRST, then the invoice — the primary invoice is minted from the
 *   booking as it stands at DISPATCH (`createXeroInvoiceForBooking` re-reads
 *   the booking and its guest nights; the queued payload carries only a booking
 *   id), so it already bills the change. A supplementary invoice on top of it
 *   bills the same money twice: $600 of income and a $50 receivable nobody owes
 *   on a $550 booking.
 *
 * WHY THE OPERATION HISTORY IS THE SOURCE, and specifically why not
 * `primaryInvoice.operation`. `resolveObjectFromCandidates` sorts its candidates
 * `field` before `link` before `operation` and takes the first, and this arm
 * only fires when `payment.xeroInvoiceId` is set — which is exactly when the
 * field candidate exists. So the resolved object's `.operation` is `null` in
 * essentially every real case and reading it would silently answer "unknown"
 * everywhere. The operation rows themselves are the evidence, and they are
 * complete: `XeroSyncOperation` rows are never pruned in production.
 *
 * WHY LINKS ARE NOT A FALLBACK. `XeroObjectLink.createdAt` looks like the same
 * evidence and is not: this very tool backfills a missing PRIMARY_INVOICE link
 * (`SYNC_PAYMENT_PRIMARY_INVOICE_LINK`), so a link's timestamp can be years
 * later than the mint it records. Reading one would report "the invoice
 * followed the edit" for invoices that plainly preceded it.
 *
 * THE COMPARISON INSTANT IS `completedAt`, AND EARLIEST WINS. A successful
 * `INVOICE`/`CREATE` operation carrying this invoice's id is proof the invoice
 * existed in Xero by the moment that operation completed, so the EARLIEST such
 * completion is the tightest upper bound the history offers on when the invoice
 * came into existence. `startedAt` and `createdAt` are NOT usable in its place:
 * an operation enqueued before the edit can dispatch after it, and the invoice
 * is built at dispatch — so an enqueue timestamp would read "invoice first" for
 * exactly the outage window this defect lives in.
 *
 * EVERYTHING ELSE IS `unknown`, WHICH THE CALLER REPORTS RATHER THAN GUESSES.
 * An invoice minted before the outbox existed, or reconciled into Xero by hand,
 * has no matching operation row at all; a matching row with no completion
 * instant bounds nothing. Neither is evidence that the invoice preceded the
 * edit, and this is a money path, so neither may be treated as if it were.
 */
export type PrimaryInvoiceEditTiming =
  | {
      outcome: "invoice-preceded-edit";
      raisedAt: Date;
      operationId: string;
    }
  | {
      outcome: "invoice-followed-edit";
      raisedAt: Date;
      operationId: string;
    }
  | {
      outcome: "unknown";
      reason: "no-successful-create-operation" | "no-completion-timestamp";
    };

export function resolvePrimaryInvoiceEditTiming({
  operations,
  primaryInvoiceObjectId,
  editedAt,
}: {
  operations: XeroOperationRecord[];
  primaryInvoiceObjectId: string;
  editedAt: Date;
}): PrimaryInvoiceEditTiming {
  const matches = operations.filter(
    (operation) =>
      operation.entityType === "INVOICE" &&
      operation.operationType === "CREATE" &&
      ["SUCCEEDED", "PARTIAL"].includes(operation.status) &&
      operation.xeroObjectId === primaryInvoiceObjectId
  );

  if (matches.length === 0) {
    return { outcome: "unknown", reason: "no-successful-create-operation" };
  }

  let earliest: { raisedAt: Date; operationId: string } | null = null;
  for (const operation of matches) {
    const completedAt = operation.completedAt;
    if (!completedAt) {
      continue;
    }
    if (!earliest || completedAt.getTime() < earliest.raisedAt.getTime()) {
      earliest = { raisedAt: completedAt, operationId: operation.id };
    }
  }

  if (!earliest) {
    return { outcome: "unknown", reason: "no-completion-timestamp" };
  }

  // Strictly BEFORE. An invoice raised at the same instant as the edit is not
  // evidence that it preceded it, and the safe answer to "cannot tell" is the
  // one that asks a person rather than the one that bills.
  return {
    outcome:
      earliest.raisedAt.getTime() < editedAt.getTime()
        ? "invoice-preceded-edit"
        : "invoice-followed-edit",
    raisedAt: earliest.raisedAt,
    operationId: earliest.operationId,
  };
}
