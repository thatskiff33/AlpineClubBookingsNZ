import { memberMoneyApplicationKeys, memberMoneyEventKeys, type MemberMoneyEventKey } from "./keys";
import { MemberMoneyPlanError, type MemberMoneyDebtor, type MemberMoneyLegPlan, type MemberMoneyPlan, type MemberMoneySource } from "./plan";

/**
 * SUBSCRIPTION CHARGES, JOINING FEES AND THEIR RECEIPTS AS PLANS (#4519, Ledger
 * M7). Pure: the doors in `subscription-posting.ts` read the facts and post
 * what these return. Every batch is sourced `SUBSCRIPTION` and names no
 * booking, so its receivable is the member's own (design section 4).
 *
 * R18 is one CHARGE per subscription charge row: one obligation for the whole
 * charge, owed by its recipient, and one `SUBSCRIPTION_REVENUE` component per
 * frozen charge component at its charged cents. The components must add up to
 * the charge, or nothing posts: the invoice and the journal never disagree on
 * what a charge is. A charge with no money (`NO_INVOICE`, or zero) is a ZERO
 * event under the same key, so the charge is in the journal either way.
 */

export interface SubscriptionChargeFacts {
  chargeId: string;
  recipientMemberId: string;
  billingBasis: string;
  chargedAmountCents: number;
  components: readonly { id: string; label: string; chargedAmountCents: number }[];
}

/** The one spelling of a charge's version on its R18 source link. */
const CONFIRM_VERSION = "confirm";

export const subscriptionChargeSource = (chargeId: string): MemberMoneySource =>
  ({ kind: "SUBSCRIPTION", id: chargeId, version: CONFIRM_VERSION });

/** The obligation R18 opens is named by its event key, as a booking's R01 obligation is. */
export const subscriptionChargeObligationKey = (chargeId: string): string => memberMoneyEventKeys.subscriptionCharge(chargeId);

/** A component's identity, so a later correction or reversal names exactly it. */
export const subscriptionComponentIdentity = (chargeId: string, componentId: string): string => `subscription:${chargeId}:${componentId}`;

/**
 * R18. `replacesPaid` names prior charges of a post-void re-bill that something
 * already collected (the owner's decision, 10 Nov 2026): their debt was paid, so
 * the new bill posts ZERO, linking them, rather than charge the member again.
 */
export function planSubscriptionCharge(
  facts: SubscriptionChargeFacts,
  options: { actorMemberId?: string | null; replacesPaid?: readonly string[] } = {},
): MemberMoneyPlan {
  const eventKey = memberMoneyEventKeys.subscriptionCharge(facts.chargeId);
  const source = subscriptionChargeSource(facts.chargeId);
  const common = { eventKey, origin: "APP" as const, source, actorMemberId: options.actorMemberId ?? null };
  const problems: string[] = [];
  if (!Number.isSafeInteger(facts.chargedAmountCents) || facts.chargedAmountCents < 0) problems.push("the charge needs non-negative integer cents");
  for (const component of facts.components) {
    if (!Number.isSafeInteger(component.chargedAmountCents) || component.chargedAmountCents < 0) {
      problems.push(`component ${component.id} needs non-negative integer cents`);
    }
  }
  const sum = facts.components.reduce((total, component) => total + component.chargedAmountCents, 0);
  if (facts.billingBasis !== "NO_INVOICE" && sum !== facts.chargedAmountCents) {
    problems.push(`the components add up to ${sum} cents, not the charge's ${facts.chargedAmountCents}`);
  }
  if (problems.length > 0) throw new MemberMoneyPlanError(problems);

  const replaced = [...new Set(options.replacesPaid ?? [])].sort();
  if (replaced.length > 0) {
    return { ...common, kind: "ZERO", reason: "Subscription re-bill of a voided charge already paid: nothing more owed",
      additionalSources: replaced.map((id) => ({ kind: "SUBSCRIPTION" as const, id, version: "replaced-paid" })) };
  }
  if (facts.billingBasis === "NO_INVOICE" || facts.chargedAmountCents === 0) {
    return { ...common, kind: "ZERO", reason: "Subscription charge with no money" };
  }
  const debtor: MemberMoneyDebtor = { kind: "MEMBER", memberId: facts.recipientMemberId };
  const obligationKey = subscriptionChargeObligationKey(facts.chargeId);
  const legs: MemberMoneyLegPlan[] = [
    { type: "amount", account: "MEMBER_RECEIVABLE", side: "DEBIT", amountCents: facts.chargedAmountCents, debtor, obligationKey,
      evidence: { chargeId: facts.chargeId } },
    ...facts.components.filter((component) => component.chargedAmountCents > 0).map((component): MemberMoneyLegPlan => ({
      type: "revenue", account: "SUBSCRIPTION_REVENUE", side: "CREDIT", grossCents: component.chargedAmountCents,
      chargeIdentity: subscriptionComponentIdentity(facts.chargeId, component.id), evidence: { label: component.label },
    })),
  ];
  return { ...common, kind: "CHARGE", reason: "Subscription charge confirmed",
    obligations: [{ key: obligationKey, kind: "CHARGE", debtor, faceCents: facts.chargedAmountCents, evidence: { chargeId: facts.chargeId } }],
    legs };
}

/**
 * R19, once per member: the entrance fee frozen on its Xero invoice, as a CHARGE
 * to `JOINING_FEE_REVENUE`, or ZERO for a member the club exempts.
 */
export function planJoiningFee(input: {
  memberId: string;
  feeAmountCents: number;
  exempt: boolean;
  actorMemberId?: string | null;
}): MemberMoneyPlan {
  const eventKey = memberMoneyEventKeys.joiningFee(input.memberId);
  const source: MemberMoneySource = { kind: "SUBSCRIPTION", id: input.memberId, version: "joining-fee" };
  const common = { eventKey, origin: "APP" as const, source, actorMemberId: input.actorMemberId ?? null };
  if (input.exempt) return { ...common, kind: "ZERO", reason: "Member exempt from the joining fee" };
  if (!Number.isSafeInteger(input.feeAmountCents) || input.feeAmountCents <= 0) {
    throw new MemberMoneyPlanError(["a joining fee needs positive integer cents"]);
  }
  const debtor: MemberMoneyDebtor = { kind: "MEMBER", memberId: input.memberId };
  const obligationKey: string = eventKey;
  return { ...common, kind: "CHARGE", reason: "Joining fee invoiced",
    obligations: [{ key: obligationKey, kind: "CHARGE", debtor, faceCents: input.feeAmountCents, evidence: {} }],
    legs: [
      { type: "amount", account: "MEMBER_RECEIVABLE", side: "DEBIT", amountCents: input.feeAmountCents, debtor, obligationKey, evidence: {} },
      { type: "revenue", account: "JOINING_FEE_REVENUE", side: "CREDIT", grossCents: input.feeAmountCents,
        chargeIdentity: `joining-fee:${input.memberId}`, evidence: {} },
    ] };
}

/**
 * R08: cash an officer recorded against a subscription charge, as Dr CASH / Cr
 * MEMBER_RECEIVABLE, collected against the charge's obligation in the same
 * batch. Reversing the receipt takes the collection back with it.
 */
export function planSubscriptionReceipt(input: {
  eventKey: MemberMoneyEventKey;
  chargeId: string;
  version: string;
  debtor: MemberMoneyDebtor;
  obligationKey: string;
  amountCents: number;
  reason: string;
  actorMemberId?: string | null;
}): MemberMoneyPlan {
  const evidence = { chargeId: input.chargeId };
  return {
    kind: "RECEIPT", eventKey: input.eventKey, origin: "OFFICER", reason: input.reason, actorMemberId: input.actorMemberId ?? null,
    source: { kind: "SUBSCRIPTION", id: input.chargeId, version: input.version },
    legs: [
      { type: "amount", account: "CASH", side: "DEBIT", amountCents: input.amountCents, evidence },
      { type: "amount", account: "MEMBER_RECEIVABLE", side: "CREDIT", amountCents: input.amountCents, debtor: input.debtor, evidence },
    ],
    applications: [{
      key: memberMoneyApplicationKeys.application(input.eventKey, `cash:${input.chargeId}`, input.obligationKey),
      source: { leg: 1 }, obligationKey: input.obligationKey, amountCents: input.amountCents,
    }],
  };
}
