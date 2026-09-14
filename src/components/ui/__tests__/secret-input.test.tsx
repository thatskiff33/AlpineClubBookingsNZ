// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SecretInput } from "@/components/ui/secret-input";
import {
  HUT_LEADER_PIN_LENGTH,
  sanitiseHutLeaderPin,
} from "@/lib/hut-leader-pin";

/**
 * `SecretInput`'s FILTERING and CARET behaviour (#2981).
 *
 * Deliberately not where the security property is proved. jsdom is not a browser
 * and the whole reason this component exists is a react-dom/browser runtime fact,
 * so the attribute-and-selector guarantee is pinned by
 * `e2e/raw-css-secret-reflection.spec.ts` in a real engine. What jsdom CAN answer
 * is whether the filter runs and whether the caret survives it — the half that
 * would otherwise be untested, because the browser spec types at the end of the
 * value and never exercises a mid-string edit that deletes a character.
 *
 * The attribute assertions here are a cheap bonus rather than the proof: with no
 * `value`/`defaultValue` prop, even jsdom sets no `value` attribute.
 */

function renderPin() {
  const onValueChange = vi.fn();
  render(
    <SecretInput
      id="pin"
      aria-label="PIN"
      maxLength={HUT_LEADER_PIN_LENGTH}
      sanitise={sanitiseHutLeaderPin}
      onValueChange={onValueChange}
    />,
  );
  return {
    field: screen.getByLabelText("PIN") as HTMLInputElement,
    onValueChange,
  };
}

/**
 * Deliver an edit the way a browser does: the new text is already in the
 * element's value and the caret already sits after the inserted characters when
 * `change` fires.
 *
 * It goes through `fireEvent.change`'s `target` rather than assigning
 * `field.value` first, because React 19 keeps its own value tracker and swallows
 * a change event whose value it believes it already knows — assigning directly
 * makes every one of these tests pass vacuously with the handler never called.
 */
function edit(field: HTMLInputElement, value: string, caret: number) {
  fireEvent.change(field, {
    target: { value, selectionStart: caret, selectionEnd: caret },
  });
}

/** One keystroke: `character` inserted at `at`. */
function typeAt(field: HTMLInputElement, character: string, at: number) {
  const before = field.value;
  edit(
    field,
    before.slice(0, at) + character + before.slice(at),
    at + character.length,
  );
}

describe("SecretInput", () => {
  it("never carries a value attribute, typed into or not", () => {
    const { field } = renderPin();
    expect(field).not.toHaveAttribute("value");
    typeAt(field, "1", 0);
    typeAt(field, "4", 1);
    expect(field.value).toBe("14");
    expect(field).not.toHaveAttribute("value");
    expect(field.defaultValue).toBe("");
  });

  it("reports the sanitised value, not the raw one", () => {
    const { field, onValueChange } = renderPin();
    typeAt(field, "1", 0);
    typeAt(field, "a", 1);
    expect(field.value).toBe("1");
    expect(onValueChange).toHaveBeenLastCalledWith("1");
  });

  it("leaves the caret where it was when a mid-string character is filtered out", () => {
    const { field } = renderPin();
    for (const [index, digit] of [..."1234"].entries()) typeAt(field, digit, index);
    expect(field.value).toBe("1234");

    // Caret between "12" and "34"; the rejected character must not move it.
    typeAt(field, "a", 2);
    expect(field.value).toBe("1234");
    expect(field.selectionStart).toBe(2);
    expect(field.selectionEnd).toBe(2);

    // And typing a digit there still inserts at the caret.
    typeAt(field, "9", 2);
    expect(field.value).toBe("12934");
    expect(field.selectionStart).toBe(3);
  });

  it("keeps the caret after the typed digit when the length cap truncates the tail", () => {
    const { field } = renderPin();
    for (const [index, digit] of [..."123456"].entries()) typeAt(field, digit, index);
    expect(field.value).toBe("123456");

    // A browser with `maxLength` would refuse this, but the filter is the
    // authority and this is the case where counting TOTAL deletions would put
    // the caret one position early.
    typeAt(field, "9", 2);
    expect(field.value).toBe("129345");
    expect(field.selectionStart).toBe(3);
  });

  it("caps the length however the characters arrive", () => {
    const { field, onValueChange } = renderPin();
    // Paste: the whole string lands at once.
    edit(field, "1a2b3c4d5e6f7g8h", 16);
    expect(field.value).toBe("123456");
    expect(field.value).toHaveLength(HUT_LEADER_PIN_LENGTH);
    expect(onValueChange).toHaveBeenLastCalledWith("123456");
    expect(field).not.toHaveAttribute("value");
  });

  it("passes the value straight through when no filter is given", () => {
    const onValueChange = vi.fn();
    render(<SecretInput aria-label="Token" onValueChange={onValueChange} />);
    const field = screen.getByLabelText("Token") as HTMLInputElement;
    edit(field, "abc-123", 7);
    expect(onValueChange).toHaveBeenLastCalledWith("abc-123");
    expect(field).not.toHaveAttribute("value");
  });
});
