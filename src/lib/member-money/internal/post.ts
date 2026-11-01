import type { Prisma } from "@prisma/client";
import type { ClubFormat } from "../../club-format";
import {
  ClubTaxTreatmentUnavailableError,
  clubTaxTreatmentOn,
  type ClubTaxSettings,
} from "../../club-tax-settings";
import { clubCalendarDateOf, type ClubTimeZone, type Instant } from "../../club-time";
import { clubChargeCurrencyCodeOrThrow } from "../../stripe-charge-currency";
import {
  buildMemberMoneyBatch,
  buildMemberMoneyReversal,
  type MemberMoneyPlan,
  type MemberMoneyPostingContext,
  type MemberMoneyReversalPlan,
  type MemberMoneyTaxContext,
} from "./plan";
import { readMemberMoneyJournalToReverse, writeMemberMoneyBatch, type MemberMoneyPosting } from "./store";

/**
 * Resolve a posting context BEFORE the business transaction opens
 * (`INV-LOCK-004`), and the only way to make one. The club civil date of the
 * instant comes through the club-time kernel (`INV-DATE`, `INV-CONFIG-002`).
 * The currency comes through the rule card charges use
 * (`clubChargeCurrencyCodeOrThrow`), so the journal and the card cannot
 * disagree. A stored currency a card cannot be charged in is refused here, so
 * such a club posts nothing at all, bank and cash events included. The tax
 * treatment is the one in force on that date (D3), or "unavailable" when the
 * setting starts later; only a fresh tax split refuses that.
 *
 * `effectiveAt` must be the source fact's own stable instant, never the clock
 * at processing time: the payload hash includes it.
 */
export function resolveMemberMoneyPostingContext(input: {
  effectiveAt: Instant;
  zone: ClubTimeZone;
  format: ClubFormat;
  policyVersion: string;
  codingVersion: string;
  taxSettings: ClubTaxSettings;
}): MemberMoneyPostingContext {
  const effectiveDate = clubCalendarDateOf(input.effectiveAt, input.zone);
  let tax: MemberMoneyTaxContext;
  try {
    tax = { status: "known", treatment: clubTaxTreatmentOn(input.taxSettings, effectiveDate) };
  } catch (error) {
    if (!(error instanceof ClubTaxTreatmentUnavailableError)) throw error;
    tax = { status: "unavailable", effectiveFrom: error.effectiveFrom };
  }
  return {
    effectiveAt: input.effectiveAt,
    effectiveDate,
    currency: clubChargeCurrencyCodeOrThrow(input.format),
    policyVersion: input.policyVersion,
    codingVersion: input.codingVersion,
    tax,
  } as MemberMoneyPostingContext;
}

/**
 * THE posting command (#4626, Ledger M3a). Builds one complete batch from the
 * plan, refusing an ill-shaped or unbalanced plan before any write, then writes
 * it inside the caller's transaction. An identical replay of the event key
 * returns the batch already posted; different content under the key throws
 * `MemberMoneyPostingConflictError`. A database refusal at commit rolls the
 * caller's business mutation back too: no caller may catch it and commit.
 *
 * PRECONDITION (`INV-LOCK-001`): a plan that corrects a revenue component, or
 * charges a component that already has posted legs, depends on that
 * component's live state until commit, so the caller's transaction must already
 * hold `pg_advisory_xact_lock(1)`. The store checks and refuses with
 * `GlobalLockNotHeldError` otherwise. Every door that will post one (R01-R04,
 * R21) already holds it. Only the first charge of a new component, and a plan
 * with no revenue component at all, need no key.
 */
export async function postMemberMoneyEvent(
  tx: Prisma.TransactionClient,
  context: MemberMoneyPostingContext,
  plan: MemberMoneyPlan,
): Promise<MemberMoneyPosting> {
  return writeMemberMoneyBatch(tx, buildMemberMoneyBatch(context, plan));
}

/**
 * Post the exact whole-batch REVERSAL of a posted journal, once: its key is the
 * journal's, so a retry replays and a second, different reversal conflicts. It
 * is refused if a revenue component the journal posted has changed since (a
 * later correction or charge): reverse that with an ADJUSTMENT instead. When the
 * journal posted revenue components, the same `lock(1)` precondition holds.
 */
export async function reverseMemberMoneyJournal(
  tx: Prisma.TransactionClient,
  context: MemberMoneyPostingContext,
  plan: MemberMoneyReversalPlan,
): Promise<MemberMoneyPosting> {
  const original = await readMemberMoneyJournalToReverse(tx, plan.reversesJournalId);
  return writeMemberMoneyBatch(tx, buildMemberMoneyReversal(context, plan, original), original);
}
