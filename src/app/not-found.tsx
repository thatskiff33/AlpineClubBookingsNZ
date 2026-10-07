import Link from "next/link";
import { buildBookingLoginPath } from "@/lib/auth-redirect";
import { getPublishedPageContentByPath } from "@/lib/page-content-html";
import { buildEmbeddedBody } from "@/lib/page-content-embeds";
import { getCachedClubIdentity } from "@/lib/public-layout-config";
import { EmbeddedPageContentParts } from "@/components/website/embedded-page-content-parts";
import { ClubFormatProvider } from "@/components/club-format-provider";
import { clubFormatValues } from "@/lib/club-format-server";

/**
 * Must render per-request (issue #2356), for the same reason `/display` must
 * (`src/app/display/page.tsx`): the CSP is nonce-only in production and Next
 * stamps the nonce into its inline bootstrap/RSC scripts only during DYNAMIC
 * rendering, reading it from the request's own CSP header. Without this the
 * `/_not-found` route is prerendered at build time — Next then also copies it
 * to `pages/404.html`, which `base-server` serves for unmatched URLs — and that
 * artefact ships seven inline `<script>` tags with no `nonce`, every one of them
 * blocked by the very policy on the same response.
 *
 * It removes two more defects that lived in the same artefact, both caused by
 * the build-time render having no database and no request:
 *  • the `/404` page-content lookup failed at build and was swallowed
 *    by the surrounding catch (see `loadNotFoundContent()` below), so the
 *    admin-authored `/404` CMS page could not appear in it — the hardcoded
 *    fallback was frozen into the HTML.
 *  • the root layout's `generateMetadata()` fell back to `SAFE_DEFAULT_CONFIG`,
 *    baking the template placeholder ("Example Mountain Club") and
 *    `http://localhost:3000` into that artefact's title and OG tags.
 *
 * Both were confined to the artefact, which is why nobody reported them: the
 * `(website)/[...slug]` CMS catch-all already claimed every human-plausible
 * mistyped or bot-probed URL and rendered this boundary dynamically via
 * `notFound()`, with the real club name and nonced scripts. Only two synthetic
 * shapes (`/_next/data/*` and `/_error`) reached the frozen copy — which is also
 * why the cost of this change is small, since the app was already paying for the
 * dynamic render nearly everywhere.
 * `scripts/ci/check-prerendered-script-nonces.mjs` fails the build if a
 * prerendered route ever ships unnonced inline scripts again.
 */
export const dynamic = "force-dynamic";

function pageSlugFromPath(path: string) {
  return path.replace(/^\//, "") || "home";
}

/**
 * Every read this page needs, or `null` if any of them fails.
 *
 * The whole thing is guarded, not just the page lookup: `buildEmbeddedBody()`
 * resolves gallery/form/calendar embeds and `getCachedClubIdentity()` reads
 * config, so either can throw when the database is unreachable or an embed
 * reference is broken. This is the LAST boundary in the render — a throw here
 * escalates to the nearest error boundary and turns a 404 into a 500, on a URL
 * shape that used to be served from a static file and so could not fail at all
 * (#2356 review). Degrading to the hardcoded fallback below keeps "page not
 * found" available whatever the database is doing.
 */
async function loadNotFoundContent() {
  try {
    // Published filter (#2440): an unpublished /404 row (only reachable by a
    // hand-written row — the admin routes refuse to unpublish system pages)
    // degrades to the hardcoded fallback below, same as a missing row.
    const page = await getPublishedPageContentByPath("/404");
    if (!page) return null;

    // The club's format (#3565) is read here, inside the same guard, because
    // an embedded booking-request form below reads `useClubFormat()` in the
    // browser and this page sits outside both chrome components' providers.
    // `cache()` shares the read with `buildEmbeddedBody()`, so it is one read.
    const [embeddedBody, clubIdentity, format] = await Promise.all([
      buildEmbeddedBody(page.contentHtml),
      getCachedClubIdentity(),
      clubFormatValues(),
    ]);

    return { page, embeddedBody, clubIdentity, format };
  } catch {
    return null;
  }
}

export default async function NotFound() {
  const content = await loadNotFoundContent();

  if (content) {
    const { page, embeddedBody, clubIdentity, format } = content;
    const headerHtml = { __html: page.headerText };
    const pageSlug = pageSlugFromPath(page.path);

    return (
      <>
        <section
          className="dynamic-header bg-gradient-to-br from-brand-charcoal to-brand-deep py-16 text-brand-snow sm:py-20"
          data-page-slug={pageSlug}
        >
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            {page.caption && (
              <span className="website-eyebrow mb-4">{page.caption}</span>
            )}
            <h1 className="font-heading text-4xl font-bold tracking-tight sm:text-5xl">
              {page.title}
            </h1>
            {page.headerText && (
              <div
                className="mt-4 max-w-2xl text-lg text-brand-snow/80"
                dangerouslySetInnerHTML={headerHtml}
              />
            )}
          </div>
        </section>

        <section
          className="dynamic-body bg-brand-snow py-16 sm:py-20"
          data-page-slug={pageSlug}
        >
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            {embeddedBody.length > 0 ? (
              <ClubFormatProvider
                currencyCode={format.currencyCode}
                locale={format.locale}
              >
                <div className="text-base leading-7 text-brand-deep/85 [&_a]:text-brand-charcoal [&_a]:underline [&_h1]:font-heading [&_h1]:text-3xl [&_h1]:font-bold [&_h2]:font-heading [&_h2]:text-2xl [&_h2]:font-semibold [&_h3]:font-heading [&_h3]:text-xl [&_h3]:font-semibold [&_li]:ml-6 [&_li]:list-disc [&_ol_li]:list-decimal [&_p]:mb-4">
                  <EmbeddedPageContentParts
                    parts={embeddedBody}
                    pageSlug={pageSlug}
                    keyPrefix="not-found"
                    clubIdentity={clubIdentity}
                  />
                </div>
              </ClubFormatProvider>
            ) : null}
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/"
                className="inline-flex items-center justify-center rounded-lg bg-brand-charcoal px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-brand-deep"
              >
                Go Home
              </Link>
              <Link
                href={buildBookingLoginPath()}
                className="inline-flex items-center justify-center rounded-lg border border-brand-ridge/40 px-6 py-3 text-sm font-medium text-brand-charcoal transition-colors hover:bg-brand-mist"
              >
                Book a Stay
              </Link>
            </div>
          </div>
        </section>
      </>
    );
  }

  // Fallback when the /404 page content record doesn't exist yet.
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="mx-auto max-w-md px-4 text-center">
        <h1 className="mb-4 text-6xl font-bold text-gray-900">404</h1>
        <h2 className="mb-4 text-2xl font-semibold text-gray-700">
          Page Not Found
        </h2>
        <p className="mb-8 text-gray-500">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
        <div className="flex flex-col justify-center gap-3 sm:flex-row">
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-lg bg-gray-900 px-6 py-3 text-white transition-colors hover:bg-gray-800"
          >
            Go Home
          </Link>
          <Link
            href={buildBookingLoginPath()}
            className="inline-flex items-center justify-center rounded-lg border border-gray-300 px-6 py-3 text-gray-700 transition-colors hover:bg-gray-100"
          >
            Book a Stay
          </Link>
        </div>
      </div>
    </div>
  );
}
