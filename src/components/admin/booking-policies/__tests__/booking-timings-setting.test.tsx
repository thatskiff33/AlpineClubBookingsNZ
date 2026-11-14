// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BookingTimingsSetting } from "../booking-timings-setting";
import { bookingTimingsFrom, type BookingTimings } from "@/lib/booking-timings";

afterEach(cleanup);

const PRE = "Pre-arrival reminder";
const PAYMENT = "First reminder to pay an extra amount";
const HOLD = "Policy-exception hold";

/** The page's own wiring: the control stages into state it then reads back. */
function Harness({ onStage }: { onStage?: (patch: Partial<BookingTimings>) => void }) {
  const [timings, setTimings] = useState(bookingTimingsFrom({}));
  return (
    <BookingTimingsSetting
      timings={timings}
      editing
      onChange={(patch) => {
        onStage?.(patch);
        setTimings((current) => ({ ...current, ...patch }));
      }}
    />
  );
}

const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe("booking timing controls", () => {
  it("shows the saved timings read-only until Edit", () => {
    render(<BookingTimingsSetting timings={bookingTimingsFrom({})} editing={false} onChange={vi.fn()} />);
    expect(screen.getAllByRole("spinbutton").map((field) => field.getAttribute("value"))).toEqual(["3", "3", "7"]);
    for (const field of screen.getAllByRole("spinbutton")) expect(field).toBeDisabled();
  });

  it("stages a whole number inside the bounds as it is typed", () => {
    const onStage = vi.fn();
    render(<Harness onStage={onStage} />);
    fireEvent.change(input(PRE), { target: { value: "5" } });
    fireEvent.change(input(HOLD), { target: { value: "30" } });
    expect(onStage.mock.calls).toEqual([[{ preArrivalReminderDays: 5 }], [{ policyExceptionHoldDays: 30 }]]);
  });

  it("keeps what is typed while it is out of bounds, then pulls it to the bound on blur", () => {
    const onStage = vi.fn();
    render(<Harness onStage={onStage} />);
    // "7" with a "14" typed after the caret at its end reads "714": it must not
    // silently show 30 half way through typing.
    fireEvent.change(input(HOLD), { target: { value: "714" } });
    expect(input(HOLD).value).toBe("714");
    expect(input(HOLD)).toHaveAttribute("aria-invalid", "true");
    expect(onStage).not.toHaveBeenCalled();
    fireEvent.blur(input(HOLD));
    expect(onStage.mock.calls).toEqual([[{ policyExceptionHoldDays: 30 }]]);
    expect(input(HOLD).value).toBe("30");
    expect(input(HOLD)).not.toHaveAttribute("aria-invalid");
  });

  it("pulls a value below the lower bound up to it on blur", () => {
    const onStage = vi.fn();
    render(<Harness onStage={onStage} />);
    fireEvent.change(input(PAYMENT), { target: { value: "0" } });
    expect(onStage).not.toHaveBeenCalled();
    fireEvent.blur(input(PAYMENT));
    expect(onStage.mock.calls).toEqual([[{ additionalPaymentReminderDays: 1 }]]);
    expect(input(PAYMENT).value).toBe("1");
  });

  it("lets a field be cleared to retype it, and falls back to the last staged value on blur", () => {
    const onStage = vi.fn();
    render(<Harness onStage={onStage} />);
    fireEvent.change(input(HOLD), { target: { value: "" } });
    expect(input(HOLD).value).toBe("");
    fireEvent.change(input(HOLD), { target: { value: "10" } });
    expect(input(HOLD).value).toBe("10");
    fireEvent.change(input(HOLD), { target: { value: "" } });
    fireEvent.blur(input(HOLD));
    expect(input(HOLD).value).toBe("10");
    expect(onStage.mock.calls).toEqual([[{ policyExceptionHoldDays: 10 }]]);
  });

  it("never stages a decimal", () => {
    const onStage = vi.fn();
    render(<Harness onStage={onStage} />);
    fireEvent.change(input(PRE), { target: { value: "2.5" } });
    fireEvent.blur(input(PRE));
    expect(onStage).not.toHaveBeenCalled();
    expect(input(PRE).value).toBe("3");
  });

  it("drops typed text when edit mode ends, so the next edit starts from the saved value", () => {
    const { rerender } = render(
      <BookingTimingsSetting timings={bookingTimingsFrom({})} editing onChange={vi.fn()} />,
    );
    // Out of bounds, so nothing was staged; the field is left without a blur.
    fireEvent.change(input(HOLD), { target: { value: "714" } });
    expect(input(HOLD).value).toBe("714");
    rerender(<BookingTimingsSetting timings={bookingTimingsFrom({})} editing={false} onChange={vi.fn()} />);
    expect(input(HOLD).value).toBe("7");
    rerender(<BookingTimingsSetting timings={bookingTimingsFrom({})} editing onChange={vi.fn()} />);
    expect(input(HOLD).value).toBe("7");
    expect(input(HOLD)).not.toHaveAttribute("aria-invalid");
  });
});
