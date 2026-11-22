import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MainPushBaseError, main, resolveMainPushBase } from "./resolve-main-push-base.mjs";

/*
  INV-OPS-021 (#5356): a push to main is judged from the last main commit
  whose ci.yml run judged it, so a merge whose queued run a newer merge replaced
  is still judged by the push-only gates. These cases drive the resolver over a
  fake GitHub API.
*/

const sha = (letter) => letter.repeat(40);

/** A `main` push run of ci.yml as GitHub lists it. */
function run(runNumber, head, status = "completed", conclusion = status === "completed" ? "success" : null) {
  return { id: 1000 + runNumber, run_number: runNumber, head_sha: head, status, conclusion };
}

/** A fetch that serves `pages` (newest-first lists) and records the URLs asked for. */
function fakeApi(pages, { status = 200 } = {}) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const page = Number(new URL(url).searchParams.get("page"));
    return { ok: status === 200, status, json: async () => ({ total_count: 0, workflow_runs: pages[page - 1] ?? [] }) };
  };
  return { fetchImpl, urls };
}

const everyAncestor = () => true;
const request = (overrides) => ({ repository: "owner/repo", token: "t", runNumber: 50, headSha: sha("f"), isAncestor: everyAncestor, ...overrides });

describe("resolveMainPushBase", () => {
  it("judges from the newest earlier run that ran, past runs a newer merge replaced", async () => {
    // e's run is ours (#50). d and c were dropped from the queue; b's run finished red.
    const { fetchImpl, urls } = fakeApi([
      [run(50, sha("f"), "in_progress"), run(49, sha("d"), "completed", "cancelled"), run(48, sha("c"), "completed", "cancelled"), run(47, sha("b"), "completed", "failure"), run(46, sha("a"))],
    ]);

    const result = await resolveMainPushBase(request({ fetchImpl }));

    expect(result.sha).toBe(sha("b"));
    expect(urls[0]).toBe("https://api.github.com/repos/owner/repo/actions/workflows/ci.yml/runs?branch=main&event=push&per_page=100&page=1");
  });

  it("takes the previous commit when nothing was dropped", async () => {
    const { fetchImpl } = fakeApi([[run(50, sha("f"), "in_progress"), run(49, sha("e"))]]);
    expect((await resolveMainPushBase(request({ fetchImpl }))).sha).toBe(sha("e"));
  });

  it("counts a run still in progress but not one still queued, which can yet be replaced", async () => {
    const queued = fakeApi([[run(49, sha("e"), "queued"), run(48, sha("d"), "in_progress"), run(47, sha("c"))]]);
    expect((await resolveMainPushBase(request({ fetchImpl: queued.fetchImpl }))).sha).toBe(sha("d"));
  });

  it("skips runs whose gates never ran", async () => {
    const { fetchImpl } = fakeApi([
      [run(49, sha("e"), "completed", "skipped"), run(48, sha("d"), "completed", "startup_failure"), run(47, sha("c"), "completed", "stale"), run(46, sha("b"), "completed", "timed_out")],
    ]);
    expect((await resolveMainPushBase(request({ fetchImpl }))).sha).toBe(sha("b"));
  });

  it("ignores newer runs, its own commit's other runs, and commits that are not ancestors", async () => {
    const { fetchImpl } = fakeApi([[run(52, sha("g")), run(51, sha("f")), run(49, sha("f")), run(48, sha("x")), run(47, sha("c"))]]);
    const result = await resolveMainPushBase(request({ fetchImpl, isAncestor: (commit) => commit !== sha("x") }));
    expect(result.sha).toBe(sha("c"));
  });

  it("reads further pages until it finds one", async () => {
    const cancelled = Array.from({ length: 100 }, (_, index) => run(49 - index, sha("d"), "completed", "cancelled"));
    const { fetchImpl, urls } = fakeApi([cancelled, [run(-60, sha("a"))]]);
    expect((await resolveMainPushBase(request({ fetchImpl }))).sha).toBe(sha("a"));
    expect(urls).toHaveLength(2);
  });

  it("fails closed when no earlier run judged an ancestor", async () => {
    const { fetchImpl } = fakeApi([[run(49, sha("d"), "completed", "cancelled")]]);
    await expect(resolveMainPushBase(request({ fetchImpl }))).rejects.toThrow(MainPushBaseError);
  });

  it("fails closed on an API error or an answer it cannot read", async () => {
    await expect(resolveMainPushBase(request({ fetchImpl: fakeApi([], { status: 403 }).fetchImpl }))).rejects.toThrow(/HTTP 403/);
    const garbled = async () => ({ ok: true, status: 200, json: async () => ({ workflow_runs: [{ id: "1" }] }) });
    await expect(resolveMainPushBase(request({ fetchImpl: garbled }))).rejects.toThrow(/shape/);
    const offline = async () => {
      throw new Error("network down");
    };
    await expect(resolveMainPushBase(request({ fetchImpl: offline }))).rejects.toThrow(/network down/);
  });
});

describe("main", () => {
  let dir;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const quiet = { log: () => {} };

  const mainPushEnv = (output) => ({
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_TOKEN: "t",
    GITHUB_RUN_NUMBER: "50",
    GITHUB_SHA: sha("f"),
    GITHUB_OUTPUT: output,
  });

  it("writes the resolved commit for a push to main", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "main-push-base-"));
    const output = path.join(dir, "out");
    const { fetchImpl } = fakeApi([[run(49, sha("d"), "completed", "cancelled"), run(48, sha("c"))]]);

    expect(await main({ env: mainPushEnv(output), fetchImpl, isAncestor: everyAncestor, log: quiet })).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(`sha=${sha("c")}\n`);
  });

  it("writes nothing and asks nothing for an epic push or a pull request", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "main-push-base-"));
    const output = path.join(dir, "out");
    const { fetchImpl, urls } = fakeApi([[run(49, sha("e"))]]);
    for (const env of [
      { ...mainPushEnv(output), GITHUB_REF: "refs/heads/epic/12-x" },
      { ...mainPushEnv(output), GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/7/merge" },
    ]) {
      expect(await main({ env, fetchImpl, isAncestor: everyAncestor, log: quiet })).toBe(0);
    }
    expect(urls).toEqual([]);
    expect(() => readFileSync(output, "utf8")).toThrow();
  });

  it("refuses a push to main it cannot place", async () => {
    const { fetchImpl } = fakeApi([[]]);
    await expect(main({ env: { ...mainPushEnv(undefined), GITHUB_RUN_NUMBER: "" }, fetchImpl, log: quiet })).rejects.toThrow(/GITHUB_RUN_NUMBER/);
    await expect(main({ env: mainPushEnv(undefined), fetchImpl, isAncestor: everyAncestor, log: quiet })).rejects.toThrow(MainPushBaseError);
  });
});
