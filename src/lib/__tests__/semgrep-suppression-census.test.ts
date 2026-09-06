import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every `nosemgrep` annotation in the tree, pinned by name (#2842).
 *
 * ENFORCES `INV-SSOT-004`: the population is measured here, once, and this is
 * the fact — not a number restated in prose that drifts the moment somebody
 * adds an annotation.
 *
 * WHY THIS EXISTS, and it is not hypothetical. #2842 measured the suppressions
 * with `--disable-nosem` and deleted the 117 that suppressed nothing the
 * blocking gate can emit. Two things then went wrong that only a census
 * catches:
 *
 *  - the original census grepped `src/`, `scripts/` and `prisma/` and MISSED
 *    `e2e/`, which the blocking scan does read — the invocation excludes only
 *    `node_modules`, `.next` and `.semgrep/tests`, and there is no
 *    `.semgrepignore`. Three annotations lived there uncounted, so every
 *    published figure was wrong;
 *  - a fourth arrived DURING the branch's own life, through a mid-branch merge
 *    of #3214, after the census had run.
 *
 * A one-time sweep cannot hold a population. This can, and it is offline, so
 * it costs milliseconds and needs no scanner.
 *
 * ADDING ONE IS NOT FORBIDDEN — it is required to be justified. Run the
 * `--disable-nosem` command in `docs/MAINTENANCE.md` -> "Two Semgrep scans run
 * per pull request". If it reports no finding at your line, the annotation
 * suppresses nothing and is noise the next census has to re-disprove. If it
 * does, add the site here with the rule id and the reason.
 */

const REPO_ROOT = path.resolve(__dirname, "../../..");

/** Extensions Semgrep's four registry packs plus `.semgrep/rules` actually read. */
const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/**
 * Directories the blocking invocation excludes (`ci.yml` -> `static-analysis`),
 * plus VCS/build noise that is not tracked source. `.semgrep/tests` is excluded
 * there because every file in it is a deliberate violation.
 */
const UNSCANNED_DIRECTORIES = new Set([
  ".git",
  ".next",
  "node_modules",
  ".artifacts",
  "coverage",
  "playwright-report",
  "test-results",
]);

/**
 * An annotation naming a rule id, which is the only kind that suppresses
 * anything. This deliberately does NOT match the bare word in a docblock:
 * `filter-suppressed-sarif.mjs` and two test files discuss `nosemgrep` at
 * length and must not read as annotations.
 */
const ID_BEARING_ANNOTATION = /nosemgrep: *([a-z][A-Za-z0-9_.-]+)/g;

/**
 * THE JUSTIFIED SURVIVORS, and the whole content of this contract.
 *
 * Measured for #2842 on the pinned CI image `semgrep/semgrep:1.161.0`, by
 * re-running the exact blocking invocation with `--disable-nosem`: these three
 * sites are the ONLY findings in the tree, so they are the only annotations
 * that suppress anything. 120 annotations existed before that measurement and
 * 117 were deleted.
 */
const JUSTIFIED_SUPPRESSIONS = [
  {
    file: "src/components/club-post-editor.tsx",
    rule: "typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml",
    why: "Member HTML seeded once into an uncontrolled editor, sanitised through the board allowlist; the only react-dangerouslysetinnerhtml finding in the tree.",
  },
  {
    file: "src/lib/audit-retention.ts",
    rule: "acb-unsafe-raw-sql",
    why: "DDL generated from the committed column manifest; no request-reachable input.",
  },
  {
    file: "src/lib/booking-envelope-invariants.ts",
    rule: "acb-unsafe-raw-sql",
    why: "SET CONSTRAINTS generated from a committed two-element const array; no argument and no request-reachable input.",
  },
] as const;

function scannedFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (UNSCANNED_DIRECTORIES.has(entry.name)) continue;
      scannedFiles(path.join(dir, entry.name), found);
    } else if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

function censusOfAnnotations(): { file: string; rule: string }[] {
  const found: { file: string; rule: string }[] = [];
  for (const absolute of scannedFiles(REPO_ROOT)) {
    const source = readFileSync(absolute, "utf8");
    if (!source.includes("nosemgrep")) continue;
    for (const match of source.matchAll(ID_BEARING_ANNOTATION)) {
      found.push({
        file: path.relative(REPO_ROOT, absolute).split(path.sep).join("/"),
        rule: match[1],
      });
    }
  }
  return found.sort(
    (a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule),
  );
}

describe("Semgrep suppression census (#2842)", () => {
  it("holds exactly the justified suppressions, tree-wide", () => {
    expect(
      censusOfAnnotations(),
      [
        "A `nosemgrep` annotation appeared, moved or vanished.",
        "",
        "Every annotation must suppress a finding the BLOCKING gate can emit, and",
        "must be justified at the call site. Prove it before adding one: run the",
        '`--disable-nosem` command in docs/MAINTENANCE.md -> "Two Semgrep scans run',
        'per pull request". No finding at your line means the annotation suppresses',
        "nothing — 117 like that were deleted by #2842.",
        "",
        "If it is justified, add it to JUSTIFIED_SUPPRESSIONS with its rule id and",
        "reason. If you removed one, delete its entry here in the same change.",
      ].join("\n"),
    ).toEqual(
      JUSTIFIED_SUPPRESSIONS.map(({ file, rule }) => ({ file, rule })).sort(
        (a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule),
      ),
    );
  });

  it("scans e2e/, the directory the first census missed", () => {
    // The specific regression this suite was written for. `e2e/` is tracked,
    // the blocking scan reads it, and three annotations hid there through an
    // entire census. If the walker stops covering it, this contract silently
    // stops being able to catch what it was written to catch.
    const covered = scannedFiles(REPO_ROOT).map((file) =>
      path.relative(REPO_ROOT, file).split(path.sep).join("/"),
    );

    expect(covered).toContain("e2e/helpers/stay-dates.ts");
    expect(covered.some((file) => file.startsWith("src/"))).toBe(true);
    expect(covered.some((file) => file.startsWith("scripts/"))).toBe(true);
  });

  it("reads a rule id but not the word in prose", () => {
    // Assembled rather than written out, because this suite scans the tree it
    // is part of: a literal annotation here would make the census match its
    // own fixture and report a suppression that does not exist.
    const annotation = `// nose${"mgrep"}: acb-unsafe-raw-sql — why`;
    const prose = "Semgrep honours a `nose" + "mgrep` comment and marks it";

    expect([...annotation.matchAll(ID_BEARING_ANNOTATION)].map((m) => m[1])).toEqual([
      "acb-unsafe-raw-sql",
    ]);
    expect([...prose.matchAll(ID_BEARING_ANNOTATION)]).toEqual([]);
  });
});
