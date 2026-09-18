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

/**
 * Returns its argument. Fixtures are assembled through it so that no literal
 * annotation ever appears in this file, which scans the tree it lives in — a
 * literal would make the census count its own fixtures.
 */
const chr = (text: string): string => text;

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
 * Every spelling Semgrep actually honours — measured, not assumed.
 *
 * The first version of this census matched the literal id-bearing form only,
 * and that was a HOLE, not a simplification. Probed against this repository's
 * own rules over one raw-SQL violation (the examples below are written without
 * their comment openers on purpose, because this suite scans the file it lives
 * in and a literal one would make it count its own documentation):
 *
 *   bare `nosemgrep`                        SUPPRESSED — every rule on the line
 *   bare `nosem`                            SUPPRESSED
 *   `nosem: acb-unsafe-raw-sql`             SUPPRESSED
 *   `nosemgrep: other.rule,acb-…-raw-sql`   SUPPRESSED — BOTH ids
 *   `nosemgrep:ACB-UNSAFE-RAW-SQL`          not suppressed; it is case-sensitive
 *
 * So the short bare spelling — three characters shorter than the documented
 * one — used to defeat all three instruments at once: the scan reports nothing
 * because the result is suppressed, the census never opened the file because it
 * prefiltered on the longer word, and the SARIF filter withheld the result from
 * code scanning. Upstream Semgrep's own documentation teaches the bare form, so
 * this is reachable by copying from the vendor rather than by doing anything
 * odd. The comma variant is worse in one specific way: appending an id to an
 * already-justified annotation leaves the census row identical while a second
 * rule goes silent, which is why a list is split into every id it names.
 *
 * WHY THE ANCHOR IS SAFE AND NOT A SECOND HOLE. Semgrep honours the directive
 * only at the START of a comment's content, which the same probe established:
 * the same token mid-sentence, or at the END of a comment, is NOT honoured.
 * Anchoring on the comment opener therefore matches exactly what the scanner
 * matches — it is not a heuristic to dodge prose. It also means the five
 * `reason. <directive>` annotations #2842 stripped were never honoured at all,
 * the id sitting at the end of the comment, which independently corroborates
 * the measurement that they suppressed nothing.
 */
const HONOURED_ANNOTATION =
  // `{0,}` rather than `*`: a literal `*` immediately before the token
  // would make this very pattern read its own source as an annotation.
  /(?:\/\/|\/\*|\*)[ \t]{0,}nosem(?:grep)?(?![A-Za-z])[ \t]{0,}(:[ \t]{0,}([^\r\n*]{0,}))?/g;

/** A rule id as Semgrep tokenises one, taken from the head of a list segment. */
const RULE_ID_HEAD = /^[A-Za-z0-9_.-]+/;

/**
 * The marker for an annotation that names NO id.
 *
 * A bare `nosemgrep` suppresses every rule on its line, so it can never be
 * justified per-rule and there is nothing to measure it against. It is its own
 * class, and the census refuses it outright rather than pinning it.
 */
const BARE_ANNOTATION = "(bare — suppresses every rule)";


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
    // Prefilter on the SHORTEST honoured spelling. Prefiltering on the longer
    // one is what let the SHORT bare spelling through without the file ever
    // being opened at all.
    if (!source.includes("nosem")) continue;
    const file = path.relative(REPO_ROOT, absolute).split(path.sep).join("/");

    for (const match of source.matchAll(HONOURED_ANNOTATION)) {
      const idList = match[2];
      if (idList === undefined) {
        found.push({ file, rule: BARE_ANNOTATION });
        continue;
      }
      // Semgrep honours a comma-separated list and suppresses EVERY id in it,
      // so capturing only the first would let a second rule be silenced while
      // the census row stayed identical.
      const ids = idList
        .split(",")
        .map((segment) => segment.trim().match(RULE_ID_HEAD)?.[0])
        .filter((id): id is string => Boolean(id));
      if (ids.length === 0) {
        found.push({ file, rule: BARE_ANNOTATION });
        continue;
      }
      for (const rule of ids) found.push({ file, rule });
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

  it("sees every spelling Semgrep honours, and no prose", () => {
    // The four spellings the first version of this census missed, each probed
    // against the repository's own rules and each measured as SUPPRESSING.
    const read = (text: string) =>
      [...text.matchAll(HONOURED_ANNOTATION)].map((m) => m[2]);

    const bare = chr("//") + " nose" + "mgrep";
    const bareShort = chr("//") + " nose" + "m";
    const shortWithId = chr("//") + " nose" + "m: acb-unsafe-raw-sql";
    const commaList =
      chr("//") + " nose" + "mgrep: other.rule,acb-unsafe-raw-sql";

    expect(read(bare), "a bare annotation names no id").toEqual([undefined]);
    expect(read(bareShort), "the short spelling is honoured too").toEqual([
      undefined,
    ]);
    expect(read(shortWithId)[0]).toContain("acb-unsafe-raw-sql");
    expect(read(commaList)[0]).toContain("other.rule,acb-unsafe-raw-sql");

    // Prose is NOT matched, and that is not a heuristic: Semgrep honours the
    // annotation only at the start of a comment's content, measured, so the
    // anchor is where the scanner's own is.
    expect(read(chr("//") + " Semgrep honours a nose" + "mgrep comment")).toEqual(
      [],
    );
    expect(read(chr("//") + " explain why this is safe nose" + "mgrep")).toEqual(
      [],
    );
    expect(read("const nose" + "mgrep = 1;")).toEqual([]);
  });

  it("splits a comma list into every id it names", () => {
    // Appending an id to an existing justified annotation would otherwise
    // leave the census row identical while a second rule went silent.
    const source =
      chr("//") + " nose" + "mgrep: other.rule,acb-unsafe-raw-sql\n";
    const ids = [...source.matchAll(HONOURED_ANNOTATION)].flatMap((m) =>
      (m[2] ?? "")
        .split(",")
        .map((segment) => segment.trim().match(RULE_ID_HEAD)?.[0])
        .filter(Boolean),
    );

    expect(ids).toEqual(["other.rule", "acb-unsafe-raw-sql"]);
  });
});
