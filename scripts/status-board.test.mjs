import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { TRUSTED_LANE_AUTHORS } from "./lib/lane-reservations.mjs";
import { BOARD_HEADING, buildBoard, cell, ciState, closedIssues, collectBoard, mergeLabel, renderBoard } from "./status-board.mjs";

// REST-shaped responses, written from the documented shapes of the issues,
// comments, pulls, check-runs, branch and activity endpoints and keyed by the
// request path. They are NOT live recordings: nothing here may read GitHub.
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/status-board/open-board.json", import.meta.url), "utf8"));
const golden = readFileSync(new URL("./fixtures/status-board/open-board.expected.md", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../.github/workflows/status-board.yml", import.meta.url), "utf8");
const agentsDoc = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");

// The frozen test clock (AGENTS.md): never the real calendar.
const now = Date.parse("2026-07-01T00:00:00Z");
const repo = "thatskiff33/AlpineClubBookingsNZ";
const noRetry = { mergeRetryMs: 0 };

function replay(responses = fixtures) {
  return vi.fn(async (path) => {
    if (!(path in responses)) throw new Error(`Unexpected request ${path}`);
    return structuredClone(responses[path]);
  });
}

const collect = (responses, read = replay(responses)) => collectBoard(repo, read, "main", noRetry);
const board = async (responses) => buildBoard(await collect(responses), now);

describe("closedIssues", () => {
  it("reads closing keywords and ignores comments, code and unrelated numbers", () => {
    expect(closedIssues("Closes #4\nfixes: #2 and Resolved #9\nSee #7", "o/r")).toEqual([2, 4, 9]);
    expect(closedIssues("<!-- Closes #1 -->\n`Closes #2`\n```\nFixes #3\n```\nCloses o/r#5", "o/r")).toEqual([5]);
    expect(closedIssues(null, "o/r")).toEqual([]);
  });

  it("accepts a bare number or this repository's, never another repository's", () => {
    expect(closedIssues("Closes #1\nFixes O/R#2\nResolves other/repo#3\nCloses someone/o#4", "o/r")).toEqual([1, 2]);
  });
});

describe("ciState", () => {
  const run = (name, status = "completed", conclusion = "success") => ({ name, status, conclusion });

  it("fails on a required failure and names it, listing non-required failures apart", () => {
    const state = ciState([run("verify", "completed", "failure"), run("Lint", "completed", "timed_out"), run("E2E", "in_progress")], ["verify", "E2E"]);
    expect(state).toEqual({ state: "fail", failing: ["verify"], pending: ["E2E"], otherFailing: ["Lint"] });
  });

  it("is running while a required check is in flight or has not reported", () => {
    expect(ciState([run("verify", "queued")], ["verify"]).state).toBe("running");
    expect(ciState([run("verify")], ["verify", "Playwright E2E"])).toMatchObject({ state: "running", pending: ["Playwright E2E"] });
  });

  it("passes only on success, neutral and skipped", () => {
    expect(ciState([run("verify"), run("Lint", "completed", "skipped"), run("Docs", "completed", "neutral")], null).state).toBe("pass");
  });

  it.each(["cancelled", "stale", "timed_out", "action_required", "failure", "startup_failure", "something_new", null])(
    "does not pass a completed check whose conclusion is %s", (conclusion) => {
      expect(ciState([run("verify", "completed", conclusion)], ["verify"])).toMatchObject({ state: "fail", failing: ["verify"] });
      expect(ciState([run("verify"), run("Lint", "completed", conclusion)], ["verify"])).toMatchObject({ state: "pass", otherFailing: ["Lint"] });
    });

  it("counts every check when the required set is unknown, and reports none for an empty head", () => {
    expect(ciState([run("Lint", "completed", "failure")], null)).toMatchObject({ state: "fail", failing: ["Lint"] });
    expect(ciState([], null).state).toBe("none");
  });
});

describe("mergeLabel", () => {
  it.each([
    [{ mergeable: false, mergeable_state: "dirty" }, "conflicts"],
    [{ mergeable: false, mergeable_state: "draft" }, "conflicts"],
    [{ mergeable: true, mergeable_state: "clean" }, "clean"],
    [{ mergeable: true, mergeable_state: "behind" }, "behind"],
    [{ mergeable: true, mergeable_state: "blocked" }, "blocked"],
    [{ mergeable: true, mergeable_state: "draft" }, "no conflicts"],
    [{ mergeable: null, mergeable_state: "unknown" }, "unknown"],
  ])("maps %j to %s", (pr, label) => {
    expect(mergeLabel(pr)).toBe(label);
  });
});

describe("the board built from REST-shaped responses", () => {
  it("lists only open claims, in issue order, and drops a released one", async () => {
    const built = await board();
    expect(built.lanes.map((lane) => lane.number)).toEqual([101, 102, 104, 105, 106]);
    expect(built.lanes.map((lane) => lane.holder)).toEqual(["Alpine lane", "Summit lane", "Ridge lane", "Col lane", "Moraine | lane @owner"]);
  });

  it("carries each claim's last LANE-SYNC and last push", async () => {
    const [alpine, summit] = (await board()).lanes;
    expect(new Date(alpine.lastSyncAt).toISOString()).toBe("2026-06-30T20:00:00.000Z");
    expect(new Date(alpine.lastPushAt).toISOString()).toBe("2026-06-30T21:00:00.000Z");
    expect(summit.lastSyncAt).toBeNull();
  });

  it("marks only the lane the lanes:stale rule reports as stale", async () => {
    const built = await board();
    expect(built.lanes.filter((lane) => lane.stale).map((lane) => lane.number)).toEqual([102]);
    expect(built.stale).toEqual([expect.objectContaining({ number: 102, holder: "Summit lane", lastActivity: "2026-06-21T12:00:00.000Z" })]);
  });

  it("ignores a stranger's CLAIM, RELEASE and LANE-SYNC when building lanes", async () => {
    const stranger = (id, body, at) => ({ id, body, created_at: at, user: { login: "stranger" } });
    const responses = { ...fixtures,
      [`repos/${repo}/issues/101/comments?per_page=100&page=1`]: [...fixtures[`repos/${repo}/issues/101/comments?per_page=100&page=1`],
        stranger(9001, "RELEASE: not yours to release", "2026-06-30T22:00:00Z")],
      [`repos/${repo}/issues/103/comments?per_page=100&page=1`]: [...fixtures[`repos/${repo}/issues/103/comments?per_page=100&page=1`],
        stranger(9002, "CLAIM: Squatter lane", "2026-06-30T22:00:00Z")],
      [`repos/${repo}/issues/102/comments?per_page=100&page=1`]: [...fixtures[`repos/${repo}/issues/102/comments?per_page=100&page=1`],
        stranger(9003, "LANE-SYNC: still here", "2026-06-30T22:00:00Z")],
    };
    const built = await board(responses);
    expect(built.lanes.map((lane) => lane.number)).toEqual([101, 102, 104, 105, 106]);
    expect(built.lanes.find((lane) => lane.number === 102)).toMatchObject({ stale: true, lastSyncAt: null });
  });

  it("keeps the trusted-account list in one place and in step with AGENTS.md", () => {
    expect(TRUSTED_LANE_AUTHORS).toEqual(["thatskiff33", "thatskiff33-agents", "sekreton[bot]"]);
    expect(agentsDoc.replace(/\s+/g, " ")).toContain("agents are `thatskiff33-agents` or `sekreton[bot]`, the owner is `thatskiff33`");
  });

  it("links a pull request to its lane by closing keyword in this repository, and not by a fork's same-named branch", async () => {
    const built = await board();
    expect(built.lanes.map((lane) => lane.pulls)).toEqual([[201], [], [202], [203], [204]]);
    expect(built.pulls.map((pr) => pr.number)).toEqual([201, 202, 203, 204, 205, 206, 207, 208, 209, 210]);
    expect(built.pulls.map((pr) => pr.lanes)).toEqual([[101], [104], [105], [106], [], [], [], [], [], []]);
  });

  it("links by branch only when the head repository is this one, and survives a deleted fork", async () => {
    const sameRepo = { ...fixtures, [`repos/${repo}/pulls/206`]: { ...fixtures[`repos/${repo}/pulls/206`],
      head: { ref: "feat/102-export", sha: "f".repeat(40), repo: { full_name: repo } } } };
    expect((await board(sameRepo)).lanes.find((lane) => lane.number === 102).pulls).toEqual([206]);
    const forked = { ...fixtures, [`repos/${repo}/pulls/206`]: { ...fixtures[`repos/${repo}/pulls/206`],
      head: { ref: "feat/102-export", sha: "f".repeat(40), repo: { full_name: "some-fork/AlpineClubBookingsNZ" } } } };
    expect((await board(forked)).lanes.find((lane) => lane.number === 102).pulls).toEqual([]);
    const deleted = { ...fixtures, [`repos/${repo}/pulls/207`]: { ...fixtures[`repos/${repo}/pulls/207`],
      head: { ref: "feat/102-export", sha: "g".repeat(40), repo: null } } };
    expect((await board(deleted)).lanes.find((lane) => lane.number === 102).pulls).toEqual([]);
  });

  it("does not link a pull request that closes another repository's issue with the same number", async () => {
    const built = await board();
    expect(built.pulls.find((pr) => pr.number === 207).lanes).toEqual([]);
    expect(built.lanes.find((lane) => lane.number === 101).pulls).toEqual([201]);
  });

  it("reports a conflicting pull request from mergeable_state", async () => {
    const pr = (await board()).pulls.find((p) => p.number === 202);
    expect(pr).toMatchObject({ merge: "conflicts", draft: false, ci: { state: "running", pending: ["Playwright E2E"] } });
  });

  it("reports a red pull request with the failing required check names", async () => {
    const pr = (await board()).pulls.find((p) => p.number === 203);
    expect(pr.ci).toEqual({ state: "fail", failing: ["verify"], pending: ["Playwright E2E", "Static analysis gate"], otherFailing: ["Typecheck"] });
  });

  it("fails a pull request whose required check was cancelled or stale", async () => {
    const built = await board();
    expect(built.pulls.find((p) => p.number === 209).ci).toMatchObject({ state: "fail", failing: ["Dependency audit"] });
    expect(built.pulls.find((p) => p.number === 207).ci.state).toBe("pass"); // a cancelled non-required check does not fail it
  });

  it("reports a draft pull request and a green ready one", async () => {
    const built = await board();
    expect(built.pulls.find((p) => p.number === 204)).toMatchObject({ draft: true, merge: "no conflicts", ci: { state: "running" } });
    expect(built.pulls.find((p) => p.number === 201)).toMatchObject({ draft: false, merge: "clean", ci: { state: "pass" }, head: "aaaaaaa" });
  });

  it("judges a pull request into an epic branch by that branch's own required list, else the default branch's", async () => {
    const built = await board();
    // 208's own list is verify + Lint, so its in-flight Playwright check does not hold it.
    expect(built.pulls.find((p) => p.number === 208)).toMatchObject({ ci: { state: "pass" }, requiredKnown: true });
    // 209's branch protection is unreadable, so it falls back to the default branch's list (and still fails on Dependency audit).
    expect(built.pulls.find((p) => p.number === 209)).toMatchObject({ requiredKnown: true });
  });

  it("marks a stacked pull request, into a base that gets no CI, instead of showing it running for ever", async () => {
    const built = await board();
    expect(built.pulls.find((p) => p.number === 210)).toMatchObject({ ci: { state: "no-ci" }, requiredKnown: true });
    expect(renderBoard(built, now)).toContain("no CI on this base");
  });

  it("falls back to the default branch's list for an unprotected epic branch, or when the protection read errored", async () => {
    const rebased = (number, ref) => ({ ...fixtures, [`repos/${repo}/pulls/${number}`]: {
      ...fixtures[`repos/${repo}/pulls/${number}`], base: { ...fixtures[`repos/${repo}/pulls/${number}`].base, ref } } });
    // An epic branch with no protection: CI runs there, so the default branch's list applies (nothing has reported: running).
    const epic = { ...rebased(210, "epic/5-unprotected"), [`repos/${repo}/branches/epic%2F5-unprotected`]: { name: "epic/5-unprotected", protected: false } };
    expect((await board(epic)).pulls.find((p) => p.number === 210).ci.state).toBe("running");
    // A stacked base whose protection could not be read is not assumed CI-less.
    expect((await board(rebased(210, "feat/unreadable"))).pulls.find((p) => p.number === 210).ci.state).toBe("running");
  });

  it("reads CI on each pull request's exact head commit, and each pull request once", async () => {
    const read = replay();
    await collect(undefined, read);
    const paths = read.mock.calls.map(([path]) => path);
    expect(paths).toContain(`repos/${repo}/commits/${"c".repeat(40)}/check-runs?filter=latest&per_page=100&page=1`);
    expect(paths.filter((path) => path === `repos/${repo}/pulls/201`)).toHaveLength(1);
  });

  it("re-reads a pull request whose mergeable is still null, once", async () => {
    const serve = replay();
    let reads = 0;
    const read = vi.fn(async (path) => {
      const value = await serve(path);
      if (path === `repos/${repo}/pulls/201` && ++reads === 1) return { ...value, mergeable: null, mergeable_state: "unknown" };
      return value;
    });
    const built = buildBoard(await collect(undefined, read), now);
    expect(reads).toBe(2);
    expect(built.pulls.find((p) => p.number === 201).merge).toBe("clean");

    reads = 0;
    const stuck = vi.fn(async (path) => {
      const value = await serve(path);
      if (path === `repos/${repo}/pulls/201`) { reads += 1; return { ...value, mergeable: null, mergeable_state: "unknown" }; }
      return value;
    });
    expect(buildBoard(await collect(undefined, stuck), now).pulls.find((p) => p.number === 201).merge).toBe("unknown");
    expect(reads).toBe(2);
  });

  it("renders the board exactly, the same every time", async () => {
    const text = renderBoard(await board(), now);
    expect(text).toBe(golden);
    expect(text.startsWith(`${BOARD_HEADING}\n`)).toBe(true);
    expect(renderBoard(await board(), now)).toBe(text);
  });

  it("changes only with its explicit clock: a later now ages claims into stale", async () => {
    const built = await board();
    const later = Date.parse("2026-07-04T00:00:00Z");
    expect(renderBoard(built, later)).toContain("Generated 2026-07-04T00:00:00.000Z");
    const aged = buildBoard(await collect(), later);
    expect(aged.stale.map((row) => row.number)).toEqual([101, 102, 104, 105, 106]);
  });

  it("keeps untrusted text inert: no mention, pipe, tag, cross-reference or autolink reaches the markdown", async () => {
    const text = renderBoard(await board(), now);
    expect(text).not.toMatch(/@owner|@someone/);
    expect(text).toContain("Moraine \\| lane @&#8203;owner");
    expect(text).toContain("feat(#&#8203;101)");
    expect(cell("<b>x</b> `y` [z]\nnext")).toBe("&lt;b&gt;x&lt;/b&gt; 'y' (z) next");
  });

  it("escapes entity-encoded mentions, cross-references and autolinks", () => {
    expect(cell("&#64;user and &commat;user and &#x40;user")).toBe("&amp;#&#8203;64;user and &amp;commat;user and &amp;#&#8203;x40;user");
    expect(cell("see #123 and o/r#4")).toBe("see #&#8203;123 and o/r#&#8203;4");
    expect(cell("https://evil.example/x www.evil.example ftp://h")).toBe("https:&#8203;//evil.example/x www&#8203;.evil.example ftp:&#8203;//h");
    expect(cell("a@b.example")).toBe("a@&#8203;b.example");
  });

  it("flags a claim on the pull request itself as a lane whose pull request is itself", async () => {
    const responses = { ...fixtures,
      [`repos/${repo}/issues/201/comments?per_page=100&page=1`]: [
        { id: 1, body: "CLAIM: Self lane", created_at: "2026-06-30T20:00:00Z", user: { login: "thatskiff33-agents" } }] };
    const built = await board(responses);
    expect(built.lanes.find((lane) => lane.number === 201)).toMatchObject({ kind: "PR", pulls: [201], stale: false, pushWarning: null });
  });
});

describe("edge cases", () => {
  const nothing = {
    [`repos/${repo}/issues?state=open&per_page=100&page=1`]: [],
  };

  it("renders an empty board when nothing is open, and survives an unreadable required-check list", async () => {
    const read = vi.fn(async (path) => {
      if (path === `repos/${repo}/branches/main`) throw new Error("HTTP 404");
      if (path in nothing) return nothing[path];
      throw new Error(`Unexpected request ${path}`);
    });
    expect(renderBoard(buildBoard(await collect(undefined, read), now), now)).toBe([
      "# Status board", "",
      "Generated 2026-07-01T00:00:00.000Z from the open issues and pull requests of `thatskiff33/AlpineClubBookingsNZ`. "
      + "The scheduled job overwrites this body every run (#4464); edit nothing here. Claim text is shown as posted and is not verified.", "",
      "0 active claims (0 stale), 0 open pull requests (0 draft, 0 red, 0 conflicting).", "",
      "## Lanes", "", "No active claims.", "",
      "## Open pull requests", "", "No open pull requests.", "",
      "## Stale claims", "", "No stale claims.", "",
    ].join("\n"));
  });

  it("counts every check, and says so, when the required list is not readable", async () => {
    const responses = { ...fixtures };
    responses[`repos/${repo}/branches/main`] = { name: "main", protected: true };
    const text = renderBoard(await board(responses), now);
    expect(text).toContain("required-check list was not readable");
    expect(text).toContain("fail: Typecheck, verify");
  });

  it("truncates a board that would exceed GitHub's issue body limit", () => {
    const lane = (number) => ({ number, title: "x".repeat(60), url: "u", kind: "Issue", holder: "h", claimedAt: now, lastSyncAt: null,
      lastPushAt: null, pushWarning: null, stale: false, pulls: [] });
    const text = renderBoard({ repo, requiredKnown: true, pulls: [], stale: [], lanes: Array.from({ length: 2000 }, (_, i) => lane(i + 1)) }, now);
    expect(text.length).toBeLessThan(60100);
    expect(text).toContain("Board truncated");
  });

  it("fails on a failed read instead of printing a clean board", async () => {
    await expect(collectBoard(repo, async (path) => {
      if (path.includes("/branches/")) throw new Error("HTTP 404");
      throw new Error("HTTP 403");
    }, "main", noRetry)).rejects.toThrow("HTTP 403");
  });

  it("rejects bad arguments before reading anything", () => {
    const script = fileURLToPath(new URL("./status-board.mjs", import.meta.url));
    const run = (...args) => execFileSync(process.execPath, [script, ...args], { stdio: "pipe" });
    expect(() => run("--now", "yesterday")).toThrow(/Usage: pnpm run status/);
    expect(() => run("not a repo")).toThrow(/Usage: pnpm run status/);
    expect(() => run("--base", "bad branch;rm")).toThrow(/Usage: pnpm run status/);
  });
});

describe("the scheduled workflow", () => {
  it("runs on a schedule, where `github.event.repository` is absent, as well as from the default branch on dispatch", () => {
    expect(workflow).toContain(
      "if: github.event_name == 'schedule' || github.ref == format('refs/heads/{0}', github.event.repository.default_branch)");
  });

  it("is never a pull request check, and no expression is interpolated into a run script", () => {
    const triggers = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\npermissions:"));
    expect(triggers).not.toMatch(/pull_request|push:/);
    for (const [, script] of workflow.matchAll(/run: [|>][-]?\n((?:[ ]{10,}.*\n|\n)+)/g)) expect(script).not.toContain("${{");
  });

  it("overwrites only an empty body or a board, never a pull request or someone else's issue", () => {
    expect(workflow).toContain(`startswith("${BOARD_HEADING}")`);
    expect(workflow).toContain('has("pull_request")');
  });

  it("passes the default branch as the base, falling back to the ref a scheduled run uses", () => {
    expect(workflow).toContain('--base "${DEFAULT_BRANCH}"');
    expect(workflow).toContain("DEFAULT_BRANCH: ${{ github.event.repository.default_branch || github.ref_name }}");
  });
});
