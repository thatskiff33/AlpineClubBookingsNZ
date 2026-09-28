// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LateCaptureRefundSetting } from "@/components/admin/booking-policies/late-capture-refund-setting";

/**
 * #3639 (owner decision 26 Sep 2026): the club's choice for a card payment that
 * goes through after its booking was cancelled. Two answers, automatic refund
 * first because it is the default, and nothing changes unless the page is being
 * edited.
 */
afterEach(() => cleanup());

describe("LateCaptureRefundSetting", () => {
  it("shows the club's current answer and offers exactly the two choices", () => {
    render(<LateCaptureRefundSetting needsApproval={false} editing canChange onChange={vi.fn()} />);
    const select = screen.getByLabelText(
      "Payments that arrive after a booking was cancelled",
    ) as HTMLSelectElement;

    expect(select.value).toBe("automatic");
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "Refund them automatically",
      "A treasurer approves each refund",
    ]);
  });

  it("reports treasurer approval as true and automatic as false", () => {
    const onChange = vi.fn();
    render(<LateCaptureRefundSetting needsApproval={false} editing canChange onChange={onChange} />);
    const select = screen.getByLabelText(
      "Payments that arrive after a booking was cancelled",
    );

    fireEvent.change(select, { target: { value: "approve" } });
    fireEvent.change(select, { target: { value: "automatic" } });

    expect(onChange.mock.calls).toEqual([[true], [false]]);
  });

  it("cannot be changed outside edit mode", () => {
    render(<LateCaptureRefundSetting needsApproval editing={false} canChange onChange={vi.fn()} />);
    const select = screen.getByLabelText(
      "Payments that arrive after a booking was cancelled",
    ) as HTMLSelectElement;

    expect(select.value).toBe("approve");
    expect(select).toBeDisabled();
  });

  it("is read-only, and says why, for an officer without finance edit (#3639 review F2)", () => {
    render(
      <LateCaptureRefundSetting needsApproval={false} editing canChange={false} onChange={vi.fn()} />,
    );
    expect(
      screen.getByLabelText("Payments that arrive after a booking was cancelled"),
    ).toBeDisabled();
    expect(screen.getByText(/Only someone with finance edit access/)).toBeInTheDocument();
  });
});
