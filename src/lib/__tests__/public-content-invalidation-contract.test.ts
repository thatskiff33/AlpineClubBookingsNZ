import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const helperWriters: Array<[string, number]> = [
  ["src/app/api/admin/age-tier-settings/route.ts", 1],
  ["src/app/api/admin/lodges/route.ts", 1],
  ["src/app/api/admin/lodges/[id]/route.ts", 1],
  // 3 -> 4 (#2352 MC-03D): POST, PUT, PATCH and now DELETE. The count is
  // deliberately exact rather than ">= 1" — that is what makes a new writer on
  // this file a decision someone has to take rather than an omission nobody
  // notices — so a fifth mutating method must bump it again, and must not be
  // "fixed" by loosening the assertion.
  ["src/app/api/admin/page-content/route.ts", 4],
  ["src/app/api/admin/config-transfer/apply/route.ts", 1],
  ["src/app/api/admin/seasons/route.ts", 1],
  ["src/app/api/admin/seasons/[id]/route.ts", 2],
  ["src/app/api/admin/booking-policies/cancellation/route.ts", 1],
  ["src/app/api/admin/booking-policies/group-discount/route.ts", 1],
  ["src/app/api/admin/booking-policies/minimum-stay/route.ts", 1],
  ["src/app/api/admin/booking-policies/minimum-stay/[id]/route.ts", 2],
  ["src/app/api/admin/booking-policies/periods/route.ts", 1],
  ["src/app/api/admin/booking-policies/periods/[id]/route.ts", 2],
];
const directWriters = [
  "src/app/api/admin/fee-configuration/route.ts",
  "src/app/api/admin/membership-types/route.ts",
  "src/app/api/admin/membership-types/[id]/route.ts",
  "src/app/api/admin/membership-types/[id]/merge/route.ts",
  "src/app/api/admin/membership-types/reorder/route.ts",
  "src/app/api/admin/public-content-settings/route.ts",
  // E3 #1929: the club-identity PUT also revalidates the public layout.
  "src/app/api/admin/club-identity/route.ts",
];

// E3 #1929: the DB-first identity tag must be invalidated on every writer that
// can change club/lodge identity — the club-identity admin PUT, the lodge write
// routes (default lodge name feeds identity), and config-transfer apply.
const identityInvalidators = [
  "src/app/api/admin/club-identity/route.ts",
  "src/app/api/admin/lodges/route.ts",
  "src/app/api/admin/lodges/[id]/route.ts",
];

/**
 * #2352 F3. These three writes used to clear ONLY the 15-second tagged data
 * caches. That was enough while every public page was re-rendered on every visit;
 * with the CMS pages served from the full-route ISR store it changed nothing a
 * visitor could see, because what they are served is a stored render of the layout
 * — banners, module flags, theme CSS and all — rather than a fresh one.
 *
 * Each must now go through `revalidatePublicSite()`, which clears both.
 */
const fullRouteAndTagWriters = [
  ["src/app/api/admin/modules/route.ts", "PUBLIC_LAYOUT_CACHE_TAGS.modules"],
  ["src/app/api/admin/site-banners/route.ts", "PUBLIC_LAYOUT_CACHE_TAGS.banners"],
  ["src/app/api/admin/site-banners/[id]/route.ts", "PUBLIC_LAYOUT_CACHE_TAGS.banners"],
  ["src/app/api/admin/site-style/route.ts", "PUBLIC_LAYOUT_CACHE_TAGS.theme"],
] as const;

/**
 * The gap the slice-1 review found in the list above: F3 audited only the four
 * writers that change LAYOUT CONFIG, and missed every writer that changes data the
 * CMS page BODY renders server-side.
 *
 *  • **Lodge capacity.** `{{lodge-capacity}}` / `{{lodge-capacity:slug}}` resolve
 *    through UNCACHED reads (`src/lib/page-content-embeds.ts` →
 *    `getLodgeCapacity()` / `getDefaultLodgeCapacity()`, neither wrapped in
 *    `unstable_cache`). No cached read means no cache tag on the page's ISR entry,
 *    so the `revalidateTag("public-layout:capacity")` these nine handlers used to
 *    issue had nothing to expire: an admin lowering the bed count from 24 to 18
 *    left `/accommodation` advertising 24.
 *  • **The images tree.** `{{photo-gallery}}` / `{{photo-slideshow}}` are resolved
 *    by an `fs.readdir` at render time and passed as props, so the listing freezes
 *    into the stored page. None of these routes revalidated anything at all, so a
 *    DELETED photo kept being rendered from the store.
 *
 * Every one of them now goes through `revalidatePublicSite()`, and this list is
 * what stops the next one being missed.
 */
const bodyDataWriters = [
  "src/app/api/admin/lodge-settings/route.ts",
  "src/app/api/admin/bed-allocation/beds/route.ts",
  "src/app/api/admin/bed-allocation/beds/[id]/route.ts",
  "src/app/api/admin/bed-allocation/rooms/route.ts",
  "src/app/api/admin/bed-allocation/rooms/[id]/route.ts",
  "src/app/api/admin/bed-allocation/rooms/bulk/route.ts",
  "src/app/api/admin/bed-allocation/rooms/import-from-config/route.ts",
  "src/app/api/admin/image-manager/upload/route.ts",
  "src/app/api/admin/image-manager/images/route.ts",
  "src/app/api/admin/image-manager/directories/route.ts",
] as const;

describe("public site full-route invalidation contract (#2352 F3)", () => {
  it.each(fullRouteAndTagWriters)(
    "clears the stored public pages as well as the tag in %s",
    (relativePath, tag) => {
      const source = fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

      expect(source).toContain(`revalidatePublicSite(${tag})`);
      // The half-wired form: a tag clear with no full-route clear beside it.
      expect(source).not.toMatch(/^\s*invalidatePublicLayoutConfig\(/m);
    },
  );

  it.each(bodyDataWriters)(
    "clears the stored public pages after a body-data write in %s",
    (relativePath) => {
      const source = fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

      expect(source).toMatch(/^\s*revalidatePublicSite\(\);?$/m);
      // The tag-only helper these used to call is gone; a reintroduction would be
      // the same defect again. Line-anchored on a CALL, because the lodge-settings
      // route's own comment names the helper it stopped using — a substring check
      // would fail on the explanation rather than on a regression.
      expect(source).not.toMatch(/^\s*invalidatePublicLodgeCapacity\(/m);
    },
  );

  it("has no tag-only capacity helper left to call", () => {
    const cache = fs.readFileSync(
      path.join(process.cwd(), "src/lib/public-layout-cache.ts"),
      "utf8",
    );

    expect(cache).not.toMatch(
      /export function invalidatePublicLodgeCapacity\(/,
    );
  });

  it("keeps ONE shared entry point, so a new write cannot pick the wrong half", () => {
    const helper = fs.readFileSync(
      path.join(process.cwd(), "src/lib/public-content-revalidation.ts"),
      "utf8",
    );

    // Both clears, in one function.
    expect(helper).toContain('revalidatePath("/", "layout")');
    expect(helper).toContain("invalidatePublicLayoutConfig(");
    // And the older name is now a one-line alias over it rather than a second
    // implementation that could drift.
    expect(helper).toMatch(
      /export function revalidatePublicPageContent\(\): void \{\s*revalidatePublicSite\(\);\s*\}/,
    );
  });

  it("does not use the route-group revalidatePath form for the public site", () => {
    // `revalidatePath("/(website)", "layout")` was never verified against the
    // full-route store, and one form used everywhere is one thing to verify.
    const siteStyle = fs.readFileSync(
      path.join(process.cwd(), "src/app/api/admin/site-style/route.ts"),
      "utf8",
    );

    // Line-anchored, because the route's own comment NAMES the form it stopped
    // using — a substring check would fail on the explanation rather than on a call.
    expect(siteStyle).not.toMatch(/^\s*revalidatePath\("\/\(website\)"/m);
  });
});

describe("public content authority invalidation contract", () => {
  it.each(helperWriters)("invalidates after successful writes in %s", (relativePath, expectedCalls) => {
    const source = fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
    expect(source.match(/^\s*revalidatePublicPageContent\(\);?$/gm)?.length ?? 0).toBe(expectedCalls);
  });

  it.each(directWriters)("invalidates the public layout in %s", (relativePath) => {
    const source = fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
    expect(source).toContain('revalidatePath("/", "layout")');
  });

  it("keeps config-transfer invalidation on the success path after its audited apply", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/app/api/admin/config-transfer/apply/route.ts"), "utf8");
    expect(source.indexOf("revalidatePublicPageContent()"))
      .toBeGreaterThan(source.indexOf("await applyConfigImport"));
    expect(source.indexOf("revalidatePublicPageContent()"))
      .toBeLessThan(source.indexOf("return NextResponse.json({ result })"));
  });

  it.each(identityInvalidators)("invalidates the DB-first club identity in %s", (relativePath) => {
    const source = fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
    expect(source).toContain("invalidatePublicClubIdentity()");
    expect(source).toContain("primeClubIdentitySync()");
  });

  it("invalidates the identity tag + primes the sync accessor on config-transfer apply", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/app/api/admin/config-transfer/apply/route.ts"), "utf8");
    expect(source).toContain("PUBLIC_LAYOUT_CACHE_TAGS.identity");
    expect(source).toContain("primeClubIdentitySync()");
  });

  // #2200: an import that changes the age tiers must drop the in-process
  // getAgeTierSettings cache — gated on the age-tier entity actually changing so
  // an unrelated import does not needlessly clear it. The behavioural gate (fires
  // only when appliedEntities includes "age-tier") is proven in
  // config-transfer-apply-age-tier-cache.test.ts; this pins the route wiring.
  it("clears the age-tier cache on config-transfer apply, gated on the age-tier entity", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/app/api/admin/config-transfer/apply/route.ts"), "utf8");
    expect(source).toContain("invalidateAgeTierCache()");
    expect(source).toMatch(/appliedEntities\.includes\("age-tier"\)/);
  });
});

/*
  #2352 MC-03D, second review finding S2 — the CLIENT-side half of the same
  problem the block above covers on the server.

  Revalidation fixes the public site. It does nothing for the other admin panel
  already open in the officer's browser: `admin/page-content` renders
  `PageContentPanel` and `PublicContentSettingsPanel` as siblings with no common
  client ancestor, the settings panel loads once on mount, and it posts its WHOLE
  settings object on save. So deleting a page left that panel holding a stale
  published-page list and — when the delete repointed the Book Now target inside
  its own transaction — a `bookNowTarget: "PAGE"` with a page id that no longer
  existed. Every later save in it then failed with 400 "The selected Book Now page
  is not published." until the officer happened to reload. Deterministic, not a
  race, and invisible to any server-side assertion.

  Pinned structurally because the failure is the ABSENCE of a wire between two
  files: both ends must reference the one shared event constant, so renaming or
  dropping either end fails here rather than in production.
*/
describe("page deletion tells the sibling settings panel to re-read (#2352 S2)", () => {
  const read = (relativePath: string) =>
    fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

  it("announces the change from the delete's success path", () => {
    const source = read("src/components/admin/page-content-panel.tsx");
    expect(source).toMatch(
      /^import \{ emitPublicContentSettingsChanged \} from "@\/lib\/public-content-settings-events";$/m,
    );

    /*
      Line-anchored on horizontal whitespace only, for the same reason the
      site-style assertion above is: a plain `toContain` also matches the call
      NAMED in a comment. Proven — commenting the call out left every substring
      assertion passing, which is precisely the mutation this gate exists to
      catch. `[^\S\r\n]*` cannot consume `//`, so a commented-out call fails here.
    */
    const emitCall = /^[^\S\r\n]*emitPublicContentSettingsChanged\(\);$/m;
    expect(source).toMatch(emitCall);

    // On the success path, not the failure one: after the toast that reports the
    // delete, and before that try's own `catch`. Anchored on the toast rather
    // than on the failure message, because "Failed to delete page" appears twice
    // in this handler — once on the non-ok response inside the try — so an
    // indexOf of it would land ahead of the success path and prove nothing.
    const emitAt = source.search(emitCall);
    const successToastAt = source.indexOf("toast.success(`Deleted ${page.title}`)");
    expect(successToastAt).toBeGreaterThan(-1);
    const catchAt = source.indexOf("} catch (error) {", successToastAt);
    expect(catchAt).toBeGreaterThan(successToastAt);
    expect(emitAt).toBeGreaterThan(successToastAt);
    expect(emitAt).toBeLessThan(catchAt);
  });

  it("re-reads the settings panel when it hears that event, and unsubscribes", () => {
    const source = read("src/components/admin/public-content-settings-panel.tsx");
    expect(source).toMatch(
      /^import \{ PUBLIC_CONTENT_SETTINGS_CHANGED_EVENT \} from "@\/lib\/public-content-settings-events";$/m,
    );
    // Line-anchored for the comment reason given above.
    expect(source).toMatch(
      /^[^\S\r\n]*window\.addEventListener\(PUBLIC_CONTENT_SETTINGS_CHANGED_EVENT, load\);$/m,
    );
    // A listener added on mount without a matching removal leaks a stale `load`
    // per remount, so the cleanup is part of the contract rather than tidiness.
    expect(source).toMatch(
      /^[^\S\r\n]*window\.removeEventListener\(PUBLIC_CONTENT_SETTINGS_CHANGED_EVENT, load\);$/m,
    );
  });

  it("has both ends on the same event name, from the shared module", () => {
    const events = read("src/lib/public-content-settings-events.ts");
    expect(events).toContain(
      'export const PUBLIC_CONTENT_SETTINGS_CHANGED_EVENT =',
    );
    // The literal lives in exactly one place: neither panel may hard-code it.
    for (const panel of [
      "src/components/admin/page-content-panel.tsx",
      "src/components/admin/public-content-settings-panel.tsx",
    ]) {
      expect(read(panel)).not.toContain('"admin:public-content-settings-changed"');
    }
  });
});
