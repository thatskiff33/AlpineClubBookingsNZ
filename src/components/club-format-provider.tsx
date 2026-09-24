"use client";

import { createContext, useContext, useMemo } from "react";


import {
  CLUB_CURRENCY_FALLBACK,
  CLUB_LOCALE_FALLBACK,
  normaliseClubCurrencyCode,
  normaliseClubLocale,
  type ClubFormat,
} from "@/lib/club-format";

/**
 * The club's currency and locale, delivered to the BROWSER as data (stage 2 of
 * programme #3205, #3564). INV-CONFIG-006.
 *
 * ## The problem this solves, in one sentence
 *
 * Stage 1 (#3563) made `ClubFormatSettings` the authority for the club's
 * currency and locale, and that authority is a `server-only` database read —
 * but ten `"use client"` modules were reading `APP_CURRENCY` / `APP_LOCALE`
 * from `@/config/operational`, which is `NEXT_PUBLIC_*` inlined at BUILD time
 * and therefore `undefined` in the published image no matter what the club
 * sets. A browser cannot reach the database and must never ask its own host, so
 * the values have to arrive as DATA. This is the seam they arrive through.
 *
 * ## Why a context rather than a prop
 *
 * The same three reasons `club-time-provider.tsx` records, and they are the
 * reasons rather than a wish to match it: the nine admin consumers are rendered
 * from pages, panels and generic module maps with no shared call site to thread
 * a prop through; the house has already answered this exact question twice
 * (`ClubIdentityProvider`, `ClubTimeProvider`) and a third pattern for one
 * problem is worse than either; and a component that must be HANDED a currency
 * to render at all makes a test discriminating — render it under `CHF` and a
 * `CHF` assertion cannot pass by accident, where a component reading an ambient
 * constant passes whatever the environment happens to hold.
 *
 * ## Why the hook THROWS when there is no provider
 *
 * Because the alternative is the defect wearing a green suite. Falling back to
 * `NZD` and `en-NZ` renders a plausible wrong currency on an officer's screen
 * and nothing anywhere fails — which is precisely the bug #3205 exists to end,
 * reintroduced one level down. A throw is loud at first render, in development,
 * on the tree that forgot to mount it.
 *
 * That is only safe because the mount is GUARANTEED rather than hoped for:
 *
 * | Route groups                                                      | Mounted by          |
 * | ----------------------------------------------------------------- | ------------------- |
 * | `(admin)`, `(authenticated)`, `(finance)`, `(lodge)`, `(public)`  | `app-providers.tsx` |
 * | `(website)`, `(website-dynamic)`                                   | `website/website-chrome.tsx` |
 *
 * `__tests__/club-format-provider-mount-census.test.tsx` reads those layouts
 * and those two components off disk and fails if a route group appears that
 * neither covers, and walks the import graph of every surface outside a route
 * group to prove that nothing under it reaches this hook. So "every page has a
 * provider" is an enforced fact rather than a claim in a docblock.
 *
 * `/display` is the one surface deliberately outside that guarantee: it has no
 * layout and sits in no route group, so its own server page resolves the club's
 * format and mounts this provider around the screen. See
 * `src/app/display/page.tsx` for why it does not simply join the chrome — the
 * same answer CT-4 gave for the timezone, and for the same reason (its sibling
 * `error.tsx` is held at zero data dependencies, and no mount on that route
 * could cover it).
 *
 * ## What a client component does with it
 *
 * Renders money. Since #3565 every money and number rendering in
 * `src/lib/utils.ts` and `src/lib/finance-format.ts` takes the club's format as a
 * REQUIRED argument, so a component that renders an amount has to get one from
 * somewhere, and in the browser this is the only place it can. A component that
 * renders many amounts binds once with `bindClubFormat(useClubFormat())`, which
 * hands back the same `BoundClubFormat` that `clubFormat()` hands a server
 * module, so a component that moves between server and client changes the line
 * that obtains it and nothing else. (A `useBoundClubFormat` hook shipped briefly
 * in #3565 and was removed once every call site had chosen the explicit form.)
 *
 * `club-time/intl.ts`'s locale is still the environment's; it is #3566.
 */

/**
 * `null` means "no provider above me", and is deliberately NOT a usable format.
 * A default binding here would make a missing mount invisible, which is exactly
 * the failure the throw below exists to prevent.
 */
const ClubFormatContext = createContext<ClubFormat | null>(null);

export function ClubFormatProvider({
  currencyCode,
  locale,
  children,
}: {
  /**
   * The club's persisted ISO 4217 currency code, resolved on the SERVER. Raw
   * `string`s rather than a `ClubFormat` object because two scalars keep the
   * memo below keyed on values instead of on an object identity that a server
   * component re-creates on every render.
   */
  currencyCode: string;
  /** The club's persisted BCP 47 locale, resolved on the SERVER. */
  locale: string;
  children: React.ReactNode;
}) {
  const format = useMemo<ClubFormat>(
    () => ({
      /**
       * The same judgement `resolveClubFormat` makes for the same reason: both
       * values passed stage 1's validator on the way in, so the only way either
       * fails here is a runtime whose ICU has stopped accepting something the
       * club chose. Falling back to the documented default keeps the page
       * answering, where throwing would blank it. Per FIELD, so a rotted locale
       * does not discard a currency the club really did choose.
       */
      currencyCode:
        normaliseClubCurrencyCode(currencyCode) ?? CLUB_CURRENCY_FALLBACK,
      locale: normaliseClubLocale(locale) ?? CLUB_LOCALE_FALLBACK,
    }),
    [currencyCode, locale],
  );

  return (
    <ClubFormatContext.Provider value={format}>
      {children}
    </ClubFormatContext.Provider>
  );
}

/**
 * The club's currency code and locale, both resolved and both always present.
 *
 * The returned object is the SAME `ClubFormat` a server module gets from
 * `getClubFormat()`, so a component that moves between server and client
 * changes the line that obtains it and nothing else.
 */
export function useClubFormat(): ClubFormat {
  const format = useContext(ClubFormatContext);
  if (format === null) {
    throw new Error(
      "useClubFormat must be used within ClubFormatProvider (#3564; INV-CONFIG-006). " +
        "Every route group is wrapped by AppProviders or WebsiteChrome, both of which " +
        "mount it, so this means either a new tree that mounts neither, or a test that " +
        "renders the component bare — render it through the shared test helper in " +
        "src/lib/__tests__/support/club-time-render.tsx, which mounts this provider too, " +
        "or wrap it in <ClubFormatProvider currencyCode=\"...\" locale=\"...\"> and choose " +
        "the values the assertion is about. The lobby display (/display) is wrapped by " +
        "neither chrome component: its own server page resolves the club's format and " +
        "mounts this provider around the screen.",
    );
  }
  return format;
}
