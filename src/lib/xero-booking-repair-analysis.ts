// Booking-level analysis helpers (cancellation credit, modification amounts,
// refund candidates, member name) for the booking-vs-Xero repair tool.
// Extracted verbatim from xero-booking-repair.ts (#1208 item 2).
import { CreditType } from "@prisma/client";
import type {
  BookingModificationRecord,
  BookingRepairRecord,
  XeroOperationRecord,
} from "./xero-booking-repair-types";
import {
  isSuccessfulXeroOperation,
  readJsonArray,
  readJsonRecord,
  readJsonString,
} from "./xero-booking-repair-utils";

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

/**
 * DID THIS EDIT ADD A GUEST TO THE BOOKING (#3199 fix round)?
 *
 * Read from `newData.addedGuests`, which BOTH writers of a guest-adding
 * modification compose: the batch edit
 * (`booking-batch-modification-service.ts`, on the parked branch as well as the
 * priced one) and the standalone add route (`/api/bookings/[id]/guests`,
 * `modificationType: "GUEST_ADD"`). `modificationType` alone cannot answer it -
 * a batch edit that adds a guest is typed `BATCH_MODIFY` - so the array is the
 * signal and the type is not.
 *
 * WHY THE SUPPLEMENTARY-INVOICE ARM NEEDS IT, and it is not obvious. The
 * primary invoice bills `booking.guests[]` and their nights
 * (`buildInvoiceLineItems`), NOT `booking.finalPriceCents`. A parked edit
 * writes 0 to both components of its `BookingModification` - so its own net is
 * 0 - and yet an added guest on that same parked edit is written with a REAL
 * `priceCents` and real priced nights, because the current rate for a guest who
 * did not exist before is the one amount a parked edit can always work out. So
 * "the booking's own totals did not move" is true and beside the point: a
 * primary invoice minted afterwards bills that guest, the officer pricing the
 * review is told the added guests' amount "has not been charged" and includes
 * it, and the supplementary invoice then bills it a second time.
 *
 * An added NIGHT on an EXISTING guest is deliberately not part of this. A
 * parked edit writes those nights `NULL`, which disqualifies that guest from
 * per-night lines entirely and drops them to the whole-range branch billing
 * their UNCHANGED stored `priceCents` - so a later primary invoice carries no
 * more money for them than an earlier one would have.
 */
export function modificationAddedGuestCount(
  modification: Pick<BookingModificationRecord, "newData">
) {
  const newData = readJsonRecord(modification.newData);
  if (!newData) {
    return 0;
  }

  return readJsonArray(newData.addedGuests).length;
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
      isSuccessfulXeroOperation(operation) &&
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
      isSuccessfulXeroOperation(operation) &&
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
 * AND WHY NOT `PaymentRecoveryOperation.hadIssuedXeroInvoice` (#3199 fix
 * round), which is the SAME FACT already frozen at edit time by
 * `hasIssuedPrimaryXeroInvoice` (`booking-payment-state.ts`) for the automatic
 * twin of this rule (#3181). It is the better answer where it exists, and it
 * almost never exists here: recovery rows are written only on the
 * `CREATE_ADDITIONAL_PAYMENT_INTENT` path, while this pass reads historical
 * bookings that have no recovery row at all — which is the whole reason #3199
 * needed its own source. Worth knowing if the two ever diverge on a booking
 * that HAS both: `hasIssuedPrimaryXeroInvoice` reads `payment.xeroInvoiceId`,
 * persisted mid-run, whereas `completedAt` is written when the outbox closes
 * the row, so an edit landing between those two instants is "invoice issued" to
 * that helper and "not proven" here. This one refuses; that is the safe
 * direction, and it is a refusal rather than a contradiction.
 *
 * THE COMPARISON INSTANT IS `completedAt`, AND EARLIEST WINS. A successful
 * `INVOICE`/`CREATE` operation carrying this invoice's id is proof the invoice
 * existed in Xero by the moment that operation completed, so the EARLIEST such
 * completion is the tightest upper bound the history offers on when the invoice
 * came into existence. `startedAt` and `createdAt` are NOT usable in its place:
 * an operation enqueued before the edit can dispatch after it, and the invoice
 * is built at dispatch — so an enqueue timestamp would read "invoice first" for
 * exactly the outage window this defect lives in. (`createdAt` IS legitimate
 * for the STALE_PRIMARY_INVOICE_DETAILS arm a few lines up, which only asks the
 * `>=` direction — see the note at its call site.)
 *
 * A RE-ASSERT IS AN UPPER BOUND AND NOTHING MORE (#3199 fix round), and
 * "earliest wins" alone does not handle it. An operator retry claims the
 * operation row ITSELF (`FAILED|PARTIAL -> RUNNING`, `xero-operation-retry.ts`)
 * — a retry this very tool offers as `RETRY_XERO_OPERATION` — and when
 * `createXeroInvoiceForBooking` finds the invoice already there it closes that
 * SAME row SUCCEEDED, which rewrites `completedAt` to the retry's instant. The
 * original mint instant is overwritten; there is no earlier row left to win.
 * A PARTIAL row carrying a real invoice id is an ordinary shape, so this is not
 * exotic: mint on 1 May, edit on 2 May, operator retry on 10 May, and the
 * history now reads "invoice followed edit" for an invoice that plainly
 * preceded it. That direction is fail-safe, but the report would state
 * POSITIVELY that a supplementary invoice would double-bill — a false statement
 * about money, which is worse than "cannot be established" because the honest
 * wording is the one that sends an officer to look. So a completion whose
 * `responsePayload.skipped` is true bounds the invoice from ABOVE only: it may
 * still prove "invoice first" when it lands before the edit, and it may never
 * prove "invoice second".
 *
 * A STATED LIMIT, NOT A RESIDUAL: the two instants come off two clocks.
 * `BookingModification.createdAt` is `DEFAULT CURRENT_TIMESTAMP`, the DATABASE
 * clock; `completedAt` is `new Date()` in application code, the APP clock. No
 * margin is applied, for two reasons. The comparison already carries a cushion
 * in the safe direction — Postgres `CURRENT_TIMESTAMP` is the TRANSACTION start
 * instant, so the edit's true commit is strictly later than the value compared
 * against, and a mint completing anywhere in between genuinely could not see
 * the edit and genuinely does need supplementing. What is left is pure NTP skew
 * with the app clock behind the database, over a window narrower than the edit
 * transaction's own duration, and any margin large enough to cover it would be
 * an unjustifiable constant that pushed ordinary, correct findings into manual
 * review. The finding reports the invoice id and the instant either way, so an
 * officer can check the one case where it matters.
 *
 * EVERYTHING ELSE IS `unknown`, WHICH THE CALLER REPORTS RATHER THAN GUESSES.
 * An invoice minted before the outbox existed, or reconciled into Xero by hand,
 * has no matching operation row at all; a matching row with no completion
 * instant bounds nothing. Neither is evidence that the invoice preceded the
 * edit, and this is a money path, so neither may be treated as if it were.
 *
 * The "a primary invoice minted after the edit already bills the edit itself"
 * argument is stated in full, with worked figures, at
 * `payment-recovery.ts` -> `resolveHadIssuedXeroInvoiceForReplay` (#3181); it
 * is not restated here or at the other two sites that rely on it
 * (`xero-booking-edit-settlement.ts`, `payment-recovery.ts`'s replay gate) —
 * `INV-SSOT-001`.
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
      reason:
        | "no-successful-create-operation"
        | "no-completion-timestamp"
        | "only-re-asserted-completion";
    };

/**
 * A completion that RE-ASSERTED an invoice somebody else had already minted,
 * rather than one that minted it (#3199 fix round).
 *
 * `createXeroInvoiceForBooking` short-circuits when `payment.xeroInvoiceId` is
 * already set, and closes the claimed operation SUCCEEDED with exactly this
 * payload: `{ skipped: true, reason: "Invoice already exists for this payment;
 * link re-asserted." }`, stamping the invoice's own id onto the row. That is
 * the ONLY writer that can produce a successful `INVOICE`/`CREATE` row carrying
 * a real invoice id and a top-level `skipped` — the other `skipped: true`
 * completions in that module close CANCELLED with no object id (the manual
 * mark-paid abandons), or belong to an `UPDATE` operation
 * (`updateXeroBookingInvoiceForBooking`). Both are already excluded by this
 * resolver's own filter, so within the matched set the flag is unambiguous.
 *
 * A REAL mint's payload never carries it: it writes `invoice`, `payment`,
 * `paymentSkipped` and `invoiceEmailSkipped`, none of which is a bare `skipped`.
 */
function isReAssertedInvoiceCompletion(operation: XeroOperationRecord) {
  return readJsonRecord(operation.responsePayload)?.skipped === true;
}

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
      isSuccessfulXeroOperation(operation) &&
      operation.xeroObjectId === primaryInvoiceObjectId
  );

  if (matches.length === 0) {
    return { outcome: "unknown", reason: "no-successful-create-operation" };
  }

  let earliest:
    | { raisedAt: Date; operationId: string; reAsserted: boolean }
    | null = null;
  for (const operation of matches) {
    const completedAt = operation.completedAt;
    if (!completedAt) {
      continue;
    }
    if (!earliest || completedAt.getTime() < earliest.raisedAt.getTime()) {
      earliest = {
        raisedAt: completedAt,
        operationId: operation.id,
        reAsserted: isReAssertedInvoiceCompletion(operation),
      };
    }
  }

  if (!earliest) {
    return { outcome: "unknown", reason: "no-completion-timestamp" };
  }

  // Strictly BEFORE. An invoice raised at the same instant as the edit is not
  // evidence that it preceded it, and the safe answer to "cannot tell" is the
  // one that asks a person rather than the one that bills.
  if (earliest.raisedAt.getTime() < editedAt.getTime()) {
    return {
      outcome: "invoice-preceded-edit",
      raisedAt: earliest.raisedAt,
      operationId: earliest.operationId,
    };
  }

  // The earliest evidence is a re-assert, so it says only that the invoice
  // existed BY then - not that it was raised then. It cannot carry
  // "invoice-followed-edit", which is a positive claim about money.
  if (earliest.reAsserted) {
    return { outcome: "unknown", reason: "only-re-asserted-completion" };
  }

  return {
    outcome: "invoice-followed-edit",
    raisedAt: earliest.raisedAt,
    operationId: earliest.operationId,
  };
}
