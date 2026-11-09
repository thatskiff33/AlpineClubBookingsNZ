import "server-only";

/**
 * THE BOOKING DOORS' ENTRY INTO THE JOURNAL (#4627, Ledger M3b). Server-only,
 * because the context resolver reads the club's settings through the server's
 * Prisma client; `./index` stays importable by a plain-Node operator command.
 *
 * A door resolves its context before its transaction opens, then, inside it,
 * posts the same lines its legacy writer just wrote. Only the legacy chokepoints
 * and member merge call these (`member-money-journal-inert-census.test.ts`);
 * from #4628 also the bank-transfer binding doors and the pending-charge syncs.
 */
export type { BookingChargeEvent } from "./internal/booking-charges";
export { isBookingJournalInactive, type BookingJournalContext } from "./internal/journal-activity";
// One statement, kept outside the boundary (`../booking-row-lock`) so a lock-only caller names no journal module (#4845).
export { lockBookingRowForOwnerRead } from "../booking-row-lock";
export { postBookingLedgerJournal, postMemberMergeTransfer, postPendingBookingJournal } from "./internal/booking-posting";
// #4628 (M3c): a bank-transfer booking's charge before settlement, planned by the legacy side.
export type { StandingChargeLine } from "./internal/booking-pending-charges";
export { resolveBookingDoorClock, resolveBookingMoneyPostingContext } from "./internal/door-context";

export { postBookingReceipts, type BookingReceiptDecision } from "./internal/booking-receipts";

// #4516 (M4c): card refunds. R05 at the doors, the sender's reservation step, R12/R13 in the one cash writer,
// a "Paid another way" close's R14, and which debt a recovery row pays.
export { closeKeptCaptureReturn, postRefundObligation, withdrawRefundObligation, type RefundObligationDoor } from "./internal/refund-obligations";
export { reserveCardRefundSlice, type CardRefundObligationRef, type CardRefundReservationOutcome, type CardRefundSliceReservation } from "./internal/refund-reservations";
export { postCardRefundCash } from "./internal/refund-cash";
export { postPaidAnotherWayClose, type PaidAnotherWayJournalClose, type PaidAnotherWayRest } from "./internal/refund-closes";
export { cardRefundObligationOfRecoveryKey, resolveCardRefundObligation, type CardRefundRecoveryRow } from "./internal/refund-obligation-map";
export { MemberMoneyReservationRefused } from "./internal/store";
