import "server-only";

import sanitizeHtml from "sanitize-html";
import { prisma } from "@/lib/prisma";
import type { EditablePageRecord } from "@/lib/page-content";

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "br",
    "ul",
    "ol",
    "li",
    "blockquote",
    "strong",
    "em",
    "u",
    "s",
    "a",
    "img",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "hr",
    "span",
    "div",
    "svg",
    "path",
    "rect",
    "circle",
    "section",
    "line",
    "main",
    "style",
  ],
  allowedAttributes: {
    a: ["href", "name", "target", "rel"],
    img: ["src", "alt", "width", "height"],
    th: ["colspan", "rowspan"],
    td: ["colspan", "rowspan"],
    svg: [
      "xmlns",
      "viewbox",
      "width",
      "height",
      "fill",
      "stroke",
      "stroke-width",
      "stroke-linecap",
      "stroke-linejoin",
    ],
    path: [
      "d",
      "fill",
      "stroke",
      "stroke-width",
      "stroke-linecap",
      "stroke-linejoin",
    ],
    rect: [
      "x",
      "y",
      "width",
      "height",
      "rx",
      "ry",
      "fill",
      "stroke",
      "stroke-width",
      "stroke-linecap",
      "stroke-linejoin",
    ],
    circle: ["cx", "cy", "r"],
    line: ["x1", "y1", "x2", "y2"],
    "*": ["class", "aria-hidden"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: {
    img: ["http", "https"],
  },
  allowProtocolRelative: false,
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: {
        ...attribs,
        rel: "noopener noreferrer",
      },
    }),
  },
};

export function sanitizePageContentHtml(contentHtml: string): string {
  return sanitizeHtml(contentHtml, SANITIZE_OPTIONS).trim();
}

/**
 * Strips all markup, for contexts that need plain text (meta descriptions).
 */
export function pageContentHtmlToPlainText(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, " ")
    .trim();
}

function toEditablePageRecord(record: {
  id: string;
  slug: string;
  caption: string;
  menuTitle: string;
  title: string;
  headerText: string;
  path: string;
  sortOrder: number;
  contentHtml: string;
  updatedAt: Date;
  updatedByMemberId: string | null;
}): EditablePageRecord {
  return {
    id: record.id,
    slug: record.slug,
    caption: record.caption,
    menuTitle: record.menuTitle,
    title: record.title,
    headerText: record.headerText,
    path: record.path,
    sortOrder: record.sortOrder,
    contentHtml: record.contentHtml,
    updatedAt: record.updatedAt.toISOString(),
    updatedByMemberId: record.updatedByMemberId,
  };
}

export async function getSanitizedPageContentByPath(path: string): Promise<{
  id: string;
  slug: string;
  caption: string;
  menuTitle: string;
  title: string;
  headerText: string;
  path: string;
  sortOrder: number;
  contentHtml: string;
} | null> {
  const record = await prisma.pageContent.findUnique({
    where: { path },
    select: {
      id: true,
      slug: true,
      caption: true,
      menuTitle: true,
      title: true,
      headerText: true,
      path: true,
      sortOrder: true,
      contentHtml: true,
    },
  });

  if (!record) {
    return null;
  }

  // Defence in depth: stored values are sanitised on write, but render
  // paths inject both fields with dangerouslySetInnerHTML, so sanitise
  // again on read in case a record was written through another path.
  const safeContentHtml = sanitizePageContentHtml(record.contentHtml);
  const safeHeaderText = sanitizePageContentHtml(record.headerText);

  return {
    id: record.id,
    slug: record.slug,
    caption: record.caption,
    menuTitle: record.menuTitle,
    title: record.title,
    headerText: safeHeaderText,
    path: record.path,
    sortOrder: record.sortOrder,
    contentHtml: safeContentHtml,
  };
}

export async function getSanitizedPageContentHtmlByPath(
  path: string,
): Promise<string | null> {
  const record = await getSanitizedPageContentByPath(path);
  return record?.contentHtml ?? null;
}

export async function listEditablePageContent() {
  const records = await prisma.pageContent.findMany({
    orderBy: [{ sortOrder: "asc" }, { title: "asc" }],
  });

  return records.map(toEditablePageRecord);
}

export async function listWebsiteMenuPages() {
  const records = await prisma.pageContent.findMany({
    orderBy: [{ sortOrder: "asc" }, { title: "asc" }],
    select: {
      slug: true,
      caption: true,
      menuTitle: true,
      title: true,
      path: true,
      sortOrder: true,
    },
  });

  return records.filter((record) => record.menuTitle.trim().length > 0);
}
