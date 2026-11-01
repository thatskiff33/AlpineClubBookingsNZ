import { afterEach, describe, expect, it, vi } from "vitest";

import { collectReservations, staleReservations } from "./lanes-stale.mjs";

import { ghJson } from "./lib/github-cli.mjs";

vi.mock("./lib/github-cli.mjs", () => ({ ghJson: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

const now = Date.parse("2026-07-01T00:00:00Z");
const comment = (body, created_at = "2026-06-26T00:00:00Z") => ({
  body, created_at, user: { login: "thatskiff33-agents" },
});
const claim = comment("CLAIM: Alpine lane. Branch `feature/alpine`.");
const thread = (comments = [claim], extra = {}) => ({
  number: 42, html_url: "https://github.com/o/r/issues/42", comments, ...extra,
});

describe("staleReservations", () => {
  it("reports the claimed lane, activity and release action for an old claim", () => {
    expect(staleReservations([thread()], now)).toEqual([{
      number: 42, url: "https://github.com/o/r/issues/42", kind: "Issue",
      holder: "Alpine lane", lastActivity: "2026-06-26T00:00:00.000Z",
      action: "Release Alpine lane's reservation on #42 (auto-release after 72 hours, #4452).",
    }]);
  });

  it.each(["2026-06-30T00:00:00Z", "2026-06-28T00:00:00Z"])("keeps fresh or exactly 72-hour claims out (%s)", (at) => {
    expect(staleReservations([thread([comment(claim.body, at)])], now)).toEqual([]);
  });

  it("resets inactivity on LANE-SYNC, without ending the reservation forever", () => {
    expect(staleReservations([thread([claim, comment("LANE-SYNC: checkpoint", "2026-06-30T00:00:00Z")])], now)).toEqual([]);
    const rows = staleReservations([thread([claim, comment("LANE-SYNC: checkpoint", "2026-06-27T00:00:00Z")])], now);
    expect(rows[0].lastActivity).toBe("2026-06-27T00:00:00.000Z");
  });

  it.each(["RELEASE", "HANDOVER"])("ends a reservation on %s after its claim", (prefix) => {
    expect(staleReservations([thread([claim, comment(`${prefix}: ended`, "2026-06-27T00:00:00Z")])], now)).toEqual([]);
  });

  it("uses push time even when the pushed commit itself is old", () => {
    expect(staleReservations([thread([claim], { pushedAt: "2026-06-30T00:00:00Z" })], now)).toEqual([]);
    expect(staleReservations([thread([claim], { pushedAt: "2026-06-27T12:00:00Z" })], now)[0].lastActivity)
      .toBe("2026-06-27T12:00:00.000Z");
  });

  it("uses the latest claim in unsorted input, ignoring earlier release and sync", () => {
    const later = comment("CLAIM: Summit lane. Branch `feature/summit`.", "2026-06-27T00:00:00Z");
    const comments = [later, comment("RELEASE: old claim", "2026-06-26T12:00:00Z"), claim];
    expect(staleReservations([thread(comments)], now)[0].holder).toBe("Summit lane");
    expect(staleReservations([thread([...comments, comment(later.body, "2026-06-30T00:00:00Z")])], now)).toEqual([]);
  });

  it("uses comment IDs to order claims created in the same second", () => {
    const earlier = { ...claim, id: 10 };
    const later = { ...comment("CLAIM: Summit lane"), id: 12 };
    const release = { ...comment("RELEASE: earlier claim"), id: 11 };
    expect(staleReservations([thread([later, earlier, release])], now)[0].holder).toBe("Summit lane");
  });

  it.each(["RELEASE", "HANDOVER"])("honours %s after a claim in the same second", (prefix) => {
    const earlier = { ...claim, id: 10 };
    const later = { ...comment(`${prefix}: done`), id: 11 };
    expect(staleReservations([thread([later, earlier])], now)).toEqual([]);
  });

  it("ignores ordinary comments and quoted workflow examples", () => {
    const comments = [claim, comment("Discussion of RELEASE and HANDOVER", "2026-06-30T00:00:00Z"),
      comment("```\nLANE-SYNC: example\n```", "2026-06-30T00:00:00Z")];
    expect(staleReservations([thread(comments)], now)).toHaveLength(1);
    expect(staleReservations([thread([comment("> CLAIM: example")])], now)).toEqual([]);
  });

  it("identifies PR reservations and handles threads without claims", () => {
    expect(staleReservations([thread([], { number: 1 }), thread([claim], { pull_request: {} })], now)[0].kind).toBe("PR");
  });
});

describe("GitHub collection", () => {
  it("paginates open issues/PRs and comments, and checks ordinary and force pushes on the PR's fork", async () => {
    const read = vi.fn(async (path) => {
      if (path === "repos/o/r/issues?state=open&per_page=100&page=1") return Array.from({ length: 100 }, (_, i) => ({ number: i + 1 }));
      if (path === "repos/o/r/issues?state=open&per_page=100&page=2") return [{ number: 101, pull_request: {} }];
      if (path === "repos/o/r/issues/101/comments?per_page=100&page=1") return Array.from({ length: 100 }, () => comment("Discussion"));
      if (path === "repos/o/r/issues/101/comments?per_page=100&page=2") return [comment("CLAIM: Fork lane")];
      if (path.includes("/comments?")) return [];
      if (path === "repos/o/r/pulls/101") return { head: { ref: "feature/fork", repo: { full_name: "fork/r" } } };
      if (path === "repos/fork/r/activity?ref=refs%2Fheads%2Ffeature%2Ffork&activity_type=push&per_page=1") return [{ timestamp: "2026-06-27T00:00:00Z" }];
      if (path === "repos/fork/r/activity?ref=refs%2Fheads%2Ffeature%2Ffork&activity_type=force_push&per_page=1") return [{ timestamp: "2026-06-30T00:00:00Z" }];
      throw new Error(`Unexpected request ${path}`);
    });
    const threads = await collectReservations("o/r", read);
    expect(threads).toHaveLength(101);
    expect(threads[100].pushedAt).toBe("2026-06-30T00:00:00Z");
    expect(staleReservations(threads, now)).toEqual([]);
  });

  it("uses the claim branch for issues and caches shared branch activity", async () => {
    const read = vi.fn(async (path) => {
      if (path.includes("/issues?")) return [{ number: 1 }, { number: 2 }];
      if (path.includes("/comments?")) return [claim];
      if (path.includes("/activity?ref=refs%2Fheads%2Ffeature%2Falpine")) return [];
      throw new Error(`Unexpected request ${path}`);
    });
    expect(staleReservations(await collectReservations("o/r", read), now)).toHaveLength(2);
    expect(read.mock.calls.filter(([path]) => path.includes("/activity?"))).toHaveLength(2);
  });

  it.each([
    ["CLAIM: Alpine lane. Branch feature/alpine.", "feature/alpine"],
    ["CLAIM: Alpine lane. Branch `feature/alpine+fix`.", "feature/alpine+fix"],
    ["CLAIM: Alpine lane. Branch feature/雪@fix.", "feature/雪@fix"],
  ])("preserves the branch token in %s", async (body, branch) => {
    const read = vi.fn(async (path) => {
      if (path.includes("/issues?")) return [{ number: 1 }];
      if (path.includes("/comments?")) return [comment(body)];
      if (path === `repos/o/r/activity?ref=${encodeURIComponent(`refs/heads/${branch}`)}&activity_type=push&per_page=1`) {
        return [{ timestamp: "2026-06-30T00:00:00Z" }];
      }
      if (path === `repos/o/r/activity?ref=${encodeURIComponent(`refs/heads/${branch}`)}&activity_type=force_push&per_page=1`) return [];
      throw new Error(`Unexpected request ${path}`);
    });
    expect(staleReservations(await collectReservations("o/r", read), now)).toEqual([]);
  });

  it("flags missing branch information and does not query released reservations", async () => {
    const read = vi.fn(async (path) => {
      if (path.includes("/issues?")) return [{ number: 1 }, { number: 2 }];
      if (path.includes("/issues/1/comments?")) return [comment("CLAIM: Unnamed branch lane")];
      if (path.includes("/issues/2/comments?")) return [claim, comment("RELEASE: done", "2026-06-27T00:00:00Z")];
      throw new Error(`Unexpected request ${path}`);
    });
    const rows = staleReservations(await collectReservations("o/r", read), now);
    expect(rows).toHaveLength(1);
    expect(rows[0].pushWarning).toContain("check push activity manually");
  });

  it("uses only explicit GET requests through gh", async () => {
    vi.mocked(ghJson).mockReturnValue([]);
    expect(await collectReservations("o/r")).toEqual([]);
    expect(ghJson).toHaveBeenCalledWith(["api", "--method", "GET", "repos/o/r/issues?state=open&per_page=100&page=1"]);
  });

  it.each(["not on PATH", "not authenticated"])("supports public reads when gh is %s", async (message) => {
    vi.mocked(ghJson).mockImplementation(() => { throw new Error(message); });
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal("fetch", fetch);
    expect(await collectReservations("o/r")).toEqual([]);
    expect(fetch).toHaveBeenCalledWith("https://api.github.com/repos/o/r/issues?state=open&per_page=100&page=1",
      { headers: { Accept: "application/vnd.github+json" } });
  });

  it("propagates public REST failures without returning an empty stale list", async () => {
    vi.mocked(ghJson).mockImplementation(() => { throw new Error("not authenticated"); });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    await expect(collectReservations("o/r")).rejects.toThrow("HTTP 403");
  });

  it("does not turn failed GitHub reads into a clean report", async () => {
    await expect(collectReservations("o/r", async () => { throw new Error("HTTP 403"); })).rejects.toThrow("HTTP 403");
  });
});
