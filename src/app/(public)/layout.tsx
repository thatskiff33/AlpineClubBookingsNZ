import { headers } from "next/headers";
import { AppProviders } from "@/components/app-providers";
import { SiteBanners } from "@/components/site-banners";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { WebsiteHeader } from "@/components/website-header";
import { WebsiteFooter } from "@/components/website-footer";
import { clubThemeFontVariableClassName } from "@/lib/club-theme-fonts";
import { CSP_NONCE_HEADER } from "@/lib/csp";
import {
  getCachedClubIdentity,
  getCachedCurrentSiteBanners,
  getCachedDefaultLodgeCapacity,
  getCachedWebsiteThemeRenderState,
} from "@/lib/public-layout-config";

/**
 * Every `(public)` route stays per-request, declared here for the whole group
 * (#2352 slice 1). MEASURED, not tidiness: without this line `pnpm run build`
 * fails.
 *
 * This group is out of #2352's scope by decision — `/login` permanently (D7), and
 * the rest are token-bearing or recovery screens (`/pay/[token]`, `/chores/[token]`,
 * `/family-invite/[token]`, `/membership-cancellation/[token]`, and the recovery
 * flows) that must never be stored. (The booking-request and school-booking pages
 * and their token confirmations moved OUT of this group to `(website-dynamic)` in
 * #2818 — they are no longer here.) It used to be dynamic by ACCIDENT: the `auth()`
 * call this layout no longer makes was a dynamic API read, and removing it left the
 * group's build-time behaviour resting on the `headers()` read below — which
 * happens only AFTER the layout's four database reads have resolved (five until
 * #2573 removed the module-flag read with the analytics runtime it fed). During
 * `docker build` there is no database (`Dockerfile` points `DATABASE_URL` at an
 * unreachable host), so a page's own unguarded query rejected before the bailout
 * was reached, and the build stopped on an "Error occurred prerendering page" for
 * one of this group's routes.
 *
 * Declaring it on the LAYOUT covers every route in the group, including any added
 * later, which is what a per-page line would not. The `(website)` group states its
 * modes per route instead, because there exactly one of them is deliberately
 * different — see `scripts/ci/check-website-render-modes.mjs`.
 */
export const dynamic = "force-dynamic";

export default async function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // No `auth()` here since #2352: the only thing it fed was the shared public
  // header's one signed-in boolean, and the header now ships both forms of its
  // CTA pair and lets the browser pick from the non-secret marker cookie (D2).
  // These routes are still rendered per request — see the `force-dynamic` above,
  // which is now what says so — so nothing about their freshness changes; they
  // simply no longer resolve a session to decide a link label.
  //
  // The module-flag read that used to sit in this list is gone with the analytics
  // runtime it fed (#2573): nothing else in this layout is module-gated, so keeping
  // the query would have been a database round trip per request for a value nobody
  // reads.
  const [lodgeCapacity, siteBanners, theme, clubIdentity] = await Promise.all([
    // Default lodge: public-site identity copy (per-lodge figures come
    // from the {{lodge-capacity:slug}} content token).
    getCachedDefaultLodgeCapacity(),
    getCachedCurrentSiteBanners(),
    getCachedWebsiteThemeRenderState(),
    getCachedClubIdentity(),
  ]);
  const liveClubIdentity = { ...clubIdentity, lodgeCapacity };
  const requestHeaders = await headers();
  const nonce = requestHeaders.get(CSP_NONCE_HEADER) ?? undefined;

  return (
    <AppProviders clubIdentity={liveClubIdentity} nonce={nonce}>
      <div
        className={`${clubThemeFontVariableClassName} app-theme-scope min-h-screen flex flex-col bg-background text-foreground`}
      >
        <style
          dangerouslySetInnerHTML={{ __html: theme.appCss }}
          data-site-style="club-theme"
        />
        <a
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:ring-2 focus:ring-ring"
          href="#main-content"
        >
          Skip to main content
        </a>
        <SiteBanners banners={siteBanners} />
        <WebsiteHeader
          logoUrl={theme.logoUrl}
          logoDataUrl={theme.logoDataUrl}
        />
        <main className="flex-1" id="main-content">
          <div className="mx-auto flex w-full max-w-7xl justify-end px-4 pt-4 sm:px-6 lg:px-8">
            <ThemeSwitcher className="w-full max-w-sm" />
          </div>
          <div className="flex min-h-[calc(100vh-18rem)] items-center justify-center p-4">
            {children}
          </div>
        </main>
        <WebsiteFooter
          logoUrl={theme.logoUrl}
          logoDataUrl={theme.logoDataUrl}
        />
        {/*
          NO analytics runtime here, and that is the safe-route policy enforced in
          code rather than documented (#2573, owner decision section 7).

          Every route in this group is on the owner's exclusion list. `/login`,
          `/login/verify`, `/login/enroll`, `/login/magic` and `/register` are
          authentication screens; `/forgot-password`, `/reset-password`,
          `/change-password`, `/verify-email` and `/confirm-email-change` are
          recovery flows; and `/pay/[token]`, `/chores/[token]`,
          `/family-invite/[token]` and `/membership-cancellation/[token]` all carry
          a one-time credential in the URL. Analytics must not load on any of them,
          and a URL from any of them must never reach Google. (The booking-request
          and school-booking token flows are the same shape, but now live in
          `(website-dynamic)`, whose chrome DOES mount analytics — there
          `isAnalyticsEligiblePath()` is the sole guard, and it refuses those
          tokenised paths.)

          Mounting the component and letting its route policy refuse would work, and
          `isAnalyticsEligiblePath()` does refuse every address above — but not
          mounting it at all is the stronger statement: there is no code path from
          this group to a Google request, so a future change to the policy cannot
          accidentally open one. `analytics-route-policy.test.ts` still asserts the
          predicate refuses these paths, so the two halves agree.
        */}
      </div>
    </AppProviders>
  );
}
