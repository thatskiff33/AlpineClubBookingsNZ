/**
 * The deliberate, visible escape from the file-size ratchet (owner decision,
 * 21 Aug 2026).
 *
 * WHY THIS EXISTS. #2979 deleted `scripts/quality/file-size-baseline.txt` and,
 * with it, `npm run quality:budget:update` — the one way to say "yes, this file
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
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/** Where a pull request writes its allowances. One file per pull request. */
export const ALLOWANCE_DIR = "size-allowances.d";

/** Never parsed as an allowance, the same way the changelog compiler skips it. */
const RESERVED_NAMES = new Set(["readme.md"]);

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

export type AllowanceProblem = { source: string; problem: string };

export type AllowanceRead = {
  allowances: SizeAllowance[];
  /** Malformed input. A gate must not guess at what its input meant. */
  problems: AllowanceProblem[];
};

const FIELD = /^(file|lines|reason):(.*)$/;

type Draft = { file?: string; lines?: string; reason?: string; started: number };

function finishDraft(
  draft: Draft,
  source: string,
  out: SizeAllowance[],
  problems: AllowanceProblem[],
): void {
  const where = `${source} (entry starting at line ${draft.started})`;
  const file = draft.file?.trim() ?? "";
  const lines = draft.lines?.trim() ?? "";
  const reason = draft.reason?.replace(/\s+/g, " ").trim() ?? "";

  const missing = [
    file ? null : "file",
    lines ? null : "lines",
    reason ? null : "reason",
  ].filter(Boolean);
  if (missing.length > 0) {
    problems.push({
      source,
      problem: `${where} is missing ${missing.join(", ")} — every entry needs all three, so a reviewer can see which file, how long, and why`,
    });
    return;
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

  out.push({ source, file, lines: Number(lines), reason });
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
  const allowances: SizeAllowance[] = [];
  const problems: AllowanceProblem[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  let draft: Draft | null = null;
  let lastKey: "file" | "lines" | "reason" | null = null;

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
    const key = match[1] as "file" | "lines" | "reason";
    const value = match[2] ?? "";
    if (key === "file") {
      if (draft) finishDraft(draft, source, allowances, problems);
      draft = { file: value, started: lineNumber };
      lastKey = "file";
      return;
    }
    if (!draft) {
      problems.push({
        source,
        problem: `line ${lineNumber} sets \`${key}:\` before any \`file:\`; each entry starts with the file it is about`,
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

  if (draft) finishDraft(draft, source, allowances, problems);
  return { allowances, problems };
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
          !RESERVED_NAMES.has(entry.name.toLowerCase()),
      )
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { allowances: [], problems: [] };
    return {
      allowances: [],
      problems: [
        {
          source: ALLOWANCE_DIR,
          problem: `could not be read (${code ?? String(error)}), so the gate cannot tell an empty directory from an unreadable one`,
        },
      ],
    };
  }

  const allowances: SizeAllowance[] = [];
  const problems: AllowanceProblem[] = [];
  for (const name of names) {
    const source = `${ALLOWANCE_DIR}/${name}`;
    let text: string;
    try {
      text = readFileSync(path.join(dir, name), "utf8");
    } catch (error) {
      problems.push({ source, problem: `could not be read (${String(error)})` });
      continue;
    }
    const parsed = parseAllowanceFile(source, text);
    allowances.push(...parsed.allowances);
    problems.push(...parsed.problems);
  }

  // Two entries for one file is ambiguous, and ambiguity in a gate's input is
  // the thing that let the old ledger ship a ceiling the tree already violated.
  const seen = new Map<string, string>();
  for (const allowance of allowances) {
    const first = seen.get(allowance.file);
    if (first !== undefined) {
      problems.push({
        source: allowance.source,
        problem: `${allowance.file} already has an allowance in ${first}; one file, one allowance`,
      });
      continue;
    }
    seen.set(allowance.file, allowance.source);
  }

  return { allowances, problems };
}
