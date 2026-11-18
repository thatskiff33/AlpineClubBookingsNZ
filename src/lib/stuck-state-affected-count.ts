import {
  getStuckStateDashboard,
  type StuckStateDashboardDependencies,
} from "@/lib/stuck-state-dashboard";

/** How long the sidebar's Stuck States headline may be reused (#4962). */
export const STUCK_STATE_AFFECTED_COUNT_TTL_MS = 60_000;

let affectedCountCache: { value: Promise<number>; expiresAt: number } | null = null;

/**
 * Stuck States' headline — `totals.affectedCount`, the number the page itself
 * leads with — for the officer work queues (#4962). It is the same scan, so the
 * badge can never disagree with the page, but the badge is asked for on every
 * admin navigation and the scan is many queries, so one result (or the one in
 * flight) is shared for a minute per server process. No provider network call:
 * `getXeroAdminHealthSnapshot` reads only stored state and usage rows. A failed
 * scan is not cached.
 */
export function getStuckStateAffectedCount(input?: {
  deps?: Partial<StuckStateDashboardDependencies>;
  now?: Date;
}): Promise<number> {
  const nowMs = (input?.now ?? new Date()).getTime();
  if (affectedCountCache && affectedCountCache.expiresAt > nowMs) {
    return affectedCountCache.value;
  }
  const value = getStuckStateDashboard({ deps: input?.deps, now: input?.now }).then(
    (dashboard) => dashboard.totals.affectedCount,
  );
  const entry = { value, expiresAt: nowMs + STUCK_STATE_AFFECTED_COUNT_TTL_MS };
  affectedCountCache = entry;
  value.catch(() => {
    if (affectedCountCache === entry) affectedCountCache = null;
  });
  return value;
}

/** Test seam: forget the cached Stuck States headline. */
export function resetStuckStateAffectedCountCache() {
  affectedCountCache = null;
}
