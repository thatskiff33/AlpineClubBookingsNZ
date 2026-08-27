import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Sharing a board post to the central server (epic #2992).
 *
 * The behaviour worth pinning is what happens when the far end misbehaves: a
 * member's post must survive somebody else's outage, must not be published
 * twice, and must not be retried forever against a refusal that will never
 * change.
 */

const mocks = vi.hoisted(() => {
  // Declared INSIDE the hoisted block. A plain `class` at module scope is not
  // hoisted the way vi.mock is, so the factory below would run first and find
  // it uninitialised.
  class FakeApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = "ServerNzApiError";
      this.status = status;
    }
  }
  return {
    FakeApiError,
    findUnique: vi.fn(),
    findMany: vi.fn(),
    withdrawClubPost: vi.fn(),
    update: vi.fn(),
    shareClubPost: vi.fn(),
    readPostImage: vi.fn(),
  };
});
const FakeApiError = mocks.FakeApiError;

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clubPost: {
      findUnique: mocks.findUnique,
      findMany: mocks.findMany,
      update: mocks.update,
    },
  },
}));

vi.mock("@/lib/servernz-api", () => ({
  ServerNzApiError: mocks.FakeApiError,
  shareClubPost: mocks.shareClubPost,
  withdrawClubPost: mocks.withdrawClubPost,
}));

vi.mock("@/lib/post-image-storage", () => ({
  readPostImage: mocks.readPostImage,
}));

import { retryPendingShares, shareOnePost } from "@/lib/club-post-sharing";

const REQUESTED = new Date("2026-07-01T00:00:00.000Z");

function post(overrides: Record<string, unknown> = {}) {
  return {
    id: "post-1",
    authorMemberId: "member-1",
    authorName: "Jo Whitcombe",
    content: "Chains needed above the second cattle stop.",
    bodyHtml: null,
    shareRequestedAt: REQUESTED,
    shareAttempts: 0,
    sharedAt: null,
    serverPostId: null,
    removedAt: null,
    images: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.update.mockResolvedValue({});
  mocks.readPostImage.mockResolvedValue(Buffer.from([1, 2, 3]));
});

describe("shareOnePost", () => {
  it("records the server's id and stamps sharedAt", async () => {
    mocks.findUnique.mockResolvedValue(post());
    mocks.shareClubPost.mockResolvedValue({ id: "server-9" });

    const outcome = await shareOnePost("post-1");

    expect(outcome).toEqual({ status: "shared", serverPostId: "server-9" });
    const data = mocks.update.mock.calls[0][0].data;
    expect(data.serverPostId).toBe("server-9");
    expect(data.sharedAt).toBeInstanceOf(Date);
    expect(data.shareError).toBeNull();
  });

  it("does not send a post that already has a server id", async () => {
    // The duplicate guard: a retry that crashed after the remote accepted it
    // but before the local row was updated must not publish it twice on every
    // other club's board.
    mocks.findUnique.mockResolvedValue(post({ serverPostId: "server-9" }));

    const outcome = await shareOnePost("post-1");

    expect(outcome).toEqual({ status: "skipped", reason: "already-shared" });
    expect(mocks.shareClubPost).not.toHaveBeenCalled();
  });

  it("does not send a post nobody asked to share", async () => {
    mocks.findUnique.mockResolvedValue(post({ shareRequestedAt: null }));
    const outcome = await shareOnePost("post-1");
    expect(outcome).toEqual({ status: "skipped", reason: "not-requested" });
    expect(mocks.shareClubPost).not.toHaveBeenCalled();
  });

  it("does not send a removed post", async () => {
    mocks.findUnique.mockResolvedValue(post({ removedAt: new Date() }));
    const outcome = await shareOnePost("post-1");
    expect(outcome).toEqual({ status: "skipped", reason: "gone" });
    expect(mocks.shareClubPost).not.toHaveBeenCalled();
  });

  it("keeps the request pending when the far end is merely unavailable", async () => {
    mocks.findUnique.mockResolvedValue(post());
    mocks.shareClubPost.mockRejectedValue(new FakeApiError(503, "unavailable"));

    const outcome = await shareOnePost("post-1");

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    // shareRequestedAt is NOT cleared, so the sweep carries it.
    expect(mocks.update.mock.calls[0][0].data).not.toHaveProperty(
      "shareRequestedAt",
    );
  });

  it("stops retrying a refusal that will never change", async () => {
    // A 4xx other than 429 is the server saying the REQUEST is wrong. Retrying
    // it unchanged just reproduces the same refusal on a schedule.
    mocks.findUnique.mockResolvedValue(post());
    mocks.shareClubPost.mockRejectedValue(
      new FakeApiError(403, "Token lacks posts:write scope"),
    );

    const outcome = await shareOnePost("post-1");

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    const data = mocks.update.mock.calls[0][0].data;
    expect(data.shareRequestedAt).toBeNull();
    expect(data.shareError).toContain("posts:write");
  });

  it("retries a rate limit rather than giving up on it", async () => {
    mocks.findUnique.mockResolvedValue(post());
    mocks.shareClubPost.mockRejectedValue(new FakeApiError(429, "slow down"));
    const outcome = await shareOnePost("post-1");
    expect(outcome).toMatchObject({ retryable: true });
  });

  it("sends images in position order, which is what the rewrite depends on", async () => {
    mocks.findUnique.mockResolvedValue(
      post({
        images: [
          { publicId: "a".repeat(32), mimeType: "image/webp", storageKey: "1" },
          { publicId: "b".repeat(32), mimeType: "image/webp", storageKey: "2" },
        ],
      }),
    );
    mocks.shareClubPost.mockResolvedValue({ id: "server-9" });

    await shareOnePost("post-1");

    const sent = mocks.shareClubPost.mock.calls[0][0];
    // The server maps image_ids[n] onto the nth file; a different order here
    // attaches every picture to the wrong place in the body.
    expect(sent.images.map((i: { publicId: string }) => i.publicId)).toEqual([
      "a".repeat(32),
      "b".repeat(32),
    ]);
  });

  it("shares the words even when an image file has gone missing", async () => {
    mocks.findUnique.mockResolvedValue(
      post({
        images: [
          { publicId: "a".repeat(32), mimeType: "image/webp", storageKey: "1" },
        ],
      }),
    );
    mocks.readPostImage.mockResolvedValue(null);
    mocks.shareClubPost.mockResolvedValue({ id: "server-9" });

    const outcome = await shareOnePost("post-1");

    expect(outcome.status).toBe("shared");
    expect(mocks.shareClubPost.mock.calls[0][0].images).toEqual([]);
  });
});

describe("retryPendingShares", () => {
  it("asks only for requested-but-not-yet-shared posts", async () => {
    mocks.findMany.mockResolvedValue([]);
    await retryPendingShares(REQUESTED);
    const where = mocks.findMany.mock.calls[0][0].where;
    expect(where.sharedAt).toBeNull();
    expect(where.removedAt).toBeNull();
    expect(where.shareRequestedAt).toMatchObject({ not: null });
  });

  it("counts what it managed and what it did not", async () => {
    mocks.findMany
      .mockResolvedValueOnce([{ id: "p1" }, { id: "p2" }])
      // The withdrawal half of the same pass finds nothing outstanding.
      .mockResolvedValueOnce([]);
    mocks.findUnique
      .mockResolvedValueOnce(post({ id: "p1" }))
      .mockResolvedValueOnce(post({ id: "p2" }));
    mocks.shareClubPost
      .mockResolvedValueOnce({ id: "server-1" })
      .mockRejectedValueOnce(new FakeApiError(503, "unavailable"));

    const result = await retryPendingShares(REQUESTED);

    expect(result).toEqual({
      attempted: 2,
      shared: 1,
      failed: 1,
      withdrawalsAttempted: 0,
      withdrawalsConfirmed: 0,
      withdrawalsFailed: 0,
    });
  });

  it("selects fewest-attempts-first so stuck posts cannot starve newer ones (#3091 r5)", async () => {
    mocks.findMany.mockResolvedValue([]);

    await retryPendingShares(REQUESTED);

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ shareAttempts: "asc" }, { shareRequestedAt: "asc" }],
      }),
    );
  });

  it("gives up at the attempt cap with the reason on the row (#3091 r5)", async () => {
    mocks.findUnique.mockResolvedValue(post({ shareAttempts: 7 }));
    mocks.shareClubPost.mockRejectedValue(new FakeApiError(503, "unavailable"));

    const outcome = await shareOnePost("post-1");

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          shareAttempts: 8,
          shareRequestedAt: null,
          shareError: expect.stringContaining("Gave up after 8 attempts"),
        }),
      }),
    );
  });

  it("retries the takedown of a removed shared post and stamps the confirmation (#3091 r1)", async () => {
    mocks.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "p9", serverPostId: "server-9" },
        { id: "p10", serverPostId: "server-10" },
      ]);
    mocks.withdrawClubPost
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new FakeApiError(503, "unavailable"));

    const result = await retryPendingShares(REQUESTED);

    expect(result).toMatchObject({
      withdrawalsAttempted: 2,
      withdrawalsConfirmed: 1,
      withdrawalsFailed: 1,
    });
    expect(mocks.withdrawClubPost).toHaveBeenCalledWith("server-9");
    // The confirmed one is stamped; the failed one is left for the next pass.
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "p9" },
        data: { withdrawnAt: expect.any(Date) },
      }),
    );
  });
});
