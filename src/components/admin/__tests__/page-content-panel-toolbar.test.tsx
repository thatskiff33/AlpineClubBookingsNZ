// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WysiwygEditor } from "@/components/admin/page-content-panel";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

describe("WysiwygEditor toolbar", () => {
  it.each([false, true])("names the multiline editor and exposes readOnly=%s in both modes", (readOnly) => {
    render(<WysiwygEditor value="<p>Example</p>" onChange={() => {}} readOnly={readOnly} />);
    const editor = screen.getByRole("textbox", { name: "Page content" });
    expect(editor.getAttribute("aria-multiline")).toBe("true");
    expect(editor.getAttribute("aria-readonly")).toBe(String(readOnly));
    expect(editor.getAttribute("contenteditable")).toBe(String(!readOnly));
    fireEvent.click(screen.getByRole("button", { name: "HTML Editor" }));
    expect(screen.getByRole("textbox", { name: "Page content" }).hasAttribute("readonly")).toBe(readOnly);
  });

  it("uses the field name when the editor is reused for header text", () => {
    render(<WysiwygEditor ariaLabel="Header text" value="" onChange={() => {}} />);
    expect(screen.getByRole("textbox", { name: "Header text" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "HTML Editor" }));
    expect(screen.getByRole("textbox", { name: "Header text" })).toBeTruthy();
  });

  it("keeps the editor toolbar sticky", () => {
    render(<WysiwygEditor value="<p>Example</p>" onChange={() => {}} />);

    const modeLabel = screen.getByText("Visual editor mode is active.");
    const toolbar = modeLabel.parentElement;

    expect(toolbar).not.toBeNull();
    expect(toolbar?.className).toContain("sticky");
    expect(toolbar?.className).toContain("top-0");
    expect(toolbar?.className).toContain("z-30");
  });
});
