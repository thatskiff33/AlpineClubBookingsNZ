/**
 * #3267, #4646 (`INV-PAY-081`, `INV-PAY-089`) — what a saved-card charge
 * attempt is called at Stripe: its idempotency key and its metadata, and how
 * each is read back. The contract they serve is in
 * `saved-card-charge-attempt.ts`'s module docblock.
 *
 * The key and the metadata live together because one decides the other. Stripe
 * fingerprints the whole request under a key and refuses a re-send whose
 * parameters differ ("idempotency parameter mismatch") for 24 hours. #4646 added
 * the attempt row's id to the metadata, so the webhook can adopt a row whose
 * answer was lost even when Stripe reports the capture with no request
 * (`Event.request` is null for an asynchronous capture). A row minted BEFORE
 * #4646 first sent the old metadata, and the re-send of its key must send the
 * old metadata again. So the KEY records the shape: every attempt minted now
 * carries the `_v2` key, and the metadata is a pure function of the key. One
 * key can then only ever be sent with one body, whichever code sends it, and
 * no clock or deploy date is consulted.
 */

/**
 * The one prefix every saved-card charge key carries. The ledger filters in
 * `saved-card-charge-attempt.ts` select attempt rows by it (the cron's #1992
 * pre-charge sweep excludes them; #4320's reversal judges them at their own
 * figure), and `savedCardChargeIdempotencyKey` builds the key from it, so no
 * reader and the mint can disagree about what an attempt row is
 * (`INV-SSOT-002`).
 */
export const SAVED_CARD_CHARGE_KEY_PREFIX = "pending_charge_";

/** #4646: the end of a key whose sends carry the attempt row's id in the metadata. */
const ATTEMPT_ID_IN_METADATA_KEY_SUFFIX = "_v2";

/** The key an attempt minted before #4646 carries. Nothing mints it any more. */
function preAttemptIdKey(bookingId: string, attemptRowId: string): string {
  return `${SAVED_CARD_CHARGE_KEY_PREFIX}${bookingId}_${attemptRowId}`;
}

/**
 * The idempotency key for ONE new attempt: the booking id for the operator
 * reading the Stripe dashboard, the attempt row's own id for uniqueness, and
 * the `_v2` ending that says its metadata names the row (#4646). Stored on the
 * row's `reference`, so the key can be re-sent when a first POST never
 * answered, so a row can be recognised as an attempt, and so a webhook can
 * find the row by the key Stripe stamps on the event
 * (`Stripe.Event.request.idempotency_key`) when the POST's own response was
 * lost.
 */
export function savedCardChargeIdempotencyKey(bookingId: string, attemptRowId: string): string {
  return `${preAttemptIdKey(bookingId, attemptRowId)}${ATTEMPT_ID_IN_METADATA_KEY_SUFFIX}`;
}

/**
 * Which of the two attempt keys `key` is for this booking's row, or null when
 * it is neither (not an attempt key, or another row's or booking's). The one
 * reading of an attempt key: `beginSavedCardChargeAttempt` recognises attempt
 * rows by it, the webhook's adoption checks a row's key by it, and
 * {@link buildSavedCardChargeMetadata} picks the body by it.
 *
 * - `names_attempt`: minted since #4646; its metadata carries the row's id.
 * - `pre_4646`: minted before; its metadata never did, and a re-send must not.
 */
export function savedCardChargeKeyShape(
  key: string | null | undefined,
  bookingId: string,
  attemptRowId: string,
): "names_attempt" | "pre_4646" | null {
  if (key === savedCardChargeIdempotencyKey(bookingId, attemptRowId)) return "names_attempt";
  if (key === preAttemptIdKey(bookingId, attemptRowId)) return "pre_4646";
  return null;
}

/** #4646: the metadata key a saved-card charge names its attempt row under. */
export const SAVED_CARD_ATTEMPT_ID_METADATA_KEY = "savedCardAttemptId";

/**
 * The Stripe `metadata` a saved-card charge sends — the cron, the admin
 * confirm-pending-guests route and the charge-saved-method route, byte for
 * byte. Modelled on `buildBookingCancellationRefundMetadata` (#1494): the shape
 * carries no per-path value, because the admin route's
 * `source: "admin_confirm_pending_guests"` is exactly what made Stripe refuse
 * the shared key with an idempotency parameter mismatch. Which path minted an
 * attempt is recorded on the ledger row's `reason` instead. The webhook routes
 * on `bookingId` (`appPaymentIntentRoute`); nothing downstream reads `memberId`
 * — it is dashboard-only.
 *
 * #4646: an attempt whose key is `names_attempt` also carries its row's id
 * under {@link SAVED_CARD_ATTEMPT_ID_METADATA_KEY}, which is how the webhook
 * adopts the row when the event carries no key. A `pre_4646` key — or any key
 * that is not this row's, which no caller sends — gets the old body, so the
 * re-send of a key minted before #4646 is byte for byte its first send.
 *
 * `chargeSavedCardAttempt` builds it itself from the attempt it is handed, so
 * no caller can pass a different shape; exported so the tests can pin it.
 */
export function buildSavedCardChargeMetadata(
  bookingId: string,
  /**
   * The booking OWNER's member id, or null when it is owned by an
   * `Organisation` (#3369). It is dashboard-only — nothing downstream reads it
   * — so the key is simply omitted rather than carrying an empty string or an
   * organisation id under a name that says member.
   */
  memberId: string | null,
  attempt: { readonly attemptRowId: string; readonly idempotencyKey: string },
): Record<string, string> & { bookingId: string } {
  const metadata: Record<string, string> & { bookingId: string } = memberId ? { bookingId, memberId } : { bookingId };
  if (savedCardChargeKeyShape(attempt.idempotencyKey, bookingId, attempt.attemptRowId) === "names_attempt") {
    metadata[SAVED_CARD_ATTEMPT_ID_METADATA_KEY] = attempt.attemptRowId;
  }
  return metadata;
}

/**
 * #4646: the attempt row a PaymentIntent's metadata names, or null when it names
 * none — missing, not a string, or empty. Only a hint for a lookup: the
 * webhook adopts the row only when everything else about it agrees
 * (`adoptSavedCardChargeAttemptForIntent`).
 */
export function savedCardAttemptIdFromMetadata(
  metadata: Readonly<Record<string, string | undefined>> | null | undefined,
): string | null {
  const id = metadata?.[SAVED_CARD_ATTEMPT_ID_METADATA_KEY];
  return typeof id === "string" && id.length > 0 ? id : null;
}
