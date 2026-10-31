import { expect, test } from "./helpers/accessibility";
import { storageStatePath } from "./helpers/auth";
import { E2E_ADMIN } from "./helpers/fixtures";
import {
  ROUTE_ERROR_PROBE_COOKIE,
  ROUTE_ERROR_PROBE_HEADING,
  ROUTE_ERROR_PROBE_MESSAGE,
  ROUTE_ERROR_PROBE_PATH,
  ROUTE_ERROR_PROBE_THROW,
} from "../src/lib/route-error-probe";
import { ROUTE_GROUP_BOUNDARIES } from "../src/lib/route-group-boundaries";

// Issue #4467, item 1, acceptance: "an E2E test that throws inside an admin page
// shows the admin error boundary with a working retry".
//
// The page that throws is the test-only route-error probe (src/lib/route-error-
// probe.ts): it fails while this browser context sends the probe cookie and
// renders a fixed heading once it does not. The toggle lives in the CONTEXT, not
// the database, so a retried attempt starts clean (flake invariant 1) and nothing
// here races another spec. Every assertion is role- or attribute-scoped rather
// than a bare getByText on page content (flake invariant 2), so it stays sound
// if this route ever streams behind a loading boundary.
test.use({ storageState: storageStatePath(E2E_ADMIN.email) });

test("a failing admin page shows the admin error screen inside the admin layout, and Try again recovers it", async ({
  page,
  context,
  baseURL,
}) => {
  if (!baseURL) throw new Error("The Playwright config always sets baseURL.");
  await context.addCookies([
    {
      name: ROUTE_ERROR_PROBE_COOKIE,
      value: ROUTE_ERROR_PROBE_THROW,
      url: baseURL,
    },
  ]);

  await page.goto(ROUTE_ERROR_PROBE_PATH);

  // The admin group's boundary, not the root one: it renders inside the admin
  // layout, so the officer keeps the sidebar and their place in it.
  const boundary = page.locator('[data-route-error="admin"]');
  await expect(
    boundary.getByRole("heading", { name: "Something went wrong" }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Admin sections" }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${ROUTE_ERROR_PROBE_PATH}$`));

  // The way back stays in the admin area.
  const { homeHref, homeLabel } = ROUTE_GROUP_BOUNDARIES.admin;
  await expect(boundary.getByRole("link", { name: homeLabel })).toHaveAttribute(
    "href",
    homeHref,
  );

  // The digest is shown. The message check below is a smoke check only: in a
  // production build Next already replaces a Server Component error's message
  // before it reaches the browser, so it would pass without the boundary's own
  // rule. That rule — never render the message, including a Client Component
  // error that keeps its original one — is proved by
  // src/components/__tests__/route-error.test.tsx.
  await expect(boundary.getByText(/^Error ID:/)).toBeVisible();
  await expect(page.getByText(ROUTE_ERROR_PROBE_MESSAGE)).toHaveCount(0);

  // Stop the failure, then retry: `retry()` re-fetches the segment from the
  // server, so the same URL now renders and the boundary is gone.
  await context.clearCookies({ name: ROUTE_ERROR_PROBE_COOKIE });
  await boundary.getByRole("button", { name: "Try again" }).click();

  await expect(
    page.getByRole("heading", { name: ROUTE_ERROR_PROBE_HEADING }),
  ).toBeVisible();
  await expect(boundary).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Admin sections" }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${ROUTE_ERROR_PROBE_PATH}$`));
});
