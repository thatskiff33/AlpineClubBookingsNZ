import path from "node:path";

import { ESLint, RuleTester } from "eslint";

import testClock from "./test-clock.mjs";

const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: "module" } });
const frozen = (shape) => ({ messageId: "frozen", data: { shape } });

tester.run("no-date-now-elapsed", testClock.rules["no-date-now-elapsed"], {
  valid: [
    // Reading "now" for a fixture is deterministic under the freeze.
    "const past = new Date(Date.now() - 24 * 60 * 60 * 1000);",
    "const DAY_MS = 86_400_000; const past = new Date(Date.now() - DAY_MS);",
    "const issuedAt = Date.now() - 60_000;",
    // Comparing a fixture instant with now: a lockout mock, not a deadline.
    "const locked = member.lockedUntil.getTime() > Date.now();",
    "const expired = Date.now() >= token.expiresAt;",
    // The sanctioned stopwatch and deadline.
    "const started = process.hrtime.bigint(); if (realElapsedMs(started) > 10_000) throw new Error();",
    "const before = performance.now(); const took = performance.now() - before;",
    // A Date.now() reading in another variable's scope does not leak.
    "function a() { const start = Date.now(); return start; } function b(start) { return Date.now() - start; }",
  ],
  invalid: [
    { code: "const start = Date.now(); await work(); expect(Date.now() - start).toBeLessThan(20);", errors: [frozen("a stopwatch")] },
    { code: "let start; start = Date.now(); const took = Date.now() - start;", errors: [frozen("a stopwatch")] },
    { code: "const took = Date.now() - Date.now();", errors: [frozen("a stopwatch")] },
    { code: "const deadline = Date.now() + 10_000; while (Date.now() < deadline) await poll();", errors: [frozen("a deadline")] },
    { code: "const deadline = Date.now() + 5000; for (;;) { if (Date.now() > deadline) throw new Error(); }", errors: [frozen("a deadline")] },
    { code: "let until; until = Date.now() + 100; if (until <= Date.now()) stop();", errors: [frozen("a deadline")] },
    { code: "if (Date.now() > Date.now() + 1) stop();", errors: [frozen("a deadline")] },
    { code: "const start = globalThis.Date.now(); const took = globalThis.Date.now() - start;", errors: [frozen("a stopwatch")] },
  ],
});

// The shipped config, not a copy: the rule runs on Vitest files and is off for
// the Playwright suite, which keeps the real clock.
it("runs through eslint.config.mjs on Vitest files only", async () => {
  const eslint = new ESLint({ cwd: process.cwd() });
  const code = "const deadline = Date.now() + 10;\nwhile (Date.now() < deadline) {}\nexport {};\n";
  const lint = async (file) =>
    (await eslint.lintText(code, { filePath: path.join(process.cwd(), file) }))[0].messages
      .filter((message) => message.ruleId === "test-clock/no-date-now-elapsed").length;
  expect(await lint("src/lib/__tests__/clock-probe.test.ts")).toBe(1);
  expect(await lint("scripts/clock-probe.test.mjs")).toBe(1);
  expect(await lint("e2e/clock-probe.spec.ts")).toBe(0);
  expect(await lint("src/lib/clock-probe.ts")).toBe(0);
}, 120_000);
