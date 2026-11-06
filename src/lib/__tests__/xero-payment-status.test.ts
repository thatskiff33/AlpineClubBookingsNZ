/**
 * #4576 (`INV-SSOT`): one rule decides whether a Xero payment still counts.
 * `isLiveXeroPaymentStatus` (src/lib/xero-payment-status.ts) excludes DELETED and
 * VOIDED in any case; the census below fails on a new hand-rolled comparison of
 * a payment's status against either word anywhere in production source.
 *
 * Reads the source from disk for the census: no import edge reaches every reader.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DELETED_XERO_PAYMENT_STATUS,
  isDeletedXeroPaymentStatus,
  isLiveXeroPaymentStatus,
} from "@/lib/xero-payment-status";
import { stripComments } from "./support/strip-comments";

const ROOT = path.resolve(__dirname, "../../..");
const RULE_FILE = path.join("src", "lib", "xero-payment-status.ts");

describe("isLiveXeroPaymentStatus (#4576)", () => {
  it.each(["AUTHORISED", "authorised", "", undefined, null])("counts %s as live", (status) => {
    expect(isLiveXeroPaymentStatus(status)).toBe(true);
  });

  it.each(["DELETED", "deleted", "Deleted", "VOIDED", "voided"])("counts %s as dead", (status) => {
    expect(isLiveXeroPaymentStatus(status)).toBe(false);
  });

  it("keeps the narrower deleted check for the never-re-adopt rule", () => {
    expect(isDeletedXeroPaymentStatus("deleted")).toBe(true);
    expect(isDeletedXeroPaymentStatus("VOIDED")).toBe(false);
    expect(DELETED_XERO_PAYMENT_STATUS).toBe("DELETED");
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === "__tests__" || name === "node_modules") return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/**
 * A comparison of a payment's status against DELETED or VOIDED, on one line:
 * the shape all four pre-#4576 copies took (`String(payment.status ?? "") !== "DELETED"`
 * and its upper-cased variant). Invoice and credit-note statuses share the words,
 * so a line must name both a payment and a status to count.
 */
const HAND_ROLLED = /(?:[!=]==?\s*["'](?:DELETED|VOIDED)["'])|(?:["'](?:DELETED|VOIDED)["']\s*[!=]==?)/;

function handRolledLines(source: string): string[] {
  return stripComments(source)
    .split("\n")
    .filter((line) => HAND_ROLLED.test(line) && /payment/i.test(line) && /status/i.test(line));
}

describe("one live-payment rule: no hand-rolled Xero payment-status comparison (#4576)", () => {
  it("catches the shapes the four old readers used (fixture proof)", () => {
    for (const shape of [
      'String(payment.status ?? "").toUpperCase() !== "DELETED",',
      'return Boolean(payment.paymentID) && String(payment.status ?? "") !== "DELETED";',
      'if (String(payment.status ?? "") === "DELETED") return [];',
      'const dead = "VOIDED" === payment?.status;',
    ]) {
      expect(handRolledLines(shape), shape).toHaveLength(1);
    }
    expect(handRolledLines('if (invoice.status === "VOIDED") return;')).toEqual([]);
  });

  it("finds none in production source outside the rule's own module", () => {
    // src/test holds the provider fakes, which play Xero itself.
    const offenders = sourceFiles(path.join(ROOT, "src"))
      .filter((file) => !file.startsWith(path.join(ROOT, "src", "test") + path.sep))
      .filter((file) => path.relative(ROOT, file) !== RULE_FILE)
      .flatMap((file) => {
        const source = readFileSync(file, "utf8");
        if (!/DELETED|VOIDED/.test(source)) return [];
        return handRolledLines(source).map((line) => `${path.relative(ROOT, file)}: ${line.trim()}`);
      });
    expect(
      offenders,
      "Use isLiveXeroPaymentStatus (or isDeletedXeroPaymentStatus) from src/lib/xero-payment-status.ts",
    ).toEqual([]);
  });
});
