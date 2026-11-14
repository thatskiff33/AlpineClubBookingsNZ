/**
 * Function-length ratchet (#4927).
 *
 * The file-size ratchet's rule, applied one level down: current function-length
 * debt may stay, but new debt and debt growth may not appear silently. A
 * function no longer than `FUNCTION_LENGTH_LIMIT` may not cross it, a new
 * function may not arrive over it, and a function already over it may not get
 * longer than it was on the base ref.
 *
 * WHY A SECOND GATE. The file-size budget measures whole files, so a 2,000-line
 * function in a file that already holds an allowance passes it — and the doors
 * that move money (cancel, create, edit, guest-add, bank settlement) grew into
 * exactly that shape one fix at a time. A function is the unit a reviewer has to
 * hold in their head; a file is not.
 *
 * EVERYTHING ABOUT "BEFORE" IS THE FILE-SIZE RATCHET'S, reused rather than
 * copied: the base ref is resolved by `resolveBaseRef` (the merge base, failing
 * loudly when it cannot be read), the changed files, their renames and the
 * in-scope-rename rule come from `changedFilesWithBasePaths` (the same helper
 * `resolveBaseSizes` uses), scope comes from the same `isProductionFile`, and an
 * escape is a `function:` entry in the same `size-allowances.d/` fragment, with
 * the same one-shot rules. Only changed files are judged: an untouched function
 * cannot have grown.
 *
 * A FUNCTION IS MATCHED BY NAME within its file (following a git rename of the
 * file, but only from inside the budgeted scope, exactly as the file-size
 * ratchet does). A function whose name vanished from one changed file and
 * appears, uniquely, in another is followed too: moving a long function to its
 * own module is a step toward splitting it, and must not be refused as "new".
 * Renaming a long function is not followed — the ratchet cannot tell a rename
 * from a deletion plus a new function, and the remedy (split it while you are
 * there, or keep the name) is cheap.
 *
 * Reads `git` and the working tree only: no network, no build, no database.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  ALLOWANCE_DIR,
  type AllowanceProblem,
  type FunctionAllowance,
} from "./file-size-allowances";
import {
  baseContentOf,
  type ComputedFinding,
  changedFilesWithBasePaths,
  deletedFilesSinceBase,
  resolveBaseRef,
} from "./file-size-base";
import { measureFunctions, type FunctionSpan } from "./function-length";

/**
 * The one ceiling, in physical lines from a function's first token to its last.
 *
 * Why 300: the population over it is small enough to read as a report, and it
 * is the length the cancellation door is to be split down to (#4927). At 200
 * the report roughly doubles and stops being something a person reads; at 500
 * it waves through functions no reviewer holds in their head. The dated
 * measurement lives once, in docs/MAINTENANCE.md; `quality:budget --report`
 * prints today's.
 */
export const FUNCTION_LENGTH_LIMIT = 300;

const ALLOWANCE_FORMAT_HINT =
  "`function: <path>#<name>` / `lines: <its new length>` / `reason: <why splitting is worse here>`";

export type FunctionFindingKind =
  | "base-unresolvable"
  | "new-over-limit"
  | "crossed-limit"
  | "grown-beyond-base"
  | "allowance-malformed"
  | "allowance-mismatched"
  | "allowance-not-permitted"
  | "allowance-unused";

/** The file-size finding's shape, with `file` meaning `<file>#<name>`. */
export type FunctionFinding = Omit<ComputedFinding, "kind"> & {
  kind: FunctionFindingKind;
};

export type FunctionRatchetResult = {
  findings: FunctionFinding[];
  baseSha: string | null;
  /** Production files whose functions this run measured. */
  checkedFiles: number;
  allowancesApplied: FunctionAllowance[];
};

type Measured = FunctionSpan & { file: string };

function keyOf(file: string, name: string): string {
  return `${file}#${name}`;
}

function measureText(file: string, text: string | null): Measured[] {
  if (text === null) return [];
  return measureFunctions(file, text).map((span) => ({ ...span, file }));
}

function readWorkingTree(root: string, file: string): string | null {
  try {
    return readFileSync(path.join(root, file), "utf8");
  } catch {
    return null;
  }
}

/** Where a function's base length was found, when it was found somewhere. */
type Previous = { lines: number; from: string | null };

/** Judge every function in the files this change touched. */
export function evaluateFunctionLengthRatchet(input: {
  root: string;
  baseRef: string;
  isProductionFile: (file: string) => boolean;
  limit?: number;
  allowances?: ReadonlyArray<FunctionAllowance>;
  allowanceProblems?: ReadonlyArray<AllowanceProblem>;
}): FunctionRatchetResult {
  const limit = input.limit ?? FUNCTION_LENGTH_LIMIT;
  const budget = `function, <= ${limit} lines`;
  const findings: FunctionFinding[] = [];

  // Malformed allowance files are reported by the file-size ratchet, which
  // reads the same directory in the same run; reporting them twice would only
  // double the noise. Callers running this gate alone pass them in.
  for (const { source, problem } of input.allowanceProblems ?? []) {
    findings.push({
      severity: "unusable",
      kind: "allowance-malformed",
      file: source,
      budget: null,
      previous: null,
      current: null,
      problem,
      action: `fix the entry, or delete it. Format: ${ALLOWANCE_FORMAT_HINT}`,
    });
  }

  const base = resolveBaseRef(input.root, input.baseRef);
  const diff = base.ok
    ? changedFilesWithBasePaths(input.root, base.sha, input.isProductionFile)
    : base;
  const gone = base.ok ? deletedFilesSinceBase(input.root, base.sha) : base;
  if (!base.ok || !diff.ok || !gone.ok) {
    const failed = [base, diff, gone].find((step) => !step.ok);
    findings.push({
      severity: "unusable",
      kind: "base-unresolvable",
      file: null,
      budget: null,
      previous: null,
      current: null,
      problem: failed && !failed.ok ? failed.error : "the base could not be read",
      action:
        "follow the remedy named above and re-run — this check will not report " +
        "a pass it has no evidence for",
    });
    return { findings, baseSha: null, checkedFiles: 0, allowancesApplied: [] };
  }

  const changed = diff.changed;
  const inDiff = new Set(changed.map((entry) => entry.file));

  // Base functions, keyed by where they lived on the base.
  const baseByKey = new Map<string, Measured>();
  const measureBase = (file: string) => {
    for (const fn of measureText(file, baseContentOf(input.root, base.sha, file)?.toString("utf8") ?? null)) {
      baseByKey.set(keyOf(file, fn.name), fn);
    }
  };

  // Current functions, each with the base path its file came from (null when
  // the file is new, or moved in from outside the budgeted scope).
  const current: Array<Measured & { basePath: string | null }> = [];
  let checkedFiles = 0;
  for (const { file, basePath } of changed) {
    if (!input.isProductionFile(file)) continue;
    checkedFiles += 1;
    if (basePath) measureBase(basePath);
    for (const fn of measureText(file, readWorkingTree(input.root, file))) {
      current.push({ ...fn, basePath });
    }
  }
  for (const file of gone.deleted) {
    if (input.isProductionFile(file)) measureBase(file);
  }

  // A base function is ORPHANED when nothing at its base location still
  // carries its name. A current function with no base match may inherit an
  // orphan's length if the name identifies exactly one of each.
  const claimed = new Set(
    current
      .filter((fn) => fn.basePath !== null)
      .map((fn) => keyOf(fn.basePath as string, fn.name))
      .filter((key) => baseByKey.has(key)),
  );
  const orphansByName = new Map<string, Measured[]>();
  for (const [key, fn] of baseByKey) {
    if (claimed.has(key)) continue;
    orphansByName.set(fn.name, [...(orphansByName.get(fn.name) ?? []), fn]);
  }
  const unmatchedByName = new Map<string, number>();
  for (const fn of current) {
    const key = fn.basePath === null ? null : keyOf(fn.basePath, fn.name);
    if (key !== null && baseByKey.has(key)) continue;
    unmatchedByName.set(fn.name, (unmatchedByName.get(fn.name) ?? 0) + 1);
  }

  const previousOf = (fn: Measured & { basePath: string | null }): Previous | null => {
    if (fn.basePath !== null) {
      const same = baseByKey.get(keyOf(fn.basePath, fn.name));
      if (same) {
        return { lines: same.lines, from: fn.basePath === fn.file ? null : fn.basePath };
      }
    }
    const orphans = orphansByName.get(fn.name) ?? [];
    const [orphan] = orphans;
    if (orphan && orphans.length === 1 && unmatchedByName.get(fn.name) === 1) {
      return { lines: orphan.lines, from: orphan.file };
    }
    return null;
  };

  // Allowances live only in the change that introduces them, as for files.
  const live = (input.allowances ?? []).filter((a) => inDiff.has(a.source));
  const allowanceFor = new Map<string, FunctionAllowance>();
  for (const allowance of live) {
    const first = allowanceFor.get(allowance.key);
    if (first) {
      findings.push({
        severity: "unusable",
        kind: "allowance-malformed",
        file: allowance.key,
        budget: null,
        previous: `declared in ${first.source}`,
        current: `declared again in ${allowance.source}`,
        problem: `${allowance.key} already has an allowance in ${first.source}; one function, one allowance`,
        action: "delete one of the two entries — a gate cannot choose between two numbers",
      });
    }
    allowanceFor.set(allowance.key, allowance);
  }
  const used = new Set<string>();
  const allowancesApplied: FunctionAllowance[] = [];

  current.sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine);
  for (const fn of current) {
    if (fn.lines <= limit) continue;
    const key = keyOf(fn.file, fn.name);
    const where = `${fn.lines} lines (lines ${fn.startLine}-${fn.endLine})`;
    const previous = previousOf(fn);
    const allowance = allowanceFor.get(key);

    if (previous === null || previous.lines <= limit) {
      const isNew = previous === null;
      if (allowance) used.add(key);
      findings.push({
        severity: "regression",
        kind: allowance ? "allowance-not-permitted" : isNew ? "new-over-limit" : "crossed-limit",
        file: key,
        budget,
        previous: isNew ? null : `${previous.lines} lines on the base ref`,
        current: `${where}, over by ${fn.lines - limit}`,
        problem: allowance
          ? `an allowance cannot carry a ${isNew ? "NEW function" : "function over the limit for the first time"}`
          : isNew
            ? "a NEW function is over the limit"
            : "the function grew past the limit",
        action:
          "split it into named functions that each take what they need as typed " +
          "input. An allowance cannot cover a new function or one crossing the " +
          "limit for the first time: extract the longest nested block into its " +
          "own top-level function",
      });
      continue;
    }

    if (fn.lines <= previous.lines) continue;
    const movedNote = previous.from ? ` (in ${previous.from})` : "";
    if (allowance) {
      used.add(key);
      if (allowance.lines !== fn.lines) {
        findings.push({
          severity: "regression",
          kind: "allowance-mismatched",
          file: key,
          budget,
          previous: `${allowance.source} records ${allowance.lines} lines`,
          current: where,
          problem: "the allowance does not match the function, so it is not describing this change",
          action: `set \`lines: ${fn.lines}\` in ${allowance.source}, or delete the entry`,
        });
      } else {
        allowancesApplied.push(allowance);
      }
      continue;
    }
    findings.push({
      severity: "regression",
      kind: "grown-beyond-base",
      file: key,
      budget,
      previous: `${previous.lines} lines on the base ref${movedNote}`,
      current: `${where}, +${fn.lines - previous.lines}`,
      problem: "an already-over-limit function grew",
      action:
        `split or shorten it. If the increase is genuinely necessary, say so out ` +
        `loud: add ${ALLOWANCE_DIR}/<pr-number>-<slug>.md containing ` +
        `${ALLOWANCE_FORMAT_HINT} — one file per pull request`,
    });
  }

  for (const allowance of live) {
    if (used.has(allowance.key)) continue;
    findings.push({
      severity: "regression",
      kind: "allowance-unused",
      file: allowance.key,
      budget: null,
      previous: `${allowance.source} records ${allowance.lines} lines`,
      current: null,
      problem:
        "this change declares an allowance the check did not need — the function " +
        "did not grow past its ceiling, or is not in a production file this change touches",
      action: `delete the entry from ${allowance.source}`,
    });
  }

  return { findings, baseSha: base.sha, checkedFiles, allowancesApplied };
}

/** Every function over the limit in the given files, longest first. */
export function findLongFunctions(
  root: string,
  files: readonly string[],
  limit: number = FUNCTION_LENGTH_LIMIT,
): Measured[] {
  return files
    .flatMap((file) => measureText(file, readWorkingTree(root, file)))
    .filter((fn) => fn.lines > limit)
    .sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));
}
