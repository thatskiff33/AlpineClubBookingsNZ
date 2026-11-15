// @vitest-environment jsdom

// #4949: the one home of "a status region mounted before the request, sr-only
// while empty, focused when the outcome replaces the control that had focus".

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { createRef, useRef } from "react";
import { describe, expect, it } from "vitest";

import { StatusRegion, useFocusOnOutcome } from "@/components/status-region";
import { expectToHoldFocus } from "@/lib/__tests__/helpers/focus";

describe("StatusRegion", () => {
  it("is a polite, atomic, empty, screen-reader-only status region until it has something to show", () => {
    render(<StatusRegion />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-atomic", "true");
    expect(status).toHaveClass("sr-only");
    expect(status).toHaveTextContent("");
  });

  it("stays the same element when it is filled, and draws the box only when visible", () => {
    const { rerender } = render(
      <StatusRegion visible={false} visibleClassName="box">
        Sent
      </StatusRegion>,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveClass("sr-only");
    expect(status).not.toHaveClass("box");

    rerender(
      <StatusRegion visible visibleClassName="box">
        Sent
      </StatusRegion>,
    );
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveClass("box", "outline-none");
    expect(status).not.toHaveClass("sr-only");
  });

  it("can take focus but is never a tab stop", () => {
    render(<StatusRegion id="r" />);
    expect(screen.getByRole("status")).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("status")).toHaveAttribute("id", "r");
  });

  it("hands its element to a caller's ref", () => {
    const ref = createRef<HTMLDivElement>();
    render(<StatusRegion ref={ref} />);
    expect(ref.current).toBe(screen.getByRole("status"));
  });

  it("takes focus when the outcome key arrives, not when it mounts at rest", async () => {
    const { rerender } = render(<StatusRegion outcomeKey={0}>Working</StatusRegion>);
    const status = screen.getByRole("status");
    expect(document.activeElement).toBe(document.body);

    rerender(<StatusRegion outcomeKey={1}>Done</StatusRegion>);
    await expectToHoldFocus(status, "the status region");
  });

  it("takes focus again for each new outcome, and moves nothing for a re-render with the same key", async () => {
    const { rerender } = render(
      <>
        <button type="button">Elsewhere</button>
        <StatusRegion outcomeKey={1}>Done</StatusRegion>
      </>,
    );
    const status = screen.getByRole("status");
    await expectToHoldFocus(status, "the status region");

    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    rerender(
      <>
        <button type="button">Elsewhere</button>
        <StatusRegion outcomeKey={1}>Done again</StatusRegion>
      </>,
    );
    await expectToHoldFocus(elsewhere, "the control the person moved to");

    rerender(
      <>
        <button type="button">Elsewhere</button>
        <StatusRegion outcomeKey={2}>Done again</StatusRegion>
      </>,
    );
    await expectToHoldFocus(status, "the status region");
  });

  it("moves nothing for a falsy key", async () => {
    render(
      <>
        <button type="button">Elsewhere</button>
        <StatusRegion outcomeKey={false}>Working</StatusRegion>
      </>,
    );
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    await expectToHoldFocus(elsewhere, "the control the person is on");
  });
});

describe("useFocusOnOutcome", () => {
  function Panel({ outcome }: { outcome: number }) {
    const ref = useRef<HTMLDivElement>(null);
    useFocusOnOutcome(ref, outcome);
    return (
      <div ref={ref} tabIndex={-1} data-testid="panel">
        Result
      </div>
    );
  }

  it("focuses any element a caller names once the outcome arrives", async () => {
    const { rerender } = render(<Panel outcome={0} />);
    expect(document.activeElement).toBe(document.body);
    rerender(<Panel outcome={1} />);
    await expectToHoldFocus(screen.getByTestId("panel"), "the outcome panel");
  });
});
