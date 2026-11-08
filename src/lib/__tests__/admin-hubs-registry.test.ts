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
  ADMIN_ROUTE_MAP_PREFIXES,
  ADMIN_PERMISSION_LEVELS,
  ANY_ADMIN_ADMISSION_PATHS,
  CONSOLIDATED_FEES_PATH,
  ROOMS_BEDS_PATH,
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
  adminHref,
  buildAdminUrlRules,
  resolveAdminHref,
  type AdminUrlRules,
} from "@/lib/admin-hubs";
import {
  hubRoot,
  isAdminMenuDestination,
  type AdminHubPage,
} from "@/lib/admin-hubs/define";
import { stripComments } from "@/lib/__tests__/support/strip-comments";

// ---------------------------------------------------------------------------
// The admin hub registry (epic #4468, C1 #4798).
//
// C2 generates the page half of the security map from this registry, so every
// fact it records is checked here against what TODAY's code answers for the
// same path: the page tree on disk, `getAdminRouteRequirement`,
// `canOpenAdminPath`, `getRequiredFeaturesForPath` and the sidebar. The page
// list and its resolver pathnames come from the shared enumeration, so this
// suite measures the tree exactly as the route-map drift guard does
// (`INV-SSOT-004`).
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
 * until then.
 */
function diskPath(page: AdminHubPage): string {
  return page.moved ? page.hubPath : page.oldPath;
}

/**
 * The pathname today's resolvers are asked about. It is always the OLD path,
 * moved or not: until C2 regenerates the route map from this registry, the map
 * knows only old paths, and the off-state rewrite keeps the proxy and the
 * layout guard seeing them. `concrete` uses the shared enumeration's
 * placeholder, which a test below pins.
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
  /** Every prefix in today's route map (`ADMIN_ROUTE_MAP_PREFIXES`). */
  readonly routeMapPrefixes: readonly string[];
  /** Every module-gated path, labelled. */
  readonly gatedPaths: ReadonlyArray<{ readonly path: string; readonly label: string }>;
  /** The paths `canOpenAdminPath` admits by a special rule. */
  readonly specialPaths: readonly string[];
  /** Every `page.tsx` on disk. */
  readonly pagePaths: readonly string[];
}

const TODAYS_SOURCES: PrefixCensusSources = {
  routeMapPrefixes: ADMIN_ROUTE_MAP_PREFIXES,
  gatedPaths: FEATURE_ROUTE_RULES.flatMap((rule) => [
    ...(rule.prefixes ?? []).map((p) => ({ path: p, label: `${rule.flag} prefix` })),
    ...(rule.exemptPaths ?? []).map((p) => ({ path: p, label: `${rule.flag} exemption` })),
  ]),
  specialPaths: [...ANY_ADMIN_ADMISSION_PATHS, CONSOLIDATED_FEES_PATH, ROOMS_BEDS_PATH],
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
 * BELOW it, so both are needed. Once C2 generates route-map and module
 * prefixes from this registry, a moved page's own generated prefixes sit under
 * its hub root by design, and C2 must exclude them here as `owned` does for
 * the page tree.
 */
function hubPrefixCollisions(
  prefix: string,
  owned: readonly string[] = [],
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

  for (const mapPrefix of sources.routeMapPrefixes) {
    if (nestsUnder(mapPrefix, root)) reasons.push(`the route-map prefix ${mapPrefix} sits under it`);
  }
  for (const { path: gated, label } of sources.gatedPaths) {
    if (nestsUnder(gated, root)) reasons.push(`${gated} (${label}) sits under it`);
  }
  for (const special of sources.specialPaths) {
    if (nestsUnder(special, root)) reasons.push(`the special path ${special} sits under it`);
  }
  for (const page of sources.pagePaths) {
    if (nestsUnder(page, root) && !owned.includes(page)) {
      reasons.push(`the existing page ${page} sits under it`);
    }
  }
  return reasons;
}

describe("the hub prefix census", () => {
  it("passes every hub's prefix", () => {
    const collisions = ADMIN_HUBS.flatMap((hub) =>
      hubPrefixCollisions(hub.prefix, ownedPagePaths(hub.key)).map(
        (reason) => `${hub.key} (/admin/${hub.prefix}): ${reason}`,
      ),
    );
    expect(collisions).toEqual([]);
  });

  it("reads a non-empty route map", () => {
    expect(ADMIN_ROUTE_MAP_PREFIXES).toContain("/admin/bookings");
    expect(Object.isFrozen(ADMIN_ROUTE_MAP_PREFIXES)).toBe(true);
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

  it("rejects a prefix that an existing page sits under, even off the route map", () => {
    // `/admin/dashboard` resolves to the catch-all, so only the page tree
    // catches it; Home may use it only because the dashboard is its landing.
    expect(hubPrefixCollisions("dashboard")).toEqual([
      "the existing page /admin/dashboard sits under it",
    ]);
    expect(hubPrefixCollisions("dashboard", ownedPagePaths("dashboard"))).toEqual([]);
  });

  it("lets a hub own the pages that have moved under it, and no others", () => {
    const pages = ADMIN_PAGES.map((page) =>
      page.id === "payments" ? { ...page, moved: true } : page,
    );
    const moved = pages.find((page) => page.id === "payments")!;
    const sources = { ...TODAYS_SOURCES, pagePaths: [...ON_DISK_PAGE_PATHS, moved.hubPath] };
    expect(ownedPagePaths("finance", pages)).toEqual([moved.hubPath]);
    expect(hubPrefixCollisions("finance", ownedPagePaths("finance", pages), sources)).toEqual([]);
    // Unmoved in the registry, so the file under the hub is not the hub's.
    expect(hubPrefixCollisions("finance", ownedPagePaths("finance"), sources)).toEqual([
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
      { routeMapPrefixes: [...ADMIN_ROUTE_MAP_PREFIXES, "/admin/zz-hub/child"] },
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
    expect(hubPrefixCollisions("zz-hub", [], { ...TODAYS_SOURCES, ...override })).toEqual([reason]);
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

  it("has moved no page yet (C4 #4801 makes the first move)", () => {
    expect(ADMIN_PAGES.filter((page) => page.moved).map((page) => page.id)).toEqual([]);
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

  it("refuses moving setup before the other hubs move their setup pages out", () => {
    const settingsOnly = ADMIN_PAGES.map((page) => ({
      ...page,
      moved: page.hub === "settings",
    }));
    expect(movedOverUnmoved(settingsOnly)).toEqual([
      "setup is moved but setup-booking-rules beneath it is not",
      "setup is moved but setup-cancellation beneath it is not",
      "setup is moved but setup-integrations beneath it is not",
    ]);
    const othersFirst = ADMIN_PAGES.map((page) => ({
      ...page,
      moved: page.hub === "settings" || page.oldPath.startsWith("/admin/setup/"),
    }));
    expect(movedOverUnmoved(othersFirst)).toEqual([]);
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

async function walkRegistry(pages: readonly AdminHubPage[], live: boolean) {
  const rules = buildAdminUrlRules(live, pages);
  const problems: string[] = [];
  for (const page of pages) problems.push(...(await walkPage(rules, page, live)));
  return problems;
}

describe("buildAdminUrlRules", () => {
  it("returns nothing for today's registry, in either state", () => {
    const empty = { redirects: [], rewrites: { beforeFiles: [] } };
    expect(buildAdminUrlRules(false)).toEqual(empty);
    expect(buildAdminUrlRules(true)).toEqual(empty);
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
    moved: true,
  };

  it("builds a moved page's rules in each state", () => {
    expect(buildAdminUrlRules(false, [synthetic])).toEqual({
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
    expect(buildAdminUrlRules(true, [synthetic])).toEqual({
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
      await expect(walkRegistry([synthetic], live)).resolves.toEqual([]);
    },
  );

  it("never redirects a page whose hub path is its old path", () => {
    const dashboard = ADMIN_PAGES.find((page) => page.id === "dashboard")!;
    const moved = { ...dashboard, moved: true };
    expect(buildAdminUrlRules(true, [moved]).redirects).toEqual([]);
    expect(buildAdminUrlRules(false, [moved]).redirects).toEqual([]);
  });

  it("refuses a catch-all segment rather than guessing its pattern", () => {
    expect(() =>
      buildAdminUrlRules(true, [{ ...synthetic, oldPath: "/admin/synthetic/[...rest]" }]),
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
// Inert until C2/C3: nothing outside the registry and this suite imports it.
// ---------------------------------------------------------------------------

describe("the registry is inert", () => {
  const ROOT = process.cwd();
  const REGISTRY_DIR = "src/lib/admin-hubs/";
  const THIS_SUITE = "src/lib/__tests__/admin-hubs-registry.test.ts";
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

  it("is imported by no file outside src/lib/admin-hubs/ and this suite", () => {
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
        file !== THIS_SUITE &&
        IMPORT.test(fs.readFileSync(path.join(ROOT, file), "utf8")),
    );
    expect(importers).toEqual([]);
  });

  it("uses only relative imports inside the registry, so next.config.ts can load it", () => {
    const aliased = sourceFiles(REGISTRY_DIR.slice(0, -1)).filter((file) =>
      /from\s*["']@\//.test(fs.readFileSync(path.join(ROOT, file), "utf8")),
    );
    expect(aliased).toEqual([]);
  });
});
