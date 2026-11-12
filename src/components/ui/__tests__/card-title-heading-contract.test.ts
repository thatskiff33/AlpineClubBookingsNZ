import { describe, expect, it } from "vitest";
import {
  CARD_TITLE_OPEN,
  filesUnder,
  headingClassification,
  lineOf,
  read,
  SOURCE_FILES,
} from "./support/card-title-source";

/**
 * #2796 — the guard that stops "a card title has no heading semantics" being
 * discovered and hand-patched a fourth time.
 *
 * `CardTitle` renders a `<div>`, so a title only reaches a screen reader's
 * heading list (and `getByRole("heading", …)`) when a call site opts in with
 * `headingLevel`. Two things have gone wrong here before, and this file pins
 * both:
 *
 * 1. **Three different hand-rolled spellings.** `/login/enroll` (#1242) added
 *    an `sr-only <h1>`, `roster-editor.tsx` wrote `role="heading"
 *    aria-level={2}` inline, and #2779 copied that onto the pay cards. Guard
 *    one keeps the inline spelling from coming back: there is one mechanism.
 *
 * 2. **A Playwright assertion written the natural way that can never match.**
 *    #2779 was found exactly that way. Worse, the failure is silent when the
 *    assertion is a NEGATIVE one (`toHaveCount(0)`): a plain `CardTitle` makes
 *    it pass whether or not the card rendered. Guard two cross-checks every
 *    literal heading name asserted in `e2e/` against what `src/` actually
 *    renders that text as.
 *
 * Both guards are DISCOVERY-based, not allow-list based: they scan the tree, so
 * a new file is covered the day it lands.
 */

const E2E_FILES = filesUnder("e2e", /\.ts$/, false);

// ---------------------------------------------------------------------------
// Guard one: one mechanism, not three
// ---------------------------------------------------------------------------

describe("CardTitle heading semantics have exactly one spelling (#2796)", () => {
  it("no call site hand-writes role=\"heading\" / aria-level on a CardTitle", () => {
    const offenders: string[] = [];
    for (const file of SOURCE_FILES) {
      const source = read(file);
      for (const match of source.matchAll(CARD_TITLE_OPEN)) {
        const attrs = match[1] ?? "";
        if (/\brole\s*=/.test(attrs) || /\baria-level\s*=/.test(attrs)) {
          offenders.push(`${file}:${lineOf(source, match.index)}`);
        }
      }
    }

    expect(
      offenders,
      "Use <CardTitle headingLevel={n}> instead of writing role=\"heading\" " +
        "aria-level={n} by hand (#2796). The prop emits the same DOM, keeps " +
        "the level type-checked, and is what the guards in this file know " +
        "how to see. Offending sites:\n" +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("the mechanism itself is still present and still has no default level", () => {
    const card = read("src/components/ui/card.tsx");
    expect(card).toContain("headingLevel?: CardTitleHeadingLevel");
    // No default level: `headingLevel` must be destructured bare. A default
    // would silently give 167 call sites a level nobody chose, which is the
    // decision #2796 leaves with the repository owner.
    expect(card).toMatch(/\{\s*className,\s*headingLevel,\s*\.\.\.props\s*\}/);
    expect(card).toContain('role: "heading"');
  });
});

// ---------------------------------------------------------------------------
// Guard two: an e2e heading assertion must target something that IS a heading
// ---------------------------------------------------------------------------

/**
 * `getByRole("heading", { … })` calls in the e2e tree, capturing the options
 * object so a literal `name:` can be pulled out of it. Regex names
 * (`name: /…/i`) are skipped — they are matched against rendered text, which
 * this static check cannot resolve.
 */
const HEADING_ROLE_CALL = /getByRole\(\s*["']heading["']\s*,\s*\{([^}]*)\}/g;
const LITERAL_NAME = /\bname\s*:\s*"((?:[^"\\]|\\.)*)"/;

/**
 * Reduce a JSX children blob to just its literal text: drop `{/* comments *\/}`
 * and every `{expression}` (brace-matched, so nested braces survive), then drop
 * tag markup, keeping any text nested inside it.
 */
function literalText(inner: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i];
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (depth === 0) out += char;
  }
  return out
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every `<CardTitle …>…</CardTitle>` block in the tree. */
function cardTitleBlocks() {
  const blocks: Array<{
    file: string;
    line: number;
    attrs: string;
    text: string;
  }> = [];
  for (const file of SOURCE_FILES) {
    const source = read(file);
    for (const match of source.matchAll(
      /<CardTitle\b([^>]*?)>([\s\S]*?)<\/CardTitle>/g
    )) {
      blocks.push({
        file,
        line: lineOf(source, match.index),
        attrs: match[1] ?? "",
        text: literalText(match[2] ?? ""),
      });
    }
  }
  return blocks;
}

/** Text rendered by something that really is a heading to assistive tech. */
function realHeadingTexts(): Set<string> {
  const texts = new Set<string>();
  for (const file of SOURCE_FILES) {
    const source = read(file);
    // Native <h1>…<h6>.
    for (const match of source.matchAll(
      /<(h[1-6])\b([^>]*?)>([\s\S]*?)<\/\1>/g
    )) {
      texts.add(literalText(match[3] ?? ""));
    }
    // Anything carrying role="heading" — including CardTitle via headingLevel,
    // which is handled separately below, and any other div that opts in.
    for (const match of source.matchAll(
      /<(\w+)\b([^>]*\brole\s*=\s*["']heading["'][^>]*?)>([\s\S]*?)<\/\1>/g
    )) {
      texts.add(literalText(match[3] ?? ""));
    }
  }
  for (const block of cardTitleBlocks()) {
    if (headingClassification(block.attrs) === "heading") texts.add(block.text);
  }
  texts.delete("");
  return texts;
}

/**
 * Names deliberately exempted, with the reason. Empty on purpose: an entry here
 * is a claim that a heading assertion targeting a plain `CardTitle` is correct,
 * which needs an argument, not a habit.
 */
const EXEMPT_HEADING_NAMES = new Map<string, string>();

describe("e2e heading assertions target real headings (#2796)", () => {
  it("no getByRole(\"heading\") name is rendered only by a plain CardTitle", () => {
    const headingTexts = realHeadingTexts();
    const plainTitles = cardTitleBlocks().filter(
      (block) => headingClassification(block.attrs) !== "heading"
    );

    const findings: string[] = [];
    for (const file of E2E_FILES) {
      const source = read(file);
      for (const call of source.matchAll(HEADING_ROLE_CALL)) {
        const name = LITERAL_NAME.exec(call[1] ?? "")?.[1];
        if (!name) continue;
        if (EXEMPT_HEADING_NAMES.has(name)) continue;
        if (headingTexts.has(name)) continue;
        const culprits = plainTitles.filter((block) => block.text === name);
        if (culprits.length === 0) continue;
        findings.push(
          `${file}:${lineOf(source, call.index)} asserts heading "${name}", ` +
            `but the only thing rendering that text is a CardTitle with no ` +
            `heading level: ${culprits
              .map((block) => `${block.file}:${block.line}`)
              .join(", ")}`
        );
      }
    }

    expect(
      findings,
      "A CardTitle without `headingLevel` renders a plain <div>, so a " +
        "getByRole(\"heading\") locator can never match it. A positive " +
        "assertion fails; a negative one (toHaveCount(0)) passes vacuously, " +
        "whether or not the card rendered — which is worse. Give the card a " +
        "headingLevel from its page's real outline (#2796):\n" +
        findings.join("\n")
    ).toEqual([]);
  });

  it("scans a tree that actually contains the files it claims to scan", () => {
    // A discovery guard that silently discovers nothing is the failure mode
    // this repository has shipped before, so pin that both walks found work.
    expect(SOURCE_FILES.length).toBeGreaterThan(100);
    expect(E2E_FILES.length).toBeGreaterThan(20);
    expect(cardTitleBlocks().length).toBeGreaterThan(100);
    expect(
      E2E_FILES.some((file) => read(file).includes('getByRole("heading"'))
    ).toBe(true);
  });
});
