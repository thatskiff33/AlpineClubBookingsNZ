import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { chromiumSpecFiles } from "./e2e-spec-shard.mjs";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it("runs only the member, booking and payment specs on a phone before the setup gate", async () => {
  vi.stubEnv("E2E_SHARD", "1/3");
  const { default: config } = await import("../../playwright.config");
  const mobile = config.projects?.find((project) => project.name === "mobile");
  expect(mobile?.use?.isMobile).toBe(true);
  expect(mobile?.use?.hasTouch).toBe(true);
  expect(mobile?.dependencies).toEqual(["chromium"]);
  const pattern = mobile?.testMatch;
  expect(pattern).toBeInstanceOf(RegExp);
  const files = chromiumSpecFiles(path.resolve("e2e"));
  expect(files.filter((file) => (pattern as RegExp).test(`/e2e/${file}`))).toEqual([
    "booking.spec.ts", "member-notices.spec.ts", "stripe-payment.spec.ts",
  ]);
  expect(config.projects?.find((project) => project.name === "pre-setup")?.dependencies).toContain("mobile");
});

it("does not repeat mobile on another shard", async () => {
  vi.stubEnv("E2E_SHARD", "2/3");
  const { default: config } = await import("../../playwright.config");
  expect(config.projects?.some((project) => project.name === "mobile")).toBe(false);
});
