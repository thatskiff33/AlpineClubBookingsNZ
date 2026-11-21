import type { AgeTier, Prisma, SubscriptionStatus } from "@prisma/client";

import { getAgeTierSettingsStrict } from "@/lib/age-tier";
import { loadMembershipLockoutSettingsStrict } from "@/lib/membership-lockout-settings";
import { resolveMembershipTypePoliciesForMembers } from "@/lib/membership-type-policy";
import type { AgeTierSettingData } from "@/lib/policies/age-tier";
import {
  liabilityRuleFor,
  resolveMemberSubscriptionLiability,
  type SubscriptionLiabilitySettings,
} from "@/lib/policies/subscription";
import { memberDisplayName } from "@/lib/member-serialization";

/**
 * What choosing a subscription-liability rule would change (#5190), read-only.
 *
 * Before a club opts in, an officer needs to see who the choice affects. For a
 * proposed pair this compares, for every current member, today's answers —
 * billing's and booking access's, which may differ only while the club is
 * `NOT_CHOSEN` — with the one answer both sides would give afterwards:
 *
 *  - `newlyOwing`: the proposed rule says they owe, and today at least one side
 *    says they do not (they would be invoiced, or would need to pay to book);
 *  - `noLongerOwing`: the proposed rule says they owe nothing, and today at
 *    least one side says they do, with the number of any unpaid invoice they
 *    already hold (an officer may want to void it);
 *  - `staleRecords`: their season row says "Not required" and nothing has
 *    billed, paid, covered or marked it, but the proposed rule says they owe —
 *    the current members' rows the clear-up (`clearStaleNotRequiredRows`)
 *    would flip. The clear-up also flips archived and cancelled members'
 *    rows, which this list leaves out: it covers current members only.
 *
 * Every answer comes from the shared rule (`resolveMemberSubscriptionLiability`)
 * with the same inputs billing and the booking gates read; nothing here is a
 * second copy of it. The admin liability screen (#5190's second pull request)
 * shows this list; until then it is the endpoint the upgrade runbook names.
 */

export interface LiabilityImpactMember {
  memberId: string;
  name: string;
  /** Whether the billing run's answer changes for them. */
  billingChanges: boolean;
  /** Whether booking access's answer changes for them. */
  accessChanges: boolean;
}

export interface SubscriptionLiabilityImpact {
  seasonYear: number;
  current: SubscriptionLiabilitySettings;
  proposed: SubscriptionLiabilitySettings;
  newlyOwing: LiabilityImpactMember[];
  noLongerOwing: Array<LiabilityImpactMember & { unpaidInvoiceNumber: string | null }>;
  staleRecords: Array<{ memberId: string; name: string }>;
}

/** The facts one member's three answers are computed from. */
export interface LiabilityImpactFacts {
  memberId: string;
  name: string;
  subscriptionBehavior: Parameters<typeof resolveMemberSubscriptionLiability>[0]["subscriptionBehavior"];
  member: { ageTier: AgeTier; dateOfBirth: Date | null };
  seasonRow: {
    status: SubscriptionStatus;
    xeroInvoiceId: string | null;
    xeroInvoiceNumber: string | null;
    manuallyMarkedPaidAt: Date | null;
    hasActiveCoverage: boolean;
  } | null;
}

const UNPAID_INVOICE_STATUSES: ReadonlySet<SubscriptionStatus> = new Set(["UNPAID", "OVERDUE"]);

/** The pure comparison, over facts already read. */
export function classifyLiabilityImpact(input: {
  seasonYear: number;
  current: SubscriptionLiabilitySettings;
  proposed: SubscriptionLiabilitySettings;
  ageTierSettings: AgeTierSettingData[];
  members: LiabilityImpactFacts[];
}): SubscriptionLiabilityImpact {
  const currentBilling = liabilityRuleFor("billing", input.current);
  const currentAccess = liabilityRuleFor("access", input.current);
  // Once chosen, both sides read the same rule; billing's view stands for both.
  const proposedRule = liabilityRuleFor("billing", input.proposed);
  const impact: SubscriptionLiabilityImpact = {
    seasonYear: input.seasonYear,
    current: input.current,
    proposed: input.proposed,
    newlyOwing: [],
    noLongerOwing: [],
    staleRecords: [],
  };
  for (const facts of input.members) {
    const owes = (rule: typeof proposedRule) =>
      resolveMemberSubscriptionLiability({
        subscriptionBehavior: facts.subscriptionBehavior,
        member: facts.member,
        seasonRowStatus: facts.seasonRow?.status,
        seasonYear: input.seasonYear,
        rule,
        ageTierSettings: input.ageTierSettings,
      }).owes;
    const billingNow = owes(currentBilling);
    const accessNow = owes(currentAccess);
    const after = owes(proposedRule);
    const change = {
      memberId: facts.memberId,
      name: facts.name,
      billingChanges: billingNow !== after,
      accessChanges: accessNow !== after,
    };
    if (change.billingChanges || change.accessChanges) {
      if (after) {
        impact.newlyOwing.push(change);
      } else {
        const row = facts.seasonRow;
        impact.noLongerOwing.push({
          ...change,
          unpaidInvoiceNumber:
            row && UNPAID_INVOICE_STATUSES.has(row.status) ? row.xeroInvoiceNumber : null,
        });
      }
    }
    const row = facts.seasonRow;
    // As the clear-up: a member whose type cannot be resolved is left alone.
    if (
      after &&
      facts.subscriptionBehavior != null &&
      row?.status === "NOT_REQUIRED" &&
      row.xeroInvoiceId === null &&
      row.manuallyMarkedPaidAt === null &&
      !row.hasActiveCoverage
    ) {
      impact.staleRecords.push({ memberId: facts.memberId, name: facts.name });
    }
  }
  return impact;
}

type ImpactReadDb = Pick<
  Prisma.TransactionClient,
  | "member"
  | "memberSubscription"
  | "membershipLockoutSettings"
  | "ageTierSetting"
  | "seasonalMembershipAssignment"
  | "membershipType"
>;

/**
 * Read every current (not archived, not cancelled) member's facts for the season
 * and classify them. Read-only, and strict: a failed settings read rejects
 * rather than comparing against a default.
 */
export async function buildSubscriptionLiabilityImpact(
  db: ImpactReadDb,
  params: { seasonYear: number; proposed: SubscriptionLiabilitySettings },
): Promise<SubscriptionLiabilityImpact> {
  const { seasonYear } = params;
  const [lockoutSettings, ageTierSettings, members] = await Promise.all([
    loadMembershipLockoutSettingsStrict(db),
    getAgeTierSettingsStrict(db),
    db.member.findMany({
      where: { archivedAt: null, cancelledAt: null },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        ageTier: true,
        dateOfBirth: true,
        subscriptions: {
          where: { seasonYear },
          take: 1,
          select: {
            status: true,
            xeroInvoiceId: true,
            xeroInvoiceNumber: true,
            manuallyMarkedPaidAt: true,
            chargeCoverage: { where: { releasedAt: null }, take: 1, select: { id: true } },
          },
        },
      },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
    }),
  ]);
  const policies = await resolveMembershipTypePoliciesForMembers(db, {
    memberIds: members.map((member) => member.id),
    seasonYear,
  });
  return classifyLiabilityImpact({
    seasonYear,
    current: {
      requiredTypeAgeRule: lockoutSettings.requiredTypeAgeRule,
      liabilityAgeSource: lockoutSettings.liabilityAgeSource,
    },
    proposed: params.proposed,
    ageTierSettings,
    members: members.map((member) => {
      const row = member.subscriptions[0];
      return {
        memberId: member.id,
        name: memberDisplayName(member),
        subscriptionBehavior: policies.get(member.id)?.subscriptionBehavior,
        member,
        seasonRow: row
          ? {
              status: row.status,
              xeroInvoiceId: row.xeroInvoiceId,
              xeroInvoiceNumber: row.xeroInvoiceNumber,
              manuallyMarkedPaidAt: row.manuallyMarkedPaidAt,
              hasActiveCoverage: row.chargeCoverage.length > 0,
            }
          : null,
      };
    }),
  });
}
