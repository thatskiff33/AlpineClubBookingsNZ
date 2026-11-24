import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { ADDITIONAL_ASK_INTENT_TYPE } from "@/lib/ordinary-ask-request";
import { relativeSource, sourceFiles } from "./support/booking-guest-night-writer-scan";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

const CANONICAL_MODULE = "src/lib/ordinary-ask-request.ts";
const INVARIANT = "INV-SSOT-001";

// Exact literals only: longer recovery/reissue reasons are separate facts.
// The TypeScript AST excludes comments and handles quote styles/escaped literals.
// Parse original JSX: stripping a URL text node can erase valid code after it.
function tagLiterals(file: string, raw: string) {
  const source = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true);
  const found: { file: string; line: number; canonical: boolean }[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text === ADDITIONAL_ASK_INTENT_TYPE
    ) {
      const parent = node.parent;
      found.push({
        file,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        canonical:
          file === CANONICAL_MODULE &&
          ts.isVariableDeclaration(parent) &&
          ts.isIdentifier(parent.name) &&
          parent.name.text === "ADDITIONAL_ASK_INTENT_TYPE" &&
          parent.initializer === node,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe(`${INVARIANT}: additional asks share one intent type (#4078)`, () => {
  it("preserves the historical Stripe metadata and audit wire value", () => {
    expect(ADDITIONAL_ASK_INTENT_TYPE).toBe("modification_additional");
  });

  it.each([
    'metadata: { type: "modification_additional" }',
    "metadata: { type: 'modification_additional' }",
    "metadata: { type: `modification_additional` }",
    'if (intent.metadata?.type === "modification_additional") {}',
    'audit({ kind: "modification_additional" });',
    'const copied = "modification_\\u0061dditional";',
  ])("detects a handwritten tag outside the known consumers: %s", (code) => {
    expect(tagLiterals("src/app/new-consumer.ts", code)).toEqual([
      { file: "src/app/new-consumer.ts", line: 1, canonical: false },
    ]);
  });

  it("detects a handwritten tag after JSX URL text on the same line", () => {
    const code = 'export const UI = () => <><strong>https://</strong><Widget intentType={"modification_additional"} /></>;';
    expect(tagLiterals("src/app/new-consumer.tsx", code)).toEqual([
      { file: "src/app/new-consumer.tsx", line: 1, canonical: false },
    ]);
  });

  it("ignores comments and the distinct reason strings", () => {
    expect(tagLiterals("src/lib/example.ts", `
      // type: "modification_additional"
      /* kind: 'modification_additional' */
      const recovery = "modification_additional_recovery";
      const reissue = "modification_additional_currency_reissue";
    `)).toEqual([]);
  });

  it("allows only the canonical definition throughout production source", () => {
    const files = sourceFiles().map((file) => ({ file, relative: relativeSource(file) }))
      .filter(({ relative }) => relative.startsWith("src/"));
    const paths = files.map(({ relative }) => relative);
    // Bind discovery by named subtrees and the owner, rather than a mutable count.
    for (const subtree of ["src/app/", "src/components/", "src/config/", "src/lib/"]) {
      expect(paths.some((file) => file.startsWith(subtree)), `${INVARIANT}: source walk missed ${subtree}`).toBe(true);
    }
    expect(paths, `${INVARIANT}: source walk missed the definition`).toContain(CANONICAL_MODULE);
    expect(paths.some((file) => file.includes("/__tests__/") || /\.(?:test|spec)\./.test(file))).toBe(false);
    const literals = files.flatMap(({ file, relative }) => tagLiterals(relative, readFileSync(file, "utf8")));
    expect(literals.filter(({ canonical }) => !canonical), `${INVARIANT}: import ADDITIONAL_ASK_INTENT_TYPE instead of copying its wire value`).toEqual([]);
    expect(literals.filter(({ canonical }) => canonical), `${INVARIANT}: expected exactly one canonical definition`).toHaveLength(1);
    // The whole-production AST walk measured 5.8s under the 772-file related batch.
    // Keep the walk complete while giving this disk/parse test its own bounded budget.
  }, CENSUS_TIMEOUT_MS);
});
