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

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
  count: vi.fn(),
  withdrawClubPost: vi.fn(),
  imageFindMany: vi.fn(),
  imageDeleteMany: vi.fn(),
  transaction: vi.fn(),
  deletePostImage: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clubPost: {
      findUnique: mocks.findUnique,
      findMany: mocks.findMany,
      update: mocks.update,
      count: mocks.count,
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
  withdrawClubPost: mocks.withdrawClubPost,
}));

import { listClubPostsForMember } from "@/lib/club-posts";
import {
  ClubPostAlreadyRemovedError,
  ClubPostNotFoundError,
  ClubPostNotEditableError,
  countPendingWithdrawals,
  editClubPostContent,
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
  mocks.transaction.mockResolvedValue([]);
  mocks.deletePostImage.mockResolvedValue(undefined);
  mocks.update.mockResolvedValue({});
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
  it("blanks the content rather than only flagging the row", async () => {
    // Behind-a-filter is not gone. A future query that forgets the filter would
    // otherwise resurface words somebody asked to have removed.
    await removeClubPost("post-1");
    const data = mocks.update.mock.calls[0][0].data;
    expect(data.content).toBe("");
    expect(data.removedAt).toBeInstanceOf(Date);
  });

  it("keeps the author on the row, so a removal stays answerable for", async () => {
    await removeClubPost("post-1");
    const data = mocks.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("authorMemberId");
    expect(data).not.toHaveProperty("authorName");
  });

  it("is idempotent — removing twice is not an error", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "post-1",
      removedAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    await expect(removeClubPost("post-1")).resolves.toBeUndefined();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("404s an unknown post", async () => {
    mocks.findUnique.mockResolvedValue(null);
    await expect(removeClubPost("nope")).rejects.toBeInstanceOf(
      ClubPostNotFoundError,
    );
  });

  // #3091 review 1: a takedown of a SHARED post must be confirmed, retried,
  // and visible while outstanding — not fire-and-forget.
  it("stamps withdrawnAt when the central server confirms the takedown", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "post-1",
      removedAt: null,
      serverPostId: "server-9",
      originClubCode: null,
    });
    mocks.withdrawClubPost.mockResolvedValue(undefined);

    await removeClubPost("post-1");

    expect(mocks.withdrawClubPost).toHaveBeenCalledWith("server-9");
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "post-1" },
        data: { withdrawnAt: expect.any(Date) },
      }),
    );
  });

  it("leaves the removal standing and withdrawnAt unset when the withdrawal fails", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "post-1",
      removedAt: null,
      serverPostId: "server-9",
      originClubCode: null,
    });
    mocks.withdrawClubPost.mockRejectedValue(new Error("server down"));

    // NOT fatal: the local removal is what the admin asked for.
    await expect(removeClubPost("post-1")).resolves.toBeUndefined();

    const stamped = mocks.update.mock.calls.find(
      ([args]) => args.data.withdrawnAt !== undefined,
    );
    expect(stamped).toBeUndefined();
  });

  it("never withdraws a MIRROR — the network copy belongs to its origin club", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "post-1",
      removedAt: null,
      serverPostId: "server-9",
      originClubCode: "RUAPEHU",
    });

    await removeClubPost("post-1");

    expect(mocks.withdrawClubPost).not.toHaveBeenCalled();
  });

  it("counts removals whose network takedown is still outstanding", async () => {
    mocks.count.mockResolvedValue(2);

    await expect(countPendingWithdrawals()).resolves.toBe(2);
    expect(mocks.count).toHaveBeenCalledWith({
      where: {
        removedAt: { not: null },
        serverPostId: { not: null },
        originClubCode: null,
        withdrawnAt: null,
      },
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
