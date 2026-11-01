import { expect, test } from "./helpers/accessibility";
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

test("read-only admin views every area but cannot write", async ({
  page,
}) => {
  await loginPersona(page, ROLE_PERSONAS.ADMIN_READONLY.email);

  // In-area: every admin area is view-level, so admin pages render.
  await page.goto("/admin/members");
  await expect(page).toHaveURL(/\/admin\/members/);
  await page.goto("/admin/bookings");
  await expect(page).toHaveURL(/\/admin\/bookings/);

  // Since the editable access-roles change (#1184), ADMIN_READONLY carries
  // finance: view, so the /finance workspace renders read-only rather than
  // bouncing. The boundary that defines this role is edit, not area: a
  // membership write is refused even though the membership pages render.
  await page.goto("/finance");
  await expect(page).toHaveURL(/\/finance/);
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
  await page.goto("/admin/bookings");
  await expect(page).toHaveURL(/\/admin\/bookings/);

  // Out-of-area: content = none → redirected to the overview dashboard.
  await page.goto("/admin/page-content");
  await expect(page).toHaveURL(/\/admin\/dashboard/);
});

test("membership officer manages members but is blocked from content", async ({
  page,
}) => {
  await loginPersona(page, ROLE_PERSONAS.ADMIN_MEMBERSHIP.email);

  // In-area: membership = edit.
  await page.goto("/admin/members");
  await expect(page).toHaveURL(/\/admin\/members/);

  // Out-of-area: content = none → redirected to the overview dashboard.
  await page.goto("/admin/page-content");
  await expect(page).toHaveURL(/\/admin\/dashboard/);
});

test("content manager edits content but is blocked from membership", async ({
  page,
}) => {
  await loginPersona(page, ROLE_PERSONAS.ADMIN_CONTENT.email);

  // In-area: content = edit.
  await page.goto("/admin/page-content");
  await expect(page).toHaveURL(/\/admin\/page-content/);

  // Out-of-area: membership = none, overview = view → redirected to dashboard.
  await page.goto("/admin/members");
  await expect(page).toHaveURL(/\/admin\/dashboard/);
});

test("treasurer edits finance but is blocked from content", async ({ page }) => {
  await loginPersona(page, ROLE_PERSONAS.FINANCE_ADMIN.email);

  // In-area: finance = edit (admin finance pages).
  await page.goto("/admin/payments");
  await expect(page).toHaveURL(/\/admin\/payments/);
  // FINANCE_ADMIN is a finance manager, so the /finance workspace is reachable.
  await page.goto("/finance");
  await expect(page).toHaveURL(/\/finance/);

  // Out-of-area: content = none → redirected to the overview dashboard.
  await page.goto("/admin/page-content");
  await expect(page).toHaveURL(/\/admin\/dashboard/);
});

test("finance-only viewer reaches Subscriptions without member links", async ({
  page,
}) => {
  await loginPersona(page, ROLE_PERSONAS.FINANCE_USER.email);

  // In-area: FINANCE_USER carries only finance:view, so the dedicated finance
  // workspace is available without granting another admin area.
  await page.goto("/finance");
  await expect(page).toHaveURL(/\/finance/);

  // Subscriptions is finance-readable, but member detail is membership-gated.
  // FINANCE_USER is the bundled finance-only boundary: it can read this table
  // while each member stays plain text with no local member route.
  await page.goto("/admin/subscriptions");
  await expect(page).toHaveURL(/\/admin\/subscriptions/);
  await expect(page.getByRole("table", { name: "Subscriptions" })).toBeVisible();
  await expect(page.locator('a[href^="/admin/members/"]')).toHaveCount(0);
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
  await page.goto("/admin/members");
  await expect(page).toHaveURL(/\/admin\/payments/);
});

test("lodge role reaches lodge operations but no admin portal", async ({
  page,
}) => {
  await loginPersona(page, ROLE_PERSONAS.LODGE.email);

  // In-area: the kiosk landing.
  await page.goto("/lodge/kiosk");
  await expect(page).toHaveURL(/\/lodge\/kiosk/);

  // Lodge-distinguishing surface: the roster wizard's layout redirects a
  // NON-lodge member to the kiosk, so staying on /lodge/roster proves the
  // LODGE access role specifically (any member can reach the kiosk). A relative
  // future in-season date (issue #2117) keeps the roster page valid on any run.
  await page.goto(`/lodge/roster/${relDateOnly(30)}/setup`);
  await expect(page).toHaveURL(/\/lodge\/roster\//);

  // Out-of-area: LODGE carries no admin bundle → admin pages bounce away.
  await page.goto("/admin/members");
  await expect(page).toHaveURL(/\/dashboard/);
});
