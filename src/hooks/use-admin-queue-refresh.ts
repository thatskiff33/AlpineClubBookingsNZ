"use client";

import { useCallback, useEffect, useRef } from "react";
import { ADMIN_QUEUE_CHANGED_EVENT } from "@/lib/admin-queue-events";

/**
 * When an officer queue count is read again (#4962, #4969). The one place for
 * these triggers, so the sidebar's Needs Attention badges and the Booking
 * Requests page's tab badges move together and can never disagree after an
 * officer acts:
 * - when a queue page announces a decision (`notifyAdminQueueChanged`),
 * - when the window regains focus or the tab becomes visible again,
 * - whenever the caller asks, through the returned `refresh` (first load,
 *   navigation, Retry).
 *
 * At most one load runs at a time. A decision or `refresh` during a load queues
 * one more after it, because the load in flight may predate the change; focus
 * and visibility do not, since the load in flight is already fresh, and a tab
 * coming back fires both. Because loads never overlap, an older response can
 * never land after a newer one.
 *
 * `load` is told whether the caller is still mounted, and must not set state
 * once it is not. It is read fresh on every call, so it may close over the
 * latest render.
 */
export function useAdminQueueRefresh(
  load: (isMounted: () => boolean) => Promise<void>,
): () => void {
  const latestLoad = useRef(load);
  // Declared before the effect below and every caller effect, so it has run by
  // the time anything calls `refresh`.
  useEffect(() => {
    latestLoad.current = load;
  });
  const request = useRef<(queueIfBusy: boolean) => void>(() => {});

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let again = false;
    const isMounted = () => !disposed;

    const run = (queueIfBusy: boolean) => {
      if (inFlight) {
        if (queueIfBusy) again = true;
        return;
      }
      inFlight = true;
      latestLoad
        .current(isMounted)
        .catch(() => {
          /* `load` reports its own failure; a throw must not stop the queue */
        })
        .finally(() => {
          inFlight = false;
          if (again && !disposed) {
            again = false;
            run(false);
          }
        });
    };
    request.current = run;

    const onFocus = () => run(false);
    const onQueueChanged = () => run(true);
    const onVisible = () => {
      if (document.visibilityState === "visible") run(false);
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener(ADMIN_QUEUE_CHANGED_EVENT, onQueueChanged);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      request.current = () => {};
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(ADMIN_QUEUE_CHANGED_EVENT, onQueueChanged);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return useCallback(() => request.current(true), []);
}
