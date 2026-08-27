/**
 * Joining-fee classification, narration, and preview (#1931, E5).
 *
 * The one-off "joining fee" (formerly "entrance fee") is keyed by a member's
 * membership type x optional age tier. This module is the single source of
 * truth for:
 *   - classifying a member (or raw type+tier/DOB inputs) into a display
 *     category (Adult | Family | Youth | Child) plus the type+tier key the
 *     JoiningFee schedule is resolved by,
 *   - the invoice-line narration (shared BY REFERENCE with the Xero invoice
 *     builder and the admin preview endpoint — item 15),
 *   - the read-only default amount/narration preview.
 *
 * Family is STRICTLY TYPE-DRIVEN: only members assigned the built-in Family
 * membership type resolve the flat family fee. The old composition heuristic
 * (>=2 adults + a dependent) is removed — a deliberate behaviour change flagged
 * in the PR body, docs, and an admin-visible note.
 *
 * The N/A age tier (organisations/schools, #1440) is exempt; this is an
 * age-tier exemption evaluated BEFORE membership-type resolution.
 */

import type { AgeTier, EntranceFeeCategory, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildJoiningFeeNarration } from "@/lib/joining-fee-narration";
import { getEffectiveJoiningFee, type JoiningFeeScheduleSource } from "@/lib/authoritative-fees";
import { resolveMembershipTypePolicyForMember } from "@/lib/membership-type-policy";
import { computeAgeTier } from "@/lib/age-tier";
import { getSeasonStartDate } from "@/lib/policies/age-tier";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { clubSeasonYear } from "@/lib/financial-year";

type JoiningFeeStore = Prisma.TransactionClient | typeof prisma;

export const JOINING_FEE_EXEMPT_MESSAGE =
  "Organisations and schools (N/A age tier) are exempt from joining fees.";

const FAMILY_MEMBERSHIP_TYPE_KEY = "FAMILY";

/**
 * Map a membership type key + age tier to the display category used for the
 * joining-fee narration and the (frozen) Xero reference label. Family is
 * type-driven; every other type derives from the age tier (INFANT folds onto
 * CHILD, matching the schedule fan-out). NOT_APPLICABLE nominally returns ADULT
 * so this stays total, but such members are exempt and never reach billing.
 */
export function deriveJoiningFeeCategory(
  membershipTypeKey: string | null,
  ageTier: AgeTier | null,
): EntranceFeeCategory {
  if (membershipTypeKey === FAMILY_MEMBERSHIP_TYPE_KEY) return "FAMILY";
  if (ageTier === "YOUTH") return "YOUTH";
  if (ageTier === "CHILD" || ageTier === "INFANT") return "CHILD";
  return "ADULT";
}

/**
 * Human display label for a category. Byte-identical to the (frozen) inline
 * label expression in the Xero invoice builder, so preview/narration copy
 * matches what invoicing produces.
 */
export function joiningFeeCategoryLabel(category: EntranceFeeCategory): string {
  return category === "FAMILY"
    ? "Family"
    : category === "YOUTH"
      ? "Youth"
      : category === "CHILD"
        ? "Child"
        : "Adult";
}

// The default narration builder lives in @/lib/joining-fee-narration (see its
// docblock for the referential-reuse contract); re-exported here so existing
// importers keep one import site for the joining-fee API surface.
export { buildJoiningFeeNarration };

export interface MemberJoiningFeeClassification {
  exempt: boolean;
  exemptReason?: string;
  /** null when no membership type could be resolved (graceful runtime skip). */
  membershipTypeId: string | null;
  membershipTypeKey: string | null;
  ageTier: AgeTier | null;
  category: EntranceFeeCategory;
}

async function resolveMembershipTypeId(
  store: JoiningFeeStore,
  membershipTypeKey: string,
  candidateId: string | null,
): Promise<string | null> {
  if (candidateId) return candidateId;
  const row = await store.membershipType.findFirst({
    where: { key: membershipTypeKey },
    select: { id: true },
  });
  return row?.id ?? null;
}

/**
 * Classify a member for joining-fee resolution. Reads the member's age tier and
 * resolves the effective membership type via the shared policy helper. Accepts
 * an optional transaction client (#1886) so approval can classify a member and
 * assignment created inside the still-open transaction.
 */
export async function resolveMemberJoiningFeeClassification(
  memberId: string,
  store: JoiningFeeStore = prisma,
  /**
   * The membership season to resolve the member's type policy in.
   *
   * REQUIRED WHENEVER `store` IS NOT THE GLOBAL CLIENT, and that is a concurrency
   * rule (#2870, correctness review). A caller passing a transaction client is
   * inside a transaction — on the approval path, one holding the application and
   * member-lifecycle advisory locks — and resolving the club's zone here is an
   * uncached read on the GLOBAL client, so a second pool connection under those
   * locks. The season it produces selects the membership-type policy, which
   * selects the `JoiningFee` schedule row, whose `amountCents` is written onto an
   * immutable entrance-fee Xero invoice; and `readPersistedClubTimeZoneRow`
   * swallows every throw, so a pool timeout would resolve the season from the
   * environment seed and charge the wrong joining fee with one warn line as the
   * only evidence.
   *
   * Omitted with the global client — a read-only preview route — it resolves the
   * club's zone itself, which is correct and costs nothing under contention.
   */
  seasonYear?: number,
): Promise<MemberJoiningFeeClassification> {
  if (store !== prisma && seasonYear === undefined) {
    throw new Error(
      "resolveMemberJoiningFeeClassification needs an explicit seasonYear when it is " +
        "given a transaction client: resolving the club's timezone here would read " +
        "ClubTimeSettings on the global client while that transaction holds the " +
        "application and member-lifecycle advisory locks, and the season it produces " +
        "selects the joining fee written onto an immutable invoice.",
    );
  }
  const member = await store.member.findUnique({
    where: { id: memberId },
    select: { ageTier: true },
  });

  if (!member) {
    return {
      exempt: false,
      membershipTypeId: null,
      membershipTypeKey: null,
      ageTier: null,
      category: "ADULT",
    };
  }

  // Age-tier exemption is evaluated BEFORE membership-type resolution (#1440).
  if (member.ageTier === "NOT_APPLICABLE") {
    return {
      exempt: true,
      exemptReason: JOINING_FEE_EXEMPT_MESSAGE,
      membershipTypeId: null,
      membershipTypeKey: null,
      ageTier: member.ageTier,
      category: "ADULT",
    };
  }

  const policy = await resolveMembershipTypePolicyForMember(store, {
    memberId,
    seasonYear:
      seasonYear ?? clubSeasonYear(await readClubTimeZoneOutsideRequest()),
  });

  if (!policy) {
    return {
      exempt: false,
      membershipTypeId: null,
      membershipTypeKey: null,
      ageTier: member.ageTier,
      category: deriveJoiningFeeCategory(null, member.ageTier),
    };
  }

  const membershipTypeKey = policy.membershipType.key;
  const membershipTypeId = await resolveMembershipTypeId(
    store,
    membershipTypeKey,
    policy.membershipType.id,
  );

  return {
    exempt: false,
    membershipTypeId,
    membershipTypeKey,
    ageTier: member.ageTier,
    category: deriveJoiningFeeCategory(membershipTypeKey, member.ageTier),
  };
}

export interface JoiningFeePreview {
  defaultAmountCents: number | null;
  defaultNarration: string;
  exempt: boolean;
  exemptReason?: string;
  effectiveFrom: string | null;
  source: JoiningFeeScheduleSource;
}

async function buildPreview(
  classification: {
    exempt: boolean;
    exemptReason?: string;
    membershipTypeId: string | null;
    ageTier: AgeTier | null;
    category: EntranceFeeCategory;
  },
  options: { asOf: Date; store: JoiningFeeStore },
): Promise<JoiningFeePreview> {
  const defaultNarration = buildJoiningFeeNarration(
    joiningFeeCategoryLabel(classification.category),
  );

  if (classification.exempt) {
    return {
      defaultAmountCents: null,
      defaultNarration,
      exempt: true,
      exemptReason: classification.exemptReason,
      effectiveFrom: null,
      source: "NONE",
    };
  }

  if (!classification.membershipTypeId) {
    return {
      defaultAmountCents: null,
      defaultNarration,
      exempt: false,
      effectiveFrom: null,
      source: "NONE",
    };
  }

  const fee = await getEffectiveJoiningFee(
    { membershipTypeId: classification.membershipTypeId, ageTier: classification.ageTier },
    options.asOf,
    options.store,
  );

  return {
    defaultAmountCents: fee.amountCents,
    defaultNarration,
    exempt: false,
    effectiveFrom: fee.effectiveFrom,
    source: fee.source,
  };
}

/**
 * Preview the default joining-fee amount + narration for an existing member.
 * Read-only; no writes, no Xero calls. Reuses the exact narration builder the
 * invoice line uses (item 15 referential-reuse contract).
 */
export async function getJoiningFeePreviewForMember(
  memberId: string,
  options: {
    /**
     * The day the JoiningFee schedule's effective window is evaluated on
     * (`effectiveFrom <= asOf <= effectiveTo`), REQUIRED since #3123.
     *
     * It is not a lodge night, but it IS "what day is it at the club": when a
     * caller does not name a day it means today, and today has to be the club's
     * own. It used to default to the ENVIRONMENT's day, so a club configured
     * behind its container's zone started quoting a schedule row a day before
     * it took effect — the wrong PRICE, on the fee an applicant is asked to
     * pay. `INV-MONEY`, `docs/AUTHORITATIVE_FEES.md`. The default is deleted
     * rather than replaced by a read in here because both `effectiveFrom` and
     * `effectiveTo` are `@db.Date` calendar days, so their counterpart has to
     * arrive on the same UTC-midnight frame the caller is already working in
     * (`INV-DATE-026`).
     */
    asOf: Date;
    store?: JoiningFeeStore;
  },
): Promise<JoiningFeePreview> {
  const store = options.store ?? prisma;
  const asOf = options.asOf;
  const classification = await resolveMemberJoiningFeeClassification(memberId, store);
  return buildPreview(classification, { asOf, store });
}

export interface JoiningFeeInputs {
  membershipTypeId?: string | null;
  membershipTypeKey?: string | null;
  ageTier?: AgeTier | null;
  /** Optional DOB (date-only or Date) resolved to an age tier for applicants. */
  dateOfBirth?: Date | null;
}

/**
 * Preview the default joining-fee amount + narration for RAW inputs — a
 * membership type (id or key) plus an age tier (or a DOB to resolve one). Used
 * for not-yet-created applicants (E10 consumes this). Read-only.
 */
export async function getJoiningFeePreviewForInputs(
  inputs: JoiningFeeInputs,
  options: {
    /** See {@link getJoiningFeePreviewForMember} — required for the same reason. */
    asOf: Date;
    store?: JoiningFeeStore;
    seasonYear?: number;
  },
): Promise<JoiningFeePreview> {
  const store = options.store ?? prisma;
  const asOf = options.asOf;

  // `computeAgeTier` requires its reference date since #2870, so the season is
  // resolved here — once, on the global client, outside any transaction, which is
  // what this read-only preview route is. It was the LAST call site in the tree
  // omitting it, and closing it is what let `age-tier.ts` drop the uncached
  // zone-reading default that three other paths were reaching through a lock.
  const ageTier: AgeTier | null = inputs.ageTier
    ?? (inputs.dateOfBirth
      ? await computeAgeTier(
          inputs.dateOfBirth,
          getSeasonStartDate(
            options.seasonYear
              ?? clubSeasonYear(await readClubTimeZoneOutsideRequest()),
          ),
        )
      : null);

  // Resolve the membership type's key and id from whichever was supplied.
  let membershipTypeKey = inputs.membershipTypeKey ?? null;
  let membershipTypeId = inputs.membershipTypeId ?? null;
  if (membershipTypeId && !membershipTypeKey) {
    const row = await store.membershipType.findUnique({
      where: { id: membershipTypeId },
      select: { key: true },
    });
    membershipTypeKey = row?.key ?? null;
    if (!row) membershipTypeId = null;
  } else if (membershipTypeKey && !membershipTypeId) {
    membershipTypeId = await resolveMembershipTypeId(store, membershipTypeKey, null);
  }

  const exempt = ageTier === "NOT_APPLICABLE";
  const category = deriveJoiningFeeCategory(membershipTypeKey, ageTier);

  return buildPreview(
    {
      exempt,
      exemptReason: exempt ? JOINING_FEE_EXEMPT_MESSAGE : undefined,
      membershipTypeId,
      ageTier,
      category,
    },
    { asOf, store },
  );
}
