/**
 * The deliberate, visible escape from the file-size ratchet (owner decision,
 * 21 Aug 2026).
 *
 * WHY THIS EXISTS. #2979 deleted `scripts/quality/file-size-baseline.txt` and,
 * with it, `pnpm run quality:budget:update` — the one way to say "yes, this file
 * grows, I mean it". The issue called the result "today's semantics"; it was
 * not. Today there IS an escape, and removing it would leave **283 over-budget
 * files** — most of the modules people work in daily — unable to gain a single
 * line, ever. That is not hypothetical: measured against `origin/main` on the
 * day of the decision, PR #2980 grew eight already-over-budget files by 463
 * lines between them, and PR #2985 hit the same wall on `src/proxy.ts` and
 * escaped only by moving code out of it.
 *
 * WHY IT IS NOT A LEDGER AGAIN. A single shared file is precisely what #2979
 * exists to delete: every change edits the same lines, so every merge
 * re-conflicts, and resolving by hand shipped a wrong ceiling twice. So this
 * follows the pattern this repository already used to solve the identical
 * problem for `CHANGELOG.md` (#2452): **one new file per pull request**, under
 * `size-allowances.d/`, at a path no other pull request touches. Two branches
 * cannot conflict over files they do not share.
 *
 * WHY IT CANNOT ROT. An allowance is inherently ONE-SHOT. Once the pull request
 * merges, the grown length IS the base ref, so the same file needs no allowance
 * next time. Two rules keep that true:
 *
 *   - the recorded length must EQUAL the file's real length, so an allowance
 *     cannot drift away from the tree the way the ledger did, and cannot be
 *     re-used later for a different growth;
 *   - an allowance only has effect on the change that INTRODUCES it — the
 *     allowance file itself must be in this change's diff. After merge it is
 *     inert, and can be swept up in bulk exactly like a compiled changelog
 *     fragment.
 *
 * WHAT IT MAY NOT DO — the two things it must never reopen (#2987):
 *
 *   - it may not let a NEW file skip its budget;
 *   - it may not let a file RENAMED INTO the budgeted scope inherit a ceiling
 *     from outside it.
 *
 * Both are refused by name, with the reason, rather than silently ignored. It
 * also does not cover a file crossing its budget for the FIRST time: the owner
 * decision permits "growth of an existing in-scope over-budget file", and a
 * module that is still under its budget should be split before it goes over.
 *
 * The same fragments carry `function:` entries (`<path>#<name>`) for the
 * function-length ratchet (#4927), under the same rules; that ratchet judges
 * them (`scripts/lib/function-length-ratchet.ts`).
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ALLOWANCE_DIR, isReservedAllowanceName, isSafeAllowanceName } from "./allowance-dir.mjs";

/** Where a pull request writes its allowances. One file per pull request. */
export { ALLOWANCE_DIR };

/**
 * A reason has to be a reason. The owner decision is explicit that "a bare
 * 'allow growth' marker is not visible enough to review", and the cheapest
 * objective floor on that is a length nobody clears by typing "needed".
 */
const MIN_REASON_LENGTH = 20;

export type SizeAllowance = {
  /** The allowance file this entry came from, repo-relative with `/`. */
  source: string;
  /** The production file allowed to grow. */
  file: string;
  /** The length it is allowed to reach — which must be its real length. */
  lines: number;
  /** Why splitting is worse here, for a reviewer to weigh. */
  reason: string;
};

/**
 * The same escape for the function-length ratchet (#4927): one function, not a
 * whole file, may grow past its base-ref length. Written in the same fragment
 * files, as `function: <path>#<name>` in place of `file: <path>`, so there is
 * one allowance directory and one format rather than two.
 */
export type FunctionAllowance = {
  source: string;
  /** The production file the function lives in. */
  file: string;
  /** The function's name as the ratchet reports it, e.g. `Class.method`. */
  name: string;
  /** `<file>#<name>`, the key the ratchet matches on. */
  key: string;
  lines: number;
  reason: string;
};

export type AllowanceProblem = { source: string; problem: string };

export type AllowanceRead = {
  allowances: SizeAllowance[];
  functionAllowances: FunctionAllowance[];
  /** Malformed input. A gate must not guess at what its input meant. */
  problems: AllowanceProblem[];
};

const FIELD = /^(file|function|lines|reason):(.*)$/;

type Key = "file" | "function" | "lines" | "reason";

type Draft = {
  /** Which key opened the entry: a whole file, or one function in one. */
  subject: "file" | "function";
  file?: string;
  function?: string;
  lines?: string;
  reason?: string;
  started: number;
};

function finishDraft(
  draft: Draft,
  source: string,
  out: AllowanceRead,
): void {
  const { problems } = out;
  const where = `${source} (entry starting at line ${draft.started})`;
  const subject = draft[draft.subject]?.trim() ?? "";
  const lines = draft.lines?.trim() ?? "";
  const reason = draft.reason?.replace(/\s+/g, " ").trim() ?? "";

  const missing = [
    subject ? null : draft.subject,
    lines ? null : "lines",
    reason ? null : "reason",
  ].filter(Boolean);
  if (missing.length > 0) {
    problems.push({
      source,
      problem: `${where} is missing ${missing.join(", ")} — every entry needs all three, so a reviewer can see which ${draft.subject}, how long, and why`,
    });
    return;
  }

  let file = subject;
  let name = "";
  if (draft.subject === "function") {
    const hash = subject.indexOf("#");
    file = hash === -1 ? "" : subject.slice(0, hash).trim();
    name = hash === -1 ? "" : subject.slice(hash + 1).trim();
    if (!file || !name) {
      problems.push({
        source,
        problem: `${where} names \`function: ${subject}\`; write \`function: <path>#<name>\`, the path and the name the check printed`,
      });
      return;
    }
  }

  if (file.includes("\\") || file.startsWith("/") || file.includes("..")) {
    problems.push({
      source,
      problem: `${where} names \`${file}\`; a repo-relative path with forward slashes is required`,
    });
    return;
  }
  if (!/^[0-9]+$/.test(lines)) {
    problems.push({
      source,
      problem: `${where} records \`lines: ${lines}\`, which is not a whole number of lines`,
    });
    return;
  }
  if (reason.length < MIN_REASON_LENGTH) {
    problems.push({
      source,
      problem: `${where} gives a ${reason.length}-character reason; say why splitting is worse here, in at least ${MIN_REASON_LENGTH} characters — a bare marker is not something a reviewer can weigh`,
    });
    return;
  }

  if (draft.subject === "function") {
    out.functionAllowances.push({
      source,
      file,
      name,
      key: `${file}#${name}`,
      lines: Number(lines),
      reason,
    });
    return;
  }
  out.allowances.push({ source, file, lines: Number(lines), reason });
}

/**
 * Parse one allowance file.
 *
 * Not exported: the suite drives this through `readSizeAllowances` over real
 * directories, the same way the rest of this gate is tested against real git
 * repositories rather than mocks.
 */
function parseAllowanceFile(
  source: string,
  text: string,
): AllowanceRead {
  const out: AllowanceRead = { allowances: [], functionAllowances: [], problems: [] };
  const { problems } = out;
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  let draft: Draft | null = null;
  let lastKey: Key | null = null;

  lines.forEach((raw, index) => {
    const lineNumber = index + 1;
    // A continuation line is indented and extends the field above it, so a
    // reason can be wrapped to a sensible width like every other prose here.
    if (draft && lastKey && /^\s+\S/.test(raw)) {
      draft[lastKey] = `${draft[lastKey] ?? ""} ${raw.trim()}`;
      return;
    }
    const match = FIELD.exec(raw);
    if (!match) {
      // Anything else is prose — a heading, a blank line, a paragraph. Prose is
      // encouraged; only the three keys are read.
      return;
    }
    const key = match[1] as Key;
    const value = match[2] ?? "";
    if (key === "file" || key === "function") {
      if (draft) finishDraft(draft, source, out);
      draft = { subject: key, [key]: value, started: lineNumber };
      lastKey = key;
      return;
    }
    if (!draft) {
      problems.push({
        source,
        problem: `line ${lineNumber} sets \`${key}:\` before any \`file:\` or \`function:\`; each entry starts with what it is about`,
      });
      return;
    }
    if (draft[key] !== undefined) {
      problems.push({
        source,
        problem: `the entry starting at line ${draft.started} sets \`${key}:\` twice`,
      });
      return;
    }
    draft[key] = value;
    lastKey = key;
  });

  if (draft) finishDraft(draft, source, out);
  return out;
}

/**
 * Read every allowance in the tree.
 *
 * A missing directory is the ordinary case — most pull requests need none — and
 * is not a problem. A directory that cannot be read IS a problem: a gate whose
 * input it cannot see must not assume the input was empty.
 */
export function readSizeAllowances(root: string): AllowanceRead {
  const dir = path.join(root, ALLOWANCE_DIR);
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.toLowerCase().endsWith(".md") &&
          !isReservedAllowanceName(entry.name),
      )
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return { allowances: [], functionAllowances: [], problems: [] };
    }
    return {
      allowances: [],
      functionAllowances: [],
      problems: [
        {
          source: ALLOWANCE_DIR,
          problem: `could not be read (${code ?? String(error)}), so the gate cannot tell an empty directory from an unreadable one`,
        },
      ],
    };
  }

  const allowances: SizeAllowance[] = [];
  const functionAllowances: FunctionAllowance[] = [];
  const problems: AllowanceProblem[] = [];
  for (const name of names) {
    const source = `${ALLOWANCE_DIR}/${name}`;
    if (!isSafeAllowanceName(name)) {
      problems.push({ source, problem: `unsafe allowance filename: ${name}` });
      continue;
    }
    let text: string;
    try {
      text = readFileSync(path.join(dir, name), "utf8");
    } catch (error) {
      problems.push({ source, problem: `could not be read (${String(error)})` });
      continue;
    }
    const parsed = parseAllowanceFile(source, text);
    allowances.push(...parsed.allowances);
    functionAllowances.push(...parsed.functionAllowances);
    problems.push(...parsed.problems);
  }

  // Two entries for one file is ambiguous, and ambiguity in a gate's input is
  // the thing that let the old ledger ship a ceiling the tree already violated.
  //
  // WITHIN ONE ALLOWANCE FILE, and that boundary is the fix rather than an
  // oversight. This reader sees the whole directory, including declarations
  // that merged months ago — and a merged allowance is INERT, which is the
  // contract the effect path in `file-size-base.ts` honours by applying only
  // allowances whose own file is in the change's diff. Detecting duplicates
  // across the whole directory contradicted that: the SECOND pull request to
  // grow a file was refused, and refused by being shown a path it did not have
  // in its diff and could do nothing about. Measured on the club-time epic
  // branch, 15 of the 22 files holding an allowance came from three
  // already-merged declarations, several of them on files the next groups were
  // about to touch.
  //
  // So the cross-file half of the rule moves to where liveness is known:
  // `evaluateComputedRatchet` applies it to the allowances live for THIS change,
  // which is the case the rule is actually about. Two entries in one file need
  // no liveness to judge — nobody writes them by accident in different changes —
  // so they stay here, where the parse already is.
  const subjects = [
    ...allowances.map((a) => ({ source: a.source, subject: a.file, unit: "file" })),
    ...functionAllowances.map((a) => ({ source: a.source, subject: a.key, unit: "function" })),
  ];
  for (const [source, entries] of groupBySource(subjects)) {
    const seen = new Set<string>();
    for (const { subject, unit } of entries) {
      if (seen.has(subject)) {
        problems.push({
          source,
          problem: `${subject} already has an allowance in ${source}; one ${unit}, one allowance`,
        });
        continue;
      }
      seen.add(subject);
    }
  }

  return { allowances, functionAllowances, problems };
}

function groupBySource<T extends { source: string }>(
  allowances: readonly T[],
): Map<string, T[]> {
  const bySource = new Map<string, T[]>();
  for (const allowance of allowances) {
    const existing = bySource.get(allowance.source);
    if (existing) existing.push(allowance);
    else bySource.set(allowance.source, [allowance]);
  }
  return bySource;
}
