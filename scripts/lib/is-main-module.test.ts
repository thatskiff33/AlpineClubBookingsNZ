import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { blankLiterals } from "@/lib/__tests__/support/strip-comments";
import { isMainModule } from "./is-main-module.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const HELPER = "scripts/lib/is-main-module.mjs";

const TEMPORARY_DIRECTORIES: string[] = [];
afterAll(() => {
  for (const directory of TEMPORARY_DIRECTORIES) rmSync(directory, { recursive: true, force: true });
});

/** A real file at `<root>/real/gate.mjs`, and `<root>/link` a symlink to `<root>/real`. */
function linkedScript() {
  const root = mkdtempSync(path.join(tmpdir(), "is-main-module-"));
  TEMPORARY_DIRECTORIES.push(root);
  const real = path.join(root, "real");
  mkdirSync(real);
  const script = path.join(real, "gate.mjs");
  writeFileSync(script, "export const x = 1;\n", "utf8");
  writeFileSync(path.join(real, "other.mjs"), "export const y = 1;\n", "utf8");
  // `"junction"` works on Windows without elevation; elsewhere the type is ignored.
  symlinkSync(real, path.join(root, "link"), "junction");
  return { root, real, script, url: pathToFileURL(script).href };
}

describe("isMainModule (#4598)", () => {
  it("is true for the module's own path", () => {
    const { script, url } = linkedScript();
    expect(isMainModule(url, script)).toBe(true);
  });

  it("is true for a relative spelling of the same path", () => {
    const { script, url } = linkedScript();
    expect(isMainModule(url, path.relative(process.cwd(), script))).toBe(true);
  });

  it("is true when started through a symlinked directory", () => {
    // The silent-green case: Node resolves `import.meta.url` through the link
    // and hands `argv[1]` back as spelled, so an unresolved comparison decides
    // "imported, not run" and the script exits 0 having done nothing.
    const { root, url } = linkedScript();
    expect(isMainModule(url, path.join(root, "link", "gate.mjs"))).toBe(true);
  });

  it("is false for a different file", () => {
    const { real, url } = linkedScript();
    expect(isMainModule(url, path.join(real, "other.mjs"))).toBe(false);
  });

  it("is false, and does not throw, when argv[1] is missing or does not exist", () => {
    const { real, url } = linkedScript();
    expect(isMainModule(url, undefined)).toBe(false);
    expect(isMainModule(url, "")).toBe(false);
    expect(isMainModule(url, path.join(real, "no-such-file.mjs"))).toBe(false);
  });

  it("reads process.argv[1] by default", () => {
    // Under vitest argv[1] is the runner, never this test file.
    expect(isMainModule(import.meta.url)).toBe(false);
  });
});

/*
  THE CENSUS (INV-SSOT). Every "was I run directly?" check goes through
  `isMainModule`; a hand-written one is how a script ends up comparing an
  unresolved `argv[1]` against the resolved `import.meta.url` and exiting 0
  under a symlinked checkout. So, in code (comments and literals blanked), no
  file but the helper may read `process.argv[1]`, compare `import.meta.url` or
  `import.meta.filename` with `===`/`!==`, read `import.meta.main`, or compare
  `require.main` with `module`.

  Patterns run over the whole blanked file, not line by line, so a comparison a
  formatter breaks after `===` still matches. Reading argv's entry point by
  destructuring, `slice(1)` or `at(-1)` is matched too.

  Limit, stated rather than hidden: a check that captures `import.meta.url`
  into a variable first, then compares that variable with an argv entry held
  in another variable, is not matched. Every shape the tree actually used is.
*/
const HAND_WRITTEN_CHECKS = [
  /\bprocess\s*\.\s*argv\s*\[\s*1\s*\]/,
  /\bprocess\s*\.\s*argv\s*\.\s*at\s*\(\s*-?\s*1\s*\)/,
  /\bprocess\s*\.\s*argv\s*\.\s*slice\s*\(\s*1\s*[,)]/,
  /\[\s*,\s*[\w$]+[^\]]*\]\s*=\s*process\s*\.\s*argv\b/,
  /\bimport\s*\.\s*meta\s*\.\s*(?:url|filename|dirname)\s*\)?\s*[!=]==?/,
  /[!=]==?\s*(?:\w+\s*\(\s*)?import\s*\.\s*meta\s*\.\s*(?:url|filename|dirname)\b/,
  /\bimport\s*\.\s*meta\s*\.\s*main\b/,
  /\brequire\s*\.\s*main\s*[!=]==?\s*module\b|\bmodule\s*[!=]==?\s*require\s*\.\s*main\b/,
];
// Raw-text prefilter: a file naming none of these cannot match, so it is not blanked.
const PREFILTER = /argv|import\s*\.\s*meta|require\s*\.\s*main/;

/** Files that may hold a hand-written check, each with the reason. */
const ALLOWED = new Map<string, string>([[HELPER, "the helper itself"]]);

const SCANNED_EXTENSION = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const UNSCANNED_DIRECTORY = new Set([
  "node_modules",
  ".git",
  ".next",
  ".claude",
  ".artifacts",
  "coverage",
  "dist",
  "build",
  "playwright-report",
  "test-results",
  "public",
]);

function scannableFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!UNSCANNED_DIRECTORY.has(entry.name)) scannableFiles(path.join(dir, entry.name), found);
    } else if (SCANNED_EXTENSION.test(entry.name) && !entry.name.endsWith(".d.ts") && !entry.name.endsWith(".d.mts")) {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

/** `file:line: text` for every hand-written check outside {@link ALLOWED}. */
function handWrittenChecks(root: string = REPO_ROOT): { hits: string[]; scanned: number } {
  const hits: string[] = [];
  let scanned = 0;
  for (const absolute of scannableFiles(root)) {
    const file = path.relative(root, absolute).split(path.sep).join("/");
    if (ALLOWED.has(file)) continue;
    scanned += 1;
    const source = readFileSync(absolute, "utf8");
    if (!PREFILTER.test(source)) continue;
    // Whole-file, so `\s*` spans a comparison a formatter wrapped after `===`.
    const code = blankLiterals(source);
    const original = source.split("\n");
    for (const pattern of HAND_WRITTEN_CHECKS) {
      const match = pattern.exec(code);
      if (!match) continue;
      const line = code.slice(0, match.index).split("\n").length;
      hits.push(`${file}:${line}: ${original[line - 1]?.trim()}`);
    }
  }
  return { hits, scanned };
}

describe("INV-SSOT: one direct-run check (#4598)", () => {
  it("finds no hand-written process.argv[1] check outside the helper", () => {
    const { hits, scanned } = handWrittenChecks();
    // Non-vacuity: an empty walk would pass every assertion below.
    expect(scanned).toBeGreaterThan(1000);
    expect(
      hits,
      `Use \`isMainModule(import.meta.url)\` from ${HELPER} instead; it realpaths both sides so a run through a symlink still reaches main().`,
    ).toEqual([]);
  });

  it("matches every shape the tree used before #4598, and not the helper call", () => {
    const shapes = [
      "if (import.meta.url === pathToFileURL(process.argv[1] ?? \"\").href) main();",
      "const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;",
      "if (invokedPath === import.meta.url) main();",
      "if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();",
      "if (fileURLToPath(import.meta.url) === script) main();",
      "if (import.meta.filename === script) main();",
      "if (process.argv.at(1) === here) main();",
      "if (import.meta.main) main();",
      "if (require.main === module) main();",
      "if (pathToFileURL(entry).href ===\n  import.meta.url) main();",
      "const [, entry] = process.argv;",
      "const entry = process.argv.slice(1)[0];",
      "if (process.argv.at(-1) === here) main();",
      "if (import.meta.dirname === dir) main();",
    ];
    for (const shape of shapes) {
      const line = blankLiterals(shape);
      expect(HAND_WRITTEN_CHECKS.some((pattern) => pattern.test(line)), shape).toBe(true);
    }
    for (const fine of [
      "if (isMainModule(import.meta.url)) main();",
      "// compare process.argv[1] with import.meta.url",
      "const note = \"process.argv[1] === import.meta.url\";",
      "const ROOT = path.dirname(fileURLToPath(import.meta.url));",
      "const args = process.argv.slice(2);",
      "const [, , command] = process.argv;",
    ]) {
      const line = blankLiterals(fine);
      expect(HAND_WRITTEN_CHECKS.some((pattern) => pattern.test(line)), fine).toBe(false);
    }
  });
});
