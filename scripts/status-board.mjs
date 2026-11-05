#!/usr/bin/env node
/**
 * The generated status board (#4464): what is running, from GitHub alone.
 *
 * Read-only. It lists every open lane (the latest `CLAIM:` on an open issue or
 * pull request that no later `RELEASE:` or `HANDOVER:` ended), its last
 * `LANE-SYNC:`, the pull requests linked to it with draft or ready state, CI on
 * the exact head commit and conflict state, and the claims the `lanes:stale`
 * rule calls stale. It prints markdown; `.github/workflows/status-board.yml`
 * overwrites one issue's body with it. It replaces the hand-kept ownership
 * tables (#3905). Claims, releases and the stale rule are read by
 * `scripts/lib/lane-reservations.mjs`, shared with `pnpm run lanes:stale`.
 *
 * Deterministic: rows are ordered by number, and the only time in the output is
 * the `--now` the caller passes in.
 */

import { isMainModule } from "./lib/is-main-module.mjs";
import {
  STALE_HOURS, activeClaim, branchOf, collectReservations, holderOf, lastLaneSyncAt, readGithub, staleReservations,
} from "./lib/lane-reservations.mjs";

/** GitHub rejects an issue body past 65,536 characters; stay well inside it. */
const MAX_BODY_CHARS = 60000;
/** The heading the board opens with; the workflow refuses to overwrite an issue body that is neither empty nor this. */
export const BOARD_HEADING = "# Status board";
/** Only these conclusions pass. Cancelled, stale, timed out, action required and anything unknown do not. */
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const failed = (run) => run.status === "completed" && !PASSING_CONCLUSIONS.has(run.conclusion);

/**
 * Issue numbers a pull request body closes in `repo` (`Closes #1`, `fixes: owner/repo#2`);
 * comments, code and another repository's references are ignored.
 */
export function closedIssues(body, repo) {
  const text = (body ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const numbers = new Set();
  for (const match of text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)/gi)) {
    if (!match[1] || match[1].toLowerCase() === repo.toLowerCase()) numbers.add(Number(match[2]));
  }
  return [...numbers].sort((a, b) => a - b);
}

/**
 * CI on one head commit. With the required set known, only required checks
 * decide the state (a required check that has not reported is pending, as in
 * GitHub's "Expected - waiting for status"); without it, every check does.
 */
export function ciState(checkRuns, required) {
  const byName = new Map(checkRuns.map((run) => [run.name, run]));
  const names = required ?? [...byName.keys()];
  const failing = [];
  const pending = [];
  for (const name of names) {
    const run = byName.get(name);
    if (!run || run.status !== "completed") pending.push(name);
    else if (failed(run)) failing.push(name);
  }
  const otherFailing = required
    ? checkRuns.filter((run) => !required.includes(run.name) && failed(run)).map((run) => run.name) : [];
  let state = "pass";
  if (!names.length) state = "none";
  else if (failing.length) state = "fail";
  else if (pending.length) state = "running";
  return { state, failing: failing.sort(), pending: pending.sort(), otherFailing: otherFailing.sort() };
}

/** Conflict state from `mergeable` and `mergeable_state` (a draft reports "draft", which hides conflicts). */
export function mergeLabel(pr) {
  if (pr.mergeable === false || pr.mergeable_state === "dirty") return "conflicts";
  if (["clean", "behind", "blocked", "unstable", "has_hooks"].includes(pr.mergeable_state)) return pr.mergeable_state;
  if (pr.mergeable_state === "draft" && pr.mergeable === true) return "no conflicts";
  return "unknown";
}

/** `required_status_checks` of the base branch, or null when the token cannot see it. */
async function requiredChecks(read, repo, base) {
  try {
    const branch = await read(`repos/${repo}/branches/${encodeURIComponent(base)}`);
    const status = branch?.protection?.required_status_checks;
    const names = [...(status?.contexts ?? []), ...(status?.checks ?? []).map((check) => check.context)];
    return names.length ? [...new Set(names)].sort() : null;
  } catch {
    return null;
  }
}

async function checkRuns(read, repo, sha) {
  const runs = [];
  for (let page = 1; ; page++) {
    const rows = (await read(`repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100&page=${page}`)).check_runs ?? [];
    runs.push(...rows);
    if (rows.length < 100) return runs;
  }
}

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Everything the board needs, read through the same GET-only boundary as `lanes:stale`.
 * `base` is the default branch; a pull request into another base (an exception
 * epic's `epic/**` branch) is judged against that base's own required list where
 * readable, otherwise `base`'s. GitHub computes `mergeable` lazily, so a `null`
 * is read once more after `mergeRetryMs`.
 */
export async function collectBoard(repo, read = readGithub, base = "main", { mergeRetryMs = 2000 } = {}) {
  const requiredByBase = new Map();
  const requiredFor = async (name) => {
    if (!requiredByBase.has(name)) requiredByBase.set(name, await requiredChecks(read, repo, name));
    return requiredByBase.get(name);
  };
  const fallback = await requiredFor(base);
  const pulls = new Map();
  const readPull = async (number) => {
    if (!pulls.has(number)) {
      let pr = await read(`repos/${repo}/pulls/${number}`);
      if (pr.mergeable === null) {
        await pause(mergeRetryMs);
        pr = await read(`repos/${repo}/pulls/${number}`);
      }
      pulls.set(number, pr);
    }
    return pulls.get(number);
  };
  const threads = await collectReservations(repo, read, readPull);
  for (const thread of threads.filter((t) => t.pull_request)) {
    const pr = await readPull(thread.number);
    pr.checkRuns = await checkRuns(read, repo, pr.head.sha);
    pr.required = (await requiredFor(pr.base?.ref ?? base)) ?? fallback;
  }
  return { repo, threads, pulls };
}

/** A pull request is linked to a lane by being it, by closing it in this repository, or by its branch in this repository. */
function linkedPulls(thread, claim, pulls, repo) {
  const branch = branchOf(claim);
  return [...pulls.values()].filter((pr) => pr.number === thread.number
    || closedIssues(pr.body, repo).includes(thread.number)
    || (branch && pr.head.ref === branch && pr.head.repo?.full_name?.toLowerCase() === repo.toLowerCase()))
    .sort((a, b) => a.number - b.number);
}

/** Pure: the board's rows from collected data and an explicit `now`. */
export function buildBoard(model, now) {
  const stale = new Map(staleReservations(model.threads, now).map((row) => [row.number, row]));
  const claimed = model.threads.map((thread) => ({ thread, claim: activeClaim(thread.comments) }))
    .filter((entry) => entry.claim).sort((a, b) => a.thread.number - b.thread.number);
  const lanes = claimed.map(({ thread, claim }) => {
    const sync = lastLaneSyncAt(thread.comments, claim);
    return {
      number: thread.number, title: thread.title ?? "", url: thread.html_url, kind: thread.pull_request ? "PR" : "Issue",
      holder: holderOf(claim), claimedAt: claim.at, lastSyncAt: sync, lastPushAt: thread.pushedAt ? Date.parse(thread.pushedAt) : null,
      pushWarning: thread.pushWarning ?? null, stale: stale.has(thread.number),
      pulls: linkedPulls(thread, claim, model.pulls, model.repo).map((pr) => pr.number),
    };
  });
  const pulls = [...model.pulls.values()].sort((a, b) => a.number - b.number).map((pr) => ({
    number: pr.number, title: pr.title ?? "", url: pr.html_url, draft: Boolean(pr.draft), head: pr.head.sha.slice(0, 7),
    ci: ciState(pr.checkRuns ?? [], pr.required ?? null), requiredKnown: Boolean(pr.required), merge: mergeLabel(pr),
    lanes: lanes.filter((lane) => lane.pulls.includes(pr.number)).map((lane) => lane.number),
  }));
  return { repo: model.repo, requiredKnown: pulls.every((pr) => pr.requiredKnown), lanes, pulls, stale: [...stale.values()].sort((a, b) => a.number - b.number) };
}

/**
 * Keep text from untrusted titles and claims inert inside a table cell: no pipes,
 * tags, newlines, mentions (`@`, or an entity that decodes to one: `&` is
 * escaped in the same pass), `#123` cross-references or autolinks (`://` and
 * `www.` are broken with a zero-width space).
 */
export function cell(text, max = 80) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  const cut = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  const escaped = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "|": "\\|", "@": "@&#8203;", "#": "#&#8203;", "`": "'", "[": "(", "]": ")" };
  return cut.replace(/[&<>|@#`[\]]/g, (c) => escaped[c]).replace(/:\/\//g, ":&#8203;//").replace(/www\./gi, (m) => `${m.slice(0, 3)}&#8203;.`);
}

const when = (ms) => (ms === null ? "—" : `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}Z`);

function ciText(ci) {
  if (ci.state === "fail") return `fail: ${ci.failing.map((name) => cell(name)).join(", ")}${ci.otherFailing.length ? ` (also failing, not required: ${ci.otherFailing.map((name) => cell(name)).join(", ")})` : ""}`;
  if (ci.state === "running") return `running${ci.pending.length ? `: ${ci.pending.slice(0, 3).map((name) => cell(name)).join(", ")}${ci.pending.length > 3 ? ` +${ci.pending.length - 3}` : ""}` : ""}`;
  return ci.state;
}

const pullSummary = (pr) => `[#${pr.number}](${pr.url}) ${pr.draft ? "draft" : "ready"} · CI ${ciText(pr.ci)} · ${pr.merge}`;

function table(header, rows) {
  return [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.join(" | ")} |`)];
}

/** Pure: the markdown for a built board. */
export function renderBoard(board, now) {
  const pullsByNumber = new Map(board.pulls.map((pr) => [pr.number, pr]));
  const staleCount = board.lanes.filter((lane) => lane.stale).length;
  const red = board.pulls.filter((pr) => pr.ci.state === "fail").length;
  const conflicting = board.pulls.filter((pr) => pr.merge === "conflicts").length;
  const drafts = board.pulls.filter((pr) => pr.draft).length;
  const lines = [
    BOARD_HEADING, "",
    `Generated ${new Date(now).toISOString()} from the open issues and pull requests of \`${board.repo}\`. `
    + "The scheduled job overwrites this body every run (#4464); edit nothing here. "
    + "Claim text is shown as posted and is not verified.", "",
    `${board.lanes.length} active claims (${staleCount} stale), ${board.pulls.length} open pull requests `
    + `(${drafts} draft, ${red} red, ${conflicting} conflicting).`, "",
    "## Lanes", "",
  ];
  if (!board.lanes.length) lines.push("No active claims.");
  else {
    lines.push(...table(["Thread", "Holder", "Claimed", "Last LANE-SYNC", "Last push", "Status", "Pull requests"],
      board.lanes.map((lane) => [
        `[#${lane.number}](${lane.url}) ${cell(lane.title, 60)}`, cell(lane.holder, 40), when(lane.claimedAt), when(lane.lastSyncAt),
        lane.pushWarning ? "unknown" : when(lane.lastPushAt), lane.stale ? `**STALE** (over ${STALE_HOURS}h)` : "active",
        lane.pulls.map((n) => pullSummary(pullsByNumber.get(n))).join("<br>") || "none",
      ])));
  }
  lines.push("", "## Open pull requests", "");
  if (!board.pulls.length) lines.push("No open pull requests.");
  else {
    lines.push(...table(["Pull request", "State", "CI on head", "Merge state", "Head", "Lane"],
      board.pulls.map((pr) => [
        `[#${pr.number}](${pr.url}) ${cell(pr.title, 60)}`, pr.draft ? "draft" : "ready", ciText(pr.ci), pr.merge, `\`${pr.head}\``,
        pr.lanes.map((n) => `#${n}`).join(", ") || "none",
      ])));
    if (!board.requiredKnown) lines.push("", "A base branch's required-check list was not readable for at least one pull request, so CI counts every check on those heads.");
  }
  lines.push("", "## Stale claims", "");
  if (!board.stale.length) lines.push("No stale claims.");
  else {
    for (const row of board.stale) {
      lines.push(`- [#${row.number}](${row.url}) ${cell(row.holder, 40)}: last activity ${when(Date.parse(row.lastActivity))}. `
        + `${row.pushWarning ? `${cell(row.pushWarning, 100)} ` : ""}Check the thread, then post a \`RELEASE:\` (#4452).`);
    }
  }
  const body = `${lines.join("\n")}\n`;
  if (body.length <= MAX_BODY_CHARS) return body;
  return `${body.slice(0, body.lastIndexOf("\n", MAX_BODY_CHARS))}\n\nBoard truncated: it exceeded the issue body limit.\n`;
}

function parseArgs(argv) {
  const usage = "Usage: pnpm run status [owner/repo] [--now <ISO-8601 time>] [--base <default branch>]";
  let repo = "thatskiff33/AlpineClubBookingsNZ";
  let now = Date.now();
  let base = "main";
  const rest = [...argv];
  while (rest.length) {
    const arg = rest.shift();
    if (arg === "--now") {
      now = Date.parse(rest.shift() ?? "");
      if (Number.isNaN(now)) throw new Error(usage);
    } else if (arg === "--base") {
      base = rest.shift() ?? "";
      if (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(base)) throw new Error(usage);
    } else if (/^[\w.-]+\/[\w.-]+$/.test(arg)) repo = arg;
    else throw new Error(usage);
  }
  return { repo, now, base };
}

async function main() {
  const { repo, now, base } = parseArgs(process.argv.slice(2));
  process.stdout.write(renderBoard(buildBoard(await collectBoard(repo, readGithub, base), now), now));
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
