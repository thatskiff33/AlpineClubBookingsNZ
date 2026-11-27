"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef } from "react";

/**
 * Re-renders the admin layout when a save moves the club's financial year-end
 * (#5259 review).
 *
 * The layout hands every season screen the year-end through
 * `ClubSeasonProvider`, and Next keeps that layout across client navigation, so
 * without a refresh the season screens keep the old month while the routes
 * resolve the new one. `noteLoaded` records the month the page was drawn with;
 * `noteSaved` refreshes the router only when a save answered a different one.
 * Both take the `financialYear.effectiveMonth` the settings route returns.
 */
export function useYearEndRefresh() {
  const router = useRouter();
  const effective = useRef<number | null>(null);
  const noteLoaded = useCallback((month: unknown) => {
    if (typeof month === "number") effective.current = month;
  }, []);
  const noteSaved = useCallback(
    (month: unknown) => {
      if (typeof month !== "number" || month === effective.current) return;
      effective.current = month;
      router.refresh();
    },
    [router],
  );
  return { noteLoaded, noteSaved };
}
