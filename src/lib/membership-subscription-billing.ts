
import { compareOrdinal } from "@/lib/ordinal-order";
import { stableDigest } from "@/lib/stable-digest";
import type {
  AgeTier,
  MembershipBillingExceptionResolution,
  MembershipFeeBillingBasis,
  MembershipFeeProrationRule,
  MembershipSubscriptionChargeSource,
  MembershipTypeSubscriptionBehavior,
  Prisma,
  SubscriptionStatus,
} from "@prisma/client";
import {
  computeAgeTierWithSettings,
  getAgeTierSettings,
  getSeasonStartDate,
  type AgeTierSettingData,
} from "@/lib/age-tier";
import { DEFAULT_MEMBERSHIP_SUBSCRIPTION_BILLING_SETTINGS } from "@/config/club-settings-defaults";
import { createAuditLog } from "@/lib/audit";
import { getEffectiveMembershipAnnualFee, getEffectiveSubscriptionCategoryFee, getFamilyBillingMode } from "@/lib/authoritative-fees";
import { clubToday, dateOnlyInstantOf } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { formatDateOnly, parseDateOnly } from "@/lib/date-only";
import {
  getSeasonStartMonth,
  seasonYearOfStoredDate,
} from "@/lib/financial-year";
import { refreshFinancialYearConfig } from "@/lib/financial-year-server";
import { seasonYearsLabel } from "@/lib/season-label";
import { requiresPaidSubscriptionForAgeTier } from "@/lib/member-subscription-eligibility";
import { prisma } from "@/lib/prisma";
import { defaultMembershipTypeKeyForRole, storedRoleDefaultMembershipTypeWhere } from "@/lib/membership-types";
import { getResolvedAccountMapping } from "@/lib/xero-mappings";
import { isBilledThroughFamily, resolveBillingFamilyMembership } from "@/lib/membership-billing-family";
import { chargeAxisDisplayName, chargeFamilyAxisKey } from "@/lib/membership-charge-axis";
import { subscriptionInvoiceOutboxRow } from "@/lib/xero-operation-outbox-payload";
import { buildXeroIdempotencyKey, startXeroSyncOperation } from "@/lib/xero-sync";
import {
  CLOSED_FAMILY_MEMBER_NEEDS_DECISION_CODE,
  CLOSED_FAMILY_PARTLY_REVERSED_CODE,
  CLOSED_FAMILY_REBILL_BESIDE_INVOICE_CODE,
  closedFamilyMemberDecisionMessage,
  isChargeClosedAsAlreadyPaid,
  confirmWithholdsInvoicingWarnings,
  invoicingWarningEntryKey,
  isClosedCoveragePaymentReversed,
  isInvoicingPreviewWarning,
  isSubscriptionSettled,
  type ClosedFamilyDecisionReason,
  wasPaidAtClose,
  WITHHELD_ON_APPROVAL_NOTE,
} from "@/lib/subscription-charge-already-paid";

export class SubscriptionBillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubscriptionBillingError";
  }
}

export type SubscriptionBillingExceptionCode =
  | "MISSING_MEMBERSHIP_ASSIGNMENT"
  | "MISSING_FEE_SCHEDULE"
  | "MISSING_FAMILY"
  | "AMBIGUOUS_FAMILY"
  | "INVALID_BILLING_FAMILY_SELECTION"
  | "MISSING_FAMILY_RECIPIENT"
  | "INVALID_FAMILY_RECIPIENT"
  | "PER_FAMILY_FEE_IN_INDIVIDUAL_MODE"
  | "MISSING_XERO_ACCOUNT_MAPPING"
  | "FAMILY_ALREADY_BILLED"
  // Subscription-category decoupling: a club-definable billing category (e.g.
  // "Couple") has no effective SubscriptionCategoryFee on the decision date —
  // mirrors MISSING_FEE_SCHEDULE on the independent category axis.
  | "MISSING_CATEGORY_FEE_SCHEDULE"
  // Subscription-category decoupling (review finding): a family already
  // billed on ONE axis this run (category or type) has a member who would
  // bill it again on the OTHER axis. Both axes are PER_FAMILY-shaped and key
  // their dedup on different strings, so neither notices the other without
  // this check — withholds rather than double-charging the family.
  | "MIXED_AXIS_FAMILY_BILLING"
  // Subscription-category decoupling (review finding): a member's assignment
  // still names a category an admin archived since. Falling through to type
  // billing silently (no exception) would re-price the member with no trace
  // of why — this makes the admin resolve it (re-assign, reactivate the
  // category, or clear the assignment) rather than guessing a price.
  | "ARCHIVED_SUBSCRIPTION_CATEGORY_ASSIGNED"
  // #4110 decisions 4 and 5: a member of a family a closed charge still bills
  // whom Finance must decide how to bill. Withholds, like FAMILY_ALREADY_BILLED.
  | typeof CLOSED_FAMILY_MEMBER_NEEDS_DECISION_CODE
  // #4110: a WARNING, not a block — the family entry it names is still
  // confirmed and invoiced (an officer's confirm; an approval withholds it).
  | typeof CLOSED_FAMILY_PARTLY_REVERSED_CODE
  // #4110 review round 5: a warning too — the re-bill sits beside a member's
  // own live Xero invoice.
  | typeof CLOSED_FAMILY_REBILL_BESIDE_INVOICE_CODE;

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
  exemptMembers: Array<{
    memberId: string;
    memberName: string;
    ageTier: AgeTier | null;
  }>;
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

/**
 * Through the canonical `stableDigest` (`INV-SSOT-001`, #3250).
 *
 * This module used to define its own `createHash("sha256")
 * .update(JSON.stringify(value)).digest("hex")` — character for character the
 * private copy #3250 was filed about, in a second file. Two consequences of
 * routing it to the shared helper, both measured rather than assumed and both
 * pinned by `membership-subscription-billing.test.ts`:
 *
 * - **`SubscriptionBillingException.fingerprint` is byte-identical**, because
 *   `exception()` hashes an ARRAY OF PRIMITIVES and recursive key sorting is the
 *   identity on that. This matters: the fingerprint is a STORED column that a
 *   later run reads back (`where: { fingerprint }`) and prunes against
 *   (`notIn: currentFingerprints`), so a change there would duplicate every
 *   existing exception row and delete the originals.
 * - **`confirmationToken` moves once, at deploy.** It hashes a nested OBJECT, so
 *   sorted keys give different bytes. Nothing stores it: the preview hands it to
 *   the browser and the confirm route re-derives it. An admin holding an open
 *   preview across the deploy is answered with the route's ordinary 409 —
 *   "Billing configuration changed after preview. Review the refreshed preview
 *   before confirming." — and re-previews. In exchange the token becomes
 *   independent of the order the preview object's keys were built in, which is
 *   the property the canonical helper exists to give.
 */
function digest(value: unknown) {
  return stableDigest(value);
}

function seasonBounds(seasonYear: number) {
  const startMonth = getSeasonStartMonth();
  const start = new Date(Date.UTC(seasonYear, startMonth - 1, 1));
  const nextStart = new Date(Date.UTC(seasonYear + 1, startMonth - 1, 1));
  const end = new Date(nextStart.getTime() - 24 * 60 * 60 * 1000);
  return { start, end };
}

export function calculateMembershipCharge(input: {
  annualAmountCents: number;
  prorationRule: MembershipFeeProrationRule;
  seasonYear: number;
  decisionDate: Date;
}) {
  if (!Number.isSafeInteger(input.annualAmountCents) || input.annualAmountCents < 0) {
    throw new SubscriptionBillingError("Annual membership fee must be a non-negative integer number of cents.");
  }
  const { start, end } = seasonBounds(input.seasonYear);
  const decision = new Date(Date.UTC(
    input.decisionDate.getUTCFullYear(),
    input.decisionDate.getUTCMonth(),
    input.decisionDate.getUTCDate(),
  ));
  if (decision < start || decision > end) {
    throw new SubscriptionBillingError(`Decision date must fall within membership year ${input.seasonYear}.`);
  }
  if (input.prorationRule === "NONE") {
    return {
      amountCents: input.annualAmountCents,
      coveredMonths: 12,
      coverageStart: start,
      coverageEnd: end,
    };
  }
  const coveredMonths =
    (end.getUTCFullYear() - decision.getUTCFullYear()) * 12 +
    end.getUTCMonth() - decision.getUTCMonth() + 1;
  return {
    // Integer arithmetic with half-up cent rounding. Values are far below the
    // JS safe-integer ceiling because fee schedules are constrained to Int32.
    amountCents: Math.floor((input.annualAmountCents * coveredMonths + 6) / 12),
    coveredMonths,
    coverageStart: new Date(Date.UTC(decision.getUTCFullYear(), decision.getUTCMonth(), 1)),
    coverageEnd: end,
  };
}

// The single-line invoice description. A single-component fee (every existing fee
// post-backfill) reproduces this text — including the `(1 month)` vs `(N months)`
// pluralization. Multi-component fees append the component label to distinguish
// their lines.
//
// WHAT KEEPS AN EXISTING CHARGE'S LINE STABLE IS PERSISTENCE, NOT THIS LITERAL,
// and the comment that stood here said otherwise (#3116). It claimed a frozen
// string contract: a re-driven backfilled charge mints a byte-identical line
// BECAUSE this text never changes. That is not the mechanism.
// `MembershipSubscriptionChargeComponent.description` is a persisted column;
// this function WRITES it at plan time and the mint READS THE STORED COLUMN BACK
// (`xero-subscription-invoices.ts`, whose fallback branch is the one place that
// re-derives at send time). So changing this derivation changes newly-planned
// charges only.
//
// `yearEndMonth` IS REQUIRED and deliberately has no default, so an unstated
// year-end is a compile error rather than a silently wrong invoice line - see
// `season-label.ts` for why the default is wrong off a request path.
export function buildComponentLineDescription(input: {
  membershipTypeName: string;
  seasonYear: number;
  coveredMonths: number;
  label: string;
  isSoleComponent: boolean;
  yearEndMonth: number;
}) {
  const base = `${input.membershipTypeName} membership `
    + `${seasonYearsLabel(input.seasonYear, input.yearEndMonth)}`
    + ` (${input.coveredMonths} month${input.coveredMonths === 1 ? "" : "s"})`;
  return input.isSoleComponent ? base : `${base} — ${input.label}`;
}

// Subscription-category decoupling: the category-axis sibling of
// buildComponentLineDescription, deliberately a separate function rather than
// an overload of it — that one carries a frozen-column contract note (#3116)
// about changing what it writes, so a category-flavoured branch stays out of
// its way entirely. "subscription" replaces "membership" in the line text
// since a category charge is independent of any MembershipType.
export function buildCategoryComponentLineDescription(input: {
  subscriptionCategoryName: string;
  seasonYear: number;
  coveredMonths: number;
  label: string;
  isSoleComponent: boolean;
  yearEndMonth: number;
}) {
  const base = `${input.subscriptionCategoryName} subscription `
    + `${seasonYearsLabel(input.seasonYear, input.yearEndMonth)}`
    + ` (${input.coveredMonths} month${input.coveredMonths === 1 ? "" : "s"})`;
  return input.isSoleComponent ? base : `${base} — ${input.label}`;
}

// Per-component charged cents: same half-up cent rounding as the fee-level
// calculation, applied per line. Σ of per-component floors can diverge from the
// fee-level floor by up to (n−1) cents for a multi-component prorated fee — this
// is intended: the charge total is authoritative as Σ components so the invoice
// (one line per component) always foots to the charge amount (see
// docs/AUTHORITATIVE_FEES.md). A single-component fee is byte-identical.
function componentChargedCents(amountCents: number, prorate: boolean, coveredMonths: number) {
  return prorate ? Math.floor((amountCents * coveredMonths + 6) / 12) : amountCents;
}

/** What a set of plan entries charges, in cents: the preview's total and the confirm audit's. */
function totalChargedCents(entries: readonly Pick<SubscriptionBillingPlanEntry, "chargedAmountCents">[]): number {
  return entries.reduce((sum, entry) => sum + entry.chargedAmountCents, 0);
}

/** Newest charge first; the id breaks a createdAt tie, so the order is total. */
function newestChargeFirst(left: { createdAt: Date; id: string }, right: { createdAt: Date; id: string }): number {
  return right.createdAt.getTime() - left.createdAt.getTime() || compareOrdinal(right.id, left.id);
}

function exception(input: Omit<SubscriptionBillingPlanException, "fingerprint">) {
  // Subscription-category decoupling (review finding corrected): a type-axis
  // exception's `membershipTypeId` is ALWAYS set and a category-axis one's is
  // ALWAYS null, so the two axes already cannot collide in the ORIGINAL
  // 5-element digest — appending `subscriptionCategoryId` unconditionally
  // would have moved every existing OPEN exception's fingerprint for no
  // reason, which the digest() docblock above explicitly calls a correctness
  // requirement (`where: { fingerprint }` / `notIn: currentFingerprints`),
  // not a cosmetic detail: it would have superseded every one of them as
  // RESOLVED on the next reconcile with nothing actually fixed. The ONLY real
  // gap was two DIFFERENT categories' exceptions for the same member+code,
  // which WOULD collide (both have membershipTypeId null) — so the category
  // id is folded in only on that branch, as a 6th element a type-axis
  // exception never computes and therefore never changes.
  return {
    ...input,
    fingerprint: input.subscriptionCategoryId
      ? digest([
          input.seasonYear, input.code, input.memberId, input.familyGroupId,
          input.membershipTypeId, input.subscriptionCategoryId,
        ])
      : digest([
          input.seasonYear, input.code, input.memberId, input.familyGroupId,
          input.membershipTypeId,
        ]),
  };
}

export async function getSubscriptionBillingDueDays(tx: Prisma.TransactionClient | typeof prisma = prisma) {
  const row = await tx.membershipSubscriptionBillingSettings.findUnique({
    where: { id: "default" },
    select: { invoiceDueDays: true },
  });
  return row?.invoiceDueDays ?? DEFAULT_MEMBERSHIP_SUBSCRIPTION_BILLING_SETTINGS.invoiceDueDays;
}

export async function buildSubscriptionBillingPreview(input: {
  seasonYear: number;
  decisionDate?: Date;
  memberIds?: string[];
  store?: Prisma.TransactionClient | typeof prisma;
  /**
   * The club's financial year-end month, when the caller already holds it.
   * Omitted, it is resolved here - correct for a request path, and REFUSED
   * inside a transaction (see the guard below).
   */
  yearEndMonth?: number;
}): Promise<SubscriptionBillingPreview> {
  const db = input.store ?? prisma;
  // "Today" means the CLUB's calendar day, from its PERSISTED timezone, encoded
  // as the UTC-midnight value every `decisionDate` comparison in this module
  // reads with UTC getters (CT-4, #2870; INV-CONFIG-002). `getTodayDateOnly()`
  // stood here and answered from `APP_TIME_ZONE` — the container's environment,
  // which for a deployment that sets only `TZ` is not the club's zone at all.
  // This value bounds a season and is written into immutable charges.
  //
  // THE DEFAULT IS REFUSED INSIDE A TRANSACTION, and that is a concurrency rule
  // rather than tidiness. `getTodayDateOnly()` was pure; resolving the club's zone
  // is a `ClubTimeSettings` read. Both in-module callers that pass `store` are
  // inside `prisma.$transaction` holding `pg_advisory_xact_lock` on this season,
  // and both already supply an explicit `decisionDate` — so today the read never
  // happens under that lock. Refusing makes that an ENFORCED contract instead of a
  // coincidence a future caller can break silently: a settings query under a
  // held lock buys nothing and lengthens the hold (`booking-request.ts` records
  // the same judgement in its own words), and the confirm path must in any case
  // re-derive from the FROZEN preview's date rather than from a fresh "today".
  if (input.store && !input.decisionDate) {
    throw new SubscriptionBillingError(
      "A preview built inside a transaction must be given its decision date. " +
        "Defaulting it here would read the club's timezone from the database while " +
        "this transaction holds the season's advisory lock, and a confirm must " +
        "re-derive from the frozen preview's date rather than from a fresh today.",
    );
  }
  // The same rule, for the same reason, one release later (#3116). Resolving the
  // financial year-end reads settings and - with no admin override - CALLS XERO
  // for the organisation's accounting year. Under a held `pg_advisory_xact_lock`
  // that is a provider call inside a transaction, which this repository forbids
  // outright. A transactional caller has a preview in hand and passes its frozen
  // `yearEndMonth`.
  if (input.store && input.yearEndMonth === undefined) {
    throw new SubscriptionBillingError(
      "A preview built inside a transaction must be given its financial year-end month. " +
        "Resolving it here would read settings — and possibly call Xero — while this " +
        "transaction holds the season's advisory lock, and a confirm must replay the " +
        "frozen preview's year-end rather than resolve a fresh one.",
    );
  }
  const decisionDate =
    input.decisionDate ??
    dateOnlyInstantOf(clubToday(await readClubTimeZoneOutsideRequest()));
  // Resolved, never defaulted from the `financial-year.ts` cache: this value is
  // written into invoice-line text, and the cache is the March default on any
  // process that did not seed it (#3116).
  const yearEndMonth = input.yearEndMonth ?? (await refreshFinancialYearConfig());
  // Validate the date against the selected membership year before querying,
  // including an otherwise-empty preview.
  const bounds = seasonBounds(input.seasonYear);
  if (decisionDate < bounds.start || decisionDate > bounds.end) {
    throw new SubscriptionBillingError(`Decision date must fall within membership year ${input.seasonYear}.`);
  }
  const [dueDays, familyBillingMode, alreadyCovered, alreadyPaid, existingFamilyCharges, familyInvoiceBlockers, activeFamilyMarkers, members] = await Promise.all([
    getSubscriptionBillingDueDays(db),
    getFamilyBillingMode(db),
    db.membershipSubscriptionChargeCoverage.findMany({
      where: {
        // #2147: only ACTIVE claims block re-billing. A released claim must not
        // keep a member un-billable forever. Two writers release one: the void
        // sync (its Xero invoice was voided/deleted, #2147) and an officer's
        // close of a charge already paid (#4098).
        releasedAt: null,
        subscription: {
          seasonYear: input.seasonYear,
          ...(input.memberIds?.length ? { memberId: { in: input.memberIds } } : {}),
        },
      },
      select: { memberId: true },
    }),
    // #1944 + #2147 (D1) non-clobber / anti-double-billing guard. Skip every
    // member whose season subscription is either already PAID *or* already
    // carries a LIVE Xero invoice link (xeroInvoiceId not null — UNPAID/OVERDUE
    // included). The PAID clause preserves the #1944 manual-mark-paid case
    // (PAID with a null xeroInvoiceId, cash paid outside Xero); the additive
    // xeroInvoiceId clause fixes #2147 — an invoiced-but-unpaid member (e.g.
    // billed by the older Xero-sync path, so no charge-coverage row exists) was
    // passing both the coverage and PAID guards and being re-invoiced. The
    // predicate is ADDITIVE, not a replacement: it never re-bills a manual-PAID
    // member. The invoiced subset (with its invoice number) is surfaced to the
    // admin in the collapsed "Already invoiced" section (D3).
    db.memberSubscription.findMany({
      where: {
        seasonYear: input.seasonYear,
        OR: [{ status: "PAID" }, { xeroInvoiceId: { not: null } }],
        ...(input.memberIds?.length ? { memberId: { in: input.memberIds } } : {}),
      },
      select: {
        memberId: true,
        status: true,
        xeroInvoiceId: true,
        xeroInvoiceNumber: true,
        member: { select: { firstName: true, lastName: true } },
      },
    }),
    db.membershipSubscriptionCharge.findMany({
      where: {
        seasonYear: input.seasonYear,
        billingBasis: "PER_FAMILY",
        familyGroupId: { not: null },
        // #2147: a VOIDED family charge (its Xero invoice was voided/deleted —
        // nobody paid it) has released its coverage and must NOT keep the
        // family un-billable forever, so it is left out here. A NOT_REQUIRED
        // one (an officer closed it as already paid, #4098) IS read: it keeps
        // the family billed — a new joiner still raises FAMILY_ALREADY_BILLED —
        // until a covered member's payment is reversed (owner, #4110). The
        // decision is the `billedFamilyTypes` loop below, from its (released)
        // coverage through `isClosedCoveragePaymentReversed`.
        status: { not: "VOIDED" },
      },
      // Newest first, the order the closed-family rule below reads them in (it
      // also sorts, so the rule never depends on the order rows arrive in).
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        createdAt: true,
        familyGroupId: true,
        membershipTypeId: true,
        // Subscription-category decoupling (review finding): a category
        // charge is minted with billingBasis "PER_FAMILY" too, so this query
        // already matches it — it just didn't used to select the column the
        // generalized `chargeFamilyAxisKey` below needs to tell it apart
        // from a type charge for the same family.
        subscriptionCategoryId: true,
        status: true,
        billingBasis: true,
        coverage: {
          select: {
            memberName: true,
            subscriptionStatusAtClose: true,
            // #4110 review: whether the covered member is still BILLED through
            // this family (the main loop's rule, resolveBillingFamilyMembership)
            // — a member who moved to another family and then had their payment
            // reversed does not re-bill the family they left. The member id is
            // the subscription's, never the coverage snapshot's, which a member
            // merge keeps as the merged-away id.
            subscription: {
              select: {
                memberId: true,
                status: true,
                member: {
                  select: {
                    billingFamilyGroupId: true,
                    familyGroupMemberships: { select: { familyGroupId: true } },
                  },
                },
              },
            },
          },
        },
      },
    }),
    // #2147 FINDING 1 (family-level dedup): every family-group membership whose
    // member already holds a LIVE season Xero invoice (xeroInvoiceId not null)
    // OR an ACTIVE coverage claim (releasedAt IS NULL). The per-member skip-set
    // (coveredSet/paidSet) only suppresses the invoice-HOLDER; a family group
    // billed PER_FAMILY would otherwise mint a SECOND family charge to the
    // recipient because a not-yet-invoiced child (no invoice link, no coverage
    // row) still proceeds through the PER_FAMILY branch and folds the whole
    // family in. Deliberately UNSCOPED by input.memberIds: a scoped
    // NEW_MEMBER_APPROVAL run for just a child must still see the billing
    // member's live invoice on the same family group. The subset is bounded by
    // the number of invoiced/covered members, so this stays cheap.
    db.familyGroupMember.findMany({
      where: {
        member: {
          subscriptions: {
            some: {
              seasonYear: input.seasonYear,
              OR: [
                { xeroInvoiceId: { not: null } },
                { chargeCoverage: { some: { releasedAt: null } } },
              ],
            },
          },
        },
      },
      select: {
        familyGroupId: true,
        memberId: true,
        // #2161 (D1): the holder's own resolved billing basis decides whether a
        // bare live invoice suppresses the family fee, so the same policy/fee
        // resolution the main loop performs (assignment-first membership type →
        // per-tier fee → billingBasis) must run for holders too. Holders may be
        // OUTSIDE the scoped member set (the blocker query is deliberately
        // unscoped), so we fetch the resolution inputs here and reuse the shared
        // memoized resolver — no parallel resolution machinery.
        member: {
          select: {
            firstName: true,
            lastName: true,
            role: true,
            dateOfBirth: true,
            ageTier: true,
            seasonalMembershipAssignments: {
              where: { seasonYear: input.seasonYear },
              take: 1,
              select: {
                membershipType: { select: { id: true, key: true, name: true, subscriptionBehavior: true } },
                // Billing review fix: a holder's bare invoice may be the
                // difference invoice for a CATEGORY-axis closed family
                // charge, not a type-axis one — the holderKey built below
                // needs to know which axis this holder's own assignment is
                // actually on, same as the main loop already resolves for
                // the member being billed.
                subscriptionCategory: { select: { id: true, isActive: true } },
              },
            },
            subscriptions: {
              where: { seasonYear: input.seasonYear },
              take: 1,
              select: {
                xeroInvoiceId: true,
                xeroInvoiceNumber: true,
                status: true,
                // #2161 (D1): where an active coverage claim is the trigger, the
                // basis is derived from the CHARGE row it belongs to (simpler and
                // exact) — a PER_FAMILY charge for this group suppresses; a
                // PER_MEMBER charge's coverage does not.
                chargeCoverage: {
                  where: { releasedAt: null },
                  select: { charge: { select: { billingBasis: true, familyGroupId: true } } },
                },
              },
            },
          },
        },
      },
    }),
    // #2161 (D2): every ACTIVE operator "already invoiced" marker for the season.
    // An active marker suppresses its family group's PER_FAMILY charge regardless
    // of the D1 predicate, closing the double-billing window D1 re-opens for a
    // mixed-basis family whose live invoice sits on a PER_MEMBER-billed member.
    // Uses `db` (the store), so the in-transaction confirm re-preview sees markers
    // committed since the admin previewed, keeping preview/confirm parity.
    db.familyGroupSeasonInvoiceMarker.findMany({
      where: { seasonYear: input.seasonYear, releasedAt: null },
      select: {
        familyGroupId: true,
        note: true,
        markedAt: true,
        markedBy: { select: { firstName: true, lastName: true } },
      },
    }),
    db.member.findMany({
      where: {
        active: true,
        archivedAt: null,
        ...(input.memberIds?.length ? { id: { in: input.memberIds } } : {}),
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        role: true,
        // #2041: DOB drives the season-start age tier for BASED_ON_AGE_TIER
        // liability; ageTier is the fail-closed fallback when DOB is unknown.
        dateOfBirth: true,
        ageTier: true,
        billingFamilyGroupId: true,
        seasonalMembershipAssignments: {
          where: { seasonYear: input.seasonYear },
          take: 1,
          select: {
            membershipType: {
              select: {
                id: true,
                key: true,
                name: true,
                subscriptionBehavior: true,
              },
            },
            // Subscription-category decoupling: the independent billing axis,
            // resolved alongside membershipType but never affecting it — see
            // the category branch at the top of the per-member loop below.
            subscriptionCategory: {
              select: { id: true, key: true, name: true, isActive: true },
            },
          },
        },
        familyGroupMemberships: {
          select: {
            familyGroupId: true,
            familyGroup: {
              select: {
                billingMembership: {
                  select: {
                    familyGroupId: true,
                    member: {
                      select: { id: true, firstName: true, lastName: true, email: true, active: true, archivedAt: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
  ]);

  // #2161 (D1): resolve fallback types for BOTH the scoped members AND the
  // (possibly out-of-scope) invoice-holders the blocker query surfaced, so a
  // holder without a season assignment can still resolve its role-default type
  // for the basis check.
  const fallbackKeys = [...new Set([
    ...members
      .filter((member) => member.seasonalMembershipAssignments.length === 0)
      .map((member) => defaultMembershipTypeKeyForRole(member.role)),
    ...familyInvoiceBlockers
      .filter((blocker) => blocker.member.seasonalMembershipAssignments.length === 0)
      .map((blocker) => defaultMembershipTypeKeyForRole(blocker.member.role)),
  ])];
  const fallbackTypes = fallbackKeys.length > 0
    ? await db.membershipType.findMany({
        where: storedRoleDefaultMembershipTypeWhere(fallbackKeys),
        select: {
          id: true, key: true, name: true, subscriptionBehavior: true,
        },
      })
    : [];
  const fallbackTypeByKey = new Map(fallbackTypes.map((type) => [type.key, type]));

  // #2147 FINDING 1 + #2161 (D1): family groups auto-suppressed from generating a
  // (second) family charge because a member's OWN resolved billing basis is
  // PER_FAMILY and they already hold a live season Xero invoice or a PER_FAMILY
  // coverage claim. familySuppressionInfo carries the representative
  // invoice-holder for the "Already invoiced" audit surface — preferring a member
  // who actually holds a live Xero invoice (so a real invoice number is shown),
  // then deterministic by memberId so preview and the in-transaction confirm
  // re-run agree byte-for-byte. Populated AFTER the memoized fee resolver is
  // defined (below), because the D1 predicate resolves each holder's basis.
  const suppressedFamilyGroupIds = new Set<string>();
  const familySuppressionInfo = new Map<string, {
    holderMemberId: string;
    holderName: string;
    xeroInvoiceNumber: string | null;
    status: SubscriptionStatus | null;
    hasLiveInvoice: boolean;
    // #2161 FINDING 1: the representative holder blocked the family via the
    // fail-closed unresolvable-basis path (surfaced so the operator sees WHY).
    basisUnresolvable: boolean;
  }>();
  // #2161 (D2): ACTIVE operator markers by family group, plus their display info.
  // An active marker suppresses the family regardless of the D1 predicate.
  const markedFamilyGroupIds = new Set(activeFamilyMarkers.map((marker) => marker.familyGroupId));
  const markerInfoByFamilyGroupId = new Map(activeFamilyMarkers.map((marker) => [
    marker.familyGroupId,
    {
      note: marker.note,
      markedByName: marker.markedBy
        ? `${marker.markedBy.firstName} ${marker.markedBy.lastName}`.trim()
        : null,
      markedAt: marker.markedAt,
    },
  ]));
  // Member counts for every family group that MIGHT surface (auto-suppressed or
  // operator-marked), so the audit line can state how many members are covered.
  // Populated after the D1 suppression predicate runs (below), in one cheap
  // grouped read, only when at least one such family exists.
  const familyGroupSizeById = new Map<string, number>();
  // The suppressed family groups actually surfaced by this preview — a family is
  // only surfaced when a not-yet-billed member of it would otherwise have minted
  // a second charge (a fully-invoiced family's members are all skipped per-member
  // before the family branch, and already appear in alreadyInvoiced).
  const suppressedFamiliesSurfaced = new Set<string>();
  const alreadyInvoicedFamilies: SubscriptionBillingPreview["alreadyInvoicedFamilies"] = [];

  const coveredSet = new Set(alreadyCovered.map((row) => row.memberId));
  // #1944 + #2147: members already PAID (manual or Xero) OR holding a live Xero
  // invoice are never re-invoiced (D1). Both clauses feed one skip-set.
  const paidSet = new Set(alreadyPaid.map((row) => row.memberId));
  // #2147 (D3): the invoiced (live xeroInvoiceId) subset, for the "Already
  // invoiced" section. Names come from the joined member row so an already-
  // invoiced member who has since gone inactive still renders correctly.
  const alreadyInvoiced = alreadyPaid
    .filter((row) => row.xeroInvoiceId != null)
    .map((row) => ({
      memberId: row.memberId,
      memberName: row.member
        ? `${row.member.firstName} ${row.member.lastName}`.trim()
        : row.memberId,
      xeroInvoiceNumber: row.xeroInvoiceNumber,
      status: row.status,
    }))
    .sort((left, right) => compareOrdinal(left.memberId, right.memberId));
  // The effective fee depends on the membership type, the member's age tier
  // (#2067 per-tier pricing), and the decision date; the decision date is fixed
  // for the whole preview, so memoize per (type, tier) instead of querying once
  // per member (#1886). An all-flat config resolves every tier to the same flat
  // row inside the resolver, so it stays byte-identical — just keyed per tier.
  const feeByTypeAndTier = new Map<
    string,
    Awaited<ReturnType<typeof getEffectiveMembershipAnnualFee>>
  >();
  const getMemoizedFee = async (membershipTypeId: string, ageTier: AgeTier | null) => {
    const memoKey = `${membershipTypeId}:${ageTier ?? "FLAT"}`;
    if (!feeByTypeAndTier.has(memoKey)) {
      feeByTypeAndTier.set(
        memoKey,
        await getEffectiveMembershipAnnualFee({ membershipTypeId, ageTier }, decisionDate, db),
      );
    }
    return feeByTypeAndTier.get(memoKey) ?? null;
  };
  // Subscription-category decoupling: the category-axis fee resolver, same
  // memoization pattern as getMemoizedFee above but with no age-tier
  // dimension — a SubscriptionCategoryFee is always a single flat row.
  const categoryFeeById = new Map<
    string,
    Awaited<ReturnType<typeof getEffectiveSubscriptionCategoryFee>>
  >();
  const getMemoizedCategoryFee = async (subscriptionCategoryId: string) => {
    if (!categoryFeeById.has(subscriptionCategoryId)) {
      categoryFeeById.set(
        subscriptionCategoryId,
        await getEffectiveSubscriptionCategoryFee({ subscriptionCategoryId }, decisionDate, db),
      );
    }
    return categoryFeeById.get(subscriptionCategoryId) ?? null;
  };
  // #4110 (owner, 15 Oct 2026): which family charges still bill their family.
  // A live charge always does. A charge closed as already paid does until a
  // covered member's PAYMENT is reversed: a member PAID at the close who is no
  // longer settled. An exempt member (NOT_REQUIRED at the close) later moved to
  // NOT_INVOICED by an assignment save or the membership sync reversed nothing,
  // so it never re-bills the family (#4110 review F1). Once a payment is
  // reversed the family is billed again — and when only SOME of the payments
  // were reversed the preview warns the officer that confirming invoices the
  // whole family fee (CLOSED_FAMILY_PARTLY_REVERSED). A live charge for the
  // same key wins over a closed one.
  //
  // Only members still BILLED through the family count (#4110 review): a
  // covered member who moved to another family is not this family's to
  // re-bill. Members the winning closed charge covered while exempt are
  // remembered, so one who later needs a subscription gets an exception that
  // says so rather than the late-joiner wording (and is never silently
  // unbilled).
  //
  // WHICH CHARGE DECIDES (owner, 16 Oct 2026: "newest charge wins"). A live
  // charge for the family/type/season always does. Otherwise the NEWEST closed
  // charge decides alone: while it is still settled it keeps the family
  // billed, even if a payment only an older closed charge covered was
  // reversed. Charges are grouped and sorted here, so the answer never depends
  // on the order the rows arrive in.
  //
  // Newest decides WHETHER the family is billed again; the other closed
  // charges still count for what the officer is told (#4110 review round 4):
  //  - the partial-reversal warning (decision 1) counts every member billed
  //    through the family who was paid at ANY closed charge's close and is
  //    still settled, so a family whose newest charge covered only the
  //    reversed member is still flagged;
  //  - while the family stays billed, a member a closed charge covered who is
  //    no longer settled — exempt at that close and now owing (decision 4), or
  //    paid there and since reversed (decision 5) — gets the decision
  //    exception, whichever closed charge covered them;
  //  - while a reversal under the newest charge would re-bill the family but a
  //    hold keeps it back (#2161 invoice or family charge, or an operator's
  //    marker; rounds 6 and 7), every such member gets it too, the newest
  //    charge's reversed ones included, naming the hold; a new joiner does not;
  //  - a member a closed charge covered who is still settled (a tier-exempt
  //    child still NOT_REQUIRED) is skipped with no exception: there is
  //    nothing to decide, and Mark as paid would refuse their row.
  const billedFamilyTypes = new Map<string, string>();
  const partlyReversedClosedFamilies = new Map<string, { chargeId: string; reversedMemberNames: string[] }>();
  const decisionReasonByFamilyKey = new Map<string, Map<string, ClosedFamilyDecisionReason>>();
  const settledCoveredByFamilyKey = new Map<string, Set<string>>();
  // #4110 review round 5: per closed family/type, the members whose own bare
  // Xero invoice may be Finance's difference invoice (decision 4, choice 2) —
  // exempt at a close, or reversed under an OLDER charge and not paid at the
  // newest close. Only their invoice is let past the #2161 suppression; a
  // member paid at the newest close holds their own family invoice, which
  // keeps suppressing, or a second full family invoice would be minted.
  const differenceInvoiceHoldersByFamilyKey = new Map<string, Set<string>>();
  // ...and, for a family billed again, the holders whose invoice WOULD have
  // held the family (same type, basis not per-member) but passed as a
  // difference invoice, so the officer is warned before confirming (round 5;
  // narrowed in round 6, F3). Filled in the #2161 loop, which has the basis.
  const invoiceHoldersByFamilyKey = new Map<string, Array<{ memberName: string; invoice: string }>>();

  const familyChargesByKey = new Map<string, Array<(typeof existingFamilyCharges)[number]>>();
  for (const charge of [...existingFamilyCharges].sort(newestChargeFirst)) {
    // Generalized (review finding, point 4): this key used to be built from
    // `charge.membershipTypeId` alone, which is null on a category charge —
    // `${null}` stringifies to the literal text "null", silently collapsing
    // every category charge for a family onto one dedup key regardless of
    // which category it actually is. `chargeFamilyAxisKey` is the shared,
    // census-guarded accessor for this (INV-SSOT-007); this is what lets a
    // category charge for a family be found as "already billed" exactly like
    // a type charge for the same family, through the SAME #4110 machinery.
    const key = chargeFamilyAxisKey({
      seasonYear: input.seasonYear,
      familyGroupId: charge.familyGroupId,
      membershipTypeId: charge.membershipTypeId,
      subscriptionCategoryId: charge.subscriptionCategoryId,
    });
    familyChargesByKey.set(key, [...(familyChargesByKey.get(key) ?? []), charge]);
  }
  for (const [key, charges] of familyChargesByKey) {
    const live = charges.find((charge) => !isChargeClosedAsAlreadyPaid(charge));
    if (live) {
      billedFamilyTypes.set(key, live.id);
      continue;
    }
    // Every row of every closed charge for the key, newest charge first, kept
    // only where the member is still billed through that family.
    const familyRows = charges.flatMap((charge) =>
      charge.coverage.filter((row) => isBilledThroughFamily(row.subscription.member, charge.familyGroupId)));
    const newest = charges[0]!;
    const newestRows = newest.coverage.filter((row) => isBilledThroughFamily(row.subscription.member, newest.familyGroupId));
    const reversed = newestRows.filter(isClosedCoveragePaymentReversed);
    const paidAtNewestClose = new Set(newestRows.filter(wasPaidAtClose).map((row) => row.subscription.memberId));
    differenceInvoiceHoldersByFamilyKey.set(key, new Set(familyRows
      .filter((row) => !paidAtNewestClose.has(row.subscription.memberId)
        && (!wasPaidAtClose(row) || isClosedCoveragePaymentReversed(row)))
      .map((row) => row.subscription.memberId)));
    // Per member a closed charge covered who is no longer settled, why the
    // officer must decide if the family is NOT billed again for them: reversed
    // under the newest charge (only when a hold keeps the re-bill back),
    // reversed under an older one, or exempt at a close. Rows run newest
    // charge first, so a member's newest row gives the reason.
    const reversedAtNewest = new Set(reversed.map((row) => row.subscription.memberId));
    const decisions = new Map<string, ClosedFamilyDecisionReason>();
    const settled = new Set<string>();
    for (const row of familyRows) {
      const memberId = row.subscription.memberId;
      if (isSubscriptionSettled(row.subscription.status)) {
        settled.add(memberId);
      } else if (!decisions.has(memberId)) {
        decisions.set(memberId, reversedAtNewest.has(memberId)
          ? "REVERSED_UNDER_NEWEST_CHARGE"
          : wasPaidAtClose(row) ? "REVERSED_UNDER_OLDER_CHARGE" : "EXEMPT_AT_CLOSE");
      }
    }
    decisionReasonByFamilyKey.set(key, decisions);
    if (reversed.length === 0) {
      billedFamilyTypes.set(key, newest.id);
      settledCoveredByFamilyKey.set(key, settled);
      continue;
    }
    // A member's subscription has ONE status, so a reversed member (no longer
    // settled) can never match here: no need to exclude them by id.
    const paymentStillStands = familyRows.some((row) =>
      wasPaidAtClose(row) && isSubscriptionSettled(row.subscription.status));
    if (paymentStillStands) {
      partlyReversedClosedFamilies.set(key, {
        chargeId: newest.id,
        reversedMemberNames: reversed.map((row) => row.memberName).sort(compareOrdinal),
      });
    }
  }

  // Shared across both axes (#4110, folded for category billing per review
  // point 4): given a family-dedup key already built via
  // `chargeFamilyAxisKey` and the member being considered for it, decides
  // what a charge at that key means for them. The caller pushes its own
  // exception with its own axis-specific fields (membershipTypeId vs
  // subscriptionCategoryId) and axis display name (`chargeAxisDisplayName`)
  // — this function only resolves WHICH outcome applies, from the maps the
  // loop above already built generically for both axes.
  // `reason` on "decide" deliberately EXCLUDES "REVERSED_UNDER_NEWEST_CHARGE"
  // — not just by runtime check below, but at the type level, so a caller
  // passing it straight to `closedFamilyMemberDecisionMessage` (whose
  // discriminated union requires `heldBy` only for that one reason) needs no
  // defensive `heldBy` it can never actually supply here.
  type ClosedFamilyDecision =
    | { outcome: "none" }
    | { outcome: "settled" }
    | {
        outcome: "decide";
        reason: Exclude<ClosedFamilyDecisionReason, "REVERSED_UNDER_NEWEST_CHARGE">;
        existingFamilyChargeId: string;
      }
    | { outcome: "already_billed"; existingFamilyChargeId: string };
  function resolveClosedFamilyDecision(groupingKey: string, memberId: string): ClosedFamilyDecision {
    const existingFamilyChargeId = billedFamilyTypes.get(groupingKey);
    if (!existingFamilyChargeId) return { outcome: "none" };
    // A covered member still settled has nothing to decide.
    if (settledCoveredByFamilyKey.get(groupingKey)?.has(memberId)) return { outcome: "settled" };
    const reason = decisionReasonByFamilyKey.get(groupingKey)?.get(memberId);
    // A reversal under the NEWEST charge never reaches here: it is this
    // function's precondition (via billedFamilyTypes having an entry at all)
    // that the newest charge for this key has no reversals — see the
    // `reversed.length === 0` branch above.
    if (reason && reason !== "REVERSED_UNDER_NEWEST_CHARGE") {
      return { outcome: "decide", reason, existingFamilyChargeId };
    }
    return { outcome: "already_billed", existingFamilyChargeId };
  }

  const entries: SubscriptionBillingPlanEntry[] = [];
  const exceptions: SubscriptionBillingPlanException[] = [];
  const familyGroups = new Map<string, SubscriptionBillingPlanEntry>();
  // Cross-axis double-billing guard (review finding): the category branch and
  // the type-axis PER_FAMILY branch key their SOLO-member grouping on
  // `familyGroups`/`categoryGroupingKey` with different `:member:`-shaped
  // strings, and even once both are routed through `billedFamilyTypes` for
  // the family-shaped case, a family with one categorized member and one
  // member still on a PER_FAMILY type would mint a charge from both axes in
  // the SAME run before either axis's own charge exists in the database for
  // the other to see. These two sets close that same-run gap.
  // A family with one categorized member and one member still on a PER_FAMILY
  // type would otherwise get a charge from both axes. These two sets are
  // populated the moment either axis mints or merges a family entry, and are
  // checked by the OTHER axis before it does the same — whichever member is
  // processed first in the loop wins, and the other raises an exception
  // instead of a second charge.
  const categoryBilledFamilyGroupIdsThisRun = new Set<string>();
  const typeBilledFamilyGroupIdsThisRun = new Set<string>();
  const decisionDateOnly = formatDateOnly(decisionDate);
  // #2041: members skipped because a BASED_ON_AGE_TIER type + their season-start
  // tier is not subscription-liable. Age-tier settings are lazy-loaded once (and
  // only when a BASED_ON_AGE_TIER type is actually encountered) so clubs without
  // the feature pay no extra read.
  const exemptMemberIds = new Set<string>();
  // #2148 (D1): parallel display list for the collapsed "Exempt" section — same
  // membership as exemptMemberIds, plus name + the tier that made them exempt.
  const exemptMembers: Array<{ memberId: string; memberName: string; ageTier: AgeTier | null }> = [];
  let ageTierSettingsCache: AgeTierSettingData[] | null = null;
  const getAgeTierSettingsMemoized = async () => {
    if (!ageTierSettingsCache) {
      ageTierSettingsCache = await getAgeTierSettings();
    }
    return ageTierSettingsCache;
  };

  // Billing review fix (age-tier/REQUIRED-type exemption gap): whether a
  // member's type policy exempts them from ANY season subscription, on
  // EITHER billing axis. Shared so the type axis and the category axis
  // cannot resolve a different answer for the same member/season — before
  // this, the category branch asked `loadMemberSubscriptionSettlements`
  // instead (a resolver built for the BOOKING-lockout gate, not this
  // decision), which applies the tier gate unconditionally — even for a
  // REQUIRED type — off the member's live, STORED `ageTier`. The type
  // axis's own gate below only ever applied it for BASED_ON_AGE_TIER, off
  // the season-start tier (stable all season, immune to a mid-season age-up).
  // A REQUIRED-type member is NEVER tier-gated, on either axis.
  function resolveSubscriptionTierExemption(input: {
    subscriptionBehavior: MembershipTypeSubscriptionBehavior;
    seasonStartTier: AgeTier | null;
    ageTierSettings: AgeTierSettingData[];
  }): boolean {
    if (input.subscriptionBehavior === "NOT_REQUIRED") return true;
    if (input.subscriptionBehavior !== "BASED_ON_AGE_TIER") return false;
    return !requiresPaidSubscriptionForAgeTier(input.seasonStartTier, input.ageTierSettings);
  }
  // The season-start tier the exemption gate (and, for a BASED_ON_AGE_TIER
  // type, the fee price itself — #2041/#2067 decision Q3) key off: the age
  // at the START of the club's financial year, derived from DOB so
  // mid-season birthdays never change that season's tier. Shared by both
  // axes so a member's liability can't drift between them for the SAME
  // underlying reason the type axis's own comment above states.
  const resolveSeasonStartTier = async (member: { dateOfBirth: Date | null; ageTier: AgeTier }): Promise<AgeTier | null> => {
    const ageTierSettings = await getAgeTierSettingsMemoized();
    return member.dateOfBirth
      ? computeAgeTierWithSettings(member.dateOfBirth, getSeasonStartDate(input.seasonYear), ageTierSettings)
      : member.ageTier;
  };

  // #2161 (D1): resolve one member's OWN effective billing basis using the SAME
  // policy/fee resolution the main loop performs (assignment-first membership
  // type → per-tier fee → billingBasis), reusing the shared memoized resolver and
  // age-tier settings. Used to decide whether a bare live-invoice holder blocks
  // the family fee; it must work for holders OUTSIDE the scoped member set, which
  // it does because the blocker query fetched the same resolution inputs and the
  // fallback types cover holder roles too.
  // The holder's effective membership type: the season's assignment, else
  // their role's default type — the main loop's own fallback.
  const resolveMemberMembershipType = (holder: (typeof familyInvoiceBlockers)[number]["member"]) =>
    holder.seasonalMembershipAssignments[0]?.membershipType
      ?? fallbackTypeByKey.get(defaultMembershipTypeKeyForRole(holder.role));
  // Billing review fix: the holder's own CURRENT assignment, same source the
  // charge-minting loop reads when it decides which axis's key to write a
  // closed charge's coverage/difference-invoice rows under — so the holder
  // key built below reconstructs the SAME key, on whichever axis the
  // holder's own closed family charge actually used.
  const resolveMemberSubscriptionCategory = (holder: (typeof familyInvoiceBlockers)[number]["member"]) => {
    const category = holder.seasonalMembershipAssignments[0]?.subscriptionCategory;
    return category && category.isActive ? category : null;
  };
  const resolveMemberBillingBasis = async (
    holder: (typeof familyInvoiceBlockers)[number]["member"],
  ): Promise<MembershipFeeBillingBasis | null> => {
    const membershipType = resolveMemberMembershipType(holder);
    if (!membershipType || membershipType.subscriptionBehavior === "NOT_REQUIRED") return null;
    let feeTier: AgeTier | null;
    if (membershipType.subscriptionBehavior === "BASED_ON_AGE_TIER") {
      const ageTierSettings = await getAgeTierSettingsMemoized();
      feeTier = holder.dateOfBirth
        ? computeAgeTierWithSettings(holder.dateOfBirth, getSeasonStartDate(input.seasonYear), ageTierSettings)
        : holder.ageTier;
    } else {
      feeTier = holder.ageTier;
    }
    const fee = await getMemoizedFee(membershipType.id, feeTier);
    return fee?.billingBasis ?? null;
  };

  // #2147 FINDING 1 + #2161 (D1): decide, per surfaced blocker, whether it
  // suppresses ITS family group's PER_FAMILY charge. Coverage trigger: an active
  // claim from a PER_FAMILY charge for THIS family group suppresses (a PER_MEMBER
  // charge's coverage does not). Bare live-invoice trigger (legacy, no charge
  // row): suppress only if the holder's OWN resolved basis is PER_FAMILY.
  for (const row of familyInvoiceBlockers) {
    const sub = row.member.subscriptions[0];
    const coverageSuppresses = (sub?.chargeCoverage ?? []).some(
      (claim) => claim.charge.billingBasis === "PER_FAMILY"
        && claim.charge.familyGroupId === row.familyGroupId,
    );
    let suppresses = coverageSuppresses;
    // #2161 FINDING 1 (FAIL CLOSED): a bare live-invoice holder (no PER_FAMILY
    // coverage claim) suppresses its family unless its OWN basis PROVABLY
    // resolves to a non-PER_FAMILY (PER_MEMBER-ish) value. A null / unresolvable
    // basis — NOT_REQUIRED type, no resolvable type, or no fee row for the type
    // — keeps the family SUPPRESSED rather than silently minting a second family
    // invoice off a not-yet-billed child (e.g. a Life Member parent holding the
    // legacy family invoice resolves to a NOT_REQUIRED basis of null). Suppression
    // lifts ONLY on a proven PER_MEMBER basis — the sole basis under which the
    // holder's live invoice can be their own per-member invoice. PER_FAMILY and
    // NO_INVOICE holders never generate a personal invoice, so a live invoice on
    // them can only be a legacy/family invoice and must keep suppressing. Escape
    // paths for a family wrongly suppressed this way: fix the holder's membership
    // type / fee config, or void the stale invoice in Xero (link nulled + coverage
    // released, then the group re-bills as one entry — see
    // docs/guides/subscriptions.md).
    let basisUnresolvable = false;
    // #4110 review rounds 4 and 5: a bare invoice held by a member a closed
    // charge for this family and type covered without a standing payment —
    // exempt at a close, or reversed under an older charge — is Finance's
    // difference invoice (decision 4), and the closed charge decides whether
    // the family owes, so it does not suppress. Any other bare invoice,
    // including one held by a member paid at the newest close (their own
    // family invoice), keeps suppressing as #2161 requires.
    const holderType = resolveMemberMembershipType(row.member);
    // Billing review fix: a holder's bare invoice can be the difference
    // invoice for either axis's closed family charge — `differenceInvoiceHoldersByFamilyKey`
    // stores a holder under the CLOSED CHARGE's own axis key (built from
    // `charge.membershipTypeId`/`charge.subscriptionCategoryId` above), so
    // this lookup key must be built the same way: from the holder's own
    // CURRENT category assignment when active, never hardcoding
    // subscriptionCategoryId null. A holder reassigned off that category
    // since the charge closed would miss here same as before the fix — the
    // same staleness the main loop's own assignment-first resolution
    // already accepts everywhere else.
    const holderCategory = resolveMemberSubscriptionCategory(row.member);
    const holderKey = holderCategory
      ? chargeFamilyAxisKey({
          seasonYear: input.seasonYear,
          familyGroupId: row.familyGroupId,
          membershipTypeId: null,
          subscriptionCategoryId: holderCategory.id,
        })
      : holderType
        ? chargeFamilyAxisKey({
            seasonYear: input.seasonYear,
            familyGroupId: row.familyGroupId,
            membershipTypeId: holderType.id,
            subscriptionCategoryId: null,
          })
        : null;
    const differenceInvoice = holderKey != null
      && (differenceInvoiceHoldersByFamilyKey.get(holderKey)?.has(row.memberId) ?? false);
    if (!suppresses && sub?.xeroInvoiceId != null) {
      const holderBasis = await resolveMemberBillingBasis(row.member);
      if (holderBasis !== "PER_MEMBER") {
        if (differenceInvoice && holderKey) {
          // It would have held the family: if the family is billed again,
          // the officer is told this member already holds it.
          invoiceHoldersByFamilyKey.set(holderKey, [...(invoiceHoldersByFamilyKey.get(holderKey) ?? []), {
            memberName: `${row.member.firstName} ${row.member.lastName}`.trim(),
            invoice: sub.xeroInvoiceNumber ?? sub.xeroInvoiceId,
          }].sort((left, right) => compareOrdinal(left.memberName, right.memberName) || compareOrdinal(left.invoice, right.invoice)));
        } else {
          suppresses = true;
          basisUnresolvable = holderBasis == null;
        }
      }
    }
    if (!suppresses) continue;
    suppressedFamilyGroupIds.add(row.familyGroupId);
    const candidate = {
      holderMemberId: row.memberId,
      holderName: `${row.member.firstName} ${row.member.lastName}`.trim(),
      xeroInvoiceNumber: sub?.xeroInvoiceNumber ?? null,
      status: sub?.status ?? null,
      hasLiveInvoice: sub?.xeroInvoiceId != null,
      basisUnresolvable,
    };
    const existing = familySuppressionInfo.get(row.familyGroupId);
    if (
      !existing ||
      (candidate.hasLiveInvoice && !existing.hasLiveInvoice) ||
      (candidate.hasLiveInvoice === existing.hasLiveInvoice &&
        candidate.holderMemberId < existing.holderMemberId)
    ) {
      familySuppressionInfo.set(row.familyGroupId, candidate);
    }
  }
  // One grouped read for the sizes of every family that could surface (auto-
  // suppressed OR operator-marked).
  const sizeTargetFamilyGroupIds = new Set([...suppressedFamilyGroupIds, ...markedFamilyGroupIds]);
  if (sizeTargetFamilyGroupIds.size > 0) {
    const sizes = await db.familyGroupMember.groupBy({
      by: ["familyGroupId"],
      where: { familyGroupId: { in: [...sizeTargetFamilyGroupIds] } },
      _count: { memberId: true },
    });
    for (const size of sizes) familyGroupSizeById.set(size.familyGroupId, size._count.memberId);
  }

  for (const member of members) {
    if (coveredSet.has(member.id) || paidSet.has(member.id)) continue;
    const assignment = member.seasonalMembershipAssignments[0];
    const membershipType = assignment?.membershipType
      ?? fallbackTypeByKey.get(defaultMembershipTypeKeyForRole(member.role));
    const memberName = `${member.firstName} ${member.lastName}`.trim();
    if (!membershipType) {
      exceptions.push(exception({
        code: "MISSING_MEMBERSHIP_ASSIGNMENT",
        message: `${memberName} has no membership type for ${input.seasonYear}.`,
        seasonYear: input.seasonYear, memberId: member.id, familyGroupId: null, membershipTypeId: null,
        context: { memberName },
      }));
      continue;
    }
    // ====================================================================
    // Subscription-category decoupling: an independent billing axis. When
    // the member's SeasonalMembershipAssignment carries an active
    // subscriptionCategory, route them through this entirely separate path
    // — their fee comes from SubscriptionCategoryFee, never from
    // membershipType's own fee schedule, and membershipType above is used
    // ONLY for the resolvable-type check already done and for the
    // per-covered-member audit trail below. Booking rights/rate/lockout are
    // untouched either way: they read SeasonalMembershipAssignment.
    // membershipTypeId directly, never anything built in this branch.
    //
    // Deliberately a branch taken BEFORE touching any of the existing
    // type-fee/PER_FAMILY logic below, not a modification of it — a member
    // with no category (the default) falls through to that logic completely
    // unchanged, which is the regression backstop for this whole feature.
    //
    // Review finding (point 3, "one rule for who is exempt"): category
    // billing must not disagree with booking-access about who is exempt, so
    // it does NOT override a type's own exemption the way an earlier design
    // did — a category assignment no longer forces a charge on a member the
    // booking gates would treat as exempt. The check a few lines below routes
    // through `resolveMemberSubscriptionSettlement`
    // (`src/lib/subscription-lockout-facts.ts`), the SAME function
    // `NON_MEMBER_PRICING` repricing and the member-guest gate already trust
    // (`INV-LOCKOUT-020`) — not a fourth, independently-invented exemption
    // rule.
    const subscriptionCategory = assignment?.subscriptionCategory;
    // Review finding: an ARCHIVED category on a live assignment used to fall
    // through to type billing with no trace — a member re-priced (often
    // upward, losing a flat couple/family rate) with nothing in the preview
    // telling the admin why. Raised here, before the active-category branch,
    // so it takes priority over billing rather than silently skipping it.
    if (subscriptionCategory && !subscriptionCategory.isActive) {
      exceptions.push(exception({
        code: "ARCHIVED_SUBSCRIPTION_CATEGORY_ASSIGNED",
        message: `${memberName} is still assigned the archived subscription category ${subscriptionCategory.name}. Re-assign their category (or reactivate it), or clear the assignment, before invoicing — otherwise they would be billed under their membership type instead with no record of why.`,
        seasonYear: input.seasonYear, memberId: member.id, familyGroupId: null,
        membershipTypeId: null, subscriptionCategoryId: subscriptionCategory.id,
        context: { memberName },
      }));
      continue;
    }
    if (subscriptionCategory && subscriptionCategory.isActive) {
      // Review finding (point 3), corrected (billing review, age-tier/
      // REQUIRED-type exemption gap): a member exempt from ANY season
      // subscription (type NOT_REQUIRED, or BASED_ON_AGE_TIER with a
      // tier-exempt season-start age) is never billed via category either
      // — checked first, before any fee/family work, since an exempt member
      // needs none of it. Mirrors the type axis's own `exemptMemberIds`/
      // `exemptMembers` flow below: no charge, confirm still writes/keeps
      // their NOT_REQUIRED row. Uses `resolveSubscriptionTierExemption`,
      // the SAME shared gate the type axis calls below — not
      // `loadMemberSubscriptionSettlements` (a BOOKING-lockout-oriented
      // resolver that used to gate on the member's live STORED tier even
      // for a REQUIRED type, so the same person could be billed on one
      // axis and wrongly exempt on the other).
      const categorySeasonStartTier = membershipType.subscriptionBehavior === "BASED_ON_AGE_TIER"
        ? await resolveSeasonStartTier(member)
        : null;
      const categoryExempt = resolveSubscriptionTierExemption({
        subscriptionBehavior: membershipType.subscriptionBehavior,
        seasonStartTier: categorySeasonStartTier,
        ageTierSettings: await getAgeTierSettingsMemoized(),
      });
      if (categoryExempt) {
        exemptMemberIds.add(member.id);
        exemptMembers.push({ memberId: member.id, memberName, ageTier: categorySeasonStartTier ?? member.ageTier });
        continue;
      }
      // Mirrors the type axis's own PER_FAMILY_FEE_IN_INDIVIDUAL_MODE guard:
      // every SubscriptionCategoryFee is PER_FAMILY-shaped by construction
      // (there is no PER_MEMBER option for a category), so the club's
      // individual-billing-mode toggle forbids it just as flatly as it would
      // a type's PER_FAMILY fee — including for a solo category member, for
      // the same reason the type-axis guard doesn't special-case a solo
      // member of a PER_FAMILY type either.
      if (familyBillingMode === "BILL_MEMBERS_INDIVIDUALLY") {
        exceptions.push(exception({
          code: "PER_FAMILY_FEE_IN_INDIVIDUAL_MODE",
          message: `${subscriptionCategory.name} is a subscription category but this club bills members individually. Change the club's family billing mode, or remove ${memberName}'s subscription category, before invoicing.`,
          seasonYear: input.seasonYear, memberId: member.id, familyGroupId: null,
          membershipTypeId: null, subscriptionCategoryId: subscriptionCategory.id,
          context: { memberName },
        }));
        continue;
      }
      const categoryFee = await getMemoizedCategoryFee(subscriptionCategory.id);
      if (!categoryFee) {
        exceptions.push(exception({
          code: "MISSING_CATEGORY_FEE_SCHEDULE",
          message: `${subscriptionCategory.name} has no effective subscription fee on ${decisionDateOnly}.`,
          seasonYear: input.seasonYear, memberId: member.id, familyGroupId: null,
          membershipTypeId: null, subscriptionCategoryId: subscriptionCategory.id,
          context: { memberName, decisionDate: decisionDateOnly },
        }));
        continue;
      }
      const categoryCalculated = calculateMembershipCharge({
        annualAmountCents: categoryFee.amountCents,
        prorationRule: categoryFee.prorationRule,
        seasonYear: input.seasonYear,
        decisionDate,
      });
      // Family/recipient resolution, reusing the SAME category-agnostic
      // helper the type axis uses (resolveBillingFamilyMembership only ever
      // touches familyGroupMemberships/billingFamilyGroupId). Diverges from
      // the type axis in ONE place: a category member with NO family group
      // (kind "NONE") is NOT an error here — they bill alone at the
      // category's flat rate, since a category (unlike a type's PER_FAMILY
      // fee) is not inherently "whole family or nothing": the club's own
      // mental model is "members who share this category bill together",
      // which collapses to a group of one when there's no partner.
      const familyResolution = resolveBillingFamilyMembership(member);
      let categoryFamilyGroupId: string | null = null;
      let categoryRecipient = { id: member.id, name: memberName, email: member.email };
      if (familyResolution.kind === "AMBIGUOUS") {
        exceptions.push(exception({
          code: "AMBIGUOUS_FAMILY",
          message: `${memberName} belongs to more than one family; choose one before billing.`,
          seasonYear: input.seasonYear, memberId: member.id, familyGroupId: null,
          membershipTypeId: null, subscriptionCategoryId: subscriptionCategory.id,
          context: { memberName, familyGroupIds: member.familyGroupMemberships.map((row) => row.familyGroupId) },
        }));
        continue;
      }
      if (familyResolution.kind === "INVALID_SELECTION") {
        exceptions.push(exception({
          code: "INVALID_BILLING_FAMILY_SELECTION",
          message: `${memberName}'s selected billing family is no longer one of their families; re-select before billing.`,
          seasonYear: input.seasonYear, memberId: member.id, familyGroupId: member.billingFamilyGroupId,
          membershipTypeId: null, subscriptionCategoryId: subscriptionCategory.id,
          context: {
            memberName,
            selectedFamilyGroupId: member.billingFamilyGroupId,
            familyGroupIds: member.familyGroupMemberships.map((row) => row.familyGroupId),
          },
        }));
        continue;
      }
      if (familyResolution.kind === "RESOLVED") {
        const membership = familyResolution.membership;
        categoryFamilyGroupId = membership.familyGroupId;
        const billing = membership.familyGroup.billingMembership;
        if (!billing) {
          exceptions.push(exception({
            code: "MISSING_FAMILY_RECIPIENT",
            message: `Family ${categoryFamilyGroupId} has no explicit billing recipient.`,
            seasonYear: input.seasonYear, memberId: member.id, familyGroupId: categoryFamilyGroupId,
            membershipTypeId: null, subscriptionCategoryId: subscriptionCategory.id,
            context: { memberName },
          }));
          continue;
        }
        if (billing.familyGroupId !== categoryFamilyGroupId || !billing.member.active || billing.member.archivedAt) {
          exceptions.push(exception({
            code: "INVALID_FAMILY_RECIPIENT",
            message: `Family ${categoryFamilyGroupId}'s billing recipient is not an active member of that family.`,
            seasonYear: input.seasonYear, memberId: member.id, familyGroupId: categoryFamilyGroupId,
            membershipTypeId: null, subscriptionCategoryId: subscriptionCategory.id,
            context: { memberName, recipientMemberId: billing.member.id },
          }));
          continue;
        }
        categoryRecipient = {
          id: billing.member.id,
          name: `${billing.member.firstName} ${billing.member.lastName}`.trim(),
          email: billing.member.email,
        };
      }
      // kind === "NONE" falls through with categoryFamilyGroupId staying
      // null and categoryRecipient staying the member themself — solo
      // category billing, not an error.

      // The family-shaped case goes through the shared accessor
      // (INV-SSOT-007) so it lands in the SAME `billedFamilyTypes` map the
      // type axis populates — see `familyChargesByKey` above. The solo case
      // stays a distinct, member-keyed literal: it was never one of the
      // family-dedup call sites the maintainer review named, and
      // `chargeFamilyAxisKey` is specifically a FAMILY key, not a fit for a
      // member-keyed shape.
      const categoryGroupingKey = categoryFamilyGroupId
        ? chargeFamilyAxisKey({
            seasonYear: input.seasonYear,
            familyGroupId: categoryFamilyGroupId,
            membershipTypeId: null,
            subscriptionCategoryId: subscriptionCategory.id,
          })
        : `${input.seasonYear}:category:${subscriptionCategory.id}:member:${member.id}`;

      // Family-level dedup against an existing category OR type charge for
      // this family (#4110, folded for category billing per review point 4
      // — `resolveClosedFamilyDecision` is the SAME function the type axis
      // calls below, fed by the SAME generalized `billedFamilyTypes` map).
      // Solo members need no equivalent: the universal coveredSet/paidSet
      // skip at the top of the loop already makes a re-run idempotent for
      // them.
      //
      // Billing review fix: this now runs BEFORE the suppressed/marked check
      // below, matching the type axis's order. It used to run AFTER — a
      // family already marked "already invoiced" via a bare live Xero
      // invoice or an active coverage claim (checked below) was `continue`d
      // straight past this decision, so a late joiner on a category charge,
      // or a member no longer settled since the family's category charge
      // closed, got no charge and neither FAMILY_ALREADY_BILLED nor
      // CLOSED_FAMILY_MEMBER_NEEDS_DECISION — silently skipped instead.
      if (categoryFamilyGroupId) {
        const decision = resolveClosedFamilyDecision(categoryGroupingKey, member.id);
        if (decision.outcome === "settled") continue;
        if (decision.outcome === "decide") {
          exceptions.push(exception({
            code: CLOSED_FAMILY_MEMBER_NEEDS_DECISION_CODE,
            message: closedFamilyMemberDecisionMessage({
              memberName,
              axisName: subscriptionCategory.name,
              reason: decision.reason,
            }),
            seasonYear: input.seasonYear, memberId: member.id, familyGroupId: categoryFamilyGroupId,
            membershipTypeId: null, subscriptionCategoryId: subscriptionCategory.id,
            context: {
              memberName,
              existingFamilyChargeId: decision.existingFamilyChargeId,
              subscriptionCategoryFeeId: categoryFee.id,
              reason: decision.reason,
            },
          }));
          continue;
        }
        if (decision.outcome === "already_billed") {
          exceptions.push(exception({
            code: "FAMILY_ALREADY_BILLED",
            message: `${memberName} joined family ${categoryFamilyGroupId} after its ${subscriptionCategory.name} fee was billed. The immutable family charge was not changed and no second invoice was created.`,
            seasonYear: input.seasonYear, memberId: member.id, familyGroupId: categoryFamilyGroupId,
            membershipTypeId: null, subscriptionCategoryId: subscriptionCategory.id,
            context: { memberName, existingFamilyChargeId: decision.existingFamilyChargeId, subscriptionCategoryFeeId: categoryFee.id },
          }));
          continue;
        }
        // decision.outcome === "none" falls through to the suppression
        // check next.
      }

      // #2161's operator marker / D1 auto-suppression applies identically
      // regardless of axis — both are keyed purely by familyGroupId, and a
      // category charge's coverage claim already carries billingBasis
      // "PER_FAMILY" (see the entry below), so the existing D1 predicate in
      // the familyInvoiceBlockers loop above already recognizes it with no
      // changes needed there.
      if (categoryFamilyGroupId && (suppressedFamilyGroupIds.has(categoryFamilyGroupId) || markedFamilyGroupIds.has(categoryFamilyGroupId))) {
        // Billing review fix: when this family's existing charge is actually
        // on the OTHER (type) axis, this is a genuine axis conflict, not a
        // benign "someone already invoiced it" — raise
        // MIXED_AXIS_FAMILY_BILLING so the admin fixes the assignment,
        // instead of filing it as an ordinary already-invoiced audit line.
        // `existingFamilyCharges` is the same raw query result
        // `familyChargesByKey`/`billedFamilyTypes` above are built from, so
        // this reads the same ground truth.
        const otherAxisCharge = existingFamilyCharges.find(
          (charge) => charge.familyGroupId === categoryFamilyGroupId && charge.membershipTypeId != null,
        );
        if (otherAxisCharge) {
          exceptions.push(exception({
            code: "MIXED_AXIS_FAMILY_BILLING",
            message: `${memberName}'s family ${categoryFamilyGroupId} already has a membership-type charge. Assign ${subscriptionCategory.name} to every member of the family who should share it, or bill them separately, before invoicing.`,
            seasonYear: input.seasonYear, memberId: member.id, familyGroupId: categoryFamilyGroupId,
            membershipTypeId: null, subscriptionCategoryId: subscriptionCategory.id,
            context: { memberName },
          }));
          continue;
        }
        if (!suppressedFamiliesSurfaced.has(categoryFamilyGroupId)) {
          suppressedFamiliesSurfaced.add(categoryFamilyGroupId);
          const info = familySuppressionInfo.get(categoryFamilyGroupId);
          const marker = markerInfoByFamilyGroupId.get(categoryFamilyGroupId);
          alreadyInvoicedFamilies.push({
            familyGroupId: categoryFamilyGroupId,
            holderMemberId: info?.holderMemberId ?? null,
            holderName: info?.holderName ?? null,
            xeroInvoiceNumber: info?.xeroInvoiceNumber ?? null,
            status: info?.status ?? null,
            holderBasisUnresolvable: info?.basisUnresolvable ?? false,
            membersCovered: familyGroupSizeById.get(categoryFamilyGroupId) ?? 0,
            operatorMarked: marker != null,
            markerNote: marker?.note ?? null,
            markedByName: marker?.markedByName ?? null,
            markedAt: marker?.markedAt ?? null,
          });
        }
        // Billing review fix: copy the membership-type path's "held, so ask
        // the officer" exception (#4110 review rounds 6 and 7) — a member a
        // closed CATEGORY charge covered who is no longer settled is asked
        // about instead of silently skipped. `decisionReasonByFamilyKey` is
        // keyed per-axis via `categoryGroupingKey`, so this only fires for a
        // hold traceable to THIS family's category charge, never a
        // type-axis one (that case was already handled above).
        const heldReason = decisionReasonByFamilyKey.get(categoryGroupingKey)?.get(member.id);
        if (heldReason) {
          const info = familySuppressionInfo.get(categoryFamilyGroupId);
          const heldBy = !info
            ? "an operator's already-invoiced marker"
            : info.hasLiveInvoice
              ? `${info.holderName}'s Xero invoice${info.xeroInvoiceNumber ? ` ${info.xeroInvoiceNumber}` : ""}`
              : `${info.holderName}'s family charge`;
          exceptions.push(exception({
            code: CLOSED_FAMILY_MEMBER_NEEDS_DECISION_CODE,
            message: closedFamilyMemberDecisionMessage({
              memberName, axisName: subscriptionCategory.name, reason: heldReason, heldBy,
            }),
            seasonYear: input.seasonYear,
            memberId: member.id,
            familyGroupId: categoryFamilyGroupId,
            membershipTypeId: null,
            subscriptionCategoryId: subscriptionCategory.id,
            context: { memberName, subscriptionCategoryFeeId: categoryFee.id, reason: heldReason, heldBy },
          }));
        }
        continue;
      }

      const currentCategoryEntry = familyGroups.get(categoryGroupingKey);
      if (currentCategoryEntry) {
        currentCategoryEntry.coveredMembers.push({ id: member.id, name: memberName });
        continue;
      }

      // Cross-axis double-billing guard — see the Set's declaration comment.
      // A type-axis PER_FAMILY member of this SAME family was processed
      // earlier in this loop and already minted/merged a family charge; a
      // category charge for the rest of the family would double-bill it.
      if (categoryFamilyGroupId && typeBilledFamilyGroupIdsThisRun.has(categoryFamilyGroupId)) {
        exceptions.push(exception({
          code: "MIXED_AXIS_FAMILY_BILLING",
          message: `${memberName}'s family ${categoryFamilyGroupId} already has a membership-type charge from another member this run. Assign ${subscriptionCategory.name} to every member of the family who should share it, or bill them separately, before invoicing.`,
          seasonYear: input.seasonYear, memberId: member.id, familyGroupId: categoryFamilyGroupId,
          membershipTypeId: null, subscriptionCategoryId: subscriptionCategory.id,
          context: { memberName },
        }));
        continue;
      }
      if (categoryFamilyGroupId) categoryBilledFamilyGroupIdsThisRun.add(categoryFamilyGroupId);

      // Component invoice lines, same synthetic-default safety net as the
      // type axis's identical block below.
      const definedCategoryComponents = categoryFee.components ?? [];
      const categoryFeeComponents = definedCategoryComponents.length > 0
        ? definedCategoryComponents
        : [{ label: "Subscription fee", amountCents: categoryFee.amountCents, prorate: true, xeroAccountCode: null as string | null, xeroItemCode: null as string | null, sortOrder: 0 }];
      const isSoleCategoryComponent = categoryFeeComponents.length === 1;
      const categoryComponents: SubscriptionBillingComponent[] = categoryFeeComponents.map((component) => ({
        label: component.label,
        description: buildCategoryComponentLineDescription({
          subscriptionCategoryName: subscriptionCategory.name,
          seasonYear: input.seasonYear,
          coveredMonths: categoryCalculated.coveredMonths,
          label: component.label,
          isSoleComponent: isSoleCategoryComponent,
          yearEndMonth,
        }),
        annualAmountCents: component.amountCents,
        chargedAmountCents: componentChargedCents(component.amountCents, component.prorate, categoryCalculated.coveredMonths),
        prorated: component.prorate,
        xeroAccountCode: component.xeroAccountCode ?? null,
        xeroItemCode: component.xeroItemCode ?? null,
        sortOrder: component.sortOrder,
      }));
      const categoryChargedAmountCents = categoryComponents.reduce((sum, component) => sum + component.chargedAmountCents, 0);
      const categoryEntry: SubscriptionBillingPlanEntry = {
        key: categoryGroupingKey,
        seasonYear: input.seasonYear,
        membershipAnnualFeeId: null,
        membershipTypeId: null,
        membershipTypeKey: null,
        membershipTypeName: null,
        subscriptionCategoryId: subscriptionCategory.id,
        subscriptionCategoryKey: subscriptionCategory.key,
        subscriptionCategoryName: subscriptionCategory.name,
        subscriptionCategoryFeeId: categoryFee.id,
        // Always PER_FAMILY-shaped, even for a solo (familyGroupId null)
        // category member — see the SubscriptionCategoryFee schema comment:
        // a category fee is inherently "one charge per group sharing it",
        // never a per-member choice the way a MembershipAnnualFee's
        // billingBasis is.
        billingBasis: "PER_FAMILY",
        prorationRule: categoryFee.prorationRule,
        annualAmountCents: categoryFee.amountCents,
        chargedAmountCents: categoryChargedAmountCents,
        coveredMonths: categoryCalculated.coveredMonths,
        decisionDate: decisionDateOnly,
        coverageStart: formatDateOnly(categoryCalculated.coverageStart),
        coverageEnd: formatDateOnly(categoryCalculated.coverageEnd),
        familyGroupId: categoryFamilyGroupId,
        recipient: categoryRecipient,
        coveredMembers: [{ id: member.id, name: memberName }],
        xeroAccountCode: null,
        xeroItemCode: null,
        components: categoryComponents,
      };
      familyGroups.set(categoryGroupingKey, categoryEntry);
      entries.push(categoryEntry);
      continue;
    }
    // ==================== end subscription-category branch ====================
    if (membershipType.subscriptionBehavior === "NOT_REQUIRED") continue;
    // Per-tier pricing (#2067) + age-tier liability (#2041): for a
    // BASED_ON_AGE_TIER type the fee PRICE and the liability gate must both key
    // off the SAME season-start computed tier — the age at the START of the club
    // financial year (season start = 1st of the FY start month), derived from
    // DOB so mid-season birthdays never change that season's tier (decision Q3;
    // e.g. youth-from-10 with an Apr-start year: a 31 Mar 10th birthday stays a
    // Child all season, a 1 Apr 10th birthday is a Youth that season). Pricing
    // off the STORED tier while gating liability on the computed tier would
    // mis-price a member whose stored tier has drifted from the season-start
    // tier (the age-up cron only maintains the ADULT boundary, and
    // non-current-season billing recomputes) — e.g. liable as YOUTH but charged
    // the CHILD price, or overcharged at ADULT for a prior season. Members
    // without a DOB fall back to their stored tier (ADULT default) — fail-closed
    // / required. Every OTHER policy has no computed tier, so its fee resolves
    // by the member's stored tier (joining-fee convention); a NOT_APPLICABLE
    // tier still short-circuits to the flat fee inside the resolver.
    const seasonStartTier: AgeTier | null = membershipType.subscriptionBehavior === "BASED_ON_AGE_TIER"
      ? await resolveSeasonStartTier(member)
      : null;
    // The tier ACTUALLY used to resolve the fee — also what names a
    // MISSING_FEE_SCHEDULE exception and keys the memo cache: the season-start
    // tier for a BASED_ON_AGE_TIER type, else the member's stored tier.
    const feeTier =
      membershipType.subscriptionBehavior === "BASED_ON_AGE_TIER"
        ? seasonStartTier
        : member.ageTier;
    const fee = await getMemoizedFee(membershipType.id, feeTier);
    // #2041 + #2148 (D1): BASED_ON_AGE_TIER defers per-member liability to the
    // season-start age tier. The exemption gate runs BEFORE MISSING_FEE_SCHEDULE
    // and does NOT require a resolved fee — a deliberately exempt tier
    // (subscriptionRequiredForBooking = false, e.g. CHILD/INFANT) legitimately
    // has no MembershipAnnualFee row, so raising MISSING_FEE_SCHEDULE for it is
    // pure noise (#2148). A member is exempt when their season-start tier is not
    // subscription-liable AND either NO fee resolves for that tier OR the
    // resolved fee is PER_MEMBER. The PER_FAMILY carve-out is deliberate
    // (#2148 constraint 1 / decision Q5): a BASED_ON_AGE_TIER PER_FAMILY fee
    // bills the family once even when a child is tier-exempt, so a resolved
    // PER_FAMILY fee must NOT short-circuit here — the child falls through to the
    // family path below and stays in family coverage. NO_INVOICE fees already
    // mint a zero charge + NOT_REQUIRED row on the entry path, so a resolved
    // NO_INVOICE fee is also left to fall through.
    if (membershipType.subscriptionBehavior === "BASED_ON_AGE_TIER") {
      // Billing review fix: `resolveSubscriptionTierExemption` is the SAME
      // shared gate the category branch above calls — for a
      // BASED_ON_AGE_TIER type (confirmed by this branch already) it
      // reduces to exactly the season-start tier check this always did, so
      // this call changes no behavior here; it exists so the two axes can
      // never drift apart on what counts as tier-exempt.
      const tierExempt = resolveSubscriptionTierExemption({
        subscriptionBehavior: membershipType.subscriptionBehavior,
        seasonStartTier,
        ageTierSettings: await getAgeTierSettingsMemoized(),
      });
      if (
        tierExempt &&
        (!fee || fee.billingBasis === "PER_MEMBER")
      ) {
        // Skip the charge; confirm upserts a NOT_REQUIRED season row (Q4). Join
        // exemptMemberIds (drives the confirm NOT_REQUIRED write — constraint 2),
        // and the display list for the collapsed "Exempt" section.
        exemptMemberIds.add(member.id);
        exemptMembers.push({ memberId: member.id, memberName, ageTier: feeTier });
        continue;
      }
    }
    if (!fee) {
      exceptions.push(exception({
        code: "MISSING_FEE_SCHEDULE",
        message: `${membershipType.name} has no effective annual fee for the ${feeTier} age tier on ${decisionDateOnly}.`,
        seasonYear: input.seasonYear, memberId: member.id, familyGroupId: null,
        membershipTypeId: membershipType.id,
        context: { memberName, decisionDate: decisionDateOnly },
      }));
      continue;
    }
    const calculated = calculateMembershipCharge({
      annualAmountCents: fee.amountCents,
      prorationRule: fee.prorationRule,
      seasonYear: input.seasonYear,
      decisionDate,
    });
    let familyGroupId: string | null = null;
    let recipient = { id: member.id, name: memberName, email: member.email };
    if (fee.billingBasis === "PER_FAMILY") {
      // Mode guard (#159): per-family billing is disallowed while the club bills
      // members individually, so a stale PER_FAMILY schedule surfaces as a
      // visible config exception instead of being silently reinterpreted as
      // per-member. This also makes the never-infer-recipient family branch
      // below (MISSING_FAMILY_RECIPIENT / INVALID_FAMILY_RECIPIENT) unreachable
      // in individual mode, upholding the invariant by construction rather than
      // by assumption.
      if (familyBillingMode === "BILL_MEMBERS_INDIVIDUALLY") {
        exceptions.push(exception({
          code: "PER_FAMILY_FEE_IN_INDIVIDUAL_MODE",
          message: `${membershipType.name} has a per-family fee but this club bills members individually. Change the fee's billing basis before invoicing.`,
          seasonYear: input.seasonYear, memberId: member.id, familyGroupId: null,
          membershipTypeId: membershipType.id, context: { memberName },
        }));
        continue;
      }
      // Multi-family resolution (#1932, E6), shared with the closed-family
      // reversal check (#4110 review) through resolveBillingFamilyMembership.
      // Only reached in BILL_FAMILY_VIA_BILLING_MEMBER mode (the individual-mode
      // guard above already fired). A single-group member ignores the
      // selection; for a multi-group member the admin-chosen
      // billingFamilyGroupId decides, and a stale pointer degrades to a visible
      // exception, never silent misbilling. The chosen family then flows
      // through the SAME downstream recipient checks (MISSING_FAMILY_RECIPIENT /
      // INVALID_FAMILY_RECIPIENT) as an unambiguous family.
      const resolution = resolveBillingFamilyMembership(member);
      const familyGroupIds = member.familyGroupMemberships.map((row) => row.familyGroupId);
      if (resolution.kind === "NONE") {
        exceptions.push(exception({
          code: "MISSING_FAMILY", message: `${memberName} has a per-family fee but is not in a family.`,
          seasonYear: input.seasonYear, memberId: member.id, familyGroupId: null,
          membershipTypeId: membershipType.id, context: { memberName },
        }));
        continue;
      }
      if (resolution.kind === "AMBIGUOUS") {
        exceptions.push(exception({
          code: "AMBIGUOUS_FAMILY", message: `${memberName} belongs to more than one family; choose one before billing.`,
          seasonYear: input.seasonYear, memberId: member.id, familyGroupId: null,
          membershipTypeId: membershipType.id,
          context: { memberName, familyGroupIds },
        }));
        continue;
      }
      if (resolution.kind === "INVALID_SELECTION") {
        exceptions.push(exception({
          code: "INVALID_BILLING_FAMILY_SELECTION",
          message: `${memberName}'s selected billing family is no longer one of their families; re-select before billing.`,
          seasonYear: input.seasonYear, memberId: member.id, familyGroupId: member.billingFamilyGroupId,
          membershipTypeId: membershipType.id,
          context: { memberName, selectedFamilyGroupId: member.billingFamilyGroupId, familyGroupIds },
        }));
        continue;
      }
      const membership = resolution.membership;
      familyGroupId = membership.familyGroupId;
      const billing = membership.familyGroup.billingMembership;
      if (!billing) {
        exceptions.push(exception({
          code: "MISSING_FAMILY_RECIPIENT", message: `Family ${familyGroupId} has no explicit billing recipient.`,
          seasonYear: input.seasonYear, memberId: member.id, familyGroupId,
          membershipTypeId: membershipType.id, context: { memberName },
        }));
        continue;
      }
      if (billing.familyGroupId !== familyGroupId || !billing.member.active || billing.member.archivedAt) {
        exceptions.push(exception({
          code: "INVALID_FAMILY_RECIPIENT", message: `Family ${familyGroupId}'s billing recipient is not an active member of that family.`,
          seasonYear: input.seasonYear, memberId: member.id, familyGroupId,
          membershipTypeId: membershipType.id,
          context: { memberName, recipientMemberId: billing.member.id },
        }));
        continue;
      }
      recipient = {
        id: billing.member.id,
        name: `${billing.member.firstName} ${billing.member.lastName}`.trim(),
        email: billing.member.email,
      };
    }
    const groupingKey = fee.billingBasis === "PER_FAMILY"
      ? chargeFamilyAxisKey({
          seasonYear: input.seasonYear,
          familyGroupId,
          membershipTypeId: membershipType.id,
          subscriptionCategoryId: null,
        })
      : `${input.seasonYear}:${fee.id}:member:${member.id}`;
    // #4110 decisions 4 and 5 (owner, 16 Oct 2026), folded for category
    // billing per review point 4 — `resolveClosedFamilyDecision` is the SAME
    // function the category branch above calls, fed by the SAME generalized
    // `billedFamilyTypes` map: a member a closed charge for this family
    // covered who is no longer settled — exempt at that close and now owing,
    // or paid there and since reversed under an older charge — is not billed
    // through the family. The officer is asked to decide (mark them Paid if
    // the family fee covers everyone, otherwise invoice the difference in
    // Xero by hand); the exception regenerates on every preview until the
    // member is settled or invoiced, so it stays OPEN until Finance acts. A
    // covered member still settled has nothing to decide. Anyone else is a
    // late joiner, as before.
    const typeDecision = resolveClosedFamilyDecision(groupingKey, member.id);
    if (typeDecision.outcome === "settled") continue;
    if (typeDecision.outcome === "decide") {
      exceptions.push(exception({
        code: CLOSED_FAMILY_MEMBER_NEEDS_DECISION_CODE,
        message: closedFamilyMemberDecisionMessage({
          memberName,
          axisName: membershipType.name,
          reason: typeDecision.reason,
        }),
        seasonYear: input.seasonYear,
        memberId: member.id,
        familyGroupId,
        membershipTypeId: membershipType.id,
        context: {
          memberName,
          existingFamilyChargeId: typeDecision.existingFamilyChargeId,
          membershipAnnualFeeId: fee.id,
          reason: typeDecision.reason,
        },
      }));
      continue;
    }
    if (typeDecision.outcome === "already_billed") {
      exceptions.push(exception({
        code: "FAMILY_ALREADY_BILLED",
        message: `${memberName} joined family ${familyGroupId} after its ${membershipType.name} fee was billed. The immutable family charge was not changed and no second invoice was created.`,
        seasonYear: input.seasonYear,
        memberId: member.id,
        familyGroupId,
        membershipTypeId: membershipType.id,
        context: { memberName, existingFamilyChargeId: typeDecision.existingFamilyChargeId, membershipAnnualFeeId: fee.id },
      }));
      continue;
    }
    // typeDecision.outcome === "none" falls through to the rest of the loop.
    // #2147 FINDING 1: family-level dedup. If ANY member of this family group is
    // already billed for the season (a live Xero invoice or an active coverage
    // claim), the whole family is already covered — suppress the ENTIRE group
    // from generating a second family charge and surface it (once) in the
    // "Already invoiced" audit section, rather than minting a duplicate invoice
    // to the recipient off a not-yet-invoiced child. familyGroupId is non-null
    // only on the PER_FAMILY path, so per-member paths are untouched. Placed
    // after FAMILY_ALREADY_BILLED so an existing NEW-system family charge still
    // reports that dedicated exception; this handles the legacy shape where the
    // live invoice lives only on MemberSubscription.xeroInvoiceId with no charge
    // or coverage rows. Once the invoice is voided (link nulled, coverage
    // released) no member blocks the group and it re-bills as one normal entry.
    // #2161 (D2): an operator marker suppresses the family regardless of the D1
    // auto-suppression predicate, so a mixed-basis family whose live invoice sits
    // on a PER_MEMBER-billed member can still be closed out by the operator.
    if (familyGroupId && (suppressedFamilyGroupIds.has(familyGroupId) || markedFamilyGroupIds.has(familyGroupId))) {
      if (!suppressedFamiliesSurfaced.has(familyGroupId)) {
        suppressedFamiliesSurfaced.add(familyGroupId);
        const info = familySuppressionInfo.get(familyGroupId);
        const marker = markerInfoByFamilyGroupId.get(familyGroupId);
        alreadyInvoicedFamilies.push({
          familyGroupId,
          holderMemberId: info?.holderMemberId ?? null,
          holderName: info?.holderName ?? null,
          xeroInvoiceNumber: info?.xeroInvoiceNumber ?? null,
          status: info?.status ?? null,
          holderBasisUnresolvable: info?.basisUnresolvable ?? false,
          membersCovered: familyGroupSizeById.get(familyGroupId) ?? 0,
          operatorMarked: marker != null,
          markerNote: marker?.note ?? null,
          markedByName: marker?.markedByName ?? null,
          markedAt: marker?.markedAt ?? null,
        });
      }
      // #4110 review rounds 6 and 7: the family would have been billed again
      // for a reversal, but it is held. The hold stands (#2161, never a second
      // family invoice); every member a closed charge covered who is no longer
      // settled — reversed under the newest charge, reversed under an older
      // one, or exempt at a close — is asked about instead, naming the hold.
      // Anyone else (a new joiner) is not.
      const heldReason = decisionReasonByFamilyKey.get(groupingKey)?.get(member.id);
      if (heldReason) {
        const info = familySuppressionInfo.get(familyGroupId);
        const heldBy = !info
          ? "an operator's already-invoiced marker"
          : info.hasLiveInvoice
            ? `${info.holderName}'s Xero invoice${info.xeroInvoiceNumber ? ` ${info.xeroInvoiceNumber}` : ""}`
            : `${info.holderName}'s family charge`;
        exceptions.push(exception({
          code: CLOSED_FAMILY_MEMBER_NEEDS_DECISION_CODE,
          message: closedFamilyMemberDecisionMessage({
            memberName, axisName: membershipType.name, reason: heldReason, heldBy,
          }),
          seasonYear: input.seasonYear,
          memberId: member.id,
          familyGroupId,
          membershipTypeId: membershipType.id,
          context: { memberName, membershipAnnualFeeId: fee.id, reason: heldReason, heldBy },
        }));
      }
      continue;
    }
    // Cross-axis double-billing guard — see the Set's declaration comment. A
    // category-axis member of this SAME family was processed earlier in this
    // loop and already minted/merged a family charge; a type-axis PER_FAMILY
    // charge for the rest of the family would double-bill it. Only the
    // PER_FAMILY path can collide this way — a PER_MEMBER/NO_INVOICE
    // `groupingKey` is keyed by member, never by family.
    if (familyGroupId && categoryBilledFamilyGroupIdsThisRun.has(familyGroupId)) {
      exceptions.push(exception({
        code: "MIXED_AXIS_FAMILY_BILLING",
        message: `${memberName}'s family ${familyGroupId} already has a subscription-category charge from another member this run. Assign that member's category to ${memberName} too, or bill them separately, before invoicing.`,
        seasonYear: input.seasonYear, memberId: member.id, familyGroupId,
        membershipTypeId: membershipType.id,
        context: { memberName, membershipAnnualFeeId: fee.id },
      }));
      continue;
    }
    if (familyGroupId) typeBilledFamilyGroupIdsThisRun.add(familyGroupId);
    const current = familyGroups.get(groupingKey);
    if (current) {
      current.coveredMembers.push({ id: member.id, name: memberName });
      continue;
    }
    // Component invoice lines (#1932, E6). The lifecycle invariant guarantees a
    // non-NO_INVOICE fee always has >=1 component; the synthetic default is a
    // belt-and-suspenders safety net that derives the identical single line the
    // backfill would have written, so a fee that somehow lost its components
    // still bills correctly rather than silently charging zero.
    const definedComponents = fee.components ?? [];
    const feeComponents = definedComponents.length > 0
      ? definedComponents
      : [{ label: "Annual membership fee", amountCents: fee.amountCents, prorate: true, xeroAccountCode: null as string | null, xeroItemCode: null as string | null, sortOrder: 0 }];
    const isSoleComponent = feeComponents.length === 1;
    const components: SubscriptionBillingComponent[] = fee.billingBasis === "NO_INVOICE"
      ? []
      : feeComponents.map((component) => ({
          label: component.label,
          description: buildComponentLineDescription({
            membershipTypeName: membershipType.name,
            seasonYear: input.seasonYear,
            coveredMonths: calculated.coveredMonths,
            label: component.label,
            isSoleComponent,
            yearEndMonth,
          }),
          annualAmountCents: component.amountCents,
          chargedAmountCents: componentChargedCents(component.amountCents, component.prorate, calculated.coveredMonths),
          prorated: component.prorate,
          xeroAccountCode: component.xeroAccountCode ?? null,
          xeroItemCode: component.xeroItemCode ?? null,
          sortOrder: component.sortOrder,
        }));
    // The charge total is Σ components (see componentChargedCents). For a
    // single-component fee this equals the fee-level calculation byte-for-byte.
    const chargedAmountCents = fee.billingBasis === "NO_INVOICE"
      ? 0
      : components.reduce((sum, component) => sum + component.chargedAmountCents, 0);
    const entry: SubscriptionBillingPlanEntry = {
      key: groupingKey,
      seasonYear: input.seasonYear,
      membershipAnnualFeeId: fee.id,
      membershipTypeId: membershipType.id,
      membershipTypeKey: membershipType.key,
      membershipTypeName: membershipType.name,
      billingBasis: fee.billingBasis,
      prorationRule: fee.prorationRule,
      annualAmountCents: fee.amountCents,
      chargedAmountCents,
      coveredMonths: calculated.coveredMonths,
      decisionDate: decisionDateOnly,
      coverageStart: formatDateOnly(calculated.coverageStart),
      coverageEnd: formatDateOnly(calculated.coverageEnd),
      familyGroupId,
      recipient,
      coveredMembers: [{ id: member.id, name: memberName }],
      xeroAccountCode: null,
      xeroItemCode: null,
      components,
    };
    familyGroups.set(groupingKey, entry);
    entries.push(entry);
  }

  // #4110 (owner, 15 Oct 2026): a closed family whose payments were only
  // PARTLY reversed is billed again for the whole family fee. The officer is
  // told before confirming; the entry stays, so confirming invoices it.
  for (const entry of entries) {
    const partly = partlyReversedClosedFamilies.get(entry.key);
    if (!partly) continue;
    // Billing review fix: a category entry's `membershipTypeName` is null
    // (the quartet, not the trio, is populated — see the type's own
    // comment), so interpolating it directly rendered "This family's null
    // charge…" for a category family. `chargeAxisDisplayName` is the
    // shared resolver for whichever axis actually billed this entry.
    // `subscriptionCategoryId` must also be passed to `exception()` so its
    // fingerprint folds in the category id — otherwise two different
    // categories warned for the same family+code (both membershipTypeId
    // null) collide onto one fingerprint and only one warning can be
    // stored.
    const axisName = chargeAxisDisplayName({
      membershipTypeName: entry.membershipTypeName,
      subscriptionCategoryName: entry.subscriptionCategoryName ?? null,
    });
    exceptions.push(exception({
      code: CLOSED_FAMILY_PARTLY_REVERSED_CODE,
      message: `This family's ${axisName} charge was closed as already paid, and since then only some of the members who were paid at the close are no longer paid or not required (${partly.reversedMemberNames.join(", ")}). Confirming invoices the full family fee to ${entry.recipient.name}.`,
      seasonYear: input.seasonYear,
      memberId: null,
      familyGroupId: entry.familyGroupId,
      membershipTypeId: entry.membershipTypeId,
      subscriptionCategoryId: entry.subscriptionCategoryId ?? null,
      context: { closedChargeId: partly.chargeId, reversedMemberNames: partly.reversedMemberNames },
    }));
  }
  // #4110 review round 5: the re-bill sits beside a covered member's own live
  // Xero invoice (usually Finance's hand-made difference invoice), so the
  // full family fee may overbill. Warned like a partial reversal.
  for (const entry of entries) {
    const holders = invoiceHoldersByFamilyKey.get(entry.key);
    if (!holders) continue;
    const named = holders.map((holder) => `${holder.memberName} (${holder.invoice})`).join(", ");
    // Billing review fix: same null-axis-name / missing-fingerprint-key gap
    // as the partial-reversal warning above.
    const axisName = chargeAxisDisplayName({
      membershipTypeName: entry.membershipTypeName,
      subscriptionCategoryName: entry.subscriptionCategoryName ?? null,
    });
    exceptions.push(exception({
      code: CLOSED_FAMILY_REBILL_BESIDE_INVOICE_CODE,
      message: `This family's ${axisName} charge was closed as already paid and is now billed again for the full family fee, but ${holders.length === 1 ? "a member it covered already holds a Xero invoice" : "members it covered already hold Xero invoices"} for this season: ${named}. Confirming invoices the full family fee to ${entry.recipient.name} as well; check ${holders.length === 1 ? "that invoice" : "those invoices"} in Xero first.`,
      seasonYear: input.seasonYear,
      memberId: null,
      familyGroupId: entry.familyGroupId,
      membershipTypeId: entry.membershipTypeId,
      subscriptionCategoryId: entry.subscriptionCategoryId ?? null,
      context: { invoiceHolders: holders },
    }));
  }

  // ORDINAL from here down, never `localeCompare` (#3252). `entries` and
  // `exceptions` are serialised into `tokenPayload` below and hashed into
  // `confirmationToken`, which the preview hands to the browser and
  // `api/admin/subscription-billing/route.ts` re-derives and compares when the
  // admin confirms. Those are TWO REQUESTS, and under a blue/green changeover
  // they can be served by two colours at once — so the collation the two
  // derivations resolve is not guaranteed to be the same one.
  //
  // The divergence is not theoretical at this call site. `entry.key` is
  // `<year>:<id>:family:<id>` or `<year>:<id>:member:<id>`, and `:` is
  // punctuation: locale collation orders it BEFORE a digit, a code-unit
  // comparison orders it after, so `"2026:x1a:family:q"` and `"2026:x:member:q"`
  // order oppositely under the two rules (measured). The admin would be told the
  // billing run changed underneath them when nothing had.
  for (const entry of entries) {
    entry.coveredMembers.sort((left, right) => compareOrdinal(left.id, right.id));
  }
  entries.sort((left, right) => compareOrdinal(left.key, right.key));
  const invoiceEntries = entries.filter((entry) => entry.billingBasis !== "NO_INVOICE");
  if (invoiceEntries.length > 0) {
    const mapping = await getResolvedAccountMapping("subscriptionIncome", db);
    if (!mapping.code || !mapping.codeExplicitlyConfigured) {
      // Drop every invoiceable entry, keeping the NO_INVOICE ones. The
      // descending splice loop this replaces was CORRECT — descending is the
      // safe direction for splicing — and this is an equivalent rewrite, not a
      // bug fix: it says the same thing as a filter, which needs no indexed
      // read at all. `entries` is reused rather than rebound because callers
      // above hold the same array (#2800).
      const keptEntries = entries.filter(
        (entry) => entry.billingBasis === "NO_INVOICE",
      );
      entries.length = 0;
      entries.push(...keptEntries);
      exceptions.push(exception({
        code: "MISSING_XERO_ACCOUNT_MAPPING",
        message: "The subscriptionIncome Xero account mapping must be explicitly configured before membership invoices can be queued.",
        seasonYear: input.seasonYear,
        memberId: null,
        familyGroupId: null,
        membershipTypeId: null,
        context: { affectedChargeCount: invoiceEntries.length },
      }));
    } else {
      for (const entry of invoiceEntries) {
        entry.xeroAccountCode = mapping.code;
        entry.xeroItemCode = mapping.itemCode;
        // Resolve each component's account/item: its own override wins, else the
        // frozen subscriptionIncome mapping. After this pass every invoiced
        // component carries a non-null account code, which the charge-component
        // snapshot column requires.
        for (const component of entry.components) {
          component.xeroAccountCode = component.xeroAccountCode ?? mapping.code;
          component.xeroItemCode = component.xeroItemCode ?? mapping.itemCode;
        }
      }
    }
  }
  exceptions.sort((left, right) => compareOrdinal(left.fingerprint, right.fingerprint));
  // Review finding: solo category entries (familyGroupId null) sharing the
  // SAME subscriptionCategoryId, grouped for the ungroupedCategoryMembers
  // informational field above — computed from `entries` after every branch
  // has run, so it sees the final, deduplicated set.
  const soloCategoryEntriesByCategoryId = new Map<string, SubscriptionBillingPlanEntry[]>();
  for (const entry of entries) {
    if (!entry.subscriptionCategoryId || entry.familyGroupId) continue;
    const bucket = soloCategoryEntriesByCategoryId.get(entry.subscriptionCategoryId) ?? [];
    bucket.push(entry);
    soloCategoryEntriesByCategoryId.set(entry.subscriptionCategoryId, bucket);
  }
  const ungroupedCategoryMembers = [...soloCategoryEntriesByCategoryId.entries()]
    .filter(([, categoryEntries]) => categoryEntries.length > 1)
    .map(([subscriptionCategoryId, categoryEntries]) => ({
      subscriptionCategoryId,
      subscriptionCategoryName: categoryEntries[0]?.subscriptionCategoryName ?? "",
      members: categoryEntries
        .flatMap((entry) => entry.coveredMembers.map((covered) => ({ memberId: covered.id, memberName: covered.name })))
        .sort((left, right) => compareOrdinal(left.memberId, right.memberId)),
    }))
    .sort((left, right) => compareOrdinal(left.subscriptionCategoryId, right.subscriptionCategoryId));
  const scopeMemberIds = input.memberIds?.length ? [...new Set(input.memberIds)].sort() : null;
  const tokenPayload = { seasonYear: input.seasonYear, decisionDate: decisionDateOnly, dueDays, scopeMemberIds, entries, exceptions };
  return {
    seasonYear: input.seasonYear,
    decisionDate: decisionDateOnly,
    yearEndMonth,
    dueDays,
    scopeMemberIds,
    entries,
    exceptions,
    alreadyCoveredMemberIds: [...coveredSet].sort(),
    exemptMemberIds: [...exemptMemberIds].sort(),
    // Ordinal too. These two do NOT feed `tokenPayload` — they are returned for
    // display — but they order opaque ids, where locale-aware collation buys a
    // reader nothing, and one rule for the whole file is what makes the census
    // above enforceable without a line-level exemption.
    exemptMembers: [...exemptMembers].sort((left, right) => compareOrdinal(left.memberId, right.memberId)),
    alreadyInvoiced,
    alreadyInvoicedFamilies: alreadyInvoicedFamilies.sort((left, right) =>
      compareOrdinal(left.familyGroupId, right.familyGroupId)),
    totalCents: totalChargedCents(entries),
    confirmationToken: digest(tokenPayload),
    ungroupedCategoryMembers,
  };
}

async function persistOpenExceptions(
  tx: Prisma.TransactionClient,
  source: MembershipSubscriptionChargeSource,
  exceptions: SubscriptionBillingPlanException[],
) {
  const withholdWarnings = confirmWithholdsInvoicingWarnings(source);
  for (const item of exceptions) {
    const warning = isInvoicingPreviewWarning(item.code);
    // #4110: an officer's confirm acknowledges an invoicing warning and bills
    // the family it names, so it is never left OPEN. A confirm with no officer
    // (#4110 review F2) withholds that family instead, so the warning stays
    // OPEN for Finance, saying why it was not invoiced.
    if (warning && !withholdWarnings) continue;
    const message = warning ? `${item.message} ${WITHHELD_ON_APPROVAL_NOTE}` : item.message;
    await tx.membershipBillingException.upsert({
      where: { fingerprint: item.fingerprint },
      update: {
        source,
        status: "OPEN",
        message,
        context: item.context as Prisma.InputJsonValue,
        lastSeenAt: new Date(),
        resolvedAt: null,
      },
      create: { ...item, message, source, context: item.context as Prisma.InputJsonValue },
    });
  }
}


// Resolve every OPEN MembershipBillingException for the season that a fresh
// preview no longer regenerated (its fingerprint is not in currentFingerprints),
// recording the resolution provenance (#2148, D2). `scopedMemberIds`:
//  * null — whole-club scope (a whole-club confirm, or the whole-club preview
//    refresh): every superseded OPEN exception for the season resolves, which
//    already covers club-level null-member exceptions.
//  * an array — partial scope (e.g. a NEW_MEMBER_APPROVAL confirm re-evaluating
//    only some members): resolve only exceptions whose subject the preview
//    actually re-evaluated, OR the club-level MISSING_XERO_ACCOUNT_MAPPING
//    (memberId: null) special case that the confirm path has always folded in
//    (#2148 constraint 4). This is the single scoping definition both the
//    confirm and the preview-reconciliation paths reuse.
async function resolveSupersededExceptions(
  tx: Prisma.TransactionClient,
  input: {
    seasonYear: number;
    currentFingerprints: string[];
    resolvedVia: MembershipBillingExceptionResolution;
    scopedMemberIds: string[] | null;
  },
) {
  return tx.membershipBillingException.updateMany({
    where: {
      seasonYear: input.seasonYear,
      status: "OPEN",
      ...(input.scopedMemberIds ? {
        OR: [
          { memberId: { in: input.scopedMemberIds } },
          { code: "MISSING_XERO_ACCOUNT_MAPPING", memberId: null },
        ],
      } : {}),
      ...(input.currentFingerprints.length ? { fingerprint: { notIn: input.currentFingerprints } } : {}),
    },
    data: { status: "RESOLVED", resolvedAt: new Date(), resolvedVia: input.resolvedVia },
  });
}

// #2148 (D2): auto-resolve stale persisted exceptions on an explicit preview
// refresh. The refresh is whole-club (no memberIds scope), so a fresh preview
// re-evaluates every active member; any OPEN exception it did not regenerate
// (including club-level null-member ones) is superseded and resolved with
// PREVIEW_RECONCILE provenance. This is the ONLY read path that mutates, and it
// is reached exclusively through the edit-gated (finance:edit) refresh action —
// the bare finance:view GET stays read-only (#2148 constraint 3). Runs under the
// same per-season advisory lock as confirm so a refresh and a confirm cannot
// race the exception ledger. Does not create or re-message OPEN exceptions
// (refresh must not persist new rows); the live preview already renders
// still-open exceptions in the current message format.
export async function reconcileSubscriptionBillingExceptions(input: {
  seasonYear: number;
  decisionDate: Date;
  /**
   * Resolved by the request path that calls this, because the preview it builds
   * runs inside the season's advisory lock and must not resolve it there
   * (#3116).
   */
  yearEndMonth: number;
}): Promise<{ resolvedCount: number }> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`membership-subscription-billing:${input.seasonYear}`}))`;
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: input.seasonYear,
      decisionDate: input.decisionDate,
      yearEndMonth: input.yearEndMonth,
      store: tx,
    });
    const result = await resolveSupersededExceptions(tx, {
      seasonYear: input.seasonYear,
      currentFingerprints: preview.exceptions.map((item) => item.fingerprint),
      resolvedVia: "PREVIEW_RECONCILE",
      scopedMemberIds: null,
    });
    return { resolvedCount: result.count };
  });
}

export async function confirmSubscriptionBillingPreview(input: {
  preview: SubscriptionBillingPreview;
  expectedConfirmationToken: string;
  source: MembershipSubscriptionChargeSource;
  confirmedByMemberId?: string;
}) {
  if (input.preview.confirmationToken !== input.expectedConfirmationToken) {
    throw new SubscriptionBillingError("Billing preview changed; refresh and confirm the current preview.");
  }
  const chargeIds: string[] = [];
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`membership-subscription-billing:${input.preview.seasonYear}`}))`;
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: input.preview.seasonYear,
      decisionDate: parseDateOnly(input.preview.decisionDate),
      memberIds: input.preview.scopeMemberIds ?? undefined,
      // The year-end the preview was NAMED from, not a fresh resolve. The
      // descriptions feed `confirmationToken`, so re-resolving here would turn a
      // year-end change between preview and confirm into a token mismatch that
      // reads as "someone else edited the plan" (#3116).
      yearEndMonth: input.preview.yearEndMonth,
      store: tx,
    });
    if (preview.confirmationToken !== input.expectedConfirmationToken) {
      const expectedMemberIds = [...new Set(input.preview.entries.flatMap((entry) =>
        entry.coveredMembers.map((member) => member.id)))];
      const coveredMemberIds = new Set(preview.alreadyCoveredMemberIds);
      if (expectedMemberIds.length > 0 && expectedMemberIds.every((memberId) => coveredMemberIds.has(memberId))) {
        const existing = await tx.membershipSubscriptionChargeCoverage.findMany({
          where: {
            // #2147: match the active-only skip-set — a released claim's chargeId
            // must not be reported as the current coverage for a re-billed member.
            releasedAt: null,
            memberId: { in: expectedMemberIds },
            subscription: { seasonYear: input.preview.seasonYear },
          },
          select: { chargeId: true },
        });
        chargeIds.push(...existing.map((row) => row.chargeId));
        return;
      }
      throw new SubscriptionBillingError("Billing preview changed; refresh and confirm the current preview.");
    }
    const withholdWarnings = confirmWithholdsInvoicingWarnings(input.source);
    const warnings = preview.exceptions.filter((item) => isInvoicingPreviewWarning(item.code));
    // #4110 review F2: with no officer in the loop, a warned family is withheld.
    const withheldFamilyEntryKeys = new Set(withholdWarnings ? warnings.map(invoicingWarningEntryKey) : []);
    const confirmedEntries = preview.entries.filter((entry) =>
      entry.familyGroupId === null || !withheldFamilyEntryKeys.has(invoicingWarningEntryKey(entry)));
    // An officer's confirm bills every warned family, so a warning an earlier
    // approval left OPEN is superseded: leaving its fingerprint out resolves it.
    const currentFingerprints = preview.exceptions
      .filter((item) => withholdWarnings || !isInvoicingPreviewWarning(item.code))
      .map((item) => item.fingerprint);
    const scopedMemberIds = [...new Set([
      ...preview.entries.flatMap((entry) => entry.coveredMembers.map((member) => member.id)),
      ...preview.exceptions.map((item) => item.memberId).filter((id): id is string => Boolean(id)),
      ...preview.alreadyCoveredMemberIds,
    ])];
    // #2148 (D2): resolve superseded exceptions via the shared scoping helper,
    // stamping CONFIRM provenance. A NEW_MEMBER_APPROVAL confirm re-evaluates
    // only its members, so it scopes to those subjects (plus the club-level
    // null-member special case); a whole-club ANNUAL_BATCH confirm resolves every
    // superseded exception (null scope).
    await resolveSupersededExceptions(tx, {
      seasonYear: preview.seasonYear,
      currentFingerprints,
      resolvedVia: "CONFIRM",
      scopedMemberIds: input.source === "NEW_MEMBER_APPROVAL" ? scopedMemberIds : null,
    });
    await persistOpenExceptions(tx, input.source, preview.exceptions);
    for (const entry of confirmedEntries) {
      const subscriptions = [];
      for (const covered of entry.coveredMembers) {
        const subscription = await tx.memberSubscription.upsert({
          where: { memberId_seasonYear: { memberId: covered.id, seasonYear: entry.seasonYear } },
          update: {},
          create: {
            memberId: covered.id,
            seasonYear: entry.seasonYear,
            status: entry.billingBasis === "NO_INVOICE" ? "NOT_REQUIRED" : "NOT_INVOICED",
          },
          // #2147: voidGeneration discriminates a post-void re-bill's idempotency
          // key from the original (released) charge's.
          select: { id: true, memberId: true, voidGeneration: true },
        });
        // #2147: only an ACTIVE coverage claim means "already billed". A released
        // claim (its invoice was voided) must NOT suppress the re-bill.
        const coveredAlready = await tx.membershipSubscriptionChargeCoverage.findFirst({
          where: { subscriptionId: subscription.id, releasedAt: null }, select: { id: true },
        });
        if (!coveredAlready) {
          subscriptions.push({ ...subscription, memberName: covered.name });
        }
      }
      if (subscriptions.length === 0) continue;
      // #2147: fold each covered subscription's voidGeneration into the charge
      // idempotency key so a post-void re-bill mints a NEW charge instead of
      // no-op-ing onto the released (VOIDED) one via the @unique idempotencyKey.
      // When every voidGeneration is 0 (the never-voided case) the key omits the
      // discriminator entirely, staying byte-identical to the pre-#2147 shape so
      // existing charges and re-runs remain idempotent. invoiceReference derives
      // from this key and follows automatically.
      const sortedMemberIds = subscriptions.map((row) => row.memberId).sort();
      const voidGenByMember = new Map(subscriptions.map((row) => [row.memberId, row.voidGeneration ?? 0]));
      const voidGenerations = sortedMemberIds.map((memberId) => voidGenByMember.get(memberId) ?? 0);
      const idempotencyKey = voidGenerations.some((generation) => generation > 0)
        ? digest([entry.key, sortedMemberIds, entry.chargedAmountCents, { voidGenerations }])
        : digest([entry.key, sortedMemberIds, entry.chargedAmountCents]);
      const charge = await tx.membershipSubscriptionCharge.upsert({
        where: { idempotencyKey },
        update: {},
        create: {
          idempotencyKey,
          seasonYear: entry.seasonYear,
          source: input.source,
          status: entry.billingBasis === "NO_INVOICE" ? "NOT_REQUIRED" : "QUEUED",
          membershipAnnualFeeId: entry.membershipAnnualFeeId,
          membershipTypeId: entry.membershipTypeId,
          membershipTypeKey: entry.membershipTypeKey,
          membershipTypeName: entry.membershipTypeName,
          // Subscription-category decoupling: null on every type-axis entry
          // (the trio above carries it instead) — the DB CHECK
          // MembershipCharge_type_xor_category enforces exactly one side set.
          subscriptionCategoryId: entry.subscriptionCategoryId ?? null,
          subscriptionCategoryKey: entry.subscriptionCategoryKey ?? null,
          subscriptionCategoryName: entry.subscriptionCategoryName ?? null,
          subscriptionCategoryFeeId: entry.subscriptionCategoryFeeId ?? null,
          billingBasis: entry.billingBasis,
          prorationRule: entry.prorationRule,
          annualAmountCents: entry.annualAmountCents,
          chargedAmountCents: entry.chargedAmountCents,
          coveredMonths: entry.coveredMonths,
          decisionDate: parseDateOnly(entry.decisionDate),
          coverageStart: parseDateOnly(entry.coverageStart),
          coverageEnd: parseDateOnly(entry.coverageEnd),
          familyGroupId: entry.familyGroupId,
          recipientMemberId: entry.recipient.id,
          recipientName: entry.recipient.name,
          recipientEmail: entry.recipient.email,
          dueDays: preview.dueDays,
          xeroAccountCode: entry.xeroAccountCode,
          xeroItemCode: entry.xeroItemCode,
          invoiceReference: `MEMSUB-${idempotencyKey.slice(0, 24)}`,
          confirmedByMemberId: input.confirmedByMemberId,
          confirmedAt: new Date(),
          coverage: {
            create: subscriptions.map((row) => ({
              subscriptionId: row.id,
              memberId: row.memberId,
              memberName: row.memberName,
            })),
          },
          // Frozen per-line snapshot (#1932, E6), written in the SAME tx and
          // batched into the charge create so the 60s interactive-transaction
          // budget still covers a whole-club run. NO_INVOICE charges have no
          // components. Every invoiced component's account code was resolved in
          // the preview mapping pass, so the non-null column is satisfied.
          ...(entry.billingBasis === "NO_INVOICE" || entry.components.length === 0
            ? {}
            : {
                components: {
                  create: entry.components.map((component) => {
                    // Unmapped components are spliced out during the preview
                    // mapping pass, so this always resolves on the reachable
                    // path. Fail closed rather than mint a blank-account line if
                    // a future regression lets an unmapped component through.
                    const xeroAccountCode = component.xeroAccountCode ?? entry.xeroAccountCode;
                    if (xeroAccountCode == null) {
                      throw new Error(
                        `Annual-fee component "${component.label}" for ${entry.membershipTypeName ?? entry.subscriptionCategoryName} ` +
                          `(recipient ${entry.recipient.id}, season ${entry.seasonYear}) has no resolved ` +
                          `Xero account code; the preview mapping pass should have removed unmapped components before confirm.`,
                      );
                    }
                    return {
                      label: component.label,
                      description: component.description,
                      annualAmountCents: component.annualAmountCents,
                      chargedAmountCents: component.chargedAmountCents,
                      prorated: component.prorated,
                      xeroAccountCode,
                      xeroItemCode: component.xeroItemCode,
                      sortOrder: component.sortOrder,
                    };
                  }),
                },
              }),
        },
        select: { id: true },
      });
      chargeIds.push(charge.id);
      if (entry.billingBasis !== "NO_INVOICE") {
        const correlationKey = buildXeroIdempotencyKey("membership-charge", charge.id, "invoice-and-email", "v1");
        await startXeroSyncOperation({
          ...subscriptionInvoiceOutboxRow(charge.id),
          status: "PENDING",
          idempotencyKey: correlationKey,
          correlationKey,
          createdByMemberId: input.confirmedByMemberId ?? null,
          store: tx,
        });
      }
    }
    // #2041: give each BASED_ON_AGE_TIER tier-exempt member a NOT_REQUIRED
    // season row (decision Q4) so their booking status stays consistent with
    // billing even if the stored tier is promoted mid-season. Uses the fresh
    // in-transaction preview, so members that became PAID/covered since the
    // admin previewed are already excluded. upsert with an empty update NEVER
    // overwrites an existing row (PAID/history stays intact — history-intact
    // invariant), so re-runs are no-ops. No charge and no Xero op are created.
    for (const exemptMemberId of preview.exemptMemberIds) {
      await tx.memberSubscription.upsert({
        where: {
          memberId_seasonYear: {
            memberId: exemptMemberId,
            seasonYear: preview.seasonYear,
          },
        },
        update: {},
        create: {
          memberId: exemptMemberId,
          seasonYear: preview.seasonYear,
          status: "NOT_REQUIRED",
        },
      });
    }
    if (input.confirmedByMemberId) {
      await createAuditLog({
        action: "membership-subscription-billing.confirm",
        category: "payment",
        memberId: input.confirmedByMemberId,
        targetId: String(preview.seasonYear),
        details: JSON.stringify({
          source: input.source,
          confirmationToken: input.expectedConfirmationToken,
          chargeCount: chargeIds.length,
          exceptionCount: countWithheldExceptions(preview.exceptions, input.source),
          // #4110: warnings the officer confirmed through, so the audit row
          // records that a partly reversed family was knowingly re-billed. An
          // approval withholds them instead (#4110 review F2).
          acknowledgedWarnings: withholdWarnings
            ? []
            : warnings.map((item) => ({ code: item.code, familyGroupId: item.familyGroupId, context: item.context })),
          totalCents: totalChargedCents(confirmedEntries),
        }),
      }, tx);
    }
  }, {
    // A whole-club annual run touches every member sequentially; Prisma's
    // default 5s interactive-transaction budget aborts it with P2028 for
    // clubs of a few hundred members. Match the 60s whole-run batch
    // precedent in config-transfer/apply (#1886, F12).
    timeout: 60_000,
  });
  return {
    chargeIds: [...new Set(chargeIds)],
    exceptionCount: countWithheldExceptions(input.preview.exceptions, input.source),
  };
}

/**
 * Exceptions that withheld an invoice. An invoicing warning (#4110) is not one
 * on an officer's confirm, which invoices through it; on an approval it is
 * (#4110 review F2).
 */
function countWithheldExceptions(
  exceptions: readonly SubscriptionBillingPlanException[],
  source: MembershipSubscriptionChargeSource,
): number {
  const withholdWarnings = confirmWithholdsInvoicingWarnings(source);
  return exceptions.filter((item) => withholdWarnings || !isInvoicingPreviewWarning(item.code)).length;
}

export async function queueApprovedMembershipSubscriptionCharges(input: {
  memberIds: string[];
  approvedByMemberId: string;
  decisionDate?: Date;
}) {
  // THE TRAP THIS LANE EXISTS FOR, and it looked like a one-line fix.
  //
  // Approving a membership application arrives here with NO decision date, so
  // this default decides which season the member's FIRST subscription charge —
  // and the Xero invoice queued from it — is written against. On the financial
  // year boundary that is a whole SEASON YEAR, not a day, and the charge is
  // immutable once created.
  //
  // Two things were wrong and only one of them was visible. `getTodayDateOnly()`
  // answered from `APP_TIME_ZONE` (the container's environment) rather than the
  // club's persisted zone; and the season was then derived by
  // `getSeasonYear(decisionDate)`, which read this UTC-midnight encoding with
  // HOST-LOCAL getters — so on any host behind Greenwich 1 April decoded as
  // 31 March and the whole of that day was charged to the previous season.
  //
  // DO NOT "IMPROVE" THIS BY PASSING A BETTER `Date` INTO A HOST-LOCAL READER.
  // Measured across a host x club matrix (#2870, group A): that gives zero wrong
  // days for a host at or ahead of UTC and one ENTIRE wrong day for any host
  // behind it, which took a self-consistent Denver deployment from right to
  // wrong. The club's day is minted here and decoded as an encoding, in UTC, by
  // `seasonYearOfStoredDate`.
  const decisionDate =
    input.decisionDate ??
    dateOnlyInstantOf(clubToday(await readClubTimeZoneOutsideRequest()));
  const seasonYear = seasonYearOfStoredDate(decisionDate);
  const preview = await buildSubscriptionBillingPreview({ seasonYear, decisionDate, memberIds: input.memberIds });
  const result = await confirmSubscriptionBillingPreview({
    preview,
    expectedConfirmationToken: preview.confirmationToken,
    source: "NEW_MEMBER_APPROVAL",
    confirmedByMemberId: input.approvedByMemberId,
  });
  const { enqueueMembershipSubscriptionChargeOperation } = await import("@/lib/xero-subscription-invoices");
  await Promise.all(result.chargeIds.map((chargeId) =>
    enqueueMembershipSubscriptionChargeOperation(chargeId, { createdByMemberId: input.approvedByMemberId })));
  return result;
}
