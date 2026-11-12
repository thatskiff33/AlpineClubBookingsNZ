/**
 * #4922 (`INV-LOCK-003`): every production caller of the Xero inbound cycle runs
 * it under the `xero-inbound-reconcile` run claim. The lock inventory counts the
 * one place the claim is taken, so it cannot see a caller that skips it; this
 * census counts who reaches the guarded work instead. The one door is
 * `src/lib/xero-cron-runner.ts` (`runXeroCronTaskList` and
 * `runXeroWebhookInboundKick`, both under `withCronRunClaim`).
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const CYCLE = "runXeroInboundReconciliationCycle";
const DOOR = "src/lib/xero-cron-runner.ts";

/** Lines naming the cycle in code, bar its declaration and a plain re-export; comments and other strings are not code. */
function cycleReferences(file: string, text: string): number[] {
  if (!text.includes(CYCLE)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines: number[] = [];
  function visit(node: ts.Node) {
    if (ts.isIdentifier(node) && node.text === CYCLE) {
      const declaration = ts.isFunctionDeclaration(node.parent) && node.parent.name === node;
      const reExport = ts.isExportSpecifier(node.parent);
      if (!declaration && !reExport) lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    }
    // A bracket lookup (`module["runXero…"]`) reaches the cycle as surely as a dotted one.
    if (ts.isStringLiteralLike(node) && node.text === CYCLE && ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node) {
      lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return lines;
}

describe("Xero inbound cycle callers (#4922, INV-LOCK-003)", () => {
  // Mutation probe: the webhook route's pre-#4922 kick, called straight after the response.
  it("recognizes a direct, aliased, dynamic or bracketed reach for the cycle", () => {
    expect(cycleReferences("route.ts", `
      import { ${CYCLE} } from "@/lib/xero-inbound-reconciliation";
      await ${CYCLE}({ batchSize: 1, maxBatches: 3 });
    `)).toEqual([2, 3]);
    expect(cycleReferences("alias.ts", `import { ${CYCLE} as cycle } from "@/lib/xero-inbound-reconciliation";`)).toEqual([1]);
    expect(cycleReferences("dynamic.ts", `(await import("@/lib/xero-inbound-reconciliation")).${CYCLE}();`)).toEqual([1]);
    expect(cycleReferences("bracket.ts", `const run = inbound["${CYCLE}"];`)).toEqual([1]);
  });

  it("ignores the declaration, a re-export, comments and plain strings", () => {
    expect(cycleReferences("event-processing.ts", `
      export async function ${CYCLE}() {}
      export { ${CYCLE} } from "./xero-inbound/event-processing";
      // ${CYCLE}() runs under the claim
      const label = "${CYCLE}";
    `)).toEqual([]);
  });

  // Reads src/ from disk: run explicitly with test:named after adding a caller.
  it("is reached only through the claimed runner in production src/", () => {
    const files = readdirSync("src", { recursive: true, encoding: "utf8" })
      .map((file) => `src/${file.replaceAll(path.sep, "/")}`)
      .filter((file) => /\.[cm]?[jt]sx?$/.test(file) && !file.includes("/__tests__/") && !/\.(test|spec)\./.test(file));
    expect(files).toContain(DOOR);
    const callers = files.flatMap((file) => cycleReferences(file, readFileSync(file, "utf8")).length > 0 ? [file] : []);
    expect(callers, "run the inbound cycle through src/lib/xero-cron-runner.ts, under the xero-inbound-reconcile claim").toEqual([DOOR]);
  });
});
