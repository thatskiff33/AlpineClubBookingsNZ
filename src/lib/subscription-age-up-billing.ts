/**
 * Mid-season age-ups under "Age today" in the subscription billing run (#5190
 * PR 3; owner decisions 20 and 27 Nov 2026; `INV-MONEY-051`..`053`).
 *
 * The season charge is billed and priced at the season-start tier. A member
 * whose birthday (or a later in-season join) moves them to another tier then
 * settles the difference for the whole months left, the age-up month included:
 *
 *  - not owing -> owing: a PART-SEASON charge at the new tier. It is an
 *    ordinary season entry with coverage (`REMAINING_MONTHS_INCLUSIVE`, decided
 *    on the age-up day), built by the main preview loop through
 *    {@link AgeUpPlanner.partSeasonCharge}. Its coverage claim is what stops a
 *    second one;
 *  - owing -> owing at a dearer tier: a TOP_UP, a coverage-less charge linked
 *    from a `MemberSubscriptionAgeUpAdjustment`, invoiced and emailed by the
 *    ordinary subscription-invoice outbox;
 *  - owing -> a cheaper tier or not owing: a CREDIT, an adjustment row plus one
 *    outbox operation (`subscription-age-up-credit.ts`).
 *
 * Only the whole-club run (`ANNUAL_BATCH`) settles age-ups: a membership
 * approval previews only its own members and never raises one. A season charge
 * this app did not raise for the member alone (a family or category charge, a
 * hand-marked payment, an older invoice) cannot be adjusted safely, so the
 * preview warns "settle in Xero" instead (`AGE_UP_SETTLE_IN_XERO`, #2400's
 * shared-invoice rule). A warning is never persisted: an officer's confirm
 * invoices through it, and no approval ever sees one.
 *
 * Never twice: the coverage partial index (part-season), the adjustment's
 * `@@unique([memberSubscriptionId, ageUpDate])`, the top-up charge's
 * `idempotencyKey` (built from the subscription and the age-up day, not the
 * amount) and the credit's Xero idempotency key. A voided top-up stays voided:
 * the preview names it and raises nothing.
 */
import type {
  AgeTier,
  MembershipSubscriptionChargeSource,
  MembershipTypeSubscriptionBehavior,
  Prisma,
} from "@prisma/client";
import {
  AGE_UP_ADJUSTMENT_LOCAL_MODEL,
  XERO_OUTBOX_AGE_UP_CREDIT_TYPE,
  buildAgeUpCreditPayload,
} from "@/lib/age-up-credit-payload";
import { formatAgeTierName } from "@/lib/age-tier-name";
import { getEffectiveMembershipAnnualFee } from "@/lib/authoritative-fees";
import {
  calendarDateOfDateOnlyInstant,
  compareCalendarDates,
  dateOnlyInstantOf,
  requireCalendarDate,
  startOfCalendarMonth,
} from "@/lib/club-time";
import { formatDateOnly, parseDateOnly } from "@/lib/date-only";
import { buildAgeUpLineDescription } from "@/lib/membership-charge-calculation";
import type {
  SubscriptionBillingAgeUpAdjustment,
  SubscriptionBillingPlanEntry,
  SubscriptionBillingPreview,
} from "@/lib/membership-subscription-billing-types";
import type { AgeTierSettingData } from "@/lib/policies/age-tier";
import {
  getSeasonEndDate,
  priceAgeUpEvent,
  resolveAgeUpEvent,
  type AgeUpEvent,
  type SubscriptionLiabilityRule,
} from "@/lib/policies/subscription";
import { prisma } from "@/lib/prisma";
import { stableDigest } from "@/lib/stable-digest";
import { compareOrdinal } from "@/lib/ordinal-order";
import { getResolvedAccountMapping } from "@/lib/xero-mappings";
import { subscriptionInvoiceOutboxRow } from "@/lib/xero-operation-outbox-payload";
import { buildXeroIdempotencyKey, startXeroSyncOperation } from "@/lib/xero-sync";

/** The one key for an adjustment's credit, whichever route the worker takes. */
export function ageUpCreditIdempotencyKey(adjustmentId: string): string {
  return buildXeroIdempotencyKey("age-up-adjustment", adjustmentId, "credit", "v1");
}

/**
 * The top-up charge's idempotency key: the subscription and the age-up day,
 * never the amount, so a re-priced re-run cannot mint a second top-up.
 */
export function ageUpTopUpChargeKey(subscriptionId: string, ageUpDate: string): string {
  return stableDigest(["age-up", subscriptionId, ageUpDate]);
}

/**
 * The rule the SEASON charge is judged and priced by. Under "Age today" that is
 * the season-start tier; the age-up parts settle the rest. Every other rule is
 * returned as it is.
 */
export function seasonChargeLiabilityRule(rule: SubscriptionLiabilityRule): SubscriptionLiabilityRule {
  return rule.ageSource === "CURRENT_AGE" ? { ...rule, ageSource: "SEASON_START" } : rule;
}

type Db = Prisma.TransactionClient | typeof prisma;
type AnnualFee = NonNullable<Awaited<ReturnType<typeof getEffectiveMembershipAnnualFee>>>;
type MembershipTypeRef = {
  id: string;
  key: string;
  name: string;
  subscriptionBehavior: MembershipTypeSubscriptionBehavior;
};

/** The member facts the planner reads, as the preview's member query selects them. */
export interface AgeUpPlanMember {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  dateOfBirth: Date | null;
  joinedDate: Date | null;
  ageTier: AgeTier;
  seasonalMembershipAssignments: Array<{ subscriptionCategory: { isActive: boolean } | null }>;
}

/** A warning for the preview to raise; the billing module adds the fingerprint. */
export interface AgeUpWarning {
  memberId: string;
  membershipTypeId: string | null;
  message: string;
  context: Record<string, unknown>;
}

/** What the main loop does with an aged-into-owing member. */
export type PartSeasonCharge = {
  /** The tier the part-season fee is priced at. */
  feeTier: AgeTier | null;
  /** The age-up day, as the charge's decision date. */
  decisionDate: Date;
};

export interface AgeUpPlanner {
  /** The rule the season charge is judged by (see {@link seasonChargeLiabilityRule}). */
  seasonChargeRule: SubscriptionLiabilityRule;
  /**
   * For a member the season-start rule exempts: their part-season charge, when
   * they have aged into owing by the decision date and nothing shares their
   * fee. Null otherwise; a shared fee raises the warning.
   */
  partSeasonCharge(member: AgeUpPlanMember, membershipType: MembershipTypeRef): Promise<PartSeasonCharge | null>;
  /** Every top-up and credit the run raises, after the main loop. */
  planAdjustments<M extends AgeUpPlanMember>(input: {
    members: readonly M[];
    membershipTypeOf: (member: M) => MembershipTypeRef | undefined;
    entries: readonly SubscriptionBillingPlanEntry[];
  }): Promise<SubscriptionBillingAgeUpAdjustment[]>;
}

function memberName(member: Pick<AgeUpPlanMember, "firstName" | "lastName">): string {
  return `${member.firstName} ${member.lastName}`.trim();
}

function describeChange(event: Pick<AgeUpEvent, "fromTier" | "toTier" | "ageUpDate">): string {
  return `age group changed from ${formatAgeTierName(event.fromTier)} to ${formatAgeTierName(event.toTier)} on ${event.ageUpDate}`;
}

export function createAgeUpPlanner(input: {
  db: Db;
  seasonYear: number;
  decisionDate: Date;
  yearEndMonth: number;
  /** The club's billing rule; the planner is idle unless it reads "Age today". */
  rule: SubscriptionLiabilityRule;
  /** A scoped (membership approval) run never settles an age-up. */
  scoped: boolean;
  /** The read-only view while Xero is off resolves no account mapping (#4986). */
  xeroInvoicingOff: boolean;
  ageTierSettings: () => Promise<AgeTierSettingData[]>;
  /** The preview's memoised fee on its decision date. */
  feeFor: (membershipTypeId: string, ageTier: AgeTier | null) => Promise<AnnualFee | null>;
  warn: (warning: AgeUpWarning) => void;
}): AgeUpPlanner {
  const active = input.rule.ageSource === "CURRENT_AGE" && !input.scoped;
  const asOf = calendarDateOfDateOnlyInstant(input.decisionDate);
  // Members the main loop already settled, by a part-season entry or a warning.
  const handled = new Set<string>();

  const eventFor = async (
    member: AgeUpPlanMember,
    subscriptionBehavior: MembershipTypeSubscriptionBehavior,
  ): Promise<AgeUpEvent | null> =>
    resolveAgeUpEvent({
      dateOfBirth: member.dateOfBirth,
      joinedDate: member.joinedDate,
      seasonYear: input.seasonYear,
      asOf,
      rule: input.rule,
      subscriptionBehavior,
      ageTierSettings: await input.ageTierSettings(),
    });

  // A BASED_ON_AGE_TIER type prices by the liability tier; every other policy
  // by the stored tier, so its price does not move with the age-up.
  const feeTierOf = (member: AgeUpPlanMember, type: MembershipTypeRef, tier: AgeTier) =>
    type.subscriptionBehavior === "BASED_ON_AGE_TIER" ? tier : member.ageTier;

  const warnShared = (member: AgeUpPlanMember, type: MembershipTypeRef | null, event: AgeUpEvent, why: string) => {
    handled.add(member.id);
    input.warn({
      memberId: member.id,
      membershipTypeId: type?.id ?? null,
      message: `${memberName(member)}'s ${describeChange(event)}, but ${why}. Settle the age-group change in Xero.`,
      context: {
        memberName: memberName(member),
        ageUpDate: event.ageUpDate,
        fromAgeTier: event.fromTier,
        toAgeTier: event.toTier,
      },
    });
  };

  const feeAtDate = new Map<string, Promise<AnnualFee | null>>();
  const feeOn = (membershipTypeId: string, ageTier: AgeTier | null, on: Date) => {
    const key = `${membershipTypeId}:${ageTier ?? "FLAT"}:${formatDateOnly(on)}`;
    if (!feeAtDate.has(key)) {
      feeAtDate.set(key, getEffectiveMembershipAnnualFee({ membershipTypeId, ageTier }, on, input.db));
    }
    return feeAtDate.get(key)!;
  };

  return {
    seasonChargeRule: seasonChargeLiabilityRule(input.rule),

    async partSeasonCharge(member, membershipType) {
      if (!active || membershipType.subscriptionBehavior === "NOT_REQUIRED") return null;
      const event = await eventFor(member, membershipType.subscriptionBehavior);
      if (!event || event.fromOwes || !event.toOwes) return null;
      const fromFee = await input.feeFor(membershipType.id, feeTierOf(member, membershipType, event.fromTier));
      const feeTier = feeTierOf(member, membershipType, event.toTier);
      const toFee = await input.feeFor(membershipType.id, feeTier);
      // A family fee covers the member on the family's one invoice (the
      // tier-exempt child stays in its coverage, #2148 Q5): never a second.
      if (fromFee?.billingBasis === "PER_FAMILY" || toFee?.billingBasis === "PER_FAMILY") {
        warnShared(member, membershipType, event, "their membership fee is billed to their family on one invoice");
        return null;
      }
      handled.add(member.id);
      return { feeTier, decisionDate: dateOnlyInstantOf(event.ageUpDate) };
    },

    async planAdjustments({ members, membershipTypeOf, entries }) {
      if (!active) return [];
      // A top-up is an invoice line on the subscription income account; with
      // that unmapped the preview already withholds every invoice (and raises
      // the mapping exception), and a credit has no season invoice to settle.
      let mapping: { code: string | null; itemCode: string | null } = { code: null, itemCode: null };
      if (!input.xeroInvoicingOff) {
        const resolved = await getResolvedAccountMapping("subscriptionIncome", input.db);
        if (!resolved.code || !resolved.codeExplicitlyConfigured) return [];
        mapping = resolved;
      }

      const candidates: Array<{ member: AgeUpPlanMember; type: MembershipTypeRef; event: AgeUpEvent }> = [];
      for (const member of members) {
        if (handled.has(member.id)) continue;
        const type = membershipTypeOf(member);
        if (!type || type.subscriptionBehavior === "NOT_REQUIRED") continue;
        const event = await eventFor(member, type.subscriptionBehavior);
        if (!event) continue;
        if (member.seasonalMembershipAssignments[0]?.subscriptionCategory?.isActive) {
          // A category fee is one flat family charge with no age tiers.
          if (event.fromOwes !== event.toOwes) {
            warnShared(member, type, event, "their subscription is a category charge shared with their family");
          }
          continue;
        }
        candidates.push({ member, type, event });
      }
      if (candidates.length === 0) return [];

      const rows = await input.db.memberSubscription.findMany({
        where: { seasonYear: input.seasonYear, memberId: { in: candidates.map((row) => row.member.id) } },
        select: {
          id: true,
          memberId: true,
          chargeCoverage: {
            where: { releasedAt: null },
            take: 1,
            select: {
              charge: {
                select: {
                  billingBasis: true,
                  membershipTypeId: true,
                  membershipAnnualFeeId: true,
                  annualAmountCents: true,
                  decisionDate: true,
                  _count: { select: { coverage: { where: { releasedAt: null } } } },
                },
              },
            },
          },
          ageUpAdjustments: { select: { ageUpDate: true, kind: true, status: true } },
        },
      });
      const rowByMember = new Map(rows.map((row) => [row.memberId, row]));
      const feeIds = rows.flatMap((row) => row.chargeCoverage.map((cover) => cover.charge.membershipAnnualFeeId))
        .filter((id): id is string => Boolean(id));
      const feeTierById = new Map(
        (feeIds.length
          ? await input.db.membershipAnnualFee.findMany({ where: { id: { in: feeIds } }, select: { id: true, ageTier: true } })
          : []
        ).map((fee) => [fee.id, fee.ageTier]),
      );

      const planned: SubscriptionBillingAgeUpAdjustment[] = [];
      for (const { member, type, event } of candidates) {
        const row = rowByMember.get(member.id);
        const seasonCharge = row?.chargeCoverage[0]?.charge ?? null;
        const ageUpDay = dateOnlyInstantOf(event.ageUpDate).getTime();
        const raised = row?.ageUpAdjustments.find((adjustment) => adjustment.ageUpDate.getTime() === ageUpDay);
        if (raised) {
          if (raised.status === "VOIDED") {
            warnShared(member, type, event, "its top-up invoice was voided in Xero, so it is not raised again");
          }
          continue;
        }
        if (!event.fromOwes) {
          // Aged into owing, but the main loop billed no part-season charge:
          // one already covers them, or something else does.
          const partSeasonCovers =
            seasonCharge !== null &&
            compareCalendarDates(calendarDateOfDateOnlyInstant(seasonCharge.decisionDate), event.ageUpDate) === 0;
          if (!partSeasonCovers) {
            warnShared(member, type, event, "their season subscription is already on an invoice this app cannot add to");
          }
          continue;
        }

        // The season charge the difference is measured from: this app's own
        // charge for this member alone, on this type, priced at the from tier.
        const entry = entries.find((candidate) =>
          candidate.billingBasis === "PER_MEMBER" &&
          candidate.membershipTypeId === type.id &&
          candidate.coveredMembers.length === 1 &&
          candidate.coveredMembers[0]?.id === member.id);
        let season: { annualCents: number; pricedOn: Date } | null = null;
        if (seasonCharge) {
          const feeTier = seasonCharge.membershipAnnualFeeId ? feeTierById.get(seasonCharge.membershipAnnualFeeId) : null;
          if (
            seasonCharge.billingBasis !== "PER_MEMBER" ||
            seasonCharge.membershipTypeId !== type.id ||
            seasonCharge._count.coverage !== 1
          ) {
            warnShared(member, type, event, "their season subscription is on a shared or no-invoice charge");
            continue;
          }
          if (feeTier && feeTier !== feeTierOf(member, type, event.fromTier)) {
            warnShared(member, type, event, `their season subscription was priced for the ${formatAgeTierName(feeTier)} age group`);
            continue;
          }
          season = { annualCents: seasonCharge.annualAmountCents, pricedOn: seasonCharge.decisionDate };
        } else if (entry) {
          season = { annualCents: entry.annualAmountCents, pricedOn: input.decisionDate };
        } else {
          warnShared(member, type, event, "their season subscription was not billed by this app");
          continue;
        }

        let toAnnualCents = season.annualCents;
        if (event.toOwes && type.subscriptionBehavior === "BASED_ON_AGE_TIER") {
          // The new tier's fee on the day the season charge was priced, so a
          // fee-schedule change since is not billed as an age-up.
          const toFee = await feeOn(type.id, event.toTier, season.pricedOn);
          if (!toFee || toFee.billingBasis !== "PER_MEMBER") {
            warnShared(member, type, event, toFee
              ? `the ${formatAgeTierName(event.toTier)} fee is not billed per member`
              : `${type.name} has no ${formatAgeTierName(event.toTier)} fee`);
            continue;
          }
          toAnnualCents = toFee.amountCents;
        }
        const part = priceAgeUpEvent(event, input.seasonYear, (tier) =>
          tier === event.fromTier ? season.annualCents : toAnnualCents);
        if (!part) continue;
        const kind = part.signedDifferenceCents > 0 ? "TOP_UP" : "CREDIT";
        planned.push({
          key: `${input.seasonYear}:age-up:${member.id}:${part.ageUpDate}`,
          kind,
          seasonYear: input.seasonYear,
          memberId: member.id,
          memberName: memberName(member),
          ageUpDate: part.ageUpDate,
          fromAgeTier: part.fromTier,
          toAgeTier: part.toTier,
          coveredMonths: part.coveredMonths,
          fromAnnualCents: part.fromAnnualCents,
          toAnnualCents: part.toAnnualCents,
          amountCents: Math.abs(part.signedDifferenceCents),
          description: buildAgeUpLineDescription({
            membershipTypeName: type.name,
            seasonYear: input.seasonYear,
            yearEndMonth: input.yearEndMonth,
            part,
            kind,
          }),
          membershipTypeId: type.id,
          membershipTypeKey: type.key,
          membershipTypeName: type.name,
          recipient: { id: member.id, name: memberName(member), email: member.email },
          xeroAccountCode: kind === "TOP_UP" ? mapping.code : null,
          xeroItemCode: kind === "TOP_UP" ? mapping.itemCode : null,
        });
      }
      // Ordinal: the list feeds the confirmation token (#3252).
      return planned.sort((left, right) => compareOrdinal(left.key, right.key));
    },
  };
}

/**
 * Write the preview's age-up top-ups and credits, inside the billing confirm's
 * season-locked transaction and from its fresh in-transaction preview. Returns
 * the top-up charge ids, which the caller queues as it queues season charges.
 * An adjustment that already exists is left alone and queues nothing.
 */
export async function confirmAgeUpAdjustments(
  tx: Prisma.TransactionClient,
  input: {
    preview: Pick<SubscriptionBillingPreview, "ageUpAdjustments" | "dueDays">;
    source: MembershipSubscriptionChargeSource;
    confirmedByMemberId?: string;
  },
): Promise<string[]> {
  const chargeIds: string[] = [];
  for (const item of input.preview.ageUpAdjustments) {
    const subscription = await tx.memberSubscription.upsert({
      where: { memberId_seasonYear: { memberId: item.memberId, seasonYear: item.seasonYear } },
      update: {},
      create: { memberId: item.memberId, seasonYear: item.seasonYear, status: "NOT_INVOICED" },
      select: { id: true },
    });
    const ageUpDate = parseDateOnly(item.ageUpDate);
    const existing = await tx.memberSubscriptionAgeUpAdjustment.findUnique({
      where: { memberSubscriptionId_ageUpDate: { memberSubscriptionId: subscription.id, ageUpDate } },
      select: { id: true },
    });
    if (existing) continue;
    const adjustment = {
      memberSubscriptionId: subscription.id,
      memberId: item.memberId,
      seasonYear: item.seasonYear,
      ageUpDate,
      kind: item.kind,
      fromAgeTier: item.fromAgeTier,
      toAgeTier: item.toAgeTier,
      coveredMonths: item.coveredMonths,
      fromAnnualCents: item.fromAnnualCents,
      toAnnualCents: item.toAnnualCents,
      amountCents: item.amountCents,
      description: item.description,
    };
    if (item.kind === "CREDIT") {
      const credit = await tx.memberSubscriptionAgeUpAdjustment.create({ data: adjustment, select: { id: true } });
      const key = ageUpCreditIdempotencyKey(credit.id);
      await startXeroSyncOperation({
        direction: "OUTBOUND",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: AGE_UP_ADJUSTMENT_LOCAL_MODEL,
        localId: credit.id,
        queueType: XERO_OUTBOX_AGE_UP_CREDIT_TYPE,
        requestPayload: buildAgeUpCreditPayload(credit.id),
        status: "PENDING",
        idempotencyKey: key,
        correlationKey: key,
        createdByMemberId: input.confirmedByMemberId ?? null,
        store: tx,
      });
      continue;
    }
    if (!item.xeroAccountCode) {
      throw new Error(`Age-up top-up ${item.key} has no resolved Xero account code; the preview should have withheld it.`);
    }
    const idempotencyKey = ageUpTopUpChargeKey(subscription.id, item.ageUpDate);
    const annualDifferenceCents = item.toAnnualCents - item.fromAnnualCents;
    const charge = await tx.membershipSubscriptionCharge.upsert({
      where: { idempotencyKey },
      update: {},
      create: {
        idempotencyKey,
        seasonYear: item.seasonYear,
        source: input.source,
        status: "QUEUED",
        membershipTypeId: item.membershipTypeId,
        membershipTypeKey: item.membershipTypeKey,
        membershipTypeName: item.membershipTypeName,
        billingBasis: "PER_MEMBER",
        prorationRule: "REMAINING_MONTHS_INCLUSIVE",
        annualAmountCents: annualDifferenceCents,
        chargedAmountCents: item.amountCents,
        coveredMonths: item.coveredMonths,
        decisionDate: ageUpDate,
        coverageStart: dateOnlyInstantOf(startOfCalendarMonth(requireCalendarDate(item.ageUpDate))),
        coverageEnd: getSeasonEndDate(item.seasonYear),
        recipientMemberId: item.recipient.id,
        recipientName: item.recipient.name,
        recipientEmail: item.recipient.email,
        dueDays: input.preview.dueDays,
        xeroAccountCode: item.xeroAccountCode,
        xeroItemCode: item.xeroItemCode,
        invoiceReference: `MEMSUB-${idempotencyKey.slice(0, 24)}`,
        confirmedByMemberId: input.confirmedByMemberId,
        confirmedAt: new Date(),
        // One line, no coverage: the member's season row is covered by their
        // season charge, and this charge only adds the difference.
        components: {
          create: [{
            label: "Age group change",
            description: item.description,
            annualAmountCents: annualDifferenceCents,
            chargedAmountCents: item.amountCents,
            prorated: true,
            xeroAccountCode: item.xeroAccountCode,
            xeroItemCode: item.xeroItemCode,
            sortOrder: 0,
          }],
        },
      },
      select: { id: true },
    });
    await tx.memberSubscriptionAgeUpAdjustment.create({ data: { ...adjustment, chargeId: charge.id } });
    const correlationKey = buildXeroIdempotencyKey("membership-charge", charge.id, "invoice-and-email", "v1");
    await startXeroSyncOperation({
      ...subscriptionInvoiceOutboxRow(charge.id),
      status: "PENDING",
      idempotencyKey: correlationKey,
      correlationKey,
      createdByMemberId: input.confirmedByMemberId ?? null,
      store: tx,
    });
    chargeIds.push(charge.id);
  }
  return chargeIds;
}
