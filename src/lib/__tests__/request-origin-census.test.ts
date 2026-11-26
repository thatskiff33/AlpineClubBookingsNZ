/**
 * No link is built from the address a request claims (GHSA-q9f4-243m-6f54).
 *
 * `Host`, `X-Forwarded-Host`, `request.nextUrl` (which Next.js derives from
 * them) and `request.url` used as the base of a new address are whatever the
 * caller sent wherever a proxy does not overwrite them. A link the club emails,
 * stores or shows is built from the configured origin, `getAppBaseUrl()`, which
 * takes no argument for that reason.
 *
 * This census reads every production source file under `src/`, with comments
 * removed by the shared `stripComments`, and fails on a read of one of those
 * outside the expressions listed below with a reason. It matches text, so it
 * also catches a read that is not (yet) used for a link: read the configured
 * origin instead, or list the exact expression here and say why it is safe.
 *
 * What it does not see, stated so nobody takes it for more than it is: a header
 * name held in a constant, a loop over every header, the request's address
 * copied to a variable first or read through another name (`r.url`,
 * `ctx.req.url`), the request's address inside a template string, and
 * `new URL(request.url)` changed and then redirected to. `request.url` is read
 * in many routes for its query string alone, which is why only its use as a
 * base address, as a fallback, or for its host is matched.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

/** Exact expressions that may read the request's own origin, and why. */
const ALLOWED: ReadonlyArray<{ file: string; expression: string; reason: string }> = [
  {
    file: "src/proxy.ts",
    expression: "selfOrigin: request.nextUrl.origin",
    reason:
      "Adds the request's own origin to `connect-src` in the Content-Security-Policy of the response to that same request, on the display pages only. It reaches no other visitor, no email and no stored row.",
  },
  {
    file: "src/app/api/auth/[...nextauth]/route.ts",
    expression: "authRateLimitedResponse(rateLimitResponse, request.url)",
    reason:
      "The sign-in rate-limit answer carries a login address built from the request's own URL, returned in the body of the response to that same request. It reaches no other visitor, no email and no stored row.",
  },
];

const READS: ReadonlyArray<{ what: string; pattern: RegExp }> = [
  {
    what: "request.nextUrl's origin, host, hostname or href",
    pattern: /\bnextUrl\s*\??\.\s*(?:origin|host|hostname|href)\b/,
  },
  {
    what: "the Host or X-Forwarded-Host header",
    pattern: /\.\s*(?:get|has)\(\s*["'`](?:x-forwarded-host|host)["'`]\s*\)/i,
  },
  {
    what: "the Host or X-Forwarded-Host header",
    pattern: /\[\s*["'`](?:x-forwarded-host|host)["'`]\s*\]/i,
  },
  {
    what: "the Host header",
    pattern: /\bheaders\s*\??\.\s*host\b/,
  },
  {
    what: "request.url as a fallback address",
    pattern: /(?:\|\||\?\?)\s*(?:request|req)\s*\.\s*url\b/,
  },
  {
    what: "the request's address as the base of a new address, or handed to a helper as one",
    pattern: /,\s*(?:request|req)\s*\??\.\s*(?:url|nextUrl)\s*\)/,
  },
  {
    what: "a copy of request.nextUrl, which carries the request's host",
    pattern: /\bnextUrl\s*\??\.\s*clone\s*\(/,
  },
  {
    what: "the origin, host or href of the request's own URL",
    pattern: /new URL\(\s*(?:request|req)\s*\??\.\s*url\s*\)\s*\.\s*(?:origin|host|hostname|href)\b/,
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

/** The file's code with comments removed and its allowed expressions taken out. */
function codeToCheck(file: string): string {
  let code = stripComments(readFileSync(file, "utf8"));
  for (const allowed of ALLOWED) {
    if (allowed.file === file) {
      code = code.split(allowed.expression).join("");
    }
  }
  return code;
}

function readsFound(code: string): string[] {
  return READS.filter(({ pattern }) => pattern.test(code)).map(({ what }) => what);
}

describe("the request's claimed origin is not read", () => {
  it(
    "outside the expressions listed with a reason",
    () => {
      const found: string[] = [];
      for (const file of productionSourceFiles()) {
        for (const what of readsFound(codeToCheck(file))) {
          found.push(`${file}: reads ${what}`);
        }
      }
      expect(found).toEqual([]);
    },
    CENSUS_TIMEOUT_MS
  );

  it(
    "and every listed expression is still there, exactly once",
    () => {
      for (const { file, expression } of ALLOWED) {
        const code = stripComments(readFileSync(file, "utf8"));
        expect(
          code.split(expression).length - 1,
          `${file} no longer contains \`${expression}\` exactly once; update ALLOWED`
        ).toBe(1);
      }
    },
    CENSUS_TIMEOUT_MS
  );

  it("recognises each way of reading it", () => {
    const reads = [
      "getAppBaseUrl(request.nextUrl.origin)",
      "const o = req?.nextUrl?.origin;",
      "const h = request.nextUrl.host;",
      "const h = request.nextUrl.hostname;",
      "const h = request.nextUrl.href;",
      'request.headers.get("x-forwarded-host")',
      "headers.get('Host')",
      "h.has(`X-Forwarded-Host`)",
      'req.headers["host"]',
      "const host = req.headers.host;",
      "const baseUrl = process.env.NEXTAUTH_URL || request.url;",
      "const baseUrl = configured ?? req.url;",
      'new URL("/login", request.url)',
      'NextResponse.redirect(new URL(buildLoginPath("/x"), request.url))',
      'new URL("/login", request.nextUrl)',
      "const url = request.nextUrl.clone();",
      "const { origin } = { origin: new URL(request.url).origin };",
      "const host = new URL(req.url).host;",
      "authRateLimitedResponse(denial, request.url)",
      'p.replace(/\\//g, "_"); const o = req.nextUrl.origin;',
      'const glob = "src/*"; const h = request.headers.get("host"); const end = "*/";',
    ];
    for (const sample of reads) {
      expect(readsFound(stripComments(sample)), sample).not.toEqual([]);
    }
    const harmless = [
      '"x-forwarded-host": options.hostHeader,',
      "new URL(getAppBaseUrl()).origin",
      "const origin = window.location.origin;",
      "// request.nextUrl.origin is never read here",
      "/* request.headers.get('host') */",
      "const { searchParams } = new URL(request.url);",
      "const page = request.nextUrl.searchParams.get('page');",
      "const path = request.nextUrl.pathname;",
      "const protocol = new URL(request.url).protocol;",
      "getExpiredXeroOAuthStateCookieOptions(request.url)",
    ];
    for (const sample of harmless) {
      expect(readsFound(stripComments(sample)), sample).toEqual([]);
    }
  });
});
