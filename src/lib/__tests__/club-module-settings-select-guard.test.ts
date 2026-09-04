import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { MODULE_KEYS } from "@/config/modules";
import { stripComments } from "./support/strip-comments";

// #153 / #150 / #175 guard: every read AND write of the ClubModuleSettings
// singleton must use an explicit column `select`
// (CLUB_MODULE_SETTINGS_COLUMN_SELECT in src/config/modules.ts). A bare
// findUnique/findMany/upsert/create/update has no select, so Prisma names
// EVERY schema column — including a retired-but-not-yet-dropped one (the
// former multiLodge flag was the trigger; see #139) — which breaks
// blue/green safety for the eventual DROP. upsert/create/update matter just
// as much as reads: Prisma's implicit RETURNING on a write names every
// column too (#175). This is a static source scan (rather than only
// per-call-site unit tests) so a future call site that forgets the select
// fails CI immediately instead of relying on someone remembering to add a
// matching mock assertion.
//
// #2996 added the second half: a select that IS explicit but spells the module
// vocabulary out by hand is a second copy of MODULE_KEYS (INV-SSOT-001), and
// the one that existed — setup readiness — could quietly stop being complete
// the next time a module was registered. Both halves read the same
// comment-stripped text (INV-SSOT-004): a `select:` or a module key that only
// occurs inside a comment is neither a select nor a copy.
//
// The copy is looked for in TWO places, because the first review of this guard
// (PR #3265) walked a complete duplicate past it twice. Inside a delegate call's
// arguments, where a key may be bare or quoted (`kiosk: true` / `"kiosk": true`).
// And in ANY object literal in non-test src/ whose `<key>: true` entries name
// more than the threshold — because the likeliest real copy is hoisted into a
// constant and passed as `select: MODULE_SELECT_COPY`, exactly the way the
// canonical constant is used, and a scan of call arguments alone never sees it.
//
// WHAT THE LITERAL CENSUS DOES NOT SEE, stated rather than discovered: a
// vocabulary built from a string array (`Object.fromEntries(KEYS.map(...))` —
// which is how the canonical select itself is written, and why
// src/config/modules.ts is excluded by name rather than passing by accident);
// computed or template-literal keys; a copy split across several small
// literals merged by spread; and a brace inside a string literal, which can
// mis-scope the block the entries are counted in. `: true` is required on
// purpose: it keeps the census on select-shaped objects and away from
// DEFAULT_MODULE_SETTINGS-shaped maps of mixed booleans.

const SRC_DIR = path.join(process.cwd(), "src");

// Every delegate method that projects columns — through a SELECT, or through
// the implicit RETURNING of a write. deleteMany/updateMany/count/aggregate/
// groupBy project nothing and are deliberately not scanned.
const PROJECTING_METHODS = [
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "create",
  "update",
  "upsert",
  "delete",
];

const CALL_PATTERN = new RegExp(
  `clubModuleSettings\\??\\.(?:${PROJECTING_METHODS.join("|")})\\(`,
  "g",
);

/*
  Where a NARROW read ends and a hand-maintained COPY begins.

  A caller that gates on a handful of modules may legitimately name just those
  columns — the guard must not force it to fetch every module. A caller that
  names most of the registry is not narrowing anything: it is restating
  MODULE_KEYS, and a restatement that is complete today is the one that stops
  being complete the next time a module is registered (the setup-readiness read
  this guard was extended for held every key at the time, and only because each
  module lane had remembered to add its own). So the line is a MAJORITY of the
  registry: at or below half is a narrow read; above half is a copy — including
  a stale one that has lost a key or two, which a count of "all of them" would
  wave through.

  Measured when the rule was written: ZERO literal selects on this model. Every
  call site spreads CLUB_MODULE_SETTINGS_COLUMN_SELECT (or threads it through
  the config-transfer spec), so the threshold binds nothing today and exists for
  the next copy. The structural remedy — making a literal unrepresentable — is
  not available: Prisma's `select` accepts any literal, and nothing at the type
  level tells a literal from the shared constant, so this is the policed form
  INV-SSOT-001 permits when the structural one is genuinely unavailable.
*/
const MAX_HAND_SPELLED_MODULE_KEYS = Math.floor(MODULE_KEYS.length / 2);

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(full, files);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

/** Extract the balanced-paren call-argument text starting at an opening "(". */
function extractCallArgs(source: string, openParenIndex: number): string {
  let depth = 0;
  for (let i = openParenIndex; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") {
      depth--;
      if (depth === 0) return source.slice(openParenIndex, i + 1);
    }
  }
  return source.slice(openParenIndex);
}

interface ProjectingCall {
  location: string;
  args: string;
}

/**
 * Every projecting ClubModuleSettings call under src/, with its argument text.
 * Comments are stripped BEFORE the scan and `stripComments` preserves newlines,
 * so the reported line numbers still point at the raw file.
 */
function projectingCalls(): ProjectingCall[] {
  const calls: ProjectingCall[] = [];
  for (const file of walk(SRC_DIR)) {
    const code = stripComments(fs.readFileSync(file, "utf8"));
    let match: RegExpExecArray | null;
    CALL_PATTERN.lastIndex = 0;
    while ((match = CALL_PATTERN.exec(code))) {
      const openParenIndex = match.index + match[0].length - 1;
      const line = code.slice(0, match.index).split("\n").length;
      calls.push({
        location: `${path
          .relative(process.cwd(), file)
          .replace(/\\/g, "/")}:${line}`,
        args: extractCallArgs(code, openParenIndex),
      });
    }
  }
  return calls;
}

/**
 * The module keys a call spells out as object keys — bare (`kiosk: true`,
 * `kiosk:`) or quoted (`"kiosk": true`, `'kiosk': true`). The quote is
 * optional on purpose: the first review of this guard passed a JSON-style copy
 * of all 29 keys because the bare form was the only one looked for.
 */
function handSpelledModuleKeys(args: string): string[] {
  return MODULE_KEYS.filter((key) =>
    new RegExp(`(?:^|[\\s{,])["']?${key}["']?\\s*:`).test(args),
  );
}

/** Offset of the `{` opening the innermost block that contains `index`, or -1. */
function enclosingBlockStart(code: string, index: number): number {
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    const char = code[i];
    if (char === "}") depth++;
    else if (char === "{") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/** Non-test source files under src/, minus the vocabulary's own home. */
function nonTestSourceFiles(): string[] {
  return walk(SRC_DIR).filter((file) => {
    const rel = path.relative(process.cwd(), file).replace(/\\/g, "/");
    if (rel === "src/config/modules.ts") return false;
    if (/(^|\/)__tests__\//.test(rel)) return false;
    return !/\.test\.tsx?$/.test(rel);
  });
}

interface SelectShapedLiteral {
  location: string;
  keys: string[];
}

/**
 * Every object literal in non-test src/ (excluding the registry itself) with the
 * DISTINCT module keys it names as `<key>: true`, bare or quoted, grouped by the
 * innermost enclosing `{`. Same comment-stripped text as the call scan.
 */
function selectShapedLiterals(): SelectShapedLiteral[] {
  const found: SelectShapedLiteral[] = [];
  const entryPattern = new RegExp(
    `(?:^|[\\s{,])["']?(${MODULE_KEYS.join("|")})["']?\\s*:\\s*true\\b`,
    "g",
  );
  for (const file of nonTestSourceFiles()) {
    const code = stripComments(fs.readFileSync(file, "utf8"));
    const byBlock = new Map<number, Set<string>>();
    let match: RegExpExecArray | null;
    entryPattern.lastIndex = 0;
    while ((match = entryPattern.exec(code))) {
      const start = enclosingBlockStart(code, match.index + 1);
      if (start < 0) continue;
      const keys = byBlock.get(start) ?? new Set<string>();
      keys.add(match[1]);
      byBlock.set(start, keys);
    }
    for (const [start, keys] of byBlock) {
      const line = code.slice(0, start).split("\n").length;
      found.push({
        location: `${path.relative(process.cwd(), file).replace(/\\/g, "/")}:${line}`,
        keys: [...keys],
      });
    }
  }
  return found;
}

describe("ClubModuleSettings reads use an explicit column select", () => {
  const calls = projectingCalls();

  it("still sees the surface it guards", () => {
    // If the scan finds nothing at all the guard has silently stopped covering
    // the model (moved files, renamed delegate) and would pass vacuously.
    expect(calls.length).toBeGreaterThan(0);
  });

  it("has no bare clubModuleSettings projecting call anywhere in src/", () => {
    const offenders = calls
      .filter((call) => !/\bselect\s*:/.test(call.args))
      .map((call) => call.location);
    expect(offenders).toEqual([]);
  });

  it("spells no hand-maintained copy of the module vocabulary into a call (#2996, INV-SSOT-001)", () => {
    const offenders = calls
      .map((call) => ({ ...call, keys: handSpelledModuleKeys(call.args) }))
      .filter((call) => call.keys.length > MAX_HAND_SPELLED_MODULE_KEYS)
      .map(
        (call) =>
          `${call.location} names ${call.keys.length} of the ${MODULE_KEYS.length} module keys by hand`,
      );
    expect(
      offenders,
      `INV-SSOT-001: a call naming more than ${MAX_HAND_SPELLED_MODULE_KEYS} module keys is a second copy of MODULE_KEYS. ` +
        "Spread CLUB_MODULE_SETTINGS_COLUMN_SELECT (src/config/modules.ts) or derive the projection from MODULE_KEYS instead; " +
        "a genuinely narrow read names only the modules it gates on.",
    ).toEqual([]);
  });

  it("hoists no hand-maintained copy of the module vocabulary into an object literal anywhere in non-test src/ (#2996, INV-SSOT-001)", () => {
    const literals = selectShapedLiterals();
    // The threshold binds nothing today (measured: zero select-shaped literals
    // above it), so the one thing that can be asserted about the population is
    // that the scan still reads a real tree rather than an empty one.
    expect(nonTestSourceFiles().length).toBeGreaterThan(0);
    const offenders = literals
      .filter((literal) => literal.keys.length > MAX_HAND_SPELLED_MODULE_KEYS)
      .map(
        (literal) =>
          `${literal.location} names ${literal.keys.length} of the ${MODULE_KEYS.length} module keys as \`<key>: true\``,
      );
    expect(
      offenders,
      `INV-SSOT-001: an object literal naming more than ${MAX_HAND_SPELLED_MODULE_KEYS} module keys as \`<key>: true\` is a hoisted copy of MODULE_KEYS, ` +
        "wherever it is later passed. Import CLUB_MODULE_SETTINGS_COLUMN_SELECT (src/config/modules.ts) or derive from MODULE_KEYS instead.",
    ).toEqual([]);
  });

  // The config-transfer club-settings category reads and writes the singleton
  // through generic `delegateOf(...).findUnique(...)` / `.upsert(...)`
  // helpers, so the literal model name never appears at the call site and the
  // scan above cannot see it. Guard it directly: every findUnique and upsert
  // call in that file must thread the per-spec select (only populated for
  // club-module-settings) through.
  it("config-transfer club-settings.ts threads the per-spec select through every findUnique and upsert", () => {
    const file = path.join(
      SRC_DIR,
      "lib/config-transfer/categories/club-settings.ts",
    );
    const source = stripComments(fs.readFileSync(file, "utf8"));
    const findUniqueCalls = source.match(/\.findUnique\(/g) ?? [];
    const upsertCalls = source.match(/\.upsert\(/g) ?? [];
    const selectedCalls = source.match(/select:\s*spec\.select/g) ?? [];
    expect(findUniqueCalls.length).toBeGreaterThan(0);
    expect(upsertCalls.length).toBeGreaterThan(0);
    expect(selectedCalls.length).toBe(
      findUniqueCalls.length + upsertCalls.length,
    );
  });
});
