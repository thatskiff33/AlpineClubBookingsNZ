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
      (unused, i) => `<a href="https://example.org/${i}">x</a>`,
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
