import { expect, type Page } from "@playwright/test";
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
    await saveAndContinue.click();
  }

  const confirmCorrect = dialog.getByRole("button", {
    name: "Confirm details are correct",
  });
  await confirmCorrect.waitFor({ state: "visible" });
  await confirmCorrect.click();

  const finish = dialog.getByRole("button", { name: "Confirm and finish" });
  if (await finish.isVisible().catch(() => false)) {
    await finish.click();
  }
  await dialogTitle.waitFor({ state: "hidden" });
}

export async function selectCalendarDay(page: Page, dateOnly: string): Promise<void> {
  const [year, month] = dateOnly.split("-").map(Number);
  const monthHeading = new Date(year, month - 1).toLocaleDateString("en-NZ", {
    month: "long",
    year: "numeric",
  });
  for (let hops = 0; hops < 12; hops += 1) {
    if (
      await page
        .getByRole("heading", { name: monthHeading })
        .isVisible()
        .catch(() => false)
    ) {
      break;
    }
    await page.getByRole("button", { name: /Next/ }).click();
  }
  await page.getByRole("button", { name: calendarDayLabel(dateOnly) }).click();
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

  // "Add Guests" appears twice on the guests step — the "2. Add Guests" step
  // breadcrumb (always in the DOM) and the guests-step card title — so the bare
  // substring locator races the card mount and intermittently trips strict mode
  // (seen on CI for the Stripe declined spec). Gate on the unambiguous self-add
  // button the step renders instead.
  const addSelf = page.getByRole("button", {
    name: `+ ${persona.firstName} ${persona.lastName} (You)`,
  });
  await expect(addSelf).toBeVisible();
  await addSelf.click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  await expect(page.getByText("Booking Summary")).toBeVisible();
}

// Confirms the reviewed booking. Member bookings owe payment immediately, so
// the wizard continues to the in-wizard card payment step (step 4).
export async function confirmBookingToPaymentStep(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: /Continue to Payment|Confirm Booking/ })
    .click();
  // "Complete Payment" appears both as the step-4 indicator and as the card
  // title, so match loosely and just require the payment step to be showing.
  await expect(page.getByText("Complete Payment").first()).toBeVisible({
    timeout: 30_000,
  });
}
