import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { stripCssComments } from "@/lib/__tests__/support/strip-comments";

// #2257 (D7/D12) — "Greyed out text as Example text looks like a field is
// already filled in."
//
// Placeholder styling is HAND-COPIED across five files. A grep-level contract is
// the only thing that keeps them in step — but an ALLOW-LIST cannot do that job:
// it re-checks the files someone already thought of and is silent about a sixth
// copy appearing somewhere new, which is the drift that actually happens. So the
// sites are DISCOVERED by scanning the tree and the discovered set is compared
// with the expected set. A new file that styles placeholders fails this test
// until it is added deliberately.
//
// NOTE ON THE STRING LITERALS BELOW. `src/**` is inside Tailwind's content glob,
// and this file lives there, so writing the retired utility out in full would
// make Tailwind emit a live rule for it — a dead rule shipped in the bundle, and
// worse, it would defeat grepping the built CSS as a drift check. The retired
// name is therefore assembled from fragments the content scanner cannot resolve
// to a class. The utilities that legitimately SHIP are written whole: they are
// generated anyway, so naming them costs nothing.

const RETIRED_PLACEHOLDER_INK = "placeholder:text-muted-" + "foreground";
const PLACEHOLDER_INK = "placeholder:text-placeholder-foreground";
const PLACEHOLDER_ITALIC = "placeholder:italic";
const SELECT_INK = "data-[placeholder]:text-placeholder-foreground";
const SELECT_ITALIC = "data-[placeholder]:italic";

/**
 * Any class string that paints placeholder text, in either the input or the
 * Radix-trigger form. Deliberately a PREFIX match, so a divergent value (a raw
 * colour, the retired muted role, some new token) is still discovered —
 * within the placeholder:text-* / data-[placeholder]:text-* utility shapes;
 * other forms (placeholder-*, placeholder:opacity-*, [&::placeholder]:*) and
 * .css files are outside this contract.
 */
const STYLES_PLACEHOLDER = /placeholder:text-|data-\[placeholder\]:text-/;

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

/** Every `.ts`/`.tsx` file under `src/`, excluding tests (this file included). */
function sourceFiles(dir = "src"): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(process.cwd(), dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(process.cwd(), rel)).isDirectory()) {
      if (entry === "__tests__") continue;
      out.push(...sourceFiles(rel));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(rel);
    }
  }
  return out;
}

/** The four real `::placeholder` sites plus the Radix trigger. */
const EXPECTED_SITES = [
  "src/components/help-widget/help-free-text-input.tsx",
  "src/components/ui/command.tsx",
  "src/components/ui/input.tsx",
  "src/components/ui/select.tsx",
  "src/components/ui/textarea.tsx",
] as const;

/** The subset that styles a real `::placeholder` (i.e. everything but Select). */
const INPUT_SITES = EXPECTED_SITES.filter(
  (path) => path !== "src/components/ui/select.tsx",
);

const discoveredSites = sourceFiles()
  .filter((path) => STYLES_PLACEHOLDER.test(source(path)))
  .sort();

describe("#2257 placeholder text never reads as content", () => {
  it("discovers exactly the known placeholder-styling sites", () => {
    // Not an allow-list re-read: the tree is scanned, so a SIXTH hand-copy in a
    // file nobody listed shows up here as an unexpected entry.
    expect(discoveredSites).toEqual([...EXPECTED_SITES]);
  });

  for (const path of INPUT_SITES) {
    it(`${path} paints placeholders with the dedicated token and italics`, () => {
      const css = source(path);
      expect(css).toContain(PLACEHOLDER_INK);
      // The italic is the load-bearing half: `--placeholder-foreground` tracks
      // `--muted-foreground`, which already sits on the WCAG 4.5:1 floor and so
      // cannot be lightened. Italics carry the "not content" signal at no
      // contrast cost.
      expect(css).toContain(PLACEHOLDER_ITALIC);
      // The muted role paints labels, captions and helper text; a placeholder
      // must not resolve through it any more, or retuning one retunes them all.
      expect(css).not.toContain(RETIRED_PLACEHOLDER_INK);
    });
  }

  it("styles the Select placeholder through data-placeholder, not the inert ::placeholder", () => {
    const css = source("src/components/ui/select.tsx");
    // The trigger is a <button>. `::placeholder` exists only on <input> and
    // <textarea>, so the utility that used to sit here styled nothing at all and
    // Select placeholders rendered in full foreground ink.
    expect(css).not.toContain(RETIRED_PLACEHOLDER_INK);
    expect(css).not.toContain(PLACEHOLDER_INK);
    expect(css).toContain(SELECT_INK);
    expect(css).toContain(SELECT_ITALIC);
  });

  it("pairs --placeholder-foreground with --muted-foreground in every scope", () => {
    const globals = source("src/app/globals.css");
    // A custom property containing `var()` is substituted on the element that
    // DECLARES it and inherits as that fixed value, so a lone `:root`
    // declaration would freeze the base palette inside `.app-theme-scope`,
    // `.website-theme` and `.dark`.
    //
    // Counting the two declarations and comparing totals is NOT enough: five of
    // each, with all five placeholder ones in the wrong blocks, would pass.
    // Assert the PAIRING instead — every muted declaration is immediately
    // followed by its placeholder twin, which can only hold inside one rule.
    const lines = stripCssComments(globals)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const mutedIndexes = lines
      .map((line, index) =>
        line.startsWith("--muted-foreground:") ? index : -1,
      )
      .filter((index) => index >= 0);

    expect(mutedIndexes.length).toBeGreaterThanOrEqual(5);
    for (const index of mutedIndexes) {
      expect(
        lines[index + 1],
        `--muted-foreground at "${lines[index]}" has no --placeholder-foreground beside it`,
      ).toMatch(/^--placeholder-foreground:/);
    }

    // Surfaced to Tailwind inline, so the utility emits
    // `var(--placeholder-foreground)` and re-resolves per scope instead of
    // baking in `:root`'s value.
    const themeIndex = lines.indexOf(
      "--color-muted-foreground: var(--muted-foreground);",
    );
    expect(themeIndex).toBeGreaterThan(-1);
    expect(lines[themeIndex + 1]).toBe(
      "--color-placeholder-foreground: var(--placeholder-foreground);",
    );
  });
});
