import { describe, expect, it } from "vitest";

import {
  SHARE_OUTCOME_GRACE_MS,
  type ShareProblemRow,
  classifyShareProblem,
} from "@/lib/club-post-share-problem";

/**
 * #5246: which of this club's posts the admin's message-board screen marks
 * with a sharing problem. Clock frozen at 2026-07-01T00:00:00.000Z.
 */

const NOW = new Date("2026-07-01T00:00:00.000Z");

function row(overrides: Partial<ShareProblemRow> = {}): ShareProblemRow {
  return {
    originClubCode: null,
    removedAt: null,
    shareRequestedAt: null,
    shareSentAt: null,
    shareError: null,
    sharedAt: null,
    serverPostId: null,
    withdrawnAt: null,
    unrecordedServerPostId: null,
    ...overrides,
  };
}

const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("classifyShareProblem", () => {
  it("names an accepted copy that was not recorded, with its id, even on a shared post", () => {
    expect(classifyShareProblem(row({ unrecordedServerPostId: "server-9", shareError: "not recorded" }), NOW)).toEqual({
      kind: "copy-not-recorded", shareError: "not recorded", serverPostId: "server-9",
    });
    expect(classifyShareProblem(row({ sharedAt: NOW, serverPostId: "server-1", unrecordedServerPostId: "server-9" }), NOW))
      .toMatchObject({ kind: "copy-not-recorded", serverPostId: "server-9" });
  });

  it("never calls the post's own recorded share a stray copy (#5246 review)", () => {
    expect(classifyShareProblem(row({ sharedAt: NOW, serverPostId: "server-9", unrecordedServerPostId: "server-9" }), NOW)).toBeNull();
  });

  it("names a removed post whose takedown is unconfirmed, and nothing once it is confirmed", () => {
    expect(classifyShareProblem(row({ removedAt: NOW, sharedAt: NOW, serverPostId: "server-2" }), NOW)).toMatchObject({
      kind: "withdrawal-pending", serverPostId: "server-2",
    });
    expect(classifyShareProblem(row({ removedAt: NOW, sharedAt: NOW, serverPostId: "server-2", withdrawnAt: NOW }), NOW)).toBeNull();
  });

  it("calls a send unrecorded past the grace an unknown outcome, and one inside it still in flight", () => {
    expect(classifyShareProblem(row({ shareSentAt: ago(SHARE_OUTCOME_GRACE_MS) }), NOW)).toBeNull();
    expect(classifyShareProblem(row({ shareSentAt: ago(SHARE_OUTCOME_GRACE_MS + 1) }), NOW)).toEqual({
      kind: "outcome-unknown", shareError: null, serverPostId: null,
    });
    // On a removed post too: its copy may be on other clubs' boards.
    expect(classifyShareProblem(row({ removedAt: NOW, shareSentAt: ago(SHARE_OUTCOME_GRACE_MS + 1) }), NOW))
      .toMatchObject({ kind: "outcome-unknown" });
  });

  it("names a recorded failure with nothing pending, and nothing while it is still retried", () => {
    expect(classifyShareProblem(row({ shareError: "Gave up after 8 attempts" }), NOW)).toEqual({
      kind: "share-failed", shareError: "Gave up after 8 attempts", serverPostId: null,
    });
    expect(classifyShareProblem(row({ shareError: "unavailable", shareRequestedAt: NOW }), NOW)).toBeNull();
    expect(classifyShareProblem(row({ shareError: "refused", removedAt: NOW }), NOW)).toBeNull();
  });

  it("marks nothing on a post shared cleanly or never shared", () => {
    expect(classifyShareProblem(row({ sharedAt: NOW, serverPostId: "server-1" }), NOW)).toBeNull();
    expect(classifyShareProblem(row(), NOW)).toBeNull();
  });

  it("never marks another club's post, whatever its row holds", () => {
    expect(classifyShareProblem(row({
      originClubCode: "RUAPEHU",
      removedAt: NOW,
      serverPostId: "server-5",
      unrecordedServerPostId: "server-6",
      shareSentAt: ago(SHARE_OUTCOME_GRACE_MS * 2),
      shareError: "x",
    }), NOW)).toBeNull();
  });
});
