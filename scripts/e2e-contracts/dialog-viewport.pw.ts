import { resolve } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { test, expect, type Locator } from "../../e2e/helpers/accessibility";

// Exercise the real shared confirmation, Radix portals and application CSS,
// without a database or provider fixtures. No copied dialog markup or styles.
let server: ViteDevServer;
let url: string;
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve("scripts/e2e-contracts/fixtures/dialog-viewport"),
    resolve: { alias: { "@": resolve("src") } },
    esbuild: { jsx: "automatic" },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  url = server.resolvedUrls!.local[0]!;
});
test.afterAll(async () => { await server?.close(); });

for (const viewport of [{ width: 320, height: 256 }, { width: 360, height: 300 }, { width: 1280, height: 900 }]) {
  test(`confirmation is reachable at ${viewport.width} by ${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(url);
    await page.getByRole("button", { name: "Open confirmation", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Review changes" });
    await expect(dialog).toBeVisible();
    await expect.poll(() => dialog.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= innerHeight;
    })).toBe(true);
    if (viewport.height < 400) {
      await expect.poll(() => dialog.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    } else {
      expect(await dialog.evaluate((el) => el.scrollHeight === el.clientHeight)).toBe(true);
    }
    const confirm = dialog.getByRole("button", { name: "Confirm", exact: true });
    await confirm.scrollIntoViewIfNeeded();
    await expect(confirm).toBeInViewport({ ratio: 1 });
    await confirm.click();
    await expect(page.getByRole("status")).toHaveText("Confirmed");
    await expect(dialog).toHaveCount(0);
  });
}

test("existing cap, close button and portalled Select stay reachable", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 256 });
  await page.goto(url);
  await page.getByRole("button", { name: "Open capped dialog" }).click();
  const dialog = page.getByRole("dialog", { name: "Existing height override" });
  await expect(dialog).toHaveCSS("max-height", "230.4px");
  const close = dialog.getByRole("button", { name: "Close", exact: true });
  await expect(close).toBeInViewport({ ratio: 1 });
  await page.getByRole("combobox", { name: "Method" }).click();
  const option = page.getByRole("option", { name: "Second method" });
  await expect(option).toBeInViewport({ ratio: 1 });
  expect(await option.evaluate((el) => el.closest('[role="dialog"]') === null)).toBe(true);
  await option.click();
  await expect(page.getByRole("combobox", { name: "Method" })).toHaveText("Second method");
  await close.click();
  await expect(dialog).toHaveCount(0);
});

// Short window or 400% zoom: the palette must scroll only its own list, so the
// search box and the last item are both on screen. Geometry is asserted before
// any click, because Playwright's click scrolls an overflow-hidden dialog into
// place and would pass this test while the search box was pushed off screen.
test("command palette keeps its search box and every item reachable at 320 by 256", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 256 });
  await page.goto(url);
  await page.getByRole("button", { name: "Open commands" }).click();
  const dialog = page.getByRole("dialog", { name: "Command Palette" });
  const input = dialog.getByRole("combobox", { name: "Search commands" });
  const last = dialog.getByRole("option", { name: "Command 20", exact: true });
  const insideDialog = (item: Locator) => item.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const frame = el.closest('[role="dialog"]')!.getBoundingClientRect();
    return box.top >= frame.top && box.bottom <= frame.bottom && box.top >= 0 && box.bottom <= innerHeight;
  });
  await expect(input).toBeInViewport({ ratio: 1 });
  expect(await dialog.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
  await dialog.locator("[cmdk-list]").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  expect(await insideDialog(last)).toBe(true);
  expect(await dialog.evaluate((el) => el.scrollTop)).toBe(0);
  // Keyboard path: End selects the last item and cmdk scrolls it into view.
  await input.press("End");
  await expect(last).toHaveAttribute("aria-selected", "true");
  expect(await insideDialog(input)).toBe(true);
  expect(await insideDialog(last)).toBe(true);
  expect(await dialog.evaluate((el) => el.scrollTop)).toBe(0);
  await last.click();
  await expect(dialog).toHaveCount(0);
});

test("command palette scrolls its list without a second scroll area", async ({ page }) => {
  await page.goto(url);
  await page.getByRole("button", { name: "Open commands" }).click();
  const dialog = page.getByRole("dialog", { name: "Command Palette" });
  await expect(dialog).toHaveCSS("overflow-y", "hidden");
  const last = dialog.getByRole("option", { name: "Command 20", exact: true });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport({ ratio: 1 });
  await last.click();
  await expect(dialog).toHaveCount(0);
});
