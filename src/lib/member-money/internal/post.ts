import type { Prisma } from "@prisma/client";
import type { ClubTaxSettings } from "../../club-tax-settings";
import { clubTaxTreatmentOn } from "../../club-tax-settings";
import { clubCalendarDateOf, type ClubTimeZone, type Instant } from "../../club-time";
import {
  buildMemberMoneyBatch,
  buildMemberMoneyReversal,
  type MemberMoneyPlan,
  type MemberMoneyPostingContext,
  type MemberMoneyReversalPlan,
} from "./plan";
import { readMemberMoneyJournalToReverse, writeMemberMoneyBatch, type MemberMoneyPosting } from "./store";

/**
 * Resolve a posting context BEFORE the business transaction opens
 * (`INV-LOCK-004`): the club civil date of the instant through the club-time
 * kernel (`INV-DATE`, `INV-CONFIG-002`) and the tax treatment in force on it
 * (D3). Pure; the caller has already read the zone, currency and tax setting.
 */
export function resolveMemberMoneyPostingContext(input: {
  effectiveAt: Instant;
  zone: ClubTimeZone;
  currency: string;
  policyVersion: string;
  codingVersion: string;
  taxSettings: ClubTaxSettings;
}): MemberMoneyPostingContext {
  const effectiveDate = clubCalendarDateOf(input.effectiveAt, input.zone);
  return {
    effectiveAt: input.effectiveAt,
    effectiveDate,
    currency: input.currency,
    policyVersion: input.policyVersion,
    codingVersion: input.codingVersion,
    tax: clubTaxTreatmentOn(input.taxSettings, effectiveDate),
  };
}

/**
 * THE posting command (#4626, Ledger M3a). Builds one complete batch from the
 * plan, refusing an ill-shaped or unbalanced plan before any write, then writes
 * it inside the caller's transaction. An identical replay of the event key
 * returns the batch already posted; different content under the key throws
 * `MemberMoneyPostingConflictError`. A database refusal at commit rolls the
 * caller's business mutation back too: no caller may catch it and commit.
 */
export async function postMemberMoneyEvent(
  tx: Prisma.TransactionClient,
  context: MemberMoneyPostingContext,
  plan: MemberMoneyPlan,
): Promise<MemberMoneyPosting> {
  return writeMemberMoneyBatch(tx, buildMemberMoneyBatch(context, plan));
}

/** Post the exact whole-batch REVERSAL of a posted journal, once (the database refuses a second). */
export async function reverseMemberMoneyJournal(
  tx: Prisma.TransactionClient,
  context: Pick<MemberMoneyPostingContext, "effectiveAt" | "effectiveDate">,
  plan: MemberMoneyReversalPlan,
): Promise<MemberMoneyPosting> {
  const original = await readMemberMoneyJournalToReverse(tx, plan.reversesJournalId);
  return writeMemberMoneyBatch(tx, buildMemberMoneyReversal(context, plan, original));
}
