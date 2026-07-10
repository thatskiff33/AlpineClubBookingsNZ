import { type BrowserContext, expect, test, type Page } from "@playwright/test";
import { loginPersona, storageStatePath } from "./helpers/auth";
import { personas } from "./helpers/personas";
import { E2E_ADMIN } from "./helpers/fixtures";
import { calendarDayLabel } from "./helpers/stay-dates";
import {
  overrideModules,
  setModuleSettings,
  type ModuleSettings,
} from "./helpers/modules";

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
// seeded Winter 2026 window (2026-06-01..2026-09-30, see prisma/seed.ts) — the
// same season-coverage constraint every date-based spec carries.
test.describe.configure({ mode: "serial" });

let memberContext: BrowserContext;
let adminContext: BrowserContext;
let previousModules: ModuleSettings | undefined;

function isoDay(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Seeded fixed-date windows the sliding past window must dodge
// (prisma/demo-seed.ts). The retroactive create would otherwise fail on
// specific CI run dates:
// - Alice's bookings that count for the (cross-lodge) member-night conflict
//   check: the second-lodge DRAFT 2026-08-05..07 has no draftExpiresAt; the
//   primary DRAFT 2026-07-10..12 is belt-and-braces (its expiry has passed).
// - The waitlist fixture window 2026-09-14..16 is seeded full to lodge
//   capacity, which would trigger the over-capacity confirm dialog this
//   happy-path spec deliberately does not drive.
const SEEDED_BLOCKED_RANGES: ReadonlyArray<readonly [string, string]> = [
  ["2026-07-10", "2026-07-12"],
  ["2026-08-05", "2026-08-07"],
  ["2026-09-14", "2026-09-16"],
];

function overlapsSeededRange(checkIn: string, checkOut: string): boolean {
  return SEEDED_BLOCKED_RANGES.some(
    ([start, end]) => checkIn < end && checkOut > start,
  );
}

function pickPastWindow(): { checkIn: string; checkOut: string } {
  // Deeper offsets only activate near the seeded August ranges, so every
  // candidate stays inside the seeded Winter season whenever -7 does.
  for (const offset of [-7, -11, -15]) {
    const checkIn = isoDay(offset);
    const checkOut = isoDay(offset + 2);
    if (!overlapsSeededRange(checkIn, checkOut)) {
      return { checkIn, checkOut };
    }
  }
  throw new Error(
    "No conflict-free past window; realign offsets with prisma/demo-seed.ts",
  );
}

const { checkIn: pastCheckIn, checkOut: pastCheckOut } = pickPastWindow();

// Navigate the booking calendar backwards to the month holding dateOnly, then
// click the day. The shared selectCalendarDay only walks forward (Next), so a
// past date needs its own Prev walk.
async function selectPastCalendarDay(page: Page, dateOnly: string): Promise<void> {
  const [y, m] = dateOnly.split("-").map(Number);
  const monthHeading = new Date(y, m - 1).toLocaleDateString("en-NZ", {
    month: "long",
    year: "numeric",
  });
  for (let hops = 0; hops < 14; hops += 1) {
    if (
      await page
        .getByRole("heading", { name: monthHeading })
        .isVisible()
        .catch(() => false)
    ) {
      break;
    }
    await page.getByRole("button", { name: /Prev/ }).click();
  }
  await page.getByRole("button", { name: calendarDayLabel(dateOnly) }).click();
}

// The member details confirmation gate can appear on the first /book visit.
async function dismissDetailsGateIfShown(page: Page): Promise<void> {
  const dialogTitle = page.getByText("Confirm member details");
  try {
    await dialogTitle.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    return;
  }
  const dialog = page.getByRole("dialog");
  const confirmCorrect = dialog.getByRole("button", {
    name: "Confirm details are correct",
  });
  if (await confirmCorrect.isVisible().catch(() => false)) {
    await confirmCorrect.click();
  }
  const finish = dialog.getByRole("button", { name: "Confirm and finish" });
  if (await finish.isVisible().catch(() => false)) {
    await finish.click();
  }
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);

  memberContext = await browser.newContext({
    storageState: storageStatePath(personas.booker.email),
  });

  adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await loginPersona(adminPage, E2E_ADMIN.email);

  // A retroactive (cross-month) create can trigger the reconcile sweep to
  // auto-place bookings lodge-wide; disable auto-allocation for this spec so it
  // never disturbs the bed-allocation spec's fixtures (which owns the same
  // setting for its own run).
  const disabled = await adminContext.request.put(
    "/api/admin/bed-allocation/settings",
    { data: { autoAllocationEnabled: false } },
  );
  expect(
    disabled.ok(),
    `disable auto-allocation (${disabled.status()})`,
  ).toBeTruthy();

  // A past stay can't settle on the card path (#1709), so this happy path
  // records it via Internet Banking. Both flags default off in the E2E stack,
  // so turn them on for this serial file and restore them afterwards (workers:1
  // means no other spec runs concurrently). Xero stays unconnected, so the
  // queued invoice is never sent and the lock-date guard is a no-op.
  previousModules = await overrideModules(adminContext.request, {
    xeroIntegration: true,
    internetBankingPayments: true,
  });
  await adminPage.close();
});

test.afterAll(async () => {
  try {
    if (adminContext) {
      // Restore modules FIRST: leaving xeroIntegration / internetBankingPayments
      // enabled would leak into every later spec in the serial run, so it must
      // not be gated behind the bed-allocation restore (which could throw).
      if (previousModules) {
        await setModuleSettings(adminContext.request, previousModules);
      }
      await adminContext.request.put("/api/admin/bed-allocation/settings", {
        data: { autoAllocationEnabled: true },
      });
    }
  } finally {
    await memberContext?.close();
    await adminContext?.close();
  }
});

test("an admin records a past stay on behalf of a member without emailing them", async () => {
  const page = await adminContext.newPage();
  await page.goto("/admin/book");
  await expect(
    page.getByRole("heading", { name: "Book on Behalf of Member" }),
  ).toBeVisible();

  // Pick the target member through the search picker.
  await page
    .getByPlaceholder("Type a name or email...")
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

  // Card can't settle a past stay (#1709): the card option is hidden and the
  // explanation steers to Internet Banking, the forced settlement for a balance.
  await expect(
    page.getByText(/Card payment isn't available for a past stay/),
  ).toBeVisible();
  await expect(
    page.getByText("The member pays by card to secure the booking."),
  ).toHaveCount(0);
  await expect(page.getByText("Internet Banking")).toBeVisible();

  // Confirm opens the per-create email-choice dialog; take "without emailing".
  await page.getByRole("button", { name: "Confirm Booking" }).click();
  const withoutEmail = page.getByRole("button", {
    name: "Create without emailing",
  });
  await expect(withoutEmail).toBeVisible();

  // Wait for the POST itself — the Confirm button flips to "Creating booking..."
  // the instant the dialog choice fires, so a button-state wait would race the
  // in-flight request and the caller's navigation could abort it.
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/bookings") && r.request().method() === "POST",
      { timeout: 30_000 },
    ),
    withoutEmail.click(),
  ]);
  expect(response.status(), `retroactive create (${response.status()})`).toBe(
    201,
  );

  await expect(page).toHaveURL(/\/bookings\/[A-Za-z0-9-]+$/);
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
  await expect(page.getByText(checkInText).first()).toBeVisible();
  await page.close();
});

test("a member's own /book calendar keeps past days disabled", async () => {
  const page = await memberContext.newPage();
  await page.goto("/book");
  await dismissDetailsGateIfShown(page);
  await expect(page.getByText("Select Your Dates")).toBeVisible();

  // Step back one month; every day there is in the past and must be disabled for
  // a member (no retroactive flag on the member calendar).
  const lastMonth = isoDay(-32);
  const [y, m] = lastMonth.split("-").map(Number);
  const monthHeading = new Date(y, m - 1).toLocaleDateString("en-NZ", {
    month: "long",
    year: "numeric",
  });
  for (let hops = 0; hops < 3; hops += 1) {
    if (
      await page
        .getByRole("heading", { name: monthHeading })
        .isVisible()
        .catch(() => false)
    ) {
      break;
    }
    await page.getByRole("button", { name: /Prev/ }).click();
  }
  const pastDay = page.getByRole("button", { name: calendarDayLabel(lastMonth) });
  await expect(pastDay).toBeDisabled();
  await page.close();
});

test("a member POST carrying allowPastDates is rejected 403", async () => {
  const res = await memberContext.request.post("/api/bookings", {
    data: {
      checkIn: isoDay(30),
      checkOut: isoDay(32),
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
  });
  expect(res.status(), `member allowPastDates (${res.status()})`).toBe(403);
});
