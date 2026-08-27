/**
 * What a membership cancellation will actually credit — and who else that
 * invoice still covers (#2400).
 *
 * ## The problem this exists to solve
 *
 * A family (or any billing group) is billed with ONE Xero invoice covering
 * everyone in it, and `xero-subscription-invoices.ts` writes that same
 * `xeroInvoiceId` onto every covered member's `MemberSubscription` row. The
 * cancellation credit note then credited `invoice.amountDue` — the invoice's
 * WHOLE remaining balance — so cancelling one child wiped the entire family's
 * bill, including the portion belonging to members who were staying. The club
 * lost that revenue silently: the invoice simply went to zero and nothing said
 * why.
 *
 * ## The owner's decision (31 Jul 2026, recorded on #2400)
 *
 * Credit the full balance **only when the leaving member is the last covered
 * member still with the club**. If anyone else the invoice covers is staying,
 * raise nothing automatically and tell the admin, who settles it deliberately in
 * Xero. Splitting the invoice per member was rejected: the invoice's lines are
 * one per FEE COMPONENT, not one per member (see the component snapshot in
 * `xero-subscription-invoices.ts`), so there is no honest per-member share to
 * credit — and a family fee is a fee for the family, which does not necessarily
 * shrink because one person left.
 *
 * ## Who counts as "still covered"
 *
 * Two records say who an invoice covers, and they are written in the same
 * transaction:
 *
 * 1. `MemberSubscription.xeroInvoiceId` — stamped on every covered member;
 * 2. the charge's `MembershipSubscriptionChargeCoverage` rows that are still
 *    ACTIVE (`releasedAt` is null) — the claim that says this member's season is
 *    already billed on this charge.
 *
 * Normally they agree. This module takes the **union** because there are two
 * real shapes where one half is empty and the other is not:
 *
 * - **A member who was already PAID when the invoice was raised.**
 *   `createXeroMembershipSubscriptionInvoice` stamps the invoice link with
 *   `status: { not: "PAID" }`, deliberately so a manual mark-paid is never
 *   blind-downgraded — so that member's season IS billed on the invoice and
 *   carries a coverage claim, but no `xeroInvoiceId`. Coverage-only is the ONLY
 *   record of them.
 * - **Rows minted before coverage claims existed**, which carry the invoice
 *   link alone. Invoice-link-only is the only record of them.
 *
 * The void-release path is deliberately NOT one of those cases, and the union
 * buys nothing there: `releaseVoidedSubscriptionInvoice` clears the coverage row
 * AND `MemberSubscription.xeroInvoiceId` in the SAME transaction, so a released
 * member leaves both halves at once and the two never disagree because of it.
 *
 * A disagreement means the covered set is not certain, and an uncertain answer
 * must never be the licence to wipe a balance: over-counting is the safe
 * direction, because under-counting destroys revenue silently — which is the
 * whole defect. Over-counting is not free, though, and the cost is stated
 * plainly rather than understated: it does not merely mean "do not credit
 * automatically". Where the invoice sits on the leaver's own Xero contact it
 * also HARD-BLOCKS the approval, because the unpaid-invoice blocker (#2392) then
 * sees a real balance behind a contact the approval would archive. An admin can
 * still clear it by hand in Xero — settle, credit or void — so the failure is
 * recoverable, which the silent revenue loss was not.
 *
 * A covered member keeps the invoice alive unless they have themselves been
 * cancelled, which the app records as `Member.cancelledAt` being set (the same
 * predicate the admin member list uses for its "Cancelled" filter). Deliberately
 * NOT `active`: a member can be deactivated without being cancelled, and their
 * season membership is still billed on that invoice, so the money is still owed.
 * Cancelled-but-not-yet-archived members do not keep it alive, which is what
 * lets a whole family leave: each approval cancels one member, and the LAST one
 * approved finds nobody else live on the invoice and credits it in full.
 *
 * `active` is still READ, for a different purpose: a deactivated member cannot
 * be approved for cancellation at all (`assertParticipantCanBeApproved` refuses
 * an inactive membership), so "cancel the rest of the family first" is not
 * advice a reviewer can follow when the members keeping the invoice alive are
 * deactivated. The notice says so rather than sending them round a loop.
 *
 * ## When the question is asked
 *
 * Every time, afresh, at the moment it is acted on — never snapshotted when the
 * cancellation was requested. A family's composition changes: members join,
 * leave, are rebilled, or are cancelled between a request being made, approved,
 * and the outbox draining. The only answer safe to act on is the one true at the
 * instant of the action, so the approval gate asks at approval and the credit
 * note asks again when it is about to be raised. Both call this module.
 *
 * ## "Would credit" is not "did credit"
 *
 * `creditsInFull` answers *"would a credit note be raised if this ran now?"*.
 * The credit-note operation is ONE-SHOT — it completes SUCCEEDED even when it
 * deliberately skips — so once a whole family has been cancelled the answer
 * flips back to `true` for every one of them although none of their credit notes
 * will ever run again. Anything that must know whether the invoice will ACTUALLY
 * be cleared therefore reads {@link
 * MembershipCancellationSubscriptionCreditPlan.excusesUnpaidInvoiceBlocker},
 * which also consults the credit operation's recorded outcome. That distinction
 * is what stops the #2392 archive re-check excusing an invoice nobody is going
 * to credit (#2400 review, F3).
 *
 * ## Reads only the database
 *
 * No Xero call. The covered set and the members' lifecycle state are local
 * records, so the review queue can show this for a page of participants without
 * touching Xero's quota, and the credit-note path can decide to skip before it
 * authenticates.
 */

import { memberName } from "@/lib/member-serialization";
import type {
  MembershipCancellationBlocker,
  MembershipCancellationSharedInvoiceNotice,
  MembershipCancellationSharedInvoiceRoute,
} from "@/lib/membership-cancellation-blocker-messages";
import { isUnpaidInvoiceBlocker } from "@/lib/membership-cancellation-blocker-messages";
import { prisma } from "@/lib/prisma";
import { fixedClubClock } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { clubSeasonYear } from "@/lib/financial-year";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import { XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE } from "@/lib/xero-operation-outbox-payload";

/**
 * Subscription states whose invoice a cancellation credits. The same rule
 * `createXeroMembershipCancellationCreditNote` applies before it raises the
 * note — a PAID subscription is never auto-refunded.
 */
export const MEMBERSHIP_CANCELLATION_CREDITABLE_SUBSCRIPTION_STATUSES = [
  "UNPAID",
  "OVERDUE",
] as const;

/**
 * Sync-operation states that mean the cancellation credit note has had its ONE
 * run and will not have another: SUCCEEDED (raised, or deliberately skipped) and
 * PARTIAL (raised, allocation still outstanding). Both are terminal for the
 * purposes of "is this invoice still going to be cleared?".
 */
const SETTLED_CREDIT_OPERATION_STATUSES = ["SUCCEEDED", "PARTIAL"] as const;

/** A member an invoice still covers, named so an admin can recognise them. */
export type MembershipCancellationCoveredMember = {
  memberId: string;
  name: string;
  /**
   * Whether their membership is still active. A deactivated membership cannot
   * be approved for cancellation, so an inactive covered member is one nobody
   * can "cancel first" to release the invoice.
   */
  active: boolean;
  /**
   * Their Xero contact, so the notice can tell whether cancelling them first
   * would hit the very same unpaid-invoice refusal (children who inherit a
   * parent's email resolve to the same contact).
   */
  xeroContactId: string | null;
};

/**
 * What the cancellation of one member will do to their current-season
 * subscription invoice.
 */
export type MembershipCancellationSubscriptionCreditPlan = {
  memberId: string;
  subscriptionId: string;
  invoiceId: string;
  invoiceNumber: string | null;
  /** Deep link to the invoice in Xero, for the admin who has to act on it. */
  xeroUrl: string;
  /** The leaving member's own Xero contact, or null when they have none. */
  memberXeroContactId: string | null;
  /**
   * Everyone else this invoice still covers whose membership has not been
   * cancelled. Empty means the leaver is the last one out.
   */
  sharedWith: MembershipCancellationCoveredMember[];
  /**
   * True when the cancellation WOULD credit this invoice's full remaining
   * balance if it ran right now — i.e. `sharedWith` is empty. On its own this is
   * not enough to excuse the invoice from the unpaid-invoice blocker; see
   * `excusesUnpaidInvoiceBlocker`.
   */
  creditsInFull: boolean;
  /**
   * True once this subscription's cancellation credit-note operation has had its
   * single run (SUCCEEDED or PARTIAL), whatever it did. A skipped run counts:
   * the operation is terminal and will not be retried, so no credit is coming.
   */
  creditOperationSettled: boolean;
  /**
   * The ONE predicate the unpaid-invoice blocker must agree with the credit note
   * on: the blocker excludes this invoice from its refusal exactly when this is
   * true, so an invoice nobody is going to credit can never be silently ignored
   * (#2400, #2392).
   *
   * It is `creditsInFull && !creditOperationSettled` — the credit must still be
   * *coming*, not merely have been *possible*. The archive re-check runs long
   * after the credit note has settled, and recomputing `creditsInFull` there
   * would excuse an invoice whose credit note already skipped (#2400 review, F3).
   */
  excusesUnpaidInvoiceBlocker: boolean;
};

function compareCoveredMembers(
  left: MembershipCancellationCoveredMember,
  right: MembershipCancellationCoveredMember,
): number {
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  return left.memberId < right.memberId ? -1 : 1;
}

/**
 * Members whose membership is still live, per subscription invoice id.
 *
 * Always returns an entry for every invoice asked about, so a caller can never
 * read "no key" as "nobody is covered".
 */
export async function loadLiveMembersCoveredBySubscriptionInvoices(
  invoiceIds: readonly string[],
): Promise<Map<string, MembershipCancellationCoveredMember[]>> {
  const uniqueInvoiceIds = [...new Set(invoiceIds)].filter(Boolean);
  const coveredByInvoiceId = new Map<
    string,
    MembershipCancellationCoveredMember[]
  >(uniqueInvoiceIds.map((invoiceId) => [invoiceId, []]));
  if (uniqueInvoiceIds.length === 0) return coveredByInvoiceId;

  const [subscriptions, coverage] = await Promise.all([
    prisma.memberSubscription.findMany({
      where: { xeroInvoiceId: { in: uniqueInvoiceIds } },
      select: { memberId: true, xeroInvoiceId: true },
    }),
    // The active coverage claim is the other half of the same fact. A charge
    // owns exactly one Xero invoice (`MembershipSubscriptionCharge.xeroInvoiceId`
    // is unique), so this cannot pull in a member billed on a different invoice.
    //
    // The member is resolved through `subscription.memberId`, a real foreign key,
    // and NOT through the row's own denormalised `memberId`: that column is on
    // the deliberate FK-less snapshot list in `member-merge.ts`, so a merge never
    // re-points it and then deletes the loser `Member` it names. Reading it would
    // silently drop a merged member out of the covered set — and for a member
    // held ONLY by a coverage claim (the PAID-at-invoice-time shape above) that
    // collapses the covered set to nothing and lets a sibling's cancellation
    // credit the invoice in full while a covered member remains (#2400 review, F6).
    prisma.membershipSubscriptionChargeCoverage.findMany({
      where: {
        releasedAt: null,
        charge: { xeroInvoiceId: { in: uniqueInvoiceIds } },
      },
      select: {
        charge: { select: { xeroInvoiceId: true } },
        subscription: { select: { memberId: true } },
      },
    }),
  ]);

  const memberIdsByInvoiceId = new Map<string, Set<string>>(
    uniqueInvoiceIds.map((invoiceId) => [invoiceId, new Set<string>()]),
  );
  for (const subscription of subscriptions) {
    if (!subscription.xeroInvoiceId) continue;
    memberIdsByInvoiceId
      .get(subscription.xeroInvoiceId)
      ?.add(subscription.memberId);
  }
  for (const row of coverage) {
    const invoiceId = row.charge.xeroInvoiceId;
    if (!invoiceId) continue;
    memberIdsByInvoiceId.get(invoiceId)?.add(row.subscription.memberId);
  }

  const memberIds = [
    ...new Set([...memberIdsByInvoiceId.values()].flatMap((set) => [...set])),
  ];
  if (memberIds.length === 0) return coveredByInvoiceId;

  const members = await prisma.member.findMany({
    where: { id: { in: memberIds } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      cancelledAt: true,
      active: true,
      xeroContactId: true,
    },
  });
  const liveMemberById = new Map<string, MembershipCancellationCoveredMember>();
  for (const member of members) {
    // Cancelled members do not keep an invoice alive — see the module note.
    if (member.cancelledAt) continue;
    liveMemberById.set(member.id, {
      memberId: member.id,
      name: memberName(member),
      active: member.active,
      xeroContactId: member.xeroContactId,
    });
  }

  for (const [invoiceId, ids] of memberIdsByInvoiceId) {
    const live = [...ids]
      .map((memberId) => liveMemberById.get(memberId))
      .filter(
        (member): member is MembershipCancellationCoveredMember =>
          member !== undefined,
      )
      .sort(compareCoveredMembers);
    coveredByInvoiceId.set(invoiceId, live);
  }

  return coveredByInvoiceId;
}

/**
 * Everyone OTHER than the leaving member that this subscription invoice still
 * covers and whose membership has not been cancelled. Empty means the leaver is
 * the last one out and the invoice can be credited in full.
 */
export async function findOtherLiveMembersCoveredBySubscriptionInvoice(params: {
  invoiceId: string;
  leavingMemberId: string;
}): Promise<MembershipCancellationCoveredMember[]> {
  const covered = await loadLiveMembersCoveredBySubscriptionInvoices([
    params.invoiceId,
  ]);
  return (covered.get(params.invoiceId) ?? []).filter(
    (member) => member.memberId !== params.leavingMemberId,
  );
}

/**
 * The Xero invoice a subscription's ACTIVE coverage claim says it is billed on.
 *
 * The one record that survives when `MemberSubscription.xeroInvoiceId` was never
 * written — a member already PAID when the family's invoice was raised. Used by
 * the credit-note path to name the invoice it is walking away from, so a
 * whole-family cancellation that credits nothing is still reported against a
 * findable invoice rather than as a bare "nothing to do" (#2400 review, F3).
 */
export async function findSubscriptionInvoiceIdFromCoverage(
  subscriptionId: string,
): Promise<string | null> {
  const coverage = await prisma.membershipSubscriptionChargeCoverage.findFirst({
    where: { subscriptionId, releasedAt: null },
    select: { charge: { select: { xeroInvoiceId: true } } },
  });
  return coverage?.charge.xeroInvoiceId ?? null;
}

/**
 * Per member: the current-season subscription invoice their cancellation is
 * about to act on, and whether it will actually be credited.
 *
 * `null` for a member with nothing to credit — no current-season subscription,
 * one already PAID or never invoiced, or no linked Xero invoice. Every member
 * asked about gets an entry, so "no key" is never mistaken for "nothing to do".
 */
export async function loadMembershipCancellationSubscriptionCreditPlansByMemberId(
  memberIds: readonly string[],
  options: { nowMs?: number } = {},
): Promise<Map<string, MembershipCancellationSubscriptionCreditPlan | null>> {
  const uniqueMemberIds = [...new Set(memberIds)].filter(Boolean);
  const plansByMemberId = new Map<
    string,
    MembershipCancellationSubscriptionCreditPlan | null
  >(uniqueMemberIds.map((memberId) => [memberId, null]));
  if (uniqueMemberIds.length === 0) return plansByMemberId;

  // The season is read from NOW, which is the same moment the credit note's own
  // gate reads it. A member has at most one subscription per season
  // (`@@unique([memberId, seasonYear])`), so this yields at most one plan each.
  const seasonYear = clubSeasonYear(
    await readClubTimeZoneOutsideRequest(),
    fixedClubClock(new Date(options.nowMs ?? Date.now())),
  );
  const subscriptions = await prisma.memberSubscription.findMany({
    where: {
      memberId: { in: uniqueMemberIds },
      seasonYear,
      status: {
        in: [...MEMBERSHIP_CANCELLATION_CREDITABLE_SUBSCRIPTION_STATUSES],
      },
      NOT: { xeroInvoiceId: null },
    },
    select: {
      id: true,
      memberId: true,
      xeroInvoiceId: true,
      xeroInvoiceNumber: true,
      member: { select: { xeroContactId: true } },
    },
  });
  if (subscriptions.length === 0) return plansByMemberId;

  const [coveredByInvoiceId, settledCreditSubscriptionIds] = await Promise.all([
    loadLiveMembersCoveredBySubscriptionInvoices(
      subscriptions
        .map((subscription) => subscription.xeroInvoiceId)
        .filter((invoiceId): invoiceId is string => Boolean(invoiceId)),
    ),
    loadSettledCancellationCreditSubscriptionIds(
      subscriptions.map((subscription) => subscription.id),
    ),
  ]);

  for (const subscription of subscriptions) {
    const invoiceId = subscription.xeroInvoiceId;
    if (!invoiceId) continue;
    const sharedWith = (coveredByInvoiceId.get(invoiceId) ?? []).filter(
      (member) => member.memberId !== subscription.memberId,
    );
    const creditsInFull = sharedWith.length === 0;
    const creditOperationSettled = settledCreditSubscriptionIds.has(
      subscription.id,
    );
    plansByMemberId.set(subscription.memberId, {
      memberId: subscription.memberId,
      subscriptionId: subscription.id,
      invoiceId,
      invoiceNumber: subscription.xeroInvoiceNumber,
      xeroUrl: buildXeroInvoiceUrl(invoiceId),
      memberXeroContactId: subscription.member.xeroContactId,
      sharedWith,
      creditsInFull,
      creditOperationSettled,
      excusesUnpaidInvoiceBlocker: creditsInFull && !creditOperationSettled,
    });
  }

  return plansByMemberId;
}

/**
 * Subscriptions whose membership-cancellation credit note has already had its
 * single outbox run, whatever the outcome.
 *
 * Filtered on the denormalised, indexed `queueType` column (immutable after
 * enqueue) plus the operation's own `localModel`/`localId`, which
 * `enqueueXeroMembershipCancellationCreditNoteOperation` always sets to
 * `MemberSubscription`/the subscription id.
 */
async function loadSettledCancellationCreditSubscriptionIds(
  subscriptionIds: readonly string[],
): Promise<Set<string>> {
  const unique = [...new Set(subscriptionIds)].filter(Boolean);
  if (unique.length === 0) return new Set();

  const operations = await prisma.xeroSyncOperation.findMany({
    where: {
      direction: "OUTBOUND",
      queueType: XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE,
      localModel: "MemberSubscription",
      localId: { in: unique },
      status: { in: [...SETTLED_CREDIT_OPERATION_STATUSES] },
    },
    select: { localId: true },
  });

  return new Set(
    operations
      .map((operation) => operation.localId)
      .filter((localId): localId is string => Boolean(localId)),
  );
}

/**
 * The review queue's per-participant shared-invoice notice: present only where
 * the cancellation would credit an invoice that other, staying members are also
 * covered by — which is exactly the case where it now credits nothing.
 *
 * Pure. It takes the credit plans and the member's blockers, both of which the
 * caller has already loaded, so the review queue reads the plan map ONCE for the
 * page (#2400 review, F8) and the notice can tell the truth about whether the
 * approval will actually go through (#2400 review, F2): the invoice is raised to
 * the charge RECIPIENT's Xero contact, and when that is the leaver the same
 * invoice is a live balance on a contact the approval would archive, so the
 * approval is REFUSED rather than merely uncredited.
 *
 * Every member asked about gets an entry, `null` meaning "nothing to say".
 */
export function buildMembershipCancellationSharedInvoiceNotices(
  plansByMemberId: ReadonlyMap<
    string,
    MembershipCancellationSubscriptionCreditPlan | null
  >,
  blockersByMemberId: ReadonlyMap<
    string,
    readonly MembershipCancellationBlocker[]
  >,
): Map<string, MembershipCancellationSharedInvoiceNotice | null> {
  return new Map(
    [...plansByMemberId].map(([memberId, plan]) => [
      memberId,
      plan && !plan.creditsInFull
        ? buildSharedInvoiceNotice(plan, blockersByMemberId.get(memberId) ?? [])
        : null,
    ]),
  );
}

/**
 * One participant's notice. Exported for the approval refusal, which builds the
 * same notice for the same member from the same two inputs so the 409 an API
 * caller receives says exactly what the panel says (#2400 review, F5).
 */
export function buildSharedInvoiceNotice(
  plan: MembershipCancellationSubscriptionCreditPlan,
  blockers: readonly MembershipCancellationBlocker[],
): MembershipCancellationSharedInvoiceNotice {
  const blocksApproval = blockers.some(
    (blocker) =>
      isUnpaidInvoiceBlocker(blocker) && blocker.invoiceId === plan.invoiceId,
  );

  return {
    invoiceId: plan.invoiceId,
    invoiceNumber: plan.invoiceNumber,
    xeroUrl: plan.xeroUrl,
    sharedWith: plan.sharedWith.map((member) => ({
      memberId: member.memberId,
      name: member.name,
    })),
    blocksApproval,
    route: resolveSharedInvoiceRoute(plan, blocksApproval),
  };
}

/**
 * What the reviewer can actually do — which is not always "approve the others
 * first" (#2400 review, F4).
 */
function resolveSharedInvoiceRoute(
  plan: MembershipCancellationSubscriptionCreditPlan,
  blocksApproval: boolean,
): MembershipCancellationSharedInvoiceRoute {
  const cancellable = plan.sharedWith.filter((member) => member.active);
  // A deactivated membership cannot be approved for cancellation at all, so
  // there is no "them" to approve first: they hold this invoice open by design.
  if (cancellable.length === 0) return "remaining_not_cancellable";

  // Where the refusal is about THIS member's own Xero contact and every covered
  // member who could be cancelled sits on that same contact — email-inheriting
  // children resolve to their parent's — each of them meets the identical
  // refusal over the identical invoice. There is no first move.
  if (
    blocksApproval &&
    plan.memberXeroContactId &&
    cancellable.every(
      (member) => member.xeroContactId === plan.memberXeroContactId,
    )
  ) {
    return "shared_xero_contact";
  }

  return "cancel_others_first";
}
