import type { Metadata } from "next";
import { ContactPageClient } from "@/components/website/contact-page-client";
import { EmbeddedPageContentParts } from "@/components/website/embedded-page-content-parts";
import { getCachedClubIdentity } from "@/lib/public-layout-config";
import { setupInProgressMetadata } from "@/lib/website-setup-metadata";
import { getDefaultLodgeId } from "@/lib/lodges";
import { buildEmbeddedBody } from "@/lib/page-content-embeds";
import {
  getPublishedPageContentByPath,
  pageContentHtmlToPlainText,
} from "@/lib/page-content-html";
import { prisma } from "@/lib/prisma";

/**
 * Held back from static rendering (#2352 slice 1, owner decision D4) — slice 3.
 * See `(website)/page.tsx` for why the line is required rather than tidy: with the
 * shared layout no longer reading the request, a fixed route without it is
 * prerendered at build, with no database and no CSP nonce.
 */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  // Pre-setup, before any lookup (#2420 F1). See setupInProgressMetadata().
  // Post-setup, the published filter in the lookup below keeps a draft row's
  // title and header text out of the head (#2440); the code-backed defaults
  // take over exactly as they do when no row exists.
  const holdingScreen = await setupInProgressMetadata();

  if (holdingScreen) {
    return holdingScreen;
  }

  const [page, { name: clubName }] = await Promise.all([
    getPublishedPageContentByPath("/contact"),
    getCachedClubIdentity(),
  ]);

  return {
    title: page?.title ?? "Contact Us",
    description:
      pageContentHtmlToPlainText(page?.headerText ?? "") ||
      `Get in touch with ${clubName} about the club, lodge, or booking enquiries.`,
  };
}

async function loadDefaultLodgeContact(): Promise<{
  name: string;
  address: string | null;
} | null> {
  // Default-lodge identity for the contact card (E3 #1929), replacing the old
  // hardcoded lodge-address string. Never throws — a DB miss simply hides the
  // address block.
  try {
    const defaultLodgeId = await getDefaultLodgeId(prisma);
    const lodge = await prisma.lodge.findUnique({
      where: { id: defaultLodgeId },
      select: { name: true, address: true },
    });
    return lodge ? { name: lodge.name, address: lodge.address } : null;
  } catch {
    return null;
  }
}

async function loadContactRoleKey(): Promise<string | null> {
  // Admin-configured committee role for the Club Details block (Site Appearance
  // & Content → Club Identity → Club Contact). Null falls back to the legacy
  // booking-officer heuristic. Never throws.
  try {
    const settings = await prisma.publicContentSettings.findUnique({
      where: { id: "default" },
      select: { contactCommitteeRoleKey: true },
    });
    return settings?.contactCommitteeRoleKey ?? null;
  } catch {
    return null;
  }
}

export default async function ContactPage() {
  const [page, lodge, clubIdentity, contactRoleKey] = await Promise.all([
    getPublishedPageContentByPath("/contact"),
    loadDefaultLodgeContact(),
    getCachedClubIdentity(),
    loadContactRoleKey(),
  ]);
  const embeddedBody = page ? await buildEmbeddedBody(page.contentHtml) : [];

  const caption = page?.caption ?? "Get in touch";
  const title = page?.title ?? "Contact Us";
  // Only a GENUINE stored `headerText` may reach the HTML sink. It is admin HTML,
  // sanitised on write and again on read by the published-row reader used above.
  const storedHeaderHtml = page?.headerText.trim() ? page.headerText : null;
  // The fallback is a sentence this code COMPOSES, so it renders as an escaped
  // text child rather than through the sink (#2819). It interpolates nothing
  // today, but it is ordinary application copy rather than authored HTML, and its
  // two sibling pages compose the same header out of club identity — keeping the
  // branch a text node here is what stops the next edit to this line quietly
  // reopening the hole on the branch a blanked or missing row takes.
  const fallbackHeaderText =
    "Have a question about the club, the lodge, or booking a stay? Get in touch and we'll get back to you.";

  return (
    <>
      <section className="bg-gradient-to-br from-brand-charcoal to-brand-deep py-16 text-brand-snow sm:py-20">
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

      {embeddedBody.length > 0 ? (
        <EmbeddedPageContentParts
          parts={embeddedBody}
          pageSlug="contact"
          keyPrefix="contact"
          clubIdentity={clubIdentity}
          lodge={lodge ?? undefined}
          contactRoleKey={contactRoleKey}
        />
      ) : (
        <ContactPageClient
          club={clubIdentity}
          lodge={lodge ?? undefined}
          contactRoleKey={contactRoleKey}
          showHero={false}
        />
      )}
    </>
  );
}
