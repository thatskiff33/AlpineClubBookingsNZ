import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminHubPage } from "@/lib/admin-hubs/define";
import { stripComments } from "@/lib/__tests__/support/strip-comments";

// ---------------------------------------------------------------------------
// `revalidateAdminPage(id)` (epic #4468, C3 #4800): which path each page is
// revalidated at, before and after it moves, in both switch states, and the
// census that no production code revalidates an admin page any other way.
//
// Why one path and not two is in `admin-page-revalidation.ts`: Next tags a page
// with the path of the file that rendered it, which is the rewrite's
// destination, so the moved page's old URL names no cache entry.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

/**
 * The revalidation module, loaded fresh over a registry in which `movedHubs`
 * have moved and the switch reads `live`. Only the hub fragments and the switch
 * are replaced; the registry and the module are the real code.
 */
async function loadWith(live: boolean, movedHubs: readonly string[]) {
  vi.resetModules();
  vi.doMock("@/lib/admin-hubs/release", () => ({ ADMIN_HUBS_LIVE: live }));
  for (const hub of ["finance", "members", "system", "settings", "bookings", "dashboard"]) {
    vi.doMock(`@/lib/admin-hubs/hubs/${hub}`, async (importOriginal) => {
      const original = await importOriginal<Record<string, { pages: { moved: boolean }[] }>>();
      const moved = movedHubs.includes(hub);
      return Object.fromEntries(
        Object.entries(original).map(([name, fragment]) => [
          name,
          { ...fragment, pages: fragment.pages.map((page) => ({ ...page, moved })) },
        ]),
      );
    });
  }
  const revalidation = await import("@/lib/admin-page-revalidation");
  const registry = await import("@/lib/admin-hubs");
  return { ...revalidation, registry };
}

/** Every page id the routes revalidate today, and the path each must be refreshed at. */
const CALLED = [
  ["payments", "/admin/payments", "/admin/finance/payments"],
  ["subscriptions", "/admin/subscriptions", "/admin/finance/subscriptions"],
  ["stuck-states", "/admin/stuck-states", "/admin/system/stuck-states"],
  ["setup", "/admin/setup", "/admin/settings/setup"],
  ["setup-finance", "/admin/setup/finance", "/admin/settings/setup/finance"],
  ["bookings", "/admin/bookings", "/admin/booking-desk/bookings"],
  // Home's dashboard is its hub's root, so moving it changes nothing.
  ["dashboard", "/admin/dashboard", "/admin/dashboard"],
] as const;

describe("revalidateAdminPage", () => {
  beforeEach(() => {
    mocks.revalidatePath.mockReset();
    vi.doUnmock("@/lib/admin-hubs/release");
  });

  it.each([false, true])(
    "revalidates each static page at its OLD path before it moves (live=%s)",
    async (live) => {
      const { revalidateAdminPage } = await loadWith(live, []);
      for (const [id, oldPath] of CALLED) {
        mocks.revalidatePath.mockReset();
        revalidateAdminPage(id);
        expect(mocks.revalidatePath.mock.calls).toEqual([[oldPath]]);
      }
    },
  );

  it.each([false, true])(
    "revalidates each static page at its HUB path once it moves, whatever the switch says (live=%s)",
    async (live) => {
      const { revalidateAdminPage } = await loadWith(live, [
        "finance",
        "system",
        "settings",
        "bookings",
        "dashboard",
      ]);
      for (const [id, , hubPath] of CALLED) {
        mocks.revalidatePath.mockReset();
        revalidateAdminPage(id);
        // Exactly one call: the old URL is a rewrite's source, which no cache
        // entry is tagged with, so revalidating it too would do nothing.
        expect(mocks.revalidatePath.mock.calls).toEqual([[hubPath]]);
      }
    },
  );

  it.each([false, true])(
    "revalidates the member page by its file pattern, route group included, at either place (live=%s)",
    async (live) => {
      const before = await loadWith(live, []);
      before.revalidateAdminPage("member-detail");
      expect(mocks.revalidatePath.mock.calls).toEqual([["/(admin)/admin/members/[id]", "page"]]);

      mocks.revalidatePath.mockReset();
      const after = await loadWith(live, ["members"]);
      after.revalidateAdminPage("member-detail");
      expect(mocks.revalidatePath.mock.calls).toEqual([
        ["/(admin)/admin/membership/members/[id]", "page"],
      ]);
    },
  );

  it("names a page file on disk for every registered page, before and after it moves", async () => {
    const { adminPageRevalidationTarget, registry } = await loadWith(false, []);
    const fileFor = ([target, type]: readonly [string, ("page" | undefined)?]) =>
      type === "page"
        ? path.join("src", "app", `.${target}`, "page.tsx")
        : path.join("src", "app", "(admin)", `.${target}`, "page.tsx");
    const missing = registry.ADMIN_PAGES.map((page) => fileFor(adminPageRevalidationTarget(page)))
      .filter((file) => !fs.existsSync(file));
    expect(missing).toEqual([]);

    // Moved, the target is the hub path's file: what C4–C12's `git mv` creates.
    const moved = (page: AdminHubPage) => ({ ...page, moved: true });
    for (const page of registry.ADMIN_PAGES) {
      const [target, type] = adminPageRevalidationTarget(moved(page));
      const expected = type === "page" ? `/(admin)${page.hubPath}` : page.hubPath;
      expect(target).toBe(expected);
      expect(type).toBe(page.hubPath.includes("[") ? "page" : undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// Census: no production code outside the revalidation module revalidates an
// admin page by path. A literal `/admin…` or `/(admin)…` argument is refused
// outright; any other non-literal argument must be one reviewed here, so an
// admin path cannot come back through a constant.
// ---------------------------------------------------------------------------

describe("no production code revalidates an admin page by path", () => {
  const ROOT = process.cwd();
  const OWNER = "src/lib/admin-page-revalidation.ts";
  /** Every non-literal first argument production code passes, and what it names. */
  const REVIEWED_ARGUMENTS: Record<string, string> = {
    BOOKING_DETAIL_ROUTE_PATTERN: "the member-side booking page, `/(authenticated)/bookings/[id]`",
    path: "the finance sync's loop over FINANCE_REVALIDATE_PATHS (`/finance`)",
  };

  function productionFiles(dir: string): string[] {
    return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        return entry.name === "__tests__" || entry.name === "node_modules" ? [] : productionFiles(rel);
      }
      return /\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [rel] : [];
    });
  }

  const CALL = /\brevalidatePath\(\s*([^,)]*)/g;

  function scan() {
    const literalAdmin: string[] = [];
    const unreviewed: string[] = [];
    let calls = 0;
    for (const file of productionFiles("src")) {
      if (file === OWNER) continue;
      const source = stripComments(fs.readFileSync(path.join(ROOT, file), "utf8"));
      for (const match of source.matchAll(CALL)) {
        calls += 1;
        const argument = match[1]!.trim();
        if (/^["'`]/.test(argument)) {
          if (/^["'`]\/(?:\(admin\)\/)?admin(?:[/"'`]|$)/.test(argument)) {
            literalAdmin.push(`${file}: revalidatePath(${argument}`);
          }
        } else if (!(argument in REVIEWED_ARGUMENTS)) {
          unreviewed.push(`${file}: revalidatePath(${argument}`);
        }
      }
    }
    return { literalAdmin, unreviewed, calls };
  }

  it("finds the calls it polices", () => {
    // Not vacuous: the tree still revalidates the root layout and the finance portal.
    expect(scan().calls).toBeGreaterThan(10);
  });

  it("refuses a literal admin path", () => {
    expect(scan().literalAdmin).toEqual([]);
  });

  it("refuses an unreviewed non-literal argument", () => {
    expect(scan().unreviewed).toEqual([]);
  });

  it("uses revalidateAdminPage at the sites that refresh admin pages", () => {
    const users = productionFiles("src").filter((file) =>
      /\brevalidateAdminPage\(\s*"/.test(fs.readFileSync(path.join(ROOT, file), "utf8")),
    );
    expect(users.length).toBeGreaterThanOrEqual(10);
  });
});
