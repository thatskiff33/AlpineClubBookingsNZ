// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BOOKING_MONEY_RECONCILIATION_WITHHELD } from "@/lib/booking-money-reconciliation-audience";
import { BookingMoneyReconciliationNotice } from "../booking-money-reconciliation-notice";

describe("BookingMoneyReconciliationNotice", () => {
  it("renders nothing for reconciled money", () => {
    const { container } = render(
      <BookingMoneyReconciliationNotice
        view={{
          visibility: "VISIBLE",
          reconciliation: { state: "RECONCILED", reasons: [] },
        }}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  // #3278: the withheld arm is the whole audience decision at this component.
  // A non-officer's page never receives a verdict, and the component renders
  // nothing at all rather than deciding for itself who may read one.
  it("renders nothing when the loader withheld the verdict from this viewer", () => {
    const { container } = render(
      <BookingMoneyReconciliationNotice
        view={BOOKING_MONEY_RECONCILIATION_WITHHELD}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("shows every ordered reason and says no amount was changed", () => {
    render(
      <BookingMoneyReconciliationNotice
        view={{
          visibility: "VISIBLE",
          reconciliation: {
            state: "UNRECONCILED",
            reasons: ["STRAND_EVIDENCE_UNREADABLE", "PROMO_BUILD_UP_NOT_KNOWN"],
          },
        }}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("data-reconciliation-reasons")).toBe(
      "STRAND_EVIDENCE_UNREADABLE,PROMO_BUILD_UP_NOT_KNOWN",
    );
    expect(alert.textContent).toContain(
      "incomplete or inexact stored price evidence",
    );
    expect(alert.textContent).toContain(
      "promotion build-up is missing or not knowable",
    );
    expect(alert.textContent).toContain("No amount has been changed automatically");
  });
});
