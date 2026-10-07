import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revalidateTag: vi.fn(),
  unstableCache: vi.fn(
    (loader: () => Promise<unknown>) => loader,
  ),
  capacity: vi.fn(async () => 20),
  modules: vi.fn(async () => ({ analytics: true })),
  banners: vi.fn(async () => []),
  theme: vi.fn(async () => ({ appCss: "" })),
  clubIdentity: vi.fn(async () => ({ name: "Test Club" })),
  analyticsConfig: vi.fn(async () => null),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({
  revalidateTag: mocks.revalidateTag,
  unstable_cache: mocks.unstableCache,
}));
vi.mock("@/lib/lodge-capacity", () => ({
  getDefaultLodgeCapacity: mocks.capacity,
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: mocks.modules,
}));
vi.mock("@/lib/site-banners", () => ({
  getCurrentSiteBanners: mocks.banners,
}));
vi.mock("@/lib/club-theme", () => ({
  getWebsiteThemeRenderState: mocks.theme,
}));
vi.mock("@/lib/club-identity-settings", () => ({
  getClubIdentity: mocks.clubIdentity,
}));
vi.mock("@/lib/analytics-settings", () => ({
  resolveAnalyticsRuntimeConfig: mocks.analyticsConfig,
}));

import {
  getCachedAnalyticsRuntimeConfig,
  getCachedCurrentSiteBanners,
  getCachedDefaultLodgeCapacity,
  getCachedEffectiveModuleFlags,
  getCachedWebsiteThemeRenderState,
} from "@/lib/public-layout-config";
import {
  invalidatePublicLayoutConfig,
  PUBLIC_LAYOUT_CACHE_TAGS,
} from "@/lib/public-layout-cache";

describe("public layout config cache", () => {
  beforeEach(() => {
    mocks.revalidateTag.mockClear();
  });

  it("uses independent short-lived tagged caches for non-security config", async () => {
    // Vitest 5 clears mock histories before each test, including calls made
    // while statically imported modules were evaluated during collection.
    vi.resetModules();
    await import("@/lib/public-layout-config");
    expect(mocks.unstableCache.mock.calls).toEqual([
      [mocks.capacity, ["public-layout-default-lodge-capacity"], {
        tags: [PUBLIC_LAYOUT_CACHE_TAGS.capacity], revalidate: 15,
      }],
      [mocks.modules, ["public-layout-module-flags"], {
        tags: [PUBLIC_LAYOUT_CACHE_TAGS.modules], revalidate: 15,
      }],
      [mocks.banners, ["public-layout-site-banners"], {
        tags: [PUBLIC_LAYOUT_CACHE_TAGS.banners], revalidate: 15,
      }],
      [mocks.theme, ["public-layout-theme"], {
        tags: [PUBLIC_LAYOUT_CACHE_TAGS.theme], revalidate: 15,
      }],
      [mocks.clubIdentity, ["public-layout-club-identity"], {
        tags: [PUBLIC_LAYOUT_CACHE_TAGS.identity], revalidate: 15,
      }],
      // #2573: the club's Google Analytics runtime configuration joins the same
      // shape — its own key, its own tag, the same short TTL — so an admin save
      // takes effect promptly instead of at the next TTL lapse.
      [mocks.analyticsConfig, ["public-layout-analytics-config"], {
        tags: [PUBLIC_LAYOUT_CACHE_TAGS.analytics], revalidate: 15,
      }],
    ]);
  });

  it("delegates cached reads to their existing sources of truth", async () => {
    await Promise.all([
      getCachedDefaultLodgeCapacity(),
      getCachedEffectiveModuleFlags(),
      getCachedCurrentSiteBanners(),
      getCachedWebsiteThemeRenderState(),
    ]);
    expect(mocks.capacity).toHaveBeenCalledOnce();
    expect(mocks.modules).toHaveBeenCalledOnce();
    expect(mocks.banners).toHaveBeenCalledOnce();
    expect(mocks.theme).toHaveBeenCalledOnce();
  });

  // The module flag is the cache KEY as well as an argument (#2573): a club with
  // the analytics module off must never be served an entry built while it was on.
  it("passes the module flag through to the analytics resolver", async () => {
    mocks.analyticsConfig.mockClear();
    await getCachedAnalyticsRuntimeConfig(false);
    await getCachedAnalyticsRuntimeConfig(true);
    expect(mocks.analyticsConfig.mock.calls).toEqual([[false], [true]]);
  });

  it("invalidates every requested tag with stale-while-revalidate semantics", () => {
    invalidatePublicLayoutConfig(
      PUBLIC_LAYOUT_CACHE_TAGS.modules,
      PUBLIC_LAYOUT_CACHE_TAGS.banners,
      PUBLIC_LAYOUT_CACHE_TAGS.theme,
    );
    expect(mocks.revalidateTag.mock.calls).toEqual([
      [PUBLIC_LAYOUT_CACHE_TAGS.modules, "max"],
      [PUBLIC_LAYOUT_CACHE_TAGS.banners, "max"],
      [PUBLIC_LAYOUT_CACHE_TAGS.theme, "max"],
    ]);
  });

  // There is no capacity-specific invalidation any more (#2352 slice-1 review).
  // A capacity write has to clear the STORED public pages, not just the tag —
  // `{{lodge-capacity}}` is resolved from uncached reads, so the page's ISR entry
  // carries no capacity tag for `revalidateTag` to expire. The nine writers now call
  // `revalidatePublicSite()`, which is pinned by
  // public-content-invalidation-contract.test.ts.
  it("still exposes the tag itself for the shared helper to clear", () => {
    invalidatePublicLayoutConfig(PUBLIC_LAYOUT_CACHE_TAGS.capacity);
    expect(mocks.revalidateTag).toHaveBeenCalledWith(
      PUBLIC_LAYOUT_CACHE_TAGS.capacity,
      "max",
    );
  });
});
