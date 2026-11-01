import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { expressionAt } from "@/lib/__tests__/support/balanced-brackets";
import { blankLiterals } from "@/lib/__tests__/support/strip-comments";

/**
 * Contract for #2819 (and #2818 decision 6): on every code-backed public hero,
 * the only value that may reach an HTML sink is the stored CMS header field —
 * admin HTML, sanitised on write and again on read. The sentence each page
 * COMPOSES for the empty-or-missing-row branch interpolates club identity, which
 * is free settings text no sanitiser has ever seen, so it must stay an escaped
 * React text child.
 *
 * The rendered-DOM suites — `website-page-header-fallback-render.test.tsx` and
 * `booking-request-pages-fallback-render.test.tsx` — pin the behaviour, and on
 * four of the five pages a restored sink is caught there by the live element the
 * markup-shaped club identity would create. `/contact` is the exception, and it
 * is why this file exists: its fallback interpolates nothing, so a restored sink
 * emits DOM identical apart from the element tag, and no escaping assertion can
 * see it. Leaving that page's only protection a `tagName` check plus a
 * hand-maintained "this page interpolates identity" flag meant two innocent edits
 * could reopen the #2819 hole with the whole suite green.
 *
 * Matching is mostly on the SINK EXPRESSION — the source text after the `__html`
 * property key — rather than on a bare substring, so prose may discuss either
 * identifier. Two checks are deliberate exceptions and do match source text: the
 * composed sentence must appear in JSX CHILD position and must never appear in
 * JSX PROP position. A comment that spells out `text={fallbackHeaderText}` will
 * therefore fail this contract — write that example without the braces.
 */

const APP_ROOT = path.join(__dirname, "..");

/**
 * Every public hero that composes a fallback header. The three `(website)` pages
 * are #2819; the two `(website-dynamic)` form pages are #2818 and are included
 * because the rule the security surface doc states is one rule over all five, and
 * a contract that covered three of them would let the other two drift.
 */
const HERO_PAGES = [
  "(website)/join/page.tsx",
  "(website)/join/apply/page.tsx",
  "(website)/contact/page.tsx",
  "(website-dynamic)/booking-requests/page.tsx",
  "(website-dynamic)/school-bookings/page.tsx",
];

/**
 * The route groups the walk below covers, which is where every public hero lives.
 * `HERO_PAGES` is hand-written, and the failure mode of every hand-written list is
 * a new member nobody adds to it, so the two are reconciled by a test.
 */
const WEBSITE_ROUTE_GROUPS = ["(website)", "(website-dynamic)"];

/**
 * The local each page assigns the stored, twice-sanitised field to (or `null`).
 * An allowlist rather than a ban, so a page that acquires a second sink fails
 * here and is triaged by a human, instead of passing because its new expression
 * happened to name neither identifier.
 */
const ALLOWED_SINK_EXPRESSIONS = ["storedHeaderHtml"];

/** The local holding the composed sentence, which must never reach a sink. */
const COMPOSED_FALLBACK = "fallbackHeaderText";

/**
 * The composed sentence in JSX CHILD position — `>{fallbackHeaderText}<`, with the
 * whitespace and line breaks Prettier puts there in all five files.
 */
const CHILD_POSITION = new RegExp(`>\\s*\\{${COMPOSED_FALLBACK}\\}\\s*<`);

/**
 * The composed sentence in JSX PROP position — `text={fallbackHeaderText}`. Banned
 * outright; the assertion that uses this says why.
 */
const PROP_POSITION = new RegExp(`=\\s*\\{${COMPOSED_FALLBACK}\\}`);

/**
 * `__html` spelled in any way `sinkExpressions()` cannot read: quoted
 * (`{ "__html": x }`), computed (`{ ["__html"]: x }`), or ES2015 shorthand
 * (`{{ __html }}`, where the key is followed by `}` or `,` rather than `:`).
 */
const EXOTIC_HTML_KEY = /["'[]__html|__html\s*[,}]/;

/**
 * Every `dangerouslySetInnerHTML` ATTRIBUTE in a file. The `=` is required: one of
 * these pages names the attribute in a prose comment explaining that the fallback
 * must not use it, and that mention must not count as a sink.
 */
const SINK_ATTRIBUTES = /dangerouslySetInnerHTML\s*=/g;

async function readAppFile(relative: string) {
  return fs.readFile(path.join(APP_ROOT, relative), "utf8");
}

/**
 * Every file in the website route groups that composes a fallback header, found by
 * walking the tree rather than by trusting `HERO_PAGES`.
 *
 * `__tests__` directories are skipped: they hold no pages, and a fixture spelling
 * the declaration would otherwise fail this as a missing hero.
 */
async function findPagesComposingAFallback(): Promise<string[]> {
  const found: string[] = [];

  async function walk(relative: string) {
    const entries = await fs.readdir(path.join(APP_ROOT, relative), {
      withFileTypes: true,
    });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") {
          await walk(`${relative}/${entry.name}`);
        }
        continue;
      }
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) {
        continue;
      }

      const child = `${relative}/${entry.name}`;
      if ((await readAppFile(child)).includes(`const ${COMPOSED_FALLBACK} =`)) {
        found.push(child);
      }
    }
  }

  for (const group of WEBSITE_ROUTE_GROUPS) {
    await walk(group);
  }

  return found.sort();
}

/**
 * The source text of every HTML-sink expression in a file: what follows the
 * `__html` property key, up to the brace that closes the object literal, with
 * whitespace flattened and any trailing comma dropped so a wrapped expression
 * reads the same as a one-liner — Prettier wraps these attributes whenever the
 * class list grows, and that must not read as a new sink.
 *
 * The expression is read by the shared bracket scanner, which skips a bracket inside
 * a string, a template or a comment, so `{ __html: "}" + x }` reports the whole
 * `"}" + x` rather than stopping at the quoted brace. Sinks are found over masked
 * text, so a `__html:` named in a comment is not one. Both checks still run on
 * every expression: the ban states the rule, and the allowlist is what holds if the
 * extractor is ever fooled again. The probe test below pins the string-brace shape
 * along with the others.
 */
function sinkExpressions(source: string): string[] {
  const expressions: string[] = [];
  if (!source.includes("__html")) return expressions;
  const structure = blankLiterals(source);

  for (const match of structure.matchAll(/__html\s*:/g)) {
    const { text } = expressionAt(source, match.index + match[0].length, structure);
    expressions.push(text.trim().replace(/\s+/g, " "));
  }

  return expressions;
}

describe("public hero header HTML sink contract (#2819)", () => {
  it.each(HERO_PAGES)(
    "renders the composed fallback as a text child in %s",
    async (relative) => {
      const source = await readAppFile(relative);

      // Non-vacuity: the guard below is only worth anything while this page
      // really does compose a fallback under this name. A rename must come here
      // and be re-reasoned, not silently empty the contract.
      expect(
        source,
        `${relative} must compose its fallback into a \`${COMPOSED_FALLBACK}\` local`,
      ).toContain(`const ${COMPOSED_FALLBACK} =`);
      // Position, not presence. `{fallbackHeaderText}` as a bare substring is also
      // satisfied by `text={fallbackHeaderText}` — and handing the sentence to a
      // helper component in ANOTHER file is the one revert shape measured to evade
      // every other check here, since this scan cannot follow the value across the
      // file boundary to see what the helper does with it. So the sentence must be
      // rendered HERE, in child position, and prop position is banned outright.
      expect(
        CHILD_POSITION.test(source),
        `${relative} must render \`${COMPOSED_FALLBACK}\` as a JSX text child`,
      ).toBe(true);
      expect(
        PROP_POSITION.test(source),
        [
          `${relative} passes \`${COMPOSED_FALLBACK}\` to a JSX prop.`,
          "The composed sentence must be rendered on this page as an escaped text",
          "child. Passing it to a component puts it beyond this scan, which cannot",
          "then tell a text child from an HTML sink on the other side (#2819).",
        ].join(" "),
      ).toBe(false);
    },
  );

  it.each(HERO_PAGES)(
    "hands only the stored CMS field to an HTML sink in %s",
    async (relative) => {
      const source = await readAppFile(relative);
      const expressions = sinkExpressions(source);

      // `sinkExpressions()` keys on `__html:`, so a sink spelled any other way is
      // invisible to it, and a page that KEPT its text child while adding one would
      // satisfy every assertion below. Two checks close that. First, ban the
      // spellings outright, which gives a precise message.
      expect(
        EXOTIC_HTML_KEY.test(source),
        `${relative} spells an \`__html\` key in a form this scan cannot read — write it as \`__html: <expression>\``,
      ).toBe(false);
      // Second, and independent of how the key is spelled: every
      // `dangerouslySetInnerHTML` attribute on the page must have produced an
      // expression the scan could read. A computed key defeats the ban above but
      // not this, because the attribute is still there to be counted.
      expect(
        source.match(SINK_ATTRIBUTES)?.length ?? 0,
        `${relative} has more \`dangerouslySetInnerHTML\` attributes than this scan could read expressions for`,
      ).toBe(expressions.length);

      // Every one of these pages keeps exactly one sink, for the stored header.
      // An empty list would mean the extractor stopped seeing the page at all.
      expect(
        expressions.length,
        `${relative} names no HTML sink — has the hero markup moved?`,
      ).toBeGreaterThan(0);

      for (const expression of expressions) {
        expect(
          expression,
          [
            `${relative} hands \`${expression}\` to an HTML sink.`,
            "Only the stored, twice-sanitised PageContent header may be rendered",
            "that way; a sentence this application composes interpolates club",
            "identity that no sanitiser has seen, so it renders as an escaped",
            "text child (#2819).",
          ].join(" "),
        ).not.toContain(COMPOSED_FALLBACK);
        expect(
          ALLOWED_SINK_EXPRESSIONS,
          `${relative} introduces the unreviewed HTML sink \`${expression}\``,
        ).toContain(expression);
      }
    },
  );

  /**
   * The two checks above are `it.each(HERO_PAGES)`, so a sixth hero page that
   * composed a fallback and was simply never added to that list would skip the
   * contract entirely, with the whole suite green — the same silent-omission failure
   * the `PAGES` flag pin in the rendered-DOM suite exists to prevent. So the list is
   * reconciled with the route tree in both directions: a page the walk finds and the
   * list omits fails, and a list entry the walk no longer finds (renamed, deleted,
   * or no longer composing a fallback) fails too and must be re-reasoned here.
   */
  it("lists exactly the website pages that compose a fallback header", async () => {
    const found = await findPagesComposingAFallback();

    expect(
      found,
      "HERO_PAGES and the website route tree disagree about which pages compose a fallback header",
    ).toEqual([...HERO_PAGES].sort());
  });

  // The scan above is only protection if it really sees a restored sink, so its
  // reach is pinned here rather than assumed — the same reason the neutral-200
  // class scan in `app-theme-layout-contract.test.ts` carries a probe test. These
  // are the shapes a revert would take, including the two the rendered-DOM suite
  // cannot catch on /contact.
  it("sees a composed fallback wired into a sink, in every shape a revert takes", () => {
    const restored =
      '<p className="mt-4 max-w-2xl" dangerouslySetInnerHTML={{ __html: fallbackHeaderText }} />';
    expect(sinkExpressions(restored)).toEqual([COMPOSED_FALLBACK]);

    // Wrapped across lines, which is how Prettier formats it in these files.
    const wrapped = [
      "<div",
      '  className="mt-4"',
      "  dangerouslySetInnerHTML={{",
      "    __html: fallbackHeaderText,",
      "  }}",
      "/>",
    ].join("\n");
    expect(sinkExpressions(wrapped)).toEqual([COMPOSED_FALLBACK]);

    // Smuggled into one branch of a larger expression: reported whole, so the
    // `not.toContain` above still fires and the allowlist rejects it too.
    const coalesced =
      "<div dangerouslySetInnerHTML={{ __html: storedHeaderHtml ?? fallbackHeaderText }} />";
    expect(sinkExpressions(coalesced)[0]).toContain(COMPOSED_FALLBACK);
    expect(ALLOWED_SINK_EXPRESSIONS).not.toContain(sinkExpressions(coalesced)[0]);

    // A brace inside a string does not end the region early, so the composed
    // sentence stays visible to the ban when it follows one.
    expect(
      sinkExpressions(
        '<div dangerouslySetInnerHTML={{ __html: "}" + fallbackHeaderText }} />',
      ),
    ).toEqual(['"}" + fallbackHeaderText']);

    // The current, correct shape is accepted — otherwise the contract would fail
    // for the wrong reason and stop being evidence of anything.
    expect(
      sinkExpressions(
        '<div dangerouslySetInnerHTML={{ __html: storedHeaderHtml }} />',
      ),
    ).toEqual(["storedHeaderHtml"]);
  });

  /**
   * The three checks that do NOT go through `sinkExpressions()` get the same
   * treatment, on the shapes each exists to catch. Every string below was measured
   * against the real extractor first and found invisible to it — that is why these
   * checks were added, and this test is what keeps them honest.
   */
  it("catches the shapes the sink-expression scan cannot see", () => {
    // A helper in another file, handed the sentence: the stored sink is untouched,
    // so the scan reports a clean single allowlisted expression.
    const viaProp = "<HeroFallback text={fallbackHeaderText} />";
    expect(sinkExpressions(`<div dangerouslySetInnerHTML={{ __html: storedHeaderHtml }} />${viaProp}`)).toEqual([
      "storedHeaderHtml",
    ]);
    expect(PROP_POSITION.test(viaProp)).toBe(true);
    expect(CHILD_POSITION.test(viaProp)).toBe(false);
    // Including when the prop is named so as to look like a sink.
    expect(PROP_POSITION.test("<HeroFallback html={fallbackHeaderText} />")).toBe(
      true,
    );

    // The shape this page ships passes both, across the line break Prettier adds.
    const shipped = ["<p className='mt-4'>", "  {fallbackHeaderText}", "</p>"].join(
      "\n",
    );
    expect(CHILD_POSITION.test(shipped)).toBe(true);
    expect(PROP_POSITION.test(shipped)).toBe(false);

    // `__html` spelled so the extractor's `__html:` regex misses it. Each of these
    // returns NO expression, which is precisely why the ban and the attribute count
    // are needed rather than trusted to the loop above.
    for (const exotic of [
      '<span dangerouslySetInnerHTML={{ "__html": fallbackHeaderText }} />',
      '<span dangerouslySetInnerHTML={{ ["__html"]: fallbackHeaderText }} />',
      "<span dangerouslySetInnerHTML={{ __html }} />",
    ]) {
      expect(sinkExpressions(exotic)).toEqual([]);
      expect(EXOTIC_HTML_KEY.test(exotic)).toBe(true);
      expect(exotic.match(SINK_ATTRIBUTES)?.length ?? 0).toBe(1);
    }

    // A key assembled at runtime defeats the spelling ban — the attribute count is
    // what stops it, so pin that division of labour rather than implying the ban
    // covers everything.
    const computed =
      '<span dangerouslySetInnerHTML={{ ["__" + "html"]: fallbackHeaderText }} />';
    expect(sinkExpressions(computed)).toEqual([]);
    expect(EXOTIC_HTML_KEY.test(computed)).toBe(false);
    expect(computed.match(SINK_ATTRIBUTES)?.length ?? 0).toBe(1);

    // And the correct shape trips none of the three.
    const correct =
      '<div dangerouslySetInnerHTML={{ __html: storedHeaderHtml }} />';
    expect(EXOTIC_HTML_KEY.test(correct)).toBe(false);
    expect(correct.match(SINK_ATTRIBUTES)?.length ?? 0).toBe(
      sinkExpressions(correct).length,
    );
  });
});
