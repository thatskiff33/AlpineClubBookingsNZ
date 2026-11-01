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
import { MAX_INTEGER_CENTS } from "../../money-input";
import { stableDigest, stableStringify } from "../../stable-digest";
import { formatCentsPlain } from "../../utils";
import { DEBTOR_ACCOUNTS, MEMBER_MONEY_ACCOUNTS, TAXED_REVENUE_ACCOUNTS, type TaxedRevenueAccount } from "./accounts";
import { memberMoneyEventKeys, type MemberMoneyEventKey } from "./keys";
import { splitTaxInclusiveGross, type MemberMoneyTaxSplit } from "./tax";

/**
 * A posting plan, and the pure builder that turns it into a draft batch
 * (#4626, Ledger M3a). Every refusal here happens before the store reads or
 * writes a row: an ill-shaped or unbalanced plan never reaches the database.
 * A correction's tax split comes from what was posted, so the store completes
 * those legs (`completeMemberMoneyBatch`) after one read. The database's own
 * deferred checks (`member_money_batch_errors`, `INV-MONEY-041`) still hold
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
 * The tax treatment in force on the context's date, or the fact that the club's
 * setting starts later. Only a revenue leg that needs a fresh split refuses an
 * unavailable treatment; every other posting goes ahead (D3).
 */
export type MemberMoneyTaxContext =
  | { status: "known"; treatment: ClubTaxTreatment }
  | { status: "unavailable"; effectiveFrom: CalendarDate };

declare const postingContextBrand: unique symbol;

/**
 * Everything a batch needs that is resolved BEFORE the business transaction
 * (`INV-LOCK-004`). Only `resolveMemberMoneyPostingContext` makes one: the club
 * civil date from the club-time kernel, the currency through the rule card
 * charges use, the policy and coding versions, and the tax treatment.
 *
 * `effectiveAt` is the source fact's own stable instant (the booking's
 * confirmation, the modification's creation), never the processing clock: it is
 * part of the payload hash, so a retry that read the clock again would conflict.
 */
export interface MemberMoneyPostingContext {
  readonly [postingContextBrand]: true;
  readonly effectiveAt: Instant;
  readonly effectiveDate: CalendarDate;
  readonly currency: string;
  readonly policyVersion: string;
  readonly codingVersion: string;
  readonly tax: MemberMoneyTaxContext;
}

interface LegDimensions {
  side: MemberMoneySide;
  /** Defaults to the event's own source. */
  source?: MemberMoneySource;
  debtor?: MemberMoneyDebtor;
  /** An obligation this plan creates, or one an earlier batch posted. */
  obligationKey?: string;
  booking?: { bookingId: string; lodgeId: string };
  creditLotId?: string;
  /** The legacy component key a leg posts, so a later correction can name it. */
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
 * A revenue component at its GST-inclusive gross.
 *
 * On revenue's normal side (CREDIT) it is a fresh charge: the builder splits it
 * under the context's treatment into net revenue and a GST leg on the same side,
 * or repeats a `frozenTax` split (a back-post of a historical charge).
 *
 * On the other side (DEBIT) it is a CORRECTION of a posted component, named by
 * `chargeIdentity`, and repeats that component's posted split exactly, never
 * today's rate (design section 4). A correction takes the WHOLE live component:
 * its gross must equal what the component's posted legs still carry. A partial
 * reduction is the whole component corrected plus a fresh charge for what
 * remains, so no part of a split is ever apportioned. `frozenTax`, if given,
 * must equal the posted split.
 */
export interface MemberMoneyRevenueLeg extends LegDimensions {
  type: "revenue";
  account: TaxedRevenueAccount;
  grossCents: number;
  frozenTax?: MemberMoneyTaxSplit | "untaxed";
}

export type MemberMoneyLegPlan = MemberMoneyAmountLeg | MemberMoneyRevenueLeg;

/** An obligation's face is the signed sum of the receivable (CHARGE) or refund-payable (REFUND) legs naming it here. */
export interface MemberMoneyObligationPlan {
  key: string;
  kind: MemberMoneyObligationKind;
  debtor: MemberMoneyDebtor;
  faceCents: number;
  evidence: MemberMoneyEvidence;
}

interface PlanCommon {
  eventKey: MemberMoneyEventKey;
  origin: MemberMoneyOrigin;
  /** The event's own source; the batch always links it. */
  source: MemberMoneySource;
  /** Further sources the batch links, such as the legacy lines a charge bridges. */
  additionalSources?: readonly MemberMoneySource[];
  /** Provenance, not economics: neither this nor the actor is part of the payload hash. */
  reason: string;
  actorMemberId?: string | null;
}

/**
 * CHARGE and ADJUSTMENT carry legs; ZERO records an explicit zero-money event.
 * The database allows a REVERSAL only as an exact copy of a whole batch, which
 * `reverseMemberMoneyJournal` posts; a correction of some components is an
 * ADJUSTMENT whose revenue legs name them.
 */
export type MemberMoneyPlan =
  | (PlanCommon & {
      kind: "CHARGE" | "ADJUSTMENT";
      obligations?: readonly MemberMoneyObligationPlan[];
      legs: readonly MemberMoneyLegPlan[];
    })
  | (PlanCommon & { kind: "ZERO" });

/** Its event key is always `memberMoneyEventKeys.reversal(reversesJournalId)`. */
export interface MemberMoneyReversalPlan {
  reversesJournalId: string;
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

/** A correction of a posted revenue component, completed by the store from that component's posted legs. */
export interface BuiltCorrection {
  shared: Omit<BuiltLine, "account" | "amountCents" | "grossCents" | "netCents" | "taxCents" | "taxCode">;
  account: TaxedRevenueAccount;
  chargeIdentity: string;
  grossCents: number;
  frozenTax: MemberMoneyTaxSplit | "untaxed" | null;
}

/** One batch, ids still unassigned. Its payload hash covers corrections as planned, before completion. */
export interface BuiltBatch {
  event: {
    eventKey: MemberMoneyEventKey;
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
  corrections: BuiltCorrection[];
}

const blank = (value: unknown): boolean => typeof value !== "string" || value.trim().length === 0;
const cents = (value: number): boolean => Number.isSafeInteger(value) && value > 0 && value <= MAX_INTEGER_CENTS;
const sourceKey = (source: MemberMoneySource): string => `${source.kind}\u0000${source.id}\u0000${source.version}`;
const isTaxedRevenue = (account: string): account is TaxedRevenueAccount =>
  (TAXED_REVENUE_ACCOUNTS as readonly string[]).includes(account);
const untaxed = { grossCents: null, netCents: null, taxCents: null, taxCode: null } as const;

function debtorColumns(debtor: MemberMoneyDebtor | undefined) {
  if (!debtor) return { debtorKind: null, memberId: null, organisationId: null };
  return debtor.kind === "MEMBER"
    ? { debtorKind: "MEMBER" as const, memberId: debtor.memberId, organisationId: null }
    : { debtorKind: "ORGANISATION" as const, memberId: null, organisationId: debtor.organisationId };
}

function checkContext(context: MemberMoneyPostingContext, problems: string[]) {
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

/** A frozen split is integer gross = net + tax with positive net and a code. */
function frozenSplitProblem(split: MemberMoneyTaxSplit, grossCents: number): boolean {
  const { netCents, taxCents } = split;
  return ![split.grossCents, netCents, taxCents].every((value) => Number.isSafeInteger(value) && value >= 0)
    || split.grossCents !== netCents + taxCents || split.grossCents !== grossCents || netCents <= 0 || blank(split.taxCode);
}

/** The revenue leg, and its GST leg on the same side when there is tax. */
function revenueLines(
  shared: BuiltCorrection["shared"],
  account: TaxedRevenueAccount,
  grossCents: number,
  split: MemberMoneyTaxSplit | null,
): BuiltLine[] {
  if (!split) return [{ ...shared, account, amountCents: grossCents, ...untaxed }];
  const revenue: BuiltLine = { ...shared, account, amountCents: split.netCents,
    grossCents: split.grossCents, netCents: split.netCents, taxCents: split.taxCents, taxCode: split.taxCode };
  if (split.taxCents === 0) return [revenue];
  return [revenue, { ...shared, account: "GST_PAYABLE", amountCents: split.taxCents, debtorKind: null, memberId: null,
    organisationId: null, obligationKey: null, creditLotId: null, ...untaxed }];
}

/**
 * The canonical payload a replay must match: the batch's economics, with none
 * of the ids the store assigns, and without the reason and actor, which are
 * provenance. Sources, obligations, legs and corrections are sorted so a planner
 * that walks the same facts in another order replays, not conflicts.
 */
function payloadHashOf(batch: Omit<BuiltBatch, "event"> & { event: Omit<BuiltBatch["event"], "payloadHash"> }): string {
  const sorted = <T>(rows: readonly T[]) => [...rows].map(stableStringify).sort();
  const event = batch.event;
  return stableDigest({
    event: {
      eventKey: event.eventKey, kind: event.kind, origin: event.origin,
      sourceKind: event.sourceKind, sourceIdentity: event.sourceIdentity, sourceVersion: event.sourceVersion,
      effectiveAt: event.effectiveAt.toISOString(), effectiveDate: event.effectiveDate,
    },
    journal: batch.journal,
    sources: sorted(batch.sources),
    obligations: sorted(batch.obligations),
    lines: sorted(batch.lines.map(({ source, ...line }) => ({ ...line, source: batch.sources[source] }))),
    corrections: sorted(batch.corrections.map(({ shared: { source, ...shared }, ...correction }) =>
      ({ ...correction, shared: { ...shared, source: batch.sources[source] } }))),
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
  const corrections: BuiltCorrection[] = [];
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
      if ((DEBTOR_ACCOUNTS as readonly string[]).includes(leg.account) && !leg.debtor) problems.push(`${label} needs a debtor`);
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
      const shared: BuiltCorrection["shared"] = {
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
        if (isTaxedRevenue(leg.account) || (leg.account as string) === "GST_PAYABLE") {
          problems.push(`${label} must be a revenue leg: only the builder splits tax`);
        }
        if (!cents(leg.amountCents)) problems.push(`${label} needs positive integer cents`);
        lines.push({ ...shared, account: leg.account, amountCents: leg.amountCents, ...untaxed });
        return;
      }

      if (!isTaxedRevenue(leg.account)) {
        problems.push(`${label} is not a revenue account`);
        return;
      }
      if (!cents(leg.grossCents)) {
        problems.push(`${label} needs positive integer gross cents`);
        return;
      }
      if (leg.frozenTax && leg.frozenTax !== "untaxed" && frozenSplitProblem(leg.frozenTax, leg.grossCents)) {
        problems.push(`${label} carries a frozen tax split that is not integer gross = net + tax, with net, at its gross`);
        return;
      }

      if (leg.side !== MEMBER_MONEY_ACCOUNTS[leg.account].normalSide) {
        if (blank(leg.chargeIdentity)) {
          problems.push(`${label} corrects revenue, so it must name the posted component by chargeIdentity`);
          return;
        }
        if (corrections.some((c) => c.account === leg.account && c.chargeIdentity === leg.chargeIdentity)) {
          problems.push(`${label} corrects component ${leg.chargeIdentity} twice`);
        }
        corrections.push({ shared, account: leg.account, chargeIdentity: leg.chargeIdentity!, grossCents: leg.grossCents,
          frozenTax: leg.frozenTax ?? null });
        return;
      }

      let split: MemberMoneyTaxSplit | null;
      if (leg.frozenTax === "untaxed") split = null;
      else if (leg.frozenTax) split = leg.frozenTax;
      else if (context.tax.status === "unavailable") {
        problems.push(`${label} needs a fresh tax split, but the club's tax setting starts on ${context.tax.effectiveFrom}`);
        return;
      } else split = splitTaxInclusiveGross(leg.grossCents, context.tax.treatment);
      if (split && split.netCents <= 0) {
        problems.push(`${label} leaves no net revenue after tax`);
        return;
      }
      lines.push(...revenueLines(shared, leg.account, leg.grossCents, split));
    });

    // A correction's revenue and GST legs together carry its gross on its side.
    const signed = (side: MemberMoneySide, amount: number) => (side === "DEBIT" ? amount : -amount);
    const net = lines.reduce((sum, line) => sum + signed(line.side, line.amountCents), 0)
      + corrections.reduce((sum, correction) => sum + signed(correction.shared.side, correction.grossCents), 0);
    if (lines.length + corrections.length < 2) problems.push(`a ${plan.kind} batch needs at least two legs`);
    if (net !== 0) problems.push(`debits and credits do not balance: debits less credits is ${formatCentsPlain(net)}`);
    for (const obligation of obligations) {
      const account = obligation.kind === "CHARGE" ? "MEMBER_RECEIVABLE" : "REFUND_PAYABLE";
      const increases: MemberMoneySide = obligation.kind === "CHARGE" ? "DEBIT" : "CREDIT";
      const face = lines
        .filter((line) => line.obligationKey === obligation.key && line.account === account)
        .reduce((sum, line) => sum + (line.side === increases ? line.amountCents : -line.amountCents), 0);
      if (face !== obligation.faceCents) {
        problems.push(`obligation ${obligation.key}'s face is not the ${account} its legs post here (${formatCentsPlain(face)})`);
      }
    }
    sources.forEach((source, index) => {
      const posted = lines.some((line) => line.source === index) || corrections.some((c) => c.shared.source === index);
      if (source.kind === "BOOKING_LEDGER" && !posted) problems.push(`legacy line ${source.id} is linked but no leg posts it`);
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
    corrections,
  });
}

/** A posted revenue leg, as a correction reads the component it names. */
export interface PostedRevenueLeg {
  account: MemberMoneyAccount;
  chargeIdentity: string | null;
  side: MemberMoneySide;
  amountCents: number;
  grossCents: number | null;
  netCents: number | null;
  taxCents: number | null;
  taxCode: string | null;
}

/**
 * The live split of each corrected component: the signed sum of every posted
 * leg of that account and charge identity (credits add, debits take away, so an
 * earlier correction or reversal is already netted). A component posted under
 * more than one tax code has no single split to repeat and is refused.
 */
type LiveSplit = { split: MemberMoneyTaxSplit | null } | { problem: string };

function liveSplit(correction: BuiltCorrection, posted: readonly PostedRevenueLeg[]): LiveSplit {
  const legs = posted.filter((leg) => leg.account === correction.account && leg.chargeIdentity === correction.chargeIdentity);
  if (legs.length === 0) return { problem: `component ${correction.chargeIdentity} has no posted ${correction.account} leg` };
  const codes = new Set(legs.map((leg) => leg.taxCode));
  if (codes.size > 1) return { problem: `component ${correction.chargeIdentity} was posted under more than one tax treatment` };
  let gross = 0, net = 0, tax = 0;
  for (const leg of legs) {
    const sign = leg.side === "CREDIT" ? 1 : -1;
    gross += sign * (leg.grossCents ?? leg.amountCents);
    net += sign * (leg.netCents ?? leg.amountCents);
    tax += sign * (leg.taxCents ?? 0);
  }
  if (gross !== correction.grossCents) {
    return { problem: `a correction takes a whole component: ${correction.chargeIdentity} still carries `
      + `${formatCentsPlain(gross)}, not ${formatCentsPlain(correction.grossCents)}` };
  }
  const [code] = codes;
  if (code === null || code === undefined) return { split: null };
  if (net <= 0) return { problem: `component ${correction.chargeIdentity} has no net revenue left to correct` };
  return { split: { grossCents: gross, netCents: net, taxCents: tax, taxCode: code } };
}

/** Complete a draft's corrections from the posted legs of the components they name, or refuse it. */
export function completeMemberMoneyBatch(batch: BuiltBatch, posted: readonly PostedRevenueLeg[]): BuiltBatch {
  if (batch.corrections.length === 0) return batch;
  const problems: string[] = [];
  const lines = [...batch.lines];
  for (const correction of batch.corrections) {
    const live = liveSplit(correction, posted);
    if ("problem" in live) {
      problems.push(live.problem);
      continue;
    }
    const split = live.split;
    if (correction.frozenTax !== null && stableStringify(correction.frozenTax) !== stableStringify(split ?? "untaxed")) {
      problems.push(`the frozen split given for ${correction.chargeIdentity} is not the split it was posted with`);
      continue;
    }
    lines.push(...revenueLines({ ...correction.shared, chargeIdentity: correction.chargeIdentity }, correction.account,
      correction.grossCents, split));
  }
  if (problems.length > 0) throw new MemberMoneyPlanError(problems);
  return { ...batch, lines, corrections: [] };
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
  context: MemberMoneyPostingContext,
  plan: MemberMoneyReversalPlan,
  original: MemberMoneyJournalToReverse,
): BuiltBatch {
  const problems: string[] = [];
  const eventKey = memberMoneyEventKeys.reversal(plan.reversesJournalId);
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
    corrections: [],
  });
}
