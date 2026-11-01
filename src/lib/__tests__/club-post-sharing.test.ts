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
  class FakeVersionError extends Error {
    expected = "2.0";
    serverVersion = "2.1";
    constructor() {
      super("paused");
      this.name = "ServerNzVersionMismatchError";
    }
  }
  return {
    FakeApiError,
    FakeVersionError,
    findUnique: vi.fn(),
    findMany: vi.fn(),
    withdrawClubPost: vi.fn(),
    update: vi.fn(),
    shareClubPost: vi.fn(),
    readPostImage: vi.fn(),
    isServerSyncPaused: vi.fn(),
    // #4588: the share's stamp runs under the settings-row lock, and removes
    // the mirror's copy of our own post if the mirror got there first.
    lockServerNzSettings: vi.fn(),
    executeRaw: vi.fn(),
    deleteMany: vi.fn(),
    // #4590: the stamp retried with the id already returned, without the lock.
    updateMany: vi.fn(),
    imageFindMany: vi.fn(),
    deletePostImage: vi.fn(),
    order: [] as string[],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});
const FakeApiError = mocks.FakeApiError;
const FakeVersionError = mocks.FakeVersionError;

vi.mock("@/lib/logger", () => ({ default: mocks.logger }));

// #49: the pause pre-check. Not paused by default so the existing behaviour
// is exercised unchanged; the pause block below flips it.
vi.mock("@/lib/servernz-version-check", () => ({
  isServerSyncPaused: mocks.isServerSyncPaused,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: (() => {
    const client: Record<string, unknown> = {
      clubPost: {
        findUnique: mocks.findUnique,
        findMany: mocks.findMany,
        update: mocks.update,
        updateMany: mocks.updateMany,
        deleteMany: mocks.deleteMany,
      },
      clubPostImage: { findMany: mocks.imageFindMany },
      $executeRaw: mocks.executeRaw,
    };
    client.$transaction = async (work: (tx: unknown) => Promise<unknown>) => work(client);
    return client;
  })(),
}));

vi.mock("@/lib/servernz-settings", () => ({
  SERVERNZ_TRANSACTION_OPTIONS: { timeout: 150_000, maxWait: 10_000 },
  lockServerNzSettings: mocks.lockServerNzSettings,
}));

vi.mock("@/lib/servernz-api", () => ({
  ServerNzApiError: mocks.FakeApiError,
  ServerNzVersionMismatchError: mocks.FakeVersionError,
  shareClubPost: mocks.shareClubPost,
  withdrawClubPost: mocks.withdrawClubPost,
}));

vi.mock("@/lib/post-image-storage", () => ({
  readPostImage: mocks.readPostImage,
  deletePostImage: mocks.deletePostImage,
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

/**
 * Which guarded write an `updateMany` is (#4590 review): the claim before the
 * send, the request put back, the locked stamp (our post holding no id or this
 * one), or the stamp without the lock (our post holding no id).
 */
type GuardedWrite = { where: Record<string, unknown>; data: Record<string, unknown> };
function writeKind({ where }: GuardedWrite): "claim" | "restore" | "stamp" | "unlocked-stamp" {
  if ("OR" in where) return "stamp";
  if (where.shareRequestedAt === null) return "restore";
  if ("shareRequestedAt" in where) return "claim";
  return "unlocked-stamp";
}
function writes(kind: ReturnType<typeof writeKind>): GuardedWrite[] {
  return mocks.updateMany.mock.calls.map(([args]) => args as GuardedWrite).filter((args) => writeKind(args) === kind);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.update.mockResolvedValue({});
  mocks.updateMany.mockImplementation(async (args: GuardedWrite) => {
    mocks.order.push(writeKind(args));
    return { count: 1 };
  });
  mocks.readPostImage.mockResolvedValue(Buffer.from([1, 2, 3]));
  mocks.isServerSyncPaused.mockResolvedValue(false);
  mocks.order.length = 0;
  mocks.lockServerNzSettings.mockImplementation(async () => { mocks.order.push("settings"); });
  mocks.executeRaw.mockImplementation(async () => { mocks.order.push("posts"); return 2; });
  mocks.deleteMany.mockImplementation(async () => { mocks.order.push("delete-copy"); return { count: 1 }; });
  mocks.imageFindMany.mockResolvedValue([]);
  mocks.deletePostImage.mockImplementation(async () => { mocks.order.push("file"); });
});

describe("the request is claimed before the send, so a share goes out at most once (#4590 review, #4592)", () => {
  beforeEach(() => {
    mocks.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => (where.id ? post() : null));
    mocks.shareClubPost.mockResolvedValue({ id: "server-9" });
  });

  it("takes the request off the row, guarded on the value it read, before anything is sent", async () => {
    mocks.shareClubPost.mockImplementation(async () => {
      mocks.order.push("send");
      return { id: "server-9" };
    });

    await shareOnePost("post-1");

    expect(writes("claim")).toEqual([{
      where: { id: "post-1", sharedAt: null, serverPostId: null, removedAt: null, shareRequestedAt: REQUESTED },
      data: { shareRequestedAt: null },
    }]);
    expect(mocks.order.indexOf("claim")).toBeLessThan(mocks.order.indexOf("send"));
  });

  it("sends nothing when another caller already claimed it", async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 0 });

    expect(await shareOnePost("post-1")).toEqual({ status: "skipped", reason: "claimed" });
    expect(mocks.shareClubPost).not.toHaveBeenCalled();
  });

  it("puts the request back only for a share the server did not take", async () => {
    mocks.shareClubPost.mockRejectedValue(new FakeApiError(503, "unavailable"));

    expect(await shareOnePost("post-1")).toMatchObject({ status: "failed", retryable: true });
    expect(mocks.update.mock.calls.at(-1)?.[0].data).toMatchObject({ shareRequestedAt: REQUESTED, shareAttempts: 1 });
  });

  it("puts the request back after a version pause, counting nothing", async () => {
    mocks.shareClubPost.mockRejectedValue(new FakeVersionError());

    expect(await shareOnePost("post-1")).toEqual({ status: "paused" });
    expect(writes("restore")).toEqual([{
      where: { id: "post-1", shareRequestedAt: null, sharedAt: null, serverPostId: null },
      data: { shareRequestedAt: REQUESTED },
    }]);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("never puts the request back after the server accepted the share, even when nothing can be recorded", async () => {
    mocks.lockServerNzSettings.mockRejectedValue(new Error("database unavailable"));
    mocks.updateMany.mockImplementation(async (args: GuardedWrite) => {
      if (writeKind(args) === "claim") return { count: 1 };
      throw new Error("database unavailable");
    });
    mocks.update.mockRejectedValue(new Error("database unavailable"));

    expect(await shareOnePost("post-1")).toMatchObject({ status: "failed", retryable: false });

    expect(mocks.shareClubPost).toHaveBeenCalledTimes(1);
    expect(writes("restore")).toEqual([]);
    expect(mocks.update.mock.calls.some(([args]) => args.data.shareRequestedAt)).toBe(false);
    // The log names the copy on the server.
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ serverPostId: "server-9" }), expect.stringMatching(/Could not record a share/),
    );
  });
});

describe("a share the server accepted is recorded with the id it returned (#4590)", () => {
  const lockFails = () => mocks.lockServerNzSettings.mockRejectedValueOnce(new Error("lock wait timeout"));

  beforeEach(() => {
    mocks.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => (where.id ? post() : null));
    mocks.shareClubPost.mockResolvedValue({ id: "server-9" });
  });

  it("records the returned id without the lock when the locked stamp fails, and reports it shared", async () => {
    lockFails();

    expect(await shareOnePost("post-1")).toEqual({ status: "shared", serverPostId: "server-9" });

    expect(mocks.shareClubPost).toHaveBeenCalledTimes(1);
    expect(writes("unlocked-stamp")).toEqual([{
      where: { id: "post-1", serverPostId: null },
      data: { serverPostId: "server-9", sharedAt: expect.any(Date), shareError: null },
    }]);
    // No attempt is counted against a share that succeeded.
    expect(mocks.update.mock.calls.some(([args]) => "shareAttempts" in args.data)).toBe(false);
  });

  it("takes the locked stamp again when the mirror's copy refuses the unlocked write", async () => {
    lockFails();
    mocks.updateMany.mockImplementation(async (args: GuardedWrite) => {
      if (writeKind(args) === "unlocked-stamp") throw new Error("Unique constraint failed on serverPostId");
      return { count: 1 };
    });

    expect(await shareOnePost("post-1")).toEqual({ status: "shared", serverPostId: "server-9" });

    expect(mocks.lockServerNzSettings).toHaveBeenCalledTimes(2);
    expect(writes("stamp")).toHaveLength(1);
    expect(mocks.shareClubPost).toHaveBeenCalledTimes(1);
  });

  it("counts a write that matched nothing as recorded when our post already holds the id", async () => {
    lockFails();
    mocks.updateMany.mockImplementation(async (args: GuardedWrite) => ({ count: writeKind(args) === "claim" ? 1 : 0 }));
    // Read unshared before the send; holding the id by the time it is re-read.
    let reads = 0;
    mocks.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => {
      if (!where.id) return null;
      reads += 1;
      return reads === 1 ? post() : post({ serverPostId: "server-9" });
    });

    expect(await shareOnePost("post-1")).toEqual({ status: "shared", serverPostId: "server-9" });
  });

  it("names the server id in shareError when every recording fails", async () => {
    mocks.lockServerNzSettings.mockRejectedValue(new Error("database unavailable"));
    mocks.updateMany.mockImplementation(async (args: GuardedWrite) => {
      if (writeKind(args) === "claim") return { count: 1 };
      throw new Error("database unavailable");
    });

    const outcome = await shareOnePost("post-1");

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(mocks.shareClubPost).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenLastCalledWith({
      where: { id: "post-1" },
      data: { shareAttempts: 1, shareError: expect.stringContaining("server-9") },
    });
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ serverPostId: "server-9" }), expect.stringMatching(/will not be sent again/),
    );
  });

  it("never writes over a DIFFERENT id our post already holds, and names the abandoned one (#4590 review)", async () => {
    mocks.updateMany.mockImplementation(async (args: GuardedWrite) => ({ count: writeKind(args) === "claim" ? 1 : 0 }));
    let reads = 0;
    mocks.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => {
      if (!where.id) return null;
      reads += 1;
      return reads === 1 ? post() : post({ serverPostId: "server-1" });
    });

    const outcome = await shareOnePost("post-1");

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(writes("stamp")[0]?.where).toEqual({ id: "post-1", OR: [{ serverPostId: null }, { serverPostId: "server-9" }] });
    // One attempt only: a mismatch is final.
    expect(mocks.lockServerNzSettings).toHaveBeenCalledTimes(1);
    expect(mocks.update.mock.calls.at(-1)?.[0].data).toMatchObject({
      shareRequestedAt: null, shareError: expect.stringMatching(/already recorded as server-1.*\(server-9\) was not recorded/),
    });
  });

  it("logs the id, and writes nothing, when our post was deleted before it could be recorded (#4590 review)", async () => {
    mocks.updateMany.mockImplementation(async (args: GuardedWrite) => ({ count: writeKind(args) === "claim" ? 1 : 0 }));
    let reads = 0;
    mocks.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => {
      if (!where.id) return null;
      reads += 1;
      return reads === 1 ? post() : null;
    });

    expect(await shareOnePost("post-1")).toMatchObject({ status: "failed", retryable: false });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ serverPostId: "server-9" }), expect.stringMatching(/deleted before its share was recorded/),
    );
  });
});

describe("the share's stamp and the mirror's copy of our own post (#4588)", () => {
  function sharedBack(copy: Record<string, unknown> | null) {
    mocks.findUnique.mockImplementation(async ({ where }: { where: { id?: string; serverPostId?: string } }) => {
      if (where.id && where.id === copy?.id) return copy;
      if (where.id) return post();
      mocks.order.push("find-copy");
      return copy;
    });
    mocks.shareClubPost.mockResolvedValue({ id: "server-9" });
  }

  it("stamps under the settings-row lock, the lock every mirror write holds", async () => {
    sharedBack(null);

    expect(await shareOnePost("post-1")).toEqual({ status: "shared", serverPostId: "server-9" });

    expect(mocks.order).toEqual(["claim", "settings", "find-copy", "stamp"]);
    expect(mocks.findUnique).toHaveBeenLastCalledWith(expect.objectContaining({ where: { serverPostId: "server-9" } }));
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("removes the copy the mirror made before the stamp, both posts locked in id order, then stamps", async () => {
    // The mirror stores our words and author name exactly as we sent them.
    sharedBack({ id: "copy-1", originClubCode: "OURCLUB", content: post().content, authorName: post().authorName });
    mocks.imageFindMany.mockResolvedValue([{ storageKey: "posts/2026/07/copy.webp" }]);

    expect(await shareOnePost("post-1")).toEqual({ status: "shared", serverPostId: "server-9" });

    expect(mocks.order).toEqual(["claim", "settings", "find-copy", "posts", "delete-copy", "stamp", "file"]);
    const [strings, ...values] = mocks.executeRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join("?")).toBe('SELECT 1 FROM "ClubPost" WHERE "id" IN (?, ?) ORDER BY "id" FOR UPDATE');
    expect(values).toEqual(["post-1", "copy-1"]);
    expect(mocks.imageFindMany).toHaveBeenCalledWith({ where: { postId: "copy-1" }, select: { storageKey: true } });
    expect(mocks.deleteMany).toHaveBeenCalledWith({ where: { id: "copy-1" } });
    expect(writes("stamp")[0]?.where).toMatchObject({ id: "post-1" });
    expect(mocks.deletePostImage).toHaveBeenCalledWith("posts/2026/07/copy.webp");
  });

  it.each([
    ["other words", { content: "Somebody else's post.", authorName: "Jo Whitcombe" }],
    ["another author", { content: "Chains needed above the second cattle stop.", authorName: "Someone Else" }],
  ])("never deletes a mirrored post that is not our copy (%s), and fails the stamp without retrying (#4588 review)", async (_label, fields) => {
    sharedBack({ id: "copy-1", originClubCode: "OTHERCLUB", ...fields });

    const outcome = await shareOnePost("post-1");

    expect(outcome).toMatchObject({ status: "failed", retryable: false });
    expect(mocks.deleteMany).not.toHaveBeenCalled();
    // Our post was never stamped with the id.
    expect(writes("stamp")).toEqual([]);
    // The failure is recorded on our post, naming the id, and the request
    // stays off it, because a retry would put a second copy on the server.
    const recorded = mocks.update.mock.calls.at(-1)?.[0];
    expect(recorded.data).toMatchObject({ shareRequestedAt: null, shareError: expect.stringMatching(/\(server-9\) is already held here by another club's post/) });
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ mirrorPostId: "copy-1" }), expect.stringMatching(/not our copy/),
    );
  });

  it("never deletes another of this club's own posts that holds the id", async () => {
    sharedBack({ id: "post-0", originClubCode: null });
    mocks.updateMany.mockImplementation(async (args: GuardedWrite) => {
      if (writeKind(args) === "stamp") throw new Error("Unique constraint failed on serverPostId");
      return { count: 1 };
    });

    await shareOnePost("post-1");

    expect(mocks.deleteMany).not.toHaveBeenCalled();
    expect(mocks.executeRaw).not.toHaveBeenCalled();
  });
});

describe("shareOnePost", () => {
  it("records the server's id and stamps sharedAt", async () => {
    mocks.findUnique.mockResolvedValue(post());
    mocks.shareClubPost.mockResolvedValue({ id: "server-9" });

    const outcome = await shareOnePost("post-1");

    expect(outcome).toEqual({ status: "shared", serverPostId: "server-9" });
    const data = writes("stamp")[0]!.data;
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
    // The request the claim took goes back, so the sweep carries it.
    expect(mocks.update.mock.calls[0][0].data.shareRequestedAt).toEqual(REQUESTED);
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
      paused: 0,
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

  it("leaves a share pending and uncounted, with nothing sent, while the server version differs (#49)", async () => {
    mocks.isServerSyncPaused.mockResolvedValue(true);
    mocks.findUnique.mockResolvedValue(post({ shareAttempts: 7 }));

    const outcome = await shareOnePost("post-1");

    expect(outcome).toEqual({ status: "paused" });
    expect(mocks.shareClubPost).not.toHaveBeenCalled();
    // NO attempt burned and NO error written: at 7 of 8 this would otherwise
    // retire the share for good on the first paused night.
    expect(mocks.update).not.toHaveBeenCalled();
    // Decided before the images were even read.
    expect(mocks.readPostImage).not.toHaveBeenCalled();
  });

  it("treats the gate's own refusal the same way: paused, nothing counted (#49)", async () => {
    mocks.findUnique.mockResolvedValue(post({ shareAttempts: 7 }));
    mocks.shareClubPost.mockRejectedValue(new FakeVersionError());

    const outcome = await shareOnePost("post-1");

    expect(outcome).toEqual({ status: "paused" });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.logger.info).toHaveBeenCalled();
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it("counts a paused page as paused and asks the server nothing more (#49)", async () => {
    mocks.isServerSyncPaused.mockResolvedValue(true);
    mocks.findMany.mockResolvedValueOnce([{ id: "p1" }, { id: "p2" }]);
    mocks.findUnique.mockResolvedValue(post({ id: "p1" }));

    const result = await retryPendingShares(REQUESTED);

    expect(result).toMatchObject({ attempted: 2, shared: 0, failed: 0, paused: 2 });
    expect(mocks.shareClubPost).not.toHaveBeenCalled();
    // The withdrawal half is paused too: no second findMany, no withdraw.
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.withdrawClubPost).not.toHaveBeenCalled();
    expect(result).toMatchObject({ withdrawalsAttempted: 0 });
  });

  it("stops the withdrawal sweep on the server's own version refusal without counting a failure (#49 review)", async () => {
    mocks.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "p9", serverPostId: "server-9" },
        { id: "p10", serverPostId: "server-10" },
      ]);
    mocks.withdrawClubPost.mockRejectedValueOnce(new FakeVersionError());

    const result = await retryPendingShares(REQUESTED);

    expect(result).toMatchObject({ withdrawalsAttempted: 2, withdrawalsConfirmed: 0, withdrawalsFailed: 0 });
    // The second row was not even asked: one refusal answers for the page.
    expect(mocks.withdrawClubPost).toHaveBeenCalledTimes(1);
    expect(mocks.logger.warn).not.toHaveBeenCalled();
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
