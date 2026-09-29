import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  KNOWN_UNNONCED_PRERENDERS,
  auditPrerenderedHtml,
  checkBuildOutput,
  findUnnoncedInlineScripts,
} from "./check-prerendered-script-nonces.mjs";

/**
 * Unit coverage for the pure half of the prerendered-nonce gate (#2356). The
 * gate itself runs against real build output in CI, after `pnpm run build`;
 * these tests pin the RULES so a future edit cannot loosen them silently.
 */

const NONCE = "ZTljYzE2MmUtMTVhYi00YzliLWI4YTk";

describe("findUnnoncedInlineScripts", () => {
  it("flags an inline script with no nonce", () => {
    const html = `<html><body><script>self.__next_f.push([0])</script></body></html>`;
    expect(findUnnoncedInlineScripts(html)).toEqual(["<script>"]);
  });

  it("accepts an inline script carrying a nonce", () => {
    const html = `<script nonce="${NONCE}">self.__next_f.push([0])</script>`;
    expect(findUnnoncedInlineScripts(html)).toEqual([]);
  });

  it("ignores external scripts, which script-src 'self' already covers", () => {
    const html = `<script src="/_next/static/chunks/a.js" async=""></script>`;
    expect(findUnnoncedInlineScripts(html)).toEqual([]);
  });

  it("treats an EMPTY nonce as unnonced", () => {
    // `nonce=""` matches no 'nonce-…' source expression, so the browser blocks
    // the script exactly as if the attribute were absent. Accepting it would be
    // the silent pass this guard exists to prevent.
    const html = `<script nonce="">alert(1)</script>`;
    expect(findUnnoncedInlineScripts(html)).toEqual([`<script nonce="">`]);
  });

  it("finds every offender in a document, not just the first", () => {
    const html = `<script>a</script><script nonce="${NONCE}">b</script><script>c</script>`;
    expect(findUnnoncedInlineScripts(html)).toHaveLength(2);
  });

  it("ignores data blocks the browser never executes", () => {
    // CSP's script-src does not govern a non-executable type, so failing the
    // build over an unnonced JSON-LD structured-data block would be a false
    // positive that blocks a legitimate SEO change for no security reason.
    const html = `
      <script type="application/ld+json">{"@type":"Organization"}</script>
      <script type="application/json">{"a":1}</script>
      <script TYPE=' Application/LD+JSON '>{"@type":"Event"}</script>
    `;
    expect(findUnnoncedInlineScripts(html)).toEqual([]);
  });

  it("still flags executable types, including module and importmap", () => {
    // script-src DOES enforce these, so none of them may be waved through by the
    // data-block carve-out above.
    const html = `
      <script type="module">import "./a.js"</script>
      <script type="importmap">{"imports":{}}</script>
      <script type="text/javascript">alert(1)</script>
      <script type="applicaton/ld+json">{"typo":"in the type"}</script>
    `;
    expect(findUnnoncedInlineScripts(html)).toHaveLength(4);
  });
});

describe("auditPrerenderedHtml", () => {
  const allowlist = new Map([["server/app/_global-error.html", "documented reason"]]);

  it("passes when every prerendered artefact is nonced", () => {
    const artefacts = new Map([
      ["server/app/_global-error.html", `<script>bootstrap</script>`],
      ["server/app/other.html", `<script nonce="${NONCE}">ok</script>`],
    ]);
    expect(auditPrerenderedHtml(artefacts, allowlist)).toEqual({
      offenders: [],
      staleAllowances: [],
    });
  });

  it("reports a NEW prerendered route that ships unnonced inline scripts", () => {
    // The regression this whole check exists for: someone adds a prerendered
    // page (or drops a `force-dynamic`) and the CSP silently blocks its scripts.
    const artefacts = new Map([
      ["server/app/_global-error.html", `<script>bootstrap</script>`],
      ["server/app/_not-found.html", `<script>self.__next_f.push([0])</script>`],
    ]);
    const { offenders } = auditPrerenderedHtml(artefacts, allowlist);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].file).toBe("server/app/_not-found.html");
    expect(offenders[0].count).toBe(1);
  });

  it("reports an allowlisted artefact the build no longer emits", () => {
    const { staleAllowances } = auditPrerenderedHtml(new Map(), allowlist);
    expect(staleAllowances).toHaveLength(1);
    expect(staleAllowances[0]).toContain("was not emitted by the build");
  });

  it("reports an allowlisted artefact that has stopped offending", () => {
    // If a Next release starts nonce-ing the global error page, the carve-out
    // must be deleted rather than quietly outliving its reason.
    const artefacts = new Map([
      ["server/app/_global-error.html", `<script nonce="${NONCE}">bootstrap</script>`],
    ]);
    const { staleAllowances } = auditPrerenderedHtml(artefacts, allowlist);
    expect(staleAllowances).toHaveLength(1);
    expect(staleAllowances[0]).toContain("delete the carve-out");
  });

  it("keeps the shipped allowlist closed and documented", () => {
    // Adding an entry here is a deliberate, reviewed act: each one is a page
    // whose scripts our own CSP blocks in production.
    expect([...KNOWN_UNNONCED_PRERENDERS.keys()]).toEqual([
      "server/app/_global-error.html",
      "server/pages/500.html",
    ]);
    for (const reason of KNOWN_UNNONCED_PRERENDERS.values()) {
      expect(reason).toMatch(/#2356/);
    }
  });
});

describe("checkBuildOutput", () => {
  it("throws rather than passing quietly when there is no build output", () => {
    // The failure mode the check must never have: a green result from a run
    // that inspected nothing.
    expect(() => checkBuildOutput("./definitely-not-a-build-dir-2356")).toThrow(
      /must run AFTER `pnpm run build`/,
    );
  });

  it("throws when a scan root is missing, so a moved output dir cannot pass", () => {
    // Today the allowlist masks this: its entries are asserted to exist, so an
    // empty scan already fails. The day the allowlist is legitimately emptied
    // (Next starts nonce-ing its own shell) that cover disappears, and a renamed
    // output directory would otherwise be reported as a clean scan.
    const distRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nonce-check-"));
    try {
      fs.mkdirSync(path.join(distRoot, "server", "app"), { recursive: true });
      expect(() => checkBuildOutput(distRoot)).toThrow(/Expected build output directories are missing/);
    } finally {
      fs.rmSync(distRoot, { recursive: true, force: true });
    }
  });

  it("throws when both roots exist but hold no HTML at all", () => {
    const distRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nonce-check-"));
    try {
      fs.mkdirSync(path.join(distRoot, "server", "app"), { recursive: true });
      fs.mkdirSync(path.join(distRoot, "server", "pages"), { recursive: true });
      expect(() => checkBuildOutput(distRoot)).toThrow(/must not report success/);
    } finally {
      fs.rmSync(distRoot, { recursive: true, force: true });
    }
  });
});
