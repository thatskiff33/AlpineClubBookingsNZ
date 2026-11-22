/**
 * A trusted upstream for the size ratchets, for a deployment fork that syncs
 * down from this repository (#5196).
 *
 * Both ratchets compare the working tree with the fork's base ref, one pull
 * request at a time. A sync-down moves that base across many upstream pull
 * requests in one step, and two things then fail that the fork cannot fix:
 * a function or file upstream took over its limit before the ratchet existed
 * (or under a rename the cumulative diff no longer reads as one) arrives
 * looking NEW, and every upstream `size-allowances.d/` fragment in the range
 * arrives looking LIVE. Upstream already judged that code, one pull request at
 * a time, so the fork's gate has nothing to add by judging it again.
 *
 * The rule this module states once, for both ratchets (INV-SSOT):
 *
 *   - U, the trusted commit, is the newest commit on the upstream ref's
 *     FIRST-PARENT chain that `HEAD` contains: the upstream `main` this
 *     checkout actually merged, not wherever the upstream branch has got to.
 *     An upstream tip the fork has not merged adds no trust at all. First
 *     parent only, because a plain merge base can land on a commit in the
 *     middle of a merged upstream pull request's branch — a fork that merged
 *     that side commit would otherwise trust code upstream's `main` never
 *     carried and upstream's gate never judged as a whole.
 *     ASSUMPTION: the first-parent chain is what upstream's `main` carried
 *     only while upstream lands every pull request with a merge commit
 *     (AGENTS.md, "Completion and Merge", step 4: merge with a merge commit).
 *     A pull request that upstream fast-forwards or rebase-merges puts its
 *     intermediate commits ON that chain, and a fork that merged one of them
 *     would have it trusted. Nothing below detects that: the rule is only as
 *     good as upstream's keeping to merge commits.
 *   - Only paths upstream changed between M (the merge base of U and the
 *     fork's base) and U are trusted: the files this sync brings in. A path
 *     upstream did not touch in that range gets no upstream baseline, so it
 *     is judged against the fork's base exactly as before.
 *   - For a trusted path, the ratchets take the LONGER of the fork-base length
 *     and U's length as the previous length. A file or function the fork left
 *     as upstream wrote it therefore passes; one the fork lengthens beyond U is
 *     judged as fork growth, and may need its own allowance.
 *   - A `size-allowances.d/` fragment byte-identical to U's copy of a trusted
 *     path is upstream's, spent upstream, and is not live here.
 *
 * When U is `HEAD` itself — the checkout IS upstream content, as on a
 * fast-forward sync or a push of one to the fork's `main` — there is no fork
 * change to separate from upstream's, so trust is IGNORED rather than applied:
 * the ratchets run exactly as they would without it. An upstream ref that
 * cannot be resolved fails, as an unresolvable base does.
 */
import { execFileSync } from "node:child_process";

import { baseContentOf, resolveBaseRef } from "./file-size-base";

export type UpstreamTrust =
  | {
      kind: "trusted";
      /** U: the upstream commit this checkout contains. */
      sha: string;
      /** U's commit subject, so a run names what it trusted. */
      subject: string;
      /** M: where the fork's base and U last met. */
      mergeBase: string;
      /** Paths upstream changed between M and U. */
      changedPaths: ReadonlySet<string>;
      /** A trusted path's bytes at U; null when U does not have it or it is untrusted. */
      contentAt: (file: string) => Buffer | null;
    }
  | { kind: "ignored-head"; sha: string }
  | { kind: "unusable"; error: string };

/** The one line a run prints when trust resolves to `HEAD` (#5196). */
export const UPSTREAM_IGNORED_LINE = "Trusted upstream ignored: resolves to HEAD";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    cwd: root,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function firstLine(error: unknown): string {
  return error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
}

function isAncestorOfHead(root: string, sha: string): boolean {
  try {
    git(root, ["merge-base", "--is-ancestor", sha, "HEAD"]);
    return true;
  } catch {
    // Exit 1 means "not an ancestor"; any other failure is no evidence either.
    return false;
  }
}

/**
 * U, the upstream commit this checkout contains, without reference to the
 * fork's base: the first step of `resolveUpstreamTrust`.
 *
 * The first-parent chain is newest first, and containment is monotone along
 * it — every older first-parent commit is an ancestor of a newer one — so a
 * binary search finds the newest contained commit in a few `--is-ancestor`
 * calls however long upstream's history is.
 */
export function resolveUpstreamCommit(
  root: string,
  upstreamRef: string,
): { kind: "commit"; sha: string } | { kind: "ignored-head"; sha: string } | { kind: "unusable"; error: string } {
  // Resolves the ref and proves it shares history with HEAD, with the same
  // remedies the base ref gets.
  const shared = resolveBaseRef(root, upstreamRef);
  if (!shared.ok) {
    return {
      kind: "unusable",
      error: `The trusted upstream --upstream-ref could not be resolved.\n  ${shared.error}`,
    };
  }
  let head: string;
  let chain: string[];
  try {
    head = git(root, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
    const tip = git(root, ["rev-parse", "--verify", `${upstreamRef}^{commit}`]).trim();
    chain = git(root, ["rev-list", "--first-parent", tip]).split("\n").filter(Boolean);
  } catch (error) {
    return { kind: "unusable", error: `Could not read the trusted upstream's history: ${firstLine(error)}` };
  }

  let low = 0;
  let high = chain.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (isAncestorOfHead(root, chain[mid] as string)) high = mid;
    else low = mid + 1;
  }
  const sha = chain[low];
  if (sha === undefined) {
    return {
      kind: "unusable",
      error:
        `No commit on the first-parent history of \`${upstreamRef}\` is contained in HEAD, so ` +
        `there is no upstream main commit to trust.\n` +
        `  A sync must merge upstream's main itself, with a merge commit. Fix with:  ` +
        `merge the upstream branch rather than one of its pull requests' commits`,
    };
  }
  return sha === head ? { kind: "ignored-head", sha } : { kind: "commit", sha };
}

/**
 * Resolve what the ratchets may trust, given the fork's resolved base commit.
 *
 * Fails closed: any git read that does not answer makes the trust `unusable`,
 * which both ratchets report as a finding rather than falling back to an
 * ordinary run the caller did not ask for.
 */
export function resolveUpstreamTrust(
  root: string,
  upstreamRef: string,
  baseSha: string,
): UpstreamTrust {
  const commit = resolveUpstreamCommit(root, upstreamRef);
  if (commit.kind !== "commit") return commit;
  const sha = commit.sha;

  try {
    const subject = git(root, ["log", "-1", "--format=%s", sha]).trim();
    const mergeBase = git(root, ["merge-base", sha, baseSha]).trim();
    if (!mergeBase) throw new Error("merge-base produced no commit");
    const changedPaths = new Set(
      git(root, ["diff", "--no-renames", "--name-only", "-z", mergeBase, sha])
        .split("\0")
        .filter(Boolean),
    );
    const cache = new Map<string, Buffer | null>();
    const contentAt = (file: string): Buffer | null => {
      if (!changedPaths.has(file)) return null;
      if (!cache.has(file)) cache.set(file, baseContentOf(root, sha, file));
      return cache.get(file) ?? null;
    };
    return { kind: "trusted", sha, subject, mergeBase, changedPaths, contentAt };
  } catch (error) {
    return {
      kind: "unusable",
      error:
        `The trusted upstream ${sha.slice(0, 12)} shares no readable history with the ` +
        `base ${baseSha.slice(0, 12)} (${firstLine(error)}).\n` +
        `  Fix with:  git fetch --unshallow, or fetch the upstream ref with full history`,
    };
  }
}

/**
 * The trust both ratchets are handed, resolved against the same base they
 * resolve. Undefined when no upstream was named, or when the base itself
 * cannot be resolved — each ratchet then reports the base as it always has.
 */
export function upstreamTrustFor(
  root: string,
  baseRef: string,
  upstreamRef: string | null | undefined,
): UpstreamTrust | undefined {
  if (!upstreamRef) return undefined;
  const base = resolveBaseRef(root, baseRef);
  if (!base.ok) return undefined;
  return resolveUpstreamTrust(root, upstreamRef, base.sha);
}
