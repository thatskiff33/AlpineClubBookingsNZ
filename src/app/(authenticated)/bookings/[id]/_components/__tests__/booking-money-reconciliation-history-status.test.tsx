// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { BOOKING_MONEY_RECONCILIATION_WITHHELD } from "@/lib/booking-money-reconciliation-audience";
import { BookingMoneyReconciliationHistoryStatus } from "../booking-money-reconciliation-history-status";

describe("BookingMoneyReconciliationHistoryStatus", () => {
  it("mounts one verdict when a hidden server stream remains beside the hydrated page", async () => {
    const reconciled = (
      <BookingMoneyReconciliationHistoryStatus
        view={{
          visibility: "VISIBLE",
          reconciliation: { state: "RECONCILED", reasons: [] },
        }}
      />
    );
    const serverHtml = renderToString(reconciled);
    const hiddenStream = document.createElement("div");
    hiddenStream.hidden = true;
    hiddenStream.innerHTML = serverHtml;
    const visiblePage = document.createElement("main");
    visiblePage.innerHTML = serverHtml;
    document.body.append(hiddenStream, visiblePage);
    const hydrationError = vi.fn();
    let root: ReturnType<typeof hydrateRoot> | undefined;
    const verdicts = () => within(document.body).queryAllByTestId("booking-history-money-reconciliation");
    try {
      expect(verdicts()).toHaveLength(0);
      expect(within(visiblePage).getByRole("status").textContent).toContain("Loading money reconciliation");
      await act(async () => {
        root = hydrateRoot(visiblePage, reconciled, { onRecoverableError: hydrationError });
      });
      expect(hydrationError).not.toHaveBeenCalled();
      expect(verdicts()).toHaveLength(1);
      expect(within(hiddenStream).queryByTestId("booking-history-money-reconciliation")).toBeNull();
      expect(verdicts()[0]?.getAttribute("data-reconciliation-state")).toBe("RECONCILED");

      await act(async () => {
        root!.render(<BookingMoneyReconciliationHistoryStatus view={{
          visibility: "VISIBLE",
          reconciliation: { state: "UNRECONCILED", reasons: ["HEADLINE_TOTAL_MISMATCH"] },
        }} />);
      });
      expect(verdicts()).toHaveLength(1);
      expect(verdicts()[0]?.getAttribute("data-reconciliation-reasons")).toBe("HEADLINE_TOTAL_MISMATCH");
      await act(async () => {
        root!.render(<BookingMoneyReconciliationHistoryStatus view={BOOKING_MONEY_RECONCILIATION_WITHHELD} />);
      });
      expect(verdicts()).toHaveLength(0);
    } finally {
      await act(async () => { root?.unmount(); });
      hiddenStream.remove();
      visiblePage.remove();
    }
  });

  it("renders no private state when the loader withheld it", () => {
    const { container } = render(
      <BookingMoneyReconciliationHistoryStatus
        view={BOOKING_MONEY_RECONCILIATION_WITHHELD}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("labels the current state separately from historical transactions", () => {
    render(
      <BookingMoneyReconciliationHistoryStatus
        view={{
          visibility: "VISIBLE",
          reconciliation: {
            state: "UNRECONCILED",
            reasons: [
              "HEADLINE_TOTAL_MISMATCH",
              "FINAL_PRICE_RELATION_MISMATCH",
            ],
          },
        }}
      />,
    );

    const status = screen.getByTestId("booking-history-money-reconciliation");
    expect(status.getAttribute("data-reconciliation-reasons")).toBe(
      "HEADLINE_TOTAL_MISMATCH,FINAL_PRICE_RELATION_MISMATCH",
    );
    expect(status.textContent).toContain(
      "Current money reconciliation: Unreconciled",
    );
    expect(status.textContent).toContain("not a historical transaction");
  });

  /*
    #3278: the officer panel explains its reasons in English, exactly as the
    banner above the booking does. It used to print the raw reason tokens
    (`HEADLINE_TOTAL_MISMATCH, ...`) while the banner two components away
    printed sentences for the same verdict; both now read the one dictionary.
    The tokens stay in the `data-` attribute, which is machine-read.
  */
  it("explains the reasons in the same words the banner uses", () => {
    render(
      <BookingMoneyReconciliationHistoryStatus
        view={{
          visibility: "VISIBLE",
          reconciliation: {
            state: "UNRECONCILED",
            reasons: ["HEADLINE_TOTAL_MISMATCH"],
          },
        }}
      />,
    );

    const status = screen.getByTestId("booking-history-money-reconciliation");
    expect(status.textContent).toContain(
      "the stored booking total differs from the recorded guest totals",
    );
    expect(status.textContent).not.toContain("HEADLINE_TOTAL_MISMATCH");
  });

  it("says so when the booking's stored money does reconcile", () => {
    render(
      <BookingMoneyReconciliationHistoryStatus
        view={{
          visibility: "VISIBLE",
          reconciliation: { state: "RECONCILED", reasons: [] },
        }}
      />,
    );

    const status = screen.getByTestId("booking-history-money-reconciliation");
    expect(status.getAttribute("data-reconciliation-state")).toBe("RECONCILED");
    expect(status.textContent).toContain(
      "Current money reconciliation: Reconciled",
    );
  });
});
