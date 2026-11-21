import type { Dispatch, RefObject, SetStateAction } from "react";
import type { WorkPartyEvent } from "@/components/book/booking-wizard-types";
import type { PromoResult } from "@/components/promo-code-input";

/**
 * The review step's read of the open work parties overlapping the stay, split
 * out of `use-booking-wizard.ts` (#5148) so the wizard did not grow past its
 * hard size ceiling. Behaviour is unchanged: the wizard calls it where it always
 * ran the request, once the quote has landed.
 *
 * A newer request supersedes an older one: each takes the next sequence number
 * and aborts the one in flight, and a response is applied only while it is
 * still the latest and `stillCurrent()` (the lodge it was asked for is still the
 * lodge on screen). Work parties bound to another lodge are filtered out
 * server-side. A failed read empties the list; an aborted one does nothing.
 */
export function fetchStayWorkParties({
  checkIn,
  checkOut,
  lodgeId,
  sequenceRef,
  abortRef,
  stillCurrent,
  onEvents,
  onFailure,
}: {
  checkIn: string;
  checkOut: string;
  lodgeId: string;
  sequenceRef: RefObject<number>;
  abortRef: RefObject<AbortController | null>;
  stillCurrent: () => boolean;
  onEvents: (events: WorkPartyEvent[]) => void;
  onFailure: () => void;
}): void {
  const sequence = ++sequenceRef.current;
  abortRef.current?.abort();
  const controller = new AbortController();
  abortRef.current = controller;
  const ownsRequest = () => sequence === sequenceRef.current && stillCurrent();
  fetch(
    `/api/work-parties/active?checkIn=${checkIn}&checkOut=${checkOut}&lodgeId=${encodeURIComponent(lodgeId)}`,
    { signal: controller.signal },
  )
    .then((r) => (r.ok ? r.json() : { events: [] }))
    .then((data) => {
      const events: WorkPartyEvent[] = data.events || [];
      if (!ownsRequest()) return;
      onEvents(events);
    })
    .catch((requestError) => {
      if (requestError instanceof DOMException && requestError.name === "AbortError") return;
      if (ownsRequest()) onFailure();
    })
    .finally(() => {
      if (abortRef.current === controller) abortRef.current = null;
    });
}

/**
 * What a fresh list of the stay's work parties does to the selection.
 *
 * - A "Join Work Party" visit (#5148) whose work party is in the list ticks it,
 *   once, unless the member has already chosen one.
 * - A selected work party that is no longer in the list is cleared, with a
 *   notice naming it. Alone, a working-bee discount already applied goes with
 *   it; combined with codes (`combineWithCodesRef`), the codes stay and the
 *   working-bee effect re-prices them without it.
 */
export function reconcileWorkPartySelection(
  events: WorkPartyEvent[],
  state: {
    selectedId: string | null;
    previousEvents: WorkPartyEvent[];
    joinedId: string | null;
  },
  apply: {
    select: (id: string | null) => void;
    setAttending: (attending: boolean) => void;
    noticeCleared: (name: string) => void;
    setAppliedPromos: Dispatch<SetStateAction<PromoResult[]>>;
    combineWithCodesRef: RefObject<boolean>;
  },
): void {
  if (state.joinedId && !state.selectedId) {
    apply.select(state.joinedId);
    apply.setAttending(true);
    return;
  }
  if (!state.selectedId || events.some((e) => e.id === state.selectedId)) return;
  const previous = state.previousEvents.find((e) => e.id === state.selectedId);
  apply.select(null);
  apply.setAttending(false);
  if (previous) apply.noticeCleared(previous.name);
  apply.setAppliedPromos((current) =>
    current.some((promo) => promo.workPartyEvent) && !apply.combineWithCodesRef.current
      ? []
      : current,
  );
}
