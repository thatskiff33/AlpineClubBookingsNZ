import { createAuditLog } from "@/lib/audit";
import { postSubscriptionCloseReceipt, resolveSubscriptionMoneyPostingContext } from "@/lib/member-money/doors";
import { prisma } from "@/lib/prisma";
import {
  CLOSE_ALREADY_PAID_REASON_MAX,
  everyActiveCoveredSubscriptionSettled,
  isChargeClosableAsAlreadyPaid,
  isChargeClosedAsAlreadyPaid,
  isSubscriptionSettled,
  PARTLY_PAID_CHARGE_ADVICE,
  SETTLED_SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_ALREADY_PAID_CODE,
} from "@/lib/subscription-charge-already-paid";
import { findLiveSubscriptionInvoiceOperation } from "@/lib/xero-subscription-invoices";

/**
 * #4098: an officer closes a membership subscription charge the invoice worker
 * left in `CONFLICT` / `SUBSCRIPTION_ALREADY_PAID`, because every subscription
 * it covers was paid another way (usually a manual mark-paid). Retry can never
 * clear such a charge: the worker refuses to invoice a PAID subscription.
 *
 * WHAT IT WRITES, in one transaction:
 *
 *  1. The charge, `CONFLICT` -> `NOT_REQUIRED` — the status whose lifecycle
 *     meaning is "this charge needs no invoice and no provider work". `VOIDED`
 *     is not used: it records an invoice Xero voided, and this charge never had
 *     one. Confirmation writes `NOT_REQUIRED` only for a `NO_INVOICE` charge, so
 *     `isChargeClosedAsAlreadyPaid` tells the two apart without a schema change.
 *  2. Every covered subscription must still be settled — `PAID`, or
 *     `NOT_REQUIRED` for an exempt member (owner decision on #4110, 15 Oct
 *     2026); the same guarded write bumps its `voidGeneration`.
 *  3. The charge's ACTIVE coverage claims are released (`releasedAt` set, rows
 *     kept), as the void path does (#2147), each recording the status its
 *     subscription was settled with (`subscriptionStatusAtClose`, #4110 review).
 *  4. An audit row naming the officer, the reason, the charge and the
 *     subscriptions.
 *
 * WHY THE CLAIMS ARE RELEASED. An active claim means "this member's season is
 * billed on this charge", and after the close it is not: it was paid outside
 * the charge. Releasing the claims and bumping `voidGeneration` leaves each
 * subscription exactly as a member marked paid before any billing run (PAID,
 * no invoice link, no active claim). While it stays PAID every preview skips it
 * on status alone. If the manual payment is later reversed, the member is
 * re-billable: no claim hides them from the preview, and the bumped generation
 * gives the new charge a fresh idempotency key. Keeping the claims would leave a
 * reversed member silently unbillable, and without the bump a re-bill would
 * collapse onto this closed charge's key and raise nothing. A PER_FAMILY charge
 * re-bills the same way after a reversal (owner decisions, 15 Oct 2026): the
 * preview keeps counting a closed family charge as billed — a new joiner still
 * meets FAMILY_ALREADY_BILLED — until a covered member's PAYMENT is reversed
 * (PAID at the close, no longer settled), then bills the family again (warning
 * when only some payments were reversed), and the family/type/season unique
 * index covers only live charges (#4110), so the new family charge sits beside
 * this retained row. An exempt member, NOT_REQUIRED at the close, had no
 * payment to reverse: an assignment save or membership sync that later moves
 * them to NOT_INVOICED does not re-bill the family (#4110 review F1).
 *
 * GUARDS AND RACES. No advisory lock, like the void release and the family
 * markers: every write is guarded in its own WHERE. The charge claim is a
 * status-guarded `updateMany` (`CONFLICT` + the code + no invoice), so a double
 * click or two officers close once — the loser waits on the row, then matches
 * nothing and reads the charge already closed. The subscription write matches
 * only settled rows and must touch every one; a manual reversal that committed
 * first makes it fall short and the whole transaction rolls back, and one that
 * arrives later waits on the row and then finds the member re-billable. The
 * close is refused while an invoice operation for the charge is live (queued,
 * running or awaiting payment), chiefly because during a rollout an old pod's
 * worker does not know the closed status at all. Against a new worker the
 * close is safe even without that refusal: every charge-status write the
 * invoice pipeline makes — the enqueue's, the worker's conflict, INVOICE_CREATED,
 * EMAILED and EMAIL_FAILED writes, and the outbox failure handler's — matches
 * only live charges, so none can reopen a closed one. A worker whose Xero call
 * was already in flight when the close landed loses its INVOICE_CREATED write:
 * it links nothing, downgrades nothing, sends no email, and leaves
 * STRAY_INVOICE_AFTER_CLOSE on the closed charge naming the invoice to void. A
 * Retry that loses its status write to a close reports no work. An old pod
 * during a rollout could still process an operation queued concurrently with
 * the close; that is a stated limit.
 *
 * AUDIT SUBJECT. The row names the officer (memberId) and the charge (entity),
 * and lists the covered member ids in its details, but sets no
 * subjectMemberId: that column holds ONE member, so on a family charge it would
 * put the close on one arbitrary member's timeline, and a row per member would
 * multiply one act and widen what members read (INV-PRIV) beyond the decision.
 */

export class CloseAlreadyPaidChargeError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
    this.name = "CloseAlreadyPaidChargeError";
  }
}

export type CloseAlreadyPaidChargeResult = {
  /** False when the charge was already closed (an idempotent repeat). */
  closed: boolean;
  message: string;
};

const CHANGED_WHILE_CLOSING_MESSAGE = "This charge changed while you were closing it. Refresh and try again.";
const ALREADY_CLOSED_MESSAGE = "This charge is already closed as paid.";

export async function closeAlreadyPaidSubscriptionCharge(input: {
  chargeId: string;
  reason: string;
  actorMemberId: string;
}): Promise<CloseAlreadyPaidChargeResult> {
  const reason = input.reason.trim().slice(0, CLOSE_ALREADY_PAID_REASON_MAX);
  if (!reason) {
    throw new CloseAlreadyPaidChargeError("Give a reason for closing this charge.", 400);
  }
  // #4519 (Ledger M7): the journal context, before the transaction (INV-LOCK-004).
  const journalContext = await resolveSubscriptionMoneyPostingContext();
  return prisma.$transaction(async (tx) => {
    const charge = await tx.membershipSubscriptionCharge.findUnique({
      where: { id: input.chargeId },
      select: {
        id: true,
        seasonYear: true,
        status: true,
        billingBasis: true,
        lastErrorCode: true,
        xeroInvoiceId: true,
        coverage: {
          where: { releasedAt: null },
          select: {
            subscriptionId: true,
            memberName: true,
            subscription: { select: { status: true, memberId: true } },
          },
        },
      },
    });
    if (!charge) {
      throw new CloseAlreadyPaidChargeError("Subscription charge not found.", 404);
    }
    if (isChargeClosedAsAlreadyPaid(charge)) {
      return { closed: false, message: ALREADY_CLOSED_MESSAGE };
    }
    if (!isChargeClosableAsAlreadyPaid(charge)) {
      throw new CloseAlreadyPaidChargeError(
        "Only a charge in conflict because its subscription is already paid can be closed as already paid.",
        409,
      );
    }
    if (charge.coverage.length === 0) {
      throw new CloseAlreadyPaidChargeError(
        "This charge covers no subscription, so there is nothing to close as paid.",
        409,
      );
    }
    if (!everyActiveCoveredSubscriptionSettled(charge.coverage)) {
      const unpaid = charge.coverage.filter((row) => !isSubscriptionSettled(row.subscription.status));
      throw new CloseAlreadyPaidChargeError(
        `Still unpaid: ${unpaid.map((row) => row.memberName).join(", ")}. ${PARTLY_PAID_CHARGE_ADVICE}`,
        409,
      );
    }

    // A live invoice operation may be a worker mid-Xero-call, whose writes after
    // the provider responds are not status-guarded; let it finish first.
    if (await findLiveSubscriptionInvoiceOperation(tx, charge.id)) {
      throw new CloseAlreadyPaidChargeError(
        "A Xero invoice attempt for this charge is still queued or running. Wait for it to finish (see Xero Operations), then close the charge.",
        409,
      );
    }

    // The single-winner claim. A concurrent close blocks on this row and then
    // matches nothing, because the status it needs is gone.
    const claimed = await tx.membershipSubscriptionCharge.updateMany({
      where: {
        id: charge.id,
        status: "CONFLICT",
        lastErrorCode: SUBSCRIPTION_ALREADY_PAID_CODE,
        xeroInvoiceId: null,
      },
      data: { status: "NOT_REQUIRED", lastErrorCode: null, lastErrorMessage: null },
    });
    if (claimed.count === 0) {
      const current = await tx.membershipSubscriptionCharge.findUnique({
        where: { id: charge.id },
        select: { status: true, billingBasis: true },
      });
      if (current && isChargeClosedAsAlreadyPaid(current)) {
        return { closed: false, message: ALREADY_CLOSED_MESSAGE };
      }
      throw new CloseAlreadyPaidChargeError(
        CHANGED_WHILE_CLOSING_MESSAGE,
        409,
      );
    }

    const subscriptionIds = charge.coverage.map((row) => row.subscriptionId);
    // The authoritative settled re-read: the guard is in the WHERE, so a reversal
    // that committed after the read above leaves this short and rolls back.
    const stillPaid = await tx.memberSubscription.updateMany({
      where: { id: { in: subscriptionIds }, status: { in: [...SETTLED_SUBSCRIPTION_STATUSES] } },
      data: { voidGeneration: { increment: 1 } },
    });
    if (stillPaid.count !== subscriptionIds.length) {
      throw new CloseAlreadyPaidChargeError(
        `A covered subscription stopped being paid while you were closing this charge. ${PARTLY_PAID_CHARGE_ADVICE}`,
        409,
      );
    }

    // Each claim records the status its subscription was settled with (#4110
    // review F1): only a later move away from PAID is a reversed payment that
    // re-bills a closed family, so an exempt member's NOT_REQUIRED moving to
    // NOT_INVOICED is not. The subscription rows are locked by the write above
    // until commit, so the statuses cannot move between these writes, and
    // together they release every active claim the guard above counted.
    const releasedAt = new Date();
    let releasedCount = 0;
    for (const status of SETTLED_SUBSCRIPTION_STATUSES) {
      const released = await tx.membershipSubscriptionChargeCoverage.updateMany({
        where: { chargeId: charge.id, releasedAt: null, subscription: { status } },
        data: { releasedAt, subscriptionStatusAtClose: status },
      });
      releasedCount += released.count;
    }
    if (releasedCount !== subscriptionIds.length) {
      throw new CloseAlreadyPaidChargeError(
        CHANGED_WHILE_CLOSING_MESSAGE,
        409,
      );
    }

    // R08: the money paid outside the charge, collected against its journal
    // obligation, only while that is open and nothing is collected yet.
    await postSubscriptionCloseReceipt(tx, journalContext, { chargeId: charge.id, closedAt: releasedAt, actorMemberId: input.actorMemberId });

    await createAuditLog({
      action: "membership-subscription-billing.close-already-paid",
      category: "payment",
      entityType: "MembershipSubscriptionCharge",
      entityId: charge.id,
      memberId: input.actorMemberId,
      targetId: charge.id,
      details: JSON.stringify({
        reason,
        seasonYear: charge.seasonYear,
        previousStatus: "CONFLICT",
        status: "NOT_REQUIRED",
        subscriptionIds,
        memberIds: charge.coverage.map((row) => row.subscription.memberId),
        coverageReleased: releasedCount,
      }),
    }, tx);

    return { closed: true, message: "Charge closed as already paid. No Xero invoice will be raised for it." };
  });
}
