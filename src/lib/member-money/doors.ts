import "server-only";

/**
 * THE BOOKING DOORS' ENTRY INTO THE JOURNAL (#4627, Ledger M3b). Server-only,
 * because the context resolver reads the club's settings through the server's
 * Prisma client; `./index` stays importable by a plain-Node operator command.
 *
 * A door resolves its context before its transaction opens, then, inside it,
 * posts the same lines its legacy writer just wrote. Only the legacy chokepoints
 * and member merge call these (`member-money-journal-inert-census.test.ts`).
 */
export type { BookingChargeEvent } from "./internal/booking-charges";
export type { MemberMoneyPostingContext } from "./internal/plan";
export { postBookingLedgerJournal, postMemberMergeTransfer } from "./internal/booking-posting";
export { resolveBookingMoneyPostingContext } from "./internal/door-context";
