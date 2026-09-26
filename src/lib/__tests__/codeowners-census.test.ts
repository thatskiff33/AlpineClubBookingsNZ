/**
 * `.github/CODEOWNERS` cannot rot (#3341).
 *
 * The file is the mechanical half of the money gate: once "Require review from
 * Code Owners" is on for `main`, a pull request touching a listed path needs the
 * owner's Approve. GitHub never complains about a pattern that matches nothing —
 * it simply stops gating — so a renamed money module would silently leave the
 * gate while the file still read as complete. This census makes that loud, and
 * holds the file to the money surface the issue scoped it to.
 *
 * `git ls-files` is the instrument, because CODEOWNERS is evaluated against the
 * files a pull request changes, which are tracked files. It reads the index, so
 * a shallow CI checkout answers it exactly as a full one does.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const OWNER = "@thatskiff33";

/**
 * The ceiling on the owned share of non-test `src/lib` TypeScript, set from the
 * surface as measured rather than from an estimate. #3341 guessed "about 7%";
 * owning every module that mints, charges, refunds, credits, settles or sizes
 * money — the list grew once review traced the callers of the ask-sizing,
 * refund and settlement functions — measured 137 of 1132 (12.1%). 15% leaves
 * room for new money modules and still reds a glob that starts sweeping in
 * unrelated code; raise it only with the modules that justify it.
 */
const MAX_OWNED_SRC_LIB_SHARE = 0.15;

/**
 * Outside `src/lib`, a share of one directory bounds nothing, so every pattern
 * there must start with one of these prefixes AND the owned files outside
 * `src/lib` stay under a count. Measured 18 when this was set.
 */
const ALLOWED_PREFIXES = [
  "/src/lib/",
  "/src/app/api/webhooks/stripe/",
  "/src/app/api/payments/",
  "/src/app/api/pay/",
  "/src/app/api/bookings/",
  "/src/app/api/admin/payments/",
  "/src/app/api/admin/refund-requests/",
  "/docs/invariants/",
  "/.github/CODEOWNERS",
];
const MAX_OWNED_OUTSIDE_SRC_LIB = 40;

/**
 * THE REVERSE CHECK: modules known to move money, which must stay owned. A
 * pattern that goes stale reds the "matches a tracked file" case; a money file
 * that simply never got a pattern reds this one. The seam modules are added from
 * `MONEY_SEAMS` itself (read from the census source, so the list lives once).
 */
const MUST_BE_OWNED = [
  "src/lib/stripe.ts",
  "src/lib/stripe-webhook-service.ts",
  "src/lib/additional-payment-ask.ts",
  "src/lib/booking-modify-settlement.ts",
  "src/lib/payment-recovery.ts",
  "src/lib/edit-financial-review-charge.ts",
  "src/lib/internet-banking-payment-cron.ts",
  "src/lib/cancelled-booking-late-capture.ts",
  "src/lib/xero-operation-outbox.ts",
  "src/lib/group-cancel.ts",
  "src/lib/booking-ledger-write.ts",
  "src/lib/member-credit.ts",
  "src/app/api/webhooks/stripe/route.ts",
  "src/app/api/payments/create-payment-intent/route.ts",
  "src/app/api/bookings/[id]/guests/route.ts",
  "src/app/api/bookings/[id]/modify-quote/route.ts",
];

interface Rule {
  readonly pattern: string;
  readonly owners: readonly string[];
  readonly line: number;
}

function rules(): Rule[] {
  return readFileSync(path.join(ROOT, ".github", "CODEOWNERS"), "utf8")
    .split("\n")
    .map((text, index) => ({ text: text.trim(), line: index + 1 }))
    .filter(({ text }) => text !== "" && !text.startsWith("#"))
    .map(({ text, line }) => {
      const [pattern, ...owners] = text.split(/\s+/);
      return { pattern, owners, line };
    });
}

/**
 * A CODEOWNERS pattern as GitHub reads it (gitignore syntax): `*` and `?` stay
 * inside one path segment, `**` crosses them, and a pattern naming a directory
 * owns everything beneath it. Only anchored patterns are allowed here, so the
 * unanchored "match at any depth" rule is deliberately not implemented.
 */
function matcher(pattern: string): RegExp {
  const body = pattern
    .slice(1)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${body}(?:/.*)?$`);
}

const tracked = execSync("git ls-files", { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  .split("\n")
  .map((file) => file.trim())
  .filter(Boolean);

describe(".github/CODEOWNERS covers the money surface and nothing stale (#3341)", () => {
  it("anchors every pattern and names the one owner", () => {
    const malformed = rules()
      .filter((rule) => !rule.pattern.startsWith("/") || rule.owners.join(" ") !== OWNER)
      .map((rule) => `line ${rule.line}: ${rule.pattern} ${rule.owners.join(" ")}`);
    expect(
      malformed,
      `Every CODEOWNERS rule is an anchored path owned by ${OWNER} alone. An unanchored pattern matches at any depth, which is how a money glob quietly starts owning unrelated code.`,
    ).toEqual([]);
  });

  it("matches at least one tracked file with every pattern", () => {
    const dead = rules()
      .filter((rule) => !tracked.some((file) => matcher(rule.pattern).test(file)))
      .map((rule) => `line ${rule.line}: ${rule.pattern}`);
    expect(
      dead,
      "These CODEOWNERS patterns match no tracked file, so they gate nothing. A money module was probably renamed or moved: point the pattern at its new path in the same pull request rather than deleting the line.",
    ).toEqual([]);
  });

  it("owns the guards that enforce the money gate, including itself", () => {
    const owned = (file: string) => rules().some((rule) => matcher(rule.pattern).test(file));
    for (const guard of [
      ".github/CODEOWNERS",
      "src/lib/__tests__/money-seam-mock-census.test.ts",
      "src/lib/__tests__/superseded-additional-ask-integration.test.ts",
      "src/lib/__tests__/codeowners-census.test.ts",
    ]) {
      expect(tracked, `${guard} must be tracked`).toContain(guard);
      expect(owned(guard), `${guard} must be code-owned, or a PR can weaken the gate unreviewed`).toBe(true);
    }
  });

  it("stays scoped: the owned share of non-test src/lib TypeScript is under the ceiling", () => {
    const srcLib = tracked.filter(
      (file) =>
        /^src\/lib\/.+\.tsx?$/.test(file) &&
        !file.includes("/__tests__/") &&
        !/\.(?:test|spec)\.tsx?$/.test(file),
    );
    const patterns = rules().map((rule) => matcher(rule.pattern));
    const owned = srcLib.filter((file) => patterns.some((pattern) => pattern.test(file)));
    // Non-vacuous: the money modules are really in the owned set.
    expect(owned).toContain("src/lib/booking-payment-cleanup.ts");
    expect(owned).toContain("src/lib/payment-transactions.ts");
    expect(
      owned.length / srcLib.length,
      `CODEOWNERS now owns ${owned.length} of ${srcLib.length} non-test src/lib files, above the ${MAX_OWNED_SRC_LIB_SHARE * 100}% ceiling set from the measured money surface. A glob has probably gone too broad: tighten it. Raise the ceiling only for new money modules, and say which.`,
    ).toBeLessThanOrEqual(MAX_OWNED_SRC_LIB_SHARE);
  });

  it("stays scoped outside src/lib: every pattern starts with an allowed prefix, and few files are owned there", () => {
    const outside = rules()
      .filter((rule) => !ALLOWED_PREFIXES.some((prefix) => rule.pattern.startsWith(prefix)))
      .map((rule) => `line ${rule.line}: ${rule.pattern}`);
    expect(
      outside,
      "CODEOWNERS owns the money surface only. A pattern outside these prefixes needs the prefix added to ALLOWED_PREFIXES with the money reason, in the same pull request.",
    ).toEqual([]);
    const patterns = rules().map((rule) => matcher(rule.pattern));
    const ownedOutside = tracked.filter(
      (file) => !file.startsWith("src/lib/") && patterns.some((pattern) => pattern.test(file)),
    );
    expect(ownedOutside.length).toBeGreaterThan(0);
    expect(
      ownedOutside.length,
      `CODEOWNERS owns ${ownedOutside.length} files outside src/lib (ceiling ${MAX_OWNED_OUTSIDE_SRC_LIB}). A route or docs glob has gone too broad: name the money routes instead.`,
    ).toBeLessThanOrEqual(MAX_OWNED_OUTSIDE_SRC_LIB);
  });

  it("owns every module known to move money, including every money seam", () => {
    const seamModules = [
      ...readFileSync(path.join(ROOT, "src", "lib", "__tests__", "money-seam-mock-census.test.ts"), "utf8").matchAll(
        /\bmodule:\s*"(src\/[^"]+)"/g,
      ),
    ].map((match) => `${match[1]}.ts`);
    expect(seamModules.length).toBeGreaterThanOrEqual(3);
    const patterns = rules().map((rule) => matcher(rule.pattern));
    const unowned = [...MUST_BE_OWNED, ...seamModules].filter(
      (file) => !patterns.some((pattern) => pattern.test(file)),
    );
    const untracked = [...MUST_BE_OWNED, ...seamModules].filter((file) => !tracked.includes(file));
    expect(untracked, "A known money module moved: update MUST_BE_OWNED and CODEOWNERS together.").toEqual([]);
    expect(
      unowned,
      "These modules move money and no CODEOWNERS pattern owns them, so a change to them needs no owner Approve. Add a pattern.",
    ).toEqual([]);
  });
});
