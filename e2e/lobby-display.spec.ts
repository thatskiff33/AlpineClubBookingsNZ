import { expect, test, type BrowserContext } from "./helpers/accessibility";
import { loginPersona } from "./helpers/auth";
import { E2E_ADMIN } from "./helpers/fixtures";
import { overrideModules, setModuleSettings } from "./helpers/modules";

// High rows (docs/END_TO_END_TEST_MATRIX.md): the lobby display journeys —
// module-flag gating, device creation, the ADR-001 pairing handshake
// (unauthenticated TV shows a code, admin binds it, the TV claims a token and
// flips to the active board unattended), and revocation returning the TV to
// the pairing screen. Fork epic hoppers99#25 (LTV-010).
//
// The "TV" is a separate UNAUTHENTICATED browser context: the display token
// cookie it earns through pairing is its only credential.

test.describe.configure({ mode: "serial" });

const deviceName = `E2E Lobby TV ${Date.now()}`;
let previousModules: Record<string, boolean> | null = null;
let tvContext: BrowserContext | null = null;

test.afterAll(async ({ request }) => {
  if (previousModules) {
    await setModuleSettings(request, previousModules).catch(() => undefined);
  }
  await tvContext?.close();
});

test("a display pairs through the real admin flow and a revoke sends it back to pairing", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  await loginPersona(page, E2E_ADMIN.email);

  // ── Module flag off → the display surface is a hard 404 ──
  previousModules = await overrideModules(page.request, { lobbyDisplay: false });
  const gatedTv = await browser.newContext();
  const gatedPage = await gatedTv.newPage();
  const gatedResponse = await gatedPage.goto("/display");
  expect(gatedResponse?.status()).toBe(404);
  await gatedTv.close();

  // ── Flag on → create a device from the admin page ──
  // Devices management lives at /admin/display/devices; /admin/display is now
  // the Lobby Display hub landing page (fork issue #109).
  await overrideModules(page.request, { lobbyDisplay: true });
  await page.goto("/admin/display/devices");
  await page.locator("#device-name").fill(deviceName);
  await page.getByRole("button", { name: "Create device" }).click();
  await expect(page.getByText(deviceName)).toBeVisible();
  await expect(page.getByText("Unpaired")).toBeVisible();

  // ── The unauthenticated TV shows a pairing code ──
  tvContext = await browser.newContext();
  const tv = await tvContext.newPage();
  await tv.goto("/display");
  const codeLocator = tv.locator(".display-pairing-code");
  await expect(codeLocator).toBeVisible({ timeout: 30_000 });
  const code = (await codeLocator.innerText()).trim();
  expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);

  // ── Admin binds the code; the TV flips itself to the active board ──
  // #2264: selected by the input's per-device accessible name rather than its
  // placeholder. The name carries the device, so this stays unambiguous if the
  // page ever lists more than one row.
  await page
    .getByRole("textbox", { name: `Pairing code for ${deviceName}` })
    .fill(code);
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  // Match the confirmation notice specifically: once the device list refreshes,
  // a "Pairing armed" status badge appears too, and a bare /Pairing armed/
  // match then trips Playwright strict mode (2 elements) — timing-dependent,
  // seen on slower CI runners.
  await expect(page.getByText(/Pairing armed — the display/)).toBeVisible();

  await expect(tv.locator(".display-lodge-header")).toBeVisible({
    timeout: 30_000, // one 4s claim poll + state fetch, with headroom
  });
  // The pairing code is gone — the board renders lodge data instead.
  await expect(tv.locator(".display-pairing-code")).toHaveCount(0);

  // Admin list reflects the paired state after a refresh.
  await page.reload();
  await expect(page.getByText("Paired", { exact: true })).toBeVisible();

  // ── Revoke → the display returns to the pairing screen ──
  await page.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("Revoked")).toBeVisible();

  // A revoked token is rejected on its next request: a reload lands the TV
  // straight back on the pairing screen (the running page would reach the
  // same state at its next poll interval).
  await tv.reload();
  await expect(tv.locator(".display-pairing-code")).toBeVisible({
    timeout: 30_000,
  });
  await expect(tv.locator(".display-lodge-header")).toHaveCount(0);
});
