import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The one comment stripper in the tree (`INV-SSOT-004`). A census that blanks
// prose with its own copy goes falsely green when the copy under-reports, and
// this file's own docblocks quote the defect it looks for.
import { stripComments } from "./support/strip-comments";

/**
 * The bounded census behind #2981: every credential-bearing input on a page group
 * that injects administrator Raw CSS must be a `SecretInput`.
 *
 * ## Why a census and not a code review
 *
 * `SecretInput` exists because React's controlled `value={state}` pattern mirrors
 * the live value into the DOM `value` ATTRIBUTE, which a stylesheet can read one
 * character at a time. Measured in Chromium 153, Firefox 155 and WebKit 26.6 —
 * the evidence is on issue #2981 and the runtime pin is
 * `e2e/raw-css-secret-reflection.spec.ts`. The rule lives in `docs/SECURITY.md` →
 * "Secret entry on pages that carry Raw CSS".
 *
 * A browser test proves the ONE field it drives. This proves the SET: that no
 * second credential field has appeared on a Raw-CSS page wired the old way, and
 * that no new Raw-CSS page group has appeared outside the census at all. Both are
 * ways this regresses without anybody editing the fixed field.
 *
 * ## Why it is bounded
 *
 * Deliberately NOT a tree-wide scan. Ordinary text fields are not in scope (a
 * name or an email is not a secret the styling administrator is outside the trust
 * boundary for), and page groups that do not inject Raw CSS are not in scope —
 * `(public)`, `(authenticated)`, `(admin)`, `(finance)` and `(lodge)` all inject
 * `theme.appCss`, which `buildClubThemeAppCss` builds WITHOUT `rawCss`.
 *
 * This file reads source from disk, so `vitest related` cannot reach it from a
 * changed component. Run it by name when a Raw-CSS page or a credential field
 * moves.
 */

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const appDir = path.join(repoRoot, "src", "app");

/**
 * The route groups whose chrome injects Raw CSS, pinned. `WebsiteChrome` renders
 * `theme.css` (`buildClubThemeCss`, which appends `rawCss`); every other shell
 * renders `theme.appCss`, which excludes it by design.
 */
const RAW_CSS_ROUTE_GROUPS = ["(website)", "(website-dynamic)"] as const;

/**
 * Every credential-bearing input that may exist on those pages, pinned by id. A
 * new one has to be added here deliberately, which is the point: the addition is
 * where somebody decides whether it is a secret and reaches for `SecretInput`.
 */
const EXPECTED_CREDENTIAL_FIELDS = [
  {
    file: "src/app/(website-dynamic)/hut-leader-instructions/hut-leader-instructions-client.tsx",
    id: "hut-leader-pin",
    tag: "SecretInput",
  },
] as const;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      walk(full, out);
    } else if (entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

type JsxElement = { tag: string; text: string };

/**
 * Extract the opening tag of every `<input>` / `<Input>` / `<SecretInput>` in a
 * source file. Brace- and string-aware, so an `=>` inside an attribute
 * expression does not end the element early.
 */
function inputElements(source: string): JsxElement[] {
  const found: JsxElement[] = [];
  const opener = /<(input|Input|SecretInput)(?=[\s/>])/g;
  let match: RegExpExecArray | null;

  while ((match = opener.exec(source)) !== null) {
    let depth = 0;
    let quote: string | null = null;
    let index = match.index + match[0].length;

    for (; index < source.length; index++) {
      const char = source[index];
      if (quote) {
        if (char === "\\") index++;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") quote = char;
      else if (char === "{") depth++;
      else if (char === "}") depth--;
      else if (char === ">" && depth === 0) break;
    }

    found.push({
      tag: match[1],
      text: source.slice(match.index, Math.min(index + 1, source.length)),
    });
  }

  return found;
}

const CREDENTIAL_AUTOCOMPLETE = [
  "one-time-code",
  "current-password",
  "new-password",
];

/** Attribute words that mean "this holds a secret", not "this holds a name". */
const CREDENTIAL_WORD = /\b(pin|passcode|password|secret|token|api[-_ ]?key)\b/i;

/**
 * The names of the attributes written ON the element, ignoring anything inside an
 * attribute EXPRESSION. `onChange={(e) => { node.value = next }}` sets no `value`
 * attribute, and a guard that could not tell the difference would be unfixable.
 */
function topLevelAttributeNames(element: JsxElement): string[] {
  const text = element.text;
  let depth = 0;
  let quote: string | null = null;
  let outer = "";

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth++;
      continue;
    }
    if (char === "}") {
      depth--;
      continue;
    }
    if (depth === 0) outer += char;
  }

  return [...outer.matchAll(/([A-Za-z_][\w:.-]*)\s*=/g)].map((hit) => hit[1]);
}

function attributeValue(element: JsxElement, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(element.text);
  return match ? match[1] : null;
}

function isCredentialBearing(element: JsxElement): boolean {
  if (/type\s*=\s*"password"/.test(element.text)) return true;
  if (
    CREDENTIAL_AUTOCOMPLETE.some((value) =>
      element.text.includes(`autoComplete="${value}"`),
    )
  ) {
    return true;
  }
  for (const attribute of ["id", "name", "aria-label", "placeholder"]) {
    const value = attributeValue(element, attribute);
    if (value && CREDENTIAL_WORD.test(value)) return true;
  }
  return false;
}

describe("Raw-CSS pages: credential inputs must not reflect the secret (#2981)", () => {
  it("pins which route groups inject administrator Raw CSS", () => {
    const groups = fs
      .readdirSync(appDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("("))
      .filter((entry) => {
        const layout = path.join(appDir, entry.name, "layout.tsx");
        return (
          fs.existsSync(layout) &&
          fs.readFileSync(layout, "utf8").includes("WebsiteChrome")
        );
      })
      .map((entry) => entry.name)
      .sort();

    // A new Raw-CSS group must be added to RAW_CSS_ROUTE_GROUPS deliberately,
    // because the census below only looks where this list points.
    expect(groups).toEqual([...RAW_CSS_ROUTE_GROUPS].sort());
  });

  it("keeps the Raw CSS in the website chrome, which is the surface censused", () => {
    const chrome = fs.readFileSync(
      path.join(repoRoot, "src/components/website/website-chrome.tsx"),
      "utf8",
    );
    // `theme.css` is buildClubThemeCss output, which appends rawCss; `appCss` is
    // the shell build that excludes it. If this flips, the census is looking at
    // the wrong surface.
    expect(stripComments(chrome)).toContain("theme.css");
  });

  it("censuses every credential-bearing input on those pages", () => {
    const found = RAW_CSS_ROUTE_GROUPS.flatMap((group) =>
      walk(path.join(appDir, group)).flatMap((file) => {
        const source = stripComments(fs.readFileSync(file, "utf8"));
        return inputElements(source)
          .filter(isCredentialBearing)
          .map((element) => ({
            file: path.relative(repoRoot, file).split(path.sep).join("/"),
            id: attributeValue(element, "id"),
            tag: element.tag,
          }));
      }),
    );

    // Exact equality, both ways: a NEW credential field fails here until somebody
    // decides about it, and the known one failing to be found (a rename, a move)
    // fails here too rather than passing vacuously.
    expect(found).toEqual([...EXPECTED_CREDENTIAL_FIELDS]);
  });

  it("keeps SecretInput itself from passing a value into the DOM", () => {
    const source = stripComments(
      fs.readFileSync(
        path.join(repoRoot, "src/components/ui/secret-input.tsx"),
        "utf8",
      ),
    );
    const rendered = inputElements(source);
    expect(rendered).toHaveLength(1);
    // The whole guarantee: react-dom writes the `value` CONTENT ATTRIBUTE only
    // when a `value` or `defaultValue` prop is present on the element.
    const attributes = topLevelAttributeNames(rendered[0]);
    expect(attributes).not.toContain("value");
    expect(attributes).not.toContain("defaultValue");
    // Not vacuous: the element really was parsed and really does carry props.
    expect(attributes).toContain("onChange");
  });
});
