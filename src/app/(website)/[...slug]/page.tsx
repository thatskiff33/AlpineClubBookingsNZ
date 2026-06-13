import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ContactPageClient } from "@/app/(website)/contact/contact-page-client";
import { JoinApplyPageClient } from "@/app/(website)/join/apply/join-apply-page-client";
import { CommitteeMembersGrid } from "@/components/website/committee-members-grid";
import { clubIdentity, CLUB_NAME } from "@/config/club-identity";
import {
  getSanitizedPageContentByPath,
  pageContentHtmlToPlainText,
} from "@/lib/page-content-html";
import { isReservedPageSlug, isValidPageSlug } from "@/lib/page-content";

type DynamicPageProps = {
  params: Promise<{
    slug: string[];
  }>;
};

// Resolves the catch-all segments to a PageContent path. Static routes
// always win over this catch-all, so code-backed pages are unaffected.
// Reserved names are rejected in every segment position so database pages
// can never sit underneath application route prefixes.
async function getPageForParams(props: DynamicPageProps) {
  const params = await props.params;
  const slug = params.slug.join("/");

  if (!isValidPageSlug(slug) || isReservedPageSlug(slug)) {
    return null;
  }

  return getSanitizedPageContentByPath(`/${slug}`);
}

const EMBED_TOKEN_REGEX =
  /\{\{\s*(committee-members-cards|member-application-form|contact-form)\s*\}\}/gi;

function buildEmbeddedBody(contentHtml: string) {
  const parts: Array<
    | { type: "html"; value: string }
    | { type: "committee" }
    | { type: "member-application-form" }
    | { type: "contact-form" }
  > = [];
  let lastIndex = 0;

  for (const match of contentHtml.matchAll(EMBED_TOKEN_REGEX)) {
    const startIndex = match.index ?? 0;
    const before = contentHtml.slice(lastIndex, startIndex);
    if (before.trim().length > 0) {
      parts.push({ type: "html", value: before });
    }
    if ((match[1] ?? "").toLowerCase() === "committee-members-cards") {
      parts.push({ type: "committee" });
    } else if ((match[1] ?? "").toLowerCase() === "member-application-form") {
      parts.push({ type: "member-application-form" });
    } else {
      parts.push({ type: "contact-form" });
    }
    lastIndex = startIndex + match[0].length;
  }

  const trailing = contentHtml.slice(lastIndex);
  if (trailing.trim().length > 0) {
    parts.push({ type: "html", value: trailing });
  }

  if (parts.length === 0) {
    return null;
  }

  return parts;
}

export async function generateMetadata(
  props: DynamicPageProps,
): Promise<Metadata> {
  const page = await getPageForParams(props);

  if (!page) {
    return {
      title: CLUB_NAME,
    };
  }

  return {
    title: page.title,
    description:
      pageContentHtmlToPlainText(page.headerText) ||
      `${page.title} information for ${CLUB_NAME}.`,
  };
}

export default async function DynamicWebsitePage(props: DynamicPageProps) {
  const page = await getPageForParams(props);

  if (!page) {
    notFound();
  }

  const embeddedBody = buildEmbeddedBody(page.contentHtml);
  const headerHtml = { __html: page.headerText };

  return (
    <>
      <section className="dynamic-header bg-gradient-to-br from-brand-charcoal to-brand-deep py-16 text-brand-snow sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <span className="website-eyebrow mb-4">{page.caption}</span>
          <h1 className="font-heading text-4xl font-bold tracking-tight sm:text-5xl">
            {page.title}
          </h1>
          {/* headerText is returned by getSanitizedPageContentByPath. */}
          <div
            className="mt-4 max-w-2xl text-lg text-brand-snow/80"
            dangerouslySetInnerHTML={headerHtml}
          />
        </div>
      </section>
      <section className="dynamic-body bg-brand-snow py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          {embeddedBody ? (
            <div className="space-y-10 text-base leading-7 text-brand-deep/85 [&_a]:text-brand-charcoal [&_a]:underline [&_h1]:font-heading [&_h1]:text-3xl [&_h1]:font-bold [&_h2]:font-heading [&_h2]:text-2xl [&_h2]:font-semibold [&_h3]:font-heading [&_h3]:text-xl [&_h3]:font-semibold [&_li]:ml-6 [&_li]:list-disc [&_ol_li]:list-decimal [&_p]:mb-4">
              {embeddedBody.map((part, index) => {
                if (part.type === "committee") {
                  return <CommitteeMembersGrid key={`committee-${index}`} />;
                }

                if (part.type === "member-application-form") {
                  return (
                    <JoinApplyPageClient
                      key={`member-application-form-${index}`}
                      club={clubIdentity}
                      showHero={false}
                    />
                  );
                }

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
                    key={`html-${index}`}
                    dangerouslySetInnerHTML={{ __html: part.value }}
                  />
                );
              })}
            </div>
          ) : (
            <div className="dynamic-empty rounded-lg border border-brand-ridge/35 bg-brand-mist/35 p-6 text-brand-deep/75">
              No content has been published for this page yet.
            </div>
          )}
        </div>
      </section>
    </>
  );
}
