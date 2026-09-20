import { expect, test } from "@playwright/test";

import { storageStatePath } from "./helpers/auth";
import {
  E2E_ADMIN,
  PAID_PROMO_BOOKING_ID,
  UNRECONCILED_BOOKING_ID,
} from "./helpers/fixtures";

test.use({ storageState: storageStatePath(E2E_ADMIN.email) });

test("the ordinary paid FREE_NIGHTS fixture is reconciled and needs no warning", async ({
  page,
}) => {
  await page.goto(`/bookings/${PAID_PROMO_BOOKING_ID}`);

  const bookingDetail = page.getByTestId("booking-detail-content");
  const historyState = bookingDetail.getByTestId(
    "booking-history-money-reconciliation",
  );
  await expect(historyState).toBeVisible();
  await expect(historyState).toHaveAttribute(
    "data-reconciliation-state",
    "RECONCILED",
  );
  await expect(historyState).toHaveAttribute("data-reconciliation-reasons", "");
  await expect(
    bookingDetail.getByTestId("booking-money-unreconciled"),
  ).toHaveCount(0);
});

test("an officer sees the complete derived booking-money warning on synthetic data", async ({
  page,
}) => {
  await page.goto(`/bookings/${UNRECONCILED_BOOKING_ID}`);

  const bookingDetail = page.getByTestId("booking-detail-content");
  const warning = bookingDetail.getByTestId("booking-money-unreconciled");
  await expect(warning).toBeVisible();
  await expect(warning).toHaveAttribute("data-reconciliation-state", "UNRECONCILED");
  await expect(warning).toHaveAttribute(
    "data-reconciliation-reasons",
    "HEADLINE_TOTAL_MISMATCH",
  );
  await expect(warning).toContainText(
    "the stored booking total differs from the recorded guest totals",
  );
  await expect(warning).toContainText("No amount has been changed automatically");

  const historyState = bookingDetail.getByTestId(
    "booking-history-money-reconciliation",
  );
  await expect(historyState).toBeVisible();
  await expect(historyState).toHaveAttribute(
    "data-reconciliation-reasons",
    "HEADLINE_TOTAL_MISMATCH",
  );
  await expect(historyState).toContainText(
    "This is the current derived state, not a historical transaction",
  );
});
