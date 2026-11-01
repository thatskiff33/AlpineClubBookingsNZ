import { expect, test, type BrowserContext } from "../helpers/accessibility";
import { loginPersona } from "../helpers/auth";
import { E2E_ADMIN, ROSTER_GUEST_LODGE_A, SECOND_LODGE } from "../helpers/fixtures";
import { overrideModules, setModuleSettings } from "../helpers/modules";

// Multi-lodge lobby display scoping (fork epic hoppers99#25, LTV-010): a
// display device created for lodge B renders LODGE B's board — its header
// names lodge B, and lodge A's content never appears. Runs ONLY in the
// `multi-lodge` project against the two-lodge database.
//
// The seeded cross-lodge arrivals (ROSTER_ISOLATION_WINDOW) sit on fixed
// August dates outside the display's rolling today+N window, so the
// PRESENCE of lodge B guests is not assertable here; the data-level
// cross-lodge proof (a lodge A device token never receives lodge B
// bookings/guests/chores/config) is pinned by the display-state route tests
// (src/lib/__tests__/lodge-display-state.test.ts — scoping assertion).

test.describe.configure({ mode: "serial" });

const deviceName = `E2E Lodge B TV ${Date.now()}`;
let previousModules: Record<string, boolean> | null = null;
let tvContext: BrowserContext | null = null;

test.afterAll(async ({ request }) => {
  if (previousModules) {
    await setModuleSettings(request, previousModules).catch(() => undefined);
  }
  await tvContext?.close();
});

test("a device bound to lodge B renders lodge B's board and never lodge A's content", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  await loginPersona(page, E2E_ADMIN.email);
  previousModules = await overrideModules(page.request, { lobbyDisplay: true });

  // Create a device explicitly bound to lodge B via the lodge picker.
  // Devices management moved to /admin/display/devices (fork issue #109; the
  // /admin/display route is now the Lobby Display hub).
  await page.goto("/admin/display/devices");
  await page.locator("#device-name").fill(deviceName);
  await page.locator("#device-lodge").selectOption({ label: SECOND_LODGE.name });
  await page.getByRole("button", { name: "Create device" }).click();
  // Assert on the created device's row (device name + bound lodge name), not a
  // bare page-wide text match: the create form's lodge <select> sits above the
  // list, so an unscoped `.first()` resolves to its hidden <option> and can
  // never be visible. The row nests the two <p>s (name, lodge) in one wrapper,
  // so scope to the device name's parent element.
  await expect(
    page.getByText(deviceName, { exact: true }).locator("..").getByText(SECOND_LODGE.name)
  ).toBeVisible();

  // Pair an unauthenticated TV against it.
  tvContext = await browser.newContext();
  const tv = await tvContext.newPage();
  await tv.goto("/display");
  const codeLocator = tv.locator(".display-pairing-code");
  await expect(codeLocator).toBeVisible({ timeout: 30_000 });
  const code = (await codeLocator.innerText()).trim();

  // #2264: selected by the input's per-device accessible name rather than its
  // placeholder. The name carries the device, so this stays unambiguous if the
  // page ever lists more than one row.
  await page
    .getByRole("textbox", { name: `Pairing code for ${deviceName}` })
    .fill(code);
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  // Match the confirmation notice specifically, not a bare /Pairing armed/ —
  // the device row's status badge can also say "Pairing armed" once the list
  // refreshes, tripping Playwright strict mode (2 elements) on slower runners.
  await expect(page.getByText(/Pairing armed — the display/)).toBeVisible();

  // The board renders LODGE B: its name in the header, and lodge A's
  // seeded guest never present anywhere in the page.
  const header = tv.locator(".display-lodge-name");
  await expect(header).toBeVisible({ timeout: 30_000 });
  await expect(header).toHaveText(SECOND_LODGE.name);
  await expect(
    tv.getByText(ROSTER_GUEST_LODGE_A.firstName, { exact: false })
  ).toHaveCount(0);
});
