// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useInertOutsidePopup } from "@/hooks/use-inert-outside-popup";

// #4466: what an open Select hides from assistive tech (Radix hideOthers,
// `data-aria-hidden`) is made inert while it is open, and released when it
// closes, so nothing outside a closed select is left unfocusable.
function LetterSelect() {
  return (
      <Select defaultValue="a">
        <SelectTrigger aria-label="Letter">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Alpha</SelectItem>
          <SelectItem value="b">Bravo</SelectItem>
        </SelectContent>
      </Select>
  );
}

function Harness() {
  return (
    <div>
      <button type="button">Outside</button>
      <LetterSelect />
    </div>
  );
}

async function flushFrames() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  });
}

describe("SelectContent inert outside (#4466)", () => {
  beforeAll(() => {
    // jsdom has neither; Radix Select calls both.
    if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  });

  it("makes the hidden page inert while open and releases it on close", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("combobox", { name: "Letter" });

    expect(document.querySelectorAll("[inert]")).toHaveLength(0);

    await act(async () => {
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
    });
    await flushFrames();
    const option = await screen.findByRole("option", { name: "Bravo" });

    const hidden = document.querySelectorAll('[data-aria-hidden="true"]');
    expect(hidden.length).toBeGreaterThan(0);
    for (const element of hidden) expect(element.hasAttribute("inert")).toBe(true);

    await act(async () => {
      fireEvent.click(option);
    });
    await flushFrames();

    expect(screen.queryByRole("option", { name: "Bravo" })).toBeNull();
    expect(document.querySelectorAll("[inert]")).toHaveLength(0);
  });

  it("leaves an open dialog that holds the select focusable", async () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Pick</DialogTitle>
          <LetterSelect />
        </DialogContent>
      </Dialog>,
    );
    const trigger = screen.getByRole("combobox", { name: "Letter" });
    await act(async () => {
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
    });
    await flushFrames();
    await screen.findByRole("option", { name: "Bravo" });

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.closest("[inert]")).toBeNull();
  });

  it("leaves the children of a dialog alone when the popup renders inside it", async () => {
    // A listbox rendered INSIDE a dialog makes hideOthers mark the dialog's own
    // children; inerting them would empty the dialog of focusable content.
    function InDialogPopup() {
      const ref = useInertOutsidePopup<HTMLDivElement>(null);
      return (
        <div role="dialog" aria-label="Remove">
          <div data-aria-hidden="true" aria-hidden="true" data-testid="sibling">
            <button type="button">Cancel</button>
          </div>
          <div ref={ref} role="listbox" />
        </div>
      );
    }
    render(<InDialogPopup />);
    await flushFrames();
    expect(screen.getByTestId("sibling").hasAttribute("inert")).toBe(false);
  });
});
