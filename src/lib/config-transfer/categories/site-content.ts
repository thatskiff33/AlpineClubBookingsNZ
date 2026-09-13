import { strToU8, strFromU8 } from "fflate";
import type { Prisma } from "@prisma/client";

import {
  logoImageIdFromUrl,
  normaliseThemeValues,
  resolveLogoFields,
} from "@/lib/club-theme-schema";
import { storableLogoDataUrl } from "@/lib/image-metadata";
import { sanitizePageContentHtml } from "@/lib/page-content-html";
import {
  canUnpublishPage,
  isBuiltinPageSlug,
  isReservedPageSlug,
  isValidPageSlug,
  PAGE_CONTENT_LIMITS,
  SITE_CONTENT_KEYS,
  SITE_CONTENT_LIMITS,
  SYSTEM_PAGE_SLUGS,
  toPagePath,
} from "@/lib/page-content";
import {
  bundleMediaIds,
  planBundleMediaTarget,
  remapImageRefs,
} from "../media";
import {
  cleanedLiteralWarning,
  stripCleanedLiterals,
} from "../cleaned-literals";
import type { BundleEntry } from "../bundle";

// Re-exported for tests and other categories that rewrite image references.
export { remapImageRefs };
import { serialiseCsv } from "../csv";
import { registerEntity } from "../registry";
import type { CategoryExporter, ExportContext } from "../export-types";
import {
  applyRow,
  changedFields,
  hashRow,
  planActionFor,
  rawHasValue,
  updateDataForMode,
  type CategoryImporter,
  type CategoryApplyResult,
  type CategoryPlanResult,
  type PlanContext,
  type ApplyContext,
  type ImportMode,
  type PlanItem,
  type ReadDb,
} from "../import-types";
import {
  RowValidator,
  asStr,
  nz,
  readCsvRows,
  strictBool,
  strictInt,
  type Valid,
} from "../values";

// site-content category: CMS pages, keyed site content, and the club theme.
// See docs/config-transfer/decisions/ADR-001.

const PAGE_FILE = "site-content/pages.csv";
const SITE_CONTENT_FILE = "site-content/site-content.csv";
const THEME_FILE = "site-content/theme.json";

/** Allowlisted PageContent fields — no id/updatedByMemberId/timestamps. */
export const PAGE_CONTENT_FIELDS = [
  "slug",
  "path",
  "caption",
  "menuTitle",
  "title",
  "headerText",
  "sortOrder",
  "contentHtml",
  "published",
] as const;

export const SITE_CONTENT_FIELDS = ["key", "contentHtml"] as const;

// #2187: only the three seed columns cross the wire. The four former brand
// columns (the charcoal/ridge/mist/snow surfaces) are dead to code and derived
// at render time from the substrate, so a bundle neither emits nor imports them.
// Format v2 introduced this shape; the exact-version importer rejects every
// older bundle that still carries the removed columns.
export const CLUB_THEME_FIELDS = [
  "brandGold",
  "brandDeep",
  "brandSafety",
  "headingFontKey",
  "bodyFontKey",
  "logoUrl",
  "logoDataUrl",
  "rawCss",
] as const;

registerEntity({
  entity: "page-content",
  category: "site-content",
  tier: "key-strong",
  format: "csv",
  file: PAGE_FILE,
  naturalKey: ["slug"],
  singleton: false,
  fields: [...PAGE_CONTENT_FIELDS],
});

registerEntity({
  entity: "site-content",
  category: "site-content",
  tier: "key-strong",
  format: "csv",
  file: SITE_CONTENT_FILE,
  naturalKey: ["key"],
  singleton: false,
  fields: [...SITE_CONTENT_FIELDS],
});

registerEntity({
  entity: "club-theme",
  category: "site-content",
  tier: "key-strong",
  format: "json",
  file: THEME_FILE,
  naturalKey: [],
  singleton: true,
  fields: [...CLUB_THEME_FIELDS],
});

/**
 * The single derivation BOTH the dry-run and the apply use for the club theme
 * (#2322, ADR-002 plan/apply parity). Before this existed the planner compared
 * raw bundle values while apply wrote normalised, remapped, exclusivity-resolved
 * ones, so the preview under-disclosed the logo nulling and mis-counted dangling
 * imports.
 *
 * `resolvedLogoUrl` is what the caller has determined the logo reference will
 * be: apply passes the remapped id, plan passes the id the reuse rule will land
 * on (or null when the bundle carries no bytes for it, which both sides drop).
 */
export function deriveThemeWrite(
  theme: Record<string, unknown>,
  mode: ImportMode,
  resolvedLogoUrl: string | null,
): Record<string, unknown> {
  // An import bypasses the zod write schema entirely, so the bundle's values go
  // through the same normaliser every render uses — that enforces
  // LOGO_URL_PATTERN and the 900K data-URI read bound. Legacy oversized
  // data-URIs in old bundles stay importable by design.
  const normalised = normaliseThemeValues({
    ...theme,
    logoUrl: resolvedLogoUrl,
  });
  const logoFields = resolveLogoFields(normalised);
  const sanitised: Record<string, unknown> = {
    ...normalised,
    ...logoFields,
    // #2242: the INLINE logo is image bytes too, and it renders on every public
    // page (header, footer, mobile menu). A bundle's `logoDataUrl` used to be
    // written verbatim, so a club's straight-from-phone inline logo published
    // its GPS coordinates on every deployment the bundle was ever restored to —
    // the same hole the bundled `MediaImage` bytes had (see ../media.ts). Same
    // fail-open policy: an unconfirmable strip is stored and logged, never
    // blocked, so one odd decorative logo cannot fail an operator's restore.
    //
    // Applied here, inside the single derivation BOTH plan and apply use, so the
    // dry-run keeps disclosing exactly what the write will do (ADR-002).
    logoDataUrl: storableLogoDataUrl(logoFields.logoDataUrl, {
      source: "config-transfer club theme logo",
    }),
  };

  // Pick back ONLY the keys the bundle actually carried: normaliseThemeValues
  // fills every field with a default, so writing it wholesale would turn a
  // partial bundle into a full overwrite and reset colours it never mentioned.
  const data: Record<string, unknown> = {};
  for (const field of CLUB_THEME_FIELDS) {
    if (field in theme) data[field] = sanitised[field];
  }

  const write = updateDataForMode(mode, theme, data) as Record<string, unknown>;

  // Re-apply exclusivity to the FINAL write set. `updateDataForMode`'s merge
  // mode (the default) drops any field whose bundle value is blank — including
  // the very nulls that carry the invariant — so without this an import can
  // leave BOTH logo columns populated on an existing row.
  //
  // The two columns are ONE logical field, so they travel together: if the
  // bundle declares a logo at all (a non-blank value under either key), both
  // derived values are written. Treating them independently under merge is what
  // produced the incoherent states — e.g. a bundle whose logoUrl turns out to be
  // dangling would null the URL while leaving the target's OLD inlined logo in
  // place, resurrecting a logo the bundle never described. A bundle that
  // mentions neither key still leaves both columns untouched, which is ordinary
  // merge behaviour.
  const declaresLogo =
    rawHasValue(theme, "logoUrl") || rawHasValue(theme, "logoDataUrl");
  if (declaresLogo) {
    write.logoUrl = sanitised.logoUrl ?? null;
    write.logoDataUrl = sanitised.logoDataUrl ?? null;
  }

  return write;
}

/** Extract MediaImage ids referenced as /api/images/<id> in content HTML. */
export function extractImageIds(html: string): string[] {
  const ids = new Set<string>();
  const re = /\/api\/images\/([A-Za-z0-9_-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    // The capture group has no `?` quantifier, so it is always present.
    const id = match[1];
    if (id !== undefined) ids.add(id);
  }
  return [...ids];
}

type PageRow = Record<(typeof PAGE_CONTENT_FIELDS)[number], unknown>;
type SiteRow = Record<(typeof SITE_CONTENT_FIELDS)[number], unknown>;

export function serialisePages(rows: PageRow[]): BundleEntry {
  return {
    path: PAGE_FILE,
    category: "site-content",
    rowCount: rows.length,
    bytes: strToU8(serialiseCsv([...PAGE_CONTENT_FIELDS], rows)),
  };
}

export function serialiseSiteContent(rows: SiteRow[]): BundleEntry {
  return {
    path: SITE_CONTENT_FILE,
    category: "site-content",
    rowCount: rows.length,
    bytes: strToU8(serialiseCsv([...SITE_CONTENT_FIELDS], rows)),
  };
}

export function serialiseTheme(
  theme: Record<(typeof CLUB_THEME_FIELDS)[number], unknown> | null,
): BundleEntry | null {
  if (!theme) return null;
  const projected: Record<string, unknown> = {};
  for (const field of CLUB_THEME_FIELDS) projected[field] = theme[field];
  return {
    path: THEME_FILE,
    category: "site-content",
    rowCount: 1,
    bytes: strToU8(JSON.stringify(projected, null, 2)),
  };
}

export const siteContentExporter: CategoryExporter = {
  category: "site-content",
  async export(ctx: ExportContext): Promise<BundleEntry[]> {
    const pages = await ctx.db.pageContent.findMany({
      orderBy: [{ sortOrder: "asc" }, { slug: "asc" }],
      select: {
        slug: true,
        path: true,
        caption: true,
        menuTitle: true,
        title: true,
        headerText: true,
        sortOrder: true,
        contentHtml: true,
        published: true,
      },
    });
    const siteContent = await ctx.db.siteContent.findMany({
      orderBy: { key: "asc" },
      select: { key: true, contentHtml: true },
    });
    const theme = await ctx.db.clubTheme.findUnique({
      where: { id: "default" },
      select: {
        brandGold: true,
        brandDeep: true,
        brandSafety: true,
        headingFontKey: true,
        bodyFontKey: true,
        logoUrl: true,
        logoDataUrl: true,
        rawCss: true,
      },
    });

    // Reference every image embedded in exported HTML so its bytes are bundled.
    for (const page of pages) {
      for (const id of extractImageIds(page.contentHtml ?? "")) {
        ctx.media.reference(id);
      }
    }
    for (const row of siteContent) {
      for (const id of extractImageIds(row.contentHtml ?? "")) {
        ctx.media.reference(id);
      }
    }
    // #2322: the club logo is a served image, not inlined bytes, so its
    // MediaImage row has to travel with the bundle like any embedded image —
    // otherwise the imported theme points at an id the target deployment does
    // not have. Same `/api/images/<id>` scanner the HTML fields use.
    for (const id of extractImageIds(theme?.logoUrl ?? "")) {
      ctx.media.reference(id);
    }

    const entries: BundleEntry[] = [
      serialisePages(pages),
      serialiseSiteContent(siteContent),
    ];
    const themeEntry = serialiseTheme(theme);
    if (themeEntry) entries.push(themeEntry);
    return entries;
  },
};

// ---------------------------------------------------------------------------
// Import side (plan + apply). Upsert-only, never delete (ADR-002). Row
// validation is strict (errors block apply); pages and site content are
// batch-loaded, and the same parsed rows feed plan and apply.
// ---------------------------------------------------------------------------

interface ParsedPageRow {
  raw: Record<string, string>;
  slug: string;
  data: {
    path: string;
    caption: string;
    menuTitle: string;
    title: string;
    headerText: string;
    sortOrder: number;
    contentHtml: string;
    published: boolean;
  };
}

/**
 * Strict page-slug cell: the same rules the admin page-content route applies
 * (src/app/api/admin/page-content/route.ts). A hand-edited bundle must not
 * write a slug the admin UI would reject — or one whose segments shadow a
 * reserved application route (admin, api, book, ...).
 *
 * BUILT-IN slugs are exempt from the reserved rule, exactly as the admin PUT
 * route exempts a built-in row keeping its own slug. The exporter above emits
 * EVERY `PageContent` row, built-ins included, so without this a bundle exported
 * from any deployment would fail to import the moment a built-in slug became
 * reserved — which `booking-requests` and `school-bookings` did in #2818
 * decision 9. The exemption is safe because the set is code-owned and fixed, and
 * because the writer below targets the row by slug, so a built-in slug can only
 * ever address its own built-in row.
 */
function strictPageSlug(value: unknown): Valid<string> {
  const s = asStr(value).trim();
  if (s === "") return { ok: false, message: "must not be blank" };
  if (s.length > PAGE_CONTENT_LIMITS.slugMax) {
    return {
      ok: false,
      message: `must be at most ${PAGE_CONTENT_LIMITS.slugMax} characters`,
    };
  }
  if (!isValidPageSlug(s)) {
    return {
      ok: false,
      message: `"${s}" is not a valid page slug (lowercase letters, numbers, and hyphens, with optional forward slashes between segments)`,
    };
  }
  if (!isBuiltinPageSlug(s) && isReservedPageSlug(s)) {
    return { ok: false, message: `"${s}" uses a reserved route segment` };
  }
  return { ok: true, value: s };
}

/**
 * Field-cap parity with the admin route's zod schemas: the same
 * PAGE_CONTENT_LIMITS values, measured the same way (`trimmed` mirrors the
 * schema's .trim(); headerText/contentHtml are capped untrimmed, exactly like
 * the route, and BEFORE sanitisation, exactly like the route). The returned
 * value is the MEASURED form — trimmed fields come back trimmed, mirroring
 * zod's .trim() transform, so the import stores exactly what the admin route
 * would store (#1732).
 */
function withinCap(
  value: unknown,
  max: number,
  trimmed: boolean,
): Valid<string> {
  const s = trimmed ? asStr(value).trim() : asStr(value);
  if (s.length > max) {
    return { ok: false, message: `must be at most ${max} characters` };
  }
  return { ok: true, value: s };
}

/** Title parity: required (unless merge keeps the existing one) and capped. */
function strictPageTitle(value: unknown, blankOk: boolean): Valid<string> {
  if (nz(value) === null && !blankOk) {
    return { ok: false, message: "must not be blank" };
  }
  return withinCap(value, PAGE_CONTENT_LIMITS.titleMax, true);
}

/**
 * sortOrder parity: the admin route's 0–9999 range, plus its system-page rule
 * — the menu order of home/404 is fixed, so a bundle must not move an existing
 * system page to any other value. Re-importing the page's CURRENT order stays
 * legal: seeded databases hold home at the starter order until an admin edit
 * normalises it to the fixed one, and a healthy export must round-trip clean.
 */
function strictPageSortOrder(
  value: unknown,
  slug: string,
  currentSortOrder: number | null,
): Valid<number> {
  const parsed = strictInt(value);
  if (!parsed.ok) return parsed;
  const n = parsed.value;
  if (
    n < PAGE_CONTENT_LIMITS.sortOrderMin ||
    n > PAGE_CONTENT_LIMITS.sortOrderMax
  ) {
    return {
      ok: false,
      message: `must be between ${PAGE_CONTENT_LIMITS.sortOrderMin} and ${PAGE_CONTENT_LIMITS.sortOrderMax}`,
    };
  }
  const fixedOrder = SYSTEM_PAGE_SLUGS.get(slug);
  if (
    fixedOrder !== undefined &&
    currentSortOrder !== null &&
    n !== fixedOrder &&
    n !== currentSortOrder
  ) {
    return {
      ok: false,
      message: `menu order for system page "${slug}" is fixed at ${fixedOrder} and cannot be changed`,
    };
  }
  return parsed;
}

/**
 * published parity: pages the admin route refuses to unpublish — system pages
 * (home, 404) and built-in design pages (canUnpublishPage) — must not be
 * hidden by a bundle either.
 */
function strictPagePublished(value: unknown, slug: string): Valid<boolean> {
  const parsed = strictBool(value);
  if (!parsed.ok) return parsed;
  if (!parsed.value && !canUnpublishPage(slug)) {
    return {
      ok: false,
      message: `page "${slug}" cannot be hidden from the public site`,
    };
  }
  return parsed;
}

/** Validate + build a page row; blanks legal only where merge keeps existing. */
function parsePageRow(
  index: number,
  raw: Record<string, string>,
  blankOk: boolean,
  errors: string[],
  /** The existing DB row for this slug (allowlisted projection), if any. */
  current: Record<string, unknown> | null,
): ParsedPageRow | null {
  const v = new RowValidator(PAGE_FILE, index, errors);
  const slug = v.custom("slug", strictPageSlug(raw.slug), "");
  // Field caps + system-page protections: parity with the admin route's zod
  // schemas and PUT/PATCH guards (src/app/api/admin/page-content/route.ts),
  // through the shared PAGE_CONTENT_LIMITS / SYSTEM_PAGE_SLUGS /
  // canUnpublishPage. Violations are row errors that block apply. The trimmed
  // fields (caption/menuTitle/title) keep the validator's TRIMMED value — the
  // admin route stores the zod-trimmed form, so the import must too. parsePageRow
  // feeds plan and apply alike, so the change preview diffs against the trimmed
  // value apply would write: a legacy row whose stored value is untrimmed plans
  // as one update, then converges to "unchanged" on re-import (#1732).
  const caption = v.custom(
    "caption",
    withinCap(raw.caption, PAGE_CONTENT_LIMITS.captionMax, true),
    "",
  );
  const menuTitle = v.custom(
    "menuTitle",
    withinCap(raw.menuTitle, PAGE_CONTENT_LIMITS.menuTitleMax, true),
    "",
  );
  const title = v.custom("title", strictPageTitle(raw.title, blankOk), "");
  v.custom(
    "headerText",
    withinCap(raw.headerText, PAGE_CONTENT_LIMITS.headerTextMax, false),
    "",
  );
  v.custom(
    "contentHtml",
    withinCap(raw.contentHtml, PAGE_CONTENT_LIMITS.contentHtmlMax, false),
    "",
  );
  const currentSortOrder =
    typeof current?.sortOrder === "number" ? current.sortOrder : null;
  const sortOrder =
    nz(raw.sortOrder) === null && blankOk
      ? 100
      : v.custom(
          "sortOrder",
          strictPageSortOrder(raw.sortOrder ?? "", slug, currentSortOrder),
          0,
        );
  const published =
    nz(raw.published) === null && blankOk
      ? false
      : v.custom(
          "published",
          strictPagePublished(raw.published ?? "", slug),
          false,
        );
  if (!v.ok) return null;
  return {
    raw,
    slug,
    data: {
      // Derived from the slug, never trusted from the file — a crafted path
      // cell could otherwise disagree with the slug (mirrors the admin route).
      path: toPagePath(slug),
      caption,
      menuTitle,
      title,
      // Stored sanitised, exactly like the admin write path. Both plan and
      // apply consume this value, so the change preview diffs against what
      // apply would actually write.
      headerText: sanitizePageContentHtml(raw.headerText ?? ""),
      sortOrder,
      contentHtml: raw.contentHtml ?? "",
      published,
    },
  };
}

function readThemeFile(
  files: Map<string, Uint8Array>,
  errors: string[],
): Record<string, unknown> | null {
  const bytes = files.get(THEME_FILE);
  if (!bytes) return null;
  let json: unknown;
  try {
    json = JSON.parse(strFromU8(bytes));
  } catch (error) {
    errors.push(
      `${THEME_FILE}: not valid JSON (${error instanceof Error ? error.message : "parse error"})`,
    );
    return null;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    errors.push(`${THEME_FILE}: must be a JSON object`);
    return null;
  }
  const record = json as Record<string, unknown>;
  let ok = true;
  for (const field of CLUB_THEME_FIELDS) {
    if (!(field in record)) continue;
    const value = record[field];
    if (value !== null && typeof value !== "string") {
      errors.push(`${THEME_FILE}: ${field} — must be a string (or null)`);
      ok = false;
    }
  }
  return ok ? record : null;
}

interface SiteContentBatch {
  pages: Map<string, Record<string, unknown> & { id?: string }>;
  siteContent: Map<string, { id: string; key: string; contentHtml: string }>;
  theme: Record<string, unknown> | null;
}

/** O(1) membership for the recognised keyed site-content keys. */
const SITE_CONTENT_KEY_SET: ReadonlySet<string> = new Set(SITE_CONTENT_KEYS);

/**
 * Strict site-content key cell: parity with the admin keyed site-content
 * route's `z.enum(SITE_CONTENT_KEYS)` (src/app/api/admin/site-content/route.ts).
 * We validate against that write allowlist — not the wider Prisma enum via
 * strictEnum — because the DB `key` column is an enum: an unrecognised key from
 * a hand-edited bundle must fail here as a clean row error, before it reaches
 * the batch `findMany`, where Prisma would otherwise throw a validation error
 * against the enum column instead of surfacing the row.
 */
function strictSiteContentKey(value: unknown): Valid<string> {
  const s = asStr(value).trim();
  if (s === "") return { ok: false, message: "must not be blank" };
  if (!SITE_CONTENT_KEY_SET.has(s)) {
    return {
      ok: false,
      message: `"${s}" is not a recognised site-content key`,
    };
  }
  return { ok: true, value: s };
}

async function loadSiteContentBatch(
  db: ReadDb,
  slugs: string[],
  keys: string[],
): Promise<SiteContentBatch> {
  const [pageRows, siteRows, theme] = await Promise.all([
    slugs.length
      ? db.pageContent.findMany({
          where: { slug: { in: slugs } },
          select: {
            id: true,
            slug: true,
            path: true,
            caption: true,
            menuTitle: true,
            title: true,
            headerText: true,
            sortOrder: true,
            contentHtml: true,
            published: true,
          },
        })
      : Promise.resolve([]),
    keys.length
      ? db.siteContent.findMany({
          where: { key: { in: keys as never[] } },
          select: { id: true, key: true, contentHtml: true },
        })
      : Promise.resolve([]),
    db.clubTheme.findUnique({
      where: { id: "default" },
      select: Object.fromEntries(
        CLUB_THEME_FIELDS.map((f) => [f, true]),
      ) as Record<string, true>,
    }),
  ]);
  return {
    pages: new Map(pageRows.map((r) => [r.slug, r])),
    siteContent: new Map(siteRows.map((r) => [String(r.key), r])),
    theme,
  };
}

async function planSiteContent(ctx: PlanContext): Promise<CategoryPlanResult> {
  const items: PlanItem[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const fingerprintParts: string[] = [];

  const rawPages = readCsvRows(ctx.files, PAGE_FILE);
  const rawSite = readCsvRows(ctx.files, SITE_CONTENT_FILE);
  const batch = await loadSiteContentBatch(
    ctx.db,
    rawPages.map((r) => r.slug?.trim() ?? "").filter(Boolean),
    // Only recognised keys reach the batch findMany: the DB key column is a
    // Prisma enum, so an unknown key would throw there instead of surfacing as
    // a clean row error (validated below via strictSiteContentKey).
    rawSite
      .map((r) => r.key?.trim() ?? "")
      .filter((k) => SITE_CONTENT_KEY_SET.has(k)),
  );

  // Pages (by slug).
  let anyEmbeddedImages = false;
  rawPages.forEach((raw, i) => {
    const current = batch.pages.get(raw.slug?.trim() ?? "") ?? null;
    const parsed = parsePageRow(
      i,
      raw,
      ctx.mode === "merge" && !!current,
      errors,
      current,
    );
    if (!parsed) return;
    if (/\/api\/images\//.test(parsed.data.contentHtml)) anyEmbeddedImages = true;
    fingerprintParts.push(
      `page-content:${parsed.slug}:${current ? hashRow([...PAGE_CONTENT_FIELDS], current) : "absent"}`,
    );
    // #2511: refuse to re-plant a value a cleanup migration removed. If this
    // row's raw bundle value byte-matches a cleaned literal (e.g. the pre-#2431
    // guest-booking hero for slug "home"), that field is dropped from the write
    // set so the dry-run reflects that it will be kept as-is, and a named
    // warning row is surfaced. The same strip runs in apply, so preview and
    // apply stay in lockstep.
    const guarded = stripCleanedLiterals("page-content", parsed.slug, raw, {
      ...parsed.data,
      // contentHtml diffs against the sanitised form (imageRemap is apply-time;
      // for image-embedding pages this is conservative — may say "changed").
      contentHtml: sanitizePageContentHtml(parsed.data.contentHtml),
    });
    for (const hit of guarded.hits) warnings.push(cleanedLiteralWarning(hit));
    const write = updateDataForMode(ctx.mode, raw, guarded.write);
    const changed = changedFields(write, current);
    items.push({
      entity: "page-content",
      key: parsed.slug,
      action: planActionFor(current, changed),
      changedFields: changed.length ? changed : undefined,
    });
  });

  // Site content (by key).
  rawSite.forEach((raw, i) => {
    const v = new RowValidator(SITE_CONTENT_FILE, i, errors);
    // Key parity with the admin route's z.enum(SITE_CONTENT_KEYS): an
    // unrecognised key is a clean row error, never a create against the enum.
    const key = v.custom("key", strictSiteContentKey(raw.key), "");
    // Field-cap parity with the keyed site-content route's zod schema
    // (src/app/api/admin/site-content/route.ts): the shared SITE_CONTENT_LIMITS,
    // measured untrimmed and BEFORE sanitisation, exactly like the route.
    v.custom(
      "contentHtml",
      withinCap(raw.contentHtml, SITE_CONTENT_LIMITS.contentHtmlMax, false),
      "",
    );
    if (!v.ok) return;
    const current = batch.siteContent.get(key) ?? null;
    fingerprintParts.push(
      `site-content:${key}:${current ? hashRow([...SITE_CONTENT_FIELDS], current) : "absent"}`,
    );
    // #2511: refuse to re-plant a cleaned literal (e.g. the pre-#2490 RMCA
    // footer affiliations for key FOOTER_AFFILIATIONS). Same guard the pages
    // path uses; see the note there.
    const guarded = stripCleanedLiterals("site-content", key, raw, {
      contentHtml: sanitizePageContentHtml(raw.contentHtml ?? ""),
    });
    for (const hit of guarded.hits) warnings.push(cleanedLiteralWarning(hit));
    const write = updateDataForMode(ctx.mode, raw, guarded.write);
    const changed = changedFields(write, current);
    items.push({
      entity: "site-content",
      key,
      action: planActionFor(current, changed),
      changedFields: changed.length ? changed : undefined,
    });
  });

  // Theme (singleton).
  const theme = readThemeFile(ctx.files, errors);
  if (theme) {
    const current = batch.theme;
    fingerprintParts.push(
      `club-theme:default:${current ? hashRow([...CLUB_THEME_FIELDS], current) : "absent"}`,
    );
    // Same derivation apply uses, so the preview discloses the exclusivity
    // nulling and the dangling-logo drop instead of echoing raw bundle values
    // (#2322, ADR-002). The only thing plan cannot know is the id a freshly
    // minted MediaImage will get, so a logo that will be created fresh is
    // disclosed as changed without fabricating the value.
    const bundleLogoImageId = logoImageIdFromUrl(
      typeof theme.logoUrl === "string" ? theme.logoUrl : null,
    );
    let planLogoUrl: string | null = null;
    let logoIdUnknowable = false;
    if (bundleLogoImageId) {
      const target = await planBundleMediaTarget(
        ctx.db,
        ctx.files,
        bundleLogoImageId,
      );
      if (target.carried) {
        if (target.existingId) {
          planLogoUrl = `/api/images/${target.existingId}`;
        } else {
          logoIdUnknowable = true;
          planLogoUrl = typeof theme.logoUrl === "string" ? theme.logoUrl : null;
        }
      }
    }

    const write = deriveThemeWrite(theme, ctx.mode, planLogoUrl);
    const changed = changedFields(write, current);
    if (logoIdUnknowable && !changed.includes("logoUrl")) {
      changed.push("logoUrl");
    }
    items.push({
      entity: "club-theme",
      key: "default",
      action: planActionFor(current, changed),
      changedFields: changed.length ? changed : undefined,
    });
  }

  if (anyEmbeddedImages) {
    warnings.push(
      "Some pages embed images; their bytes are re-imported and references remapped.",
    );
  }

  // #2322: the theme can reference a logo image the bundle does not carry (media
  // stripped, skipped as too large, or unrecognised bytes). Importing the id
  // verbatim would leave the theme pointing at a blob this deployment has never
  // seen, so apply drops it — say so in the dry-run rather than silently.
  const plannedThemeLogoId = logoImageIdFromUrl(
    typeof theme?.logoUrl === "string" ? theme.logoUrl : null,
  );
  if (plannedThemeLogoId && !bundleMediaIds(ctx.files).has(plannedThemeLogoId)) {
    warnings.push(
      "The bundle's club logo image is missing from its media; the logo will be cleared and the club name shown instead.",
    );
  }

  return { items, warnings, errors, fingerprintParts };
}

async function applySiteContent(ctx: ApplyContext): Promise<CategoryApplyResult> {
  const result: CategoryApplyResult = { created: 0, updated: 0, deleted: 0, unchanged: 0, skipped: 0 };
  const errors: string[] = []; // plan blocked all errors; defensive only
  const oldToNew = ctx.imageRemap;

  const rawPages = readCsvRows(ctx.files, PAGE_FILE);
  const rawSite = readCsvRows(ctx.files, SITE_CONTENT_FILE);
  const batch = await loadSiteContentBatch(
    ctx.tx,
    rawPages.map((r) => r.slug?.trim() ?? "").filter(Boolean),
    // Same enum-safe key filter as plan: an unknown key must never reach the
    // batch findMany (plan already blocked it; defensive for direct callers).
    rawSite
      .map((r) => r.key?.trim() ?? "")
      .filter((k) => SITE_CONTENT_KEY_SET.has(k)),
  );

  // Pages.
  for (const [i, raw] of rawPages.entries()) {
    const current = batch.pages.get(raw.slug?.trim() ?? "") ?? null;
    const parsed = parsePageRow(
      i,
      raw,
      ctx.mode === "merge" && !!current,
      errors,
      current,
    );
    if (!parsed) { result.skipped += 1; continue; }
    const html = sanitizePageContentHtml(
      remapImageRefs(parsed.data.contentHtml, oldToNew),
    );
    // #2511: drop any field whose raw bundle value byte-matches a cleaned
    // literal (e.g. the pre-#2431 guest-booking hero). On an existing row —
    // the case the base seed always guarantees for "home" — the field is left
    // unwritten, so the cleaned state the migration established stands. Every
    // other field imports as normal. Mirrors the strip in planSiteContent.
    const { write: pageData } = stripCleanedLiterals("page-content", parsed.slug, raw, {
      ...parsed.data,
      contentHtml: html,
    });
    await applyRow({
      mode: ctx.mode,
      raw,
      data: pageData,
      current,
      create: (data) =>
        ctx.tx.pageContent.create({ data: { slug: parsed.slug, ...data } }),
      update: (write) =>
        ctx.tx.pageContent.update({
          where: { slug: parsed.slug },
          data: write,
        }),
      result,
    });
  }

  // Site content.
  for (const [i, raw] of rawSite.entries()) {
    const v = new RowValidator(SITE_CONTENT_FILE, i, errors);
    // Key parity with the admin route (plan already blocked an unknown key;
    // defensive, mirroring the page path).
    const key = v.custom("key", strictSiteContentKey(raw.key), "");
    // Cap parity with the keyed site-content route (plan already blocked this;
    // defensive, mirroring the page path).
    v.custom(
      "contentHtml",
      withinCap(raw.contentHtml, SITE_CONTENT_LIMITS.contentHtmlMax, false),
      "",
    );
    if (!v.ok) { result.skipped += 1; continue; }
    const current = batch.siteContent.get(key) ?? null;
    const html = sanitizePageContentHtml(
      remapImageRefs(raw.contentHtml ?? "", oldToNew),
    );
    // #2511: drop contentHtml when it byte-matches a cleaned literal (e.g. the
    // pre-#2490 RMCA footer). On the always-seeded FOOTER_AFFILIATIONS row this
    // leaves the cleared state; mirrors the strip in planSiteContent.
    const { write: siteData } = stripCleanedLiterals("site-content", key, raw, {
      contentHtml: html,
    });
    await applyRow({
      mode: ctx.mode,
      raw,
      data: siteData,
      current,
      create: (data) =>
        ctx.tx.siteContent.create({ data: { key: key as never, ...data } }),
      update: (write) =>
        ctx.tx.siteContent.update({ where: { key: key as never }, data: write }),
      result,
    });
  }

  // Theme (singleton, replace-present of allowlisted fields).
  const theme = readThemeFile(ctx.files, errors);
  if (theme) {
    // Media ids are NOT preserved across deployments — recreateBundleMedia
    // mints fresh rows and returns an old->new map — so the logo reference has
    // to be remapped exactly like the image refs embedded in page HTML (#2322).
    // A reference the map does not cover has no bytes in this deployment, so it
    // is dropped rather than stored as a dangling id (the planner warns).
    const bundleLogoUrl =
      typeof theme.logoUrl === "string" ? theme.logoUrl.trim() : null;
    const bundleLogoImageId = logoImageIdFromUrl(bundleLogoUrl);
    const resolvedLogoUrl =
      bundleLogoImageId && oldToNew.has(bundleLogoImageId)
        ? remapImageRefs(bundleLogoUrl as string, oldToNew)
        : null;

    const write = deriveThemeWrite(theme, ctx.mode, resolvedLogoUrl);
    const current = batch.theme;
    if (!current) {
      // The three seed columns are required with no DB default, so the bundle
      // must carry them (validated by Prisma at runtime). The four orphan columns
      // have DB defaults (#2187 EXPAND migration), so omitting them is safe.
      // Creates always take the bundle's full derived values.
      const createData = deriveThemeWrite(theme, "overwrite", resolvedLogoUrl);
      await ctx.tx.clubTheme.create({
        data: {
          id: "default",
          ...createData,
        } as Prisma.ClubThemeUncheckedCreateInput,
      });
      result.created += 1;
    } else {
      const changed = changedFields(write, current);
      if (changed.length === 0) {
        result.unchanged += 1;
      } else {
        await ctx.tx.clubTheme.update({ where: { id: "default" }, data: write });
        result.updated += 1;
      }
    }
  }

  return result;
}

export const siteContentImporter: CategoryImporter = {
  category: "site-content",
  plan: planSiteContent,
  apply: applySiteContent,
};
