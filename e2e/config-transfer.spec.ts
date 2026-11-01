import { expect, test } from "./helpers/accessibility";
import { storageStatePath } from "./helpers/auth";
import { E2E_ADMIN } from "./helpers/fixtures";

// Configuration Export & Import (config transfer) round trip: a full admin
// exports a site-content bundle, re-uploads the same file, previews (dry-run),
// and applies it. Because the bundle is exactly what the instance holds, the
// dry-run classifies rows as unchanged and the apply succeeds as a no-op —
// exercising export, upload, plan (fingerprint), mode UI, and apply end to end.

test.describe.configure({ mode: "serial" });

// Reuse the E2E admin session saved once in auth.setup.ts instead of a fresh
// per-spec login (#1779).
test.use({ storageState: storageStatePath(E2E_ADMIN.email) });

test("export → re-upload → dry-run → apply round trip", async ({ page }) => {
  await page.goto("/admin/config-transfer");
  await expect(
    page.getByRole("heading", { name: /configuration export & import/i }),
  ).toBeVisible();

  // Export a site-content-only bundle (deterministic, no door codes). Assert
  // each toggle landed (auto-waiting) so the export cannot race the clicks.
  for (const category of ["club-settings", "lodge-config"]) {
    const box = page.locator(`#cat-${category}`);
    if (await box.isChecked()) await box.click();
    await expect(box).not.toBeChecked();
  }
  const siteContent = page.locator("#cat-site-content");
  if (!(await siteContent.isChecked())) await siteContent.click();
  await expect(siteContent).toBeChecked();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /export bundle/i }).click();
  const download = await downloadPromise;
  const bundlePath = await download.path();
  expect(bundlePath).toBeTruthy();

  // Re-upload the exported bundle and run the dry-run.
  await page.locator('input[type="file"]').setInputFiles(bundlePath!);
  await page.getByRole("button", { name: /preview \(dry-run\)/i }).click();
  await expect(page.getByText(/^Plan: /)).toBeVisible({ timeout: 20_000 });
  // A re-import of this instance's own export can never CREATE rows. (It may
  // show a few "updated" on a cold stack whose first requests lazily
  // normalise seeded content between the export and the preview — those are
  // genuine diffs, correctly reported, so the count of updates isn't pinned.)
  await expect(page.getByText(/Plan: 0 new, /)).toBeVisible();
  // No validation errors → Apply is enabled.
  const applyButton = page.getByRole("button", { name: /apply import/i });
  await expect(applyButton).toBeEnabled();

  // Apply and confirm the truthful result summary (no creates on a round trip).
  await applyButton.click();
  await expect(page.getByText(/Applied: 0 created, /)).toBeVisible({
    timeout: 30_000,
  });
});
