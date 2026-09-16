import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The one comment stripper in the tree (`INV-SSOT-004`). A census that blanks
// prose with its own copy goes falsely green when the copy under-reports, and
// this file's own docblocks quote the defect it looks for.
import { stripComments } from "./support/strip-comments";

/**
 * The bounded census behind #2981: every credential-bearing input rendered on a
 * surface that injects administrator Raw CSS must be a `SecretInput`.
 *
 * Rule, mechanism, browser evidence and scope: `docs/SECURITY.md` → "Secret
 * entry on pages that carry Raw CSS". Not restated here.
 *
 * ## What this proves that the browser spec cannot
 *
 * `e2e/raw-css-secret-reflection.spec.ts` proves the ONE field it drives, in a
 * real engine. This proves the SET — that no second credential field has appeared
 * on a Raw-CSS surface wired the old way, and that no new Raw-CSS SINK has
 * appeared outside the census at all. Both regress without anybody editing the
 * fixed field, which is why the sink list is derived and pinned rather than
 * assumed.
 *
 * ## Exactly what it checks, and exactly what it does not
 *
 * It is a source scanner over the surfaces `RAW_CSS_SINKS` names, plus
 * `src/components/website/**` and one level of `@/components/...` imports from
 * those surfaces' files. Within those it matches element text LITERALLY. Four
 * evasion shapes are therefore invisible to it, named rather than left to be
 * discovered:
 *
 *  1. a computed attribute — `type={kind}`, `id={FIELD_ID}`, `autoComplete={ac}`;
 *  2. a custom wrapper tag — `<PinInput>`, `<Textarea>`, `<CodeField>`: only
 *     `input` / `Input` / `SecretInput` are recognised as fields at all;
 *  3. a credential field two or more component hops away, since import-following
 *     stops after one level and does not leave `@/components`;
 *  4. a secret in a field whose attributes read as ordinary — a token typed into
 *     something labelled only "Reference", which no word list can catch.
 *
 * That is the honest boundary of a static check, and it is why the runtime pin
 * exists alongside it. What the census IS reliable for is the regression this
 * lane closed: a plainly-labelled credential field, written the ordinary way, on
 * a surface that carries Raw CSS.
 *
 * It reads source from disk, so `vitest related` cannot reach it from a changed
 * component. Run it by name when a Raw-CSS surface or a credential field moves.
 */

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const appDir = path.join(repoRoot, "src", "app");

/**
 * Every place `buildClubThemeCss()` output — the build that APPENDS the club's
 * `rawCss` — reaches a page document. Three, and the tree's own record of them is
 * `docs/SECURITY-ATTACK-SURFACE.md` → "Admin Raw CSS on the public site".
 *
 * The first cut of this census derived surfaces from route groups named
 * `(…)`, which is structurally blind to `src/app/display` (no parenthesised
 * group) and to the setup screen (not a route at all). Deriving from the SINK is
 * what makes the coverage follow the injection rather than the directory naming.
 */
const RAW_CSS_SINKS = [
  {
    file: "src/components/website/website-chrome.tsx",
    what: "the public website chrome",
    // Resolved from the tree rather than listed: every route group whose layout
    // renders WebsiteChrome.
    surfaces: "website-chrome" as const,
  },
  {
    file: "src/app/display/display-screen.tsx",
    what: "the lodge display screen",
    surfaces: ["src/app/display"],
  },
  {
    file: "src/lib/setup-in-progress-screen.ts",
    what: "the pre-setup holding screen",
    surfaces: ["src/lib/setup-in-progress-screen.ts"],
  },
];

/**
 * Every non-test source file that so much as NAMES the club-theme CSS, with why.
 * The sinks above are the subset that writes it into a document; the rest carry
 * or produce it. Pinned as a set so a NEW consumer — which might be a fourth
 * sink — fails here and has to be classified rather than appearing silently.
 */
const CLUB_THEME_CSS_REFERENCES: Record<string, string> = {
  "src/components/website/website-chrome.tsx": "SINK: injects theme.css",
  "src/app/display/display-screen.tsx": "SINK: injects layoutRender.themeCss",
  "src/lib/setup-in-progress-screen.ts": "SINK: injects themeCss into the holding screen",
  "src/app/api/display/state/route.ts": "produces themeCss for the display sink",
  "src/app/api/admin/display/preview-grant/route.ts": "produces themeCss for the display preview",
  "src/lib/setup-gate.ts": "produces themeCss for the holding-screen sink",
  "src/lib/lodge-display/layout-render.ts": "carries themeCss through to the display sink",
  "src/lib/lodge-display/layout-registry.ts": "type only: themeCss on the render input",
  "src/lib/lodge-display/css-tokens.ts": "prose only: explains what themeCss covers",
  "src/lib/club-theme-schema.ts": "defines buildClubThemeCss — the build that appends rawCss",
  "src/lib/club-theme.ts": "calls it: `css: buildClubThemeCss(values)`",
  "src/app/(admin)/admin/site-style/site-style-wizard.tsx":
    "NOT a sink: the admin editor builds the output to SHOW as text in a <pre>, never injects it — and its only reader is the Raw CSS author",
  "src/components/website-footer-shell.tsx": "prose only: which build the shell injects",
  "src/lib/family-invite-return-address.ts": "prose only: why (public) is not a Raw-CSS surface",
  "src/lib/theme/app-tokens.ts": "prose only: which build injects the .website-theme block",
};

/**
 * Every credential-bearing input that may exist on those surfaces, pinned by id.
 * A new one has to be added here deliberately, which is the point: the addition
 * is where somebody decides whether it is a secret and reaches for `SecretInput`.
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
    } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function relative(file: string): string {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

function isTestPath(file: string): boolean {
  return (
    file.includes("__tests__") ||
    file.endsWith(".test.ts") ||
    file.endsWith(".test.tsx")
  );
}

/** Route groups whose layout renders `WebsiteChrome`, resolved from the tree. */
function websiteChromeGroups(): string[] {
  return fs
    .readdirSync(appDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => {
      const layout = path.join(appDir, entry.name, "layout.tsx");
      return (
        fs.existsSync(layout) &&
        fs.readFileSync(layout, "utf8").includes("WebsiteChrome")
      );
    })
    .map((entry) => path.join("src", "app", entry.name).split(path.sep).join("/"))
    .sort();
}

/** Every source path a sink's surfaces resolve to. */
function censusedSurfaces(): string[] {
  return RAW_CSS_SINKS.flatMap((sink) =>
    sink.surfaces === "website-chrome" ? websiteChromeGroups() : sink.surfaces,
  );
}

/**
 * The files the census actually reads: everything under the censused surfaces,
 * every `src/components/website` module (rendered INTO the chrome), and one level
 * of `@/components/...` imports from any of those.
 */
function censusedFiles(): string[] {
  const seed = new Set<string>();

  for (const surface of censusedSurfaces()) {
    const full = path.join(repoRoot, surface);
    if (!fs.existsSync(full)) continue;
    if (fs.statSync(full).isDirectory()) {
      for (const file of walk(full)) seed.add(file);
    } else {
      seed.add(full);
    }
  }
  for (const file of walk(path.join(repoRoot, "src", "components", "website"))) {
    seed.add(file);
  }

  // One hop into @/components. A shared field component rendered onto a Raw-CSS
  // page is invisible to a directory walk, and that is the gap this closes.
  const imported = new Set<string>();
  for (const file of seed) {
    const source = stripComments(fs.readFileSync(file, "utf8"));
    for (const hit of source.matchAll(/from\s+"(@\/components\/[^"]+)"/g)) {
      const base = path.join(repoRoot, "src", hit[1].slice("@/".length));
      for (const candidate of [
        `${base}.tsx`,
        `${base}.ts`,
        path.join(base, "index.tsx"),
        path.join(base, "index.ts"),
      ]) {
        if (fs.existsSync(candidate)) {
          imported.add(candidate);
          break;
        }
      }
    }
  }

  return [...new Set([...seed, ...imported])].filter((file) => !isTestPath(file));
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

describe("Raw-CSS surfaces: credential inputs must not reflect the secret (#2981)", () => {
  it("pins every file that names the club-theme CSS, so a new sink cannot appear unclassified", () => {
    const referencing = walk(path.join(repoRoot, "src"))
      .filter((file) => !isTestPath(file))
      .filter((file) => {
        const source = fs.readFileSync(file, "utf8");
        return (
          source.includes("theme.css") ||
          source.includes("themeCss") ||
          source.includes("buildClubThemeCss")
        );
      })
      .map(relative)
      .sort();

    // Set equality both ways. A new consumer fails here until somebody decides
    // whether it is a fourth SINK — in which case RAW_CSS_SINKS and the surfaces
    // the census walks both have to grow.
    expect(referencing).toEqual(Object.keys(CLUB_THEME_CSS_REFERENCES).sort());
  });

  it("resolves the website chrome's surfaces from the tree", () => {
    // A new Raw-CSS route group is censused automatically, but it still has to
    // be a group whose layout renders WebsiteChrome; this pins what that is now.
    expect(websiteChromeGroups()).toEqual([
      "src/app/(website)",
      "src/app/(website-dynamic)",
    ]);
  });

  it("reaches all three sinks' surfaces, not just the parenthesised groups", () => {
    const surfaces = censusedSurfaces();
    expect(surfaces).toContain("src/app/(website)");
    expect(surfaces).toContain("src/app/(website-dynamic)");
    expect(surfaces).toContain("src/app/display");
    expect(surfaces).toContain("src/lib/setup-in-progress-screen.ts");

    // And the file list really was built from them, including the shared-component
    // hop — not vacuously empty.
    const files = censusedFiles().map(relative);
    expect(files).toContain(
      "src/app/(website-dynamic)/hut-leader-instructions/hut-leader-instructions-client.tsx",
    );
    expect(files).toContain("src/app/display/display-screen.tsx");
    expect(files).toContain("src/lib/setup-in-progress-screen.ts");
    expect(files).toContain("src/components/ui/secret-input.tsx");
  });

  it("censuses every credential-bearing input on those surfaces", () => {
    const found = censusedFiles().flatMap((file) => {
      const source = stripComments(fs.readFileSync(file, "utf8"));
      return inputElements(source)
        .filter(isCredentialBearing)
        .map((element) => ({
          file: relative(file),
          id: attributeValue(element, "id"),
          tag: element.tag,
        }));
    });

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
