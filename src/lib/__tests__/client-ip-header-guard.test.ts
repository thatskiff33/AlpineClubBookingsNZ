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
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

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
    expect(CLIENT_IP_HEADER_ARMS.length).toBe(5);
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
      'export const h = { host: "a", "x-forwarded-for": "203.0.113.9" };',
      // The platform headers, so trusting one is a decision made in the helper.
      'export const ip = (r: Request) => r.headers.get("CF-Connecting-IP");',
      'export const ip = (r: Request) => r.headers.get("true-client-ip");',
      'export const ip = (r: Request) => r.headers.get("x-vercel-forwarded-for");',
      'export const ip = (r: Request) => r.headers.get("fly-client-ip");',
      'export const ip = (r: Request) => r.headers.get("Forwarded");',
      "export const ip = (r: Request) => r.headers.has(`forwarded`);",
      'export const ip = (h: Record<string, string>) => h["forwarded"];',
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

  it("leaves the helper's constant, prose and the word forwarded alone", async () => {
    for (const code of [
      'import { FORWARDED_FOR_HEADER } from "@/lib/rate-limit-http";\nexport const h = { [FORWARDED_FOR_HEADER]: "203.0.113.9" };',
      'export const note = "the x-forwarded-for header";',
      // An audit census's evidence kind, and a Sentry scrub list's key part.
      'export const kind = { kind: "forwarded" } as const;\nexport const parts = ["forwarded", "-ip"];',
      'export const same = (k: string) => k === "forwarded";',
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

describe("#5399 census: where a client-address header is named in code", () => {
  // The distinctive names anywhere in code; `forwarded` only in a header-shaped
  // read, because the bare word is prose and an audit-census kind.
  const NAMED =
    /x-forwarded-for|x-real-ip|cf-connecting-ip|true-client-ip|x-vercel-forwarded-for|fly-client-ip|\.(?:get|has)\(\s*["'`]forwarded["'`]|\[\s*["'`]forwarded["'`]\s*\]/i;

  it("finds a client-address header named only in the helper", () => {
    const files = walk(path.join(ROOT, "src"));
    expect(files.length, "the walk found no source; the census would pass vacuously").toBeGreaterThan(500);
    const naming = files
      .filter((full) => NAMED.test(stripComments(readFileSync(full, "utf8"))))
      .map((full) => path.relative(ROOT, full).split(path.sep).join("/"))
      .sort();
    expect(naming).toEqual([HELPER]);
  }, CENSUS_TIMEOUT_MS);
});
