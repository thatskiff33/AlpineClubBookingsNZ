"use client";

import { useCallback, useMemo, useState } from "react";
import type { BookingData } from "@/components/edit-booking/types";

/**
 * The reciprocal "other club member" rate election, as the edit panel holds it
 * (Other Lodges epic, follow-up to #2749).
 *
 * The officer ticks "Member of Other Lodge", names the partner lodge, and then
 * ticks the individual NON-MEMBER guests who belong to it. Each tick reprices
 * that person at the club's own member rate for their age tier; unticking puts
 * them back on the non-member rate. Everything here is a PROPOSAL: nothing is
 * written until Save, and the money it moves is shown by the debounced quote
 * first, exactly like every other change on this screen.
 *
 * WHY A HOOK RATHER THAN MORE PANEL STATE. Three pieces of state that must move
 * together — clearing the lodge has to clear every tick, or the officer saves a
 * set of member-rated guests with no club recorded against them and the server
 * refuses. Keeping the transitions in one place is what makes that impossible to
 * get half-right, and it keeps the panel shell from growing another concern.
 */

export interface OtherLodgeRateState {
  /**
   * Whether this viewer is offered the control at all. Keyed on the presence of
   * the server-provided registry, which the booking page ships to admins only —
   * never guessed from a role string on the client.
   */
  available: boolean;
  /** The partner-lodge registry, in name order. Empty when unavailable. */
  lodges: Array<{ id: string; name: string }>;
  /** "Member of Other Lodge" — reveals the lodge picker when ticked. */
  enabled: boolean;
  /** The chosen lodge, or null while the officer has not picked one yet. */
  lodgeId: string | null;
  /** The guests currently ticked as members of that lodge. */
  flaggedGuestIds: ReadonlySet<string>;
  /** True once the election differs from what is stored on the booking. */
  changed: boolean;
  /**
   * Guest ticks are live only once a lodge is named — the whole point of the
   * dependency is that a person cannot be an "other lodge member" of no lodge.
   */
  guestTicksEnabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onLodgeIdChange: (lodgeId: string | null) => void;
  onGuestToggle: (guestId: string, flagged: boolean) => void;
  /** The two request fields, or `{}` when this edit proposes no change. */
  payloadFields: () => {
    otherLodgeId?: string | null;
    otherLodgeMemberGuestIds?: string[];
  };
  /**
   * #2978: the guests this officer may tick, straight from the server. Empty
   * when the payload carried none, which is also what a non-admin viewer gets -
   * so no tick box is offered to anybody who could not save one.
   *
   * A guest ALREADY ticked on the stored booking can fall out of this set later
   * (their membership type changes, or their subscription lapses). The panel
   * still renders their box in that case — see `edit-guests-card` — because a
   * flag nobody can untick makes the whole booking uneditable.
   */
  eligibleGuestIds: ReadonlySet<string>;
  /** Discard the pending election — used by the admin date-override reset. */
  reset: () => void;
}

function sameMembership(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

export function useOtherLodgeRate(booking: BookingData): OtherLodgeRateState {
  const lodges = useMemo(() => booking.otherLodges ?? [], [booking.otherLodges]);
  // Memoised so the identity is stable across renders: it feeds a per-row prop
  // in `edit-guests-card`, and a fresh Set each render would re-render every
  // guest row on every keystroke elsewhere in the panel.
  const eligibleGuestIds = useMemo(
    () => new Set(booking.otherLodgeRateEligibleGuestIds ?? []),
    [booking.otherLodgeRateEligibleGuestIds],
  );
  const available = Array.isArray(booking.otherLodges);
  const storedLodgeId = booking.otherLodgeId ?? null;
  const storedFlaggedGuestIds = useMemo(
    () =>
      new Set(
        booking.guests
          .filter((guest) => guest.otherLodgeMember)
          .map((guest) => guest.id),
      ),
    [booking.guests],
  );

  const [enabled, setEnabled] = useState(() => storedLodgeId !== null);
  const [lodgeId, setLodgeId] = useState<string | null>(storedLodgeId);
  const [flaggedGuestIds, setFlaggedGuestIds] = useState<Set<string>>(
    () => new Set(storedFlaggedGuestIds),
  );

  const onEnabledChange = useCallback(
    (next: boolean) => {
      setEnabled(next);
      // Unticking the header control retracts the whole election in one move:
      // no lodge, nobody ticked. Re-ticking it starts from the stored state
      // rather than from a blank slate, so an accidental toggle is undoable
      // without re-picking everybody.
      if (!next) {
        setLodgeId(null);
        setFlaggedGuestIds(new Set());
      } else {
        setLodgeId(storedLodgeId);
        setFlaggedGuestIds(new Set(storedFlaggedGuestIds));
      }
    },
    [storedFlaggedGuestIds, storedLodgeId],
  );

  const onLodgeIdChange = useCallback((next: string | null) => {
    setLodgeId(next);
    // Deselecting the lodge name clears every guest tick with it — the same
    // rule the server enforces, applied here so the ticks visibly go away
    // instead of being silently refused on save.
    if (!next) setFlaggedGuestIds(new Set());
  }, []);

  const onGuestToggle = useCallback((guestId: string, flagged: boolean) => {
    setFlaggedGuestIds((current) => {
      const next = new Set(current);
      if (flagged) next.add(guestId);
      else next.delete(guestId);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setEnabled(storedLodgeId !== null);
    setLodgeId(storedLodgeId);
    setFlaggedGuestIds(new Set(storedFlaggedGuestIds));
  }, [storedFlaggedGuestIds, storedLodgeId]);

  const changed =
    lodgeId !== storedLodgeId ||
    !sameMembership(flaggedGuestIds, storedFlaggedGuestIds);

  const payloadFields = useCallback(() => {
    if (!changed) return {};
    return {
      otherLodgeId: lodgeId,
      // Always sent alongside the lodge, and always the COMPLETE set: the server
      // reads it as an end state, so omitting it on a lodge-only change would
      // read as "nobody", and sending only the additions would never untick.
      otherLodgeMemberGuestIds: [...flaggedGuestIds],
    };
  }, [changed, flaggedGuestIds, lodgeId]);

  return {
    available,
    lodges,
    eligibleGuestIds,
    enabled,
    lodgeId,
    flaggedGuestIds,
    changed,
    guestTicksEnabled: enabled && lodgeId !== null,
    onEnabledChange,
    onLodgeIdChange,
    onGuestToggle,
    payloadFields,
    reset,
  };
}
