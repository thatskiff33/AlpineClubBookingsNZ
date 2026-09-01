import { expect, type Page } from "@playwright/test";
import {
  type BookingCreateIsolation,
  withBookingCreateClientIp,
} from "./booking-create-client-ip";
import {
  CALENDAR_CLICK_TIMEOUT_MS,
  walkCalendarToMonth,
} from "./calendar-navigation";
import type { Persona } from "./personas";
import { calendarDayLabel, type StayWindow } from "./stay-dates";

// Per-night occupied-bed counts from the authenticated availability API. The
// capacity-lock assertion compares these before and after a booking.
export async function fetchOccupiedBeds(
  page: Page,
  nights: string[],
): Promise<Record<string, number>> {
  const months = new Set(nights.map((night) => night.slice(0, 7)));
  const occupied: Record<string, number> = {};
  for (const month of months) {
    const [year, monthNumber] = month.split("-").map(Number);
    const response = await page.request.get(
      `/api/availability?year=${year}&month=${monthNumber - 1}`,
    );
    expect(response.ok(), `availability API for ${month}`).toBeTruthy();
    const body = (await response.json()) as {
      availability: Record<string, number>;
      seasons: Record<string, { name: string }>;
    };
    for (const night of nights) {
      if (night.slice(0, 7) !== month) continue;
      expect(
        body.seasons[night],
        `night ${night} must fall inside a seeded season — reseed or adjust stay windows`,
      ).toBeTruthy();
      occupied[night] = body.availability[night] ?? 0;
    }
  }
  return occupied;
}

// First visit to /book runs the member-onboarding dialog when the member's
// details are incomplete (demo-seed members lack a date of birth and postal
// address). Completes whichever steps appear; a no-show is fine. No reload
// afterwards: completing the wizard raises the member-onboarding-confirmed
// event and the page refetches its family list (#1124), which this suite
// deliberately relies on for regression coverage.
export async function completeMemberDetailsGateIfShown(page: Page): Promise<void> {
  const dialogTitle = page.getByText("Confirm member details");
  try {
    await dialogTitle.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    return; // details already confirmed
  }

  const dialog = page.getByRole("dialog");

  const saveAndContinue = dialog.getByRole("button", { name: "Save and continue" });
  const confirmCorrect = dialog.getByRole("button", {
    name: "Confirm details are correct",
  });
  // The title and the current step do not mount in the same commit. Sampling
  // Save immediately after the title can therefore see neither step, skip the
  // profile form, and wait until the whole test times out for Confirm. Wait for
  // either legitimate step action before deciding which branch is active.
  await dialog
    .getByRole("button", {
      name: /Save and continue|Confirm details are correct/,
    })
    .waitFor({ state: "visible", timeout: 5_000 });
  if (await saveAndContinue.isVisible().catch(() => false)) {
    const dob = dialog.getByLabel(/date of birth/i);
    if ((await dob.inputValue().catch(() => "")) === "") {
      await dob.fill("1985-03-14");
    }
    const fillIfEmpty = async (label: RegExp, value: string) => {
      const fields = dialog.getByLabel(label);
      const count = await fields.count();
      for (let i = 0; i < count; i += 1) {
        const field = fields.nth(i);
        if ((await field.inputValue().catch(() => "")) === "") {
          await field.fill(value);
        }
      }
    };
    await fillIfEmpty(/address line 1/i, "12 Mountain Rd");
    await fillIfEmpty(/city|town/i, "Alpine Village");
    await fillIfEmpty(/postcode|postal code/i, "3420");
    const postalAddressMissing = dialog.getByText("Postal Address Line 1", {
      exact: true,
    });
    if (await postalAddressMissing.isVisible().catch(() => false)) {
      await dialog.getByRole("button", { name: "Postal address" }).click();
      await dialog.getByLabel("Postal same as physical").check();
    }
    await saveAndContinue.click();
  }

  await confirmCorrect.waitFor({ state: "visible" });
  await confirmCorrect.click();

  const finish = dialog.getByRole("button", { name: "Confirm and finish" });
  if (await finish.isVisible().catch(() => false)) {
    await finish.click();
  }
  await dialogTitle.waitFor({ state: "hidden" });
}

// How many "Next ›" clicks the walk below may spend reaching a stay window's
// month (#2302).
//
// `BookingCalendar` opens on the RUN DATE's own month, moves exactly one month
// per click, never disables Next, and the wizard has no booking horizon — so the
// cost of reaching a window is simply the number of calendar months between
// today and that window. The bound must therefore cover the FURTHEST window the
// date helpers can produce, not just the ones specs use today:
// `stayWindowForAttempt` shifts a retry by RETRY_WINDOW_STRIDE (16) indexes, so
// the reachable set is base 0–15 × attempt 0–2, i.e. stay indexes 0–47.
//
// Swept over 400 consecutive run dates, that whole set costs at most 14 hops.
// The previous bound of 12 was exactly the worst case of the windows already in
// use (base 6, attempt 2 on 2026-07-31 needs all 12) and one SHORT of the base
// range docs/E2E_PLAYWRIGHT.md tells authors to convert (base 9, attempt 2 needs
// 13) — and running out did not fail here at all: the walk simply stopped on the
// wrong month and the DAY click timed out, which reads as a calendar bug and
// only ever appears on a retry. Hence both halves of this fix: real margin, and
// an explicit arrival assertion so exhausting the budget fails loudly, on the
// month it could not reach.
const MAX_MONTH_HOPS = 24;

export async function selectCalendarDay(page: Page, dateOnly: string): Promise<void> {
  // The walk itself lives in `e2e/helpers/calendar-navigation.ts` (#2626), shared
  // with the retroactive spec's backwards walks. It asserts ARRIVAL before the
  // caller clicks a day — without that the final hop is unverified and a miss
  // surfaces as `locator.click: Timeout … getByRole('button', { name: /^Monday,
  // 2 August 2027,/ })`, the reported error being the symptom rather than the
  // cause, which is the whole pathology #2302 is about — and it bounds each
  // "Next" click, because a hop-bounded loop with unbounded clicks in it has no
  // time bound at all (#2626, where one such click ate a whole 90 s test budget).
  await walkCalendarToMonth(page, {
    target: dateOnly,
    maxHops: MAX_MONTH_HOPS,
    context:
      `stay day ${dateOnly}, walking forward from the run date's month — see ` +
      `MAX_MONTH_HOPS in e2e/helpers/booking.ts and RETRY_WINDOW_STRIDE in ` +
      `e2e/helpers/stay-dates.ts`,
  });
  // Bounded with the walk's own per-click budget. Arrival is asserted above, so
  // the month is right — but a day that RESOLVES and is not actionable (out of
  // season, disabled as past, availability still loading) would otherwise wait
  // out the whole test budget and report `Target page, context or browser has
  // been closed` instead of naming the day (#2302, #2626).
  await page
    .getByRole("button", { name: calendarDayLabel(dateOnly) })
    .click({ timeout: CALENDAR_CLICK_TIMEOUT_MS });
}

// Drives the /book wizard through dates → guests (booking the signed-in member
// themselves) → review, stopping on the review step.
export async function bookSelfToReviewStep(
  page: Page,
  persona: Persona,
  window: StayWindow,
): Promise<void> {
  await page.goto("/book");
  await completeMemberDetailsGateIfShown(page);

  await expect(page.getByText("Select Your Dates")).toBeVisible();
  await selectCalendarDay(page, window.checkIn);
  await selectCalendarDay(page, window.checkOut);

  // The booker is pre-selected by default (#1680): the self quick-add renders
  // in its added state (✓, disabled) once the family list loads — no manual
  // click. Gating on the added-state button is unambiguous (avoids the "Add
  // Guests" breadcrumb/card-title strict-mode race) and auto-waits out the
  // family-load seed flip.
  const addedSelf = page.getByRole("button", {
    name: `✓ ${persona.firstName} ${persona.lastName} (You)`,
  });
  await expect(addedSelf).toBeVisible();
  await expect(addedSelf).toBeDisabled();
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  await expect(page.getByText("Booking Summary")).toBeVisible();
}

// Confirms the reviewed booking. Member bookings owe payment immediately, so
// the wizard continues to the in-wizard card payment step (step 4).
export async function confirmBookingToPaymentStep(
  page: Page,
  isolation: BookingCreateIsolation,
): Promise<void> {
  await withBookingCreateClientIp(page, isolation, {
    trigger: () =>
      page
        .getByRole("button", { name: /Continue to Payment|Confirm Booking/ })
        .click(),
    // "Complete Payment" appears both as the step-4 indicator and as the card
    // title, so match loosely and just require the payment step to be showing.
    waitForOutcome: () =>
      expect(page.getByText("Complete Payment").first()).toBeVisible({
        timeout: 30_000,
      }),
  });
}
