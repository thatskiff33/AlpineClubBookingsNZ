// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  FieldHint,
  describedByFieldHint,
  useFieldHint,
} from "@/components/ui/field-hint";
// `INV-SSOT-004`: the ONE comment/string stripper in the tree, imported rather
// than written again.
import { stripCommentsAndStrings } from "@/lib/__tests__/support/strip-comments";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// #2257 — the point of this primitive is the ASSISTIVE-TECH association, not
// the grey text. A hint that merely sits below an input is invisible to a
// screen reader focusing that input, which is the defect these tests pin.

function HintedField({ errorId }: { errorId?: string }) {
  const hint = useFieldHint(errorId);
  return (
    <div>
      <Label htmlFor="season-name">Season Name</Label>
      {errorId ? <p id={errorId}>Enter a season name.</p> : null}
      <Input id="season-name" {...hint.fieldProps} />
      <FieldHint {...hint.hintProps}>Example: Winter 2026</FieldHint>
    </div>
  );
}

describe("FieldHint / useFieldHint", () => {
  it("points the described control at the hint it renders", () => {
    render(<HintedField />);

    const field = screen.getByLabelText("Season Name");
    const describedBy = field.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();

    // The id must resolve to the hint element actually in the document — the
    // wiring, not just the presence of an attribute.
    const hint = document.getElementById(describedBy ?? "");
    expect(hint).not.toBeNull();
    expect(hint).toHaveTextContent("Example: Winter 2026");
    expect(hint?.tagName).toBe("P");
  });

  it("announces an error before the hint when both describe the field", () => {
    render(<HintedField errorId="season-name-error" />);

    const field = screen.getByLabelText("Season Name");
    const ids = (field.getAttribute("aria-describedby") ?? "").split(" ");

    // Both descriptions survive — a hint must never displace an error.
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe("season-name-error");
    expect(document.getElementById(ids[1] ?? "")).toHaveTextContent(
      "Example: Winter 2026",
    );
  });

  it("drops falsy preceding ids so a conditional id can be passed straight through", () => {
    function Conditional() {
      const hint = useFieldHint(false, null, undefined, "");
      return (
        <>
          <Input aria-label="Code" {...hint.fieldProps} />
          <FieldHint {...hint.hintProps}>Example: WINTER20</FieldHint>
        </>
      );
    }
    render(<Conditional />);

    const ids = (
      screen.getByLabelText("Code").getAttribute("aria-describedby") ?? ""
    ).split(" ");
    expect(ids).toHaveLength(1);
    expect(document.getElementById(ids[0] ?? "")).toHaveTextContent(
      "Example: WINTER20",
    );
  });

  it("gives every field its own hint id when the same component renders twice", () => {
    render(
      <>
        <HintedField />
        <HintedField />
      </>,
    );

    const [first, second] = screen.getAllByLabelText("Season Name");
    expect(first?.getAttribute("aria-describedby")).toBeTruthy();
    expect(first?.getAttribute("aria-describedby")).not.toBe(
      second?.getAttribute("aria-describedby"),
    );
  });

  it("orders caller-supplied ids the same way for the .map() helper", () => {
    // Rows rendered inside a `.map()` cannot call a hook per row, so they pass a
    // deterministic id. The ordering contract must not differ between the two.
    expect(describedByFieldHint("hint-1", "view-only-reason")).toBe(
      "view-only-reason hint-1",
    );
    expect(describedByFieldHint("hint-1", false, undefined, null, "")).toBe(
      "hint-1",
    );
  });

  it("renders as muted helper text below the control", () => {
    render(<FieldHint id="h">Example: Winter 2026</FieldHint>);
    expect(screen.getByText("Example: Winter 2026").className).toContain(
      "text-muted-foreground",
    );
  });
});

/*
  The half-wiring guard. `FieldHint` requiring an `id` stops a hint existing with
  nothing to point at, but nothing in the type system stops a caller spreading
  `hintProps` onto the hint and forgetting `fieldProps` on the control: that
  compiles, renders identically, and is silently inaccessible.

  Every `useFieldHint()` call must therefore be matched by exactly one
  `.fieldProps` spread and one `.hintProps` spread. Comparing the three counts
  catches a half-wired addition without pinning a number that every future
  conversion would have to bump.
*/
function conversionSources(dir = "src"): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(process.cwd(), dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(process.cwd(), rel)).isDirectory()) {
      if (entry === "__tests__") continue;
      out.push(...conversionSources(rel));
    } else if (/\.tsx?$/.test(entry) && rel !== FIELD_HINT_MODULE) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * The primitive itself, which DEFINES all three and so cannot be counted with
 * its callers: `export function useFieldHint(` would read as a hook call with
 * no matching spreads, and the two prop bags it returns as spreads with no
 * hook.
 */
const FIELD_HINT_MODULE = "src/components/ui/field-hint.tsx";

/**
 * How many times a needle appears in the CODE under `src/`.
 *
 * COMMENTS AND STRING CONTENTS ARE STRIPPED FIRST (#3191 fix round), through the
 * tree's one stripper (`INV-SSOT-004`). Counting raw text made this contract
 * fire on PROSE: a component that explained in a comment why its `.map()` rows
 * call `describedByFieldHint` rather than the hook was counted as calling the
 * hook, so its three counts went out of balance and an accessibility-wiring
 * contract failed over a sentence. That pushed the defect into production code -
 * the component was left saying it must not spell the hook's name - which is the
 * wrong half of the tree to bend. This repository documents each defect at the
 * site it removed it from, so a raw-text scanner here misfires worst where the
 * wiring is most carefully explained.
 */
function countAcrossSrc(needle: string): number {
  return conversionSources().reduce((total, path) => {
    const text = stripCommentsAndStrings(
      readFileSync(join(process.cwd(), path), "utf8"),
    );
    return total + text.split(needle).length - 1;
  }, 0);
}

describe("FieldHint wiring contract", () => {
  it("matches every useFieldHint() with one fieldProps and one hintProps spread", () => {
    const hooks = countAcrossSrc("useFieldHint(");
    const fieldProps = countAcrossSrc(".fieldProps");
    const hintProps = countAcrossSrc(".hintProps");

    expect(hooks).toBeGreaterThan(0);
    expect(
      fieldProps,
      "a useFieldHint() whose fieldProps never reaches a control renders a hint no screen reader will announce",
    ).toBe(hooks);
    expect(
      hintProps,
      "a useFieldHint() whose hintProps never reaches a FieldHint points aria-describedby at nothing",
    ).toBe(hooks);
  });

  it("keeps the .map() sites on describedByFieldHint, counted in the same total", () => {
    // Rows inside a `.map()` cannot call the hook, so they do not appear in the
    // counts above. They are the only other way a field gets a hint, and both
    // are covered by their own render tests
    // (finance-report-mappings-panel.test.tsx, club-identity-panel.test.tsx).
    const derived = countAcrossSrc("describedByFieldHint(");
    expect(derived).toBeGreaterThan(0);
    expect(countAcrossSrc("useFieldHint(") + derived).toBeGreaterThanOrEqual(21);
  });

  it("counts code and not prose", () => {
    // THE CONTROL for the stripping above, and it has both halves. A stripper
    // that returned nothing would make every count zero and the three-way
    // comparison pass vacuously, which is the failure this repository has
    // shipped before; one that stripped nothing would put us back to counting
    // a comment ABOUT the hook as a call to it.
    const stripped = stripCommentsAndStrings(
      [
        "// this row cannot call useFieldHint() inside a .map()",
        "/* it spreads .fieldProps and .hintProps */",
        'const note = "useFieldHint() is the hook";',
        "const hint = useFieldHint();",
      ].join("\n"),
    );
    expect(stripped.split("useFieldHint(").length - 1).toBe(1);
    expect(stripped).toContain("const hint = useFieldHint();");
  });
});
