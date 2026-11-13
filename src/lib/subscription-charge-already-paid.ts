import type {
  MembershipFeeBillingBasis,
  MembershipSubscriptionChargeSource,
  MembershipSubscriptionChargeStatus,
  SubscriptionStatus,
} from "@prisma/client";

import { chargeFamilyAxisKey } from "@/lib/membership-charge-axis";

/**
 * #4098: the one home for what a membership subscription charge's status means
 * for invoice work, and for the "already paid" conflict and its close. Client
 * safe (type imports only): the Subscriptions panel decides which buttons to
 * show from the same predicates the server enforces.
 */

/**
 * The charge statuses that will never need a Xero invoice. `NOT_REQUIRED` is a
 * zero-cent `NO_INVOICE` charge, or one an officer closed because its covered
 * subscriptions were already paid; `VOIDED` is a charge whose invoice Xero voided
 * (#2147). Every delivery consumer — the enqueue, the outbox worker, the outbox
 * failure handler and Xero Operations Retry — leaves these alone.
 */
export const MEMBERSHIP_CHARGE_NO_INVOICE_STATUSES = [
  "NOT_REQUIRED",
  "VOIDED",
] as const satisfies readonly MembershipSubscriptionChargeStatus[];

export function membershipChargeNeedsNoInvoice(charge: {
  status: MembershipSubscriptionChargeStatus | string;
  billingBasis: MembershipFeeBillingBasis | string;
}): boolean {
  return (
    charge.billingBasis === "NO_INVOICE" ||
    (MEMBERSHIP_CHARGE_NO_INVOICE_STATUSES as readonly string[]).includes(charge.status)
  );
}

/**
 * The WHERE for every charge-status write the invoice pipeline makes — the
 * enqueue, the worker and the outbox failure handler: this charge, and still
 * able to be invoiced. A charge in a no-invoice status (closed as already paid,
 * #4098, or VOIDED, #2147) matches nothing, so no pipeline write can reopen it,
 * however late it lands.
 */
export function liveChargeWhere(chargeId: string) {
  return { id: chargeId, status: { notIn: [...MEMBERSHIP_CHARGE_NO_INVOICE_STATUSES] } };
}

/** The `lastErrorCode` the invoice worker writes when a covered subscription is already PAID. */
export const SUBSCRIPTION_ALREADY_PAID_CODE = "SUBSCRIPTION_ALREADY_PAID";

/**
 * The `lastErrorCode` left on a CLOSED charge when an invoice attempt that was
 * already in Xero finished after the close (#4098 review): the invoice it
 * raised or adopted is linked to nothing and must be voided in Xero by hand.
 */
export const STRAY_INVOICE_AFTER_CLOSE_CODE = "STRAY_INVOICE_AFTER_CLOSE";

export function strayInvoiceAfterCloseMessage(invoiceLabel: string): string {
  return (
    `This charge was closed as already paid while Xero invoice ${invoiceLabel} was being raised for it. ` +
    "That invoice was not emailed and is not recorded against any member here. Void it in Xero promptly: " +
    "until then the membership sync may attach it to the recipient's subscription. " +
    "This note stays on the closed charge as the record; once the invoice is voided there is nothing more to do."
  );
}

/** True for the outcome the worker records on its operation for a stray invoice. */
export function isStrayInvoiceAfterCloseOutcome(responsePayload: unknown): boolean {
  return (
    typeof responsePayload === "object" &&
    responsePayload !== null &&
    (responsePayload as { conflict?: unknown }).conflict === STRAY_INVOICE_AFTER_CLOSE_CODE
  );
}

/** Xero Operations' reason for that operation (#4098 review, money F4). */
export const STRAY_INVOICE_AFTER_CLOSE_OPERATION_REASON =
  "The membership charge was closed as already paid while this invoice was being raised, so the invoice " +
  "was not emailed and is not recorded against any member. Void it in Xero promptly (the membership sync " +
  "may otherwise attach it to the recipient), then mark this operation resolved. There is nothing to retry.";

/** The longest reason an officer may give for closing an already-paid charge. */
export const CLOSE_ALREADY_PAID_REASON_MAX = 500;

/** How to undo a payment recorded outside the charge, in the panel's words. */
const REVERSE_PAYMENT_HOW = "Mark as unpaid on the subscription, or void it in Xero";

/**
 * What to do with an already-paid conflict whose covered subscriptions are not
 * all paid: it can't be closed as paid, and Retry alone loops, because the
 * worker conflicts again while ANY covered subscription is PAID. So the two
 * paths that work are named: pay the rest and close, or unpay every one and
 * Retry. Shared by the worker's conflict message and both of the close's
 * refusals (#4098 review: money F1 / security F1).
 */
export const PARTLY_PAID_CHARGE_ADVICE =
  "Not every covered subscription is paid (or not required), so it can't be closed as paid. Either record " +
  "the remaining payments and then close it, or reverse every payment recorded for it " +
  `(${REVERSE_PAYMENT_HOW}) and then Retry to invoice the whole charge.`;

/**
 * The conflict message the invoice worker stores, naming the real choices
 * (#4098). The worker conflicts when ANY covered subscription is PAID, but the
 * close needs EVERY one settled (PAID, or NOT_REQUIRED for an exempt member),
 * so a charge that is not wholly settled gets different advice.
 */
export function subscriptionAlreadyPaidConflictMessage(
  paidMemberNames: readonly string[],
  everyCoveredSubscriptionSettled: boolean,
): string {
  const subject = paidMemberNames.length === 1 ? "subscription is" : "subscriptions are";
  const head = `Covered ${subject} already PAID (${paidMemberNames.join(", ")}); no Xero invoice was created. `;
  if (everyCoveredSubscriptionSettled) {
    return (
      head +
      `Close it as already paid on the Subscriptions page, or reverse the payment (${REVERSE_PAYMENT_HOW}) and Retry.`
    );
  }
  return head + PARTLY_PAID_CHARGE_ADVICE;
}

/**
 * True when an officer may close this charge as already paid: it sits in
 * `CONFLICT` with `SUBSCRIPTION_ALREADY_PAID` and no Xero invoice. The server
 * also re-reads every covered subscription as settled (PAID, or NOT_REQUIRED
 * for an exempt member) before it closes.
 */
export function isChargeClosableAsAlreadyPaid(charge: {
  status: MembershipSubscriptionChargeStatus | string;
  lastErrorCode: string | null;
  xeroInvoiceId: string | null;
}): boolean {
  return (
    charge.status === "CONFLICT" &&
    charge.lastErrorCode === SUBSCRIPTION_ALREADY_PAID_CODE &&
    charge.xeroInvoiceId === null
  );
}

/**
 * The subscription statuses that count as SETTLED for a charge: PAID, and
 * NOT_REQUIRED — an exempt member owes nothing (owner decision on #4110,
 * 15 Oct 2026). Used by the close, the panel's Close offer, the worker's
 * conflict advice and the preview's "only a reversal re-bills a closed family"
 * rule, so they all read settled the same way.
 */
export const SETTLED_SUBSCRIPTION_STATUSES = [
  "PAID",
  "NOT_REQUIRED",
] as const satisfies readonly SubscriptionStatus[];

export function isSubscriptionSettled(status: SubscriptionStatus | string): boolean {
  return (SETTLED_SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
}

/**
 * True when the charge's ACTIVE coverage is non-empty and every subscription in
 * it is settled (PAID or NOT_REQUIRED) — the second half of what the close
 * needs, after `isChargeClosableAsAlreadyPaid`. A row without `releasedAt` is
 * read as active (the close selects only active rows). The panel offers Close
 * only when this holds, and the close refuses when it does not.
 */
export function everyActiveCoveredSubscriptionSettled(
  coverage: ReadonlyArray<{ releasedAt?: Date | string | null; subscription: { status: string } }>,
): boolean {
  const active = coverage.filter((row) => row.releasedAt == null);
  return active.length > 0 && active.every((row) => isSubscriptionSettled(row.subscription.status));
}

/**
 * Whether a covered subscription was PAID when an officer's close as already
 * paid released its claim (#4110 review). The close records the status it saw
 * on the coverage row; NULL is a close made before that column existed, when
 * the close accepted only PAID.
 */
export function wasPaidAtClose(row: { subscriptionStatusAtClose: SubscriptionStatus | null }): boolean {
  return (row.subscriptionStatusAtClose ?? "PAID") === "PAID";
}

/**
 * #4110 (owner, 15 Oct 2026, decision 3): only a reversal of a covered
 * member's PAYMENT makes a family whose charge was closed as already paid
 * billable again. So a released coverage row of such a charge counts as
 * reversed only when its subscription was PAID at the close and is no longer
 * settled. An exempt member (NOT_REQUIRED at the close) had no payment to
 * reverse: a later move to NOT_INVOICED — an assignment re-save, or the
 * membership sync for a REQUIRED type — is not a reversal (#4110 review F1).
 */
export function isClosedCoveragePaymentReversed(row: {
  subscriptionStatusAtClose: SubscriptionStatus | null;
  subscription: { status: SubscriptionStatus | string };
}): boolean {
  return wasPaidAtClose(row) && !isSubscriptionSettled(row.subscription.status);
}

/**
 * True for a charge an officer closed as already paid. Confirmation writes
 * `NOT_REQUIRED` only for a `NO_INVOICE` charge, so a `NOT_REQUIRED` charge on
 * any other basis can only have come from the close.
 */
export function isChargeClosedAsAlreadyPaid(charge: {
  status: MembershipSubscriptionChargeStatus | string;
  billingBasis: MembershipFeeBillingBasis | string;
}): boolean {
  return charge.status === "NOT_REQUIRED" && charge.billingBasis !== "NO_INVOICE";
}

/**
 * #4110 (owner, 15 Oct 2026): the preview's warning that a family whose charge
 * was closed as already paid had only SOME members' payments reversed, so
 * confirming invoices the whole family fee. It rides the preview's exception
 * list so it is in the confirmation token, but unlike every other code it does
 * not withhold the entry: the officer is warned, and confirming invoices it.
 */
export const CLOSED_FAMILY_PARTLY_REVERSED_CODE = "CLOSED_FAMILY_PARTLY_REVERSED";

/**
 * #4110 review round 5: the preview's warning that a family whose charge was
 * closed as already paid is billed again for the full fee while a member that
 * charge covered already holds a Xero invoice for the season (typically the
 * difference Finance invoiced by hand, decision 4), so confirming may overbill.
 * A warning like CLOSED_FAMILY_PARTLY_REVERSED: an officer confirms through it,
 * an approval withholds the family for Finance.
 */
export const CLOSED_FAMILY_REBILL_BESIDE_INVOICE_CODE = "CLOSED_FAMILY_REBILL_BESIDE_INVOICE";

/** True for a preview exception that warns about a charge confirming still invoices. */
export function isInvoicingPreviewWarning(code: string): boolean {
  return code === CLOSED_FAMILY_PARTLY_REVERSED_CODE || code === CLOSED_FAMILY_REBILL_BESIDE_INVOICE_CODE;
}

/**
 * #4110 review F2 (owner decision 1 on #4110: the preview flags a partly
 * reversed closed family for the officer BEFORE confirming). Membership
 * approval confirms its own preview with no officer looking at it, so for that
 * source an invoicing warning withholds the family entry it names, like any
 * other exception: it is persisted OPEN for Finance and counted, so the
 * approver is told Finance must review it. Finance's own confirm of the billing
 * run then shows the warning and invoices the family.
 */
export function confirmWithholdsInvoicingWarnings(source: MembershipSubscriptionChargeSource): boolean {
  return source === "NEW_MEMBER_APPROVAL";
}

/** Appended to a withheld warning's persisted message, for Finance. */
export const WITHHELD_ON_APPROVAL_NOTE =
  "It was not invoiced on membership approval: Finance must review it in Subscription billing and confirm the billing run to invoice it.";

/**
 * The family entry an invoicing warning names, keyed the same way from either
 * side. Delegates to `chargeFamilyAxisKey` (INV-SSOT-007) rather than
 * building its own template literal, so a category-axis warning/entry is
 * keyed identically to how `membership-subscription-billing.ts` keys a
 * category charge — a second, independent key-builder here would have been
 * exactly the drift the shared accessor exists to prevent.
 */
export function invoicingWarningEntryKey(item: {
  seasonYear: number;
  familyGroupId: string | null;
  membershipTypeId: string | null;
  subscriptionCategoryId?: string | null;
}): string {
  return chargeFamilyAxisKey({
    seasonYear: item.seasonYear,
    familyGroupId: item.familyGroupId,
    membershipTypeId: item.membershipTypeId,
    subscriptionCategoryId: item.subscriptionCategoryId ?? null,
  });
}

/**
 * #4110 decisions 4 and 5 (owner, 16 Oct 2026): a member a closed family
 * charge covered whom the officer must decide how to bill, because the family
 * is not billed again for them:
 *  - while the newest closed charge still bills the family: one exempt at a
 *    close who now needs a subscription, or one whose payment under an OLDER
 *    closed charge was reversed;
 *  - while a reversal under the newest charge would re-bill the family but a
 *    hold keeps it back (#2161: another member's own invoice or family
 *    charge, or an operator's marker; review rounds 6 and 7): every covered
 *    member no longer settled, whichever reason, naming the hold.
 * The exception withholds, regenerates on every preview until the member is
 * settled or holds a Xero invoice, and so stays OPEN until Finance acts.
 */
export const CLOSED_FAMILY_MEMBER_NEEDS_DECISION_CODE = "CLOSED_FAMILY_MEMBER_NEEDS_DECISION";

/** True for an exception that asks the officer to decide (counted apart in the panel). */
export function isOfficerDecisionException(code: string): boolean {
  return code === CLOSED_FAMILY_MEMBER_NEEDS_DECISION_CODE;
}

/**
 * Why a closed family's member needs the officer's decision. A reversal under
 * the NEWEST charge needs a decision only when a hold keeps the family's
 * re-bill back; what holds it travels in the message's `heldBy`.
 */
export type ClosedFamilyDecisionReason = "EXEMPT_AT_CLOSE" | "REVERSED_UNDER_OLDER_CHARGE" | "REVERSED_UNDER_NEWEST_CHARGE";

/**
 * The two choices decision 4 gives the officer, worded once.
 *
 * `axisName` (renamed from `membershipTypeName` when category billing was
 * folded into this same decision machinery) is whichever axis's display
 * name applies — a membership type's name for a type charge, a
 * `chargeAxisDisplayName`-resolved category name for a category charge. The
 * wording itself does not care which axis it is.
 */
export function closedFamilyMemberDecisionMessage(input: {
  memberName: string;
  axisName: string;
} & (
  | { reason: "EXEMPT_AT_CLOSE" | "REVERSED_UNDER_OLDER_CHARGE"; heldBy?: string }
  // Only ever raised for a held family, so what holds it is required.
  | { reason: "REVERSED_UNDER_NEWEST_CHARGE"; heldBy: string }
)): string {
  const held = input.heldBy ? `, and the family is held back by ${input.heldBy}` : "";
  const why = input.reason === "EXEMPT_AT_CLOSE"
    ? `${input.memberName} was not required to pay when the family's ${input.axisName} charge was closed as already paid, and now needs a subscription${held}.`
    : input.reason === "REVERSED_UNDER_OLDER_CHARGE"
      ? input.heldBy
        ? `${input.memberName}'s payment under an earlier closed ${input.axisName} family charge was reversed${held}.`
        : `${input.memberName}'s payment under an earlier closed ${input.axisName} family charge was reversed, but the family's newer charge, closed as already paid, still stands.`
      : `${input.memberName}'s payment under the family's closed ${input.axisName} charge was reversed${held}.`;
  return (
    `${why} The family is not billed again. Decide how to bill ${input.memberName}: ` +
    "if the family fee already covers everyone in the family, mark them Paid; " +
    "otherwise invoice just the difference in Xero by hand."
  );
}
