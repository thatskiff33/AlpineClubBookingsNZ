import { expect, test } from "./helpers/accessibility";
import { storageStatePath } from "./helpers/auth";
import { E2E_ADMIN, WAITLISTER } from "./helpers/fixtures";

// High row (docs/END_TO_END_TEST_MATRIX.md): access-role *management* — the
// Full-Admin create → edit → assign → effect journey the seeded role-boundary
// spec (admin-roles.spec) does not cover. A custom (non-seeded) definition-backed
// role is created and edited on /admin/access-roles, assigned to a member from
// /admin/members/[id], and its effect is confirmed (the member's Access Roles
// badge + the role's holder count).
//
// E2E_ADMIN (the only Full Admin login) is required: scoped admins get 403 on
// access-role management. The role is assigned to Wanda: no spec asserts her
// access roles, and the app's owner-positive gating (#1303) means a scoped
// view-role never changes her own member-page behaviour in the specs that log
// in as her (IB, membership-application, waitlist).
test.describe.configure({ mode: "serial" });

// Reuse the E2E admin session saved once in auth.setup.ts instead of a fresh
// per-spec login (#1779).
test.use({ storageState: storageStatePath(E2E_ADMIN.email) });

// Run-unique so a manual re-run against a non-reseeded DB never collides on the
// role label. Reused for every locator/assertion below.
const roleLabel = `E2E Bookings Viewer ${Date.now()}`;

test("a full admin creates, edits, assigns a custom access role and sees the effect", async ({
  page,
}) => {
  // Generous timeout: the journey spans role create → edit → assign → verify
  // across several admin pages.
  test.setTimeout(180_000);

  // ── Create the role ──
  await page.goto("/admin/access-roles");
  await page.getByRole("button", { name: "New Role" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("New Access Role")).toBeVisible();
  await page.locator("#access-role-label").fill(roleLabel);
  await page
    .locator("#access-role-description")
    .fill("E2E-created role for the access-role management journey.");

  // Set the "Bookings & Beds" area permission to View (Radix Select — pick by
  // option text, not a native <select>). Each area row is a bordered card; the
  // Bookings & Beds one is unique by its label.
  await dialog
    .locator("div.rounded-md.border")
    .filter({ hasText: "Bookings & Beds" })
    .first()
    .getByRole("combobox")
    .click();
  await page.getByRole("option", { name: "View", exact: true }).click();

  await page.getByRole("button", { name: "Create Role" }).click();
  await expect(page.getByText("Access role created")).toBeVisible();

  // ── Edit the role ──
  const roleRow = page
    .locator("div.rounded-md.border")
    .filter({ hasText: roleLabel });
  await expect(roleRow).toBeVisible({ timeout: 30_000 });
  await roleRow.getByRole("button", { name: "Edit" }).click();

  await expect(dialog.getByText(`Edit ${roleLabel}`)).toBeVisible();
  await page
    .locator("#access-role-description")
    .fill("E2E-created role, description edited by the spec.");
  await page.getByRole("button", { name: "Save Changes" }).click();
  await expect(page.getByText("Access role updated")).toBeVisible();

  // ── Assign the role to Wanda ──
  // Resolve her member id by search (robust to members-list pagination), then
  // drive her member detail page directly.
  const membersRes = await page.request.get(
    `/api/admin/members?search=${encodeURIComponent(WAITLISTER.email)}`,
  );
  expect(
    membersRes.ok(),
    `GET /api/admin/members (${membersRes.status()})`,
  ).toBeTruthy();
  const membersBody = (await membersRes.json()) as {
    members?: Array<{ id: string; email: string }>;
  };
  const target = (membersBody.members ?? []).find(
    (member) => member.email === WAITLISTER.email,
  );
  expect(target?.id, "Wanda should exist as an admin-visible member").toBeTruthy();

  await page.goto(`/admin/members/${target!.id}`);
  await expect(page).toHaveURL(/\/admin\/members\/(?!$)[^/?#]+/);

  // Expand the Account & Access group (groups start collapsed), then scope every
  // interaction to that group's content REGION — its accessible name is the
  // trigger text (Radix AccordionContent is role="region" labelled by its
  // trigger). This mirrors the group idiom e2e/admin-member-detail.spec.ts drives
  // on this same page, and keeps the group's "Access Roles" dt, inline Edit, and
  // role badge from colliding with the admin sidebar's "Access Roles" nav link
  // or the other inline-edit groups' controls.
  await page.getByRole("button", { name: /Account & Access/ }).click();
  const accessGroup = page.getByRole("region", { name: /Account & Access/ });
  await expect(
    accessGroup.getByText("Access Roles", { exact: true }),
  ).toBeVisible();
  await accessGroup
    .getByRole("button", { name: "Edit", exact: true })
    .click();

  // Since #1439 the Access Roles picker sits behind the User Type select:
  // Wanda derives as a plain "User", so the picker (and the custom role's
  // checkbox) only appears once the type is switched to Admin. "Also a club
  // member" defaults on, so her USER token is kept alongside the new role.
  await accessGroup.getByRole("combobox", { name: "User Type" }).click();
  await page.getByRole("option", { name: "Admin", exact: true }).click();

  // Tick the new role's checkbox — scoped through its wrapping <label> (whose
  // text carries the unique role label) so the Radix checkbox resolves robustly.
  const roleCheckbox = accessGroup
    .locator("label")
    .filter({ hasText: roleLabel })
    .getByRole("checkbox");
  await expect(roleCheckbox).toBeVisible({ timeout: 30_000 });
  await roleCheckbox.click();
  await accessGroup.getByRole("button", { name: "Save Changes" }).click();
  await expect(page.getByText("Member updated successfully")).toBeVisible();

  // ── Effect ──
  // Back in display mode, the group's Access Roles value shows a badge for the
  // role (scoped to the group so it never matches a dialog/list remnant).
  await expect(accessGroup.getByText(roleLabel)).toBeVisible({
    timeout: 30_000,
  });

  // And the role now has exactly one holder (authenticated admin API — robust
  // vs a brittle UI count locator).
  const rolesRes = await page.request.get("/api/admin/access-roles");
  expect(rolesRes.ok(), `GET /api/admin/access-roles (${rolesRes.status()})`).toBeTruthy();
  const rolesBody = (await rolesRes.json()) as {
    roles?: Array<{ label: string; memberCount: number }>;
  };
  const created = (rolesBody.roles ?? []).find((role) => role.label === roleLabel);
  expect(created?.memberCount, "the created role should have one holder").toBe(1);
});
