import { expect, test } from "../helpers/accessibility";
import { setSiteSetupComplete } from "../helpers/setup-state";

/**
 * The pre-setup gate ON THE WIRE (#2420, review finding F5).
 *
 * The unit suite calls the exported `proxy()` and asserts on the `NextResponse`
 * it returns — which is exactly the layer at which this whole class of bug LOOKS
 * fine. `NextResponse.rewrite(url, { status: 503 })` also carries `status: 503`
 * on the object and still answers 200 on the wire, because Next only propagates
 * a middleware status on the direct-response branch. Nothing but a real server
 * can tell those apart, so this spec exists to read the status line itself.
 *
 * ## Why this runs against the SAME stack, not a second one
 *
 * Every stack `scripts/e2e-stack.sh` builds is seeded `SEED_THEME_COMPLETE=1`,
 * so pre-setup was unmeasured. A second stack seeded without the flag was the
 * obvious answer and was rejected: it means another `docker compose up --build`,
 * another Postgres, another seed and another ~15-minute CI job, for four
 * assertions — and it would need a new required check added to branch
 * protection, which is not something this branch can do.
 *
 * Instead this is a project of its own that runs LAST (`dependencies:
 * ["chromium"]` in playwright.config.ts), flips the one row that decides the
 * state, and puts it back. Two things make that safe rather than reckless:
 * `workers: 1` and `fullyParallel: false`, so nothing else is in flight while
 * the site is closed; and it is the last thing to run, so even a failed restore
 * cannot affect another spec. The restore is still in `afterAll`, and the first
 * test of the run re-asserts the site is open, so a leaked state is loud.
 *
 * The state change is made directly against the database because the
 * application genuinely cannot make it: `saveClubTheme()` never clears
 * `completedAt`. See `e2e/helpers/setup-state.ts`.
 */

// The proxy caches the setup state for SETUP_STATE_TTL_MS (15s, see
// src/lib/setup-gate.ts), so a flip is not visible instantly. Written out rather
// than imported: pulling setup-gate.ts in would drag next/server and Prisma into
// the Playwright process for one number. Every assertion polls rather than
// sleeping, so a change to the TTL only affects how long this waits.
const SETTLE_MS = 30_000;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await setSiteSetupComplete(false);
});

test.afterAll(async () => {
  await setSiteSetupComplete(true);
});

test("every public address answers 503 with the holding screen", async ({
  request,
}) => {
  // `/` first, and polled: this is also where we wait out the proxy's cache.
  await expect
    .poll(async () => (await request.get("/")).status(), {
      timeout: SETTLE_MS,
      message: "the home page must answer 503 once setup is un-completed",
    })
    .toBe(503);

  // And the catch-all separately, because it is a different code path that
  // observes the same database write on its own schedule. Polling only `/` and
  // then asserting the rest in one pass is a race: it happens to hold here
  // because the loop below runs after the home page has already settled, but
  // the same shape in the completing direction below did NOT hold, and read a
  // stale 200 for a miss. Waiting for both paths costs nothing and removes the
  // question.
  await expect
    .poll(async () => (await request.get("/definitely-missing")).status(), {
      timeout: SETTLE_MS,
      message: "a miss must answer 503 once setup is un-completed",
    })
    .toBe(503);

  for (const url of ["/", "/about", "/contact", "/definitely-missing"]) {
    const response = await request.get(url);

    // A REAL page (/about, /contact) and a miss must be indistinguishable —
    // answering 200 for one and 503 for the other would publish the club's page
    // inventory from a half-built site.
    expect(response.status(), `${url} must answer 503 pre-setup`).toBe(503);

    const body = await response.text();
    expect(body, `${url} must carry the holding screen`).toContain(
      "Site setup in progress",
    );
    // The club's real page content must not appear on any of them.
    expect(body).not.toContain("dynamic-header");
  }
});

test("the 503 tells clients when to retry and forbids caching", async ({
  request,
}) => {
  const response = await request.get("/");
  const headers = response.headers();

  // Without Retry-After a long-running 503 is a signal to DROP the club's URLs
  // from an index; with it, it reads as a temporary outage.
  expect(headers["retry-after"]).toBeTruthy();
  // `/` is otherwise allow-listed as anonymously cacheable for 60s (#2322); the
  // holding screen must never be stored under that entry.
  expect(headers["cache-control"]).toContain("no-store");
  expect(headers["content-type"]).toContain("text/html");
});

test("the operator can still reach everything needed to finish setup", async ({
  request,
}) => {
  // The whole point of the gate is that it does not lock the admin out of the
  // wizard that ends it. Un-authenticated here, so a redirect to login is the
  // expected answer for the admin pages — what matters is that it is NOT 503.
  for (const url of ["/admin/site-style", "/admin", "/login"]) {
    const response = await request.get(url, { maxRedirects: 0 });

    expect(response.status(), `${url} must not be gated`).not.toBe(503);
  }

  // #2405's terminal JSON 404 must hold in this state too.
  const api = await request.get("/api/definitely-missing");
  expect(api.status()).toBe(404);
  expect(api.headers()["content-type"]).toContain("application/json");
  expect(await api.json()).toEqual({ error: "Not found" });

  // And a real API route keeps working, so the wizard can save.
  const health = await request.get("/api/health");
  expect(health.status()).toBe(200);
});

test("completing setup opens the site again", async ({ request }) => {
  await setSiteSetupComplete(true);

  await expect
    .poll(async () => (await request.get("/")).status(), {
      timeout: SETTLE_MS,
      message: "the site must open once setup is completed",
    })
    .toBe(200);

  // The gate is inert again: a miss goes back to being a real 404, not a 503.
  //
  // Polled, not asserted once, and for the same reason the assertion above is:
  // completing setup is a database write, and the two paths do not observe it
  // at the same instant. `/` turning 200 says the home route has caught up; it
  // says nothing about the catch-all that answers an unknown path, which is
  // served by its own code and settles on its own schedule. Asserting this one
  // synchronously the moment the first poll returned made it a race that lost
  // whenever the home route happened to settle first — reading 200, the gate
  // still serving the wizard for every path, rather than the 404 a miss earns
  // once the gate is genuinely inert.
  await expect
    .poll(async () => (await request.get("/definitely-missing")).status(), {
      timeout: SETTLE_MS,
      message: "a miss must go back to being a real 404 once setup is complete",
    })
    .toBe(404);
});
