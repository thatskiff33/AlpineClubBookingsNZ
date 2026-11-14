import type { Browser, BrowserContext, Page } from "@playwright/test";

import { expect, test } from "./helpers/accessibility";
import { adminHref, adminUrlPattern } from "./helpers/admin-url";
import { loginPersona, storageStatePath } from "./helpers/auth";
import { E2E_ADMIN, ROLE_PERSONAS } from "./helpers/fixtures";
import {
  ADMIN_HUBS,
  ADMIN_PAGES,
  ADMIN_RETIRED_PAGES,
  resolveAdminHref,
  retiredAdminPageHref,
} from "@/lib/admin-hubs";
import { ADMIN_HUBS_LIVE } from "@/lib/admin-hubs/release";
import { SEEDED_ROLE_HUB_LABELS } from "@/lib/__tests__/support/admin-menu-role-hubs";

// The admin hubs, switched on (epic #4468, C17 #4814): the moved and retired
// pages' redirects, the role menu and its switcher, Preview as role, and the
// command palette. Every expectation is read from the hub registry, never
// written by hand.
//
// The hub URLs exist only once `ADMIN_HUBS_LIVE` is true, so this file is
// skipped until C18 (#4815) flips the switch; that PR is where it first runs.
// Before the flip the specs that expect admin URLs pass through
// `adminUrlPattern(adminHref(…))`, which answers the old URLs.
test.skip(
  !ADMIN_HUBS_LIVE,
  "Admin hubs are off: runs once C18 (#4815) sets ADMIN_HUBS_LIVE",
);

// No serial group: nothing here hands state to the next test, so one failure
// must not hide the rest (the first run, at C18, is the one that needs every
// result). The two-role test sets its own roles and restores them in `finally`.

// A private login bucket for E2E_ADMIN, the most shared login in the suite
// (see submitLoginForm). Outside syntheticClientIp's 10.99.0.0/16.
const ADMIN_GRANT_IP = "10.48.14.1";

/** A redirect's target, resolved against any origin, for comparison by part. */
function target(location: string): URL {
  return new URL(location, "http://hubs.invalid");
}

/** The hub links the sidebar shows, as the C14 role menu renders them. */
function hubLinks(page: Page) {
  return page
    .getByRole("navigation", { name: "Admin sections" })
    .getByRole("link");
}

/** A seeded role's hub labels, as C14's unit test pins them. */
function hubsFor(role: string): string[] {
  const labels = SEEDED_ROLE_HUB_LABELS[role];
  if (!labels) throw new Error(`no seeded hub row for ${role}`);
  return [...labels];
}

async function adminSession(browser: Browser) {
  return browser.newContext({ storageState: storageStatePath(E2E_ADMIN.email) });
}

/** Every static, menu-listed page whose directory has moved under its hub. */
const MOVED_PAGES = ADMIN_PAGES.filter(
  (entry) => entry.moved && entry.kind === "page" && !entry.oldPath.includes("["),
);

test.describe("old addresses redirect once to the hubs", () => {
  test.use({ storageState: storageStatePath(E2E_ADMIN.email) });

  // Home's dashboard keeps its URL, so it has no moved page to find. A hub with
  // none at all would leave its pages unchecked, so each one is named.
  for (const hub of ADMIN_HUBS.filter((entry) => entry.key !== "dashboard")) {
    test(`${hub.label} has a moved page to check`, () => {
      expect(
        MOVED_PAGES.some((entry) => entry.hub === hub.key),
        `${hub.label} has no moved static page: every hub's pages move before the switch`,
      ).toBe(true);
    });
  }

  // Every static, menu-listed page whose directory has moved (#4814 section 5).
  for (const moved of MOVED_PAGES) {
    test(`${moved.oldPath} answers 307 to its hub path, query kept`, async ({
      page,
    }) => {
      const oldHref = resolveAdminHref(moved, false);
      const hubHref = resolveAdminHref(moved, true);
      expect(hubHref).not.toBe(oldHref);

      const res = await page.request.get(`${oldHref}?hub=1`, { maxRedirects: 0 });
      expect(res.status(), `${oldHref} should redirect`).toBe(307);
      const location = target(res.headers()["location"] ?? "");
      expect(location.pathname).toBe(hubHref);
      expect(location.searchParams.get("hub")).toBe("1");

      const landed = await page.request.get(`${hubHref}?hub=1`, { maxRedirects: 0 });
      const again = landed.headers()["location"];
      expect(
        again === undefined || !target(again).pathname.startsWith("/admin"),
        `${oldHref} chained to ${again}`,
      ).toBe(true);
    });
  }

  for (const retired of ADMIN_RETIRED_PAGES) {
    test(`retired ${retired.oldPath} lands on its merged page in one hop`, async ({
      page,
    }) => {
      const expected = target(retiredAdminPageHref(retired, true));

      const res = await page.request.get(`${retired.oldPath}?hub=1`, {
        maxRedirects: 0,
      });
      expect(res.status(), `${retired.oldPath} should redirect`).toBe(307);
      const location = target(res.headers()["location"] ?? "");
      expect(location.pathname).toBe(expected.pathname);
      for (const [key, value] of expected.searchParams) {
        expect(location.searchParams.get(key), `?${key}`).toBe(value);
      }
      expect(location.searchParams.get("hub")).toBe("1");
      // A fragment, when the merged page names a section, may or may not
      // survive the Location header; it is never a different one.
      expect(["", expected.hash]).toContain(location.hash);

      const next = await page.request.get(`${location.pathname}${location.search}`, {
        maxRedirects: 0,
      });
      const again = next.headers()["location"];
      expect(
        again === undefined || !target(again).pathname.startsWith("/admin"),
        `${retired.oldPath} chained to ${again}`,
      ).toBe(true);
    });
  }
});

test.describe("the role menu", () => {
  test("a Full Admin sees every hub and no role switcher", async ({ browser }) => {
    const context = await adminSession(browser);
    try {
      const page = await context.newPage();
      await page.goto(adminHref("dashboard"));
      await expect(hubLinks(page)).toHaveText(hubsFor("ADMIN"));
      await expect(page.getByRole("combobox", { name: "Show menu for" })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  // LODGE holds no admin area, so it has no admin menu (admin-roles.spec).
  const personas = (Object.keys(ROLE_PERSONAS) as (keyof typeof ROLE_PERSONAS)[]).filter(
    (role) => role !== "LODGE",
  );
  for (const role of personas) {
    test(`the ${role} officer sees exactly that role's hubs`, async ({ page }) => {
      await loginPersona(page, ROLE_PERSONAS[role].email);
      await page.goto(adminHref("dashboard"));
      // FINANCE_USER has no Home; the layout sends it to its first page.
      await expect(hubLinks(page)).toHaveText(hubsFor(role));
      // One menu role: nothing to switch between.
      await expect(page.getByRole("combobox", { name: "Show menu for" })).toHaveCount(0);
    });
  }

  test("an officer with two roles switches between their menus", async ({
    browser,
    page,
  }) => {
    test.setTimeout(120_000);
    const treasurer = ROLE_PERSONAS.FINANCE_ADMIN;
    // Opened inside the try, so a failed lookup still closes it and puts the
    // Treasurer's roles back; each retry starts from the seeded roles.
    let adminContext: BrowserContext | undefined;
    let restoreRoles: (() => Promise<void>) | undefined;
    try {
      adminContext = await browser.newContext();
      const adminPage = await adminContext.newPage();
      // A fresh sign-in, so the role writes pass any recent-authentication check.
      await loginPersona(adminPage, E2E_ADMIN.email, ADMIN_GRANT_IP);

      const search = await adminPage.request.get(
        `/api/admin/members?search=${encodeURIComponent(treasurer.email)}`,
      );
      expect(search.ok(), `member search (${search.status()})`).toBeTruthy();
      const { members = [] } = (await search.json()) as {
        members?: Array<{ id: string; email: string }>;
      };
      const memberId = members.find((member) => member.email === treasurer.email)?.id;
      expect(memberId, "the seeded Treasurer").toBeTruthy();

      const detail = await adminPage.request.get(`/api/admin/members/${memberId}`);
      expect(detail.ok(), `member detail (${detail.status()})`).toBeTruthy();
      const { accessRoles = [] } = (await detail.json()) as { accessRoles?: string[] };
      // Without Content Manager, whatever an earlier run left behind.
      const seeded = accessRoles.filter((token) => token !== "ADMIN_CONTENT");

      const setRoles = async (tokens: string[]) => {
        const res = await adminPage.request.put(`/api/admin/members/${memberId}`, {
          data: { accessRoles: tokens },
        });
        expect(res.ok(), `set roles ${tokens.join(",")}: ${await res.text()}`).toBeTruthy();
      };
      restoreRoles = () => setRoles(seeded);

      await setRoles([...seeded, "ADMIN_CONTENT"]);
      await loginPersona(page, treasurer.email);
      await page.goto(adminHref("dashboard"));
      const switcher = page.getByRole("combobox", { name: "Show menu for" });

      await switcher.click();
      await page.getByRole("option", { name: "Content Manager", exact: true }).click();
      await expect(hubLinks(page)).toHaveText(hubsFor("ADMIN_CONTENT"));
      await expect(hubLinks(page).filter({ hasText: "Website" })).toHaveCount(1);
      await expect(hubLinks(page).filter({ hasText: "Finance" })).toHaveCount(0);

      await switcher.click();
      await page.getByRole("option", { name: "Treasurer", exact: true }).click();
      await expect(hubLinks(page)).toHaveText(hubsFor("FINANCE_ADMIN"));
      await expect(hubLinks(page).filter({ hasText: "Finance" })).toHaveCount(1);
      await expect(hubLinks(page).filter({ hasText: "Website" })).toHaveCount(0);
    } finally {
      try {
        await restoreRoles?.();
      } finally {
        await adminContext?.close();
      }
    }
  });
});

// Preview as role (C15 #4812) has not been built: there is no preview control,
// banner or route to drive yet. The spec is written with C15, against the
// accessible names it renders: start preview as Content Manager, open
// adminHref("club-identity"), a PUT to /api/admin/club-identity is refused,
// the Edit button is view-only, and Exit restores it.
test.fixme("Preview as role is view-only, and Exit restores editing", () => {});

test.describe("the command palette", () => {
  async function openPalette(page: Page) {
    const dialog = page.getByRole("dialog", { name: "Search admin features" });
    // The shortcut listener attaches on hydration; retry until it answers.
    await expect(async () => {
      if (!(await dialog.isVisible())) {
        await page.keyboard.press("ControlOrMeta+k");
      }
      await expect(dialog).toBeVisible({ timeout: 1_000 });
    }).toPass();
    return dialog;
  }

  test("a Full Admin finds Page Content and lands on it", async ({ browser }) => {
    const context = await adminSession(browser);
    try {
      const page = await context.newPage();
      await page.goto(adminHref("dashboard"));
      const dialog = await openPalette(page);
      await dialog.getByPlaceholder("Search admin features…").fill("Page Content");
      await dialog.getByRole("option", { name: "Page Content", exact: true }).click();
      await expect(page).toHaveURL(adminUrlPattern(adminHref("page-content")));
    } finally {
      await context.close();
    }
  });

  test("a Content Manager is offered no finance page", async ({ page }) => {
    await loginPersona(page, ROLE_PERSONAS.ADMIN_CONTENT.email);
    await page.goto(adminHref("dashboard"));
    const dialog = await openPalette(page);
    await dialog.getByPlaceholder("Search admin features…").fill("Payments");
    await expect(dialog.getByText("No matching admin pages.")).toBeVisible();
    await expect(dialog.getByRole("option")).toHaveCount(0);
  });
});
