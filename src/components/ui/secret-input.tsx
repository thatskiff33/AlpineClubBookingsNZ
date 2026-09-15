"use client";

import * as React from "react";

import { Input, type InputProps } from "@/components/ui/input";

/**
 * A text input for a user-entered SECRET on a page that carries administrator
 * Raw CSS (#2981).
 *
 * **The rule, the mechanism, the browser evidence and the scope live in
 * `docs/SECURITY.md` → "Secret entry on pages that carry Raw CSS".** Read that
 * before changing anything here; this docblock states only what the code does.
 *
 * It renders an **uncontrolled** input: neither `value` nor `defaultValue` ever
 * reaches the DOM element, so `react-dom` never writes `defaultValue` and the
 * element carries no `value` attribute at any point. The live secret exists only
 * as the element's `value` property and in the caller's React state, neither of
 * which a CSS selector can read.
 *
 * Both props are removed by the type (`Omit`), so passing one is a compile error
 * rather than a lint rule — unrepresentable beats policed (`INV-SSOT`). They are
 * also stripped at runtime, because a `{...props}` spread from an `any`-typed
 * source would otherwise reinstate the leak silently. `sanitise` runs against the
 * element's own property rather than by feeding a value back down as a prop, so
 * input filtering keeps working without reintroducing the attribute.
 *
 * Guards: `e2e/raw-css-secret-reflection.spec.ts` (runtime),
 * `src/components/ui/__tests__/secret-input.test.tsx` (filtering and caret),
 * `src/lib/__tests__/raw-css-secret-input-census.test.ts` (adoption).
 */
export type SecretInputProps = Omit<
  InputProps,
  "value" | "defaultValue" | "onChange"
> & {
  /** Called with the sanitised value after every edit. */
  onValueChange: (value: string) => void;
  /**
   * Optional input filter, applied to the element's own property. Must be a pure
   * function that only ever DELETES characters, and must be stable on prefixes —
   * `sanitise(raw.slice(0, n))` must be the corresponding prefix of
   * `sanitise(raw)`. The caret repair below depends on both, and every credential
   * filter here has them (digits only, a length cap).
   */
  sanitise?: (raw: string) => string;
};

/**
 * Input types whose selection API exists. `selectionStart` merely returns `null`
 * on the others (`email`, `number`, …), but `setSelectionRange` THROWS on them,
 * so the caret repair is skipped rather than guarded after the fact. A secret
 * field is a text or password field in practice; this only stops a future caller
 * crashing.
 */
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
    // types were bypassed. A reinstated `value` prop is the single way this
    // component can start leaking again.
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

          if (sanitise && next !== raw) {
            const caretCapable = CARET_CAPABLE_TYPES.has(node.type);
            const caret = caretCapable ? node.selectionStart : null;

            // Write the PROPERTY only. Assigning `node.value` never touches the
            // content attribute, which is exactly the distinction this component
            // exists to keep.
            node.value = next;

            if (caret !== null) {
              // Sanitise the text BEFORE the caret and take its length. That is
              // exact for a filter that only deletes and is prefix-stable —
              // including when the deletion is a trailing truncation, where
              // subtracting the total number of deleted characters would put the
              // caret one position too early.
              const repaired = Math.min(
                sanitise(raw.slice(0, caret)).length,
                next.length,
              );
              node.setSelectionRange(repaired, repaired);
            }
          }

          onValueChange(next);
        }}
      />
    );
  },
);
SecretInput.displayName = "SecretInput";
