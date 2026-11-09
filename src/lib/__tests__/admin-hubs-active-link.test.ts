import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import { getVisibleAdminNavSections } from "@/components/admin-sidebar";
import { requireCalendarDate } from "@/lib/club-time";
import { ADMIN_PAGES, activeAdminHref } from "@/lib/admin-hubs";
import type { AdminHubPage } from "@/lib/admin-hubs/define";
import { stripComments } from "@/lib/__tests__/support/strip-comments";

// ---------------------------------------------------------------------------
// The registry's `samePage()` for the sidebar (epic #4468, C3 #4800):
// `activeAdminHref` reads a moved page's old path and hub path as one page.
// `src/components/__tests__/admin-sidebar-active-link.test.tsx` renders the
// real sidebar over a moved hub; this file holds the function's own cases and
// the census that keeps the sidebar on it.
// ---------------------------------------------------------------------------

/** The sidebar's rule before C3, verbatim: the deepest href the pathname is at or under. */
function legacyActiveHref(pathname: string, hrefs: readonly string[]): string {
  return hrefs
    .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
    .reduce((best, href) => (href.length > best.length ? href : best), "");
}

const allOn = Object.fromEntries(MODULE_KEYS.map((key) => [key, true])) as FeatureFlags;

/** Every href the sidebar can render, the dated queue links included. */
const SIDEBAR_HREFS = getVisibleAdminNavSections(
  requireCalendarDate("2026-07-01"),
  allOn,
  undefined,
  true,
).flatMap((section) => section.items.map((item) => item.href));

/** Every page in a registry, moved. */
function allMoved(pages: readonly AdminHubPage[] = ADMIN_PAGES): AdminHubPage[] {
  return pages.map((page) => ({ ...page, moved: true }));
}

const concrete = (registryPath: string) => registryPath.replace(/\[[^\]/]+\]/g, "x123");

describe("activeAdminHref while no page has moved", () => {
  it("PREMISE: no page has moved, and the sidebar has hrefs, query links among them", () => {
    expect(ADMIN_PAGES.some((page) => page.moved)).toBe(false);
    expect(SIDEBAR_HREFS.length).toBeGreaterThan(40);
    expect(SIDEBAR_HREFS.some((href) => href.includes("?"))).toBe(true);
  });

  it("answers exactly as the sidebar did before C3, for every page, path beneath it and hub path", () => {
    const pathnames = ADMIN_PAGES.flatMap((page) => [
      concrete(page.oldPath),
      `${concrete(page.oldPath)}/beneath`,
      concrete(page.hubPath),
    ]);
    pathnames.push("/admin", "/admin/", "/admin/nope", "/dashboard");
    const differ = pathnames.filter(
      (pathname) =>
        activeAdminHref(pathname, SIDEBAR_HREFS) !== legacyActiveHref(pathname, SIDEBAR_HREFS),
    );
    expect(differ).toEqual([]);
  });
});

describe("activeAdminHref over a moved registry", () => {
  const moved = allMoved();
  const page = (id: string) => moved.find((entry) => entry.id === id)!;

  it.each(ADMIN_PAGES.map((entry) => entry.id))(
    "reads %s's old URL and hub URL as one page, whichever the hrefs are written in",
    (id) => {
      const entry = page(id);
      const oldUrl = concrete(entry.oldPath);
      const hubUrl = concrete(entry.hubPath);
      for (const href of [oldUrl, hubUrl]) {
        expect(activeAdminHref(oldUrl, [href], moved)).toBe(href);
        expect(activeAdminHref(hubUrl, [href], moved)).toBe(href);
        expect(activeAdminHref(`${hubUrl}/beneath`, [href], moved)).toBe(href);
      }
    },
  );

  it("maps a dynamic hub path back through its segments, with what lies beneath it", () => {
    // `/admin/membership/members/[id]/merge` is the hub path of `/admin/members/[id]/merge`.
    expect(page("member-merge").hubPath).toBe("/admin/membership/members/[id]/merge");
    expect(
      activeAdminHref("/admin/membership/members/m-7/merge", ["/admin/members/m-7/merge"], moved),
    ).toBe("/admin/members/m-7/merge");
    expect(activeAdminHref("/admin/membership/members/m-7", ["/admin/members"], moved)).toBe(
      "/admin/members",
    );
    // A different record is a different page.
    expect(
      activeAdminHref("/admin/membership/members/m-8/merge", ["/admin/members/m-7/merge"], moved),
    ).toBe("");
  });

  it("still picks the deepest link, measured as one page however each href is written", () => {
    const hrefs = ["/admin/finance/xero", "/admin/xero/member-grouping", "/admin/xero"];
    expect(activeAdminHref("/admin/finance/xero/member-grouping", hrefs, moved)).toBe(
      "/admin/xero/member-grouping",
    );
    // The two spellings of Xero Sync tie; the first listed wins, as before.
    expect(activeAdminHref("/admin/xero", hrefs, moved)).toBe("/admin/finance/xero");
  });

  it("never lights a query link, as before", () => {
    const href = "/admin/bookings?unpaid=finished&checkOutTo=2026-07-01";
    expect(activeAdminHref("/admin/booking-desk/bookings", [href], moved)).toBe("");
    expect(activeAdminHref("/admin/bookings", [href], moved)).toBe("");
  });

  it("lights nothing at a hub root, which is no page (C13), nor at a prefix lookalike", () => {
    expect(activeAdminHref("/admin/finance", SIDEBAR_HREFS, moved)).toBe("");
    expect(activeAdminHref("/admin/finance-x/payments", ["/admin/payments"], moved)).toBe("");
  });

  it("reads only MOVED pages: an unmoved page's hub path is served by nothing", () => {
    const onlyFinance = ADMIN_PAGES.map((entry) => ({
      ...entry,
      moved: entry.hub === "finance",
    }));
    expect(activeAdminHref("/admin/finance/payments", ["/admin/payments"], onlyFinance)).toBe(
      "/admin/payments",
    );
    expect(activeAdminHref("/admin/membership/members", ["/admin/members"], onlyFinance)).toBe(
      "",
    );
  });
});

// ---------------------------------------------------------------------------
// Census: the sidebar's active state comes from the registry, never from a raw
// comparison of the pathname with an href.
// ---------------------------------------------------------------------------

describe("no admin active-state check compares raw hrefs", () => {
  const ROOT = process.cwd();
  const read = (file: string) => stripComments(fs.readFileSync(path.join(ROOT, file), "utf8"));

  it("the sidebar reads usePathname() once and hands it only to activeAdminHref", () => {
    const source = read("src/components/admin-sidebar.tsx");
    expect(source).toMatch(/const pathname = usePathname\(\);/);
    expect(source).toMatch(/activeAdminHref\(\s*pathname,/);
    const rest = source
      .replace(/const pathname = usePathname\(\);/, "")
      .replace(/activeAdminHref\(\s*pathname,/, "");
    expect(rest).not.toMatch(/\bpathname\b/);
  });

  it("no admin component compares a pathname with a literal admin page path", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__" && entry.name !== "node_modules") walk(rel);
        } else if (/\.tsx?$/.test(entry.name)) {
          files.push(rel);
        }
      }
    };
    walk("src/components");
    walk("src/app/(admin)");
    expect(files.length).toBeGreaterThan(200);
    // `pathname === "/admin/x"`, `"/admin/x" === pathname`, `pathname.startsWith("/admin/x")`.
    const RAW =
      /\b[pP]athname\s*[!=]==\s*["'`]\/admin\/|["'`]\/admin\/[^"'`]*["'`]\s*[!=]==\s*\w*[pP]athname\b|\b[pP]athname\??\.startsWith\(\s*["'`]\/admin\//;
    const offenders = files.filter((file) => RAW.test(read(file)));
    expect(offenders).toEqual([]);
  });
});
