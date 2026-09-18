import { expect, test, type Page } from "@playwright/test";
import { loginPersona } from "./helpers/auth";
import { ROLE_PERSONAS } from "./helpers/fixtures";
import { personas } from "./helpers/personas";

// High row (docs/END_TO_END_TEST_MATRIX.md): "Member detail grouped layout
// and per-group inline editing." Drives the redesigned /admin/members/[id]:
// default-collapsed groups with header previews, cross-member expand/collapse
// persistence (admin-member-section:* localStorage), per-group inline edit
// with a group-scoped partial PUT, and the Xero header actions staying hidden
// while Xero is disconnected (the CI default — no Xero token is seeded).

test.describe.configure({ mode: "serial" });

async function openMemberDetail(page: Page, name: string) {
  await page.goto("/admin/members");
  // The table renders client-side after the members fetch; the demo seed fits
  // on page 1 sorted by name, so no search needed. Interacting before the
  // page settles (e.g. filling the search box right after goto) raced
  // hydration in CI and wiped the input, so the first interaction is this
  // auto-waited click. Locate by href+text rather than accessible name.
  const memberLink = page
    .locator('a[href*="/admin/members/"]')
    .filter({ hasText: name })
    .first();
  await expect(memberLink).toBeVisible({ timeout: 30_000 });
  await memberLink.click();
  await expect(page).toHaveURL(/\/admin\/members\/(?!$)[^/?#]+/);
}

test("member directory Open action lands read-only and keeps the name link", async ({
  page,
}) => {
  await loginPersona(page, ROLE_PERSONAS.ADMIN_MEMBERSHIP.email);
  await page.goto("/admin/members");

  const name = `${personas.booker.firstName} ${personas.booker.lastName}`;
  const row = page.getByRole("row").filter({ hasText: name }).first();
  const nameLink = row.getByRole("link", { name, exact: true });
  const openLink = row.getByRole("link", { name: `Open ${name}` });
  await expect(nameLink).toBeVisible({ timeout: 30_000 });
  await expect(openLink).toHaveAttribute("href", /\/admin\/members\/[^?]+\?returnTo=/);
  await expect(openLink).not.toHaveAttribute("href", /edit=true/);

  await openLink.focus();
  await expect(openLink).toBeFocused();
  await openLink.press("Enter");
  await expect(page).toHaveURL(/\/admin\/members\/(?!$)[^/?#]+\?returnTo=/);
  await expect(page.getByText("First Name", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save Changes" })).toHaveCount(0);
});

test("groups start collapsed, edit inline, and persist expansion across members", async ({
  page,
}) => {
  await loginPersona(page, ROLE_PERSONAS.ADMIN_MEMBERSHIP.email);

  await openMemberDetail(page, `${personas.booker.firstName} ${personas.booker.lastName}`);

  // Default collapsed: group triggers visible, group content unmounted.
  await expect(
    page.getByRole("button", { name: /Contact & Personal/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Lifecycle & Deletion/ }),
  ).toBeVisible();
  await expect(page.getByText("First Name", { exact: true })).toHaveCount(0);

  // Xero is not connected in the E2E environment: no Xero header actions.
  await expect(
    page.getByRole("button", { name: "More member actions" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Link to Xero/ })).toHaveCount(
    0,
  );

  // Expand Contact & Personal and edit the phone number inline.
  await page.getByRole("button", { name: /Contact & Personal/ }).click();
  await expect(page.getByText("First Name", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  await page.getByLabel("Phone number").fill("5550001");
  await page.getByRole("button", { name: "Save Changes" }).click();
  await expect(page.getByText("Member updated successfully")).toBeVisible();
  // Back in display mode with the saved value (exact dd text; the collapsed-
  // header preview also contains the phone, so a substring match is ambiguous).
  await expect(page.getByText("First Name", { exact: true })).toBeVisible();
  await expect(page.getByText("+64 27 5550001", { exact: true })).toBeVisible();

  // The expanded Contact group follows the admin to a different member.
  await openMemberDetail(
    page,
    `${personas.enrollee.firstName} ${personas.enrollee.lastName}`,
  );
  await expect(page.getByText("First Name", { exact: true })).toBeVisible();

  // Collapsing it is remembered too.
  await page.getByRole("button", { name: /Contact & Personal/ }).click();
  await expect(page.getByText("First Name", { exact: true })).toHaveCount(0);
});
