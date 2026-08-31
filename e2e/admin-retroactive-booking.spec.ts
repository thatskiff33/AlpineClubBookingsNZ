import { type BrowserContext, expect, test, type Page } from "@playwright/test";
import { storageStatePath } from "./helpers/auth";
import {
  overrideSingleLodgeAutoAllocation,
  setBedAllocationSettings,
  type BedAllocationSettingsSnapshot,
} from "./helpers/bed-allocation-settings";
import {
  bookingCreateIsolation,
  postBookingCreate,
  withBookingCreateClientIp,
} from "./helpers/booking-create-client-ip";
import { completeMemberDetailsGateIfShown } from "./helpers/booking";
import { personas } from "./helpers/personas";
import {
  DEMO_BOOKING_WINDOWS,
  E2E_ADMIN,
  relDateOnly,
  WAITLIST_FULL_WINDOW,
} from "./helpers/fixtures";
import {
  CALENDAR_CLICK_TIMEOUT_MS,
  walkCalendarToMonth,
} from "./helpers/calendar-navigation";
import { cancelMemberBookingsOnDate } from "./helpers/reset";
import {
  calendarDayLabel,
  pastStayLeftoverCheckIns,
  pastStayWindowForAttempt,
} from "./helpers/stay-dates";

// docs/END_TO_END_TEST_MATRIX.md row "Admin retroactive create (#1695)": a Full
// Admin records a stay that already happened via /admin/book — toggle "Record a
// past stay", pick past dates inside the seeded Winter season, and confirm with
// an explicit member-email choice. The over-capacity confirm and Xero lock-date
// guard paths are covered at route/service level (Xero is not connected in E2E,
// so the lock guard is a no-op here by design). Negatives: a member's own /book
// calendar keeps past days disabled, and a member POST carrying allowPastDates
// is rejected 403.
//
// Past dates are chosen relative to the run clock and must land inside the
// seeded (relative) Winter season — the same season-coverage constraint every
// date-based spec carries (issue #2117: seasons and seeded bookings are now
// relative, so attempts 0/1/2 at -7/-11/-15 days are always in-season and
// clear of the seeded windows on any run date).
test.describe.configure({ mode: "serial" });

let memberContext: BrowserContext;
let adminContext: BrowserContext;
let bedAllocationSettingsBefore: BedAllocationSettingsSnapshot | undefined;

// Seeded windows the sliding past window must dodge (prisma/e2e-fixtures.ts,
// now RELATIVE — issue #2117). The retroactive create would otherwise fail:
// - Alice's own DRAFT booking counts for the member-night conflict check
//   (aliceDraft sits deep in the past at -25 days, well clear of both the -7..-15
//   attempt band and the -16..-6 leftover sweep below, but is listed so the dodge
//   stays honest if its offset ever changes).
// - The waitlist fixture window is seeded full to lodge capacity, which would
//   trigger the over-capacity confirm dialog this happy-path spec does not
//   drive (it is a future Monday, so it never overlaps a past window anyway).
const SEEDED_BLOCKED_RANGES: ReadonlyArray<readonly [string, string]> = [
  [DEMO_BOOKING_WINDOWS.aliceDraft.checkIn, DEMO_BOOKING_WINDOWS.aliceDraft.checkOut],
  [WAITLIST_FULL_WINDOW.checkIn, WAITLIST_FULL_WINDOW.checkOut],
];

// A retroactive stay can cross a month boundary in EITHER direction: the walk to
// the past check-in goes BACK from the month the calendar opened on, and the
// check-out two nights later can then be in the NEXT month. Each is at most ONE
// hop, since the -7…-15 attempt band never spans more than one month boundary,
// and a two-night stay never spans more than one either.
//
// Tightened from 14 to 2 (#3221). The walk now derives its own direction from the
// month the calendar is showing, so this bound is the ONLY remaining check that
// the caller's belief about where the calendar is matches reality — 14 hops would
// silently absorb a walk that had no business hopping at all. Two is the one-hop
// worst case plus a single hop of margin, and exhausting it fails naming both the
// month it could not reach and the one it is stuck on (#2626) rather than walking
// on to click a day button that is not rendered.
const MAX_PAST_MONTH_HOPS = 2;

// Navigate from the month the calendar currently displays to the month holding
// dateOnly, then click the day. The walk reads the displayed month itself, so
// this no longer has to be told — or guess — where the calendar opened (#3221).
async function selectPastCalendarDay(
  page: Page,
  dateOnly: string,
): Promise<void> {
  await walkCalendarToMonth(page, {
    target: dateOnly,
    maxHops: MAX_PAST_MONTH_HOPS,
    context: `retroactive stay day ${dateOnly}`,
  });
  // Bounded with the walk's own per-click budget. Every day here is in the PAST,
  // so this is the click most exposed to a day that resolves but is not
  // actionable — the calendar disables past days unless "Record a past stay" has
  // taken effect. Unbounded, that waits out the 90 s test budget and reports
  // `Target page, context or browser has been closed` (#2302, #2626).
  await page
    .getByRole("button", { name: calendarDayLabel(dateOnly) })
    .click({ timeout: CALENDAR_CLICK_TIMEOUT_MS });
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);

  memberContext = await browser.newContext({
    storageState: storageStatePath(personas.booker.email),
  });

  // Reuse the E2E admin session saved once in auth.setup.ts instead of a fresh
  // per-spec login (#1779).
  adminContext = await browser.newContext({
    storageState: storageStatePath(E2E_ADMIN.email),
  });

  // RETRY AND RE-RUN IDEMPOTENCY (#2625). The first test creates a real PENDING
  // booking through the create route and nothing removed it, so this spec was
  // the one date-based spec that could not run twice against one seeded database:
  // the second run met its own leftover on attempt 0's past nights and failed
  // with BOOKING_MEMBER_NIGHT_CONFLICT. `pastStayWindowForAttempt` gives each
  // ATTEMPT its own band, which is why a hosted retry survives, but it cannot
  // help a re-RUN (attempt 0 again) or the next DAY's run (the bands slide with
  // the run date while the leftover does not) — so the reset is the tool, in the
  // group `beforeAll` that re-runs on every attempt. A clean first run cancels
  // nothing.
  //
  // Full admin matters twice over: opting out of the cancellation email is
  // booking-management-admin only, and every date here is in the past, so the
  // started-stay block (#2029) has to be waived — which it is for ADMIN only.
  // Matched against the booker as OWNER, and the sweep covers every check-in
  // that can hold one of this run's nights, not just attempt 0's.
  await cancelMemberBookingsOnDate(adminContext.request, {
    memberName: `${personas.booker.firstName} ${personas.booker.lastName}`,
    checkIn: pastStayLeftoverCheckIns(),
  });

  // A retroactive (cross-month) create can trigger the reconcile sweep to
  // auto-place bookings lodge-wide; disable auto-allocation for this spec so it
  // never disturbs the bed-allocation spec's fixtures (which owns the same
  // setting for its own run).
  bedAllocationSettingsBefore = await overrideSingleLodgeAutoAllocation(
    adminContext.request,
    false,
  );
});

test.afterAll(async () => {
  try {
    if (adminContext) {
      if (bedAllocationSettingsBefore) {
        await setBedAllocationSettings(
          adminContext.request,
          bedAllocationSettingsBefore,
        );
      }
    }
  } finally {
    await memberContext?.close();
    await adminContext?.close();
  }
});

test("an admin records a past stay on behalf of a member without emailing them", async ({}, testInfo) => {
  const { checkIn: pastCheckIn, checkOut: pastCheckOut } =
    pastStayWindowForAttempt(testInfo.retry, SEEDED_BLOCKED_RANGES);
  const page = await adminContext.newPage();
  await page.goto("/admin/book");
  await expect(
    page.getByRole("heading", { name: "Book on Behalf of Member" }),
  ).toBeVisible();

  // Pick the target member through the search picker.
  // #2264: the picker's visible label is now associated with its input, so
  // select by accessible name instead of by placeholder.
  await page
    .getByRole("textbox", { name: "Search for a member to book on behalf of" })
    .fill(personas.booker.firstName);
  await page
    .getByRole("button", {
      name: new RegExp(
        `${personas.booker.firstName} ${personas.booker.lastName}`,
      ),
    })
    .first()
    .click();

  await expect(page.getByText("Select Dates", { exact: true })).toBeVisible();

  // Opt into retroactive booking, then pick past dates inside the seeded season.
  await page.getByRole("checkbox", { name: /Record a past stay/ }).check();
  await selectPastCalendarDay(page, pastCheckIn);
  await selectPastCalendarDay(page, pastCheckOut);

  // Quick-add the member themselves as the guest.
  await page
    .getByRole("button", {
      name: `+ ${personas.booker.firstName} ${personas.booker.lastName}`,
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  await expect(page.getByText("Booking Summary")).toBeVisible();
  // The review step flags the retroactive context.
  await expect(page.getByText(/Recording a past stay/)).toBeVisible();

  // Confirm opens the per-create email-choice dialog; take "without emailing".
  await page.getByRole("button", { name: "Confirm Booking" }).click();
  const withoutEmail = page.getByRole("button", {
    name: "Create without emailing",
  });
  await expect(withoutEmail).toBeVisible();

  // The persisted booking renders its past check-in date. Match the full
  // formatted date ("Friday, 3 July 2026") — a bare day-number regex collides
  // with timestamps elsewhere on the page (strict-mode violation).
  const [y, m, d] = pastCheckIn.split("-").map(Number);
  const checkInText = new Date(y, m - 1, d).toLocaleDateString("en-NZ", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  // Wait for the POST itself — the Confirm button flips to "Creating booking..."
  // the instant the dialog choice fires, so a button-state wait would race the
  // in-flight request and the caller's navigation could abort it.
  await withBookingCreateClientIp(
    page,
    bookingCreateIsolation("admin-retroactive-record", testInfo.retry),
    {
      trigger: () =>
        Promise.all([
          page.waitForResponse(
            (r) =>
              r.url().endsWith("/api/bookings") &&
              r.request().method() === "POST",
            { timeout: 30_000 },
          ),
          withoutEmail.click(),
        ]),
      // The create navigates, so the interception is held until the new
      // booking's own detail page is really rendered.
      waitForOutcome: async ([response]) => {
        expect(
          response.status(),
          `retroactive create (${response.status()})`,
        ).toBe(201);
        await expect(page).toHaveURL(/\/bookings\/[A-Za-z0-9-]+$/);
        await expect(page.getByText(checkInText).first()).toBeVisible();
      },
    },
  );
  await page.close();
});

test("a member's own /book calendar keeps past days disabled", async () => {
  const page = await memberContext.newPage();
  await page.goto("/book");
  // The shared gate helper, not a local copy (#2626). This test used to carry its
  // own two-branch version that only knew the "Confirm details are correct" and
  // "Confirm and finish" steps, and sampled them in the same tick the dialog
  // title appeared. Alice's demo-seed profile is missing a date of birth and a
  // postal address, so the gate actually opens on its PROFILE step — "Save and
  // continue", which the copy had no branch for — and it sat there open with the
  // whole page behind the modal overlay and out of the accessibility tree. Then
  // the walk below could not find the calendar at all and hung on a click.
  //
  // It passed in hosted CI only because the full suite runs
  // `admin-override-dates.spec.ts` first, and that spec's `bookSelfToReviewStep`
  // completes Alice's onboarding through this same shared helper. Run this spec on
  // its own — which is exactly how it is run while working on it — and the gate is
  // still outstanding.
  await completeMemberDetailsGateIfShown(page);
  await expect(page.getByText("Select Your Dates")).toBeVisible();

  // Step back to a month whose every day is in the past, and which must therefore
  // be entirely disabled for a member (no retroactive flag on the member
  // calendar). relDateOnly(-32) is one or two months back depending on the run date,
  // so three hops is the bound — and, unlike before, running out of them now
  // fails on the month it could not reach instead of silently walking on to
  // assert against a day button that is not rendered.
  const lastMonth = relDateOnly(-32);
  await walkCalendarToMonth(page, {
    target: lastMonth,
    maxHops: 3,
    context: `the fully-past month holding ${lastMonth}`,
  });

  const pastDay = page.getByRole("button", { name: calendarDayLabel(lastMonth) });
  await expect(pastDay).toBeDisabled();
  await page.close();
});

test("a member POST carrying allowPastDates is rejected 403", async ({}, testInfo) => {
  const res = await postBookingCreate(
    memberContext.request,
    bookingCreateIsolation(
      "admin-retroactive-member-rejection",
      testInfo.retry,
    ),
    {
      data: {
        checkIn: relDateOnly(30),
        checkOut: relDateOnly(32),
        guests: [
          {
            firstName: "Alice",
            lastName: "Anderson",
            ageTier: "ADULT",
            isMember: true,
          },
        ],
        allowPastDates: true,
      },
    },
  );
  expect(res.status(), `member allowPastDates (${res.status()})`).toBe(403);
});
