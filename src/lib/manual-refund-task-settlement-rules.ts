import type { ManualRefundTaskKind } from "@prisma/client";

/**
 * #3213 (epic #2797): WHICH FINANCE-QUEUE ITEMS CAN BE SETTLED AT ALL, and the
 * sentence an officer gets when one cannot.
 *
 * Two layers have to agree about this and they cannot share a module otherwise:
 * `manual-refund-task-resolution.ts` is `server-only`, so the settle screen
 * cannot import the rule from where it is enforced, and a copy written beside
 * the screen would drift from the one the server throws. That is the same split
 * `manual-refund-task-copy.ts` records for the zero refusal - and the reason
 * this is a module of its own rather than another section of that one is that a
 * RULE is not COPY: the screen consults this to decide whether a control exists
 * at all, which is a question about behaviour rather than about words.
 *
 * `INV-SSOT`. Before this, "a withheld share cannot be completed" would have
 * been decided twice - once by the door and once by the card - and the failure
 * mode of that arrangement is not a visible disagreement but a silent one: a
 * card that keeps offering a control the server has started refusing.
 *
 * THE RULE ITSELF HAS ONE HOME AND IT IS NOT THIS FILE. `INV-PAY-051`
 * (`docs/invariants/payment-and-settlement.md`) states why `COMPLETED` is
 * refused on this kind, which is the part a reader needs to understand rather
 * than to call.
 */

/**
 * May a task of this kind be closed as money that moved?
 *
 * FALSE FOR EXACTLY ONE KIND. `UNCOLLECTED_EDIT_REVIEW_SHARE` is a notice that
 * the club may not have ASKED for money, so there is nothing for a settlement to
 * record - and a `COMPLETED` close whose `settlementDirection` is null reads as
 * `REFUND_TO_MEMBER` on every kind older than `EDIT_FINANCIAL_REVIEW`, so
 * completing one would assert a refund the club never made and reach the refund
 * allocation path with an amount that is not a refund at all.
 *
 * TAKES A LOOSE STRING, because the browser's copy of a task's kind is one: a
 * cached client bundle reading a newer row must degrade rather than throw. An
 * unrecognised kind - including a row written before the column existed, which
 * carries null - answers TRUE, so this can only ever CLOSE a door, never open
 * one the server would refuse.
 */
export function manualRefundTaskKindAllowsSettlement(
  kind: ManualRefundTaskKind | string | null | undefined,
): boolean {
  return kind !== "UNCOLLECTED_EDIT_REVIEW_SHARE";
}

/**
 * The refusal the completion door raises, or null when this close is allowed.
 *
 * ONE CALL RATHER THAN A PREDICATE PLUS A STRING, because the door has to ask
 * both questions together and a caller that asked only one would either refuse
 * a dismissal or complete a withheld share. Answering `null` for every
 * dismissal is part of the rule, not a caller's business: DISMISSED is how one
 * of these items IS closed.
 *
 * IT NAMES THE WAY OUT, which is what the owner's 31 Aug 2026 decision on the
 * zero refusal asks of every refusal on this screen. Here the way out is the
 * whole job: check Xero, bill only what is missing, then close the item.
 */
export function manualRefundTaskSettlementRefusal(
  kind: ManualRefundTaskKind | string | null | undefined,
  resolution: "completed" | "dismissed",
): string | null {
  if (resolution !== "completed") return null;
  if (manualRefundTaskKindAllowsSettlement(kind)) return null;
  return "This item records money the club may not have asked for, so it cannot be closed as an amount settled here - nothing about it moves money. Check the booking's Xero invoices, bill any shortfall by hand, then close it with a note saying what you found and what you billed.";
}
