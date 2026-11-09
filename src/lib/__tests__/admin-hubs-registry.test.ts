import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { NextConfig } from "next";
import {
  unstable_getResponseFromNextConfig,
  getRedirectUrl,
  getRewrittenUrl,
  isRewrite,
} from "next/experimental/testing/server";
import {
  ADMIN_PERMISSION_AREAS,
  ADMIN_ROUTE_MAP,
  ADMIN_PERMISSION_LEVELS,
  canOpenAdminPath,
  getAdminRouteRequirement,
  isAnyAdminAdmissionPath,
  isConsolidatedFeesPath,
  isRoomsBedsPath,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";
import {
  FEATURE_ROUTE_RULES,
  getRequiredFeaturesForPath,
} from "@/config/feature-routes";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import { getVisibleAdminNavSections } from "@/components/admin-sidebar";
import { requireCalendarDate } from "@/lib/club-time";
import {
  adminPageFiles,
  toRawPathname,
  toResolverPathname,
  toRepoRelative,
} from "@/lib/__tests__/helpers/admin-route-enumeration";
import { ADMIN_HUBS_LIVE } from "@/lib/admin-hubs/release";
import {
  ADMIN_HUBS,
  ADMIN_PAGES,
  ADMIN_RETIRED_PAGES,
  adminAnchorHref,
  adminHref,
  adminPageRoutePath,
  adminTabHref,
  buildAdminUrlRules,
  parseAdminPageTab,
  resolveAdminHref,
  type AdminUrlRules,
} from "@/lib/admin-hubs";
import {
  hubRoot,
  isAdminMenuDestination,
  type AdminHubPage,
  type AdminRetiredPage,
} from "@/lib/admin-hubs/define";
import {
  ADMIN_PAGE_ADMISSION_PATHS,
  adminHubOwnedPaths,
} from "@/lib/admin-hubs/security-map";
import { stripComments } from "@/lib/__tests__/support/strip-comments";

// ---------------------------------------------------------------------------
// The admin hub registry (epic #4468, C1 #4798).
//
// Every fact the registry records is checked here against what the code
// answers for the same path: the page tree on disk, `getAdminRouteRequirement`,
// `canOpenAdminPath`, `getRequiredFeaturesForPath` and the sidebar. Since C2
// (#4799) the page half of those answers is GENERATED from this registry, so
// for the map they now prove the generator reads each entry as it says; the
// independent statement of what each page must answer is the frozen oracle in
// `admin-hub-route-parity.test.ts` and the page pin in
// `admin-route-area-matrix.test.ts`. The page list and its resolver pathnames
// come from the shared enumeration, so this suite measures the tree exactly as
// the route-map drift guard does (`INV-SSOT-004`).
// ---------------------------------------------------------------------------

/** On-disk page path (`[id]` kept) -> the pathname the resolvers see (`x123`). */
const RESOLVER_PATH_BY_PAGE = new Map(
  adminPageFiles.map((file) => [toRawPathname(file), toResolverPathname(file)]),
);
const PAGE_FILE_BY_PATH = new Map(
  adminPageFiles.map((file) => [toRawPathname(file), toRepoRelative(file)]),
);
const ON_DISK_PAGE_PATHS = [...RESOLVER_PATH_BY_PAGE.keys()].sort();

/** A concrete URL for a registry path: every `[name]` filled with `x123`. */
function concrete(registryPath: string): string {
  return registryPath.replace(/\[[^\]/]+\]/g, "x123");
}

/**
 * Where a page's `page.tsx` lives: its hub path once it has moved, its old path
 * until then. The registry's own answer (C3 #4800), which `revalidateAdminPage`
 * also uses, so this census checks the one definition against the disk.
 */
const diskPath = adminPageRoutePath;

/**
 * The pathname the resolvers are asked about. It is always the OLD path, moved
 * or not: the off-state rewrite keeps the proxy and the layout guard seeing it.
 * (C2 generates the map for the hub path too; the parity census proves the two
 * answer alike.) `concrete` uses the shared enumeration's placeholder, which a
 * test below pins.
 */
function resolverPath(page: AdminHubPage): string {
  return concrete(page.oldPath);
}

/**
 * The registry against a page list from disk: every page on disk registered
 * once, at the path where its file now lives, and no entry without a file.
 * A function of its inputs so a synthetic tree can drive it.
 */
function diskCensus(
  pages: readonly AdminHubPage[],
  onDisk: readonly string[],
): string[] {
  const counts = new Map<string, number>();
  for (const page of pages) {
    counts.set(diskPath(page), (counts.get(diskPath(page)) ?? 0) + 1);
  }
  const disk = new Set(onDisk);
  const missing = onDisk
    .filter((p) => !counts.has(p))
    .map((p) => `${PAGE_FILE_BY_PATH.get(p) ?? p} (${p}) has no registry entry`);
  const duplicated = [...counts]
    .filter(([, count]) => count > 1)
    .map(([p, count]) => `${p} is registered ${count} times`);
  const stale = pages
    .filter((page) => !disk.has(diskPath(page)))
    .map(
      (page) =>
        `${page.id} is ${page.moved ? "moved" : "not moved"}, but no page.tsx serves ${diskPath(page)}`,
    );
  return [...missing, ...duplicated, ...stale];
}

/** `path` equals `root` or sits beneath it, `/`-anchored as every resolver matches. */
function nestsUnder(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function nestsEitherWay(a: string, b: string): boolean {
  return nestsUnder(a, b) || nestsUnder(b, a);
}

const APPROVED_HUBS = [
  ["dashboard", "Home"],
  ["bookings", "Bookings"],
  ["rules", "Fees & booking rules"],
  ["finance", "Finance"],
  ["members", "Members"],
  ["lodge-ops", "Lodge"],
  ["website", "Website"],
  ["messages", "Messages & email"],
  ["system", "Help & system"],
  ["settings", "Club settings"],
] as const;

describe("the hubs", () => {
  it("are the ten the owner approved on #4468, in order", () => {
    expect(ADMIN_HUBS.map((hub) => [hub.key, hub.label])).toEqual(APPROVED_HUBS);
  });

  it("have unique keys and prefixes, and no prefix nests inside another", () => {
    const keys = ADMIN_HUBS.map((hub) => hub.key);
    expect(new Set(keys).size).toBe(keys.length);
    const roots = ADMIN_HUBS.map((hub) => hubRoot(hub.prefix));
    for (const [i, a] of roots.entries()) {
      for (const b of roots.slice(i + 1)) {
        expect(nestsEitherWay(a, b), `${a} and ${b}`).toBe(false);
      }
    }
    for (const hub of ADMIN_HUBS) {
      expect(hub.prefix, hub.key).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
});

describe("every admin page is registered exactly once", () => {
  it("finds the page tree", () => {
    // A broken walk must not make the census below pass vacuously.
    expect(ON_DISK_PAGE_PATHS.length).toBeGreaterThan(100);
  });

  it("registers each page directory on disk once, and nothing that is not on disk", () => {
    expect(diskCensus(ADMIN_PAGES, ON_DISK_PAGE_PATHS)).toEqual([]);
  });

  it("expects a moved page at its hub path, not its old path", () => {
    // C4's first `git mv`, played against a synthetic tree.
    const pages = ADMIN_PAGES.map((page) =>
      page.id === "member-merge" ? { ...page, moved: true } : page,
    );
    const merge = pages.find((page) => page.id === "member-merge")!;
    const afterMove = ON_DISK_PAGE_PATHS.filter((p) => p !== merge.oldPath).concat(
      merge.hubPath,
    );

    expect(diskCensus(pages, afterMove)).toEqual([]);
    // Flagged moved, but the file never left: the hub path is missing and the
    // old path is unregistered.
    expect(diskCensus(pages, ON_DISK_PAGE_PATHS)).toEqual([
      `${PAGE_FILE_BY_PATH.get(merge.oldPath)} (${merge.oldPath}) has no registry entry`,
      `member-merge is moved, but no page.tsx serves ${merge.hubPath}`,
    ]);
    // Moved on disk, but the registry was not told.
    expect(diskCensus(ADMIN_PAGES, afterMove)).toEqual([
      `${merge.hubPath} (${merge.hubPath}) has no registry entry`,
      `member-merge is not moved, but no page.tsx serves ${merge.oldPath}`,
    ]);
  });

  it("asks the resolvers about each unmoved page exactly as the shared enumeration does", () => {
    // `resolverPath` fills dynamic segments itself so it still works after a
    // move; this pins its placeholder to the enumeration's (INV-SSOT-004).
    const drift = ADMIN_PAGES.filter((page) => !page.moved)
      .filter((page) => RESOLVER_PATH_BY_PAGE.get(page.oldPath) !== resolverPath(page))
      .map((page) => page.id);
    expect(drift).toEqual([]);
  });
});

describe("ids and paths are unique", () => {
  const unique = (values: string[]) =>
    values.filter((value, index) => values.indexOf(value) !== index);

  it("has unique ids, old paths and hub paths", () => {
    expect(unique(ADMIN_PAGES.map((page) => page.id))).toEqual([]);
    expect(unique(ADMIN_PAGES.map((page) => page.oldPath))).toEqual([]);
    expect(unique(ADMIN_PAGES.map((page) => page.hubPath))).toEqual([]);
  });

  it("never gives one page's hub path as another page's old path", () => {
    // A hub path equal to someone else's old path is a redirect chain waiting
    // for the first move.
    const collisions = ADMIN_PAGES.flatMap((page) =>
      ADMIN_PAGES.filter(
        (other) => other !== page && other.oldPath === page.hubPath,
      ).map((other) => `${page.id}'s hub path is ${other.id}'s old path`),
    );
    expect(collisions).toEqual([]);
  });
});

describe("each entry's admission is what today's code gives its old path", () => {
  it("records the route map's area, at view", () => {
    const drift = ADMIN_PAGES.flatMap((page) => {
      const requirement = getAdminRouteRequirement(resolverPath(page), "GET");
      return requirement?.area === page.area && requirement.level === "view"
        ? []
        : [`${page.id}: registry ${page.area}, route map ${JSON.stringify(requirement)}`];
    });
    expect(drift).toEqual([]);
  });

  it("records canOpenAdminPath's special rules, in its order", () => {
    const drift = ADMIN_PAGES.flatMap((page) => {
      const probe = resolverPath(page);
      const expected = isAnyAdminAdmissionPath(probe)
        ? "any-admin"
        : isConsolidatedFeesPath(probe)
          ? "fees-or"
          : isRoomsBedsPath(probe)
            ? "rooms-beds-or"
            : "area";
      return expected === page.admission
        ? []
        : [`${page.id}: registry ${page.admission}, canOpenAdminPath ${expected}`];
    });
    expect(drift).toEqual([]);
  });

  /**
   * The recorded (area, admission) pair must reproduce `canOpenAdminPath` for
   * EVERY permission grid — all 3^7 — not just the seeded roles. This is what C2
   * will generate the map from, so it is checked as behaviour, not as labels.
   */
  it("reproduces canOpenAdminPath for every permission grid", () => {
    const grids: AdminPermissionMatrix[] = ADMIN_PERMISSION_AREAS.reduce<
      AdminPermissionMatrix[]
    >(
      (acc, area) =>
        acc.flatMap((partial) =>
          ADMIN_PERMISSION_LEVELS.map((level) => ({ ...partial, [area.key]: level })),
        ),
      [{} as AdminPermissionMatrix],
    );
    expect(grids).toHaveLength(3 ** ADMIN_PERMISSION_AREAS.length);

    const admits = (page: AdminHubPage, grid: AdminPermissionMatrix) => {
      switch (page.admission) {
        case "any-admin":
          return ADMIN_PERMISSION_AREAS.some((area) => grid[area.key] !== "none");
        case "fees-or":
          return grid.bookings !== "none" || grid.finance !== "none";
        case "rooms-beds-or":
          return grid.lodge !== "none" || grid.bookings !== "none";
        case "area":
          return grid[page.area] !== "none";
      }
    };

    const drift: string[] = [];
    for (const page of ADMIN_PAGES) {
      const probe = resolverPath(page);
      for (const grid of grids) {
        const actual = canOpenAdminPath(
          { canLogin: true, accessRoles: [], adminPermissionMatrix: grid },
          probe,
        );
        if (actual !== admits(page, grid)) {
          drift.push(`${page.id} with ${JSON.stringify(grid)}: canOpenAdminPath ${actual}`);
          break;
        }
      }
    }
    expect(drift).toEqual([]);
  });

  it("records every module flag the path needs today", () => {
    const drift = ADMIN_PAGES.flatMap((page) => {
      const expected = getRequiredFeaturesForPath(resolverPath(page)).sort();
      const recorded = [...page.flags].sort();
      return JSON.stringify(expected) === JSON.stringify(recorded)
        ? []
        : [`${page.id}: registry [${recorded}], feature routes [${expected}]`];
    });
    expect(drift).toEqual([]);
  });

  it("marks fullAdminOnly exactly where the sidebar hides a page from non-Full-Admins", () => {
    const allOn = Object.fromEntries(
      MODULE_KEYS.map((key) => [key, true]),
    ) as FeatureFlags;
    const fullGrid = Object.fromEntries(
      ADMIN_PERMISSION_AREAS.map((area) => [area.key, "edit"]),
    ) as AdminPermissionMatrix;
    const day = requireCalendarDate("2026-07-01");
    const hrefs = (isFullAdmin: boolean) =>
      new Set(
        getVisibleAdminNavSections(day, allOn, fullGrid, isFullAdmin).flatMap(
          (section) => section.items.map((item) => item.href.split(/[?#]/)[0]),
        ),
      );
    const forEveryone = hrefs(false);
    const fullAdminOnly = [...hrefs(true)].filter((href) => !forEveryone.has(href));

    expect(fullAdminOnly.length).toBeGreaterThan(0);
    expect(
      ADMIN_PAGES.filter((page) => page.fullAdminOnly)
        .map((page) => page.oldPath)
        .sort(),
    ).toEqual(fullAdminOnly.sort());
  });
});

interface PrefixCensusSources {
  /** Every prefix in today's route map (`ADMIN_ROUTE_MAP`). */
  readonly routeMapPrefixes: readonly string[];
  /** Every module-gated path, labelled. */
  readonly gatedPaths: ReadonlyArray<{ readonly path: string; readonly label: string }>;
  /** The paths `canOpenAdminPath` admits by a special rule. */
  readonly specialPaths: readonly string[];
  /** Every `page.tsx` on disk. */
  readonly pagePaths: readonly string[];
}

const TODAYS_SOURCES: PrefixCensusSources = {
  routeMapPrefixes: ADMIN_ROUTE_MAP.map(({ prefix }) => prefix),
  gatedPaths: FEATURE_ROUTE_RULES.flatMap((rule) => [
    ...(rule.prefixes ?? []).map((p) => ({ path: p, label: `${rule.flag} prefix` })),
    ...(rule.exemptPaths ?? []).map((p) => ({ path: p, label: `${rule.flag} exemption` })),
  ]),
  specialPaths: Object.values(ADMIN_PAGE_ADMISSION_PATHS).flat(),
  pagePaths: ON_DISK_PAGE_PATHS,
};

/**
 * The page paths a hub may own beneath its root: its landing page, and every
 * one of its pages that has moved there.
 */
function ownedPagePaths(
  hubKey: string,
  pages: readonly AdminHubPage[] = ADMIN_PAGES,
): string[] {
  return pages.filter(
    (page) => page.hub === hubKey && (page.moved || page.hubPath === page.oldPath),
  ).map((page) => page.hubPath);
}

/**
 * What a hub owns beneath its root: the page files it may hold there, and the
 * rules C2 generates there from its own pages (#4799). Those rules sit under
 * the root by design — they are each page's old-path rules relocated — so they
 * are the hub's, not collisions; any OTHER rule beneath the root still is.
 */
interface Owned {
  readonly pages: readonly string[];
  readonly rules: readonly string[];
}

const NOTHING_OWNED: Owned = { pages: [], rules: [] };

function ownedBy(hubKey: string, pages: readonly AdminHubPage[] = ADMIN_PAGES): Owned {
  return { pages: ownedPagePaths(hubKey, pages), rules: adminHubOwnedPaths(hubKey) };
}

/**
 * Why a hub prefix cannot be used: the reasons it would collide with today's
 * security map, module gates or page tree. Empty means it is safe.
 *
 * A collision means a hub path would inherit a rule that is not its page's:
 * the route map takes the FIRST matching prefix, so a page under
 * `/admin/bookings/...` would resolve to `bookings` whatever it is; under
 * `/admin/lodge/...` it would need the kiosk module; under `/admin/fees/...` it
 * would take the fee console's OR rule. An existing page under the prefix would
 * also be redirected away from its own URL when the switch goes on.
 *
 * Probing the root finds rules AT or ABOVE it; only the lists find rules
 * BELOW it, so both are needed. The rules C2 generates beneath the root from
 * the hub's own pages are excluded as `owned.rules`, as moved pages are for the
 * page tree.
 */
function hubPrefixCollisions(
  prefix: string,
  owned: Owned = NOTHING_OWNED,
  sources: PrefixCensusSources = TODAYS_SOURCES,
): string[] {
  const root = hubRoot(prefix);
  const reasons: string[] = [];

  for (const probe of [root, `${root}/x123`]) {
    const requirement = getAdminRouteRequirement(probe, "GET");
    if (requirement?.area !== "overview") {
      reasons.push(`${probe} resolves to the ${requirement?.area} area, not the catch-all`);
    }
    if (isAnyAdminAdmissionPath(probe)) reasons.push(`${probe} is an any-admin path`);
    if (isConsolidatedFeesPath(probe)) reasons.push(`${probe} takes the fee console's rule`);
    if (isRoomsBedsPath(probe)) reasons.push(`${probe} takes the Rooms & Beds rule`);
    const flags = getRequiredFeaturesForPath(probe);
    if (flags.length > 0) reasons.push(`${probe} needs the module(s) ${flags.join(", ")}`);
  }

  const foreign = (path: string) => nestsUnder(path, root) && !owned.rules.includes(path);
  for (const mapPrefix of sources.routeMapPrefixes) {
    if (foreign(mapPrefix)) reasons.push(`the route-map prefix ${mapPrefix} sits under it`);
  }
  for (const { path: gated, label } of sources.gatedPaths) {
    if (foreign(gated)) reasons.push(`${gated} (${label}) sits under it`);
  }
  for (const special of sources.specialPaths) {
    if (foreign(special)) reasons.push(`the special path ${special} sits under it`);
  }
  for (const page of sources.pagePaths) {
    if (nestsUnder(page, root) && !owned.pages.includes(page)) {
      reasons.push(`the existing page ${page} sits under it`);
    }
  }
  return reasons;
}

describe("the hub prefix census", () => {
  it("passes every hub's prefix", () => {
    const collisions = ADMIN_HUBS.flatMap((hub) =>
      hubPrefixCollisions(hub.prefix, ownedBy(hub.key)).map(
        (reason) => `${hub.key} (/admin/${hub.prefix}): ${reason}`,
      ),
    );
    expect(collisions).toEqual([]);
  });

  it("reads a non-empty route map", () => {
    expect(TODAYS_SOURCES.routeMapPrefixes).toContain("/admin/bookings");
    expect(Object.isFrozen(ADMIN_ROUTE_MAP)).toBe(true);
  });

  it("finds the rules C2 generates beneath each hub, and owns only those", () => {
    // Non-vacuous: every hub's generated rules really do sit under its root and
    // would otherwise be reported, so `owned.rules` is doing the excluding.
    for (const hub of ADMIN_HUBS) {
      const rules = adminHubOwnedPaths(hub.key);
      expect(rules.length, hub.key).toBeGreaterThan(0);
      expect(rules.filter((rule) => !nestsUnder(rule, hubRoot(hub.prefix))), hub.key).toEqual([]);
    }
    expect(hubPrefixCollisions("finance").join("\n")).toMatch(
      /the route-map prefix \/admin\/finance\/payments sits under it/,
    );
    expect(hubPrefixCollisions("finance", ownedBy("finance"))).toEqual([]);
  });

  it.each([
    ["lodge", /kiosk/],
    ["fees", /fee console/],
    ["bookings", /bookings area/],
    ["members", /membership area/],
    ["setup", /support area/],
    ["xero", /xeroIntegration/],
  ])("rejects /admin/%s", (prefix, reason) => {
    const reasons = hubPrefixCollisions(prefix);
    expect(reasons.join("\n")).toMatch(reason);
  });

  it("lets Home own its dashboard, which is both a page and a rule at its root", () => {
    // `/admin/dashboard` resolves to `overview` whether through its own rule or
    // the catch-all, so no probe catches it; Home may use the prefix only
    // because the dashboard is its landing page and the rule is generated from it.
    expect(hubPrefixCollisions("dashboard")).toEqual([
      "the route-map prefix /admin/dashboard sits under it",
      "the existing page /admin/dashboard sits under it",
    ]);
    expect(hubPrefixCollisions("dashboard", ownedBy("dashboard"))).toEqual([]);
  });

  it("lets a hub own the pages that have moved under it, and no others", () => {
    const pages = ADMIN_PAGES.map((page) =>
      page.id === "payments" ? { ...page, moved: true } : page,
    );
    const moved = pages.find((page) => page.id === "payments")!;
    const sources = { ...TODAYS_SOURCES, pagePaths: [...ON_DISK_PAGE_PATHS, moved.hubPath] };
    expect(ownedPagePaths("finance", pages)).toEqual([moved.hubPath]);
    expect(hubPrefixCollisions("finance", ownedBy("finance", pages), sources)).toEqual([]);
    // Unmoved in the registry, so the file under the hub is not the hub's.
    expect(hubPrefixCollisions("finance", ownedBy("finance"), sources)).toEqual([
      `the existing page ${moved.hubPath} sits under it`,
    ]);
  });

  /**
   * A rule that sits only BELOW the root, where a probe of the root cannot see
   * it. Today's tree has no such case, so each source is given one.
   */
  it.each([
    [
      "route map",
      { routeMapPrefixes: [...TODAYS_SOURCES.routeMapPrefixes, "/admin/zz-hub/child"] },
      "the route-map prefix /admin/zz-hub/child sits under it",
    ],
    [
      "module gates",
      {
        gatedPaths: [...TODAYS_SOURCES.gatedPaths, { path: "/admin/zz-hub/child", label: "kiosk prefix" }],
      },
      "/admin/zz-hub/child (kiosk prefix) sits under it",
    ],
    [
      "special rules",
      { specialPaths: [...TODAYS_SOURCES.specialPaths, "/admin/zz-hub/child"] },
      "the special path /admin/zz-hub/child sits under it",
    ],
    [
      "page tree",
      { pagePaths: [...ON_DISK_PAGE_PATHS, "/admin/zz-hub/child"] },
      "the existing page /admin/zz-hub/child sits under it",
    ],
  ])("rejects a prefix whose only collision is nested in the %s", (_source, override, reason) => {
    expect(hubPrefixCollisions("zz-hub")).toEqual([]);
    expect(hubPrefixCollisions("zz-hub", NOTHING_OWNED, { ...TODAYS_SOURCES, ...override })).toEqual([reason]);
  });
});

describe("the entries' shape", () => {
  it("puts every hub path under its own hub's prefix, keeping the old relative path", () => {
    const drift = ADMIN_HUBS.flatMap((hub) =>
      ADMIN_PAGES.filter((page) => page.hub === hub.key).flatMap((page) => {
        const root = hubRoot(hub.prefix);
        const expected =
          page.hubPath === root
            ? root
            : `${root}${page.oldPath.slice("/admin".length)}`;
        return nestsUnder(page.hubPath, root) && page.hubPath === expected
          ? []
          : [`${page.id}: ${page.hubPath}`];
      }),
    );
    expect(drift).toEqual([]);
  });

  it("lets only Home's dashboard be a hub root; every other root is left for C13's landing page", () => {
    const roots = ADMIN_PAGES.filter((page) =>
      ADMIN_HUBS.some((hub) => page.hubPath === hubRoot(hub.prefix)),
    ).map((page) => page.id);
    expect(roots).toEqual(["dashboard"]);
  });

  it("has moved the Website hub, and nothing else (C4 #4801)", () => {
    expect(
      ADMIN_PAGES.filter((page) => page.moved)
        .map((page) => page.id)
        .sort(),
    ).toEqual([
      "appearance",
      "club-identity",
      "image-manager",
      "mountain-conditions",
      "page-content",
      "site-banners",
      "site-content",
      "site-style",
    ]);
    expect(new Set(ADMIN_PAGES.filter((page) => page.moved).map((page) => page.hub))).toEqual(
      new Set(["website"]),
    );
  });

  /**
   * A directory move carries everything beneath it, whichever hub those pages
   * belong to: `/admin/setup` holds pages of Settings, Rules, Members and
   * System. So no page may be moved while a page under its old path is not.
   */
  function movedOverUnmoved(pages: readonly AdminHubPage[]): string[] {
    return pages
      .filter((page) => page.moved)
      .flatMap((page) =>
        pages
          .filter(
            (other) =>
              !other.moved &&
              other.oldPath !== page.oldPath &&
              nestsUnder(other.oldPath, page.oldPath),
          )
          .map((other) => `${page.id} is moved but ${other.id} beneath it is not`),
      );
  }

  it("moves no page while a page beneath it, in any hub, stays", () => {
    expect(movedOverUnmoved(ADMIN_PAGES)).toEqual([]);
  });

  it("lets setup move with its own hub, now that it holds no other hub's page", () => {
    // Until S1 (#4796) retired setup/booking-rules, setup/cancellation and
    // setup/integrations, those three (Rules, Members, System) held setup back.
    expect(
      ADMIN_PAGES.filter((page) => page.oldPath.startsWith("/admin/setup/") && page.hub !== "settings")
        .map((page) => page.id),
    ).toEqual([]);
    const settingsOnly = ADMIN_PAGES.map((page) => ({
      ...page,
      moved: page.hub === "settings",
    }));
    expect(movedOverUnmoved(settingsOnly)).toEqual([]);
    // The guard still bites: setup moved, setup/finance left behind.
    const halfMoved = settingsOnly.map((page) =>
      page.id === "setup-finance" ? { ...page, moved: false } : page,
    );
    expect(movedOverUnmoved(halfMoved)).toEqual([
      "setup is moved but setup-finance beneath it is not",
    ]);
  });

  it("moves the pages of one hub that share a directory together", () => {
    // A move is a `git mv` of the top-level directory, so its pages cannot be
    // half moved — and a static sibling must never be left behind for a moved
    // dynamic one (`/notices/new` beside `/notices/[id]`) to claim.
    const drift = ADMIN_PAGES.flatMap((page) =>
      ADMIN_PAGES.filter(
        (other) =>
          other.hub === page.hub &&
          other.oldPath.split("/")[2] === page.oldPath.split("/")[2] &&
          other.moved !== page.moved,
      ).map((other) => `${page.id} and ${other.id}`),
    );
    expect(drift).toEqual([]);
  });

  it("uses only plain [name] dynamic segments", () => {
    const odd = ADMIN_PAGES.filter((page) =>
      page.oldPath
        .split("/")
        .some((segment) => segment.startsWith("[") && !/^\[[A-Za-z][A-Za-z0-9]*\]$/.test(segment)),
    ).map((page) => page.oldPath);
    expect(odd).toEqual([]);
  });
});

describe("which pages are menu and palette destinations", () => {
  /**
   * A stub is a `page.tsx` that calls `redirect()` and never returns anything
   * to render, read from the file itself so the classification cannot drift.
   */
  function isRedirectStub(page: AdminHubPage): boolean {
    const file = PAGE_FILE_BY_PATH.get(diskPath(page));
    if (!file) throw new Error(`${page.id}: no page.tsx at ${diskPath(page)}`);
    const source = stripComments(fs.readFileSync(path.join(process.cwd(), file), "utf8"));
    return /\b(?:permanentRedirect|redirect)\(/.test(source) && !/\breturn\b/.test(source);
  }

  it("classifies every page from its path and its file", () => {
    const drift = ADMIN_PAGES.flatMap((page) => {
      const expected = page.oldPath.startsWith("/admin/testing/")
        ? "test"
        : isRedirectStub(page)
          ? "stub"
          : page.oldPath.endsWith("/print")
            ? "print"
            : /\[[^\]/]+\]/.test(page.oldPath)
              ? "detail"
              : "page";
      return expected === page.kind ? [] : [`${page.id}: registry ${page.kind}, expected ${expected}`];
    });
    expect(drift).toEqual([]);
  });

  it("offers no page with a [param] in its path", () => {
    expect(
      ADMIN_PAGES.filter(
        (page) => isAdminMenuDestination(page) && page.oldPath.includes("["),
      ).map((page) => page.id),
    ).toEqual([]);
  });

  it("finds the four redirect stubs and the test probe", () => {
    expect(
      ADMIN_PAGES.filter((page) => page.kind === "stub").map((page) => page.id).sort(),
    ).toEqual(["booking-approvals", "booking-change-requests", "display-settings", "fee-configuration"]);
    expect(
      ADMIN_PAGES.filter((page) => page.kind === "test").map((page) => page.id),
    ).toEqual(["testing-route-error"]);
    expect(ADMIN_PAGES.filter((page) => !isAdminMenuDestination(page))).toHaveLength(16);
  });
});

describe("adminHref", () => {
  it("is off today", () => {
    expect(ADMIN_HUBS_LIVE).toBe(false);
  });

  it("links every page at its old path today", () => {
    expect(adminHref("payments")).toBe("/admin/payments");
    expect(adminHref("dashboard")).toBe("/admin/dashboard");
    expect(adminHref("member-merge", { id: "m 1/2" })).toBe("/admin/members/m%201%2F2/merge");
    expect(
      adminHref("xero-record", { localModel: "Booking", localId: "b1" }),
    ).toBe("/admin/xero/records/Booking/b1");
    for (const page of ADMIN_PAGES) {
      expect(resolveAdminHref(page, ADMIN_HUBS_LIVE, { id: "x", date: "x", localModel: "x", localId: "x" }))
        .toBe(concrete(page.oldPath).replaceAll("x123", "x"));
    }
  });

  it("links the hub path only when the switch is on AND the page has moved", () => {
    const page = ADMIN_PAGES.find((candidate) => candidate.id === "member-detail")!;
    const moved = { ...page, moved: true };
    expect(resolveAdminHref(page, true, { id: "a" })).toBe("/admin/members/a");
    expect(resolveAdminHref(moved, false, { id: "a" })).toBe("/admin/members/a");
    expect(resolveAdminHref(moved, true, { id: "a" })).toBe("/admin/membership/members/a");
  });

  it("refuses an unknown id and a missing parameter", () => {
    // @ts-expect-error -- not a registered page id
    expect(() => adminHref("no-such-page")).toThrow(/unknown admin page/);
    // @ts-expect-error -- a dynamic page needs its parameters
    expect(() => adminHref("member-detail")).toThrow(/missing the "id" parameter/);
  });
});

// ---------------------------------------------------------------------------
// Merged pages (S1 #4796): tabs, anchors and the retired pages.
// ---------------------------------------------------------------------------

describe("tabs and anchors", () => {
  it("links a tab, the default one without a query, and a section", () => {
    expect(adminTabHref("family-groups", "suggestions")).toBe("/admin/family-groups?tab=suggestions");
    expect(adminTabHref("family-groups", "groups")).toBe("/admin/family-groups");
    expect(adminTabHref("membership-cancellations", "settings")).toBe(
      "/admin/membership-cancellations?tab=settings",
    );
    expect(adminAnchorHref("health", "integration-readiness")).toBe(
      "/admin/health#integration-readiness",
    );
  });

  it("reads a tab, falling back to the first for anything it does not declare", () => {
    expect(parseAdminPageTab("family-groups", "suggestions")).toBe("suggestions");
    expect(parseAdminPageTab("family-groups", null)).toBe("groups");
    expect(parseAdminPageTab("family-groups", "settings")).toBe("groups");
    expect(parseAdminPageTab("membership-cancellations", "settings")).toBe("settings");
    expect(parseAdminPageTab("membership-cancellations", "")).toBe("requests");
  });

  it("refuses a tab or an anchor the page does not declare", () => {
    // @ts-expect-error -- not one of family-groups' tabs
    expect(() => adminTabHref("family-groups", "settings")).toThrow(/no "settings" tab/);
    // @ts-expect-error -- payments declares no tabs
    expect(() => adminTabHref("payments", "x")).toThrow(/no "x" tab/);
    // @ts-expect-error -- not one of health's anchors
    expect(() => adminAnchorHref("health", "nowhere")).toThrow(/no "nowhere" anchor/);
  });

  it("names tabs and anchors only on the pages that hold a merged page", () => {
    expect(
      ADMIN_PAGES.filter((page) => page.tabs.length > 0 || page.anchors.length > 0)
        .map((page) => [page.id, [...page.tabs], [...page.anchors]]),
    ).toEqual([
      ["membership-cancellations", ["requests", "settings"], []],
      ["family-groups", ["groups", "suggestions"], []],
      ["health", [], ["integration-readiness"]],
    ]);
  });

  /** The page's own file, and everything beside it in its directory's `_components`. */
  function pageSources(page: AdminHubPage): string {
    const file = PAGE_FILE_BY_PATH.get(diskPath(page))!;
    const dir = path.join(process.cwd(), path.dirname(file));
    const components = path.join(dir, "_components");
    const besides = fs.existsSync(components)
      ? fs.readdirSync(components)
          .filter((name) => /\.tsx?$/.test(name))
          .map((name) => path.join(components, name))
      : [];
    return [path.join(dir, path.basename(file)), ...besides]
      .map((abs) => stripComments(fs.readFileSync(abs, "utf8")))
      .join("\n");
  }

  it("has each tabbed page render the shared tab shell for itself, with every tab", () => {
    // `AdminPageTabs` reads `?tab=` through `parseAdminPageTab`; the tabs a page
    // hands it are typed against the registry, but only this sees a tab left out.
    const drift = ADMIN_PAGES.filter((page) => page.tabs.length > 0).flatMap((page) => {
      const source = pageSources(page).replace(/\s+/g, " ");
      return [
        ...(source.includes(`<AdminPageTabs page="${page.id}"`) ? [] : [`${page.id}: no AdminPageTabs`]),
        ...page.tabs
          .filter((tab) => !source.includes(`{ value: "${tab}",`))
          .map((tab) => `${page.id}: no "${tab}" tab`),
      ];
    });
    expect(drift).toEqual([]);
  });

  it("has each anchored page render every anchor as an element id", () => {
    const drift = ADMIN_PAGES.flatMap((page) =>
      page.anchors
        .filter((anchor) => !pageSources(page).includes(`"${anchor}"`))
        .map((anchor) => `${page.id}: no "${anchor}"`),
    );
    expect(drift).toEqual([]);
  });
});

describe("retired pages", () => {
  it("are the five merges the owner approved on #4468", () => {
    expect(
      ADMIN_RETIRED_PAGES.map(({ oldPath, mergedInto, tab, anchor }) => ({
        oldPath,
        mergedInto,
        tab,
        anchor,
      })),
    ).toEqual([
      { oldPath: "/admin/family-suggestions", mergedInto: "family-groups", tab: "suggestions", anchor: undefined },
      { oldPath: "/admin/membership-cancellation", mergedInto: "membership-cancellations", tab: "settings", anchor: undefined },
      { oldPath: "/admin/setup/cancellation", mergedInto: "membership-cancellations", tab: "settings", anchor: undefined },
      { oldPath: "/admin/setup/booking-rules", mergedInto: "bookings-setup", tab: undefined, anchor: undefined },
      { oldPath: "/admin/setup/integrations", mergedInto: "health", tab: undefined, anchor: "integration-readiness" },
    ]);
  });

  it("have no page left on disk, at or beneath their old path", () => {
    const left = ADMIN_RETIRED_PAGES.flatMap((retired) =>
      ON_DISK_PAGE_PATHS.filter((page) => nestsUnder(page, retired.oldPath)).map(
        (page) => `${retired.oldPath}: ${page}`,
      ),
    );
    expect(left).toEqual([]);
  });

  it("are merged into a page with its tab or anchor, and used by no registered page", () => {
    const drift = ADMIN_RETIRED_PAGES.flatMap((retired) => {
      const target = ADMIN_PAGES.find((page) => page.id === retired.mergedInto);
      if (!target) return [`${retired.oldPath}: no page ${retired.mergedInto}`];
      return [
        ...(retired.tab === undefined || target.tabs.includes(retired.tab)
          ? []
          : [`${retired.oldPath}: ${target.id} has no tab ${retired.tab}`]),
        ...(retired.anchor === undefined || target.anchors.includes(retired.anchor)
          ? []
          : [`${retired.oldPath}: ${target.id} has no anchor ${retired.anchor}`]),
        ...ADMIN_PAGES.filter((page) =>
          [page.oldPath, page.hubPath].some((p) => nestsUnder(p, retired.oldPath)),
        ).map((page) => `${retired.oldPath}: still ${page.id}'s path`),
      ];
    });
    expect(drift).toEqual([]);
  });

  it("refuse a dynamic path, a path a page still uses, and an unknown destination", () => {
    const base: AdminRetiredPage = {
      oldPath: "/admin/zz-retired",
      label: "Retired",
      mergedInto: "payments",
    };
    expect(() => buildAdminUrlRules(false, ADMIN_PAGES, [base])).not.toThrow();
    expect(() =>
      buildAdminUrlRules(false, ADMIN_PAGES, [{ ...base, oldPath: "/admin/zz-retired/[id]" }]),
    ).toThrow(/is dynamic/);
    expect(() =>
      buildAdminUrlRules(false, ADMIN_PAGES, [{ ...base, oldPath: "/admin/payments" }]),
    ).toThrow(/still payments's path/);
    // A page beneath it would be redirected away too.
    expect(() =>
      buildAdminUrlRules(false, ADMIN_PAGES, [{ ...base, oldPath: "/admin/members" }]),
    ).toThrow(/still members's path/);
    expect(() =>
      buildAdminUrlRules(false, ADMIN_PAGES, [{ ...base, mergedInto: "no-such-page" }]),
    ).toThrow(/unknown no-such-page/);
    expect(() =>
      buildAdminUrlRules(false, ADMIN_PAGES, [{ ...base, tab: "settings" }]),
    ).toThrow(/payments has no "settings" tab/);
  });

  it("are redirected ahead of a moved page whose pattern would claim them", async () => {
    // A retired static path beside a moved dynamic page: once live, the moved
    // page's `/admin/zz/:id` redirect matches `/admin/zz/old` too, so the
    // retired rule must come first to win.
    const zz: AdminHubPage = {
      id: "zz-detail",
      label: "ZZ",
      hub: "finance",
      oldPath: "/admin/zz/[id]",
      hubPath: "/admin/finance/zz/[id]",
      area: "finance",
      admission: "area",
      flags: [],
      kind: "detail",
      fullAdminOnly: false,
      tabs: [],
      anchors: [],
      moved: true,
    };
    const payments = ADMIN_PAGES.find((page) => page.id === "payments")!;
    const retired: AdminRetiredPage = { oldPath: "/admin/zz/old", label: "Old", mergedInto: "payments" };
    const rules = buildAdminUrlRules(true, [payments, zz], [retired]);
    await expect(resolveThrough(rules, "/admin/zz/old")).resolves.toEqual({
      kind: "redirect",
      status: 307,
      url: "/admin/payments",
    });
    await expect(resolveThrough(rules, "/admin/zz/x1")).resolves.toEqual({
      kind: "redirect",
      status: 307,
      url: "/admin/finance/zz/x1",
    });
  });

  it.each([false, true])(
    "each redirects once, temporarily for now, to its tab, query kept (live=%s)",
    async (live) => {
      await expect(walkRegistry(ADMIN_PAGES, live)).resolves.toEqual([]);
    },
  );

  it.each([false, true])(
    "each goes straight to its destination's hub path once that page has moved (live=%s)",
    async (live) => {
      const targets = new Set<string>(ADMIN_RETIRED_PAGES.map((retired) => retired.mergedInto));
      const pages = ADMIN_PAGES.map((page) => ({ ...page, moved: targets.has(page.id) }));
      await expect(walkRegistry(pages, live)).resolves.toEqual([]);
      const destinations = buildAdminUrlRules(live, pages)
        .redirects.filter((rule) => ADMIN_RETIRED_PAGES.some((retired) => retired.oldPath === rule.source))
        .map((rule) => rule.destination);
      expect(destinations).toContain(
        live ? "/admin/membership/family-groups?tab=suggestions" : "/admin/family-groups?tab=suggestions",
      );
      expect(destinations).toContain(
        live ? "/admin/system/health#integration-readiness" : "/admin/health#integration-readiness",
      );
    },
  );

  /**
   * No dead links: no source file names a retired URL, comments aside. The
   * registry's retired list and the suites that prove its redirects are the
   * only places that may, and say why.
   */
  it("are linked from nowhere in the code", () => {
    const ALLOWED: Record<string, string> = {
      "src/lib/admin-hubs/retired.ts": "the retired list itself",
      "src/lib/__tests__/admin-hubs-registry.test.ts": "this suite",
      "src/lib/__tests__/next-config-admin-hub-urls.test.ts": "the redirects through the real config",
      "src/lib/__tests__/admin-route-area-matrix.test.ts": "the retired pages' former areas",
      "src/lib/__tests__/admin-hub-route-parity.test.ts": "main's oracle, verbatim",
    };
    const retiredPattern = new RegExp(
      `(?<![\\w/-])(?:${ADMIN_RETIRED_PAGES.map((retired) =>
        retired.oldPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      ).join("|")})(?![\\w-])`,
    );
    // Non-vacuous: the pattern sees a retired URL, and not the API that shares a name.
    expect(retiredPattern.test(`href: "/admin/family-suggestions"`)).toBe(true);
    expect(retiredPattern.test(`fetch("/admin/setup/booking-rules?x=1")`)).toBe(true);
    expect(retiredPattern.test(`fetch("/api/admin/family-suggestions")`)).toBe(false);
    expect(retiredPattern.test(`"/admin/membership-cancellations"`)).toBe(false);

    const SOURCE_FILE = /\.(?:ts|tsx|mts|js|mjs)$/;
    const walk = (dir: string): string[] => {
      const abs = path.join(process.cwd(), dir);
      if (!fs.existsSync(abs)) return [];
      return fs.readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          return entry.name === "node_modules" || entry.name.startsWith(".") ? [] : walk(rel);
        }
        return SOURCE_FILE.test(entry.name) ? [rel] : [];
      });
    };
    const files = ["src", "e2e", "scripts"].flatMap(walk);
    expect(files.length).toBeGreaterThan(1000);
    const linking = files.filter(
      (file) =>
        !(file in ALLOWED) &&
        retiredPattern.test(stripComments(fs.readFileSync(path.join(process.cwd(), file), "utf8"))),
    );
    expect(linking).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// URL rules, resolved through Next's own config pipeline: the real
// `loadCustomRoutes()` (which refuses a rule Next would refuse) and the real
// path matching and destination substitution.
// ---------------------------------------------------------------------------

type Outcome =
  | { kind: "redirect"; status: number; url: string }
  | { kind: "rewrite"; url: string }
  | { kind: "none" };

async function resolveThrough(
  rules: AdminUrlRules,
  url: string,
  only: "all" | "rewrites" = "all",
): Promise<Outcome> {
  const nextConfig: NextConfig = {
    redirects: async () => (only === "all" ? rules.redirects : []),
    rewrites: async () => ({
      beforeFiles: rules.rewrites.beforeFiles,
      afterFiles: [],
      fallback: [],
    }),
  };
  const response = await unstable_getResponseFromNextConfig({
    url: `https://example.org${url}`,
    nextConfig,
  });
  const redirect = getRedirectUrl(response);
  if (redirect) {
    return { kind: "redirect", status: response.status, url: canonicalUrl(redirect) };
  }
  if (isRewrite(response)) {
    return { kind: "rewrite", url: canonicalUrl(getRewrittenUrl(response)!) };
  }
  return { kind: "none" };
}

/**
 * Path plus query, the query re-serialised. Both sides of every comparison
 * below go through it (`INV-SSOT-002`): the testing util re-encodes a query
 * (`%20` comes back as `+`), which is the same query, not a lost one.
 */
function canonicalUrl(url: string): string {
  const parsed = new URL(url, "https://example.org");
  const search = new URLSearchParams(parsed.search).toString();
  return search ? `${parsed.pathname}?${search}` : parsed.pathname;
}

const QUERY = "?tab=approvals&q=a%20b";

/**
 * Walks one page's URLs through the rules, the way a browser and Next would:
 * follow a redirect once, then apply rewrites. Fails on a chain (a redirect to
 * a redirect), a loop, a rewrite that is rewritten again, a lost query, or a
 * page ending up served from the wrong file.
 */
async function walkPage(rules: AdminUrlRules, page: AdminHubPage, live: boolean) {
  const oldUrl = concrete(page.oldPath);
  const hubUrl = concrete(page.hubPath);
  const problems: string[] = [];
  const expectOutcome = (label: string, actual: Outcome, expected: Outcome) => {
    if (expected.kind !== "none") {
      expected = { ...expected, url: canonicalUrl(expected.url) };
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(`${page.id} ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    }
  };

  // Not moved, or nowhere to move to (Home's dashboard is its hub's root).
  if (!page.moved || hubUrl === oldUrl) {
    expectOutcome("old URL", await resolveThrough(rules, oldUrl + QUERY), { kind: "none" });
    if (hubUrl !== oldUrl) {
      expectOutcome("hub URL", await resolveThrough(rules, hubUrl + QUERY), { kind: "none" });
    }
    return problems;
  }

  if (live) {
    expectOutcome("old URL", await resolveThrough(rules, oldUrl + QUERY), {
      kind: "redirect",
      status: 307,
      url: hubUrl + QUERY,
    });
    expectOutcome("hub URL", await resolveThrough(rules, hubUrl + QUERY), { kind: "none" });
    return problems;
  }

  // Off: the hub URL bounces to the old URL once, and the old URL is served
  // from the moved file without a second redirect.
  expectOutcome("hub URL", await resolveThrough(rules, hubUrl + QUERY), {
    kind: "redirect",
    status: 307,
    url: oldUrl + QUERY,
  });
  expectOutcome("old URL", await resolveThrough(rules, oldUrl + QUERY), {
    kind: "rewrite",
    url: hubUrl + QUERY,
  });
  // `beforeFiles` keeps applying later rules to a rewritten path, so the
  // rewritten URL must match no rewrite of its own.
  expectOutcome(
    "rewritten URL",
    await resolveThrough(rules, hubUrl + QUERY, "rewrites"),
    { kind: "none" },
  );
  return problems;
}

/**
 * Walks one retired page's URL through the rules: one redirect (a 307 until
 * the release after S1, see `AdminUrlRedirect`),
 * straight to where its destination is SERVED in this state (the old path,
 * rewritten to the moved file, while off; the hub path once on), at its tab
 * and section, the request's query kept and its `tab` overridden; and the
 * destination is then not redirected again.
 *
 * The testing util writes a destination's fragment BEFORE the query it
 * appends (`${newUrl}?${search}`); Next's server writes them in order
 * (`next-config-admin-hub-urls.test.ts` replays its steps). So a query found
 * inside the fragment is read back as the query.
 */
async function walkRetired(
  rules: AdminUrlRules,
  retired: AdminRetiredPage,
  pages: readonly AdminHubPage[],
  live: boolean,
) {
  const target = pages.find((page) => page.id === retired.mergedInto)!;
  const served = concrete(live && target.moved ? target.hubPath : target.oldPath);
  const query = new URLSearchParams(QUERY);
  if (retired.tab !== undefined) query.set("tab", retired.tab);
  const expected = {
    status: 307,
    url: canonicalUrl(`${served}?${query}`),
    hash: retired.anchor === undefined ? "" : `#${retired.anchor}`,
  };

  const response = await unstable_getResponseFromNextConfig({
    url: `https://example.org${retired.oldPath}${QUERY}`,
    nextConfig: {
      redirects: async () => rules.redirects,
      rewrites: async () => ({ beforeFiles: rules.rewrites.beforeFiles, afterFiles: [], fallback: [] }),
    },
  });
  const location = getRedirectUrl(response);
  const problems: string[] = [];
  if (!location) return [`${retired.oldPath}: not redirected`];
  const parsed = new URL(location, "https://example.org");
  const [hash, misplaced = ""] = parsed.hash.split("?");
  const search = [parsed.search.slice(1), misplaced].filter(Boolean).join("&");
  const actual = {
    status: response.status,
    url: canonicalUrl(`${parsed.pathname}${search ? `?${search}` : ""}`),
    hash: hash ?? "",
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    problems.push(`${retired.oldPath}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
  const next = await resolveThrough(rules, actual.url);
  if (next.kind === "redirect") problems.push(`${retired.oldPath}: a chain, on to ${next.url}`);
  return problems;
}

async function walkRegistry(
  pages: readonly AdminHubPage[],
  live: boolean,
  retiredPages: readonly AdminRetiredPage[] = ADMIN_RETIRED_PAGES,
) {
  const rules = buildAdminUrlRules(live, pages, retiredPages);
  const problems: string[] = [];
  for (const page of pages) problems.push(...(await walkPage(rules, page, live)));
  for (const retired of retiredPages) {
    problems.push(...(await walkRetired(rules, retired, pages, live)));
  }
  return problems;
}

describe("buildAdminUrlRules", () => {
  it("returns only the retired pages' redirects for today's registry, in either state", () => {
    // No page has moved, so every destination is served at its old path either way.
    const retired = {
      redirects: [
        {
          source: "/admin/family-suggestions",
          destination: "/admin/family-groups?tab=suggestions",
          permanent: false,
        },
        {
          source: "/admin/membership-cancellation",
          destination: "/admin/membership-cancellations?tab=settings",
          permanent: false,
        },
        {
          source: "/admin/setup/cancellation",
          destination: "/admin/membership-cancellations?tab=settings",
          permanent: false,
        },
        {
          source: "/admin/setup/booking-rules",
          destination: "/admin/bookings-setup",
          permanent: false,
        },
        {
          source: "/admin/setup/integrations",
          destination: "/admin/health#integration-readiness",
          permanent: false,
        },
      ],
      rewrites: { beforeFiles: [] },
    };
    expect(buildAdminUrlRules(false)).toEqual(retired);
    expect(buildAdminUrlRules(true)).toEqual(retired);
    expect(buildAdminUrlRules(false, ADMIN_PAGES, [])).toEqual({
      redirects: [],
      rewrites: { beforeFiles: [] },
    });
  });

  const synthetic: AdminHubPage = {
    id: "synthetic",
    label: "Synthetic",
    hub: "synthetic-hub",
    oldPath: "/admin/synthetic/[id]",
    hubPath: "/admin/synthetic-hub/synthetic/[id]",
    area: "support",
    admission: "area",
    flags: [],
    kind: "detail",
    fullAdminOnly: false,
    tabs: [],
    anchors: [],
    moved: true,
  };

  it("builds a moved page's rules in each state", () => {
    expect(buildAdminUrlRules(false, [synthetic], [])).toEqual({
      redirects: [
        {
          source: "/admin/synthetic-hub/synthetic/:id",
          destination: "/admin/synthetic/:id",
          permanent: false,
        },
      ],
      rewrites: {
        beforeFiles: [
          { source: "/admin/synthetic/:id", destination: "/admin/synthetic-hub/synthetic/:id" },
        ],
      },
    });
    expect(buildAdminUrlRules(true, [synthetic], [])).toEqual({
      redirects: [
        {
          source: "/admin/synthetic/:id",
          destination: "/admin/synthetic-hub/synthetic/:id",
          permanent: false,
        },
      ],
      rewrites: { beforeFiles: [] },
    });
  });

  it.each([false, true])(
    "resolves a synthetic moved page with no loop or chain, query kept (live=%s)",
    async (live) => {
      await expect(walkRegistry([synthetic], live, [])).resolves.toEqual([]);
    },
  );

  it("never redirects a page whose hub path is its old path", () => {
    const dashboard = ADMIN_PAGES.find((page) => page.id === "dashboard")!;
    const moved = { ...dashboard, moved: true };
    expect(buildAdminUrlRules(true, [moved], []).redirects).toEqual([]);
    expect(buildAdminUrlRules(false, [moved], []).redirects).toEqual([]);
  });

  it.each([false, true])(
    "refuses moving a dynamic page without the static sibling its pattern captures, either way round (live=%s)",
    (live) => {
      const moveOnly = (ids: readonly string[]) =>
        ADMIN_PAGES.map((page) => ({ ...page, moved: ids.includes(page.id) }));
      // `/admin/notices/:id` matches `/admin/notices/new`.
      expect(() => buildAdminUrlRules(live, moveOnly(["notice-detail"]))).toThrow(
        /notice-detail \(\/admin\/notices\/\[id\]\) would capture notice-new/,
      );
      expect(() => buildAdminUrlRules(live, moveOnly(["notice-new"]))).toThrow(
        /would capture notice-new/,
      );
      // Together, or with the list page above them, is fine.
      expect(() =>
        buildAdminUrlRules(live, moveOnly(["notices", "notice-detail", "notice-new"])),
      ).not.toThrow();
      expect(() => buildAdminUrlRules(live, moveOnly(["notices"]))).not.toThrow();
      // A synthetic pair the registry does not have, so the rule is not about notices.
      const pair = [
        { ...synthetic, id: "x-detail", oldPath: "/admin/synthetic/[id]", moved: true },
        {
          ...synthetic,
          id: "x-new",
          oldPath: "/admin/synthetic/new",
          hubPath: "/admin/synthetic-hub/synthetic/new",
          kind: "page" as const,
          moved: false,
        },
      ];
      expect(() => buildAdminUrlRules(live, pair, [])).toThrow(/x-detail .* would capture x-new/);
      expect(() =>
        buildAdminUrlRules(live, pair.map((page) => ({ ...page, moved: true })), []),
      ).not.toThrow();
    },
  );

  it("refuses a catch-all segment rather than guessing its pattern", () => {
    expect(() =>
      buildAdminUrlRules(true, [{ ...synthetic, oldPath: "/admin/synthetic/[...rest]" }], []),
    ).toThrow(/unsupported dynamic segment/);
  });

  it.each([false, true])(
    "resolves the whole registry, every page moved, with no loop or chain (live=%s)",
    async (live) => {
      const allMoved = ADMIN_PAGES.map((page) => ({ ...page, moved: true }));
      await expect(walkRegistry(allMoved, live)).resolves.toEqual([]);
    },
  );

  it.each(ADMIN_HUBS.map((hub) => hub.key))(
    "resolves the registry with only the %s hub moved, in both states",
    async (hubKey) => {
      const oneHubMoved = ADMIN_PAGES.map((page) => ({ ...page, moved: page.hub === hubKey }));
      await expect(walkRegistry(oneHubMoved, false)).resolves.toEqual([]);
      await expect(walkRegistry(oneHubMoved, true)).resolves.toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// Nothing outside the registry imports it but the files named below. Each one
// is a deliberate edit here, so a new reader is reviewed. In production the
// security map reads it (C2 #4799), and the parity census proves what that map
// answers did not change; since C3 (#4800) so do next.config.ts, the sidebar's
// active link and revalidateAdminPage, each unchanged until a page moves.
// ---------------------------------------------------------------------------

describe("the registry is inert", () => {
  const ROOT = process.cwd();
  const REGISTRY_DIR = "src/lib/admin-hubs/";
  /** Every file outside the registry that may import it, and why. */
  const IMPORTERS: Record<string, string> = {
    "src/lib/admin-permissions.ts":
      "C2: the route map's page half, the admission paths and the landing page are generated",
    "src/config/feature-routes.ts": "C2: the admin page module gates are generated",
    "src/lib/__tests__/admin-hubs-registry.test.ts": "this suite",
    "src/lib/__tests__/admin-hub-route-parity.test.ts":
      "C2's census: each page's old and hub path answer as main's hand-written map did",
    "src/lib/__tests__/admin-route-area-matrix.test.ts":
      "the reviewed page -> area pin, one row per registered page",
    "src/lib/__tests__/admin-route-authorization-proof.test.ts":
      "sweeps every page at its old and hub path through the real guards",
    "src/lib/__tests__/admin-route-map-drift.test.ts":
      "enumerates pages from the registry, at both paths",
    "src/lib/__tests__/coverage-matrix-areas.test.ts":
      "takes COVERAGE_MATRIX.md's areas from the registry's old paths",
    "next.config.ts": "C3: the redirects and beforeFiles rewrites are generated",
    "src/components/admin-sidebar.tsx": "C3: the active link is the registry's activeAdminHref",
    "src/lib/admin-page-revalidation.ts": "C3: revalidateAdminPage revalidates a page's file path",
    "src/components/help-widget/help-widget-admin.tsx":
      "C3: admin help reads the pathname through canonicalAdminPathname",
    "src/components/nav-bar.tsx": "C3: the profile return-to uses servedAdminPathname",
    "src/app/(admin)/admin/xero/page.tsx": "C3: currentXeroPath uses servedAdminPathname",
    "src/app/(admin)/admin/xero/_components/operations-panel.tsx":
      "C3: router.replace targets use servedAdminPathname",
    "src/app/(admin)/admin/xero/_components/inbound-events-panel.tsx":
      "C3: router.replace targets use servedAdminPathname",
    "src/lib/__tests__/admin-hubs-active-link.test.ts": "C3: activeAdminHref and its census",
    "src/components/__tests__/admin-sidebar-active-link.test.tsx":
      "C3: the real sidebar over a moved Finance hub",
    "src/lib/__tests__/admin-page-revalidation.test.ts":
      "C3: revalidateAdminPage's targets and the revalidatePath census",
    "src/components/admin/admin-page-tabs.tsx":
      "S1: the tab shell reads and links a page's tabs through the registry",
    "src/components/admin/membership-cancellation-settings-tab.tsx":
      "S1: the Settings tab links Email Messages with adminHref",
    "src/app/(admin)/admin/bookings-setup/page.tsx": "S1: its cards link with adminHref",
    "src/app/(admin)/admin/health/_components/integration-readiness-section.tsx":
      "S1: its cards link with adminHref; its id is the registry's anchor",
    "src/app/(admin)/admin/setup/setup-page-client.tsx":
      "S1: the cards for the merged setup pages link with adminHref",
    "src/app/(admin)/admin/notifications/page.tsx":
      "S1: the cancellation settings card links the Settings tab",
    "src/components/admin/membership-cancellation-blocker-notice.tsx":
      "S1: the settings link is the queue's Settings tab",
    "src/lib/setup-readiness.ts": "S1: the cancellation step links the Settings tab",
    "src/lib/__tests__/next-config-admin-hub-urls.test.ts":
      "S1: walks each retired page's redirect through the real config",
    "src/app/(admin)/layout.tsx": "C4: the site-style banner links with adminHref",
    "src/app/(admin)/admin/website/appearance/page.tsx": "C4: its cards link with adminHref",
    "src/app/(admin)/admin/website/appearance/identity/page.tsx":
      "C4: its back link is adminHref",
    "src/app/(admin)/admin/website/site-style/page.tsx": "C4: its back link is adminHref",
    "src/app/(admin)/admin/website/site-content/page.tsx": "C4: its back link is adminHref",
    "src/app/(admin)/admin/website/site-banners/page.tsx": "C4: its back link is adminHref",
    "src/app/(admin)/admin/website/page-content/page.tsx": "C4: its back link is adminHref",
    "src/app/(admin)/admin/website/image-manager/page.tsx": "C4: its back link is adminHref",
    "src/app/(admin)/admin/website/mountain-conditions/page.tsx":
      "C4: its back link is adminHref",
    "src/app/(admin)/admin/setup/foundations/page.tsx":
      "C4: the Club Identity card links with adminHref",
    "src/app/(admin)/admin/booking-policies/cancellation/page.tsx":
      "C4: the public-pages link is adminHref",
    "src/lib/analytics-settings-shared.ts": "C4: the privacy-policy editor link is adminHref",
  };
  const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
  const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'][^"']*admin-hubs(?:\/[^"']*)?["']/m;

  function sourceFiles(dir: string): string[] {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return [];
    return fs.readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        return entry.name === "node_modules" || entry.name.startsWith(".") ? [] : sourceFiles(rel);
      }
      return SOURCE.test(entry.name) ? [rel] : [];
    });
  }

  it("is imported by no file outside src/lib/admin-hubs/ but the reviewed importers", () => {
    const rootConfigs = fs
      .readdirSync(ROOT)
      .filter((name) => SOURCE.test(name));
    const files = [
      ...rootConfigs,
      ...["src", "scripts", "e2e", "prisma"].flatMap(sourceFiles),
    ];
    expect(files.length).toBeGreaterThan(1000);

    const importers = files.filter(
      (file) =>
        !file.startsWith(REGISTRY_DIR) &&
        IMPORT.test(fs.readFileSync(path.join(ROOT, file), "utf8")),
    );
    // Both directions: an unreviewed importer fails, and so does a stale entry.
    expect(importers.sort()).toEqual(Object.keys(IMPORTERS).sort());
  });

  it("uses only relative imports inside the registry, so next.config.ts can load it", () => {
    const aliased = sourceFiles(REGISTRY_DIR.slice(0, -1)).filter((file) =>
      /from\s*["']@\//.test(fs.readFileSync(path.join(ROOT, file), "utf8")),
    );
    expect(aliased).toEqual([]);
  });
});
