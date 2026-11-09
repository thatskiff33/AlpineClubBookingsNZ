/**
 * #4823: member merge moves `Payment.manuallyMarkedPaidByMemberId` (the officer
 * who recorded a cash settlement) LAST, and never waits for a Payment row.
 *
 * Merge takes no `lock(1)` (see docs/CONCURRENCY_AND_LOCKING.md, "Why merge
 * takes no global cohort key"), yet it holds booking rows to commit: its owner
 * and actor moves re-point them. The `lock(1)` writers meet a booking's Payment
 * and booking rows in BOTH orders. A card settle (its PAID claim and R01) and
 * the back-post take the Payment row first. The edit doors, an edit review and
 * an approved appeal take the booking row first. Two
 * `lock(1)` holders never interleave, so neither order is wrong between them.
 * Merge is not a `lock(1)` holder, so no fixed place for the Payment rows among
 * merge's row locks is free of a cycle with both families:
 *
 * - After the booking moves, waiting (the order before #4823): merge holds the
 *   booking row and waits for the Payment row a settle holds while the settle
 *   waits for that booking row.
 * - Before the booking moves (Payment, then booking, the settle's order): merge
 *   holds the Payment row and waits for the booking row an edit door holds
 *   while the door waits for that Payment row.
 *
 * Merge's lodge prefix fences either writer only where the booking's lodge is
 * in it, and a booking merge touches through an actor column (the duplicate
 * made it, or overrode its capacity) can be at a lodge neither member stayed at.
 * (An approved appeal refuses a cash-settled payment before its transaction, so
 * it never meets merge on one of these rows.)
 *
 * So merge never WAITS for a Payment row. One statement locks every row naming
 * the duplicate, sorted by id, `NOWAIT`. If any is held, the merge refuses (a
 * 409 the caller builds, with nothing written) and the operator retries. A
 * lock nobody waits for cannot be part of a wait-for cycle.
 *
 * The call sits after merge's sorted `Member … FOR UPDATE` set and its late
 * queue sweeps. From that point no writer can make a Payment row name the
 * duplicate: that FK write needs `FOR KEY SHARE` on the duplicate's Member row.
 * So the locked set is complete, and the duplicate's `onDelete: SetNull` finds
 * no Payment row to update when it is deleted. It is also as late as the moves
 * can go, so merge holds the Payment rows across the fewest later waits.
 */
import { Prisma } from "@prisma/client";

import { MEMBER_MERGE_RELATION_SPECS, type MemberMergeRelationSpec } from "@/lib/member-merge-relations";
import { isPostgresLockNotAvailable } from "@/lib/prisma-errors";

/**
 * The one relation the spec table marks `movedLast`, which the generic move
 * pass skips and this module moves. Read from the table, never retyped, and
 * checked when the module loads: the `NOWAIT` reasoning above is about Payment
 * rows, so a second flagged relation, or a different model, fails loudly here.
 */
export const MEMBER_MERGE_PAYMENT_ATTRIBUTION_SPEC: MemberMergeRelationSpec = (() => {
  const flagged = MEMBER_MERGE_RELATION_SPECS.filter((relation) => relation.movedLast);
  const [only] = flagged;
  if (flagged.length !== 1 || !only || only.model !== "Payment" || only.bucket !== "move") {
    throw new Error(`#4823: exactly one "move" relation on Payment may be movedLast; found ${flagged.map((relation) => relation.key).join(", ") || "none"}.`);
  }
  return only;
})();

type LateMoveDelegate = {
  updateMany(args: { where: Record<string, string>; data: Record<string, string> }): Promise<{ count: number }>;
};

/**
 * Lock every Payment row the duplicate is named on, sorted and `NOWAIT`, then
 * re-point them to the survivor. Returns the number moved. A held row throws
 * `refuse()`; any other error is rethrown. Call it only while holding the
 * merge's `Member … FOR UPDATE` set, so the set it locks cannot grow.
 */
export async function moveMergedPaymentAttributionLast(
  tx: Prisma.TransactionClient,
  members: { masterId: string; loserId: string },
  refuse: () => Error,
): Promise<number> {
  const { model, column, delegate } = MEMBER_MERGE_PAYMENT_ATTRIBUTION_SPEC;
  // Identifiers from the static spec table, never from input.
  const table = Prisma.raw(`"${model}"`);
  const memberColumn = Prisma.raw(`"${column}"`);
  try {
    await tx.$executeRaw`SELECT 1 FROM ${table} WHERE ${memberColumn} = ${members.loserId} ORDER BY "id" FOR NO KEY UPDATE NOWAIT`;
  } catch (error) {
    if (isPostgresLockNotAvailable(error)) throw refuse();
    throw error;
  }
  const moved = await (tx as unknown as Record<string, LateMoveDelegate>)[delegate].updateMany({
    where: { [column]: members.loserId },
    data: { [column]: members.masterId },
  });
  return moved.count;
}
