"use client";

import { createContext, useContext, useMemo } from "react";

import { useClubTime } from "@/components/club-time-provider";
import { bindClubSeason, type BoundClubSeason } from "@/lib/season-label";

/**
 * The club's financial year-end month, delivered to the BROWSER as data
 * (#5259), on the terms `club-time-provider.tsx` sets for the zone.
 *
 * The year-end decides which season an officer is looking at and how it is
 * named, and it is resolved on the server from the admin override or the
 * connected Xero organisation. A browser reads neither (`INV-OPS-013`), and
 * `financial-year.ts`'s process cache is never seeded in one, so a client
 * screen that asked it got March whatever the club had set. The admin layout
 * awaits `clubFinancialYearEndMonthForLayout()` (bounded) and mounts this provider with the result.
 *
 * ## Mounted by the admin layout only
 *
 * Every season picker and season label drawn in a browser is an admin screen.
 * The member profile names seasons too, but it is a server component and binds
 * the year-end itself. Mounting this in `AppProviders` would put a settings read
 * (and, with the Xero year-end cache cold, a throttled Xero read) on every
 * member page for no consumer.
 *
 * ## The hook THROWS with no provider, deliberately
 *
 * A default of March here would be the very defect this provider removes,
 * invisible again. A screen rendered outside the admin layout fails loudly.
 */
const ClubSeasonContext = createContext<number | null>(null);

export function ClubSeasonProvider({
  yearEndMonth,
  children,
}: {
  /** The club's effective year-end month (1-12), resolved on the SERVER. */
  yearEndMonth: number;
  children: React.ReactNode;
}) {
  return (
    <ClubSeasonContext.Provider value={yearEndMonth}>
      {children}
    </ClubSeasonContext.Provider>
  );
}

/**
 * The club's seasons: the current season year and every season's name, from the
 * server-resolved year-end and the club's own zone and date format.
 */
export function useClubSeason(): BoundClubSeason {
  const yearEndMonth = useContext(ClubSeasonContext);
  const clubTime = useClubTime();
  const bound = useMemo(
    () =>
      yearEndMonth === null ? null : bindClubSeason(yearEndMonth, clubTime),
    [yearEndMonth, clubTime],
  );
  if (bound === null) {
    throw new Error(
      "useClubSeason must be used within ClubSeasonProvider (#5259). The admin layout " +
        "mounts it with the server-resolved financial year-end; a test that renders a " +
        "season screen bare should wrap it in <ClubSeasonProvider yearEndMonth={...}> and " +
        "choose the year-end the assertion is about.",
    );
  }
  return bound;
}
