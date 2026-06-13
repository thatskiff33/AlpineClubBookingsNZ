import type { Metadata } from "next";
import { JoinApplyPageClient } from "@/app/(website)/join/apply/join-apply-page-client";
import { clubIdentity } from "@/config/club-identity";
import { CLUB_NAME } from "@/config/club-identity";
import {
  getSanitizedPageContentByPath,
  pageContentHtmlToPlainText,
} from "@/lib/page-content-html";

const JOIN_APPLY_EMBED_TOKEN_REGEX =
  /\{\{\s*(join-apply-form|member-application-form)\s*\}\}/gi;

function buildEmbeddedBody(contentHtml: string) {
  const parts: Array<
    { type: "html"; value: string } | { type: "member-application-form" }
  > = [];
  let lastIndex = 0;

  for (const match of contentHtml.matchAll(JOIN_APPLY_EMBED_TOKEN_REGEX)) {
    const startIndex = match.index ?? 0;
    const before = contentHtml.slice(lastIndex, startIndex);
    if (before.trim().length > 0) {
      parts.push({ type: "html", value: before });
    }
    parts.push({ type: "member-application-form" });
    lastIndex = startIndex + match[0].length;
  }

  const trailing = contentHtml.slice(lastIndex);
  if (trailing.trim().length > 0) {
    parts.push({ type: "html", value: trailing });
  }

  return parts;
}

export async function generateMetadata(): Promise<Metadata> {
  const page = await getSanitizedPageContentByPath("/join/apply");

  return {
    title: page?.title ?? "Apply for Membership",
    description:
      pageContentHtmlToPlainText(page?.headerText ?? "") ||
      `Apply for membership with ${CLUB_NAME}. Provide your details and two nominators for committee review.`,
  };
}

export default async function JoinApplyPage() {
  const page = await getSanitizedPageContentByPath("/join/apply");
  const embeddedBody = page ? buildEmbeddedBody(page.contentHtml) : [];

  const caption = page?.caption ?? "Membership Application";
  const title = page?.title ?? "Apply for Membership";
  const headerText =
    page?.headerText ||
    `Enter your details, nominate two current ${clubIdentity.name} members, and we will move your application through nomination confirmation and committee approval.`;

  return (
    <>
      <section className="bg-gradient-to-br from-brand-charcoal to-brand-deep py-14 text-brand-snow sm:py-18">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <span className="website-eyebrow mb-4">{caption}</span>
          <h1 className="font-heading text-4xl font-bold tracking-tight sm:text-5xl">
            {title}
          </h1>
          <div
            className="mt-4 max-w-3xl text-lg text-brand-snow/80"
            dangerouslySetInnerHTML={{ __html: headerText }}
          />
        </div>
      </section>

      {embeddedBody.length > 0 ? (
        embeddedBody.map((part, index) => {
          if (part.type === "member-application-form") {
            return (
              <JoinApplyPageClient
                key={`member-application-form-${index}`}
                club={clubIdentity}
                showHero={false}
              />
            );
          }

          return (
            <div
              key={`join-apply-html-${index}`}
              dangerouslySetInnerHTML={{ __html: part.value }}
            />
          );
        })
      ) : (
        <JoinApplyPageClient club={clubIdentity} showHero={false} />
      )}
    </>
  );
}
