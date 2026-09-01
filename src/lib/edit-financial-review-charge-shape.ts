import {
  ManualRefundTaskDirection,
  ManualRefundTaskKind,
  ManualRefundTaskStatus,
  PaymentSource,
  PaymentTransactionKind,
  type Prisma,
} from "@prisma/client";

import { parseEditFinancialReviewContext } from "@/lib/edit-financial-review-context";
import { buildEditFinancialReviewChargeReason } from "@/lib/payment-recovery-keys";

/**
 * #3187 (epic #2797): WHICH ROWS AN EDIT-REVIEW CHARGE IS MADE OF, and how they
 * total — as pure shapes, with no `server-only` above them.
 *
 * WHY THIS FILE EXISTS AT ALL, and it is not a stylistic split.
 * `edit-financial-review-charge-request.ts` is `server-only`: it writes audit
 * rows and holds the module Prisma client. The booking-vs-Xero repair tool asks
 * two of the same questions — *which review tasks carry a settled charge share*
 * and *which ledger row is this edit's combined request* — and that tool runs
 * from `scripts/xero-booking-repair.ts`, an operator CLI. A CLI that statically
 * reaches `server-only` THROWS the moment it starts, before it prints anything;
 * `cli-server-only-reach-census.test.ts` refuses exactly that, and it caught
 * this import on the first run. The precedent is `payment-recovery-keys.ts`,
 * split out of `payment-recovery.ts` for the same consumer and the same reason.
 *
 * The alternative — the repair tool keeping its own copy of "which rows count as
 * owed" — is the one thing this must not be. A repair tool auditing an
 * accounting leg from a second spelling of that leg's own rule is how the two
 * come to disagree, and it would disagree silently, in a report an operator
 * trusts (`INV-SSOT`).
 *
 * Deliberately NOT in `edit-financial-review-context.ts`, whose own header
 * commits to importing nothing from `node:`, Prisma, or `@/lib/prisma` so a
 * client component can hold the parser. These shapes need the Prisma enums.
 */

/**
 * WHICH REVIEW TASKS CARRY A SETTLED CHARGE SHARE.
 *
 * COMPLETED, `CHARGE_TO_MEMBER`, and carrying an amount: a share that has been
 * priced by an officer and settled as money owed to the club. Spread beside a
 * `bookingId` for one booking, or a `bookingId: { in: [...] }` for a repair
 * sweep.
 */
export const editReviewChargeShareTaskWhere = {
  kind: ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW,
  status: ManualRefundTaskStatus.COMPLETED,
  settlementDirection: ManualRefundTaskDirection.CHARGE_TO_MEMBER,
  amountCents: { not: null },
} as const satisfies Prisma.ManualRefundTaskWhereInput;

export const editReviewChargeShareTaskSelect = {
  id: true,
  amountCents: true,
  reviewContext: true,
} as const satisfies Prisma.ManualRefundTaskSelect;

/** One settled share, as little of it as the sum needs. */
export type EditReviewChargeShareRow = {
  amountCents: number | null;
  reviewContext: unknown;
};

/**
 * The settled shares, totalled per edit.
 *
 * The arithmetic half of `sumEditReviewChargeSharesCents`, split out so the same
 * summation serves one anchor and a whole repair sweep. A task whose stored
 * context is unreadable, or which names no anchor, contributes to NOTHING rather
 * than to a fallback bucket: `parseEditFinancialReviewContext` returning null
 * means the evidence cannot be trusted, and quietly attributing that money to
 * some edit would be the guess this epic exists to refuse.
 */
export function sumEditReviewChargeSharesByAnchor(
  tasks: readonly EditReviewChargeShareRow[],
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const task of tasks) {
    const anchor = parseEditFinancialReviewContext(task.reviewContext)
      ?.bookingModificationId;
    if (!anchor) continue;
    totals.set(anchor, (totals.get(anchor) ?? 0) + (task.amountCents ?? 0));
  }
  return totals;
}

/**
 * WHICH LEDGER ROW IS THIS EDIT'S COMBINED CHARGE REQUEST — as three field
 * equalities, so the question can be asked of the database AND of rows already
 * in hand without being spelled twice (`INV-SSOT`).
 *
 * `findEditReviewChargeRequest` spreads this into a `where`;
 * `isEditReviewChargeRequestRow` compares a loaded row against it field by
 * field. #3187 needed the second form: the repair tool already holds every
 * `PaymentTransaction` on the booking, and re-querying for one it is looking at
 * would be a second answer to a question this feature already owns.
 */
export function editReviewChargeRequestCriteria(bookingModificationId: string) {
  return {
    kind: PaymentTransactionKind.ADDITIONAL,
    source: PaymentSource.STRIPE,
    reason: buildEditFinancialReviewChargeReason(bookingModificationId),
  } as const;
}

/** The same three equalities, asked of a row that is already loaded (#3187). */
export function isEditReviewChargeRequestRow(
  row: {
    kind: PaymentTransactionKind;
    source: PaymentSource;
    reason: string | null;
  },
  bookingModificationId: string,
): boolean {
  const criteria = editReviewChargeRequestCriteria(bookingModificationId);
  return (
    row.kind === criteria.kind &&
    row.source === criteria.source &&
    row.reason === criteria.reason
  );
}
