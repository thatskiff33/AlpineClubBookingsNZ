/**
 * Shared PR-body and changed-file plumbing for the pull-request gates in this
 * directory.
 *
 * Both gates run before `pnpm install --frozen-lockfile` in the `verify` job, so this module stays
 * dependency-free and uses only Node built-ins.
 *
 * Extracted from `check-pr-concurrency-declaration.mjs` when the changelog
 * fragment gate (#2452) needed exactly the same behaviour: read the CURRENT PR
 * body so an author who edits it after a failing run can go green on a plain
 * re-run, and fall back to the (possibly stale) event payload when the API is
 * unavailable.
 */
import { execFileSync } from "node:child_process";

/**
 * Body-source selection, factored pure so it can be unit tested without network
 * access. A successfully fetched live body (even an empty one, which fails
 * closed) wins; the event-payload body is used only when the fetch was
 * unavailable or failed (fetchedBody === null).
 */
export function selectPrBody({ fetchedBody, eventBody }) {
  if (typeof fetchedBody === "string") {
    return fetchedBody;
  }
  return typeof eventBody === "string" ? eventBody : "";
}

/**
 * Fetch the CURRENT PR body from the GitHub API so that an author who edits the
 * body after a failing run can re-run the job and go green. The workflow uses
 * the default `pull_request` event types (no `edited`), so the event payload
 * body can be stale; re-running replays that stale payload. Returns null on any
 * missing input or failure so the caller falls back to the event body (which
 * preserves today's behavior and still fails closed on a missing/empty body).
 *
 * `label` prefixes the warning lines so the log names the gate that is talking.
 */
export async function fetchLivePrBody(label) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const prNumber = process.env.PR_NUMBER;
  if (!token || !repo || !prNumber) {
    return null;
  }
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "alpineclub-pr-gate",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      console.warn(
        `${label}: could not fetch live PR body (HTTP ${response.status}); falling back to event payload body.`,
      );
      return null;
    }
    const data = await response.json();
    // GitHub sends `body: null` for an empty PR body; normalize to "" so an
    // empty live body fails closed rather than falling back to the event payload.
    return typeof data.body === "string" ? data.body : "";
  } catch (error) {
    console.warn(
      `${label}: live PR body fetch failed (${error.message}); falling back to event payload body.`,
    );
    return null;
  }
}

/**
 * Run `git diff` over a PR's range and return the raw changed-file listing.
 *
 * `-c core.quotePath=false` is LOAD-BEARING, not tidiness. With git's default
 * `quotePath=true` any path containing a non-ASCII byte is emitted C-quoted —
 * `src/lib/café.ts` arrives as `"src/lib/caf\303\251.ts"`, complete with the
 * leading double quote. Every path pattern in these gates is anchored (`^src/`,
 * `^prisma/`, `^changelog\.d/`), so a quoted path matches NOTHING: the
 * concurrency gate stops seeing a sensitive file and accepts a bare `N/A`, and
 * the changelog gate stops seeing a code change and waves the PR through. Both
 * fail OPEN, silently, on exactly the kind of file whose name nobody inspects.
 * With the flag the bytes are emitted verbatim and the patterns match again.
 *
 * `--name-status` is the ONLY shape offered, and that is deliberate. It used to
 * be opt-in, with `--name-only` as the default, and `--name-only` prints only
 * the DESTINATION of a detected rename: a PR that moves
 * `src/lib/payment-settlement.ts` to `src/lib/ledger.ts` and edits the lock
 * order on the way arrives as one non-sensitive path, so the concurrency gate
 * stops asking for a declaration on money code. `parseNameStatus` expands `R`
 * back into the delete + add pair it is, which puts BOTH endpoints back in front
 * of the sensitive-path test. Status is also what lets the changelog gate tell
 * an added fragment from the ones a release compile deletes. Every caller runs
 * the output through `parseNameStatus`.
 */
export function gitDiffChangedFiles(base, head, { cwd } = {}) {
  return execFileSync(
    "git",
    ["-c", "core.quotePath=false", "diff", "--name-status", `${base}...${head}`],
    { encoding: "utf8", ...(cwd ? { cwd } : {}) },
  );
}

/**
 * Parse `git diff --name-status` output into `[{ status, path }]` records with
 * single-letter statuses (A/M/D/T/...).
 *
 * Status matters to the changelog gate: a PR that *deletes* fragments (the
 * release compile) must not be credited with adding one. A rename is expanded
 * into the delete + add pair it actually is, so a file moved out of `src/`
 * still counts as a source change.
 */
export function parseNameStatus(stdout) {
  const records = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.split("\t");
    const status = fields[0]?.[0] ?? "";
    if (!status) continue;
    if ((status === "R" || status === "C") && fields.length >= 3) {
      if (status === "R") {
        records.push({ status: "D", path: fields[1] });
      }
      records.push({ status: "A", path: fields[2] });
      continue;
    }
    if (fields[1]) {
      records.push({ status, path: fields[1] });
    }
  }
  return records;
}
