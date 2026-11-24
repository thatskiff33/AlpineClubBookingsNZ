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
import {
  findStaleNotRequiredRows,
  type StaleNotRequiredRow,
} from "@/lib/member-subscription-defaults";
import { SUBSCRIPTION_BILLING_POPULATION_WHERE } from "@/lib/subscription-billing-population";
import {
  SEASON_ROW_STATE_SELECT,
  type SeasonRowState,
} from "@/lib/subscription-season-row-note";

/**
 * What choosing a subscription-liability rule would change (#5190), read-only.
 *
 * Before a club opts in, an officer needs to see who the choice affects. For a
 * proposed pair this compares, for every member in the billing population
 * (`SUBSCRIPTION_BILLING_POPULATION_WHERE`: active, not archived — whom the
 * billing run considers), today's answers —
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
 *    exactly the rows saving the rule would reset (`findStaleNotRequiredRows`,
 *    the clear-up's own selection), including those of members outside the
 *    billing population (inactive or archived), each flagged.
 *
 * Every answer comes from the shared rule (`resolveMemberSubscriptionLiability`)
 * with the same inputs billing and the booking gates read; nothing here is a
 * second copy of it. The admin liability section on the subscription-lockout
 * page shows this list before an officer saves a rule.
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
  staleRecords: StaleNotRequiredRow[];
}

/** The facts one member's three answers are computed from. */
export interface LiabilityImpactFacts {
  memberId: string;
  name: string;
  subscriptionBehavior: Parameters<typeof resolveMemberSubscriptionLiability>[0]["subscriptionBehavior"];
  member: { ageTier: AgeTier; dateOfBirth: Date | null };
  /** Read with `SEASON_ROW_STATE_SELECT`, plus the invoice number. */
  seasonRow: (SeasonRowState & { xeroInvoiceNumber: string | null }) | null;
}

const UNPAID_INVOICE_STATUSES: ReadonlySet<SubscriptionStatus> = new Set(["UNPAID", "OVERDUE"]);

/**
 * The pure comparison, over facts already read. `staleRecords` is passed
 * through as read: it comes from the clear-up's own selection, not from here.
 */
export function classifyLiabilityImpact(input: {
  seasonYear: number;
  current: SubscriptionLiabilitySettings;
  proposed: SubscriptionLiabilitySettings;
  ageTierSettings: AgeTierSettingData[];
  members: LiabilityImpactFacts[];
  staleRecords: StaleNotRequiredRow[];
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
    staleRecords: input.staleRecords,
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
 * Read every billing-population member's facts for the season
 * and classify them. Read-only, and strict: a failed settings read rejects
 * rather than comparing against a default.
 */
export async function buildSubscriptionLiabilityImpact(
  db: ImpactReadDb,
  params: { seasonYear: number; proposed: SubscriptionLiabilitySettings },
): Promise<SubscriptionLiabilityImpact> {
  const { seasonYear } = params;
  const [lockoutSettings, ageTierSettings, members, staleRecords] = await Promise.all([
    loadMembershipLockoutSettingsStrict(db),
    getAgeTierSettingsStrict(db),
    db.member.findMany({
      // The members billing considers, as the billing preview reads them.
      where: { ...SUBSCRIPTION_BILLING_POPULATION_WHERE },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        ageTier: true,
        dateOfBirth: true,
        subscriptions: {
          where: { seasonYear },
          take: 1,
          select: { ...SEASON_ROW_STATE_SELECT, xeroInvoiceNumber: true },
        },
      },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
    }),
    // The rows saving the proposed rule would reset, as the clear-up selects them.
    findStaleNotRequiredRows(db, { seasonYear, settings: params.proposed }),
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
    staleRecords,
    members: members.map((member) => {
      const row = member.subscriptions[0];
      return {
        memberId: member.id,
        name: memberDisplayName(member),
        subscriptionBehavior: policies.get(member.id)?.subscriptionBehavior,
        member,
        seasonRow: row ?? null,
      };
    }),
  });
}
