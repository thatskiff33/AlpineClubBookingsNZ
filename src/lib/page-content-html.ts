import "server-only";

import sanitizeHtml from "sanitize-html";
import { prisma } from "@/lib/prisma";
import { deriveAltFromImageSrc } from "@/lib/image-alt";
import { isReservedPageSlug, type EditablePageRecord } from "@/lib/page-content";
import {
  isBuiltInDynamicPageSlug,
  isCmsServablePageSlug,
} from "@/lib/public-website-paths";

// Hardcoded literal regexes (not a dynamic `new RegExp`) so the pattern can
// never be shaped by input and there is no non-literal-RegExp/ReDoS surface.
const PIXEL_DIMENSION_PATTERNS = {
  width: /width\s*:\s*(\d+)(?:px)?\b/i,
  height: /height\s*:\s*(\d+)(?:px)?\b/i,
} as const;

function extractPixelDimension(
  style: string,
  property: "width" | "height",
): string | null {
  const match = style.match(PIXEL_DIMENSION_PATTERNS[property]);
  return match?.[1] ?? null;
}

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "a",
    "article",
    "b",
    "blockquote",
    "br",
    "caption",
    "circle",
    "code",
    "data",
    "details",
    "div",
    "dl",
    "dt",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "img",
    "li",
    "line",
    "main",
    "ol",
    "p",
    "path",
    "polygon",
    "pre",
    "rect",
    "s",
    "section",
    "small",
    "span",
    "strong",
    "sub",
    "summary",
    "sup",
    "svg",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "u",
    "ul",
  ],
  allowedAttributes: {
    a: ["href", "name", "target", "rel"],
    // "open" is a boolean state attribute (no scriptable surface); it lets
    // CMS authors pre-expand an accordion item.
    details: ["open"],
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
    polygon: [
      "points",
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
    img: (tagName, attribs) => {
      const style = attribs.style ?? "";
      const width = extractPixelDimension(style, "width");
      const height = extractPixelDimension(style, "height");
      const nextAttribs: Record<string, string> = {
        ...attribs,
      };

      if (width && !nextAttribs.width) {
        nextAttribs.width = width;
      }
      if (height && !nextAttribs.height) {
        nextAttribs.height = height;
      }

      // Alt-text backfill (#1947). This covers every <img> that reaches the DOM
      // through sanitised page content — the standalone-<img> html parts
      // (dangerouslySetInnerHTML) and page.headerText — not just images pulled
      // into a {{photo-gallery}} token. A present alt (even alt="") is the
      // author's explicit decision and is left untouched. A wholly missing alt
      // is backfilled: a derived filename label when there is one, else an
      // explicit alt="" — because a missing alt makes screen readers announce
      // the src (e.g. a base64 blob), whereas alt="" marks the image decorative
      // and silences it. We never invent a fake descriptive label for an
      // unlabelled standalone image. `src` is read pre-scheme-filtering here, so
      // a data: URI (stripped later in the CMS default) still derives "".
      if (nextAttribs.alt === undefined) {
        nextAttribs.alt = deriveAltFromImageSrc(nextAttribs.src ?? "");
      }

      delete nextAttribs.style;

      return {
        tagName,
        attribs: nextAttribs,
      };
    },
  },
};

export interface SanitizePageContentHtmlOptions {
  /**
   * Lobby-display authoring/render path ONLY (issue #161, ADR-003 residual):
   * constrain `<img>` src to relative/root-absolute paths or `data:` URIs,
   * matching the display CSP's `img-src 'self' data:` (src/lib/csp.ts) so an
   * authoring admin gets a save-time sanitiser signal instead of an image the
   * browser silently refuses to fetch on the unattended wall. The CMS default
   * (this flag omitted/false) is UNCHANGED — public-site page content keeps
   * allowing `http`/`https` image sources, which `data:` URIs deliberately do
   * not (see the "keeps uploaded image library URLs but strips data: URIs"
   * test) — do not flip this default.
   */
  restrictImgSrc?: boolean;
  /**
   * The HTML is rendered inside a page that already owns its level-1 heading
   * (a notice under its title, #4951, `INV-PUB-006`): an `<h1>` an author puts
   * in the body comes out as `<h2>`, so the page keeps exactly one. Omit it
   * where the HTML IS the page, as public website content is. Only the tag name
   * changes; the allow-lists are the ones above.
   */
  underPageHeading?: boolean;
}

export function sanitizePageContentHtml(
  contentHtml: string,
  options: SanitizePageContentHtmlOptions = {},
): string {
  const base: sanitizeHtml.IOptions = options.restrictImgSrc
    ? {
        ...SANITIZE_OPTIONS,
        // Replaces (not extends) SANITIZE_OPTIONS.allowedSchemesByTag — img is
        // its only key today. Dropping http/https here silently strips the
        // whole `src` attribute (same mechanism the CMS default already uses
        // to strip data: — see the "strips data: URIs" test) and allowing
        // data: instead means a display author's now-blocked external image
        // renders with no src rather than throwing.
        allowedSchemesByTag: { img: ["data"] },
      }
    : SANITIZE_OPTIONS;
  const sanitizeOptions: sanitizeHtml.IOptions = options.underPageHeading
    ? { ...base, transformTags: { ...base.transformTags, h1: "h2" } }
    : base;
  return sanitizeHtml(contentHtml, sanitizeOptions).trim();
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
  published: boolean;
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
    published: record.published,
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
  published: boolean;
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
      published: true,
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
    // Defaults to true for legacy rows written before this column existed.
    published: record.published ?? true,
  };
}

/**
 * The read every PUBLIC render path must use (#2440): identical to
 * `getSanitizedPageContentByPath()` but treating an unpublished row as absent,
 * so a draft is never served to an anonymous visitor. Only an explicit `false`
 * hides a page — legacy rows written before the column existed stay visible
 * (same semantics as the `(website)/[...slug]` catch-all always had).
 *
 * Every supported write path already refuses to unpublish the built-in pages
 * the code-backed routes read (`canUnpublishPage`, enforced by the admin PATCH
 * route and the config-transfer importer), so on those routes this filter is
 * defence in depth against legacy or hand-written rows rather than a state the
 * admin UI can produce. A contract test bans application code outside this
 * module from importing or calling the unfiltered read, so the routes cannot
 * drift apart again.
 */
export async function getPublishedPageContentByPath(path: string) {
  const page = await getSanitizedPageContentByPath(path);

  if (!page || page.published === false) {
    return null;
  }

  return page;
}

export async function listEditablePageContent() {
  const records = await prisma.pageContent.findMany({
    orderBy: [{ sortOrder: "asc" }, { title: "asc" }],
  });

  return records.map(toEditablePageRecord);
}

/**
 * The pages the public header and mobile drawer link to.
 *
 * Three filters, and the third arrived with the #2352 slice-1 review:
 *
 *  1. `published` — a hidden page is not advertised.
 *  2. A non-empty `menuTitle` — the admin's way of keeping a published page out
 *     of the navigation.
 *  3. The site must actually SERVE the address:
 *     {@link isBuiltInDynamicPageSlug} (a real code-backed `(website-dynamic)`
 *     route renders it) OR both {@link isCmsServablePageSlug} (the
 *     `(website)/[...slug]` catch-all will render it) AND
 *     {@link isReservedPageSlug} `=== false` (the catch-all's own loader will
 *     not then refuse the slug).
 *
 * Without the third, slice 1 could leave a nav link pointing at a 404. That
 * slice reserved every first segment belonging to another route group, so an
 * existing row at `/lodge/history` or `/notices/archive` — legal when it was
 * saved — stopped being served. The row is untouched and still `published`, so
 * filters 1 and 2 both passed it and the header kept advertising it, with no
 * signal to the visitor or the operator. An address the site will not serve is
 * not an address the site should link to.
 *
 * ## Why the third filter also subtracts reserved slugs (#2818)
 *
 * `isCmsServablePageSlug` asks only the route-GROUP question about the FIRST
 * segment, so it returns `true` for `/trips/booking-requests`: the address is a
 * public-website path and no fixed-length `(website-dynamic)` route claims it.
 * But `booking-requests` and `school-bookings` are now RESERVED WORDS that match
 * in ANY segment (#2818 decision 9), so the catch-all loader hard-404s
 * `trips/booking-requests` even though it will store it nowhere. Filter 1 and 2
 * pass such a row, and the old filter 3 did too — reviving the exact
 * "link to a 404" hazard slice 1 closed for reserved first segments. Excluding
 * `isReservedPageSlug` closes it for reserved words anywhere in the slug.
 *
 * The two built-in slugs are themselves reserved (they ARE the new words), so the
 * order matters: `isBuiltInDynamicPageSlug` is checked FIRST and admits them, and
 * only an admin-created row reaches the `isCmsServablePageSlug && !reserved`
 * branch. A club that opts `/booking-requests` into its menu still shows it.
 *
 * This does not repair the row; the operator still has to rename it (see
 * `CONFIGURATION.md` → "Some slugs are refused, and the list grew" for the query
 * that finds them). It stops the site promising a page it cannot deliver in the
 * meantime.
 *
 * ## Why filter 3 grew a second half (#2818)
 *
 * It used to be `isCmsServablePageSlug` alone, and that ASSUMED "the catch-all
 * will serve it" and "the site will serve it" are the same sentence. For an
 * admin-created page they are. `/booking-requests` and `/school-bookings` are the
 * counter-example: a real code-backed route serves each of them, so the link
 * works, while the catch-all must keep refusing the slug because those pages are
 * rendered per request and are never stored. Asking the narrower question would
 * have forced them into the fixed-nonce route group purely to get a menu entry —
 * which is what #2813 first did and what decision 2 of #2818 reversed.
 *
 * Filter 2 is what keeps this OPT-IN. Both pages seed an empty `menuTitle`, so a
 * club that does nothing keeps today's unlisted behaviour (#2421); a club that
 * wants the form advertised types a menu title under Site Appearance & Content →
 * Page Content. The pages' own `generateMetadata` reads the SAME field for the
 * robots tag, so what the nav shows and what a search engine may index can never
 * disagree.
 */
export async function listWebsiteMenuPages() {
  const records = await prisma.pageContent.findMany({
    // Hidden (unpublished) pages drop out of the public navigation.
    where: { published: true },
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

  return records.filter(
    (record) =>
      record.menuTitle.trim().length > 0 &&
      (isBuiltInDynamicPageSlug(record.slug) ||
        (isCmsServablePageSlug(record.slug) &&
          !isReservedPageSlug(record.slug))),
  );
}

/**
 * The published, servable CMS page paths, as a snapshot for the pre-cutover
 * warm-up gate (#2566).
 *
 * The same three-part filter {@link listWebsiteMenuPages} applies, minus the
 * navigation one: `published` (a draft or hidden page is never warmed — the owner's
 * decision lists "draft pages" and "unpublished or deleted CMS pages" among the
 * exclusions), and {@link isCmsServablePageSlug} (the address must be one the
 * `(website)/[...slug]` catch-all will actually serve). A page with no `menuTitle`
 * IS included, deliberately: it is unadvertised, not unpublished, and a visitor
 * following a direct link still pays the cold render.
 *
 * **It does NOT take {@link listWebsiteMenuPages}' widened form of that filter,
 * and the difference is the whole point of the split (#2818).** The menu asks "is
 * there a link worth offering?"; this asks "is there a STORE entry to warm?".
 * `/booking-requests` and `/school-bookings` have `PageContent` rows and may carry
 * a menu entry, but they are `(website-dynamic)` routes: nothing about them is
 * ever stored, so warming them would fill nothing and the census cross-check would
 * then demand `CRITICAL_PUBLIC_ROUTES` entries for two addresses that must not
 * have any (#2818 decision 4). `isCmsServablePageSlug` alone is exactly right
 * here.
 *
 * Lives in this module rather than in the deploy code because this is where the
 * published filter lives (#2440) and where the contract test keeps it — a second
 * `PageContent` read somewhere else is how one caller ends up serving drafts.
 *
 * Ordered by path so the warm-up report reads the same way twice, and so the
 * bounded-concurrency worker pool consumes a stable list.
 */
export async function listPublishedCmsPagePaths(): Promise<string[]> {
  const records = await prisma.pageContent.findMany({
    where: { published: true },
    orderBy: { path: "asc" },
    select: { slug: true, path: true },
  });

  return records
    .filter((record) => isCmsServablePageSlug(record.slug))
    .map((record) => record.path);
}

/**
 * Is this CMS path STILL published and servable?
 *
 * The warm-up gate's answer to the owner's CMS-consistency requirement: "If a page
 * is unpublished after discovery but before warming, distinguish that race from an
 * unexpected missing published page." A 404 on a discovered path is only a failure
 * if the page is still published; if an admin hid it mid-deploy, the 404 is the
 * correct answer and the gate says so instead of blocking a cutover on it.
 *
 * Deliberately a FRESH read, not the snapshot: the whole point is to see the state
 * as it is now rather than as discovery found it.
 */
export async function isCmsPagePathPublished(path: string): Promise<boolean> {
  const record = await prisma.pageContent.findUnique({
    where: { path },
    select: { slug: true, published: true },
  });

  return Boolean(
    record && record.published !== false && isCmsServablePageSlug(record.slug),
  );
}
