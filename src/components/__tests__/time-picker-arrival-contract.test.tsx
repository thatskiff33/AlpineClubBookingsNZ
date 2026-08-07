// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { TimePicker } from "@/components/time-picker";
import { isExpectedArrivalTime } from "@/lib/arrival-time";

/*
  #2621 — the control and the rule must agree, proven by running both.

  The defect this closes was not that either side was wrong on its own. The
  picker had always offered only `:00` and `:30`; the API accepted six minute
  values; and the test that should have caught the gap re-implemented the API's
  regex, so it agreed with the bug. Three statements of one rule, and nothing
  compared them.

  So this compares them the only way that cannot go stale: render the real control
  and put every option it offers through the real validator. A future edit to the
  hour window, the minute set, or the pattern stays honest, and if the two are ever
  pulled apart again this fails on the actual values rather than on a copy.
*/
describe("the arrival-time picker offers exactly what the API accepts (#2621)", () => {
  it("renders at least one option, so an empty list cannot pass vacuously", () => {
    render(<TimePicker value={null} onChange={vi.fn()} />);
    // Guard the assertion below: `every` over an empty array is true, which would
    // turn a picker that rendered nothing into a passing contract test.
    expect(realTimeOptionValues().length).toBeGreaterThan(20);
  });

  it("offers no value the validator would refuse", () => {
    render(<TimePicker value={null} onChange={vi.fn()} />);
    const refused = realTimeOptionValues().filter(
      (value) => !isExpectedArrivalTime(value),
    );
    expect(refused).toEqual([]);
  });

  it("names the control through the id its label points at", () => {
    // The accessibility half of the same defect: all three call sites already
    // wrote `<Label htmlFor="arrival-time">`, and this rendered no id at all, so
    // every one of those labels pointed at nothing.
    render(
      <>
        <label htmlFor="arrival-time">Expected Arrival Time</label>
        <TimePicker id="arrival-time" value={null} onChange={vi.fn()} />
      </>,
    );
    expect(
      screen.getByLabelText("Expected Arrival Time").tagName.toLowerCase(),
    ).toBe("select");
  });

  it("carries a description only when one is supplied", () => {
    const { rerender } = render(
      <TimePicker value={null} onChange={vi.fn()} id="t" />,
    );
    expect(screen.getByRole("combobox")).not.toHaveAttribute("aria-describedby");

    rerender(
      <TimePicker value={null} onChange={vi.fn()} id="t" describedById="err" />,
    );
    expect(screen.getByRole("combobox")).toHaveAttribute(
      "aria-describedby",
      "err",
    );
  });
});

/** Every real option value except the "Not sure" empty choice. */
function realTimeOptionValues(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLOptionElement>("option"),
  )
    .map((option) => option.value)
    .filter((value) => value !== "");
}
