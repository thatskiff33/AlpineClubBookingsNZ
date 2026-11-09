import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { NextConfig } from "next";
import {
  unstable_getResponseFromNextConfig,
  getRedirectUrl,
  getRewrittenUrl,
  isRewrite,
} from "next/experimental/testing/server";
import { ASSET_NOT_FOUND_PATH, ASSET_NOT_FOUND_REWRITES } from "@/lib/asset-url-404";

// ---------------------------------------------------------------------------
// `next.config.ts` and the admin hub URLs (epic #4468, C3 #4800).
//
// The config's `redirects()` and `rewrites().beforeFiles` are generated from
// the hub registry. Today no page has moved, so both are empty and the config
// routes exactly as before; over a registry whose Finance hub has moved, the
// REAL config yields the rules the epic plan fixes for each switch state. Both
// are run through Next's own pipeline (`unstable_getResponseFromNextConfig`,
// which calls the real `loadCustomRoutes()`). `admin-hubs-registry.test.ts`
// walks every page of the registry through the generated rules themselves.
// ---------------------------------------------------------------------------

type Config = NextConfig & {
  redirects: NonNullable<NextConfig["redirects"]>;
  rewrites: NonNullable<NextConfig["rewrites"]>;
};

/**
 * The real `next.config.ts`, loaded fresh. With `movedHub`, that hub's fragment
 * has every page moved; with `live`, the switch reads that value. Nothing else
 * is replaced.
 */
async function loadConfig(options: { live?: boolean; movedHub?: string } = {}) {
  vi.resetModules();
  vi.doUnmock("@/lib/admin-hubs/release");
  vi.doUnmock("@/lib/admin-hubs/hubs/finance");
  if (options.live !== undefined) {
    vi.doMock("@/lib/admin-hubs/release", () => ({ ADMIN_HUBS_LIVE: options.live }));
  }
  if (options.movedHub) {
    vi.doMock(`@/lib/admin-hubs/hubs/${options.movedHub}`, async (importOriginal) => {
      const original = await importOriginal<Record<string, { pages: { moved: boolean }[] }>>();
      return Object.fromEntries(
        Object.entries(original).map(([name, fragment]) => [
          name,
          { ...fragment, pages: fragment.pages.map((page) => ({ ...page, moved: true })) },
        ]),
      );
    });
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

describe("next.config.ts today: no page has moved", () => {
  it("has no redirects and no beforeFiles rewrites, and keeps the asset rewrites as they were", async () => {
    const config = await loadConfig();
    expect(await config.redirects()).toEqual([]);
    const rewrites = await config.rewrites();
    expect(rewrites).toEqual({
      beforeFiles: [],
      afterFiles: [...ASSET_NOT_FOUND_REWRITES],
      fallback: [],
    });
  });

  it.each(["/admin/payments", "/admin/finance/payments", "/admin/members/x1"])(
    "routes %s untouched",
    async (url) => {
      await expect(resolve(await loadConfig(), url)).resolves.toEqual({ kind: "none" });
    },
  );
});

describe("next.config.ts over a moved Finance hub", () => {
  it("off: the hub URL redirects (307) to the old URL, query kept; the old URL is rewritten to the moved file", async () => {
    const config = await loadConfig({ live: false, movedHub: "finance" });
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
    const config = await loadConfig({ live: true, movedHub: "finance" });
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
      const config = await loadConfig({ live, movedHub: "finance" });
      const rewrites = (await config.rewrites()) as { afterFiles: unknown[]; fallback: unknown[] };
      expect(rewrites.afterFiles).toEqual([...ASSET_NOT_FOUND_REWRITES]);
      expect(rewrites.fallback).toEqual([]);
      await expect(resolve(config, "/foo.png")).resolves.toEqual({
        kind: "rewrite",
        url: ASSET_NOT_FOUND_PATH,
      });
    },
  );

  it("PREMISE: the moved state really does produce rules, so the empty state above is not vacuous", async () => {
    const off = await loadConfig({ live: false, movedHub: "finance" });
    expect((await off.redirects()).length).toBeGreaterThan(0);
    const rewrites = (await off.rewrites()) as { beforeFiles: unknown[] };
    expect(rewrites.beforeFiles.length).toBeGreaterThan(0);
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
