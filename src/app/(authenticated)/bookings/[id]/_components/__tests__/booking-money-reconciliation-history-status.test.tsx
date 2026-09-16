// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BookingMoneyReconciliationHistoryStatus } from "../booking-money-reconciliation-history-status";

describe("BookingMoneyReconciliationHistoryStatus", () => {
  it("renders no private state when the loader withheld it", () => {
    const { container } = render(
      <BookingMoneyReconciliationHistoryStatus reconciliation={null} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("labels the current state separately from historical transactions", () => {
    render(
      <BookingMoneyReconciliationHistoryStatus
        reconciliation={{
          state: "UNRECONCILED",
          reasons: [
            "HEADLINE_TOTAL_MISMATCH",
            "FINAL_PRICE_RELATION_MISMATCH",
          ],
        }}
      />,
    );

    const status = screen.getByTestId("booking-history-money-reconciliation");
    expect(status.getAttribute("data-reconciliation-reasons")).toBe(
      "HEADLINE_TOTAL_MISMATCH,FINAL_PRICE_RELATION_MISMATCH",
    );
    expect(status.textContent).toContain("Current money reconciliation: Unreconciled");
    expect(status.textContent).toContain("not a historical transaction");
  });
});
