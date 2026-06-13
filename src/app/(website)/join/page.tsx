import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { CLUB_NAME } from "@/config/club-identity";
import {
  getSanitizedPageContentByPath,
  pageContentHtmlToPlainText,
} from "@/lib/page-content-html";

export async function generateMetadata(): Promise<Metadata> {
  const page = await getSanitizedPageContentByPath("/join");
  return {
    title: page?.title ?? "Join the Club",
    description:
      pageContentHtmlToPlainText(page?.headerText ?? "") ||
      `How to become a member of the ${CLUB_NAME}. Nomination by two existing members, entrance fee, induction process, and membership details.`,
  };
}

export default async function JoinPage() {
  const page = await getSanitizedPageContentByPath("/join");
  const contentHtml = page?.contentHtml ?? "";
  const caption = page?.caption || "Join the Club";
  const title = page?.title || "Becoming a Member";
  const headerText =
    page?.headerText ||
    `How to become a member of the ${CLUB_NAME}. Nomination by two existing members, entrance fee, induction process, and membership details.`;

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
      <section className="bg-brand-snow py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          {contentHtml ? (
            <div
              className="space-y-4 text-base leading-7 text-brand-deep/85 [&_a]:text-brand-charcoal [&_a]:underline [&_h1]:font-heading [&_h1]:text-3xl [&_h1]:font-bold [&_h2]:font-heading [&_h2]:text-2xl [&_h2]:font-semibold [&_h3]:font-heading [&_h3]:text-xl [&_h3]:font-semibold [&_li]:ml-6 [&_li]:list-disc [&_ol_li]:list-decimal [&_p]:mb-4"
              dangerouslySetInnerHTML={{ __html: contentHtml }}
            />
          ) : (
            <div className="rounded-lg border border-brand-ridge/35 bg-brand-mist/35 p-6 text-brand-deep/75">
              No content has been published for this page yet.
            </div>
          )}

          <div className="mt-10 flex flex-wrap gap-3">
            <Button asChild>
              <Link href="/join/apply">Apply for Membership</Link>
            </Button>
            <Button
              asChild
              variant="outline"
              className="border-brand-charcoal/20 bg-transparent text-brand-charcoal hover:bg-brand-mist/45 hover:text-brand-charcoal"
            >
              <Link href="/contact">Talk to the Committee</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
