import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Why `x-forwarded-host` is enough for the pre-cutover warm-up gate (#2566).
 *
 * The gate renders each public page on the target release and the release STORES what
 * it renders, so what the release believes its host to be is load-bearing. The request
 * sets `host` and `x-forwarded-host` both, but only the forwarded one arrives: an HTTP
 * client writes `Host` from the URL authority, which for a loopback warm-up is
 * `127.0.0.1:3000`. Measured on node v22.14 with a request built exactly like
 * `requestOnce`'s — the server saw `host=127.0.0.1:3999`, `xfh=club.example.nz` — and
 * recorded in `warmup-run.ts`'s module header.
 *
 * That is fine TODAY for one reason, and this file is that reason written as a test
 * rather than as a comment: nothing on a public render path reads a request host at
 * all. Absolute URLs and `metadataBase` come from `NEXTAUTH_URL`. The one place in the
 * tree that resolves a request host — the issue-report API — prefers the forwarded
 * value, so it would read the right answer anyway.
 *
 * If that changes, the warm-up would either store pages rendered for the loopback
 * authority or fail every route as an `unexpected-redirect`, and `fetch` cannot send a
 * wire `Host` to fix it. So the change has to be noticed here, at the point where
 * someone can decide to give the gate an HTTP client that can.
 */

const REPO = process.cwd();

function readRepoFile(relativePath: string): string {
  // Test helper: reads a fixed repo file under process.cwd(); relativePath is test-controlled, not user input.
  return fs.readFileSync(path.resolve(REPO, relativePath), "utf8");
}

function sourceFilesUnder(relativeDir: string): string[] {
  const root = path.resolve(REPO, relativeDir);
  const found: string[] = [];

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.tsx?$/.test(entry.name)) {
        found.push(path.relative(REPO, full).split(path.sep).join("/"));
      }
    }
  };

  walk(root);
  return found;
}

/** Reads of the raw `Host` header, in the forms this codebase would use. */
const RAW_HOST_READ =
  /(?:headers\(\)|\.headers)\s*(?:\)\s*)?\.get\(\s*["'`]host["'`]\s*\)|headers\[["'`]host["'`]\]/i;

describe("the warm-up gate's host assumption", () => {
  it("finds no public render path reading the raw Host header", () => {
    const files = [
      "src/proxy.ts",
      "src/app/layout.tsx",
      "src/lib/app-url.ts",
      ...sourceFilesUnder("src/app/(website)"),
    ];

    const offenders = files.filter((file) =>
      RAW_HOST_READ.test(readRepoFile(file)),
    );

    expect(
      offenders,
      "A public render path now reads the raw Host header, which a loopback warm-up cannot set (fetch overwrites it with the URL authority). Either read x-forwarded-host instead, or give src/lib/deploy/warmup-run.ts an HTTP client that can send a wire Host — see that module's header.",
    ).toEqual([]);
  });

  it("keeps the tree's one host reader on the forwarded value first", () => {
    const issueReports = readRepoFile("src/app/api/issue-reports/route.ts");
    const forwarded = issueReports.indexOf('get("x-forwarded-host")');
    const raw = issueReports.indexOf('get("host")');

    expect(forwarded).toBeGreaterThan(-1);
    expect(raw).toBeGreaterThan(forwarded);
  });

  it("sends the forwarded host and proto, and never a client address", () => {
    const warmup = readRepoFile("src/lib/deploy/warmup-run.ts");

    expect(warmup).toContain('"x-forwarded-host": options.hostHeader');
    expect(warmup).toContain('"x-forwarded-proto"');
    // getClientIp() trusts the RIGHTMOST forwarded value, so a warm-up that invented
    // one would be asking the app to trust an address it made up. Matched as a header
    // KEY, so the module header may keep explaining why it is absent.
    expect(warmup).not.toMatch(/["']x-forwarded-for["']\s*:/i);
  });
});
