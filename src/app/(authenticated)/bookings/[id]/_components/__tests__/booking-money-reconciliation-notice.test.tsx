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

  // #3278, the two kinds. `UNRECONCILED` covers a discrepancy an officer can
  // resolve AND records that were never kept, which nobody can. The reasons are
  // listed either way and neither is `RECONCILED`, so unknown evidence is still
  // not a pass (#2797) — what differs is only what the screen asks of the
  // reader, because a to-do that cannot be closed is what teaches an officer to
  // skim the banner that matters.
  it("asks for review when the recorded numbers disagree", () => {
    render(
      <BookingMoneyReconciliationNotice
        view={{
          visibility: "VISIBLE",
          reconciliation: {
            state: "UNRECONCILED",
            reasons: ["HEADLINE_TOTAL_MISMATCH"],
          },
        }}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("data-reconciliation-kind")).toBe("DISAGREEMENT");
    expect(alert.textContent).toContain("needs officer review");
    expect(alert.textContent).toContain(
      "the stored booking total differs from the recorded guest totals",
    );
    expect(alert.textContent).toContain("No amount has been changed automatically");
  });

  it("states the fact, and asks for nothing, when the records were never kept", () => {
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
    // Not an alert: there is nothing to act on, and announcing it as one is the
    // noise this split exists to remove.
    const note = screen.getByRole("note");
    expect(note.getAttribute("data-reconciliation-kind")).toBe("EVIDENCE_ABSENT");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(note.textContent).toContain("cannot be checked");
    expect(note.textContent).toContain("There is nothing to action here");
    expect(note.textContent).not.toContain("needs officer review");
    // Still unreconciled, and still every reason, in order.
    expect(note.getAttribute("data-reconciliation-state")).toBe("UNRECONCILED");
    expect(note.getAttribute("data-reconciliation-reasons")).toBe(
      "STRAND_EVIDENCE_UNREADABLE,PROMO_BUILD_UP_NOT_KNOWN",
    );
    expect(note.textContent).toContain(
      "incomplete or inexact stored price evidence",
    );
    expect(note.textContent).toContain(
      "promotion build-up is missing or not knowable",
    );
  });

  // The case that decides the rule: one actionable reason must not be muted by
  // an unactionable sibling.
  it("treats a mixed verdict as a disagreement", () => {
    render(
      <BookingMoneyReconciliationNotice
        view={{
          visibility: "VISIBLE",
          reconciliation: {
            state: "UNRECONCILED",
            reasons: ["NO_SURVIVING_STRANDS", "HEADLINE_TOTAL_MISMATCH"],
          },
        }}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("data-reconciliation-kind")).toBe("DISAGREEMENT");
    expect(alert.textContent).toContain("needs officer review");
  });
});
