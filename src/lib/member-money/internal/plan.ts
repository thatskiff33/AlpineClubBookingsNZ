import type {
  MemberMoneyAccount,
  MemberMoneyDebtorKind,
  MemberMoneyEventKind,
  MemberMoneyObligationKind,
  MemberMoneyOrigin,
  MemberMoneySide,
  MemberMoneySourceKind,
} from "@prisma/client";
import type { ClubTaxTreatment } from "../../club-tax-settings";
import { isCalendarDate, type CalendarDate, type Instant } from "../../club-time";
import { stableDigest, stableStringify } from "../../stable-digest";
import { memberMoneyEventKeys } from "./keys";
import { MAX_MEMBER_MONEY_CENTS, splitTaxInclusiveGross, type MemberMoneyTaxSplit } from "./tax";

/**
 * A posting plan, and the pure builder that turns it into one complete batch
 * (#4626, Ledger M3a). Every refusal here happens before the store writes a row:
 * an ill-shaped or unbalanced plan never reaches the database. The database's
 * own deferred checks (`member_money_batch_errors`, `INV-MONEY-041`) still hold
 * whatever this builder misses.
 */

/** JSON a leg or obligation keeps as frozen descriptive evidence. */
export type MemberMoneyJson = string | number | boolean | null | MemberMoneyJson[] | { [key: string]: MemberMoneyJson };
export type MemberMoneyEvidence = { [key: string]: MemberMoneyJson };

/** A member or an organisation, never both, as a booking's owner is. */
export type MemberMoneyDebtor =
  | { kind: "MEMBER"; memberId: string }
  | { kind: "ORGANISATION"; organisationId: string };

/** A source fact. A `BOOKING_LEDGER` source's id is the `BookingLedgerLine` id it bridges. */
export interface MemberMoneySource {
  kind: MemberMoneySourceKind;
  id: string;
  version: string;
}

/**
 * Everything a batch needs that is resolved BEFORE the business transaction
 * (`INV-LOCK-004`): the club civil date from the club-time kernel, the club
 * currency, the policy and coding versions, and the tax treatment in force on
 * that date. The command never computes any of these itself.
 */
export interface MemberMoneyPostingContext {
  effectiveAt: Instant;
  effectiveDate: CalendarDate;
  currency: string;
  policyVersion: string;
  codingVersion: string;
  tax: ClubTaxTreatment;
}

/** The revenue accounts the database's tax tie reads (`member_money_batch_errors`). */
export const TAXED_REVENUE_ACCOUNTS = [
  "BOOKING_REVENUE",
  "SUBSCRIPTION_REVENUE",
  "JOINING_FEE_REVENUE",
  "FEE_REVENUE",
] as const satisfies readonly MemberMoneyAccount[];
export type TaxedRevenueAccount = (typeof TAXED_REVENUE_ACCOUNTS)[number];

interface LegDimensions {
  side: MemberMoneySide;
  /** Defaults to the event's own source. */
  source?: MemberMoneySource;
  debtor?: MemberMoneyDebtor;
  /** An obligation this plan creates, or one an earlier batch posted. */
  obligationKey?: string;
  booking?: { bookingId: string; lodgeId: string };
  creditLotId?: string;
  /** The legacy component key a leg posts, so a later ADJUSTMENT can name it. */
  chargeIdentity?: string;
  refundIdentity?: string;
  evidence: MemberMoneyEvidence;
}

/** A leg of a fixed amount. Revenue and GST legs are not written this way: tax is split only by the builder. */
export interface MemberMoneyAmountLeg extends LegDimensions {
  type: "amount";
  account: Exclude<MemberMoneyAccount, TaxedRevenueAccount | "GST_PAYABLE">;
  amountCents: number;
}

/**
 * A revenue component at its GST-inclusive gross. The builder splits it under the
 * context's treatment into a net revenue leg and a GST leg on the same side, or
 * repeats a `frozenTax` split an earlier posting recorded (design section 4: a
 * correction uses the original cents, not today's rate).
 */
export interface MemberMoneyRevenueLeg extends LegDimensions {
  type: "revenue";
  account: TaxedRevenueAccount;
  grossCents: number;
  frozenTax?: MemberMoneyTaxSplit | "untaxed";
}

export type MemberMoneyLegPlan = MemberMoneyAmountLeg | MemberMoneyRevenueLeg;

export interface MemberMoneyObligationPlan {
  key: string;
  kind: MemberMoneyObligationKind;
  debtor: MemberMoneyDebtor;
  faceCents: number;
  evidence: MemberMoneyEvidence;
}

interface PlanCommon {
  eventKey: string;
  origin: MemberMoneyOrigin;
  /** The event's own source; the batch always links it. */
  source: MemberMoneySource;
  /** Further sources the batch links, such as the legacy lines a charge bridges. */
  additionalSources?: readonly MemberMoneySource[];
  reason: string;
  actorMemberId?: string | null;
}

/**
 * CHARGE and ADJUSTMENT carry legs; ZERO records an explicit zero-money event.
 * A partial correction is an ADJUSTMENT with mirrored legs naming each component
 * by `chargeIdentity`: the database allows a REVERSAL only as an exact copy of a
 * whole batch, which `reverseMemberMoneyJournal` posts.
 */
export type MemberMoneyPlan =
  | (PlanCommon & {
      kind: "CHARGE" | "ADJUSTMENT";
      obligations?: readonly MemberMoneyObligationPlan[];
      legs: readonly MemberMoneyLegPlan[];
    })
  | (PlanCommon & { kind: "ZERO" });

export interface MemberMoneyReversalPlan {
  reversesJournalId: string;
  /** Defaults to `memberMoneyEventKeys.reversal(reversesJournalId)`. */
  eventKey?: string;
  origin: MemberMoneyOrigin;
  source: MemberMoneySource;
  reason: string;
  actorMemberId?: string | null;
}

/** A plan refused before any write, with every problem found. */
export class MemberMoneyPlanError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`member-money plan refused: ${problems.join("; ")}`);
    this.name = "MemberMoneyPlanError";
  }
}

export interface BuiltSource {
  kind: MemberMoneySourceKind;
  id: string;
  version: string;
  bookingLedgerLineId: string | null;
}

export interface BuiltObligation {
  key: string;
  kind: MemberMoneyObligationKind;
  debtorKind: MemberMoneyDebtorKind;
  memberId: string | null;
  organisationId: string | null;
  faceCents: number;
  evidence: MemberMoneyJson;
}

export interface BuiltLine {
  /** Index into `BuiltBatch.sources`. */
  source: number;
  account: MemberMoneyAccount;
  side: MemberMoneySide;
  amountCents: number;
  debtorKind: MemberMoneyDebtorKind | null;
  memberId: string | null;
  organisationId: string | null;
  obligationKey: string | null;
  bookingId: string | null;
  lodgeId: string | null;
  creditLotId: string | null;
  chargeIdentity: string | null;
  refundIdentity: string | null;
  originalLineId: string | null;
  grossCents: number | null;
  netCents: number | null;
  taxCents: number | null;
  taxCode: string | null;
  evidence: MemberMoneyJson;
}

/** One complete batch, ids still unassigned. */
export interface BuiltBatch {
  event: {
    eventKey: string;
    kind: MemberMoneyEventKind;
    origin: MemberMoneyOrigin;
    sourceKind: MemberMoneySourceKind;
    sourceIdentity: string;
    sourceVersion: string;
    payloadHash: string;
    actorMemberId: string | null;
    reason: string;
    effectiveAt: Instant;
    effectiveDate: CalendarDate;
  };
  journal: {
    currency: string;
    policyVersion: string;
    codingVersion: string;
    reversesJournalId: string | null;
  };
  sources: BuiltSource[];
  obligations: BuiltObligation[];
  lines: BuiltLine[];
}

const blank = (value: unknown): boolean => typeof value !== "string" || value.trim().length === 0;
const cents = (value: number): boolean => Number.isSafeInteger(value) && value > 0 && value <= MAX_MEMBER_MONEY_CENTS;
const sourceKey = (source: MemberMoneySource): string => `${source.kind}\u0000${source.id}\u0000${source.version}`;

function debtorColumns(debtor: MemberMoneyDebtor | undefined) {
  if (!debtor) return { debtorKind: null, memberId: null, organisationId: null };
  return debtor.kind === "MEMBER"
    ? { debtorKind: "MEMBER" as const, memberId: debtor.memberId, organisationId: null }
    : { debtorKind: "ORGANISATION" as const, memberId: null, organisationId: debtor.organisationId };
}

function checkContext(context: Pick<MemberMoneyPostingContext, "effectiveAt" | "effectiveDate">, problems: string[]) {
  if (!(context.effectiveAt instanceof Date) || Number.isNaN(context.effectiveAt.getTime())) {
    problems.push("effectiveAt is not a valid instant");
  }
  if (!isCalendarDate(context.effectiveDate)) problems.push("effectiveDate is not a club calendar date");
}

function checkCommon(plan: Pick<PlanCommon, "eventKey" | "reason" | "source">, problems: string[]) {
  if (blank(plan.eventKey)) problems.push("eventKey is blank");
  if (blank(plan.reason)) problems.push("reason is blank");
  if (blank(plan.source.id) || blank(plan.source.version)) problems.push("the event source needs an id and a version");
}

/**
 * The canonical payload a replay must match: everything the batch says, with
 * none of the ids the store assigns. Sources, obligations and lines are sorted
 * so a planner that walks the same facts in another order replays, not conflicts.
 */
function payloadHashOf(batch: Omit<BuiltBatch, "event"> & { event: Omit<BuiltBatch["event"], "payloadHash"> }): string {
  const sorted = <T>(rows: readonly T[]) => [...rows].map(stableStringify).sort();
  return stableDigest({
    event: { ...batch.event, effectiveAt: batch.event.effectiveAt.toISOString() },
    journal: batch.journal,
    sources: sorted(batch.sources),
    obligations: sorted(batch.obligations),
    lines: sorted(batch.lines.map(({ source, ...line }) => ({ ...line, source: batch.sources[source] }))),
  });
}

function seal(batch: Omit<BuiltBatch, "event"> & { event: Omit<BuiltBatch["event"], "payloadHash"> }): BuiltBatch {
  return { ...batch, event: { ...batch.event, payloadHash: payloadHashOf(batch) } };
}

/** Build a CHARGE, ADJUSTMENT or ZERO batch, refusing any ill-shaped or unbalanced plan. */
export function buildMemberMoneyBatch(context: MemberMoneyPostingContext, plan: MemberMoneyPlan): BuiltBatch {
  const problems: string[] = [];
  checkContext(context, problems);
  checkCommon(plan, problems);
  if (!/^[A-Z]{3}$/.test(context.currency)) problems.push("currency is not an ISO 4217 code");
  if (blank(context.policyVersion) || blank(context.codingVersion)) problems.push("policy and coding versions are required");

  const sources: BuiltSource[] = [];
  const sourceIndex = new Map<string, number>();
  const link = (source: MemberMoneySource): number => {
    const key = sourceKey(source);
    let index = sourceIndex.get(key);
    if (index === undefined) {
      if (blank(source.id) || blank(source.version)) problems.push(`source ${source.kind} needs an id and a version`);
      index = sources.push({
        kind: source.kind, id: source.id, version: source.version,
        bookingLedgerLineId: source.kind === "BOOKING_LEDGER" ? source.id : null,
      }) - 1;
      sourceIndex.set(key, index);
    }
    return index;
  };
  link(plan.source);
  for (const source of plan.additionalSources ?? []) link(source);

  const obligations: BuiltObligation[] = [];
  const lines: BuiltLine[] = [];
  if (plan.kind !== "ZERO") {
    const planned = new Map<string, MemberMoneyObligationPlan>();
    for (const obligation of plan.obligations ?? []) {
      if (blank(obligation.key)) problems.push("an obligation key is blank");
      else if (planned.has(obligation.key)) problems.push(`obligation ${obligation.key} is planned twice`);
      planned.set(obligation.key, obligation);
      if (!cents(obligation.faceCents)) problems.push(`obligation ${obligation.key} needs positive integer face cents`);
      const debtor = debtorColumns(obligation.debtor);
      if (blank(debtor.memberId ?? debtor.organisationId)) problems.push(`obligation ${obligation.key} needs a debtor id`);
      obligations.push({
        key: obligation.key, kind: obligation.kind, debtorKind: obligation.debtor.kind,
        memberId: debtor.memberId, organisationId: debtor.organisationId,
        faceCents: obligation.faceCents, evidence: obligation.evidence,
      });
    }

    plan.legs.forEach((leg, index) => {
      const label = `leg ${index} (${leg.account})`;
      const debtor = debtorColumns(leg.debtor);
      if (leg.debtor && blank(debtor.memberId ?? debtor.organisationId)) problems.push(`${label} names a blank debtor id`);
      if (["MEMBER_RECEIVABLE", "MEMBER_CREDIT", "REFUND_PAYABLE"].includes(leg.account) && !leg.debtor) {
        problems.push(`${label} needs a debtor`);
      }
      if (leg.account === "MEMBER_CREDIT" && (blank(leg.creditLotId) || leg.debtor?.kind !== "MEMBER")) {
        problems.push(`${label} needs a credit lot and a member debtor`);
      }
      if (leg.account === "REFUND_PAYABLE" && !leg.obligationKey) problems.push(`${label} needs an obligation`);
      if (leg.booking && (blank(leg.booking.bookingId) || blank(leg.booking.lodgeId))) {
        problems.push(`${label} names a booking without its lodge`);
      }
      const obligation = leg.obligationKey ? planned.get(leg.obligationKey) : undefined;
      if (obligation && stableStringify(obligation.debtor) !== stableStringify(leg.debtor ?? null)) {
        problems.push(`${label} names a debtor other than obligation ${leg.obligationKey}'s`);
      }
      const shared = {
        source: link(leg.source ?? plan.source),
        side: leg.side,
        ...debtor,
        obligationKey: leg.obligationKey ?? null,
        bookingId: leg.booking?.bookingId ?? null,
        lodgeId: leg.booking?.lodgeId ?? null,
        creditLotId: leg.creditLotId ?? null,
        chargeIdentity: leg.chargeIdentity ?? null,
        refundIdentity: leg.refundIdentity ?? null,
        originalLineId: null,
        evidence: leg.evidence,
      };

      if (leg.type === "amount") {
        const account: string = leg.account;
        if ((TAXED_REVENUE_ACCOUNTS as readonly string[]).includes(account) || account === "GST_PAYABLE") {
          problems.push(`${label} must be a revenue leg: only the builder splits tax`);
        }
        if (!cents(leg.amountCents)) problems.push(`${label} needs positive integer cents`);
        lines.push({ ...shared, account: leg.account, amountCents: leg.amountCents,
          grossCents: null, netCents: null, taxCents: null, taxCode: null });
        return;
      }

      if (!(TAXED_REVENUE_ACCOUNTS as readonly string[]).includes(leg.account)) {
        problems.push(`${label} is not a revenue account`);
      }
      if (!cents(leg.grossCents)) {
        problems.push(`${label} needs positive integer gross cents`);
        return;
      }
      let split: MemberMoneyTaxSplit | null;
      if (leg.frozenTax === "untaxed") split = null;
      else if (leg.frozenTax) {
        split = leg.frozenTax;
        const { grossCents, netCents, taxCents } = split;
        if (![grossCents, netCents, taxCents].every((value) => Number.isSafeInteger(value) && value >= 0)
          || grossCents !== netCents + taxCents || grossCents !== leg.grossCents || blank(split.taxCode)) {
          problems.push(`${label} carries a frozen tax split that is not integer gross = net + tax at its gross`);
          return;
        }
      } else split = splitTaxInclusiveGross(leg.grossCents, context.tax);

      if (!split) {
        lines.push({ ...shared, account: leg.account, amountCents: leg.grossCents,
          grossCents: null, netCents: null, taxCents: null, taxCode: null });
        return;
      }
      if (split.netCents <= 0) {
        problems.push(`${label} leaves no net revenue after tax`);
        return;
      }
      lines.push({ ...shared, account: leg.account, amountCents: split.netCents,
        grossCents: split.grossCents, netCents: split.netCents, taxCents: split.taxCents, taxCode: split.taxCode });
      if (split.taxCents > 0) {
        lines.push({ ...shared, account: "GST_PAYABLE", amountCents: split.taxCents, debtorKind: null, memberId: null,
          organisationId: null, obligationKey: null, creditLotId: null,
          grossCents: null, netCents: null, taxCents: null, taxCode: null });
      }
    });

    if (lines.length < 2) problems.push(`a ${plan.kind} batch needs at least two legs`);
    const net = lines.reduce((sum, line) => sum + (line.side === "DEBIT" ? line.amountCents : -line.amountCents), 0);
    if (net !== 0) problems.push(`debits minus credits is ${net} cents, not 0`);
    sources.forEach((source, index) => {
      if (source.kind === "BOOKING_LEDGER" && lines.length > 0 && !lines.some((line) => line.source === index)) {
        problems.push(`legacy line ${source.id} is linked but no leg posts it`);
      }
    });
  }

  if (problems.length > 0) throw new MemberMoneyPlanError(problems);
  return seal({
    event: {
      eventKey: plan.eventKey, kind: plan.kind, origin: plan.origin,
      sourceKind: plan.source.kind, sourceIdentity: plan.source.id, sourceVersion: plan.source.version,
      actorMemberId: plan.actorMemberId ?? null, reason: plan.reason,
      effectiveAt: context.effectiveAt, effectiveDate: context.effectiveDate,
    },
    journal: {
      currency: context.currency, policyVersion: context.policyVersion, codingVersion: context.codingVersion,
      reversesJournalId: null,
    },
    sources,
    obligations,
    lines,
  });
}

/** A posted journal as the reversal builder needs it: its header and every leg, verbatim. */
export interface MemberMoneyJournalToReverse {
  id: string;
  currency: string;
  policyVersion: string;
  codingVersion: string;
  lines: ReadonlyArray<Omit<BuiltLine, "source" | "originalLineId"> & { id: string }>;
}

/**
 * The exact whole-batch REVERSAL the database accepts: every original leg copied
 * with its side swapped and `originalLineId` naming it, under the original's
 * currency, policy and coding versions. All legs link the reversal's own source.
 */
export function buildMemberMoneyReversal(
  context: Pick<MemberMoneyPostingContext, "effectiveAt" | "effectiveDate">,
  plan: MemberMoneyReversalPlan,
  original: MemberMoneyJournalToReverse,
): BuiltBatch {
  const problems: string[] = [];
  const eventKey = plan.eventKey ?? memberMoneyEventKeys.reversal(plan.reversesJournalId);
  checkContext(context, problems);
  checkCommon({ ...plan, eventKey }, problems);
  if (original.id !== plan.reversesJournalId) problems.push("the journal read is not the one the plan reverses");
  if (problems.length > 0) throw new MemberMoneyPlanError(problems);
  return seal({
    event: {
      eventKey, kind: "REVERSAL", origin: plan.origin,
      sourceKind: plan.source.kind, sourceIdentity: plan.source.id, sourceVersion: plan.source.version,
      actorMemberId: plan.actorMemberId ?? null, reason: plan.reason,
      effectiveAt: context.effectiveAt, effectiveDate: context.effectiveDate,
    },
    journal: {
      currency: original.currency, policyVersion: original.policyVersion, codingVersion: original.codingVersion,
      reversesJournalId: original.id,
    },
    sources: [{
      kind: plan.source.kind, id: plan.source.id, version: plan.source.version,
      bookingLedgerLineId: plan.source.kind === "BOOKING_LEDGER" ? plan.source.id : null,
    }],
    obligations: [],
    lines: original.lines.map(({ id, ...line }) => ({
      ...line, source: 0, side: line.side === "DEBIT" ? "CREDIT" : "DEBIT", originalLineId: id,
    })),
  });
}
