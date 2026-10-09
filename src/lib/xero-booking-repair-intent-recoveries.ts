/**
 * The booking-vs-Xero repair pass's reading of OPEN additional-intent mint
 * recoveries, per booking - split from `xero-booking-repair-load.ts` (#3954
 * review round 4) to keep the loader inside its size budget. Code moved, plus
 * the ordinary edit's key.
 *
 * Two keys, two maps, so neither is ever read as the other's:
 *
 * - a COMPLETED financial review's charge (#3187): its edit's supplementary
 *   invoice is deferred while the replay still owes the request;
 * - an ORDINARY edit's (#3954): a reduction whose smaller re-issued ask has not
 *   been minted yet - its own recovery still open - is deferred rather than
 *   reported as missing the invoice that mint will raise.
 */
import {
  buildAdditionalIntentRecoveryIdempotencyKey,
  buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey,
  isEditFinancialReviewAdditionalIntentRecoveryKey,
} from "./payment-recovery-keys";

export type IntentRecoveryKeyMaps = {
  review: Map<string, string>;
  ordinary: Map<string, string>;
};

/**
 * The recovery key each loaded edit would have written had its intent mint
 * failed, so the query matches by EXACT key and reads the anchor back out of
 * these maps rather than by slicing a prefix off a string - the mistake
 * `bookingModificationIdForAdditionalIntentRecoveryKey` documents.
 */
export function intentRecoveryKeyMaps(modificationIds: readonly string[]): IntentRecoveryKeyMaps {
  return {
    review: new Map(
      modificationIds.map((modificationId) => [
        buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey(modificationId),
        modificationId,
      ]),
    ),
    ordinary: new Map(
      modificationIds.map((modificationId) => [buildAdditionalIntentRecoveryIdempotencyKey(modificationId), modificationId]),
    ),
  };
}

/**
 * Per BOOKING, and for the same reason as the review shares: a recovery row is
 * joined to its edit through a key, and a key naming a modification on a
 * DIFFERENT booking must not defer this one's repair.
 */
export function groupOpenIntentRecoveriesByBooking(
  recoveries: readonly { bookingId: string; idempotencyKey: string }[],
  maps: IntentRecoveryKeyMaps,
): { review: Map<string, Set<string>>; ordinary: Map<string, Set<string>> } {
  const review = new Map<string, Set<string>>();
  const ordinary = new Map<string, Set<string>>();
  const add = (byBooking: Map<string, Set<string>>, bookingId: string, modificationId: string) => {
    const anchors = byBooking.get(bookingId) ?? new Set<string>();
    anchors.add(modificationId);
    byBooking.set(bookingId, anchors);
  };
  for (const recovery of recoveries) {
    const ordinaryModificationId = maps.ordinary.get(recovery.idempotencyKey);
    if (ordinaryModificationId) {
      add(ordinary, recovery.bookingId, ordinaryModificationId);
      continue;
    }
    // Redundant with the exact-key `in` filter, and deliberately kept: if that
    // query is ever widened, an ORDINARY edit's recovery row must not be read
    // as a review charge's. Fail closed rather than defer the wrong edit.
    if (!isEditFinancialReviewAdditionalIntentRecoveryKey(recovery.idempotencyKey)) continue;
    const modificationId = maps.review.get(recovery.idempotencyKey);
    if (modificationId) add(review, recovery.bookingId, modificationId);
  }
  return { review, ordinary };
}
