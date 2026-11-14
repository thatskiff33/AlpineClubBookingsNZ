// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { CommandDialog } from "@/components/ui/command";

describe("DialogContent viewport safety", () => {
  it("caps and scrolls content while Radix locks page scrolling", () => {
    render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Review changes</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "Review changes" });
    expect(dialog.classList.contains("max-h-[calc(100dvh-2rem)]")).toBe(true);
    expect(dialog.classList.contains("overflow-y-auto")).toBe(true);
  });

  it("preserves a caller's existing height cap", () => {
    render(
      <Dialog open>
        <DialogContent className="max-h-[90vh]" aria-describedby={undefined}>
          <DialogTitle>Review changes</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "Review changes" });
    expect(dialog.classList.contains("max-h-[90vh]")).toBe(true);
    expect(dialog.classList.contains("overflow-y-auto")).toBe(true);
    expect(dialog.classList.contains("max-h-[calc(100dvh-2rem)]")).toBe(false);
  });

  it("lets the command palette keep its own scrolling region", () => {
    render(<CommandDialog open />);
    const dialog = screen.getByRole("dialog", { name: "Command Palette" });
    expect(dialog.classList.contains("overflow-hidden")).toBe(true);
    expect(dialog.classList.contains("max-h-[calc(100dvh-2rem)]")).toBe(true);
    expect(dialog.classList.contains("overflow-y-auto")).toBe(false);
  });

  it("makes the command palette a column so only its list shrinks", () => {
    render(<CommandDialog open />);
    const dialog = screen.getByRole("dialog", { name: "Command Palette" });
    expect(dialog.classList.contains("flex")).toBe(true);
    expect(dialog.classList.contains("flex-col")).toBe(true);
    expect(dialog.classList.contains("grid")).toBe(false);
  });
});
