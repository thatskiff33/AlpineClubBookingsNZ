// @vitest-environment jsdom

import { renderHook as rtlRenderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import {
  ClubFormatProvider,
  useClubFormat,
} from "@/components/club-format-provider";
import {
  CLUB_CURRENCY_FALLBACK,
  CLUB_LOCALE_FALLBACK,
} from "@/lib/club-format";

/**
 * The browser's one source for the club's currency and locale (#3564, stage 2
 * of programme #3205; INV-CONFIG-006).
 *
 * `renderHook` comes from Testing Library DIRECTLY here, not from the shared
 * `club-time-render` helper, and that is the point of the first case: the
 * helper mounts this provider, so a suite that used it could not observe what
 * happens without one.
 */

function wrapperFor(currencyCode: string, locale: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <ClubFormatProvider currencyCode={currencyCode} locale={locale}>
        {children}
      </ClubFormatProvider>
    );
  };
}

describe("useClubFormat", () => {
  it("THROWS when no provider is above it, rather than assuming New Zealand", () => {
    /*
      The whole reason the mount census exists. A fallback here would render a
      plausible wrong currency on an officer's screen with nothing failing —
      which is the defect #3205 exists to end, reintroduced one level down.

      React logs the thrown error to the console as well as propagating it;
      that noise is expected and is not a second failure.
    */
    expect(() => rtlRenderHook(() => useClubFormat())).toThrow(
      /useClubFormat must be used within ClubFormatProvider/,
    );
  });

  it("hands down the club's values, canonicalised", () => {
    const { result } = rtlRenderHook(() => useClubFormat(), {
      wrapper: wrapperFor("chf", "de-ch"),
    });
    // The spelling is normalised on the way through, so a component never has
    // to decide whether `chf` and `CHF` are the same club.
    expect(result.current).toEqual({ currencyCode: "CHF", locale: "de-CH" });
  });

  it("falls back PER FIELD when one value is unusable", () => {
    /*
      The values reached here through stage 1's validator, so the only ways to
      get an unusable one are database surgery and a browser whose ICU has
      stopped accepting something the club chose. Falling back per FIELD keeps
      the good half: a rotted locale must not discard a currency the club
      really did choose, which is the judgement `resolveClubFormat` makes on
      the server for the same reason.
    */
    const badCurrency = rtlRenderHook(() => useClubFormat(), {
      wrapper: wrapperFor("not a currency", "de-CH"),
    });
    expect(badCurrency.result.current).toEqual({
      currencyCode: CLUB_CURRENCY_FALLBACK,
      locale: "de-CH",
    });

    const badLocale = rtlRenderHook(() => useClubFormat(), {
      wrapper: wrapperFor("CHF", "not a locale"),
    });
    expect(badLocale.result.current).toEqual({
      currencyCode: "CHF",
      locale: CLUB_LOCALE_FALLBACK,
    });
  });

  it("returns a stable object across re-renders with the same values", () => {
    /*
      Not tidiness: the resolved object is the dependency a consumer memoises a
      formatter on, and `Intl` construction is the expensive half of
      formatting. A provider that re-created it every render would rebuild
      every formatter beneath it on every render — including the lobby
      display's, which re-renders on a fifteen-second interval forever.
    */
    const { result, rerender } = rtlRenderHook(() => useClubFormat(), {
      wrapper: wrapperFor("CHF", "de-CH"),
    });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
