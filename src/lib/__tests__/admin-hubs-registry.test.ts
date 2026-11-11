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
  getAdminPage,
  isInexactAdminPagePath,
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
import { xeroSectionId } from "@/app/(admin)/admin/finance/xero/_components/types";
import { BANK_REFUND_VOIDS_ANCHOR } from "@/components/admin/bank-refund-voids-to-answer-panel";

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
    // C5 (#4802) moved every Finance page, so their files sit under the hub.
    const financeHubPaths = [
      "/admin/finance/payments",
      "/admin/finance/internet-banking",
      "/admin/finance/refund-requests",
      "/admin/finance/subscriptions",
      "/admin/finance/reports",
      "/admin/finance/xero",
      "/admin/finance/xero/member-grouping",
      "/admin/finance/xero/records/[localModel]/[localId]",
      "/admin/finance/xero/setup",
    ];
    expect(ownedPagePaths("finance")).toEqual(financeHubPaths);
    expect(hubPrefixCollisions("finance", ownedBy("finance"))).toEqual([]);
    // Unmoved in the registry, so the file under the hub is not the hub's.
    const pages = ADMIN_PAGES.map((page) =>
      page.id === "payments" ? { ...page, moved: false } : page,
    );
    expect(ownedPagePaths("finance", pages)).toEqual(financeHubPaths.slice(1));
    expect(hubPrefixCollisions("finance", ownedBy("finance", pages))).toEqual([
      "the existing page /admin/finance/payments sits under it",
    ]);
  });

  it("lets the Rules hub own its moved pages and the fee console's rule beneath it (C6 #4803)", () => {
    // C6 moved every Fees & booking rules page under `/admin/rules`. The fee
    // console's bookings-OR-finance rule followed it there, generated from its
    // entry, so it is the hub's own rule and no collision.
    expect(ownedPagePaths("rules")).toEqual([
      "/admin/rules/fees",
      "/admin/rules/fee-configuration",
      "/admin/rules/seasons",
      "/admin/rules/age-tier-settings",
      "/admin/rules/promo-codes",
      "/admin/rules/booking-policies",
      "/admin/rules/booking-policies/adult-member-hosting",
      "/admin/rules/booking-policies/cancellation",
      "/admin/rules/booking-policies/group-discount",
      "/admin/rules/booking-policies/minimum-stay",
      "/admin/rules/booking-policies/periods",
      "/admin/rules/booking-policies/public-requests",
      "/admin/rules/bookings-setup",
    ]);
    expect(TODAYS_SOURCES.specialPaths).toContain("/admin/rules/fees");
    expect(hubPrefixCollisions("rules", ownedBy("rules"))).toEqual([]);
    // Owning nothing, the fee console's rule and its page are both reported.
    const unowned = hubPrefixCollisions("rules").join("\n");
    expect(unowned).toMatch(/the special path \/admin\/rules\/fees sits under it/);
    expect(unowned).toMatch(/the existing page \/admin\/rules\/fees sits under it/);
  });

  it("lets the Help & system hub own its moved pages and the rules generated beneath it (C7 #4804)", () => {
    // C7 moved every Help & system page under `/admin/system`. AI Diagnostics'
    // any-admin admission and the AI pages' module gates followed them there,
    // generated from their entries, so they are the hub's own rules.
    expect(ownedPagePaths("system")).toEqual([
      "/admin/system/health",
      "/admin/system/issue-reports",
      "/admin/system/stuck-states",
      "/admin/system/background-jobs",
      "/admin/system/email-deliverability",
      "/admin/system/audit-log",
      "/admin/system/ai-diagnostics",
      "/admin/system/ai-assistant",
      "/admin/system/backups",
      "/admin/system/backups/setup",
      "/admin/system/testing/route-error",
    ]);
    expect(TODAYS_SOURCES.specialPaths).toContain("/admin/system/ai-diagnostics");
    expect(hubPrefixCollisions("system", ownedBy("system"))).toEqual([]);
    // Owning nothing, the moved pages and the rules generated for them are reported.
    const unowned = hubPrefixCollisions("system").join("\n");
    expect(unowned).toMatch(/the special path \/admin\/system\/ai-diagnostics sits under it/);
    expect(unowned).toMatch(/\/admin\/system\/ai-assistant \([^)]*\) sits under it/);
    expect(unowned).toMatch(/the existing page \/admin\/system\/health sits under it/);
  });

  it("lets the Messages & email hub own its moved pages and the rules generated beneath it (C8 #4805)", () => {
    // C8 moved every Messages & email page under `/admin/messages`. The hub
    // mixes the membership and support areas, so no rule is generated AT its
    // root: each page's area, and the Communications, Member Notices and
    // Message Board module gates, followed it there as a rule of its own.
    expect(ownedPagePaths("messages")).toEqual([
      "/admin/messages/notifications",
      "/admin/messages/communications",
      "/admin/messages/notices",
      "/admin/messages/notices/[id]",
      "/admin/messages/notices/new",
      "/admin/messages/message-board",
      "/admin/messages/email-messages",
      "/admin/messages/booking-messages",
      "/admin/messages/notification-rules",
      "/admin/messages/notification-recipients",
    ]);
    expect(adminHubOwnedPaths("messages")).not.toContain("/admin/messages");
    expect(TODAYS_SOURCES.routeMapPrefixes).not.toContain("/admin/messages");
    expect(hubPrefixCollisions("messages", ownedBy("messages"))).toEqual([]);
    // Owning nothing, the moved pages and the rules generated for them are reported.
    const unowned = hubPrefixCollisions("messages").join("\n");
    expect(unowned).toMatch(/the route-map prefix \/admin\/messages\/notices sits under it/);
    expect(unowned).toMatch(/\/admin\/messages\/communications \([^)]*\) sits under it/);
    expect(unowned).toMatch(/the existing page \/admin\/messages\/notifications sits under it/);
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

  it("has moved the Website, Finance, Fees & booking rules, Help & system and Messages & email hubs, and nothing else (C4 #4801, C5 #4802, C6 #4803, C7 #4804, C8 #4805)", () => {
    expect(
      ADMIN_PAGES.filter((page) => page.moved)
        .map((page) => page.id)
        .sort(),
    ).toEqual([
      "age-tier-settings",
      "ai-assistant",
      "ai-diagnostics",
      "appearance",
      "audit-log",
      "background-jobs",
      "backups",
      "backups-setup",
      "booking-messages",
      "booking-policies",
      "booking-policies-adult-member-hosting",
      "booking-policies-cancellation",
      "booking-policies-group-discount",
      "booking-policies-minimum-stay",
      "booking-policies-periods",
      "booking-policies-public-requests",
      "bookings-setup",
      "club-identity",
      "communications",
      "email-deliverability",
      "email-messages",
      "fee-configuration",
      "fees",
      "health",
      "image-manager",
      "internet-banking",
      "issue-reports",
      "message-board",
      "mountain-conditions",
      "notice-detail",
      "notice-new",
      "notices",
      "notification-recipients",
      "notification-rules",
      "notifications",
      "page-content",
      "payments",
      "promo-codes",
      "refund-requests",
      "reports",
      "seasons",
      "site-banners",
      "site-content",
      "site-style",
      "stuck-states",
      "subscriptions",
      "testing-route-error",
      "xero",
      "xero-member-grouping",
      "xero-record",
      "xero-setup",
    ]);
    expect(new Set(ADMIN_PAGES.filter((page) => page.moved).map((page) => page.hub))).toEqual(
      new Set(["website", "finance", "rules", "messages", "system"]),
    );
    // Each of those hubs moved whole: no page of theirs was left behind.
    expect(
      ADMIN_PAGES.filter((page) => ["website", "finance", "rules", "messages", "system"].includes(page.hub) && !page.moved).map(
        (page) => page.id,
      ),
    ).toEqual([]);
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

  /**
   * Static pages that name their record in the QUERY and cannot open without
   * it, so they are details although no `[param]` says so (S2 #4797). Each is
   * reviewed: the page must show only an error when opened bare, because the
   * command palette would otherwise offer a link that errors.
   */
  const QUERY_DETAIL_PAGES: Readonly<Record<string, string>> = {
    "display-preview": "needs ?templateId= and ?previewLodge=; says so and stops without them",
  };

  it("finds each query-named detail page reading its query", () => {
    for (const id of Object.keys(QUERY_DETAIL_PAGES)) {
      const page = ADMIN_PAGES.find((candidate) => candidate.id === id);
      expect(page, id).toBeDefined();
      const file = PAGE_FILE_BY_PATH.get(diskPath(page!));
      const source = stripComments(fs.readFileSync(path.join(process.cwd(), file!), "utf8"));
      expect(source, id).toMatch(/location\.search|useSearchParams|searchParams/);
    }
  });

  it("classifies every page from its path and its file", () => {
    const drift = ADMIN_PAGES.flatMap((page) => {
      const expected = page.oldPath.startsWith("/admin/testing/")
        ? "test"
        : isRedirectStub(page)
          ? "stub"
          : page.oldPath.endsWith("/print")
            ? "print"
            : /\[[^\]/]+\]/.test(page.oldPath) || page.id in QUERY_DETAIL_PAGES
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
    expect(ADMIN_PAGES.filter((page) => !isAdminMenuDestination(page))).toHaveLength(17);
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

/**
 * A registry path spelled another way at each static segment below `/admin`:
 * `case` capitalises it, `escape` percent-encodes its first character. Dynamic
 * segments are filled with `x123` either way.
 */
function respell(registryPath: string, how: "case" | "escape"): string {
  return registryPath
    .split("/")
    .map((segment, index) => {
      if (index < 2 || segment.startsWith("[")) return segment.startsWith("[") ? "x123" : segment;
      return how === "case"
        ? segment.charAt(0).toUpperCase() + segment.slice(1)
        : `%${segment.charCodeAt(0).toString(16).toUpperCase()}${segment.slice(1)}`;
    })
    .join("/");
}

describe("isInexactAdminPagePath", () => {
  it("passes every page's old and hub path as written, with a query, a trailing slash or a path beneath", () => {
    const refused = ADMIN_PAGES.flatMap((page) =>
      [page.oldPath, page.hubPath].flatMap((registryPath) => {
        const url = concrete(registryPath);
        return [url, `${url}/`, `${url}?tab=x&Q=Y`, `${url}/beneath/More`].filter((candidate) =>
          isInexactAdminPagePath(candidate),
        );
      }),
    );
    expect(refused).toEqual([]);
  });

  it.each(["case", "escape"] as const)(
    "refuses every page's old and hub path respelled by %s, and beneath it",
    (how) => {
      const passed = ADMIN_PAGES.flatMap((page) =>
        [page.oldPath, page.hubPath]
          .filter((registryPath) => registryPath.split("/").length > 2)
          .flatMap((registryPath) => {
            const url = respell(registryPath, how);
            return [url, `${url}/`, `${url}?q=1`, `${url}/beneath`].filter(
              (candidate) => !isInexactAdminPagePath(candidate),
            );
          }),
      );
      expect(passed).toEqual([]);
      expect(respell("/admin/site-style", how)).not.toBe("/admin/site-style");
    },
  );

  it("refuses the whole prefix respelled, and one child below an exact parent", () => {
    for (const url of [
      "/ADMIN/site-style",
      "/Admin/website/site-style",
      "/admin/appearance/Identity",
      "/admin/website/appearance/IDENTITY",
      "/admin/notices/NEW",
    ]) {
      expect(isInexactAdminPagePath(url), url).toBe(true);
    }
  });

  it("lets a dynamic segment carry any value, and leaves paths no page has alone", () => {
    for (const url of [
      "/admin/members/AbC%20D",
      "/admin/members/AbC/merge",
      "/admin/xero/records/Booking/b-1",
      "/admin/lodges/Main-Lodge/setup",
      "/admin/Nope",
      "/admin/payments/Unknown",
      "/finance/Payments",
      "/Dashboard",
      "/",
      "",
    ]) {
      expect(isInexactAdminPagePath(url), url).toBe(false);
    }
  });

  it("still compares a registry whose static segment is not lower case", () => {
    // The lower-case shortcut must not apply to it.
    const weird = { ...ADMIN_PAGES[0]!, oldPath: "/admin/Weird", hubPath: "/admin/zz/Weird" };
    expect(isInexactAdminPagePath("/admin/weird", [weird])).toBe(true);
    expect(isInexactAdminPagePath("/admin/zz/weird", [weird])).toBe(true);
    expect(isInexactAdminPagePath("/admin/Weird", [weird])).toBe(false);
  });

  it("leaves a malformed escape as it is rather than throwing", () => {
    expect(isInexactAdminPagePath("/admin/site-%E0%A4%A")).toBe(false);
    expect(isInexactAdminPagePath("/admin/%E0%A4%A/x")).toBe(false);
  });
});

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
    expect(adminAnchorHref("xero", "xero-section-mappings")).toBe("/admin/xero#xero-section-mappings");
  });

  it("declares Xero's mappings anchor as the id its card is given (C5 #4802)", () => {
    // The card writes `id={xeroSectionId("mappings")}`; the links go through the
    // registry. One spelling, or a renamed section would leave every link short.
    expect(xeroSectionId("mappings")).toBe("xero-section-mappings");
    expect(getAdminPage("xero").anchors).toEqual([xeroSectionId("mappings")]);
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

  it("names tabs and anchors only on the pages that hold a merged page or a linked section", () => {
    expect(
      ADMIN_PAGES.filter((page) => page.tabs.length > 0 || page.anchors.length > 0)
        .map((page) => [page.id, [...page.tabs], [...page.anchors]]),
    ).toEqual([
      ["xero", [], ["xero-section-mappings"]],
      ["membership-cancellations", ["requests", "settings"], []],
      ["family-groups", ["groups", "suggestions"], []],
      ["health", [], ["integration-readiness"]],
      ["stuck-states", [], ["bank-refund-voids"]],
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

  /**
   * An anchor whose element id is minted by a helper, not written out: the
   * expression the page must render instead, pinned equal to the anchor above.
   */
  const MINTED_ANCHORS: Record<string, string> = {
    "xero-section-mappings": 'id={xeroSectionId("mappings")}',
  };

  /**
   * An anchor whose element is a shared component's, outside the page's
   * directory: the page must render the component, and the component must give
   * its element the id through the registry-typed constant pinned below.
   */
  const COMPONENT_ANCHORS: Record<
    string,
    { readonly renders: string; readonly file: string; readonly id: string }
  > = {
    "bank-refund-voids": {
      renders: "<BankRefundVoidsToAnswerPanel",
      file: "src/components/admin/bank-refund-voids-to-answer-panel.tsx",
      id: "id={BANK_REFUND_VOIDS_ANCHOR}",
    },
  };

  /** Why `anchor` is not rendered by `page`, or `null` when it is. */
  function anchorDrift(page: AdminHubPage, anchor: string): string | null {
    const source = pageSources(page);
    const component = COMPONENT_ANCHORS[anchor];
    if (component !== undefined) {
      if (!source.includes(component.renders)) return `${page.id}: no ${component.renders}`;
      const own = stripComments(fs.readFileSync(path.join(process.cwd(), component.file), "utf8"));
      return own.includes(component.id) ? null : `${page.id}: ${component.file} has no ${component.id}`;
    }
    const minted = MINTED_ANCHORS[anchor];
    const found = minted === undefined ? source.includes(`"${anchor}"`) : source.includes(minted);
    return found ? null : `${page.id}: no "${anchor}"`;
  }

  it("has each anchored page render every anchor as an element id", () => {
    const drift = ADMIN_PAGES.flatMap((page) =>
      page.anchors.flatMap((anchor) => anchorDrift(page, anchor) ?? []),
    );
    expect(drift).toEqual([]);
  });

  it("declares the voided bank refund notes anchor as the id its panel is given (C7 #4804)", () => {
    // The panel writes `id={BANK_REFUND_VOIDS_ANCHOR}`; its stuck-state row links
    // with adminAnchorHref. One spelling, typed against the registry.
    expect(BANK_REFUND_VOIDS_ANCHOR).toBe("bank-refund-voids");
    expect(getAdminPage("stuck-states").anchors).toEqual([BANK_REFUND_VOIDS_ANCHOR]);
    expect(adminAnchorHref("stuck-states", BANK_REFUND_VOIDS_ANCHOR)).toBe(
      "/admin/stuck-states#bank-refund-voids",
    );
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
      keywords: [],
      tabs: [],
      anchors: [],
      moved: true,
    };
    const payments = ADMIN_PAGES.find((page) => page.id === "payments")!;
    const retired: AdminRetiredPage = { oldPath: "/admin/zz/old", label: "Old", mergedInto: "payments" };
    const rules = buildAdminUrlRules(true, [payments, zz], [retired]);
    // Payments has moved (C5 #4802), so live, its content is served at the hub URL.
    expect(payments.moved).toBe(true);
    await expect(resolveThrough(rules, "/admin/zz/old")).resolves.toEqual({
      kind: "redirect",
      status: 307,
      url: "/admin/finance/payments",
    });
    // Off, the retired redirect goes to the old URL, where Payments is served.
    await expect(
      resolveThrough(buildAdminUrlRules(false, [payments, zz], [retired]), "/admin/zz/old"),
    ).resolves.toEqual({ kind: "redirect", status: 307, url: "/admin/payments" });
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
      expect(destinations).toContain(live ? "/admin/rules/bookings-setup" : "/admin/bookings-setup");
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
  it("returns the retired redirects and the Website, Finance, Rules, Help & system and Messages pages' move rules", () => {
    // C4 (#4801) moved the Website pages under `/admin/website`, C5 (#4802)
    // the Finance pages under `/admin/finance`, C6 (#4803) the Fees & booking
    // rules pages under `/admin/rules`, C7 (#4804) the Help & system pages
    // under `/admin/system`, and C8 (#4805) the Messages & email pages under
    // `/admin/messages`. Off: each hub URL redirects to the old URL, and a
    // beforeFiles rewrite serves the old URL from the moved file. On: the old
    // URL redirects to the hub URL, and there are no rewrites. Retired pages
    // still come first. Bookings Setup, which Booking Rules was merged into,
    // and System Health, which Integrations Setup was merged into, have moved,
    // so once on those two redirects go straight to the hub URL; the others
    // keep their old destinations in both states.
    const retiredRedirects = (live: boolean) => [
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
        destination: live ? "/admin/rules/bookings-setup" : "/admin/bookings-setup",
        permanent: false,
      },
      {
        source: "/admin/setup/integrations",
        destination: live
          ? "/admin/system/health#integration-readiness"
          : "/admin/health#integration-readiness",
        permanent: false,
      },
    ];
    // Static paths in old-path order, then the two dynamic pages, fewest
    // dynamic segments first, their `[name]` segments as Next's `:name`.
    const staticMoves = [
      ["/admin/age-tier-settings", "/admin/rules/age-tier-settings"],
      ["/admin/ai-assistant", "/admin/system/ai-assistant"],
      ["/admin/ai-diagnostics", "/admin/system/ai-diagnostics"],
      ["/admin/appearance", "/admin/website/appearance"],
      ["/admin/appearance/identity", "/admin/website/appearance/identity"],
      ["/admin/audit-log", "/admin/system/audit-log"],
      ["/admin/background-jobs", "/admin/system/background-jobs"],
      ["/admin/backups", "/admin/system/backups"],
      ["/admin/backups/setup", "/admin/system/backups/setup"],
      ["/admin/booking-messages", "/admin/messages/booking-messages"],
      ["/admin/booking-policies", "/admin/rules/booking-policies"],
      ["/admin/booking-policies/adult-member-hosting", "/admin/rules/booking-policies/adult-member-hosting"],
      ["/admin/booking-policies/cancellation", "/admin/rules/booking-policies/cancellation"],
      ["/admin/booking-policies/group-discount", "/admin/rules/booking-policies/group-discount"],
      ["/admin/booking-policies/minimum-stay", "/admin/rules/booking-policies/minimum-stay"],
      ["/admin/booking-policies/periods", "/admin/rules/booking-policies/periods"],
      ["/admin/booking-policies/public-requests", "/admin/rules/booking-policies/public-requests"],
      ["/admin/bookings-setup", "/admin/rules/bookings-setup"],
      ["/admin/communications", "/admin/messages/communications"],
      ["/admin/email-deliverability", "/admin/system/email-deliverability"],
      ["/admin/email-messages", "/admin/messages/email-messages"],
      ["/admin/fee-configuration", "/admin/rules/fee-configuration"],
      ["/admin/fees", "/admin/rules/fees"],
      ["/admin/health", "/admin/system/health"],
      ["/admin/image-manager", "/admin/website/image-manager"],
      ["/admin/internet-banking", "/admin/finance/internet-banking"],
      ["/admin/issue-reports", "/admin/system/issue-reports"],
      ["/admin/message-board", "/admin/messages/message-board"],
      ["/admin/mountain-conditions", "/admin/website/mountain-conditions"],
      ["/admin/notices", "/admin/messages/notices"],
      ["/admin/notices/new", "/admin/messages/notices/new"],
      ["/admin/notification-recipients", "/admin/messages/notification-recipients"],
      ["/admin/notification-rules", "/admin/messages/notification-rules"],
      ["/admin/notifications", "/admin/messages/notifications"],
      ["/admin/page-content", "/admin/website/page-content"],
      ["/admin/payments", "/admin/finance/payments"],
      ["/admin/promo-codes", "/admin/rules/promo-codes"],
      ["/admin/refund-requests", "/admin/finance/refund-requests"],
      ["/admin/reports", "/admin/finance/reports"],
      ["/admin/seasons", "/admin/rules/seasons"],
      ["/admin/site-banners", "/admin/website/site-banners"],
      ["/admin/site-content", "/admin/website/site-content"],
      ["/admin/site-style", "/admin/website/site-style"],
      ["/admin/stuck-states", "/admin/system/stuck-states"],
      ["/admin/subscriptions", "/admin/finance/subscriptions"],
      ["/admin/testing/route-error", "/admin/system/testing/route-error"],
      ["/admin/xero", "/admin/finance/xero"],
      ["/admin/xero/member-grouping", "/admin/finance/xero/member-grouping"],
      ["/admin/xero/setup", "/admin/finance/xero/setup"],
    ] as const;
    const noticeDetail = ["/admin/notices/[id]", "/admin/messages/notices/[id]"] as const;
    const xeroRecord = [
      "/admin/xero/records/[localModel]/[localId]",
      "/admin/finance/xero/records/[localModel]/[localId]",
    ] as const;
    expect(
      ADMIN_PAGES.filter((page) => page.moved)
        .map((page) => [page.oldPath, page.hubPath])
        .sort((a, b) => a[0].localeCompare(b[0])),
    ).toEqual([...staticMoves, noticeDetail, xeroRecord].sort((a, b) => a[0].localeCompare(b[0])));
    const moves = [
      ...staticMoves,
      ["/admin/notices/:id", "/admin/messages/notices/:id"],
      [
        "/admin/xero/records/:localModel/:localId",
        "/admin/finance/xero/records/:localModel/:localId",
      ],
    ] as const;
    const off = moves.map(([oldUrl, hubUrl]) => ({
      source: hubUrl,
      destination: oldUrl,
      permanent: false as const,
    }));
    const on = moves.map(([oldUrl, hubUrl]) => ({
      source: oldUrl,
      destination: hubUrl,
      permanent: false as const,
    }));
    const beforeFiles = moves.map(([oldUrl, hubUrl]) => ({
      source: oldUrl,
      destination: hubUrl,
    }));
    expect(buildAdminUrlRules(false)).toEqual({
      redirects: [...retiredRedirects(false), ...off],
      rewrites: { beforeFiles },
    });
    expect(buildAdminUrlRules(true)).toEqual({
      redirects: [...retiredRedirects(true), ...on],
      rewrites: { beforeFiles: [] },
    });
    expect(buildAdminUrlRules(false, ADMIN_PAGES, [])).toEqual({
      redirects: off,
      rewrites: { beforeFiles },
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
    keywords: [],
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
    "src/components/admin-sidebar.tsx":
      "C3: the active link is the registry's activeAdminHref; S2: the palette index is ADMIN_MENU_DESTINATIONS; " +
      "C7: the Help & system links and the Issue Reports badge are adminLink and adminHref; " +
      "C8: the Messages & email links are adminLink",
    "src/lib/admin-page-revalidation.ts": "C3: revalidateAdminPage revalidates a page's file path",
    "src/components/help-widget/help-widget-admin.tsx":
      "C3: admin help reads the pathname through canonicalAdminPathname",
    "src/components/nav-bar.tsx": "C3: the profile return-to uses servedAdminPathname",
    "src/app/(admin)/admin/finance/xero/page.tsx":
      "C3: currentXeroPath uses servedAdminPathname; C5: the setup link is adminHref",
    "src/app/(admin)/admin/finance/xero/_components/operations-panel.tsx":
      "C3: router.replace targets use servedAdminPathname",
    "src/app/(admin)/admin/finance/xero/_components/inbound-events-panel.tsx":
      "C3: router.replace targets use servedAdminPathname",
    "src/lib/__tests__/admin-hubs-active-link.test.ts": "C3: activeAdminHref and its census",
    "src/lib/__tests__/feature-navigation.test.ts":
      "C4: a nav href's page file is the hub path once the Website pages have moved",
    "src/components/__tests__/admin-sidebar-active-link.test.tsx":
      "C3: the real sidebar over a moved Finance hub",
    "src/lib/__tests__/admin-page-revalidation.test.ts":
      "C3: revalidateAdminPage's targets and the revalidatePath census",
    "src/components/admin/admin-page-tabs.tsx":
      "S1: the tab shell reads and links a page's tabs through the registry",
    "src/components/admin/membership-cancellation-settings-tab.tsx":
      "S1: the Settings tab links Email Messages with adminHref",
    "src/app/(admin)/admin/rules/bookings-setup/page.tsx": "S1: its cards link with adminHref",
    "src/app/(admin)/admin/system/health/_components/integration-readiness-section.tsx":
      "S1: its cards link with adminHref; its id is the registry's anchor",
    "src/app/(admin)/admin/setup/setup-page-client.tsx":
      "S1: the cards for the merged setup pages link with adminHref; C8: and the Notifications & Email card",
    "src/app/(admin)/admin/messages/notifications/page.tsx":
      "S1: the cancellation settings card links the Settings tab; C8: its other cards link with adminHref; " +
      "#4878: the Delivery Rules and Recipients titles are the registry labels",
    "src/components/admin/membership-cancellation-blocker-notice.tsx":
      "S1: the settings link is the queue's Settings tab",
    "src/lib/setup-readiness.ts":
      "S1: the cancellation step links the Settings tab; C5: Xero setup, and the mappings anchor and label; " +
      "C6: the booking policies, age tier and seasons steps; C7: the System Health steps",
    "src/lib/__tests__/admin-feature-search-index.test.ts":
      "S2: the palette census and its fail-closed property over every grid and seeded role",
    "src/lib/__tests__/contextual-help.test.ts":
      "#4878: the Member notices help title is the page's registry label",
    "src/app/(admin)/admin/messages/notifications/__tests__/hub-card-labels.test.tsx":
      "#4878: the Delivery Rules and Recipients cards show the registry labels",
    "src/lib/__tests__/admin-palette-lodge-scoped-pages.test.tsx":
      "S2: the lodge-scoped pages open from their palette href",
    "src/lib/__tests__/next-config-admin-hub-urls.test.ts":
      "S1: walks each retired page's redirect through the real config",
    "src/app/(admin)/layout.tsx": "C4: the site-style banner links with adminHref",
    "src/app/(admin)/admin/website/appearance/page.tsx": "C4: its title is the registry label",
    "src/lib/admin-appearance-pages.ts":
      "#108: the Website hub's cards and the Content sidebar menu, linked with adminHref",
    "src/lib/admin-nav-panels.ts":
      "#108: the role menus name their pages by registry id, matched in old-path form",
    "src/lib/__tests__/admin-nav-panels.test.tsx":
      "#108: every page a role menu names is a sidebar page, at its adminHref",
    "src/app/(admin)/admin/website/appearance/identity/page.tsx":
      "C4: its back link is adminLink",
    "src/app/(admin)/admin/website/site-style/page.tsx":
      "C4: its back link is adminLink; C8: the Email Messages link is adminHref",
    "src/app/(admin)/admin/website/site-content/page.tsx": "C4: its back link is adminLink",
    "src/app/(admin)/admin/website/site-banners/page.tsx": "C4: its back link is adminLink",
    "src/app/(admin)/admin/website/page-content/page.tsx": "C4: its back link is adminLink",
    "src/app/(admin)/admin/website/image-manager/page.tsx": "C4: its back link is adminLink",
    "src/app/(admin)/admin/website/mountain-conditions/page.tsx":
      "C4: its back link is adminLink",
    "src/app/(admin)/admin/setup/foundations/page.tsx":
      "C4: the Club Identity card links with adminHref; C7: and the System Health card",
    "src/app/(admin)/admin/rules/booking-policies/cancellation/page.tsx":
      "C4: the public-pages link is adminHref; C6: its back link is adminLink",
    "src/lib/analytics-privacy-policy.ts": "C4: the privacy-policy editor link is adminHref",
    "src/components/admin/analytics-integration-card.tsx":
      "C4: the privacy-policy fallback link is adminHref",
    "src/proxy.ts": "C4: a page reached only by another spelling of its path is a 404",
    "src/lib/contextual-help/admin/appearance-and-website.ts":
      "C4: the Website pages' help is keyed by each page's registry old path",
    "src/lib/__tests__/admin-page-exact-path-proxy.test.ts":
      "C4: the proxy's 404 for every registered page spelled another way",
    "src/app/(admin)/admin/book/page.tsx": "C5: the Xero setup link is adminHref",
    "src/app/(admin)/admin/dashboard/page.tsx":
      "C5: the payments and refunds links, and the payments permission check, are adminHref; " +
      "C6: the seasons and promo-code links",
    "src/app/(admin)/admin/finance/internet-banking/page.tsx": "C5: its back link is adminLink",
    "src/app/(admin)/admin/finance/xero/_components/health-diagnostics-panel.tsx":
      "C5: the member-grouping link is adminHref",
    "src/app/(admin)/admin/finance/xero/_components/webhook-amber-badge.tsx":
      "C5: the webhook setup link is adminHref",
    "src/app/(admin)/admin/finance/xero/_components/xero-setup-page-client.tsx":
      "C5: its back link is adminHref",
    "src/app/(admin)/admin/finance/xero/setup/xero-completion-steps.tsx":
      "C5: the Xero admin link is adminHref",
    "src/app/(admin)/admin/integrations/page.tsx":
      "C5: the Xero setup card is adminHref; C7: and the backup setup and AI assistant cards",
    "src/app/(admin)/admin/modules/page.tsx": "C5: the Xero module setup link is adminHref",
    "src/app/(admin)/admin/setup/finance/page.tsx":
      "C5: the Xero cards are adminHref and the mappings card adminAnchorHref",
    "src/app/(admin)/admin/stripe/setup/page.tsx": "C5: the payments link is adminHref",
    "src/components/admin/booking-requests/booking-approvals-panel.tsx":
      "C5: the refunds link is adminHref",
    "src/components/admin/subscription-lockout-settings-panel.tsx":
      "C5: the Xero setup links are adminHref; C6: the fee console and age tier links",
    "src/lib/__tests__/asset-url-404.test.ts":
      "C5: the beforeFiles pin follows the moved Website and Finance pages",
    "src/lib/admin-member-detail-helpers.ts":
      "C5: the member back-link label is the registry label of the Bookings or Finance page it returns to",
    "src/lib/audit-query.ts":
      "C5, C6: audit deep links use adminHref; C7: and the lifecycle audit link; C8: and the communications links",
    "src/lib/booking-provider-mismatches.ts": "C5: the settlement-queue link is adminHref",
    "src/lib/diagnostics/page-context/__tests__/registry.test.ts":
      "C5: a diagnostics row's file is the hub path once its page has moved",
    "src/lib/email-message-audit-defaults.ts": "C5: default email deep links use adminHref",
    "src/lib/email-templates/admin-finance.ts": "C5: finance alert buttons use adminHref",
    "src/lib/email-templates/admin-ops.ts": "C5: the digest's finance links use adminHref",
    "src/lib/email-templates/admin-xero-reports.ts": "C5: the report buttons use adminHref",
    "src/lib/email/admin-alerts-finance.ts": "C5: payment review links use adminHref",
    "src/lib/email/admin-alerts-internet-banking-started-stay.ts":
      "C5: the payments review link is adminHref",
    "src/lib/email/admin-alerts-internet-banking.ts": "C5: the payments review link is adminHref",
    "src/lib/email/admin-alerts-late-capture.ts": "C5: the payments review links are adminHref",
    "src/lib/email/admin-alerts-settlement.ts": "C5: the payments review links are adminHref",
    "src/lib/finance-dashboard-page/sync-health-view.ts": "C5: the Xero admin link is adminHref",
    "src/lib/finance-sync-health.ts": "C5: the Xero admin link is adminHref",
    "src/lib/stuck-state-dashboard.ts":
      "C5, C7: stuck-state links use adminHref; C7: the voided bank refund notes row is adminAnchorHref",
    "src/lib/xero-record-activity.ts": "C5: the payments back link is adminLink",
    "src/lib/xero-record-links.ts": "C5: a Xero record's URL is adminHref",
    "src/lib/contextual-help/admin/finance.ts":
      "C5: the Finance pages' help is keyed by each page's registry old path; C6: and the fee console's",
    "src/lib/contextual-help/admin/members.ts":
      "C5: the Subscriptions help is keyed by its registry old path; C8: and Communications' and Member Notices'",
    "src/lib/contextual-help/questions-admin.ts":
      "C5: the Finance pages' question chips are keyed by each page's registry old path; C6: and Seasons'; " +
      "C7: and the Audit Log's; C8: and Communications'",
    "src/app/(admin)/admin/finance/payments/page.tsx": "C5: its own address is adminHref",
    "src/app/(admin)/admin/finance/refund-requests/page.tsx": "C5: its own address is adminHref",
    "src/app/(admin)/admin/finance/subscriptions/page.tsx": "C5: its own address is adminHref",
    "src/app/(admin)/admin/finance/xero/records/[localModel]/[localId]/page.tsx":
      "C5: the fallback back link is adminLink",
    "src/app/(admin)/admin/finance/xero/setup/xero-wizard-steps.tsx":
      "C5: the OAuth connect step returns to Xero Setup at its adminHref",
    "src/app/api/admin/xero/callback/route.ts":
      "C5: the OAuth callback's default landing is Xero Sync at its adminHref",
    "src/lib/cron-credit-reconciliation.ts": "C5: the refund credit-note alert links Xero Sync at its adminHref",
    "src/lib/__tests__/admin-member-detail-helpers.test.ts":
      "C5: the member back-link labels are the registry's",
    "src/lib/__tests__/admin-moved-page-literals.test.ts":
      "C5: no production code spells a moved page's old URL as a literal",
    "src/lib/__tests__/xero-oauth-return-path.test.ts":
      "C5: the OAuth return-path check accepts both Xero landing pages at either place",
    "src/app/(admin)/admin/rules/booking-policies/page.tsx": "C6: its cards link with adminHref",
    "src/app/(admin)/admin/rules/booking-policies/adult-member-hosting/page.tsx":
      "C6: its back link is adminLink",
    "src/app/(admin)/admin/rules/booking-policies/group-discount/page.tsx":
      "C6: its back link is adminLink",
    "src/app/(admin)/admin/rules/booking-policies/minimum-stay/page.tsx":
      "C6: its back link is adminLink",
    "src/app/(admin)/admin/rules/booking-policies/periods/page.tsx": "C6: its back link is adminLink",
    "src/app/(admin)/admin/rules/booking-policies/public-requests/page.tsx":
      "C6: its back link is adminLink",
    "src/app/(admin)/admin/rules/fee-configuration/page.tsx": "C6: it redirects to the fee console's adminHref",
    "src/lib/__tests__/fee-configuration-redirect.test.ts":
      "C6: pins the Fee Configuration stub's redirect to the fee console's adminHref",
    "src/app/(admin)/admin/rules/fees/_components/hut-fees-section.tsx": "C6: the Seasons link is adminHref",
    "src/app/(admin)/admin/rules/seasons/page.tsx": "C6: the Fees link is adminHref",
    "src/app/(admin)/admin/finance/xero/_components/mappings-panel.tsx":
      "C6: the fee console link is adminHref",
    "src/app/(admin)/admin/lodges/[id]/page.tsx":
      "C6: the Seasons & Rates card's link, and the fees and seasons permission checks, are adminHref",
    "src/app/(admin)/admin/lodges/[id]/setup/page.tsx": "C6: the seasons link is adminHref",
    "src/app/(admin)/admin/lodges/_components/other-lodge-season-rates.tsx": "C6: the Fees link is adminHref",
    "src/app/(admin)/admin/membership/membership-types/page.tsx": "C6: the age tier settings link is adminHref",
    "src/app/(admin)/admin/rooms-beds/page.tsx": "C6: its back link is adminLink",
    "src/lib/contextual-help/admin/rates-and-policies.ts":
      "C6: the Rules pages' help is keyed by each page's registry old path",
    "src/lib/contextual-help/admin/setup-and-configuration.ts":
      "C6: the Bookings Setup help is keyed by its registry old path; " +
      "C8: and Notifications & Email's and Booking Messages'",
    "src/app/(admin)/admin/system/audit-log/page.tsx": "C7: its own address is adminHref",
    "src/app/(admin)/admin/system/background-jobs/page.tsx": "C7: its back link is adminLink",
    "src/app/(admin)/admin/system/email-deliverability/page.tsx": "C7: its back link is adminLink",
    "src/app/(admin)/admin/system/backups/backups-client.tsx": "C7: the backup setup link is adminHref",
    "src/app/(admin)/admin/system/backups/setup/backup-wizard-steps.tsx":
      "C7: the Database Backups link is adminHref",
    "src/app/(admin)/admin/system/health/_components/health-dashboard.tsx":
      "C7: the Email Deliverability and Background Jobs cards link with adminHref",
    "src/app/(admin)/admin/system/stuck-states/page.tsx": "C7: the System Health link is adminHref",
    "src/app/(admin)/admin/waitlist/page.tsx":
      "C7: the audit-log and email deliverability links are adminHref",
    "src/app/api/issue-reports/route.ts": "C7: the alert email's Issue Reports link is adminHref",
    "src/components/admin/admin-booking-tools-card.tsx": "C7: the audit log link is adminHref",
    "src/components/admin/booking-withheld-emails-banner.tsx":
      "C7: the email deliverability link is adminHref",
    "src/lib/contextual-help/admin/monitoring-and-support.ts":
      "C7: the Help & system pages' help is keyed by each page's registry old path",
    "src/lib/route-error-probe.ts": "C7: the probe's path is adminHref",
    "src/components/admin/bank-refund-voids-to-answer-panel.tsx":
      "C7: its card's id is the Stuck States page's registry anchor",
    "src/lib/__tests__/stuck-state-dashboard.test.ts":
      "C7: the voided bank refund notes row links the registry anchor",
    "src/lib/setup-readiness-data-keys.ts": "C7: the data-key check links System Health with adminHref",
    "src/app/(admin)/admin/messages/notification-rules/page.tsx": "C8: its back link is adminLink",
    "src/app/(admin)/admin/messages/notification-recipients/page.tsx": "C8: its back link is adminLink",
    "src/app/(admin)/admin/messages/email-messages/page.tsx": "C8: its back link is adminLink",
    "src/app/(admin)/admin/messages/booking-messages/page.tsx": "C8: its back link is adminLink",
    "src/app/(admin)/admin/messages/notices/page.tsx":
      "C8: the notice and new-notice links are adminHref",
    "src/app/(admin)/admin/messages/notices/[id]/page.tsx": "C8: its back link is adminLink",
    "src/app/(admin)/admin/messages/notices/new/page.tsx": "C8: its back link is adminLink",
    "src/components/admin/notice-editor.tsx":
      "C8: saving and cancelling return to Member Notices at its adminHref",
    "src/components/admin/club-posts/club-posts-admin.tsx":
      "C8: the Message Board's tab links and search form address it at its adminHref",
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
