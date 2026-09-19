/**
 * THE INPUT A MANUAL REFUND TASK CLOSES ON, and why each field is stated.
 *
 * Lifted out of `manual-refund-task-resolution.ts` on #3529, the same seam
 * `edit-financial-review-charge-refusals.ts` was cut on in #3181: the shape is
 * a contract the route and the tests read, the module it came from is the
 * transaction that honours it, and the prose here is about what a caller must
 * say rather than about what the closer does. Type-only, so a surface can
 * import the shape without dragging the closer's Prisma and Stripe imports in.
 */
import type { ManualRefundTaskDirection } from "@prisma/client";
import type { RecordedStrandNightPrices } from "@/lib/stored-night-price-repair";

/**
 * What a completion claims about the amount, and it must be stated.
 *
 * #2797 owner decision D2 chose *"amend at completion, audited"* over a separate
 * `confirmedAmountCents` column, so the confirmed figure arrives HERE rather than
 * through some earlier pricing step, and a separate pre-completion AMEND was
 * deliberately not built. Not because a priced-but-still-OPEN task is undefined
 * — it is defined, in `INV-PAY-051`, and the raise can create one when the edit
 * could prove a figure — but because that state means "proposed, not yet
 * confirmed", and a second writer able to move the figure while the row stays
 * OPEN would turn it into something a reader could mistake for a decision. The
 * one path that changes an amount is this one, and it closes the task in the
 * same write.
 *
 * A NUMBER is the admin's confirmed POSITIVE integer cents — zero is refused, see
 * below. On a task raised with no amount (`EDIT_FINANCIAL_REVIEW`) it IS the
 * pricing. On a task that
 * already carries one it must match, EXCEPT on an `EDIT_FINANCIAL_REVIEW` task,
 * where a different figure is the audited amendment D2 permits — the row keeps
 * `raisedAmountCents` either way, so the row itself says whether the amount moved
 * and by how much. On a legacy kind a different figure is refused: those amounts
 * were computed by cancellation or capture policy and an operator closing the
 * task is not the person who gets to rewrite them, so the mismatch is treated as
 * a stale screen (409) exactly like `expectedAmountCents` on the settle path.
 *
 * NULL is an explicit claim that the task already carries its final amount, and
 * closes at it — today's behaviour, now stated rather than assumed. It 409s when
 * there is no amount to close at.
 *
 * ZERO IS REFUSED whichever way it arrives, and that is `INV-PAY-051`. COMPLETED
 * means the money genuinely went back, so a $0.00 completion records a refund
 * that did not happen — in the booking's durable, member-facing event log.
 * "Reviewed, nothing is due" is DISMISSED, which is a real decision and is what
 * this whole epic exists to make representable without a magic zero.
 *
 * It is REQUIRED rather than optional on purpose: making it optional would let
 * every existing call site keep the old behaviour silently, where requiring it
 * makes the compiler list them.
 */
export type ManualRefundTaskResolution =
  | {
      taskId: string;
      resolution: "completed";
      note: string | null;
      actingMemberId: string;
      confirmedAmountCents: number | null;
      /**
       * #3170: WHICH WAY the money goes, and it is REQUIRED on every completion
       * for the same reason `confirmedAmountCents` is - optional would let every
       * existing call site keep the old behaviour silently, where required makes
       * the compiler list them.
       *
       * Before this issue the direction was implicit in the word "refund", and
       * that implicitness was the hazard: this child is the first to park an edit
       * that can move the price UP, so an officer reading the evidence can
       * correctly conclude the club is owed - and every settlement route was
       * refund-shaped, so acting on that conclusion sent the money the wrong way.
       *
       * NULL means REFUND_TO_MEMBER and is accepted only on the legacy kinds,
       * which cannot mean anything else. An `EDIT_FINANCIAL_REVIEW` completion
       * must state it: a task whose whole nature is "nobody could work this out"
       * is exactly the task where an unstated default is a guess.
       */
      direction: ManualRefundTaskDirection | null;
      /**
       * #3191: what the officer says each of this review's UNPRICED NIGHTS sold
       * for, or null for "not recording those now" - which is an ordinary answer
       * and settles exactly as this path did before #3191. REQUIRED rather than
       * optional for the reason the two fields above are. Why it is optional
       * rather than mandatory, and why a partial answer is refused rather than
       * completed, is `stored-night-price-repair.ts` and `INV-MOD-028`. #3498:
       * ONE ARRAY PER REPAIRABLE STRAND, in the order the screen offered them.
       */
      recordedNightPrices: RecordedStrandNightPrices[] | null;
    }
  | {
      taskId: string;
      resolution: "dismissed";
      note: string | null;
      actingMemberId: string;
      confirmedAmountCents?: never;
      /**
       * #3191: a dismissal records them too, and has to be able to - a parked
       * edit whose strand kept the same nights owes nothing either way, so if
       * only a completion could fill the blanks in, exactly the bookings with
       * nothing to settle would park forever. Nothing moves, so the figures must
       * come to the strand's stored total unchanged.
       */
      recordedNightPrices: RecordedStrandNightPrices[] | null;
      /**
       * A dismissal moves no money, so there is no direction to record and none
       * may be sent. The database says the same thing
       * (`ManualRefundTask_direction_only_when_completed`).
       */
      direction?: never;
    };
