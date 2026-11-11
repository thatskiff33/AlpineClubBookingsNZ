import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ADMIN_PAGES } from "@/lib/admin-hubs";
import type { AdminHubPage } from "@/lib/admin-hubs/define";
import { stripComments } from "@/lib/__tests__/support/strip-comments";

// ---------------------------------------------------------------------------
// No production code spells a moved admin page's old URL as a string literal
// (epic #4468, C5 #4802).
//
// A moved page is linked, redirected to and `router.replace`d to at its
// `adminHref`: the old URL while `ADMIN_HUBS_LIVE` is off, the hub URL once it
// is on. A literal old URL keeps working today, through the redirect the switch
// adds, and so no other test sees it. Once on, it sends the officer through
// that redirect on every link, and a page that `router.replace`s its own
// address to one bounces on every filter change. So every literal that starts
// with a moved page's old path is refused, unless it is listed below with its
// reason. The registry fragments under `src/lib/admin-hubs/` are where the
// paths are declared and are not scanned.
//
// What counts: a `"`, `'` or `` ` `` immediately followed by the old path and
// then the literal's end, `?`, `#`, `/` or `${`, in code with its comments
// removed. A path built by concatenating pieces, or written in JSX text, is
// not seen.
// ---------------------------------------------------------------------------

const ROOT = process.cwd();

/**
 * The deliberate old-path literals: `file` to the literals it may hold, and why.
 * Each must still be found, so a stale entry fails as surely as a new literal.
 */
const ALLOWED: Record<string, { literals: readonly string[]; why: string }> = {
  "src/lib/diagnostics/page-context/registry.ts": {
    literals: [
      '"/admin/payments"',
      '"/admin/stuck-states"',
      '"/admin/health"',
      '"/admin/bookings"',
      '"/admin/booking-requests"',
      '"/admin/waitlist"',
      '"/admin/bed-allocation"',
    ],
    why:
      "a diagnostics row is matched against the help widget's canonicalAdminPathname, " +
      "which is a moved page's OLD path in either switch state",
  },
};

/** Every production `.ts`/`.tsx` file under `src/`, tests and the registry itself left out. */
function productionFiles(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") return [];
      if (rel === "src/lib/admin-hubs") return [];
      return productionFiles(rel);
    }
    if (!/\.tsx?$/.test(entry.name) || /\.(test|spec)\.tsx?$/.test(entry.name)) return [];
    return [rel];
  });
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A moved page's old path up to its first dynamic segment: what a literal can spell. */
function staticOldPath(page: AdminHubPage): string {
  const cut = page.oldPath.search(/\/\[/);
  return cut === -1 ? page.oldPath : page.oldPath.slice(0, cut);
}

/** A pattern finding a string literal that starts with one of `paths`. */
function oldPathLiteralPattern(paths: readonly string[]): RegExp {
  // Longest first, so `/admin/xero/setup` is reported as itself, not as `/admin/xero`.
  const alternatives = [...new Set(paths)]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  return new RegExp(`(["'\`])(${alternatives})(?=["'\`?#/]|\\$\\{)`, "g");
}

/** `file:line: literal` for every old-path literal in `source`. */
function findOldPathLiterals(file: string, source: string, pattern: RegExp): string[] {
  const code = stripComments(source);
  const found: string[] = [];
  for (const match of code.matchAll(pattern)) {
    const line = code.slice(0, match.index).split("\n").length;
    const quote = match[1]!;
    found.push(`${file}:${line}: ${quote}${match[2]}${quote}`);
  }
  return found;
}

const MOVED = ADMIN_PAGES.filter((page) => page.moved && page.hubPath !== page.oldPath);
const PATTERN = oldPathLiteralPattern(MOVED.map(staticOldPath));

describe("no production code spells a moved admin page's old URL", () => {
  it("PREMISE: pages have moved, and the scan reads the production tree", () => {
    expect(MOVED.length).toBeGreaterThan(0);
    const files = productionFiles("src");
    expect(files).toContain("src/app/(admin)/admin/finance/payments/page.tsx");
    expect(files).not.toContain("src/lib/admin-hubs/hubs/finance.ts");
    expect(files.some((file) => file.includes("__tests__"))).toBe(false);
  });

  it("finds none outside the reviewed list, and every reviewed one still", () => {
    const found = productionFiles("src").flatMap((file) =>
      findOldPathLiterals(file, fs.readFileSync(path.join(ROOT, file), "utf8"), PATTERN),
    );
    const byFile = new Map<string, string[]>();
    for (const hit of found) {
      const [file, , literal] = hit.split(/:(\d+): /);
      byFile.set(file!, [...(byFile.get(file!) ?? []), literal!]);
    }
    const unreviewed = found.filter((hit) => {
      const [file, , literal] = hit.split(/:(\d+): /);
      return !ALLOWED[file!]?.literals.includes(literal!);
    });
    expect(
      unreviewed,
      "Link a moved page with adminHref / adminLink / adminAnchorHref (or servedAdminPathname for " +
        "a path read from the router); key help by getAdminPage(id).oldPath. A literal that must " +
        "stay the old path goes in ALLOWED with its reason.",
    ).toEqual([]);
    const stale = Object.entries(ALLOWED).flatMap(([file, { literals }]) =>
      literals
        .filter((literal) => !(byFile.get(file) ?? []).includes(literal))
        .map((literal) => `${file}: ${literal}`),
    );
    expect(stale, "a reviewed literal is gone: drop it from ALLOWED").toEqual([]);
  });

  it("reports each spelling a moved page's URL is written in, and leaves the rest alone", () => {
    // The scanner's own cases, against a synthetic file.
    const pattern = oldPathLiteralPattern(["/admin/xero", "/admin/xero/setup", "/admin/payments"]);
    const source = [
      'const a = "/admin/payments";',
      "const b = `/admin/payments?${query}`;",
      "router.replace('/admin/xero/setup#webhooks');",
      'const c = `/admin/xero/records/${model}/${id}`;',
      "const d = `/admin/payments${suffix}`;",
      '<Link href="/admin/xero">Xero</Link>',
      'fetch("/api/admin/payments");',
      'const e = "/admin/payments-archive";',
      'const f = "/admin/xeroish";',
      "// a comment naming \"/admin/payments\"",
      "/* and a block: '/admin/xero' */",
      'const g = adminHref("payments");',
    ].join("\n");
    expect(findOldPathLiterals("x.tsx", source, pattern)).toEqual([
      'x.tsx:1: "/admin/payments"',
      "x.tsx:2: `/admin/payments`",
      "x.tsx:3: '/admin/xero/setup'",
      "x.tsx:4: `/admin/xero`",
      "x.tsx:5: `/admin/payments`",
      'x.tsx:6: "/admin/xero"',
    ]);
  });
});
