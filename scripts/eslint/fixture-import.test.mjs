import { ESLint } from "eslint";

it("refuses a journey that bypasses the accessibility fixture", async () => {
  const eslint = new ESLint();
  const [bad] = await eslint.lintText('import { test as suite } from "@playwright/test"; suite("page", async () => {});', { filePath: "e2e/import-probe.spec.ts" });
  expect(bad.messages.some((message) => message.ruleId === "no-restricted-imports")).toBe(true);
  const [good] = await eslint.lintText('import { test } from "./helpers/accessibility"; test("page", async () => {});', { filePath: "e2e/import-probe.spec.ts" });
  expect(good.messages.filter((message) => message.ruleId === "no-restricted-imports")).toEqual([]);
  // Loading the full repository config takes ~2.5s alone and over 5s on a busy
  // runner; same allowance as ratchet.test.mjs.
}, 20_000);
