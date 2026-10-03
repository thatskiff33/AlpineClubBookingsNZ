/**
 * #3827 (`INV-PAY-114`): an edit's refund hand-back is a
 * `CANCELLED_BOOKING_HAND_BACK` marked by its occurrence key, so a reader that
 * selects a CANCELLATION's hand-backs by kind alone would count an edit's as
 * one (the repair tool's late-cash evidence, the organisation hand-back's
 * duplicate check). Every production read that filters on that kind must also
 * spread `NOT_EDIT_REFUND_HAND_BACK_WHERE`, the one spelling of the exclusion.
 *
 * Reads the source from disk: no import edge reaches these files.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === "__tests__" || name === "node_modules") return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/** The argument text of every `manualRefundTask.findFirst/findMany/count(...)` call. */
function readCalls(source: string): string[] {
  const calls: string[] = [];
  const re = /manualRefundTask\.(?:findFirst|findMany|count|aggregate|groupBy)\(/g;
  for (let match = re.exec(source); match; match = re.exec(source)) {
    let depth = 1;
    let i = match.index + match[0].length;
    for (; i < source.length && depth > 0; i += 1) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") depth -= 1;
    }
    calls.push(source.slice(match.index, i));
  }
  return calls;
}

describe("INV-PAY-114: a cancellation hand-back reader excludes an edit's refund hand-back", () => {
  const offenders: string[] = [];
  let readersByKind = 0;
  for (const file of sourceFiles(path.join(ROOT, "src"))) {
    const source = readFileSync(file, "utf8");
    for (const call of readCalls(source)) {
      if (!call.includes("CANCELLED_BOOKING_HAND_BACK")) continue;
      readersByKind += 1;
      if (!call.includes("...NOT_EDIT_REFUND_HAND_BACK_WHERE")) {
        offenders.push(`${path.relative(ROOT, file)}: ${call.slice(0, 80)}`);
      }
    }
  }

  it("finds the readers it polices (a census that matches nothing proves nothing)", () => {
    expect(readersByKind).toBeGreaterThanOrEqual(2);
  });

  it("every one spreads the exclusion", () => {
    expect(offenders, "INV-PAY-114: spread NOT_EDIT_REFUND_HAND_BACK_WHERE beside the kind").toEqual([]);
  });
});
