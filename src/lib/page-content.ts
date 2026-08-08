import { isCmsServablePageSlug } from "@/lib/public-website-paths";

export type EditablePageRecord = {
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
  updatedAt: string | null;
  updatedByMemberId: string | null;
};

/**
 * Field limits for admin-editable PageContent rows. Single source of truth for
 * the admin page-content route's zod schemas
 * (src/app/api/admin/page-content/route.ts) and the config-transfer importer
 * (src/lib/config-transfer/categories/site-content.ts) so the two write paths
 * can never drift apart.
 */
export const PAGE_CONTENT_LIMITS = {
  captionMax: 120,
  menuTitleMax: 120,
  titleMax: 120,
  headerTextMax: 20000,
  slugMax: 80,
  sortOrderMin: 0,
  sortOrderMax: 9999,
  contentHtmlMax: 200000,
} as const;

/**
 * Field limits for admin-editable keyed SiteContent rows (the footer sections).
 * A distinct cap from PAGE_CONTENT_LIMITS — the keyed site-content route owns
 * its own limit and the two must be free to diverge — but the single source of
 * truth for BOTH the admin site-content route's zod schema
 * (src/app/api/admin/site-content/route.ts) and the config-transfer importer
 * (src/lib/config-transfer/categories/site-content.ts) so those two write paths
 * can never drift apart. Lives here alongside PAGE_CONTENT_LIMITS to keep the
 * config-transfer importer graph free of the prisma-loading @/lib/site-content.
 */
export const SITE_CONTENT_LIMITS = {
  contentHtmlMax: 200000,
} as const;

/**
 * Canonical keys for the admin-editable keyed SiteContent rows (currently the
 * three public footer columns; future chrome sections extend this list). Single
 * source of truth for the admin site-content route's zod enum
 * (src/app/api/admin/site-content/route.ts), the @/lib/site-content display
 * helpers, and the config-transfer importer
 * (src/lib/config-transfer/categories/site-content.ts). Lives here alongside
 * SITE_CONTENT_LIMITS — again to keep the config-transfer importer graph free
 * of the prisma-loading @/lib/site-content — so the importer can validate a
 * bundle's keys against the same allowlist the admin route enforces.
 */
export const SITE_CONTENT_KEYS = [
  "FOOTER_BLURB",
  "FOOTER_QUICK_LINKS",
  "FOOTER_AFFILIATIONS",
] as const;

/**
 * Slugs for built-in system pages that must always exist.
 * Their slugs and sort orders are fixed and cannot be changed by admins.
 */
export const SYSTEM_PAGE_SLUGS: ReadonlyMap<string, number> = new Map([
  ["home", 1],
  ["404", 100],
]);

export function isSystemPageSlug(slug: string): boolean {
  return SYSTEM_PAGE_SLUGS.has(slug);
}

/**
 * Built-in pages seeded from starter content and linked from code-backed
 * routes, the footer, and the sitemap. Admins may edit their copy, but they
 * must not be unpublished/hidden — those links would 404. Only admin-created
 * pages can be hidden. (`home` is also a system page; listed here for clarity.)
 */
const BUILTIN_PAGE_SLUGS: ReadonlySet<string> = new Set([
  "home",
  "about",
  "join",
  "join/apply",
  "rules",
  "contact",
  "committee",
  "privacy",
  "terms",
  "faq",
]);

// test seam
export function isBuiltinPageSlug(slug: string): boolean {
  return BUILTIN_PAGE_SLUGS.has(slug);
}

/**
 * Only admin-created content pages may be hidden from the public site. System
 * pages (home, 404) and built-in design pages must always remain published.
 */
export function canUnpublishPage(slug: string): boolean {
  return !isSystemPageSlug(slug) && !isBuiltinPageSlug(slug);
}

/**
 * Which pages may be DELETED outright (#2352 MC-03D, decision D-B3(a)).
 *
 * Deliberately one line over {@link canUnpublishPage} rather than a second list
 * of its own. Deleting a page is strictly more destructive than hiding one, so
 * the deletable set must never be WIDER than the hideable set — and the only way
 * to guarantee that as both lists evolve is to have exactly one list. The
 * alternative considered and rejected (D-B3(b)) was an independently maintained
 * deletable list, which drifts the first time a slug is added to one and not the
 * other; D-B3(c), "any page", would let an officer delete the row `/` and `/404`
 * render from.
 *
 * It exists as its own NAMED predicate rather than a direct `canUnpublishPage()`
 * call at the delete site so that narrowing deletion later (Full Admin only, say,
 * or "hidden pages only") is a change to this function, not a hunt through
 * callers — and so a reader of the delete route sees the question being asked.
 * `__tests__/page-content.test.ts` pins the never-wider-than-hiding property
 * across every slug either predicate knows about.
 */
export function canDeletePage(slug: string): boolean {
  return canUnpublishPage(slug);
}

const PAGE_SLUG_PATTERN =
  /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

// Names that must not appear in any segment of an admin-created slug.
// Application route prefixes (admin, api, book, ...) would let database
// pages shadow or sit underneath real routes. Slugs like "contact", "join",
// "home", "privacy", "terms", and "faq" are intentionally NOT reserved:
// their code-backed routes or the catch-all read the matching PageContent
// record, which is how those pages are edited.
const RESERVED_PAGE_SLUGS = new Set([
  "admin",
  "api",
  "book",
  "dashboard",
  "login",
  "logout",
  "register",
  "forgot-password",
  "reset-password",
]);

export function normalizePageSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");
}

export function isValidPageSlug(value: string): boolean {
  return PAGE_SLUG_PATTERN.test(value);
}

/**
 * Is this slug refused for an admin-created page?
 *
 * Two rules, and the second one arrived with #2352 slice 1:
 *
 *  1. {@link RESERVED_PAGE_SLUGS} in ANY segment — the long-standing rule that
 *     stops a database page shadowing or sitting underneath a real route.
 *  2. Any address outside the FIXED-NONCE set (`isCmsServablePageSlug()`). Rule 1
 *     held only nine names, so `pay`, `chores`, `calendar`, `notices`, `profile`,
 *     `lodge`, `finance` and the rest were all accepted — and a page at `/pay`
 *     really was reachable, because `(public)/pay` contains only `[token]/`, so
 *     nothing claimed the bare path and the `(website)` catch-all served it.
 *
 *     Since slice 1 that catch-all fills the full-route ISR store, and the proxy
 *     gives the FIXED per-release CSP nonce to exactly the addresses the five
 *     approved `(website)` routes can serve. A page outside that set is stored
 *     carrying the per-request nonce of whichever request generated it, and every
 *     later response names a different one — so the browser refuses every inline
 *     script on it and the page never becomes interactive. Refusing the slug is
 *     what keeps "stored by the catch-all" inside "carries the fixed nonce".
 *
 *     Rule 2 does the work of a reserved WORD for the three `(website-dynamic)`
 *     addresses as well, and does it more precisely than a word would.
 *     `hut-leader-instructions`, `join/<code>` and `join/verify/<token>` are all
 *     refused because a real per-request route claims them, so a CMS page there
 *     could never be served — while `trips/hut-leader-instructions`, which no
 *     route claims, is still a perfectly good page. Adding the name to
 *     {@link RESERVED_PAGE_SLUGS} instead would have refused that second address
 *     too, for no reason: that set matches in EVERY segment position.
 *
 * Rule 2 looks at the first segment for the route-GROUP question:
 * `/trips/pay` has root segment `trips`, is a public-website address, and is
 * served and stored normally.
 */
export function isReservedPageSlug(value: string): boolean {
  if (value.split("/").some((segment) => RESERVED_PAGE_SLUGS.has(segment))) {
    return true;
  }

  return !isCmsServablePageSlug(value);
}

export function toPagePath(slug: string): string {
  return `/${slug}`;
}
