"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  quotePayloadAddsGuests,
  quoteRefusalMessage,
} from "@/components/edit-booking/quote-refusal";
import { exceptionProposalSignatureFromJson } from "@/components/edit-booking/exception-request-payload";
import type { QuoteResult } from "@/components/edit-booking/types";
import { readExceptionOffer, type ExceptionOffer } from "@/lib/booking-exception-offer";
import { isDependantIdentityRefusalCode } from "@/lib/booking-dependant-identity";
import {
  MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE,
  MEMBER_GUEST_NOT_ADDABLE_CODE,
} from "@/lib/member-guest-refusal";

/**
 * The quote the panel is currently showing, and the setters the fetch writes.
 *
 * WHY THIS IS A SEPARATE CALL FROM THE FETCH BELOW. The modification payload is
 * built from `desiredElectionCents`, which is derived from the CURRENT quote —
 * so the payload the fetch is keyed on cannot be computed until this state
 * exists. That was free while both lived in one component body (the `useState`
 * simply sat above the builder); as a hook it has to be two calls in the same
 * order. Declaring the state here and the flow below keeps every dependency
 * array and the effect's position in the panel's effect order exactly as they
 * were (#2690).
 */
export function useModificationQuoteState() {
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState("");
  return { quote, setQuote, quoteLoading, setQuoteLoading, quoteError, setQuoteError };
}

/**
 * Price the pending edit, 500ms after the member stops typing.
 *
 * Extracted from `edit-booking-panel.tsx` (#2690) with the fetch, both refs, the
 * debounce effect, the guard order and the 500ms window unchanged.
 *
 * THE ONE DEPENDENCY-ARRAY CHANGE IN THIS REFACTOR, declared here rather than
 * left to be noticed. `fetchQuote` was `useCallback(..., [booking.id])` while it
 * sat in the component body, because the seven state setters it calls were
 * declared there and `react-hooks/exhaustive-deps` knows a setter destructured
 * from `useState` is stable. Across a hook boundary they arrive as parameters,
 * where the linter can no longer prove that, so they are named in the array.
 *
 * That is safe, and the reason is specific rather than general: React guarantees
 * the identity of a `useState` setter for the lifetime of the component, so
 * every added entry is constant and the memo can never invalidate for a reason
 * it did not invalidate for before. `bookingId` remains the only entry that can
 * actually change. Holding them in a ref instead would have kept the array
 * literally identical, but writing a ref during render is what
 * `react-hooks/refs` forbids, and that rule is enabled here as an error.
 *
 * `edit-booking-panel-quote-debounce.test.tsx` is the guard: it fails if this
 * arm ever re-arms the timer on its own output, which is the failure mode a
 * wrong dependency list produces here and the one no rendered-output assertion
 * would catch.
 */
export function useDebouncedModificationQuote({
  bookingId,
  modificationPayloadJson,
  setQuote,
  setQuoteLoading,
  setQuoteError,
  setMemberGuestAddError,
  setExceptionOfferState,
  setSaveOverCapacityNights,
  setSettlementMethod,
  onDependantIdentityRefusal,
}: {
  bookingId: string;
  /** The serialised pending modification, or null when there is nothing to price. */
  modificationPayloadJson: string | null;
  setQuote: (value: QuoteResult | null) => void;
  setQuoteLoading: (value: boolean) => void;
  setQuoteError: (value: string) => void;
  /**
   * The four slots a quote answer writes that are NOT the quote itself. Each is
   * also written by the save path or by a guest/promo handler, so they belong to
   * the panel — but the quote is one of their writers, and its writes have to
   * happen in the order they always did.
   */
  setMemberGuestAddError: (value: string | null) => void;
  setExceptionOfferState: (
    value: { offer: ExceptionOffer; proposalSignature: string } | null,
  ) => void;
  setSaveOverCapacityNights: (
    value: { date: string; availableBeds: number }[] | null,
  ) => void;
  setSettlementMethod: (value: "card" | "credit" | null) => void;
  /**
   * #3451 (`INV-GUEST-019`): the quote was refused because an ADDED guest shares
   * a name with one of the booking owner's recorded dependants. The panel decides
   * what that means for its answers — the refusal itself is already shown as
   * `quoteError`. Must be stable (a `useCallback`), like the setters above.
   */
  onDependantIdentityRefusal?: (code: string) => void;
}): void {
  const quoteTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Monotonic id per quote request so a slow, superseded response can never
  // overwrite the quote for the user's latest edit.
  const quoteRequestSeqRef = useRef(0);

  const fetchQuote = useCallback(
    async (payloadJson: string) => {
      const seq = ++quoteRequestSeqRef.current;
      setQuoteError("");
      setQuoteLoading(true);

      try {
        const res = await fetch(`/api/bookings/${bookingId}/modify-quote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payloadJson,
        });

        const data = await res.json();
        // A newer edit superseded this request; drop the stale response.
        if (seq !== quoteRequestSeqRef.current) return;
        if (!res.ok) {
          const addsGuests = quotePayloadAddsGuests(payloadJson);
          setQuoteError(quoteRefusalMessage(data, addsGuests));
          // MG4 (#2309): D-8's collapsed refusal about an add the booker just
          // made is ALSO shown inside the find panel, beside the person it is
          // about. Only that one code, and only when the request actually tried
          // to add somebody — see `quotePayloadAddsGuests` for why a refusal on
          // a request that added nobody must not be re-attributed to an add.
          setMemberGuestAddError(
            addsGuests && data?.code === MEMBER_GUEST_NOT_ADDABLE_CODE
              ? MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE
              : null,
          );
          setQuote(null);
          if (
            onDependantIdentityRefusal &&
            isDependantIdentityRefusalCode(data?.code)
          ) {
            onDependantIdentityRefusal(data.code);
          }
          // #2562: a refused QUOTE is a real blockage on this path — the member
          // cannot save what they cannot price — so the reviewable ones open the
          // request door here rather than making them press Save to find out.
          //
          // Recorded against THE PAYLOAD THIS FETCH SENT, not against whatever is on
          // screen when the answer lands (#2562 re-review): the fetch is debounced,
          // so the member may have edited on since, and the offer belongs to the
          // proposal the server actually refused. The render comparison then retires
          // it immediately if that is no longer what they are proposing.
          const offer = readExceptionOffer(data);
          setExceptionOfferState(
            offer
              ? {
                  offer,
                  proposalSignature:
                    exceptionProposalSignatureFromJson(payloadJson),
                }
              : null,
          );
          return;
        }
        setMemberGuestAddError(null);
        setQuote(data);
        // A quote that came back is not a refusal, so no request is on offer.
        // Cleared here rather than only on the next attempt, so a member who fixes
        // the proposal is not still looking at a door they no longer need.
        setExceptionOfferState(null);
        // A fresh quote that no longer needs an over-capacity confirm clears any
        // stale apply-side warning (#1668).
        if (!data.overCapacityConfirmRequired) {
          setSaveOverCapacityNights(null);
        }
        if (!data.settlementOptions?.requiresSettlementMethod) {
          setSettlementMethod(null);
        }
      } catch {
        if (seq !== quoteRequestSeqRef.current) return;
        setQuoteError("Failed to get quote");
        setQuote(null);
      } finally {
        if (seq === quoteRequestSeqRef.current) {
          setQuoteLoading(false);
        }
      }
    },
    [
      bookingId,
      setQuote,
      setQuoteLoading,
      setQuoteError,
      setMemberGuestAddError,
      setExceptionOfferState,
      setSaveOverCapacityNights,
      setSettlementMethod,
      onDependantIdentityRefusal,
    ],
  );

  // Auto-fetch quote when changes happen (debounced). The effect is keyed on
  // the serialized payload, not on callback identity: several payload inputs
  // (e.g. remainingGuests) are recomputed objects, so a callback dependency
  // changes on every render — including the render caused by a completed
  // fetch — which re-armed the timer and refetched in an endless 500ms loop.
  // Under an override the pricing-mode radio must be chosen before the quote
  // fires — otherwise a member-shaped quote would run and (for a fully-past
  // booking) error, confusing the admin.
  useEffect(() => {
    if (quoteTimeoutRef.current) clearTimeout(quoteTimeoutRef.current);
    if (!modificationPayloadJson) {
      setQuote(null);
      setExceptionOfferState(null);
      return;
    }
    quoteTimeoutRef.current = setTimeout(
      () => fetchQuote(modificationPayloadJson),
      500,
    );
    return () => {
      if (quoteTimeoutRef.current) clearTimeout(quoteTimeoutRef.current);
    };
    // Same declaration as `fetchQuote` above: `setQuote` and
    // `setExceptionOfferState` join the original `[fetchQuote,
    // modificationPayloadJson]` because they are now parameters rather than
    // locally-declared setters. Both are `useState` setters with React-guaranteed
    // stable identity, so the effect still re-runs on exactly the two things it
    // ever re-ran on.
  }, [fetchQuote, modificationPayloadJson, setQuote, setExceptionOfferState]);
}
