// The shapes a subscription billing preview is made of: its plan entries, plan
// exceptions, exempt members and the preview itself. Moved out of
// `membership-subscription-billing.ts` unchanged (#4926, the hard ceiling on a
// file's length). Types only, so nothing here runs; the old path still exports
// every name. The exception CODES stay beside the code that raises them, and are
// imported here as a type.
import type {
  AgeTier,
  MembershipFeeBillingBasis,
  MembershipFeeProrationRule,
  SubscriptionStatus,
} from "@prisma/client";
import type { SubscriptionBillingExceptionCode } from "@/lib/membership-subscription-billing";

// One resolved invoice line of an annual fee (#1932, E6). `xeroAccountCode` /
// `xeroItemCode` carry the per-component override if set, otherwise null until the
// post-loop mapping pass fills them from the frozen subscriptionIncome mapping.
// The frozen charge-component snapshot is written verbatim from this at confirm.
export type SubscriptionBillingComponent = {
  label: string;
  description: string;
  annualAmountCents: number;
  chargedAmountCents: number;
  prorated: boolean;
  xeroAccountCode: string | null;
  xeroItemCode: string | null;
  sortOrder: number;
};

export type SubscriptionBillingPlanEntry = {
  key: string;
  seasonYear: number;
  // Exactly one of the membershipType* trio or the subscriptionCategory*
  // quartet below is populated per entry — a type-axis entry (unchanged
  // behaviour) sets the trio and leaves the quartet undefined; a
  // category-axis entry sets the quartet and these to null. Nullable rather
  // than widened-to-optional for the trio so the existing type-axis
  // construction site (which always supplies them) needs no change.
  membershipAnnualFeeId: string | null;
  membershipTypeId: string | null;
  membershipTypeKey: string | null;
  membershipTypeName: string | null;
  // Subscription-category decoupling: optional so the existing type-axis
  // entry literal doesn't need to mention them.
  subscriptionCategoryId?: string | null;
  subscriptionCategoryKey?: string | null;
  subscriptionCategoryName?: string | null;
  subscriptionCategoryFeeId?: string | null;
  billingBasis: MembershipFeeBillingBasis;
  prorationRule: MembershipFeeProrationRule;
  annualAmountCents: number;
  chargedAmountCents: number;
  coveredMonths: number;
  decisionDate: string;
  coverageStart: string;
  coverageEnd: string;
  familyGroupId: string | null;
  recipient: { id: string; name: string; email: string };
  coveredMembers: Array<{ id: string; name: string }>;
  xeroAccountCode: string | null;
  xeroItemCode: string | null;
  components: SubscriptionBillingComponent[];
};

export type SubscriptionBillingPlanException = {
  fingerprint: string;
  code: SubscriptionBillingExceptionCode;
  message: string;
  seasonYear: number;
  memberId: string | null;
  familyGroupId: string | null;
  membershipTypeId: string | null;
  // Subscription-category decoupling: optional so none of the many existing
  // exception() call sites need to change — they simply omit it, and the
  // fingerprint digest below treats an omitted value as null.
  subscriptionCategoryId?: string | null;
  context: Record<string, unknown>;
};

export type SubscriptionBillingExemptMember =
  | { memberId: string; memberName: string; ageTier: AgeTier | null; exemptBy: "AGE_TIER" }
  | { memberId: string; memberName: string; ageTier: null; exemptBy: "MEMBERSHIP_TYPE"; membershipTypeName: string };

export type SubscriptionBillingPreview = {
  seasonYear: number;
  decisionDate: string;
  // The club's financial year-end month this preview's invoice-line descriptions
  // were NAMED from (#3116). Frozen here for the same reason `decisionDate` is:
  // the confirm path rebuilds the preview inside the transaction and compares
  // `confirmationToken`, and the descriptions are part of that token — so confirm
  // must replay the year-end the preview used rather than resolve a fresh one.
  yearEndMonth: number;
  dueDays: number;
  scopeMemberIds: string[] | null;
  entries: SubscriptionBillingPlanEntry[];
  exceptions: SubscriptionBillingPlanException[];
  alreadyCoveredMemberIds: string[];
  // Members skipped by a BASED_ON_AGE_TIER type because their season-start age
  // tier does not require a subscription (issue #2041). They mint no charge and
  // no Xero op; confirm upserts a NOT_REQUIRED MemberSubscription row for them
  // so their booking status stays consistent with billing (decision Q4). Not
  // part of the confirmation token — the set is derived deterministically from
  // members, age-tier settings, and per-type fees, so the in-transaction
  // re-preview reproduces it, and clubs with no BASED_ON_AGE_TIER type keep a
  // byte-identical token (always []).
  exemptMemberIds: string[];
  // #2148 (D1): the same exempt set as exemptMemberIds, enriched with the member
  // name and the season-start age tier that made them exempt, for the collapsed
  // informational "Exempt" preview section. Derived deterministically alongside
  // exemptMemberIds, so — like exemptMemberIds — it is NOT part of the
  // confirmation token. A member lands here when their BASED_ON_AGE_TIER
  // season-start tier is not subscription-liable AND either no fee resolves for
  // that tier or the resolved fee is PER_MEMBER (a PER_FAMILY fee still bills the
  // family once, so a tier-exempt child under it is NOT exempted here — Q5 / #2148
  // constraint 1).
  //
  // #4496: a member on a subscription category whose membership type is
  // NOT_REQUIRED is listed too (#4554's acceptance check), with `exemptBy`
  // "MEMBERSHIP_TYPE" and no tier, so the preview never shows a tier as the
  // reason. Every other row is `exemptBy` "AGE_TIER".
  exemptMembers: Array<SubscriptionBillingExemptMember>;
  // #2147 (D3): members skipped because their season MemberSubscription already
  // holds a LIVE Xero invoice (xeroInvoiceId not null — PAID/UNPAID/OVERDUE).
  // The admin sees them, and their invoice number, in a collapsed "Already
  // invoiced" section instead of being silently re-billed. Derived
  // deterministically from MemberSubscription state (like alreadyCovered /
  // exempt), so it is NOT part of the confirmation token — the skip itself is
  // already reflected by the absence of an entry, which the in-transaction
  // re-preview reproduces under the per-season advisory lock.
  alreadyInvoiced: Array<{
    memberId: string;
    memberName: string;
    xeroInvoiceNumber: string | null;
    status: SubscriptionStatus;
  }>;
  // #2147 FINDING 1 + #2161: family groups suppressed from a (second) PER_FAMILY
  // charge. A family is suppressed when EITHER a group member's own resolved
  // billing basis is PER_FAMILY and they hold a live season Xero invoice or a
  // PER_FAMILY coverage claim (#2161 D1 refinement of the #2147 predicate — a
  // PER_MEMBER member's personal invoice no longer blocks the family fee), OR an
  // operator has set an explicit "already invoiced" marker for the family/season
  // (#2161 D2). Surfaced beside alreadyInvoiced so the operator can audit what
  // covers the whole family. Like alreadyInvoiced it is derived deterministically
  // from persisted state (NOT part of the confirmation token — the suppressed
  // family simply mints no entry, which the in-transaction re-preview reproduces
  // under the per-season advisory lock).
  alreadyInvoicedFamilies: Array<{
    familyGroupId: string;
    // Null for a family suppressed only by an operator marker (no auto-detected
    // invoice holder).
    holderMemberId: string | null;
    holderName: string | null;
    xeroInvoiceNumber: string | null;
    status: SubscriptionStatus | null;
    membersCovered: number;
    // #2161 FINDING 1: true when the auto-detected invoice holder suppressed the
    // family via the fail-closed path — its OWN billing basis could not be
    // resolved (NOT_REQUIRED type, no resolvable type, or no fee row), so the
    // family is conservatively suppressed. Resolve the holder's type/fee or void
    // the invoice to re-bill. Always false for a purely operator-marked family.
    holderBasisUnresolvable: boolean;
    // #2161 (D2): true when an operator marker suppresses this family. The
    // marker fields describe who marked it and any note; a family can be BOTH
    // auto-suppressed (holder fields populated) and operator-marked.
    operatorMarked: boolean;
    markerNote: string | null;
    markedByName: string | null;
    markedAt: Date | null;
  }>;
  totalCents: number;
  confirmationToken: string;
  // Subscription-category decoupling (review finding): more than one member
  // billed SOLO (no family group) under the SAME category this run. Solo
  // category billing is deliberately not an error on its own — a club can
  // have a genuinely standalone category — but two or more members sharing
  // one name like "Couple" while billed as separate flat charges is very
  // likely a setup mistake (the club pays MORE than if they were billed
  // individually under their own type, the opposite of the category's
  // purpose) rather than something to silently charge. Purely informational,
  // like exemptMembers/alreadyInvoiced: derived deterministically from
  // entries, so it is NOT part of the confirmation token and blocks nothing —
  // the screen tells the admin, it never guesses who should be grouped.
  ungroupedCategoryMembers: Array<{
    subscriptionCategoryId: string;
    subscriptionCategoryName: string;
    members: Array<{ memberId: string; memberName: string }>;
  }>;
};
