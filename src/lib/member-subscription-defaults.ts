import type {
  MembershipTypeSubscriptionBehavior,
  Prisma,
  Role,
} from "@prisma/client";
import { effectiveSubscriptionBehavior } from "@/lib/membership-types";

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
 * Scope — deliberately ONLY the REQUIRED direction (mirrors the annual-fee sweep,
 * does not exceed it):
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
 * The write is a narrow, idempotent, status-guarded `updateMany` — the same
 * classification as the Xero sync's `writeXeroDerivedSubscriptionState`: no
 * advisory lock is required because the WHERE guard makes clobbering structurally
 * impossible (it never touches a paid, invoiced, actively charge/family-covered
 * — releasedAt IS NULL, the #2147 "already billed" rule — or manually-marked
 * row) and a second run matches nothing. It performs NO provider
 * calls, so it is safe to run inside the caller's assignment transaction.
 */
export async function reconcileSeasonSubscriptionForAssignment(
  db: Pick<Prisma.TransactionClient, "memberSubscription">,
  params: {
    memberId: string;
    seasonYear: number;
    subscriptionBehavior: MembershipTypeSubscriptionBehavior;
  }
): Promise<{ reconciled: boolean }> {
  if (params.subscriptionBehavior !== "REQUIRED") {
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
  if (
    !existing ||
    existing.status !== "NOT_REQUIRED" ||
    existing.xeroInvoiceId !== null ||
    existing.manuallyMarkedPaidAt !== null ||
    existing.chargeCoverage.length > 0
  ) {
    return { reconciled: false };
  }

  const result = await db.memberSubscription.updateMany({
    where: {
      memberId: params.memberId,
      seasonYear: params.seasonYear,
      // Re-assert the read guard at write time so a concurrent writer that
      // moved the row between the read above and here still cannot be clobbered.
      status: "NOT_REQUIRED",
      xeroInvoiceId: null,
      manuallyMarkedPaidAt: null,
      // #2179: the coverage guard must be re-asserted relationally too — a
      // NO_INVOICE billing confirm creates an ACTIVE coverage claim while
      // leaving the row NOT_REQUIRED, so the scalar guards alone cannot
      // exclude a claim that landed between the read above and this write.
      chargeCoverage: { none: { releasedAt: null } },
    },
    data: { status: "NOT_INVOICED" },
  });

  return { reconciled: result.count > 0 };
}
