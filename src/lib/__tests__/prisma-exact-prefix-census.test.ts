import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { expressionAt } from "@/lib/__tests__/support/balanced-brackets";
import { blankLiterals, stripComments } from "@/lib/__tests__/support/strip-comments";

/**
 * #4146 (`INV-SSOT-006`): every Prisma `startsWith` or `contains` whose operand carries an id
 * or user input goes through `exactPrefix` or `exactContains`.
 *
 * Prisma sends `startsWith: p` as SQL `LIKE p || '%'` without escaping `p`, so
 * a `_` or `%` in a prefix built from an id, or typed by a person, is a
 * wildcard. This reads `src/` from disk (comments stripped) and judges the
 * value of every `startsWith:` and `contains:` property. Allowed bare: a string literal, or an
 * UPPER_SNAKE constant. Anything else (a template literal, a `build…(` call, a
 * variable) must be written `field: exactPrefix(p)` instead, or appear in
 * `ALLOWED` below with the reason its value can carry neither.
 *
 * BLIND SPOTS. It judges the expression's spelling, not its value: a
 * lower-case alias of a constant is listed, and an UPPER_SNAKE name bound to a
 * computed string would pass. `prisma-exact-prefix.ts` itself is the one file
 * not read: it spells the escaped operands the rest must not.
 */
const REPO_ROOT = resolve(__dirname, "../../..");
const SRC = join(REPO_ROOT, "src");
const HELPER = "src/lib/prisma-exact-prefix.ts";

/** `file|value` -> why that value never carries an id or user input. */
const ALLOWED: Record<string, string> = {
  "src/lib/manual-refund-task-settlement-rules.ts|prefix":
    "iterates NON_CANCELLATION_HAND_BACK_KEY_PREFIXES, a list of three constants",
  "src/lib/edit-financial-review-cancel-netting.ts|buildEditFinancialReviewRefundRecoveryIdempotencyKey(\"\")":
    "built with an empty task id, so it is the constant family prefix",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" || entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** The value expression after a `startsWith:` at `from`, up to its first `,`, `}` or `)` at depth 0. */
function valueAt(source: string, from: number, structure?: string): string {
  return expressionAt(source, from, structure).text.replace(/\s+/g, " ").trim();
}

function bareValueAllowed(value: string): boolean {
  return /^(["'])(?:(?!\1)[^\\]|\\.)*\1$/.test(value) || /^[A-Z][A-Z0-9_]*$/.test(value);
}

/** Run the same scanner on production files and synthetic regression fixtures. */
function inspectSource(source: string): string[] {
  const values: string[] = [];
  const code = stripComments(source);
  const structure = /startsWith|contains/.test(code) ? blankLiterals(code) : code;
  // Shorthand and computed keys cannot establish a literal operand.
  for (const match of code.matchAll(/(?:\{|,)\s*(?:startsWith|contains)\s*[,}]|\[\s*["'`](?:startsWith|contains)["'`]\s*\]/g)) {
    values.push(match[0].trim());
  }
  for (const match of code.matchAll(/(?:\b(?:startsWith|contains)|["'](?:startsWith|contains)["'])\s*:\s*/g)) {
    const value = valueAt(code, (match.index ?? 0) + match[0].length, structure);
    if (!bareValueAllowed(value)) values.push(value);
  }
  return values;
}

function census(): { unexplained: string[]; allowedSeen: Set<string>; scanned: number } {
  const unexplained: string[] = [];
  const allowedSeen = new Set<string>();
  const files = sourceFiles(SRC).filter((file) => relative(REPO_ROOT, file).split("\\").join("/") !== HELPER);
  for (const file of files) {
    const rel = relative(REPO_ROOT, file).split("\\").join("/");
    for (const value of inspectSource(readFileSync(file, "utf8"))) {
      const key = `${rel}|${value}`;
      if (key in ALLOWED) allowedSeen.add(key);
      else unexplained.push(key);
    }
  }
  return { unexplained, allowedSeen, scanned: files.length };
}

describe("every id- or input-carrying Prisma startsWith/contains uses literal matching (#4146, #4190, INV-SSOT-006)", () => {
  const result = census();

  it("reads the tree it claims to", () => {
    expect(result.scanned).toBeGreaterThan(500);
  });

  it("finds no bare startsWith/contains whose value could carry an id or user input", () => {
    expect(
      result.unexplained,
      "INV-SSOT-006: Prisma's `startsWith`/`contains` is SQL LIKE and does not escape `_` or `%`, so a prefix built from an id " +
        "or typed by a person can match another record. Write `field: exactPrefix(prefix)` or `field: exactContains(value)` (optionally case-insensitive) " +
        "(src/lib/prisma-exact-prefix.ts). Only a value that can carry neither belongs in ALLOWED, with its reason.",
    ).toEqual([]);
  });

  it("has no stale ALLOWED entry", () => {
    expect(
      Object.keys(ALLOWED).filter((key) => !result.allowedSeen.has(key)),
      "INV-SSOT-006: an ALLOWED entry no longer matches a site; remove it.",
    ).toEqual([]);
  });

  it("rejects dynamic contains in ordinary, quoted, computed and shorthand properties (#4190)", () => {
    for (const source of [
      '{ contains: query, mode: "insensitive" }',
      '{ contains: `${id}:` }',
      '{ "contains": query }',
      '{ ["contains"]: query }',
      '{ contains }',
    ]) expect(inspectSource(source), `INV-SSOT-006: missed ${source}`).not.toEqual([]);
    expect(inspectSource('/* contains: query */ field: exactContains(query, "insensitive")')).toEqual([]);
    expect(inspectSource('{ contains: "hut-fees" }')).toEqual([]);
  });

  it("judges the spellings it is meant to (non-vacuity)", () => {
    expect(bareValueAllowed('"payment:"')).toBe(true);
    expect(bareValueAllowed("CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX")).toBe(true);
    expect(bareValueAllowed("`${key}:`")).toBe(false);
    expect(bareValueAllowed("buildDuplicateCaptureRefundRecoveryKeyPrefixForBooking(bookingId)")).toBe(false);
    expect(bareValueAllowed("trimmedQuery")).toBe(false);
    expect(valueAt("startsWith: build(a, b), not: x }", 12)).toBe("build(a, b)");
    expect(valueAt("startsWith:\n  `p:${id}:` }", 11)).toBe("`p:${id}:`");
  });
});
