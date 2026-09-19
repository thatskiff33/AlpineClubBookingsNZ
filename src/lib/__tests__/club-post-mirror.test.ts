import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mirroring shared posts from the central server (epic #2992).
 *
 * The rules worth pinning are the AUTHORITY rules: our own post coming back
 * around the loop must never be overwritten by the server's derived copy, a
 * network takedown of our own post hides it rather than deleting a member's
 * words, and a mirror is a cache that deletes cleanly. The cursor rule —
 * advance after applying, never before — is what makes a crash replay
 * converge instead of losing posts.
 *
 * The "cursor overlap" block below is #3449: the first request of a pass asks
 * from one bounded window before the stored position, so a post committed late
 * is picked up next pass rather than skipped forever, and the mirror's own
 * apply path is proved idempotent against the repeat that buys.
 */

const mocks = vi.hoisted(() => ({
  postFindUnique: vi.fn(),
  postCreate: vi.fn(),
  postUpdate: vi.fn(),
  postDelete: vi.fn(),
  imageDeleteMany: vi.fn(),
  settingsUpsert: vi.fn(),
  settingsUpdateMany: vi.fn(),
  settingsFindUnique: vi.fn(),
  settingsUpdate: vi.fn(),
  transaction: vi.fn(),
  pullSharedPostSync: vi.fn(),
  fetchSharedPostImage: vi.fn(),
  registerPushTarget: vi.fn(),
  getServerNzSetupState: vi.fn(),
  getIntegrationCredentialValue: vi.fn(),
  setIntegrationCredential: vi.fn(),
  writePostImage: vi.fn(),
  deletePostImage: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    warn: mocks.loggerWarn,
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clubPost: {
      findUnique: mocks.postFindUnique,
      create: mocks.postCreate,
      update: mocks.postUpdate,
      delete: mocks.postDelete,
    },
    clubPostImage: { deleteMany: mocks.imageDeleteMany },
    serverNzSettings: {
      upsert: mocks.settingsUpsert,
      updateMany: mocks.settingsUpdateMany,
      findUnique: mocks.settingsFindUnique,
      update: mocks.settingsUpdate,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/servernz-api", () => ({
  pullSharedPostSync: mocks.pullSharedPostSync,
  fetchSharedPostImage: mocks.fetchSharedPostImage,
  registerPushTarget: mocks.registerPushTarget,
}));

vi.mock("@/lib/servernz-config", () => ({
  getServerNzSetupState: mocks.getServerNzSetupState,
}));

vi.mock("@/lib/integration-credentials", () => ({
  getIntegrationCredentialValue: mocks.getIntegrationCredentialValue,
  setIntegrationCredential: mocks.setIntegrationCredential,
}));

vi.mock("@/lib/post-image-storage", () => ({
  writePostImage: mocks.writePostImage,
  deletePostImage: mocks.deletePostImage,
}));

import { runMirrorSync } from "@/lib/club-post-mirror";

const NOW = new Date("2026-07-01T00:00:00.000Z");
const SERVER_IMAGE = "c".repeat(32);

function visiblePost(overrides: Record<string, unknown> = {}) {
  return {
    state: "visible" as const,
    post: {
      id: "srv-1",
      club: { id: "club-2", name: "Ruapehu Alpine Club", code: "RUAPEHU" },
      authorName: "Alex Rangi",
      content: "Chains needed on the access road.",
      bodyHtml: null,
      images: [],
      createdAt: "2026-06-30T00:00:00.000Z",
      updatedAt: "2026-06-30T01:00:00.000Z",
      ...overrides,
    },
  };
}

function envelope(changes: unknown[], cursor = { since: "2026-06-30T01:00:00.000Z", sinceId: "srv-1" }) {
  return { changes, cursor, hasMore: false };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getServerNzSetupState.mockResolvedValue({ apiKeySet: true });
  mocks.getIntegrationCredentialValue.mockResolvedValue("stored-secret");
  mocks.settingsUpsert.mockResolvedValue({});
  mocks.settingsUpdateMany.mockResolvedValue({ count: 1 });
  mocks.settingsFindUnique.mockResolvedValue({
    commsCursorSince: null,
    commsCursorSinceId: null,
  });
  mocks.settingsUpdate.mockResolvedValue({});
  mocks.postFindUnique.mockResolvedValue(null);
  mocks.postCreate.mockResolvedValue({});
  mocks.transaction.mockResolvedValue([]);
});

describe("runMirrorSync", () => {
  it("skips when the integration is not configured", async () => {
    mocks.getServerNzSetupState.mockResolvedValue({ apiKeySet: false });
    const result = await runMirrorSync(NOW);
    expect(result.skipped).toBe("not-configured");
    expect(mocks.pullSharedPostSync).not.toHaveBeenCalled();
  });

  it("reports busy when another pass holds the claim", async () => {
    mocks.settingsUpdateMany.mockResolvedValue({ count: 0 });
    const result = await runMirrorSync(NOW);
    expect(result.skipped).toBe("busy");
    expect(mocks.pullSharedPostSync).not.toHaveBeenCalled();
  });

  it("creates a mirror row for another club's post", async () => {
    mocks.pullSharedPostSync.mockResolvedValue(envelope([visiblePost()]));

    const result = await runMirrorSync(NOW);

    expect(result.upserted).toBe(1);
    const data = mocks.postCreate.mock.calls[0][0].data;
    expect(data.serverPostId).toBe("srv-1");
    expect(data.originClubCode).toBe("RUAPEHU");
    // No local member wrote this; there is nobody to link.
    expect(data.authorMemberId).toBeNull();
  });

  it("never overwrites this club's own post with the server's copy", async () => {
    // The loop: we shared it, the feed hands it back. This install is
    // authoritative for its own members' words.
    mocks.pullSharedPostSync.mockResolvedValue(envelope([visiblePost()]));
    mocks.postFindUnique.mockResolvedValue({
      id: "local-1",
      originClubCode: null,
      images: [],
    });

    await runMirrorSync(NOW);

    expect(mocks.postCreate).not.toHaveBeenCalled();
    expect(mocks.postUpdate).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("deletes a mirror outright on a tombstone, files included", async () => {
    mocks.pullSharedPostSync.mockResolvedValue(
      envelope([{ state: "removed", id: "srv-1", reason: "removed" }]),
    );
    mocks.postFindUnique.mockResolvedValue({
      id: "local-9",
      originClubCode: "RUAPEHU",
      hiddenAt: null,
      images: [{ storageKey: "posts/2026/06/x.webp" }],
    });

    const result = await runMirrorSync(NOW);

    expect(result.removed).toBe(1);
    expect(mocks.postDelete).toHaveBeenCalledWith({ where: { id: "local-9" } });
    expect(mocks.deletePostImage).toHaveBeenCalledWith("posts/2026/06/x.webp");
  });

  it("hides rather than deletes this club's own post on a network takedown", async () => {
    // Takedown convergence is a moderation action, not an erasure: the words
    // belong to this club's own member, so the row is hidden and unshackled
    // from the network, never destroyed.
    mocks.pullSharedPostSync.mockResolvedValue(
      envelope([{ state: "removed", id: "srv-1", reason: "removed" }]),
    );
    mocks.postFindUnique.mockResolvedValue({
      id: "local-1",
      originClubCode: null,
      hiddenAt: null,
      images: [],
    });

    await runMirrorSync(NOW);

    expect(mocks.postDelete).not.toHaveBeenCalled();
    const data = mocks.postUpdate.mock.calls[0][0].data;
    expect(data.hiddenAt).toBeInstanceOf(Date);
    expect(data.serverPostId).toBeNull();
    expect(data.sharedAt).toBeNull();
  });

  it("advances the cursor only after a page is applied", async () => {
    const order: string[] = [];
    mocks.pullSharedPostSync.mockImplementation(async () => {
      order.push("pull");
      return envelope([visiblePost()]);
    });
    mocks.postCreate.mockImplementation(async () => {
      order.push("apply");
      return {};
    });
    mocks.settingsUpdate.mockImplementation(async (args: { data: Record<string, unknown> }) => {
      if ("commsCursorSince" in args.data) order.push("cursor");
      return {};
    });

    await runMirrorSync(NOW);

    // A crash between apply and cursor replays the page; every write is an
    // idempotent upsert or delete, so replay converges. The reverse order
    // silently loses whatever the crash interrupted.
    expect(order.indexOf("apply")).toBeLessThan(order.indexOf("cursor"));
  });

  it("mirrors a rich body with its image rewritten to the local copy", async () => {
    mocks.pullSharedPostSync.mockResolvedValue(
      envelope([
        visiblePost({
          bodyHtml: `<p>Road</p><img src="/api/images/posts/${SERVER_IMAGE}.webp" alt="">`,
          images: [
            { url: `/api/images/posts/${SERVER_IMAGE}.webp`, width: 100, height: 80 },
          ],
        }),
      ]),
    );
    mocks.fetchSharedPostImage.mockResolvedValue(new Uint8Array([1]));
    mocks.writePostImage.mockResolvedValue({
      publicId: "d".repeat(32),
      storageKey: "posts/2026/07/local.webp",
      mimeType: "image/webp",
      sha256: "e".repeat(64),
      width: 100,
      height: 80,
      bytes: 1,
    });

    await runMirrorSync(NOW);

    const data = mocks.postCreate.mock.calls[0][0].data;
    // Points at THIS install's session-checked route, not the central server.
    expect(data.bodyHtml).toContain(`/api/club-posts/images/${"d".repeat(32)}`);
    expect(data.bodyHtml).not.toContain("/api/images/posts/");
  });

  it("gives a plain post with pictures a body, so the pictures are seen", async () => {
    // The board renders images only through the body. Without this, a post
    // that arrived as text-plus-attachments would have its pictures stored,
    // counted and never shown to anyone.
    mocks.pullSharedPostSync.mockResolvedValue(
      envelope([
        visiblePost({
          bodyHtml: null,
          images: [{ url: `/api/images/posts/${SERVER_IMAGE}.webp` }],
        }),
      ]),
    );
    mocks.fetchSharedPostImage.mockResolvedValue(new Uint8Array([1]));
    mocks.writePostImage.mockResolvedValue({
      publicId: "d".repeat(32),
      storageKey: "posts/2026/07/local.webp",
      mimeType: "image/webp",
      sha256: "e".repeat(64),
      width: 100,
      height: 80,
      bytes: 1,
    });

    await runMirrorSync(NOW);

    const data = mocks.postCreate.mock.calls[0][0].data;
    expect(data.bodyHtml).toContain(`/api/club-posts/images/${"d".repeat(32)}`);
  });

  it("mirrors the words even when an image cannot be fetched", async () => {
    mocks.pullSharedPostSync.mockResolvedValue(
      envelope([
        visiblePost({
          images: [{ url: `/api/images/posts/${SERVER_IMAGE}.webp` }],
        }),
      ]),
    );
    mocks.fetchSharedPostImage.mockResolvedValue(null);

    const result = await runMirrorSync(NOW);

    expect(result.upserted).toBe(1);
    expect(mocks.postCreate.mock.calls[0][0].data.images.create).toEqual([]);
  });

  it("releases the claim even when the pull throws", async () => {
    mocks.pullSharedPostSync.mockRejectedValue(new Error("server down"));

    await expect(runMirrorSync(NOW)).rejects.toThrow("server down");

    const release = mocks.settingsUpdate.mock.calls.find(
      ([args]) => args.data.commsSyncStartedAt === null,
    );
    expect(release).toBeDefined();
  });

  // #3091 review 2: one bad change must not wedge the mirror permanently.
  it("records a first failure as poison and aborts the pass without advancing the cursor", async () => {
    mocks.pullSharedPostSync.mockResolvedValue(envelope([visiblePost()]));
    mocks.postCreate.mockRejectedValue(new Error("value too long"));

    await expect(runMirrorSync(NOW)).rejects.toThrow("value too long");

    const poison = mocks.settingsUpdate.mock.calls.find(
      ([args]) => args.data.commsPoisonChangeId === "srv-1",
    );
    expect(poison).toBeDefined();
    expect(poison?.[0].data.commsPoisonCount).toBe(1);
    const advanced = mocks.settingsUpdate.mock.calls.find(
      ([args]) => args.data.commsCursorSince !== undefined,
    );
    expect(advanced).toBeUndefined();
  });

  it("steps OVER a change that has failed three consecutive passes, and the feed continues", async () => {
    mocks.settingsFindUnique.mockResolvedValue({
      commsCursorSince: null,
      commsCursorSinceId: null,
      commsPoisonChangeId: "srv-1",
      commsPoisonCount: 2,
    });
    mocks.pullSharedPostSync.mockResolvedValue(
      envelope([visiblePost(), visiblePost({ id: "srv-2" })]),
    );
    // The poison change still fails; the one behind it is fine.
    mocks.postCreate
      .mockRejectedValueOnce(new Error("value too long"))
      .mockResolvedValue({});

    const result = await runMirrorSync(NOW);

    // srv-1 skipped, srv-2 applied, cursor advanced, poison cleared.
    expect(result.upserted).toBe(1);
    const cleared = mocks.settingsUpdate.mock.calls.find(
      ([args]) => args.data.commsPoisonChangeId === null,
    );
    expect(cleared).toBeDefined();
    const advanced = mocks.settingsUpdate.mock.calls.find(
      ([args]) => args.data.commsCursorSince !== undefined,
    );
    expect(advanced).toBeDefined();
  });

  it("forgets recorded poison when the change applies cleanly on retry", async () => {
    mocks.settingsFindUnique.mockResolvedValue({
      commsCursorSince: null,
      commsCursorSinceId: null,
      commsPoisonChangeId: "srv-1",
      commsPoisonCount: 1,
    });
    mocks.pullSharedPostSync.mockResolvedValue(envelope([visiblePost()]));

    const result = await runMirrorSync(NOW);

    expect(result.upserted).toBe(1);
    const cleared = mocks.settingsUpdate.mock.calls.find(
      ([args]) => args.data.commsPoisonChangeId === null,
    );
    expect(cleared).toBeDefined();
  });

  // #3091 review 2a: sanitising GROWS a body, so the cap is measured on what
  // the column stores. Anchors gain target/rel — a wire-legal body can come
  // out over 20,000 and would fail the insert AFTER rows are written.
  it("mirrors an over-long sanitised body as plain text rather than wedging", async () => {
    const anchors = Array.from(
      { length: 420 },
      (_unused, i) => `<a href="https://example.org/${i}">x</a>`,
    ).join(" ");
    mocks.pullSharedPostSync.mockResolvedValue(
      envelope([visiblePost({ bodyHtml: anchors })]),
    );

    const result = await runMirrorSync(NOW);

    expect(result.upserted).toBe(1);
    expect(mocks.postCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ bodyHtml: null }),
      }),
    );
  });

  // #3091 review 2b: the wire schema only requires a non-empty string, and
  // Prisma throws on an Invalid Date — a poison change by another route.
  it("skips a post whose createdAt does not parse, loudly, without wedging", async () => {
    mocks.pullSharedPostSync.mockResolvedValue(
      envelope([visiblePost({ createdAt: "not a date" })]),
    );

    await runMirrorSync(NOW);

    expect(mocks.postCreate).not.toHaveBeenCalled();
    const advanced = mocks.settingsUpdate.mock.calls.find(
      ([args]) => args.data.commsCursorSince !== undefined,
    );
    expect(advanced).toBeDefined();
  });
});

// #3449: the bounded overlap before the stored position, and the mirror's own
// evidence that the repeat it re-delivers is harmless.
describe("runMirrorSync cursor overlap", () => {
  const STORED = { since: "2026-06-30T01:00:00.000Z", sinceId: "srv-1" };
  const ONE_MINUTE_EARLIER = "2026-06-30T00:59:00.000Z";

  function storedPosition(position = STORED) {
    mocks.settingsFindUnique.mockResolvedValue({
      commsCursorSince: position.since,
      commsCursorSinceId: position.sinceId,
      commsPoisonChangeId: null,
      commsPoisonCount: 0,
    });
  }

  function cursorWrites() {
    return mocks.settingsUpdate.mock.calls
      .filter(([args]) => "commsCursorSince" in args.data)
      .map(([args]) => args.data);
  }

  /** A mirror row already holding exactly what `visiblePost()` delivers. */
  function mirroredCopy(overrides: Record<string, unknown> = {}) {
    return {
      id: "local-2",
      originClubCode: "RUAPEHU",
      originClubName: "Ruapehu Alpine Club",
      content: "Chains needed on the access road.",
      bodyHtml: null,
      images: [],
      ...overrides,
    };
  }

  it("asks from one window before the stored position, with the tiebreak id dropped", async () => {
    // THE DEFECT. A post stamped 00:59:30 whose commit landed after the read
    // that returned the 01:00:00 cursor was behind the watermark on its first
    // visible read and never asked for again. Asking from 00:59:00 picks it up
    // on the very next pass. `sinceId` is dropped with the step: it orders rows
    // at the stored instant exactly, and paired with an earlier instant it
    // would exclude a sliver of that instant's rows.
    storedPosition();
    const late = visiblePost({ id: "srv-late", updatedAt: "2026-06-30T00:59:30.000Z" });
    mocks.pullSharedPostSync.mockResolvedValue(
      envelope([late], { since: "2026-06-30T01:00:00.000Z", sinceId: "srv-1" }),
    );

    const result = await runMirrorSync(NOW);

    expect(mocks.pullSharedPostSync).toHaveBeenCalledWith({
      since: ONE_MINUTE_EARLIER,
      sinceId: null,
    });
    expect(result.upserted).toBe(1);
    expect(mocks.postCreate.mock.calls[0][0].data.serverPostId).toBe("srv-late");
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });

  it("applies a re-delivered identical post idempotently and does not count it as changed", async () => {
    // The row the overlap is FOR: already mirrored on the previous pass, back
    // again because it sits inside the window. Nothing is written and it is
    // reported as unchanged, so a working overlap never reads as activity.
    storedPosition();
    mocks.pullSharedPostSync.mockResolvedValue(
      envelope([visiblePost({ updatedAt: "2026-06-30T00:59:30.000Z" })]),
    );
    mocks.postFindUnique.mockResolvedValue(mirroredCopy());

    const result = await runMirrorSync(NOW);

    expect(result.unchanged).toBe(1);
    expect(result.upserted).toBe(0);
    expect(mocks.postCreate).not.toHaveBeenCalled();
    expect(mocks.postUpdate).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.deletePostImage).not.toHaveBeenCalled();
    // The durable position still moves to the server's answer.
    expect(cursorWrites()).toEqual([
      { commsCursorSince: STORED.since, commsCursorSinceId: STORED.sinceId },
    ]);
  });

  it("recognises an identical re-delivery with pictures by their bytes, and drops the duplicate files", async () => {
    // Two passes of the SAME post. Images are stored under a fresh local id
    // every time they are fetched, so the body's image URLs differ between the
    // two renderings; sameness is judged on the picture bytes (SHA-256) and the
    // body with those ids blanked. The second pass's duplicate files are
    // removed, not left for the orphan sweep.
    storedPosition();
    mocks.pullSharedPostSync.mockResolvedValue(
      envelope([
        visiblePost({
          bodyHtml: `<p>Road</p><img src="/api/images/posts/${SERVER_IMAGE}.webp" alt="">`,
          images: [{ url: `/api/images/posts/${SERVER_IMAGE}.webp` }],
          updatedAt: "2026-06-30T00:59:30.000Z",
        }),
      ]),
    );
    mocks.fetchSharedPostImage.mockResolvedValue(new Uint8Array([1]));
    const stored = (publicId: string, storageKey: string) => ({
      publicId,
      storageKey,
      mimeType: "image/webp",
      sha256: "e".repeat(64),
      width: 100,
      height: 80,
      bytes: 1,
    });
    mocks.writePostImage.mockResolvedValueOnce(stored("d".repeat(32), "posts/2026/06/first.webp"));

    const first = await runMirrorSync(NOW);
    expect(first.upserted).toBe(1);
    const created = mocks.postCreate.mock.calls[0][0].data;

    mocks.writePostImage.mockResolvedValueOnce(stored("f".repeat(32), "posts/2026/07/duplicate.webp"));
    mocks.postFindUnique.mockResolvedValue(
      mirroredCopy({
        bodyHtml: created.bodyHtml,
        images: [
          { publicId: "d".repeat(32), storageKey: "posts/2026/06/first.webp", sha256: "e".repeat(64) },
        ],
      }),
    );

    const second = await runMirrorSync(NOW);

    expect(second.unchanged).toBe(1);
    expect(second.upserted).toBe(0);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.postCreate).toHaveBeenCalledTimes(1);
    expect(mocks.deletePostImage).toHaveBeenCalledTimes(1);
    expect(mocks.deletePostImage).toHaveBeenCalledWith("posts/2026/07/duplicate.webp");
  });

  it("reads the existing pictures in position order, so a many-picture repeat compares unchanged", async () => {
    // Sameness is judged image-by-image against the server's list, which is
    // positional. Without an order on the read, Postgres returns the rows in
    // whatever order it likes, and an identical two-picture post can compare
    // "updated" — re-downloading and re-writing its files every pass inside
    // the window. The order is pinned on the query, and a two-picture repeat
    // is proved unchanged end to end.
    storedPosition();
    const second = "b".repeat(32);
    mocks.pullSharedPostSync.mockResolvedValue(
      envelope([
        visiblePost({
          bodyHtml:
            `<p>Road</p><img src="/api/images/posts/${SERVER_IMAGE}.webp" alt="">` +
            `<img src="/api/images/posts/${second}.webp" alt="">`,
          images: [
            { url: `/api/images/posts/${SERVER_IMAGE}.webp` },
            { url: `/api/images/posts/${second}.webp` },
          ],
          updatedAt: "2026-06-30T00:59:30.000Z",
        }),
      ]),
    );
    mocks.fetchSharedPostImage.mockResolvedValue(new Uint8Array([1]));
    const stored = (publicId: string, storageKey: string, sha: string) => ({
      publicId,
      storageKey,
      mimeType: "image/webp",
      sha256: sha,
      width: 100,
      height: 80,
      bytes: 1,
    });
    mocks.writePostImage
      .mockResolvedValueOnce(stored("1".repeat(32), "posts/2026/06/one.webp", "a".repeat(64)))
      .mockResolvedValueOnce(stored("2".repeat(32), "posts/2026/06/two.webp", "b".repeat(64)));
    const first = await runMirrorSync(NOW);
    expect(first.upserted).toBe(1);
    const created = mocks.postCreate.mock.calls[0][0].data;

    mocks.writePostImage
      .mockResolvedValueOnce(stored("3".repeat(32), "posts/2026/07/one-again.webp", "a".repeat(64)))
      .mockResolvedValueOnce(stored("4".repeat(32), "posts/2026/07/two-again.webp", "b".repeat(64)));
    mocks.postFindUnique.mockResolvedValue(
      mirroredCopy({
        bodyHtml: created.bodyHtml,
        images: [
          { publicId: "1".repeat(32), storageKey: "posts/2026/06/one.webp", sha256: "a".repeat(64) },
          { publicId: "2".repeat(32), storageKey: "posts/2026/06/two.webp", sha256: "b".repeat(64) },
        ],
      }),
    );

    const again = await runMirrorSync(NOW);

    expect(again.unchanged).toBe(1);
    expect(again.upserted).toBe(0);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.deletePostImage.mock.calls.map(([key]) => key)).toEqual([
      "posts/2026/07/one-again.webp",
      "posts/2026/07/two-again.webp",
    ]);
    // The order the comparison depends on is asked of the database, not
    // assumed of it.
    expect(mocks.postFindUnique).toHaveBeenLastCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          images: expect.objectContaining({ orderBy: { position: "asc" } }),
        }),
      }),
    );
  });

  it("still applies a re-delivered post whose words changed, and counts it", async () => {
    // The counterweight: idempotent on a repeat must not become blind to an
    // edit that happens to land inside the window.
    storedPosition();
    mocks.pullSharedPostSync.mockResolvedValue(
      envelope([
        visiblePost({
          content: "Chains needed on the access road. Grader due at noon.",
          updatedAt: "2026-06-30T00:59:30.000Z",
        }),
      ]),
    );
    mocks.postFindUnique.mockResolvedValue(mirroredCopy());

    const result = await runMirrorSync(NOW);

    expect(result.upserted).toBe(1);
    expect(result.unchanged).toBe(0);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it("leaves an initial sync with no stored position unchanged", async () => {
    mocks.pullSharedPostSync.mockResolvedValue(envelope([visiblePost()]));

    await runMirrorSync(NOW);

    expect(mocks.pullSharedPostSync).toHaveBeenCalledWith({ since: null, sinceId: null });
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });

  it("leaves the durable position where it was when the pull fails", async () => {
    storedPosition();
    mocks.pullSharedPostSync.mockRejectedValue(new Error("server down"));

    await expect(runMirrorSync(NOW)).rejects.toThrow("server down");

    expect(cursorWrites()).toEqual([]);
  });

  it("leaves the durable position where it was when a change in the page fails", async () => {
    storedPosition();
    mocks.pullSharedPostSync.mockResolvedValue(
      envelope([visiblePost()], { since: "2026-06-30T02:00:00.000Z", sinceId: "srv-1" }),
    );
    mocks.postCreate.mockRejectedValue(new Error("write failed"));

    await expect(runMirrorSync(NOW)).rejects.toThrow("write failed");

    expect(cursorWrites()).toEqual([]);
  });

  it("keeps the first page's position when the second page fails, and writes no later one", async () => {
    // A multi-page pass persists after EACH applied page, so a failure on page
    // two keeps page one — nothing applied is lost, nothing unapplied is
    // stepped past. What must not happen is a write for the failed page.
    storedPosition();
    const pageOne = { since: "2026-06-30T01:30:00.000Z", sinceId: "srv-5" };
    mocks.pullSharedPostSync
      .mockResolvedValueOnce({ changes: [visiblePost()], cursor: pageOne, hasMore: true })
      .mockResolvedValueOnce(
        envelope([visiblePost({ id: "srv-2" })], {
          since: "2026-06-30T02:00:00.000Z",
          sinceId: "srv-9",
        }),
      );
    mocks.postCreate.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("write failed"));

    await expect(runMirrorSync(NOW)).rejects.toThrow("write failed");

    expect(cursorWrites()).toEqual([
      { commsCursorSince: pageOne.since, commsCursorSinceId: pageOne.sinceId },
    ]);
  });

  it("never lets the durable position rewind when the server echoes the overlapped request", async () => {
    // A cursor endpoint ordinarily echoes `since` on an empty page. Quiet
    // pass: stored C, request C - 60s, no rows, echo C - 60s — storing that
    // rewinds a minute per pass. The stored PAIR is kept: the server's
    // tiebreak belongs with the server's timestamp, not with ours.
    storedPosition();
    mocks.pullSharedPostSync.mockResolvedValue(
      envelope([], { since: ONE_MINUTE_EARLIER, sinceId: "srv-0" }),
    );

    await runMirrorSync(NOW);

    expect(cursorWrites()).toEqual([
      { commsCursorSince: STORED.since, commsCursorSinceId: STORED.sinceId },
    ]);
  });

  it("still advances to a server position that is genuinely later", async () => {
    storedPosition();
    mocks.pullSharedPostSync.mockResolvedValue(
      envelope([], { since: "2026-06-30T01:00:00.001Z", sinceId: "srv-2" }),
    );

    await runMirrorSync(NOW);

    expect(cursorWrites()).toEqual([
      { commsCursorSince: "2026-06-30T01:00:00.001Z", commsCursorSinceId: "srv-2" },
    ]);
  });

  it("steps back only on the first page of a pass; later pages continue from the server's cursor", async () => {
    // A later page's cursor is a position inside THIS pass's read, not a
    // watermark left by an earlier one. Stepping it back would re-fetch each
    // page's tail on the next, and a dense page would be re-served identically
    // until the page cap.
    storedPosition();
    const pageOne = { since: "2026-06-30T01:30:00.000Z", sinceId: "srv-5" };
    mocks.pullSharedPostSync
      .mockResolvedValueOnce({ changes: [], cursor: pageOne, hasMore: true })
      .mockResolvedValueOnce(
        envelope([], { since: "2026-06-30T02:00:00.000Z", sinceId: "srv-9" }),
      );

    const result = await runMirrorSync(NOW);

    expect(result.pages).toBe(2);
    expect(mocks.pullSharedPostSync).toHaveBeenNthCalledWith(1, {
      since: ONE_MINUTE_EARLIER,
      sinceId: null,
    });
    expect(mocks.pullSharedPostSync).toHaveBeenNthCalledWith(2, pageOne);
  });

  it("keeps asking from the server's cursor when the window itself spans more than one page", async () => {
    // Review probe (#3449). Page 1 asks from T-60s; when the window holds more
    // than a page the server's next cursor is INSIDE it — earlier than the
    // stored position — and the never-backwards guard rightly refuses to
    // PERSIST it. Requesting page 2 from the guarded value would re-ask from
    // the stored position and step over the rest of the window, every pass:
    // the original defect re-created one page in. The request position is the
    // server's cursor verbatim; only the durable write is guarded.
    storedPosition();
    const insideWindow = { since: "2026-06-30T00:59:20.000Z", sinceId: "srv-Y" };
    mocks.pullSharedPostSync
      .mockResolvedValueOnce({ changes: [], cursor: insideWindow, hasMore: true })
      .mockResolvedValueOnce(
        envelope([], { since: "2026-06-30T01:00:00.000Z", sinceId: "srv-1" }),
      );

    await runMirrorSync(NOW);

    expect(mocks.pullSharedPostSync).toHaveBeenNthCalledWith(2, insideWindow);
    // Persisted: never the inside-window cursor, only the stored pair and then
    // the server's final answer.
    expect(cursorWrites()).toEqual([
      { commsCursorSince: STORED.since, commsCursorSinceId: STORED.sinceId },
      { commsCursorSince: STORED.since, commsCursorSinceId: STORED.sinceId },
    ]);
  });

  it("applies a late-committed post that sits on the second page of the window", async () => {
    storedPosition();
    mocks.pullSharedPostSync
      .mockResolvedValueOnce({
        changes: [],
        cursor: { since: "2026-06-30T00:59:20.000Z", sinceId: "srv-Y" },
        hasMore: true,
      })
      .mockResolvedValueOnce(
        envelope(
          [visiblePost({ id: "srv-late", updatedAt: "2026-06-30T00:59:30.000Z" })],
          { since: "2026-06-30T01:00:00.000Z", sinceId: "srv-1" },
        ),
      );

    const result = await runMirrorSync(NOW);

    expect(result.pages).toBe(2);
    expect(result.upserted).toBe(1);
    expect(mocks.postCreate.mock.calls[0][0].data.serverPostId).toBe("srv-late");
  });

  it("passes an opaque position through untouched and says the overlap is not applied", async () => {
    // The position is contractually the server's own; a token has no minute to
    // step back from. Nothing breaks, the protection is simply absent — and
    // the log line, naming THIS pull, is the only place that shows.
    storedPosition({ since: "tok-100", sinceId: "srv-1" });
    mocks.pullSharedPostSync.mockResolvedValue(
      envelope([], { since: "tok-200", sinceId: "srv-2" }),
    );

    await runMirrorSync(NOW);

    expect(mocks.pullSharedPostSync).toHaveBeenCalledWith({ since: "tok-100", sinceId: "srv-1" });
    expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      { cursor: "tok-100" },
      expect.stringContaining("shared-post mirror"),
    );
    expect(mocks.loggerWarn.mock.calls[0][1]).toContain("NOT being applied");
    // Unorderable on both sides, so the server's answer stands.
    expect(cursorWrites()).toEqual([
      { commsCursorSince: "tok-200", commsCursorSinceId: "srv-2" },
    ]);
  });
});

