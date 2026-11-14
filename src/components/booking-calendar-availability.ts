"use client";

import { useEffect, useState } from "react";

/**
 * WHAT `BookingCalendar` KNOWS ABOUT THE SERVER, kept apart from how it draws it.
 *
 * The calendar's render is a long grid of per-cell decisions; the load,
 * accumulate, reset and retry machinery below is a separate concern that was
 * growing the same file past its size budget (#4954). Moved here as it was —
 * nothing about when a month is requested, merged or discarded changed.
 */

interface SeasonInfo {
  name: string;
  type: string;
}

/**
 * Everything one lodge's calendar knows about occupancy, accumulated across
 * every month that has been loaded (#2930).
 *
 * TWO DEFECTS LIVED IN THE SHAPE THIS REPLACES, a bare `Record<string, number>`
 * reset on every month change.
 *
 * 1. **Months did not accumulate.** Paging forward replaced the map wholesale,
 *    so paging back showed an empty month until its refetch landed — and a stay
 *    that spans a month boundary was being judged with one of its two months
 *    missing.
 * 2. **Missing was read as zero.** `availability[date] ?? 0` cannot tell "this
 *    night has nobody in it" from "this night has not been loaded", and it
 *    answered BOTH with an empty lodge. A failed or in-flight fetch therefore
 *    painted a full lodge as completely free and invited the member to pick it.
 *    Unknown is now its own state and renders as unknown.
 *
 * Keyed by lodge because the numbers are only meaningful against the lodge they
 * were counted for: switching lodges DISCARDS the accumulation rather than
 * merging two lodges' nights into one map. `capacity` is that lodge's own
 * effective capacity as the route resolved it (`INV-CAP-003`), never the
 * club-identity figure, which is one lodge's bed count and was previously used
 * as the denominator for all of them.
 */
interface LodgeAvailabilityState {
  /** The lodge these nights and this capacity belong to; null = default lodge. */
  lodgeId: string | null;
  /** Occupied beds per `yyyy-MM-dd`. An ABSENT key means "not loaded". */
  nights: Record<string, number>;
  /** The lodge's effective capacity, or null until a response has resolved it. */
  capacity: number | null;
}

const EMPTY_AVAILABILITY: LodgeAvailabilityState = {
  lodgeId: null,
  nights: {},
  capacity: null,
};

/**
 * The months whose availability request FAILED, for one lodge (#4954).
 *
 * An unknown night renders honestly as `?` (#2930), but a night alone cannot
 * say whether its month is still loading or failed to load, so the grid had
 * nothing to hang an error message or a Try again button on. The fetch's outcome is
 * recorded here instead. Keys are the `yyyy-MM` prefix the season merge uses;
 * tagged with the lodge for the same reason `LodgeAvailabilityState` is, so one
 * lodge's failure is never shown against another lodge.
 */
interface FailedMonthsState {
  lodgeId: string | null;
  months: ReadonlySet<string>;
}

function withMonth(
  current: FailedMonthsState,
  lodgeId: string | null,
  key: string,
  failed: boolean,
): FailedMonthsState {
  const months = new Set(current.lodgeId === lodgeId ? current.months : []);
  if (failed) months.add(key);
  else months.delete(key);
  return { lodgeId, months };
}

/**
 * Loads the month on screen for one lodge, accumulates every month paged
 * through, and records which months failed so the calendar can say so and offer
 * Try again. `month` is 0-based, as in the calendar's own `currentMonth`, and
 * `monthKey` is that month's `yyyy-MM` key, derived by the caller from the same
 * parts so this module never builds a calendar date itself.
 *
 * `year` and `month` build the request; `monthKey` tags the failure and the
 * season merge. They are one fact in two spellings, so a caller must derive the
 * key from the same `year` and `month` it passes: a key for another month would
 * fetch one month and record its outcome against a different one.
 */
export function useBookingCalendarAvailability(
  lodgeId: string | null | undefined,
  year: number,
  month: number,
  monthKey: string,
) {
  const [availability, setAvailability] = useState<LodgeAvailabilityState>({
    ...EMPTY_AVAILABILITY,
    lodgeId: lodgeId ?? null,
  });
  const [seasons, setSeasons] = useState<Record<string, SeasonInfo>>({});
  const [failedMonths, setFailedMonths] = useState<FailedMonthsState>({
    lodgeId: lodgeId ?? null,
    months: new Set(),
  });
  // Bumped by Try again so the load effect runs again for the month on screen.
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const requestedLodgeId = lodgeId ?? null;
    const requestedMonth = monthKey;

    // Only a run that is still current may record its outcome: a late answer
    // for a month or lodge the member has left must not raise or clear the
    // alert for the one on screen (#4954).
    function recordOutcome(failed: boolean) {
      if (cancelled) return;
      setFailedMonths((current) =>
        withMonth(current, requestedLodgeId, requestedMonth, failed),
      );
    }

    async function loadAvailability() {
      const res = await fetch(
        `/api/availability?year=${year}&month=${month}${
          lodgeId ? `&lodgeId=${encodeURIComponent(lodgeId)}` : ""
        }`
      );
      if (cancelled) return;
      if (!res.ok) {
        // A refused month leaves its nights UNLOADED, which is a state the grid
        // renders honestly. Before #2930 it left them absent from a map whose
        // reader defaulted absent to zero occupancy, so a failed fetch drew an
        // empty lodge. The failure itself is now recorded too (#4954).
        recordOutcome(true);
        return;
      }

      const data = await res.json();
      if (cancelled) return;
      recordOutcome(false);

      const loadedNights: Record<string, number> =
        data.availability && typeof data.availability === "object"
          ? data.availability
          : {};
      // The lodge's own effective capacity (#2930). Never fall back to the
      // club-identity figure when it is missing: a wrong denominator produces
      // confident, wrong bed counts, where an absent one produces a visible
      // "not loaded" the member can act on.
      const loadedCapacity =
        typeof data.lodgeCapacity === "number" ? data.lodgeCapacity : null;

      setAvailability((current) =>
        current.lodgeId === requestedLodgeId
          ? {
              lodgeId: requestedLodgeId,
              // MERGE, so every month paged through stays loaded and a stay
              // spanning a month boundary is judged against both of its months.
              nights: { ...current.nights, ...loadedNights },
              capacity: loadedCapacity ?? current.capacity,
            }
          : {
              // A different lodge: the accumulated nights counted somebody
              // else's beds, so they are discarded rather than merged.
              lodgeId: requestedLodgeId,
              nights: loadedNights,
              capacity: loadedCapacity,
            },
      );
      // Seasons accumulate across months like the nights do, but they are SPARSE
      // — only a day inside a season gets a key — so a blanket merge could never
      // remove one. A season that was deactivated or re-dated kept its label on
      // the grid until the lodge changed (#2930 fix round). This month's keys are
      // dropped before the fresh answer is merged, which makes the refetch
      // authoritative for the month it asked about and leaves every other month
      // standing.
      const monthPrefix = `${requestedMonth}-`;
      const loadedSeasons: Record<string, SeasonInfo> =
        data.seasons && typeof data.seasons === "object" ? data.seasons : {};
      setSeasons((current) => {
        const kept: Record<string, SeasonInfo> = {};
        for (const [date, season] of Object.entries(current)) {
          if (!date.startsWith(monthPrefix)) kept[date] = season;
        }
        return { ...kept, ...loadedSeasons };
      });
    }

    // A rejected fetch (no network) or an unreadable body is a failed month
    // too, rather than an unhandled rejection the member never hears about.
    loadAvailability().catch(() => recordOutcome(true));

    return () => {
      cancelled = true;
    };
  }, [month, year, monthKey, lodgeId, reloadToken]);

  /**
   * Everything accumulated belongs to the lodge it was counted for, so changing
   * lodge discards it SYNCHRONOUSLY (#2930 fix round).
   *
   * The load effect above discards on a lodge mismatch too, but only on the
   * branch where a response arrives. A member who is not eligible to book a
   * lodge gets a refused fetch on every month, so that branch never ran and the
   * grid went on rendering the PREVIOUS lodge's free-bed counts, heat colours
   * and full/not-full decisions against the new lodge's dates — including
   * drawing a held night at the new lodge as free. That is exactly the
   * confidently-wrong denominator the calendar's own comments forbid, and unknown
   * already has an honest rendering.
   *
   * Seasons are per lodge for the same reason (`lodgeNullTolerantScope`).
   */
  useEffect(() => {
    setSeasons({});
    setAvailability({ ...EMPTY_AVAILABILITY, lodgeId: lodgeId ?? null });
    setFailedMonths({ lodgeId: lodgeId ?? null, months: new Set() });
  }, [lodgeId]);

  const visibleMonthFailed =
    failedMonths.lodgeId === (lodgeId ?? null) &&
    failedMonths.months.has(monthKey);

  /** Forget the visible month's failure and ask for it again. */
  function retryVisibleMonth() {
    setFailedMonths((current) =>
      withMonth(current, lodgeId ?? null, monthKey, false),
    );
    setReloadToken((token) => token + 1);
  }

  return { availability, seasons, visibleMonthFailed, retryVisibleMonth };
}
