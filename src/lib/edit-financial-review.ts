import "server-only";

import { createHash } from "node:crypto";
import {
  ManualRefundTaskKind,
  ManualRefundTaskStatus,
  Prisma,
} from "@prisma/client";
import { stableStringify } from "@/lib/stable-json";
import type {
  EditFinancialReviewContext,
  EditFinancialReviewOccurrence,
} from "@/lib/edit-financial-review-context";
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
 * It takes the key ITSELF rather than trusting the caller to hold it, and that
 * is safe in both directions. A caller that already holds it (#3032 does) gets a
 * no-op, because a transaction re-acquiring an advisory key it already owns
 * returns immediately. A caller that forgot gets the fence anyway. The
 * `INV-LOCK-002` order - global before per-lodge - is preserved because global
 * is the FIRST tier: re-taking a key already held cannot deadlock, and there is
 * no tier above it to violate.
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

/** `ManualRefundTask.reason` is `VarChar(500)`. */
const REASON_MAX_LENGTH = 500;

/**
 * Sorted-and-deduplicated dates, so an occurrence key does not depend on the
 * order the planner happened to walk the nights in.
 */
function canonicalDates(dates: readonly CalendarDate[]): string[] {
  return [...new Set(dates)].sort();
}

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
 *  4. the stored sold-price evidence the edit was judged against - the guest's
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
 * ## Why a hash rather than a readable composite key
 *
 * The material is unbounded - a stay can be a fortnight, and every night
 * contributes a date and a price - and `occurrenceKey` is one indexed column.
 * A digest is fixed-width. It is not a secret and nothing is hidden by it: the
 * whole input is stored in plain form in `reviewContext` on the same row, so the
 * key can be recomputed and checked. Canonicalisation goes through the shared
 * `stableStringify` (`INV-SSOT`) because `JSON.stringify` is insertion-ordered
 * and a key that shifts with field order is not an identity either.
 */
export function editFinancialReviewOccurrenceKey(
  occurrence: EditFinancialReviewOccurrence,
): string {
  const material = {
    bookingId: occurrence.bookingId,
    bookingGuestId: occurrence.bookingGuestId,
    cause: occurrence.cause,
    surrenderedNightDates: canonicalDates(occurrence.surrenderedNightDates),
    addedNightDates: canonicalDates(occurrence.addedNightDates),
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
  const digest = createHash("sha256")
    .update(stableStringify(material), "utf8")
    .digest("hex");
  return `${OCCURRENCE_KEY_NAMESPACE}:${OCCURRENCE_KEY_VERSION}:${digest}`;
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
  const nights = canonicalDates(occurrence.surrenderedNightDates);
  const nightsPhrase =
    nights.length === 0
      ? "no nights"
      : nights.length === 1
        ? `the night of ${nights[0]}`
        : `${nights.length} nights (${nights[0]} to ${nights[nights.length - 1]})`;
  return `Booking edit gave back ${nightsPhrase}. The exact sold price could not be read from this booking's stored history, so the club must price the adjustment from the booking's own payment and rate history before any money moves.`.slice(
    0,
    REASON_MAX_LENGTH,
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

export class EditFinancialReviewError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
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
 * modes that issue names. Typing this as `Prisma.TransactionClient` rather than
 * the module-level client makes that mistake a compile error rather than a
 * code-review question.
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
  reason,
  paymentId = null,
  raisedAmountCents = null,
  store,
}: {
  occurrence: EditFinancialReviewOccurrence;
  guestMemberId: string | null;
  bookingCheckIn: CalendarDate;
  bookingCheckOut: CalendarDate;
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
  if (
    raisedAmountCents !== null &&
    (!Number.isInteger(raisedAmountCents) || raisedAmountCents < 0)
  ) {
    // `INV-MONEY-001`: integer cents, non-negative. The DB
    // `ManualRefundTask_raised_amount_nonnegative` CHECK enforces the same rule;
    // this refuses first, with a message that names the caller's bug.
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
  };

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
          REASON_MAX_LENGTH,
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
      error.code === "P2002"
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
export async function findOpenEditFinancialReviewTask(
  bookingId: string,
  store: Prisma.TransactionClient,
): Promise<{
  id: string;
  occurrenceKey: string | null;
  amountCents: number | null;
  raisedAmountCents: number | null;
  reviewContext: Prisma.JsonValue | null;
} | null> {
  return store.manualRefundTask.findFirst({
    where: {
      bookingId,
      kind: ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW,
      status: ManualRefundTaskStatus.OPEN,
    },
    select: {
      id: true,
      occurrenceKey: true,
      amountCents: true,
      raisedAmountCents: true,
      reviewContext: true,
    },
    orderBy: { createdAt: "asc" },
  });
}
