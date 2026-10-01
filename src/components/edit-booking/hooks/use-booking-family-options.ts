"use client";

import { useCallback, useEffect, useState } from "react";
import type { BookerDependant } from "@/lib/booking-dependant-identity";
import type {
  FamilyMember,
  PartnerSharingCandidate,
} from "@/components/edit-booking/types";

/**
 * Load the booking OWNER's family quick-adds and partner-sharer candidates.
 *
 * Extracted from `edit-booking-panel.tsx` (#2690) with its dependency list,
 * its guard order, its failure semantics and its cleanup unchanged. The hook
 * OWNS all three pieces of state, so every setter it calls is one it created —
 * which is what lets the dependency array stay exactly what it was.
 *
 * `familyMembersLoaded` is not cosmetic. The consent prediction asks "is this
 * candidate in the booking owner's family group?", and an empty list makes
 * EVERY candidate look beyond-family — so predicting from an unloaded (or
 * failed) list would promise "waiting for Mia to approve" over the booker's own
 * child, the case where the finder is most likely to be used for one's own
 * household. An unanswered list predicts nothing at all, which under-informs
 * rather than misinforms: the server still asks whoever it must, and the
 * booking page shows the true state as soon as the edit is saved.
 */
export function useBookingFamilyOptions({
  bookingId,
  viewerRole,
}: {
  bookingId: string;
  viewerRole: string;
}): {
  familyMembers: FamilyMember[];
  familyMembersLoaded: boolean;
  partnerCandidates: PartnerSharingCandidate[];
  /**
   * The booking OWNER's recorded dependants (#3451, `INV-GUEST-019`), from the
   * same response — both family routes serve them from `loadBookerDependants`.
   * Empty until loaded, which is the safe direction: the panel simply does not
   * draw the question, and the server, which never trusts this list, refuses.
   */
  ownDependants: BookerDependant[];
  /**
   * Read the list again. Used when the server refuses an own-dependant collision
   * the panel could not see — its list is stale by definition, and it needs the
   * fresh one to draw the question at all.
   */
  reloadFamilyOptions: () => void;
} {
  const [familyMembers, setFamilyMembers] = useState<FamilyMember[]>([]);
  // MG4 (#2309): has the family list ANSWERED yet? See the note above.
  const [familyMembersLoaded, setFamilyMembersLoaded] = useState(false);
  // #1746: partner-sharer quick-adds (admin fetch only — the member family
  // route never returns them, so this stays empty for members).
  const [partnerCandidates, setPartnerCandidates] = useState<
    PartnerSharingCandidate[]
  >([]);
  const [ownDependants, setOwnDependants] = useState<BookerDependant[]>([]);
  // #3451: bumped to re-run the load below on demand.
  const [reloadCount, setReloadCount] = useState(0);
  const reloadFamilyOptions = useCallback(
    () => setReloadCount((count) => count + 1),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    // Admin on-behalf uses the bookings-scoped picker gated on bookings:edit
    // (the booking owner is resolved server-side from the booking), so a
    // Booking Officer without membership:view still gets the member's family
    // and correct member pricing (#1376). Members use their own family route.
    const familyUrl =
      viewerRole === "ADMIN"
        ? `/api/admin/bookings/${bookingId}/eligible-family`
        : "/api/members/family";

    fetch(familyUrl)
      // A NON-OK RESPONSE IS "UNKNOWN", NOT "NO FAMILY" — the same rule the
      // wizard's loader keeps, and it was broken here (MG4 #2309). Mapping a
      // 500 to `{ familyMembers: [] }` and then setting the loaded flag told
      // the consent prediction "we asked, and this booker has no family at
      // all", which makes EVERY candidate look beyond-family — including the
      // booker's own child, whose quick-add button is missing from the same
      // failed response. The prediction then promises a consent email that is
      // never sent and a held bed that does not exist. Returning null keeps the
      // guard down and predicts nothing, which under-informs instead.
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) {
          setFamilyMembers(data.familyMembers || []);
          setPartnerCandidates(data.partnerSharingCandidates || []);
          setOwnDependants(
            Array.isArray(data.ownDependants) ? data.ownDependants : [],
          );
          setFamilyMembersLoaded(true);
        }
      })
      .catch(() => {
        // Nothing to set: a thrown fetch is the same "unknown" as a non-ok
        // response, and clearing the list would only discard whatever a
        // previous successful load had already put on screen.
      });

    return () => {
      cancelled = true;
    };
    // `reloadCount` is the #3451 on-demand re-read; it changes nothing else.
  }, [bookingId, viewerRole, reloadCount]);

  return {
    familyMembers,
    familyMembersLoaded,
    partnerCandidates,
    ownDependants,
    reloadFamilyOptions,
  };
}
