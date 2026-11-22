import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

import {
  CLIENT_IP_HEADER_ARMS,
  MANDATORY_SRC_RESTRICTIONS,
  SRC_RESTRICTION_EXEMPTIONS,
} from "../../../eslint.config.mjs";
import { auditEnforcedGuardCoverage } from "./support/eslint-guard-coverage";
import { stripComments } from "./support/strip-comments";

/**
 * #5399: the caller's IP has one rule (last `X-Forwarded-For` address, then
 * `X-Real-IP`), and it lives in `src/lib/rate-limit-http.ts`. Twenty-five route
 * sites had restated it wrongly, reading the FIRST address, which is whatever
 * the caller sent.
 *
 * The lint arm is the enforcement. This suite lints real snippets through the
 * shipping config at real paths, and walks `src/` for either header name in
 * code (comments stripped) so a spelling past every selector still shows up.
 * Disk-scanning: run by name.
 */
const ROOT = process.cwd();
const PREFIX = "#5399: Read the caller's IP";
const HELPER = "src/lib/rate-limit-http.ts";
const READ = 'export const ip = (r: Request) => r.headers.get("x-forwarded-for");\n';

let eslint: ESLint;

beforeAll(async () => {
  eslint = new ESLint({ cwd: ROOT, warnIgnored: false });
  await eslint.lintText("export const x = 1;\n", {
    filePath: path.join(ROOT, "src/lib/warmup.ts"),
  });
}, 120_000);

async function hits(code: string, file: string): Promise<number> {
  const results = await eslint.lintText(code, { filePath: path.join(ROOT, file) });
  const messages = results.flatMap((result) => result.messages);
  expect(messages.filter((m) => m.fatal), `${file}: ${code}`).toEqual([]);
  return messages.filter(
    (m) => m.ruleId === "no-restricted-syntax" && (m.message ?? "").startsWith(PREFIX),
  ).length;
}

const exemptFiles = new Set(
  SRC_RESTRICTION_EXEMPTIONS.filter((exemption) =>
    exemption.omits.some((r: { selector: string }) => CLIENT_IP_HEADER_ARMS.includes(r.selector)),
  ).flatMap((exemption) => exemption.files),
);

describe("#5399: no direct read of the caller's IP headers", () => {
  it("is on the mandatory set, lifted only for the helper", () => {
    const mandatory = new Set(
      MANDATORY_SRC_RESTRICTIONS.map((r: { selector: string }) => r.selector),
    );
    expect(CLIENT_IP_HEADER_ARMS.length).toBe(2);
    for (const selector of CLIENT_IP_HEADER_ARMS) expect(mandatory.has(selector), selector).toBe(true);
    expect([...exemptFiles]).toEqual([HELPER]);
  });

  it("refuses every spelling of a read, on routes, libraries, screens and scripts", async () => {
    const spellings = [
      READ,
      'export const ip = (r: Request) => r.headers.get("X-Real-IP");',
      "export const ip = (r: Request) => r.headers.get(`x-forwarded-for`);",
      'const H = "x-forwarded-for";\nexport const ip = (r: Request) => r.headers.get(H);',
      'export const ip = (h: Record<string, string>) => h["x-real-ip"];',
      'export const { "x-forwarded-for": ip } = {} as Record<string, string>;',
    ];
    for (const file of [
      "src/app/api/admin/x/route.ts",
      "src/lib/x.ts",
      "src/components/x.tsx",
      "scripts/x.ts",
    ]) {
      for (const code of spellings) expect(await hits(code, file), `${file}: ${code}`).toBe(1);
    }
  });

  it("leaves a header written onto an outgoing request, and prose, alone", async () => {
    for (const code of [
      'export const h = { host: "a", "x-forwarded-for": "203.0.113.9" };',
      'export const note = "the x-forwarded-for header";',
    ]) {
      expect(await hits(code, "src/lib/x.ts"), code).toBe(0);
    }
    expect(await hits(READ, HELPER)).toBe(0);
  });

  it("fires at every production path on the shared roster", async () => {
    const problems = await auditEnforcedGuardCoverage({
      eslint,
      repoRoot: ROOT,
      violatingCode: READ,
      messagePrefix: PREFIX,
      isExempt: (file) => exemptFiles.has(file),
    });
    expect(problems).toEqual([]);
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "__tests__" && name !== "node_modules") walk(full, out);
    } else if (/\.[cm]?[jt]sx?$/.test(name) && !/\.test\.[cm]?[jt]sx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe("#5399 census: where either header is named in code", () => {
  /** Each file allowed to name a header, with why. Stale entries fail too. */
  const ALLOWED: Record<string, string> = {
    [HELPER]: "the one reader of both headers",
    "src/lib/mcp/dispatch.ts":
      "WRITES x-forwarded-for onto the AI app's loopback request so the route's getClientIp() sees the provider's address",
  };

  it("finds the header names only in the helper and the loopback writer", () => {
    const files = walk(path.join(ROOT, "src"));
    expect(files.length, "the walk found no source; the census would pass vacuously").toBeGreaterThan(500);
    const naming = files
      .filter((full) => /x-(forwarded-for|real-ip)/i.test(stripComments(readFileSync(full, "utf8"))))
      .map((full) => path.relative(ROOT, full).split(path.sep).join("/"))
      .sort();
    expect(naming).toEqual(Object.keys(ALLOWED).sort());
  });
});
