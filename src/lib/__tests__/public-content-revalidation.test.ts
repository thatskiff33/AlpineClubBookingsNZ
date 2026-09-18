import { beforeEach, describe, expect, it, vi } from "vitest";

import { PUBLIC_LAYOUT_CACHE_TAGS } from "@/lib/public-layout-cache";

/**
 * The BODY of the canonical public-site invalidator (#2352 D3).
 *
 * `public-content-invalidation-contract.test.ts` next door pins the 39 CALL SITES
 * — who must reach this helper, and where in the handler. It says nothing about
 * what the helper then does, and that gap was real: deleting
 * `revalidatePath("/", "layout")` from `revalidatePublicSite()` left the whole
 * Vitest tier green. Measured, not assumed — the mutation was applied to
 * `src/lib/public-content-revalidation.ts` and the contract suite (46 tests), the
 * catch-all's render-mode suite, `public-layout-cache-writers`,
 * `public-layout-config` and `admin-page-content-route` all still passed.
 *
 * That one line is the entire mechanism behind "an edit appears immediately". The
 * two caches are NOT interchangeable: `invalidatePublicLayoutConfig()` clears the
 * 15-second tagged data caches, but since slice 1 a public page view is served
 * from Next's FULL-ROUTE store, so clearing the data cache under a stored page
 * changes nothing the visitor sees. Only the tag expiry `revalidatePath` produces
 * makes the store return null and force a blocking regeneration — `revalidate =
 * 300` does not, because a stale entry is resolved to the requester before the
 * background rebuild starts (the reasoning is written out at
 * `src/app/(website)/[...slug]/page.tsx`).
 *
 * Until now the only thing proving it was the unpublish case in
 * `e2e/static-cms-pages.spec.ts`, which needs a real server and a real database.
 * That case remains the end-to-end proof; this is the unit-tier guard that fails
 * in seconds when someone refactors the line away.
 */

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  invalidatePublicLayoutConfig: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/public-layout-cache", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/public-layout-cache")),
  invalidatePublicLayoutConfig: mocks.invalidatePublicLayoutConfig,
}));

const { revalidatePublicPageContent, revalidatePublicSite } = await import(
  "@/lib/public-content-revalidation"
);

describe("revalidatePublicSite", () => {
  beforeEach(() => {
    mocks.revalidatePath.mockClear();
    mocks.invalidatePublicLayoutConfig.mockClear();
  });

  it("clears the FULL-ROUTE store, which is what makes an admin edit instant", () => {
    revalidatePublicSite();

    // Both arguments are load-bearing and neither is interchangeable. `"/"` with
    // `"layout"` is what reaches every route under the root layout — the stored
    // CMS pages included. The route-group form (`"/(website)"`) was deliberately
    // not kept, and a path-only call would clear that one address rather than the
    // tree.
    expect(mocks.revalidatePath).toHaveBeenCalledTimes(1);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("also clears the tagged data caches, always including capacity", () => {
    revalidatePublicSite();

    expect(mocks.invalidatePublicLayoutConfig).toHaveBeenCalledTimes(1);
    expect(mocks.invalidatePublicLayoutConfig).toHaveBeenCalledWith(
      PUBLIC_LAYOUT_CACHE_TAGS.capacity,
    );
  });

  it("passes a caller's extra tags through alongside capacity", () => {
    revalidatePublicSite(
      PUBLIC_LAYOUT_CACHE_TAGS.banners,
      PUBLIC_LAYOUT_CACHE_TAGS.theme,
    );

    expect(mocks.invalidatePublicLayoutConfig).toHaveBeenCalledWith(
      PUBLIC_LAYOUT_CACHE_TAGS.capacity,
      PUBLIC_LAYOUT_CACHE_TAGS.banners,
      PUBLIC_LAYOUT_CACHE_TAGS.theme,
    );
    // The extra tags must not cost the full-route clear — a writer that names a
    // tag is still a writer whose change has to appear on a stored page.
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });
});

describe("revalidatePublicPageContent", () => {
  beforeEach(() => {
    mocks.revalidatePath.mockClear();
    mocks.invalidatePublicLayoutConfig.mockClear();
  });

  it("is the same call under the older name, not a weaker one", () => {
    // 22 of the 39 pinned writers still use this name. If it ever stopped
    // delegating, every one of them would go back to clearing only the data
    // caches — silently, because the contract test next door only checks that
    // they call SOMETHING named this.
    revalidatePublicPageContent();

    expect(mocks.revalidatePath).toHaveBeenCalledTimes(1);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(mocks.invalidatePublicLayoutConfig).toHaveBeenCalledWith(
      PUBLIC_LAYOUT_CACHE_TAGS.capacity,
    );
  });
});
