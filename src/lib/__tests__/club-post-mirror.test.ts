import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripComments } from "./support/strip-comments";

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
  FakeVersionError: class FakeVersionError extends Error {
    expected = "2.0";
    serverVersion = "2.1";
    constructor() {
      super("paused");
      this.name = "ServerNzVersionMismatchError";
    }
  },
  postFindUnique: vi.fn(),
  postCreate: vi.fn(),
  postUpdate: vi.fn(),
  postDelete: vi.fn(),
  imageDeleteMany: vi.fn(),
  // The post's row lock, taken inside the fence before the re-read (#4586).
  executeRaw: vi.fn(),
  settingsUpsert: vi.fn(),
  settingsUpdateMany: vi.fn(),
  settingsFindUnique: vi.fn(),
  // The settings row as the doubles hold it: the fenced cursor write re-reads
  // it (#4470), so reads see what earlier writes stored.
  row: {} as Record<string, unknown>,
  settingsUpdate: vi.fn(),
  transaction: vi.fn(),
  pullSharedPostSync: vi.fn(),
  fetchSharedPostImage: vi.fn(),
  registerPushTarget: vi.fn(),
  getServerNzSetupState: vi.fn(),
  getIntegrationCredentialValue: vi.fn(),
  setIntegrationCredential: vi.fn(),
  invalidateProviderCredentialCache: vi.fn(),
  answerWriter: vi.fn(),
  answerTx: {} as Record<string, unknown>,
  FakeConnectionChangedError: class FakeConnectionChangedError extends Error {
    constructor() {
      super("connection changed");
      this.name = "ServerNzConnectionChangedError";
    }
  },
  writePostImage: vi.fn(),
  deletePostImage: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  checkServerVersion: vi.fn(),
}));

// #49: the version check runs before the comms claim. Matching by default so
// every existing pass is unchanged; the pause test below flips it.
vi.mock("@/lib/servernz-version-check", () => ({
  checkServerVersion: mocks.checkServerVersion,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: Object.assign(mocks.answerTx, {
    clubPost: {
      findUnique: mocks.postFindUnique,
      create: mocks.postCreate,
      update: mocks.postUpdate,
      delete: mocks.postDelete,
    },
    clubPostImage: { deleteMany: mocks.imageDeleteMany },
    $executeRaw: mocks.executeRaw,
    serverNzSettings: {
      upsert: mocks.settingsUpsert,
      updateMany: mocks.settingsUpdateMany,
      findUnique: mocks.settingsFindUnique,
      update: mocks.settingsUpdate,
    },
    $transaction: mocks.transaction,
  }),
}));

vi.mock("@/lib/servernz-api", () => ({
  ServerNzVersionMismatchError: mocks.FakeVersionError,
  pullSharedPostSync: mocks.pullSharedPostSync,
  fetchSharedPostImage: mocks.fetchSharedPostImage,
  registerPushTarget: mocks.registerPushTarget,
}));

vi.mock("@/lib/servernz-config", () => ({
  getServerNzSetupState: mocks.getServerNzSetupState,
  SERVERNZ_PROVIDER: "servernz",
  SERVERNZ_CREDENTIAL_KEYS: { apiKey: "api_key", pushSecret: "push_secret" },
}));

vi.mock("@/lib/integration-credentials", () => ({
  getIntegrationCredentialValue: mocks.getIntegrationCredentialValue,
  invalidateProviderCredentialCache: mocks.invalidateProviderCredentialCache,
  setIntegrationCredentialInTransaction: mocks.setIntegrationCredential,
}));

// #4470: the push secret is stored through the answer fence for the identity
// the registration was sent on. The double records that identity and runs the
// write on a stand-in fenced client; a refusal is staged per test.
vi.mock("@/lib/servernz-version-record", () => ({
  ServerNzConnectionChangedError: mocks.FakeConnectionChangedError,
  serverNzAnswerWriter: (identity: unknown) => async (work: (tx: unknown) => Promise<unknown>) =>
    mocks.answerWriter(identity, work),
}));

vi.mock("@/lib/post-image-storage", () => ({
  writePostImage: mocks.writePostImage,
  deletePostImage: mocks.deletePostImage,
}));

import { STALE_SYNC_CLAIM_MS, runMirrorSync } from "@/lib/club-post-mirror";
import { ensurePushRegistration } from "@/lib/servernz-push-registration";

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
  mocks.checkServerVersion.mockResolvedValue({
    status: "match",
    serverVersion: "2.0",
    expected: "2.0",
    checkedAt: NOW.toISOString(),
    couldNotCheck: false,
  });
  mocks.getIntegrationCredentialValue.mockResolvedValue("stored-secret");
  mocks.settingsUpsert.mockResolvedValue({});
  mocks.row = { commsCursorSince: null, commsCursorSinceId: null };
  // The claim (an OR on the stamp, matched here) and its release (#4586: only
  // while the row holds the stamp this pass wrote) on the same row double.
  mocks.settingsUpdateMany.mockImplementation(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    if ("commsSyncStartedAt" in where && String(where.commsSyncStartedAt) !== String(mocks.row.commsSyncStartedAt)) return { count: 0 };
    Object.assign(mocks.row, data);
    return { count: 1 };
  });
  mocks.executeRaw.mockResolvedValue(1);
  mocks.settingsFindUnique.mockImplementation(async () => ({ ...mocks.row }));
  mocks.settingsUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    Object.assign(mocks.row, data);
    return {};
  });
  mocks.postFindUnique.mockResolvedValue(null);
  mocks.postCreate.mockResolvedValue({});
  mocks.transaction.mockResolvedValue([]);
  mocks.imageDeleteMany.mockResolvedValue({ count: 0 });
  mocks.postUpdate.mockResolvedValue({});
  // The fenced writes run on the mocked client's own delegates, so every
  // row assertion below reads the same doubles whichever client wrote.
  mocks.answerWriter.mockImplementation(async (_identity: unknown, work: (tx: unknown) => Promise<unknown>) =>
    work(mocks.answerTx));
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

  it("skips BEFORE taking the claim, registering a push target or pulling, while the server version differs (#49)", async () => {
    mocks.checkServerVersion.mockResolvedValue({
      status: "mismatch",
      serverVersion: "2.1",
      expected: "2.0",
      checkedAt: NOW.toISOString(),
      couldNotCheck: false,
    });
    mocks.getIntegrationCredentialValue.mockResolvedValue(null); // would register

    const result = await runMirrorSync(NOW);

    expect(result).toEqual({ skipped: "server-version-mismatch", upserted: 0, unchanged: 0, removed: 0, pages: 0 });
    // No claim taken (and therefore none to release), nothing sent or pulled.
    expect(mocks.settingsUpdateMany).not.toHaveBeenCalled();
    expect(mocks.settingsUpdate).not.toHaveBeenCalled();
    expect(mocks.registerPushTarget).not.toHaveBeenCalled();
    expect(mocks.pullSharedPostSync).not.toHaveBeenCalled();
    expect(mocks.fetchSharedPostImage).not.toHaveBeenCalled();
  });

  it("reports PAUSED, not failed, and releases the claim when the server refuses mid-pass for version (#49 review)", async () => {
    // The pre-check passed (a matching stored answer) and the server's own 409
    // arrived on the pull - recorded by the API client, which throws the
    // version error.
    mocks.pullSharedPostSync.mockRejectedValue(new mocks.FakeVersionError());

    const result = await runMirrorSync(NOW);

    expect(result.skipped).toBe("server-version-mismatch");
    // Released: the next matching pass must not find the claim held.
    expect(mocks.settingsUpdateMany).toHaveBeenLastCalledWith({
      where: { id: "default", commsSyncStartedAt: NOW },
      data: { commsSyncStartedAt: null },
    });
    expect(mocks.row.commsSyncStartedAt).toBeNull();
  });

  it("pauses on a version refusal from an image fetch without counting the change as poison", async () => {
    mocks.pullSharedPostSync.mockResolvedValue(
      envelope([visiblePost({ images: [{ url: `https://central.test/api/images/posts/${SERVER_IMAGE}`, width: 1, height: 1 }] })]),
    );
    mocks.fetchSharedPostImage.mockRejectedValue(new mocks.FakeVersionError());

    const result = await runMirrorSync(NOW);

    expect(result.skipped).toBe("server-version-mismatch");
    expect(result.upserted).toBe(0);
    const poisonWrites = mocks.settingsUpdate.mock.calls.filter(
      ([args]) => args.data.commsPoisonChangeId !== undefined,
    );
    expect(poisonWrites).toHaveLength(0);
  });

  it("lets a version refusal on push registration pause the pass rather than hiding it as a registration warning", async () => {
    mocks.getIntegrationCredentialValue.mockResolvedValue(null);
    process.env.NEXTAUTH_URL = "https://club.example.nz";
    mocks.registerPushTarget.mockRejectedValue(new mocks.FakeVersionError());
    try {
      const result = await runMirrorSync(NOW);
      expect(result.skipped).toBe("server-version-mismatch");
      expect(mocks.pullSharedPostSync).not.toHaveBeenCalled();
      expect(mocks.loggerWarn).not.toHaveBeenCalled();
    } finally {
      delete process.env.NEXTAUTH_URL;
    }
  });

  it("runs the version check after the key check and before the claim (#49)", async () => {
    const order: string[] = [];
    mocks.checkServerVersion.mockImplementation(async () => {
      order.push("version");
      return { status: "match", serverVersion: "2.0", expected: "2.0", checkedAt: null, couldNotCheck: false };
    });
    mocks.settingsUpdateMany.mockImplementation(async ({ data }: { data: { commsSyncStartedAt: Date | null } }) => {
      order.push(data.commsSyncStartedAt ? "claim" : "release");
      return { count: 1 };
    });
    mocks.pullSharedPostSync.mockResolvedValue(envelope([]));
    await runMirrorSync(NOW);
    expect(order).toEqual(["version", "claim", "release"]);
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
    // The update path's image replacement is its fenced write (#4470).
    expect(mocks.imageDeleteMany).not.toHaveBeenCalled();
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

    const release = mocks.settingsUpdateMany.mock.calls.find(
      ([args]) => args.data.commsSyncStartedAt === null,
    );
    expect(release).toBeDefined();
    expect(mocks.row.commsSyncStartedAt).toBeNull();
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
    Object.assign(mocks.row, {
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
    Object.assign(mocks.row, {
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
    Object.assign(mocks.row, {
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
    // The update path's image replacement is its fenced write (#4470).
    expect(mocks.imageDeleteMany).not.toHaveBeenCalled();
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
    // The update path's image replacement is its fenced write (#4470).
    expect(mocks.imageDeleteMany).not.toHaveBeenCalled();
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
    // The update path's image replacement is its fenced write (#4470).
    expect(mocks.imageDeleteMany).not.toHaveBeenCalled();
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
    // One fenced write replaced the images and the post together (#4470).
    expect(mocks.answerWriter).toHaveBeenCalled();
    expect(mocks.imageDeleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.postUpdate).toHaveBeenCalledTimes(1);
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


describe("ensurePushRegistration stores the secret only for the connection it registered on (#4470)", () => {
  const SENT_ON = { baseUrl: "https://central.test", credentialVersion: "v-1" };

  beforeEach(() => {
    mocks.getIntegrationCredentialValue.mockResolvedValue(null);
    process.env.NEXTAUTH_URL = "https://club.example.nz";
    mocks.registerPushTarget.mockResolvedValue({ secret: "issued-secret", secretVersion: 3, sentOn: SENT_ON });
  });
  afterEach(() => {
    delete process.env.NEXTAUTH_URL;
  });

  it("writes through the answer fence for the registration's identity, then drops the cached copy", async () => {
    await ensurePushRegistration();
    expect(mocks.answerWriter).toHaveBeenCalledWith(SENT_ON, expect.any(Function));
    expect(mocks.setIntegrationCredential).toHaveBeenCalledWith({
      tx: mocks.answerTx,
      provider: "servernz",
      key: "push_secret",
      value: "issued-secret",
      actor: { kind: "system", actor: "servernz-push-registration" },
      expect: { expect: "any" },
    });
    expect(mocks.invalidateProviderCredentialCache).toHaveBeenCalledWith("servernz");
    expect(mocks.answerWriter.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.invalidateProviderCredentialCache.mock.invocationCallOrder[0]);
  });

  it("stores nothing, says why, and lets the pass go on when the connection changed in flight", async () => {
    mocks.answerWriter.mockRejectedValue(new mocks.FakeConnectionChangedError());
    await expect(ensurePushRegistration()).resolves.toBeUndefined();
    expect(mocks.setIntegrationCredential).not.toHaveBeenCalled();
    expect(mocks.invalidateProviderCredentialCache).toHaveBeenCalledWith("servernz");
    expect(mocks.loggerWarn).toHaveBeenCalledWith(expect.stringMatching(/connection changed while this install registered/));
  });

  it("registers nothing while a secret is stored", async () => {
    mocks.getIntegrationCredentialValue.mockResolvedValue("stored-secret");
    await ensurePushRegistration();
    expect(mocks.registerPushTarget).not.toHaveBeenCalled();
    expect(mocks.answerWriter).not.toHaveBeenCalled();
  });
});

describe("runMirrorSync writes each page only for the connection it came from (#4470)", () => {
  const OLD = { baseUrl: "https://old.central.test", credentialVersion: "v-old" };
  const NEW = { baseUrl: "https://old.central.test", credentialVersion: "v-new" };

  function page(changes: unknown[], sentOn: unknown, cursor = { since: "2026-06-30T01:00:00.000Z", sinceId: "srv-1" }, hasMore = false) {
    return { changes, cursor, hasMore, sentOn };
  }

  function refuseFor(identity: unknown) {
    mocks.answerWriter.mockImplementation(async (sentOn: unknown, work: (tx: unknown) => Promise<unknown>) => {
      if (sentOn === identity) throw new mocks.FakeConnectionChangedError();
      return work(mocks.answerTx);
    });
  }

  it("writes the post, the cursor and the last-sync time through the page's own fence", async () => {
    mocks.pullSharedPostSync.mockResolvedValue(page([visiblePost()], OLD));
    const result = await runMirrorSync(NOW);
    expect(result).toMatchObject({ upserted: 1, pages: 1 });
    expect(result.stopped).toBeUndefined();
    // Post, cursor, last-sync: three fenced writes, all for OLD.
    expect(mocks.answerWriter.mock.calls.map(([identity]) => identity)).toEqual([OLD, OLD, OLD]);
    expect(mocks.row).toMatchObject({ commsCursorSince: "2026-06-30T01:00:00.000Z", commsLastSyncAt: NOW });
  });

  it("stops at a replaced connection's first write: no post, cursor, failure count or last-sync, its pictures removed", async () => {
    mocks.pullSharedPostSync.mockResolvedValue(page(
      [visiblePost({ images: [{ url: `https://central.test/api/images/posts/${SERVER_IMAGE}`, width: 1, height: 1 }] })],
      OLD,
    ));
    mocks.fetchSharedPostImage.mockResolvedValue(new Uint8Array([1]));
    mocks.writePostImage.mockResolvedValue({
      publicId: "local-img", storageKey: "k/local-img", mimeType: "image/webp", sha256: "a", width: 1, height: 1, bytes: 1,
    });
    refuseFor(OLD);

    const result = await runMirrorSync(NOW);

    expect(result.stopped).toBe("connection-changed");
    expect(result.upserted).toBe(0);
    expect(mocks.postCreate).not.toHaveBeenCalled();
    expect(mocks.row).toEqual({ commsCursorSince: null, commsCursorSinceId: null, commsSyncStartedAt: null });
    expect(mocks.deletePostImage).toHaveBeenCalledWith("k/local-img");
    expect(mocks.loggerWarn).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/connection changed while the shared-post mirror ran/));
  });

  it("does not count a replaced connection as a poison change", async () => {
    mocks.pullSharedPostSync.mockResolvedValue(page([{ state: "removed", id: "srv-gone" }], OLD));
    mocks.postFindUnique.mockResolvedValue({ id: "local-gone", originClubCode: "RUAPEHU", hiddenAt: null, images: [] });
    refuseFor(OLD);
    const result = await runMirrorSync(NOW);
    expect(result).toMatchObject({ stopped: "connection-changed", removed: 0 });
    expect(mocks.postDelete).not.toHaveBeenCalled();
    expect(mocks.row).not.toHaveProperty("commsPoisonChangeId");
    // Not even attempted: the refused removal is the pass's one fenced write.
    expect(mocks.answerWriter).toHaveBeenCalledTimes(1);
  });

  it("keeps the pages applied before the change and writes nothing from the page after it", async () => {
    const first = { since: "2026-06-30T01:30:00.000Z", sinceId: "srv-5" };
    mocks.pullSharedPostSync
      .mockResolvedValueOnce(page([visiblePost()], NEW, first, true))
      .mockResolvedValueOnce(page([visiblePost({ id: "srv-6" })], OLD, { since: "2026-06-30T02:00:00.000Z", sinceId: "srv-6" }));
    refuseFor(OLD);
    const result = await runMirrorSync(NOW);
    expect(result).toMatchObject({ stopped: "connection-changed", upserted: 1, pages: 2 });
    expect(mocks.postCreate).toHaveBeenCalledTimes(1);
    expect(mocks.row).toMatchObject({ commsCursorSince: first.since, commsCursorSinceId: first.sinceId });
    expect(mocks.row).not.toHaveProperty("commsLastSyncAt");
  });

  it("writes no position over one that moved since the pass read it (a key replaced before the first pull)", async () => {
    mocks.row = { commsCursorSince: "2026-06-30T00:00:00.000Z", commsCursorSinceId: "srv-old" };
    mocks.pullSharedPostSync.mockImplementation(async () => {
      // The replacement's reset commits after the pass read the position, and
      // the page is sent on the NEW key, so the fence itself passes.
      mocks.row.commsCursorSince = null;
      mocks.row.commsCursorSinceId = null;
      return page([], NEW, { since: "2026-06-29T00:00:00.000Z", sinceId: "srv-new" });
    });
    const result = await runMirrorSync(NOW);
    expect(result.stopped).toBe("connection-changed");
    expect(mocks.row).toMatchObject({ commsCursorSince: null, commsCursorSinceId: null });
    expect(mocks.row).not.toHaveProperty("commsLastSyncAt");
  });
});

/**
 * A light census (#4470), the download's own (`servernz-version-record.test.ts`):
 * the mirror reaches the global client only to READ and for its single-flight
 * claim. Every write it makes from a server answer (posts, removals, failure
 * count, cursor, last-sync time) goes through the page's fenced writer, so a
 * future unfenced write on `prisma.` fails here.
 */
describe("the mirror writes answers only through the fence (#4470)", () => {
  it("keeps the database out of the pictures-and-body module split from it (#4588)", () => {
    const source = stripComments(readFileSync(path.join(process.cwd(), "src/lib/club-post-mirror-images.ts"), "utf8"));
    expect(source).not.toMatch(/\bprisma\b|\$transaction|@\/lib\/prisma/);
  });

  it("calls the global client for reads and the claim alone", () => {
    const source = stripComments(readFileSync(path.join(process.cwd(), "src/lib/club-post-mirror.ts"), "utf8"));
    const calls = [...source.matchAll(/\bprisma\.(\$?\w+)(?:\s*\.(\w+))?/g)].map(([, model, method]) => `${model}.${method}`);
    const READS = new Set(["findUnique", "findMany", "findFirst", "count"]);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((call) => !READS.has(call.split(".")[1] ?? "")).sort()).toEqual([
      // The claim's materialise, take and release: no server answer in them.
      "serverNzSettings.updateMany",
      "serverNzSettings.updateMany",
      "serverNzSettings.upsert",
    ]);
    // ...and the second updateMany is the release, of this pass's stamp only
    // (#4586).
    expect(source).toMatch(/prisma\.serverNzSettings\s*\.updateMany\(\{ where: \{ id: "default", commsSyncStartedAt: claimedAt \}, data: \{ commsSyncStartedAt: null \} \}\)/);
  });
});

describe("runMirrorSync's failure count belongs to the position it read (#4470 delta review)", () => {
  const NEW = { baseUrl: "https://central.test", credentialVersion: "v-new" };

  it("does not step over a post on a count a key replacement reset while the pass ran", async () => {
    // Two failures recorded on the OLD key, and no cursor yet either side.
    Object.assign(mocks.row, { commsPoisonChangeId: "srv-1", commsPoisonCount: 2 });
    mocks.pullSharedPostSync.mockImplementation(async () => {
      // The replacement's reset commits after the pass read the row; the page
      // is sent on the NEW key, so the connection fence itself passes.
      Object.assign(mocks.row, { commsPoisonChangeId: null, commsPoisonCount: 0 });
      return { changes: [visiblePost()], cursor: { since: "2026-06-30T01:00:00.000Z", sinceId: "srv-1" }, hasMore: false, sentOn: NEW };
    });
    mocks.postCreate.mockRejectedValueOnce(new Error("value too long"));

    const result = await runMirrorSync(NOW);

    expect(result.stopped).toBe("connection-changed");
    // Not stepped over: the reset count stands, and no cursor moved past it.
    expect(mocks.row).toMatchObject({ commsPoisonChangeId: null, commsPoisonCount: 0, commsCursorSince: null });
    expect(mocks.loggerError).not.toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/Skipping a poison/));
  });

  it("does not count a first failure on the new key onto the old key's count", async () => {
    Object.assign(mocks.row, { commsPoisonChangeId: "srv-1", commsPoisonCount: 1 });
    mocks.pullSharedPostSync.mockImplementation(async () => {
      Object.assign(mocks.row, { commsPoisonChangeId: null, commsPoisonCount: 0 });
      return { changes: [visiblePost()], cursor: null, hasMore: false, sentOn: NEW };
    });
    mocks.postCreate.mockRejectedValueOnce(new Error("value too long"));

    const result = await runMirrorSync(NOW);

    expect(result.stopped).toBe("connection-changed");
    expect(mocks.row).toMatchObject({ commsPoisonChangeId: null, commsPoisonCount: 0 });
  });

  it("removes a post's freshly stored pictures when its write fails for any reason, not only a refusal", async () => {
    mocks.pullSharedPostSync.mockResolvedValue(envelope([
      visiblePost({ images: [{ url: `https://central.test/api/images/posts/${SERVER_IMAGE}`, width: 1, height: 1 }] }),
    ]));
    mocks.fetchSharedPostImage.mockResolvedValue(new Uint8Array([1]));
    mocks.writePostImage.mockResolvedValue({
      publicId: "local-img", storageKey: "k/failed-write", mimeType: "image/webp", sha256: "a", width: 1, height: 1, bytes: 1,
    });
    mocks.postCreate.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(runMirrorSync(NOW)).rejects.toThrow("database unavailable");
    expect(mocks.deletePostImage).toHaveBeenCalledWith("k/failed-write");
  });
});

/**
 * #4586: three concurrency gaps in the mirror. The release clears only the
 * claim this pass wrote; the create-or-update decision, and a tombstone's, is
 * re-read inside the fence under the post's row lock; and that lock is taken
 * before any image row, the order every message-board writer follows.
 */
describe("the mirror's release clears only this pass's own claim (#4586)", () => {
  it("leaves a claim that a second pass took over while this one ran", async () => {
    const takenOverAt = new Date(NOW.getTime() + STALE_SYNC_CLAIM_MS + 1);
    mocks.pullSharedPostSync.mockImplementation(async () => {
      // This pass's claim went stale mid-pass and a second pass took it.
      mocks.row.commsSyncStartedAt = takenOverAt;
      return envelope([]);
    });

    await runMirrorSync(NOW);

    expect(mocks.row.commsSyncStartedAt).toBe(takenOverAt);
  });

  it("releases with the exact stamp its claim wrote", async () => {
    mocks.pullSharedPostSync.mockResolvedValue(envelope([]));

    await runMirrorSync(NOW);

    const [claim, release] = mocks.settingsUpdateMany.mock.calls.map(([args]) => args);
    expect(claim.data.commsSyncStartedAt).toEqual(NOW);
    expect(release).toEqual({ where: { id: "default", commsSyncStartedAt: claim.data.commsSyncStartedAt }, data: { commsSyncStartedAt: null } });
    expect(mocks.row.commsSyncStartedAt).toBeNull();
  });
});

describe("the mirror decides under the post's row lock, post before images (#4586)", () => {
  const MIRRORED = {
    id: "local-2", originClubCode: "RUAPEHU", originClubName: "Ruapehu Alpine Club",
    content: "An older version of the words.", bodyHtml: null,
    images: [{ storageKey: "posts/2026/06/old.webp", sha256: "0".repeat(64) }],
  };

  function recordOrder() {
    const order: string[] = [];
    mocks.answerWriter.mockImplementation(async (_identity: unknown, work: (tx: unknown) => Promise<unknown>) => {
      order.push("fence");
      return work(mocks.answerTx);
    });
    mocks.executeRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      order.push(`lock ${strings.join("?")} [${values.join(",")}]`);
      return 1;
    });
    mocks.postFindUnique.mockImplementation(async () => {
      order.push("read");
      return MIRRORED;
    });
    mocks.imageDeleteMany.mockImplementation(async () => {
      order.push("images");
      return { count: 1 };
    });
    mocks.postUpdate.mockImplementation(async () => {
      order.push("post");
      return {};
    });
    mocks.postDelete.mockImplementation(async () => {
      order.push("delete");
      return {};
    });
    return order;
  }

  const LOCK = 'lock SELECT 1 FROM "ClubPost" WHERE "serverPostId" = ? FOR UPDATE [srv-1]';

  it("locks the post inside the fence, then re-reads it, before any image row", async () => {
    const order = recordOrder();
    mocks.pullSharedPostSync.mockResolvedValue(envelope([visiblePost()]));

    const result = await runMirrorSync(NOW);

    expect(result.upserted).toBe(1);
    // The first read only skips our own posts' downloads; the decision is
    // the second, under the lock.
    expect(order.slice(0, 6)).toEqual(["read", "fence", LOCK, "read", "images", "post"]);
    expect(mocks.deletePostImage).toHaveBeenCalledWith("posts/2026/06/old.webp");
  });

  it("updates, not creates, a row mirrored between the first read and the fence", async () => {
    mocks.pullSharedPostSync.mockResolvedValue(envelope([visiblePost()]));
    mocks.postFindUnique.mockResolvedValueOnce(null).mockResolvedValue(MIRRORED);

    const result = await runMirrorSync(NOW);

    expect(result.upserted).toBe(1);
    expect(mocks.postCreate).not.toHaveBeenCalled();
    expect(mocks.postUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "local-2" } }));
  });

  it("writes nothing, and drops its fresh pictures, when the row became this club's own post under the lock", async () => {
    mocks.pullSharedPostSync.mockResolvedValue(envelope([
      visiblePost({ images: [{ url: `https://central.test/api/images/posts/${SERVER_IMAGE}`, width: 1, height: 1 }] }),
    ]));
    mocks.fetchSharedPostImage.mockResolvedValue(new Uint8Array([1]));
    mocks.writePostImage.mockResolvedValue({
      publicId: "local-img", storageKey: "k/fresh", mimeType: "image/webp", sha256: "a", width: 1, height: 1, bytes: 1,
    });
    // Our share was stamped with this server id after the first read.
    mocks.postFindUnique.mockResolvedValueOnce(null).mockResolvedValue({ ...MIRRORED, originClubCode: null });

    const result = await runMirrorSync(NOW);

    expect(result.upserted).toBe(0);
    expect(mocks.postCreate).not.toHaveBeenCalled();
    expect(mocks.postUpdate).not.toHaveBeenCalled();
    expect(mocks.imageDeleteMany).not.toHaveBeenCalled();
    expect(mocks.deletePostImage).toHaveBeenCalledWith("k/fresh");
  });

  it("applies a tombstone from a read under the lock, deleting the post with its images by cascade", async () => {
    const order = recordOrder();
    mocks.pullSharedPostSync.mockResolvedValue(envelope([{ state: "removed", id: "srv-1", reason: "removed" }]));

    const result = await runMirrorSync(NOW);

    expect(result.removed).toBe(1);
    expect(order.slice(0, 4)).toEqual(["fence", LOCK, "read", "delete"]);
    expect(mocks.imageDeleteMany).not.toHaveBeenCalled();
    expect(mocks.deletePostImage).toHaveBeenCalledWith("posts/2026/06/old.webp");
  });

  it("reads a lock that matched nothing as not found, never as a row read unlocked", async () => {
    // A share stamping this id on our own post after the lock ran: the read
    // would see that row with no lock held on it.
    mocks.pullSharedPostSync.mockResolvedValue(envelope([visiblePost()]));
    mocks.postFindUnique.mockResolvedValueOnce(null).mockResolvedValue(MIRRORED);
    mocks.executeRaw.mockResolvedValue(0);

    const result = await runMirrorSync(NOW);

    expect(result.upserted).toBe(1);
    expect(mocks.postFindUnique).toHaveBeenCalledTimes(1);
    expect(mocks.postUpdate).not.toHaveBeenCalled();
    // Created: the unique serverPostId refuses it if a row took the id meanwhile.
    expect(mocks.postCreate).toHaveBeenCalledTimes(1);
  });

  it("counts no removal, and deletes no file, when the locked read finds no row", async () => {
    mocks.pullSharedPostSync.mockResolvedValue(envelope([{ state: "removed", id: "srv-1", reason: "removed" }]));

    const result = await runMirrorSync(NOW);

    expect(result.removed).toBe(0);
    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    expect(mocks.postDelete).not.toHaveBeenCalled();
    expect(mocks.deletePostImage).not.toHaveBeenCalled();
  });
});

/**
 * #4588: a mirror this club's admin removed never gets its words back, and a
 * pass whose claim was taken over writes nothing after the takeover.
 */
describe("a removed mirror stays removed (#4588)", () => {
  const REMOVED = {
    id: "local-3", originClubCode: "RUAPEHU", originClubName: "Ruapehu Alpine Club",
    content: "", bodyHtml: null, removedAt: new Date("2026-06-30T12:00:00.000Z"), hiddenAt: null, images: [],
  };
  const WITH_PICTURE = () => visiblePost({
    content: "Edited at the origin club.",
    images: [{ url: `https://central.test/api/images/posts/${SERVER_IMAGE}`, width: 1, height: 1 }],
  });

  beforeEach(() => {
    mocks.fetchSharedPostImage.mockResolvedValue(new Uint8Array([1]));
    mocks.writePostImage.mockResolvedValue({
      publicId: "local-img", storageKey: "k/fresh", mimeType: "image/webp", sha256: "a", width: 1, height: 1, bytes: 1,
    });
  });

  it("downloads nothing and writes nothing for a re-delivery the first read sees removed", async () => {
    mocks.pullSharedPostSync.mockResolvedValue(envelope([WITH_PICTURE()]));
    mocks.postFindUnique.mockResolvedValue(REMOVED);

    const result = await runMirrorSync(NOW);

    expect(result).toMatchObject({ upserted: 0, unchanged: 0 });
    expect(mocks.fetchSharedPostImage).not.toHaveBeenCalled();
    expect(mocks.postUpdate).not.toHaveBeenCalled();
    expect(mocks.imageDeleteMany).not.toHaveBeenCalled();
  });

  it("writes no words or pictures back, and drops its fresh files, when the post was removed before the lock", async () => {
    mocks.pullSharedPostSync.mockResolvedValue(envelope([WITH_PICTURE()]));
    // Not yet removed when first read; removed by the time the lock is held.
    mocks.postFindUnique.mockResolvedValueOnce({ ...REMOVED, removedAt: null }).mockResolvedValue(REMOVED);

    const result = await runMirrorSync(NOW);

    expect(result).toMatchObject({ upserted: 0, unchanged: 0 });
    expect(mocks.postUpdate).not.toHaveBeenCalled();
    expect(mocks.postCreate).not.toHaveBeenCalled();
    expect(mocks.imageDeleteMany).not.toHaveBeenCalled();
    expect(mocks.deletePostImage).toHaveBeenCalledWith("k/fresh");
  });

  it("keeps a removed mirror's blank row on a tombstone, so a later restore cannot bring it back", async () => {
    mocks.pullSharedPostSync.mockResolvedValue(envelope([{ state: "removed", id: "srv-1", reason: "hidden" }]));
    mocks.postFindUnique.mockResolvedValue(REMOVED);

    const result = await runMirrorSync(NOW);

    expect(result.removed).toBe(0);
    expect(mocks.postDelete).not.toHaveBeenCalled();
    expect(mocks.postUpdate).not.toHaveBeenCalled();
  });
});

describe("a pass whose claim was taken over writes nothing after the takeover (#4588)", () => {
  const TAKEN_OVER_AT = new Date(NOW.getTime() + STALE_SYNC_CLAIM_MS + 1);

  it("stops at its first write, with its own label, and leaves the new holder's claim", async () => {
    mocks.pullSharedPostSync.mockImplementation(async () => {
      mocks.row.commsSyncStartedAt = TAKEN_OVER_AT;
      return envelope([visiblePost()]);
    });

    const result = await runMirrorSync(NOW);

    expect(result).toMatchObject({ stopped: "claim-taken-over", upserted: 0 });
    expect(mocks.postCreate).not.toHaveBeenCalled();
    expect(mocks.row).toMatchObject({ commsCursorSince: null, commsSyncStartedAt: TAKEN_OVER_AT });
    expect(mocks.row.commsLastSyncAt).toBeUndefined();
    // Not counted against the change as a failure.
    expect(mocks.row.commsPoisonChangeId).toBeUndefined();
  });

  it("refuses a tombstone and a position write too, keeping the pages applied before the takeover", async () => {
    mocks.pullSharedPostSync
      .mockResolvedValueOnce({ ...envelope([visiblePost()]), hasMore: true })
      .mockImplementationOnce(async () => {
        mocks.row.commsSyncStartedAt = TAKEN_OVER_AT;
        return envelope([{ state: "removed", id: "srv-1", reason: "removed" }], { since: "2026-06-30T02:00:00.000Z", sinceId: "srv-2" });
      });
    mocks.postFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue({
      id: "local-9", originClubCode: "RUAPEHU", hiddenAt: null, removedAt: null, images: [],
    });

    const result = await runMirrorSync(NOW);

    expect(result).toMatchObject({ stopped: "claim-taken-over", upserted: 1, removed: 0, pages: 2 });
    expect(mocks.postCreate).toHaveBeenCalledTimes(1);
    expect(mocks.postDelete).not.toHaveBeenCalled();
    expect(mocks.row).toMatchObject({ commsCursorSince: "2026-06-30T01:00:00.000Z", commsSyncStartedAt: TAKEN_OVER_AT });
  });
});
