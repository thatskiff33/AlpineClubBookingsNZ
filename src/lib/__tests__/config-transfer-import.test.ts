import { describe, expect, it, vi } from "vitest";
import { strToU8 } from "fflate";

vi.mock("server-only", () => ({}));

import { buildBundle } from "@/lib/config-transfer/bundle";
import { serialiseCsv } from "@/lib/config-transfer/csv";
import { buildImportPlan } from "@/lib/config-transfer/import";
import {
  remapImageRefs,
  PAGE_CONTENT_FIELDS,
} from "@/lib/config-transfer/categories/site-content";
import type { ReadDb } from "@/lib/config-transfer/import-types";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

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
  return buildBundle({
    entries: [
      {
        path: "site-content/pages.csv",
        category: "site-content",
        rowCount: rows.length,
        bytes: strToU8(serialiseCsv([...PAGE_CONTENT_FIELDS], rows)),
      },
    ],
    appVersion: "0.10.1",
    prismaMigration: null,
    includedCategories: ["site-content"],
    doorCodesIncluded: false,
    generatedAt: "2026-07-08T00:00:00.000Z",
  });
}

function targetDb(existingPages: Array<Record<string, unknown>>): ReadDb {
  return {
    pageContent: {
      findMany: vi.fn().mockResolvedValue(existingPages),
    },
    siteContent: { findUnique: vi.fn().mockResolvedValue(null) },
    clubTheme: { findUnique: vi.fn().mockResolvedValue(null) },
    xeroToken: { findFirst: vi.fn().mockResolvedValue(null) },
  } as unknown as ReadDb;
}

describe("config-transfer import plan", () => {
  it("classifies an unmatched page as create", async () => {
    const plan = await buildImportPlan(targetDb([]), pagesBundle([BASE_PAGE]), { format: CLUB_FORMAT_TEST, mode: "merge" });
    expect(plan.summary).toEqual({ create: 1, update: 0, delete: 0, unchanged: 0 });
    expect(plan.categories[0].items[0]).toMatchObject({
      entity: "page-content",
      key: "about",
      action: "create",
    });
  });

  it("classifies an identical existing page as unchanged", async () => {
    const plan = await buildImportPlan(
      targetDb([BASE_PAGE]),
      pagesBundle([BASE_PAGE]),
      { format: CLUB_FORMAT_TEST, mode: "merge" },
    );
    expect(plan.summary.unchanged).toBe(1);
    expect(plan.categories[0].items[0].action).toBe("unchanged");
  });

  it("classifies a changed page as update with the changed fields", async () => {
    const plan = await buildImportPlan(
      targetDb([{ ...BASE_PAGE, title: "Old Title" }]),
      pagesBundle([BASE_PAGE]),
      { format: CLUB_FORMAT_TEST, mode: "merge" },
    );
    const item = plan.categories[0].items[0];
    expect(item.action).toBe("update");
    expect(item.changedFields).toContain("title");
  });

  it("produces a deterministic fingerprint that changes with DB state", async () => {
    const bundle = pagesBundle([BASE_PAGE]);
    const empty = await buildImportPlan(targetDb([]), bundle, { format: CLUB_FORMAT_TEST, mode: "merge" });
    const populated = await buildImportPlan(targetDb([BASE_PAGE]), bundle, { format: CLUB_FORMAT_TEST, mode: "merge" });
    expect(empty.fingerprint).not.toBe(populated.fingerprint);
    // Same inputs → same fingerprint.
    const again = await buildImportPlan(targetDb([]), bundle, { format: CLUB_FORMAT_TEST, mode: "merge" });
    expect(again.fingerprint).toBe(empty.fingerprint);
  });
});

describe("remapImageRefs", () => {
  it("rewrites known image ids and leaves unknown ones", () => {
    const html = '<img src="/api/images/old1"><img src="/api/images/old2">';
    const out = remapImageRefs(html, new Map([["old1", "new1"]]));
    expect(out).toContain("/api/images/new1");
    expect(out).toContain("/api/images/old2");
  });
});
