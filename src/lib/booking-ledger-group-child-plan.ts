/**
 * THE GROUP LINES HISTORY OWES ONE GROUP-SETTLED CHILD, PLANNED IN MEMORY
 * (#3854 scope 3 and its delta review's F1; design `docs/design/booking-ledger.md`
 * §5.2, §6; owner decision 2A on #3583).
 *
 * ONE planner, two readers (`INV-SSOT`):
 *
 *  - the back-post (`booking-ledger-back-post-group.ts`) reads the settlement,
 *    its children and the child's refund evidence under its locks, plans here,
 *    and posts what this returns;
 *  - the census (`booking-ledger-projection-census.ts`) plans the same lines
 *    from its one snapshot, without writing them, to decide whether a child
 *    with no lines is `GROUP_SETTLEMENT_OFF_LEDGER` — money the back-post WILL
 *    post and the census will then agree on — or a coverage gap that holds the
 *    gate (F1: a child the back-post would refuse is never waved through).
 *
 * Pure: it reads nothing. Every line comes from the live posters' planners and
 * keys (`booking-ledger-group-settlement-posting.ts`):
 *
 *   share   `planGroupSettlementShareLines` over every child the settlement paid
 *           (its captured payment, of the settlement's source), each at its
 *           payment's `amountCents`. Sum or nothing: payments that do not add
 *           up to what the settlement collected post nothing, and the child is
 *           refused (`GROUP_SHARES_DO_NOT_RECONCILE`), never guessed.
 *   refund  `planGroupSettlementRefundLine` for a mirror plan's frozen share,
 *           only once the mirror is written (`refundedAmountCents > 0`, the
 *           replay's own test); an unmirrored plan is the replay's to post.
 *   kept    an organiser cancel froze no CANCELLED snapshot (nor any kept or
 *           hand-back figure on its event), so the kept figure is the live
 *           cancel's own (`groupSettledChildKeptFrom`), re-derived from the
 *           payment as it stands: its refunds (a written mirror among them)
 *           and its open EDIT refund hand-backs (#3827, `INV-PAY-117`)
 *           together are what the cancel's refunds and the hand-backs it netted
 *           out came to, since an edit hand-back open at the cancel can since
 *           only have been paid (moving `refundedAmountCents` by what it
 *           closed) — never dismissed (`INV-PAY-117`'s refusal). A refund
 *           REQUEST's hand-back is not the cancel's: an appeal exists only on a
 *           cancelled booking (D-3813-7), so the live cancel never netted one.
 *           Open, it is the appeal's money in flight; paid, it posts its own
 *           refund and is taken back out of `refundedAmountCents` here;
 *           dismissed, nothing moved. Either way the kept figure stays what
 *           the cancel kept (#3854 sync lens F1).
 */
import type { BookingStatus, ManualRefundTaskStatus, PaymentSource } from "@prisma/client";

import type { BackPostRefusal } from "@/lib/booking-ledger-back-post-report";
import {
  planGroupSettlementRefundLine,
  planGroupSettlementShareLines,
  type GroupSettlementChildShare,
} from "@/lib/booking-ledger-group-settlement-posting";
import type { BookingLedgerPosting } from "@/lib/booking-ledger-write";
import { isCapturedPaymentStatus } from "@/lib/booking-payment-state";
import { cancellationKeptCents } from "@/lib/cancellation-kept";
import {
  deserializeRefundPlan,
  isMirrorRefundPlan,
  mirrorPlanRefundedCents,
  type OrganiserChildRefundEvidence,
} from "@/lib/group-settlement-refund-plan";
import { isEditRefundHandBackTask, isRefundRequestHandBackTask } from "@/lib/manual-refund-task-settlement-rules";
import { isOrganiserChildRefundKey } from "@/lib/payment-recovery-keys";
import { isRecordedRefundStatus } from "@/lib/payment-transaction-status";

export type GroupChildSettlement = {
  id: string;
  source: PaymentSource;
  /** What the settlement collected: the shares must add up to it. */
  amountCents: number;
  stripePaymentIntentId: string | null;
  refundPlan: unknown;
};

/** One child of the organiser's booking that the organiser settled, as the settle flipped it. */
export type GroupChildSibling = {
  id: string;
  lodgeId: string;
  payment: { amountCents: number; status: string; source: PaymentSource } | null;
};

type ChildPayment = { status: string; source: PaymentSource; amountCents: number; refundedAmountCents: number };

/** Did the settlement pay this child — its captured payment, of the settlement's own source? */
function isPaidBySettlement(
  payment: Pick<ChildPayment, "status" | "source"> | null,
  settlement: Pick<GroupChildSettlement, "source">,
): payment is NonNullable<typeof payment> {
  return payment !== null && isCapturedPaymentStatus(payment.status) && payment.source === settlement.source;
}

/** How the organiser cancel refunded the child: the frozen `{childId: cents}` mirror plan, or #3653's per-child debts. */
function groupCancelRefundPlanKind(settlement: Pick<GroupChildSettlement, "refundPlan" | "stripePaymentIntentId">): "mirror" | "per-child" {
  return isMirrorRefundPlan(settlement) || !settlement.stripePaymentIntentId ? "mirror" : "per-child";
}

export type GroupSettledChildKeptPlan =
  | { kind: "mirror"; plannedRefundCents: number }
  | { kind: "per-child"; committedRefundCents: number };

/**
 * What the organiser's cancellation keeps of a child the settlement paid: what
 * it paid for the child less every refund made or still owed on it, so
 * `owed(b)` is zero once they post. `payment` as it stood when the organiser
 * cancelled it. The live cancel and the back-post share it.
 *
 * "Still owed" includes the payment's open edit and refund-request hand-backs
 * (#3827, `INV-PAY-117`): the cancel's refund was sized net of them
 * (`cancelRefundableBaseCents`), so the club does not keep them either — each
 * posts its own bank refund when the treasurer pays it, as on any booking
 * (`paidCancellationMoney`'s `paidAmountCents` nets them out the same way).
 */
export function groupSettledChildKeptFrom(
  payment: { amountCents: number; refundedAmountCents: number; openNonCancellationHandBackCents: number },
  plan: GroupSettledChildKeptPlan,
): number {
  const committedRefundCents =
    plan.kind === "per-child" ? plan.committedRefundCents : mirrorPlanRefundedCents(payment, plan.plannedRefundCents);
  // No credit applied and none restored: the organiser paid in money, so the
  // kept figure is what it retained (never below zero).
  return cancellationKeptCents({
    retainedAmountCents: Math.max(0, payment.amountCents - committedRefundCents - payment.openNonCancellationHandBackCents),
    appliedCreditCents: 0,
    creditRestoredCents: 0,
  });
}

/**
 * The child payment's hand-backs as the group history planner reads them
 * (#3827, `INV-PAY-117`; #3854 sync lens F1), from the rows already in hand
 * (the census's snapshot, which the back-post plans from too):
 *
 *  - `openEditRefundHandBackCents`: its OPEN edit refund hand-backs
 *    (`isEditRefundHandBackTask`) — the only hand-backs a live organiser
 *    cancel nets out, since no appeal exists before the child is cancelled.
 *  - `completedRefundRequestHandBackCents`: its COMPLETED refund-request
 *    hand-backs (`isRefundRequestHandBackTask`) — an appeal paid after the
 *    cancel, whose completion moved `refundedAmountCents` by its amount (a
 *    completed task's amount is what it settled; non-review kinds cannot be
 *    repriced), so the planner takes it back out to read the refunds as the
 *    cancel left them.
 *
 * An open or dismissed refund-request hand-back counts for neither: it moved
 * nothing, and the cancel never counted it.
 */
export type GroupChildHandBacks = { openEditRefundHandBackCents: number; completedRefundRequestHandBackCents: number };

const OPEN: ManualRefundTaskStatus = "OPEN";
const COMPLETED: ManualRefundTaskStatus = "COMPLETED";

export function groupChildHandBacksFromRows(
  paymentId: string,
  tasks: ReadonlyArray<{ kind: string | null; status: string; occurrenceKey: string | null; paymentId: string | null; amountCents: number | null }>,
): GroupChildHandBacks {
  const sum = (matches: (task: (typeof tasks)[number]) => boolean) =>
    tasks.filter((task) => task.paymentId === paymentId && matches(task)).reduce((total, task) => total + (task.amountCents ?? 0), 0);
  return {
    openEditRefundHandBackCents: sum((task) => task.status === OPEN && isEditRefundHandBackTask(task)),
    completedRefundRequestHandBackCents: sum((task) => task.status === COMPLETED && isRefundRequestHandBackTask(task)),
  };
}

/**
 * `organiserChildCommittedRefundCents`'s evidence, read from rows already in
 * hand (the census's snapshot): the child payment's recorded refunds, and its
 * `organiser_child_refund_` debts on the settlement's intent not yet SUCCEEDED
 * — the same filter `organiser-child-refund.ts` (`committedCents`) puts in its
 * query. Exhausted debts count: the money is still owed.
 */
export function organiserChildRefundEvidenceFromRows(input: {
  paymentId: string;
  paymentIntentId: string;
  refunds: ReadonlyArray<{ status: string; amountCents: number }>;
  operations: ReadonlyArray<{ status: string; amountCents: number; idempotencyKey: string; paymentId: string; paymentIntentId: string }>;
}): OrganiserChildRefundEvidence {
  return {
    recordedRefundCents: input.refunds.filter((refund) => isRecordedRefundStatus(refund.status)).reduce((sum, refund) => sum + refund.amountCents, 0),
    childOwedCents: input.operations
      .filter(
        (operation) =>
          operation.paymentIntentId === input.paymentIntentId &&
          operation.paymentId === input.paymentId &&
          isOrganiserChildRefundKey(operation.idempotencyKey) &&
          operation.status !== "SUCCEEDED",
      )
      .reduce((sum, operation) => sum + operation.amountCents, 0),
  };
}

export type GroupChildPlan =
  | {
      kind: "plan";
      /** The share and any plan refund, posted after the child's confirmation. */
      postings: BookingLedgerPosting[];
      steps: string[];
      /** The organiser cancel's kept figure; null where the generic CANCELLED-snapshot reading applies. */
      cancellationKeptCents: number | null;
    }
  | { kind: "refuse"; reason: BackPostRefusal; detail: string };

/**
 * The group lines history owes one child, or null where no group settlement
 * paid it (the back-post then treats it as any other booking).
 * `perChildCommittedRefundCents` is `organiserChildCommittedRefundCents` for the
 * child's payment, needed only for a child cancelled without a snapshot under a
 * per-child plan (`needsPerChildCommittedRefund`).
 */
export function planGroupChildLines(input: {
  child: { id: string; lodgeId: string; status: BookingStatus; cancelledWithoutSnapshot: boolean };
  payment: ChildPayment | null;
  settlement: GroupChildSettlement;
  /** Every child of the organiser's booking that the organiser settled, this one included. */
  siblings: readonly GroupChildSibling[];
  perChildCommittedRefundCents: number | null;
  /** The child payment's hand-backs now, as the kept figure reads them (`groupChildHandBacksFromRows`). */
  handBacks: GroupChildHandBacks;
}): GroupChildPlan | null {
  const { child, payment, settlement } = input;
  if (!isPaidBySettlement(payment, settlement)) return null;
  const paid: GroupSettlementChildShare[] = input.siblings.flatMap((sibling) =>
      isPaidBySettlement(sibling.payment, settlement)
      ? [{ bookingId: sibling.id, lodgeId: sibling.lodgeId, shareCents: sibling.payment.amountCents }]
      : [],
  );
  const shares = planGroupSettlementShareLines({ settlement, children: paid });
  if (!shares.reconciles) {
    return {
      kind: "refuse",
      reason: "GROUP_SHARES_DO_NOT_RECONCILE",
      detail: `settlement ${settlement.id} collected ${settlement.amountCents}; the ${paid.length} child payment(s) it paid come to ${shares.totalShareCents}`,
    };
  }
  const postings = shares.postings.filter((posting) => posting.bookingId === child.id);
  const steps = postings.map((posting) => `group share (${posting.unitCents})`);

  const planKind = groupCancelRefundPlanKind(settlement);
  const mirror = isMirrorRefundPlan(settlement);
  const plannedRefundCents = mirror ? (deserializeRefundPlan(settlement.refundPlan).get(child.id) ?? 0) : 0;
  const mirrored = payment.refundedAmountCents > 0;
  if (mirror && mirrored) {
    const refund = planGroupSettlementRefundLine({ settlement, bookingId: child.id, lodgeId: child.lodgeId, refundCents: plannedRefundCents });
    if (refund) {
      postings.push(refund);
      steps.push(`group plan refund (${refund.unitCents})`);
    }
  }

  let cancellationKeptCents: number | null = null;
  if (child.status === "CANCELLED" && child.cancelledWithoutSnapshot) {
    // The payment as the cancel left it: a written mirror is already in its
    // refunds, so the plan's share is added only while unwritten; an edit
    // hand-back open at the cancel is either still open or, paid since, in
    // `refundedAmountCents`. An appeal paid since is in `refundedAmountCents`
    // too, but is not the cancel's, so it comes back out (F1, see the header).
    const refundedAtCancelCents = Math.max(0, payment.refundedAmountCents - input.handBacks.completedRefundRequestHandBackCents);
    const now = {
      amountCents: payment.amountCents,
      refundedAmountCents: refundedAtCancelCents,
      openNonCancellationHandBackCents: input.handBacks.openEditRefundHandBackCents,
    };
    if (planKind === "per-child" && input.perChildCommittedRefundCents === null) {
      throw new Error(`planGroupChildLines: child ${child.id} needs its committed per-child refund (#3854)`);
    }
    cancellationKeptCents = groupSettledChildKeptFrom(
      now,
      planKind === "mirror"
        ? { kind: "mirror", plannedRefundCents: mirror && refundedAtCancelCents > 0 ? 0 : plannedRefundCents }
        : { kind: "per-child", committedRefundCents: input.perChildCommittedRefundCents! },
    );
  }
  return { kind: "plan", postings, steps, cancellationKeptCents };
}

/** Whether `planGroupChildLines` needs the child's committed per-child refund: a snapshot-less cancel under #3653's plan. */
export function needsPerChildCommittedRefund(
  child: { status: BookingStatus; cancelledWithoutSnapshot: boolean },
  settlement: Pick<GroupChildSettlement, "refundPlan" | "stripePaymentIntentId">,
): boolean {
  return child.status === "CANCELLED" && child.cancelledWithoutSnapshot && groupCancelRefundPlanKind(settlement) === "per-child";
}
