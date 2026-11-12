// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BookingTimingsSetting } from "../booking-timings-setting";
import { bookingTimingsFrom } from "@/lib/booking-timings";

afterEach(cleanup);

describe("booking timing controls", () => {
  it("shows the saved timings read-only until Edit", () => {
    render(<BookingTimingsSetting timings={bookingTimingsFrom({})} editing={false} onChange={vi.fn()} />);
    expect(screen.getAllByRole("spinbutton").map((input) => input.getAttribute("value"))).toEqual(["3", "3", "7"]);
    for (const input of screen.getAllByRole("spinbutton")) expect(input).toBeDisabled();
  });

  it("stages bounded changes without saving", () => {
    const onChange = vi.fn();
    render(<BookingTimingsSetting timings={bookingTimingsFrom({})} editing onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Pre-arrival reminder"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("First reminder to pay an extra amount"), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText("Policy-exception hold"), { target: { value: "0" } });
    expect(onChange.mock.calls).toEqual([
      [{ preArrivalReminderDays: 5 }],
      [{ additionalPaymentReminderDays: 30 }],
      [{ policyExceptionHoldDays: 1 }],
    ]);
  });
});
