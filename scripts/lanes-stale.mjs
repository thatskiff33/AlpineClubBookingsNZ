#!/usr/bin/env node
/** Read-only reservation report. No GitHub writes or automatic release. */

import { ghJson } from "./lib/github-cli.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

const STALE_HOURS = 72;
const STALE_MS = STALE_HOURS * 60 * 60 * 1000;

/** Parse only a comment's opening workflow prefix, never quoted examples. */
function event(comment) {
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

function activeClaim(comments) {
  const claim = latestClaim(comments);
  if (!claim || comments.map(event).some((e) => e && compareEvents(e, claim) > 0 &&
    (e.kind === "RELEASE" || e.kind === "HANDOVER"))) return null;
  return claim;
}

function branchOf(claim) {
  const match = claim?.body.match(/(?:^|[\n.,;])\s*(?:[-*]\s+)?branch\s*[:=]?\s*(?:`([^`\n]+)`|([^\s]+))/im);
  // Backticks delimit a literal ref; unquoted refs can end with prose punctuation.
  return match?.[1] ?? match?.[2]?.replace(/[.,;]+$/, "");
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
    const subsequent = thread.comments.map(event).filter((e) => e && compareEvents(e, claim) > 0);
    const lastActivity = Math.max(claim.at, ...subsequent.filter((e) => e.kind === "LANE-SYNC").map((e) => e.at),
      thread.pushedAt ? Date.parse(thread.pushedAt) : claim.at);
    if (now - lastActivity <= STALE_MS) continue;
    // GitHub author names identify the shared account, not the lane.
    const holder = claim.text.split(/\s+Branch\b|\s+Scope:/i)[0].trim().replace(/[.,;:]+$/, "") || "Unnamed lane (inspect CLAIM)";
    stale.push({ number: thread.number, url: thread.html_url, kind: thread.pull_request ? "PR" : "Issue",
      holder, ...(thread.pushWarning ? { pushWarning: thread.pushWarning } : {}), lastActivity: new Date(lastActivity).toISOString(),
      action: `Release ${holder}'s reservation on #${thread.number} (auto-release after 72 hours, #4452).` });
  }
  return stale;
}

/** GET-only CLI boundary; public REST reads also work without gh/authentication. */
async function readGithub(endpoint) {
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

async function allPages(read, endpoint) {
  const result = [];
  for (let page = 1; ; page++) {
    const rows = await read(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    result.push(...rows);
    if (rows.length < 100) return result;
  }
}

/** Collect all open issues AND PRs (the REST issues endpoint includes both). */
export async function collectReservations(repo, read = readGithub) {
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
      const pr = await read(`${root}/pulls/${thread.number}`);
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

async function main() {
  const repo = process.argv[2] ?? "thatskiff33/AlpineClubBookingsNZ";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || process.argv.length > 3) {
    throw new Error("Usage: pnpm run lanes:stale [owner/repo]");
  }
  const stale = staleReservations(await collectReservations(repo), Date.now());
  console.log(`Stale reservations (>${STALE_HOURS} hours). Report only; check the thread, then post a RELEASE: on each (#4452).`);
  for (const row of stale) {
    console.log(`\n${row.kind} #${row.number} ${row.url}\nHolder: ${row.holder}\nLast activity: ${row.lastActivity}${row.pushWarning ? `\n${row.pushWarning}` : ""}\nAction: ${row.action}`);
  }
  if (!stale.length) console.log("No stale reservations.");
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
