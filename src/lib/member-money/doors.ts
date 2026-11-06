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
export { postBookingLedgerJournal, postMemberMergeTransfer, postPendingBookingJournal } from "./internal/booking-posting";
// #4628 (M3c): a bank-transfer booking's charge before settlement, planned by the legacy side.
export type { StandingChargeLine } from "./internal/booking-pending-charges";
export { resolveBookingDoorClock, resolveBookingMoneyPostingContext } from "./internal/door-context";
