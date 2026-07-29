import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// #2283: every outbound Xero link must be built by the `src/lib/xero-links.ts`
// builders. A hand-rolled `https://go.xero.com/...` string cannot carry the
// organisation SHORT CODE, so on a Xero login with more than one organisation
// it lands the admin in whichever organisation their session last used —
// verified against live Xero by the owner (issue #2283). Twenty-one such links
// across ten admin components were migrated; this guard stops the drift from
// re-accumulating one "quick link" at a time.
//
// Scope (deliberate):
// - `src/` only. E2E specs, scripts and docs may mention Xero URLs freely.
// - `src/lib/xero-links.ts` is the ONE place allowed to spell the host out —
//   that is its job.
// - Test files (`__tests__` directories, `*.test.*` / `*.spec.*`) are
//   excluded: they assert the exact URLs the builders produce and stub
//   builder outputs in mocks, and a literal inside a test cannot mislink an
//   admin. Production fixtures do not get this pass — only test files do.
//
// The pattern requires the host to be preceded by `//` (with or without a
// `https:` / `http:` scheme) rather than matching the bare host, so prose
// comments that merely mention "the generic go.xero.com link" stay legal —
// there are three such comments in `src/` today — while an actual URL in a
// comment still fails, which errs on the loud side. Protocol-relative
// (`//go.xero.com/…`) and plain-`http` spellings are caught too: they mislink
// an admin exactly as an `https` literal does.
//
// What this guard CANNOT catch, stated plainly so nobody reads a green run as
// more than it is: a URL assembled from pieces (`"https://" + XERO_HOST + …`,
// a template literal split across lines, a host in a config constant), and
// anything inside an excluded test file. It is a drift brake on the obvious
// mistake — one more hand-written "quick link" — not a proof.

const FORBIDDEN = /(?:https?:)?\/\/go\.xero\.com/;
const ALLOWED_FILES = new Set(["src/lib/xero-links.ts"]);
const SOURCE_EXTENSIONS = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const TEST_FILE = /\.(?:test|spec)\.[^./]+$/;

function collectSourceFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      collectSourceFiles(full, out);
    } else if (
      SOURCE_EXTENSIONS.test(entry.name) &&
      !TEST_FILE.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("xero-links guard (#2283)", () => {
  it("keeps every go.xero.com URL inside src/lib/xero-links.ts", () => {
    const root = process.cwd();
    const offenders: string[] = [];

    for (const file of collectSourceFiles(join(root, "src"), [])) {
      const relPath = relative(root, file).replace(/\\/g, "/");
      if (ALLOWED_FILES.has(relPath)) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (FORBIDDEN.test(line)) {
          offenders.push(`${relPath}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(
      offenders,
      `Inline go.xero.com URL(s) found. Build Xero links with the builders in ` +
        `src/lib/xero-links.ts (buildXeroContactUrl / buildXeroInvoiceUrl / ` +
        `buildXeroCreditNoteUrl / buildXeroReportsUrl / buildXeroDashboardUrl), ` +
        `passing the organisation short code from useXeroOrgShortCode where the ` +
        `surface has one — a hand-rolled URL cannot target the club's ` +
        `organisation on a multi-org Xero login (#2283).\n\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  // The pattern itself, pinned in both directions: it must keep catching the
  // non-`https` spellings that mislink an admin just as badly, without
  // starting to fail the three prose mentions of the bare host that live in
  // `src/` today (go-to-xero-button.tsx, use-xero-org-short-code.ts,
  // xero-organisation.ts).
  it("matches URL spellings of the host but not prose mentions of it", () => {
    for (const line of [
      `const url = "https://go.xero.com/Dashboard/";`,
      `const url = "http://go.xero.com/Dashboard/";`,
      `const url = "//go.xero.com/Dashboard/";`,
      `<a href="https://go.xero.com/Contacts/View/abc">Open in Xero</a>`,
    ]) {
      expect(FORBIDDEN.test(line), line).toBe(true);
    }
    for (const line of [
      ` * back to the generic go.xero.com dashboard path, which resolves for a`,
      ` * loading, or the read failed. Callers then build the generic go.xero.com`,
      ` * Callers must treat null as "build the generic go.xero.com link" — never as`,
    ]) {
      expect(FORBIDDEN.test(line), line).toBe(false);
    }
  });

  // The guard is only as good as its file walk: if the walker silently
  // stopped finding the migrated components, the assertion above would pass
  // on an empty set forever. Pin one known consumer as a canary.
  it("actually walks the migrated components (walker canary)", () => {
    const root = process.cwd();
    const files = collectSourceFiles(join(root, "src"), []).map((file) =>
      relative(root, file).replace(/\\/g, "/"),
    );
    expect(files).toContain(
      "src/app/(admin)/admin/xero/_components/sync-results-panel.tsx",
    );
    expect(files).toContain("src/lib/xero-links.ts");
    // And the exclusions hold: no test files in the walked set.
    expect(files.some((file) => TEST_FILE.test(file))).toBe(false);
    expect(files.some((file) => file.includes("__tests__"))).toBe(false);
  });
});
