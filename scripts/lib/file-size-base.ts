/**
 * Where a file's PREVIOUS length comes from (#2979).
 *
 * The ratchet's rule is unchanged: current size debt may stay, but new debt and
 * debt growth may not appear silently. What changes is where "previous" is read
 * from. It used to be a checked-in ledger, `scripts/quality/file-size-baseline.txt`,
 * and that file was the whole problem rather than the rule:
 *
 *   - every pull request that grows a listed file rewrites the same line, so the
 *     next pull request to merge re-conflicts it, forever. Measured on the 21 Aug
 *     wave: FIVE of nine lanes touched it, and `.gitattributes` gives it no merge
 *     driver (`CHANGELOG.md` is the only `merge=` entry), so every collision was
 *     a real three-way conflict;
 *   - resolving one by picking a side ships a WRONG number, and twice did. Two
 *     lanes both raised the `src/proxy.ts` line; their code merged cleanly in
 *     different regions and the merged file was 1329 lines while the recorded
 *     ceiling read either 1320 or 1208. A third recorded a ceiling of 1101 for a
 *     file whose untouched length on `main` was already 1104 — a ledger the tree
 *     violated the moment it landed;
 *   - and a stored number keyed by PATH is fooled by a rename. A `.ts` file
 *     renamed to `.js` left its entry behind and passed.
 *
 * Reading the previous length from the base ref instead removes the artifact and
 * every one of those failure modes with it. There is no line for two branches to
 * both rewrite, no stored number to drift from the tree, and a rename is followed
 * rather than guessed at, because git reports it.
 *
 * "The base ref" here means the MERGE BASE of that ref and `HEAD`, not its tip.
 * See `resolveBaseRef` for what that buys, and for what it costs.
 *
 * A rename is followed ONLY WITHIN THE BUDGETED SCOPE. Moving a file into
 * `src/` from `prisma/` or `scripts/` is not a rename this policy can inherit a
 * ceiling from, because those trees have no ceiling to inherit; such a file is
 * judged as new. See `resolveBaseSizes`.
 *
 * NO NETWORK, NO BUILD, NO DATABASE. Two `git` reads per changed file at worst.
 * CI's `verify` job already checks out full history (`fetch-depth: 0`), which is
 * what puts the real branch point in the clone at all — see `resolveBaseRef` for
 * what a truncated history does here, which is quieter and worse than failing.
 *
 * FAILS LOUDLY WHEN THE BASE CANNOT BE RESOLVED, and that is deliberate rather
 * than defensive: a gate that cannot read what it is comparing against must not
 * report a pass it has not earned. `npm run pr:check` already behaves this way
 * for the same reason — an unfetched `origin/main` is a failure there, not a
 * green. The remedy printed names the ref actually asked for.
 */
import { execFileSync } from "node:child_process";

import {
  ALLOWANCE_DIR,
  type AllowanceProblem,
  type SizeAllowance,
} from "./file-size-allowances";

/** Quoted into every message that asks somebody to write one. */
const ALLOWANCE_FORMAT_HINT =
  "`file: <path>` / `lines: <its new length>` / `reason: <why splitting is worse here>`";

/** How many lines a file had on the base ref, or that it did not exist there. */
export type BaseSize =
  | { kind: "existed"; lines: number; /** Set when git reports a rename. */ from?: string }
  | {
      kind: "absent";
      /**
       * Set when git reports a rename whose PREDECESSOR was outside the budgeted
       * scope, so there was no ceiling to inherit and the file counts as new.
       */
      movedFrom?: string;
    };

export type BaseResolution =
  | { ok: true; ref: string; sizes: Map<string, BaseSize> }
  | { ok: false; error: string };

/** Count lines the same way `countLines` does, so the two agree exactly. */
function countLinesOfBuffer(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x0a) count += 1;
  }
  if (buf[buf.length - 1] !== 0x0a) count += 1;
  return count;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    cwd: root,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitBuffer(root: string, args: string[]): Buffer {
  return execFileSync("git", args, {
    cwd: root,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * An all-zero object id. GitHub sends this as a push event's `before` when the
 * ref did not exist beforehand, and git never resolves it to a commit.
 */
function isNullSha(ref: string): boolean {
  return /^0{40}$/.test(ref) || /^0{64}$/.test(ref);
}

/**
 * The remedy to print, worded for the ref that was actually asked for.
 *
 * `git fetch origin main` used to be hard-coded into both failure branches,
 * which meant a run with `--base release/1.2` was told to fetch a ref it had
 * not mentioned. An instruction that does not match the input is worse than no
 * instruction: it gets followed, it does not help, and the reader concludes the
 * gate is broken rather than that their base is missing.
 */
function fetchRemedyFor(ref: string): string {
  const remoteBranch = /^origin\/(.+)$/.exec(ref);
  if (remoteBranch) return `git fetch origin ${remoteBranch[1]}`;
  return `git fetch origin, or pass --base with a ref this checkout has`;
}

/**
 * Confirm the base ref exists, and return the commit this branch left it at.
 *
 * NOT the ref's tip — the MERGE BASE of the ref and `HEAD`, which is where this
 * branch diverged. That distinction is the difference between "what did this
 * change do" and "how does this checkout differ from wherever `main` has got
 * to", and only the first is a fair thing to fail somebody for.
 *
 * WHERE THE DIFFERENCE IS REAL, AND WHERE IT IS NOT. On a `pull_request` event
 * the two readings are IDENTICAL, and that was measured rather than assumed:
 * CI checks out `refs/pull/N/merge`, a merge commit whose first parent is the
 * base tip, so `merge-base(origin/main, HEAD)` IS `origin/main`. The merge tree
 * already carries `main`'s version of every file the branch did not touch, so
 * those files are not in the diff under either reading. The benefit AND the
 * cost below therefore both belong to LOCAL runs on a branch that has not
 * merged `main` in.
 *
 * WHAT IT BUYS, locally: a stale branch is not failed for growth it did not
 * cause. Measured while building #2979 — `origin/main` had moved ahead by one
 * merged pull request and `git diff origin/main` reported SEVEN `src/` files as
 * changed that the branch had never touched. They happened to be shrinks, so
 * nothing failed; had that pull request SPLIT a file instead, the local check
 * would have gone red for somebody else's edit, and the remedy would have been
 * to merge `main` — the treadmill this change exists to end.
 *
 * WHAT IT COSTS, locally, stated plainly because an earlier version of this
 * comment claimed the opposite. The merge base is NOT uniformly the stricter
 * reading. Measured counterexample: `src/lib/big.ts` is 1200 lines at the
 * branch point, `main` then splits it to 300, and the branch re-inflates it to
 * 1199. The merge-base ceiling is 1200, so the local run PASSES; the tip
 * ceiling would be `max(700, 300) = 700` and would fail. The gap closes the
 * moment `main` is merged in — the merge base then moves to the shrink — and it
 * never opens in CI at all, for the reason above.
 *
 * A MISSING merge base fails. A TRUNCATED history is the quieter hazard, and it
 * does not fail: in a `git clone --depth 1`, `origin/main` resolves, the merge
 * base comes back as HEAD itself, the diff is empty, and this check reports OK
 * over a tree holding a 1300-line module. That is measured, and it is why the
 * `verify` job's `fetch-depth: 0` is load-bearing — not because a shallow clone
 * has no merge base, but because a shallow one silently narrows the diff.
 */
export function resolveBaseRef(
  root: string,
  ref: string,
): { ok: true; sha: string } | { ok: false; error: string } {
  if (isNullSha(ref)) {
    return {
      ok: false,
      error:
        `The base is an all-zero object id (\`${ref}\`), which is how a push event says\n` +
        `  the ref did not exist before this push — a branch created by it, or a push\n` +
        `  whose predecessor GitHub could not name. There is no "before" to measure\n` +
        `  against, so this check cannot run, and it fails rather than passing: a gate\n` +
        `  that cannot read its comparison must not report a green it has not earned.\n` +
        `  Fix with:  re-run with --base naming a commit this history really contains`,
    };
  }

  let tip: string;
  try {
    tip = git(root, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return {
      ok: false,
      error:
        `Could not resolve the base ref \`${ref}\` (${detail}).\n` +
        `  This check compares each changed file against its length on that ref, so it\n` +
        `  cannot run without it — and it fails rather than passing, because a gate that\n` +
        `  cannot read its comparison must not report a green it has not earned.\n` +
        `  Fix with:  ${fetchRemedyFor(ref)}`,
    };
  }
  if (!tip) {
    return {
      ok: false,
      error:
        `\`git rev-parse ${ref}\` produced no commit, so there is nothing to compare\n` +
        `  against and this check fails rather than reporting a green it has not earned.\n` +
        `  Fix with:  ${fetchRemedyFor(ref)}`,
    };
  }

  try {
    const mergeBase = git(root, ["merge-base", tip, "HEAD"]).trim();
    if (!mergeBase) throw new Error("produced no commit");
    return { ok: true, sha: mergeBase };
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return {
      ok: false,
      error:
        `\`${ref}\` resolves to ${tip.slice(0, 12)}, but this checkout shares no commit\n` +
        `  with it (${detail}), so there is no point to measure "before" from.\n` +
        `  Unrelated histories, or a clone too shallow to reach the branch point, are the\n` +
        `  usual causes. It fails rather than passing, because a gate that cannot read its\n` +
        `  comparison must not report a green it has not earned.\n` +
        `  Fix with:  git fetch --unshallow origin, or ${fetchRemedyFor(ref)}`,
    };
  }
}

/**
 * Files changed between the base and the working tree, with renames followed.
 *
 * `-M` is what makes a rename keep its predecessor's ceiling instead of being
 * judged as a brand-new file that must meet its budget outright. Without it,
 * moving an already-over-budget file would fail the gate for no reason — and,
 * worse in the other direction, a `.ts` to `.js` rename used to slip through the
 * old ledger entirely.
 *
 * `-z` because a path needing quoting must not be misread.
 */
export function changedFilesSinceBase(
  root: string,
  baseSha: string,
): { ok: true; changed: Array<{ file: string; renamedFrom?: string }> } | { ok: false; error: string } {
  try {
    const raw = git(root, [
      "diff",
      "-M",
      "--name-status",
      "-z",
      "--diff-filter=ACMRT",
      baseSha,
    ]);
    const fields = raw.split("\0").filter((f) => f.length > 0);
    const changed: Array<{ file: string; renamedFrom?: string }> = [];
    let i = 0;
    while (i < fields.length) {
      const status = fields[i] ?? "";
      // A rename or copy status is `R100` / `C75` and consumes TWO paths; every
      // other status consumes one. Reading the arity off the status letter is
      // what keeps the NUL stream aligned.
      //
      // `C` cannot occur here today: copy detection needs `-C`, and only `-M` is
      // passed. It is parsed anyway so the stream stays aligned if that ever
      // changes — but note that treating a copy like a rename would be WRONG for
      // this gate. A copy of an oversized module is a second oversized module,
      // not a move of the first, so it should be judged as new. Add that
      // distinction in the same change that adds `-C`, not after it.
      if (status.startsWith("R") || status.startsWith("C")) {
        const from = fields[i + 1];
        const to = fields[i + 2];
        if (from === undefined || to === undefined) break;
        changed.push({ file: to, renamedFrom: from });
        i += 3;
        continue;
      }
      const file = fields[i + 1];
      if (file === undefined) break;
      changed.push({ file });
      i += 2;
    }
    return { ok: true, changed };
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return { ok: false, error: `Could not read the diff against ${baseSha}: ${detail}` };
  }
}

/** One file's length on the base ref. `absent` means it is new there. */
export function baseSizeOf(
  root: string,
  baseSha: string,
  file: string,
): BaseSize {
  try {
    return { kind: "existed", lines: countLinesOfBuffer(gitBuffer(root, ["show", `${baseSha}:${file}`])) };
  } catch {
    // `git show` fails for a path that does not exist in that tree, which is the
    // ordinary new-file case rather than an error worth reporting.
    return { kind: "absent" };
  }
}

/**
 * Files git does not track yet and is not ignoring.
 *
 * `git diff` cannot see an untracked file, so without this a brand-new module is
 * judged by nobody until somebody stages it. That matters locally rather than in
 * CI, where everything is committed — but a developer running the check before
 * `git add` would otherwise be told a 900-line new file is fine, which is the
 * one answer this gate must never give.
 *
 * Found by probing rather than by reading: while mutation-testing the new-file
 * case, the STAGED version failed correctly and the untracked version printed
 * nothing at all. The old ledger implementation had the identical blind spot for
 * the identical reason — it scanned `git ls-files`, which lists tracked files
 * only. Closed here rather than reproduced.
 *
 * `--exclude-standard` is what keeps an ignored file ignored, so a build
 * artefact or a local scratch file is still none of this gate's business.
 */
export function untrackedFiles(root: string): string[] {
  try {
    return git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
      .split("\0")
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Resolve the previous length of every file changed since `ref`.
 *
 * A renamed file resolves to its length under its OLD path, and records that
 * path so a message can explain where the ceiling came from — BUT ONLY WHEN THE
 * OLD PATH WAS ITSELF INSIDE THE BUDGETED SCOPE.
 *
 * That qualification is load-bearing, and its absence was a regression against
 * the ledger this replaced. The ledger scanned the whole tree, so a 1324-line
 * `prisma/demo-seed.ts` moved to `src/lib/demo-seed.ts` turned up as an
 * over-budget file with no entry and failed as new debt. Following the rename
 * unconditionally instead reads that move as "this file already had a 1324-line
 * ceiling", and the gate passes — for a file that has just entered the policy's
 * scope for the first time, at nearly twice its budget. Reproduced at 1324 and
 * at 5000 lines, exit 0 both times.
 *
 * Worse, it could be laundered in two steps with a green gate on each. Move
 * `src/lib/big.ts` into `src/lib/__tests__/` (out of scope, so unjudged) and
 * grow it from 1200 to 5000; then move it back to `src/lib/big2.ts`, inheriting
 * 5000 as its "previous length". A 5000-line production module lands and
 * nothing ever went red.
 *
 * So: a rename whose predecessor is not a production file is treated as a NEW
 * file, which must meet its documented budget outright. `movedFrom` records
 * where it came from, so the failure says that rather than calling a file the
 * reader can see in the history "new".
 *
 * `isProductionFile` is required rather than optional on purpose. A default of
 * "everything is in scope" would restore the bypass silently for any caller who
 * forgot it, and this is a gate.
 */
export function resolveBaseSizes(
  root: string,
  ref: string,
  isProductionFile: (file: string) => boolean,
): BaseResolution {
  const base = resolveBaseRef(root, ref);
  if (!base.ok) return { ok: false, error: base.error };

  const diff = changedFilesSinceBase(root, base.sha);
  if (!diff.ok) return { ok: false, error: diff.error };

  const sizes = new Map<string, BaseSize>();
  for (const { file, renamedFrom } of diff.changed) {
    if (renamedFrom) {
      if (!isProductionFile(renamedFrom)) {
        sizes.set(file, { kind: "absent", movedFrom: renamedFrom });
        continue;
      }
      const previous = baseSizeOf(root, base.sha, renamedFrom);
      sizes.set(
        file,
        previous.kind === "existed"
          ? { kind: "existed", lines: previous.lines, from: renamedFrom }
          : { kind: "absent", movedFrom: renamedFrom },
      );
      continue;
    }
    sizes.set(file, baseSizeOf(root, base.sha, file));
  }

  // Untracked files are new by definition, so they carry no previous length and
  // must simply meet their budget. Added AFTER the diff, and guarded, so a file
  // that is both tracked and modified keeps the length the diff found for it.
  //
  // The guard is belt-and-braces rather than a case anybody has reached: `git
  // diff <commit>` reports only paths present in the base tree or the index,
  // and `git ls-files --others` reports only paths in neither, so the two sets
  // are disjoint by construction. It stays because the cost is one `Map.has`
  // and the failure it would prevent — handing an oversized modified file a
  // brand-new-file ceiling — is exactly the shape of bug this gate exists for.
  for (const file of untrackedFiles(root)) {
    if (!sizes.has(file)) sizes.set(file, { kind: "absent" });
  }

  return { ok: true, ref: base.sha, sizes };
}

/* ------------------------------------------------------------------------- *
 * Evaluation
 * ------------------------------------------------------------------------- */

export type ComputedFindingKind =
  | "base-unresolvable"
  /** The scan found no production files at all, so a clean result proves nothing. */
  | "empty-scan"
  | "new-over-budget"
  | "grown-beyond-base"
  | "unclassified-source-file"
  /** An allowance file this gate cannot read or cannot trust. */
  | "allowance-malformed"
  /** An allowance whose recorded length is not the file's real length. */
  | "allowance-mismatched"
  /** An allowance for something an allowance may never cover. */
  | "allowance-not-permitted"
  /** An allowance in this change that covered nothing. */
  | "allowance-unused";

export type ComputedFinding = {
  severity: "regression" | "unusable";
  kind: ComputedFindingKind;
  file: string | null;
  budget: string | null;
  /** Length on the base ref, or null for a file that is new there. */
  previous: string | null;
  current: string | null;
  problem: string;
  action: string;
};

export type ComputedResult = {
  findings: ComputedFinding[];
  /** The commit compared against, or null when it could not be resolved. */
  baseSha: string | null;
  /** Production files this run actually judged. */
  checkedFiles: number;
  /**
   * Growth this run permitted because the change said out loud that it would.
   * Rendered on SUCCESS as well as on failure: an escape nobody can see is the
   * escape the ledger already was.
   */
  allowancesApplied: SizeAllowance[];
};

/**
 * Judge only the files this change touched, against their length on the base.
 *
 * THE RULE IS UNCHANGED from the stored-ledger version: a file not previously
 * over budget may not go over it, and a file already over may not grow. What
 * changes is that "already over, and by how much" is read from the base ref.
 *
 * TWO PROPERTIES THIS GAINS, both of which the ledger needed machinery to fake.
 * Both are stated with their real limits, because an earlier version of this
 * comment stated them absolutely and neither is absolute:
 *
 * 1. **Ceiling drift cannot accumulate SEQUENTIALLY.** The ledger enforced exact
 *    equality with the tree precisely because a merely-not-worse ledger rots: a
 *    file could shrink to 100 lines, keep a 900-line ceiling, and grow back to
 *    900 with nothing to show for it. Here the ceiling IS the base ref, so one
 *    change after another is judged against what the previous one really left
 *    behind, and no stale number can survive in between. What this does NOT
 *    cover is a branch that PREDATES the shrink: its merge base still holds the
 *    larger file, so it may re-inflate up to that older length and pass. See
 *    `resolveBaseRef` for the measured counterexample and why the exposure is
 *    confined to local runs.
 * 2. **A rename cannot launder debt**, because the previous length is looked up
 *    under the old path that git reports, not under a key that no longer exists
 *    — and, since the fix in `resolveBaseSizes`, only when that old path was
 *    itself inside the budgeted scope. A file arriving from `prisma/` or
 *    `scripts/`, or returning from a test path, is judged as new.
 *
 * WHAT IT DELIBERATELY STOPS DOING: it no longer judges files the change did not
 * touch. An untouched file cannot have grown, so there is nothing to catch — and
 * scanning them was the only reason the whole tree's debt had to be written down.
 * The aggregate figure is now a report you ask for, not a file you maintain.
 */
export function evaluateComputedRatchet(input: {
  root: string;
  baseRef: string;
  /** Files whose classification the scan could not determine. */
  unclassified: ReadonlyArray<{ file: string; reason: string }>;
  isProductionFile: (file: string) => boolean;
  budgetForFile: (file: string) => { category: string; limit: number };
  countLines: (root: string, file: string) => number;
  /** Declared growth from `size-allowances.d/`, and anything unreadable in it. */
  allowances?: ReadonlyArray<SizeAllowance>;
  allowanceProblems?: ReadonlyArray<AllowanceProblem>;
}): ComputedResult {
  const findings: ComputedFinding[] = [];

  for (const { source, problem } of input.allowanceProblems ?? []) {
    findings.push({
      severity: "unusable",
      kind: "allowance-malformed",
      file: source,
      budget: null,
      previous: null,
      current: null,
      problem,
      action:
        `fix the entry, or delete it — an allowance this gate cannot read is a ` +
        `hole in the gate, not an allowance it may ignore. Format: ` +
        `${ALLOWANCE_FORMAT_HINT}`,
    });
  }

  for (const { file, reason } of input.unclassified) {
    findings.push({
      severity: "unusable",
      kind: "unclassified-source-file",
      file,
      budget: null,
      previous: null,
      current: null,
      problem: reason,
      action:
        "give the file a path this check can classify, or correct the " +
        "classification rules — an unclassifiable source file is a hole in the " +
        "gate, not a file it may skip",
    });
  }

  const resolved = resolveBaseSizes(
    input.root,
    input.baseRef,
    input.isProductionFile,
  );
  if (!resolved.ok) {
    findings.push({
      severity: "unusable",
      kind: "base-unresolvable",
      file: null,
      budget: null,
      previous: null,
      current: null,
      problem: resolved.error,
      action:
        "follow the remedy named above and re-run — this check will not report " +
        "a pass it has no evidence for",
    });
    return { findings, baseSha: null, checkedFiles: 0, allowancesApplied: [] };
  }

  // An allowance only has effect on the change that INTRODUCES it: the
  // allowance file itself has to be in this change's diff. That is what makes
  // it per-pull-request rather than a ledger by accretion — after merge it is
  // inert, so it can be swept up in bulk like a compiled changelog fragment,
  // and it can never be reached for again by a later change.
  const liveAllowances = (input.allowances ?? []).filter((allowance) =>
    resolved.sizes.has(allowance.source),
  );
  const allowanceFor = new Map(liveAllowances.map((a) => [a.file, a]));
  const used = new Set<string>();
  const allowancesApplied: SizeAllowance[] = [];

  let checkedFiles = 0;
  for (const [file, previous] of [...resolved.sizes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!input.isProductionFile(file)) continue;
    checkedFiles += 1;

    const budget = input.budgetForFile(file);
    const current = input.countLines(input.root, file);
    const describe = `${budget.category}, <= ${budget.limit} LOC`;

    const allowance = allowanceFor.get(file);

    if (previous.kind === "absent") {
      if (current > budget.limit) {
        const moved = previous.movedFrom;
        // An allowance may NEVER cover this. Refused by name rather than
        // ignored, because the two bypasses #2987 closed are exactly a new file
        // skipping its budget and a rename into scope inheriting an
        // out-of-scope ceiling — and an escape hatch that quietly reopened
        // either would be worse than no escape hatch.
        if (allowance) {
          used.add(file);
          findings.push({
            severity: "regression",
            kind: "allowance-not-permitted",
            file,
            budget: describe,
            previous: allowance.source,
            current: `${current} LOC, over by ${current - budget.limit}`,
            problem: moved
              ? "an allowance cannot cover a file MOVED INTO the budgeted scope"
              : "an allowance cannot cover a NEW file",
            action:
              "delete the allowance and split the file, or bring it under its " +
              "budget. An allowance permits an already-over-budget file to grow; " +
              "it is not a way to arrive over budget, which is the bypass this " +
              "gate exists to refuse",
          });
          continue;
        }
        findings.push({
          severity: "regression",
          kind: "new-over-budget",
          file,
          budget: describe,
          previous: moved
            ? `no ceiling to inherit — ${moved} is outside the file-size policy's scope`
            : null,
          current: `${current} LOC, over by ${current - budget.limit}`,
          problem: moved
            ? "a file MOVED INTO the budgeted scope is over its budget"
            : "a NEW file is over its budget",
          action: moved
            ? "split it, or bring it under the budget before it moves in — a file " +
              "entering this policy's scope has to meet the budget like any other " +
              "new one, or moving code into src/ would be a way to launder debt"
            : "split it, or bring it under the budget before it lands",
        });
      }
      continue;
    }

    // An already-over file keeps its own length as the ceiling; an under-budget
    // one keeps the budget. Taking the max is what lets existing debt stay while
    // refusing growth, without a stored list of exceptions.
    const ceiling = Math.max(budget.limit, previous.lines);
    if (current > ceiling) {
      const renamedNote = previous.from ? ` (renamed from ${previous.from})` : "";
      const alreadyOver = previous.lines > budget.limit;

      if (allowance) {
        used.add(file);
        if (!alreadyOver) {
          // The owner decision permits "growth of an existing in-scope
          // OVER-BUDGET file". A module still inside its budget is a module
          // that can be split before it goes over, and letting an allowance
          // carry it over would turn the budget itself into a suggestion.
          findings.push({
            severity: "regression",
            kind: "allowance-not-permitted",
            file,
            budget: describe,
            previous: `${previous.lines} LOC on the base ref, inside its budget (${allowance.source})`,
            current: `${current} LOC, +${current - ceiling} beyond its ceiling`,
            problem:
              "an allowance cannot carry a file over its budget for the first time",
            action:
              "split it, or keep it inside its budget. An allowance lets an " +
              "already-over-budget file grow; a file that is still within its " +
              "budget has the cheapest possible split available to it",
          });
        } else if (allowance.lines !== current) {
          // The one rule that stops an allowance drifting from the tree the way
          // the ledger did, and stops one being written once and re-used later.
          findings.push({
            severity: "regression",
            kind: "allowance-mismatched",
            file,
            budget: describe,
            previous: `${allowance.source} records ${allowance.lines} LOC`,
            current: `${current} LOC — ${current > allowance.lines ? "longer" : "shorter"} than the allowance says`,
            problem:
              "the allowance does not match the file, so it is not describing this change",
            action:
              `set \`lines: ${current}\` in ${allowance.source}, or delete the ` +
              `entry if the file no longer needs one — an allowance whose number ` +
              `is not the file's real length is the drift this gate replaced`,
          });
        } else {
          allowancesApplied.push(allowance);
        }
        continue;
      }

      findings.push({
        severity: "regression",
        kind: "grown-beyond-base",
        file,
        budget: describe,
        previous: `${previous.lines} LOC on the base ref${renamedNote}`,
        current: `${current} LOC, +${current - ceiling} beyond its ceiling`,
        problem: alreadyOver
          ? "an already-oversized file grew"
          : "the file grew past its budget",
        action: alreadyOver
          ? `split or reduce it. If the increase is genuinely necessary, say so ` +
            `out loud: add ${ALLOWANCE_DIR}/<pr-number>-<slug>.md containing ` +
            `${ALLOWANCE_FORMAT_HINT.replace(/\n/g, " ")} — one file per pull ` +
            `request, so no two branches conflict over it`
          : "split or reduce it below its budget — an allowance cannot carry a " +
            "file over its budget for the first time, only let one already over " +
            "it grow",
      });
    }
  }

  // An allowance nobody needed is either a mistake or a file that shrank, and
  // both are worth seeing. It FAILS rather than merely printing, for two
  // reasons: an allowance left lying around is the seed of the shared ledger
  // this whole change deletes, and the fix — delete three lines — is cheaper
  // than the review it would otherwise escape.
  for (const allowance of liveAllowances) {
    if (used.has(allowance.file)) continue;
    findings.push({
      severity: "regression",
      kind: "allowance-unused",
      file: allowance.file,
      budget: null,
      previous: `${allowance.source} records ${allowance.lines} LOC`,
      current: `${input.countLines(input.root, allowance.file)} LOC in the tree`,
      problem:
        "this change declares an allowance the check did not need — the file " +
        "did not grow past its ceiling, or is not a production file this policy " +
        "covers, or is not in this change at all",
      action:
        `delete the entry from ${allowance.source}. An allowance is one-shot and ` +
        `belongs to the change that needs it; one left behind is a stored ` +
        `exception, which is the thing this gate no longer has`,
    });
  }

  return {
    findings,
    baseSha: resolved.ref,
    checkedFiles,
    allowancesApplied,
  };
}
