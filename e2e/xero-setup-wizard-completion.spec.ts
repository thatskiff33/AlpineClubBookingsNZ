import { type BrowserContext, expect, test } from "./helpers/accessibility";
import { storageStatePath } from "./helpers/auth";
import { E2E_ADMIN } from "./helpers/fixtures";
import { overrideModules, setModuleSettings, type ModuleSettings } from "./helpers/modules";
import { resetXeroSetupWizard } from "./helpers/reset";
import { wizardCursorSave } from "./helpers/wizard-cursor";

// Kept in lockstep with MOCK_XERO_ORG_NAME in src/lib/xero-mock-endpoint.ts.
const MOCK_XERO_ORG_NAME = "Alpine Test Club Ltd";

// Full guided Xero completion flow (#2081), end-to-end against the mock-Xero
// harness (XERO_MOCK_API_ORIGIN, set in .env.staging): from module-on through
// credentials -> connect -> WEBHOOK VERIFY (intent-to-receive) -> mapping ->
// import & finish. The webhook verify is the load-bearing assertion: the mock
// harness POSTs Xero's validation ping to the REAL /api/webhooks/xero route
// (same resolver + HMAC path production uses), and the wizard only goes green on
// that fresh, key-matched marker.
test.describe.configure({ mode: "serial" });

let adminContext: BrowserContext;
let previousModules: ModuleSettings | undefined;

test.beforeAll(async ({ browser }) => {
  adminContext = await browser.newContext({
    storageState: storageStatePath(E2E_ADMIN.email),
  });
  previousModules = await overrideModules(adminContext.request, {
    xeroIntegration: true,
  });
  // RETRY IDEMPOTENCY (#2302): a retry must start from step one on a
  // disconnected club, exactly like a first attempt. Re-runs on every attempt
  // (a retry restarts the worker).
  await resetXeroSetupWizard(adminContext.request);
});

test.afterAll(async () => {
  try {
    if (adminContext) {
      // Hand the sibling wizard spec (which sorts AFTER this file) a
      // disconnected club whose wizard cursor is back on step one. This lives in
      // afterAll, NOT at the end of the test body (#2302): a mid-test failure
      // used to strand the sibling on a connected, step-3 wizard, which is one
      // of the ways xero-setup-wizard.spec.ts:48 went red on content that was
      // green on main. Runs BEFORE the module restore below, because
      // /api/admin/xero/disconnect needs xeroIntegration still enabled.
      await resetXeroSetupWizard(adminContext.request);
    }
    if (adminContext && previousModules) {
      await setModuleSettings(adminContext.request, previousModules);
    }
  } finally {
    await adminContext?.close();
  }
});

test("operator completes the whole Xero wizard including verified webhooks", async () => {
  const page = await adminContext.newPage();
  await page.goto("/admin/xero/setup");

  // Step 1 — create-app instructions.
  await expect(
    page.getByRole("heading", { name: /create your xero app/i }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 2 — credentials.
  await page.getByLabel("Client ID").fill("mock-client-id");
  await page.getByLabel("Client Secret").fill("mock-client-secret");
  // "Save credentials" on a fresh club; "Replace credentials" once a pair is
  // stored — which is the state a RETRY of this test starts from, since the
  // beforeAll reset deliberately leaves credentials in place (#2302). Matching
  // only /save/ made every retry of this spec fail here.
  await page
    .getByRole("button", { name: /(save|replace) credentials/i })
    .click();
  // Assert on what THIS save changed, not on standing state (#2302). "Both
  // credentials stored" renders whenever a pair is stored, and the beforeAll
  // reset deliberately leaves the pair in place — so from attempt 1 onwards that
  // badge is already on screen before the click and would pass even if the save
  // silently failed. The success banner is written only by a save that returned
  // OK, so it holds the assertion honest on every attempt; the badge is still
  // checked afterwards for the stored-pair state the next step depends on.
  await expect(
    page.getByRole("status").getByText(/Credentials saved/i),
  ).toBeVisible();
  await expect(page.getByText(/Both credentials stored/i)).toBeVisible();
  const connectCursorSaved = wizardCursorSave(page, "xero", "connect");
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 3 — connect (mock OAuth round-trip).
  await expect(
    page.getByRole("heading", { name: /connect to xero/i }),
  ).toBeVisible();
  // The post-OAuth page resumes on the step the server has stored, so leave
  // only once the wizard has saved that it is on Connect (#4014).
  expect((await connectCursorSaved).ok()).toBeTruthy();
  await page.getByRole("button", { name: /^Connect Xero$/ }).click();
  // ?connected=true is consumed and stripped by the wizard context (#2394
  // review, F1), so match the page, not the marker.
  await expect(page).toHaveURL(/\/admin\/xero\/setup/);
  await expect(
    page.getByText(new RegExp(`Connected to\\s+${MOCK_XERO_ORG_NAME}`, "i")),
  ).toBeVisible({ timeout: 30_000 });

  // Advance to the webhook step. (Connect is verified, so Continue is enabled.)
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 4 — webhooks: save the key, Verify, then have the mock harness send the
  // intent-to-receive ping to the REAL webhook route.
  await expect(
    page.getByRole("heading", { name: /webhooks \(optional\)/i }),
  ).toBeVisible();
  await page.getByLabel(/Webhooks key/i).fill("mock-webhook-signing-key");
  // The first attempt sees Save; a retry intentionally preserves credentials
  // and therefore sees Replace. Exercise the write on every attempt so the
  // verification remains attributable to this run.
  await page
    .getByRole("button", { name: /^(save|replace) key$/i })
    .click();
  await expect(
    page.getByRole("status").getByText(/Webhook key saved/i),
  ).toBeVisible();
  const verifyBtn = page.getByRole("button", { name: "Verify" });
  await expect(verifyBtn).toBeEnabled();

  // Synchronize on the first freshness-scoped poll. Its `since` query proves
  // the server-issued start response has returned and the client has installed
  // that exact anchor; a fixed sleep can still race a loaded CI runner.
  const firstFreshnessPoll = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return (
      url.pathname === "/api/admin/xero/webhook/verify-status" &&
      url.searchParams.has("since")
    );
  });
  await verifyBtn.click();
  await firstFreshnessPoll;
  const pingRes = await page.request.post(
    "/api/testing/xero-mock/send-validation",
  );
  expect(pingRes.ok()).toBeTruthy();
  expect((await pingRes.json()).forwarded).toBe(200);

  await expect(page.getByText(/Webhooks verified/i)).toBeVisible({
    timeout: 30_000,
  });

  // The persistent amber badge must be gone once verified.
  await expect(
    page.getByText(/Webhooks not configured/i),
  ).toHaveCount(0);

  // Advance to account mapping — the embedded MappingsPanel renders the mock
  // chart of accounts.
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("heading", { name: /map accounts & items/i }),
  ).toBeVisible();
  await expect(page.getByText(/Account Mappings/i)).toBeVisible({
    timeout: 30_000,
  });

  // Advance to import & finish — summary + one-time import tools.
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("heading", { name: /import contacts & finish/i }),
  ).toBeVisible();
  await expect(page.getByText(/Setup summary/i)).toBeVisible();
  await expect(page.getByText(/^Verified$/)).toBeVisible();
  // Summary covers org, webhook state AND mappings (#2081 acceptance criteria):
  // the Mappings row reports how many of the mapping keys resolve to a code.
  await expect(page.getByText(/Mappings/)).toBeVisible();
  await expect(page.getByText(/\d+ of \d+ accounts mapped/)).toBeVisible();

  // The whole wizard is now complete.
  await expect(page.getByText(/Setup complete/i)).toBeVisible();

  // The disconnect + cursor rewind that hands the sibling wizard spec a
  // re-runnable state now lives in afterAll, so it also runs when this test
  // fails partway (#2302). Credentials stay stored either way — the sibling spec
  // re-enters them via the Replace flow, which is itself worth exercising.
  await page.close();
});
