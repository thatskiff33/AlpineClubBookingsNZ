import { expect, test } from "./helpers/accessibility";

import { formatBookingReference } from "../src/lib/booking-reference";
import { storageStatePath } from "./helpers/auth";
import { BANK_REFUND_VOID_BOOKING_IDS, E2E_ADMIN } from "./helpers/fixtures";

test.use({ storageState: storageStatePath(E2E_ADMIN.email) });

/**
 * #4162 (owner decision 17 Oct 2026, "undo, then ask once"): a bank refund the
 * nightly follow-up put back on Money to settle because Xero voided its credit
 * note shows its one question, and "Yes, it has gone" -> "Yes, raise a fresh
 * credit note" records it as paid back again and takes it off the list.
 *
 * An answer is final and the suite seeds once per prepare, so the spec answers
 * the FIRST SEEDED ROW STILL OPEN (review, security 13): a retry, or a second
 * run against the same database, never meets a row an earlier attempt answered
 * (docs/E2E_PLAYWRIGHT.md, flake invariant 1). Three are seeded, so three runs
 * fit one prepare. Locators are roles within the row's own list item, never
 * bare text, so a streamed template cannot double a match (flake invariant 2).
 */
test("a treasurer answers a bank refund whose Xero credit note was voided, and it leaves the refund list", async ({ page }) => {
  await page.goto("/admin/payments");
  const queue = page.getByTestId("manual-refund-task-queue");
  await expect(queue.getByTestId("manual-refund-task-bank-refund-void-intro")).toBeVisible();
  const rowFor = (bookingId: string) => queue.getByRole("listitem").filter({ hasText: `Booking ${formatBookingReference(bookingId)}:` });
  let index = -1;
  for (const [candidate, bookingId] of BANK_REFUND_VOID_BOOKING_IDS.entries()) {
    if ((await rowFor(bookingId).count()) === 1) {
      index = candidate;
      break;
    }
  }
  expect(index, "every seeded follow-up has been answered: re-run test:e2e:prepare").toBeGreaterThanOrEqual(0);
  const bookingId = BANK_REFUND_VOID_BOOKING_IDS[index]!;
  const reference = formatBookingReference(bookingId);
  const row = rowFor(bookingId);
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("manual-refund-task-bank-refund-void-question")).toContainText(
    `Its Xero credit note CN-E2E-${index} was found voided on`,
  );
  await expect(row.getByTestId("manual-refund-task-bank-refund-void-question")).toContainText("gone to the member?");

  await row.getByRole("button", { name: "Yes, it has gone" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: /^Has the .+ gone to / })).toBeVisible();
  const confirm = dialog.getByRole("button", { name: "Record the answer" });
  // No answer is pre-chosen.
  await expect(confirm).toBeDisabled();
  await dialog.getByRole("radio", { name: /Yes, raise a fresh credit note/ }).check();
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(page.getByText("One fresh credit note is queued for Xero, dated today.").filter({ visible: true })).toBeVisible();
  await expect(queue.getByRole("listitem").filter({ hasText: `Booking ${reference}:` })).toHaveCount(0);
});
