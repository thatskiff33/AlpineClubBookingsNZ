// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminLoadError } from "@/components/admin/admin-load-error";

/**
 * #4961 review: Try again must not strand a keyboard user. A `disabled` button
 * drops focus for the length of the retry, and a retry that fails again leaves
 * the alert's words unchanged, which a live region does not announce.
 */
afterEach(cleanup);

function deferred() {
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => { settle = resolve; });
  return { promise, settle };
}

describe("AdminLoadError retry", () => {
  it("is an error alert with a Try again button that re-runs the page's read", () => {
    const onRetry = vi.fn();
    render(<AdminLoadError title="Things could not be loaded" message="Because." onRetry={onRetry} data-testid="load-error" />);
    const alert = screen.getByTestId("load-error");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent("Things could not be loaded");
    expect(alert).toHaveTextContent("Because.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("keeps focus on the button while a retry runs, ignores a second click, and says so", async () => {
    const read = deferred();
    const onRetry = vi.fn(() => read.promise);
    render(<AdminLoadError title="Things could not be loaded" message="Because." onRetry={onRetry} />);
    const button = screen.getByRole("button", { name: "Try again" });
    button.focus();
    fireEvent.click(button);

    // Not `disabled`: a disabled button would lose focus here.
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Trying again.");
    fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);

    // The retry fails again: the page leaves this mounted with the same words.
    await act(async () => { read.settle(); await read.promise; });
    expect(button).not.toHaveAttribute("aria-disabled");
    expect(button).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Still could not be loaded.");

    // And it can be pressed again.
    fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("keeps the status region mounted but empty before any retry, so the first announcement is not dropped", () => {
    render(<AdminLoadError title="Things could not be loaded" message="Because." onRetry={() => undefined} />);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });
});
