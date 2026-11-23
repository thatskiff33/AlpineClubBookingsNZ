/**
 * #4872 (`INV-PAY-150`, `INV-SSOT`): every production planner call passes the
 * superseded-capture hold-back, or is named here with the reason it does not.
 *
 * An empty map is the default and changes nothing, so tests are not in this
 * census. #4879 brought the edit-review card plan and the "Paid another way"
 * close under the rule; the group cancellation is the only exemption, because
 * it cannot reach a superseded capture's charge (`INV-PAY-150`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "./support/strip-comments";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

const ROOT = resolve(__dirname, "../../..");
const NAMES = [
  "planStripeRefundAllocation",
  "planCardRefundFromLedger",
  "applyLocalRefundAllocation",
  "foldMirrorRefundIntoLedger",
] as const;

/** file:function → why this call does not pass the hold-back yet. */
const EXEMPT: Record<string, string> = {
  "src/lib/group-cancel.ts:foldMirrorRefundIntoLedger":
    "#4879: an organiser-settled child payment's rows are bank receipts, never a superseded capture's charge",
  "src/lib/group-cancel.ts:applyLocalRefundAllocation":
    "#4879: the group cancellation allocates only over an organiser-settled child's bank receipts",
};

function productionFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        found.push(relative(ROOT, full).split(sep).join("/"));
      }
    }
  };
  walk(join(ROOT, "src"));
  return found.sort();
}

function argumentText(source: string, openParen: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openParen; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === "\\") {
        i += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openParen, i + 1);
    }
  }
  return source.slice(openParen);
}

function passesHoldBack(name: (typeof NAMES)[number], args: string): boolean {
  if (args.includes("heldBackByTransaction")) return true;
  return (name === "foldMirrorRefundIntoLedger" || name === "planCardRefundFromLedger") && args.includes(".byTransaction");
}

describe("every card planner passes the superseded-capture hold-back (#4872)", { timeout: CENSUS_TIMEOUT_MS }, () => {
  const calls: Array<{ key: string; passes: boolean }> = [];
  for (const file of productionFiles()) {
    const source = stripComments(readFileSync(join(ROOT, file), "utf8"));
    for (const name of NAMES) {
      const pattern = new RegExp(`\\b${name}\\s*\\(`, "g");
      for (const match of source.matchAll(pattern)) {
        const index = match.index ?? 0;
        if (/function\s*$/.test(source.slice(Math.max(0, index - 40), index))) continue;
        const args = argumentText(source, index + match[0].length - 1);
        calls.push({ key: `${file}:${name}`, passes: passesHoldBack(name, args) });
      }
    }
  }

  it("finds the production callers", () => {
    expect(calls.length).toBeGreaterThan(0);
  });

  it("passes the hold-back, or is a named exemption", () => {
    const missing = calls.filter((call) => !call.passes && EXEMPT[call.key] === undefined);
    expect(missing.map((call) => call.key)).toEqual([]);
  });

  it("sizes a full reduction from the edit cash basis (#4872)", () => {
    const files = [
      "src/lib/booking-guest-acceptance-return-route.ts",
      "src/lib/booking-batch-modification-service.ts",
    ];
    for (const file of files) {
      const source = stripComments(readFileSync(join(ROOT, file), "utf8"));
      expect(source, file).toContain("refundableCashForModification(");
      expect(source, file).not.toContain("refundableCashNetOfOpenHandBacks(");
    }
  });

  it("keeps each exemption a real call that does not pass the map yet", () => {
    for (const key of Object.keys(EXEMPT)) {
      const found = calls.filter((call) => call.key === key);
      expect(found, key).toHaveLength(1);
      expect(found[0]?.passes, `${key} now passes the hold-back; take it off the exemption list`).toBe(false);
    }
  });
});
