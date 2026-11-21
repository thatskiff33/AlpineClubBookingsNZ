import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #5246: the admin PATCH branches that withdraw a post's stray copy from the
 * central server and mark an unrecorded share as dealt with.
 */

const mocks = vi.hoisted(() => {
  class Named extends Error {
    constructor(name: string, message: string) {
      super(message);
      this.name = name;
    }
  }
  class ClubPostNoShareProblemError extends Named { constructor() { super("ClubPostNoShareProblemError", "That post has no shared copy left to deal with."); } }
  type Attempt = { withdrawnServerPostIds: string[]; outstandingServerPostIds: string[] };
  const none: Attempt = { withdrawnServerPostIds: [], outstandingServerPostIds: ["server-9"] };
  class ClubPostWithdrawalPausedError extends Named {
    constructor(readonly attempt: Attempt = none) { super("ClubPostWithdrawalPausedError", "paused; ask the central server's administrator"); }
  }
  class ClubPostWithdrawalFailedError extends Named {
    constructor(readonly attempt: Attempt = none) { super("ClubPostWithdrawalFailedError", "refused; ask the central server's administrator"); }
  }
  return {
    ClubPostNoShareProblemError,
    ClubPostWithdrawalPausedError,
    ClubPostWithdrawalFailedError,
    withdrawSharedCopy: vi.fn(),
    dismissShareOutcome: vi.fn(),
    logAudit: vi.fn(),
  };
});

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: vi.fn(async () => ({ commsPortal: true })),
}));
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: vi.fn(async () => ({ ok: true, session: { user: { id: "admin-1" } } })),
}));
vi.mock("@/lib/club-posts", () => ({ ClubPostValidationError: class extends Error {} }));
vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/club-posts-admin", () => ({
  ClubPostAlreadyRemovedError: class extends Error {},
  ClubPostNotEditableError: class extends Error {},
  ClubPostNotFoundError: class extends Error {},
  ClubPostNoShareProblemError: mocks.ClubPostNoShareProblemError,
  ClubPostWithdrawalPausedError: mocks.ClubPostWithdrawalPausedError,
  ClubPostWithdrawalFailedError: mocks.ClubPostWithdrawalFailedError,
  withdrawSharedCopy: mocks.withdrawSharedCopy,
  dismissShareOutcome: mocks.dismissShareOutcome,
  editClubPostContent: vi.fn(),
  removeClubPost: vi.fn(),
  setClubPostHidden: vi.fn(),
}));

import { NextRequest } from "next/server";

import { PATCH } from "@/app/api/admin/club-posts/[id]/route";

function patch(body: unknown) {
  return PATCH(
    new NextRequest("http://localhost/api/admin/club-posts/post-1", { method: "PATCH", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: "post-1" }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("withdrawing a shared copy", () => {
  it("withdraws and audits the server id, never the post's words", async () => {
    mocks.withdrawSharedCopy.mockResolvedValue({ serverPostIds: ["server-9"] });

    const res = await patch({ withdrawSharedCopy: true });

    expect(res.status).toBe(200);
    expect(mocks.withdrawSharedCopy).toHaveBeenCalledWith("post-1");
    expect(mocks.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "club_post.withdraw_shared_copy",
      category: "communication",
      memberId: "admin-1",
      entityId: "post-1",
      details: expect.stringContaining("server-9"),
    }));
  });

  it("answers 409 when nothing is left to withdraw, with no audit row: nothing was attempted", async () => {
    mocks.withdrawSharedCopy.mockRejectedValue(new mocks.ClubPostNoShareProblemError());

    const res = await patch({ withdrawSharedCopy: true });

    expect(res.status).toBe(409);
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it.each([
    ["a version pause", () => new mocks.ClubPostWithdrawalPausedError(), 409, /paused by a version difference/],
    ["the server's refusal", () => new mocks.ClubPostWithdrawalFailedError(), 502, /server did not confirm/],
  ])("answers %s with its plain message and audits the failed attempt (#5246 review)", async (_label, error, status, reason) => {
    const thrown = error();
    mocks.withdrawSharedCopy.mockRejectedValue(thrown);

    const res = await patch({ withdrawSharedCopy: true });

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: thrown.message });
    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    const audit = mocks.logAudit.mock.calls[0]![0];
    expect(audit).toMatchObject({
      action: "club_post.withdraw_shared_copy.failed",
      category: "communication",
      memberId: "admin-1",
      entityId: "post-1",
    });
    expect(audit.details).toMatch(reason);
    expect(audit.details).toContain("Withdrawn: none. Still outstanding: server-9.");
  });

  it.each([
    ["a refusal", (attempt: { withdrawnServerPostIds: string[]; outstandingServerPostIds: string[] }) => new mocks.ClubPostWithdrawalFailedError(attempt), 502],
    ["a pause", (attempt: { withdrawnServerPostIds: string[]; outstandingServerPostIds: string[] }) => new mocks.ClubPostWithdrawalPausedError(attempt), 409],
  ])("audits the copy a half-successful withdrawal did take down, before %s (#5246 review)", async (_label, error, status) => {
    mocks.withdrawSharedCopy.mockRejectedValue(error({ withdrawnServerPostIds: ["server-9"], outstandingServerPostIds: ["server-1"] }));

    const res = await patch({ withdrawSharedCopy: true });

    expect(res.status).toBe(status);
    expect(mocks.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "club_post.withdraw_shared_copy.failed",
      details: expect.stringContaining("Withdrawn: server-9. Still outstanding: server-1."),
    }));
  });

  it("accepts only `true`", async () => {
    expect((await patch({ withdrawSharedCopy: false })).status).toBe(400);
    expect(mocks.withdrawSharedCopy).not.toHaveBeenCalled();
  });
});

describe("marking an unrecorded share as dealt with", () => {
  it("clears it and audits the dismissal", async () => {
    mocks.dismissShareOutcome.mockResolvedValue(undefined);

    const res = await patch({ dismissShareProblem: true });

    expect(res.status).toBe(200);
    expect(mocks.dismissShareOutcome).toHaveBeenCalledWith("post-1");
    expect(mocks.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "club_post.share_problem.dismiss" }));
  });

  it("answers 409 when there is nothing to deal with", async () => {
    mocks.dismissShareOutcome.mockRejectedValue(new mocks.ClubPostNoShareProblemError());
    expect((await patch({ dismissShareProblem: true })).status).toBe(409);
  });
});
