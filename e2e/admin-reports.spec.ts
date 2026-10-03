import { expect, test } from "@playwright/test";
import { DEMO_BOOKING_WINDOWS } from "../prisma/e2e-fixtures";
import { storageStatePath } from "./helpers/auth";
import { E2E_ADMIN } from "./helpers/fixtures";

// Issue #2368: Base Reports is a stay-night report, not a booking-created
// report. The seeded Dave booking was created when the demo database was built,
// but its three-night stay sits forty days in the past. Selecting those nights
// must still find it, allocate its $135 booked price to the stay, and leave
// occupancy at zero because CONFIRMED is in the report cohort but deliberately
// outside the PAID/COMPLETED utilisation cohort.
test.use({ storageState: storageStatePath(E2E_ADMIN.email) });

test("reports overlapping stay nights and keeps booked revenue distinct from cash", async ({
  page,
}) => {
  const stay = DEMO_BOOKING_WINDOWS.daveConfirmed;

  const apiResponse = await page.request.get(
    `/api/admin/reports?from=${stay.checkIn}&to=${stay.nights.at(-1)}`,
  );
  expect(apiResponse.ok()).toBe(true);
  const report = await apiResponse.json();
  expect(report.summary).toMatchObject({
    totalBookings: 1,
    totalRevenueCents: 13_500,
    netCollectedCents: 13_500,
    totalGuests: 1,
    avgOccupancyRate: 0,
  });
  expect(report.statusBreakdown).toMatchObject({ confirmed: 1, paid: 0, completed: 0 });
  expect(report.revenue.reduce(
    (total: number, bucket: { revenueCents: number }) => total + bucket.revenueCents,
    0,
  )).toBe(13_500);

  await page.goto("/admin/reports");
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();

  const refreshed = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/admin/reports" &&
      url.searchParams.get("from") === stay.checkIn &&
      url.searchParams.get("to") === stay.nights.at(-1)
    );
  });
  await page.getByLabel("From").fill(stay.checkIn);
  await page.getByRole("textbox", { name: "To", exact: true }).fill(
    stay.nights.at(-1) ?? stay.checkIn,
  );
  await refreshed;

  const bookedRevenueCard = page
    .getByText("Booked Revenue", { exact: true })
    .locator("xpath=../..");
  const collectedCashCard = page
    .getByText("Net Collected", { exact: true })
    .locator("xpath=../..");
  const avgOccupancyCard = page
    .getByText("Avg Occupancy", { exact: true })
    .locator("xpath=../..");
  await expect(bookedRevenueCard.getByText("$135.00")).toBeVisible();
  await expect(collectedCashCard.getByText("$135.00")).toBeVisible();
  await expect(page.getByText("Outstanding Additions", { exact: true })).toBeVisible();
  await expect(page.getByText("Booked Revenue by Day", { exact: true })).toBeVisible();
  await expect(avgOccupancyCard.getByText("0%", { exact: true })).toBeVisible();
});
