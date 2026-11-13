"use client";

import { useEffect, useRef, useState } from "react";

/** What `GET /api/work-parties/[id]` returns that the prefill needs. */
type WorkPartyPrefill = {
  id: string;
  name: string;
  lodgeId: string | null;
  checkIn: string;
  checkOut: string;
};

export const WORK_PARTY_PREFILL_UNAVAILABLE_NOTICE =
  "That work party can no longer be joined, so nothing was filled in. You can still book as usual.";

export const WORK_PARTY_PREFILL_LODGE_NOTICE =
  "You can't book the lodge that work party is held at, so nothing was filled in.";

/**
 * "Join Work Party" (fork #118): `/book?workParty=<id>` opens the booking page
 * with the work party's stay, its lodge and the working-bee option filled in.
 *
 * The work party id is the ONLY input — the dates come from the server
 * (`GET /api/work-parties/[id]`, its `join` stay), never from the URL, so there
 * is one source of them. The member still chooses guests and pays as usual,
 * and every booking rule still applies: the dates go through the wizard's own
 * `handleDateSelect`, exactly as a calendar pick would, and the server
 * re-validates the work party when the booking is created.
 *
 * Steps, each taken once:
 * 1. Fetch the work party. Unknown, inactive, past, or not visible to this
 *    account (the API's 404) → a short notice and nothing filled in.
 * 2. Once the lodge list has loaded successfully, select the work party's
 *    lodge (a club-wide work party keeps the member's own lodge). A lodge the
 *    member cannot book → a notice and nothing filled in. A list that failed
 *    to load decides nothing; the wizard's own "Try again" reloads it.
 * 3. Once that lodge is the settled scope, the wizard is on the dates step and
 *    the subscription check has answered, select the stay — unless bookings
 *    are blocked (an unpaid subscription), where the dates step's own message
 *    stands and nothing is filled in.
 *
 * A member who has already picked dates or moved past the dates step before
 * the work party arrives keeps their own choice: the prefill is dropped.
 * 4. When the review step lists the working bees for the stay, tick this one
 *    (`takePendingSelection`), unless the member has already chosen.
 */
export function useWorkPartyPrefill({
  workPartyId,
  lodgeIds,
  lodgesSettled,
  lodgeId,
  scopedLodgeId,
  onDatesStep,
  memberStarted,
  bookingBlocked,
  selectLodge,
  selectDates,
}: {
  workPartyId: string | null;
  lodgeIds: readonly string[];
  /** The lodge list loaded successfully (not loading, failed or forbidden). */
  lodgesSettled: boolean;
  lodgeId: string | null;
  scopedLodgeId: string | null;
  onDatesStep: boolean;
  /** The member has picked dates or left the dates step. */
  memberStarted: boolean;
  /** Bookings are blocked (unpaid subscription); null while still checking. */
  bookingBlocked: boolean | null;
  selectLodge: (lodgeId: string) => void;
  selectDates: (checkIn: string, checkOut: string) => void;
}) {
  const [prefill, setPrefill] = useState<WorkPartyPrefill | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const datesAppliedRef = useRef(false);
  const lodgeAppliedRef = useRef(false);
  const pendingSelectionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!workPartyId) return;
    const controller = new AbortController();
    fetch(`/api/work-parties/${encodeURIComponent(workPartyId)}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        const data = res.ok ? await res.json() : null;
        const workParty = data?.workParty;
        if (!workParty?.join) {
          setNotice(WORK_PARTY_PREFILL_UNAVAILABLE_NOTICE);
          return;
        }
        pendingSelectionRef.current = workParty.id;
        setPrefill({
          id: workParty.id,
          name: workParty.name,
          lodgeId: workParty.lodgeId ?? null,
          checkIn: workParty.join.checkIn,
          checkOut: workParty.join.checkOut,
        });
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setNotice(WORK_PARTY_PREFILL_UNAVAILABLE_NOTICE);
      });
    return () => controller.abort();
  }, [workPartyId]);

  const lodgeRefused =
    prefill?.lodgeId != null &&
    lodgesSettled &&
    !lodgeIds.includes(prefill.lodgeId);

  // Drop the prefill for good: nothing more is selected or ticked.
  function abandon() {
    lodgeAppliedRef.current = true;
    datesAppliedRef.current = true;
    pendingSelectionRef.current = null;
  }

  useEffect(() => {
    if (!prefill || datesAppliedRef.current || !memberStarted) return;
    abandon();
  }, [prefill, memberStarted]);

  useEffect(() => {
    if (!prefill || lodgeAppliedRef.current || !lodgesSettled) return;
    lodgeAppliedRef.current = true;
    if (!prefill.lodgeId) return;
    if (lodgeRefused) {
      abandon();
      setNotice(WORK_PARTY_PREFILL_LODGE_NOTICE);
      return;
    }
    if (lodgeId !== prefill.lodgeId) selectLodge(prefill.lodgeId);
  }, [prefill, lodgesSettled, lodgeRefused, lodgeId, selectLodge]);

  useEffect(() => {
    if (!prefill || datesAppliedRef.current || !lodgeAppliedRef.current) return;
    if (!onDatesStep || !scopedLodgeId || bookingBlocked === null) return;
    if (bookingBlocked) {
      abandon();
      return;
    }
    if (prefill.lodgeId && scopedLodgeId !== prefill.lodgeId) return;
    datesAppliedRef.current = true;
    selectDates(prefill.checkIn, prefill.checkOut);
  }, [prefill, onDatesStep, scopedLodgeId, bookingBlocked, selectDates]);

  /**
   * The work party to tick on the review step, once: returns its id when it is
   * among the working bees listed for the stay, and clears it either way so a
   * member who unticks it, or changes the dates, is not overridden.
   */
  function takePendingSelection(
    events: ReadonlyArray<{ id: string }>,
  ): string | null {
    const pending = pendingSelectionRef.current;
    if (!pending || !datesAppliedRef.current) return null;
    pendingSelectionRef.current = null;
    return events.some((event) => event.id === pending) ? pending : null;
  }

  return {
    workPartyPrefillNotice: notice,
    workPartyPrefillName: prefill?.name ?? null,
    takePendingWorkPartySelection: takePendingSelection,
  };
}
