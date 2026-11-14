// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import DisplayBuilder from "../display-builder";
import { emptyBuilderModel } from "@/lib/lodge-display/builder-model";

// DnD accessibility (ADR-004 §8/§9). The builder must be operable with NO pointer:
// palette items are focusable, keyboard-draggable buttons (@dnd-kit exposes
// aria-roledescription + aria-describedby), and every placement/reorder also has
// a plain-button / menu fallback. The settings drawer opens on demand. jsdom can't
// fully simulate a @dnd-kit pointer drag, so these assert the keyboard-operable
// surface and fallbacks that guarantee no-pointer operation.

function renderBuilder(skeleton: Parameters<typeof emptyBuilderModel>[0] = "columns") {
  return render(
    <DisplayBuilder
      layoutId={null}
      templateId={null}
      initialModel={emptyBuilderModel(skeleton, 2)}
      initialKey=""
      initialName=""
      initialFooterHtml=""
      initialCssOverrides=""
      isBuiltIn={false}
      canEdit
      lodges={[{ id: "lodge-a", name: "Ruapehu" }]}
      onDuplicate={() => undefined}
    />
  );
}

describe("DisplayBuilder — keyboard operability + fallbacks", () => {
  it("palette modules are focusable, keyboard-draggable buttons", () => {
    renderBuilder();
    const arrivals = screen.getByRole("button", { name: /Arrivals board/i });
    // A real, tabbable button (works with keyboard, not just a pointer target).
    expect(arrivals.tagName).toBe("BUTTON");
    // @dnd-kit marks draggables so a screen-reader announces how to lift/move.
    expect(arrivals).toHaveAttribute("aria-roledescription", "draggable");
    expect(arrivals).toHaveAttribute("aria-describedby");
    // The HTML content block is a palette item too.
    expect(screen.getByRole("button", { name: /HTML content block/i })).toBeInTheDocument();
  });

  it("does NOT surface page-furniture modules in the palette", () => {
    renderBuilder();
    expect(screen.queryByRole("button", { name: /^Lodge header$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Info footer$/i })).toBeNull();
  });

  it("every zone exposes a labelled reorder + remove + settings control", () => {
    renderBuilder("columns");
    // Two zones → two "Settings" triggers, each zone move/remove labelled by key.
    expect(screen.getAllByRole("button", { name: "Settings" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: /Move zone-1 later/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Remove zone-2/i })).toBeInTheDocument();
  });

  it("side-rail pins the main cell — no remove/reorder on it", () => {
    renderBuilder("side-rail");
    expect(screen.queryByRole("button", { name: /Remove main/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Move main/i })).toBeNull();
    // Rail zones still reorder.
    expect(screen.getByRole("button", { name: /Remove rail-1/i })).toBeInTheDocument();
  });

  it("opens the zone settings drawer on demand (focus moves into it)", () => {
    renderBuilder("columns");
    fireEvent.click(screen.getAllByRole("button", { name: "Settings" })[0]);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Zone: zone-1/i)).toBeInTheDocument();
    // The behaviour picker (static/conditional/rotator) is present + operable.
    expect(within(dialog).getByLabelText(/Behaviour/i)).toBeInTheDocument();
  });

  // §U4: zone keys are positional (re-derived on every reorder), so after a move
  // the focused arrow must follow the MOVED zone to its new position, not stay on
  // the DOM slot (which now holds a different zone).
  it("keeps focus on the moved zone's control after a keyboard reorder", () => {
    renderBuilder("columns");
    const downFirst = screen.getByRole("button", { name: /Move zone-1 later/i });
    downFirst.focus();
    fireEvent.click(downFirst);
    // The zone that was first is now second; focus followed it to the second
    // position's "later" control (labelled by its re-derived key, zone-2).
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /Move zone-2 later/i })
    );
  });
});
