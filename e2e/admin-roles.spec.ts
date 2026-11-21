import { expect, test, type Locator, type Page } from "./helpers/accessibility";
import { getAdminPage } from "@/lib/admin-hubs";
import { adminHref, adminUrlPattern } from "./helpers/admin-url";
import { loginPersona } from "./helpers/auth";
import { relDateOnly, ROLE_PERSONAS } from "./helpers/fixtures";

// High row (docs/END_TO_END_TEST_MATRIX.md): "Role boundaries for full admin,
// read-only admin, booking officer, membership officer, Treasurer, content
// manager, finance viewer, and lodge kiosk."
//
// Each persona holds exactly one bundled access role (see prisma/demo-seed.ts +
// src/lib/access-roles.ts). The expectations below come straight from the
// authoritative area matrix in src/lib/admin-permissions.ts (ADMIN_ROLE_BUNDLES)
// and the /finance (finance-auth) and /lodge (kiosk) gates — not invented.
//
// The admin layout redirects an out-of-area request to the persona's first
// accessible admin page (getFirstAccessibleAdminHref) or /dashboard, so a URL
// that stays put == access granted and a URL that moves == blocked. Each test
// gets a clean browser context (no shared storageState) and signs in fresh,
// completing forced two-factor enrollment on the way (the module is global in
// this env).

test.describe.configure({ mode: "serial" });

// The accessibility fixture audits the page a test is leaving, at the next
// navigation and at teardown, so each page is settled before the test moves on
// (#5155): after its URL is asserted, the page's own content in place of the
// loading skeleton, and a non-empty <title>. Without this the audit
// intermittently reported document-title on the Members page, most likely by
// racing its soft navigation.
async function expectSettled(page: Page, content: Locator) {
  await expect(page.locator("[data-route-loading]")).toHaveCount(0);
  await expect(content).toBeVisible();
  await expect(page).toHaveTitle(/\S/);
}

const membersTable = (page: Page) => page.getByRole("table", { name: "Members" });
const heading = (page: Page, name: string | RegExp) =>
  page.getByRole("heading", { level: 1, name });

test("read-only admin views every area but cannot write", async ({
  page,
}) => {
  await loginPersona(page, ROLE_PERSONAS.ADMIN_READONLY.email);

  // In-area: every admin area is view-level, so admin pages render.
  await page.goto(adminHref("members"));
  await expect(page).toHaveURL(adminUrlPattern(adminHref("members")));
  await expectSettled(page, membersTable(page));
  await page.goto(adminHref("bookings"));
  await expect(page).toHaveURL(adminUrlPattern(adminHref("bookings")));
  await expectSettled(page, heading(page, getAdminPage("bookings").label));

  // Since the editable access-roles change (#1184), ADMIN_READONLY carries
  // finance: view, so the /finance workspace renders read-only rather than
  // bouncing. The boundary that defines this role is edit, not area: a
  // membership write is refused even though the membership pages render.
  await page.goto("/finance");
  await expect(page).toHaveURL(/\/finance/);
  await expectSettled(page, heading(page, /finance workspace/));
  // In-page fetch so the write carries the browser's full request context.
  // The members route deliberately maps forbidden -> 401 "Unauthorized"
  // (adminGuardOptions.forbiddenResponse override in
  // src/app/api/admin/members/route.ts), so a refused write is 401 here, not
  // the guard's default 403. Either way: view-only cannot create members.
  const write = await page.evaluate(async () => {
    const res = await fetch("/api/admin/members", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ firstName: "Blocked", lastName: "Write" }),
    });
    return { status: res.status, body: await res.text() };
  });
  expect(write.status, `write response: ${write.body}`).toBe(401);
  expect(write.body).toContain("Unauthorized");
});

test("booking officer manages bookings but is blocked from content", async ({
  page,
}) => {
  await loginPersona(page, ROLE_PERSONAS.ADMIN_BOOKINGS.email);

  // In-area: bookings = edit.
  await page.goto(adminHref("bookings"));
  await expect(page).toHaveURL(adminUrlPattern(adminHref("bookings")));
  await expectSettled(page, heading(page, getAdminPage("bookings").label));

  // Out-of-area: content = none → redirected to the overview dashboard.
  await page.goto(adminHref("page-content"));
  await expect(page).toHaveURL(adminUrlPattern(adminHref("dashboard")));
  await expectSettled(page, heading(page, "Admin Dashboard"));
});

test("membership officer manages members but is blocked from content", async ({
  page,
}) => {
  await loginPersona(page, ROLE_PERSONAS.ADMIN_MEMBERSHIP.email);

  // In-area: membership = edit.
  await page.goto(adminHref("members"));
  await expect(page).toHaveURL(adminUrlPattern(adminHref("members")));
  await expectSettled(page, membersTable(page));

  // Out-of-area: content = none → redirected to the overview dashboard.
  await page.goto(adminHref("page-content"));
  await expect(page).toHaveURL(adminUrlPattern(adminHref("dashboard")));
  await expectSettled(page, heading(page, "Admin Dashboard"));
});

test("content manager edits content but is blocked from membership", async ({
  page,
}) => {
  await loginPersona(page, ROLE_PERSONAS.ADMIN_CONTENT.email);

  // In-area: content = edit.
  await page.goto(adminHref("page-content"));
  await expect(page).toHaveURL(adminUrlPattern(adminHref("page-content")));
  await expectSettled(page, heading(page, "Page Content"));

  // Out-of-area: membership = none, overview = view → redirected to dashboard.
  await page.goto(adminHref("members"));
  await expect(page).toHaveURL(adminUrlPattern(adminHref("dashboard")));
  await expectSettled(page, heading(page, "Admin Dashboard"));
});

test("treasurer edits finance but is blocked from content", async ({ page }) => {
  await loginPersona(page, ROLE_PERSONAS.FINANCE_ADMIN.email);

  // In-area: finance = edit (admin finance pages).
  await page.goto(adminHref("payments"));
  await expect(page).toHaveURL(adminUrlPattern(adminHref("payments")));
  await expectSettled(page, heading(page, "Payments"));
  // FINANCE_ADMIN is a finance manager, so the /finance workspace is reachable.
  await page.goto("/finance");
  await expect(page).toHaveURL(/\/finance/);
  await expectSettled(page, heading(page, /finance workspace/));

  // Out-of-area: content = none → redirected to the overview dashboard.
  await page.goto(adminHref("page-content"));
  await expect(page).toHaveURL(adminUrlPattern(adminHref("dashboard")));
  await expectSettled(page, heading(page, "Admin Dashboard"));
});

test("finance-only viewer reaches Subscriptions without member links", async ({
  page,
}) => {
  await loginPersona(page, ROLE_PERSONAS.FINANCE_USER.email);

  // In-area: FINANCE_USER carries only finance:view, so the dedicated finance
  // workspace is available without granting another admin area.
  await page.goto("/finance");
  await expect(page).toHaveURL(/\/finance/);
  await expectSettled(page, heading(page, /finance workspace/));

  // Subscriptions is finance-readable, but member detail is membership-gated.
  // FINANCE_USER is the bundled finance-only boundary: it can read this table
  // while each member stays plain text with no local member route.
  await page.goto(adminHref("subscriptions"));
  await expect(page).toHaveURL(adminUrlPattern(adminHref("subscriptions")));
  await expectSettled(page, page.getByRole("table", { name: "Subscriptions" }));
  await expect(page.locator(`a[href^="${adminHref("members")}/"]`)).toHaveCount(0);
  const incrementalSync = page.getByRole("button", { name: "Incremental Sync" });
  const repairSync = page.getByRole("button", {
    name: "Repair Stale Linked Members",
  });
  await expect(incrementalSync).toBeDisabled();
  await expect(repairSync).toBeDisabled();
  await expect(incrementalSync).toHaveAttribute("aria-describedby", /.+/);
  await expect(repairSync).toHaveAttribute("aria-describedby", /.+/);
  await expect(
    page.getByText(
      "Your admin role can view this area but cannot make changes.",
      { exact: true },
    ),
  ).toHaveCount(2);

  // Since #1184, FINANCE_USER carries finance: view in the admin matrix, so
  // an out-of-area admin page bounces to its first accessible admin page (the
  // finance-area /admin/payments), not the member dashboard. The boundary
  // proven: it cannot reach the members area itself.
  await page.goto(adminHref("members"));
  await expect(page).toHaveURL(adminUrlPattern(adminHref("payments")));
  await expectSettled(page, heading(page, "Payments"));
});

test("lodge role reaches lodge operations but no admin portal", async ({
  page,
}) => {
  await loginPersona(page, ROLE_PERSONAS.LODGE.email);

  // In-area: the kiosk landing.
  await page.goto("/lodge/kiosk");
  await expect(page).toHaveURL(/\/lodge\/kiosk/);
  await expectSettled(page, page.getByRole("heading", { level: 1 }));

  // Lodge-distinguishing surface: the roster wizard's layout redirects a
  // NON-lodge member to the kiosk, so staying on /lodge/roster proves the
  // LODGE access role specifically (any member can reach the kiosk). A relative
  // future in-season date (issue #2117) keeps the roster page valid on any run.
  await page.goto(`/lodge/roster/${relDateOnly(30)}/setup`);
  await expect(page).toHaveURL(/\/lodge\/roster\//);
  await expectSettled(page, page.getByRole("heading", { level: 1 }));

  // Out-of-area: LODGE carries no admin bundle → admin pages bounce away.
  await page.goto(adminHref("members"));
  await expect(page).toHaveURL(/\/dashboard/);
  await expectSettled(page, heading(page, /Welcome back/));
});
