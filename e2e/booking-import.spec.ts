import { randomUUID } from "node:crypto";

import { type APIRequestContext, expect, test } from "./helpers/accessibility";
import { storageStatePath } from "./helpers/auth";
import { E2E_ADMIN } from "./helpers/fixtures";
import { personas } from "./helpers/personas";
import { relDateOnly } from "../prisma/e2e-fixtures";
import { getAdminPage } from "../src/lib/admin-hubs";

// docs/END_TO_END_TEST_MATRIX.md row "Import paid bookings (#5005)": an officer
// holding finance edit and bookings edit uploads a one-booking file, reads the
// preview, imports it, and finds the booking paid; then reverses the batch,
// which cancels it with nobody emailed. The money, capacity and census
// contracts are proven on real PostgreSQL by booking-import.realdb.test.ts;
// this spec proves the screen drives them.
//
// Retry-safe (E2E_PLAYWRIGHT.md, "Flake invariants"): every attempt has its own
// Booking Ref and its own one-night stay far in the future, and the hook
// reverses any batch an earlier attempt or run left behind, through the
// product's own route, so a leftover booking never blocks Alice's night.
test.use({ storageState: storageStatePath(E2E_ADMIN.email) });

const IMPORT_PAGE = getAdminPage("booking-import").oldPath;
const HEADER =
  "Booking Ref,Owner Email,Owner First Name,Owner Last Name,Guest Type,Guest Email,Guest First Name,Guest Last Name,Age Group,Check In,Check Out,Amount Paid";

async function reverseLeftoverBatches(request: APIRequestContext) {
  const listed = await request.get("/api/admin/bookings/import/batches");
  expect(listed.ok()).toBe(true);
  const { batches } = (await listed.json()) as { batches: { id: string; status: string }[] };
  for (const batch of batches.filter((entry) => entry.status === "COMPLETED")) {
    for (let slice = 0; slice < 50; slice += 1) {
      const reversed = await request.post(`/api/admin/bookings/import/batches/${batch.id}/reverse`);
      expect(reversed.ok()).toBe(true);
      if (((await reversed.json()) as { remaining: number }).remaining === 0) break;
    }
  }
}

test.beforeEach(async ({ page }) => {
  await reverseLeftoverBatches(page.request);
});

test("imports a paid booking from a file, shows it paid, and reverses the batch", async ({ page }, testInfo) => {
  const ref = `E2E-${testInfo.retry}-${randomUUID().slice(0, 8)}`;
  const checkIn = relDateOnly(280 + testInfo.retry * 2);
  const checkOut = relDateOnly(281 + testInfo.retry * 2);
  const alice = personas.booker;
  const csv = [
    HEADER,
    [ref, alice.email, alice.firstName, alice.lastName, "Member", alice.email, alice.firstName, alice.lastName, "", checkIn, checkOut, "123.45"].join(","),
  ].join("\n");

  await page.goto(IMPORT_PAGE);
  await expect(page.getByRole("heading", { name: "Import Paid Bookings", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Import paid bookings" }).click();
  const dialog = page.getByRole("dialog", { name: "Import paid bookings" });
  await dialog.getByLabel("CSV file").setInputFiles({ name: "paid-bookings.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });

  // The headers match, so every column is mapped; the date format is the file's.
  await expect(dialog.getByLabel("Date format in the file")).toBeVisible();
  await dialog.getByRole("button", { name: "Preview" }).click();
  const bookingRow = dialog.getByRole("row").filter({ hasText: ref });
  await expect(bookingRow).toContainText("Will import");
  await expect(dialog.getByText("Will import", { exact: true }).first()).toBeVisible();

  await dialog.getByRole("button", { name: /^Import 1 booking \(/ }).click();
  await expect(page).toHaveURL(/\/admin\/(booking-desk\/)?booking-import\/[^/]+$/);
  await expect(page.getByRole("heading", { name: "Import Batch", level: 1 })).toBeVisible();
  const batchRow = page.getByRole("row").filter({ hasText: ref });
  // "Untouched" means still paid, nothing changed since the import (INV-PAY-163).
  await expect(batchRow).toContainText("Imported, untouched");

  const batchUrl = page.url();
  await batchRow.getByRole("link", { name: ref }).click();
  await expect(page).toHaveURL(/\/bookings\/[^/]+$/);
  await expect(page.getByText("Paid", { exact: true }).first()).toBeVisible();

  await page.goto(batchUrl);
  await page.getByRole("button", { name: "Reverse batch" }).click();
  const confirm = page.getByRole("dialog", { name: "Reverse this import" });
  await expect(confirm).toContainText("Nobody is emailed");
  await confirm.getByRole("button", { name: "Reverse batch" }).click();
  await expect(page.getByRole("row").filter({ hasText: ref })).toContainText("Reversed");
});
