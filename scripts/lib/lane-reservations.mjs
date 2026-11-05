/**
 * The one reader of lane reservations: `CLAIM:`, `LANE-SYNC:`, `RELEASE:` and
 * `HANDOVER:` comments on open issues and pull requests, and the 72-hour stale
 * rule built on them (#4452).
 *
 * Extracted from `scripts/lanes-stale.mjs` (#4464) so the generated status
 * board reads claims, releases and push activity exactly as the stale report
 * does, instead of keeping a second parser that could disagree about who holds
 * what. Read-only: nothing here writes to GitHub. Node built-ins only, so it
 * runs before any install.
 */

import { ghJson } from "./github-cli.mjs";

export const STALE_HOURS = 72;
const STALE_MS = STALE_HOURS * 60 * 60 * 1000;

/** Parse only a comment's opening workflow prefix, never quoted examples. */
export function event(comment) {
  const match = comment.body?.trimStart().match(/^(CLAIM|LANE-SYNC|RELEASE|HANDOVER)\b:?\s*([^\n]*)/);
  if (!match) return null;
  return { id: comment.id ?? 0, kind: match[1], text: match[2], at: Date.parse(comment.created_at), body: comment.body };
}

function compareEvents(a, b) {
  return a.at - b.at || a.id - b.id;
}

function latestClaim(comments) {
  return comments.map(event).filter((e) => e?.kind === "CLAIM")
    .sort((a, b) => compareEvents(b, a))[0];
}

/** The latest `CLAIM:` unless a later `RELEASE:` or `HANDOVER:` ended it. */
export function activeClaim(comments) {
  const claim = latestClaim(comments);
  if (!claim || comments.map(event).some((e) => e && compareEvents(e, claim) > 0 &&
    (e.kind === "RELEASE" || e.kind === "HANDOVER"))) return null;
  return claim;
}

/** The time of the newest `LANE-SYNC:` after the claim, or null when there is none. */
export function lastLaneSyncAt(comments, claim) {
  const times = comments.map(event)
    .filter((e) => e?.kind === "LANE-SYNC" && compareEvents(e, claim) > 0).map((e) => e.at);
  return times.length ? Math.max(...times) : null;
}

export function branchOf(claim) {
  const match = claim?.body.match(/(?:^|[\n.,;])\s*(?:[-*]\s+)?branch\s*[:=]?\s*(?:`([^`\n]+)`|([^\s]+))/im);
  // Backticks delimit a literal ref; unquoted refs can end with prose punctuation.
  return match?.[1] ?? match?.[2]?.replace(/[.,;]+$/, "");
}

/** The lane named in a claim. GitHub author names identify the shared account, not the lane. */
export function holderOf(claim) {
  return claim.text.split(/\s+Branch\b|\s+Scope:/i)[0].trim().replace(/[.,;:]+$/, "") || "Unnamed lane (inspect CLAIM)";
}

/** Latest of the claim, its later `LANE-SYNC:` comments and the branch's last push. */
export function lastActivityAt(thread, claim) {
  const sync = lastLaneSyncAt(thread.comments, claim);
  return Math.max(claim.at, ...(sync === null ? [] : [sync]), thread.pushedAt ? Date.parse(thread.pushedAt) : claim.at);
}

/**
 * Pure input: open threads with REST-shaped comments and optional pushedAt.
 * `now` is explicit so fixtures never depend on the real calendar.
 */
export function staleReservations(threads, now) {
  const stale = [];
  for (const thread of threads) {
    const claim = activeClaim(thread.comments);
    if (!claim) continue;
    const lastActivity = lastActivityAt(thread, claim);
    if (now - lastActivity <= STALE_MS) continue;
    const holder = holderOf(claim);
    stale.push({ number: thread.number, url: thread.html_url, kind: thread.pull_request ? "PR" : "Issue",
      holder, ...(thread.pushWarning ? { pushWarning: thread.pushWarning } : {}), lastActivity: new Date(lastActivity).toISOString(),
      action: `Release ${holder}'s reservation on #${thread.number} (auto-release after 72 hours, #4452).` });
  }
  return stale;
}

/** GET-only CLI boundary; public REST reads also work without gh/authentication. */
export async function readGithub(endpoint) {
  try {
    return ghJson(["api", "--method", "GET", endpoint]);
  } catch (error) {
    if (!/not on PATH|not authenticated/i.test(error.message)) throw error;
    const response = await fetch(`https://api.github.com/${endpoint}`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) throw new Error(`GitHub GET ${endpoint}: HTTP ${response.status}`);
    return response.json();
  }
}

export async function allPages(read, endpoint) {
  const result = [];
  for (let page = 1; ; page++) {
    const rows = await read(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    result.push(...rows);
    if (rows.length < 100) return result;
  }
}

/**
 * Collect all open issues AND PRs (the REST issues endpoint includes both).
 * `readPull` is injectable so the status board can keep the pull requests this
 * walk already fetched instead of requesting each one a second time.
 */
export async function collectReservations(repo, read = readGithub, readPull = (number) => read(`repos/${repo}/pulls/${number}`)) {
  const root = `repos/${repo}`;
  const threads = await allPages(read, `${root}/issues?state=open`);
  const pushes = new Map();
  for (const thread of threads) {
    thread.comments = await allPages(read, `${root}/issues/${thread.number}/comments`);
    const claim = activeClaim(thread.comments);
    if (!claim) continue;
    let branch = branchOf(claim);
    let branchRepo = repo;
    if (thread.pull_request) {
      const pr = await readPull(thread.number);
      branch ??= pr.head.ref;
      branchRepo = pr.head.repo?.full_name;
    }
    if (!branch || !branchRepo) {
      thread.pushWarning = "Branch unavailable: check push activity manually before releasing.";
      continue;
    }
    const key = `${branchRepo}:${branch}`;
    if (!pushes.has(key)) {
      // Activity timestamps are push times, unlike commit author/committer dates.
      // Ordinary and force pushes are separate GitHub activity types.
      const times = [];
      for (const type of ["push", "force_push"]) {
        const rows = await read(`repos/${branchRepo}/activity?ref=${encodeURIComponent(`refs/heads/${branch}`)}&activity_type=${type}&per_page=1`);
        if (rows[0]) times.push(rows[0].timestamp);
      }
      pushes.set(key, times.sort().at(-1));
    }
    thread.pushedAt = pushes.get(key);
  }
  return threads;
}
