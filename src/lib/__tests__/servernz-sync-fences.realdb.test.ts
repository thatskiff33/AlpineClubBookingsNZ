/**
 * PostgreSQL proof of the Central Server connection/claim fences (#4262).
 * Opt in with RUN_CONCURRENCY_RACE_TESTS=1 and the canonical guarded disposable
 * CONCURRENCY_RACE_DATABASE_URL. No provider is called: version discovery is
 * satisfied by the stored expected version. Only the session boundary is doubled.
 * The real encrypted credential writer, snapshot fence, row locks, hide/merge,
 * metadata writer, link route and audit insert all execute against PostgreSQL.
 */
import type { IntegrationCredential, Prisma, ServerNzSettings } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { realElapsedMs } from "./helpers/clock";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { raceSession } from "./support/race-session-double";
import { SERVERNZ_EXPECTED_SERVER_VERSION } from "@/lib/servernz-api-version";

vi.mock("@/lib/auth", async () => (await import("./support/race-session-double")).raceAuthDouble());

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const PREFIX = "race-4262-fence-";
const ACTOR = `${PREFIX}admin`;
const LODGE = `${PREFIX}local`;
const OTHER = `${PREFIX}other`;
const HISTORY = `${PREFIX}history`;
const CENTRAL = `${PREFIX}c1`;
const CENTRAL2 = `${PREFIX}c2`;
const BASE_URL = "https://central-fence.example.invalid";
const BASE_TIME = new Date("2026-07-01T00:00:00.000Z");
const OWNED = [{ id: CENTRAL, name: "Fence one" }, { id: CENTRAL2, name: "Fence two" }];
const AUDIT_TRIGGER = "race_4262_fence_audit_failure";
const COMMIT_TRIGGER = "race_4262_fence_link_commit_failure";

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let fence: typeof import("@/lib/servernz-sync-connection");
let config: typeof import("@/lib/servernz-config");
let settings: typeof import("@/lib/servernz-settings");
let merge: typeof import("@/lib/servernz-other-lodges-merge");
let claim: typeof import("@/lib/servernz-sync-claim");
let credentials: typeof import("@/lib/integration-credentials");
let route: typeof import("@/app/api/admin/lodges/[id]/central-lodge/route");
let PrismaValue: (typeof import("@prisma/client"))["Prisma"];
let originalSettings: ServerNzSettings | null;
let originalCredential: IntegrationCredential | null;
let savedSecret: string | undefined;
let savedSession: typeof raceSession.current;
let fetchGuard: { mockRestore(): void } | undefined;
let role: import("./helpers/environment-role").SuiteEnvironmentRoleDeclaration | undefined;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

(RUN ? describe : describe.skip)("Central Server sync fences — real PostgreSQL (#4262)", { timeout: 20_000 }, () => {
  async function removeAuditFailure() {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${AUDIT_TRIGGER} ON "AuditLog"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${AUDIT_TRIGGER}()`);
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${COMMIT_TRIGGER} ON "Lodge"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${COMMIT_TRIGGER}()`);
  }

  async function clearRows() {
    await prisma.auditLog.deleteMany({ where: { actorMemberId: ACTOR } });
    await prisma.bookingRequest.deleteMany({ where: { id: HISTORY } });
    await prisma.otherLodge.deleteMany({ where: { id: { startsWith: PREFIX } } });
  }

  async function answers() {
    await prisma.serverNzSettings.update({ where: { id: settings.SERVERNZ_SETTINGS_ID }, data: {
      baseUrl: BASE_URL, serverVersion: SERVERNZ_EXPECTED_SERVER_VERSION,
      serverVersionCheckedAt: BASE_TIME, otherLodgesEnabled: true,
      otherLodgesCursor: "fence-before", otherLodgesKeyedAt: BASE_TIME,
      otherLodgesLastDownloadAt: BASE_TIME, otherLodgesSyncStartedAt: null,
      otherLodgesOwnedLodges: OWNED,
    } });
  }

  /** Observe an actual blocked PostgreSQL statement, rather than promise timing. */
  async function waitForLock(fragment: string) {
    const start = process.hrtime.bigint();
    while (realElapsedMs(start) < 5_000) {
      const waiting = await prisma.$queryRaw<{ pid: number }[]>`
        SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND cardinality(pg_blocking_pids(pid)) > 0
          AND position(${fragment} in query) > 0`;
      if (waiting.length > 0) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`INV-LOCK-004: no PostgreSQL lock waiter reached ${fragment}`);
  }

  async function put(centralLodgeId: string | null) {
    return route.PUT(new Request(`http://localhost/api/admin/lodges/${LODGE}/central-lodge`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ centralLodgeId }),
    }), { params: Promise.resolve({ id: LODGE }) });
  }

  async function domainState() {
    return {
      other: await prisma.otherLodge.findUniqueOrThrow({ where: { id: OTHER } }),
      local: await prisma.lodge.findUniqueOrThrow({ where: { id: LODGE }, select: { centralLodgeId: true } }),
      settings: await prisma.serverNzSettings.findUniqueOrThrow({ where: { id: settings.SERVERNZ_SETTINGS_ID } }),
      history: await prisma.bookingRequest.findUniqueOrThrow({ where: { id: HISTORY }, select: { otherLodgeId: true } }),
    };
  }

  beforeAll(async () => {
    const url = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
    assertSafeRaceDbUrl(url, "Central Server sync fences");
    process.env.DATABASE_URL = url;
    savedSecret = process.env.AUTH_SECRET;
    savedSession = raceSession.current;
    process.env.AUTH_SECRET = "race-4262-fence-auth-secret-0123456789abcdefghijklmnop";
    fetchGuard = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No HTTP provider is permitted in the fence proof"));
    role = (await import("./helpers/environment-role")).declareEnvironmentRoleForSuite("non-production");
    ({ prisma } = await import("@/lib/prisma"));
    ({ Prisma: PrismaValue } = await import("@prisma/client"));
    fence = await import("@/lib/servernz-sync-connection");
    config = await import("@/lib/servernz-config");
    settings = await import("@/lib/servernz-settings");
    merge = await import("@/lib/servernz-other-lodges-merge");
    claim = await import("@/lib/servernz-sync-claim");
    credentials = await import("@/lib/integration-credentials");
    route = await import("@/app/api/admin/lodges/[id]/central-lodge/route");
    originalSettings = await prisma.serverNzSettings.findUnique({ where: { id: settings.SERVERNZ_SETTINGS_ID } });
    originalCredential = await prisma.integrationCredential.findUnique({ where: { provider_key: {
      provider: config.SERVERNZ_PROVIDER, key: config.SERVERNZ_CREDENTIAL_KEYS.apiKey,
    } } });
    await prisma.member.create({ data: {
      id: ACTOR, email: `${ACTOR}@example.invalid`, passwordHash: "not-a-password",
      firstName: "Fence", lastName: "Admin", role: "ADMIN", canLogin: true,
      accessRoles: { create: { role: "ADMIN" } },
    } });
    await prisma.lodge.create({ data: { id: LODGE, slug: LODGE, name: "Fence local lodge" } });
    raceSession.current = { user: { id: ACTOR, role: "ADMIN", accessRoles: ["ADMIN"], canLogin: true, twoFactorVerified: true } };
  });

  beforeEach(async () => {
    await clearRows();
    await config.setServerNzApiKey("fence-key-A", { kind: "admin", memberId: ACTOR });
    await answers();
    await prisma.lodge.update({ where: { id: LODGE }, data: { centralLodgeId: CENTRAL } });
    await prisma.otherLodge.create({ data: {
      id: OTHER, name: "Fence old name", centralId: CENTRAL, location: "Old location", updatedAt: BASE_TIME,
    } });
    await prisma.bookingRequest.create({ data: {
      id: HISTORY, contactFirstName: "Historic", contactLastName: "Reference",
      contactEmail: "fence-history@example.invalid", guests: [],
      checkIn: new Date("2026-06-01T00:00:00.000Z"), checkOut: new Date("2026-06-02T00:00:00.000Z"),
      otherLodgeId: OTHER, lodgeId: LODGE,
    } });
  });

  afterEach(async () => {
    await removeAuditFailure();
    expect(fetchGuard).not.toHaveBeenCalled();
  });

  afterAll(async () => {
    try {
      if (prisma) {
        await removeAuditFailure();
        await clearRows();
        await prisma.lodge.deleteMany({ where: { id: LODGE } });
        await prisma.memberAccessRole.deleteMany({ where: { memberId: ACTOR } });
        await prisma.member.deleteMany({ where: { id: ACTOR } });
        // Restore only the singleton and credential this suite borrowed, preserving
        // all other suites' settings, credentials and history.
        if (originalSettings !== undefined) {
          if (originalSettings) {
            const { otherLodgesOwnedNames, otherLodgesOwnedLodges, ...rest } = originalSettings;
            await prisma.serverNzSettings.update({ where: { id: rest.id }, data: {
              ...rest, otherLodgesOwnedNames: otherLodgesOwnedNames ?? PrismaValue.DbNull,
              otherLodgesOwnedLodges: otherLodgesOwnedLodges ?? PrismaValue.DbNull,
            } });
          } else await prisma.serverNzSettings.deleteMany({ where: { id: settings.SERVERNZ_SETTINGS_ID } });
        }
        if (originalCredential !== undefined) {
          const where = { provider_key: { provider: config.SERVERNZ_PROVIDER, key: config.SERVERNZ_CREDENTIAL_KEYS.apiKey } };
          if (originalCredential) await prisma.integrationCredential.upsert({ where, create: originalCredential, update: originalCredential });
          else await prisma.integrationCredential.deleteMany({ where: where.provider_key });
          credentials.invalidateProviderCredentialCache(config.SERVERNZ_PROVIDER);
        }
      }
    } finally {
      fetchGuard?.mockRestore();
      raceSession.current = savedSession ?? null;
      if (savedSecret === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = savedSecret;
      role?.restore();
    }
  });

  it.each(["key", "ABA", "base URL", "cursor", "keyed marker"] as const)(
    "refuses stale %s before hide/unlink, merge and metadata writes", async (changed) => {
      const snapshot = await fence.captureServerNzSyncConnection();
      if (changed === "key" || changed === "ABA") {
        await config.setServerNzApiKey("fence-key-B", { kind: "admin", memberId: ACTOR });
        if (changed === "ABA") await config.setServerNzApiKey("fence-key-A", { kind: "admin", memberId: ACTOR });
        // Equal plaintext AND restored timestamps/answers must not disguise a
        // different durable credential version on the frozen clock.
        await answers();
      } else if (changed === "base URL") {
        await config.updateServerNzConnectionSettings({ baseUrl: "https://other-fence.example.invalid", updatedByMemberId: ACTOR });
      } else {
        await prisma.serverNzSettings.update({ where: { id: settings.SERVERNZ_SETTINGS_ID }, data:
          changed === "cursor" ? { otherLodgesCursor: "fence-newer" } : { otherLodgesKeyedAt: new Date(BASE_TIME.getTime() + 1) },
        });
      }
      const before = await domainState();
      const transaction = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => fence.withServerNzSyncTransaction(snapshot, work);
      await expect(transaction((tx) => merge.hideDeletedLodge(CENTRAL, tx))).rejects.toBeInstanceOf(fence.ServerNzSyncSupersededError);
      await expect(merge.mergeDistributedLodge({ id: CENTRAL, name: "Renamed by stale pull", location: "Stale", updatedAt: BASE_TIME.toISOString() }, [], true, null, true, transaction))
        .rejects.toBeInstanceOf(fence.ServerNzSyncSupersededError);
      await expect(transaction((tx) => settings.recordOtherLodgesDownload("fence-stale", [], { keyed: true, db: tx })))
        .rejects.toBeInstanceOf(fence.ServerNzSyncSupersededError);
      await expect(fence.recordServerNzSyncVersion(snapshot, "9.9")).rejects.toBeInstanceOf(fence.ServerNzSyncSupersededError);
      expect(await domainState()).toEqual(before);
    },
  );

  it("records current-snapshot download metadata through the real fenced writer", async () => {
    await prisma.serverNzSettings.update({ where: { id: settings.SERVERNZ_SETTINGS_ID }, data: { otherLodgesKeyedAt: null } });
    const snapshot = await fence.captureServerNzSyncConnection();
    await fence.withServerNzSyncTransaction(snapshot, (tx) =>
      settings.recordOtherLodgesDownload("fence-after", [], { keyed: true, db: tx }),
    );
    expect((await domainState()).settings).toMatchObject({
      otherLodgesCursor: "fence-after", otherLodgesOwnedLodges: [],
      otherLodgesKeyedAt: BASE_TIME, otherLodgesLastDownloadAt: BASE_TIME,
    });
  });

  it("reaps a stale claim and prevents its old pass writing or releasing its successor", async () => {
    const captured = deferred();
    const releaseOld = deferred();
    let snapshot!: Awaited<ReturnType<typeof fence.captureServerNzSyncConnection>>;
    const oldPass = claim.withOtherLodgesSyncClaim(async () => {
      snapshot = await fence.captureServerNzSyncConnection();
      captured.resolve();
      await releaseOld.promise;
    }, BASE_TIME);
    await captured.promise;
    const successorHeld = deferred();
    const releaseSuccessor = deferred();
    const successorTime = new Date(BASE_TIME.getTime() + 16 * 60_000);
    const successor = claim.withOtherLodgesSyncClaim(async () => {
      successorHeld.resolve();
      await releaseSuccessor.promise;
    }, successorTime);
    try {
      await successorHeld.promise;
      const before = await domainState();
      await expect(fence.withServerNzSyncTransaction(snapshot, (tx) => merge.hideDeletedLodge(CENTRAL, tx)))
        .rejects.toBeInstanceOf(fence.ServerNzSyncSupersededError);
      expect(await domainState()).toEqual(before);
      expect(await claim.withOtherLodgesSyncClaim(async () => "must not run", successorTime)).toBeNull();
      releaseOld.resolve();
      await oldPass;
      expect((await prisma.serverNzSettings.findUniqueOrThrow({ where: { id: settings.SERVERNZ_SETTINGS_ID } })).otherLodgesSyncStartedAt).toEqual(successorTime);
    } finally {
      releaseOld.resolve(); releaseSuccessor.resolve();
      await Promise.allSettled([oldPass, successor]);
    }
    expect((await prisma.serverNzSettings.findUniqueOrThrow({ where: { id: settings.SERVERNZ_SETTINGS_ID } })).otherLodgesSyncStartedAt).toBeNull();
  });

  it("holds the real Settings row through a hide, so durable credential replacement waits for commit", async () => {
    const snapshot = await fence.captureServerNzSyncConnection();
    const hidden = deferred();
    const release = deferred();
    const mutation = fence.withServerNzSyncTransaction(snapshot, async (tx) => {
      const result = await merge.hideDeletedLodge(CENTRAL, tx);
      hidden.resolve();
      await release.promise;
      return result;
    });
    await hidden.promise;
    const replacing = config.setServerNzApiKey("fence-key-B", { kind: "admin", memberId: ACTOR });
    try {
      await waitForLock('"ServerNzSettings"');
      // The uncommitted hide/unlink is still invisible to another connection.
      expect((await domainState()).other.hiddenAt).toBeNull();
      expect((await domainState()).local.centralLodgeId).toBe(CENTRAL);
    } finally { release.resolve(); }
    expect(await mutation).toEqual({ hidden: "Fence old name", unlinked: 1 });
    await replacing;
    const after = await domainState();
    expect(after.other.hiddenAt).toEqual(BASE_TIME);
    expect(after.local.centralLodgeId).toBeNull();
    expect(after.history.otherLodgeId).toBe(OTHER);
    await expect(fence.withServerNzSyncTransaction(snapshot, (tx) => merge.hideDeletedLodge(CENTRAL, tx)))
      .rejects.toBeInstanceOf(fence.ServerNzSyncSupersededError);
  });

  it("preserves both ambiguous name histories and never reuses a hidden historical row", async () => {
    await prisma.otherLodge.create({ data: { id: `${PREFIX}duplicate`, name: "Fence old name", location: "Different history" } });
    const snapshot = await fence.captureServerNzSyncConnection();
    const transaction = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => fence.withServerNzSyncTransaction(snapshot, work);
    const before = await domainState();
    expect(await merge.mergeDistributedLodge({ id: "", name: "Fence old name", location: "Ambiguous", updatedAt: BASE_TIME.toISOString() }, [], true, null, true, transaction))
      .toMatchObject({ kind: "conflict" });
    expect(await domainState()).toEqual(before);
    await transaction((tx) => merge.hideDeletedLodge(CENTRAL, tx));
    expect(await merge.mergeDistributedLodge({ id: CENTRAL2, name: "Fence old name", location: "Successor", updatedAt: BASE_TIME.toISOString() }, [], true, null, true, transaction))
      .toMatchObject({ kind: "updated" });
    const after = await domainState();
    expect(after.other).toMatchObject({ centralId: CENTRAL, hiddenAt: BASE_TIME, location: "Old location" });
    expect(after.history.otherLodgeId).toBe(OTHER);
    expect(await prisma.otherLodge.findUniqueOrThrow({ where: { centralId: CENTRAL2 } })).toMatchObject({ id: `${PREFIX}duplicate`, location: "Successor" });
  });

  it("serializes actual link PUTs and audits null -> c1 -> c2 committed predecessors", async () => {
    await prisma.lodge.update({ where: { id: LODGE }, data: { centralLodgeId: null } });
    const held = deferred();
    const release = deferred();
    const blocker = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM "Lodge" WHERE "id" = ${LODGE} FOR UPDATE`;
      held.resolve();
      await release.promise;
    }, { timeout: 10_000 });
    await held.promise;
    const first = put(CENTRAL);
    let second: ReturnType<typeof put> | undefined;
    try {
      await waitForLock('FROM "Lodge"');
      second = put(CENTRAL2);
      await waitForLock('"ServerNzSettings"');
    } finally { release.resolve(); }
    await blocker;
    expect((await first).status).toBe(200);
    expect((await second!).status).toBe(200);
    const audits = await prisma.auditLog.findMany({ where: { action: "LODGE_CENTRAL_LINK_UPDATED", entityId: LODGE } });
    expect(audits).toHaveLength(2);
    expect(audits.map((row) => row.metadata)).toEqual(expect.arrayContaining([
      { before: { centralLodgeId: null }, after: { centralLodgeId: CENTRAL } },
      { before: { centralLodgeId: CENTRAL }, after: { centralLodgeId: CENTRAL2 } },
    ]));
    expect((await domainState()).local.centralLodgeId).toBe(CENTRAL2);
  });

  it("rolls back both link and audit when PostgreSQL rejects the link at commit", async () => {
    const auditWhere = { action: "LODGE_CENTRAL_LINK_UPDATED", entityId: LODGE };
    const beforeLink = (await domainState()).local.centralLodgeId;
    const beforeAudits = await prisma.auditLog.count({ where: auditWhere });
    // Deferred until COMMIT: createAuditLog must already have returned. Requiring
    // its row to be visible also prevents a missing audit call producing a pass.
    // An audit mistakenly written through the main client survives this failure
    // and makes the unchanged-count assertion below fail.
    await prisma.$executeRawUnsafe(`CREATE FUNCTION ${COMMIT_TRIGGER}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW."id" = '${LODGE}' AND NEW."centralLodgeId" = '${CENTRAL2}'
        AND EXISTS (SELECT 1 FROM "AuditLog" WHERE "entityId" = '${LODGE}' AND "action" = 'LODGE_CENTRAL_LINK_UPDATED')
        THEN RAISE EXCEPTION 'race 4262 link commit failure after audit'; END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe(`CREATE CONSTRAINT TRIGGER ${COMMIT_TRIGGER} AFTER UPDATE ON "Lodge"
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${COMMIT_TRIGGER}()`);

    expect((await put(CENTRAL2)).status).toBe(500);
    expect((await domainState()).local.centralLodgeId).toBe(beforeLink);
    expect(await prisma.auditLog.count({ where: auditWhere })).toBe(beforeAudits);
  });

  it("rolls the actual link PUT back when PostgreSQL rejects its audit insert", async () => {
    // A scoped real database failure, not an audit-helper replacement.
    await prisma.$executeRawUnsafe(`CREATE FUNCTION ${AUDIT_TRIGGER}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW."entityId" = '${LODGE}' AND NEW."action" = 'LODGE_CENTRAL_LINK_UPDATED'
        THEN RAISE EXCEPTION 'race 4262 audit failure'; END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER ${AUDIT_TRIGGER} BEFORE INSERT ON "AuditLog"
      FOR EACH ROW EXECUTE FUNCTION ${AUDIT_TRIGGER}()`);
    expect((await put(CENTRAL2)).status).toBe(500);
    expect((await domainState()).local.centralLodgeId).toBe(CENTRAL);
    expect(await prisma.auditLog.count({ where: { action: "LODGE_CENTRAL_LINK_UPDATED", entityId: LODGE } })).toBe(0);
  });
});

(RUN ? describe : describe.skip)("Central Server fence harness cleanup (#4262)", () => {
  it("restores the shared role and session", () => {
    expect(process.env.APP_ENVIRONMENT_ROLE).toBe(role?.before);
    expect(raceSession.current).toEqual(savedSession);
    expect(process.env.AUTH_SECRET).toBe(savedSecret);
  });
});
