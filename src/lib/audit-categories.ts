/**
 * The canonical audit-category taxonomy (#2581).
 *
 * WHY THIS FILE EXISTS. `AuditLog.category` is not a display label. It is the
 * only thing a category-filtered reader can filter on, so it decides which
 * permission an operator needs before the platform will show them an event:
 * the AI Diagnostics correlation tools (#2375) select on
 * `category = ANY (…)` and nothing else, and a row whose category is wrong is a
 * row read by the wrong people, while a row whose category is missing is a row
 * read by nobody. Before this module the taxonomy was written out by hand in six
 * places — the writer union in `audit.ts`, the Admin filter options, the legacy
 * action filters, the member-visible subset, the badge map and the Diagnostics
 * category sets — and they had already drifted: `family` was written by 27
 * production sites while being absent from the writer union and from every
 * Diagnostics set, so family evidence was unreadable by any correlation tool.
 *
 * So this is one closed list, and everything else derives from it.
 *
 * THE LIST IS CLOSED, and that is the point. The old writer union ended in
 * `| (string & {})`, which accepts any string — and two invented values got in
 * through it (`membership` on three nomination writers, `auth` on the
 * auth-bounce writer), each producing rows no reader anywhere could filter for.
 * A misspelling would have done the same silently. With the escape gone,
 * `category: "membershp"` is a type error.
 *
 * CATEGORY FOLLOWS THE AFFECTED BUSINESS DOMAIN — never who acted, never which
 * folder the file is in, never whether a cron job or a person did it. That is
 * the owner's binding rule on #2581, and it is why the member-photo writers no
 * longer choose between `admin` and `account` based on whether an administrator
 * acted on the member's behalf: the affected domain is the member's own profile
 * either way.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DECIDE. Member-facing exposure. The
 * member timeline's visible subset stays a separately reviewed list in
 * `audit-query.ts`; adding a category here must never publish it to members as
 * a side effect.
 *
 * That promise covers ADDING a category. It does not cover RE-CLASSIFYING a
 * writer, which moves its rows across the member boundary whenever the old and
 * new categories sit on different sides of it — the member timeline filters on
 * category too. #2581 crossed it four times, all in the same direction and all
 * disclosed at the writer: the three membership-application writers
 * (`membership` → `account`), the auth-bounce writer (`auth` → `security`), and
 * the on-behalf branch of the two member-photo writers (`admin` → `account`).
 * Every one of those rows is about the member who can now see it, and the member
 * projection returns no metadata, no request id, no IP and no drill-downs.
 * `audit-writer-census.test.ts` pins the member-visible set so the next crossing
 * is a named test failure rather than a discovery.
 */
import type { AdminPermissionArea } from "@/lib/admin-permissions";

/**
 * Every audit category the platform may write, in the order readers display
 * them. Adding one is a reviewed change: the exhaustive `Record`s below, the
 * badge map, the Admin filter options and the Diagnostics permission map all
 * fail to compile until the new value is classified.
 */
export const AUDIT_CATEGORIES = [
  "account",
  "booking",
  "payment",
  "family",
  "admin",
  "security",
  "lodge",
  "xero",
  "communication",
  "privacy",
  "system",
] as const;

export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

const AUDIT_CATEGORY_SET: ReadonlySet<string> = new Set<string>(AUDIT_CATEGORIES);

/**
 * The runtime half of the closed type, for the places a category arrives as
 * text rather than as a literal — a stored row, a query string, a historical
 * value written before this module existed.
 */
export function isAuditCategory(value: unknown): value is AuditCategory {
  return typeof value === "string" && AUDIT_CATEGORY_SET.has(value);
}

/** The operator-facing name of each category. */
export const AUDIT_CATEGORY_LABELS: Record<AuditCategory, string> = {
  account: "Account",
  booking: "Bookings",
  payment: "Payments",
  family: "Family",
  admin: "Admin",
  security: "Security",
  lodge: "Lodge",
  xero: "Xero",
  communication: "Communication",
  privacy: "Privacy",
  system: "System",
};

/**
 * The five fixed AI Diagnostics correlation entries (#2375). One entry per
 * domain, each with its own permission set declared at review time — never an
 * argument the model chooses, because ADR-002 authorizes before arguments are
 * parsed.
 */
export const AUDIT_CORRELATION_DOMAINS = [
  "system",
  "booking",
  "membership",
  "finance",
  "lodge",
] as const;

export type AuditCorrelationDomain = (typeof AUDIT_CORRELATION_DOMAINS)[number];

/**
 * WHICH CORRELATION ENTRY MAY READ EACH CATEGORY, and therefore which
 * permission a reader needs. Exactly one entry per category, so the five sets
 * are disjoint by construction rather than by a test that checks afterwards: a
 * row carries at most one category, so a denial cannot be worked around by
 * running the entry the caller does hold.
 *
 * TWO ASSIGNMENTS HERE CHANGE WHO CAN READ AN EVENT, and both are deliberate.
 *
 *  - `communication` moves OUT of the support-only system entry (#2581
 *    decision 7). Bulk-communication and notice-delivery events carry recipient
 *    addresses in their payloads and are membership work, so the reader now
 *    needs `membership:view` as well. This REMOVES evidence a support-only
 *    operator can correlate today; it is a deliberate narrowing under least
 *    privilege, not a refactor.
 *  - `family` joins the membership entry. It was in no set at all, so 27
 *    production write sites were readable by no correlation tool; they are now
 *    readable with `support:view` plus `membership:view`. That is a widening of
 *    a real population to its least-privilege destination.
 *
 * `admin`, `security` and `system` remain readable with `support:view` alone.
 * That is why classifying anything INTO them is the assignment that needs a
 * written justification: `support` already governs Admin > Audit Log, where the
 * same operator reads the same rows in full, but the correlation channel is
 * reached by a model rather than by a person navigating to a screen.
 */
export const AUDIT_CATEGORY_CORRELATION_DOMAIN: Record<
  AuditCategory,
  AuditCorrelationDomain
> = {
  account: "membership",
  booking: "booking",
  payment: "finance",
  family: "membership",
  admin: "system",
  security: "system",
  lodge: "lodge",
  xero: "finance",
  communication: "membership",
  privacy: "membership",
  system: "system",
};

/**
 * The admin areas a correlation reader must hold for each domain. `support` is
 * always required; a domain entry adds its own area on top.
 */
export const AUDIT_CORRELATION_DOMAIN_AREAS: Record<
  AuditCorrelationDomain,
  readonly AdminPermissionArea[]
> = {
  system: ["support"],
  booking: ["support", "bookings"],
  membership: ["support", "membership"],
  finance: ["support", "finance"],
  lodge: ["support", "lodge"],
};

/** The categories one correlation entry may read, in canonical order. */
export function auditCategoriesForCorrelationDomain(
  domain: AuditCorrelationDomain,
): readonly AuditCategory[] {
  return AUDIT_CATEGORIES.filter(
    (category) => AUDIT_CATEGORY_CORRELATION_DOMAIN[category] === domain,
  );
}

/**
 * The categories a reader holding the areas `holdsArea` accepts may read,
 * when the reader is a model rather than a person at Admin > Audit Log: AI
 * Diagnostics' correlation tools, and an officer's AI app connection reading
 * the audit log (`search_audit_log`, ALP-724). Each category needs every area
 * `auditCategoryReaderAreas` names. A row with no category is in none.
 */
export function auditCategoriesReadableWith(
  holdsArea: (area: AdminPermissionArea) => boolean,
): AuditCategory[] {
  return AUDIT_CATEGORIES.filter((category) => auditCategoryReaderAreas(category).every(holdsArea));
}

/** The admin areas needed to correlate events in one category. */
export function auditCategoryReaderAreas(
  category: AuditCategory,
): readonly AdminPermissionArea[] {
  return AUDIT_CORRELATION_DOMAIN_AREAS[
    AUDIT_CATEGORY_CORRELATION_DOMAIN[category]
  ];
}
