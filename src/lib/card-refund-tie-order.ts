// #4284: the one order of a payment's card refund rows and recorded refunds,
// shared by the owed-figure attribution (`open-card-refund-owed.ts`) and every
// read that feeds it. Plain module (a type-only Prisma import), so a client
// page can import the module that reads it.
import type { Prisma } from "@prisma/client";

/**
 * #4284 (`INV-PAY-121`, `INV-SSOT`): THE ONE ORDER OF A PAYMENT'S CARD REFUND
 * ROWS AND RECORDED REFUNDS, for every read that attributes refunds to rows.
 *
 * `createdAt` alone is not an order: two rows raised in one ledger write (two
 * refunds Stripe failed later together), or two refunds recorded in one, tie,
 * and PostgreSQL returns tied rows in whatever order it meets them. Which row
 * a refund fills would then change from one read to the next - one read says a
 * row owes 5000, the next says 0. So a tie is broken by a unique column: a row
 * by `id`, a refund by `stripeRefundId` (unique on `PaymentRefund`). Neither
 * is an insertion order (a cuid is not one, #4129); the tie-break makes the
 * answer the same every time, not "the one written first".
 *
 * The attribution sorts in memory with the comparators below, so it holds
 * whatever order its rows arrive in; that sort is the guarantee. The reads also
 * ask PostgreSQL for the same order (`CARD_REFUND_OPERATION_ORDER_BY`,
 * `RECORDED_CARD_REFUND_ORDER_BY`) as defence in depth. PostgreSQL compares the
 * keys by the database's collation, which can differ from code-unit order on
 * mixed-case keys (Stripe's ids), so on such a tie the comparator decides.
 */
export const CARD_REFUND_OPERATION_ORDER_BY = [
  { createdAt: "asc" },
  { id: "asc" },
] satisfies Prisma.PaymentRecoveryOperationOrderByWithRelationInput[];

/** A payment's recorded refunds in the order `compareRecordedCardRefunds` reads them (#4284). */
export const RECORDED_CARD_REFUND_ORDER_BY = [
  { createdAt: "asc" },
  { stripeRefundId: "asc" },
] satisfies Prisma.PaymentRefundOrderByWithRelationInput[];

/** What a card refund row is ordered by (`CardRefundOperationRow`'s `createdAt` and `id`). */
interface CardRefundRowOrderKey {
  createdAt: Date;
  id: string;
}

/** What a recorded refund is ordered by (`RecordedCardRefundRow`'s `createdAt` and `stripeRefundId`). */
interface RecordedCardRefundOrderKey {
  createdAt: Date;
  stripeRefundId: string;
}

/** Code-unit order of two unique strings, the same on every runtime (never `localeCompare`). */
function compareUniqueKeys(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Card refund rows oldest raised first, a `createdAt` tie broken by `id` (#4284). */
export function compareCardRefundOperations(
  left: CardRefundRowOrderKey,
  right: CardRefundRowOrderKey,
): number {
  return left.createdAt.getTime() - right.createdAt.getTime() || compareUniqueKeys(left.id, right.id);
}

/** Recorded refunds oldest recorded first, a `createdAt` tie broken by `stripeRefundId` (#4284). */
export function compareRecordedCardRefunds(
  left: RecordedCardRefundOrderKey,
  right: RecordedCardRefundOrderKey,
): number {
  return left.createdAt.getTime() - right.createdAt.getTime() || compareUniqueKeys(left.stripeRefundId, right.stripeRefundId);
}
