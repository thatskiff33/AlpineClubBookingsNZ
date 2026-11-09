import fs from "node:fs";
import path from "node:path";
import { AccessRole } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import { getDisabledFeatureForPath } from "@/config/feature-routes";
import { DEFAULT_ACCESS_ROLE_DEFINITIONS } from "@/lib/access-role-definitions";
import { isFullAdmin, type PrivilegeCheckInput } from "@/lib/access-roles";
import {
  canOpenAdminPath,
  getAdminPermissionMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";
import {
  ADMIN_FEATURE_SEARCH_GROUP_ORDER,
  adminPageLabel,
  getAdminFeatureSearchIndex,
  getVisibleAdminNavSections,
  type AdminFeatureSearchEntry,
} from "@/components/admin-sidebar";
import {
  ADMIN_HUBS,
  ADMIN_MENU_DESTINATIONS,
  ADMIN_PAGES,
  ADMIN_RETIRED_PAGES,
  adminHref,
  buildAdminUrlRules,
  canonicalAdminPathname,
  getAdminPage,
  retiredAdminPageHref,
} from "@/lib/admin-hubs";
import { ADMIN_HUBS_LIVE } from "@/lib/admin-hubs/release";
import type { AdminHubPage } from "@/lib/admin-hubs/define";
import { requireCalendarDate } from "@/lib/club-time";
import {
  buildUnpaidFinishedStaysHref,
  buildUnsettledAdditionalStaysHref,
} from "@/lib/unpaid-finished-stays-hrefs";
import {
  adminPageFiles,
  toRawPathname,
  toRepoRelative,
} from "@/lib/__tests__/helpers/admin-route-enumeration";
import { SWEEP_GRIDS } from "@/lib/__tests__/helpers/admin-sweep-grids";
import { stripComments } from "@/lib/__tests__/support/strip-comments";

// ---------------------------------------------------------------------------
// THE ADMIN FEATURE PALETTE'S INDEX (#2092; built from the hub registry since
// S2 #4797).
//
// Two halves. The census proves the palette offers every admin page a Full
// Admin can open, and nothing that is not a page, from the page tree on disk.
// The property test proves it fails closed: for every sweep grid and every
// seeded role, under every module setting, no entry is offered whose path the
// layout guard (`canOpenAdminPath`) refuses, whose module is off, or that is
// Full Admin only for anyone else; and nothing the viewer may open is withheld.
// ---------------------------------------------------------------------------

/**
 * #3123: the club's day, first and REQUIRED. One entry is a dated deep link
 * (the unpaid-finished-stays queue); the frozen test day serves every call.
 */
const CLUB_DAY = requireCalendarDate("2026-07-01");

const allOn: FeatureFlags = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as FeatureFlags;
const allOff: FeatureFlags = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, false]),
) as FeatureFlags;

function matrix(
  over: Partial<Record<keyof AdminPermissionMatrix, "none" | "view" | "edit">>,
): AdminPermissionMatrix {
  return {
    overview: "none",
    bookings: "none",
    membership: "none",
    finance: "none",
    lodge: "none",
    content: "none",
    support: "none",
    ...over,
  };
}

const fullMatrix = matrix({
  overview: "edit",
  bookings: "edit",
  membership: "edit",
  finance: "edit",
  lodge: "edit",
  content: "edit",
  support: "edit",
});

const QUEUE_VIEW_HREFS = new Set([
  buildUnpaidFinishedStaysHref(CLUB_DAY),
  buildUnsettledAdditionalStaysHref(),
]);

function hrefs(index: readonly AdminFeatureSearchEntry[]): Set<string> {
  return new Set(index.map((entry) => entry.href));
}

/** A retired page's palette entry: its old name, at its redirect's target. */
function isRetiredEntry(entry: AdminFeatureSearchEntry): boolean {
  return ADMIN_RETIRED_PAGES.some(
    (retired) => retired.label === entry.label && retiredAdminPageHref(retired) === entry.href,
  );
}

/** The index's PAGES, as old paths: the queue views and retired names left out. */
function indexedPagePaths(index: readonly AdminFeatureSearchEntry[]): Set<string> {
  return new Set(
    index
      .filter((entry) => !QUEUE_VIEW_HREFS.has(entry.href) && !isRetiredEntry(entry))
      .map((entry) => canonicalAdminPathname(entry.href)),
  );
}

function fullAdminIndex(features: FeatureFlags = allOn) {
  return getAdminFeatureSearchIndex(CLUB_DAY, features, fullMatrix, true);
}

// --- the census, from disk ---------------------------------------------------

/**
 * Whether a page on disk is somewhere an officer goes on purpose, decided from
 * the path and the file alone, never from a page's registry entry: no
 * `[param]`, not the test probe, not a print view, not a file that only
 * redirects, and not the one reviewed page that names its record in the query
 * (`display/preview`, which shows only an error without `?templateId=`). The
 * path is read in its old-path form (`canonicalAdminPathname`), which consults
 * the registry only for where a hub has moved a directory, never for a page's
 * kind (C7 #4804).
 */
const QUERY_NAMED_DETAILS = new Set(["/admin/display/preview"]);

function isDestinationOnDisk(file: string): boolean {
  const pagePath = canonicalAdminPathname(toRawPathname(file));
  if (pagePath.includes("[")) return false;
  if (pagePath === "/admin/testing" || pagePath.startsWith("/admin/testing/")) return false;
  if (pagePath.endsWith("/print")) return false;
  if (QUERY_NAMED_DETAILS.has(pagePath)) return false;
  const source = stripComments(fs.readFileSync(file, "utf8"));
  const redirectsOnly =
    /\b(?:permanentRedirect|redirect)\(/.test(source) && !/\breturn\b/.test(source);
  return !redirectsOnly;
}

const DISK_DESTINATIONS = adminPageFiles
  .filter(isDestinationOnDisk)
  .map((file) => canonicalAdminPathname(toRawPathname(file)));
const DISK_NON_DESTINATIONS = adminPageFiles
  .filter((file) => !isDestinationOnDisk(file))
  .map((file) => ({ file: toRepoRelative(file), path: toRawPathname(file) }));

/**
 * The pages the palette offers that the sidebar does not link: the areas #130
 * and the setup work left reachable only from a hub card, a setup checklist or
 * another page. Pinned so the gain is reviewed, not incidental.
 */
const NEWLY_INDEXED = [
  "/admin/alpine-server/setup",
  "/admin/appearance/identity",
  "/admin/backups/setup",
  "/admin/booking-messages",
  "/admin/booking-policies/adult-member-hosting",
  "/admin/booking-policies/cancellation",
  "/admin/booking-policies/group-discount",
  "/admin/booking-policies/minimum-stay",
  "/admin/booking-policies/periods",
  "/admin/booking-policies/public-requests",
  "/admin/chores",
  "/admin/display/builder",
  "/admin/display/devices",
  "/admin/display/layouts",
  "/admin/display/reference",
  "/admin/display/setup",
  "/admin/display/templates",
  "/admin/email-messages",
  "/admin/google/setup",
  "/admin/image-manager",
  "/admin/induction/settings",
  "/admin/lockers",
  "/admin/member-fields",
  "/admin/membership-types",
  "/admin/mountain-conditions",
  "/admin/notices/new",
  "/admin/notification-recipients",
  "/admin/notification-rules",
  "/admin/page-content",
  "/admin/rooms-beds",
  "/admin/seasons",
  "/admin/setup/finance",
  "/admin/setup/foundations",
  "/admin/site-banners",
  "/admin/site-content",
  "/admin/site-style",
  "/admin/stripe/setup",
  "/admin/subscription-lockout",
  "/admin/video-meetings/setup",
  "/admin/xero/setup",
];

describe("getAdminFeatureSearchIndex — every admin page, from disk", () => {
  it("offers a Full Admin exactly the destination pages on disk", () => {
    const indexed = indexedPagePaths(fullAdminIndex());
    expect(DISK_DESTINATIONS.length).toBeGreaterThan(80);
    expect([...indexed].sort()).toEqual([...new Set(DISK_DESTINATIONS)].sort());
  });

  it("never offers a detail, print, stub or test page, even to a Full Admin", () => {
    const indexed = indexedPagePaths(fullAdminIndex());
    const offered = DISK_NON_DESTINATIONS.filter(({ path: pagePath }) =>
      indexed.has(canonicalAdminPathname(pagePath)),
    );
    expect(DISK_NON_DESTINATIONS.length).toBeGreaterThanOrEqual(17);
    expect(offered).toEqual([]);
    for (const page of ADMIN_PAGES.filter((candidate) => candidate.kind !== "page")) {
      expect(indexed.has(page.oldPath), page.id).toBe(false);
    }
  });

  it("never offers a retired page's old URL", () => {
    const offered = hrefs(fullAdminIndex());
    expect(ADMIN_RETIRED_PAGES.length).toBeGreaterThan(0);
    for (const retired of ADMIN_RETIRED_PAGES) {
      expect(offered.has(retired.oldPath), retired.oldPath).toBe(false);
    }
  });

  it("offers each page the sidebar does not link", () => {
    const indexed = indexedPagePaths(fullAdminIndex());
    expect(NEWLY_INDEXED.filter((pagePath) => !indexed.has(pagePath))).toEqual([]);
  });

  it("indexes each page once, at its adminHref, under its hub", () => {
    const index = fullAdminIndex();
    const pageHrefs = index
      .filter((entry) => !isRetiredEntry(entry))
      .map((entry) => entry.href);
    expect(new Set(pageHrefs).size).toBe(pageHrefs.length);
    const keys = index.map((entry) => `${entry.href} ${entry.label}`);
    expect(new Set(keys).size).toBe(keys.length);
    const hubLabel = new Map<string, string>(ADMIN_HUBS.map((hub) => [hub.key, hub.label]));
    for (const { page, href } of ADMIN_MENU_DESTINATIONS) {
      const entry = index.find((candidate) => candidate.href === href);
      expect(entry, page.id).toBeDefined();
      expect(entry!.section).toBe(hubLabel.get(page.hub));
      if (page.id !== "hut-leaders") expect(entry!.label).toBe(page.label);
    }
    expect(index.find((entry) => entry.href === adminHref("payments"))).toMatchObject({
      label: "Payments",
      section: "Finance",
    });
    expect(index.find((entry) => entry.href === adminHref("chores"))).toMatchObject({
      label: "Chores",
      section: "Lodge",
    });
  });

  it("groups by hub, in menu order", () => {
    expect(ADMIN_FEATURE_SEARCH_GROUP_ORDER).toEqual(ADMIN_HUBS.map((hub) => hub.label));
    const sections = new Set(fullAdminIndex().map((entry) => entry.section));
    expect([...sections].every((section) => ADMIN_FEATURE_SEARCH_GROUP_ORDER.includes(section))).toBe(true);
  });

  it("keeps the queue views, dated by the club's day, under Bookings", () => {
    const index = fullAdminIndex();
    expect(index.find((entry) => entry.href === buildUnpaidFinishedStaysHref(CLUB_DAY))).toMatchObject({
      label: "Unpaid Finished Stays",
      section: "Bookings",
    });
    expect(index.find((entry) => entry.href === buildUnsettledAdditionalStaysHref())).toMatchObject({
      label: "Unpaid Stay Additions",
      section: "Bookings",
    });
  });

  it("carries the hut-leader relabel, without doubling a saved plural (#3976)", () => {
    const label = (term: string) =>
      getAdminFeatureSearchIndex(CLUB_DAY, allOn, fullMatrix, true, term).find(
        (entry) => entry.href === adminHref("hut-leaders"),
      )?.label;
    expect(label("Warden")).toBe("Wardens");
    expect(label("Hut Leaders")).toBe("Hut Leaders");
  });
});

describe("getAdminFeatureSearchIndex — keywords", () => {
  const keywordsOf = (href: string) =>
    fullAdminIndex().find((entry) => entry.href === href)?.keywords ?? [];

  it("carries the registry keywords the sidebar used to hold", () => {
    expect(keywordsOf(adminHref("xero"))).toContain("accounting");
    expect(keywordsOf(adminHref("club-time"))).toEqual(
      expect.arrayContaining(["timezone", "daylight saving", "iana"]),
    );
  });

  /*
    Google Analytics has no page of its own: #2573 put its configuration in a
    dialog on Integrations, so the page carries its words. "analytics" alone is
    also Reports' keyword, which is why the specific terms matter.
  */
  it("finds Google Analytics through the Integrations page it lives on", () => {
    expect(keywordsOf(adminHref("integrations"))).toEqual(
      expect.arrayContaining(["google analytics", "analytics", "ga4", "api", "webhooks"]),
    );
  });

  it("does not repeat a retired page's name as its destination's keyword", () => {
    const words = keywordsOf(adminHref("family-groups")).map((word) => word.toLowerCase());
    expect(words).not.toContain("family suggestions");
    expect(words).toContain("suggested families");
  });

  /*
    The palette's groups are hubs since S2, so the sidebar section names an
    officer learned ("Lodge Operations", "Setup & Configuration") ride on each
    page as a keyword, read from the sidebar itself.
  */
  it("finds a page by its old sidebar section name", () => {
    expect(keywordsOf(adminHref("roster"))).toContain("Lodge Operations");
    expect(keywordsOf(adminHref("modules"))).toContain("Setup & Configuration");
    expect(keywordsOf(adminHref("bed-allocation"))).toContain("Bookings & Beds");
    expect(keywordsOf(adminHref("promo-codes"))).toContain("Rates & Policies");
    expect(keywordsOf(adminHref("health"))).toContain("Monitoring & Support");
    // Listed in Needs Attention too, but keeps its natural section.
    expect(keywordsOf(adminHref("booking-requests"))).toContain("Bookings & Beds");
    expect(keywordsOf(adminHref("booking-requests"))).not.toContain("Needs Attention");
    // The queue views sit only in Needs Attention.
    expect(keywordsOf(buildUnpaidFinishedStaysHref(CLUB_DAY))).toContain("Needs Attention");
    // A page the sidebar does not link has no section to carry.
    expect(keywordsOf(adminHref("chores"))).toEqual([]);
  });

  it("carries every sidebar section name onto the pages it lists", () => {
    const index = fullAdminIndex();
    const missing: string[] = [];
    for (const section of getVisibleAdminNavSections(CLUB_DAY, allOn, fullMatrix, true)) {
      if (!section.label || section.label === "Needs Attention") continue;
      for (const item of section.items) {
        const entry = index.find((candidate) => candidate.href === item.href);
        if (!entry) missing.push(`${item.href}: not indexed`);
        else if (!entry.keywords?.includes(section.label)) missing.push(`${item.href}: no "${section.label}"`);
      }
    }
    expect(missing).toEqual([]);
  });
});

// --- retired pages, by their old names ---------------------------------------

describe("getAdminFeatureSearchIndex — a retired page under its old name", () => {
  const retiredEntry = (index: readonly AdminFeatureSearchEntry[], label: string) =>
    index.find((entry) => entry.label === label && isRetiredEntry(entry));

  it("lands on the tab or section that holds it, as its redirect does", () => {
    const index = fullAdminIndex();
    const redirects = new Map(
      buildAdminUrlRules(ADMIN_HUBS_LIVE).redirects.map((rule) => [rule.source, rule.destination]),
    );
    expect(ADMIN_RETIRED_PAGES.length).toBe(5);
    for (const retired of ADMIN_RETIRED_PAGES) {
      const entry = retiredEntry(index, retired.label);
      expect(entry, retired.label).toBeDefined();
      expect(entry!.href).toBe(redirects.get(retired.oldPath));
      const destination = getAdminPage(retired.mergedInto);
      expect(entry!.section).toBe(ADMIN_HUBS.find((hub) => hub.key === destination.hub)!.label);
    }
    // Pinned, so a target cannot drift to a default tab unnoticed.
    expect(retiredEntry(index, "Family Suggestions")?.href).toBe("/admin/family-groups?tab=suggestions");
    expect(retiredEntry(index, "Membership Cancellation Settings")?.href).toBe(
      "/admin/membership-cancellations?tab=settings",
    );
    expect(retiredEntry(index, "Cancellation Setup")?.href).toBe("/admin/membership-cancellations?tab=settings");
    expect(retiredEntry(index, "Booking Rules")?.href).toBe("/admin/bookings-setup");
    expect(retiredEntry(index, "Integrations Readiness")?.href).toBe("/admin/health#integration-readiness");
  });

  it("is offered exactly when the page that holds it is", () => {
    const grids = [
      matrix({ membership: "view" }),
      matrix({ bookings: "view" }),
      matrix({ support: "view" }),
      matrix({ content: "edit" }),
      fullMatrix,
      matrix({}),
    ];
    for (const grid of grids) {
      const index = getAdminFeatureSearchIndex(CLUB_DAY, allOn, grid, false);
      const offered = hrefs(index);
      for (const retired of ADMIN_RETIRED_PAGES) {
        const destination = ADMIN_MENU_DESTINATIONS.find(({ page }) => page.id === retired.mergedInto)!;
        expect(Boolean(retiredEntry(index, retired.label)), `${retired.label} ${JSON.stringify(grid)}`).toBe(
          offered.has(destination.href),
        );
      }
    }
    expect(retiredEntry(getAdminFeatureSearchIndex(CLUB_DAY, allOn, matrix({ membership: "view" }), false), "Cancellation Setup")).toBeDefined();
    expect(retiredEntry(getAdminFeatureSearchIndex(CLUB_DAY, allOn, matrix({ bookings: "view" }), false), "Family Suggestions")).toBeUndefined();
  });
});

// --- the hut-leader label, one helper ----------------------------------------

describe("adminPageLabel — one relabel for the sidebar and the palette", () => {
  it("pluralises the club's term on Hut Leaders only", () => {
    expect(adminPageLabel(getAdminPage("hut-leaders"), { hutLeaderLabel: "Warden" })).toBe("Wardens");
    expect(adminPageLabel(getAdminPage("roster"), { hutLeaderLabel: "Warden" })).toBe("Roster");
  });

  it("is what both surfaces show", () => {
    const sidebarLabels = getVisibleAdminNavSections(CLUB_DAY, allOn, fullMatrix, true, "Warden")
      .flatMap((section) => section.items)
      .filter((item) => item.href === adminHref("hut-leaders"))
      .map((item) => item.label);
    expect(sidebarLabels).toEqual(["Wardens", "Wardens"]);
    expect(
      getAdminFeatureSearchIndex(CLUB_DAY, allOn, fullMatrix, true, "Warden").find(
        (entry) => entry.href === adminHref("hut-leaders"),
      )?.label,
    ).toBe("Wardens");
  });

  it("is the only place the sidebar module pluralises the term", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/components/admin-sidebar.tsx"), "utf8");
    expect(source.match(/pluralHutLeaderLabel\(/g)).toHaveLength(1);
    expect(source).toMatch(/export function adminPageLabel\([\s\S]*?pluralHutLeaderLabel\(/);
  });
});

// --- the property: it fails closed -------------------------------------------

interface Subject {
  readonly label: string;
  readonly input: PrivilegeCheckInput;
}

/** The sixteen sweep grids, every enum role and every seeded role definition. */
const SUBJECTS: Subject[] = [
  ...SWEEP_GRIDS.map((grid) => ({ label: grid.label, input: grid.member as PrivilegeCheckInput })),
  ...Object.values(AccessRole).map((role) => ({
    label: `enum ${role}`,
    input: { canLogin: true, accessRoles: [role] },
  })),
  ...DEFAULT_ACCESS_ROLE_DEFINITIONS.map((definition) => ({
    label: `seeded definition ${definition.key}`,
    input: {
      canLogin: true,
      accessRoles: [
        {
          role: definition.systemRole,
          roleDefinitionId: definition.id,
          roleDefinition: definition,
        },
      ],
    } as PrivilegeCheckInput,
  })),
];

/** Every module on, every module off, and each module off on its own. */
const FEATURE_SETS: Array<{ label: string; features: FeatureFlags }> = [
  { label: "all on", features: allOn },
  { label: "all off", features: allOff },
  ...MODULE_KEYS.map((key) => ({
    label: `${key} off`,
    features: { ...allOn, [key]: false } as FeatureFlags,
  })),
];

const pathnameOf = (href: string) => href.split(/[?#]/)[0]!;

describe("getAdminFeatureSearchIndex — it never offers a page that will not open", () => {
  it("covers every grid, enum role and seeded role", () => {
    expect(SUBJECTS.length).toBe(
      16 + Object.values(AccessRole).length + DEFAULT_ACCESS_ROLE_DEFINITIONS.length,
    );
    expect(DEFAULT_ACCESS_ROLE_DEFINITIONS.length).toBeGreaterThanOrEqual(6);
  });

  it("offers exactly the pages each subject may open, under every module setting", () => {
    const pageByHref = new Map(ADMIN_MENU_DESTINATIONS.map(({ page, href }) => [href, page]));
    /** The page an entry opens: a destination, or the page a retired name was merged into. */
    const pageOf = (entry: AdminFeatureSearchEntry): AdminHubPage | undefined => {
      const retired = ADMIN_RETIRED_PAGES.find(
        (candidate) =>
          candidate.label === entry.label && retiredAdminPageHref(candidate) === entry.href,
      );
      return retired ? getAdminPage(retired.mergedInto) : pageByHref.get(entry.href);
    };
    const failures: string[] = [];
    for (const subject of SUBJECTS) {
      const permissionMatrix = getAdminPermissionMatrix(subject.input);
      const fullAdmin = isFullAdmin(subject.input);
      for (const { label, features } of FEATURE_SETS) {
        const index = getAdminFeatureSearchIndex(CLUB_DAY, features, permissionMatrix, fullAdmin);
        const offered = hrefs(index);
        const who = `${subject.label}, ${label}`;
        for (const entry of index) {
          const { href } = entry;
          const page = pageOf(entry);
          if (!canOpenAdminPath(subject.input, href)) failures.push(`${who}: ${href} refused`);
          if (getDisabledFeatureForPath(pathnameOf(href), features) !== null) {
            failures.push(`${who}: ${href} module off`);
          }
          if (page && page.flags.some((flag) => features[flag] !== true)) {
            failures.push(`${who}: ${href} needs ${page.flags.join("+")}`);
          }
          if (page?.fullAdminOnly && !fullAdmin) failures.push(`${who}: ${href} is Full Admin only`);
          if (!page && !QUEUE_VIEW_HREFS.has(href)) failures.push(`${who}: ${href} is not a destination`);
        }
        // Nothing the subject may open is withheld (the census half, per subject).
        for (const { page, href } of ADMIN_MENU_DESTINATIONS) {
          const opens =
            canOpenAdminPath(subject.input, href) &&
            getDisabledFeatureForPath(href, features) === null &&
            (!page.fullAdminOnly || fullAdmin);
          if (opens && !offered.has(href)) failures.push(`${who}: ${href} withheld`);
          // A retired name is offered exactly when the page holding it is.
          for (const retired of ADMIN_RETIRED_PAGES.filter((r) => r.mergedInto === page.id)) {
            const named = index.some(
              (entry) => entry.label === retired.label && entry.href === retiredAdminPageHref(retired),
            );
            if (named !== offered.has(href)) failures.push(`${who}: ${retired.label} ${named ? "offered" : "withheld"} unlike ${page.id}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
    // A sweep of every subject and module setting: about 3s alone, past the 5s
    // default when its shard runs beside other suites.
  }, 30_000);

  it("fails closed: no permission matrix yields an EMPTY index", () => {
    expect(getAdminFeatureSearchIndex(CLUB_DAY, allOn, undefined, true)).toEqual([]);
    expect(getAdminFeatureSearchIndex(CLUB_DAY, allOn, undefined, false)).toEqual([]);
  });

  it("offers a plain member's empty matrix nothing", () => {
    expect(getAdminFeatureSearchIndex(CLUB_DAY, allOn, matrix({}), false)).toEqual([]);
  });

  it("hides every Full Admin page from support:edit without Full Admin", () => {
    const supportEditor = matrix({ support: "edit" });
    const asOfficer = hrefs(getAdminFeatureSearchIndex(CLUB_DAY, allOn, supportEditor, false));
    const asFullAdmin = hrefs(getAdminFeatureSearchIndex(CLUB_DAY, allOn, supportEditor, true));
    const fullAdminOnly = ADMIN_MENU_DESTINATIONS.filter(({ page }) => page.fullAdminOnly);
    expect(fullAdminOnly.map(({ page }) => page.id).sort()).toEqual([
      "access-roles",
      "club-time",
      "config-transfer",
      "environment",
    ]);
    for (const { href } of fullAdminOnly) {
      expect(asOfficer.has(href), href).toBe(false);
      expect(asFullAdmin.has(href), href).toBe(true);
    }
  });

  it("follows the OR admissions: the fee console and Rooms & Beds", () => {
    const offered = (over: Parameters<typeof matrix>[0]) =>
      hrefs(getAdminFeatureSearchIndex(CLUB_DAY, allOn, matrix(over), false));
    expect(offered({ finance: "view" }).has(adminHref("fees"))).toBe(true);
    expect(offered({ membership: "view" }).has(adminHref("fees"))).toBe(false);
    expect(offered({ bookings: "view" }).has(adminHref("rooms-beds"))).toBe(true);
    expect(offered({ lodge: "view" }).has(adminHref("rooms-beds"))).toBe(true);
    expect(offered({ finance: "view" }).has(adminHref("rooms-beds"))).toBe(false);
  });

  it("offers any admin the any-admin pages, and no one else", () => {
    expect(
      hrefs(getAdminFeatureSearchIndex(CLUB_DAY, allOn, matrix({ content: "view" }), false)).has(
        adminHref("club-format"),
      ),
    ).toBe(true);
  });

  it("drops a disabled module's pages and keeps its setup wizard (#2249)", () => {
    const off = hrefs(fullAdminIndex({ ...allOn, lobbyDisplay: false } as FeatureFlags));
    expect(off.has(adminHref("display"))).toBe(false);
    expect(off.has(adminHref("display-templates"))).toBe(false);
    expect(off.has(adminHref("display-setup"))).toBe(true);

    const xeroOff = hrefs(fullAdminIndex({ ...allOn, xeroIntegration: false } as FeatureFlags));
    expect(xeroOff.has(adminHref("xero"))).toBe(false);
    expect(xeroOff.has(adminHref("xero-setup"))).toBe(false);
    expect(xeroOff.has(adminHref("internet-banking"))).toBe(false);

    const diagnosticsOff = hrefs(fullAdminIndex({ ...allOn, aiDiagnostics: false } as FeatureFlags));
    expect(diagnosticsOff.has(adminHref("ai-diagnostics"))).toBe(false);
    expect(diagnosticsOff.has(adminHref("ai-assistant"))).toBe(true);
  });
});

describe("the census reads the tree it claims to", () => {
  it("classifies display/preview as a page that needs its query", () => {
    const file = adminPageFiles.find((candidate) => toRawPathname(candidate) === "/admin/display/preview");
    expect(file).toBeDefined();
    expect(fs.readFileSync(file!, "utf8")).toMatch(/No template to preview/);
    expect(path.basename(file!)).toBe("page.tsx");
  });
});
