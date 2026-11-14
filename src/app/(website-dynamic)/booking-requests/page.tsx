import type { Metadata } from "next";
import { BookingRequestForm } from "@/components/website/booking-request-form";
import { EmbeddedPageContentParts } from "@/components/website/embedded-page-content-parts";
import {
  getCachedClubIdentity,
  getCachedDefaultLodgeCapacity,
} from "@/lib/public-layout-config";
import { setupInProgressMetadata } from "@/lib/website-setup-metadata";
import { buildEmbeddedBody } from "@/lib/page-content-embeds";
import {
  getPublishedPageContentByPath,
  pageContentHtmlToPlainText,
} from "@/lib/page-content-html";

/**
 * The public booking-request page: a database-backed built-in CMS page with the
 * same makeup as `/join/apply` — a code-backed route that renders its
 * `/booking-requests` PageContent row through the token pipeline. Its seeded body
 * is `{{booking-requests}}`, which renders the request-to-book form.
 *
 * ## Why it sits in `(website-dynamic)` rather than `(website)` (#2818 decision 2)
 *
 * Everything about the page says fixed-nonce group: it is CMS-backed, its content
 * is twice-sanitised admin HTML, and it sits beside `/contact` and `/join/apply`
 * in the admin's Page Content list. It is here anyway for two reasons. D1's
 * fixed-nonce census is an owner decision pinned at five addresses, and widening
 * it is a decision about the CSP rather than a routing detail. And this is one of
 * the two pages where an anonymous visitor types the most personal information,
 * so the unguessable per-request nonce is worth more here than a stored copy of a
 * form that is `force-dynamic` regardless.
 *
 * The consequences of that placement are all deliberate: no Google Analytics
 * (decision 3), no warm-up declaration (decision 4), and the pre-setup holding
 * screen in front of it exactly as before.
 *
 * `force-dynamic` is declared here as well as on the group layout, because each
 * route in this group is per-request for a permanent reason of its own and the
 * reason belongs next to the route (`check-website-render-modes.mjs` requires
 * both).
 *
 * The two tokenised confirmation flows — `respond/[token]` and `verify/[token]` —
 * are siblings under this same directory; their URLs are unchanged.
 *
 * ## Advertising this page is OPT-IN, and one field decides both halves
 *
 * The seeded row carries an EMPTY `menuTitle`, so out of the box the page keeps
 * the unlisted behaviour #2421 established: reachable by its address and by the
 * links the club already sends, absent from the navigation, and `noindex`. A club
 * that wants the form advertised types a menu title under Site Appearance &
 * Content → Page Content, and that one edit both adds the nav entry
 * (`listWebsiteMenuPages`) and makes the page indexable ({@link generateMetadata}
 * below). Reading the SAME field in both places is the point: a nav-listed page a
 * search engine is told to ignore, or an indexable page the site itself will not
 * link to, are both states nobody chose (#2818 decision 1).
 */
export const dynamic = "force-dynamic";

/**
 * Is the club advertising this page? A non-empty `menuTitle` is the signal — see
 * the docblock above.
 */
function isAdvertised(menuTitle: string | undefined): boolean {
  return (menuTitle ?? "").trim().length > 0;
}

export async function generateMetadata(): Promise<Metadata> {
  // Pre-setup, before any lookup (#2420 F1). See setupInProgressMetadata().
  const holdingScreen = await setupInProgressMetadata();

  if (holdingScreen) {
    return holdingScreen;
  }

  const [page, { name: clubName }] = await Promise.all([
    getPublishedPageContentByPath("/booking-requests"),
    getCachedClubIdentity(),
  ]);

  return {
    title: page?.title ?? "Booking Requests",
    description:
      pageContentHtmlToPlainText(page?.headerText ?? "") ||
      `Request a stay with ${clubName} without creating an account.`,
    // Stated in BOTH directions rather than only the opt-out one. The sibling
    // layout already declares noindex for this whole directory, so omitting the
    // key would inherit the right answer for the unlisted case by accident — and
    // would silently stop working if that layout ever moved. An unpublished or
    // missing row also lands here as "not advertised", which is correct: the page
    // falls back to the bare form and nothing has asked for it to be indexed.
    robots: isAdvertised(page?.menuTitle)
      ? { index: true, follow: true }
      : { index: false, follow: false },
  };
}

export default async function BookingRequestsPage() {
  const [page, clubIdentity, lodgeCapacity] = await Promise.all([
    getPublishedPageContentByPath("/booking-requests"),
    getCachedClubIdentity(),
    getCachedDefaultLodgeCapacity(),
  ]);
  // DB-resolved default lodge capacity, spread over the identity so the form's
  // guest cap tracks the real lodge rather than the static fallback (#1982 R1).
  const liveClubIdentity = { ...clubIdentity, lodgeCapacity };
  const embeddedBody = page ? await buildEmbeddedBody(page.contentHtml) : [];

  const caption = page?.caption ?? "Request a stay";
  const title = page?.title ?? "Booking Requests";
  // Only a GENUINE stored `headerText` may reach the HTML sink. It is admin HTML,
  // sanitised on write and again on read by the published-row reader used above.
  const storedHeaderHtml = page?.headerText.trim() ? page.headerText : null;
  // The fallback is a string this code COMPOSES, and it interpolates a club-set
  // value (`lodgeName`) that no sanitiser has ever seen. It renders as an escaped
  // text child, never through `dangerouslySetInnerHTML` — the branch a deployment
  // with no seeded row takes is exactly the branch that must not be an HTML sink
  // (#2818 decision 6).
  const fallbackHeaderText = `Request a stay at ${liveClubIdentity.lodgeName} without creating an account. We'll email you to confirm your address, then review and price your request.`;

  return (
    <>
      <section
        className="dynamic-header bg-gradient-to-br from-brand-charcoal to-brand-deep py-16 text-brand-snow sm:py-20"
        data-page-slug="booking-requests"
      >
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <span className="website-eyebrow mb-4">{caption}</span>
          <h1 className="font-heading text-4xl font-bold tracking-tight sm:text-5xl">
            {title}
          </h1>
          {storedHeaderHtml ? (
            <div
              className="mt-4 max-w-2xl text-lg text-brand-snow/80"
              dangerouslySetInnerHTML={{ __html: storedHeaderHtml }}
            />
          ) : (
            <p className="mt-4 max-w-2xl text-lg text-brand-snow/80">
              {fallbackHeaderText}
            </p>
          )}
        </div>
      </section>

      <section
        className="dynamic-body bg-brand-snow py-16 sm:py-20"
        data-page-slug="booking-requests"
      >
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          {embeddedBody.length > 0 ? (
            <EmbeddedPageContentParts
              parts={embeddedBody}
              pageSlug="booking-requests"
              keyPrefix="booking-requests"
              clubIdentity={liveClubIdentity}
            />
          ) : (
            <BookingRequestForm club={liveClubIdentity} />
          )}
        </div>
      </section>
    </>
  );
}
