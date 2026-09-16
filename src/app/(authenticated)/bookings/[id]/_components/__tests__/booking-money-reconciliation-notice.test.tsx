// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BookingMoneyReconciliationNotice } from "../booking-money-reconciliation-notice";

describe("BookingMoneyReconciliationNotice", () => {
  it("renders nothing for reconciled money", () => {
    const { container } = render(
      <BookingMoneyReconciliationNotice
        reconciliation={{ state: "RECONCILED", reasons: [] }}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("shows every ordered reason and says no amount was changed", () => {
    render(
      <BookingMoneyReconciliationNotice
        reconciliation={{
          state: "UNRECONCILED",
          reasons: [
            "STRAND_EVIDENCE_UNREADABLE",
            "PROMO_BUILD_UP_NOT_KNOWN",
          ],
        }}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("data-reconciliation-reasons")).toBe(
      "STRAND_EVIDENCE_UNREADABLE,PROMO_BUILD_UP_NOT_KNOWN",
    );
    expect(alert.textContent).toContain("incomplete or inexact stored price evidence");
    expect(alert.textContent).toContain("promotion build-up is missing or not knowable");
    expect(alert.textContent).toContain("No amount has been changed automatically");
  });
});
