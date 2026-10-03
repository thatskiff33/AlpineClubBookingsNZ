import type { Mock } from "vitest";

/**
 * #3793: the paid cancel claim re-reads its `Payment` row after locking it.
 * A tx double answers that re-read with the payment the claim's own booking
 * read served (matched by id), so a case that never moved the payment sees the
 * same row twice. A case that models a refund landing between the two reads
 * overrides the payment delegate instead.
 */
export function lockedPaymentReReadDouble(bookingFindUnique: Mock) {
  return async (args: { where: { id: string } }) => {
    const served = await Promise.all(
      bookingFindUnique.mock.results.map((result) => result.value as unknown),
    );
    for (const row of served.reverse()) {
      const payment = (row as { payment?: { id?: string } | null } | null)?.payment;
      if (payment?.id === args.where.id) return payment;
    }
    return null;
  };
}
