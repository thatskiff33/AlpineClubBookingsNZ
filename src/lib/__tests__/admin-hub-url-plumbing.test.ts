import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { revalidatePath } from "next/cache";
import { getImplicitTags } from "next/dist/server/lib/implicit-tags";
import { normalizeAppPath } from "next/dist/shared/lib/router/utils/app-paths";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import nextConfig from "../../../next.config";
import {
  ADMIN_PAGES,
  adminPageCachePath,
  adminPageCachePathFor,
  buildAdminUrlRules,
  samePage,
  type AdminHubPage,
} from "@/lib/admin-hubs";
import { ADMIN_HUBS_LIVE } from "@/lib/admin-hubs/release";
import { revalidateAdminPage } from "@/lib/admin-hubs/revalidate";
import { buildUnpaidFinishedStaysHref } from "@/lib/unpaid-finished-stays-hrefs";
import { stripComments } from "./support/strip-comments";

/**
 * C3 (#4800). The rules themselves, in both states, are pinned in
 * `admin-hubs-registry.test.ts`. This file pins the three readers: the shipped
 * Next config, the sidebar's active-link comparison, and revalidation under the
 * off-state rewrite.
 */

function tagsEmittedFor(urlPath: string): string[] {
  const store: { incrementalCache: object; pendingRevalidatedTags?: { tag: string }[] } = {
    incrementalCache: {},
  };
  workAsyncStorage.run(store as never, () => {
    revalidatePath(urlPath);
  });
  return (store.pendingRevalidatedTags ?? []).map((item) => item.tag);
}

describe("shipped admin URL rules", () => {
  it("builds redirects and beforeFiles rewrites from the registry at the current switch", async () => {
    const rules = buildAdminUrlRules(ADMIN_HUBS_LIVE);
    await expect(nextConfig.redirects!()).resolves.toEqual([...rules.redirects]);
    const rewrites = await nextConfig.rewrites!();
    if (Array.isArray(rewrites)) throw new Error("rewrites must be the staged form");
    expect(rewrites.beforeFiles).toEqual([...rules.rewrites.beforeFiles]);
    // Nothing has moved, so today's config still redirects and rewrites nothing.
    expect(ADMIN_HUBS_LIVE).toBe(false);
    expect(rules).toEqual({ redirects: [], rewrites: { beforeFiles: [] } });
  });

  it.each([false, true])(
    "a moved page's rules point at the file in state live=%s",
    (live) => {
      const payments = ADMIN_PAGES.find((page) => page.id === "payments")!;
      const moved: AdminHubPage = { ...payments, moved: true };
      const rules = buildAdminUrlRules(live, [moved]);
      if (live) {
        expect(rules).toEqual({
          redirects: [
            {
              source: "/admin/payments",
              destination: "/admin/finance/payments",
              permanent: false,
            },
          ],
          rewrites: { beforeFiles: [] },
        });
        return;
      }
      expect(rules).toEqual({
        redirects: [
          {
            source: "/admin/finance/payments",
            destination: "/admin/payments",
            permanent: false,
          },
        ],
        rewrites: {
          beforeFiles: [
            { source: "/admin/payments", destination: "/admin/finance/payments" },
          ],
        },
      });
    },
  );
});

describe("samePage", () => {
  it("keeps today's prefix match, including the deepest of two ancestors", () => {
    expect(samePage("/admin/payments", "/admin/payments")).toBe(true);
    expect(samePage("/admin/payments/extra", "/admin/payments")).toBe(true);
    expect(samePage("/admin/payment", "/admin/payments")).toBe(false);
    expect(samePage("/admin/xero/setup", "/admin/xero")).toBe(true);
    expect(samePage("/admin/xero/setup", "/admin/xero/setup")).toBe(true);
    const hrefs = ["/admin/xero", "/admin/xero/setup", "/admin/payments"];
    const active = hrefs
      .filter((href) => samePage("/admin/xero/setup", href))
      .reduce((best, href) => (href.length > best.length ? href : best), "");
    expect(active).toBe("/admin/xero/setup");
  });

  it("does not let a filtered bookings link steal the highlight", () => {
    const filtered = buildUnpaidFinishedStaysHref("2026-07-01");
    expect(samePage("/admin/bookings", filtered)).toBe(false);
    const hrefs = ["/admin/bookings", filtered];
    const active = hrefs
      .filter((href) => samePage("/admin/bookings", href))
      .reduce((best, href) => (href.length > best.length ? href : best), "");
    expect(active).toBe("/admin/bookings");
  });

  it("treats the hub URL as the same page as the sidebar's old link", () => {
    expect(samePage("/admin/finance/payments", "/admin/payments")).toBe(true);
    expect(samePage("/admin/finance/payments/extra", "/admin/payments")).toBe(true);
    expect(samePage("/admin/finance/xero/setup", "/admin/xero")).toBe(true);
    expect(samePage("/admin/finance/xero/setup", "/admin/xero/setup")).toBe(true);
    expect(samePage("/admin/finance/xero/setup", "/admin/payments")).toBe(false);
    const hrefs = ["/admin/xero", "/admin/xero/setup"];
    const active = hrefs
      .filter((href) => samePage("/admin/finance/xero/setup", href))
      .reduce((best, href) => (href.length > best.length ? href : best), "");
    expect(active).toBe("/admin/xero/setup");
  });

  it("prefers the static notices page over the [id] page for /admin/notices/new", () => {
    expect(samePage("/admin/notices/new", "/admin/notices/new")).toBe(true);
    expect(samePage("/admin/notices/abc", "/admin/notices/new")).toBe(false);
    expect(samePage("/admin/notices/abc", "/admin/notices")).toBe(true);
  });

  it("falls back to a prefix match for an href the registry does not know", () => {
    expect(samePage("/admin/not-a-page/child", "/admin/not-a-page")).toBe(true);
    expect(samePage("/admin/not-a-page", "/admin/not-a-pag")).toBe(false);
  });

  it("is what the sidebar uses to choose the active link", () => {
    const source = readFileSync("src/components/admin-sidebar.tsx", "utf8");
    expect(source).toContain("samePage(pathname, href)");
  });
});

describe("revalidateAdminPage", () => {
  it("refreshes today's URL while no page has moved", () => {
    for (const page of ADMIN_PAGES) {
      if (page.oldPath.includes("[")) continue;
      expect(adminPageCachePathFor(page), page.id).toBe(page.oldPath);
    }
    expect(adminPageCachePath("payments")).toBe("/admin/payments");
    expect(adminPageCachePath("subscriptions")).toBe("/admin/subscriptions");
    expect(adminPageCachePath("stuck-states")).toBe("/admin/stuck-states");
    expect(adminPageCachePath("setup")).toBe("/admin/setup");
    expect(adminPageCachePath("setup-finance")).toBe("/admin/setup/finance");
    expect(adminPageCachePath("bookings")).toBe("/admin/bookings");
    expect(adminPageCachePath("dashboard")).toBe("/admin/dashboard");
  });

  it("refuses a dynamic page instead of refreshing nothing", () => {
    const detail = ADMIN_PAGES.find((page) => page.oldPath.includes("["))!;
    expect(() => adminPageCachePathFor(detail)).toThrow(/dynamic segment/);
  });

  it("calls revalidatePath with the file's URL", () => {
    const store: { incrementalCache: object; pendingRevalidatedTags?: { tag: string }[] } = {
      incrementalCache: {},
    };
    workAsyncStorage.run(store as never, () => {
      revalidateAdminPage("payments");
    });
    expect((store.pendingRevalidatedTags ?? []).map((item) => item.tag)).toEqual(
      tagsEmittedFor("/admin/payments"),
    );
  });

  it("refreshes the file a beforeFiles rewrite serves, not the browser's old URL", async () => {
    // Next tags a render with the route module's resolved pathname, which is
    // `normalizeAppPath` of the page file (`route-module.js`), not the URL that
    // was rewritten onto it. The off-state rewrite's destination is that file.
    const payments = ADMIN_PAGES.find((page) => page.id === "payments")!;
    const moved: AdminHubPage = { ...payments, moved: true };
    const currentFile = `/(admin)${payments.oldPath}/page`;
    expect(existsSync(`src/app${currentFile}.tsx`)).toBe(true);
    expect(normalizeAppPath(currentFile)).toBe(payments.oldPath);

    const movedFile = `/(admin)${moved.hubPath}/page`;
    expect(normalizeAppPath(movedFile)).toBe(moved.hubPath);
    expect(adminPageCachePathFor(moved)).toBe(moved.hubPath);

    const { tags } = await getImplicitTags(movedFile, normalizeAppPath(movedFile), null);
    const hubTags = tagsEmittedFor(moved.hubPath);
    const oldTags = tagsEmittedFor(moved.oldPath);
    expect(tags.some((tag: string) => hubTags.includes(tag))).toBe(true);
    expect(tags.some((tag: string) => oldTags.includes(tag))).toBe(false);
  });
});

describe("literal /admin revalidatePath calls", () => {
  // The card-refund routes still name their paths literally. Another lane owns
  // those files; this branch does not edit them. A new call anywhere else has
  // to go through revalidateAdminPage.
  const LEFT_LITERAL = [
    "src/app/api/admin/payments/card-refunds/[id]/paid-another-way/route.ts",
    "src/app/api/admin/payments/card-refunds/[id]/paid-twice-resolved/route.ts",
  ];
  const CALL = /revalidatePath\(\s*["']\/admin\/[^"']*["']/;

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return entry.name === "node_modules" || entry.name.startsWith(".") ? [] : sourceFiles(rel);
      }
      return /\.tsx?$/.test(entry.name) ? [rel] : [];
    });
  }

  it("survive only in the card-refund routes this branch does not edit", () => {
    const found = sourceFiles("src")
      .filter((file) => CALL.test(stripComments(readFileSync(file, "utf8"))))
      .map((file) => file.split(path.sep).join("/"))
      .sort();
    expect(found).toEqual([...LEFT_LITERAL].sort());
  });
});
