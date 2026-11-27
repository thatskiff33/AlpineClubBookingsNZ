import type { ManualRefundTaskKind } from "@prisma/client";
import { isBankRefundVoidFollowUpTask } from "@/lib/bank-refund-void-follow-up-key";
import { isGroupOrganiserHandBackTask } from "@/lib/group-organiser-hand-back-rules";
import { isLateCaptureHandBackTask } from "@/lib/late-capture-hand-back-task";
import { editRefundHandBackOccurrenceKey, isCardRefundPaidAnotherWayTask, isPartPaymentReviewTask } from "@/lib/manual-refund-task-settlement-rules";

/**
 * #4516 (Ledger M4d): WHICH MANUAL REFUND TASKS THE MEMBER-MONEY JOURNAL RECORDS AS A HAND-BACK DEBT. A plain module
 * (no Prisma client, no journal door), so the doors' rules (`manual-refund-task-hand-back-journal.ts`) and the
 * read-only hand-back census (`member-money/internal/hand-back-census.ts`), which plain-Node operator commands
 * import, ask the one rule (`INV-SSOT`).
 */

/** What the rule reads of a task. */
export type HandBackFacts = {
  kind: ManualRefundTaskKind | string | null;
  occurrenceKey: string | null;
  partPaymentReviewPaymentId: string | null;
  reason: string | null;
};

/**
 * An edit hand-back raised for organiser-extra raced cash. It wears an edit hand-back's key, but the cash is an
 * organiser share (M6), so it is not a member-money hand-back debt. The prefix is the key
 * `organiser-extra-raced-cash.ts` builds.
 */
const ORGANISER_EXTRA_HAND_BACK_PREFIX = editRefundHandBackOccurrenceKey("organiser-extra-");
export function isOrganiserExtraRacedHandBackTask(task: Pick<HandBackFacts, "kind" | "occurrenceKey">): boolean {
  return task.kind === "CANCELLED_BOOKING_HAND_BACK" && (task.occurrenceKey?.startsWith(ORGANISER_EXTRA_HAND_BACK_PREFIX) ?? false);
}

/**
 * A hand-back the member-money journal records as a refund debt (R05, scope `hand-back`). Exactly the tasks a
 * raise posts: a cancellation's cash hand-back, a card shortfall's bank part or part to check, an edit hand-back,
 * a refund request's bank part, and an organisation's late cash. Not a part-payment review, a
 * group organiser's hand-back, a paid-another-way close, a bank-refund void follow-up, organiser-extra raced cash,
 * or a late capture's own question (including a legacy row whose only mark is its reason). A legacy row with no
 * kind and any other reason is a cancellation's hand-back.
 */
export function isJournalHandBackTask(task: HandBackFacts): boolean {
  if (task.kind !== "CANCELLED_BOOKING_HAND_BACK" && task.kind !== null) return false;
  if (isPartPaymentReviewTask(task)) return false;
  if (isGroupOrganiserHandBackTask(task)) return false;
  if (isCardRefundPaidAnotherWayTask(task)) return false;
  if (isBankRefundVoidFollowUpTask(task)) return false;
  if (isOrganiserExtraRacedHandBackTask(task)) return false;
  if (isLateCaptureHandBackTask({ kind: task.kind, reason: task.reason ?? "" })) return false;
  return true;
}
