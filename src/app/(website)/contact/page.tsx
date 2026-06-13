import type { Metadata } from "next";
import { ContactPageClient } from "@/app/(website)/contact/contact-page-client";
import { clubIdentity, CLUB_NAME } from "@/config/club-identity";
import {
  getSanitizedPageContentByPath,
  pageContentHtmlToPlainText,
} from "@/lib/page-content-html";

const CONTACT_EMBED_TOKEN_REGEX = /\{\{\s*(contact-form)\s*\}\}/gi;

function buildEmbeddedBody(contentHtml: string) {
  const parts: Array<
    { type: "html"; value: string } | { type: "contact-form" }
  > = [];
  let lastIndex = 0;

  for (const match of contentHtml.matchAll(CONTACT_EMBED_TOKEN_REGEX)) {
    const startIndex = match.index ?? 0;
    const before = contentHtml.slice(lastIndex, startIndex);
    if (before.trim().length > 0) {
      parts.push({ type: "html", value: before });
    }
    parts.push({ type: "contact-form" });
    lastIndex = startIndex + match[0].length;
  }

  const trailing = contentHtml.slice(lastIndex);
  if (trailing.trim().length > 0) {
    parts.push({ type: "html", value: trailing });
  }

  return parts;
}

export async function generateMetadata(): Promise<Metadata> {
  const page = await getSanitizedPageContentByPath("/contact");

  return {
    title: page?.title ?? "Contact Us",
    description:
      pageContentHtmlToPlainText(page?.headerText ?? "") ||
      `Get in touch with ${CLUB_NAME} about the club, lodge, or booking enquiries.`,
  };
}

export default async function ContactPage() {
  const page = await getSanitizedPageContentByPath("/contact");
  const embeddedBody = page ? buildEmbeddedBody(page.contentHtml) : [];

  const caption = page?.caption ?? "Get in touch";
  const title = page?.title ?? "Contact Us";
  const headerText =
    page?.headerText ||
    "Have a question about the club, the lodge, or booking a stay? Get in touch and we'll get back to you.";

  return (
    <>
      <section className="bg-gradient-to-br from-brand-charcoal to-brand-deep py-16 text-brand-snow sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <span className="website-eyebrow mb-4">{caption}</span>
          <h1 className="font-heading text-4xl font-bold tracking-tight sm:text-5xl">
            {title}
          </h1>
          <div
            className="mt-4 max-w-2xl text-lg text-brand-snow/80"
            dangerouslySetInnerHTML={{ __html: headerText }}
          />
        </div>
      </section>

      {embeddedBody.length > 0 ? (
        embeddedBody.map((part, index) => {
          if (part.type === "contact-form") {
            return (
              <ContactPageClient
                key={`contact-form-${index}`}
                club={clubIdentity}
                showHero={false}
              />
            );
          }

          return (
            <div
              key={`contact-html-${index}`}
              dangerouslySetInnerHTML={{ __html: part.value }}
            />
          );
        })
      ) : (
        <ContactPageClient club={clubIdentity} showHero={false} />
      )}
    </>
  );
}
