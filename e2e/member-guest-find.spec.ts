import {
  type APIRequestContext,
  type BrowserContext,
  type Page,
  expect,
  test,
} from "./helpers/accessibility";
import { loginPersona } from "./helpers/auth";
import {
  completeMemberDetailsGateIfShown,
  selectCalendarDay,
} from "./helpers/booking";
import { E2E_ADMIN, NOMINATOR_TWO, WAITLISTER } from "./helpers/fixtures";
import { overrideModules, type ModuleSettings } from "./helpers/modules";
import { stayWindow } from "./helpers/stay-dates";

/*
  #2308 (epic #2305, MG3) — finding another member to add as a guest, end to end.

  Matrix row (docs/END_TO_END_TEST_MATRIX.md, "Booking privacy + enumeration"):
  one journey per find mode plus a module-OFF assertion.

  WHY THIS SPEC IS DELIBERATELY API-HEAVY, with only the surface checked in the
  browser. What MG3 has to be right about is a privacy envelope — which statuses
  come back, which fields a row carries, which route exists — and those are
  claims about RESPONSES, not about pixels. Driving them through the wizard would
  test the wizard's debounce far more than it tested the envelope, and would make
  the spec's failures ambiguous exactly where its assertions need to be sharp.
  What genuinely IS visual — does the button appear, is the panel inline rather
  than a dialog, does the whole surface disappear when the club has the module
  off — is checked in the browser, in the LAST describe, for the reason set out
  above it.

  MECHANICS:
    - Wanda (WAITLISTER) is the signed-in booker doing the finding. Nadia
      (NOMINATOR_TWO) is a member outside Wanda's family group, which is what
      makes her the interesting target.
    - NO BOOKING IS CREATED. The browser walk stops at the guests step, so this
      spec claims no capacity and leaves no person-night behind for its own retry
      to trip over; the calendar clicks use a spare stay window so they cannot
      collide with another spec's nights either.
    - The memberGuests module and the two search settings are driven through
      their admin routes and restored afterwards.
*/

test.describe.configure({ mode: "serial" });

let adminContext: BrowserContext;
let adminRequest: APIRequestContext;
let previousModules: ModuleSettings | null = null;
let previousSettings: Record<string, unknown> | null = null;

let wandaContext: BrowserContext;
let wandaRequest: APIRequestContext;

const RESOLVE = "/api/members/guest-candidates/resolve";
const SEARCH = "/api/members/guest-candidates/search";
const CONFIG = "/api/members/guest-candidates";

// The wizard opens on the DATES step; `GuestForm` — and therefore both add
// buttons — only exists once a check-in and a check-out have been chosen. The
// first version of this spec went straight to `/book` and asserted on the
// non-member button, so the control assertion could never pass and it took the
// whole serial file down with it. Drive the wizard the way `booking.spec.ts`
// does, with the shared helpers, rather than inventing navigation here.
//
// NO BOOKING IS CREATED: the walk stops at the guests step, so this still
// touches no capacity and leaves no person-night behind. The window index is a
// spare one, so even the calendar clicks cannot collide with another spec.
const GUESTS_STEP_WINDOW = stayWindow(11);

async function openGuestsStep(page: Page): Promise<void> {
  await page.goto("/book");
  await completeMemberDetailsGateIfShown(page);
  await expect(page.getByText("Select Your Dates")).toBeVisible();
  await selectCalendarDay(page, GUESTS_STEP_WINDOW.checkIn);
  await selectCalendarDay(page, GUESTS_STEP_WINDOW.checkOut);
}

async function setSearchSettings(overrides: {
  openMemberSearchEnabled: boolean;
  openMemberSearchIncludesMinors?: boolean;
}) {
  const current = await adminRequest.get("/api/admin/member-guest-settings");
  expect(current.ok(), `GET member-guest-settings (${current.status()})`).toBeTruthy();
  const body = (await current.json()) as { settings: Record<string, unknown> };
  const res = await adminRequest.put("/api/admin/member-guest-settings", {
    data: {
      approvalRequired: body.settings.approvalRequired,
      pendingHoldExpiryDays: body.settings.pendingHoldExpiryDays,
      openMemberSearchIncludesMinors: false,
      ...overrides,
    },
  });
  expect(res.ok(), `PUT member-guest-settings (${res.status()})`).toBeTruthy();
}

test.beforeAll(async ({ browser }) => {
  adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await loginPersona(adminPage, E2E_ADMIN.email);
  adminRequest = adminPage.request;

  const current = await adminRequest.get("/api/admin/member-guest-settings");
  expect(current.ok()).toBeTruthy();
  previousSettings = ((await current.json()) as { settings: Record<string, unknown> })
    .settings;
  // Captured ONCE, here, rather than in whichever describe happens to flip the
  // module first: the browser assertions now run last (see the note above the
  // final describe), so a per-describe capture would have recorded the state a
  // previous describe had already changed and "restored" the club to it.
  previousModules = await overrideModules(adminRequest, {});

  wandaContext = await browser.newContext();
  const wandaPage = await wandaContext.newPage();
  await loginPersona(wandaPage, WAITLISTER.email);
  wandaRequest = wandaPage.request;
});

test.afterAll(async () => {
  // Restore in the safe order: settings first, then the module, so there is
  // never an instant where the module is on with another spec's search posture.
  if (previousSettings) {
    await adminRequest.put("/api/admin/member-guest-settings", {
      data: {
        approvalRequired: previousSettings.approvalRequired,
        pendingHoldExpiryDays: previousSettings.pendingHoldExpiryDays,
        openMemberSearchEnabled: previousSettings.openMemberSearchEnabled,
        openMemberSearchIncludesMinors:
          previousSettings.openMemberSearchIncludesMinors,
      },
    });
  }
  if (previousModules) {
    await adminRequest.put("/api/admin/modules", { data: { settings: previousModules } });
  }
  await wandaContext?.close();
  await adminContext?.close();
});

test.describe("module OFF — the surface does not exist", () => {
  test.beforeAll(async () => {
    await overrideModules(adminRequest, { memberGuests: false });
  });

  test("both find routes 404 for a club that has not turned the module on", async () => {
    const resolve = await wandaRequest.post(RESOLVE, {
      data: { email: NOMINATOR_TWO.email },
    });
    // 404, not 403: a 403 would confirm the club HAS the feature and merely
    // disabled it for this caller.
    expect(resolve.status()).toBe(404);
    expect((await wandaRequest.get(`${SEARCH}?q=nad`)).status()).toBe(404);

    const config = await wandaRequest.get(CONFIG);
    expect(config.ok()).toBeTruthy();
    expect(await config.json()).toEqual({ enabled: false });
  });
});

test.describe("module ON, open search OFF — the default every club gets", () => {
  test.beforeAll(async () => {
    await overrideModules(adminRequest, { memberGuests: true });
    await setSearchSettings({ openMemberSearchEnabled: false });
  });

  test("an exact email resolves the member, and the name route does not exist", async () => {
    const resolve = await wandaRequest.post(RESOLVE, {
      data: { email: NOMINATOR_TWO.email },
    });
    expect(resolve.status()).toBe(200);
    const body = (await resolve.json()) as {
      candidates: Array<Record<string, unknown>>;
    };
    expect(body.candidates.length).toBeGreaterThanOrEqual(1);
    const nadia = body.candidates.find(
      (candidate) => candidate.firstName === NOMINATOR_TWO.firstName,
    );
    expect(nadia).toBeTruthy();
    // D-19: full name and age group ONLY. This assertion is the row shape's last
    // line of defence — a `select` that grew a field would show up here.
    expect(Object.keys(nadia!).sort()).toEqual([
      "ageTier",
      "firstName",
      "lastName",
      "memberId",
    ]);

    // The name type-ahead is a per-club opt-in and this club has not taken it.
    expect((await wandaRequest.get(`${SEARCH}?q=nom`)).status()).toBe(404);
  });

  test("an unknown address answers with exactly the same shape and status", async () => {
    const miss = await wandaRequest.post(RESOLVE, {
      data: { email: "definitely-nobody-here@example.invalid" },
    });
    expect(miss.status()).toBe(200);
    expect(await miss.json()).toEqual({ candidates: [] });
  });

});

test.describe("open search ON — the browsable membership list a club opts into", () => {
  test.beforeAll(async () => {
    await overrideModules(adminRequest, { memberGuests: true });
    await setSearchSettings({
      openMemberSearchEnabled: true,
      openMemberSearchIncludesMinors: false,
    });
  });

  test("the name route now exists and narrows by prefix", async () => {
    const res = await wandaRequest.get(
      `${SEARCH}?q=${encodeURIComponent(NOMINATOR_TWO.lastName.slice(0, 3))}`,
    );
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      candidates: Array<{ firstName: string; lastName: string; ageTier: string }>;
      truncated?: boolean;
    };
    expect(
      body.candidates.some((c) => c.firstName === NOMINATOR_TWO.firstName),
    ).toBe(true);
    expect(body.candidates.length).toBeLessThanOrEqual(10);
    // The truncation signal is a boolean. A count would be a free
    // membership-size oracle.
    expect(typeof (body.truncated ?? false)).toBe("boolean");
    expect(JSON.stringify(body)).not.toContain('"total"');
  });

  test("a one-character query is refused work rather than dumping the roll", async () => {
    const res = await wandaRequest.get(`${SEARCH}?q=n`);
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ candidates: [], truncated: false });
  });

  test("no candidate row carries an email address, in either mode", async () => {
    const search = await wandaRequest.get(
      `${SEARCH}?q=${encodeURIComponent(NOMINATOR_TWO.lastName.slice(0, 3))}`,
    );
    const resolve = await wandaRequest.post(RESOLVE, {
      data: { email: NOMINATOR_TWO.email },
    });
    for (const res of [search, resolve]) {
      const text = await res.text();
      expect(text).not.toContain("@");
    }
  });

  test("turning it back off makes the route 404 again, with no redeploy", async () => {
    await setSearchSettings({ openMemberSearchEnabled: false });
    expect((await wandaRequest.get(`${SEARCH}?q=nom`)).status()).toBe(404);
  });
});

/*
  THE BROWSER ASSERTIONS RUN LAST, DELIBERATELY.

  This file is serial, so the first failure skips everything after it — and the
  first version put the one browser test at the very top, where a navigation
  mistake in it silently took every privacy assertion in the file with it (the
  spec contributed nothing at all, while the PR body still claimed the
  properties). The API assertions are the ones that carry the privacy claims and
  they are cheap and deterministic, so they go first; anything that has to drive
  a wizard through a calendar goes here, where the worst it can cost is itself.
*/
test.describe("the wizard surface", () => {
  test.beforeAll(async () => {
    await overrideModules(adminRequest, { memberGuests: true });
    await setSearchSettings({ openMemberSearchEnabled: false });
  });

  test("offers the button and opens the find panel inline", async () => {
    const page = await wandaContext.newPage();
    await openGuestsStep(page);
    const button = page.getByRole("button", { name: "+ Add Member Guest" });
    await expect(button).toBeVisible();
    await button.click();
    const panel = page.getByTestId("member-guest-find-panel");
    // Inline, under the Guests heading (owner sign-off answer 3) — not a dialog.
    await expect(panel).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByLabel("Find a member by email address")).toBeVisible();
    await page.close();
  });

  test("offers one box for either a name or an address once open search is on", async () => {
    await setSearchSettings({
      openMemberSearchEnabled: true,
      openMemberSearchIncludesMinors: false,
    });
    const page = await wandaContext.newPage();
    await openGuestsStep(page);
    await page.getByRole("button", { name: "+ Add Member Guest" }).click();
    // Owner sign-off answer 2: ONE box, no mode switch.
    await expect(
      page.getByLabel("Find a member by name or email address"),
    ).toBeVisible();
    await expect(page.getByLabel("Find a member by email address")).toHaveCount(0);
    await page.close();
  });

  test("disappears entirely when the club turns the module off", async () => {
    await overrideModules(adminRequest, { memberGuests: false });
    const page = await wandaContext.newPage();
    await openGuestsStep(page);
    await expect(
      page.getByRole("button", { name: "+ Add Member Guest" }),
    ).toHaveCount(0);
    // The existing non-member button is untouched, so this proves the surface
    // disappeared rather than the whole step failing to render.
    await expect(
      page.getByRole("button", { name: "+ Add Non-Member Guest" }),
    ).toBeVisible();
    await page.close();
  });
});
