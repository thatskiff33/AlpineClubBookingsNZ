import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * #4467 (review F4): one reader of a validation refusal's `details`.
 *
 * Routes answer a body their zod schema refuses with `details` set to zod's
 * `flatten()` (or its bare `fieldErrors`). `readValidationDetails` in
 * `src/lib/format-validation-errors.ts` is the one place that reads that
 * shape back; a second reader drifts from it (the admin list screens' reader
 * did, until this census folded it in). This fails a module that reads it
 * by hand, in either of the two ways one has been written:
 *
 * - `<x>.details.fieldErrors` / `<x>.details?.formErrors`, or
 * - `Object.entries(<x>.details)` (and `keys` / `values`).
 *
 * It reads TypeScript's parse, so prose in a comment does not count. Its
 * limit: a reader that first destructures `details` into its own binding
 * (`const { details } = body; details.fieldErrors`) or reaches it by element
 * access (`body["details"]`) is not matched. None exists today, and matching
 * any identifier named `details` would flag the one legitimate reader. A route
 * BUILDING the body (`parsed.error.flatten().fieldErrors`) is not a read and
 * does not match: neither shape goes through a `details` property.
 */

const SRC = path.join(process.cwd(), "src");
const READER = "src/lib/format-validation-errors.ts";

/**
 * Hand-rolled readers that predate the rule, each with why it is still here.
 * An entry that stops matching fails below, so the list cannot go stale.
 */
const KNOWN_DEBT: Record<string, string> = {
  "src/app/(website)/join/apply/join-apply-page-client.tsx":
    "the public application form maps the applications route's bare fieldErrors itself; to move onto readValidationDetails",
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === "node_modules" || entry === "__tests__" ? [] : walk(full);
    }
    return /\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

function namedDetails(node: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(node) && node.name.text === "details";
}

/** Whether `text` reads a `details` field map by hand. */
function readsDetailsByHand(fileName: string, text: string): boolean {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isPropertyAccessExpression(node) &&
      (node.name.text === "fieldErrors" || node.name.text === "formErrors") &&
      namedDetails(node.expression)
    ) {
      found = true;
      return;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Object" &&
      ["entries", "keys", "values"].includes(node.expression.name.text) &&
      node.arguments[0] !== undefined &&
      namedDetails(node.arguments[0])
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const offenders = walk(SRC)
  .map((file) => path.relative(process.cwd(), file).split(path.sep).join("/"))
  .filter((file) => file !== READER)
  .filter((file) => readsDetailsByHand(file, readFileSync(file, "utf8")));

describe("one reader of a validation refusal's details (#4467)", () => {
  it("recognises both hand-written shapes, and not a route building the body", () => {
    expect(readsDetailsByHand("a.ts", "const m = body.details?.fieldErrors;")).toBe(true);
    expect(readsDetailsByHand("a.ts", "const m = payload?.details.formErrors;")).toBe(true);
    expect(readsDetailsByHand("a.ts", "Object.entries(data.details).forEach(f);")).toBe(true);
    expect(
      readsDetailsByHand("a.ts", "json({ details: parsed.error.flatten().fieldErrors });"),
    ).toBe(false);
    expect(readsDetailsByHand("a.ts", "// body.details.fieldErrors\nconst x = 1;")).toBe(false);
  });

  it("finds no reader outside format-validation-errors.ts but the named debt", () => {
    expect(offenders.filter((file) => !(file in KNOWN_DEBT))).toEqual([]);
  });

  it("still finds each named debt, so a fixed one leaves the list", () => {
    expect(Object.keys(KNOWN_DEBT).filter((file) => !offenders.includes(file))).toEqual([]);
  });
});
