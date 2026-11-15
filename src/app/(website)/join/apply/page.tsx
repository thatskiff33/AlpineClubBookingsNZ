import type { Metadata } from "next";
import { JoinApplyPageClient } from "@/components/website/join-apply-page-client";
import { EmbeddedPageContentParts } from "@/components/website/embedded-page-content-parts";
import { getCachedClubIdentity } from "@/lib/public-layout-config";
import { setupInProgressMetadata } from "@/lib/website-setup-metadata";
import { buildEmbeddedBody } from "@/lib/page-content-embeds";
import {
  getPublishedPageContentByPath,
  pageContentHtmlToPlainText,
} from "@/lib/page-content-html";

/**
 * Held back from static rendering (#2352 slice 1, owner decision D4) — slice 3.
 * See `(website)/page.tsx` for why the line is required rather than tidy: with the
 * shared layout no longer reading the request, a fixed route without it is
 * prerendered at build, with no database and no CSP nonce.
 */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  // Pre-setup, before any lookup (#2420 F1). See setupInProgressMetadata().
  const holdingScreen = await setupInProgressMetadata();

  if (holdingScreen) {
    return holdingScreen;
  }

  const [page, { name: clubName }] = await Promise.all([
    getPublishedPageContentByPath("/join/apply"),
    getCachedClubIdentity(),
  ]);

  return {
    title: page?.title ?? "Apply for Membership",
    description:
      pageContentHtmlToPlainText(page?.headerText ?? "") ||
      `Apply for membership with ${clubName}. Provide your details and two nominators for committee review.`,
  };
}

export default async function JoinApplyPage() {
  const [page, clubIdentity] = await Promise.all([
    getPublishedPageContentByPath("/join/apply"),
    getCachedClubIdentity(),
  ]);
  const embeddedBody = page ? await buildEmbeddedBody(page.contentHtml) : [];

  const caption = page?.caption ?? "Membership Application";
  const title = page?.title ?? "Apply for Membership";
  // Only a GENUINE stored `headerText` may reach the HTML sink. It is admin HTML,
  // sanitised on write and again on read by the published-row reader used above.
  const storedHeaderHtml = page?.headerText.trim() ? page.headerText : null;
  // The fallback is a string this code COMPOSES, and it interpolates a club-set
  // value (`name`) that no sanitiser has ever seen. It renders as an escaped text
  // child, never through the HTML sink — the branch a deployment with a blanked
  // or missing row takes is exactly the branch that must not be one (#2819).
  const fallbackHeaderText = `Enter your details, nominate two current ${clubIdentity.name} members, and we will move your application through nomination confirmation and committee approval.`;

  return (
    <>
      <section className="bg-gradient-to-br from-brand-charcoal to-brand-deep py-14 text-brand-snow sm:py-18">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <span className="website-eyebrow mb-4">{caption}</span>
          <h1 className="font-heading text-4xl font-bold tracking-tight sm:text-5xl">
            {title}
          </h1>
          {storedHeaderHtml ? (
            <div
              className="mt-4 max-w-3xl text-lg text-brand-snow/80"
              dangerouslySetInnerHTML={{ __html: storedHeaderHtml }}
            />
          ) : (
            <p className="mt-4 max-w-3xl text-lg text-brand-snow/80">
              {fallbackHeaderText}
            </p>
          )}
        </div>
      </section>

      {embeddedBody.length > 0 ? (
        <EmbeddedPageContentParts
          parts={embeddedBody}
          pageSlug="join-apply"
          keyPrefix="join-apply"
          clubIdentity={clubIdentity}
        />
      ) : (
        <JoinApplyPageClient club={clubIdentity} showHero={false} />
      )}
    </>
  );
}
