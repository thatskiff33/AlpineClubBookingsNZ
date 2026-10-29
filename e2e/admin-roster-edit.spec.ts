import { expect, test, type Page } from "./helpers/accessibility";
import { storageStatePath } from "./helpers/auth";
import { DEMO_BOOKING_WINDOWS, E2E_ADMIN } from "./helpers/fixtures";

type BrowserRoster = {
  guests: Array<{
    id: string;
    bookingId: string;
    firstName: string;
    lastName: string;
    bookingGroupLabel: string;
    dateOfBirth?: unknown;
  }>;
  assignments: Array<{
    id: string;
    bookingId: string;
    bookingGuestId: string | null;
    choreTemplateId: string;
    choreTemplateName: string;
    status: string;
  }>;
  templates: Array<{ id: string }>;
};

// #2586: the seeded night has two operational PAID booking/family groups. This browser journey
// pins generate -> whole-roster Edit -> Save/Cancel -> reload -> Confirm ->
// reload, including a cross-booking replacement and D-R2's exact group/order.
test.use({ storageState: storageStatePath(E2E_ADMIN.email) });

async function loadRosterDate(
  page: Page,
  date: string,
  navigation: "goto" | "reload",
) {
  const lodgeScopedInitialLoad = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return /^\/api\/admin\/roster\/\d{4}-\d{2}-\d{2}$/.test(url.pathname) &&
      url.searchParams.has("lodgeId") &&
      response.request().method() === "GET";
  });
  if (navigation === "goto") await page.goto("/admin/roster");
  else await page.reload();
  expect((await lodgeScopedInitialLoad).ok()).toBe(true);

  const loaded = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/admin/roster/${date}` &&
    new URL(response.url()).searchParams.has("lodgeId") &&
    response.request().method() === "GET",
  );
  await page.locator("#date").fill(date);
  const response = await loaded;
  expect(response.ok()).toBe(true);
  await expect(page.locator("#date")).toHaveValue(date);
  return response;
}

test("stages and atomically saves a two-booking roster in D-R2 order", async ({ page }) => {
  const date = DEMO_BOOKING_WINDOWS.rosterEdit.checkIn;
  const initialResponse = await loadRosterDate(page, date, "goto");
  const initialRoster = await initialResponse.json() as BrowserRoster;
  await expect(page.getByRole("button", { name: "Edit roster" })).toBeVisible();

  // Exercise the explicit Generate path, then use its authoritative reload for
  // the cross-booking source/target rather than assuming allocator row order.
  const regenerated = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/admin/roster/${date}` &&
    response.request().method() === "PUT" &&
    response.request().postDataJSON()?.action === "regenerate",
  );
  const regeneratedLoad = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/admin/roster/${date}` &&
    response.request().method() === "GET",
  );
  const regenerateButton = page.getByRole("button", { name: "Regenerate Roster" });
  const hasFinalAssignments = initialRoster.assignments.some(
    (assignment) => assignment.status === "CONFIRMED" || assignment.status === "COMPLETED",
  );
  if (hasFinalAssignments) {
    const dialogOpened = page.waitForEvent("dialog");
    const clicked = regenerateButton.click();
    const dialog = await dialogOpened;
    expect(dialog.message()).toContain("replace the current confirmed roster");
    await dialog.accept();
    await clicked;
  } else {
    await regenerateButton.click();
  }
  expect((await regenerated).ok()).toBe(true);
  const current = await (await regeneratedLoad).json() as BrowserRoster;

  expect(current.guests.map((guest) => `${guest.bookingGroupLabel}|${guest.firstName} ${guest.lastName}`)).toEqual([
    "Booking for Dave Davis|Dave Davis",
    "Booking for Dave Davis|Alice Anderson",
    "Booking for Dave Davis|Zara Unknown",
    "Booking for Erin Evans|Erin Evans",
    "Booking for Erin Evans|Aaron Unknown",
  ]);
  expect(current.guests.every((guest) => !("dateOfBirth" in guest))).toBe(true);

  const daveGroup = page.getByRole("region", { name: "Booking for Dave Davis" });
  const erinGroup = page.getByRole("region", { name: "Booking for Erin Evans" });
  await expect(daveGroup.locator("li").locator("span")).toHaveText([
    "Dave Davis:",
    "Alice Anderson:",
    "Zara Unknown:",
  ]);
  await expect(erinGroup.locator("li").locator("span")).toHaveText([
    "Erin Evans:",
    "Aaron Unknown:",
  ]);

  const source = current.assignments.find((assignment) => assignment.bookingGuestId);
  expect(source).toBeTruthy();
  const sourceGuest = current.guests.find((guest) => guest.id === source!.bookingGuestId)!;
  const targetGuest = current.guests.find((guest) => guest.bookingId !== sourceGuest.bookingId)!;
  expect(targetGuest.bookingId).not.toBe(sourceGuest.bookingId);

  const staffingCard = page.getByRole("heading", { name: "Chore staffing" }).locator("..").locator("..");
  const staffingLine = staffingCard
    .getByText(`${source!.choreTemplateName}:`, { exact: true })
    .locator("..");
  const targetSummary = page
    .getByRole("region", { name: targetGuest.bookingGroupLabel })
    .locator("li")
    .filter({ hasText: `${targetGuest.firstName} ${targetGuest.lastName}:` });
  const staffingBefore = await staffingLine.textContent();
  const guestSummaryBefore = await targetSummary.textContent();
  await expect(staffingLine).toContainText(/assigned.*(under|within|over).*recommendation/);
  await expect(targetSummary).toContainText(/No chore assigned|assignment/);

  await page.getByRole("button", { name: "Edit roster" }).click();
  const assignmentSelects = page.locator('select[id^="roster-guest-"]');
  const startingCount = await assignmentSelects.count();
  expect(startingCount).toBeGreaterThan(1);
  let sourceIndex = -1;
  for (let index = 0; index < startingCount; index++) {
    if (await assignmentSelects.nth(index).inputValue() === source!.bookingGuestId) {
      sourceIndex = index;
      break;
    }
  }
  expect(sourceIndex).toBeGreaterThanOrEqual(0);
  const untouchedIndex = sourceIndex === 0 ? 1 : 0;
  const untouchedValue = await assignmentSelects.nth(untouchedIndex).inputValue();
  await assignmentSelects.nth(sourceIndex).selectOption(targetGuest.id);
  await expect(assignmentSelects.nth(untouchedIndex)).toHaveValue(untouchedValue);

  const sourceCard = assignmentSelects
    .nth(sourceIndex)
    .locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' rounded-xl ')][1]");
  await sourceCard.getByRole("button", { name: "+ Add Person" }).click();
  await expect(assignmentSelects).toHaveCount(startingCount + 1);
  await sourceCard.locator('select[id^="roster-guest-"]').last().selectOption(targetGuest.id);
  await expect(staffingLine).not.toHaveText(staffingBefore ?? "");
  await expect(targetSummary).not.toHaveText(guestSummaryBefore ?? "");
  await expect(staffingLine).toContainText(/assigned.*(under|within|over).*recommendation/);
  await expect(targetSummary).toContainText(/assignments?:/);

  const saved = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/admin/roster/${date}` &&
    response.request().method() === "PUT" &&
    response.request().postDataJSON()?.action === "save",
  );
  await page.getByRole("button", { name: "Save roster" }).click();
  const saveResponse = await saved;
  expect(saveResponse.ok()).toBe(true);
  const savedRoster = await saveResponse.json() as BrowserRoster;
  expect(saveResponse.request().postDataJSON()).toMatchObject({
    action: "save",
    acknowledgeCompletedReset: false,
  });
  expect(savedRoster.assignments.find((assignment) => assignment.id === source!.id)).toMatchObject({
    bookingGuestId: targetGuest.id,
    bookingId: targetGuest.bookingId,
    status: "SUGGESTED",
  });
  expect(savedRoster.assignments.every((assignment) => assignment.status === "SUGGESTED")).toBe(true);
  await expect(page.getByText("Roster saved. All assignments are now Suggested and ready to confirm.")).toBeVisible();

  // Cancel restores the authoritative Save response, not the original load.
  await page.getByRole("button", { name: "Edit roster" }).click();
  const savedSourceSelect = page.locator(`#roster-guest-${source!.id}`);
  await savedSourceSelect.selectOption(sourceGuest.id);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText(`${targetGuest.firstName} ${targetGuest.lastName}`, { exact: true }).first()).toBeVisible();

  const reloadedResponse = await loadRosterDate(page, date, "reload");
  const reloaded = await reloadedResponse.json() as BrowserRoster;
  expect(reloaded.assignments.find((assignment) => assignment.id === source!.id)).toMatchObject({
    bookingGuestId: targetGuest.id,
    bookingId: targetGuest.bookingId,
    status: "SUGGESTED",
  });

  page.once("dialog", (dialog) => dialog.accept());
  const confirmed = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/admin/roster/${date}` &&
    response.request().method() === "PUT" &&
    response.request().postDataJSON()?.action === "confirm",
  );
  await page.getByRole("button", { name: "Confirm Roster" }).click();
  expect((await confirmed).ok()).toBe(true);

  const confirmedReloadResponse = await loadRosterDate(page, date, "reload");
  const confirmedReload = await confirmedReloadResponse.json() as BrowserRoster;
  expect(confirmedReload.assignments.find((assignment) => assignment.id === source!.id)).toMatchObject({
    bookingGuestId: targetGuest.id,
    bookingId: targetGuest.bookingId,
    status: "CONFIRMED",
  });
  await expect(page.getByText("CONFIRMED", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(`${targetGuest.firstName} ${targetGuest.lastName}`, { exact: true }).first()).toBeVisible();
});
