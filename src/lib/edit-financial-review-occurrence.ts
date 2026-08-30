import "server-only";

import { ManualRefundTaskStatus, Prisma } from "@prisma/client";
import { stableDigest } from "@/lib/stable-digest";
import { canonicalNights } from "@/lib/stable-json";
import type { EditFinancialReviewOccurrence } from "@/lib/edit-financial-review-context";
import { MANUAL_REFUND_TASK_REASON_MAX } from "@/lib/manual-subscription-payment";

/**
 * #3030/#3166 (epic #2797): the IDENTITY of one unpriceable structural edit, and
 * where its next review task goes.
 *
 * Split out of `edit-financial-review.ts` when #3166 doubled the size of the
 * question. That module owns the STATE — raising a task, fencing a second edit,
 * reading one back — and this one owns the single question it asks first: *is
 * this edit the same occurrence as one already on file, and if not, under what
 * key does the new one go?*
 *
 * They are separable because the boundary between them is exactly one value: a
 * key, and a slot to write it in. Nothing here writes a row, moves money, or
 * knows what a task is for; nothing there re-derives a key.
 *
 * Read this file top to bottom — the key's material, why the stored evidence is
 * in it, why the recurrence ordinal is NOT, and the walk that spends it — before
 * changing any of it. The version constant below is a hinge, and the digest is
 * pinned by a test that exists to make changing it deliberate.
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
 * THAT IS NECESSARY AND WAS NOT SUFFICIENT (#3166). It rests on the edit
 * changing the evidence, and the pre-check-in guest-add parks WITHOUT changing
 * any of the material above - no night is surrendered, none is added, and a
 * parked add writes nothing to `BookingGuest` or `BookingGuestNight`, so the
 * identity is stable across every repeat. `findFreeOccurrenceSlot` is what makes
 * a settled task stop suppressing the next occurrence; read its docblock for the
 * money that was walking out of the door and why the ordinal sits outside this
 * digest rather than inside it.
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
 * How many times ONE occurrence identity may recur before the raise refuses.
 *
 * Not a policy limit - it is a runaway guard on the walk below, which is the
 * only unbounded loop in this module. Fifty settled reviews of the identical
 * structural edit on one booking is not a club's booking history, it is a
 * defect, and looping for ever against the database is a worse way to find out.
 */
export const MAX_OCCURRENCE_RECURRENCES = 50;

/**
 * The stored key for the `n`th time one occurrence identity has come round.
 *
 * The first is the digest itself, so every key already on file keeps matching
 * its row and the pinned digest in `edit-financial-review.test.ts` is still the
 * key a first raise writes. Later ones carry a `#n` suffix OUTSIDE the digest,
 * which is what keeps the "recompute the key from `reviewContext` and check it"
 * property the key's own docblock claims: recomputing yields the base, and the
 * row's key is the base plus an optional recurrence suffix.
 */
function occurrenceKeyForRecurrence(
  baseOccurrenceKey: string,
  recurrence: number,
): string {
  return recurrence === 1
    ? baseOccurrenceKey
    : `${baseOccurrenceKey}#${recurrence}`;
}

/**
 * #3166: WHERE THIS RAISE GOES - the open task already holding this occurrence,
 * or the first free key for a new one.
 *
 * ## The money this closes
 *
 * The find-then-create this replaces matched on the base key REGARDLESS OF
 * STATUS, so a task that had been completed or dismissed suppressed every later
 * raise of the same occurrence identity for ever. The key's own docblock names
 * that failure ("the raise finds a terminal row, declines to create anything,
 * and the second adjustment is never reviewed by anybody") and answers it by
 * putting the guest's stored evidence in the hash - which works only when the
 * edit CHANGES that evidence.
 *
 * #3166 makes an occurrence that changes nothing the ordinary case, on the
 * busiest door in the product. Adding a guest surrenders no nights and adds
 * none, and a parked add writes nothing to `BookingGuest` or
 * `BookingGuestNight` - so the key is a pure function of the unchanged stored
 * evidence, and settling a task never moves it. Worked through: add a $320
 * guest to a booking whose history cannot be read, park, an officer prices and
 * completes the task; add a second $320 guest, and the raise finds the COMPLETED
 * row, creates nothing, and every downstream reader is filtered on OPEN - so
 * there is no banner, no email flag, and no fence on the third add. Ten guests
 * over a season is $3,200 the club never sees and never hears about.
 *
 * ## What "already raised" now means
 *
 * An OPEN task, and only an OPEN task. That is the state a replay must collapse
 * into, and a replay is the only thing the dedup was ever for: a raise and the
 * edit that caused it share one transaction, so a retry can only ever find its
 * predecessor's task OPEN or find nothing at all. A TERMINAL task is not a
 * replay - it is a question somebody already answered, and the edit in front of
 * us is asking a new one.
 *
 * ## THE TWO RULES LOOK IDENTICAL AND ARE NOT, AND STATUS IS WHAT SEPARATES THEM
 *
 * Two money rules sit on this walk and read like the same rule. *A replay of one
 * edit must not produce a second adjustment.* And *a second, genuinely new edit
 * of the same shape must raise its own task.* They are distinguishable, and the
 * status of the row at the base key is the whole discriminator. That is worth
 * setting out, because the obvious reading - "identical input, therefore the
 * same edit" - is what the pre-#3166 code believed, and it is false here.
 *
 * A REPLAY CANNOT SEE A TERMINAL ROW. For any row to be visible at all, the
 * predecessor's transaction must have COMMITTED - the raise runs inside the
 * caller's transaction (enforced at the top of `raiseEditFinancialReviewTask`),
 * so a rolled-back attempt takes its task with it and the retry finds nothing.
 * Once it has committed, the edit is done and there is nothing left to retry;
 * the only replays that reach a committed predecessor are a concurrent apply and
 * a retry of a request whose commit the client never heard about, and both land
 * within the same request, long before any officer can settle anything. So a
 * replay finds OPEN, or it finds nothing.
 *
 * A TERMINAL ROW IS ALWAYS A NEW EDIT, and the pending-review FENCE is what
 * makes that airtight rather than merely likely. Every money-affecting door
 * takes `pg_advisory_xact_lock(1)` and then calls
 * `assertNoPendingEditFinancialReview` before it writes anything, so a new edit
 * cannot even reach this walk while ANY `EDIT_FINANCIAL_REVIEW` task on that
 * booking is OPEN. Reaching here and finding the base key COMPLETED or DISMISSED
 * therefore means: an officer answered that question, the fence then let a
 * FURTHER edit through, and that further edit is the one in front of us. It is
 * owed its own review.
 *
 * WHICH FAILURE EACH READING WOULD BUY. Treating a terminal row as a replay is
 * the money this walk closes - silent, and unbounded: no task, no charge, no
 * banner, repeating for every guest added after the first. Treating an OPEN row
 * as a new edit would buy the opposite - two tasks for one edit, which an
 * officer sees on one booking and can dismiss. Neither is acceptable and neither
 * has to be accepted, because the fence and the transaction boundary between
 * them leave no case where the two readings both apply.
 *
 * Pinned against a real server by
 * `edit-financial-review-races.realdb.test.ts`, which asserts BOTH directions -
 * a replay of an OPEN occurrence writing nothing further, and a new occurrence
 * of a SETTLED identity getting its own row while the settled one is left as the
 * officer left it.
 *
 * ## Why a suffix rather than widening the hashed material
 *
 * `bookingModificationId` is the obvious discriminator and is the wrong one: a
 * retried edit writes a NEW modification row, so hashing it would make every
 * retry a fresh task and lose the replay dedup this walk exists to keep. The
 * recurrence ordinal is not part of the occurrence's identity at all - it is
 * which turn of that identity this is - so it belongs beside the digest rather
 * than inside it, and `OCCURRENCE_KEY_VERSION` does not move.
 *
 * TERMINAL ROWS ARE NEVER TOUCHED. Nothing here reopens, amends or re-reads a
 * settled task; the audit of what an officer decided the first time stays
 * exactly as they left it, and the new question gets its own row. A booking
 * legitimately holding more than one review is already the model
 * (`booking-financial-review-visibility.ts` says so in as many words).
 *
 * Walked one indexed unique lookup at a time rather than with a `startsWith`
 * scan, because `occurrenceKey`'s btree serves equality under any collation and
 * a prefix `LIKE` does not. The realistic depth is one.
 */
export async function findFreeOccurrenceSlot(
  store: Prisma.TransactionClient,
  baseOccurrenceKey: string,
): Promise<
  | {
      kind: "open";
      occurrenceKey: string;
      task: { id: string; status: ManualRefundTaskStatus };
    }
  | { kind: "free"; occurrenceKey: string }
  | { kind: "exhausted" }
> {
  for (
    let recurrence = 1;
    recurrence <= MAX_OCCURRENCE_RECURRENCES;
    recurrence += 1
  ) {
    const occurrenceKey = occurrenceKeyForRecurrence(
      baseOccurrenceKey,
      recurrence,
    );
    const existing = await store.manualRefundTask.findUnique({
      where: { occurrenceKey },
      select: { id: true, status: true },
    });
    if (!existing) return { kind: "free", occurrenceKey };
    if (existing.status === ManualRefundTaskStatus.OPEN) {
      return { kind: "open", occurrenceKey, task: existing };
    }
  }
  // The caller raises the failure, because the error class belongs to the module
  // that owns the state rather than to this one.
  return { kind: "exhausted" };
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
