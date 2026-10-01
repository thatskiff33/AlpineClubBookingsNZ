/**
 * What a policy-exception request carries out of a pending modification, and what
 * it has to leave behind (#2562).
 *
 * Moved verbatim from `edit-booking-panel.tsx` (#2690).
 * `exceptionRequestPayloadFromModification` is re-exported from the panel, which
 * is where `edit-booking-panel-exception-request.test.tsx` imports it from.
 */

/**
 * The parts of a pending modification that a policy-exception proposal cannot
 * carry (#2562), named for the member.
 *
 * The proposal shape is a party and a set of nights — dates, guests added, guests
 * removed, per-guest stay ranges. Everything else this panel can send is a
 * different kind of change, so an approval will not apply it, and the request card
 * says so before the member submits rather than leaving them to discover it. The
 * list is derived from the ACTUAL payload keys, so a key added to the builder
 * later cannot be silently dropped without appearing here.
 */
const EXCEPTION_PROPOSAL_PAYLOAD_KEYS = [
  "checkIn",
  "checkOut",
  "addGuests",
  "removeGuestIds",
  "guestStayRanges",
  // #3451: the answers about added guests travel WITH the proposal — the request
  // door re-checks them and freezes them for the approval's replay.
  "dependantIdentityDeclarations",
] as const;

/**
 * The omitted payload keys that change what the club would CHARGE (#2562 review).
 *
 * WHY THIS MATTERS ON SCREEN. `modify-quote` prices the WHOLE payload the member
 * typed: `netChargeCents` is built from `newFinalPriceCents = newTotalPriceCents +
 * newPromoAdjustmentCents`, so a promo in the payload is baked into the figure.
 * The exception request carries none of that, so the frozen proposal prices
 * without it — and the card was printing the promo-inclusive number directly above
 * its own warning that the promo is not included. The two contradicted each other
 * and the number was the wrong one.
 *
 * `linkGuestToMember` is in this set deliberately: linking a placeholder guest to
 * a real member can move that guest onto member rates, so it is a price change
 * dressed as a tidy-up. `settlementMethod`, `guestUpdates`,
 * `memberReviewJustification`, `confirmOverCapacity` and `notifyMember` are not:
 * they change how a change is settled, recorded or announced, never its price.
 */
const EXCEPTION_PRICE_AFFECTING_OMITTED_KEYS: ReadonlySet<string> = new Set([
  "promoCode",
  "removePromoCode",
  "promoGuestIds",
  "promoAddedGuestIndexes",
  "applyCreditCents",
  "partnerSharedGuests",
  "linkGuestToMember",
  "adminOverride",
  "pricingMode",
]);

const EXCEPTION_OMITTED_CHANGE_LABELS: Record<string, string> = {
  guestUpdates: "guest name corrections",
  linkGuestToMember: "linking a placeholder guest to a member",
  promoCode: "the promo code",
  removePromoCode: "removing the promo code",
  promoGuestIds: "who the promo code applies to",
  promoAddedGuestIndexes: "who the promo code applies to",
  applyCreditCents: "using account credit",
  partnerSharedGuests: "partner-shared places",
  adminOverride: "the admin date override",
  pricingMode: "the admin pricing mode",
  confirmOverCapacity: "the over-capacity confirmation",
  settlementMethod: "how a refund is settled",
  memberReviewJustification: "the review reason",
};

export function exceptionRequestPayloadFromModification(
  body: Record<string, unknown>,
): {
  payload: Record<string, unknown>;
  omittedChanges: string[];
  /**
   * True when at least one dropped key would have changed the price, so the
   * quote's `netChargeCents` is NOT the figure the frozen proposal would produce
   * and must not be shown as one.
   */
  omitsPricedChange: boolean;
} {
  const payload: Record<string, unknown> = {};
  for (const key of EXCEPTION_PROPOSAL_PAYLOAD_KEYS) {
    if (body[key] !== undefined) payload[key] = body[key];
  }
  const omitted = new Set<string>();
  let omitsPricedChange = false;
  for (const key of Object.keys(body)) {
    if ((EXCEPTION_PROPOSAL_PAYLOAD_KEYS as readonly string[]).includes(key)) {
      continue;
    }
    // An unknown key is still reported, by its own name, rather than dropped
    // silently: a wrong-looking word on screen is recoverable, a change the member
    // believes they submitted is not.
    omitted.add(EXCEPTION_OMITTED_CHANGE_LABELS[key] ?? key);
    // FAIL SAFE on an unrecognised key: assume it moved the price. Suppressing a
    // figure costs the member a sentence about normal rates; showing a figure no
    // approval can produce costs them the difference.
    if (
      EXCEPTION_PRICE_AFFECTING_OMITTED_KEYS.has(key) ||
      !(key in EXCEPTION_OMITTED_CHANGE_LABELS)
    ) {
      omitsPricedChange = true;
    }
  }
  return { payload, omittedChanges: [...omitted].sort(), omitsPricedChange };
}

/**
 * The identity of the PROPOSAL inside a pending modification (#2562 re-review).
 *
 * An offer to ask a Booking Officer describes ONE refused proposal: these dates,
 * this party, these per-guest ranges. The panel used to keep the offer in a plain
 * state slot and rely on the debounced quote effect to clear it, which it does not
 * do: the effect only clears on a RESOLVED quote or an empty payload, so a member
 * who moved a date after a refusal was still shown the old rule's wording and the
 * old payload's figure — labelled as the club's quote for "this proposal as it
 * stands" — for as long as they kept editing, and a failed quote left the offer
 * standing indefinitely. Submitting inside that window posts the CURRENT payload
 * while they read the previous one, and a now-legal proposal comes back 400
 * `NoEligiblePolicyExceptionError`, which has no remedy branch on the card.
 *
 * So the offer is stored WITH this signature and compared during render, exactly as
 * the new-booking wizard does (`exceptionProposalSignature` in
 * `use-booking-wizard.ts`): a mismatch retires it in the same render the change
 * lands in, with no frame in which the stale card is on screen.
 *
 * Narrowed through `exceptionRequestPayloadFromModification` on purpose, so the
 * signature covers exactly what the request would carry. Changing a promo code or a
 * settlement choice does not retire an offer — those are not part of the proposal an
 * officer would freeze, and the card already refuses to show a figure that was
 * priced with them.
 */
export function exceptionProposalSignature(
  body: Record<string, unknown>,
): string {
  return JSON.stringify(exceptionRequestPayloadFromModification(body).payload);
}

/**
 * The same signature for a payload that has already been serialised — the form the
 * quote fetch holds. FAILS CLOSED: a body that will not parse yields a signature
 * that matches nothing, so the offer retires rather than outliving its proposal.
 */
export function exceptionProposalSignatureFromJson(payloadJson: string): string {
  try {
    const parsed = JSON.parse(payloadJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    return exceptionProposalSignature(parsed as Record<string, unknown>);
  } catch {
    return "";
  }
}
