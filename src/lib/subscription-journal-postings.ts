import type { Prisma } from "@prisma/client";
import {
  postJoiningFeeCharge,
  postSubscriptionCharge,
  resolveSubscriptionMoneyPostingContext,
  reverseSubscriptionChargeForCredit,
  type BookingJournalContext,
  type SubscriptionCreditOutcome,
} from "@/lib/member-money/doors";
import { findOtherLiveMembersCoveredBySubscriptionInvoice } from "@/lib/membership-cancellation-subscription-credit";
import { prisma } from "@/lib/prisma";

/*
 * #4519 (Ledger M7): the journal postings of the subscription billing confirm
 * (R18), the joining-fee enqueue (R19) and the cancellation credit note (R20),
 * kept beside each other and out of those already-oversized writers. Each
 * resolves its posting context before any transaction it posts in opens
 * (INV-LOCK-004).
 */

/** The charge columns R18 reads, selected by the confirm's charge upsert. */
export const SUBSCRIPTION_CHARGE_JOURNAL_SELECT = {
  id: true, billingBasis: true, chargedAmountCents: true, recipientMemberId: true,
  components: { select: { id: true, label: true, chargedAmountCents: true } },
} as const satisfies Prisma.MembershipSubscriptionChargeSelect;

/**
 * The confirm's journal context, and whether its transaction takes lock(1). A
 * re-bill after a void may reverse the voided charge's R18, a revenue reversal
 * the store refuses without lock(1). Only then is it taken, read here before the
 * transaction so a whole-club run never holds it; a void landing after this read
 * makes the store refuse and the confirm roll back, and the officer's retry sees
 * it and locks (INV-LOCK-001).
 */
export async function prepareSubscriptionBillingJournal(seasonYear: number, coveredMemberIds: readonly string[]) {
  const journalContext = await resolveSubscriptionMoneyPostingContext();
  const rebillsAVoid = coveredMemberIds.length > 0 && Boolean(await prisma.memberSubscription.findFirst({
    where: { seasonYear, voidGeneration: { gt: 0 }, memberId: { in: [...coveredMemberIds] } },
    select: { id: true },
  }));
  return { journalContext, rebillsAVoid };
}

/**
 * R18 for a charge the confirm has just created; a charge row found by its key
 * is a replay or a pre-M7 charge (M9's history), and posts nothing here.
 */
export async function postConfirmedSubscriptionCharge(tx: Prisma.TransactionClient, journalContext: BookingJournalContext, input: {
  charge: Prisma.MembershipSubscriptionChargeGetPayload<{ select: typeof SUBSCRIPTION_CHARGE_JOURNAL_SELECT }>;
  subscriptions: readonly { id: string; voidGeneration: number | null }[];
  actorMemberId: string | null;
}): Promise<void> {
  await postSubscriptionCharge(tx, journalContext, {
    facts: { chargeId: input.charge.id, ...input.charge },
    replacesChargeIds: await chargesReplacedByRebill(tx, input.charge.id, input.subscriptions),
    actorMemberId: input.actorMemberId,
  });
}

/**
 * #4519 (owner, 10 Nov 2026): the charges a post-void re-bill replaces. Each
 * covered subscription that was voided before contributes the charge its latest
 * released coverage names; the door decides whether that charge's journal debt
 * is reversed or, already collected, makes the new charge a ZERO.
 */
async function chargesReplacedByRebill(
  tx: Prisma.TransactionClient,
  chargeId: string,
  subscriptions: readonly { id: string; voidGeneration: number | null }[],
): Promise<string[]> {
  const replaced: string[] = [];
  for (const subscription of subscriptions) {
    if ((subscription.voidGeneration ?? 0) === 0) continue;
    const released = await tx.membershipSubscriptionChargeCoverage.findFirst({
      where: { subscriptionId: subscription.id, releasedAt: { not: null }, chargeId: { not: chargeId } },
      orderBy: [{ releasedAt: "desc" }, { createdAt: "desc" }],
      select: { chargeId: true },
    });
    if (released) replaced.push(released.chargeId);
  }
  return replaced;
}

/**
 * R19's poster for `enqueueXeroEntranceFeeInvoiceOperation`. A caller's `store`
 * needs a context resolved before that transaction; without one the enqueue
 * resolves it here. The charge posts in the caller's transaction, or else in a
 * short one of its own after the outbox insert: that insert stays on the global
 * client, whose lost-race recovery a transaction would abort (#1354, #4338). The
 * key makes a repeat post nothing, and posting beside an already-queued row too
 * heals a crash between the two.
 */
export async function joiningFeeJournalPoster(memberId: string, options?: {
  store?: Prisma.TransactionClient;
  journalContext?: BookingJournalContext;
  createdByMemberId?: string;
}): Promise<(fee: { feeAmountCents: number; exempt: boolean }) => Promise<unknown>> {
  if (options?.store && !options.journalContext) {
    throw new Error("enqueueXeroEntranceFeeInvoiceOperation needs a journal context resolved before the caller's transaction when it is given one (#4519).");
  }
  const journalContext = options?.journalContext ?? await resolveSubscriptionMoneyPostingContext();
  return (fee) => {
    const post = (tx: Prisma.TransactionClient) => postJoiningFeeCharge(tx, journalContext, {
      memberId, ...fee, actorMemberId: options?.createdByMemberId ?? null,
    });
    return options?.store ? post(options.store) : prisma.$transaction(post);
  };
}

/**
 * R20 (#4519, Ledger M7): a credit note for the whole of an unpaid charge
 * reverses that charge's journal debt. A short transaction of its own, after
 * the Xero call, takes `lock(1)` first (a revenue reversal) and re-reads under
 * it whether the leaver is still the last live member the invoice covers. The
 * outcome, with both figures, goes on the operation's response payload.
 */
export async function postCancellationCreditToJournal(input: {
  invoiceId: string;
  leavingMemberId: string;
  creditNoteId: string;
  creditedCents: number;
  actorMemberId?: string;
}): Promise<SubscriptionCreditOutcome> {
  const charge = await prisma.membershipSubscriptionCharge.findUnique({ where: { xeroInvoiceId: input.invoiceId }, select: { id: true } });
  if (!charge) return { outcome: "nothing-to-reverse", creditedCents: input.creditedCents, chargedCents: null };
  const journalContext = await resolveSubscriptionMoneyPostingContext();
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const stillCovered = await findOtherLiveMembersCoveredBySubscriptionInvoice({
      invoiceId: input.invoiceId, leavingMemberId: input.leavingMemberId, db: tx,
    });
    return reverseSubscriptionChargeForCredit(tx, journalContext, {
      chargeId: charge.id, creditNoteId: input.creditNoteId, creditedCents: input.creditedCents,
      leaverIsLastLiveMember: stillCovered.length === 0, actorMemberId: input.actorMemberId ?? null,
    });
  });
}
