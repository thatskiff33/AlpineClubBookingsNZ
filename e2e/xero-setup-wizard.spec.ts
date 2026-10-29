import { type BrowserContext, expect, test } from "./helpers/accessibility";
import { storageStatePath } from "./helpers/auth";
import { E2E_ADMIN } from "./helpers/fixtures";
import { overrideModules, setModuleSettings, type ModuleSettings } from "./helpers/modules";
import { resetXeroSetupWizard } from "./helpers/reset";
import { wizardCursorSave } from "./helpers/wizard-cursor";

// Kept in lockstep with MOCK_XERO_ORG_NAME in src/lib/xero-mock-endpoint.ts,
// which the gated mock organisation endpoint returns. Duplicated as a literal
// rather than imported so this spec never pulls a server-only module into the
// Playwright transform.
const MOCK_XERO_ORG_NAME = "Alpine Test Club Ltd";

// Guided Xero connection wizard happy path (#2080), driven end-to-end against
// the mock-Xero harness (XERO_MOCK_API_ORIGIN, set in .env.staging). A fresh
// club with only a strong auth secret configured must reach
// "Connected to <Org>" purely in-app: create-app instructions -> enter
// credentials -> OAuth connect -> right-org confirmation.
//
// xeroIntegration defaults OFF (e2e/setup/enable-e2e-modules.ts), so this spec
// turns it on for its own run and restores it in afterAll — the same
// toggle-and-restore choreography the internet-banking spec uses, kept
// non-colliding by workers=1 (playwright.config.ts).
test.describe.configure({ mode: "serial" });

let adminContext: BrowserContext;
let previousModules: ModuleSettings | undefined;

test.beforeAll(async ({ browser }) => {
  // Reuse the Full-Admin session saved once in auth.setup.ts (credential writes
  // are Full-Admin only, #2079 decision 4).
  adminContext = await browser.newContext({
    storageState: storageStatePath(E2E_ADMIN.email),
  });
  previousModules = await overrideModules(adminContext.request, {
    xeroIntegration: true,
  });
  // RETRY IDEMPOTENCY (#2302). The wizard persists its step cursor server-side
  // (/api/admin/integrations/wizard-progress), so an attempt that reached step 3
  // leaves /admin/xero/setup RESUMING on step 3. Without this rewind every retry
  // failed instantly on the step-1 heading at line 55 instead of re-running the
  // flow — observed in runs 30478504882 and 30530889448, where one transient
  // failure at the org-name assertion became three, and the reported error was
  // the pollution rather than the cause. Also disconnects, so step 3's OAuth
  // round-trip is a genuine connect on every attempt. This hook re-runs on each
  // retry (a retry restarts the worker), which is what makes it the right place.
  await resetXeroSetupWizard(adminContext.request);
});

test.afterAll(async () => {
  try {
    if (adminContext && previousModules) {
      await setModuleSettings(adminContext.request, previousModules);
    }
  } finally {
    await adminContext?.close();
  }
});

test("operator reaches Connected to <Org> entirely in-app", async () => {
  const page = await adminContext.newPage();
  await page.goto("/admin/xero/setup");

  // Step 1 — create-app instructions with copy-paste-exact values.
  await expect(
    page.getByRole("heading", { name: /create your xero app/i }),
  ).toBeVisible();
  // The resolved redirect URI copy field is present (the value the flow sends).
  await expect(page.getByText(/OAuth 2\.0 redirect URI/i)).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 2 — enter credentials (write-only) → C1 credentials API.
  await expect(
    page.getByRole("heading", { name: /enter your xero credentials/i }),
  ).toBeVisible();
  await page.getByLabel("Client ID").fill("mock-client-id");
  await page.getByLabel("Client Secret").fill("mock-client-secret");
  // "Save credentials" on a fresh club; "Replace credentials" when the
  // completion spec (which runs first) has already stored a pair.
  await page
    .getByRole("button", { name: /(save|replace) credentials/i })
    .click();
  // Wait for THIS save to finish, not for standing state (#4014, as the
  // completion spec has since #2302). On the Replace path "Both credentials
  // stored" and an enabled Continue are already on screen before the click, so
  // asserting only those let this spec reach Connect while the save was still
  // writing. The save is two sequential writes, and every credential write
  // resets the Xero connection by design (#3454): in E2E run 37830486574 the
  // client-secret write committed AFTER the OAuth callback and disconnected the
  // organisation the spec was about to confirm. The success banner is written
  // only once both writes have returned OK.
  await expect(
    page.getByRole("status").getByText(/Credentials saved/i),
  ).toBeVisible();

  // Verified: both credentials now show "Set ✓" and Continue enables.
  await expect(page.getByText(/Both credentials stored/i)).toBeVisible();
  const continueBtn = page.getByRole("button", { name: "Continue" });
  await expect(continueBtn).toBeEnabled();
  const connectCursorSaved = wizardCursorSave(page, "xero", "connect");
  await continueBtn.click();

  // Step 3 — connect: the OAuth flow round-trips through the mock and returns to
  // the wizard, which confirms the connected organisation name.
  await expect(
    page.getByRole("heading", { name: /connect to xero/i }),
  ).toBeVisible();
  // The post-OAuth page resumes on the step the server has stored, so leave
  // only once the wizard has saved that it is on Connect (#4014).
  expect((await connectCursorSaved).ok()).toBeTruthy();
  await page.getByRole("button", { name: /^Connect Xero$/ }).click();

  // Back on the wizard after the mock OAuth round-trip: right-org confirmation.
  // The callback lands with ?connected=true, but the wizard context CONSUMES
  // that marker once and strips it (#2394 review, F1) — otherwise every later
  // return to this step re-fires a forced live Xero read with nobody pressing
  // anything. So assert the landing page, then that the marker is gone.
  await expect(page).toHaveURL(/\/admin\/xero\/setup/);
  await expect(
    page.getByText(new RegExp(`Connected to\\s+${MOCK_XERO_ORG_NAME}`, "i")),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page).not.toHaveURL(/connected=true/);
  // Connect is verified but the wizard is NOT complete (#2081 extends it with
  // webhooks/mapping/import) — the next step is reachable, and no completion
  // banner shows yet (never "the whole integration is done" mid-flow, #2080
  // UX-F9; the six-step completion state is covered by the completion spec).
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("heading", { name: /webhooks \(optional\)/i }),
  ).toBeVisible();
  await expect(page.getByText(/Setup complete/i)).toHaveCount(0);

  await page.close();
});
