import "server-only";

import {
  ManualRefundTaskKind,
  ManualRefundTaskStatus,
  Prisma,
} from "@prisma/client";
import { ApiError } from "@/lib/api-error";
import logger from "@/lib/logger";
import { stableDigest } from "@/lib/stable-digest";
import { canonicalNights } from "@/lib/stable-json";
import {
  isNonNegativeIntegerCents,
  parseEditFinancialReviewContext,
  type EditFinancialReviewContext,
  type EditFinancialReviewOccurrence,
} from "@/lib/edit-financial-review-context";
import { MANUAL_REFUND_TASK_REASON_MAX } from "@/lib/manual-subscription-payment";
import type { CalendarDate } from "@/lib/club-time";

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
 * raise into one local action.
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

/**
 * The occurrence-key namespace and its version.
 *
 * `v1` is a real hinge. The key IS the identity of an occurrence, so changing
 * what goes into the hash silently re-identifies every future edit and would let
 * an already-reviewed occurrence raise a second task. Bumping this prefix makes
 * such a change a deliberate new namespace instead - old keys keep matching old
 * rows, and nothing collides. Never widen the material without bumping it.
 */
const OCCURRENCE_KEY_NAMESPACE = "edit-financial-review";
const OCCURRENCE_KEY_VERSION = "v1";

/**
 * The identity of one unpriceable structural edit, as 64 lowercase hex
 * characters behind a namespaced, versioned prefix.
 *
 * ## What "the same structural edit" means, precisely
 *
 * Two calls describe the SAME occurrence when all of the following match:
 *
 *  1. the booking and the guest strand whose nights were given back;
 *  2. why the price could not be proven (the `cause`);
 *  3. the set of night dates surrendered, and the set added - as SETS, so order
 *     and duplicates cannot change the answer; and
 *  4. the stored night-price rows the edit was judged against - the guest's
 *     stored total, and every stored night row's date and price, including the
 *     nulls, as it all stood BEFORE the edit.
 *
 * Anything else differing - the operator prose in `reason`, the wall-clock
 * moment, who was signed in, which retry this is - does not change the key.
 *
 * ## Why (4) is in there, which is the part worth arguing
 *
 * Without it a retry is still one task, but this sequence quietly loses money.
 * A night is surrendered and the amount cannot be proven, so a task is raised.
 * An admin prices it and COMPLETES it. Later the same night is added back to the
 * booking and surrendered again. That is a genuinely new occurrence owed a
 * genuinely new adjustment - but on booking, guest, cause and dates alone it
 * hashes to the key the completed task already holds, so the raise finds a
 * terminal row, declines to create anything, and the second adjustment is never
 * reviewed by anybody. Including the stored evidence distinguishes the two,
 * because the first edit changed it.
 *
 * ## Why NOT the `BookingGuestNight` row ids, which is the obvious answer
 *
 * Row ids would distinguish that case cleanly and were rejected on measurement:
 * the whole reason an edit reaches this module is that the stored per-night
 * evidence is missing or unusable, so in the `NO_STORED_NIGHT_PRICES` case there
 * are no row ids to key on at all. An identity that is unavailable in its own
 * primary failure case is not an identity.
 *
 * The evidence fingerprint costs nothing extra: it is data the planner has
 * necessarily already read (it is what failed to reconcile), and the same data
 * `reviewContext` must capture regardless, because the edit destroys it.
 *
 * It is IDENTITY MATERIAL, and calling it "sold-price evidence" would overstate
 * it. A stored `BookingGuestNight.priceCents` may be a derived even split rather
 * than a price anyone was ever charged - two backfill migrations wrote splits,
 * and nothing distinguishes their rows from genuinely-sold ones
 * (`StoredNightPriceEvidence` names them). That does not weaken its use HERE:
 * the key needs a fingerprint of what the database held at the moment of the
 * edit, and that is exactly what this is. It is also why the amount goes to a
 * human instead of being computed.
 *
 * ## Why a hash rather than a readable composite key
 *
 * The material is unbounded - a stay can be a fortnight, and every night
 * contributes a date and a price - and `occurrenceKey` is one indexed column.
 * A digest is fixed-width. It is not a secret and nothing is hidden by it: the
 * whole input is stored in plain form in `reviewContext` on the same row, so the
 * key can be recomputed and checked. Canonicalisation goes through the shared
 * `stableDigest` (`INV-SSOT`) because `JSON.stringify` is insertion-ordered and
 * a key that shifts with field order is not an identity either.
 *
 * The digest for a fixed occurrence is PINNED in
 * `src/lib/__tests__/edit-financial-review.test.ts`. That pin is what makes the
 * "never widen the material without bumping the version" rule above enforceable
 * rather than merely written down: every other test recomputes the key on both
 * sides and would pass through exactly the change that loses the money.
 */
export function editFinancialReviewOccurrenceKey(
  occurrence: EditFinancialReviewOccurrence,
): string {
  const material = {
    bookingId: occurrence.bookingId,
    bookingGuestId: occurrence.bookingGuestId,
    cause: occurrence.cause,
    surrenderedNightDates: canonicalNights(occurrence.surrenderedNightDates),
    addedNightDates: canonicalNights(occurrence.addedNightDates),
    storedEvidence: {
      guestTotalCents: occurrence.storedEvidence.guestTotalCents,
      // Sorted by date so the planner's read order cannot change the identity.
      // Two rows for one date would be evidence in their own right, so they are
      // NOT deduplicated here - only ordered.
      nightPrices: [...occurrence.storedEvidence.nightPrices]
        .map((night) => ({ date: night.date, priceCents: night.priceCents }))
        .sort((left, right) =>
          left.date === right.date
            ? (left.priceCents ?? -1) - (right.priceCents ?? -1)
            : left.date < right.date
              ? -1
              : 1,
        ),
    },
  };
  return `${OCCURRENCE_KEY_NAMESPACE}:${OCCURRENCE_KEY_VERSION}:${stableDigest(material)}`;
}

/**
 * The operator prose on the task.
 *
 * A builder rather than free text at the call site, so every raised task reads
 * the same way - but prose is emphatically NOT the identity. #3030 rejects "free
 * form task reason as the identity" outright, and this repository has already
 * been bitten by the weaker version of that: `reason` has been used as a
 * de-facto discriminator via a `startsWith` match in the finance queue, which is
 * what `ManualRefundTaskKind` exists to replace. Change this wording freely; the
 * occurrence key will not move.
 */
export function buildEditFinancialReviewReason(
  occurrence: EditFinancialReviewOccurrence,
): string {
  const nights = canonicalNights(occurrence.surrenderedNightDates);
  // NOT "first to last". A night set need not be contiguous, and "3 nights
  // (2026-08-02 to 2026-08-20)" reads as a nineteen-night span for three actual
  // nights - in the sentence an admin reads WHILE PRICING REAL MONEY. The nights
  // are listed instead, and the list is what gets truncated if the stay is long
  // enough to overrun the column; `reviewContext` carries the full set either
  // way, and #3033 renders it.
  const nightsPhrase =
    nights.length === 0
      ? "no nights"
      : nights.length === 1
        ? `the night of ${nights[0]}`
        : `${nights.length} nights: ${nights.join(", ")}`;
  // #3032: the second sentence has to match the cause, because the two are read
  // as instructions. "The exact sold price could not be read" is FALSE of a
  // `COUNTERPART_STRAND_UNREADABLE` strand - its rows are complete and add up -
  // and an admin told otherwise about a task that carries real per-night prices
  // has been handed a contradiction while pricing real money.
  const why =
    occurrence.cause === "COUNTERPART_STRAND_UNREADABLE"
      ? "This guest's own stored night prices are complete and add up, but another guest on the same booking has prices that cannot be read, so the booking's total could not be reworked automatically. Confirm the amount owed for the nights above before any money moves."
      : "The exact sold price could not be read from this booking's stored history, so the club must price the adjustment from the booking's own payment and rate history before any money moves.";
  return `Booking edit gave back ${nightsPhrase}. ${why}`.slice(
    0,
    MANUAL_REFUND_TASK_REASON_MAX,
  );
}

/** What became of a raise. */
export type RaiseEditFinancialReviewResult = {
  taskId: string;
  occurrenceKey: string;
  /**
   * True only when THIS call inserted the row. False means the occurrence was
   * already on file - a replay - and `status` says what has since become of it.
   */
  created: boolean;
  /**
   * The occurrence's status now. `OPEN` on a fresh raise or a replay of one
   * still awaiting pricing; `COMPLETED` or `DISMISSED` when the occurrence was
   * already resolved, in which case this call deliberately did nothing: those
   * states are terminal for that occurrence and a replay must not reopen them.
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
  reason,
  paymentId = null,
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
  /** Operator prose. Defaults to `buildEditFinancialReviewReason`. */
  reason?: string;
  /**
   * A captured payment this adjustment sits against, or null. Null is the
   * ordinary case here and is not a gap: owner decision D2 made `paymentId`
   * optional precisely because a credit owed back for a surrendered night need
   * not sit against any one captured payment, and completing such a task writes
   * no refund allocation.
   */
  paymentId?: string | null;
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

  const occurrenceKey = editFinancialReviewOccurrenceKey(occurrence);

  // `INV-LOCK-001` / `INV-LOCK-002`: the global settlement cohort key, taken
  // before the find-then-create below, which is what makes that pair atomic.
  // Re-entrant, so a caller already holding it (#3032) pays nothing. See this
  // module's header for why the unique index is not the primary fence.
  await store.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

  const existing = await store.manualRefundTask.findUnique({
    where: { occurrenceKey },
    select: { id: true, status: true },
  });
  if (existing) {
    return {
      taskId: existing.id,
      occurrenceKey,
      created: false,
      status: existing.status,
    };
  }

  const reviewContext: EditFinancialReviewContext = {
    version: 1,
    occurrence,
    guestMemberId,
    bookingCheckIn,
    bookingCheckOut,
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
 * Two readers ask that question and they are imported side by side into the same
 * services: this module's `findOpenEditFinancialReviewTask`, which is the FENCE
 * and runs on the caller's transaction client under the booking-edit locks, and
 * `booking-financial-review-visibility.ts`, which is the member-facing and admin
 * VISIBILITY read and runs on the global client after the commit. The client, the
 * moment, the shape returned and the number of bookings asked about all differ,
 * which is why they are two functions - but the predicate is one idea, and
 * spelling it twice is how a later narrowing (a third status, a second kind) ends
 * up applying to the banner and not to the fence, or the other way round.
 *
 * It lives HERE, with the module that mints the kind, rather than beside either
 * reader.
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
