// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import DisplayBuilder from "../display-builder";
import { emptyBuilderModel } from "@/lib/lodge-display/builder-model";

// §U2/U3: the board key is no longer a hand-typed slug the author must get right.
// It auto-derives from the Name (slugified), stays editable as a preview field,
// and is validated client-side against the same regex the save routes enforce —
// so an invalid key ("Foyer Board") is caught inline and blocks Save, never
// round-tripping to a bare "Invalid request". §U7: the canvas is relabelled to
// convey it is the board BODY area (the device shell adds header/footer chrome).

function renderNewBuilder() {
  return render(
    <DisplayBuilder
      layoutId={null}
      templateId={null}
      initialModel={emptyBuilderModel("columns", 2)}
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

describe("DisplayBuilder — board key field (§U2/U3)", () => {
  it("auto-derives a valid slug from the name and enables Create", () => {
    renderNewBuilder();
    const name = screen.getByLabelText("Name");
    const key = screen.getByLabelText(/Board key/i) as HTMLInputElement;
    const create = screen.getByRole("button", { name: /Create board/i });

    // Nothing typed yet → Save is blocked with a helpful hint.
    expect(create).toBeDisabled();
    expect(screen.getByText(/Enter a name to save/i)).toBeInTheDocument();

    fireEvent.change(name, { target: { value: "Foyer Board" } });

    expect(key.value).toBe("foyer-board");
    expect(create).toBeEnabled();
  });

  it("shows an inline message and blocks Save when the key is hand-edited invalid", () => {
    renderNewBuilder();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Foyer" },
    });
    const key = screen.getByLabelText(/Board key/i) as HTMLInputElement;
    expect(key.value).toBe("foyer");

    // A hand-edit with a space + capitals is invalid.
    fireEvent.change(key, { target: { value: "Foyer Board" } });

    expect(key).toHaveAttribute("aria-invalid", "true");
    expect(
      screen.getByText(/Use lower-case letters, numbers and hyphens only/i)
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create board/i })).toBeDisabled();
    expect(
      screen.getByText(/Fix the board key to save/i)
    ).toBeInTheDocument();
  });

  // #2048 L1: the client mirrors the server's `.max(80)` so a long auto-derived
  // slug is caught inline, not bounced back as a misattributed charset error.
  it("blocks Save on an over-length key and says so (mirrors the server 80-char cap)", () => {
    renderNewBuilder();
    const key = screen.getByLabelText(/Board key/i) as HTMLInputElement;
    // 81 chars — one past the server cap.
    fireEvent.change(key, { target: { value: "a".repeat(81) } });

    expect(key).toHaveAttribute("aria-invalid", "true");
    // The inline alert (distinct from the always-on hint) names the cap.
    expect(screen.getByRole("alert")).toHaveTextContent(/up to 80 characters/i);
    expect(screen.getByRole("button", { name: /Create board/i })).toBeDisabled();

    // Exactly 80 chars is accepted (with a name present to unblock Save).
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Long board" } });
    fireEvent.change(key, { target: { value: "a".repeat(80) } });
    expect(key).toHaveAttribute("aria-invalid", "false");
    expect(screen.getByRole("button", { name: /Create board/i })).toBeEnabled();
  });

  it("mentions the 80-character cap in the key hint", () => {
    renderNewBuilder();
    expect(screen.getByText(/up to 80 characters/i)).toBeInTheDocument();
  });

  it("does not clobber a hand-edited key when the name changes again", () => {
    renderNewBuilder();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Foyer" },
    });
    const key = screen.getByLabelText(/Board key/i) as HTMLInputElement;
    fireEvent.change(key, { target: { value: "lobby-wall" } });
    // A further name edit must leave the hand-set key alone.
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Foyer Board" },
    });
    expect(key.value).toBe("lobby-wall");
  });

  it("labels the canvas as the board body area (§U7)", () => {
    renderNewBuilder();
    expect(
      screen.getByText(/Canvas — board body \(16:9 screen minus header\/footer\)/i)
    ).toBeInTheDocument();
  });
});
