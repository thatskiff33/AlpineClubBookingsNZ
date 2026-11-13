import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { NextConfig } from "next";
import {
  unstable_getResponseFromNextConfig,
  getRedirectUrl,
  getRewrittenUrl,
  isRewrite,
} from "next/experimental/testing/server";
import { prepareDestination } from "next/dist/shared/lib/router/utils/prepare-destination";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { ASSET_NOT_FOUND_PATH, ASSET_NOT_FOUND_REWRITES } from "@/lib/asset-url-404";
import { ADMIN_PAGES, ADMIN_RETIRED_PAGES, isInexactAdminPagePath } from "@/lib/admin-hubs";

// ---------------------------------------------------------------------------
// `next.config.ts` and the admin hub URLs (epic #4468, C3 #4800).
//
// The config's `redirects()` and `rewrites().beforeFiles` are generated from
// the hub registry. C4 (#4801) has moved the Website pages, C5 (#4802) the
// Finance pages, C6 (#4803) the Fees & booking rules pages, C7 (#4804) the
// Help & system pages, C8 (#4805) the Messages & email pages and C10 (#4807)
// the Bookings pages, and the switch is off, so each of those hub URLs
// redirects to its old URL and each old URL is rewritten to the moved file. The five retired pages (S1 #4796) still redirect
// in both states. All of this is run through
// Next's own pipeline (`unstable_getResponseFromNextConfig`, which calls the
// real `loadCustomRoutes()`). `admin-hubs-registry.test.ts` walks every page
// of the registry through the generated rules themselves.
// ---------------------------------------------------------------------------

type Config = NextConfig & {
  redirects: NonNullable<NextConfig["redirects"]>;
  rewrites: NonNullable<NextConfig["rewrites"]>;
};

/**
 * The real `next.config.ts`, loaded fresh. With `live`, the switch reads that
 * value. Nothing else is replaced.
 */
async function loadConfig(options: { live?: boolean } = {}) {
  vi.resetModules();
  vi.doUnmock("@/lib/admin-hubs/release");
  if (options.live !== undefined) {
    vi.doMock("@/lib/admin-hubs/release", () => ({ ADMIN_HUBS_LIVE: options.live }));
  }
  return (await import("../../../next.config")).default as Config;
}

type Outcome = { kind: "redirect"; status: number; url: string } | { kind: "rewrite"; url: string } | { kind: "none" };

async function resolve(nextConfig: NextConfig, url: string): Promise<Outcome> {
  const response = await unstable_getResponseFromNextConfig({
    url: `https://example.org${url}`,
    nextConfig,
  });
  const redirect = getRedirectUrl(response);
  const canonical = (target: string) => {
    const parsed = new URL(target, "https://example.org");
    const search = new URLSearchParams(parsed.search).toString();
    return search ? `${parsed.pathname}?${search}` : parsed.pathname;
  };
  if (redirect) return { kind: "redirect", status: response.status, url: canonical(redirect) };
  if (isRewrite(response)) return { kind: "rewrite", url: canonical(getRewrittenUrl(response)!) };
  return { kind: "none" };
}

/** The redirect's full Location, fragment included, against the page's origin. */
async function location(nextConfig: NextConfig, url: string) {
  const response = await unstable_getResponseFromNextConfig({
    url: `https://example.org${url}`,
    nextConfig,
  });
  return { status: response.status, location: getRedirectUrl(response) };
}

/** `[name]` -> `:name`, the spelling `buildAdminUrlRules` hands to Next. */
function nextPattern(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      const simple = /^\[([A-Za-z][A-Za-z0-9]*)\]$/.exec(segment);
      return simple ? `:${simple[1]}` : segment;
    })
    .join("/");
}

function dynamicSegmentCount(path: string): number {
  return path.split("/").filter((segment) => segment.startsWith("[")).length;
}

/** A concrete URL for a dynamic page, so the smoke request can match `:name`. */
function samplePath(path: string): string {
  return path.replace(/\[[^\]/]+\]/g, "sample");
}

describe("next.config.ts with the switch off", () => {
  const movedPages = () =>
    ADMIN_PAGES.filter((page) => page.moved && page.hubPath !== page.oldPath).sort(
      (a, b) =>
        dynamicSegmentCount(a.oldPath) - dynamicSegmentCount(b.oldPath) ||
        a.oldPath.localeCompare(b.oldPath),
    );

  it("redirects each moved page's hub URL, rewrites its old URL, and keeps the asset rewrites", async () => {
    const config = await loadConfig();
    const moved = movedPages();
    expect(new Set(moved.map((page) => page.hub))).toEqual(
      new Set(["website", "finance", "rules", "system", "messages", "bookings"]),
    );
    const retired = ADMIN_RETIRED_PAGES.map(({ oldPath }) => oldPath);
    expect(
      (await config.redirects()).map(({ source, permanent }) => ({ source, permanent })),
    ).toEqual([
      ...retired.map((source) => ({ source, permanent: false as const })),
      ...moved.map((page) => ({ source: nextPattern(page.hubPath), permanent: false as const })),
    ]);
    const rewrites = await config.rewrites();
    expect(rewrites).toEqual({
      beforeFiles: moved.map((page) => ({
        source: nextPattern(page.oldPath),
        destination: nextPattern(page.hubPath),
      })),
      afterFiles: [...ASSET_NOT_FOUND_REWRITES],
      fallback: [],
    });
  });

  /**
   * C4 (#4801), C5 (#4802), C6 (#4803), C7 (#4804), C8 (#4805) and C10 (#4807) off-state smoke. Next's config pipeline answers a
   * `beforeFiles` rewrite as 200 and a redirect as 307. The old URL is served
   * from the moved file; the hub URL redirects to the old URL.
   */
  it("serves each moved page's old URL (200) and redirects its hub URL there", async () => {
    const config = await loadConfig();
    const moved = movedPages();
    expect(moved.length).toBeGreaterThan(0);
    for (const page of moved) {
      const oldUrl = samplePath(page.oldPath);
      const hubUrl = samplePath(page.hubPath);
      const served = await unstable_getResponseFromNextConfig({
        url: `https://example.org${oldUrl}`,
        nextConfig: config,
      });
      expect(served.status, oldUrl).toBe(200);
      expect(isRewrite(served), oldUrl).toBe(true);
      expect(new URL(getRewrittenUrl(served)!, "https://example.org").pathname).toBe(hubUrl);

      const hub = await unstable_getResponseFromNextConfig({
        url: `https://example.org${hubUrl}`,
        nextConfig: config,
      });
      expect(hub.status, hubUrl).toBe(307);
      expect(new URL(getRedirectUrl(hub)!, "https://example.org").pathname).toBe(oldUrl);
    }
  });

  it("off: the server matches a moved page's rewrite in any letter case, which is why the proxy refuses those spellings", async () => {
    // The server compiles each `beforeFiles` rewrite with `getPathMatch` and no
    // `sensitive` option (`buildCustomRoute('before_files_rewrite', item)` in
    // `next/dist/server/lib/router-utils/filesystem.js`), which path-to-regexp
    // reads as case-insensitive. (The testing util above matches its regex
    // without that flag, so it cannot show this.) The same call, on the real
    // rules: a respelled old URL reaches the moved file while the proxy and the
    // guards read the path as written. `admin-page-exact-path-proxy.test.ts`
    // proves the proxy answers it with a 404 first; here, the premise.
    const rules = ((await (await loadConfig()).rewrites()) as {
      beforeFiles: { source: string; destination: string }[];
    }).beforeFiles;
    const serverMatch = (url: string) =>
      rules.find(({ source }) =>
        getPathMatch(source, { strict: true, removeUnnamedParams: true })(url),
      )?.destination;
    for (const [url, destination] of [
      ["/admin/Site-Style", "/admin/website/site-style"],
      ["/ADMIN/PAGE-CONTENT", "/admin/website/page-content"],
      ["/admin/Appearance/Identity", "/admin/website/appearance/identity"],
    ] as const) {
      expect(serverMatch(url), url).toBe(destination);
      expect(isInexactAdminPagePath(url), url).toBe(true);
    }
    expect(serverMatch("/admin/site-style")).toBe("/admin/website/site-style");
    expect(isInexactAdminPagePath("/admin/site-style")).toBe(false);
    // An escaped spelling matches no rule (they match the raw path), and on
    // next@16.4.3 it renders the public catch-all; it is refused anyway, as a
    // precaution against a Next that starts rendering decoded paths.
    expect(serverMatch("/admin/site%2Dstyle")).toBeUndefined();
    expect(isInexactAdminPagePath("/admin/site%2Dstyle")).toBe(true);
  });

  it.each(["/admin/members", "/admin/lockers", "/admin/members/x1"])(
    "routes %s untouched",
    async (url) => {
      await expect(resolve(await loadConfig(), url)).resolves.toEqual({ kind: "none" });
    },
  );

  // S1 (#4796): each retired page's old URL, with a query, through the real
  // config. A redirect in `next.config.ts` runs before the proxy (Next's
  // proxy reference, "Execution order"), so nothing is served at a retired URL
  // and its admission is the destination's.
  it.each([
    [
      "/admin/family-suggestions?q=smith",
      "https://example.org/admin/family-groups?q=smith&tab=suggestions",
    ],
    [
      "/admin/membership-cancellation?returnTo=%2Fadmin%2Fmembers",
      "https://example.org/admin/membership-cancellations?returnTo=%2Fadmin%2Fmembers&tab=settings",
    ],
    [
      // The request's own `tab` gives way to the tab that holds the page.
      "/admin/setup/cancellation?tab=requests&x=1",
      "https://example.org/admin/membership-cancellations?tab=settings&x=1",
    ],
    ["/admin/setup/booking-rules?x=1", "https://example.org/admin/bookings-setup?x=1"],
    ["/admin/setup/integrations", "https://example.org/admin/health#integration-readiness"],
  ])("redirects %s to %s, a 307 until its release is out", async (url, expected) => {
    // Not yet permanent: a browser caches a 308 with no expiry, so a rollback
    // would leave old links bouncing to tabs the old code does not have. The
    // retired redirects become 308s one release later.
    const { status, location: actual } = await location(await loadConfig(), url);
    expect(status).toBe(307);
    const parse = (href: string) => {
      const parsed = new URL(href, "https://example.org");
      return {
        pathname: parsed.pathname,
        query: Object.fromEntries(parsed.searchParams),
        hash: parsed.hash,
      };
    };
    expect(parse(actual!)).toEqual(parse(expected));
  });

  /**
   * A fragment AND a query. The testing util cannot show this one: it appends
   * the query to the destination after its fragment (`${newUrl}?${search}` in
   * `config-testing-utils.js`). The server does not: `resolve-routes.js`
   * takes `prepareDestination`'s pathname, hash and query apart, sets `search`
   * from the query, and `router-server.js` writes `url.format` of the result as
   * the Location. Those same steps, on the real rule:
   */
  it("puts the request's query before the section's fragment, as Next's server writes it", async () => {
    const rule = (await (await loadConfig()).redirects()).find(
      ({ source }) => source === "/admin/setup/integrations",
    )!;
    const { parsedDestination } = prepareDestination({
      appendParamsToQuery: false,
      destination: rule.destination,
      params: {},
      query: { x: "1" },
    });
    const { query, ...rest } = parsedDestination;
    const search = new URLSearchParams(query as Record<string, string>).toString();
    expect(url.format({ ...rest, search: search ? `?${search}` : "" })).toBe(
      "/admin/health?x=1#integration-readiness",
    );
  });

  it("leaves the pages the retired ones were merged into, and their neighbours, alone", async () => {
    const config = await loadConfig();
    // Bookings Setup (C6 #4803) and System Health (C7 #4804) have moved: each
    // old URL is served from the moved file, as every moved page's is, and
    // nothing redirects it.
    await expect(resolve(config, "/admin/bookings-setup")).resolves.toEqual({
      kind: "rewrite",
      url: "/admin/rules/bookings-setup",
    });
    await expect(resolve(config, "/admin/health")).resolves.toEqual({
      kind: "rewrite",
      url: "/admin/system/health",
    });
    for (const url of [
      "/admin/family-groups",
      "/admin/membership-cancellations",
      "/admin/setup",
      "/admin/setup/finance",
      "/admin/setup/foundations",
      "/api/admin/family-suggestions",
      "/api/admin/membership-cancellation-settings",
    ]) {
      await expect(resolve(config, url), url).resolves.toEqual({ kind: "none" });
    }
  });
});

describe("next.config.ts over the moved Finance hub", () => {
  // Finance moved for real in C5 (#4802); until then this block mocked the move.
  it("PREMISE: every Finance page has moved", () => {
    const finance = ADMIN_PAGES.filter((page) => page.hub === "finance");
    expect(finance.length).toBeGreaterThan(0);
    expect(finance.filter((page) => !page.moved).map((page) => page.id)).toEqual([]);
  });

  it("off: the hub URL redirects (307) to the old URL, query kept; the old URL is rewritten to the moved file", async () => {
    const config = await loadConfig({ live: false });
    await expect(resolve(config, "/admin/finance/payments?tab=open")).resolves.toEqual({
      kind: "redirect",
      status: 307,
      url: "/admin/payments?tab=open",
    });
    await expect(resolve(config, "/admin/payments?tab=open")).resolves.toEqual({
      kind: "rewrite",
      url: "/admin/finance/payments?tab=open",
    });
    await expect(
      resolve(config, "/admin/xero/records/Booking/b-1"),
    ).resolves.toEqual({ kind: "rewrite", url: "/admin/finance/xero/records/Booking/b-1" });
    // An unmoved page is untouched.
    await expect(resolve(config, "/admin/members")).resolves.toEqual({ kind: "none" });
  });

  it("on: the old URL redirects (307) to the hub URL, query kept, and nothing is rewritten", async () => {
    const config = await loadConfig({ live: true });
    await expect(resolve(config, "/admin/payments?tab=open")).resolves.toEqual({
      kind: "redirect",
      status: 307,
      url: "/admin/finance/payments?tab=open",
    });
    await expect(resolve(config, "/admin/finance/payments")).resolves.toEqual({ kind: "none" });
    expect((await config.rewrites()) as { beforeFiles: unknown[] }).toMatchObject({
      beforeFiles: [],
    });
  });

  it.each([false, true])(
    "keeps the asset rewrites working and in place alongside the admin rules (live=%s)",
    async (live) => {
      const config = await loadConfig({ live });
      const rewrites = (await config.rewrites()) as { afterFiles: unknown[]; fallback: unknown[] };
      expect(rewrites.afterFiles).toEqual([...ASSET_NOT_FOUND_REWRITES]);
      expect(rewrites.fallback).toEqual([]);
      await expect(resolve(config, "/foo.png")).resolves.toEqual({
        kind: "rewrite",
        url: ASSET_NOT_FOUND_PATH,
      });
    },
  );

  it("PREMISE: the moved state really does produce rules, so the state above is not vacuous", async () => {
    const off = await loadConfig({ live: false });
    // The moved pages' own redirects, beside the retired pages'.
    const retired = new Set<string>(ADMIN_RETIRED_PAGES.map(({ oldPath }) => oldPath));
    expect((await off.redirects()).filter((rule) => !retired.has(rule.source)).length).toBeGreaterThan(0);
    const rewrites = (await off.rewrites()) as { beforeFiles: unknown[] };
    expect(rewrites.beforeFiles.length).toBeGreaterThan(0);
  });
});

describe("next.config.ts over the moved Rules hub", () => {
  // Fees & booking rules moved in C6 (#4803).
  it("PREMISE: every Fees & booking rules page has moved", () => {
    const rules = ADMIN_PAGES.filter((page) => page.hub === "rules");
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.filter((page) => !page.moved).map((page) => page.id)).toEqual([]);
  });

  it("off: the fee console's hub URL redirects to its old URL, and the old URL is served from the moved file, query kept", async () => {
    const config = await loadConfig({ live: false });
    await expect(resolve(config, "/admin/rules/fees?lodgeId=l-1")).resolves.toEqual({
      kind: "redirect",
      status: 307,
      url: "/admin/fees?lodgeId=l-1",
    });
    await expect(resolve(config, "/admin/fees?lodgeId=l-1")).resolves.toEqual({
      kind: "rewrite",
      url: "/admin/rules/fees?lodgeId=l-1",
    });
  });

  it("on: Booking Rules, merged into Bookings Setup, redirects once, straight to its hub URL", async () => {
    const config = await loadConfig({ live: true });
    await expect(resolve(config, "/admin/setup/booking-rules?x=1")).resolves.toEqual({
      kind: "redirect",
      status: 307,
      url: "/admin/rules/bookings-setup?x=1",
    });
    await expect(resolve(config, "/admin/rules/bookings-setup")).resolves.toEqual({ kind: "none" });
  });
});

describe("next.config.ts over the moved Help & system hub", () => {
  // Help & system moved in C7 (#4804).
  it("PREMISE: every Help & system page has moved", () => {
    const system = ADMIN_PAGES.filter((page) => page.hub === "system");
    expect(system.length).toBeGreaterThan(0);
    expect(system.filter((page) => !page.moved).map((page) => page.id)).toEqual([]);
  });

  it("off: the audit log's hub URL redirects to its old URL, and the old URL is served from the moved file, query kept", async () => {
    const config = await loadConfig({ live: false });
    await expect(resolve(config, "/admin/system/audit-log?q=b-1")).resolves.toEqual({
      kind: "redirect",
      status: 307,
      url: "/admin/audit-log?q=b-1",
    });
    await expect(resolve(config, "/admin/audit-log?q=b-1")).resolves.toEqual({
      kind: "rewrite",
      url: "/admin/system/audit-log?q=b-1",
    });
  });

  it("on: Integrations Setup, merged into System Health, redirects once, straight to its hub URL and section", async () => {
    const config = await loadConfig({ live: true });
    const { status, location: actual } = await location(config, "/admin/setup/integrations");
    expect(status).toBe(307);
    const parsed = new URL(actual!, "https://example.org");
    expect(parsed.pathname + parsed.hash).toBe("/admin/system/health#integration-readiness");
    await expect(resolve(config, "/admin/system/health")).resolves.toEqual({ kind: "none" });
  });
});

describe("next.config.ts over the moved Messages & email hub", () => {
  // Messages & email moved in C8 (#4805).
  it("PREMISE: every Messages & email page has moved", () => {
    const messages = ADMIN_PAGES.filter((page) => page.hub === "messages");
    expect(messages).toHaveLength(10);
    expect(messages.filter((page) => !page.moved).map((page) => page.id)).toEqual([]);
  });

  it("off: a notice's hub URL redirects to its old URL, and the old URL is served from the moved file, query kept", async () => {
    const config = await loadConfig({ live: false });
    await expect(resolve(config, "/admin/messages/notices/n-1?page=2")).resolves.toEqual({
      kind: "redirect",
      status: 307,
      url: "/admin/notices/n-1?page=2",
    });
    await expect(resolve(config, "/admin/notices/n-1?page=2")).resolves.toEqual({
      kind: "rewrite",
      url: "/admin/messages/notices/n-1?page=2",
    });
  });

  it("off: the new-notice page is served from its own file, and the Message Board keeps its tab and search", async () => {
    const config = await loadConfig({ live: false });
    await expect(resolve(config, "/admin/notices/new")).resolves.toEqual({
      kind: "rewrite",
      url: "/admin/messages/notices/new",
    });
    await expect(resolve(config, "/admin/messages/message-board?tab=hidden&q=ski")).resolves.toEqual({
      kind: "redirect",
      status: 307,
      url: "/admin/message-board?tab=hidden&q=ski",
    });
    await expect(resolve(config, "/admin/message-board?tab=hidden&q=ski")).resolves.toEqual({
      kind: "rewrite",
      url: "/admin/messages/message-board?tab=hidden&q=ski",
    });
  });

  it.each([false, true])("leaves the hub's root alone, which no page is at yet (live=%s)", async (live) => {
    await expect(resolve(await loadConfig({ live }), "/admin/messages")).resolves.toEqual({
      kind: "none",
    });
  });

  it("on: the old URL redirects once, straight to the hub URL", async () => {
    const config = await loadConfig({ live: true });
    await expect(resolve(config, "/admin/notifications")).resolves.toEqual({
      kind: "redirect",
      status: 307,
      url: "/admin/messages/notifications",
    });
    await expect(resolve(config, "/admin/notices/new")).resolves.toEqual({
      kind: "redirect",
      status: 307,
      url: "/admin/messages/notices/new",
    });
    await expect(resolve(config, "/admin/messages/notifications")).resolves.toEqual({ kind: "none" });
  });
});

describe("next.config.ts over the moved Bookings hub", () => {
  // Bookings moved in C10 (#4807). The prefix is `booking-desk`, not `bookings`.
  it("PREMISE: every Bookings page has moved", () => {
    const bookings = ADMIN_PAGES.filter((page) => page.hub === "bookings");
    expect(bookings).toHaveLength(7);
    expect(bookings.filter((page) => !page.moved).map((page) => page.id)).toEqual([]);
  });

  it("off: the Bookings hub URL redirects to its old URL, and the old URL is served from the moved file, query kept", async () => {
    const config = await loadConfig({ live: false });
    await expect(resolve(config, "/admin/booking-desk/bookings?status=PENDING")).resolves.toEqual({
      kind: "redirect",
      status: 307,
      url: "/admin/bookings?status=PENDING",
    });
    await expect(resolve(config, "/admin/bookings?status=PENDING")).resolves.toEqual({
      kind: "rewrite",
      url: "/admin/booking-desk/bookings?status=PENDING",
    });
  });

  it("off: Booking Requests keeps its tab and status, and each stub is served from its moved file", async () => {
    const config = await loadConfig({ live: false });
    await expect(
      resolve(config, "/admin/booking-desk/booking-requests?tab=approvals&status=PENDING"),
    ).resolves.toEqual({
      kind: "redirect",
      status: 307,
      url: "/admin/booking-requests?tab=approvals&status=PENDING",
    });
    await expect(resolve(config, "/admin/booking-requests?tab=approvals&status=PENDING")).resolves.toEqual({
      kind: "rewrite",
      url: "/admin/booking-desk/booking-requests?tab=approvals&status=PENDING",
    });
    await expect(resolve(config, "/admin/booking-approvals?status=PENDING")).resolves.toEqual({
      kind: "rewrite",
      url: "/admin/booking-desk/booking-approvals?status=PENDING",
    });
    await expect(resolve(config, "/admin/booking-change-requests?status=PENDING")).resolves.toEqual({
      kind: "rewrite",
      url: "/admin/booking-desk/booking-change-requests?status=PENDING",
    });
  });

  it.each([false, true])("leaves the hub's root alone, which no page is at yet (live=%s)", async (live) => {
    await expect(resolve(await loadConfig({ live }), "/admin/booking-desk")).resolves.toEqual({
      kind: "none",
    });
  });

  it("on: the old URL redirects once, straight to the hub URL, and the hub URL is not rewritten", async () => {
    const config = await loadConfig({ live: true });
    await expect(resolve(config, "/admin/bookings?status=PENDING")).resolves.toEqual({
      kind: "redirect",
      status: 307,
      url: "/admin/booking-desk/bookings?status=PENDING",
    });
    await expect(resolve(config, "/admin/booking-desk/bookings?status=PENDING")).resolves.toEqual({
      kind: "none",
    });
  });
});

// ---------------------------------------------------------------------------
// Next's config loader can load the registry: it does not apply the tsconfig
// `@/` alias, and a `server-only` module throws outside a server bundle. So
// every module `next.config.ts` reaches through a relative import must use only
// relative imports and packages, and none may be `server-only`. (A real
// `loadConfig()` of this config was also run when C3 landed; the result is in
// the PR.)
// ---------------------------------------------------------------------------

describe("next.config.ts's own import graph", () => {
  const ROOT = process.cwd();
  /** `import … from "x"`, `export … from "x"`, `import "x"`; not `import type`. */
  const IMPORT = /^\s*(import|export)\s+(type\s+)?(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm;

  function resolveRelative(fromFile: string, specifier: string): string {
    const base = path.resolve(path.dirname(fromFile), specifier);
    for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), base]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    throw new Error(`cannot resolve ${specifier} from ${fromFile}`);
  }

  function walk() {
    const seen = new Set<string>();
    const packages = new Set<string>();
    const queue = [path.join(ROOT, "next.config.ts")];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const match of fs.readFileSync(file, "utf8").matchAll(IMPORT)) {
        if (match[2]) continue; // type-only: erased, never loaded
        const specifier = match[3]!;
        if (specifier.startsWith(".")) queue.push(resolveRelative(file, specifier));
        else packages.add(specifier);
      }
    }
    return { files: [...seen].map((file) => path.relative(ROOT, file)).sort(), packages };
  }

  it("reaches the hub registry", () => {
    const { files } = walk();
    expect(files).toContain("src/lib/admin-hubs/index.ts");
    expect(files).toContain("src/lib/admin-hubs/release.ts");
    expect(files).toContain("src/lib/admin-hubs/hubs/finance.ts");
  });

  it("loads no aliased and no server-only module, only packages the loader can resolve", () => {
    const { packages } = walk();
    expect([...packages].filter((specifier) => specifier.startsWith("@/"))).toEqual([]);
    expect(packages.has("server-only")).toBe(false);
    // `next` itself is imported for its types only.
    expect([...packages].sort()).toEqual(["@sentry/nextjs/config", "node:crypto"]);
  });
});
