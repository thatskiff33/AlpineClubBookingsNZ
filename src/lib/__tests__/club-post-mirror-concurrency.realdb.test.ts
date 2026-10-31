/**
 * #4586: the message-board mirror's concurrency gaps, on real PostgreSQL.
 *
 * 1. A pass whose single-flight claim went stale and was taken over releases
 *    nothing on its way out: the second pass's claim stands until it ends.
 * 2. A mirror tombstone and an admin removal of the same post, each held after
 *    its first lock while the other queues, in both orders. Both writers take
 *    the post row before its image rows, so neither deadlocks and the end state
 *    is consistent: no image rows, every named file deleted once the rows are
 *    gone, and the post row gone, or (since #4588) kept blank and removed when
 *    the admin's removal committed first. Taking the images first (the admin's
 *    old order) deadlocks in both orders here.
 *
 * Real writers only: `runMirrorSync` and `removeClubPost`, with the central
 * server answered by a stubbed `fetch` (no HTTP leaves this process) and the
 * image files' deletion observed rather than performed. The shared race
 * harness imports this suite; ordinary unit runs skip it. It owns `race-4586-`
 * posts and images and, like the other central-server suites, the singleton
 * settings row and its credentials.
 *
 * #4588 adds the board's lifecycle races, owning `race-4588-` rows and putting
 * the board's settings row back as it found it:
 * 3. A pass taken over mid-pass applies nothing after the takeover.
 * 4. A mirror this club removed keeps its blank words when re-delivered.
 * 5. A member's post claiming an old upload while the orphan sweep runs keeps
 *    the image row and its file.
 * 6. A mirror update adding a picture to a post retention is deleting leaves
 *    no file on the mount without a row.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { SERVERNZ_EXPECTED_SERVER_VERSION } from "@/lib/servernz-api-version";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const BASE_URL = "https://central.race-4586.example.invalid";
const SERVER_POST_ID = "race-4586-post";
const STORAGE_KEYS = ["posts/2026/06/race-4586-a.webp", "posts/2026/06/race-4586-b.webp"];
const MEMBER_ID = "race-4588-member";
let savedBoardSettings: { retentionDays: number; cleanupStartedAt: Date | null } | null | undefined;
let retention: typeof import("@/lib/club-post-retention");
let posts: typeof import("@/lib/club-posts");
let prisma: (typeof import("@/lib/prisma"))["prisma"];
let mirror: typeof import("@/lib/club-post-mirror");
let admin: typeof import("@/lib/club-posts-admin");
let storage: typeof import("@/lib/post-image-storage");
let observer: PrismaClient;
const savedAuthSecret = process.env.AUTH_SECRET;
const savedNextAuthUrl = process.env.NEXTAUTH_URL;
// `club-post-mirror` loads the image pipeline, which loads `sharp`, and loading
// it sets `VIPSHOME` (#4107 env guard).
const savedVipsHome = process.env.VIPSHOME;
const fetchMock = vi.fn();

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

type Latch = ReturnType<typeof latch>;

(RUN ? describe : describe.skip)("message-board mirror concurrency — real PostgreSQL (#4586)", { timeout: 60_000 }, () => {
  async function clean() {
    await prisma.clubPostImage.deleteMany({ where: { OR: [
      { publicId: { startsWith: "race-4586-" } }, { storageKey: { startsWith: "race-4588-" } },
    ] } });
    await prisma.clubPost.deleteMany({ where: { OR: [
      { id: { startsWith: "race-4586-" } }, { serverPostId: { startsWith: "race-4586-" } },
      { serverPostId: { startsWith: "race-4588-" } }, { authorMemberId: MEMBER_ID },
    ] } });
    await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    await prisma.integrationCredential.deleteMany({ where: { provider: "servernz", key: { in: ["api_key", "push_secret"] } } });
    await prisma.serverNzSettings.deleteMany({ where: { id: "default" } });
  }

  /** Answers the pass's version check, and each feed request with `page`. */
  function answerFeed(page: (call: number) => Promise<unknown>) {
    let feedCalls = 0;
    fetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url).endsWith("/api/v1/version")) {
        return new Response(JSON.stringify({ version: SERVERNZ_EXPECTED_SERVER_VERSION, match: true }));
      }
      // A post's picture (#4588); its storing is observed, not performed.
      if (String(url).includes("/api/images/posts/")) return new Response(new Uint8Array([1, 2, 3]));
      feedCalls += 1;
      return new Response(JSON.stringify(await page(feedCalls)));
    });
  }

  const EMPTY_PAGE = { changes: [], cursor: null, hasMore: false };
  const TOMBSTONE_PAGE = { changes: [{ state: "removed", id: SERVER_POST_ID, reason: "removed" }], cursor: null, hasMore: false };

  /**
   * Waits until a competing statement queues on a `ClubPost` row lock. Given
   * `unlessSettled`, also returns once that promise settles, so a mutation that
   * removes the wait fails on the test's assertion rather than this timeout.
   */
  async function waitForBlockedPostWriter(unlessSettled?: Promise<unknown>) {
    let settled = false;
    void unlessSettled?.then(() => { settled = true; }, () => { settled = true; });
    const start = process.hrtime.bigint();
    while (true) {
      if (settled) return;
      // An observation, not a row-lock read; there is no Prisma model for this view.
      const rows = await observer.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock' AND query ILIKE '%"ClubPost"%'
      `;
      if ((rows[0]?.count ?? 0) > 0) return;
      if (realElapsedMs(start) > 10_000) throw new Error("The competing writer never queued on the post row.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * Holds a real interactive transaction open after the first statement that
   * `matches`, so a competing writer can queue on what it has locked. Every
   * transaction the writers open runs through the real client unchanged; only
   * the first match pauses. Restore with the returned spy.
   */
  function holdAfterFirst(matches: (model: string, method: string, args: unknown[]) => boolean, held: Latch, resume: Latch) {
    const original = prisma.$transaction.bind(prisma) as (arg: unknown, options?: unknown) => Promise<unknown>;
    let fired = false;
    const after = async (model: string, method: string, args: unknown[], result: unknown) => {
      if (!fired && matches(model, method, args)) {
        fired = true;
        held.release();
        await resume.promise;
      }
      return result;
    };
    const wrap = (tx: object) => new Proxy(tx, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop);
        if (typeof prop !== "string") return value;
        if (typeof value === "function") {
          return async (...args: unknown[]) => after("$", prop, args, await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args));
        }
        if (value && typeof value === "object" && !prop.startsWith("$")) {
          return new Proxy(value, {
            get(model, method) {
              const fn: unknown = Reflect.get(model, method);
              if (typeof fn !== "function" || typeof method !== "string") return fn;
              return async (...args: unknown[]) => after(prop, method, args, await (fn as (...a: unknown[]) => Promise<unknown>).apply(model, args));
            },
          });
        }
        return value;
      },
    });
    return vi.spyOn(prisma, "$transaction").mockImplementation(((arg: unknown, options?: unknown) =>
      typeof arg === "function"
        ? original((tx: object) => (arg as (tx: object) => Promise<unknown>)(wrap(tx)), options)
        : original(arg, options)) as never);
  }

  async function seedMirroredPost() {
    await prisma.clubPost.create({ data: {
      id: "race-4586-row", serverPostId: SERVER_POST_ID, originClubCode: "RACE4586", originClubName: "Race Club",
      authorName: "Race Author", content: "Mirrored words.", postedAt: new Date("2026-06-30T00:00:00.000Z"),
      images: { create: STORAGE_KEYS.map((storageKey, position) => ({
        storageKey, publicId: `race-4586-img-${position}`, mimeType: "image/webp", sha256: String(position).repeat(64),
        width: 1, height: 1, bytes: 1, position,
      })) },
    } });
  }

  async function postState() {
    const [posts, images] = await Promise.all([
      prisma.clubPost.count({ where: { id: "race-4586-row" } }),
      prisma.clubPostImage.count({ where: { publicId: { startsWith: "race-4586-" } } }),
    ]);
    return { posts, images };
  }

  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Message-board mirror");
    process.env.DATABASE_URL = RACE_DB_URL;
    process.env.AUTH_SECRET = "race4586Only_3f0c2b9e7d61a4c8b5e2f9a1d7c3e604";
    ({ prisma } = await import("@/lib/prisma"));
    mirror = await import("@/lib/club-post-mirror");
    admin = await import("@/lib/club-posts-admin");
    storage = await import("@/lib/post-image-storage");
    retention = await import("@/lib/club-post-retention");
    posts = await import("@/lib/club-posts");
    savedBoardSettings = await prisma.clubPostSettings.findUnique({
      where: { id: "default" }, select: { retentionDays: true, cleanupStartedAt: true },
    });
    const [{ PrismaClient: Client }, { createPrismaPgAdapter }] = await Promise.all([
      import("@prisma/client"), import("@/lib/prisma-adapter"),
    ]);
    observer = new Client({ adapter: createPrismaPgAdapter(RACE_DB_URL) });
    await observer.$connect();
  });

  beforeEach(async () => {
    await clean();
    // Poll-only: no push registration call in these passes.
    delete process.env.NEXTAUTH_URL;
    const { encryptCredential, INTEGRATION_CREDENTIAL_LABEL } = await import("@/lib/integration-crypto");
    await prisma.serverNzSettings.create({ data: { id: "default", baseUrl: BASE_URL, serverVersion: SERVERNZ_EXPECTED_SERVER_VERSION } });
    await prisma.integrationCredential.create({ data: {
      provider: "servernz", key: "api_key",
      ...encryptCredential({ provider: "servernz", key: "api_key", plaintext: "race-4586-key", label: INTEGRATION_CREDENTIAL_LABEL }),
    } });
    const { resetIntegrationCredentialCacheForTests } = await import("@/lib/integration-credentials");
    resetIntegrationCredentialCacheForTests();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterAll(async () => {
    try {
      if (prisma) {
        await clean();
        // The board's settings row, as this suite found it.
        if (savedBoardSettings === null) await prisma.clubPostSettings.deleteMany({ where: { id: "default" } });
        else if (savedBoardSettings) await prisma.clubPostSettings.update({ where: { id: "default" }, data: savedBoardSettings });
      }
      await observer?.$disconnect();
    } finally {
      if (savedAuthSecret === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = savedAuthSecret;
      if (savedNextAuthUrl === undefined) delete process.env.NEXTAUTH_URL;
      else process.env.NEXTAUTH_URL = savedNextAuthUrl;
      if (savedVipsHome === undefined) delete process.env.VIPSHOME;
      else process.env.VIPSHOME = savedVipsHome;
      vi.unstubAllGlobals();
    }
  });

  it("leaves a claim that a second pass took over when the stale pass ends", async () => {
    const first = new Date("2026-07-01T00:00:00.000Z");
    const second = new Date(first.getTime() + mirror.STALE_SYNC_CLAIM_MS + 1_000);
    const secondInFeed = latch();
    const finishSecond = latch();
    let secondPass: Promise<unknown> | undefined;
    answerFeed(async (call) => {
      if (call === 1) {
        // The first pass is out on its page long enough for its claim to go
        // stale; a second pass takes the claim and is out on its own page.
        secondPass = mirror.runMirrorSync(second);
        await secondInFeed.promise;
      } else {
        secondInFeed.release();
        await finishSecond.promise;
      }
      return EMPTY_PAGE;
    });

    try {
      await mirror.runMirrorSync(first);
      // The first pass has ended; the second still holds its own claim.
      expect((await prisma.serverNzSettings.findUnique({ where: { id: "default" } }))?.commsSyncStartedAt).toEqual(second);
      // So a third pass is busy rather than running beside the second.
      expect(await mirror.runMirrorSync(new Date(second.getTime() + 1_000))).toMatchObject({ skipped: "busy" });
    } finally {
      finishSecond.release();
      await secondPass;
    }
    // And the second releases its own on the way out.
    expect((await prisma.serverNzSettings.findUnique({ where: { id: "default" } }))?.commsSyncStartedAt).toBeNull();
  });

  it("removes the post's words and pictures once, without deadlock, when an admin removal holds the post and a tombstone queues", async () => {
    await seedMirroredPost();
    const deleted = vi.spyOn(storage, "deletePostImage").mockResolvedValue(undefined);
    answerFeed(async () => TOMBSTONE_PAGE);
    const held = latch();
    const resume = latch();
    // The admin's first statement: its post claim (an image delete in the
    // old order).
    const spy = holdAfterFirst((model) => model === "clubPost" || model === "clubPostImage", held, resume);
    const removal = admin.removeClubPost("race-4586-row");
    const removalOutcome = removal.then(() => ({ error: null }), (error: unknown) => ({ error }));
    let pass: Promise<unknown> | undefined;
    try {
      await Promise.race([held.promise, removal.then(() => { throw new Error("The removal escaped its hold."); })]);
      spy.mockRestore();
      pass = mirror.runMirrorSync(new Date("2026-07-01T00:00:00.000Z"));
      const passOutcome = pass.then((result) => ({ result, error: null }), (error: unknown) => ({ result: null, error }));
      await waitForBlockedPostWriter(pass);
      resume.release();

      expect(await removalOutcome).toEqual({ error: null });
      const { result, error } = await passOutcome;
      expect(error).toBeNull();
      // The tombstone found the admin's removal under its lock and kept the
      // blank row (#4588): it is what keeps a later restore from bringing the
      // post back.
      expect(result).toMatchObject({ removed: 0 });
      expect(await postState()).toEqual({ posts: 1, images: 0 });
      expect(await prisma.clubPost.findUnique({ where: { id: "race-4586-row" }, select: { content: true, removedAt: true } }))
        .toEqual({ content: "", removedAt: expect.any(Date) });
      expect(deleted.mock.calls.map(([key]) => key).sort()).toEqual(STORAGE_KEYS);
    } finally {
      resume.release();
      await Promise.allSettled([removal, pass]);
      spy.mockRestore();
      deleted.mockRestore();
    }
  });

  it("removes the post once, without deadlock, when a tombstone holds the post and an admin removal queues", async () => {
    await seedMirroredPost();
    const deleted = vi.spyOn(storage, "deletePostImage").mockResolvedValue(undefined);
    answerFeed(async () => TOMBSTONE_PAGE);
    const held = latch();
    const resume = latch();
    // The tombstone's post lock, taken inside the page's fence.
    const spy = holdAfterFirst(
      (model, method, args) => model === "$" && method === "$executeRaw" && String(args[0]).includes('"ClubPost"'),
      held, resume,
    );
    const pass = mirror.runMirrorSync(new Date("2026-07-01T00:00:00.000Z"));
    const passOutcome = pass.then((result) => ({ result, error: null }), (error: unknown) => ({ result: null, error }));
    let removal: Promise<unknown> | undefined;
    try {
      await Promise.race([held.promise, pass.then(() => { throw new Error("The tombstone escaped its hold."); })]);
      spy.mockRestore();
      removal = admin.removeClubPost("race-4586-row");
      const removalOutcome = removal.then(() => ({ error: null }), (error: unknown) => ({ error }));
      await waitForBlockedPostWriter(removal);
      resume.release();

      const { result, error } = await passOutcome;
      expect(error).toBeNull();
      expect(result).toMatchObject({ removed: 1 });
      // The tombstone deleted the post first, so the removal finds nothing.
      expect((await removalOutcome).error).toBeInstanceOf(admin.ClubPostNotFoundError);
      expect(await postState()).toEqual({ posts: 0, images: 0 });
      expect(deleted.mock.calls.map(([key]) => key).sort()).toEqual(STORAGE_KEYS);
    } finally {
      resume.release();
      await Promise.allSettled([pass, removal]);
      spy.mockRestore();
      deleted.mockRestore();
    }
  });
  /** Waits until `count` statements queue on a lock over `table`'s rows. */
  async function waitForBlocked(table: string, count: number, unlessSettled?: Promise<unknown>) {
    let settled = false;
    void unlessSettled?.then(() => { settled = true; }, () => { settled = true; });
    const start = process.hrtime.bigint();
    const pattern = `%"${table}"%`;
    while (true) {
      if (settled) return;
      // An observation, not a row-lock read; there is no Prisma model for this view.
      const rows = await observer.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock' AND query ILIKE ${pattern}
      `;
      if ((rows[0]?.count ?? 0) >= count) return;
      if (realElapsedMs(start) > 10_000) throw new Error(`Fewer than ${count} writer(s) queued on ${table}.`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  function visibleChange(id: string, content: string, imageIds: string[] = []) {
    return { state: "visible", post: {
      id, club: { id: "race-4588-club", name: "Race Club", code: "RACE4588" }, authorName: "Race Author", content,
      bodyHtml: null, images: imageIds.map((image) => ({ url: `${BASE_URL}/api/images/posts/${image}.webp` })),
      createdAt: "2024-06-30T00:00:00.000Z", updatedAt: "2026-06-30T00:00:00.000Z",
    } };
  }

  /** The image pipeline, observed: every stored file gets a fresh key and no disk write. */
  function observeStoredImages() {
    let n = 0;
    return vi.spyOn(storage, "writePostImage").mockImplementation(async () => {
      n += 1;
      const hex = n.toString(16).padStart(32, "a");
      return { publicId: hex, storageKey: `race-4588-stored-${n}.webp`, mimeType: "image/webp", sha256: hex.repeat(2), width: 1, height: 1, bytes: 3 };
    });
  }

  it("applies nothing from an old pass after a second pass took its claim (#4588)", async () => {
    const first = new Date("2026-07-01T00:00:00.000Z");
    const second = new Date(first.getTime() + mirror.STALE_SYNC_CLAIM_MS + 1_000);
    const secondInFeed = latch();
    const finishSecond = latch();
    let secondPass: Promise<unknown> | undefined;
    answerFeed(async (call) => {
      if (call === 1) {
        secondPass = mirror.runMirrorSync(second);
        await secondInFeed.promise;
        // The old pass's page: a post the newer pass knows nothing of.
        return { changes: [visibleChange("race-4588-late", "An older version.")], cursor: { since: "2026-06-30T00:00:00.000Z", sinceId: "race-4588-late" }, hasMore: false };
      }
      secondInFeed.release();
      await finishSecond.promise;
      return EMPTY_PAGE;
    });

    try {
      const result = await mirror.runMirrorSync(first);
      expect(result).toMatchObject({ stopped: "claim-taken-over", upserted: 0 });
      expect(await prisma.clubPost.count({ where: { serverPostId: "race-4588-late" } })).toBe(0);
      expect(await prisma.serverNzSettings.findUnique({ where: { id: "default" } })).toMatchObject({
        commsSyncStartedAt: second, commsCursorSince: null, commsLastSyncAt: null,
      });
    } finally {
      finishSecond.release();
      await secondPass;
    }
  });

  it("writes no words back to a mirror this club removed when it is delivered again (#4588)", async () => {
    await prisma.clubPost.create({ data: {
      serverPostId: "race-4588-removed", originClubCode: "RACE4588", originClubName: "Race Club", authorName: "Race Author",
      content: "", removedAt: new Date("2026-06-30T12:00:00.000Z"), postedAt: new Date("2026-06-30T00:00:00.000Z"),
    } });
    const stored = observeStoredImages();
    answerFeed(async () => ({ changes: [visibleChange("race-4588-removed", "Edited at the origin.", ["b".repeat(32)])], cursor: null, hasMore: false }));
    try {
      await mirror.runMirrorSync(new Date("2026-07-01T00:00:00.000Z"));
      expect(await prisma.clubPost.findUnique({ where: { serverPostId: "race-4588-removed" }, select: { content: true, bodyHtml: true, _count: { select: { images: true } } } }))
        .toEqual({ content: "", bodyHtml: null, _count: { images: 0 } });
      // Nothing was downloaded for it.
      expect(stored).not.toHaveBeenCalled();
    } finally {
      stored.mockRestore();
    }
  });

  it("keeps an old upload, row and file, that a new post claims while the orphan sweep deletes (#4588)", async () => {
    await prisma.member.create({ data: {
      id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password",
      firstName: "Race", lastName: "Member", ageTier: "ADULT", canLogin: true,
    } });
    const publicId = "c".repeat(32);
    const image = await prisma.clubPostImage.create({ data: {
      publicId, storageKey: "race-4588-upload.webp", mimeType: "image/webp", sha256: "d".repeat(64), bytes: 3,
      uploadedByMemberId: MEMBER_ID, createdAt: new Date("2026-06-30T00:00:00.000Z"),
    } });
    await prisma.clubPostSettings.upsert({ where: { id: "default" }, create: { id: "default", retentionDays: 0 }, update: { retentionDays: 0, cleanupStartedAt: null } });
    const deleted = vi.spyOn(storage, "deletePostImage").mockResolvedValue(undefined);
    const releaseRow = latch();
    const rowHeld = latch();
    // A third session holds the upload's row, so both writers queue on it:
    // the claim first, then the sweep's delete.
    const holder = observer.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM "ClubPostImage" WHERE "id" = ${image.id} FOR UPDATE`;
      rowHeld.release();
      await releaseRow.promise;
    }, { timeout: 30_000 });
    let created: Promise<{ id: string }> | undefined;
    let sweep: Promise<unknown> | undefined;
    try {
      await rowHeld.promise;
      created = posts.createClubPost({
        authorMemberId: MEMBER_ID, authorName: "Race Member", content: "With the picture.",
        bodyHtml: `<p>With the picture.</p><img src="/api/club-posts/images/${publicId}" alt="">`,
      });
      await waitForBlocked("ClubPostImage", 1, created);
      sweep = retention.runClubPostCleanup(new Date("2026-07-01T00:00:00.000Z"));
      await waitForBlocked("ClubPostImage", 2, sweep);
      releaseRow.release();
      await holder;
      const post = await created;
      await sweep;

      expect(await prisma.clubPostImage.findUnique({ where: { id: image.id }, select: { postId: true } })).toEqual({ postId: post.id });
      expect(deleted).not.toHaveBeenCalledWith("race-4588-upload.webp");
    } finally {
      releaseRow.release();
      await Promise.allSettled([holder, created, sweep]);
      deleted.mockRestore();
    }
  });

  it("lists every file of a post it expires, even one a mirror update adds mid-pass (#4588)", async () => {
    await prisma.clubPost.create({ data: {
      serverPostId: "race-4588-doomed", originClubCode: "RACE4588", originClubName: "Race Club", authorName: "Race Author",
      content: "Two years old.", postedAt: new Date("2024-06-30T00:00:00.000Z"),
      images: { create: [{ publicId: "e".repeat(32), storageKey: "race-4588-old.webp", mimeType: "image/webp", sha256: "f".repeat(64), bytes: 3, position: 0 }] },
    } });
    await prisma.clubPostSettings.upsert({ where: { id: "default" }, create: { id: "default", retentionDays: 365 }, update: { retentionDays: 365, cleanupStartedAt: null } });
    const stored = observeStoredImages();
    const deleted = vi.spyOn(storage, "deletePostImage").mockResolvedValue(undefined);
    answerFeed(async () => ({ changes: [visibleChange("race-4588-doomed", "Edited, with a new picture.", ["1".repeat(32)])], cursor: null, hasMore: false }));
    const held = latch();
    const resume = latch();
    // The mirror update, held after it locks the post (inside its fence).
    const spy = holdAfterFirst(
      (model, method, args) => model === "$" && method === "$executeRaw" && String(args[0]).includes('"ClubPost"'),
      held, resume,
    );
    const pass = mirror.runMirrorSync(new Date("2026-07-01T00:00:00.000Z"));
    let cleanup: Promise<unknown> | undefined;
    try {
      await Promise.race([held.promise, pass.then(() => { throw new Error("The mirror update escaped its hold."); })]);
      spy.mockRestore();
      // Retention has listed the doomed post; it queues on the post the
      // mirror holds, then the mirror adds its picture and commits.
      cleanup = retention.runClubPostCleanup(new Date("2026-07-01T00:00:00.000Z"));
      await waitForBlockedPostWriter(cleanup);
      resume.release();
      expect(await pass).toMatchObject({ upserted: 1 });
      expect(await cleanup).toMatchObject({ deleted: 1 });

      const storedKeys = (await Promise.all(stored.mock.results.map((r) => r.value as Promise<{ storageKey: string }>))).map((s) => s.storageKey);
      expect(storedKeys).toHaveLength(1);
      expect(await prisma.clubPost.count({ where: { serverPostId: "race-4588-doomed" } })).toBe(0);
      expect(await prisma.clubPostImage.count({ where: { storageKey: { startsWith: "race-4588-" } } })).toBe(0);
      // No row is left, so every file must have been deleted: the old one by
      // the mirror, the new one by retention.
      const deletedKeys = deleted.mock.calls.map(([key]) => key);
      expect(deletedKeys).toEqual(expect.arrayContaining(["race-4588-old.webp", ...storedKeys]));
    } finally {
      resume.release();
      await Promise.allSettled([pass, cleanup]);
      spy.mockRestore();
      stored.mockRestore();
      deleted.mockRestore();
    }
  });
});
