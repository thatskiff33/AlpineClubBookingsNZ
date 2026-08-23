#!/usr/bin/env -S npx tsx
/**
 * File-size budget ratchet (#2687, rebuilt on the base ref by #2979).
 *
 * `npm run quality:budget`                    judge the files this change touched
 * `npm run quality:budget -- --base <ref>`    compare against a different ref
 * `npm run quality:budget -- --report`        print the whole tree's debt
 *
 * `--base` is not only a diagnostic. CI passes it on a `push` to `main`, where
 * the default of `origin/main` IS the commit being tested and would make this
 * gate vacuous — see the step comment in `.github/workflows/ci.yml`.
 *
 * The rule, in one sentence and unchanged: current size debt may stay, but new
 * debt and debt growth may not appear silently. A file that was not over its
 * budget may not go over it, and a file that was already over may not grow.
 *
 * WHAT #2979 CHANGED is where "was" comes from. It used to be a checked-in
 * ledger, `scripts/quality/file-size-baseline.txt`. That file was the problem
 * rather than the rule: every change that grew a listed file rewrote the same
 * line, so the next merge re-conflicted it, forever — five of nine lanes on the
 * 21 Aug 2026 wave touched it, and `.gitattributes` gives it no merge driver.
 * Worse, resolving one of those conflicts by picking a side shipped a WRONG
 * ceiling twice, once a ceiling the untouched file already exceeded. The
 * previous length is now read from the base ref, so there is no line for two
 * branches to both rewrite, no stored number to drift from the tree, and a
 * rename is followed rather than guessed at.
 *
 * There is deliberately NO UPDATE MODE any more. It existed to record an
 * accepted increase, and the thing it wrote no longer exists — an accepted
 * increase is now explained in the pull request body, which is where a reviewer
 * was meant to be looking anyway. Nothing to regenerate is the point, not an
 * omission. `--update` still answers, so somebody who types it from muscle
 * memory gets that explanation instead of an unrecognised-flag shrug.
 *
 * Exits 1 on any finding, and also when the base ref cannot be resolved: a gate
 * that cannot read what it is comparing against must not report a pass it has
 * not earned. `npm run pr:check` already behaves this way for the same reason.
 *
 * Reads `git` and the working tree only: no network, no build, no database, no
 * provider.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CHECK_COMMAND,
  budgetForFile,
  countLines,
  describeBudget,
  isProductionFile,
  scanRepository,
  summariseSizeDebt,
} from "../lib/file-size-budget";
import {
  evaluateComputedRatchet,
  type ComputedFinding,
} from "../lib/file-size-base";
import {
  ALLOWANCE_DIR,
  readSizeAllowances,
  type SizeAllowance,
} from "../lib/file-size-allowances";

/** The ref a change is judged against unless told otherwise. */
export const DEFAULT_BASE_REF = "origin/main";

const SEVERITY_HEADINGS = {
  unusable: "UNUSABLE — the comparison cannot be trusted",
  regression: "REGRESSION — new or growing size debt",
} as const;

export function renderFinding(finding: ComputedFinding): string {
  const lines: string[] = [`  ${finding.file ?? "(the comparison itself)"}`];
  lines.push(`      problem:  ${finding.problem}`);
  if (finding.budget) lines.push(`      budget:   ${finding.budget}`);
  if (finding.previous) lines.push(`      previous: ${finding.previous}`);
  if (finding.current) lines.push(`      current:  ${finding.current}`);
  lines.push(`      action:   ${finding.action}`);
  return lines.join("\n");
}

/**
 * Growth this run let through, printed on SUCCESS as well as on failure.
 *
 * An escape hatch nobody can see is the ledger again in another shape. This is
 * what a reviewer reads to decide whether the reason is good enough, and what
 * makes an allowance a decision somebody made rather than a green tick.
 */
export function renderAppliedAllowances(
  applied: readonly SizeAllowance[],
): string {
  if (applied.length === 0) return "";
  return [
    "",
    `ALLOWED GROWTH — ${applied.length} file(s) grew because this change said so out loud`,
    "",
    ...applied.flatMap((allowance) => [
      `  ${allowance.file}  ->  ${allowance.lines} LOC`,
      `      declared: ${allowance.source}`,
      `      reason:   ${allowance.reason}`,
      "",
    ]),
    "  Each entry is one-shot. Once this merges the new length IS the base ref, so",
    `  the file needs no allowance next time and the ${ALLOWANCE_DIR}/ file is inert.`,
    "",
  ].join("\n");
}

export function renderReport(findings: readonly ComputedFinding[]): string {
  const out: string[] = [];
  for (const severity of ["unusable", "regression"] as const) {
    const group = findings.filter((finding) => finding.severity === severity);
    if (group.length === 0) continue;
    out.push("");
    out.push(`${SEVERITY_HEADINGS[severity]} (${group.length})`);
    out.push("");
    for (const finding of group) {
      out.push(renderFinding(finding));
      out.push("");
    }
  }
  return out.join("\n");
}

/** `--base <ref>` or `--base=<ref>`; falls back to the default. */
export function baseRefFrom(argv: readonly string[]): string {
  const inline = argv.find((arg) => arg.startsWith("--base="));
  if (inline) return inline.slice("--base=".length) || DEFAULT_BASE_REF;
  const index = argv.indexOf("--base");
  if (index !== -1) return argv[index + 1] ?? DEFAULT_BASE_REF;
  return DEFAULT_BASE_REF;
}

/**
 * The whole tree's debt, on demand.
 *
 * This is what the stored ledger used to give away for free, and it is the one
 * thing worth keeping from it — a number to quote in `docs/MAINTENANCE.md` and
 * to watch shrink. It is a REPORT rather than a gate: it never fails on the
 * debt it finds, and nothing has to be committed to keep it current.
 */
export function runReport(root: string): number {
  const scan = scanRepository(root);
  if (scan.gitError !== null) {
    process.stderr.write(
      `File-size budget report: ${scan.gitError.split("\n")[0]}\n` +
        "  Run this from the repository root inside a git checkout.\n",
    );
    return 1;
  }
  const summary = summariseSizeDebt(scan.productionStats);
  const worst = [...summary.oversized]
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 10);

  process.stdout.write(
    [
      `File-size budget report — ${summary.oversizedFiles} of ${summary.scannedFiles} ` +
        `production files are over budget, carrying ${summary.debt} lines of debt.`,
      ...(summary.scannedFiles === 0
        ? [
            "",
            "  NOTHING WAS SCANNED. This is not a debt-free tree; it is a checkout with",
            "  no production source in it. Run from the repository root.",
          ]
        : []),
      "",
      "  Largest ten:",
      ...worst.map(
        (file) =>
          `    ${String(file.lines).padStart(5)}  ${file.file}  (${describeBudget(file)})`,
      ),
      "",
      "  This is a report, not a gate. Nothing is committed to keep it current:",
      `  ${CHECK_COMMAND} judges only the files a change touches, against the base ref.`,
      "",
    ].join("\n"),
  );
  return 0;
}

/** What `--update` used to do, and why typing it is no longer a mistake worth punishing quietly. */
function explainRemovedUpdateMode(): number {
  process.stderr.write(
    [
      "File-size budget: `--update` no longer exists (#2979).",
      "",
      "  It regenerated scripts/quality/file-size-baseline.txt, and that file is gone:",
      "  a file every change rewrites is a file every merge re-conflicts, and resolving",
      "  those conflicts by picking a side shipped a wrong ceiling twice.",
      "",
      "  An accepted increase is now explained in the pull request body instead, which",
      "  is where a reviewer was meant to be looking. There is nothing to regenerate.",
      "",
      `  ${CHECK_COMMAND} -- --report   the whole tree's debt, if that is what you wanted`,
      "",
    ].join("\n"),
  );
  return 1;
}

/**
 * A gate that scans nothing reports clean. Say so instead.
 *
 * Carried over from the ledger implementation, which floored on exactly this
 * condition and lost it in the rewrite. Without it a checkout with no `src/`
 * tree at all — a partial clone, a wrong working directory that still happens
 * to be inside some git repository, a sparse checkout that excluded the source
 * — prints "OK, 0 production file(s) changed" and exits 0. Reproduced.
 *
 * "Scanned and found nothing wrong" and "scanned nothing" produce the same
 * empty findings list and must not produce the same message.
 */
const EMPTY_SCAN_FINDING: ComputedFinding = {
  severity: "unusable",
  kind: "empty-scan",
  file: null,
  budget: null,
  previous: null,
  current: null,
  problem:
    "the scan found no production source files at all, so the comparison proves nothing",
  action:
    "run this from the repository root inside a full git checkout; a passing " +
    "result from an empty scan is not a pass",
};

export function run(root: string, argv: readonly string[]): number {
  if (argv.includes("--report")) return runReport(root);
  if (argv.includes("--update")) return explainRemovedUpdateMode();

  // The scan is no longer where the comparison comes from — it is here for the
  // scope audit, which asks a question about the WHOLE tree rather than about
  // this change: is there a tracked `src/` file no budget covers? A scope hole
  // reads exactly like a clean pass, so it is worth one `git ls-files` call.
  // It is also what the empty-scan floor below is measured from.
  const scan = scanRepository(root);
  if (scan.gitError !== null) {
    process.stderr.write(
      "File-size budget: could not list tracked files, so nothing was checked.\n" +
        `  ${scan.gitError.split("\n")[0]}\n` +
        "  Run this from the repository root inside a git checkout.\n",
    );
    return 1;
  }

  const baseRef = baseRefFrom(argv);
  const declared = readSizeAllowances(root);
  const result = evaluateComputedRatchet({
    root,
    baseRef,
    unclassified: scan.unclassified,
    isProductionFile,
    budgetForFile: (file) => {
      const budget = budgetForFile(file);
      return { category: budget.category, limit: budget.limit };
    },
    countLines,
    allowances: declared.allowances,
    allowanceProblems: declared.problems,
  });

  const findings =
    scan.productionStats.length === 0
      ? [EMPTY_SCAN_FINDING, ...result.findings]
      : result.findings;

  // Name the COMMIT, not only the ref. The comparison is against the merge base
  // of the ref and HEAD, which on a stale branch is not where the ref points —
  // and until now nothing the gate printed said so, in either direction. Same
  // shape as `scripts/agent-context.ts` prints for the same reason.
  const against =
    result.baseSha === null
      ? `\`${baseRef}\``
      : `\`${baseRef}\` (merge base \`${result.baseSha.slice(0, 12)}\`)`;

  if (findings.length === 0) {
    // The tail changes when an allowance was applied, because "none beyond its
    // previous length" would then be a false summary of a run that deliberately
    // let one through.
    const tail =
      result.allowancesApplied.length === 0
        ? "none over its budget or beyond its previous length."
        : `the only growth beyond a previous length is the ` +
          `${result.allowancesApplied.length} declared below.`;
    process.stdout.write(
      `File-size budget ratchet: OK — ${result.checkedFiles} production file(s) changed ` +
        `since ${against}, ${tail}\n`,
    );
    process.stdout.write(renderAppliedAllowances(result.allowancesApplied));
    return 0;
  }

  process.stderr.write(
    `File-size budget ratchet: FAILED — ${findings.length} finding(s) ` +
      `against ${against}.\n` +
      `Judged ${result.checkedFiles} production file(s) changed since that point.\n`,
  );
  process.stderr.write(renderReport(findings));
  process.stderr.write(renderAppliedAllowances(result.allowancesApplied));
  process.stderr.write(
    [
      "",
      "The rule: current size debt may stay, but new debt and debt growth may not",
      'appear silently. See docs/MAINTENANCE.md -> "File-size budget ratchet".',
      "",
      "An already-over-budget file that genuinely has to grow says so out loud, in",
      `${ALLOWANCE_DIR}/<pr-number>-<slug>.md — one file per pull request, so no two`,
      `branches conflict over it. ${ALLOWANCE_DIR}/README.md is the format and the`,
      "rules; splitting the file is still the better answer where it is available.",
      "",
      `  ${CHECK_COMMAND}                     re-run this check`,
      `  ${CHECK_COMMAND} -- --report         the whole tree's debt, for context`,
      "",
    ].join("\n"),
  );
  return 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  process.exitCode = run(process.cwd(), process.argv.slice(2));
}
