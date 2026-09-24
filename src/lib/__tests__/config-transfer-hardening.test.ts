import { describe, expect, it, vi } from "vitest";
import { zipSync, unzipSync, strToU8 } from "fflate";

vi.mock("server-only", () => ({}));

import {
  buildBundle,
  readBundle,
  resealBundle,
  type BundleEntry,
} from "@/lib/config-transfer/bundle";
import { buildImportPlan } from "@/lib/config-transfer/import";
import { serialiseCsv } from "@/lib/config-transfer/csv";
import {
  PAGE_CONTENT_FIELDS,
  SITE_CONTENT_FIELDS,
  siteContentImporter,
} from "@/lib/config-transfer/categories/site-content";
import {
  planBundleMedia,
  planBundleMediaTarget,
  recreateBundleMedia,
} from "@/lib/config-transfer/media";
import { SITE_CONTENT_KEYS } from "@/lib/page-content";
import { SiteContentKey } from "@prisma/client";
import type { ReadDb, TxDb } from "@/lib/config-transfer/import-types";

// Hardening behaviours: plan-time validation errors that BLOCK apply, the
// fingerprint binding (bundle bytes / mode / selection / resolutions), the
// null-honest Xero item identity, media caps, zip-bomb caps, wrapper-discard
// and category-coverage warnings, door-code disclosure, and the match picker.

const GENERATED_AT = "2026-07-10T00:00:00.000Z";

function bundleOf(
  entries: BundleEntry[],
  includedCategories: Parameters<typeof buildBundle>[0]["includedCategories"],
  doorCodesIncluded = false,
): Uint8Array {
  return buildBundle({
    entries,
    appVersion: "0.10.1",
    prismaMigration: null,
    includedCategories,
    doorCodesIncluded,
    generatedAt: GENERATED_AT,
  });
}

function lodgeBundle(options: {
  lodgeJson?: Record<string, unknown>;
  seasonsCsv?: string;
  ratesCsv?: string;
}): Uint8Array {
  const entries: BundleEntry[] = [
    {
      path: "lodge-config/lodges/main/lodge.json",
      category: "lodge-config",
      rowCount: null,
      bytes: strToU8(
        JSON.stringify(
          options.lodgeJson ?? { slug: "main", name: "Main Lodge", active: true, travelNote: null, isDefault: false },
        ),
      ),
    },
  ];
  if (options.seasonsCsv !== undefined) {
    entries.push({
      path: "lodge-config/lodges/main/seasons.csv",
      category: "lodge-config",
      rowCount: 1,
      bytes: strToU8(options.seasonsCsv),
    });
  }
  if (options.ratesCsv !== undefined) {
    entries.push({
      path: "lodge-config/lodges/main/season-rates.csv",
      category: "lodge-config",
      rowCount: 1,
      bytes: strToU8(options.ratesCsv),
    });
  }
  return bundleOf(entries, ["lodge-config"]);
}

const EXISTING_SEASON = {
  id: "season-1",
  lodgeId: "lodge-1",
  name: "Winter",
  type: "WINTER",
  startDate: new Date("2026-06-01T00:00:00.000Z"),
  endDate: new Date("2026-09-01T00:00:00.000Z"),
  active: true,
};

function lodgeDb(overrides?: {
  lodges?: unknown[];
  seasons?: unknown[];
  defaultLodge?: { slug: string } | null;
}): ReadDb {
  return {
    lodge: {
      findMany: vi.fn().mockResolvedValue(
        overrides?.lodges ?? [
          { id: "lodge-1", slug: "main", name: "Main Lodge", active: true, travelNote: null, doorCode: null, isDefault: true },
        ],
      ),
      findFirst: vi.fn().mockResolvedValue(overrides?.defaultLodge ?? { slug: "main" }),
    },
    lodgeRoom: { findMany: vi.fn().mockResolvedValue([]) },
    lodgeBed: { findMany: vi.fn().mockResolvedValue([]) },
    season: { findMany: vi.fn().mockResolvedValue(overrides?.seasons ?? []) },
    // Membership-type-keyed rates (#1930, E4); the parser resolves keys here.
    membershipTypeSeasonRate: { findMany: vi.fn().mockResolvedValue([]) },
    membershipType: {
      findMany: vi.fn().mockResolvedValue([
        { id: "mt-full", key: "FULL", bookingBehavior: "MEMBER_RATE", ageGroupsApply: true },
        { id: "mt-nonmember", key: "NON_MEMBER", bookingBehavior: "NON_MEMBER_RATE", ageGroupsApply: true },
      ]),
    },
    lodgeInstruction: { findMany: vi.fn().mockResolvedValue([]) },
    choreTemplate: { findMany: vi.fn().mockResolvedValue([]) },
    xeroToken: { findFirst: vi.fn().mockResolvedValue(null) },
  } as unknown as ReadDb;
}

describe("plan-time validation blocks apply", () => {
  it("flags a malformed season date as an error (never a clean create)", async () => {
    const zip = lodgeBundle({
      seasonsCsv: "name,type,startDate,endDate,active\nWinter,WINTER,2026-06-01,,true\n",
    });
    const plan = await buildImportPlan(lodgeDb(), zip, { format: CLUB_FORMAT_TEST, mode: "merge" });
    expect(plan.errors.join(" ")).toMatch(/endDate/);
    // The invalid row is excluded from the plan items.
    expect(plan.categories.flatMap((c) => c.items).some((i) => i.entity === "season")).toBe(false);
  });

  it("flags a typo'd enum with the valid options named", async () => {
    const zip = lodgeBundle({
      seasonsCsv: "name,type,startDate,endDate,active\nWinter,WNITER,2026-06-01,2026-09-01,true\n",
    });
    const plan = await buildImportPlan(lodgeDb(), zip, { format: CLUB_FORMAT_TEST, mode: "merge" });
    expect(plan.errors.join(" ")).toMatch(/WNITER.*WINTER/);
  });

  it("flags a blank or garbage price instead of writing 0 cents", async () => {
    const zip = lodgeBundle({
      seasonsCsv: "name,type,startDate,endDate,active\nWinter,WINTER,2026-06-01,2026-09-01,true\n",
      ratesCsv: "seasonName,membershipTypeKey,ageTier,pricePerNightCents\nWinter,FULL,ADULT,4S50\n",
    });
    const plan = await buildImportPlan(lodgeDb(), zip, { format: CLUB_FORMAT_TEST, mode: "merge" });
    expect(plan.errors.join(" ")).toMatch(/pricePerNightCents.*4S50/);
  });

  it("allows blank typed cells in merge mode when the row already exists", async () => {
    const zip = lodgeBundle({
      seasonsCsv: "name,type,startDate,endDate,active\nWinter,,,,\n",
    });
    const plan = await buildImportPlan(
      lodgeDb({ seasons: [EXISTING_SEASON] }),
      zip,
      { format: CLUB_FORMAT_TEST, mode: "merge" },
    );
    expect(plan.errors).toEqual([]);
    const season = plan.categories.flatMap((c) => c.items).find((i) => i.entity === "season");
    expect(season?.action).toBe("unchanged"); // blanks keep existing values
  });

  it("rejects the same blank cells in overwrite mode", async () => {
    const zip = lodgeBundle({
      seasonsCsv: "name,type,startDate,endDate,active\nWinter,,,,\n",
    });
    const plan = await buildImportPlan(
      lodgeDb({ seasons: [EXISTING_SEASON] }),
      zip,
      { format: CLUB_FORMAT_TEST, mode: "overwrite" },
    );
    expect(plan.errors.length).toBeGreaterThan(0);
  });
});

// ---- site-content page hardening --------------------------------------------
// The import must apply the SAME slug rules as the admin page-content route,
// derive the path from the slug, and store headerText sanitised (issue #1712).

const BASE_PAGE = {
  slug: "about",
  path: "/about",
  caption: "",
  menuTitle: "About",
  title: "About Us",
  headerText: "",
  sortOrder: 1,
  contentHtml: "<p>Hi</p>",
  published: true,
};

function pagesBundle(rows: Array<Record<string, unknown>>): Uint8Array {
  return bundleOf(
    [
      {
        path: "site-content/pages.csv",
        category: "site-content",
        rowCount: rows.length,
        bytes: strToU8(serialiseCsv([...PAGE_CONTENT_FIELDS], rows)),
      },
    ],
    ["site-content"],
  );
}

function siteContentBundle(rows: Array<Record<string, unknown>>): Uint8Array {
  return bundleOf(
    [
      {
        path: "site-content/site-content.csv",
        category: "site-content",
        rowCount: rows.length,
        bytes: strToU8(serialiseCsv([...SITE_CONTENT_FIELDS], rows)),
      },
    ],
    ["site-content"],
  );
}

function pagesDb(existingPages: Array<Record<string, unknown>>): ReadDb {
  return {
    pageContent: { findMany: vi.fn().mockResolvedValue(existingPages) },
    siteContent: { findMany: vi.fn().mockResolvedValue([]) },
    clubTheme: { findUnique: vi.fn().mockResolvedValue(null) },
    xeroToken: { findFirst: vi.fn().mockResolvedValue(null) },
  } as unknown as ReadDb;
}

/** In-memory pageContent store + apply context for the site-content importer. */
function pagesApplyHarness(bundle: Uint8Array) {
  const pages = new Map<string, Record<string, unknown>>();
  const tx = {
    pageContent: {
      findMany: async () => [...pages.values()],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        pages.set(String(data.slug), { ...data });
      },
      update: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const key = String(where.slug);
        pages.set(key, { ...(pages.get(key) ?? {}), ...data });
      },
    },
    siteContent: { findMany: async () => [] },
    clubTheme: { findUnique: async () => null },
  } as unknown as TxDb;
  const { manifest, files } = readBundle(bundle);
  return {
    pages,
    ctx: {
      tx,
      files,
      manifest,
      mode: "overwrite" as const,
      resolutions: new Map<string, string>(),
      actorMemberId: "admin-1",
      imageRemap: new Map<string, string>(),
      notes: { doorCodesWritten: [] as string[] },
    },
  };
}

describe("site-content page hardening (slug/path/headerText)", () => {
  it("flags an invalid page slug as a row error and excludes the row", async () => {
    const zip = pagesBundle([{ ...BASE_PAGE, slug: "Bad Slug", path: "/bad" }]);
    const plan = await buildImportPlan(pagesDb([]), zip, { format: CLUB_FORMAT_TEST, mode: "merge" });
    expect(plan.errors.join(" ")).toMatch(
      /pages\.csv row 2: slug — "Bad Slug" is not a valid page slug/,
    );
    expect(plan.categories.flatMap((c) => c.items)).toEqual([]);
  });

  it("flags a reserved slug segment (admin route parity)", async () => {
    const zip = pagesBundle([
      { ...BASE_PAGE, slug: "admin/settings", path: "/admin/settings" },
    ]);
    const plan = await buildImportPlan(pagesDb([]), zip, { format: CLUB_FORMAT_TEST, mode: "merge" });
    expect(plan.errors.join(" ")).toMatch(/slug — .*reserved route segment/);
    expect(plan.categories.flatMap((c) => c.items)).toEqual([]);
  });

  // #2818 decision 9 made `booking-requests` and `school-bookings` RESERVED words,
  // but they are also BUILT-IN slugs with their own PageContent rows — so a bundle
  // exported from any deployment carries them, and the importer must accept them.
  // `strictPageSlug`'s `!isBuiltinPageSlug(s) && isReservedPageSlug(s)` guard is
  // what does that. The admin/settings test above passes with or without the
  // `!isBuiltinPageSlug(s) &&` half (admin is not built-in), so it never exercised
  // the exemption; this does — remove that half and this test fails.
  it.each(["booking-requests", "school-bookings"])(
    "imports the built-in reserved slug %s (the exemption strictPageSlug grants)",
    async (slug) => {
      const zip = pagesBundle([
        { ...BASE_PAGE, slug, path: `/${slug}`, menuTitle: "" },
      ]);
      const plan = await buildImportPlan(pagesDb([]), zip, { format: CLUB_FORMAT_TEST, mode: "merge" });

      expect(plan.errors).toEqual([]);
      const items = plan.categories.flatMap((c) => c.items);
      expect(items).toHaveLength(1);

      // And it really applies — the built-in row is written, addressed by its own
      // slug, exactly as strictPageSlug's docblock promises.
      const { pages, ctx } = pagesApplyHarness(zip);
      await siteContentImporter.apply(ctx);
      expect(pages.get(slug)?.path).toBe(`/${slug}`);
    },
  );

  it("derives the path from the slug instead of trusting the file", async () => {
    // Plan: a crafted path cell on an otherwise-identical row is NOT a change.
    const zip = pagesBundle([{ ...BASE_PAGE, path: "/evil" }]);
    const plan = await buildImportPlan(
      pagesDb([{ id: "p1", ...BASE_PAGE }]),
      zip,
      { format: CLUB_FORMAT_TEST, mode: "overwrite" },
    );
    expect(plan.errors).toEqual([]);
    expect(plan.categories[0].items[0].action).toBe("unchanged");

    // Apply (create): the stored path is derived from the slug.
    const { pages, ctx } = pagesApplyHarness(zip);
    await siteContentImporter.apply(ctx);
    expect(pages.get("about")?.path).toBe("/about");
  });

  it("stores headerText sanitised, exactly like the admin write path", async () => {
    const zip = pagesBundle([
      { ...BASE_PAGE, headerText: "<script>alert(1)</script><p>Hi</p>" },
    ]);

    // Apply (create): the script tag never reaches the database.
    const { pages, ctx } = pagesApplyHarness(zip);
    await siteContentImporter.apply(ctx);
    expect(pages.get("about")?.headerText).toBe("<p>Hi</p>");

    // Plan diffs against the sanitised value: an existing row that already
    // holds the sanitised form is "unchanged", not a spurious update.
    const plan = await buildImportPlan(
      pagesDb([{ id: "p1", ...BASE_PAGE, headerText: "<p>Hi</p>" }]),
      zip,
      { format: CLUB_FORMAT_TEST, mode: "overwrite" },
    );
    expect(plan.errors).toEqual([]);
    expect(plan.categories[0].items[0].action).toBe("unchanged");
  });
});

// ---- site-content page caps + system-page protections ------------------------
// Field caps and system-page protections in parity with the admin route's zod
// schemas and PUT/PATCH guards, via the shared PAGE_CONTENT_LIMITS /
// SYSTEM_PAGE_SLUGS / canUnpublishPage (issue #1716).

const HOME_PAGE = {
  slug: "home",
  path: "/home",
  caption: "Welcome to the Club Lodge",
  menuTitle: "",
  title: "Club Lodge",
  headerText: "",
  // Seeded databases hold the starter order (5), not the fixed order (1),
  // until an admin edit normalises it — a healthy export carries 5.
  sortOrder: 5,
  contentHtml: "<h2>Welcome</h2>",
  published: true,
};

describe("site-content page caps + system-page protections (admin route parity)", () => {
  it("flags an out-of-range sortOrder", async () => {
    const negative = await buildImportPlan(
      pagesDb([]),
      pagesBundle([{ ...BASE_PAGE, sortOrder: -5 }]),
      { format: CLUB_FORMAT_TEST, mode: "merge" },
    );
    expect(negative.errors.join(" ")).toMatch(
      /pages\.csv row 2: sortOrder — must be between 0 and 9999/,
    );
    expect(negative.categories.flatMap((c) => c.items)).toEqual([]);

    const tooBig = await buildImportPlan(
      pagesDb([]),
      pagesBundle([{ ...BASE_PAGE, sortOrder: 10000 }]),
      { format: CLUB_FORMAT_TEST, mode: "merge" },
    );
    expect(tooBig.errors.join(" ")).toMatch(/sortOrder — must be between 0 and 9999/);
  });

  it("flags over-length title/caption and a blank title on create", async () => {
    const plan = await buildImportPlan(
      pagesDb([]),
      pagesBundle([
        { ...BASE_PAGE, title: "T".repeat(121), caption: "C".repeat(121) },
      ]),
      { format: CLUB_FORMAT_TEST, mode: "merge" },
    );
    expect(plan.errors.join(" ")).toMatch(/title — must be at most 120 characters/);
    expect(plan.errors.join(" ")).toMatch(/caption — must be at most 120 characters/);

    // A blank title is legal only where merge keeps the existing one.
    const blank = await buildImportPlan(
      pagesDb([]),
      pagesBundle([{ ...BASE_PAGE, title: "" }]),
      { format: CLUB_FORMAT_TEST, mode: "merge" },
    );
    expect(blank.errors.join(" ")).toMatch(/title — must not be blank/);
    const kept = await buildImportPlan(
      pagesDb([{ id: "p1", ...BASE_PAGE }]),
      pagesBundle([{ ...BASE_PAGE, title: "" }]),
      { format: CLUB_FORMAT_TEST, mode: "merge" },
    );
    expect(kept.errors).toEqual([]);
  });

  it("flags an over-length slug", async () => {
    // 81 lowercase letters pass the slug pattern; only the cap rejects them.
    const plan = await buildImportPlan(
      pagesDb([]),
      pagesBundle([{ ...BASE_PAGE, slug: "a".repeat(81), path: `/${"a".repeat(81)}` }]),
      { format: CLUB_FORMAT_TEST, mode: "merge" },
    );
    expect(plan.errors.join(" ")).toMatch(/slug — must be at most 80 characters/);
  });

  it("flags over-length headerText and contentHtml", async () => {
    const plan = await buildImportPlan(
      pagesDb([]),
      pagesBundle([
        {
          ...BASE_PAGE,
          headerText: "x".repeat(20001),
          contentHtml: "y".repeat(200001),
        },
      ]),
      { format: CLUB_FORMAT_TEST, mode: "merge" },
    );
    expect(plan.errors.join(" ")).toMatch(/headerText — must be at most 20000 characters/);
    expect(plan.errors.join(" ")).toMatch(/contentHtml — must be at most 200000 characters/);
  });

  it("rejects unpublishing a page the admin route cannot unpublish", async () => {
    // System page (home) …
    const home = await buildImportPlan(
      pagesDb([{ id: "home-1", ...HOME_PAGE }]),
      pagesBundle([{ ...HOME_PAGE, published: false }]),
      { format: CLUB_FORMAT_TEST, mode: "merge" },
    );
    expect(home.errors.join(" ")).toMatch(
      /published — page "home" cannot be hidden from the public site/,
    );
    // … and built-in design pages ("about") get the same canUnpublishPage guard.
    const about = await buildImportPlan(
      pagesDb([{ id: "p1", ...BASE_PAGE }]),
      pagesBundle([{ ...BASE_PAGE, published: false }]),
      { format: CLUB_FORMAT_TEST, mode: "merge" },
    );
    expect(about.errors.join(" ")).toMatch(/page "about" cannot be hidden/);
  });

  it("blocks moving a system page's menu order but keeps a healthy export clean", async () => {
    // Moving home to an arbitrary order is a row error (route parity).
    const moved = await buildImportPlan(
      pagesDb([{ id: "home-1", ...HOME_PAGE }]),
      pagesBundle([{ ...HOME_PAGE, sortOrder: 50 }]),
      { format: CLUB_FORMAT_TEST, mode: "merge" },
    );
    expect(moved.errors.join(" ")).toMatch(
      /sortOrder — menu order for system page "home" is fixed at 1/,
    );

    // Round-trip safety: re-importing the instance's OWN export (home still at
    // the seeded order 5) is clean and a no-op, even in overwrite mode …
    const roundTrip = await buildImportPlan(
      pagesDb([{ id: "home-1", ...HOME_PAGE }]),
      pagesBundle([HOME_PAGE]),
      { format: CLUB_FORMAT_TEST, mode: "overwrite" },
    );
    expect(roundTrip.errors).toEqual([]);
    expect(roundTrip.categories[0].items[0].action).toBe("unchanged");

    // … and normalising home to its fixed order (1) stays legal.
    const normalised = await buildImportPlan(
      pagesDb([{ id: "home-1", ...HOME_PAGE }]),
      pagesBundle([{ ...HOME_PAGE, sortOrder: 1 }]),
      { format: CLUB_FORMAT_TEST, mode: "merge" },
    );
    expect(normalised.errors).toEqual([]);
    expect(normalised.categories[0].items[0].action).toBe("update");
  });

  it("stores title/caption/menuTitle trimmed and converges a legacy untrimmed row (#1732)", async () => {
    // The admin route stores the zod-.trim()med value; a bundle cell with
    // stray whitespace must round-trip to the same stored form.
    const zip = pagesBundle([
      { ...BASE_PAGE, title: "About Us  ", caption: " Caption ", menuTitle: "About " },
    ]);

    // Apply (create): the stored values are the trimmed forms.
    const { pages, ctx } = pagesApplyHarness(zip);
    await siteContentImporter.apply(ctx);
    expect(pages.get("about")?.title).toBe("About Us");
    expect(pages.get("about")?.caption).toBe("Caption");
    expect(pages.get("about")?.menuTitle).toBe("About");

    // A legacy row whose STORED title is untrimmed plans as an update ONCE
    // (the plan diffs against the trimmed value apply would write) …
    const legacy = await buildImportPlan(
      pagesDb([{ id: "p1", ...BASE_PAGE, title: "About Us  ", caption: "Caption" }]),
      zip,
      { format: CLUB_FORMAT_TEST, mode: "overwrite" },
    );
    expect(legacy.errors).toEqual([]);
    expect(legacy.categories[0].items[0].action).toBe("update");
    expect(legacy.categories[0].items[0].changedFields).toEqual(["title"]);

    // … then converges: once the DB holds the trimmed values, re-importing the
    // same whitespace-carrying bundle is "unchanged" (plan/apply agreement).
    const converged = await buildImportPlan(
      pagesDb([{ id: "p1", ...BASE_PAGE, caption: "Caption" }]),
      zip,
      { format: CLUB_FORMAT_TEST, mode: "overwrite" },
    );
    expect(converged.errors).toEqual([]);
    expect(converged.categories[0].items[0].action).toBe("unchanged");
  });
});

// ---- site-content keyed cap (admin route parity) ----------------------------
// The keyed site-content route caps contentHtml at 200000 chars
// (src/app/api/admin/site-content/route.ts, the shared SITE_CONTENT_LIMITS);
// the importer must reject an over-cap keyed row the same way (issue #1727).

describe("site-content keyed cap (admin route parity)", () => {
  it("flags over-length keyed site content as a row error and excludes the row", async () => {
    const plan = await buildImportPlan(
      pagesDb([]),
      siteContentBundle([
        { key: "FOOTER_BLURB", contentHtml: "y".repeat(200001) },
      ]),
      { format: CLUB_FORMAT_TEST, mode: "merge" },
    );
    expect(plan.errors.join(" ")).toMatch(
      /site-content\.csv row 2: contentHtml — must be at most 200000 characters/,
    );
    expect(
      plan.categories
        .flatMap((c) => c.items)
        .some((i) => i.entity === "site-content"),
    ).toBe(false);
  });

  it("allows keyed site content right at the cap", async () => {
    const plan = await buildImportPlan(
      pagesDb([]),
      siteContentBundle([
        { key: "FOOTER_BLURB", contentHtml: "y".repeat(200000) },
      ]),
      { format: CLUB_FORMAT_TEST, mode: "merge" },
    );
    expect(plan.errors).toEqual([]);
    const item = plan.categories
      .flatMap((c) => c.items)
      .find((i) => i.entity === "site-content");
    expect(item?.action).toBe("create");
  });

  it("enforces the cap at apply even when the plan gate is bypassed", async () => {
    // applyConfigImport re-plans in-transaction, so in production the plan
    // check is the gate; this pins the importer's own defensive apply check
    // for direct apply() callers.
    const zip = siteContentBundle([
      { key: "FOOTER_BLURB", contentHtml: "y".repeat(200001) },
    ]);
    const { site, ctx } = siteContentApplyHarness(zip);
    await siteContentImporter.apply(ctx);
    expect(site.size).toBe(0);
  });
});

// ---- site-content keyed key validation (admin route parity) -----------------
// The admin keyed site-content route validates key with
// z.enum(SITE_CONTENT_KEYS) (src/app/api/admin/site-content/route.ts); the DB
// key column is a Prisma enum, so a hand-edited bundle with an unknown key must
// fail as a clean row error rather than letting the batch findMany throw a
// PrismaClientValidationError against the enum column (issue #1736).

/**
 * A ReadDb whose siteContent.findMany mimics the real Prisma enum column: it
 * throws (like PrismaClientValidationError) if asked to filter by any key
 * outside SITE_CONTENT_KEYS. This pins that the importer never passes an
 * unrecognised bundle key into the batch query — the fix's whole point.
 */
function enumStrictSiteDb(): { db: ReadDb; siteFindMany: ReturnType<typeof vi.fn> } {
  const valid = new Set<string>(SITE_CONTENT_KEYS);
  const siteFindMany = vi.fn(
    async (args?: { where?: { key?: { in?: string[] } } }) => {
      for (const k of args?.where?.key?.in ?? []) {
        if (!valid.has(k)) {
          throw new Error(`PrismaClientValidationError: invalid enum key ${k}`);
        }
      }
      return [];
    },
  );
  const db = {
    pageContent: { findMany: vi.fn().mockResolvedValue([]) },
    siteContent: { findMany: siteFindMany },
    clubTheme: { findUnique: vi.fn().mockResolvedValue(null) },
    xeroToken: { findFirst: vi.fn().mockResolvedValue(null) },
  } as unknown as ReadDb;
  return { db, siteFindMany };
}

describe("site-content keyed key validation (admin route parity)", () => {
  it("flags an unrecognised key as a clean row error and never queries it", async () => {
    const { db, siteFindMany } = enumStrictSiteDb();
    // Resolves (no throw) even though the enum-strict mock would throw if the
    // bogus key reached findMany.
    const plan = await buildImportPlan(
      db,
      siteContentBundle([{ key: "BOGUS", contentHtml: "nope" }]),
      { format: CLUB_FORMAT_TEST, mode: "merge" },
    );
    expect(plan.errors.join(" ")).toMatch(
      /site-content\.csv row 2: key — "BOGUS" is not a recognised site-content key/,
    );
    // No valid keys remain, so the batch query is skipped entirely, and the
    // bogus row is excluded from the plan items.
    expect(siteFindMany).not.toHaveBeenCalled();
    expect(
      plan.categories
        .flatMap((c) => c.items)
        .some((i) => i.entity === "site-content"),
    ).toBe(false);
  });

  it("plans the valid row and errors only the bogus one in a mixed bundle", async () => {
    const { db, siteFindMany } = enumStrictSiteDb();
    const plan = await buildImportPlan(
      db,
      siteContentBundle([
        { key: "BOGUS", contentHtml: "nope" },
        { key: "FOOTER_BLURB", contentHtml: "hello" },
      ]),
      { format: CLUB_FORMAT_TEST, mode: "merge" },
    );
    // Bogus row (data row 1 → file row 2) errors; the run does not throw.
    expect(plan.errors.join(" ")).toMatch(
      /site-content\.csv row 2: key — "BOGUS" is not a recognised site-content key/,
    );
    // The batch query saw only the recognised key — never "BOGUS".
    expect(siteFindMany).toHaveBeenCalledTimes(1);
    expect(siteFindMany.mock.calls[0][0]).toMatchObject({
      where: { key: { in: ["FOOTER_BLURB"] } },
    });
    // The valid FOOTER_BLURB row still plans as a create alongside the reject.
    const items = plan.categories
      .flatMap((c) => c.items)
      .filter((i) => i.entity === "site-content");
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe("FOOTER_BLURB");
    expect(items[0].action).toBe("create");
  });

  it("does not write an unrecognised keyed row at apply", async () => {
    const zip = siteContentBundle([{ key: "BOGUS", contentHtml: "nope" }]);
    const { site, ctx } = siteContentApplyHarness(zip);
    await siteContentImporter.apply(ctx);
    expect(site.size).toBe(0);
  });

  it("keeps SITE_CONTENT_KEYS in lockstep with the Prisma SiteContentKey enum", () => {
    // A schema-enum key missing from the tuple would make the importer reject
    // a legitimate exported row from a newer instance.
    expect([...SITE_CONTENT_KEYS].sort()).toEqual(
      Object.values(SiteContentKey).sort(),
    );
  });
});

/** In-memory siteContent store + apply context for the keyed-cap apply test. */
function siteContentApplyHarness(bundle: Uint8Array) {
  const site = new Map<string, Record<string, unknown>>();
  const validKeys = new Set<string>(SITE_CONTENT_KEYS);
  const tx = {
    pageContent: { findMany: async () => [] },
    siteContent: {
      // Enum-strict like the real column: throw if the batch key list carries
      // an unrecognised key, so dropping the apply-side filter fails tests.
      findMany: async ({
        where,
      }: {
        where?: { key?: { in?: string[] } };
      } = {}) => {
        for (const key of where?.key?.in ?? []) {
          if (!validKeys.has(key)) {
            throw new Error(
              `PrismaClientValidationError: invalid SiteContentKey ${key}`,
            );
          }
        }
        return [...site.values()];
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        site.set(String(data.key), { ...data });
      },
      update: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const key = String(where.key);
        site.set(key, { ...(site.get(key) ?? {}), ...data });
      },
    },
    clubTheme: { findUnique: async () => null },
  } as unknown as TxDb;
  const { manifest, files } = readBundle(bundle);
  return {
    site,
    ctx: {
      tx,
      files,
      manifest,
      mode: "overwrite" as const,
      resolutions: new Map<string, string>(),
      actorMemberId: "admin-1",
      imageRemap: new Map<string, string>(),
      notes: { doorCodesWritten: [] as string[] },
    },
  };
}

describe("fingerprint binding", () => {
  it("differs by mode, bundle bytes, and selection", async () => {
    const zip = lodgeBundle({});
    const merge = await buildImportPlan(lodgeDb(), zip, { format: CLUB_FORMAT_TEST, mode: "merge" });
    const overwrite = await buildImportPlan(lodgeDb(), zip, { format: CLUB_FORMAT_TEST, mode: "overwrite" });
    expect(merge.fingerprint).not.toBe(overwrite.fingerprint);

    // Same keys, different bytes (travelNote differs) → different fingerprint.
    const zip2 = lodgeBundle({
      lodgeJson: { slug: "main", name: "Main Lodge", active: true, travelNote: "edited", isDefault: false },
    });
    const other = await buildImportPlan(lodgeDb(), zip2, { format: CLUB_FORMAT_TEST, mode: "merge" });
    expect(other.fingerprint).not.toBe(merge.fingerprint);

    // Deterministic for identical inputs.
    const again = await buildImportPlan(lodgeDb(), zip, { format: CLUB_FORMAT_TEST, mode: "merge" });
    expect(again.fingerprint).toBe(merge.fingerprint);
  });
});

describe("door-code disclosure", () => {
  it("names the lodge whose door code would be set", async () => {
    const zip = lodgeBundle({
      lodgeJson: { slug: "main", name: "Main Lodge", active: true, doorCode: "4271", isDefault: false },
    });
    const plan = await buildImportPlan(lodgeDb(), zip, { format: CLUB_FORMAT_TEST, mode: "merge" });
    expect(plan.doorCodeChanges).toEqual(["main"]);
    expect(
      plan.categories.flatMap((c) => c.warnings).join(" "),
    ).toMatch(/door code for lodge "main" will be set/i);
  });
});

describe("match picker (key-weak renames)", () => {
  it("offers candidates for an unmatched season and honours a resolution", async () => {
    const zip = lodgeBundle({
      seasonsCsv: "name,type,startDate,endDate,active\nWinter 2026,WINTER,2026-06-01,2026-09-01,true\n",
    });
    const db = () => lodgeDb({ seasons: [EXISTING_SEASON] });

    // Unresolved: the unmatched bundle row offers "Winter" as a candidate.
    const plan = await buildImportPlan(db(), zip, { format: CLUB_FORMAT_TEST, mode: "merge" });
    const item = plan.categories.flatMap((c) => c.items).find((i) => i.entity === "season");
    expect(item?.action).toBe("create");
    expect(item?.candidates?.[0]).toMatchObject({ id: "season-1" });

    // Resolved: the row becomes an update (rename) of the matched season.
    const resolved = await buildImportPlan(db(), zip, {
      format: CLUB_FORMAT_TEST,
      mode: "merge",
      resolutions: [{ entity: "season", key: "main/Winter 2026", matchId: "season-1" }],
    });
    const resolvedItem = resolved.categories.flatMap((c) => c.items).find((i) => i.entity === "season");
    expect(resolvedItem?.action).toBe("update");
    expect(resolvedItem?.changedFields).toContain("name");
    // Resolutions are fingerprint-bound.
    expect(resolved.fingerprint).not.toBe(plan.fingerprint);
  });
});

describe("xero item identity is null-honest", () => {
  it("matches an existing row on null identity fields instead of duplicating it", async () => {
    // A flat HUT_FEE code (#1930, E4): membershipTypeKey set, but ageTier and
    // entranceFeeCategory both null. The blank CSV cells must match the stored
    // nulls (never coerce null→a value and duplicate). FULL is configured as a
    // flat (ageGroupsApply=false) type here so the blank-ageTier row is the
    // valid shape (F9 shape validation).
    const db = {
      xeroAccountMapping: { findMany: vi.fn().mockResolvedValue([]) },
      xeroItemCodeMapping: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "item-1", category: "HUT_FEE", ageTier: null, seasonType: "WINTER",
            membershipTypeId: "mt-full", entranceFeeCategory: null, itemCode: "HUT-A", amountCents: null,
          },
        ]),
      },
      membershipType: {
        findMany: vi.fn().mockResolvedValue([
          { id: "mt-full", key: "FULL", bookingBehavior: "MEMBER_RATE", ageGroupsApply: false },
        ]),
      },
      xeroToken: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as ReadDb;
    const zip = bundleOf(
      [
        {
          path: "xero-config/item-code-mappings.csv",
          category: "xero-config",
          rowCount: 1,
          bytes: strToU8(
            "category,membershipTypeKey,ageTier,seasonType,entranceFeeCategory,itemCode,amountCents\nHUT_FEE,FULL,,WINTER,,HUT-A,\n",
          ),
        },
      ],
      ["xero-config"],
    );
    const plan = await buildImportPlan(db, zip, { format: CLUB_FORMAT_TEST, mode: "merge" });
    const item = plan.categories.flatMap((c) => c.items).find((i) => i.entity === "xero-item-code-mapping");
    // The blank ageTier/entranceFeeCategory cells match the existing null row →
    // unchanged, NOT a duplicate create.
    expect(item?.action).toBe("unchanged");
  });
});

describe("xero target-org binding", () => {
  it("fingerprints the TARGET org so a connect/switch between preview and apply drifts", async () => {
    const zip = bundleOf(
      [
        {
          path: "xero-config/account-mappings.csv",
          category: "xero-config",
          rowCount: 1,
          bytes: strToU8("key,code,itemCode\nhutFeesIncome,200,\n"),
        },
      ],
      ["xero-config"],
    );
    const dbWithTenant = (tenantId: string | null) =>
      ({
        xeroAccountMapping: { findMany: vi.fn().mockResolvedValue([]) },
        xeroItemCodeMapping: { findMany: vi.fn().mockResolvedValue([]) },
        membershipType: { findMany: vi.fn().mockResolvedValue([]) },
        xeroToken: {
          findFirst: vi
            .fn()
            .mockResolvedValue(tenantId ? { tenantId } : null),
        },
      }) as unknown as ReadDb;

    const disconnected = await buildImportPlan(dbWithTenant(null), zip, { format: CLUB_FORMAT_TEST, mode: "merge" });
    const connected = await buildImportPlan(dbWithTenant("org-a"), zip, { format: CLUB_FORMAT_TEST, mode: "merge" });
    expect(connected.fingerprint).not.toBe(disconnected.fingerprint);
  });
});

describe("bundle resource limits + coverage warnings", () => {
  it("rejects too many entries before inflating them", () => {
    const entries: Record<string, Uint8Array> = {};
    for (let i = 0; i < 2100; i += 1) entries[`site-content/f${i}.csv`] = strToU8("x");
    expect(() => readBundle(zipSync(entries))).toThrow(/too many files/i);
  });

  it("warns when the wrapper-strip discards a root-level file", () => {
    const zip = lodgeBundle({});
    const wrapped: Record<string, Uint8Array> = { "stray.txt": strToU8("note") };
    for (const [name, bytes] of Object.entries(unzipSync(zip))) {
      wrapped[`bundle/${name}`] = bytes;
    }
    const { warnings } = readBundle(zipSync(wrapped));
    expect(warnings.join(" ")).toMatch(/stray\.txt.*outside the bundle's root folder/i);
  });

  it("warns when files exist for a category not in includedCategories", () => {
    const zip = bundleOf(
      [
        {
          path: "committee/roles.csv",
          category: "committee",
          rowCount: 0,
          bytes: strToU8("key,name,description,contactEmail,isActive,sortOrder\n"),
        },
      ],
      // Manifest deliberately omits "committee" from includedCategories.
      [],
    );
    const { warnings } = readBundle(zip);
    expect(warnings.join(" ")).toMatch(/category "committee".*NOT be imported/i);
  });

  it("reseal recomputes doorCodesIncluded from the actual files", () => {
    const zip = lodgeBundle({
      lodgeJson: { slug: "main", name: "Main Lodge", active: true, doorCode: "4271", isDefault: false },
    });
    // Exported with doorCodesIncluded=false (bundleOf default) but a door code
    // hand-added: reseal must flip the flag to true.
    const resealed = readBundle(resealBundle(zip));
    expect(resealed.manifest.doorCodesIncluded).toBe(true);
  });
});

describe("media plan validation", () => {
  it("errors on an oversized image and a malformed media map", async () => {
    const bigImage = new Uint8Array(2 * 1024 * 1024 + 1);
    // PNG magic bytes so the sniffer accepts the type; the size cap still fires.
    bigImage.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const zip = bundleOf(
      [
        {
          path: "site-content/pages.csv",
          category: "site-content",
          rowCount: 0,
          bytes: strToU8("slug,path,caption,menuTitle,title,headerText,sortOrder,contentHtml,published\n"),
        },
        { path: "media/img1.png", category: "site-content", rowCount: null, bytes: bigImage },
        {
          path: "media/media-map.json",
          category: "site-content",
          rowCount: 1,
          bytes: strToU8(JSON.stringify({ old1: { path: "media/img1.png", filename: "big.png", contentType: "image/png" } })),
        },
      ],
      ["site-content"],
    );
    const db = {
      pageContent: { findMany: vi.fn().mockResolvedValue([]) },
      siteContent: { findMany: vi.fn().mockResolvedValue([]) },
      clubTheme: { findUnique: vi.fn().mockResolvedValue(null) },
      mediaImage: { findMany: vi.fn().mockResolvedValue([]) },
      xeroToken: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as ReadDb;
    const plan = await buildImportPlan(db, zip, { format: CLUB_FORMAT_TEST, mode: "merge" });
    expect(plan.errors.join(" ")).toMatch(/over the .*image limit/i);

    // Malformed media-map: a trailing comma is a plan-time ERROR, not an
    // apply-time crash after the backup.
    const badMap = bundleOf(
      [
        {
          path: "site-content/pages.csv",
          category: "site-content",
          rowCount: 0,
          bytes: strToU8("slug,path,caption,menuTitle,title,headerText,sortOrder,contentHtml,published\n"),
        },
        { path: "media/media-map.json", category: "site-content", rowCount: 1, bytes: strToU8('{"a":,}') },
      ],
      ["site-content"],
    );
    const plan2 = await buildImportPlan(db, badMap, { format: CLUB_FORMAT_TEST, mode: "merge" });
    expect(plan2.errors.join(" ")).toMatch(/media-map\.json is not valid JSON/i);
  });
});

describe("bundled media metadata stripping (#2242)", () => {
  // A bundle image is recreated as an anonymously-served MediaImage —
  // /api/images/[id] serves it with `immutable` caching, the same footing as an
  // image-library upload — so EXIF/GPS must not survive an import.
  const GPS = Buffer.from("GPS:-41.29,174.78", "latin1");

  function exifJpeg(withEoi: boolean): Buffer {
    const soi = Buffer.from([0xff, 0xd8]);
    const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), GPS]);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(payload.length + 2, 0);
    const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), len, payload]);
    const sof0 = Buffer.alloc(11);
    sof0.writeUInt8(0xff, 0);
    sof0.writeUInt8(0xc0, 1);
    sof0.writeUInt16BE(9, 2);
    sof0.writeUInt8(8, 4);
    sof0.writeUInt16BE(16, 5);
    sof0.writeUInt16BE(16, 7);
    sof0.writeUInt8(1, 9);
    const sos = Buffer.from([0xff, 0xda, 0x00, 0x02, 0x01, 0x77]);
    const parts = [soi, app1, sof0, sos];
    if (withEoi) parts.push(Buffer.from([0xff, 0xd9]));
    return Buffer.concat(parts);
  }

  function mediaFiles(bytes: Buffer, kind?: string): Map<string, Uint8Array> {
    const files = new Map<string, Uint8Array>();
    files.set("media/photo.jpg", new Uint8Array(bytes));
    files.set(
      "media/media-map.json",
      strToU8(
        JSON.stringify({
          old1: {
            path: "media/photo.jpg",
            filename: "photo.jpg",
            contentType: "image/jpeg",
            ...(kind ? { kind } : {}),
          },
        }),
      ),
    );
    return files;
  }

  /** The bytes apply actually stores for `bundled`, taken from the write itself. */
  async function storedBytesFor(bundled: Buffer): Promise<Buffer> {
    const create = vi.fn().mockResolvedValue({ id: "x" });
    const tx = {
      mediaImage: { findMany: vi.fn().mockResolvedValue([]), create },
    } as unknown as TxDb;
    await recreateBundleMedia(tx, mediaFiles(bundled), "actor-1");
    return Buffer.from(create.mock.calls[0][0].data.data as Uint8Array);
  }

  it("stores a bundled JPEG with its EXIF/GPS removed", async () => {
    const create = vi.fn().mockResolvedValue({ id: "new-1" });
    const tx = {
      mediaImage: { findMany: vi.fn().mockResolvedValue([]), create },
    } as unknown as TxDb;
    const bundled = exifJpeg(true);
    expect(bundled.includes(GPS)).toBe(true);

    const map = await recreateBundleMedia(tx, mediaFiles(bundled), "actor-1");

    expect(map.get("old1")).toBe("new-1");
    const data = create.mock.calls[0][0].data;
    const stored = Buffer.from(data.data as Uint8Array);
    expect(stored.includes(GPS)).toBe(false);
    // byteSize describes the bytes actually stored, not the bundle entry.
    expect(data.byteSize).toBe(stored.length);
    expect(data.byteSize).toBeLessThan(bundled.length);
  });

  it("FAILS OPEN and still imports an image whose strip could not be confirmed", async () => {
    // Matching the image-library upload path (and deliberately unlike the
    // member-photo route): an operator restoring a configuration bundle must not
    // have the import blocked by one unparseable decorative image.
    const original = exifJpeg(false); // no primary EOI → strip unconfirmed
    const create = vi.fn().mockResolvedValue({ id: "new-2" });
    const tx = {
      mediaImage: { findMany: vi.fn().mockResolvedValue([]), create },
    } as unknown as TxDb;

    const map = await recreateBundleMedia(tx, mediaFiles(original), "actor-1");

    expect(map.get("old1")).toBe("new-2");
    const stored = Buffer.from(create.mock.calls[0][0].data.data as Uint8Array);
    expect(stored.equals(original)).toBe(true);
  });

  it("plans create-vs-reuse against the STORED (stripped) bytes", async () => {
    // The dry-run must disclose what apply will really do: an existing row
    // holding the already-stripped bytes is a reuse, not a create. Keying the
    // lookup on the raw bundle length instead would say "create" and apply
    // would then say "unchanged" (ADR-002 plan/apply parity).
    const bundled = exifJpeg(true);
    const stored = await storedBytesFor(bundled);

    const findMany = vi
      .fn()
      .mockResolvedValue([{ id: "existing-1", data: new Uint8Array(stored) }]);
    const db = { mediaImage: { findMany } } as unknown as ReadDb;

    const plan = await planBundleMedia(db, mediaFiles(bundled));

    expect(plan.errors).toEqual([]);
    expect(plan.items).toEqual([
      { entity: "media-image", key: "photo.jpg", action: "unchanged" },
    ]);
    // Looked up by the STRIPPED byte size and the bundle entry's kind (#2322).
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { filename: "photo.jpg", byteSize: stored.length, kind: "CONTENT" },
      }),
    );
  });

  it("predicts the same reused id from planBundleMediaTarget", async () => {
    // The theme's logoUrl planner resolves a bundle id to the row apply will
    // write. It runs the identical reuse rule, so it must strip identically too.
    const bundled = exifJpeg(true);
    const stored = await storedBytesFor(bundled);
    const findMany = vi
      .fn()
      .mockResolvedValue([{ id: "existing-logo", data: new Uint8Array(stored) }]);
    const db = { mediaImage: { findMany } } as unknown as ReadDb;

    const target = await planBundleMediaTarget(
      db,
      mediaFiles(bundled, "LOGO"),
      "old1",
    );

    expect(target).toEqual({ carried: true, existingId: "existing-logo" });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { filename: "photo.jpg", byteSize: stored.length, kind: "LOGO" },
      }),
    );
  });

  it("reuses the existing row at apply time for the same stripped bytes", async () => {
    // Closing the parity loop from the other end: with the stripped row already
    // present, apply must reuse it rather than mint a second copy.
    const bundled = exifJpeg(true);
    const stored = await storedBytesFor(bundled);
    const create = vi.fn();
    const tx = {
      mediaImage: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "existing-1", data: new Uint8Array(stored) }]),
        create,
      },
    } as unknown as TxDb;

    const map = await recreateBundleMedia(tx, mediaFiles(bundled), "actor-1");

    expect(map.get("old1")).toBe("existing-1");
    expect(create).not.toHaveBeenCalled();
  });
});

describe("import-side category selection", () => {
  it("plans only the selected categories and binds the selection", async () => {
    const zip = bundleOf(
      [
        {
          path: "committee/roles.csv",
          category: "committee",
          rowCount: 1,
          bytes: strToU8("key,name,description,contactEmail,isActive,sortOrder\npresident,President,,,true,1\n"),
        },
        {
          path: "xero-config/account-mappings.csv",
          category: "xero-config",
          rowCount: 1,
          bytes: strToU8("key,code,itemCode\nhutFeesIncome,200,\n"),
        },
      ],
      ["committee", "xero-config"],
    );
    const db = () =>
      ({
        committeeRole: { findMany: vi.fn().mockResolvedValue([]) },
        xeroAccountMapping: { findMany: vi.fn().mockResolvedValue([]) },
        xeroItemCodeMapping: { findMany: vi.fn().mockResolvedValue([]) },
        membershipType: { findMany: vi.fn().mockResolvedValue([]) },
        xeroToken: { findFirst: vi.fn().mockResolvedValue(null) },
      }) as unknown as ReadDb;

    const all = await buildImportPlan(db(), zip, { format: CLUB_FORMAT_TEST, mode: "merge" });
    expect(all.selectedCategories).toEqual(["committee", "xero-config"]);

    const committeeOnly = await buildImportPlan(db(), zip, {
      format: CLUB_FORMAT_TEST,
      mode: "merge",
      selectedCategories: ["committee"],
    });
    expect(committeeOnly.selectedCategories).toEqual(["committee"]);
    expect(committeeOnly.categories.map((c) => c.category)).toEqual(["committee"]);
    // Selection is fingerprint-bound: deselecting a category → different print.
    expect(committeeOnly.fingerprint).not.toBe(all.fingerprint);
  });
});
