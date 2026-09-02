import { ApiError } from "@/lib/api-error";
import {
  prepareBookingBatchModification,
  type BatchModificationPreTransaction,
} from "@/lib/booking-batch-modification-service";
import type { LinkedDateMoveArgs } from "@/lib/booking-linked-date-move-service";
import { prisma } from "@/lib/prisma";

/**
 * WHAT THE LINKED MOVE SETTLES BEFORE ITS TRANSACTION OPENS, and how it answers
 * when that transaction cannot take its locks (#3232, `INV-LOCK-004`).
 *
 * One small module rather than three sections of the service, because these are
 * the same concern from three sides: the club's answer to a policy question, the
 * settings and provider reads that must not happen under a lock, and the budget
 * and the refusal that belong to the transaction those values are handed to.
 * Keeping them together is also what keeps the service itself readable — it is
 * one procedure, and its file should be that procedure.
 */

/**
 * Whether the club charges the change fee on both bookings (#3232 D2).
 *
 * Read from the club settings singleton, OUTSIDE any transaction, and passed in as
 * a value — the same rule every other policy read on these paths follows
 * (`INV-LOCK-004`): a settings read inside the transaction would take a second
 * pooled connection while the global money key and the lodge capacity key are both
 * held.
 *
 * Absent row means the default, which is `true`. A club that has never opened the
 * settings page has not chosen to waive anything.
 */
export async function loadLinkedMoveChargesBothChangeFees(): Promise<boolean> {
  const defaults = await prisma.bookingDefaults.findUnique({
    where: { id: "default" },
    select: { linkedMoveChargesBothChangeFees: true },
  });
  return defaults?.linkedMoveChargesBothChangeFees ?? true;
}

/**
 * The settings, policy and provider reads BOTH bookings need, done ONCE and
 * BEFORE the transaction opens (`INV-LOCK-004`, #3232).
 *
 * WHY IT CANNOT BE LEFT TO `modifyBookingBatch`. That service does this work
 * itself when it owns its transaction, and the code sits above its
 * `withOptionalTransaction` call — which reads as "before the transaction" and is
 * false here: this module hands it a transaction, so its preamble would run INSIDE
 * one holding `pg_advisory_xact_lock(1)` and the per-lodge capacity key. Twice per
 * linked move. Among those reads is `getXeroLockDates`, which on a cold or expired
 * cache is a live HTTPS request to Xero with a possible OAuth refresh, so the
 * club's entire money and lifecycle path would serialise behind an outbound
 * provider call — the one shape `docs/CONCURRENCY_AND_LOCKING.md` forbids outright,
 * and the shape this module's own header claimed it had avoided.
 *
 * `"unknown"` BECAUSE THE SECOND BOOKING IS ONLY DISCOVERED UNDER THE LOCKS. Who
 * the primary's move stranded is read after that move is written, so no position
 * out here can name the dependent bookings or their target nights. The lock-date
 * facts are therefore resolved unconditionally rather than short-circuited on "no
 * check-in is retroactive": one settings read, one token read and at most one
 * TTL-cached organisation read, on a path that is already pricing two bookings.
 * The alternative — enumerating candidate dependents out here with a second
 * uncommitted read — would buy a rare saving with a second definition of who the
 * dependents are (`INV-SSOT-001`).
 */
export async function prepareLinkedMovePreTransaction(
  args: LinkedDateMoveArgs,
): Promise<BatchModificationPreTransaction> {
  return prepareBookingBatchModification({
    candidateCheckIns: "unknown",
    audience: args.actor.role === "ADMIN" ? "admin" : "member",
  });
}

/**
 * A refusal that means "there are not beds for both", as opposed to any other
 * reason the second move could fail.
 *
 * ONLY THESE THREE, deliberately. A minimum-stay violation, a Xero lock date, a
 * member-night conflict or a membership-type policy block are not "cannot fit" —
 * they are reasons this particular linked move is wrong, and dressing them as a
 * capacity message would tell the member something false. They propagate, the
 * transaction rolls back, and the member sees the real refusal.
 *
 * `InsufficientCapacityError` IS THE ONE THAT ACTUALLY FIRES HERE, and its absence
 * made this whole arm dead code. `calculateModifiedPricing` branches on
 * `adminOverride` FIRST: the two over-capacity classes are raised only on the
 * override path, and the member path throws the plain refusal instead. A linked
 * move is reachable only for the booking's own member — an officer escalates
 * through `REQUIRE_OVERRIDE` and never gets here — so `adminOverride` is always
 * false, and keying on the classed pair alone meant a full lodge propagated a bare
 * 400 about beds on a booking the member had not asked to move, with no offer and
 * therefore no decline arm either. The two override classes are kept because an
 * admin-initiated caller supplying this service is a shape the type system allows
 * and the arm is right for it too.
 */
/**
 * The interactive-transaction budget, WIDENED because this transaction is roughly
 * two of them (`INV-LOCK-001`, `INV-LOCK-002`).
 *
 * Prisma's defaults are `maxWait: 2s / timeout: 5s`, and the wait for
 * `pg_advisory_xact_lock(1)` counts against them. Inside this one transaction:
 * that blocking global wait, the per-lodge capacity key, TWO full
 * `modifyBookingBatch` bodies (each a re-read, an eligibility pass, a pricing run,
 * a capacity check, a guest-row rewrite and a settlement), the envelope flush and
 * three supervision reconciles. On the defaults an ordinary cancel or a bed
 * assignment legitimately holding `lock(1)` would abort it — and it is the same
 * numbers `assignBedRange`, the longest-lived holder of that key in the tree,
 * already runs on, so a linked move contending with one no longer loses by
 * construction. `deleted-booking-modification-payment.ts` states the same
 * reasoning for the same reason; that caller takes a TIGHTER budget only because a
 * Stripe delivery timeout is its ceiling, and a member's save has no such ceiling.
 *
 * NOTHING IS COMMITTED WHEN IT DOES EXPIRE, which is why the caller can answer
 * "try again in a moment" honestly — see `LinkedDateMoveContendedError`.
 */
export const LINKED_MOVE_TRANSACTION_BUDGET = {
  maxWait: 10_000,
  timeout: 30_000,
} as const;

/**
 * Refused because the transaction could not take its locks in time, or lost a
 * write conflict.
 *
 * P2028 covers an exhausted `maxWait`/`timeout` and P2034 a write
 * conflict/deadlock; both mean a counterpart writer legitimately held `lock(1)` or
 * the lodge key, NOTHING WAS COMMITTED, and the remedy is "again shortly" rather
 * than "differently" (`docs/CONCURRENCY_AND_LOCKING.md`). It matters more here
 * than on most paths: unmapped, contention arrives at the member as an opaque 500
 * INSTEAD OF THE OFFER, which puts them back in the state of being unable to move
 * either booking — the deadlock this whole feature exists to remove, reappearing
 * under load.
 *
 * An `ApiError` subclass so both save routes answer it through the generic branch
 * they already have, rather than each growing its own copy of the mapping.
 */
export class LinkedDateMoveContendedError extends ApiError {
  readonly code = "LINKED_MOVE_CONTENDED";
  constructor() {
    super(
      "Something else is being changed on these bookings right now, so we could not " +
        "work out the combined change in time. Nothing was changed — please try " +
        "again in a moment.",
      503,
    );
    this.name = "LinkedDateMoveContendedError";
  }
}


/**
 * Prisma's transaction contention codes.
 *
 * The same pair, for the same reason, as `waitlist-confirm/route.ts`,
 * `admin/site-style/route.ts`, `deletion-request-decision.ts` and
 * `waitlist-return-contract.ts`. It is deliberately NOT hoisted into a shared
 * module here: two of the existing copies also carry `P2002`, which is a
 * unique-constraint retry rather than contention, so unifying them is a decision
 * about those paths and not a side effect of this one.
 */
export function isTransactionContention(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "P2028" || code === "P2034";
}
