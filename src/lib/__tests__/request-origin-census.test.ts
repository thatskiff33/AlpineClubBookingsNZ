/**
 * No link is built from the address a request claims (GHSA-q9f4-243m-6f54).
 *
 * `Host`, `X-Forwarded-Host` and `request.nextUrl.origin` (which Next.js derives
 * from them) are whatever the caller sent wherever a proxy does not overwrite
 * them. A link the club emails, stores or shows is built from the configured
 * origin, `getAppBaseUrl()`, which takes no argument for that reason.
 *
 * This census reads every production source file under `src/` and fails on a
 * read of one of those three, outside the files listed below with a reason.
 * It matches text, so it also catches a read that is not (yet) used for a link:
 * add the file here with the reason, or read the configured origin instead.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

/** Files that may read the request's own origin, and why that is safe there. */
const ALLOWED: Readonly<Record<string, string>> = {
  "src/proxy.ts":
    "Adds the request's own origin to `connect-src` in the Content-Security-Policy of the response to that same request, on the display pages only. It reaches no other visitor, no email and no stored row.",
};

const READS: ReadonlyArray<{ what: string; pattern: RegExp }> = [
  { what: "request.nextUrl.origin", pattern: /\bnextUrl\s*\??\.\s*origin\b/ },
  {
    what: "the Host or X-Forwarded-Host header",
    pattern: /\.\s*(?:get|has)\(\s*["'`](?:x-forwarded-host|host)["'`]\s*\)/i,
  },
  {
    what: "the Host or X-Forwarded-Host header",
    pattern: /\[\s*["'`](?:x-forwarded-host|host)["'`]\s*\]/i,
  },
];

function productionSourceFiles(): string[] {
  return execFileSync("git", ["ls-files", "src"], { encoding: "utf8" })
    .split("\n")
    .filter((file) => /\.(ts|tsx)$/.test(file))
    .filter((file) => !/(^|\/)__tests__\//.test(file))
    .filter((file) => !/\.(test|spec)\.tsx?$/.test(file))
    .filter((file) => !file.startsWith("src/test/"));
}

/** Drops block and line comments so a sentence about the rule is not a read. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("the request's claimed origin is not read", () => {
  it(
    "outside the files listed with a reason",
    () => {
      const found: string[] = [];
      for (const file of productionSourceFiles()) {
        const source = withoutComments(readFileSync(file, "utf8"));
        for (const { what, pattern } of READS) {
          if (pattern.test(source) && !(file in ALLOWED)) {
            found.push(`${file}: reads ${what}`);
          }
        }
      }
      expect(found).toEqual([]);
    },
    CENSUS_TIMEOUT_MS
  );

  it(
    "and every listed file still reads it",
    () => {
      for (const file of Object.keys(ALLOWED)) {
        const source = withoutComments(readFileSync(file, "utf8"));
        expect(
          READS.some(({ pattern }) => pattern.test(source)),
          `${file} no longer reads the request's origin; remove it from ALLOWED`
        ).toBe(true);
      }
    },
    CENSUS_TIMEOUT_MS
  );

  it("recognises each way of reading it", () => {
    const samples = [
      "getAppBaseUrl(request.nextUrl.origin)",
      "const o = req?.nextUrl?.origin;",
      'request.headers.get("x-forwarded-host")',
      "headers.get('Host')",
      "h.has(`X-Forwarded-Host`)",
      'req.headers["host"]',
    ];
    for (const sample of samples) {
      expect(READS.some(({ pattern }) => pattern.test(sample)), sample).toBe(true);
    }
    const harmless = [
      '"x-forwarded-host": options.hostHeader,',
      "new URL(getAppBaseUrl()).origin",
      "const origin = window.location.origin;",
      "// request.nextUrl.origin is never read here",
    ];
    for (const sample of harmless) {
      expect(
        READS.some(({ pattern }) => pattern.test(withoutComments(sample))),
        sample
      ).toBe(false);
    }
  });
});
