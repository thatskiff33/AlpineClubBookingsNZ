import { expect, test } from "./helpers/accessibility";

// The status LINE for URLs nothing serves (#2405). The unit suite
// (src/app/__tests__/unmatched-url-status.test.ts) pins that the route code
// raises notFound(); only a real server can show what status that puts on the
// wire, which is the thing the issue was actually about — a soft 404 tells
// search engines a dead address is real content and tells monitoring that a
// missing page is a working one.
//
// Anonymous on purpose: these are the shapes a crawler or a vulnerability
// scanner asks for, so no login is used.
//
// This stack is seeded with SEED_THEME_COMPLETE=1 (.github/workflows/e2e.yml),
// so it renders the real public site. That matters here: without it the site is
// pre-setup, and since #2420 the proxy answers EVERY public address with 503 and
// the "Site setup in progress" holding screen — so every expectation below would
// fail loudly rather than, as before #2420, passing a status-blind read of a
// holding screen that answered 200. Measuring a stack that lacked the flag is
// how #2405 came to report a soft 404 that a configured club does not have.
//
// These cases double as the "setup complete" half of #2420's contract on a real
// server: 404 for a miss and 200 for /about are only reachable if the gate is
// genuinely inert once setup is done.

const unmatchedPageUrls = [
  "/definitely-missing",
  "/wp-admin/setup-config.php",
  "/.env",
  "/admin/nope",
];

test("unmatched website URLs answer 404, and still show the page-not-found screen", async ({
  page,
}) => {
  for (const url of unmatchedPageUrls) {
    const response = await page.goto(url);
    expect(response?.status(), `${url} must not be a soft 404`).toBe(404);

    // Status and body together, for EVERY url rather than whichever one the
    // loop happened to end on: a 404 that stopped showing the club's own "page
    // not found" content would pass a status-only assertion.
    //
    // The seeded /404 CMS page (prisma/starter-page-content.ts) renders its
    // title as an h1 AND the string again as an h2 from its contentHtml, so the
    // heading has to be pinned to level 1 or Playwright's strict mode resolves
    // two elements. The header text below appears ONLY on the database-backed
    // branch of src/app/not-found.tsx — the hardcoded fallback says something
    // different — so together they prove the CMS 404 rendered per-request
    // (#2356) rather than the emergency screen.
    await expect(
      page.getByRole("heading", { level: 1, name: "Page Not Found" }),
      `${url} must show the club's own 404 screen`,
    ).toBeVisible();
    await expect(
      page.locator('section[data-page-slug="404"]').first(),
    ).toBeVisible();
    await expect(
      page.getByText("The page you are looking for does not exist."),
    ).toBeVisible();
  }
});

test("a real published page is still 200 — the fix must not 404 live content", async ({
  page,
}) => {
  const response = await page.goto("/about");

  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "About" }).first()).toBeVisible();
});

test("unmatched /api URLs answer 404 as JSON, never the website's HTML page", async ({
  request,
}) => {
  // Before #2405 these fell through to the (website) CMS catch-all and a JSON
  // client was handed ~23KB of text/html. `/api` and `/api/` are in the list
  // because the first fix used a REQUIRED catch-all, which needs at least one
  // segment and so left the bare prefix on the HTML path; the route is an
  // optional catch-all now.
  for (const url of [
    "/api",
    "/api/",
    "/api/definitely-missing",
    "/api/admin/nope",
  ]) {
    const response = await request.get(url);

    expect(response.status(), `${url} must be a hard 404`).toBe(404);
    expect(
      response.headers()["content-type"],
      `${url} must not be answered with a document`,
    ).toContain("application/json");
    expect(await response.json()).toEqual({ error: "Not found" });
  }

  // A POST must not be answered any differently from a GET.
  const posted = await request.post("/api/definitely-missing");
  expect(posted.status()).toBe(404);
  expect(await posted.json()).toEqual({ error: "Not found" });

  // HEAD must carry GET's headers exactly. It is not exported by the route —
  // Next derives it from GET — precisely so that it cannot drift: a
  // hand-written HEAD carried no content-type, and that one missing header told
  // an anonymous prober whether an optional module was switched on.
  const headed = await request.head("/api/definitely-missing");
  expect(headed.status()).toBe(404);
  expect(headed.headers()["content-type"]).toContain("application/json");
});

test("a real API route is untouched by the catch-all", async ({ request }) => {
  const response = await request.get("/api/health");

  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");
});
