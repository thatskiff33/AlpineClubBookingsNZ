import "server-only";

import { prisma } from "@/lib/prisma";
import { sanitizePageContentHtml } from "@/lib/page-content-html";
import { resolveTextTokens } from "@/lib/page-content-embeds";
import { SITE_CONTENT_KEYS } from "@/lib/page-content";
import { starterSiteContent } from "../../prisma/starter-site-content";
import { clubFormatValues } from "@/lib/club-format-server";
import type { ClubFormat } from "@/lib/club-format";

// Canonical display order for the keyed site content sections (currently the
// three public footer columns). The key allowlist itself lives in the
// prisma-free @/lib/page-content so the config-transfer importer can validate
// bundle keys against it without dragging server-only/prisma into its graph.
type SiteContentKeyValue = (typeof SITE_CONTENT_KEYS)[number];

const SITE_CONTENT_LABELS: Record<
  SiteContentKeyValue,
  { title: string; description: string }
> = {
  FOOTER_BLURB: {
    title: "Footer: club blurb",
    description:
      "Short paragraph under the club logo in the footer's first column. " +
      "Leave a section empty to hide that footer column.",
  },
  FOOTER_QUICK_LINKS: {
    title: "Footer: quick links",
    description:
      "Heading and link list in the footer's middle column. " +
      "Leave a section empty to hide that footer column.",
  },
  FOOTER_AFFILIATIONS: {
    title: "Footer: affiliations",
    description:
      "Heading and link list in the footer's last column. " +
      "Leave a section empty to hide that footer column.",
  },
};

export type SiteContentDocument = {
  key: SiteContentKeyValue;
  title: string;
  description: string;
  contentHtml: string;
  updatedAt: string | null;
};

export type SiteFooterContent = {
  blurbHtml: string;
  quickLinksHtml: string;
  affiliationsHtml: string;
};

const STARTER_CONTENT_BY_KEY = new Map(
  starterSiteContent.map((section) => [section.key, section.contentHtml]),
);

/**
 * Returns all sections in canonical order for the admin editor. Rows are
 * backfilled by the add_site_content migration, but missing rows still fall
 * back to the starter defaults so the editor never opens blank on an
 * environment that pre-dates the backfill. Stored values are sanitised on
 * write and again here (defence in depth, matching
 * getSanitizedLodgeInstructions); tokens stay unresolved so admins can edit
 * the literal {{facebook-url}} placeholders.
 */
export async function getSiteContentForAdmin(): Promise<SiteContentDocument[]> {
  const records = await prisma.siteContent.findMany({
    select: {
      key: true,
      contentHtml: true,
      updatedAt: true,
    },
  });

  const byKey = new Map(records.map((record) => [record.key, record]));

  return SITE_CONTENT_KEYS.map((key) => {
    const record = byKey.get(key);
    const contentHtml = record
      ? sanitizePageContentHtml(record.contentHtml)
      : sanitizePageContentHtml(STARTER_CONTENT_BY_KEY.get(key) ?? "");
    return {
      key,
      title: SITE_CONTENT_LABELS[key].title,
      description: SITE_CONTENT_LABELS[key].description,
      contentHtml,
      updatedAt: record ? record.updatedAt.toISOString() : null,
    };
  });
}

/**
 * Renders one stored section for the public footer: sanitise on read (every
 * render path injects with dangerouslySetInnerHTML), then resolve text
 * tokens ({{facebook-url}} etc.). resolveTextTokens HTML-escapes every
 * replacement value, so resolution cannot reintroduce unsafe markup.
 *
 * A missing row falls back to the starter default (same treatment); a row
 * that is present but empty stays empty — the admin deliberately hid that
 * footer column.
 */
async function renderFooterSection(
  record: { contentHtml: string } | undefined,
  key: SiteContentKeyValue,
  format: ClubFormat,
): Promise<string> {
  const storedHtml =
    record !== undefined
      ? record.contentHtml
      : (STARTER_CONTENT_BY_KEY.get(key) ?? "");
  const sanitised = sanitizePageContentHtml(storedHtml);
  if (!sanitised) {
    return "";
  }
  return resolveTextTokens(sanitised, format);
}

/** The three public footer columns, sanitised and token-resolved. */
export async function getSiteFooterContent(): Promise<SiteFooterContent> {
  const records = await prisma.siteContent.findMany({
    where: { key: { in: [...SITE_CONTENT_KEYS] } },
    select: {
      key: true,
      contentHtml: true,
    },
  });

  const byKey = new Map(records.map((record) => [record.key, record]));
  // The club's format (#3565), resolved once for all three columns.
  const format = await clubFormatValues();

  const [blurbHtml, quickLinksHtml, affiliationsHtml] = await Promise.all([
    renderFooterSection(byKey.get("FOOTER_BLURB"), "FOOTER_BLURB", format),
    renderFooterSection(byKey.get("FOOTER_QUICK_LINKS"), "FOOTER_QUICK_LINKS", format),
    renderFooterSection(
      byKey.get("FOOTER_AFFILIATIONS"),
      "FOOTER_AFFILIATIONS",
      format,
    ),
  ]);

  return { blurbHtml, quickLinksHtml, affiliationsHtml };
}
