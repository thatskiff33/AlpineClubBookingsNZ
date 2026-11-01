// M1 exposes evidence and account identities only.
export { MEMBER_MONEY_ACCOUNTS } from "./internal/accounts";
export { verifyMemberMoneyJournal } from "./internal/verify";
// M2 (#4514): read-only references a deletion path must respect (D1, #4482).
export { bookingIdsNamedByJournal, journalRowsNamingDebtor } from "./internal/references";
// M3a (#4626): the one posting command, its plan types, keys and tax split.
// The booking doors reach it only through M3b's adapter in `./doors`
// (`member-money-journal-inert-census.test.ts` admits exactly those callers).
export { memberMoneyEventKeys } from "./internal/keys";
export {
  MemberMoneyPlanError,
  type MemberMoneyDebtor,
  type MemberMoneyPlan,
  type MemberMoneyPostingContext,
  type MemberMoneySource,
} from "./internal/plan";
export { postMemberMoneyEvent, resolveMemberMoneyPostingContext, reverseMemberMoneyJournal } from "./internal/post";
export { MemberMoneyPostingConflictError } from "./internal/store";
export { splitTaxInclusiveGross } from "./internal/tax";
// M3b (#4627): the rule mapping a legacy booking line to its journal component,
// shared by the doors' adapter and the comparison census. The doors' own entry,
// which reads settings through the server's client, is `./doors` (server-only),
// so a plain-Node operator command can still import this index.
export {
  bookingChargeIdentity,
  journalComponentOfLegacyLine,
  type BookingChargeComponent,
  type BookingChargeEvent,
} from "./internal/booking-charges";
export { readBookingJournalCharges, type BookingJournalCharges } from "./internal/booking-journal-read";
