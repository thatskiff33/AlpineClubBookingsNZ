// @vitest-environment jsdom

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { stripCssComments } from "./support/strip-comments";

// #2146 — printing a finance/admin report while the app is in dark mode used to
// produce a blank-looking PDF.
//
// The print block forces a light PRESENTATION (`background: white`, a dark body
// colour) but it does that by setting colour on an ANCESTOR. An inherited
// declaration always loses to one that matches the element directly, and
// `src/components/ui/card.tsx` puts `text-card-foreground` on every Card root —
// so under `.dark` the card text resolved to the near-white dark token and
// printed white-on-white. Piling further `!important` overrides onto the print
// block only chases each new offender.
//
// The contract instead is: PRINT NEVER SEES DARK MODE. Every rule that installs
// the dark palette is excluded from print media, so `:root`'s light values and
// the light `.app-theme-scope` block stand and every token — including ones set
// directly on a descendant — resolves light on paper.

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

/**
 * Return the bodies of every `@media not print { … }` block in `css`, matched by
 * brace depth so a nested rule cannot truncate the slice.
 */
function notPrintBlocks(css: string): string[] {
  const blocks: string[] = [];
  const marker = "@media not print {";
  let from = 0;

  for (;;) {
    const start = css.indexOf(marker, from);
    if (start === -1) return blocks;

    let depth = 0;
    let index = start + marker.length - 1;
    for (; index < css.length; index += 1) {
      if (css[index] === "{") depth += 1;
      if (css[index] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push(css.slice(start + marker.length, index));
    from = index;
  }
}

/** Return the body of the single `@media print { … }` block. */
function printBlock(css: string): string {
  const marker = "@media print {";
  const start = css.indexOf(marker);
  expect(start, "globals.css must keep an @media print block").toBeGreaterThan(
    -1,
  );

  let depth = 0;
  let index = start + marker.length - 1;
  for (; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return css.slice(start + marker.length, index);
}

/** Remove every `@media not print { … }` block, leaving what print media sees. */
function stripNotPrintBlocks(css: string): string {
  let remaining = css;
  for (;;) {
    const marker = "@media not print {";
    const start = remaining.indexOf(marker);
    if (start === -1) return remaining;

    let depth = 0;
    let index = start + marker.length - 1;
    for (; index < remaining.length; index += 1) {
      if (remaining[index] === "{") depth += 1;
      if (remaining[index] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    remaining = remaining.slice(0, start) + remaining.slice(index + 1);
  }
}

/**
 * Split `css` into `{ selector, body }` rules, descending through at-rule
 * wrappers (`@media`, `@layer`, `@theme`) so a nested rule is still reported
 * with its own selector.
 */
function topLevelRules(css: string): Array<{ selector: string; body: string }> {
  const rules: Array<{ selector: string; body: string }> = [];
  let cursor = 0;

  while (cursor < css.length) {
    const open = css.indexOf("{", cursor);
    if (open === -1) return rules;

    let depth = 0;
    let close = open;
    for (; close < css.length; close += 1) {
      if (css[close] === "{") depth += 1;
      if (css[close] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }

    const selector = stripCssComments(css.slice(cursor, open)).trim();
    const body = css.slice(open + 1, close);

    if (selector.startsWith("@")) {
      rules.push(...topLevelRules(body));
    } else if (selector) {
      rules.push({ selector, body });
    }
    cursor = close + 1;
  }

  return rules;
}

/**
 * True when `selector` is gated on the dark theme class.
 *
 * `:not(...)` is stripped first so an INVERSE gate (`html:not(.dark)` — the
 * kiosk light-mode remap) is not mistaken for a dark rule.
 *
 * `(` is an accepted prefix character. That matters: this project declares its
 * dark variant as `@custom-variant dark (&:is(.dark *))` (globals.css:3), so
 * every Tailwind `dark:` utility compiles to `…:is(.dark *)` — a form the
 * original `[\s,>+~]`-only prefix class skipped entirely. `:where(.dark …)` was
 * missed for the same reason.
 */
function isDarkGated(selector: string): boolean {
  const gates = selector.replaceAll(/:not\([^)]*\)/g, "");
  return /(^|[\s,>+~(])\.dark\b/.test(gates);
}

/**
 * The custom-property names declared (not merely referenced) in `rules`.
 *
 * Comments are stripped first, as `nonTokenDeclarations` does. A commented-out
 * `--foo: …` in a light block, where a real `.dark` block declares `--foo`,
 * would otherwise add `--foo` to the healed set — silently widening what a
 * print-visible dark rule is allowed to assign, with nothing on paper to heal
 * it. (The reverse direction already fails loudly: a commented-out declaration
 * in the DARK block only ever shrinks the healed set.)
 */
function declaredTokens(
  rules: Array<{ selector: string; body: string }>,
): Set<string> {
  return new Set(
    rules.flatMap(({ body }) =>
      [
        ...stripCssComments(body).matchAll(
          /(?:^|[;{\s])(--[a-z0-9-]+)\s*:/gi,
        ),
      ].map((match) =>
        match[1].toLowerCase(),
      ),
    ),
  );
}

/**
 * The tokens a `.dark`-gated rule may safely assign while staying visible to
 * print media: those that a print-visible LIGHT block declares AND a dark-gated
 * block also declares.
 *
 * Both halves matter, and the second is the one an earlier cut of this guard
 * got wrong. "Every value is a `var(--token)` therefore it self-heals" is FALSE
 * in general: `--brand-charcoal/-deep/-snow/-gold/-mist` are FIXED brand colours
 * declared once on `:root` (globals.css) and no `.dark` block ever restates
 * them, so they are byte-identical on paper. A rule such as
 * `.dark .app-theme-scope .foo { background: var(--brand-deep); }` left outside
 * `@media not print` therefore prints a near-black card — a genuine #2146
 * recurrence that a bare "is it a var()?" probe waves straight through.
 *
 * Requiring the token to appear in a dark-gated block as well is exactly the
 * "the light value stands once the dark block is excluded from print" argument,
 * expressed mechanically. Deriving both sets from the stylesheet under test
 * means the set cannot drift away from what globals.css actually declares.
 */
function lightHealedTokens(css: string): Set<string> {
  const darkTokens = declaredTokens(
    topLevelRules(css).filter(({ selector }) => isDarkGated(selector)),
  );
  // Light declarations only count if PRINT can see them — a light block hidden
  // inside `@media not print` would not stand in on paper either.
  const lightTokens = declaredTokens(
    topLevelRules(stripNotPrintBlocks(css)).filter(
      ({ selector }) => !isDarkGated(selector),
    ),
  );
  return new Set([...lightTokens].filter((token) => darkTokens.has(token)));
}

/**
 * The declarations in `body` whose value is NOT purely a reference to a token
 * in `healed` (see `lightHealedTokens`).
 *
 * A `.dark`-gated rule may stay visible to print media ONLY if every value it
 * assigns is a bare `var(--token)` for a token the light blocks genuinely
 * restate: those resolve through the light `:root` / `.app-theme-scope` blocks
 * on paper. That is exactly what lets the token-driven neutral remap stay
 * outside the `@media not print` wrapper.
 *
 * The check is "not a healed token" rather than "looks like a colour" on
 * purpose. The first cut of this test probed for `oklch()/rgb()/hsl()/#hex` and
 * therefore passed three whole classes of regression:
 *   - CSS NAMED colours (`background: black`) — black on black paper;
 *   - the newer colour functions `lab()` / `lch()` / `color()`;
 *   - a rule that assigns no colour at all, such as the `outline: none` at
 *     globals.css — colourless, but it still made the same page print
 *     differently depending on the operator's theme.
 * Requiring a healed token makes the invariant literally true instead of
 * approximately true, and it cannot be outrun by new CSS colour syntax.
 */
function nonTokenDeclarations(
  body: string,
  healed: ReadonlySet<string>,
): string[] {
  return stripCssComments(body)
    .split(";")
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration.includes(":"))
    .filter((declaration) => {
      const value = declaration
        .slice(declaration.indexOf(":") + 1)
        // A bare `var(--token)` self-heals only when the light blocks restate
        // that token. A fallback form (`var(--x, #fff)`) deliberately does NOT
        // match, so it is reported.
        .replaceAll(/var\(\s*(--[a-z0-9-]+)\s*\)/gi, (match, token: string) =>
          healed.has(token.toLowerCase()) ? "" : match,
        )
        .replaceAll("!important", "")
        .trim();
      return value !== "";
    });
}

/**
 * Selectors of every `.dark`-gated rule that print media can still see and that
 * assigns something a light `:root` cannot heal. The contract is that this is
 * empty.
 */
function printReachableDarkRules(css: string): string[] {
  const healed = lightHealedTokens(css);
  return topLevelRules(stripNotPrintBlocks(css))
    .filter(({ selector }) => isDarkGated(selector))
    .filter(({ body }) => nonTokenDeclarations(body, healed).length > 0)
    .map(({ selector }) => selector.replaceAll(/\s+/g, " "));
}

/** The shipped stylesheet's own healed-token set, for the regex unit cases. */
const HEALED_TOKENS = lightHealedTokens(source("src/app/globals.css"));

describe("#2146 print always renders the light palette", () => {
  const globals = source("src/app/globals.css");
  const screenOnly = notPrintBlocks(globals).join("\n");

  it("excludes the :root-level dark token ramp from print", () => {
    // These are the tokens the light `.app-theme-scope` block does NOT restate,
    // so nothing else would pull them back to light on paper.
    expect(screenOnly).toContain(".dark {");
    for (const declaration of [
      "--foreground: oklch(0.985 0 0)",
      "--card-foreground: oklch(0.985 0 0)",
      "--danger: oklch(0.84 0.11 27)",
      "--success: oklch(0.84 0.11 150)",
    ]) {
      expect(screenOnly).toContain(declaration);
    }
  });

  it("excludes the dark app-theme-scope token block from print", () => {
    expect(screenOnly).toContain(".dark .app-theme-scope {");
    // The specific token behind the blank PDF: Card sets `text-card-foreground`
    // directly on its own root, so this must not resolve to a near-white dark
    // ink when printing. #2187 P1 rewired it onto the generated dark substrate
    // (`--gen-card-foreground-dark`); the exclusion from print is what keeps the
    // LIGHT `--card-foreground` standing on paper.
    expect(screenOnly).toContain(
      "--card-foreground: var(--gen-card-foreground-dark,",
    );
  });

  it("no longer carries the literal dark colored-callout remap (deleted in #2188 P2)", () => {
    // The colored-callout remap was deleted in P2 once every colored surface
    // migrated onto the scale vocabulary (bg/text/border-<scale>-<step>). Its
    // literal dark oklch rules must be gone entirely — so there is nothing left
    // for the print wrapper to exclude, and the #2146 concern it addressed is void.
    // Match the callout-remap SELECTORS specifically — not the oklch values,
    // which overlap with the curated `--danger`/`--warning` dark tokens that
    // legitimately remain on `:root`/`.dark`.
    expect(globals).not.toMatch(/\.dark \.app-theme-scope :is\(\.bg-red-50/);
    expect(globals).not.toMatch(/\.dark \.app-theme-scope :is\(\.text-red-600/);
    expect(globals).not.toMatch(/\.dark \.app-theme-scope :is\(\.bg-amber-50/);
    // The remap-only tint (bg-{hue}-50 → oklch(0.29 …)) had no semantic-token
    // twin, so its disappearance is a clean signal the block is gone.
    expect(globals).not.toContain("oklch(0.29 0.05 75)");
  });

  it("leaves NO dark-gated rule reachable from print media", () => {
    // The real invariant, and the one a future dark-mode rule can regress.
    //
    // Deliberately not limited to colour declarations. A `.dark`-gated rule may
    // stay visible to print ONLY if every value it assigns is a `var(--token)`
    // that the light `:root` heals; anything else — a literal colour in ANY
    // syntax, or a colourless declaration such as `outline: none` — makes the
    // same page print differently depending on the operator's theme, so it
    // belongs in `@media not print`.
    //
    // `html:not(.dark)` is the INVERSE gate (the kiosk light-mode remap), so it
    // is not a dark-palette rule and is skipped.
    const offenders = printReachableDarkRules(globals);

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `These .dark-gated rules are still visible to print media and assign ` +
            `a value the light :root cannot heal. Wrap each in ` +
            `@media not print, or express its value as a var(--token). ` +
            `Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("no longer carries the token-driven neutral remap outside the wrapper (deleted in #2188 P2)", () => {
    // The unwrapped `.dark .app-theme-scope` neutral remap (bg-white/slate →
    // --card/--muted/--foreground, self-healing) was deleted in P2 once every
    // tree used the shadcn role tokens at source. The surviving `.dark
    // .app-theme-scope` rules — P1's F1 core-token block and the A6 card shadow —
    // are all wrapped in `@media not print`, so after `stripNotPrintBlocks` there
    // are NO top-level dark-gated rules left. The sibling "leaves NO dark-gated
    // rule reachable from print" test is the real, surviving invariant.
    expect(globals).not.toMatch(/\.dark\s+\.app-theme-scope\s+:is\(\s*\.bg-white/);
    const topLevelDark = topLevelRules(stripNotPrintBlocks(globals)).filter(
      ({ selector }) => isDarkGated(selector),
    );
    expect(topLevelDark).toEqual([]);
  });

  it("pins color-scheme light in print so the UA cannot repaint it dark", () => {
    // next-themes writes `color-scheme` as an INLINE style on <html> when
    // `enableColorScheme` is set, and an inline style outranks any non-important
    // rule — hence the single deliberate `!important` here.
    expect(printBlock(globals)).toMatch(
      /:root\s*\{\s*color-scheme:\s*light\s*!important;\s*\}/,
    );
  });

  it("keeps the report print roots and cards on the print block", () => {
    const print = printBlock(globals);
    expect(print).toContain(".reports-print-root");
    expect(print).toContain(".reports-print-card");
    expect(print).toContain(".lodge-instructions-print-root");
  });
});

// The guard above is only as good as the two regexes it rests on, and both had
// a silent false negative. These cases pin the fixes with synthetic CSS so a
// future "tidy-up" of either regex fails loudly instead of quietly re-opening
// the hole.
describe("#2146 the print-reachability guard has no blind spots", () => {
  it("recognises the functional :is(.dark *) / :where(.dark) gate forms", () => {
    // globals.css declares `@custom-variant dark (&:is(.dark *))`, so the gate
    // routinely appears after a `(` rather than after whitespace/a combinator.
    // The original `[\s,>+~]`-only prefix class matched such a selector ONLY by
    // accident, when the compiled class name itself happened to start with
    // `.dark…` (`.dark\:bg-red-400:is(.dark *)`). Any other subject — a
    // hand-written rule, a stacked variant, an `@apply`-derived class — slipped
    // straight through. These three are all false under the old regex:
    expect(isDarkGated(".reports-print-card:is(.dark *)")).toBe(true);
    expect(isDarkGated(":where(.dark) .reports-print-card")).toBe(true);
    expect(isDarkGated(".group:hover .stat-value:is(.dark *)")).toBe(true);
    // …and the plain descendant form still matches.
    expect(isDarkGated(".dark .app-theme-scope .foo")).toBe(true);
  });

  it("still ignores the inverse html:not(.dark) gate", () => {
    // The kiosk light-mode remap is not a dark-palette rule.
    expect(isDarkGated("html:not(.dark) .kiosk-shell .bg-slate-900")).toBe(
      false,
    );
    expect(isDarkGated(".app-theme-scope .bg-card")).toBe(false);
  });

  it("flags CSS named colours, lab()/color(), and colourless declarations", () => {
    // Each of these passed the original `oklch|rgb|hsl|#hex` colour probe.
    const missedByTheOldProbe = [
      "background: black;", // a named colour — black ink on black paper
      "color: lab(20% 40 59);", // newer colour syntax
      "background-color: color(display-p3 0.1 0.1 0.1);",
      "outline: none;", // no colour at all, but still theme-dependent print
      "background: var(--card, #0b0b0b);", // fallback form is not a bare token
    ];
    for (const declaration of missedByTheOldProbe) {
      expect(
        nonTokenDeclarations(declaration, HEALED_TOKENS),
        `"${declaration}" must be reported as un-healable`,
      ).toHaveLength(1);
    }
  });

  it("passes a rule whose every value is a bare healed var(--token)", () => {
    expect(
      nonTokenDeclarations(
        "background-color: var(--card); color: var(--foreground);",
        HEALED_TOKENS,
      ),
    ).toEqual([]);
  });

  it("derives the healed set from the light blocks, so --brand-* is NOT healed", () => {
    // The `var()` shape alone is not the invariant. `--brand-charcoal/-deep/
    // -snow/-gold/-mist` are FIXED brand colours declared once on `:root`, and
    // no `.dark` block restates them, so they print byte-identical to their
    // dark-mode appearance. A "is it a var()?" probe reported these as clean;
    // they are the same near-black card / near-white ink as #2146 itself.
    for (const declaration of [
      "background: var(--brand-deep);",
      "color: var(--brand-snow);",
      "background-color: var(--brand-charcoal);",
    ]) {
      expect(
        nonTokenDeclarations(declaration, HEALED_TOKENS),
        `"${declaration}" is a fixed brand colour, not a light/dark pair, so ` +
          `it must be reported as un-healable`,
      ).toHaveLength(1);
    }

    // Sanity: the derivation really is reading globals.css, not returning
    // everything or nothing.
    expect(HEALED_TOKENS.has("--card-foreground")).toBe(true);
    expect(HEALED_TOKENS.has("--muted-foreground")).toBe(true);
    expect(HEALED_TOKENS.has("--brand-deep")).toBe(false);
    expect(HEALED_TOKENS.has("--brand-snow")).toBe(false);
  });

  it("catches a regression the shipped CSS does not contain", () => {
    // End-to-end proof on synthetic CSS: an unwrapped Tailwind-shaped dark
    // utility, an unwrapped colourless dark rule, and an unwrapped fixed-brand
    // token rule are all reported, while the same rules inside
    // `@media not print` are not. The `:root`/`.dark` pair at the top is what
    // makes `--foreground` healed and `--brand-deep` not.
    const leaky = `
      :root { --foreground: oklch(0.145 0 0); --brand-deep: #17231c; }
      .dark\\:bg-slate-900:is(.dark *) { background-color: oklch(0.2 0 0); }
      .dark .app-theme-scope .foo { background: black; }
      .dark .app-theme-scope .bar { outline: none; }
      .dark .app-theme-scope .brand { background: var(--brand-deep); }
      .dark .app-theme-scope .ok { color: var(--foreground); }
    `;
    const wrapped = `:root { --foreground: oklch(0.145 0 0); }
      @media not print { .dark { --foreground: oklch(0.985 0 0); } }`;
    expect(printReachableDarkRules(`${wrapped}${leaky}`)).toHaveLength(4);
    expect(
      printReachableDarkRules(`${wrapped}@media not print {${leaky}}`),
    ).toEqual([]);
  });
});

// FIX for the gap the CSS-only guard cannot see. `globals.css` is not the whole
// stylesheet: every `dark:` utility written in a class string — in TSX markup or
// in a plain `.ts` module that exports class names — compiles into TAILWIND'S
// generated output, never into globals.css, so no `@media not print` wrapper in
// this repo can ever reach it. A `dark:bg-slate-900` added to a report card
// would therefore reintroduce #2146 with every CSS assertion above still green.
//
// A `dark:` utility is only a hazard when it carries a LITERAL palette colour —
// a named shade (`dark:bg-slate-900`) or an arbitrary one (`dark:bg-[#0b1220]`).
// Token-driven ones (`dark:bg-input/30`, `dark:checked:bg-primary`,
// `dark:bg-warning-muted`, `dark:bg-[var(--card)]`) compile to `var(--token)`
// and self-heal on paper for exactly the same reason the neutral remap does, so
// they are not matched.
const TAILWIND_PALETTE_FAMILIES = [
  "slate",
  "gray",
  "zinc",
  "neutral",
  "stone",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
].join("|");

const LITERAL_PALETTE_DARK_UTILITY = new RegExp(
  // `dark:` plus any further stacked variants. A variant segment is one of:
  //   - a bare word, OPTIONALLY carrying a functional bracket
  //     (`hover`, `focus`, `md`, but also `data-[state=open]`, `has-[:checked]`,
  //     `supports-[backdrop-filter]`, `aria-[sort=asc]`, `group-[.open]`);
  //   - the `*:` / `**:` descendant variants;
  //   - a bare arbitrary variant (`[&>tr]`).
  // The word-then-bracket case is the one two earlier cuts of this regex both
  // missed: the alternation matched a bare word OR a bare bracket but never a
  // word FOLLOWED BY one, so every `dark:data-[…]:` form walked through. That is
  // not hypothetical — `src/components/ui` is a printable root and carries 78
  // `data-[…=` occurrences across 8 files, so adding `dark:` to any one of them
  // would have reopened #2146 with this whole suite green.
  String.raw`\bdark:(?:(?:[a-z-]+(?:\[[^\]\s]*\])?|\*{1,2}|\[[^\]\s]*\]):)*` +
    // the colour-bearing utility prefixes
    String.raw`(?:text|bg|border|ring|shadow|from|to|via|outline|decoration|divide|fill|stroke|accent|caret)-` +
    String.raw`(?:` +
    // a LITERAL value: a palette family + numeric shade, or black/white
    String.raw`(?:(?:${TAILWIND_PALETTE_FAMILIES})-\d{2,3}|black|white)\b` +
    // …or an ARBITRARY literal colour: `dark:bg-[#0b1220]`,
    // `dark:text-[rgb(2,6,23)]`, `dark:bg-[oklch(0.2_0_0)]`. These are exactly
    // as hazardous as a named shade and were previously invisible.
    //
    // The colour test is a LOOKAHEAD for a colour-ish token ANYWHERE inside the
    // brackets, not an anchored list of function names. The anchored form only
    // recognised a value that STARTED with a known colour function, so a nested
    // or newer one — `dark:bg-[color-mix(in_oklch,black,white)]`,
    // `dark:bg-[theme(colors.slate.900)]`, `dark:bg-[light-dark(white,black)]` —
    // slipped past while being every bit as literal.
    //
    // `dark:bg-[var(--card)]` still does NOT match, and must not: it resolves
    // through the light token on paper, like every other token-driven variant.
    // Nor do non-colour arbitrary values on a colour-bearing prefix
    // (`dark:text-[14px]`, `dark:shadow-[0_0_0_1px_var(--ring)]`), which is why
    // this stays a colour-token lookahead rather than "any `[…]`".
    String.raw`|\[(?=[^\]\s]*(?:#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color|color-mix|light-dark|theme)\())[^\]\s]*\]` +
    // …and a bare named colour as the whole arbitrary value (`dark:bg-[black]`).
    // Matched only as the ENTIRE value: a loose `\bwhite\b` would also fire
    // inside `var(--brand-white)`, which is token-driven and legitimate.
    String.raw`|\[(?:black|white)\]` +
    String.raw`)`,
  "g",
);

/**
 * Recursively collect the class-string-bearing source files under `path`,
 * skipping `__tests__`. `path` may be a directory or a single file.
 *
 * `.ts` is scanned as well as `.tsx`: Tailwind reads class names from any
 * source file, and this repo already keeps palette class strings in plain `.ts`
 * modules (`bed-allocation/_components/booking-accent.ts` holds nine
 * `dark:ring-<family>-800/60` strings). A `.tsx`-only scan claimed to guard
 * against new and stale entries while being structurally blind to that whole
 * file shape — extracting chart accents into a `.ts` module inside a printable
 * tree would have reopened #2146 with every assertion here still green.
 */
function listComponentFiles(path: string): string[] {
  const root = join(process.cwd(), path);
  if (!existsSync(root)) {
    throw new Error(
      `print-light-palette-contract: source root "${path}" does not exist. ` +
        `If the tree was renamed, update PRINTABLE_SURFACE_ROOTS.`,
    );
  }
  const isScannable = (entry: string) =>
    entry.endsWith(".tsx") ||
    (entry.endsWith(".ts") && !entry.endsWith(".d.ts"));

  if (!statSync(root).isDirectory()) {
    return isScannable(path) ? [path.replaceAll("\\", "/")] : [];
  }
  return readdirSync(root).flatMap((entry) => {
    const child = join(path, entry);
    if (statSync(join(process.cwd(), child)).isDirectory()) {
      return child.replaceAll("\\", "/").includes("/__tests__")
        ? []
        : listComponentFiles(child);
    }
    return isScannable(entry) ? [child.replaceAll("\\", "/")] : [];
  });
}

// Every tree whose markup can end up on paper, taken from the print roots in
// `globals.css` (`.reports-print-root`, `.reports-print-card`,
// `.lodge-instructions-print-root`) and the `window.print()` callers:
//
// - `/finance`               → (finance)/finance/layout.tsx (`reports-print-root`)
//                              + components/finance (kpi-stat-card is a print card)
// - `/admin/reports`         → admin/reports/page.tsx
// - `/admin/roster/[date]/print`
// - `/admin/induction/[id]/print`
// - `/lodge-instructions`
// - `/hut-leader-instructions` (website-theme; never gets `.dark` — see below)
// - `components/ui`          → shared primitives that render INSIDE all of the
//                              above. `ui/card.tsx` is where #2146 actually
//                              originated, so this root is not optional.
//
// The last two entries are individual shared components that render on a
// printable page without living in one of the trees above. They are NOT
// equivalent to each other:
//
// (The retired `contextual-help-button.tsx` used to be listed here as the one
// belt-and-braces case — it carried `print:hidden` itself. Epic #2094 C2
// replaced it and `booking-help-dialog.tsx` with the global help widget, whose
// launcher and panel both carry `print:hidden`; those live under
// `src/components/help-widget/`, are token-pure, and never print, so they need
// no entry here.)
//
// - `date-range-controls.tsx` — LOAD-BEARING, do not prune. `/admin/reports`
//   renders it at page.tsx:334, which is OUTSIDE the `.reports-print-root` div
//   at page.tsx:396 but still on the printed document, and it has no
//   `print:hidden`. The print block hides its `<select>` and
//   `input[type="date"]` by element type (globals.css:~1301) — but NOT the
//   `<Label>` elements it renders (date-range-controls.tsx:56,73,85), which
//   print. A literal `dark:` colour on one of those labels would print exactly
//   as written.
// - `lodge-select.tsx` — LOAD-BEARING for the same reason, though one step
//   further out. `LodgeSelect` renders a `<Label>` (lodge-select.tsx:60) that no
//   element rule hides, on admin pages including `admin/roster/page.tsx:484` —
//   inside the already-printable `admin/roster` tree. (Note `/admin/reports`
//   imports only `useLodgeOptions` from this module (page.tsx:9), which renders
//   no markup; the `LodgeSelect` component itself is not used there, and the
//   `roster/[date]/print` route takes its lodge from the URL rather than the
//   picker. So no print root renders it *today* — but it is a shared picker one
//   report screen away from doing so, and the cost of listing it is nil.)
//
// Listing them here rather than leaning on the census is deliberate: the
// census's only remedy is `NON_PRINTABLE_DARK_UTILITY_FILES`, and adding either
// of these two to that list would be a false claim — each renders visible markup
// on a page an operator can print.
const PRINTABLE_SURFACE_ROOTS = [
  "src/app/(finance)",
  "src/components/finance",
  "src/app/(admin)/admin/reports",
  "src/app/(admin)/admin/roster",
  "src/app/(admin)/admin/induction",
  "src/app/(authenticated)/lodge-instructions",
  "src/app/(website-dynamic)/hut-leader-instructions",
  "src/components/ui",
  "src/components/admin/date-range-controls.tsx",
  "src/components/lodge-select.tsx",
];

// Intentionally EMPTY, like `THEMED_NEUTRAL_ALLOWLIST` in
// `brand-color-source-contract.test.ts`. It exists so a future exception is a
// reviewable one-line addition with a stated reason rather than a quiet
// narrowing of the check. There is no legitimate reason to add one: a printable
// surface has no dark presentation to preserve.
const PRINTABLE_SURFACE_DARK_ALLOWLIST = new Set<string>([]);

// The files OUTSIDE the printable roots that carry a literal-palette `dark:`
// utility today, enumerated rather than assumed. Each is unreachable from print:
//
// - `components/nav-bar.tsx` — renders on `/finance` and every admin page, but
//   its root `<header>` carries `print:hidden` (nav-bar.tsx:102) and the print
//   block also hides `nav`/`aside` outright, so the sign-out item's
//   `dark:text-red-400` never reaches paper.
// - `book/_components/guests-step.tsx` — the booking wizard. No print root, no
//   `window.print()` caller, and it is not rendered by any printable route.
// - `admin/members/_components/member-bulk-membership-dialog.tsx` — a modal
//   preview on `/admin/members`; dialogs are not printed.
// - `admin/display/{builder,templates,layouts}` — the lobby-display authoring
//   screens. The display itself is a screen medium and these editors have no
//   print affordance.
// - `admin/bed-allocation/_components/booking-accent.ts` — the nine
//   `dark:ring-<family>-800/60` chip accents for the bed-allocation board. That
//   board is a drag-and-drop screen tool: the tree carries no print root, no
//   `window.print()` caller, and the module is imported only by
//   `allocation-chip` / `bucket-board` / `guest-chip` inside it. It is also the
//   file that proved the scan had to cover `.ts`, not just `.tsx`.
//
// This list is a DRIFT GUARD, not permission: adding a file here is a claim that
// the file can never render inside a print root, and must be justified.
// #2188 P2 emptied this list: the colored surface migration dropped every
// `dark:` colour compensator (the target scale/role tokens auto-adapt per mode),
// so no source file carries a literal-palette `dark:` utility any more. The
// enumeration guard below (`stale`) keeps it honest — a new carrier must be
// justified and re-added.
const NON_PRINTABLE_DARK_UTILITY_FILES = new Set(
  ([] as string[]).map((path) => path.replaceAll("\\", "/")),
);

describe("#2146 no literal-palette dark: utility on a printable surface", () => {
  it("keeps every printable surface free of literal dark: colours", () => {
    const offenders = PRINTABLE_SURFACE_ROOTS.flatMap(listComponentFiles)
      .filter((path) => !PRINTABLE_SURFACE_DARK_ALLOWLIST.has(path))
      .flatMap((path) => {
        const matches =
          readFileSync(join(process.cwd(), path), "utf8").match(
            LITERAL_PALETTE_DARK_UTILITY,
          ) ?? [];
        return [...new Set(matches)].map((match) => `${path}: ${match}`);
      });

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `A \`dark:\` utility carrying a LITERAL palette colour is compiled ` +
            `into Tailwind's own output, NOT globals.css, so the ` +
            `@media not print wrappers there cannot exclude it — it prints ` +
            `exactly as written and reintroduces #2146. On a printable ` +
            `surface, either drop the dark: variant or move the colour onto a ` +
            `semantic token (bg-card / text-muted-foreground / a ` +
            `pairs), which resolves light on paper. Offenders:\n` +
            `${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("matches the arbitrary-value and variant-prefix dark: forms", () => {
    // Every one of these returned `null` from the first cut of the regex, and
    // each is the #2146 bug verbatim: a hard-coded near-black surface (or
    // near-white ink) that prints exactly as written.
    const previouslyEvading = [
      "dark:bg-[#0b1220]",
      "dark:text-[rgb(2,6,23)]",
      "dark:bg-[rgba(2,6,23,0.9)]",
      "dark:bg-[hsl(222,47%,11%)]",
      "dark:bg-[oklch(0.2_0_0)]",
      "dark:text-[lab(20%_40_59)]",
      "dark:bg-[color(display-p3_0.1_0.1_0.1)]",
      "dark:*:bg-slate-900",
      "dark:**:text-white",
      "dark:[&>tr]:bg-slate-900",
      "dark:hover:bg-[#0b1220]",
      // FUNCTIONAL-BRACKET variants: a word followed by a bracket. The
      // alternation used to accept a bare word OR a bare bracket but never a
      // word carrying one, so this entire family evaded the check — including
      // `data-[…]`, which `src/components/ui` (a printable root, and the tree
      // #2146 originated in) uses 78 times.
      "dark:data-[state=open]:bg-slate-900",
      "dark:has-[:checked]:bg-slate-900",
      "dark:supports-[backdrop-filter]:bg-slate-900",
      "dark:aria-[sort=asc]:text-white",
      "dark:group-[.open]:bg-slate-900",
      "dark:data-[state=checked]:bg-[#0b1220]",
      // ARBITRARY VALUES whose colour function is nested or simply was not on
      // the enumerated list. The old branch required the value to START with a
      // known colour function, so these read as token-driven and were allowed.
      "dark:bg-[color-mix(in_oklch,black,white)]",
      "dark:bg-[theme(colors.slate.900)]",
      "dark:bg-[light-dark(white,black)]",
      "dark:bg-[black]",
    ];
    for (const utility of previouslyEvading) {
      expect(
        `class="rounded ${utility} p-2"`.match(LITERAL_PALETTE_DARK_UTILITY),
        `"${utility}" is a literal dark colour and must be caught`,
      ).not.toBeNull();
    }

    // …while token-driven variants — including arbitrary values that reach a
    // token — stay allowed, because they resolve light on paper.
    const stillAllowed = [
      "dark:bg-input/30",
      "dark:checked:bg-primary",
      "dark:bg-warning-muted",
      "dark:bg-[var(--card)]",
      "dark:text-[var(--foreground)]",
      "dark:*:bg-card",
      // The widened branches must not over-reach. A functional-bracket variant
      // is only an offender when its UTILITY carries a literal colour…
      "dark:data-[state=open]:bg-card",
      "dark:has-[:checked]:text-muted-foreground",
      // …and an arbitrary value on a colour-bearing prefix is not automatically
      // a colour. `--brand-white` in particular must stay allowed: it is a
      // token reference, not the named colour `white`.
      "dark:text-[14px]",
      "dark:border-[2px]",
      "dark:shadow-[0_0_0_1px_var(--ring)]",
      "dark:bg-[var(--brand-white)]",
    ];
    for (const utility of stillAllowed) {
      expect(
        `class="rounded ${utility} p-2"`.match(LITERAL_PALETTE_DARK_UTILITY),
        `"${utility}" is token-driven and must NOT be reported`,
      ).toBeNull();
    }
  });

  it("holds the known non-printable carriers to their enumerated list", () => {
    // `String.match` with a /g/ regex is used rather than `RegExp.test`: `test`
    // advances `lastIndex` on a global regex and would skip every other file.
    const carriers = listComponentFiles("src").filter(
      (path) =>
        readFileSync(join(process.cwd(), path), "utf8").match(
          LITERAL_PALETTE_DARK_UTILITY,
        ) !== null,
    );

    const unexpected = carriers.filter(
      (path) => !NON_PRINTABLE_DARK_UTILITY_FILES.has(path),
    );
    expect(
      unexpected,
      unexpected.length === 0
        ? ""
        : `New file(s) carry a literal-palette \`dark:\` utility (see #2146). ` +
            `Decide which of these two applies to each — the allowlist is NOT ` +
            `the default remedy:\n` +
            `  - It CAN render inside a print root (directly, or as a shared ` +
            `component used by one): drop the dark: variant or move the colour ` +
            `onto a semantic or categorical scale token, and add its path to ` +
            `PRINTABLE_SURFACE_ROOTS so the stricter check covers it from now ` +
            `on.\n` +
            `  - It can NEVER render inside a print root: add it to ` +
            `NON_PRINTABLE_DARK_UTILITY_FILES with the reason that makes that ` +
            `true (no print root in its tree, no window.print() caller, not ` +
            `reachable from a printable route).\n` +
            `${unexpected.join("\n")}`,
    ).toEqual([]);

    // Stale entries are as bad as missing ones: they make the list read as
    // permission for files that no longer exist.
    const stale = [...NON_PRINTABLE_DARK_UTILITY_FILES].filter(
      (path) => !carriers.includes(path),
    );
    expect(stale, `Remove these stale entries:\n${stale.join("\n")}`).toEqual(
      [],
    );
  });
});

// COVERAGE LIMIT, stated plainly because the Download PDF button is the one
// operators actually press and was the second half of #2146: these two cases
// are the ONLY automated coverage of that path, and neither runs html2canvas.
// The first asserts `forceLightPaletteInClone`'s DOM mutation on a hand-built
// jsdom document; the second asserts the hook is still wired in the source.
// Nothing here proves html2canvas honours `onclone` as assumed, and nothing
// inspects a produced PDF — `e2e/print-dark-mode.spec.ts` does not help either,
// because `emulateMedia` switches the print medium without touching
// html2canvas. Changing this path warrants a manual export in both themes.
describe("#2146 the html2canvas PDF capture renders light", () => {
  it("strips the dark theme from the cloned capture document", async () => {
    const { forceLightPaletteInClone } = await import("@/lib/report-pdf");

    const doc = document.implementation.createHTMLDocument("capture");
    doc.documentElement.classList.add("dark");
    doc.documentElement.style.colorScheme = "dark";
    const nested = doc.createElement("div");
    nested.className = "dark nested-scope";
    doc.body.append(nested);

    forceLightPaletteInClone(doc);

    expect(doc.documentElement.classList.contains("dark")).toBe(false);
    expect(doc.documentElement.style.colorScheme).toBe("light");
    expect(nested.classList.contains("dark")).toBe(false);
    // Only the theme class is removed; unrelated classes survive.
    expect(nested.classList.contains("nested-scope")).toBe(true);
  }, 20_000);

  it("wires the light-palette clone into the html2canvas capture", () => {
    // The capture is composited onto a hard-coded white page, so a dark-mode
    // capture would be near-white ink on white — the same blank report the print
    // path produced. Asserted on the source because driving html2canvas itself
    // needs a real layout engine.
    const pdf = source("src/lib/report-pdf.ts");
    expect(pdf).toContain('backgroundColor: "#ffffff"');
    expect(pdf).toContain("onclone: forceLightPaletteInClone");
  });
});
