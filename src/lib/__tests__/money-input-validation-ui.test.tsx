// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CancellationRulesEditor } from "@/components/admin/booking-policies/cancellation-rules-editor";
import type { PolicyRule } from "@/components/admin/booking-policies/types";

/**
 * #2685, owner decision 3 (9 Aug 2026): "Invalid money input is rejected with a
 * visible validation error. Do not coerce malformed/unparseable input to zero…
 * the error state has to be genuinely wired into the UI, not left as a `null`
 * that renders nothing."
 *
 * This proves the wiring end to end on the cancellation fixed-fee box, which was
 * the most explicit offender: it read `Math.round((parseFloat(v) || 0) * 100)`,
 * so anything the parser could not read became a cancellation fee of $0.00 with
 * nothing on screen. The message must be VISIBLE, the stored cents must not
 * move, and the surrounding section must learn that it may not save.
 */

const BASE_RULE: PolicyRule = {
  daysBeforeStay: 7,
  refundPercentage: 50,
  creditRefundPercentage: 50,
  fixedFeeCents: 2500,
  creditFixedFeeCents: 1000,
};

function Harness({
  onInvalidAmountsChange,
  onRulesChange,
}: {
  onInvalidAmountsChange?: (invalid: boolean) => void;
  onRulesChange?: (rules: PolicyRule[]) => void;
}) {
  const [rules, setRules] = useState<PolicyRule[]>([BASE_RULE]);
  return (
    <CancellationRulesEditor
      rules={rules}
      onChange={(next) => {
        setRules(next);
        onRulesChange?.(next);
      }}
      onInvalidAmountsChange={onInvalidAmountsChange}
    />
  );
}

/**
 * The card fixed-fee box is the FIRST TEXT input in the row.
 *
 * The row's first three boxes — days before stay, refund %, credit refund % —
 * are still `type="number"`, because they are counts and percentages rather than
 * money. Only the two money boxes are `type="text" inputMode="decimal"`
 * (#2685, owner decision 14 Aug 2026), which is what lets a malformed amount
 * reach the parser at all instead of being sanitized to "" by the browser.
 *
 * So this selector is also a load-bearing assertion: if someone reverts the
 * money boxes to `type="number"`, there is no textbox here and every test in
 * this file fails loudly rather than silently stopping testing the defect.
 */
function feeBox(): HTMLInputElement {
  return screen.getAllByRole("textbox")[0] as HTMLInputElement;
}

function typeInto(value: string) {
  fireEvent.change(feeBox(), { target: { value } });
}

describe("the defect the owner decision was actually about", () => {
  /*
    A stray character was the single most common malformed entry, and until the
    money boxes became `type="text"` it was the ONE case that never reached any
    of this. HTML's value-sanitization algorithm strips a number input's value to
    "" the moment it does not parse as a floating-point number, and every handler
    reads "" as "the admin cleared the box". So `"4a5"` in a cancellation fee
    silently saved $0.00, with the save button re-enabled and nothing on screen —
    and worse, it wiped an error that was already showing.

    These cases would all have passed against the old `type="number"` markup
    while the product was broken, because the assertion they make is about what
    the browser hands the handler. That is why the type matters and why
    `feeBox()` selects a textbox.
  */
  const STRAY_CHARACTER_ENTRIES = [
    "4a5",       // a mistyped digit
    "$45.00",    // a currency symbol, which admins type by habit
    "1,000.00",  // a thousands separator, likewise
    "45.00x",    // a trailing character
  ];

  it.each(STRAY_CHARACTER_ENTRIES)(
    "refuses %s instead of silently saving $0.00",
    (entry) => {
      const onInvalidAmountsChange = vi.fn();
      const onRulesChange = vi.fn();

      render(
        <Harness
          onInvalidAmountsChange={onInvalidAmountsChange}
          onRulesChange={onRulesChange}
        />,
      );

      typeInto(entry);

      // The admin is told, rather than left with a silently zeroed fee.
      expect(screen.getByRole("alert").textContent).toContain(
        "Enter a fee in dollars and cents",
      );
      // What they typed is still on screen to correct.
      expect(feeBox().value).toBe(entry);
      // No fee was written at all — not 0, not a partial parse.
      expect(onRulesChange).not.toHaveBeenCalled();
      // And the section is told to refuse the save.
      expect(onInvalidAmountsChange).toHaveBeenLastCalledWith(true);
    },
  );

  it("does not wipe an existing error when the next keystroke is also bad", () => {
    const onInvalidAmountsChange = vi.fn();
    render(<Harness onInvalidAmountsChange={onInvalidAmountsChange} />);

    typeInto("25.00x");
    expect(screen.getByRole("alert")).toBeTruthy();

    // The old clear-branch ran unconditionally, so one more character made the
    // error vanish and the fee become $0.00 with save re-enabled.
    typeInto("25.00xy");

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(onInvalidAmountsChange).toHaveBeenLastCalledWith(true);
  });
});

describe("a refused money amount is visible in the UI", () => {
  it("shows an error, keeps the stored cents, and blocks the section's save", () => {
    const onInvalidAmountsChange = vi.fn();
    const onRulesChange = vi.fn();

    render(
      <Harness
        onInvalidAmountsChange={onInvalidAmountsChange}
        onRulesChange={onRulesChange}
      />,
    );

    expect(feeBox().value).toBe("25.00");
    expect(onInvalidAmountsChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole("alert")).toBeNull();

    // A stray suffix remains visible so the exact parser can explain it.
    typeInto("25.00x");

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Enter a fee in dollars and cents");

    // The box still shows exactly what was typed — it does not snap back and
    // pretend the entry never happened.
    expect(feeBox().value).toBe("25.00x");

    // The fee never became 2500.5, 2501, or 0: no rule update was emitted at
    // all, so the last accepted value stands and the section is told to refuse.
    expect(onRulesChange).not.toHaveBeenCalled();
    expect(onInvalidAmountsChange).toHaveBeenLastCalledWith(true);
  });

  it("clears the error and resumes saving once a valid amount is typed", () => {
    const onInvalidAmountsChange = vi.fn();
    const onRulesChange = vi.fn();

    render(
      <Harness
        onInvalidAmountsChange={onInvalidAmountsChange}
        onRulesChange={onRulesChange}
      />,
    );

    typeInto("12.34x");
    expect(screen.getByRole("alert")).toBeTruthy();

    typeInto("12.34");

    expect(screen.queryByRole("alert")).toBeNull();
    expect(onInvalidAmountsChange).toHaveBeenLastCalledWith(false);
    const lastRules = onRulesChange.mock.calls.at(-1)?.[0] as PolicyRule[];
    expect(lastRules[0].fixedFeeCents).toBe(1234);
  });

  it("treats an emptied box as a deliberate zero fee, not an error", () => {
    const onInvalidAmountsChange = vi.fn();
    const onRulesChange = vi.fn();

    render(
      <Harness
        onInvalidAmountsChange={onInvalidAmountsChange}
        onRulesChange={onRulesChange}
      />,
    );

    typeInto("");

    expect(screen.queryByRole("alert")).toBeNull();
    expect(onInvalidAmountsChange).toHaveBeenLastCalledWith(false);
    const lastRules = onRulesChange.mock.calls.at(-1)?.[0] as PolicyRule[];
    expect(lastRules[0].fixedFeeCents).toBe(0);
  });

  it("refuses a negative fee, which the old parser accepted", () => {
    const onRulesChange = vi.fn();
    render(<Harness onRulesChange={onRulesChange} />);

    // `min="0"` is advisory: the browser does not stop a typed minus sign, and
    // `parseFloat("-5")` used to store a fixed fee of MINUS $5.
    typeInto("-5.00");

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(onRulesChange).not.toHaveBeenCalled();
  });

  it("names the error element from the input it belongs to", () => {
    render(<Harness />);

    typeInto("1.00x");

    const alert = screen.getByRole("alert");
    expect(alert.id).toBeTruthy();
    expect(feeBox().getAttribute("aria-describedby")).toBe(alert.id);
    expect(feeBox().getAttribute("aria-invalid")).toBe("true");
  });
});

/**
 * #2685 review — the drafts belong to the rules that were on screen when they
 * were typed, and to nothing else.
 *
 * `feeDrafts` and `feeErrors` are keyed by ROW INDEX, so when the surrounding
 * section replaced `rules` — Cancel restoring the saved policy, or a switch to a
 * different lodge's policy scope — index 0's abandoned text and its complaint
 * carried straight over onto the rules that arrived. That left the admin looking
 * at the previous scope's typed text over the new scope's stored fees, and,
 * after Cancel, at a complaint about a policy they had just put back with Save
 * still latched off.
 *
 * The harness below is the section: it owns `rules` and can replace them from
 * outside, which is the thing the component has to notice.
 */
describe("a draft does not outlive the rules it was typed against", () => {
  const OTHER_RULE: PolicyRule = {
    daysBeforeStay: 30,
    refundPercentage: 100,
    creditRefundPercentage: 100,
    fixedFeeCents: 9900,
    creditFixedFeeCents: 100,
  };

  function ReplaceableHarness() {
    const [rules, setRules] = useState<PolicyRule[]>([BASE_RULE]);
    return (
      <>
        <button onClick={() => setRules([BASE_RULE])}>restore saved</button>
        <button onClick={() => setRules([OTHER_RULE])}>switch scope</button>
        <CancellationRulesEditor rules={rules} onChange={setRules} />
      </>
    );
  }

  it("drops an abandoned amount and its error when the section restores the saved rules", () => {
    render(<ReplaceableHarness />);

    typeInto("4a5");
    expect(screen.getByRole("alert")).toBeTruthy();

    // `[BASE_RULE]` is a NEW array holding the same rule — exactly what
    // `cancelEditing` does when it restores the saved snapshot.
    fireEvent.click(screen.getByText("restore saved"));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(feeBox().value).toBe("25.00");
  });

  it("drops the previous scope's typed text when a different policy arrives", () => {
    render(<ReplaceableHarness />);

    typeInto("12.50");
    expect(feeBox().value).toBe("12.50");

    fireEvent.click(screen.getByText("switch scope"));

    // The new scope's stored fee, not the last scope's half-finished edit.
    expect(feeBox().value).toBe("99.00");
  });

  it("keeps what is being typed while the rules change on every keystroke", () => {
    // The guard above must not fire on the editor's OWN output: every accepted
    // keystroke hands the section a new array, and wiping the draft then would
    // make the box impossible to type in.
    render(<ReplaceableHarness />);

    typeInto("3");
    expect(feeBox().value).toBe("3");
    typeInto("3.");
    expect(feeBox().value).toBe("3.");
    typeInto("3.7");
    expect(feeBox().value).toBe("3.7");
    typeInto("3.75");
    expect(feeBox().value).toBe("3.75");
  });
});
