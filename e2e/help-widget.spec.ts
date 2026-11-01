import { expect, test, type Page } from "./helpers/accessibility";
import { loginPersona, storageStatePath } from "./helpers/auth";
import { completeMemberDetailsGateIfShown, selectCalendarDay } from "./helpers/booking";
import { personas } from "./helpers/personas";
import { stayWindow } from "./helpers/stay-dates";
import {
  E2E_ADMIN,
  NOMINATOR_TWO,
  HELP_WIDGET_BOOKING_ID,
} from "./helpers/fixtures";

// Epic #2094 C2: the chat-style help widget replaces the old ContextualHelpButton
// (admin/finance) and BookingHelpDialog (booking detail) on every surface, and
// serves the public website too. These checks are single-worker-safe and reuse
// stored auth state where one exists; the member booking-detail case logs Nadia
// in fresh (mirroring booking-cancel-refund) because her PAID cancellable
// booking is the only seeded fixture that carries a real cancellation refund
// schedule.

const launcher = (page: Page) => page.getByTestId("help-widget-launcher");
const panel = (page: Page) => page.getByTestId("help-widget-panel");

async function dismissConsentBannerIfShown(page: Page): Promise<void> {
  const decline = page.getByRole("button", {
    name: "Decline",
    exact: true,
  });
  if (await decline.isVisible().catch(() => false)) {
    await decline.click();
  }
}

test.describe("public help widget (anonymous)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test.describe.configure({ mode: "serial" });

  test("opens on the public home page, answers a chip, and shows no free-text input", async ({
    page,
  }) => {
    await page.goto("/");
    // The analytics cookie banner shares the bottom corner and hides the
    // launcher until dismissed; clear it if the club has analytics enabled.
    await dismissConsentBannerIfShown(page);

    await expect(launcher(page)).toBeVisible();
    await launcher(page).click();
    await expect(panel(page)).toBeVisible();

    // Tap the first curated question chip; its templated answer appears.
    const firstChip = panel(page)
      .getByRole("button")
      .filter({ hasText: "?" })
      .first();
    await firstChip.click();
    await expect(
      panel(page).getByText("From the help guide").first(),
    ).toBeVisible();

    // Free-text input must NOT render while the LLM is disabled.
    await expect(panel(page).getByRole("textbox")).toHaveCount(0);
    // Public surface invites members to sign in for more.
    await expect(
      panel(page).getByText("Members: sign in for more help."),
    ).toBeVisible();
  });
});

test.describe("admin help widget", () => {
  test.use({ storageState: storageStatePath(E2E_ADMIN.email) });
  test.describe.configure({ mode: "serial" });

  test("mounts on an admin page and the old ? help button is gone", async ({
    page,
  }) => {
    await page.goto("/admin/dashboard");
    await expect(launcher(page)).toBeVisible();

    // The retired ContextualHelpButton exposed the accessible name
    // "Open <Page> help". None must remain anywhere on the page.
    await expect(
      page.getByRole("button", { name: /^Open .+ help$/ }),
    ).toHaveCount(0);
  });

  test("shows no free-text ask box or AI wording while the module is off", async ({
    page,
  }) => {
    // The default seed leaves the aiAssistant module OFF, so llmEnabled is false
    // on every surface: the paid free-text path (textarea + Anthropic
    // disclaimer) must not render — only curated chips.
    await page.goto("/admin/dashboard");
    await launcher(page).click();
    await expect(panel(page)).toBeVisible();

    await expect(panel(page).getByRole("textbox")).toHaveCount(0);
    await expect(
      panel(page).getByText("Ask about this page…"),
    ).toHaveCount(0);
    await expect(panel(page).getByText(/sent to Anthropic/)).toHaveCount(0);
  });
});

test.describe("member booking-detail help widget", () => {
  test.describe.configure({ mode: "serial" });

  test("surfaces the cancellation refund schedule in the Page guide", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      // Nadia owns a seeded PAID, far-future booking that no spec cancels
      // (#4397), so its detail page always computes a real cancellation refund
      // schedule, whichever specs ran before this one.
      await loginPersona(page, NOMINATOR_TWO.email);
      await page.goto(`/bookings/${HELP_WIDGET_BOOKING_ID}`);
      await expect(
        page.getByRole("heading", { name: "Booking Details" }),
      ).toBeVisible();

      await launcher(page).click();
      await expect(panel(page)).toBeVisible();
      await panel(page).getByRole("button", { name: "Page guide" }).click();

      // The BookingHelpExtras leaf re-surfaces the dialog's four blocks; the
      // refund-schedule block is present for a captured-payment booking.
      // Matched by its heading, exactly: the member guide's "Cancelling and
      // refunds" text also names the schedule, so a substring match finds two
      // elements on a cancellable booking - and on a cancelled one it found
      // only that paragraph, which is how this assertion passed for months
      // without the block it names (#4397).
      await expect(
        panel(page).getByRole("heading", { name: "Cancellation refund schedule", exact: true }),
      ).toBeVisible();
      // The status glossary block survives too.
      await expect(panel(page).getByRole("heading", { name: "Booking statuses", exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
  });
});

test.describe("member /book help widget", () => {
  test.use({ storageState: storageStatePath(personas.booker.email) });
  test.describe.configure({ mode: "serial" });

  test("reorders chips as the booking wizard advances a step", async ({
    page,
  }) => {
    // Selecting dates advances dates → guests without creating a booking (no
    // Confirm), so this consumes no capacity and cannot collide with a booking
    // spec. A fresh window index keeps it off any member-night lock.
    const window = stayWindow(9);

    await page.goto("/book");
    await completeMemberDetailsGateIfShown(page);
    await expect(page.getByText("Select Your Dates")).toBeVisible();

    // Dates step: read the leading chip.
    await launcher(page).click();
    await expect(panel(page)).toBeVisible();
    const datesFirstChip = (
      await panel(page)
        .getByRole("button")
        .filter({ hasText: "?" })
        .first()
        .textContent()
    )?.trim();
    await launcher(page).click(); // close

    // Advance to the guests step.
    await selectCalendarDay(page, window.checkIn);
    await selectCalendarDay(page, window.checkOut);
    await expect(
      page.getByRole("button", { name: /\(You\)/ }),
    ).toBeVisible();

    // Guests step: the leading chip changes (guests-tagged question leads now).
    await launcher(page).click();
    await expect(panel(page)).toBeVisible();
    const guestsFirstChip = (
      await panel(page)
        .getByRole("button")
        .filter({ hasText: "?" })
        .first()
        .textContent()
    )?.trim();

    expect(datesFirstChip).toBeTruthy();
    expect(guestsFirstChip).toBeTruthy();
    expect(guestsFirstChip).not.toBe(datesFirstChip);
  });
});
