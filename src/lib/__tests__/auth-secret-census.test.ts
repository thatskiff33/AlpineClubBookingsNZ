import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { relativeSource, sourceFiles } from "./support/booking-guest-night-writer-scan";

/**
 * #4638 / INV-SSOT: new signing paths use requireAuthSecret, not private copies.
 * Run by name: this census reads source from disk, outside the import graph.
 * Detects dot/bracket reads and destructuring from process.env, and calls to
 * getAuthSecret. Computed keys and aliases of process.env/getAuthSecret are
 * outside this syntactic scan; review must check those.
 */
function secretReads(source: string): { env: number; optional: number } {
  const file = ts.createSourceFile("scan.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const result = { env: 0, optional: 0 };
  const isSecret = (name: string) => name === "AUTH_SECRET" || name === "NEXTAUTH_SECRET";
  const isEnv = (node: ts.Node) => node.getText(file) === "process.env";
  function visit(node: ts.Node) {
    if (ts.isPropertyAccessExpression(node) && isEnv(node.expression) && isSecret(node.name.text)) {
      result.env++;
    }
    if (ts.isElementAccessExpression(node) && isEnv(node.expression) &&
        ts.isStringLiteralLike(node.argumentExpression) && isSecret(node.argumentExpression.text)) {
      result.env++;
    }
    if (ts.isVariableDeclaration(node) && node.initializer && isEnv(node.initializer) &&
        ts.isObjectBindingPattern(node.name)) {
      for (const binding of node.name.elements) {
        const key = binding.propertyName ?? binding.name;
        if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && isSecret(key.text)) result.env++;
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "getAuthSecret") {
      result.optional++;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return result;
}

// These are different contracts, not unconditional "require or throw" copies.
// Exact counts reject additions inside an exempt file and stale exemptions.
const ENV_READERS = {
  "src/lib/integration-crypto.ts": 2, // Reports the source key for encryption metadata.
  "src/lib/member-merge.ts": 2, // Preserve raw keys and the non-production preview fallback.
  "src/lib/member-application-mapping.ts": 2, // Same distinct preview contract.
  "src/lib/seasonal-membership-assignments.ts": 2, // Same distinct preview contract.
};
const OPTIONAL_READERS = {
  "src/lib/runtime-config.ts": 2, // Canonical required reader and readiness diagnostics.
  "src/lib/auth.ts": 1, // Auth.js accepts an optional secret.
  "src/lib/login-throttle.ts": 2, // Distinct throttle error and optional cleanup.
  "src/lib/lodge-pin-session.ts": 1, // Missing key returns null.
  "src/lib/two-factor.ts": 1, // Distinct encryption-key error.
};

describe("auth secret census", () => {
  it("finds private readers without matching comments or prose", () => {
    expect(secretReads(`
      // process.env.AUTH_SECRET; getAuthSecret();
      const prose = "process.env.NEXTAUTH_SECRET";
      const a = process.env.AUTH_SECRET;
      const b = process.env["NEXTAUTH_SECRET"];
      const { AUTH_SECRET: secret } = process.env;
      const c = getAuthSecret();
    `)).toEqual({ env: 3, optional: 1 });
  });

  it("has no new private auth-secret readers in application source", () => {
    const env: Record<string, number> = {};
    const optional: Record<string, number> = {};
    for (const file of sourceFiles()) {
      const name = relativeSource(file);
      if (!name.startsWith("src/")) continue;
      const code = readFileSync(file, "utf8");
      // Every read the scan counts names one of these, so skip parsing the rest.
      if (!code.includes("AUTH_SECRET") && !code.includes("getAuthSecret")) continue;
      const reads = secretReads(code);
      if (reads.env) env[name] = reads.env;
      if (reads.optional) optional[name] = reads.optional;
    }
    expect(env, "Use runtime-config; preserve only the documented distinct readers.").toEqual(ENV_READERS);
    expect(optional, "Use requireAuthSecret for new required signing keys.").toEqual(OPTIONAL_READERS);
  });
});
