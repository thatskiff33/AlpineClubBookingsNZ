"use client";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { MEMBER_SIGN_OUT_EVENT } from "@/lib/member-sign-out";
import type { LodgeOption } from "@/components/lodge-select";
import type { CalendarDate } from "@/lib/club-time";
import {
  clearWizardWork,
  loadWizardWork,
  reconcileRestoredWork,
  saveWizardWork,
  type SavedWizardWork,
} from "@/lib/booking-wizard-work";

/**
 * How long the wizard waits after the last change before writing it to the
 * tab. Short, because a pending write is also flushed on unmount and on
 * `pagehide`, so nothing typed just before leaving is lost.
 */
const SAVE_DEBOUNCE_MS = 250;

/**
 * What the member is told about work brought back from the tab: `kept` when it
 * came back whole, `datesDropped` when the dates had to go (they have passed or
 * no longer make a range) and the party was kept.
 */
export type RestoredWorkNotice = "kept" | "datesDropped";

/**
 * Keeps the booking wizard's inputs in this tab and brings them back (#4950).
 *
 * The storage rules live in `src/lib/booking-wizard-work.ts`; this hook decides
 * WHEN: restore once, after the member and the bookable lodges are known; save
 * (debounced) only after that, so a fresh mount never overwrites the copy it is
 * about to read; and stop for good once the booking has left the wizard.
 *
 * Disabled for a `?replaceRequest=` visit: replacing an exception request is
 * its own entry path, and a kept copy must never override it.
 */
export function useWizardWorkPersistence({
  enabled,
  memberId,
  lodges,
  lodgesLoading,
  lodgesFailed,
  lodgesForbidden,
  today,
  work,
  onRestore,
}: {
  enabled: boolean;
  memberId: string | null;
  lodges: readonly LodgeOption[];
  lodgesLoading: boolean;
  lodgesFailed: boolean;
  lodgesForbidden: boolean;
  today: CalendarDate;
  /** The inputs to keep now, or null when there is nothing worth keeping. */
  work: Omit<SavedWizardWork, "memberId"> | null;
  onRestore: (work: SavedWizardWork) => void;
}) {
  const [restoreSettled, setRestoreSettled] = useState(false);
  const [restoredWorkNotice, setRestoredWorkNotice] =
    useState<RestoredWorkNotice | null>(null);
  const stoppedRef = useRef(false);
  const pendingSaveRef = useRef<SavedWizardWork | null>(null);
  const applyRestoredWork = useEffectEvent(onRestore);

  useEffect(() => {
    if (restoreSettled || !enabled || stoppedRef.current) return;
    // A failed lodge list is transient: wait for the retry rather than throw
    // the member's work away. A refusal (forbidden) means no lodge is bookable.
    if (!memberId || lodgesLoading || lodgesFailed) return;
    const saved = loadWizardWork(memberId);
    const restored =
      saved && !lodgesForbidden
        ? reconcileRestoredWork(saved, {
            bookableLodgeIds: lodges.map((lodge) => lodge.id),
            today,
          })
        : null;
    if (saved && !restored) clearWizardWork();
    if (saved && restored) {
      applyRestoredWork(restored);
      const datesDropped = saved.checkIn !== null && restored.checkIn === null;
      // A copy holding only the lodge and the member themselves is what a fresh
      // visit would show anyway, so it comes back without a notice.
      const worthMentioning =
        saved.checkIn !== null ||
        restored.guests.some((guest) => guest.memberId !== memberId);
      if (worthMentioning) {
        setRestoredWorkNotice(datesDropped ? "datesDropped" : "kept");
      }
    }
    setRestoreSettled(true);
  }, [
    restoreSettled,
    enabled,
    memberId,
    lodges,
    lodgesLoading,
    lodgesFailed,
    lodgesForbidden,
    today,
  ]);

  useEffect(() => {
    function stopOnSignOut() {
      stoppedRef.current = true;
      pendingSaveRef.current = null;
    }
    window.addEventListener(MEMBER_SIGN_OUT_EVENT, stopOnSignOut);
    return () => window.removeEventListener(MEMBER_SIGN_OUT_EVENT, stopOnSignOut);
  }, []);

  const flushPendingSave = useCallback(() => {
    const pending = pendingSaveRef.current;
    pendingSaveRef.current = null;
    // Every way of stopping empties the pending save, so none is left here.
    if (pending) saveWizardWork(pending);
  }, []);

  // Serialised so the save effect runs when the CONTENT changes, not on every
  // render that rebuilds the object.
  const serialisedWork =
    restoreSettled && memberId && work
      ? JSON.stringify({ ...work, memberId })
      : null;
  useEffect(() => {
    if (serialisedWork === null || stoppedRef.current) {
      pendingSaveRef.current = null;
      return;
    }
    pendingSaveRef.current = JSON.parse(serialisedWork) as SavedWizardWork;
    const timer = window.setTimeout(flushPendingSave, SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [serialisedWork, flushPendingSave]);

  // Leaving by a link unmounts the wizard; leaving by refresh or close fires
  // `pagehide`. Either way the last change is written before it is lost.
  useEffect(() => {
    window.addEventListener("pagehide", flushPendingSave);
    return () => {
      window.removeEventListener("pagehide", flushPendingSave);
      flushPendingSave();
    };
  }, [flushPendingSave]);

  /**
   * The booking has left the wizard (submitted, waitlisted, saved as a draft,
   * or sent as an exception request): forget the work and keep nothing more
   * for the rest of this visit.
   */
  const stopKeepingWork = useCallback(() => {
    stoppedRef.current = true;
    pendingSaveRef.current = null;
    clearWizardWork();
    setRestoredWorkNotice(null);
  }, []);

  /** The member chose to throw the kept work away: forget it and reload empty. */
  const startAgain = useCallback(() => {
    stopKeepingWork();
    // A full load is the reset: every piece of wizard state starts fresh, which
    // a client-side push to the same route would not do.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/book");
  }, [stopKeepingWork]);

  return { restoreSettled, restoredWorkNotice, stopKeepingWork, startAgain };
}
