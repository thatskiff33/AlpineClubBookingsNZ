import { type BrowserContext, expect, test, type Page } from "@playwright/test";
import { bookSelfToReviewStep, confirmBookingToPaymentStep } from "./helpers/booking";
import { bookingCreateIsolation } from "./helpers/booking-create-client-ip";
import { personas } from "./helpers/personas";
import { E2E_ADMIN, relDateOnly, shiftDateOnly } from "./helpers/fixtures";
import { storageStatePath } from "./helpers/auth";
import { cancelMemberBookingsOnDate } from "./helpers/reset";
import { stayWindow } from "./helpers/stay-dates";

// docs/END_TO_END_TEST_MATRIX.md row "Admin date override (#1668)": a Full Admin
// moves the dates of an in-progress and then a fully-past booking via the
// override control, choosing SHIFT (price frozen), and a member never sees the
// control. The over-capacity confirm path (step 5 of the issue spec) is
// deliberately covered at route/unit level instead of here — seeding a full
// window live inside this shared-DB serial suite is the fragile part the issue
// explicitly allows deferring — see admin-shift-booking-dates.test.ts,
// modify-admin-override.test.ts, modify-quote-shift.test.ts,
// modify-quote-recalc-override.test.ts, and
// calculate-modified-pricing-capacity.test.ts. The recalculate override path
// (which this shift-only journey never exercises) is covered by those last two
// plus resolve-target-dates-admin-override.test.ts.
//
// Shift is season-rate independent (it never prices), so this uses a fresh
// member booking on stayWindow(5) (indexes 0–4 are taken by other specs) and
// relies on the admin override to move it into the in-progress and fully-past
// date ranges the normal edit window locks.
test.describe.configure({ mode: "serial" });

// stayWindow itself skips the reserved September fixture Mondays (#1703) AND
// any Monday whose nights fall in a seeded-season gap (the October 2026 gap
// between Winter 2026 and Summer 2026-27), so index 5 is always clear of the
// seeded-FULL/offer/IB windows AND in-season on any run date.
const window = stayWindow(5);

// RETRY IDEMPOTENCY (#2302). Serial group + a booking this file CREATES and then
// MOVES: a retry re-runs the whole group against the leftover. `stayWindowForAttempt`
// cannot help — the window is a module-scope const with no `testInfo`, and the
// later tests must act on the booking the first one made — so the group's own
// `beforeAll` clears the leftover instead.
//
// Where can the leftover be? On `window.checkIn` if the group got as far as
// parking it back (or failed before the first shift), otherwise on whichever
// override target the failing attempt stopped at: relDateOnly(-5), (-4), (-1) or (0).
// The sweep below covers -6…+1, one day of slack either side so an attempt and
// its retry that straddle NZ midnight still line up. Every date is matched
// against the booker as OWNER, so this can only ever clear a booking this file
// itself created: Alice's one seeded booking sits at -25 days, and the -7…-15
// band admin-retroactive-booking.spec.ts uses is outside the sweep.
const OVERRIDE_LEFTOVER_OFFSETS = [-6, -5, -4, -3, -2, -1, 0, 1];

let memberContext: BrowserContext;
let adminContext: BrowserContext;
let bookingId = "";

// The bold "Total" row on the booking Payment card, reduced to its digits so a
// frozen price can be compared across shifts.
async function readTotalDigits(page: Page): Promise<string> {
  const row = page.locator("div.font-bold", { hasText: "Total" }).first();
  await expect(row).toBeVisible();
  return (await row.innerText()).replace(/[^0-9.]/g, "");
}

// Open the admin override editor, choose SHIFT, move the check-in (the check-out
// derives to preserve the night count), and save. Returns after the editor has
// closed on success.
async function adminShiftTo(
  page: Page,
  newCheckIn: string,
  { emailMember = false }: { emailMember?: boolean } = {},
): Promise<void> {
  await page.goto(`/bookings/${bookingId}`);
  await page.getByRole("button", { name: "Edit Booking" }).click();

  await page
    .getByRole("checkbox", { name: /Move locked\/past dates \(admin override\)/ })
    .check();
  await page.getByRole("radio", { name: /Shift dates only/ }).check();

  await page.locator("#edit-checkin").fill(newCheckIn);
  // Shift mode derives the check-out from the check-in, preserving the length.
  await expect(page.locator("#edit-checkout")).toHaveValue(
    shiftDateOnly(newCheckIn, window.nights.length),
  );

  const save = page.getByRole("button", { name: "Save Changes" });
  await expect(save).toBeEnabled({ timeout: 30_000 });
  // Every override save asks whether to email the member (owner decision,
  // #1668 review); both choices apply the change.
  await save.click();
  const notifyChoice = page.getByRole("button", {
    name: emailMember ? "Save and email member" : "Save without emailing",
  });
  await expect(notifyChoice).toBeVisible();
  // Wait for the PUT itself: the Save button renames to "Saving..." the
  // instant the dialog choice fires, so any button-based wait passes while
  // the save is still in flight — the caller's next navigation would abort it
  // mid-request (the first CI run failed exactly this way, booking
  // unchanged). modify-quote also matches a "/modify" substring, hence
  // endsWith + method.
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/bookings/${bookingId}/modify`) &&
        r.request().method() === "PUT",
      { timeout: 30_000 },
    ),
    notifyChoice.click(),
  ]);
  expect(response.ok(), `shift save (${response.status()})`).toBeTruthy();

  // On success the editor closes (router.refresh + onDone) and the Stay Details
  // view returns.
  await expect(
    page.getByRole("button", { name: "Edit Booking" }),
  ).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(async ({ browser }) => {
  memberContext = await browser.newContext({
    storageState: storageStatePath(personas.booker.email),
  });

  // Reuse the E2E admin session saved once in auth.setup.ts instead of a fresh
  // per-spec login (#1779).
  adminContext = await browser.newContext({
    storageState: storageStatePath(E2E_ADMIN.email),
  });

  // Re-runs on every attempt (a retry restarts the worker); a clean first
  // attempt cancels nothing. Full admin matters here: the started-stay block
  // (#2029) is waived only for ADMIN, and a leftover parked on relDateOnly(-5) has
  // started.
  await cancelMemberBookingsOnDate(adminContext.request, {
    memberName: `${personas.booker.firstName} ${personas.booker.lastName}`,
    checkIn: [window.checkIn, ...OVERRIDE_LEFTOVER_OFFSETS.map(relDateOnly)],
  });
});

test.afterAll(async () => {
  await memberContext?.close();
  await adminContext?.close();
});

test("member books a future stay for the admin to override", async ({}, testInfo) => {
  const page = await memberContext.newPage();
  await bookSelfToReviewStep(page, personas.booker, window);
  await confirmBookingToPaymentStep(
    page,
    bookingCreateIsolation("admin-override-seed", testInfo.retry),
  );

  // The wizard stays on /book at the in-wizard PayStep (no navigation happens
  // until payment completes), but the booking already exists — follow the
  // PayStep's "View booking details" link to capture its id.
  await page.getByRole("link", { name: "View booking details" }).click();
  await expect(page).toHaveURL(/\/bookings\/[^/]+$/);
  bookingId = new URL(page.url()).pathname.split("/").pop() ?? "";
  expect(bookingId).not.toBe("");
  await page.close();
});

test("admin shifts a future booking into an in-progress stay with the price frozen", async () => {
  const page = await adminContext.newPage();
  await page.goto(`/bookings/${bookingId}`);
  const totalBefore = await readTotalDigits(page);

  // Move check-in to yesterday: a 2-night stay then spans [yesterday, tomorrow),
  // i.e. checkIn <= today < checkOut — a genuinely in-progress booking. This
  // one exercises the "Save and email member" dialog path; the later shifts
  // take "Save without emailing".
  await adminShiftTo(page, relDateOnly(-1), { emailMember: true });

  await page.reload();
  await expect(page.getByRole("button", { name: "Edit Booking" })).toBeVisible();
  // Price unchanged by the shift.
  expect(await readTotalDigits(page)).toBe(totalBefore);
  // Re-open the editor to confirm the persisted check-in moved.
  await page.getByRole("button", { name: "Edit Booking" }).click();
  await expect(page.locator("#edit-checkin")).toHaveValue(relDateOnly(-1));
  await page.close();
});

test("admin shifts the in-progress booking forward one night (the motivating case)", async () => {
  const page = await adminContext.newPage();
  await page.goto(`/bookings/${bookingId}`);
  const totalBefore = await readTotalDigits(page);

  await adminShiftTo(page, relDateOnly(0)); // check-in = today

  await page.reload();
  await page.getByRole("button", { name: "Edit Booking" }).click();
  await expect(page.locator("#edit-checkin")).toHaveValue(relDateOnly(0));
  // Frozen price survives a second shift too.
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await readTotalDigits(page)).toBe(totalBefore);
  await page.close();
});

test("a member does NOT see the admin override control on their own in-progress booking", async () => {
  const page = await memberContext.newPage();
  await page.goto(`/bookings/${bookingId}`);
  // A member may still edit an in-progress booking (future nights), so the Edit
  // Booking button can show — but the override card must not.
  const editButton = page.getByRole("button", { name: "Edit Booking" });
  if (await editButton.isVisible().catch(() => false)) {
    await editButton.click();
  }
  await expect(
    page.getByRole("checkbox", {
      name: /Move locked\/past dates \(admin override\)/,
    }),
  ).toHaveCount(0);
  await page.close();
});

test("admin moves the booking fully into the past, then shifts it again", async () => {
  const page = await adminContext.newPage();
  await page.goto(`/bookings/${bookingId}`);
  const totalBefore = await readTotalDigits(page);

  // Fully past: check-in 5 days ago → a 2-night stay ends 3 days ago (checkOut
  // <= today), which the member-facing edit window refuses outright.
  await adminShiftTo(page, relDateOnly(-5));

  await page.reload();
  await page.getByRole("button", { name: "Edit Booking" }).click();
  await expect(page.locator("#edit-checkin")).toHaveValue(relDateOnly(-5));
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  // Move the fully-past record again (+1 day) — the fully-past path end to end.
  await adminShiftTo(page, relDateOnly(-4));
  await page.reload();
  await expect(page.getByRole("button", { name: "Edit Booking" })).toBeVisible();
  expect(await readTotalDigits(page)).toBe(totalBefore);

  // Park the booking back in its own dedicated future window (a full-circle
  // override: past → future). With auto-allocation on, each shift drafts THIS
  // booking's guest onto its resting nights (#1686 scoped reconcile) — parked
  // near today those could collide with bed-allocation.spec's fixed July seed
  // window (Bunk Room A/A1) on unlucky run dates, so never leave them there.
  await adminShiftTo(page, window.checkIn);
  await page.reload();
  await page.getByRole("button", { name: "Edit Booking" }).click();
  await expect(page.locator("#edit-checkin")).toHaveValue(window.checkIn);
  await page.close();
});
