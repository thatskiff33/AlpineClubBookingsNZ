import {
  render as rtlRender,
  renderHook as rtlRenderHook,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { ClubFormatProvider } from "@/components/club-format-provider";
import { ClubTimeProvider } from "@/components/club-time-provider";
import {
  CLUB_CURRENCY_FALLBACK,
  CLUB_LOCALE_FALLBACK,
} from "@/lib/club-format";

/**
 * Testing Library's `render`, with the application's server-resolved club
 * settings in scope — the timezone (CT-4, #2870; epic #2988) and, since #3564,
 * the currency and locale (programme #3205).
 *
 * ## Why this exists
 *
 * Since CT-4 a `"use client"` component that renders a real INSTANT, or derives
 * the club's "today", reads the zone from `ClubTimeProvider` — and
 * `useClubTime()` THROWS when there is none, deliberately, so a tree that forgot
 * to mount it fails loudly instead of rendering a plausible wrong hour. In the
 * application every route group is wrapped (`app-providers.tsx` and
 * `website/website-chrome.tsx`, pinned by
 * `club-time-provider-mount-census.test.tsx`), so the only bare renders left are
 * in tests. This is the one place that fixes them.
 *
 * ## It mounts TWO providers, and the file keeps its name anyway
 *
 * #3564 gave the club's currency and locale the identical treatment — a
 * server-resolved value, a context, a hook that throws rather than fall back to
 * `NZD`/`en-NZ`, and a mount census over the same two chrome components — so a
 * test that renders a money label or a formatted number now needs that provider
 * too. There were two ways to supply it: a second helper beside this one, or
 * this one widened.
 *
 * A SECOND HELPER WAS REJECTED because a test needing both would have to
 * compose two wrappers by hand, and the great majority of admin tests need
 * both. This module is in practice "render with the application's shell in
 * scope", and that is the thing there should be one of.
 *
 * THE NAME IS NOW NARROWER THAN WHAT IT DOES, and renaming it was measured and
 * declined: 121 files import it by path and a dozen documents and docblocks
 * name it in prose, so the rename would be a large mechanical diff across test
 * files in a change whose subject is production code. It is a fair thing for a
 * later lane to do; it is not worth doing inside this one.
 *
 * ## Import it INSTEAD of `@testing-library/react`
 *
 * It re-exports the whole module, so `screen`, `fireEvent`, `waitFor` and the
 * rest come from here too and only the import line changes. A test that needs its
 * own `wrapper` may still pass one; it replaces this one, and must then mount the
 * provider itself.
 *
 * `renderHook` IS OVERRIDDEN TOO, and that is not symmetry for its own sake. A
 * hook is the likeliest thing in this tree to call `useClubTime()` directly — the
 * migrated components mostly wrap it in one — and a `renderHook` re-exported
 * bare from Testing Library mounts no provider, so it throws while its import
 * line says otherwise. Whoever hits that has done nothing wrong.
 *
 * ## The default zone is deliberately the one the suite already assumed
 *
 * `CLUB_TIME_TEST_ZONE` is `Pacific/Auckland`, which is what `APP_TIME_ZONE`
 * resolves to under test, so every existing assertion keeps its exact expected
 * string and this migration changes no test's MEANING — only where the zone came
 * from.
 *
 * THAT ALSO MEANS A TEST USING THE DEFAULT PROVES NOTHING ABOUT ZONE AUTHORITY,
 * and saying so is the point. Under `Pacific/Auckland` the persisted zone and
 * the environment agree, so the migrated code and the code it replaced give the
 * identical answer — exactly the "false and green" trap `CLUB_TIME_KERNEL.md`
 * warns about. A test that means to assert the club's zone is the authority
 * passes a zone the environment does NOT hold — `America/Denver` is the house
 * choice, because it is behind UTC where these defects show — and asserts an
 * answer only that zone produces. `club-time-client-boundary.test.tsx` is the
 * suite that does that, and it declares its own zone constants rather than
 * importing them from here: a divergent zone exported from the file whose whole
 * job is the CONVENIENT default is an invitation to reach for it by accident.
 */

/** The zone the environment also resolves to, so shapes are unchanged. */
export const CLUB_TIME_TEST_ZONE = "Pacific/Auckland";

/**
 * The currency and locale the environment also resolves to, on exactly the
 * terms the zone above is chosen on: they are what `APP_CURRENCY` and
 * `APP_LOCALE` fall back to, so every existing assertion keeps its exact
 * expected string and this migration changes no test's MEANING.
 *
 * And, on exactly the same terms, A TEST USING THESE PROVES NOTHING ABOUT
 * FORMAT AUTHORITY. Under `NZD`/`en-NZ` the recorded setting and the build-time
 * constant agree, so a component that still reads `@/config/operational` gives
 * the identical answer. A test that means to assert the club's setting is the
 * authority passes something the environment does NOT hold — `CHF` and `de-CH`
 * are the house choices — and asserts an answer only that produces.
 */
const CLUB_FORMAT_TEST_CURRENCY = CLUB_CURRENCY_FALLBACK;
const CLUB_FORMAT_TEST_LOCALE = CLUB_LOCALE_FALLBACK;

export function ClubTimeTestProvider({ children }: { children: ReactNode }) {
  return (
    <ClubFormatProvider
      currencyCode={CLUB_FORMAT_TEST_CURRENCY}
      locale={CLUB_FORMAT_TEST_LOCALE}
    >
      <ClubTimeProvider zone={CLUB_TIME_TEST_ZONE}>{children}</ClubTimeProvider>
    </ClubFormatProvider>
  );
}

export function render(
  ui: ReactElement,
  options?: Parameters<typeof rtlRender>[1],
): ReturnType<typeof rtlRender> {
  return rtlRender(ui, { wrapper: ClubTimeTestProvider, ...options });
}

export function renderHook<Result, Props>(
  hook: (initialProps: Props) => Result,
  options?: Parameters<typeof rtlRenderHook<Result, Props>>[1],
): ReturnType<typeof rtlRenderHook<Result, Props>> {
  return rtlRenderHook(hook, { wrapper: ClubTimeTestProvider, ...options });
}

export * from "@testing-library/react";
