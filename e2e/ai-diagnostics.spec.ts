import { expect, test, type Page } from "./helpers/accessibility";

import { storageStatePath } from "./helpers/auth";
import { E2E_ADMIN } from "./helpers/fixtures";
import { overrideModules, setModuleSettings } from "./helpers/modules";

/**
 * AI DIAGNOSTICS, END TO END (AID-7, #2378).
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: reach the provider. Diagnostics calls a paid
 * model, so no E2E here spends money, and none of them mocks the product's own
 * contracts to pretend otherwise (#2378: "E2E/screenshots use seeded data and the
 * real combined registry, not mocked product contracts").
 *
 * WHAT IT DOES INSTEAD, AND WHY THAT IS THE INTERESTING HALF. A demo deployment has
 * no dedicated diagnostics credential and no SELECT-only database role, so a real
 * question travels through the REAL route and is refused by a REAL gate — module,
 * rate limit, body, module flag, global backstop, metering, readiness, credential —
 * before a provider is ever contacted. The thing #2378 actually asks to be proved is
 * that the operator is then told something true and actionable rather than "AI
 * failed", and that is exactly what an unconfigured deployment exercises for free.
 *
 * So these specs prove: the tab exists only where the server granted it, the
 * stethoscope names a real seeded booking, the consent ticks start unticked and
 * reset, the refusal is the server's own copy, and it never tells anybody to reload.
 */

test.use({ storageState: storageStatePath(E2E_ADMIN.email) });
test.describe.configure({ mode: "serial" });

const launcher = (page: Page) => page.getByTestId("help-widget-launcher");
const panel = (page: Page) => page.getByTestId("help-widget-panel");
const diagnosticsTab = (page: Page) =>
  page.getByTestId("help-widget-tab-diagnostics");

let previousModules: Record<string, boolean> | null = null;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({
    storageState: storageStatePath(E2E_ADMIN.email),
  });
  previousModules = await overrideModules(context.request, {
    aiDiagnostics: true,
  });
  await context.close();
});

test.afterAll(async ({ browser }) => {
  if (!previousModules) return;
  const context = await browser.newContext({
    storageState: storageStatePath(E2E_ADMIN.email),
  });
  await setModuleSettings(context.request, previousModules);
  await context.close();
});

test("the module switch controls the tab AND the route together", async ({
  page,
}) => {
  // Module ON: the tab is offered to an admin who may use it.
  await page.goto("/admin/bookings");
  await launcher(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(diagnosticsTab(page)).toBeVisible();

  // Module OFF: the tab goes, and so does the endpoint. A UI that hid the tab while
  // the route still answered would be a permission story told only in markup.
  await setModuleSettings(page.request, {
    ...(previousModules as Record<string, boolean>),
    aiDiagnostics: false,
  });

  const refused = await page.request.post("/api/admin/ai-diagnostics/ask", {
    data: {
      pathname: "/admin/bookings",
      question: "why will this booking not confirm?",
      transcript: [],
      allowPeopleSearch: false,
      allowRecordPersonalDetails: false,
    },
  });
  expect(refused.status()).toBe(404);

  // The tab still EXISTS with the module off — its presence is the admin's
  // permission, decided by the layout; `moduleEnabled` only changes what it says.
  // The design is deliberate (the docblock on `HelpWidgetProps.diagnostics`): a tab
  // that says "switched off" beats a box whose every question would be refused.
  // The first cut of this spec asserted the tab was GONE, which is the opposite of
  // the shipped behaviour and of the unit test that clicks this very tab.
  await page.goto("/admin/bookings");
  await launcher(page).click();
  await expect(panel(page)).toBeVisible();
  await diagnosticsTab(page).click();
  await expect(page.getByText("AI Diagnostics is switched off")).toBeVisible();
  // Its call to action must be a page that EXISTS with the module off — Feature
  // modules — never /admin/ai-diagnostics, which 404s in exactly this state.
  await expect(
    panel(page).getByRole("link", { name: "Open Feature modules" }),
  ).toHaveAttribute("href", "/admin/modules");

  // Back on, for the specs that follow.
  await setModuleSettings(page.request, {
    ...(previousModules as Record<string, boolean>),
    aiDiagnostics: true,
  });
});

test("a seeded booking row becomes the subject, and the refusal is honest", async ({
  page,
}) => {
  await page.goto("/admin/bookings");

  // The stethoscope renders per row, off the widget's published availability — so
  // its presence here is itself the proof that the admin layout resolved both the
  // permission and the module flag.
  const stethoscope = page.getByTestId("diagnostics-record-button").first();
  await expect(stethoscope).toBeVisible();

  // Its accessible name names the ROW, not the feature: a table of identical
  // "Ask diagnostics" buttons is unusable with a screen reader.
  await expect(stethoscope).toHaveAccessibleName(/Ask diagnostics about the booking for /);

  await stethoscope.click();

  // Choosing a record opens the panel already on Diagnostics.
  await expect(panel(page)).toBeVisible();
  await expect(page.getByTestId("diagnostics-input")).toBeVisible();

  // Both consent ticks start unticked, on every question (owner decision D9).
  await expect(page.getByTestId("diagnostics-consent-search")).not.toBeChecked();
  await expect(page.getByTestId("diagnostics-consent-record")).not.toBeChecked();

  // Ask for real. The route runs its gates against the real database and the real
  // registry; a demo deployment has no diagnostics credential, so a gate refuses.
  await page.getByTestId("diagnostics-consent-search").check();
  await page
    .getByTestId("diagnostics-input")
    .fill("why will this booking not confirm?");

  const askResponse = page.waitForResponse((response) =>
    response.url().includes("/api/admin/ai-diagnostics/ask"),
  );
  await page.getByTestId("diagnostics-send").click();
  const response = await askResponse;

  // 200 with a typed refusal, not a 500 and not a thrown error: a blocked question
  // is a first-class outcome of this product, not a fault.
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    status: string;
    reason?: string;
    message?: string;
    nextStep?: string;
  };
  expect(body.status).toBe("blocked");
  expect(body.message).toBeTruthy();

  // THE POINT OF THE WHOLE SPEC. Whatever refused, the operator is told something
  // actionable in the server's own words — never a bare "AI failed" — and is never
  // told to reload, because a reload during contention makes the cause worse
  // (#2804, owner decision 12 Aug 2026).
  const copy = `${body.message ?? ""} ${body.nextStep ?? ""}`;
  expect(copy).not.toMatch(/reload|refresh the page/i);
  await expect(panel(page).getByText(body.message as string)).toBeVisible();

  // And the permission the operator granted for THAT question is gone again, even
  // though the question never ran. The worst version of getting this wrong is a
  // retry silently reusing a tick from a question that was refused.
  await expect(page.getByTestId("diagnostics-consent-search")).not.toBeChecked();
});

test("the conversation survives a navigation but the chosen record does not", async ({
  page,
}) => {
  await page.goto("/admin/bookings");
  await page.getByTestId("diagnostics-record-button").first().click();
  await expect(page.getByTestId("diagnostics-input")).toBeVisible();

  // Page guide is page-specific and genuinely stale after a move; an open
  // investigation is not, so the tab stays put (owner decision D8).
  //
  // The move must be IN-APP — the sidebar link, not page.goto(). D8's promise is
  // about navigating while investigating: the widget lives in the admin layout,
  // which Next preserves across soft navigations, so the panel and transcript
  // survive. A goto() is a full reload, and losing the conversation there is the
  // documented, owner-accepted Q5 cost ("do not silently introduce persistence
  // to avoid that UX cost") — the first cut of this test asserted D8 through a
  // reload and was testing Q5's cost instead.
  await page.getByRole("link", { name: "Payments" }).click();
  await page.waitForURL("**/admin/payments");
  // No launcher click: the panel never closed. It is still on Diagnostics.
  await expect(page.getByTestId("diagnostics-input")).toBeVisible();

  // Payments rows offer their own record, of the kind THIS route declares.
  await expect(
    page.getByTestId("diagnostics-record-button").first(),
  ).toHaveAccessibleName(/Ask diagnostics about the .* payment for /);
});

test("the page owns setup and status, and the budget states its own limits", async ({
  page,
}) => {
  await page.goto("/admin/ai-diagnostics");
  await expect(
    page.getByRole("heading", { name: "Monthly budget" }),
  ).toBeVisible();

  // A full admin holds support:view, so the figure is readable rather than refused.
  await expect(page.getByTestId("budget-input")).toBeVisible();

  // Save is inert until the figure actually changes — the server owns the number,
  // and an enabled Save on an unedited field invites a pointless write.
  await expect(page.getByTestId("budget-save")).toBeDisabled();

  // Module off: the whole setup page is behind the aiDiagnostics feature-route
  // rule, so it 404s rather than rendering a budget editor for a switched-off
  // product. (The budget card's own module-off copy is reachable only in a flip
  // race between the proxy's module read and the page's, which a browser test
  // cannot stage — its unit suite covers that state.)
  await setModuleSettings(page.request, {
    ...(previousModules as Record<string, boolean>),
    aiDiagnostics: false,
  });
  const offResponse = await page.goto("/admin/ai-diagnostics");
  expect(offResponse?.status()).toBe(404);

  await setModuleSettings(page.request, {
    ...(previousModules as Record<string, boolean>),
    aiDiagnostics: true,
  });
});
