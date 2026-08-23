"use client";

import { createContext, useContext, useMemo } from "react";

import {
  bindClubTime,
  asClubTimeZone,
  requireClubTimeZone,
} from "@/lib/club-time";
import type { BoundClubTime } from "@/lib/club-time";
import { CLUB_TIME_ZONE_FALLBACK } from "@/lib/club-time-zone";

/**
 * The club's timezone, delivered to the BROWSER as data (CT-4 group C, #2870;
 * epic #2988).
 *
 * ## The problem this solves, in one sentence
 *
 * `INV-CONFIG-002` says the club's civil-time authority is the persisted
 * `ClubTimeSettings.timeZone` and nothing else — but that value is a
 * `server-only` database read, and 36 of the 45 temporal files under
 * `src/components/**` are `"use client"`. A browser cannot reach the database and
 * must never ask its own host, so the zone has to arrive as DATA. This is the
 * seam it arrives through.
 *
 * ## Read this before you reach for it: most components do not need it
 *
 * A CALENDAR DATE HAS NO TIMEZONE. A lodge night, a date of birth, a promo
 * window and a season edge are calendar days: 16 April 2026 is a Thursday in
 * every zone on earth. `formatClubDate` and its siblings pin `timeZone: "UTC"`
 * over the UTC-midnight encoding, so the projection is provably the identity and
 * takes no zone argument at all. Measured on this group: 26 of the 43 migrated
 * files render only calendar dates and never touch this context.
 *
 * Reach for this ONLY when what you hold is a real INSTANT — `createdAt`,
 * `paidAt`, an audit stamp — or when you are deriving the club's "today". Those
 * genuinely have no civil date until a zone is chosen, and choosing the viewer's
 * is the defect the epic exists to end.
 *
 * ## And when you DO decode a calendar day here, decide which decoder on purpose
 *
 * The kernel offers two, and in a `"use client"` component the difference is not
 * cosmetic. `requireCalendarDate` THROWS on a malformed day; in a browser render
 * that is an unhandled throw, so the nearest error boundary replaces the whole
 * screen — an officer's queue goes blank rather than showing one bad row.
 * `parseCalendarDate` returns `null` and hands the decision back to the caller.
 *
 * The split across this group is not arbitrary and is worth keeping: every
 * `parseCalendarDate` caller already has something honest to render when there is
 * no valid day — the raw stored text, or an em-dash — and every
 * `requireCalendarDate` caller is formatting a required server field inline with
 * no such fallback in scope, where a silent wrong-looking string would be worse
 * than a loud failure. So the question to answer before choosing is not "which is
 * stricter" but "what would this screen SHOW if the value were bad?". If the
 * answer is a sensible fallback, parse; if the answer is a lie, require.
 *
 * Nothing in this application produces a malformed day today — every value comes
 * from a `@db.Date` column through a typed route — so this is a rule about the
 * next caller rather than a live defect. Note that a decoder is not a validator:
 * these values arrive over `fetch` with no runtime schema check on the way in.
 *
 * ## Why a context rather than a prop
 *
 * Three reasons, in the order they decided it.
 *
 * 1. **The callers are not reachable from here.** These components are rendered
 *    from ~80 places under `src/app/**` and from each other. A required prop
 *    would have to be threaded through every intermediate component that does
 *    not itself care, which is the classic prop-drilling failure and would put
 *    the epic's correctness in the hands of every future caller.
 * 2. **The house already answered this exact question.** `ClubIdentityProvider`
 *    carries a server-resolved club setting to client components through a
 *    context whose hook throws when it is missing, and `useClubIdentity` is
 *    consumed the same way. A second, different pattern for the same problem is
 *    worse than either pattern alone, because the next lane then has to choose.
 * 3. **It makes a zone test discriminating.** A component reading a context has
 *    to be handed a zone to render at all, so a test that renders it under
 *    `America/Denver` and asserts a Denver-shaped answer cannot pass by
 *    accident. A component reading an ambient default passes whatever the
 *    environment happens to be.
 *
 * ## Why the hook THROWS when there is no provider
 *
 * Because the alternative is the defect wearing a green suite. A fallback zone —
 * the environment's, the shipped default, or the viewer's — renders a plausible
 * wrong hour and nothing anywhere fails. A throw is loud at first render, in
 * development, on the page that forgot to mount it.
 *
 * That is only a safe choice because the mount is GUARANTEED rather than hoped
 * for: every route group in this application is wrapped by one of exactly two
 * components, both of which live under `src/components/**` and both of which
 * mount this provider —
 *
 * | Route groups                                              | Mounted by |
 * | --------------------------------------------------------- | ---------- |
 * | `(admin)`, `(authenticated)`, `(finance)`, `(lodge)`, `(public)` | `app-providers.tsx` |
 * | `(website)`, `(website-dynamic)`                            | `website/website-chrome.tsx` |
 *
 * `__tests__/club-time-provider-mount-census.test.tsx` reads those layouts and
 * those two components off disk and fails if a route group appears that is
 * covered by neither, so "every page has a provider" is an enforced fact rather
 * than a claim in a docblock. A new route group added without one fails that
 * census before anybody reaches the white screen.
 *
 * ## A client component NEVER obtains the zone from its own host
 *
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` is the viewer's clock. A
 * member in London and a member in Ohakune must see the same club time, so that
 * read is forbidden here by `INV-CONFIG-002` and by the lint arm that bans an
 * unzoned `Intl.DateTimeFormat`. This context is the only legitimate way a
 * browser in this application learns the club's zone.
 */

/**
 * `null` means "no provider above me", and is deliberately NOT a usable zone.
 * A default binding here would make a missing mount invisible, which is exactly
 * the failure mode the throw below exists to prevent.
 */
const ClubTimeContext = createContext<BoundClubTime | null>(null);

export function ClubTimeProvider({
  zone,
  children,
}: {
  /**
   * The club's persisted timezone identifier, resolved on the SERVER. A raw
   * `string` rather than the branded `ClubTimeZone` because that is what
   * survives the server-to-client prop boundary and what an API payload carries;
   * it is re-validated below.
   */
  zone: string;
  children: React.ReactNode;
}) {
  const bound = useMemo(() => {
    /**
     * The same judgement `club-time/server.ts` makes for the same reason: the
     * value has already passed CT-1's validator on the way in, so the only way
     * it fails here is a runtime whose ICU has forgotten a zone the club chose
     * years ago. Falling back to the documented default keeps the page
     * answering, where throwing would blank it.
     */
    const validated =
      asClubTimeZone(zone) ?? requireClubTimeZone(CLUB_TIME_ZONE_FALLBACK);
    return bindClubTime(validated);
  }, [zone]);

  return (
    <ClubTimeContext.Provider value={bound}>
      {children}
    </ClubTimeContext.Provider>
  );
}

/**
 * The club's temporal API, with the persisted zone already bound.
 *
 * The returned object is the SAME interface `clubTime()` hands a server module,
 * so a component that moves between server and client changes the line that
 * obtains the binding and nothing else.
 */
export function useClubTime(): BoundClubTime {
  const bound = useContext(ClubTimeContext);
  if (bound === null) {
    throw new Error(
      "useClubTime must be used within ClubTimeProvider (CT-4, #2870; INV-CONFIG-002). " +
        "Every route group is wrapped by AppProviders or WebsiteChrome, both of which mount it, " +
        "so this means either a new tree that mounts neither, or a test that renders the " +
        'component bare — wrap it in <ClubTimeProvider zone="..."> and choose the zone the ' +
        "assertion is about. If what you are rendering is a CALENDAR DATE, you need no zone " +
        "at all: use formatClubDate and friends, which take none.",
    );
  }
  return bound;
}

/**
 * NO `useClubTimeZone()` HERE, deliberately. Every caller in this group wanted
 * an OPERATION — a formatted instant, the club's today — and `BoundClubTime`
 * already carries `.zone` for the one that genuinely needs the identifier. An
 * exported hook with no caller is dead code the `knip` gate refuses, and a
 * zone-shaped export is also the easiest thing for a later lane to reach for
 * when it should be reaching for a formatter.
 */
