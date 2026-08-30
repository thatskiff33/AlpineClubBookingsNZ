import "server-only";

import {
  ManualRefundTaskKind,
  ManualRefundTaskStatus,
  Prisma,
} from "@prisma/client";
import { ApiError } from "@/lib/api-error";
import logger from "@/lib/logger";
import {
  isNonNegativeIntegerCents,
  parseEditFinancialReviewContext,
  type EditFinancialReviewContext,
  type EditFinancialReviewOccurrence,
} from "@/lib/edit-financial-review-context";
import { MANUAL_REFUND_TASK_REASON_MAX } from "@/lib/manual-subscription-payment";
import {
  buildEditFinancialReviewReason,
  editFinancialReviewOccurrenceKey,
  findFreeOccurrenceSlot,
  MAX_OCCURRENCE_RECURRENCES,
} from "@/lib/edit-financial-review-occurrence";
import {
  editReviewSettlementPaymentId,
  type EditReviewSettlementPayment,
} from "@/lib/booking-payment-state";
import {
  calendarDateOfDateOnlyInstant,
  type CalendarDate,
} from "@/lib/club-time";

/**
 * #3030 (epic #2797): raise the durable "this booking edit is valid, but the
 * money still needs review" state.
 *
 * The owner's settled rule for the whole epic is *"exact stored sold-price
 * evidence or manual review. Never estimate historical money and never flatten
 * stored sold-price rows."* Owner decision D1 says what that means for the edit
 * itself: **complete the edit, hold only the money.** The night comes off, the
 * booking is correct, and the credit or refund is parked as an OPEN task for an
 * admin to price and confirm. Nothing moves at Stripe or in the ledger until
 * they do.
 *
 * This module owns the state and nothing else. It moves no money, prices
 * nothing, and reads no rate. It does not decide WHETHER an edit is unpriceable
 * - that is the planner (#3031) - and it does not call itself from the
 * booking-edit path - that is #3032, which composes the structural edit and this
 * raise into one local action. Since #3166 it does not mint an occurrence's
 * IDENTITY either: the key, its material, the recurrence walk that says where a
 * new occurrence goes, and the operator prose derived from the same occurrence
 * all live in `edit-financial-review-occurrence.ts`. The boundary is exactly one
 * value - a key and a slot - so nothing here re-derives a key.
 *
 * ## Locking (`INV-LOCK-001`, `INV-LOCK-002`)
 *
 * `raiseEditFinancialReviewTask` takes the global settlement cohort key
 * `pg_advisory_xact_lock(1)` and nothing else, which is exactly the
 * classification `docs/CONCURRENCY_AND_LOCKING.md` already records for the two
 * sibling `ManualRefundTask` raisers in
 * `deleted-booking-modification-payment.ts`: *"It is a settlement-money writer,
 * so it joins this cohort rather than minting a keyspace... It needs the key
 * because the write is a find-then-create, which is not atomic on its own."*
 * The reasoning transfers verbatim - two replays of one edit would each find no
 * row and each write one, and two operators would then hand back one adjustment
 * twice.
 *
 * It takes the key ITSELF rather than trusting the caller to hold it. A caller
 * that already holds it (#3032 does) gets a no-op, because a transaction
 * re-acquiring an advisory key it already owns returns immediately.
 *
 * THAT IS NOT AN UNCONDITIONAL SAFETY PROPERTY, and the difference matters
 * enough to be a stated PRECONDITION rather than a reassurance. `INV-LOCK-002`
 * orders global before per-lodge, so a caller must hold the global key, or no
 * lock at all, before it calls this. A caller holding ONLY the per-lodge
 * capacity key deadlocks:
 *
 *   Tx A: acquireLodgeCapacityLock(L) -> calls this -> waits for lock(1)
 *   Tx B: holds lock(1) (booking-cancel.ts, or any of the ~40 global-then-lodge
 *         writers) -> waits for L
 *
 * Postgres detects the cycle and kills one transaction with 40P01. Re-taking the
 * FIRST tier is only free for a transaction that is already at or above it; it
 * cannot rescue a caller that took the tiers out of order, and nothing here can.
 * The three services #3032 will wrap all take global first, so this is a
 * precondition to keep rather than a live defect.
 *
 * The unique index on `occurrenceKey` therefore stays belt-and-braces rather
 * than being the primary fence, and that split is deliberate. A unique violation
 * inside the caller's interactive transaction ABORTS that transaction in
 * Postgres - there is no re-reading after it - so an index-only design could not
 * recover, it could only lose the whole edit. The lock closes the window; the
 * index catches a writer that somehow got past it, and is reported loudly rather
 * than swallowed.
 *
 * No provider call happens anywhere in here: no Stripe, no Xero, no SES. The
 * whole point of the state is that nothing has moved yet.
 */


/** What became of a raise. */
export type RaiseEditFinancialReviewResult = {
  taskId: string;
  /**
   * The key the returned task is actually stored under: the occurrence digest
   * for the first turn of an identity, and the digest plus a `#n` recurrence
   * suffix afterwards (#3166). A caller wanting to find this row again must use
   * THIS value rather than re-deriving the digest.
   */
  occurrenceKey: string;
  /**
   * True only when THIS call inserted the row. False means the occurrence was
   * already OPEN on file - a replay - and nothing further was written.
   */
  created: boolean;
  /**
   * The status of the task this call returns, which since #3166 is always
   * `OPEN`: a row just inserted, or a replay of one still awaiting pricing. A
   * COMPLETED or DISMISSED task is terminal, is never reopened or returned here,
   * and no longer SUPPRESSES a later occurrence of the same identity - the money
   * `findFreeOccurrenceSlot` closes. Typed as the enum rather than the literal
   * because that is the caller's question to ask.
   */
  status: ManualRefundTaskStatus;
};

/**
 * `{ message, status }`, which `ApiError` already defines and 57 files already
 * use - so this SUBCLASSES it rather than being a fifth independent spelling of
 * the same shape (`INV-SSOT`, #3030).
 *
 * A distinct class still earns its place: #3032 composes a structural edit with
 * this raise and needs to tell "the raise refused" from any other `ApiError`
 * thrown inside the same transaction, which `instanceof` gives it. What it does
 * NOT need is a second definition of what an error carrying an HTTP status looks
 * like, and an `ApiError` handler anywhere up the stack now catches this too
 * instead of falling through to a 500.
 */
export class EditFinancialReviewError extends ApiError {
  constructor(message: string, status: number) {
    super(message, status);
    this.name = "EditFinancialReviewError";
  }
}

/**
 * Create - or find - the ONE financial-review task for this occurrence.
 *
 * Idempotent by design: a replay of the same structural edit returns the
 * existing task rather than raising a second one, whatever state that task has
 * reached. `created` tells the caller which happened, so #3032 can be atomic
 * about the structural edit without having to guess whether it also just made
 * work for an admin.
 *
 * ## `store` is required, and is a transaction client on purpose
 *
 * #3032 must apply the structural stay change and create-or-reuse exactly one
 * OPEN task "as one logical local action". A function that could open its own
 * transaction would let a caller commit the stay change and lose the money
 * question in a separate failed write, which is the first of the two failure
 * modes that issue names.
 *
 * THE TYPE DOES NOT ENFORCE THIS, and an earlier version of this docblock
 * claimed it did. `Prisma.TransactionClient` is `PrismaClient` minus a deny
 * list, and in Prisma 7 that list
 * (`denylist` in `node_modules/@prisma/client/runtime/client.d.ts`) is
 * `["$connect","$disconnect","$on","$use","$extends"]`. `$transaction` is NOT in
 * it - Prisma 7 supports nested transactions - so the full client is
 * structurally assignable here and passing `prisma` compiles cleanly. Measured
 * with a compile probe, not assumed. The obvious type-level repair does not work
 * either: `Prisma.TransactionClient & { $transaction?: never }` collapses to
 * `never` and rejects BOTH clients, which the same probe showed.
 *
 * So the guarantee is enforced at RUNTIME, at the top of the function. The
 * discriminator is `$connect`, and it has to be: measured against a real
 * PostgreSQL on Prisma 7.9.1, an interactive transaction client reports
 * `typeof tx.$transaction === "function"` (nested transactions again) while
 * `$connect`, `$disconnect` and `$extends` are all `undefined` on it - they are
 * the deny list, and the deny list is exactly what tells the two apart.
 *
 * The failure this prevents is worth the check. Given the full client,
 * `store.$executeRaw` would run `pg_advisory_xact_lock(1)` in its own implicit
 * transaction, which COMMITS IMMEDIATELY and releases the lock before
 * `findUnique` runs - no fence at all. The P2002 argument below inverts as well:
 * it declines to re-read because a unique violation aborts the surrounding
 * transaction, but with no surrounding transaction an ordinary concurrent replay
 * would become a 409 "retry the edit" instead of returning the existing task.
 * Every unit test would still pass, because they inject a mock `store`.
 *
 * ## What it does not do
 *
 * No money moves: no Stripe refund, no internet-banking allocation, no account
 * credit, no ledger or Xero adjustment, no email. It writes one row. Whether the
 * amount is ever paid is the admin's decision, taken later through
 * `resolveManualRefundTask`.
 */
export async function raiseEditFinancialReviewTask({
  occurrence,
  guestMemberId,
  bookingCheckIn,
  bookingCheckOut,
  bookingModificationId,
  guestsAddedByEdit,
  reason,
  paymentId,
  raisedAmountCents = null,
  store,
}: {
  occurrence: EditFinancialReviewOccurrence;
  guestMemberId: string | null;
  bookingCheckIn: CalendarDate;
  bookingCheckOut: CalendarDate;
  /**
   * #3032 (owner decision D-3032-1): the `BookingModification` row this edit
   * wrote, which is the anchor a confirmed amount settles against at completion.
   * REQUIRED rather than defaulted: a default would let a caller lose the anchor
   * silently, and the failure would then surface only when an admin tried to
   * close the task, long after the edit committed. Pass `null` deliberately
   * where there genuinely is no modification row.
   *
   * There is no production caller yet - the raise trigger arrives with #3031,
   * which is what turns an unpriceable edit into a `financial_review_required`
   * branch. Requiring the parameter NOW is what makes the future callers answer
   * the question at the point they are written rather than inherit an answer.
   */
  bookingModificationId: string | null;
  /**
   * #3166: the guests this same edit added and what they were priced at, or null.
   * REQUIRED for the same reason as the two arguments above: an add whose new
   * guests were dropped from the evidence hands an admin a card saying the
   * booking gained nothing. `EditFinancialReviewContext.guestsAddedByEdit`
   * carries the reasoning.
   */
  guestsAddedByEdit: { count: number; totalPriceCents: number | null } | null;
  /** Operator prose. Defaults to `buildEditFinancialReviewReason`. */
  reason?: string;
  /**
   * A captured payment this adjustment sits against, or null. Null is an
   * ordinary answer and is not a gap: owner decision D2 made `paymentId`
   * nullable precisely because a credit owed back for a surrendered night need
   * not sit against any one captured payment, and completing such a task writes
   * no refund allocation.
   *
   * REQUIRED rather than defaulted (#3166), for the reason
   * `bookingModificationId` beside it gives: a caller that quietly inherited
   * `null` would have its refund silently re-routed to credit, and the failure
   * would surface only when an admin closed the task. Derive it through
   * `editReviewSettlementPaymentId`; `raiseParkedEditFinancialReviewTasks` below
   * does that and is what every production caller uses.
   */
  paymentId: string | null;
  /**
   * What the task is RAISED with, written once and never amended.
   *
   * Null - the normal case - means the amount is genuinely unknown. It is NOT
   * zero, and that distinction is the whole point of this feature: `0` is a real
   * financial decision ("reviewed, nothing is due") and using it for "not yet
   * known" is the magic value #3030 rejects by name. A number here is only for
   * the case where the edit could prove a figure and still wants a human to
   * confirm it before money moves.
   */
  raisedAmountCents?: number | null;
  store: Prisma.TransactionClient;
}): Promise<RaiseEditFinancialReviewResult> {
  // The runtime half of the `store` contract above, and the whole of the
  // guarantee - see the docblock for why the TYPE cannot provide it, why
  // `$connect` rather than `$transaction` is what tells the two clients apart,
  // and what silently breaks when a caller passes `prisma`.
  if (typeof (store as { $connect?: unknown }).$connect === "function") {
    throw new EditFinancialReviewError(
      "raiseEditFinancialReviewTask must run inside the caller's transaction: pass the transaction client, not the Prisma client.",
      500,
    );
  }

  if (
    raisedAmountCents !== null &&
    !isNonNegativeIntegerCents(raisedAmountCents)
  ) {
    // `INV-MONEY-001`: integer cents, non-negative, through the one predicate
    // (`INV-SSOT`). The DB `ManualRefundTask_raised_amount_nonnegative` CHECK
    // enforces the same rule; this refuses first, with a message that names the
    // caller's bug.
    throw new EditFinancialReviewError(
      "A raised financial-review amount must be non-negative integer cents.",
      400,
    );
  }

  const baseOccurrenceKey = editFinancialReviewOccurrenceKey(occurrence);

  // `INV-LOCK-001` / `INV-LOCK-002`: the global settlement cohort key, taken
  // before the find-then-create below, which is what makes that pair atomic.
  // Re-entrant, so a caller already holding it (#3032) pays nothing. See this
  // module's header for why the unique index is not the primary fence.
  await store.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

  const slot = await findFreeOccurrenceSlot(store, baseOccurrenceKey);
  if (slot.kind === "exhausted") {
    throw new EditFinancialReviewError(
      `This booking edit's financial review has already been raised and settled ${MAX_OCCURRENCE_RECURRENCES} times for the identical change; it will not be raised again automatically.`,
      500,
    );
  }
  if (slot.kind === "open") {
    return {
      taskId: slot.task.id,
      occurrenceKey: slot.occurrenceKey,
      created: false,
      status: slot.task.status,
    };
  }
  const occurrenceKey = slot.occurrenceKey;

  const reviewContext: EditFinancialReviewContext = {
    version: 1,
    occurrence,
    guestMemberId,
    bookingCheckIn,
    bookingCheckOut,
    guestsAddedByEdit,
    bookingModificationId,
  };
  // Parsed through the SAME schema the reader uses, at the WRITE site, because
  // the reader returns null on failure and does so deliberately (an admin must
  // still see the task). That is the right read behaviour and the wrong write
  // behaviour: a caller whose planner type had widened, or that supplied a
  // non-integer cents value, would store a row whose evidence can never be read
  // back - and the occurrence key is minted over that same material, so the
  // identity would be unrecoverable too. Nothing would throw and nothing would
  // log. TypeScript does not close this: the values arrive from a caller across
  // a `Json` boundary and `CalendarDate` is a branded string a cast can forge.
  if (!parseEditFinancialReviewContext(reviewContext)) {
    throw new EditFinancialReviewError(
      "This booking edit's review evidence could not be recorded in a readable form.",
      400,
    );
  }

  try {
    const created = await store.manualRefundTask.create({
      data: {
        bookingId: occurrence.bookingId,
        paymentId,
        // Both money columns are set from the same figure at creation:
        // `amountCents` is the live one an admin may confirm or amend, and
        // `raisedAmountCents` is the frozen record of what it was before they
        // touched it (owner decision D2, the audit half).
        amountCents: raisedAmountCents,
        raisedAmountCents,
        kind: ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW,
        occurrenceKey,
        reviewContext: reviewContext as unknown as Prisma.InputJsonValue,
        reason: (reason ?? buildEditFinancialReviewReason(occurrence)).slice(
          0,
          MANUAL_REFUND_TASK_REASON_MAX,
        ),
        status: ManualRefundTaskStatus.OPEN,
      },
      select: { id: true, status: true },
    });
    return {
      taskId: created.id,
      occurrenceKey,
      created: true,
      status: created.status,
    };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002" &&
      // Only the occurrence key. Today it is the only unique constraint on this
      // table other than the cuid primary key, so the check changes nothing -
      // but a later `@@unique([bookingId, kind])` or similar would otherwise be
      // reported to the operator as "raised concurrently, retry the edit", and
      // the retry would loop for ever on a violation retrying cannot fix.
      occurrenceKeyViolation(error)
    ) {
      // Reported, never swallowed. Reaching here means the find-then-create
      // above raced despite the advisory lock, so the lock was not actually
      // held for the whole pair - a caller bug worth a loud failure, not a
      // silent retry. It cannot be recovered from in place either: a unique
      // violation aborts the surrounding Postgres transaction, so the re-read
      // that would "fix" it is not available. The caller retries the whole
      // edit, and that retry finds the row.
      throw new EditFinancialReviewError(
        "This booking edit's financial review was raised concurrently - retry the edit.",
        409,
      );
    }
    throw error;
  }
}

/**
 * #3166: THE PARKED EDIT'S WHOLE RAISE, in one place, for all four doors.
 *
 * Every parked path used to write this block out by hand: the same settlement
 * payment id, the same `memberIdByGuestId` map, the same loop with the same
 * constant arguments. Four copies of ONE fact — which captured payment a parked
 * edit's review settles against, and which member owns the strand it names — and
 * the drift had already started: two copies said why the payment id matters and
 * two did not (`INV-SSOT`).
 *
 * That value is not incidental. `chooseEditReviewSettlementRoute` reads it at
 * COMPLETION to decide whether a confirmed amount goes back to the card, is
 * mirrored as a hand-settled allocation, or becomes account credit — so getting
 * it wrong does not fail, it routes real money down the wrong path weeks later
 * in front of an admin with no way to tell. It is derived through
 * `editReviewSettlementPaymentId`, the one home for that rule.
 *
 * `raisedAmountCents` is not an argument at all, so no caller can pass a number:
 * a parked edit's amount is unknown, zero is a real financial decision, and a
 * computed figure is the guess the review exists to avoid. Unrepresentable beats
 * policed.
 *
 * Call it inside the caller's transaction, after the locks and after the
 * `BookingModification` row exists — the returned task ids are in occurrence
 * order.
 */
export async function raiseParkedEditFinancialReviewTasks({
  booking,
  guests,
  addedGuests,
  occurrences,
  bookingModificationId,
  store,
}: {
  /**
   * The booking AS IT WAS before this edit. Its dates are what the task
   * describes, so the review names the stay the unreadable evidence belongs to
   * rather than the one the edit moved it to.
   */
  booking: {
    status: string;
    payment: EditReviewSettlementPayment;
    checkIn: Date;
    checkOut: Date;
  };
  /**
   * Every strand an occurrence can name, INCLUDING one this edit is deleting —
   * the single-guest removal raises for the departing guest, whose row is not in
   * the booking's remaining guest list.
   */
  guests: readonly { id: string; memberId?: string | null }[];
  /**
   * The guests THIS edit added, if any. Passed as the created rows rather than
   * as a count so no caller has to state the rule twice; an add of nothing is an
   * empty array and is recorded as null.
   */
  addedGuests: readonly { priceCents: number }[];
  occurrences: readonly EditFinancialReviewOccurrence[];
  /**
   * Owner decision D-3032-1: THIS edit's own `BookingModification`, so the
   * credit or refund that eventually moves is keyed to the change that caused it
   * rather than to a second history row minted at completion.
   */
  bookingModificationId: string | null;
  store: Prisma.TransactionClient;
}): Promise<string[]> {
  if (occurrences.length === 0) return [];
  const memberIdByGuestId = new Map(
    guests.map((guest) => [guest.id, guest.memberId ?? null]),
  );
  const paymentId = editReviewSettlementPaymentId(booking);
  // Money the club is owed and has not taken: a parked edit writes the booking's
  // total back unchanged, so an added guest's price lives only on their own row.
  // A total that is not usable money is recorded as ABSENT rather than as a
  // figure an admin might act on - the same rule the stored evidence follows.
  const addedTotalCents = addedGuests.reduce(
    (total, guest) => total + guest.priceCents,
    0,
  );
  const guestsAddedByEdit =
    addedGuests.length === 0
      ? null
      : {
          count: addedGuests.length,
          totalPriceCents: isNonNegativeIntegerCents(addedTotalCents)
            ? addedTotalCents
            : null,
        };
  const taskIds: string[] = [];
  for (const occurrence of occurrences) {
    const raised = await raiseEditFinancialReviewTask({
      occurrence,
      guestMemberId: memberIdByGuestId.get(occurrence.bookingGuestId) ?? null,
      bookingCheckIn: calendarDateOfDateOnlyInstant(booking.checkIn),
      bookingCheckOut: calendarDateOfDateOnlyInstant(booking.checkOut),
      bookingModificationId,
      guestsAddedByEdit,
      paymentId,
      raisedAmountCents: null,
      store,
    });
    taskIds.push(raised.taskId);
  }
  return taskIds;
}

/**
 * Was this unique violation the occurrence-key index, rather than some other
 * unique constraint added later?
 *
 * `meta.target` is `string[]` on PostgreSQL, and Prisma has spelled it more than
 * one way across versions, so an unrecognised shape is treated as "not the
 * occurrence key" - the safe direction, because it sends the caller a genuine
 * error rather than an invitation to retry for ever.
 */
function occurrenceKeyViolation(
  error: Prisma.PrismaClientKnownRequestError,
): boolean {
  const target = error.meta?.target;
  if (Array.isArray(target)) return target.includes("occurrenceKey");
  if (typeof target === "string") return target.includes("occurrenceKey");
  return false;
}

/**
 * The OPEN financial-review task for a booking, if it has one.
 *
 * This is the read #3032 needs for the epic's *"a second money-affecting edit is
 * fenced when it would require unresolved money as its baseline"* invariant:
 * unresolved money on a booking is exactly an OPEN `EDIT_FINANCIAL_REVIEW` task
 * against it, and a further edit that would have to price against that unknown
 * baseline must be refused with a pending-review answer rather than compounding
 * the guess.
 *
 * Scoped by BOOKING and not by payment, deliberately, and for the same reason
 * the finance-evidence diagnostics blocker is: a credit-only task carries no
 * `paymentId`, so a payment-scoped lookup would miss precisely the tasks this
 * feature creates.
 */
/**
 * What "this booking's money is still under review" MEANS, as a `where`
 * fragment, and the one definition of it (`INV-SSOT`).
 *
 * Two readers ask that question, side by side in the same services: the FENCE
 * below, on the caller's transaction client under the booking-edit locks, and
 * `booking-financial-review-visibility.ts`, on the global client after the
 * commit. Client, moment and shape all differ, so they stay two functions - but
 * the predicate is one idea, and spelling it twice is how a later narrowing
 * reaches the banner and not the fence. It lives here, with the module that
 * mints the kind.
 */
export const OPEN_EDIT_FINANCIAL_REVIEW_TASK_FILTER = {
  kind: ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW,
  status: ManualRefundTaskStatus.OPEN,
} as const;

export async function findOpenEditFinancialReviewTask(
  bookingId: string,
  store: Prisma.TransactionClient,
): Promise<{
  id: string;
  occurrenceKey: string | null;
  amountCents: number | null;
  raisedAmountCents: number | null;
  /**
   * PARSED, not raw. An unreadable blob is unusable to every caller anyway, and
   * handing back a `JsonValue` invites exactly the field-by-field indexing into
   * an `any` that `edit-financial-review-context.ts` exists to prevent.
   */
  reviewContext: EditFinancialReviewContext | null;
} | null> {
  const task = await store.manualRefundTask.findFirst({
    where: { bookingId, ...OPEN_EDIT_FINANCIAL_REVIEW_TASK_FILTER },
    select: {
      id: true,
      occurrenceKey: true,
      amountCents: true,
      raisedAmountCents: true,
      reviewContext: true,
    },
    orderBy: { createdAt: "asc" },
  });
  if (!task) return null;

  const reviewContext = parseEditFinancialReviewContext(task.reviewContext);
  if (!reviewContext && task.reviewContext !== null) {
    // The parser returns null rather than throwing ON PURPOSE - an admin must
    // still be able to see the task, its amount and the booking's live payment
    // history when one JSON blob is unreadable. But silence is the wrong half of
    // that bargain: the row's captured evidence is money evidence the edit
    // DESTROYED, so a row that cannot be read back has lost something nothing
    // else holds. Losing it quietly is how nobody finds out until an admin is
    // staring at an empty screen. The write site refuses to create such a row at
    // all; this covers a row written by an older or newer shape.
    logger.warn(
      { taskId: task.id, bookingId },
      "EDIT_FINANCIAL_REVIEW task has a reviewContext this release cannot read",
    );
  }
  return { ...task, reviewContext };
}

/**
 * #3032 (epic #2797): the pending-review FENCE.
 *
 * The epic's rule is *"a second money-affecting edit is fenced when it would
 * require unresolved money as its baseline"*. This is the one place that rule is
 * spelled, so every money-affecting door enforces the same thing rather than
 * several things that agree today (`INV-SSOT`).
 *
 * THERE ARE FOUR DOORS, and the fourth was missed on the first pass. Three are
 * services - the batch edit, the date edit and the single-guest removal - and the
 * fourth is `POST /api/bookings/[id]/guests`, which does its own repricing inline
 * in the route rather than through a service and so did not look like one. It
 * reprices every existing guest, computes a delta against a stored total that is
 * under review and writes the new total back, silently absorbing the very
 * overstatement the review was holding. Count the doors by what WRITES a booking's
 * money, never by what imports a service.
 *
 * ## Why it is needed
 *
 * An OPEN `EDIT_FINANCIAL_REVIEW` task means the system has already admitted it
 * cannot say what this booking's last change was worth. A further edit that
 * prices a refund or a charge has to start from the booking's stored money, and
 * that stored money is exactly what is under review - so its answer would be a
 * guess built on an unresolved guess, and the second guess would then be WRITTEN
 * into the stored night rows and read back by the edit after it. That compounding
 * is what the whole epic exists to stop.
 *
 * ## Why it is deliberately narrow
 *
 * `moneyAffecting: false` passes straight through, without so much as a query.
 * Fencing a name correction, a credit election, or a price-preserving date shift
 * behind an admin's pricing decision would trap a member on a booking they can
 * see is wrong, for a reason that has nothing to do with their edit. The issue
 * asks for exactly this split: *"identity-only changes remain independent where
 * safe"*.
 *
 * A CONSENT-AUTHORITY removal is exempt too, and that exemption belongs to the
 * caller rather than to this function, because only the caller can tell one.
 * Owner decision D-14 says a member who never consented must ALWAYS be able to
 * come off a booking; blocking that on a pricing question nobody has answered
 * would trap them for as long as the review stayed open, which is a worse trap
 * than the one this fence removes. The removal proceeds and parks its own money
 * as a second review task - two occurrences, two keys, two amounts, each priced
 * on its own evidence.
 *
 * ## Where to call it
 *
 * Inside the caller's transaction, AFTER the global and per-lodge locks and
 * after the post-lock re-read, and before anything is written. A read taken
 * before the locks could be answered by a task that a concurrent completion was
 * about to close, or miss one it was about to open.
 */
export const EDIT_FINANCIAL_REVIEW_PENDING_CODE =
  "EDIT_FINANCIAL_REVIEW_PENDING";

/**
 * Deliberately says what is true and what happens next, and blames nobody. The
 * member did nothing wrong: the club's own records could not price their last
 * change. #3033 owns the surfaces that render this; it is worded to be usable
 * as-is in the meantime rather than leaving a raw 409 for whoever hits it first.
 */
export const EDIT_FINANCIAL_REVIEW_PENDING_MESSAGE =
  "The club is still working out the money for the last change to this booking, so a further change that affects the price cannot be made yet. Your booking is unchanged. Please try again once the review is finished, or contact the club if it is urgent.";

export class EditFinancialReviewPendingError extends EditFinancialReviewError {
  /**
   * A machine code, so a surface that can DO something about this - offer the
   * finance queue, or explain the wait - can tell it apart from every other 409
   * without matching on the sentence.
   */
  readonly code = EDIT_FINANCIAL_REVIEW_PENDING_CODE;

  constructor() {
    super(EDIT_FINANCIAL_REVIEW_PENDING_MESSAGE, 409);
    this.name = "EditFinancialReviewPendingError";
  }
}

export async function assertNoPendingEditFinancialReview({
  bookingId,
  moneyAffecting,
  store,
}: {
  bookingId: string;
  /**
   * Whether THIS edit needs the booking's stored money as its baseline.
   *
   * REQUIRED with no default, and that is the point: a default of `true` would
   * quietly fence identity edits the first time a caller forgot it, and a default
   * of `false` would quietly let a money edit past. The compiler asks every call
   * site the question instead (`INV-SSOT`'s "prefer unrepresentable over
   * policed").
   */
  moneyAffecting: boolean;
  store: Prisma.TransactionClient;
}): Promise<void> {
  if (!moneyAffecting) return;
  const pending = await findOpenEditFinancialReviewTask(bookingId, store);
  if (pending) {
    throw new EditFinancialReviewPendingError();
  }
}
