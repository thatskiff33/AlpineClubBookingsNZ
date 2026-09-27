// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { MoneyInput, type MoneyInputProps } from "./money-input";

function Harness(props: Partial<MoneyInputProps> = {}) {
  const [value, setValue] = useState(props.value ?? "12.34");
  return (
    <MoneyInput
      label="Nightly rate"
      {...props}
      value={value}
      onValueChange={setValue}
    />
  );
}

describe("MoneyInput", () => {
  it("is a labelled decimal text box and rejects a third typed fractional digit", () => {
    render(<Harness value="12.34" />);

    const input = screen.getByRole("textbox", { name: "Nightly rate" });
    expect(input.getAttribute("type")).toBe("text");
    expect(input.getAttribute("inputmode")).toBe("decimal");

    fireEvent.change(input, { target: { value: "35.00" } });
    fireEvent.change(input, { target: { value: "35.000" } });
    expect(input).toHaveProperty("value", "35.00");
  });

  it("rejects a pasted third fractional digit while retaining other invalid text", () => {
    render(<Harness />);
    const input = screen.getByRole("textbox");

    fireEvent.change(input, { target: { value: "35.000" } });
    expect(input).toHaveProperty("value", "12.34");

    fireEvent.change(input, { target: { value: "$35.00" } });
    expect(input).toHaveProperty("value", "$35.00");
  });

  it("steps whole dollars with buttons and arrow keys using cents-safe arithmetic", () => {
    render(<Harness value="12.34" />);
    const input = screen.getByRole("textbox");

    fireEvent.click(screen.getByRole("button", { name: "Increase amount by one dollar" }));
    expect(input).toHaveProperty("value", "13.34");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveProperty("value", "12.34");
    fireEvent.click(screen.getByRole("button", { name: "Decrease amount by one dollar" }));
    expect(input).toHaveProperty("value", "11.34");
  });

  it("does not step past cents bounds or from invalid text", () => {
    const onValueChange = vi.fn();
    const { rerender } = render(
      <MoneyInput value="0.00" onValueChange={onValueChange} minCents={0} maxCents={0} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Decrease amount by one dollar" }));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowUp" });
    expect(onValueChange).not.toHaveBeenCalled();

    rerender(<MoneyInput value="bad" onValueChange={onValueChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Increase amount by one dollar" }));
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("supports signed adjustments and respects disabled and read-only fields", () => {
    const onValueChange = vi.fn();
    const { rerender } = render(
      <MoneyInput value="-1.50" onValueChange={onValueChange} allowNegative />,
    );
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowUp" });
    expect(onValueChange).toHaveBeenLastCalledWith("-0.50");

    rerender(<MoneyInput value="1.00" onValueChange={onValueChange} disabled />);
    expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Increase amount by one dollar" }) as HTMLButtonElement).disabled).toBe(true);

    rerender(<MoneyInput value="1.00" onValueChange={onValueChange} readOnly />);
    expect((screen.getByRole("textbox") as HTMLInputElement).readOnly).toBe(true);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowUp" });
    expect(onValueChange).toHaveBeenLastCalledWith("-0.50");
  });

  it("links its visible error with caller supplied descriptions", () => {
    render(
      <MoneyInput
        label="Rate"
        value="invalid"
        onValueChange={vi.fn()}
        aria-describedby="rate-help"
        error="Enter dollars and cents, up to 2 decimal places"
      />,
    );
    const input = screen.getByRole("textbox", { name: "Rate" });
    const alert = screen.getByRole("alert");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toContain("rate-help");
    expect(input.getAttribute("aria-describedby")).toContain(alert.id);
  });
});
