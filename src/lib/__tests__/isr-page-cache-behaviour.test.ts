import { describe, expect, it, vi } from "vitest";

import FileSystemCache from "next/dist/server/lib/incremental-cache/file-system-cache";
import { IncrementalCache } from "next/dist/server/lib/incremental-cache";
import * as responseCache from "next/dist/server/response-cache";
import {
  getResponseCacheOwner,
  getRouteCacheKey,
} from "next/dist/server/lib/route-cache-key";

/**
 * `CachedRouteKind` and `IncrementalCacheKind` are declared as ambient CONST
 * enums, and this repository compiles with `isolatedModules`, which refuses to
 * access an ambient const enum member by name (TS2748). Next does emit both as
 * real runtime objects, so they are read through one untyped namespace import
 * instead of being hard-coded: a Next upgrade that renamed `APP_PAGE` would then
 * leave these `undefined` rather than passing a stale literal to a cache that
 * silently accepted it, and the first case below fails on exactly that.
 */
const { CachedRouteKind, IncrementalCacheKind } = responseCache as unknown as {
  CachedRouteKind: { APP_PAGE: string };
  IncrementalCacheKind: { APP_PAGE: string };
};

/**
 * The three properties #2352 slice 1 depends on inside Next's own cache, EXECUTED
 * against the vendored Next rather than assumed (first read on next@16.2.12,
 * re-verified on 16.3.8, which scoped response-cache keys to the owning route).
 *
 * Why this file exists at all: the #2352 planning pass asked for an *observed*
 * cache-full degradation rather than an assumed one, and reading the vendored
 * source turned up two facts that changed the design.
 *
 *  1. A runtime full-route entry is written under `<distDir>/server/app`, NOT under
 *     `.next/cache`. The production container's root filesystem is read-only with a
 *     tmpfs on `.next/cache` only, so the default configuration would have failed
 *     every write. `next.config.ts` therefore sets `experimental.isrFlushToDisk:
 *     false` and makes the in-memory store authoritative.
 *  2. `FileSystemCache.set()` writes to that memory store BEFORE it consults
 *     `flushToDisk`, and `IncrementalCache.set()` wraps the whole handler call in a
 *     try/catch that only warns. Together those are the degradation behaviour: a
 *     store that cannot be written costs a warning and a re-render, never a 500.
 *
 * A Next upgrade that changes any of this fails here, loudly, instead of silently
 * turning public page views back into full renders — or, worse, into 500s.
 *
 * What this file does NOT claim: it says nothing about behaviour under real memory
 * pressure in a 1GB container. That is a staging measurement, recorded as such.
 */

const MEMORY_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * The route that owns `/about`, built the way Next builds it. Since next@16.3.8
 * every page or route store carries the owning route module (`ctx.route`, set by
 * `ResponseCache.getCacheContext()` from `RouteModule.cacheOwner`), and
 * `IncrementalCache` scopes the storage key to it. A store WITHOUT one is
 * refused by an invariant before the handler runs — a caller bug Next's own
 * request path cannot commit, so the cases below pass an owner exactly as a real
 * request does rather than exercising a call shape production never makes.
 */
const ABOUT_OWNER = getResponseCacheOwner({
  kind: "APP_PAGE",
  page: "/about/page",
  pathname: "/about",
} as never);

function appPageEntry(html: string) {
  return {
    kind: CachedRouteKind.APP_PAGE,
    html,
    rscData: Buffer.from("rsc"),
    headers: {},
    postponed: undefined,
    status: 200,
    segmentData: undefined,
  };
}

/** A filesystem that refuses every write, standing in for a full or read-only mount. */
function refusingFs() {
  const enospc = Object.assign(new Error("ENOSPC: no space left on device"), {
    code: "ENOSPC",
  });

  return {
    readFile: vi.fn(async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }),
    readdir: vi.fn(async () => []),
    writeFile: vi.fn(async () => {
      throw enospc;
    }),
    mkdir: vi.fn(async () => {
      throw enospc;
    }),
    stat: vi.fn(async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }),
  };
}

describe("Next's full-route cache, as vendored (#2352 slice 1)", () => {
  it("still names its cache kinds what the cases below pass it", () => {
    // Read from Next rather than written out here, so a renamed member fails on
    // this line with an obvious message instead of three cases down with a
    // confusing one.
    expect(CachedRouteKind.APP_PAGE).toBe("APP_PAGE");
    expect(IncrementalCacheKind.APP_PAGE).toBe("APP_PAGE");
  });

  it("keeps a page in memory even when the disk half is switched off", async () => {
    // The property `next.config.ts` relies on: with `isrFlushToDisk: false` the
    // entry never touches a filesystem, so a read-only container can still serve a
    // stored page.
    const fs = refusingFs();
    const cache = new FileSystemCache({
      fs: fs as never,
      flushToDisk: false,
      serverDistDir: "/app/.next/server",
      revalidatedTags: [],
      maxMemoryCacheSize: MEMORY_CACHE_BYTES,
      _appDir: true,
      _pagesDir: false,
      _requestHeaders: {},
    } as never);

    await cache.set("/about", appPageEntry("<html>about</html>") as never, {
      kind: IncrementalCacheKind.APP_PAGE,
    } as never);

    const stored = await cache.get("/about", {
      kind: IncrementalCacheKind.APP_PAGE,
    } as never);

    expect((stored?.value as { html?: string })?.html).toBe("<html>about</html>");
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it("DEGRADES to a warning when a store cannot be written, rather than throwing", async () => {
    // The observed cache-full behaviour. `IncrementalCache.set()` swallows the
    // handler's error, so a page that cannot be stored is simply rendered again on
    // the next request. That is what makes an exhausted or read-only cache a
    // performance event and not an outage.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const handlerKeys: string[] = [];

    class RefusingHandler {
      async get() {
        return null;
      }
      async set(key: string) {
        handlerKeys.push(key);
        throw Object.assign(new Error("ENOSPC: no space left on device"), {
          code: "ENOSPC",
        });
      }
      async revalidateTag() {}
      resetRequestCache() {}
    }

    const cache = new IncrementalCache({
      dev: false,
      flushToDisk: false,
      minimalMode: false,
      requestHeaders: {},
      maxMemoryCacheSize: MEMORY_CACHE_BYTES,
      getPrerenderManifest: () => ({
        version: 4,
        routes: {},
        dynamicRoutes: {},
        notFoundRoutes: [],
        preview: {
          previewModeId: "preview-id",
          previewModeSigningKey: "signing-key",
          previewModeEncryptionKey: "encryption-key",
        },
      }),
      CurCacheHandler: RefusingHandler as never,
    } as never);

    await expect(
      cache.set("/about", appPageEntry("<html>about</html>") as never, {
        kind: IncrementalCacheKind.APP_PAGE,
        route: ABOUT_OWNER,
        cacheControl: { revalidate: 300, expire: undefined },
      } as never),
    ).resolves.toBeUndefined();

    // The refusal really came from the store, under the route-scoped key Next
    // now uses, so the warning below is the swallowed handler error and not
    // some earlier short-circuit.
    expect(handlerKeys).toEqual([getRouteCacheKey("/about", ABOUT_OWNER)]);

    expect(warn).toHaveBeenCalledWith(
      "Failed to update prerender cache for",
      "/about",
      expect.objectContaining({ code: "ENOSPC" }),
    );

    warn.mockRestore();
  });

  it("stores a runtime page under server/, outside .next/cache, which is why the disk half is off", async () => {
    // The measured fact that drove the configuration: this path is NOT under
    // `.next/cache`, so the container's tmpfs never covered it and its read-only
    // root would have refused every write. On next@16.2.12 it was
    // `server/app/about.html`; since 16.3.8 a runtime store is keyed to its owning
    // route and lands in `server/route-cache/APP_PAGE/<sha256>/$/about.html` —
    // a different directory under the same read-only `server/`, so the decision
    // stands and this case pins the property, not the exact layout.
    const cache = new FileSystemCache({
      fs: refusingFs() as never,
      flushToDisk: false,
      serverDistDir: "/app/.next/server",
      revalidatedTags: [],
      maxMemoryCacheSize: MEMORY_CACHE_BYTES,
      _appDir: true,
      _pagesDir: false,
      _requestHeaders: {},
    } as never);

    // The key a real request stores under, not a hand-written one.
    const key = getRouteCacheKey("/about", ABOUT_OWNER);
    const filePath: string = (
      cache as unknown as {
        getFilePath: (p: string, kind: string) => string;
      }
    ).getFilePath(`${key}.html`, IncrementalCacheKind.APP_PAGE);

    const normalised = filePath.replace(/\\/g, "/");
    expect(normalised.startsWith("/app/.next/server/")).toBe(true);
    expect(normalised.endsWith("/about.html")).toBe(true);
    expect(normalised).not.toContain("/.next/cache/");
  });
});
