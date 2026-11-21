import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2998 (epic #2992) — club message board moderation.
 *
 * The load-bearing test here is that hiding a post actually removes it from the
 * MEMBER reader. #2994 shipped the `hiddenAt`/`removedAt` filter before anything
 * could set either column precisely so that would be true on the day moderation
 * landed; this is where that is checked rather than assumed.
 *
 * Clock frozen at 2026-07-01T00:00:00.000Z.
 */

const mocks = vi.hoisted(() => {
  class FakeVersionError extends Error {
    expected = "2.0";
    serverVersion = "2.1";
    constructor() {
      super("paused");
      this.name = "ServerNzVersionMismatchError";
    }
  }
  return {
    FakeVersionError,
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    withdrawClubPost: vi.fn(),
    imageFindMany: vi.fn(),
    imageDeleteMany: vi.fn(),
    transaction: vi.fn(),
    // The removal's interactive transaction (#4586): the post's guarded claim,
    // the re-read under its lock, then the image rows.
    txUpdateMany: vi.fn(),
    txFindUniqueOrThrow: vi.fn(),
    txImageDeleteMany: vi.fn(),
    order: [] as string[],
    deletePostImage: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock("@/lib/logger", () => ({ default: mocks.logger }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clubPost: {
      findUnique: mocks.findUnique,
      findMany: mocks.findMany,
      update: mocks.update,
      updateMany: mocks.updateMany,
    },
    clubPostImage: {
      findMany: mocks.imageFindMany,
      deleteMany: mocks.imageDeleteMany,
    },
    $transaction: mocks.transaction,
  },
}));

// Removal now unlinks the post's image files from the mount; mocked so the
// suite stays about WHAT is deleted, not about a mount being present.
vi.mock("@/lib/post-image-storage", () => ({
  deletePostImage: mocks.deletePostImage,
}));

vi.mock("@/lib/servernz-api", () => ({
  ServerNzApiError: class extends Error {},
  ServerNzVersionMismatchError: mocks.FakeVersionError,
  shareClubPost: vi.fn(),
  withdrawClubPost: mocks.withdrawClubPost,
}));

// The withdrawal itself is the sharing module's, run for real; only its
// settings and version neighbours are stubbed.
vi.mock("@/lib/servernz-settings", () => ({
  SERVERNZ_TRANSACTION_OPTIONS: {},
  lockServerNzSettings: vi.fn(),
}));
vi.mock("@/lib/servernz-version-check", () => ({ isServerSyncPaused: vi.fn() }));

const NOW = new Date("2026-07-01T00:00:00.000Z");

/** A post row as the removal re-reads it under its lock, already removed. */
function removedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "post-1",
    serverPostId: null,
    unrecordedServerPostId: null,
    removedAt: NOW,
    withdrawnAt: null,
    originClubCode: null,
    images: [],
    ...overrides,
  };
}

import { listClubPostsForMember } from "@/lib/club-posts";
import {
  ClubPostAlreadyRemovedError,
  ClubPostNoShareProblemError,
  ClubPostNotFoundError,
  ClubPostNotEditableError,
  ClubPostWithdrawalFailedError,
  ClubPostWithdrawalPausedError,
  dismissShareOutcome,
  editClubPostContent,
  listClubPostShareProblems,
  withdrawSharedCopy,
  listClubPostsForAdmin,
  parseAdminPostTab,
  removeClubPost,
  setClubPostHidden,
} from "@/lib/club-posts-admin";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMany.mockResolvedValue([]);
  mocks.imageFindMany.mockResolvedValue([]);
  mocks.imageDeleteMany.mockResolvedValue({ count: 0 });
  mocks.order.length = 0;
  mocks.txUpdateMany.mockImplementation(async () => {
    mocks.order.push("post");
    return { count: 1 };
  });
  mocks.txFindUniqueOrThrow.mockImplementation(async () => {
    mocks.order.push("read");
    return removedRow();
  });
  mocks.txImageDeleteMany.mockImplementation(async () => {
    mocks.order.push("images");
    return { count: 0 };
  });
  mocks.transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) =>
    work({
      clubPost: { updateMany: mocks.txUpdateMany, findUniqueOrThrow: mocks.txFindUniqueOrThrow },
      clubPostImage: { deleteMany: mocks.txImageDeleteMany },
    }));
  mocks.deletePostImage.mockResolvedValue(undefined);
  mocks.update.mockResolvedValue({});
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.findUnique.mockResolvedValue({
    id: "post-1",
    content: "Hut book is back at the lodge.",
    hiddenAt: null,
    removedAt: null,
    originClubCode: null,
  });
});

describe("moderation reaches members", () => {
  it("the member reader excludes hidden and removed posts", async () => {
    // The whole point of moderation. If this filter is ever dropped, hiding
    // succeeds in the admin screen and changes nothing for members.
    await listClubPostsForMember("member-1");
    expect(mocks.findMany.mock.calls[0][0].where).toMatchObject({
      hiddenAt: null,
      removedAt: null,
    });
  });

  it("hiding stamps hiddenAt; showing clears it", async () => {
    await setClubPostHidden("post-1", true);
    expect(mocks.update.mock.calls[0][0].data.hiddenAt).toBeInstanceOf(Date);

    await setClubPostHidden("post-1", false);
    expect(mocks.update.mock.calls[1][0].data.hiddenAt).toBeNull();
  });

  it("hiding never touches the content", async () => {
    await setClubPostHidden("post-1", true);
    expect(mocks.update.mock.calls[0][0].data).not.toHaveProperty("content");
  });
});

describe("removal", () => {
  function shared(originClubCode: string | null) {
    mocks.txFindUniqueOrThrow.mockResolvedValue(removedRow({ serverPostId: "server-9", originClubCode }));
  }

  it("blanks the content rather than only flagging the row", async () => {
    // Behind-a-filter is not gone. A future query that forgets the filter would
    // otherwise resurface words somebody asked to have removed.
    await removeClubPost("post-1");
    const { where, data } = mocks.txUpdateMany.mock.calls[0][0];
    // A status-guarded claim: only a post not yet removed is removed.
    expect(where).toEqual({ id: "post-1", removedAt: null });
    expect(data.content).toBe("");
    expect(data.removedAt).toBeInstanceOf(Date);
  });

  it("keeps the author on the row, so a removal stays answerable for", async () => {
    await removeClubPost("post-1");
    const data = mocks.txUpdateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("authorMemberId");
    expect(data).not.toHaveProperty("authorName");
  });

  it("takes the post row before its images, and reads the images under that lock (#4586)", async () => {
    // The order every message-board writer follows. Images first deadlocked
    // against a mirror tombstone or retention deleting the same post.
    mocks.txFindUniqueOrThrow.mockImplementation(async () => {
      mocks.order.push("read");
      return removedRow({ images: [{ storageKey: "posts/2026/06/a.webp" }] });
    });

    await removeClubPost("post-1");

    expect(mocks.order).toEqual(["post", "read", "images"]);
    expect(mocks.txImageDeleteMany).toHaveBeenCalledWith({ where: { postId: "post-1" } });
    // Rows first, files after the commit.
    expect(mocks.deletePostImage).toHaveBeenCalledWith("posts/2026/06/a.webp");
    expect(mocks.imageFindMany).not.toHaveBeenCalled();
  });

  it("is idempotent — removing twice is not an error", async () => {
    mocks.txUpdateMany.mockResolvedValue({ count: 0 });
    mocks.findUnique.mockResolvedValue({ id: "post-1" });
    await expect(removeClubPost("post-1")).resolves.toBeUndefined();
    expect(mocks.txImageDeleteMany).not.toHaveBeenCalled();
    expect(mocks.deletePostImage).not.toHaveBeenCalled();
    expect(mocks.withdrawClubPost).not.toHaveBeenCalled();
  });

  it("404s an unknown post, or one a mirror tombstone or retention deleted first", async () => {
    mocks.txUpdateMany.mockResolvedValue({ count: 0 });
    mocks.findUnique.mockResolvedValue(null);
    await expect(removeClubPost("nope")).rejects.toBeInstanceOf(
      ClubPostNotFoundError,
    );
    expect(mocks.txImageDeleteMany).not.toHaveBeenCalled();
  });

  // #3091 review 1: a takedown of a SHARED post must be confirmed, retried,
  // and visible while outstanding — not fire-and-forget.
  it("stamps withdrawnAt when the central server confirms the takedown", async () => {
    shared(null);
    mocks.withdrawClubPost.mockResolvedValue(undefined);

    await removeClubPost("post-1");

    expect(mocks.withdrawClubPost).toHaveBeenCalledWith("server-9");
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "post-1", serverPostId: "server-9", withdrawnAt: null },
      data: { withdrawnAt: expect.any(Date) },
    });
  });

  it("leaves the removal standing and withdrawnAt unset when the withdrawal fails", async () => {
    shared(null);
    mocks.withdrawClubPost.mockRejectedValue(new Error("server down"));

    // NOT fatal: the local removal is what the admin asked for.
    await expect(removeClubPost("post-1")).resolves.toBeUndefined();

    const stamped = [...mocks.update.mock.calls, ...mocks.updateMany.mock.calls].find(
      ([args]) => args.data.withdrawnAt !== undefined,
    );
    expect(stamped).toBeUndefined();
  });

  it("bounds the removal's transaction like the other short row-lock writers (#4586 review)", async () => {
    shared(null);
    await removeClubPost("post-1");
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { maxWait: 10_000, timeout: 30_000 });
  });

  it("stands the removal, leaves the withdrawal pending and logs at info while the server version differs (#49)", async () => {
    shared(null);
    mocks.withdrawClubPost.mockRejectedValue(new mocks.FakeVersionError());

    await expect(removeClubPost("post-1")).resolves.toBeUndefined();

    // Removed locally all the same...
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    // ...withdrawnAt left for the sweep...
    expect(
      [...mocks.update.mock.calls, ...mocks.updateMany.mock.calls].find(([args]) => args.data.withdrawnAt !== undefined),
    ).toBeUndefined();
    // ...and recorded as expected, not as a fault: info with the two numbers.
    expect(mocks.logger.error).not.toHaveBeenCalled();
    expect(mocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ expected: "2.0", serverVersion: "2.1" }),
      expect.stringMatching(/waits until the central server API version matches/),
    );
  });

  it("never withdraws a MIRROR — the network copy belongs to its origin club", async () => {
    shared("RUAPEHU");

    await removeClubPost("post-1");

    expect(mocks.withdrawClubPost).not.toHaveBeenCalled();
  });

  it("withdraws an unrecorded copy too, and clears it once confirmed (#5246)", async () => {
    mocks.txFindUniqueOrThrow.mockResolvedValue(removedRow({ serverPostId: "server-1", unrecordedServerPostId: "server-9" }));
    mocks.withdrawClubPost.mockResolvedValue(undefined);

    await removeClubPost("post-1");

    expect(mocks.withdrawClubPost.mock.calls).toEqual([["server-9"], ["server-1"]]);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "post-1", unrecordedServerPostId: "server-9" },
      data: { unrecordedServerPostId: null, shareError: null },
    });
  });
});

describe("editing", () => {
  it("returns the ORIGINAL so it can go into the audit row", async () => {
    // After this write the audit row is the only place the member's own words
    // still exist.
    const result = await editClubPostContent("post-1", "Corrected text.");
    expect(result.before).toBe("Hut book is back at the lodge.");
    expect(result.after).toBe("Corrected text.");
  });

  it("clears the rich body, so the edit is what members actually see", async () => {
    // The board renders bodyHtml in preference to the text. An edit that only
    // rewrote `content` would be invisible: the admin saves, the audit records
    // a change, and every member keeps reading the unedited words.
    await editClubPostContent("post-1", "Corrected text.");
    expect(mocks.update.mock.calls[0][0].data).toMatchObject({
      content: "Corrected text.",
      bodyHtml: null,
    });
  });

  it("refuses to rewrite another club's words (D-C4)", async () => {
    // A mirror still shows the origin club's name and badge, so editing it
    // here would misrepresent that club to this one's members. Hide and remove
    // stay available; edit does not.
    mocks.findUnique.mockResolvedValue({
      id: "post-9",
      content: "Written by Ruapehu.",
      hiddenAt: null,
      removedAt: null,
      originClubCode: "RUAPEHU",
    });
    await expect(
      editClubPostContent("post-9", "Rewritten"),
    ).rejects.toBeInstanceOf(ClubPostNotEditableError);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("still allows hiding a mirror", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "post-9",
      content: "Written by Ruapehu.",
      hiddenAt: null,
      removedAt: null,
      originClubCode: "RUAPEHU",
    });
    await setClubPostHidden("post-9", true);
    expect(mocks.update).toHaveBeenCalled();
  });

  it("applies the same content rules members are held to", async () => {
    await expect(editClubPostContent("post-1", "   ")).rejects.toThrow();
    await expect(
      editClubPostContent("post-1", "x".repeat(4001)),
    ).rejects.toThrow();
  });

  it("refuses to edit a removed post", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "post-1",
      content: "",
      hiddenAt: null,
      removedAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    await expect(editClubPostContent("post-1", "anything")).rejects.toBeInstanceOf(
      ClubPostAlreadyRemovedError,
    );
    await expect(setClubPostHidden("post-1", true)).rejects.toBeInstanceOf(
      ClubPostAlreadyRemovedError,
    );
  });
});

describe("the moderation list", () => {
  it("defaults to the all tab and rejects an unknown one", () => {
    expect(parseAdminPostTab(null)).toBe("all");
    expect(parseAdminPostTab("flagged")).toBe("all");
    expect(parseAdminPostTab("hidden")).toBe("hidden");
  });

  it("excludes removed posts from both tabs", async () => {
    await listClubPostsForAdmin({ tab: "all" });
    expect(mocks.findMany.mock.calls[0][0].where).toMatchObject({
      removedAt: null,
    });

    await listClubPostsForAdmin({ tab: "hidden" });
    expect(mocks.findMany.mock.calls[1][0].where).toMatchObject({
      removedAt: null,
    });
  });

  it("the hidden tab shows only hidden posts", async () => {
    await listClubPostsForAdmin({ tab: "hidden" });
    expect(mocks.findMany.mock.calls[0][0].where.hiddenAt).toEqual({
      not: null,
    });
  });

  it("the all tab does not filter on hiddenAt at all", async () => {
    await listClubPostsForAdmin({ tab: "all" });
    expect(mocks.findMany.mock.calls[0][0].where.hiddenAt).toBeUndefined();
  });

  it("searches content and author name, case-insensitively", async () => {
    await listClubPostsForAdmin({ tab: "all", q: "whitcombe" });
    const where = mocks.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { content: { contains: "whitcombe", mode: "insensitive" } },
      { authorName: { contains: "whitcombe", mode: "insensitive" } },
    ]);
  });

  it("omits the search clause entirely when nothing was typed", async () => {
    await listClubPostsForAdmin({ tab: "all" });
    expect(mocks.findMany.mock.calls[0][0].where.OR).toBeUndefined();
  });
});

/** A full admin-list row: an own-club live post with nothing wrong. */
function adminRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "post-1",
    authorName: "Jo Whitcombe",
    authorMemberId: "member-1",
    content: "Chains needed above the second cattle stop.",
    postedAt: new Date("2026-06-14T00:00:00.000Z"),
    hiddenAt: null,
    removedAt: null,
    originClubName: null,
    originClubCode: null,
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

describe("sharing problems on the moderation screen (#5246)", () => {
  it("marks each post in the list with its problem, or none", async () => {
    mocks.findMany.mockResolvedValue([
      adminRow({ id: "a", unrecordedServerPostId: "server-9", shareError: "Shared to the central server as server-9, but recording that here failed" }),
      adminRow({ id: "b", shareError: "Gave up after 8 attempts: unreachable" }),
      adminRow({ id: "c", sharedAt: NOW, serverPostId: "server-3" }),
    ]);

    const posts = await listClubPostsForAdmin({ tab: "all" });

    expect(posts.map((post) => post.shareProblem)).toEqual([
      { kind: "copy-not-recorded", shareError: expect.stringContaining("server-9"), serverPostId: "server-9" },
      { kind: "share-failed", shareError: "Gave up after 8 attempts: unreachable", serverPostId: null },
      null,
    ]);
  });

  it("lists the posts that may have a copy elsewhere, removed ones included, and nothing else", async () => {
    mocks.findMany.mockResolvedValue([
      adminRow({ id: "a", unrecordedServerPostId: "server-9" }),
      adminRow({ id: "b", removedAt: NOW, content: "", serverPostId: "server-2" }),
      adminRow({ id: "c", shareSentAt: new Date("2026-06-30T00:00:00.000Z") }),
      // The filter is a superset; a row that classifies as nothing is dropped.
      adminRow({ id: "d", shareError: "refused" }),
    ]);

    const posts = await listClubPostShareProblems();

    expect(posts.map((post) => [post.id, post.shareProblem.kind])).toEqual([
      ["a", "copy-not-recorded"],
      ["b", "withdrawal-pending"],
      ["c", "outcome-unknown"],
    ]);
    const query = mocks.findMany.mock.calls[0][0];
    expect(query.take).toBe(50);
    expect(query.where).not.toHaveProperty("removedAt");
    expect(query.where.originClubCode).toBeNull();
  });
});

describe("withdrawing a shared copy on the admin's request (#5246)", () => {
  function held(overrides: Record<string, unknown>) {
    mocks.findUnique.mockResolvedValue(removedRow({ removedAt: null, ...overrides }));
  }

  it("withdraws a live post's unrecorded copy and clears it, never its own share and never the request", async () => {
    held({ serverPostId: "server-1", unrecordedServerPostId: "server-9" });
    mocks.withdrawClubPost.mockResolvedValue(undefined);

    await expect(withdrawSharedCopy("post-1")).resolves.toEqual({ serverPostIds: ["server-9"] });

    expect(mocks.withdrawClubPost.mock.calls).toEqual([["server-9"]]);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "post-1", unrecordedServerPostId: "server-9" },
      data: { unrecordedServerPostId: null, shareError: null },
    });
    const written = [...mocks.update.mock.calls, ...mocks.updateMany.mock.calls].map(([args]) => args.data);
    expect(written.some((data) => "shareRequestedAt" in data)).toBe(false);
  });

  it("withdraws a removed post's unconfirmed share and stamps the confirmation", async () => {
    held({ removedAt: NOW, serverPostId: "server-2" });
    mocks.withdrawClubPost.mockResolvedValue(undefined);

    await expect(withdrawSharedCopy("post-1")).resolves.toEqual({ serverPostIds: ["server-2"] });
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "post-1", serverPostId: "server-2", withdrawnAt: null },
      data: { withdrawnAt: expect.any(Date) },
    });
  });

  it("refuses when no copy's id is held, and never touches a live post's own share", async () => {
    held({ serverPostId: "server-1", sharedAt: NOW });

    await expect(withdrawSharedCopy("post-1")).rejects.toBeInstanceOf(ClubPostNoShareProblemError);
    expect(mocks.withdrawClubPost).not.toHaveBeenCalled();
  });

  it("never withdraws an unrecorded id that is the live post's own share (#5246 review)", async () => {
    held({ serverPostId: "server-9", sharedAt: NOW, unrecordedServerPostId: "server-9" });

    await expect(withdrawSharedCopy("post-1")).rejects.toBeInstanceOf(ClubPostNoShareProblemError);
    expect(mocks.withdrawClubPost).not.toHaveBeenCalled();
  });

  it("refuses a mirror, whose copy belongs to the club that wrote it", async () => {
    held({ originClubCode: "RUAPEHU", unrecordedServerPostId: "server-9" });

    await expect(withdrawSharedCopy("post-1")).rejects.toBeInstanceOf(ClubPostNoShareProblemError);
    expect(mocks.withdrawClubPost).not.toHaveBeenCalled();
  });

  it("keeps the id and names the central server's administrator when the server refuses", async () => {
    held({ unrecordedServerPostId: "server-9" });
    mocks.withdrawClubPost.mockRejectedValue(new Error("403 not your post"));

    const failure = withdrawSharedCopy("post-1");

    await expect(failure).rejects.toBeInstanceOf(ClubPostWithdrawalFailedError);
    await expect(failure).rejects.toThrow(/403 not your post.*central server's administrator/);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("reports a version pause as paused, with nothing cleared", async () => {
    held({ unrecordedServerPostId: "server-9" });
    mocks.withdrawClubPost.mockRejectedValue(new mocks.FakeVersionError());

    await expect(withdrawSharedCopy("post-1")).rejects.toBeInstanceOf(ClubPostWithdrawalPausedError);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("404s an unknown post", async () => {
    mocks.findUnique.mockResolvedValue(null);
    await expect(withdrawSharedCopy("nope")).rejects.toBeInstanceOf(ClubPostNotFoundError);
  });

  it("reports what a half-successful withdrawal did take down, for the audit row (#5246 review)", async () => {
    held({ removedAt: NOW, serverPostId: "server-1", unrecordedServerPostId: "server-9" });
    mocks.withdrawClubPost.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("503 unavailable"));

    const failure = await withdrawSharedCopy("post-1").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ClubPostWithdrawalFailedError);
    expect((failure as ClubPostWithdrawalFailedError).attempt).toEqual({
      withdrawnServerPostIds: ["server-9"],
      outstandingServerPostIds: ["server-1"],
    });
    expect((failure as Error).message).toMatch(/server-9 was withdrawn; the rest was not/);
    // The stray's confirmation is kept even though the call failed overall.
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "post-1", unrecordedServerPostId: "server-9" },
      data: { unrecordedServerPostId: null, shareError: null },
    });
  });

  it("a pause after the stray came down still names it as withdrawn", async () => {
    held({ removedAt: NOW, serverPostId: "server-1", unrecordedServerPostId: "server-9" });
    mocks.withdrawClubPost.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new mocks.FakeVersionError());

    const failure = await withdrawSharedCopy("post-1").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ClubPostWithdrawalPausedError);
    expect((failure as ClubPostWithdrawalPausedError).attempt).toEqual({
      withdrawnServerPostIds: ["server-9"],
      outstandingServerPostIds: ["server-1"],
    });
  });
});

/**
 * Two writers on the same post at once (#5246 review). Each reads the row
 * before either writes, so both ask the server; the second DELETE is a 404,
 * which `withdrawClubPost` treats as success. What keeps the row right is that
 * every confirmation is a guarded `updateMany` the loser matches nothing with,
 * and that no path writes the share request, so nothing is ever sent again.
 */
describe("concurrent withdrawals of the same copy (#5246 review)", () => {
  const strayLive = removedRow({ removedAt: null, serverPostId: "server-1", sharedAt: NOW, unrecordedServerPostId: "server-9" });
  const awaitingTakedown = removedRow({ serverPostId: "server-2" });

  /** The first guarded write wins; every later one with the same guard matches nothing. */
  function firstGuardedWriteWins() {
    const seen = new Set<string>();
    mocks.updateMany.mockImplementation(async ({ where }: { where: object }) => {
      const key = JSON.stringify(where);
      if (seen.has(key)) return { count: 0 };
      seen.add(key);
      return { count: 1 };
    });
  }

  function writes() {
    return [...mocks.update.mock.calls, ...mocks.updateMany.mock.calls].map(([args]) => args);
  }

  function neverResends() {
    expect(writes().some(({ data }) => "shareRequestedAt" in data || "sharedAt" in data || "shareSentAt" in data)).toBe(false);
    expect(mocks.update).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    firstGuardedWriteWins();
    mocks.withdrawClubPost.mockResolvedValue(undefined);
  });

  it("two admins: both succeed, the stray is cleared once, and the post's own share is untouched", async () => {
    mocks.findUnique.mockResolvedValue(strayLive);

    const results = await Promise.all([withdrawSharedCopy("post-1"), withdrawSharedCopy("post-1")]);

    expect(results).toEqual([{ serverPostIds: ["server-9"] }, { serverPostIds: ["server-9"] }]);
    expect(mocks.withdrawClubPost.mock.calls).toEqual([["server-9"], ["server-9"]]);
    expect(mocks.withdrawClubPost).not.toHaveBeenCalledWith("server-1");
    expect(writes()).toEqual([
      { where: { id: "post-1", unrecordedServerPostId: "server-9" }, data: { unrecordedServerPostId: null, shareError: null } },
      { where: { id: "post-1", unrecordedServerPostId: "server-9" }, data: { unrecordedServerPostId: null, shareError: null } },
    ]);
    expect(await Promise.all(mocks.updateMany.mock.results.map((r) => r.value))).toEqual([{ count: 1 }, { count: 0 }]);
    neverResends();
  });

  it("two admins on a removed post: one confirmation time is stamped, the other writes nothing", async () => {
    mocks.findUnique.mockResolvedValue(awaitingTakedown);

    await Promise.all([withdrawSharedCopy("post-1"), withdrawSharedCopy("post-1")]);

    const stamps = writes().filter(({ data }) => "withdrawnAt" in data);
    expect(stamps.map(({ where }) => where)).toEqual([
      { id: "post-1", serverPostId: "server-2", withdrawnAt: null },
      { id: "post-1", serverPostId: "server-2", withdrawnAt: null },
    ]);
    expect(await Promise.all(mocks.updateMany.mock.results.map((r) => r.value))).toEqual([{ count: 1 }, { count: 0 }]);
    neverResends();
  });

  it("an admin's withdrawal racing the removal: the removal still stands and both writes are guarded", async () => {
    mocks.findUnique.mockResolvedValue(strayLive);
    mocks.txFindUniqueOrThrow.mockResolvedValue({ ...strayLive, removedAt: NOW, images: [] });

    await Promise.all([withdrawSharedCopy("post-1"), removeClubPost("post-1")]);

    // The removal alone claims the row and clears the request; the admin's
    // action never writes removedAt or the request.
    expect(mocks.txUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.txUpdateMany.mock.calls[0][0].data).toMatchObject({ shareRequestedAt: null, removedAt: expect.any(Date) });
    // Both took the stray down; only the first clear matched.
    expect(mocks.withdrawClubPost.mock.calls.filter(([id]) => id === "server-9")).toHaveLength(2);
    const clears = writes().filter(({ data }) => "unrecordedServerPostId" in data);
    expect(clears).toHaveLength(2);
    expect(clears.every(({ where }) => where.unrecordedServerPostId === "server-9")).toBe(true);
    // The removal then withdraws the post's own share, guarded once.
    expect(writes().filter(({ data }) => "withdrawnAt" in data).map(({ where }) => where)).toEqual([
      { id: "post-1", serverPostId: "server-1", withdrawnAt: null },
    ]);
    neverResends();
  });

  it("an admin's withdrawal racing the sweep: both succeed and the confirmation is stamped once", async () => {
    const { isServerSyncPaused } = await import("@/lib/servernz-version-check");
    vi.mocked(isServerSyncPaused).mockResolvedValue(false);
    const { retryPendingWithdrawals } = await import("@/lib/club-post-sharing");
    mocks.findUnique.mockResolvedValue(awaitingTakedown);
    mocks.findMany.mockResolvedValue([awaitingTakedown]);

    const [admin, sweep] = await Promise.all([withdrawSharedCopy("post-1"), retryPendingWithdrawals()]);

    expect(admin).toEqual({ serverPostIds: ["server-2"] });
    expect(sweep).toEqual({ attempted: 1, confirmed: 1, failed: 0 });
    expect(await Promise.all(mocks.updateMany.mock.results.map((r) => r.value))).toEqual([{ count: 1 }, { count: 0 }]);
    neverResends();
  });
});

describe("marking an unrecorded share as dealt with (#5246)", () => {
  it("clears only the marker, and only while the post holds no server id and the grace has passed", async () => {
    await dismissShareOutcome("post-1", NOW);

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        id: "post-1",
        // Fifteen minutes before the frozen clock.
        shareSentAt: { not: null, lt: new Date("2026-06-30T23:45:00.000Z") },
        sharedAt: null,
        serverPostId: null,
      },
      data: { shareSentAt: null },
    });
  });

  it("refuses a send still inside the grace, which may yet record its own result (#5246 review)", async () => {
    // What the guarded write does to a send made one minute ago: no match.
    mocks.updateMany.mockImplementation(async ({ where }: { where: { shareSentAt: { lt: Date } } }) => ({
      count: new Date("2026-06-30T23:59:00.000Z") < where.shareSentAt.lt ? 1 : 0,
    }));
    mocks.findUnique.mockResolvedValue({ id: "post-1" });

    await expect(dismissShareOutcome("post-1", NOW)).rejects.toBeInstanceOf(ClubPostNoShareProblemError);
  });

  it("says there is nothing to deal with when the marker is gone, and 404s an unknown post", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });
    mocks.findUnique.mockResolvedValueOnce({ id: "post-1" }).mockResolvedValueOnce(null);

    await expect(dismissShareOutcome("post-1")).rejects.toBeInstanceOf(ClubPostNoShareProblemError);
    await expect(dismissShareOutcome("nope")).rejects.toBeInstanceOf(ClubPostNotFoundError);
  });
});
