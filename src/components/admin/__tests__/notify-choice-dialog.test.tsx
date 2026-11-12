// @vitest-environment jsdom

import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NotifyChoiceDialog } from "@/components/admin/notify-choice-dialog";

afterEach(cleanup);

// Owns the open state as every caller does, so Go back's close is observable.
function Harness({
  submitting = false,
  single = false,
  summary,
  onWithout = vi.fn(),
  onWith = vi.fn(),
  onSingle = vi.fn(),
}: {
  submitting?: boolean;
  single?: boolean;
  summary?: React.ReactNode;
  onWithout?: () => void;
  onWith?: () => void;
  onSingle?: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <p data-testid="open-state">{open ? "open" : "closed"}</p>
      <NotifyChoiceDialog
        open={open}
        onOpenChange={setOpen}
        title="Email the member?"
        description="The action happens either way."
        summary={summary}
        submitting={submitting}
        actions={
          single
            ? { kind: "single", action: { label: "Do it", onSelect: onSingle } }
            : {
                kind: "choice",
                withoutEmail: { label: "Do it without emailing", onSelect: onWithout },
                withEmail: { label: "Do it and email member", onSelect: onWith },
              }
        }
      />
    </>
  );
}

function footerButtons() {
  return within(screen.getByRole("dialog"))
    .getAllByRole("button")
    // The corner X (sr-only "Close") is DialogContent's, not the footer's.
    .filter((b) => b.textContent !== "Close");
}

describe("NotifyChoiceDialog", () => {
  it("puts Go back first, and Go back closes the dialog without firing either action", () => {
    const onWithout = vi.fn();
    const onWith = vi.fn();
    render(<Harness onWithout={onWithout} onWith={onWith} />);

    expect(footerButtons().map((b) => b.textContent)).toEqual([
      "Go back",
      "Do it without emailing",
      "Do it and email member",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));

    expect(screen.getByTestId("open-state").textContent).toBe("closed");
    expect(onWithout).not.toHaveBeenCalled();
    expect(onWith).not.toHaveBeenCalled();
  });

  it("fires each action's own callback exactly once", () => {
    const onWithout = vi.fn();
    const onWith = vi.fn();
    render(<Harness onWithout={onWithout} onWith={onWith} />);

    fireEvent.click(screen.getByRole("button", { name: "Do it without emailing" }));
    expect(onWithout).toHaveBeenCalledTimes(1);
    expect(onWith).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Do it and email member" }));
    expect(onWith).toHaveBeenCalledTimes(1);
    expect(onWithout).toHaveBeenCalledTimes(1);
  });

  it("disables every button and refuses Escape while submitting", () => {
    render(<Harness submitting />);

    for (const button of footerButtons()) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByTestId("open-state").textContent).toBe("open");
  });

  it("offers only Go back and the one action in the single-action (No emails) shape", () => {
    const onSingle = vi.fn();
    render(<Harness single onSingle={onSingle} />);

    expect(footerButtons().map((b) => b.textContent)).toEqual(["Go back", "Do it"]);
    fireEvent.click(screen.getByRole("button", { name: "Do it" }));
    expect(onSingle).toHaveBeenCalledTimes(1);
  });

  it("renders the summary slot inside the dialog when given", () => {
    render(<Harness summary={<p>Refund amount: $50.00</p>} />);

    expect(
      within(screen.getByRole("dialog")).getByText("Refund amount: $50.00"),
    ).toBeTruthy();
  });
});
