/**
 * #4436: real request builders and connection writers, forced in both orders.
 * No HTTP leaves this process. The shared race harness imports this suite;
 * ordinary unit runs skip it. Singleton fixtures are owned sequentially with
 * the #4366 suite, and only the guarded disposable race database is accepted.
 *
 * #4262 review: the Other lodges download's writes (hides, unlinks, merges,
 * the record step) are fenced on the connection its pull was sent on. The last
 * two cases replace the key while the pull is in flight and prove that its
 * deletions and renames change nothing; the control proves the same answer
 * applies when the connection stands. They own `race-4262-` rows.
 *
 * #4470: the three leftovers of an address move. A key save that names the
 * address its page showed, racing a move in both orders; a download whose
 * ADDRESS moves while its pull is out; and the old server's push secret, both
 * removed by the move and refused when a registration in flight across the
 * move comes back. They own `race-4470-` values. The fix round adds a
 * message-board mirror page in flight across a move, and a key replacement at
 * the same address rotating the push secret.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
// The seeded and answered server version is whatever THIS build expects, so the
// suite proves the connection race on any API version the lane is built for.
import { SERVERNZ_EXPECTED_SERVER_VERSION } from "@/lib/servernz-api-version";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const OLD_URL = "https://old.race-4436.example.invalid";
const NEW_URL = "https://new.race-4436.example.invalid";
const OLD_KEY = "race-4436-old-key";
const ACTOR_ID = "race-4436-admin";
let prisma: (typeof import("@/lib/prisma"))["prisma"];
let settings: typeof import("@/lib/servernz-settings");
let config: typeof import("@/lib/servernz-config");
let api: typeof import("@/lib/servernz-api");
let lodgeSync: typeof import("@/lib/servernz-other-lodges-sync");
let observer: PrismaClient;
const savedAuthSecret = process.env.AUTH_SECRET;
// #4470: the push-registration cases load `club-post-mirror`, whose image
// storage loads `sharp`, and loading it sets `VIPSHOME` (#4107 env guard).
const savedVipsHome = process.env.VIPSHOME;
const fetchMock = vi.fn();

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

(RUN ? describe : describe.skip)("central-server address move versus sync — real PostgreSQL (#4436)", { timeout: 60_000 }, () => {
  async function clean() {
    await prisma.auditLog.deleteMany({ where: { memberId: ACTOR_ID } });
    await prisma.auditLog.deleteMany({ where: { action: "alpine_server.other_lodges.hidden", details: { contains: "race-4262" } } });
    await prisma.lodge.deleteMany({ where: { id: { startsWith: "race-4262-" } } });
    await prisma.clubPost.deleteMany({ where: { serverPostId: { startsWith: "race-4470-" } } });
    await prisma.otherLodge.deleteMany({ where: { id: { startsWith: "race-4262-" } } });
    await prisma.integrationCredential.deleteMany({ where: { provider: "servernz", key: { in: ["api_key", "push_secret"] } } });
    await prisma.serverNzSettings.deleteMany({ where: { id: "default" } });
  }

  /**
   * Waits until a competing statement queues on the settings row. Given
   * `unlessSettled`, also returns once that promise settles, so a mutation that
   * removes the fence fails on the test's assertion rather than this timeout.
   */
  async function waitForBlockedConnection(unlessSettled?: Promise<unknown>) {
    let settled = false;
    void unlessSettled?.then(() => { settled = true; }, () => { settled = true; });
    const start = process.hrtime.bigint();
    while (true) {
      if (settled) return;
      // An observation, not a row-lock read; there is no Prisma model for this view.
      // Only this suite's settings-row statements count, not any waiter in the database.
      const rows = await observer.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock' AND query ILIKE '%"ServerNzSettings"%'
      `;
      if ((rows[0]?.count ?? 0) > 0) return;
      if (realElapsedMs(start) > 10_000) throw new Error("The competing connection never queued on the settings fence.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * The settings route's own write (`saveServerNzConnectionSettings`), not a
   * copy of it. `pause` holds the transaction open after the address write and
   * before the key removal, the window #4436 closed.
   */
  async function moveAddress(pause?: ReturnType<typeof latch>, entered?: ReturnType<typeof latch>) {
    const originalUpdate = settings.updateServerNzSettings;
    const update = vi.spyOn(settings, "updateServerNzSettings").mockImplementationOnce(async (input, db) => {
      const value = await originalUpdate(input, db);
      entered?.release();
      if (pause) await pause.promise;
      return value;
    });
    try {
      return await config.saveServerNzConnectionSettings({ baseUrl: NEW_URL }, { kind: "admin", memberId: ACTOR_ID });
    } finally {
      update.mockRestore();
    }
  }

  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Central-server connection");
    process.env.DATABASE_URL = RACE_DB_URL;
    process.env.AUTH_SECRET = "race4436Only_8be1c649fd2a704e95c03d7fa86210bd";
    ({ prisma } = await import("@/lib/prisma"));
    settings = await import("@/lib/servernz-settings");
    config = await import("@/lib/servernz-config");
    api = await import("@/lib/servernz-api");
    lodgeSync = await import("@/lib/servernz-other-lodges-sync");
    const [{ PrismaClient: Client }, { createPrismaPgAdapter }] = await Promise.all([
      import("@prisma/client"), import("@/lib/prisma-adapter"),
    ]);
    observer = new Client({ adapter: createPrismaPgAdapter(RACE_DB_URL) });
    await observer.$connect();
  });

  beforeEach(async () => {
    await clean();
    const { encryptCredential, INTEGRATION_CREDENTIAL_LABEL } = await import("@/lib/integration-crypto");
    await prisma.serverNzSettings.create({ data: {
      id: "default", baseUrl: OLD_URL, serverVersion: SERVERNZ_EXPECTED_SERVER_VERSION, otherLodgesOwnedNames: ["Old lodge"],
    } });
    await prisma.integrationCredential.create({ data: {
      provider: "servernz", key: "api_key",
      ...encryptCredential({ provider: "servernz", key: "api_key", plaintext: OLD_KEY, label: INTEGRATION_CREDENTIAL_LABEL }),
    } });
    const { resetIntegrationCredentialCacheForTests, resolveIntegrationCredential } = await import("@/lib/integration-credentials");
    resetIntegrationCredentialCacheForTests();
    // Warm the old process-local cache: a fenced read must bypass it.
    expect(await resolveIntegrationCredential("servernz", "api_key")).toMatchObject({ value: OLD_KEY });
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ lodges: [], cursor: null, count: 0 })));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterAll(async () => {
    try {
      if (prisma) await clean();
      await observer?.$disconnect();
    } finally {
      if (savedAuthSecret === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = savedAuthSecret;
      if (savedVipsHome === undefined) delete process.env.VIPSHOME;
      else process.env.VIPSHOME = savedVipsHome;
      vi.unstubAllGlobals();
    }
  });

  it("finishes an old-connection sync before allowing the address and key to move", async () => {
    const readAddress = latch();
    const resumeReader = latch();
    const originalLoad = settings.loadServerNzSettings;
    const read = vi.spyOn(settings, "loadServerNzSettings").mockImplementationOnce(async (db) => {
      const value = await originalLoad(db);
      readAddress.release();
      await resumeReader.promise;
      return value;
    });
    const sync = api.pullOtherLodges();
    let move: Promise<unknown> | undefined;
    try {
      await Promise.race([readAddress.promise, sync.then(() => { throw new Error("Sync escaped the read barrier."); })]);
      move = moveAddress();
      await waitForBlockedConnection();
      resumeReader.release();
      await sync;
      await move;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe(`${OLD_URL}/api/v1/other-lodges`);
      expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${OLD_KEY}`);
      await expect(api.pullOtherLodges()).rejects.toBeInstanceOf(api.ServerNzNotConfiguredError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      resumeReader.release();
      read.mockRestore();
      await Promise.allSettled([sync, move]);
    }
  });

  it("never sends a key saved after an address move to the old address", async () => {
    // The admin's two saves in order: move the address, then enter the new
    // server's key. A sync that read the OLD address before either must not
    // then pick up the NEW key: the reader holds the settings row until it has
    // read both, so the move (and the key save behind it) waits.
    const NEW_KEY = "race-4436-new-key";
    fetchMock.mockImplementation(async (url: string | URL) => new Response(JSON.stringify(
      String(url).endsWith("/api/v1/version") ? { version: SERVERNZ_EXPECTED_SERVER_VERSION, match: true } : { lodges: [], cursor: null, count: 0 },
    )));
    const readAddress = latch();
    const resumeReader = latch();
    const originalLoad = settings.loadServerNzSettings;
    const read = vi.spyOn(settings, "loadServerNzSettings").mockImplementationOnce(async (db) => {
      const value = await originalLoad(db);
      readAddress.release();
      await resumeReader.promise;
      return value;
    });
    const sync = api.pullOtherLodges();
    let replace: Promise<unknown> | undefined;
    try {
      await Promise.race([readAddress.promise, sync.then(() => { throw new Error("Sync escaped the read barrier."); })]);
      // The admin's page now shows the new address, so its key save names it.
      replace = moveAddress().then(() => config.setServerNzApiKey(NEW_KEY, NEW_URL, { kind: "admin", memberId: ACTOR_ID }));
      await waitForBlockedConnection(replace);
      resumeReader.release();
      await sync;
      await replace;
      // The next sync takes the new connection whole.
      await api.pullOtherLodges();
      const sent = fetchMock.mock.calls.map(([url, init]) => ({
        url: String(url), authorization: new Headers(init.headers).get("Authorization"),
      }));
      expect(sent.filter(({ authorization }) => authorization === `Bearer ${NEW_KEY}`)
        .every(({ url }) => url.startsWith(`${NEW_URL}/`))).toBe(true);
      expect(sent.filter(({ url }) => url.startsWith(`${OLD_URL}/`))).toEqual([
        { url: `${OLD_URL}/api/v1/other-lodges`, authorization: `Bearer ${OLD_KEY}` },
      ]);
      expect(sent.some(({ url, authorization }) =>
        url.startsWith(`${NEW_URL}/api/v1/other-lodges`) && authorization === `Bearer ${NEW_KEY}`)).toBe(true);
    } finally {
      resumeReader.release();
      read.mockRestore();
      await Promise.allSettled([sync, replace]);
    }
  });

  it("rejects a sync with no connection, whichever order it runs against initial setup", async () => {
    await prisma.serverNzSettings.delete({ where: { id: "default" } });
    const [move, sync] = await Promise.allSettled([moveAddress(), api.pullOtherLodges()]);
    expect(move.status).toBe("fulfilled");
    expect(sync.status).toBe("rejected");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("an Other lodges download whose connection is replaced in flight (#4262 review)", () => {
    const STAMP = "2026-07-01T00:00:00.000Z";
    const PULL = {
      lodges: [{ id: "race-4262-c-2", name: "race-4262 Renamed", updatedAt: STAMP }],
      cursor: "race-4262-cursor",
      count: 1,
      ownLodges: [],
      deletedLodges: [{ id: "race-4262-c-gone", deletedAt: STAMP }],
    };

    async function seedRegistry() {
      await prisma.serverNzSettings.update({
        where: { id: "default" },
        data: { otherLodgesEnabled: true, otherLodgesKeyedAt: new Date(STAMP), otherLodgesOwnedLodges: [] },
      });
      await prisma.otherLodge.createMany({ data: [
        { id: "race-4262-gone", name: "race-4262 Gone", centralId: "race-4262-c-gone" },
        { id: "race-4262-two", name: "race-4262 Old", centralId: "race-4262-c-2" },
      ] });
      await prisma.lodge.create({ data: {
        id: "race-4262-lodge", name: "race-4262 Club Lodge", slug: "race-4262-club-lodge", centralLodgeId: "race-4262-c-gone",
      } });
    }

    async function state() {
      const [gone, two, lodge, stored, audits] = await Promise.all([
        prisma.otherLodge.findUnique({ where: { id: "race-4262-gone" }, select: { hiddenAt: true } }),
        prisma.otherLodge.findUnique({ where: { id: "race-4262-two" }, select: { name: true } }),
        prisma.lodge.findUnique({ where: { id: "race-4262-lodge" }, select: { centralLodgeId: true } }),
        prisma.serverNzSettings.findUnique({ where: { id: "default" }, select: { otherLodgesCursor: true } }),
        prisma.auditLog.count({ where: { action: "alpine_server.other_lodges.hidden", details: { contains: "race-4262" } } }),
      ]);
      return {
        goneHidden: gone?.hiddenAt != null,
        twoName: two?.name,
        link: lodge?.centralLodgeId ?? null,
        cursor: stored?.otherLodgesCursor ?? null,
        audits,
      };
    }

    it("hides, unlinks, renames and records NOTHING once the key is replaced while the pull is in flight", async () => {
      await seedRegistry();
      fetchMock.mockImplementation(async () => {
        // The administrator's key replacement commits while the request is out.
        await config.setServerNzApiKey("race-4262-new-key", OLD_URL, { kind: "admin", memberId: ACTOR_ID });
        return new Response(JSON.stringify(PULL));
      });

      const result = await lodgeSync.downloadOtherClubsFromServer();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await state()).toEqual({
        goneHidden: false, twoName: "race-4262 Old", link: "race-4262-c-gone", cursor: null, audits: 0,
      });
      expect(result).toMatchObject({ hiddenLodges: [], updated: 0, renamed: 0 });
    });

    it("records NOTHING over the reset when the ADDRESS moves while the pull is in flight (#4470)", async () => {
      await seedRegistry();
      fetchMock.mockImplementation(async (url: string | URL) => {
        expect(String(url).startsWith(`${OLD_URL}/`)).toBe(true);
        // The administrator's address move commits while the request is out.
        await moveAddress();
        return new Response(JSON.stringify(PULL));
      });

      const result = await lodgeSync.downloadOtherClubsFromServer();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await state()).toEqual({
        goneHidden: false, twoName: "race-4262 Old", link: "race-4262-c-gone", cursor: null, audits: 0,
      });
      // The move's reset stands: no old owned list, keyed marker or download time.
      expect(await prisma.serverNzSettings.findUnique({ where: { id: "default" } })).toMatchObject({
        baseUrl: NEW_URL, otherLodgesOwnedLodges: null, otherLodgesKeyedAt: null, otherLodgesLastDownloadAt: null,
      });
      expect(result).toMatchObject({ stopped: "connection-changed", hiddenLodges: [], updated: 0, renamed: 0 });
    });

    it("applies the same answer when the connection stands (the control)", async () => {
      await seedRegistry();
      fetchMock.mockImplementation(async () => new Response(JSON.stringify(PULL)));

      const result = await lodgeSync.downloadOtherClubsFromServer();

      expect(await state()).toEqual({
        goneHidden: true, twoName: "race-4262 Renamed", link: null, cursor: "race-4262-cursor", audits: 1,
      });
      expect(result).toMatchObject({ hiddenLodges: ["race-4262 Gone"], renamed: 1 });
    });
  });

  describe("a key save names the address its page showed (#4470)", () => {
    const PAGE_KEY = "race-4470-key-from-old-server";

    async function storedKey() {
      const { readIntegrationCredentialRow } = await import("@/lib/integration-credentials");
      const row = await readIntegrationCredentialRow(prisma, "servernz", "api_key");
      return row.status === "configured" ? row.value : null;
    }

    it("refuses a key for the old address when the move commits first, and stores nothing", async () => {
      const changedAddress = latch();
      const resumeMove = latch();
      const move = moveAddress(resumeMove, changedAddress);
      let save: Promise<unknown> | undefined;
      try {
        await Promise.race([changedAddress.promise, move.then(() => { throw new Error("Move escaped the write barrier."); })]);
        // The page loaded before the move and still shows the old address.
        save = config.setServerNzApiKey(PAGE_KEY, OLD_URL, { kind: "admin", memberId: ACTOR_ID });
        const outcome = save.then(() => ({ error: null }), (error: unknown) => ({ error }));
        await waitForBlockedConnection(save);
        resumeMove.release();
        await move;
        expect((await outcome).error).toBeInstanceOf(config.ServerNzAddressChangedError);
        expect(await storedKey()).toBeNull();
        expect(await prisma.serverNzSettings.findUnique({ where: { id: "default" } })).toMatchObject({ baseUrl: NEW_URL });
        // The refused save wrote no credential audit row either.
        const { CREDENTIAL_AUDIT_ACTIONS } = await import("@/lib/integration-credential-actor");
        const setRows = () => prisma.auditLog.count({ where: { memberId: ACTOR_ID, action: CREDENTIAL_AUDIT_ACTIONS.set } });
        expect(await setRows()).toBe(0);
        // A page reloaded on the new address saves its key (and its audit row).
        await config.setServerNzApiKey("race-4470-new-server-key", NEW_URL, { kind: "admin", memberId: ACTOR_ID });
        expect(await storedKey()).toBe("race-4470-new-server-key");
        expect(await setRows()).toBe(1);
      } finally {
        resumeMove.release();
        await Promise.allSettled([move, save]);
      }
    });

    it("lets a key saved first for the old address be removed by the move queued behind it", async () => {
      const saving = latch();
      const resumeSave = latch();
      const originalForget = settings.forgetServerConnectionAnswers;
      const forget = vi.spyOn(settings, "forgetServerConnectionAnswers").mockImplementationOnce(async (db) => {
        await originalForget(db);
        saving.release();
        await resumeSave.promise;
      });
      const save = config.setServerNzApiKey(PAGE_KEY, OLD_URL, { kind: "admin", memberId: ACTOR_ID });
      let move: Promise<unknown> | undefined;
      try {
        await Promise.race([saving.promise, save.then(() => { throw new Error("Save escaped the write barrier."); })]);
        move = moveAddress();
        await waitForBlockedConnection(move);
        resumeSave.release();
        await save;
        await move;
        // The key went with the address it was saved for.
        expect(await storedKey()).toBeNull();
        expect(await prisma.serverNzSettings.findUnique({ where: { id: "default" } })).toMatchObject({ baseUrl: NEW_URL });
      } finally {
        resumeSave.release();
        forget.mockRestore();
        await Promise.allSettled([save, move]);
      }
    });
  });

  describe("the old server's push secret (#4470)", () => {
    const savedNextAuthUrl = process.env.NEXTAUTH_URL;

    async function storedPushSecret() {
      const { readIntegrationCredentialRow } = await import("@/lib/integration-credentials");
      const row = await readIntegrationCredentialRow(prisma, "servernz", "push_secret");
      return row.status === "configured" ? row.value : null;
    }

    async function seedPushSecret(value: string) {
      const { encryptCredential, INTEGRATION_CREDENTIAL_LABEL } = await import("@/lib/integration-crypto");
      await prisma.integrationCredential.create({ data: {
        provider: "servernz", key: "push_secret",
        ...encryptCredential({ provider: "servernz", key: "push_secret", plaintext: value, label: INTEGRATION_CREDENTIAL_LABEL }),
      } });
    }

    afterAll(() => {
      if (savedNextAuthUrl === undefined) delete process.env.NEXTAUTH_URL;
      else process.env.NEXTAUTH_URL = savedNextAuthUrl;
    });

    it("is removed with the address and key, and every sync position with them", async () => {
      await seedPushSecret("race-4470-old-push-secret");
      await prisma.serverNzSettings.update({ where: { id: "default" }, data: {
        otherLodgesCursor: "race-4470-cursor", commsCursorSince: "2026-06-30T00:00:00.000Z", commsCursorSinceId: "race-4470-post",
      } });
      await moveAddress();
      expect(await storedPushSecret()).toBeNull();
      expect(await prisma.serverNzSettings.findUnique({ where: { id: "default" } })).toMatchObject({
        baseUrl: NEW_URL, otherLodgesCursor: null, commsCursorSince: null, commsCursorSinceId: null,
      });
    });

    it("is not stored from a registration whose address moved while it was out", async () => {
      process.env.NEXTAUTH_URL = "https://club.race-4470.example.invalid";
      const { ensurePushRegistration } = await import("@/lib/club-post-mirror");
      fetchMock.mockImplementation(async (url: string | URL) => {
        expect(String(url)).toBe(`${OLD_URL}/api/v1/push-target`);
        // The administrator moves the address while the PUT is out.
        await moveAddress();
        return new Response(JSON.stringify({ url: "https://club.race-4470.example.invalid/api/webhooks/servernz-posts", secretVersion: 1, secret: "race-4470-old-server-secret-padded-to-32-chars" }));
      });
      await ensurePushRegistration();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await storedPushSecret()).toBeNull();
    });

    it("is removed by a key replacement at the same address too (#4470 review)", async () => {
      await seedPushSecret("race-4470-old-key-push-secret");
      await config.setServerNzApiKey("race-4470-rotated-key", OLD_URL, { kind: "admin", memberId: ACTOR_ID });
      expect(await storedPushSecret()).toBeNull();
      expect(await prisma.serverNzSettings.findUnique({ where: { id: "default" } })).toMatchObject({ baseUrl: OLD_URL });
    });

    it("is stored when the connection stands (the control)", async () => {
      process.env.NEXTAUTH_URL = "https://club.race-4470.example.invalid";
      const { ensurePushRegistration } = await import("@/lib/club-post-mirror");
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({
        url: "https://club.race-4470.example.invalid/api/webhooks/servernz-posts", secretVersion: 1, secret: "race-4470-standing-secret-padded-to-32-chars",
      })));
      await ensurePushRegistration();
      expect(await storedPushSecret()).toBe("race-4470-standing-secret-padded-to-32-chars");
    });
  });

  describe("a message-board mirror page in flight across an address move (#4470 review)", () => {
    const savedNextAuthUrl = process.env.NEXTAUTH_URL;
    const PAGE = {
      changes: [{ state: "visible", post: {
        id: "race-4470-post", club: { id: "race-4470-club", name: "Race Club", code: "RACE4470" },
        authorName: "Race Author", content: "From the old server.", bodyHtml: null, images: [],
        createdAt: "2026-06-30T00:00:00.000Z", updatedAt: "2026-06-30T00:00:00.000Z",
      } }],
      cursor: { since: "2026-06-30T00:00:00.000Z", sinceId: "race-4470-post" },
      hasMore: false,
    };

    beforeEach(() => {
      // Poll-only: no push registration call in these passes.
      delete process.env.NEXTAUTH_URL;
    });
    afterAll(() => {
      if (savedNextAuthUrl === undefined) delete process.env.NEXTAUTH_URL;
      else process.env.NEXTAUTH_URL = savedNextAuthUrl;
    });

    async function mirrorState() {
      const [row, posts] = await Promise.all([
        prisma.serverNzSettings.findUnique({ where: { id: "default" }, select: { commsCursorSince: true, commsCursorSinceId: true, commsLastSyncAt: true, commsSyncStartedAt: true } }),
        prisma.clubPost.count({ where: { serverPostId: { startsWith: "race-4470-" } } }),
      ]);
      return { ...row, posts };
    }

    it("writes no post, cursor or last-sync time once the address moves while the page is out", async () => {
      const { runMirrorSync } = await import("@/lib/club-post-mirror");
      fetchMock.mockImplementation(async (url: string | URL) => {
        // The pass's own version check first, then the page.
        if (String(url).endsWith("/api/v1/version")) {
          return new Response(JSON.stringify({ version: SERVERNZ_EXPECTED_SERVER_VERSION, match: true }));
        }
        // The administrator's address move commits while the page is out.
        await moveAddress();
        return new Response(JSON.stringify(PAGE));
      });

      const result = await runMirrorSync(new Date());

      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
        `${OLD_URL}/api/v1/version`, `${OLD_URL}/api/v1/feed/sync`,
      ]);
      expect(result).toMatchObject({ stopped: "connection-changed", upserted: 0, pages: 1 });
      expect(await mirrorState()).toEqual({
        commsCursorSince: null, commsCursorSinceId: null, commsLastSyncAt: null, commsSyncStartedAt: null, posts: 0,
      });
    });

    it("applies the same page when the connection stands (the control)", async () => {
      const { runMirrorSync } = await import("@/lib/club-post-mirror");
      fetchMock.mockImplementation(async (url: string | URL) => new Response(JSON.stringify(
        String(url).endsWith("/api/v1/version") ? { version: SERVERNZ_EXPECTED_SERVER_VERSION, match: true } : PAGE,
      )));

      const result = await runMirrorSync(new Date());

      expect(result).toMatchObject({ upserted: 1, pages: 1 });
      expect(result.stopped).toBeUndefined();
      expect(await mirrorState()).toMatchObject({
        commsCursorSince: PAGE.cursor.since, commsCursorSinceId: PAGE.cursor.sinceId, commsSyncStartedAt: null, posts: 1,
      });
    });
  });

  it("waits for an address change in flight and sends no old key to the new address", async () => {
    const changedAddress = latch();
    const resumeWriter = latch();
    const move = moveAddress(resumeWriter, changedAddress);
    let sync: Promise<unknown> | undefined;
    try {
      await Promise.race([changedAddress.promise, move.then(() => { throw new Error("Move escaped the write barrier."); })]);
      sync = api.pullOtherLodges();
      // Attach the rejection handler immediately so cleanup cannot leak a rejection.
      const outcome = sync.then(() => ({ error: null }), (error: unknown) => ({ error }));
      await waitForBlockedConnection();
      expect(fetchMock).not.toHaveBeenCalled();
      resumeWriter.release();
      await move;
      expect((await outcome).error).toBeInstanceOf(api.ServerNzNotConfiguredError);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await prisma.integrationCredential.count({ where: { provider: "servernz", key: "api_key" } })).toBe(0);
      expect(await prisma.serverNzSettings.findUnique({ where: { id: "default" } })).toMatchObject({
        baseUrl: NEW_URL, serverVersion: null, otherLodgesOwnedNames: null,
      });
    } finally {
      resumeWriter.release();
      await Promise.allSettled([move, sync]);
    }
  });
});
