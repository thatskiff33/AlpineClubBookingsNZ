import { AnalyticsConsent } from "@/components/analytics-consent";
import { ClubTimeProvider } from "@/components/club-time-provider";
import { HelpWidgetPublic } from "@/components/help-widget/help-widget-public";
import { SiteBanners } from "@/components/site-banners";
import { WebsiteHeader } from "@/components/website-header";
import { WebsiteFooter } from "@/components/website-footer";
import { loadEmailMessageSettings } from "@/lib/email-message-settings";
import { clubThemeFontVariableClassName } from "@/lib/club-theme-fonts";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import {
  getCachedAnalyticsRuntimeConfig,
  getCachedClubIdentity,
  getCachedWebsiteThemeRenderState,
} from "@/lib/public-layout-config";
import { clubTimeZone } from "@/lib/club-time/server";
import { getCurrentSiteBanners } from "@/lib/site-banners";
import { SETUP_IN_PROGRESS_COPY } from "@/lib/setup-in-progress-screen";

/**
 * The public website's chrome — every visible and invisible thing that wraps a
 * public page — in ONE component, composed by BOTH public route-group layouts.
 *
 * ## Why it exists
 *
 * Owner decision, 3 Aug 2026 (#2352): the fixed per-release CSP nonce covers
 * exactly the five approved addresses (`/`, the CMS catch-all, `/join`,
 * `/contact`, `/join/apply`). The three pages the first cut had swept in —
 * `/hut-leader-instructions`, `/join/[code]`, `/join/verify/[token]` — go back to
 * a freshly minted per-request nonce, and #2818 put five more routes alongside
 * them (`/booking-requests`, `/school-bookings` and their three token flows), for
 * eight in the per-request group.
 *
 * A route can only take its nonce from the layout above it, so two different
 * nonce sources means two layouts, which means two route groups. The obvious way
 * to do that is to copy the chrome into the second layout, and the owner's
 * direction ruled that out explicitly: **no duplicated markup.** A copy would
 * drift — a banner, a skip link, a help widget or a theme class added to one and
 * not the other — and the drift would be invisible until a visitor found it.
 *
 * So the chrome lives here, and each layout is three lines: resolve a nonce, hand
 * it to this component, render the children. The difference between the two
 * groups is reduced to the one thing that is genuinely different.
 * `scripts/ci/check-website-render-modes.mjs` fails the build if either layout
 * grows chrome of its own or stops composing this component.
 *
 * ## It reads NEITHER the session NOR the request, and that is the whole of slice 1
 *
 * Those were the two lines that made every public page a full server render on
 * every visit — `auth()` and `headers()`, in the layout this component was
 * extracted from, shared by every route under it. A production build prerendered
 * ZERO pages because of them. With both gone, `[...slug]` (the admin-authored CMS
 * pages) can be served from full-route ISR.
 *
 * What replaced each read:
 *  • `auth()` — the header rendered ONE boolean from it (the account button's
 *    label and target, the same pair in the mobile drawer, and the Book Now
 *    destination; no member name, email or role has ever appeared here). Both
 *    forms now ship in the page and the browser picks from a non-secret marker
 *    cookie (D2, `src/lib/signed-in-hint.ts`).
 *  • `headers()` — supplied the CSP nonce and the footer's page slug. The nonce is
 *    now a PROP, which is what lets the two groups differ; the slug comes from
 *    `usePathname()` in the footer's own shell.
 *
 * Calling either one HERE would un-do the change for both groups at once: Next
 * opts a route out of static rendering the moment anything in its tree reads the
 * request, and the only symptom is the CPU bill.
 * `scripts/ci/check-website-render-modes.mjs` fails the build on the structural
 * half of that, `scripts/ci/check-website-prerender-manifest.mjs` on the build's
 * own record of it, and the ISR route's test asserts `generateStaticParams` still
 * returns `[]`.
 *
 * The per-request group's layout reads `headers()` for its nonce, and that is
 * safe precisely because it is in the OTHER layout: the read opts that group's
 * routes out of static rendering, which is what those routes want anyway
 * (`force-dynamic`), and it cannot reach the five.
 */
export async function WebsiteChrome({
  nonce,
  children,
}: {
  /**
   * The CSP nonce to stamp on the analytics `<Script>`, or `undefined` when the
   * request carried none.
   *
   * The two callers resolve it differently and that difference IS the D1 split:
   * `(website)/layout.tsx` passes the fixed per-release value, so a stored page's
   * inline scripts still match the policy on a later response;
   * `(website-dynamic)/layout.tsx` passes the per-request value from the request's
   * own CSP header, the way every member and admin page does.
   *
   * It reaches server-rendered markup only. `AnalyticsConsent` injects its scripts
   * from the browser after hydration, and takes the nonce from the LOADED DOCUMENT
   * rather than from this prop — the two differ after a soft navigation between the
   * groups, and only the document's value is the one the policy in force names. See
   * `src/components/analytics-consent.tsx`.
   */
  nonce: string | undefined;
  children: React.ReactNode;
}) {
  const [theme, siteBanners, modules, clubZone] = await Promise.all([
    // Tagged cache wrapper, matching (public)/layout.tsx (#2322): this read used
    // to hit ClubTheme on every request. The `public-layout:theme` tag is
    // revalidated on theme save by the admin/site-style PUT.
    getCachedWebsiteThemeRenderState(),
    getCurrentSiteBanners(),
    loadEffectiveModuleFlags(),
    // CT-4 (#2870): the club's PERSISTED timezone, so the public site's client
    // components can render an instant in club time without asking the viewer's
    // browser what time it is (INV-CONFIG-002). Read alongside the others rather
    // than sequenced after them - it is one primary-key read of a one-row table
    // and this component already performs three. It never throws: an absent row
    // or an unreachable database falls through to the environment seed and then
    // to the documented default, which is the same judgement every other reader
    // of this setting makes.
    clubTimeZone(),
    // NOTE: the club identity is NOT fetched here. It is used only by the
    // pre-setup branch below, which since #2420 is a rare fallback rather than
    // the pre-setup norm, so it is resolved inside that branch — the same
    // treatment loadEmailMessageSettings() already gets, and for the same
    // reason: keep the hot path's read set to what it actually renders.
  ]);
  // Sequenced after the module read on purpose (#2573): Admin -> Modules is the
  // master switch, so a club with analytics off performs no analytics query at all.
  // The resolver never throws — a read failure resolves to `null` and is logged —
  // so this cannot break a public page render.
  const analyticsConfig = await getCachedAnalyticsRuntimeConfig(
    modules.analytics,
  );

  const themeStyle = (
    <style
      dangerouslySetInnerHTML={{ __html: theme.css }}
      data-site-style="club-theme"
    />
  );

  if (!theme.isComplete && !theme.readFailed) {
    // FALLBACK, not the main path (#2420). `src/proxy.ts` answers every
    // public-website address with 503 and this same screen while setup is
    // incomplete, so an ordinary request never gets here — and it answers on
    // `isPublicWebsitePath()`, which claims BOTH public route groups, so the
    // eight per-request routes are gated pre-setup exactly as the five are.
    //
    // What still does reach here is a URL the proxy RUNS on but the gate does not
    // CLAIM. (#2404 removed the matcher's prefetch exemption entirely, so the
    // header route in — `purpose: prefetch`, with or without `RSC` — is closed;
    // there is no header a caller can set that skips the proxy.) The gate refuses
    // asset-extension paths on purpose, because the holding screen is an HTML
    // document and must never answer a request for an image, so any such URL that
    // reaches a render lands here ungated: `/API/x.png` is the live case, claimed
    // by no rewrite rule (the general rule's `(?!api/)` lookahead is
    // case-insensitive) and matched by no `/api` route either, because Next's
    // route table is case-sensitive. This branch is what stops those seeing the
    // real site. Those responses are still 200, because a layout cannot set a
    // status; that is the whole reason the authoritative decision moved to the
    // proxy.
    //
    // `!readFailed` is the other half, and the asymmetry with the proxy gate is
    // deliberate (#2420 review F4). The gate answers an unreadable database with
    // 503, which is exactly what 503 means. This component's only available answer
    // is a 200, and a 200 saying "site setup in progress" is a claim about the
    // CLUB, not about the request — one that `/`'s anonymous cache entry would
    // then repeat for 60 seconds (300 stale) after a two-second blip on a club
    // that launched years ago. So the holding screen is painted only when the
    // database positively reports an unfinished setup. A failed read falls
    // through to the real site, whose own queries then fail honestly.
    //
    // DB-first contact address (C6 #1985): resolved only when the pre-setup
    // fallback screen actually renders, so the hot path adds no extra query on
    // the normal path. Reads EmailMessageSetting.contactEmail with the config
    // default as fallback — never a synchronous club.json read. The setup gate
    // reads the same two sources so the two screens can never name the club or
    // the contact address differently.
    const [{ contactEmail }, clubIdentity] = await Promise.all([
      loadEmailMessageSettings(),
      getCachedClubIdentity(),
    ]);
    return (
      <ClubTimeProvider zone={clubZone}>
        <div
          className={`${clubThemeFontVariableClassName} website-theme min-h-screen bg-background text-foreground`}
        >
          {themeStyle}
          <main className="flex min-h-screen items-center justify-center px-4 py-16">
            <section className="mx-auto max-w-2xl text-center">
              <p className="website-eyebrow mb-4">
                {SETUP_IN_PROGRESS_COPY.eyebrow}
              </p>
              <h1 className="font-heading text-4xl font-bold text-brand-charcoal sm:text-5xl">
                {SETUP_IN_PROGRESS_COPY.heading(clubIdentity.name)}
              </h1>
              <p className="mx-auto mt-5 max-w-xl text-base leading-7 text-brand-deep/80 sm:text-lg">
                {SETUP_IN_PROGRESS_COPY.body}
              </p>
              <p className="mt-6 text-sm text-brand-ridge">
                {SETUP_IN_PROGRESS_COPY.contactPrefix}{" "}
                <a
                  href={`mailto:${contactEmail}`}
                  className="font-medium text-brand-charcoal underline decoration-brand-gold/70 decoration-2 underline-offset-4"
                >
                  {contactEmail}
                </a>
              </p>
            </section>
          </main>
        </div>
      </ClubTimeProvider>
    );
  }

  /**
   * CT-4 (#2870), epic #2988. One of the epic's two client-boundary mount points:
   * this component is composed by BOTH public route-group layouts, so wrapping
   * here is what puts the club's zone in reach of every `"use client"` component
   * on the public website - the ski-field conditions stamp, the site banners, the
   * footer - without either layout changing. `AppProviders` covers the other five
   * route groups, and `club-time-provider-mount-census.test.tsx` fails if a group
   * ever appears that neither covers. See `club-time-provider.tsx` for why the
   * hook throws rather than falling back to a plausible wrong zone.
   *
   * BOTH RETURNS ARE WRAPPED, including the pre-setup holding screen above. That
   * screen renders no timestamp today, but the guarantee the census enforces is
   * "every page has a provider" rather than "every page that currently needs
   * one", and a conditional guarantee is the kind that stops holding quietly.
   */
  return (
    <ClubTimeProvider zone={clubZone}>
      <div
        className={`${clubThemeFontVariableClassName} website-theme min-h-screen flex flex-col bg-background text-foreground`}
      >
        {themeStyle}
        <a
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:ring-2 focus:ring-ring"
          href="#main-content"
        >
          Skip to main content
        </a>
        <SiteBanners banners={siteBanners} />
        <WebsiteHeader logoUrl={theme.logoUrl} logoDataUrl={theme.logoDataUrl} />
        <main className="flex-1" id="main-content">
          {children}
        </main>
        <WebsiteFooter logoUrl={theme.logoUrl} logoDataUrl={theme.logoDataUrl} />
        <AnalyticsConsent config={analyticsConfig} nonce={nonce} />
        {/* Public help widget: hardcoded llmEnabled=false; hides itself while the
            AnalyticsConsent banner occupies the same bottom corner. */}
        <HelpWidgetPublic />
      </div>
    </ClubTimeProvider>
  );
}
