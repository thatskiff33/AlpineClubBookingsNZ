import Link from "next/link";
import { AnalyticsPreferencesLink } from "@/components/analytics-preferences-link";
import { WebsiteFooterShell } from "@/components/website-footer-shell";
import { WebsiteLogo } from "@/components/website-logo";
import { calendarDateParts } from "@/lib/club-time";
import { clubTime } from "@/lib/club-time/server";
import { getCachedClubIdentity } from "@/lib/public-layout-config";
import { getSiteFooterContent } from "@/lib/site-content";

// Styles the admin-editable footer HTML (sanitised on write and read) so the
// section headings, link lists, and blurb paragraph keep the same look the
// static footer used. The stored markup uses <h3> section headings, but those
// sit directly under the page <h1>, which is an h1->h3 heading-order skip on
// sparse pages (axe heading-order). demoteFooterHeadings() rewrites them to
// <h2> at render time, so the heading selectors below target h2 to preserve
// the identical visual size/weight.
const FOOTER_HTML_CLASSES =
  "[&_h2]:mb-3 [&_h2]:font-heading [&_h2]:text-lg [&_h2]:font-semibold " +
  "[&_h2]:text-brand-snow [&_ul]:text-sm [&_ul>li+li]:mt-2 [&_p]:text-sm " +
  "[&_p]:leading-relaxed [&_a]:transition-colors [&_a:hover]:text-brand-gold";

// The footer columns are siblings under the page <h1>, so their section
// headings belong at <h2>. The stored admin HTML (starter default + backfill
// migration) uses <h3>; normalise the level here at render time. This is a
// presentational a11y fix only — the stored content and its sanitiser
// allowlist are untouched, and FOOTER_HTML_CLASSES styles the resulting h2
// identically to the previous h3.
function demoteFooterHeadings(html: string): string {
  return html.replace(/<(\/?)h3\b/gi, "<$1h2");
}

// Tailwind needs literal class names, so map the computed column count.
const GRID_COLUMNS_CLASS: Record<number, string> = {
  1: "md:grid-cols-1",
  2: "md:grid-cols-2",
  3: "md:grid-cols-3",
};

export async function WebsiteFooter({
  logoUrl,
  logoDataUrl,
}: {
  logoUrl?: string | null;
  logoDataUrl?: string | null;
}) {
  const [club, raw, clubIdentity] = await Promise.all([
    clubTime(),
    getSiteFooterContent(),
    getCachedClubIdentity(),
  ]);
  const clubName = clubIdentity.name;
  const blurbHtml = demoteFooterHeadings(raw.blurbHtml);
  const quickLinksHtml = demoteFooterHeadings(raw.quickLinksHtml);
  const affiliationsHtml = demoteFooterHeadings(raw.affiliationsHtml);

  // The club-info column always renders because it carries the code-managed
  // logo block; an empty blurb only removes its paragraph. The link columns
  // disappear entirely when an admin saves them empty.
  const columnCount =
    1 + (quickLinksHtml ? 1 : 0) + (affiliationsHtml ? 1 : 0);

  return (
    // The <footer> element itself is a client shell so its data-page-slug comes
    // from the URL rather than a request header (#2352) — see
    // website-footer-shell.tsx. Everything inside stays server-rendered.
    <WebsiteFooterShell className="border-t border-brand-gold/15 bg-brand-charcoal text-brand-snow/90">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div
          className={`grid grid-cols-1 gap-8 ${GRID_COLUMNS_CLASS[columnCount]}`}
        >
          {/* Club info (logo is code-rendered; blurb is admin-editable) */}
          <div>
            <div className="mb-3">
              <WebsiteLogo
                label={clubName}
                logoUrl={logoUrl}
                logoDataUrl={logoDataUrl}
                className="max-h-10 max-w-40 brightness-110"
                textClassName="text-brand-snow"
              />
            </div>
            {blurbHtml ? (
              <div
                className={FOOTER_HTML_CLASSES}
                /* Admin-authored footer HTML, sanitised on write and read. nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml */
                dangerouslySetInnerHTML={{ __html: blurbHtml }}
              />
            ) : null}
          </div>

          {/* Quick links (admin-editable) */}
          {quickLinksHtml ? (
            <div
              className={FOOTER_HTML_CLASSES}
              /* Admin-authored footer HTML, sanitised on write and read. nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml */
              dangerouslySetInnerHTML={{ __html: quickLinksHtml }}
            />
          ) : null}

          {/* Affiliations (admin-editable) */}
          {affiliationsHtml ? (
            <div
              className={FOOTER_HTML_CLASSES}
              /* Admin-authored footer HTML, sanitised on write and read. nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml */
              dangerouslySetInnerHTML={{ __html: affiliationsHtml }}
            />
          ) : null}
        </div>

        {/* Legal row stays code-rendered: auto year, non-removable links. */}
        <div className="mt-10 border-t border-brand-ridge/30 pt-6 text-center text-sm text-brand-snow/85">
          <p>
            {/* The CLUB's year, not the server's (CT-4, #2870;
                INV-CONFIG-002). `new Date().getFullYear()` is the host's
                calendar year, so for the hours either side of New Year a
                container and its club disagree about which year the copyright
                line names. `clubToday` asks the club's own calendar. */}
            &copy; {calendarDateParts(club.today()).year} {clubName}{" "}
            Incorporated. All rights reserved.
          </p>
          <p className="mt-2 space-x-4">
            <Link
              href="/privacy"
              className="transition-colors hover:text-brand-gold"
            >
              Privacy Policy
            </Link>
            <span aria-hidden="true">&middot;</span>
            <Link
              href="/terms"
              className="transition-colors hover:text-brand-gold"
            >
              Terms of Service
            </Link>
            {/* Renders nothing unless the analytics runtime has published that a
                preferences control should be offered (#2573). The separator lives
                inside the component so a club with analytics off gets neither. */}
            <AnalyticsPreferencesLink className="underline-offset-4 transition-colors hover:text-brand-gold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold" />
          </p>
        </div>
      </div>
    </WebsiteFooterShell>
  );
}
