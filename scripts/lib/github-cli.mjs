/**
 * The repository's single GitHub CLI boundary for agent-workflow tooling.
 *
 * Extracted from `scripts/issue-thread.mjs` (#2794) so the stale-container
 * reporter could resolve issue state without standing up a second `gh`
 * invocation, a second JSON parse, and — the part that actually matters — a
 * second set of guesses about what a failure means. The auth path, the
 * `gh`-not-installed message and the not-authenticated message now have one
 * home, and both callers get the same diagnosis when the CLI is unhappy.
 *
 * Node built-ins only: `scripts/ci/*` gates run before `pnpm install --frozen-lockfile` in the `verify`
 * job, and keeping this dependency-free means it stays usable from there.
 */
import { execFileSync } from "node:child_process";

/**
 * Run `gh` with the given argv and parse its stdout as JSON.
 *
 * Throws a translated Error for the two failures that are worth naming — `gh`
 * missing from PATH, and `gh` present but not authenticated — because both are
 * fixed by a specific command the caller can be told, and both otherwise
 * surface as an opaque non-zero exit.
 */
export function ghJson(args) {
  try {
    return JSON.parse(
      execFileSync("gh", args, {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        "The GitHub CLI (`gh`) is not on PATH. Install it from https://cli.github.com/ and run `gh auth login`.",
      );
    }
    const stderr = String(error?.stderr ?? "").trim();
    if (/auth login|not logged|authentication|HTTP 401/i.test(stderr)) {
      throw new Error(
        `GitHub CLI is not authenticated for this repository. Run \`gh auth login\` (or \`gh auth status\` to see why).\n${stderr}`,
      );
    }
    if (stderr) throw new Error(`\`gh ${args.join(" ")}\` failed:\n${stderr}`);
    throw error;
  }
}

/**
 * Resolve one issue's open/closed state.
 *
 * Deliberately thin: it returns whatever `gh` reports and lets the caller decide
 * what an error means. The stale-container reporter has to keep going and mark
 * that container "unknown"; `pnpm run issue` has to stop. Swallowing the error
 * here would take that choice away from both.
 *
 * `url` is returned for a reason, and a caller that treats `state` as the whole
 * answer has a bug: **`gh issue view <n>` resolves PULL REQUEST numbers too**, and
 * a closed-unmerged pull request reports `CLOSED` exactly like a closed issue.
 * Measured against this repository, `gh issue view 2026` returns
 * `state: "CLOSED"` with url `.../pull/2026` — #2026 is a CI-probe pull request,
 * not an issue at all. The url is the only field that separates the two
 * namespaces, so any caller deciding something consequential from `state` must
 * first require the url to contain `/issues/` (`scripts/stale-containers.mjs`
 * does).
 */
export function fetchIssueState(number) {
  const issue = ghJson(["issue", "view", String(number), "--json", "number,state,title,url"]);
  return {
    number: issue.number,
    state: String(issue.state ?? "").toUpperCase(),
    title: issue.title ?? "",
    url: issue.url ?? "",
  };
}
