import { describe, expect, it, vi } from "vitest";
import { strFromU8, strToU8, zipSync } from "fflate";

vi.mock("server-only", () => ({}));

import { buildConfigExport } from "@/lib/config-transfer/export";
import {
  ConfigTransferBundleError,
  readBundle,
} from "@/lib/config-transfer/bundle";
import { parseCsv } from "@/lib/config-transfer/csv";
import { siteContentImporter } from "@/lib/config-transfer/categories/site-content";
import type { ReadDb, TxDb } from "@/lib/config-transfer/import-types";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

// A true round-trip for the site-content category: export from a seeded source,
// apply into an in-memory store (the real category apply logic, incl. HTML
// sanitisation), then export from the resulting store and assert equivalence —
// and that a second apply is idempotent (no duplicates, all updates).

/** Minimal in-memory Prisma stand-in for the delegates site-content touches. */
function makeStore() {
  const pages = new Map<string, Record<string, unknown>>();
  const site = new Map<string, Record<string, unknown>>();
  let theme: Record<string, unknown> | null = null;

  const keyed = (map: Map<string, Record<string, unknown>>, field: string) => ({
    findUnique: async ({ where }: { where: Record<string, unknown> }) =>
      map.get(String(where[field])) ?? null,
    // The batched loader passes `where: { <field>: { in: [...] } }`.
    findMany: async (args?: { where?: Record<string, { in?: unknown[] }> }) => {
      const filter = args?.where?.[field]?.in;
      const all = [...map.values()];
      if (!filter) return all;
      const wanted = new Set(filter.map(String));
      return all.filter((row) => wanted.has(String(row[field])));
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      map.set(String(data[field]), { id: `id-${String(data[field])}`, ...data });
      return { id: `id-${String(data[field])}` };
    },
    update: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      const k = String(where[field]);
      map.set(k, { ...(map.get(k) ?? {}), ...data });
    },
  });

  const db = {
    pageContent: keyed(pages, "slug"),
    siteContent: keyed(site, "key"),
    // Reached on re-export now that the theme's logoUrl references an image
    // (#2322); the round-trip carries no image bytes, so an empty result is
    // the honest stub.
    mediaImage: { findMany: async () => [] },
    clubTheme: {
      findUnique: async () => theme,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        theme = { ...data };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        theme = { ...(theme ?? {}), ...data };
      },
    },
  };
  return { db, pages, site };
}

function sourceDb(): ReadDb {
  return {
    pageContent: {
      findMany: vi.fn().mockResolvedValue([
        { slug: "about", path: "/about", caption: "", menuTitle: "About", title: "About Us", headerText: "", sortOrder: 1, contentHtml: "<p>Hello</p>", published: true },
        { slug: "faq", path: "/faq", caption: "", menuTitle: "FAQ", title: "FAQ", headerText: "", sortOrder: 2, contentHtml: "<p>Questions and answers</p>", published: true },
      ]),
    },
    // A recognised SiteContentKey enum value — a real export can only carry
    // keys the DB enum allows, and the importer now rejects unknown keys (#1736).
    siteContent: { findMany: vi.fn().mockResolvedValue([{ key: "FOOTER_BLURB", contentHtml: "<p>Footer</p>" }]) },
    clubTheme: {
      findUnique: vi.fn().mockResolvedValue({
        brandGold: "#e0a800", brandDeep: "#111", brandSafety: "#f00",
        headingFontKey: "LEAGUE_SPARTAN", bodyFontKey: "INTER", logoUrl: "/api/images/logo999", logoDataUrl: null, rawCss: "",
      }),
    },
    mediaImage: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as ReadDb;
}

async function exportSite(db: ReadDb) {
  return buildConfigExport({
    db,
    categories: ["site-content"],
    includeDoorCodes: false,
    appVersion: "0.10.1",
    prismaMigration: null,
    generatedAt: "2026-07-08T00:00:00.000Z",
  });
}

describe("config-transfer round-trip (site-content)", () => {
  it("export → apply → re-export is equivalent, and re-apply is idempotent", async () => {
    const { zip } = await exportSite(sourceDb());
    const { manifest, files } = readBundle(zip);

    const store = makeStore();
    const applyCtx = {
      tx: store.db as unknown as TxDb,
      files,
      manifest,
      mode: "overwrite" as const,
      resolutions: new Map<string, string>(),
      format: CLUB_FORMAT_TEST,
      actorMemberId: "admin-1",
      imageRemap: new Map<string, string>(),
      notes: { doorCodesWritten: [] as string[] },
    };

    const first = await siteContentImporter.apply(applyCtx);
    expect(first.created).toBe(4); // 2 pages + 1 site-content + theme
    expect(store.pages.size).toBe(2);
    expect(store.pages.get("about")?.title).toBe("About Us");

    // Re-export from the applied store and compare the pages to the source.
    const { zip: zip2 } = await exportSite(store.db as unknown as ReadDb);
    const pages1 = parseCsv(strFromU8(files.get("site-content/pages.csv")!));
    const pages2 = parseCsv(
      strFromU8(readBundle(zip2).files.get("site-content/pages.csv")!),
    );
    expect(pages2.rows).toEqual(pages1.rows);

    // Idempotent second apply: no new rows, everything an update.
    const second = await siteContentImporter.apply(applyCtx);
    expect(second.created).toBe(0);
    expect(store.pages.size).toBe(2);
  });

  // #2187 (D19/R7): the club-theme entity changed incompatibly at v2 (seven
  // brand columns collapsed to three seeds) with NO v1 translation path. A v1
  // bundle still carries orphan columns this app no longer understands, so
  // readBundle must reject any formatVersion < 2 outright rather than silently
  // dropping them. buildBundle always stamps the current version, so we hand-
  // synthesize a minimal v1 bundle (schema-valid manifest, no data files) and
  // assert readBundle throws at the lowest level that parses a manifest.
  it("rejects a v1 bundle: importing a formatVersion 1 manifest throws", () => {
    const v1Manifest = {
      formatVersion: 1,
      generatedAt: "2026-07-08T00:00:00.000Z",
      app: { version: "0.10.1", prismaMigration: null },
      includedCategories: [],
      files: [],
      doorCodesIncluded: false,
    };
    const zip = zipSync({
      "manifest.json": strToU8(JSON.stringify(v1Manifest, null, 2)),
    });

    expect(() => readBundle(zip)).toThrow(ConfigTransferBundleError);
    // The rejection message names the predates-format reason (not a
    // newer-than-supported or generic parse error).
    expect(() => readBundle(zip)).toThrow(/predates/);
  });
});
