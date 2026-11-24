import type {
  MembershipTypeSubscriptionBehavior,
  Prisma,
  Role,
} from "@prisma/client";
import { getAgeTierSettingsStrict } from "@/lib/age-tier";
import { loadMembershipLockoutSettingsStrict } from "@/lib/membership-lockout-settings";
import { resolveMembershipTypePoliciesForMembers } from "@/lib/membership-type-policy";
import { effectiveSubscriptionBehavior } from "@/lib/membership-types";
import {
  hasChosenLiabilityRule,
  liabilityRuleFor,
  resolveMemberSubscriptionLiability,
} from "@/lib/policies/subscription";
import { lockSubscriptionBillingSeason } from "@/lib/subscription-billing-season-lock";
import {
  lockSubscriptionLiabilityRuleExclusive,
  lockSubscriptionLiabilityRuleShared,
} from "@/lib/subscription-liability-rule-lock";
import {
  isUntouchedNotRequiredRow,
  UNTOUCHED_NOT_REQUIRED_ROW,
} from "@/lib/subscription-season-row-note";

// Structural client type so the helper works with PrismaClient, a transaction
// client, and the seed script alike.
interface MemberSubscriptionUpsertDb {
  memberSubscription: {
    upsert(args: {
      where: { memberId_seasonYear: { memberId: string; seasonYear: number } };
      update: Record<string, never>;
      create: { memberId: string; seasonYear: number; status: "NOT_REQUIRED" };
    }): Promise<unknown>;
  };
}

/**
 * Create-if-missing a NOT_REQUIRED subscription row for the current season when a
 * BRAND-NEW member's effective membership type does not owe a subscription.
 *
 * #2149 F1: this used to key on a hand-maintained role set
 * (`SUBSCRIPTION_NOT_REQUIRED_ROLES`), a parallel role authority that contradicted
 * the PR's headline principle (membership TYPE is the sole subscription
 * authority; role carries no exemption of its own). A new member has no explicit
 * season assignment yet, so their effective type is the role's built-in default
 * (`defaultMembershipTypeKeyForRole` via `effectiveSubscriptionBehavior(null,
 * role)`) — the SAME shared resolver every read surface, the booking gate, and the
 * Xero sync use. For every real `Role` enum value this is byte-identical to the
 * retired role-set check (ADMIN/LODGE/SCHOOL/NON_MEMBER → NOT_REQUIRED built-ins,
 * USER → FULL/REQUIRED), so creation behaviour is unchanged — but the seed no
 * longer encodes its own role authority.
 *
 * Never overwrites an existing row (`update: {}`), so re-runs are no-ops.
 */
export async function ensureDefaultSeasonSubscriptionForNewMember(
  db: MemberSubscriptionUpsertDb,
  member: { id: string; role: Role },
  /**
   * The club's current season year.
   *
   * REQUIRED since the correctness review of #2870. It was briefly optional, with
   * the fallback resolving the club's zone here — but every read in this function
   * goes through the caller's `db`, and its one caller passes a TRANSACTION client
   * (`admin-members-service.ts`, inside `createAdminMember`'s transaction). A
   * fallback would therefore have opened a second pool connection on the GLOBAL
   * client from inside somebody else's transaction, which is the shape this lane
   * closed in three other places. `createAdminMember` already resolves the club's
   * season before that transaction opens, so the value simply arrives.
   */
  seasonYear: number
): Promise<void> {
  if (effectiveSubscriptionBehavior(null, member.role) !== "NOT_REQUIRED") {
    return;
  }

  await db.memberSubscription.upsert({
    where: { memberId_seasonYear: { memberId: member.id, seasonYear } },
    update: {},
    create: { memberId: member.id, seasonYear, status: "NOT_REQUIRED" },
  });
}

type LiabilityReadDb = Pick<
  Prisma.TransactionClient,
  "membershipLockoutSettings" | "member" | "ageTierSetting"
>;

/**
 * Whether the member owes a subscription for the season on the billing side of
 * the shared liability rule (#5190), read through the caller's transaction.
 * Once the club has chosen, the rule is the same on both sides, so this is the
 * answer billing and booking access both act on; while it is NOT_CHOSEN it is
 * the annual-fee sweep's answer.
 */
async function owesOnBillingSide(
  db: LiabilityReadDb,
  params: {
    memberId: string;
    seasonYear: number;
    subscriptionBehavior: MembershipTypeSubscriptionBehavior;
    settings: Parameters<typeof liabilityRuleFor>[1];
  },
): Promise<boolean> {
  const [member, ageTierSettings] = await Promise.all([
    db.member.findUnique({
      where: { id: params.memberId },
      select: { ageTier: true, dateOfBirth: true },
    }),
    getAgeTierSettingsStrict(db),
  ]);
  return resolveMemberSubscriptionLiability({
    subscriptionBehavior: params.subscriptionBehavior,
    member,
    // The row being reconciled is the NOT_REQUIRED one; billing's side of the
    // rule ignores it, chosen or not.
    seasonRowStatus: "NOT_REQUIRED",
    seasonYear: params.seasonYear,
    rule: liabilityRuleFor("billing", params.settings),
    ageTierSettings,
  }).owes;
}

/**
 * Reconcile a member's MemberSubscription row for one season after a seasonal
 * membership-type ASSIGNMENT change, so a stale creation-seeded NOT_REQUIRED row
 * cannot outlive the assignment that supersedes it (#2149 F1).
 *
 * Scenario: an operational account (e.g. role=ADMIN) is seeded a NOT_REQUIRED
 * season row at creation, then later given a REQUIRED-type season assignment. The
 * booking gate and the annual-fee sweep both treat that member as owing, but the
 * seeded NOT_REQUIRED row still reads "Not Required" on the member detail page,
 * the subscription-history table, and the members list — display and enforcement
 * disagree until the next Xero sync / sweep re-derives (and never, if enforcement
 * is off). This flips the row to the sweep's canonical un-invoiced status.
 *
 * While the club has NOT chosen its liability rule (#5190, every club on
 * upgrade), the scope is deliberately ONLY the REQUIRED direction (mirrors the
 * annual-fee sweep, does not exceed it):
 *   - REQUIRED: the sweep bills EVERY member on a REQUIRED type as NOT_INVOICED
 *     (its `create` status is `NOT_INVOICED`, independent of age tier), and the
 *     booking gate treats them as owing. Flipping the stale NOT_REQUIRED row to
 *     NOT_INVOICED is exactly that canonical state — no new divergence. The
 *     booking gate's age-tier / Xero-enforcement leniency is the same booking-only
 *     bypass display surfaces already omit (see
 *     `isSubscriptionNotRequiredForMembershipType`).
 *   - BASED_ON_AGE_TIER: NOT reconciled. A NOT_REQUIRED current-season row is the
 *     AUTHORITATIVE season-start exemption (#2041) that the booking gate AND every
 *     display surface already honour — they agree, so there is no inconsistency to
 *     fix, and flipping it would destroy that exemption.
 *   - NOT_REQUIRED: already consistent; nothing to do.
 *
 * Once the club HAS chosen, a saved NOT_REQUIRED row exempts nobody (Edge 2,
 * owner decision 18 Nov 2026), so the row is flipped whenever the shared rule
 * says the member owes — for a BASED_ON_AGE_TIER type too — and left alone when
 * it says they do not (a REQUIRED-type child under AGE_TIER_EXEMPTS).
 *
 * The write is a narrow, idempotent, status-guarded `updateMany`: the WHERE
 * guard makes clobbering a paid, invoiced, actively charge/family-covered
 * (releasedAt IS NULL, the #2147 "already billed" rule) or manually-marked row
 * structurally impossible, and a second run matches nothing.
 *
 It takes the liability-rule key SHARED first (#5190), before it reads the
 * club's liability rule. Without it, an assignment committing while a club opts
 * in could read the old (NOT_CHOSEN) rule, skip its row, and commit after the
 * clear-up had already passed that row — leaving a stale NOT_REQUIRED row the
 * chosen rule says should read NOT_INVOICED. The clear-up takes the same key
 * exclusive, so the reconcile runs wholly before it (and the clear-up then sees
 * the row) or wholly after it (and reads the chosen rule).
 *
 * It deliberately does NOT take the billing season key. Its callers already
 * hold `lock(1)`, lodge and member keys, and a billing confirm holds the season
 * key for up to its whole re-preview; waiting on it here would stall every
 * cancel, capture, refund and bed-allocation writer behind that confirm. The
 * clear-up takes the season key BEFORE the rule key, so the rule key is never
 * held by anyone waiting on a confirm. Order: global `1` -> lodge -> member ->
 * rule key (shared), last (docs/CONCURRENCY_AND_LOCKING.md, writer index). It
 * performs NO provider calls, so it is safe to run inside the caller's
 * assignment transaction.
 */
export async function reconcileSeasonSubscriptionForAssignment(
  db: Pick<Prisma.TransactionClient, "memberSubscription" | "$executeRaw"> &
    LiabilityReadDb,
  params: {
    memberId: string;
    seasonYear: number;
    subscriptionBehavior: MembershipTypeSubscriptionBehavior;
  }
): Promise<{ reconciled: boolean }> {
  if (params.subscriptionBehavior === "NOT_REQUIRED") {
    return { reconciled: false };
  }
  await lockSubscriptionLiabilityRuleShared(db);
  const settings = await loadMembershipLockoutSettingsStrict(db);
  // Deliberate scope rule while NOT_CHOSEN (#2041, see above): a
  // BASED_ON_AGE_TIER member's NOT_REQUIRED row is the season-start exemption
  // booking access still honours, so it is never flipped, whatever billing says.
  if (
    !hasChosenLiabilityRule(settings) &&
    params.subscriptionBehavior === "BASED_ON_AGE_TIER"
  ) {
    return { reconciled: false };
  }
  // Otherwise the billing side of the shared rule decides (#5190 review), as
  // the annual-fee sweep and the clear-up read it.
  const owes = await owesOnBillingSide(db, { ...params, settings });
  if (!owes) {
    return { reconciled: false };
  }

  const existing = await db.memberSubscription.findUnique({
    where: {
      memberId_seasonYear: {
        memberId: params.memberId,
        seasonYear: params.seasonYear,
      },
    },
    select: {
      status: true,
      xeroInvoiceId: true,
      manuallyMarkedPaidAt: true,
      // #2147/#2179: chargeCoverage is a to-many list (a released claim is
      // retained alongside any fresh active claim), so the real client always
      // returns an array — never null. Only an ACTIVE claim (releasedAt IS
      // NULL) means "already billed/covered": the same active-only rule as the
      // billing sweep's dedup skip-set and the confirm coveredAlready check. A
      // released claim's charge invoice was voided, which makes the member
      // re-billable, so it must NOT block flipping the stale seed row to the
      // sweep's canonical un-invoiced status.
      chargeCoverage: {
        where: { releasedAt: null },
        take: 1,
        select: { id: true },
      },
    },
  });

  // Only the untouched creation/seed default is reconciled: a paid, invoiced,
  // actively charge/family-covered, or manually-marked row is real billing
  // state and is left alone.
  if (!isUntouchedNotRequiredRow(existing)) {
    return { reconciled: false };
  }

  const result = await db.memberSubscription.updateMany({
    where: {
      memberId: params.memberId,
      seasonYear: params.seasonYear,
      // Re-assert the read guard at write time so a concurrent writer that
      // moved the row between the read above and here still cannot be clobbered.
      ...UNTOUCHED_NOT_REQUIRED_ROW,
    },
    data: { status: "NOT_INVOICED" },
  });

  return { reconciled: result.count > 0 };
}

/**
 * The liability clear-up (#5190): once the club has chosen its liability rule,
 * flip every untouched `NOT_REQUIRED` row for the season whose member the rule
 * says owes a subscription to `NOT_INVOICED` — the annual-fee sweep's canonical
 * un-invoiced status.
 *
 * Why it exists: before the choice, the sweep wrote `NOT_REQUIRED` for a member
 * who was tier-exempt at season start, and booking access honoured that row.
 * Once chosen, the row exempts nobody (Edge 2, owner decision 18 Nov 2026), so a
 * row left saying "Not required" for a member who now owes would contradict the
 * gate on every display surface and in the Xero sync.
 *
 * Runs in the CALLER'S transaction and first takes the billing season key, so it
 * serialises with billing confirm, then the liability-rule key exclusive, so it
 * serialises with the seasonal-assignment reconcile (`INV-LOCK-003`; writer
 * index in docs/CONCURRENCY_AND_LOCKING.md). The write is one status-guarded `updateMany`
 * over {@link UNTOUCHED_NOT_REQUIRED_ROW}, so a paid, invoiced, covered
 * (including a `NO_INVOICE` claim) or manually-marked row is never touched, and
 * a second run matches nothing. A member whose type cannot be resolved is left
 * alone. While the club has not chosen it does nothing. No provider calls.
 */
export async function clearStaleNotRequiredRows(
  tx: Prisma.TransactionClient,
  seasonYear: number,
): Promise<StaleNotRequiredClearUp> {
  const nothingCleared: StaleNotRequiredClearUp = { clearedCount: 0, clearedMemberIds: [] };
  await lockSubscriptionBillingSeason(tx, seasonYear);
  // Season key first, then the rule key: a reconcile holding `lock(1)` waits on
  // the rule key only for this clear-up's own writes, never for a confirm.
  await lockSubscriptionLiabilityRuleExclusive(tx);
  const settings = await loadMembershipLockoutSettingsStrict(tx);
  if (!hasChosenLiabilityRule(settings)) {
    return nothingCleared;
  }
  const rows = await tx.memberSubscription.findMany({
    where: { seasonYear, ...UNTOUCHED_NOT_REQUIRED_ROW },
    select: { memberId: true },
  });
  if (rows.length === 0) {
    return nothingCleared;
  }
  const memberIds = rows.map((row) => row.memberId);
  const [policies, members, ageTierSettings] = await Promise.all([
    resolveMembershipTypePoliciesForMembers(tx, { memberIds, seasonYear }),
    tx.member.findMany({
      where: { id: { in: memberIds } },
      select: { id: true, ageTier: true, dateOfBirth: true },
    }),
    getAgeTierSettingsStrict(tx),
  ]);
  const memberById = new Map(members.map((member) => [member.id, member]));
  const rule = liabilityRuleFor("billing", settings);
  const owingMemberIds = memberIds.filter((memberId) => {
    const policy = policies.get(memberId);
    const member = memberById.get(memberId);
    return (
      policy !== undefined &&
      member !== undefined &&
      resolveMemberSubscriptionLiability({
        subscriptionBehavior: policy.subscriptionBehavior,
        member,
        seasonRowStatus: "NOT_REQUIRED",
        seasonYear,
        rule,
        ageTierSettings,
      }).owes
    );
  });
  if (owingMemberIds.length === 0) {
    return nothingCleared;
  }
  // `AndReturn` so the audit names the rows the guarded write actually moved,
  // not the ones the read proposed: a writer outside the season key (the Xero
  // sync, an invoice write) can move a row in between.
  const flipped = await tx.memberSubscription.updateManyAndReturn({
    where: {
      seasonYear,
      memberId: { in: owingMemberIds },
      ...UNTOUCHED_NOT_REQUIRED_ROW,
    },
    data: { status: "NOT_INVOICED" },
    select: { memberId: true },
  });
  return {
    clearedCount: flipped.length,
    clearedMemberIds: flipped.map((row) => row.memberId).sort(),
  };
}

/** What one clear-up moved. `clearedMemberIds` is every flipped member, sorted. */
export interface StaleNotRequiredClearUp {
  clearedCount: number;
  clearedMemberIds: string[];
}

/** The most member ids one clear-up audit row names; the total is always kept. */
export const CLEARED_ROWS_AUDIT_MEMBER_ID_LIMIT = 50;

/**
 * The audit metadata for one clear-up (#5190): the total, and the flipped
 * member ids capped at {@link CLEARED_ROWS_AUDIT_MEMBER_ID_LIMIT} so one row
 * stays bounded however large the club. The settings `PUT` and the config
 * import both record it, so either path can be traced to the members it moved.
 */
export function clearedRowsAuditMetadata(
  clearUp: StaleNotRequiredClearUp,
  seasonYear: number,
) {
  return {
    seasonYear,
    total: clearUp.clearedCount,
    memberIds: clearUp.clearedMemberIds.slice(0, CLEARED_ROWS_AUDIT_MEMBER_ID_LIMIT),
    memberIdsTruncated:
      clearUp.clearedMemberIds.length > CLEARED_ROWS_AUDIT_MEMBER_ID_LIMIT,
  };
}
