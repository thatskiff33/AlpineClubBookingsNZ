import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { buildBoard, cell, ciState, closedIssues, collectBoard, mergeLabel, renderBoard } from "./status-board.mjs";

// Recorded REST responses (shapes as the issues, comments, pulls, check-runs,
// branch and activity endpoints return them), keyed by the request path.
const recorded = JSON.parse(readFileSync(new URL("./fixtures/status-board/open-board.json", import.meta.url), "utf8"));
const golden = readFileSync(new URL("./fixtures/status-board/open-board.expected.md", import.meta.url), "utf8");

// The frozen test clock (AGENTS.md): never the real calendar.
const now = Date.parse("2026-07-01T00:00:00Z");
const repo = "thatskiff33/AlpineClubBookingsNZ";

function replay(responses = recorded) {
  return vi.fn(async (path) => {
    if (!(path in responses)) throw new Error(`Unexpected request ${path}`);
    return structuredClone(responses[path]);
  });
}

const board = async (responses) => buildBoard(await collectBoard(repo, replay(responses)), now);

describe("closedIssues", () => {
  it("reads closing keywords and ignores comments, code and unrelated numbers", () => {
    expect(closedIssues("Closes #4\nfixes: #2 and Resolved #9\nSee #7")).toEqual([2, 4, 9]);
    expect(closedIssues("<!-- Closes #1 -->\n`Closes #2`\n```\nFixes #3\n```\nCloses o/r#5")).toEqual([5]);
    expect(closedIssues(null)).toEqual([]);
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

  it("passes when every required check passed, treating skipped and neutral as green", () => {
    expect(ciState([run("verify"), run("Lint", "completed", "skipped"), run("Docs", "completed", "neutral")], null).state).toBe("pass");
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

describe("the board built from recorded responses", () => {
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

  it("links a pull request to its lane by closing keyword, and leaves a fork's pull request unclaimed", async () => {
    const built = await board();
    expect(built.lanes.map((lane) => lane.pulls)).toEqual([[201], [], [202], [203], [204]]);
    expect(built.pulls.map((pr) => pr.lanes)).toEqual([[101], [104], [105], [106], []]);
  });

  it("reports a conflicting pull request from mergeable_state", async () => {
    const pr = (await board()).pulls.find((p) => p.number === 202);
    expect(pr).toMatchObject({ merge: "conflicts", draft: false, ci: { state: "running", pending: ["Playwright E2E"] } });
  });

  it("reports a red pull request with the failing required check names", async () => {
    const pr = (await board()).pulls.find((p) => p.number === 203);
    expect(pr.ci).toEqual({ state: "fail", failing: ["verify"], pending: ["Playwright E2E", "Static analysis gate"], otherFailing: ["Typecheck"] });
  });

  it("reports a draft pull request and a green ready one", async () => {
    const built = await board();
    expect(built.pulls.find((p) => p.number === 204)).toMatchObject({ draft: true, merge: "no conflicts", ci: { state: "running" } });
    expect(built.pulls.find((p) => p.number === 201)).toMatchObject({ draft: false, merge: "clean", ci: { state: "pass" }, head: "aaaaaaa" });
  });

  it("reads CI on each pull request's exact head commit, and each pull request once", async () => {
    const read = replay();
    await collectBoard(repo, read);
    const paths = read.mock.calls.map(([path]) => path);
    expect(paths).toContain(`repos/${repo}/commits/${"c".repeat(40)}/check-runs?filter=latest&per_page=100&page=1`);
    expect(paths.filter((path) => path === `repos/${repo}/pulls/201`)).toHaveLength(1);
  });

  it("renders the recorded board exactly, the same every time", async () => {
    const text = renderBoard(await board(), now);
    expect(text).toBe(golden);
    expect(renderBoard(await board(), now)).toBe(text);
  });

  it("changes only with its explicit clock: a later now ages claims into stale", async () => {
    const built = await board();
    const later = Date.parse("2026-07-04T00:00:00Z");
    expect(renderBoard(built, later)).toContain("Generated 2026-07-04T00:00:00.000Z");
    const aged = buildBoard(await collectBoard(repo, replay()), later);
    expect(aged.stale.map((row) => row.number)).toEqual([101, 102, 104, 105, 106]);
  });

  it("keeps untrusted text inert: no mention, pipe or tag reaches the markdown unescaped", async () => {
    const text = renderBoard(await board(), now);
    expect(text).not.toMatch(/@owner|@someone/);
    expect(text).toContain("Moraine \\| lane @&#8203;owner");
    expect(cell("<b>x</b> `y` [z]\nnext")).toBe("&lt;b&gt;x&lt;/b&gt; 'y' (z) next");
  });

  it("flags a claim on the pull request itself as a lane whose pull request is itself", async () => {
    const responses = { ...recorded,
      [`repos/${repo}/issues/201/comments?per_page=100&page=1`]: [{ id: 1, body: "CLAIM: Self lane", created_at: "2026-06-30T20:00:00Z" }] };
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
    expect(renderBoard(buildBoard(await collectBoard(repo, read), now), now)).toBe([
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
    const responses = { ...recorded };
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
    })).rejects.toThrow("HTTP 403");
  });

  it("rejects bad arguments before reading anything", () => {
    const script = fileURLToPath(new URL("./status-board.mjs", import.meta.url));
    const run = (...args) => execFileSync(process.execPath, [script, ...args], { stdio: "pipe" });
    expect(() => run("--now", "yesterday")).toThrow(/Usage: pnpm run status/);
    expect(() => run("not a repo")).toThrow(/Usage: pnpm run status/);
  });
});
