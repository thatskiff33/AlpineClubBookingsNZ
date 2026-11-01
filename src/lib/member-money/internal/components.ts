import type { MemberMoneyAccount, MemberMoneySide } from "@prisma/client";
import { stableStringify } from "../../stable-digest";
import { formatCentsPlain } from "../../utils";
import { TAXED_REVENUE_ACCOUNTS } from "./accounts";
import {
  MemberMoneyPlanError,
  revenueLines,
  type BuiltBatch,
  type BuiltCorrection,
  type MemberMoneyJournalToReverse,
} from "./plan";
import type { MemberMoneyTaxSplit } from "./tax";

/**
 * The live state of a revenue component (#4626, Ledger M3a): what its posted
 * legs still carry. A component is one taxed revenue account and one
 * `chargeIdentity`, across the whole journal. Pure; the store reads the legs.
 */

/** A posted revenue leg, as a correction or a reversal reads the component it names. */
export interface PostedRevenueLeg {
  account: MemberMoneyAccount;
  chargeIdentity: string | null;
  side: MemberMoneySide;
  amountCents: number;
  grossCents: number | null;
  netCents: number | null;
  taxCents: number | null;
  taxCode: string | null;
  bookingId: string | null;
  lodgeId: string | null;
}

interface Totals { gross: number; net: number; tax: number }
interface ComponentState {
  /** Each distinct booking and lodge the component's legs name. */
  scopes: Set<string>;
  /** Signed totals per tax code (null: untaxed). Credits add, debits take away. */
  byCode: Map<string | null, Totals>;
}

const componentKey = (account: string, chargeIdentity: string) => `${account}\u0000${chargeIdentity}`;
const scopeOf = (leg: { bookingId: string | null; lodgeId: string | null }) => stableStringify([leg.bookingId, leg.lodgeId]);

function componentStates(posted: readonly PostedRevenueLeg[]): Map<string, ComponentState> {
  const states = new Map<string, ComponentState>();
  for (const leg of posted) {
    if (leg.chargeIdentity === null) continue;
    const key = componentKey(leg.account, leg.chargeIdentity);
    const state = states.get(key) ?? { scopes: new Set<string>(), byCode: new Map<string | null, Totals>() };
    states.set(key, state);
    state.scopes.add(scopeOf(leg));
    const totals = state.byCode.get(leg.taxCode) ?? { gross: 0, net: 0, tax: 0 };
    const sign = leg.side === "CREDIT" ? 1 : -1;
    totals.gross += sign * (leg.grossCents ?? leg.amountCents);
    totals.net += sign * (leg.netCents ?? leg.amountCents);
    totals.tax += sign * (leg.taxCents ?? 0);
    state.byCode.set(leg.taxCode, totals);
  }
  return states;
}

/** The tax codes a component still carries money under. A code fully netted to zero no longer counts. */
const liveCodes = (state: ComponentState) => [...state.byCode].filter(([, totals]) => totals.gross !== 0);

type LiveSplit = { split: MemberMoneyTaxSplit | null } | { problem: string };

/**
 * The split a correction must repeat. The component's legs must agree on one
 * booking and lodge, which the correction must name too. Exactly one tax code
 * may still carry money: a component fully corrected under one code and charged
 * again under another is corrected at the new code. The correction takes the
 * whole live component.
 */
function liveSplit(correction: BuiltCorrection, state: ComponentState | undefined): LiveSplit {
  const id = correction.chargeIdentity;
  if (!state) return { problem: `component ${id} has no posted ${correction.account} leg` };
  if (state.scopes.size > 1) return { problem: `component ${id}'s posted legs disagree on its booking or lodge` };
  if (!state.scopes.has(scopeOf(correction.shared))) {
    return { problem: `the correction of ${id} names a different booking or lodge from the component's` };
  }
  const live = liveCodes(state);
  if (live.length > 1) return { problem: `component ${id} carries money under more than one tax treatment` };
  const [code, totals] = live[0] ?? [null, { gross: 0, net: 0, tax: 0 }];
  if (totals.gross !== correction.grossCents) {
    return { problem: `a correction takes a whole component: ${id} still carries `
      + `${formatCentsPlain(totals.gross)}, not ${formatCentsPlain(correction.grossCents)}` };
  }
  if (code === null) return { split: null };
  if (totals.net <= 0) return { problem: `component ${id} has no net revenue left to correct` };
  return { split: { grossCents: totals.gross, netCents: totals.net, taxCents: totals.tax, taxCode: code } };
}

/** Complete a draft's corrections from the posted legs of the components they name, or refuse it. */
export function completeMemberMoneyBatch(batch: BuiltBatch, posted: readonly PostedRevenueLeg[]): BuiltBatch {
  if (batch.corrections.length === 0) return batch;
  const states = componentStates(posted);
  const problems: string[] = [];
  const lines = [...batch.lines];
  for (const correction of batch.corrections) {
    const live = liveSplit(correction, states.get(componentKey(correction.account, correction.chargeIdentity)));
    if ("problem" in live) {
      problems.push(live.problem);
      continue;
    }
    if (correction.frozenTax !== null && stableStringify(correction.frozenTax) !== stableStringify(live.split ?? "untaxed")) {
      problems.push(`the frozen split given for ${correction.chargeIdentity} is not the split it was posted with`);
      continue;
    }
    lines.push(...revenueLines({ ...correction.shared, chargeIdentity: correction.chargeIdentity }, correction.account,
      correction.grossCents, live.split));
  }
  if (problems.length > 0) throw new MemberMoneyPlanError(problems);
  return { ...batch, lines, corrections: [] };
}

/** The components a journal's taxed revenue legs post, as `{ account, chargeIdentity }`. */
export function componentsPostedBy(journal: Pick<MemberMoneyJournalToReverse, "lines">) {
  const seen = new Map<string, { account: MemberMoneyAccount; chargeIdentity: string }>();
  for (const line of journal.lines) {
    if (line.chargeIdentity !== null && (TAXED_REVENUE_ACCOUNTS as readonly string[]).includes(line.account)) {
      seen.set(componentKey(line.account, line.chargeIdentity), { account: line.account, chargeIdentity: line.chargeIdentity });
    }
  }
  return [...seen.values()];
}

/**
 * An exact reversal is only right while each component the journal posted is
 * still as the journal left it. A charge's components must still carry exactly
 * what it credited (no correction since, which the reversal would drive
 * negative); a correction's components must carry nothing (not charged again
 * since). Anything else is refused: post an ADJUSTMENT instead.
 */
export function reversalLiveProblems(journal: Pick<MemberMoneyJournalToReverse, "lines">, posted: readonly PostedRevenueLeg[]): string[] {
  const states = componentStates(posted);
  const isRevenue = (account: string) => (TAXED_REVENUE_ACCOUNTS as readonly string[]).includes(account);
  const mine = componentStates(journal.lines.filter((line) => isRevenue(line.account)));
  const problems: string[] = [];
  for (const [key, own] of mine) {
    const contributed = [...own.byCode.values()].reduce((sum, totals) => sum + totals.gross, 0);
    const live = [...(states.get(key)?.byCode.values() ?? [])].reduce((sum, totals) => sum + totals.gross, 0);
    const expected = contributed > 0 ? contributed : 0;
    if (live !== expected) {
      const chargeIdentity = key.split("\u0000")[1];
      problems.push(`component ${chargeIdentity} has changed since this journal posted it (it carries ${formatCentsPlain(live)}, `
        + `not ${formatCentsPlain(expected)}): reverse it with an ADJUSTMENT, not an exact reversal`);
    }
  }
  return problems;
}
