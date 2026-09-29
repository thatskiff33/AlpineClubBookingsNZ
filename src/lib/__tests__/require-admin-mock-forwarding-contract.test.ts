import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// #2921: the requireAdmin test mock must RECEIVE the route's permission option.
//
// `evaluateRequireAdminMock` can only honour a route's `{ area, level }`
// requirement if the value reaches it. When it does not, the helper falls back
// to `hasAdminPortalAccess` — "is this person in the admin portal at all", a
// check the real guard has never performed — and every per-area assertion in
// that file becomes vacuous. 50 files were in that state when this was found,
// and the file it was found in had passed a mutation the author expected it to
// catch.
//
// Two controls now stop it recurring, and this is the second of them:
//
//  1. `evaluateRequireAdminMock`'s parameter is REQUIRED (it accepts undefined,
//     because a route that passes no options is legitimate), so a bare
//     `evaluateRequireAdminMock()` is a compile error. `pnpm run typecheck`
//     catches that shape before this test runs.
//  2. The type system cannot see the OTHER shapes.
//     `evaluateRequireAdminMock({})` type-checks and is just as inert, and so
//     does forwarding some unrelated variable. This test parses every test file
//     that mentions the helper and pins the two forms that are actually
//     correct.
//
// Scoped deliberately to files that mention the helper. A suite that stubs
// `requireAdmin` some other way entirely — an inline `async () => ({ ok: true,
// session })`, a `vi.fn()` with `mockResolvedValue` — is a different and
// legitimate pattern, and this test says nothing about it. There is no
// allowlist: an exemption list is how this class comes back.
// ---------------------------------------------------------------------------

const SRC_ROOT = path.join(process.cwd(), "src");
const HELPER = "evaluateRequireAdminMock";
const THIS_FILE = "require-admin-mock-forwarding-contract.test.ts";

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const absolute = path.join(directory, entry);
    if (statSync(absolute).isDirectory()) return walk(absolute);
    return /\.tsx?$/.test(entry) ? [absolute] : [];
  });
}

function repoPath(absolute: string) {
  return path.relative(process.cwd(), absolute).replaceAll("\\", "/");
}

/** Strips `as X`, `!`, `<X>` and parentheses so a cast still counts as a forward. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

function enclosingFunction(node: ts.Node): FunctionLike | null {
  for (let current = node.parent; current; current = current.parent) {
    if (isFunctionLike(current)) return current;
  }
  return null;
}

/** `evaluateRequireAdminMock` or `(await import(...)).evaluateRequireAdminMock`. */
function isHelperReference(node: ts.Expression): boolean {
  const target = unwrap(node);
  if (ts.isIdentifier(target)) return target.text === HELPER;
  if (ts.isPropertyAccessExpression(target)) return target.name.text === HELPER;
  return false;
}

type Finding = { file: string; line: number; reason: string };

const files = walk(SRC_ROOT).filter((file) => {
  if (path.basename(file) === THIS_FILE) return false;
  if (repoPath(file).includes("__tests__/helpers/require-admin-mock.ts")) {
    return false;
  }
  return readFileSync(file, "utf8").includes(HELPER);
});

const findings: Finding[] = [];
const forwardingWrappers: string[] = [];
const directReferences: string[] = [];

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TSX,
  );

  const lineOf = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const visit = (node: ts.Node) => {
    // Rule 1 — a CALL of the helper must pass the enclosing function's own
    // first parameter. That is the only value that can be the route's options.
    if (ts.isCallExpression(node) && isHelperReference(node.expression)) {
      const wrapper = enclosingFunction(node);
      const parameterName =
        wrapper && wrapper.parameters.length > 0
          ? wrapper.parameters[0].name.getText(source)
          : null;
      const argument = node.arguments[0]
        ? unwrap(node.arguments[0])
        : undefined;
      const argumentName =
        argument && ts.isIdentifier(argument) ? argument.text : null;

      if (!parameterName) {
        findings.push({
          file: repoPath(file),
          line: lineOf(node),
          reason:
            "calls evaluateRequireAdminMock from a function that declares no " +
            "parameter, so the route's permission option cannot reach it. " +
            "Reference the helper directly instead: `requireAdmin: (await " +
            'import("./helpers/require-admin-mock")).evaluateRequireAdminMock`',
        });
      } else if (argumentName !== parameterName) {
        findings.push({
          file: repoPath(file),
          line: lineOf(node),
          reason:
            `passes \`${node.arguments[0]?.getText(source) ?? "nothing"}\` where ` +
            `it must forward its own parameter \`${parameterName}\`. Anything ` +
            "else discards the route's permission option and silently downgrades " +
            "the gate to a broad portal check",
        });
      } else {
        forwardingWrappers.push(`${repoPath(file)}:${lineOf(node)}`);
      }
    }

    // Rule 2 — inside a vi.mock of the session guards, a `requireAdmin` wrapper
    // that takes no parameter is the exact #2921 shape even if the helper call
    // sits somewhere Rule 1 cannot attribute it to.
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source) === "requireAdmin"
    ) {
      const value = unwrap(node.initializer);
      if (isFunctionLike(value) && value.parameters.length === 0) {
        findings.push({
          file: repoPath(file),
          line: lineOf(node),
          reason:
            "wires `requireAdmin` to a function that takes no parameter. The " +
            "route's `{ area, level }` requirement is passed as that argument, " +
            "so this wrapper throws it away",
        });
      } else if (isHelperReference(node.initializer)) {
        directReferences.push(`${repoPath(file)}:${lineOf(node)}`);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
}

describe("requireAdmin test-mock forwarding contract (#2921)", () => {
  it("finds the files that use the shared requireAdmin mock", () => {
    // A guard over an empty set is a guard that passes for the wrong reason. If
    // this drops to zero, either the helper was renamed (update HELPER) or the
    // walk stopped reaching src/lib/__tests__.
    expect(files.length).toBeGreaterThanOrEqual(50);
  });

  it("never lets a call site drop the route's permission option", () => {
    const report = findings
      .map(({ file, line, reason }) => `  ${file}:${line} — ${reason}`)
      .join("\n");
    expect(report, `#2921 non-forwarding requireAdmin mocks:\n${report}`).toBe(
      "",
    );
  });

  it("keeps the direct reference the prevailing house form", () => {
    // Not a style point. Every wrapper is a place the argument can be dropped
    // again; the bare reference has no argument to drop. If wrappers ever
    // outnumber direct references, the sweep has been eroded.
    expect(directReferences.length).toBeGreaterThan(forwardingWrappers.length);
  });
});
