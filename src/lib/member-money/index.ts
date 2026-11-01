// M1 exposes evidence and account identities only.
export { MEMBER_MONEY_ACCOUNTS } from "./internal/accounts";
export { verifyMemberMoneyJournal } from "./internal/verify";
// M2 (#4514): read-only references a deletion path must respect (D1, #4482).
export { bookingIdsNamedByJournal, journalRowsNamingDebtor } from "./internal/references";
// M3a (#4626): the one posting command, its plan types, keys and tax split.
// No door calls it yet (`member-money-journal-inert-census.test.ts`).
export { memberMoneyEventKeys } from "./internal/keys";
export {
  MemberMoneyPlanError,
  TAXED_REVENUE_ACCOUNTS,
  type MemberMoneyAmountLeg,
  type MemberMoneyDebtor,
  type MemberMoneyEvidence,
  type MemberMoneyLegPlan,
  type MemberMoneyObligationPlan,
  type MemberMoneyPlan,
  type MemberMoneyPostingContext,
  type MemberMoneyReversalPlan,
  type MemberMoneyRevenueLeg,
  type MemberMoneySource,
} from "./internal/plan";
export { postMemberMoneyEvent, resolveMemberMoneyPostingContext, reverseMemberMoneyJournal } from "./internal/post";
export { MemberMoneyPostingConflictError, type MemberMoneyPosting } from "./internal/store";
export { splitTaxInclusiveGross, type MemberMoneyTaxSplit } from "./internal/tax";
