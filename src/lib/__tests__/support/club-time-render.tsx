import {
  render as rtlRender,
  renderHook as rtlRenderHook,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { ClubTimeProvider } from "@/components/club-time-provider";

/**
 * Testing Library's `render`, with the club's timezone in scope (CT-4, #2870;
 * epic #2988).
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

export function ClubTimeTestProvider({ children }: { children: ReactNode }) {
  return <ClubTimeProvider zone={CLUB_TIME_TEST_ZONE}>{children}</ClubTimeProvider>;
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
