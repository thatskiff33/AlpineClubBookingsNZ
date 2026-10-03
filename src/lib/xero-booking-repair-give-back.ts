import { recordedCreditGiveBack } from "@/lib/booking-credit-give-back-marker";
import { asRecord, readString } from "@/lib/xero-json";
import { isGiveBackNoteScope, queuedReviewTaskId } from "@/lib/xero-review-task-key";

/**
 * #3809 (review M1): the edit's SECOND invoice-allocated note - applied credit
 * given back beside a card or bank refund's note or a credit election's
 * unallocated one - is scoped (`giveBackNoteScope`) on its
 * operation's payload and on the links it records. The repair pass reads the
 * edit's own note without it, so the one cannot hide the other, and checks the
 * give-back's separately.
 */
function isGiveBackScoped(item: { requestPayload?: unknown; metadata?: unknown }): boolean {
  if ("requestPayload" in item && isGiveBackNoteScope(queuedReviewTaskId({ requestPayload: item.requestPayload }))) {
    return true;
  }
  return isGiveBackNoteScope(readString(asRecord(item.metadata)?.reviewTaskId));
}

/** An edit's links and operations without its scoped give-back note's. */
export function withoutGiveBackNote<L extends { metadata?: unknown }, O extends { requestPayload: unknown }>(
  links: L[],
  operations: O[],
): { links: L[]; operations: O[] } {
  return {
    links: links.filter((link) => !isGiveBackScoped(link)),
    operations: operations.filter((operation) => !isGiveBackScoped(operation)),
  };
}

/**
 * Where the edit's history row records applied credit given back beside money
 * captured (so the give-back took a note of its own), whether that note is
 * present: the scoped operations, or nothing where none is due. `null` means
 * there is nothing to check here.
 */
export function scopedGiveBackNote<O extends { entityType: string; operationType: string; requestPayload: unknown }>({
  newData,
  operations,
  paymentHasCapturedMoney,
}: {
  newData: unknown;
  operations: O[];
  paymentHasCapturedMoney: boolean;
}): { givenBackCents: number; operations: O[] } | null {
  const recorded = recordedCreditGiveBack(newData);
  if (!paymentHasCapturedMoney || !recorded || recorded.givenBackCents <= 0) return null;
  return {
    givenBackCents: recorded.givenBackCents,
    operations: operations.filter(
      (operation) => operation.entityType === "CREDIT_NOTE" && operation.operationType === "CREATE" && isGiveBackScoped(operation),
    ),
  };
}
