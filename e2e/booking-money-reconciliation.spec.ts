import { expect, test } from "@playwright/test";

import { storageStatePath } from "./helpers/auth";
import {
  E2E_ADMIN,
  UNRECONCILED_BOOKING_ID,
} from "./helpers/fixtures";

test.use({ storageState: storageStatePath(E2E_ADMIN.email) });

test("an officer sees the complete derived booking-money warning on synthetic data", async ({
  page,
}) => {
  await page.goto(`/bookings/${UNRECONCILED_BOOKING_ID}`);

  const warning = page.getByTestId("booking-money-unreconciled");
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

  const historyState = page.getByTestId("booking-history-money-reconciliation");
  await expect(historyState).toBeVisible();
  await expect(historyState).toHaveAttribute(
    "data-reconciliation-reasons",
    "HEADLINE_TOTAL_MISMATCH",
  );
  await expect(historyState).toContainText(
    "This is the current derived state, not a historical transaction",
  );
});
