/**
 * Real-PostgreSQL proof of the data-encryption key ring on the credential store
 * (#4456).
 *
 * The unit suites prove the key rules against pure crypto. What only PostgreSQL
 * can prove is that a credential written under a RING key goes through the
 * store's existing compare-and-set (`withCredentialTransaction` + the
 * `expect: version` claim on the `(ciphertext, iv, authTag)` tuple) exactly as a
 * legacy row does — which is the claim the re-encrypt command will join:
 *
 *   1. acceptance: a credential written under a ring key survives an
 *      AUTH_SECRET rotation, read back through the database; a legacy row does
 *      not, and says so as "needs re-entry";
 *   2. re-keying a legacy row is an ordinary version-guarded write: the row
 *      afterwards names the ring key and still reads back the same value;
 *   3. a row that changed underneath a version-guarded write (a token refresh
 *      landing first) makes the write LOSE — no row change, no audit row — and
 *      a retry from a fresh read succeeds under the current key;
 *   4. two writers holding the same version, FORCED to meet at the claim behind
 *      a third connection's row lock, let exactly one through;
 *   5. (PR 2) `data-keys:reencrypt` leaves no credential, authenticator secret
 *      or unused legacy recovery code on an old key, every value still reads
 *      after AUTH_SECRET is rotated, and a later ring key moves them again;
 *   6. (PR 2) a Xero token refresh racing the re-encrypt loses or wins cleanly
 *      and no refresh token is lost: with the lease held the re-encrypt loses
 *      and the refresh saves; forced to queue on the same `XeroToken` row lock,
 *      whichever goes first, the refresh's save still succeeds.
 *
 * OFF by default, like every `*.realdb.test.ts`: it runs only with
 * `RUN_CONCURRENCY_RACE_TESTS=1` against `CONCURRENCY_RACE_DATABASE_URL`
 * (loopback, port 55442+, the `concurrency_race_1881` marker), and hosted CI
 * runs it through the import in `concurrency-lock-races.realdb.test.ts`. It owns
 * and cleans its own `race-4456` credential rows and their audit rows, and puts
 * back every environment variable it changes (#4107).
 *
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/data-encryption-key-ring.realdb.test.ts
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const LABEL = "Data-encryption key ring (#4456)";
const RACE_TEST_TIMEOUT_MS = 20_000;
const BARRIER_TIMEOUT_MS = 3_000;

const PROVIDER = "race-4456";
const ADMIN = { kind: "admin", memberId: "race-4456-admin" } as const;
const REFRESH_JOB = { kind: "system", actor: "xero-token-refresh" } as const;
// Fabricated auth secrets, built at run time so no secret-shaped literal sits in
// the source for the secret scanner to read (#4456 review). Each clears the
// 32-character strength gate, and the two differ.
const AUTH = `${PROVIDER}-a`.padEnd(48, "a");
const ROTATED_AUTH = `${PROVIDER}-r`.padEnd(48, "r");

function testKey(seed: number): string {
  return Buffer.from(Array.from({ length: 32 }, (_, index) => (seed * 53 + index * 19) % 256)).toString("base64");
}
const RING = `k1:${testKey(1)}`;

/** The variables this suite changes, as it found them (#4107). */
const SAVED_ENV = ["AUTH_SECRET", "NEXTAUTH_SECRET", "DATA_ENCRYPTION_KEYS", "DATA_ENCRYPTION_LEGACY_KEY"] as const;
let savedEnv: Partial<Record<(typeof SAVED_ENV)[number], string | undefined>> | null = null;

function restoreEnv() {
  if (!savedEnv) return;
  for (const name of SAVED_ENV) {
    const value = savedEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const RING_2 = `k2:${testKey(2)},${RING}`;
const MEMBER_ID = "race-4456-member";
const TENANT = "race-4456-tenant";
const XERO_TOKEN_ENTITY = "xero-oauth:token-set";

let prisma: typeof import("@/lib/prisma")["prisma"];
let credentials: typeof import("@/lib/integration-credentials");
let reencrypt: typeof import("@/lib/data-encryption-reencrypt");
let twoFactor: typeof import("@/lib/two-factor");
let xeroStore: typeof import("@/lib/xero-token-store");
let StaleCredentialWriteError: typeof import("@/lib/integration-credential-actor")["StaleCredentialWriteError"];
let holderClient: PrismaClient;
let observerClient: PrismaClient;

(RUN ? describe : describe.skip)(LABEL, { timeout: RACE_TEST_TIMEOUT_MS }, () => {
  async function clear() {
    await prisma.integrationCredential.deleteMany({ where: { provider: PROVIDER } });
    await prisma.auditLog.deleteMany({ where: { entityId: { startsWith: `${PROVIDER}:` } } });
    // PR 2's rows: the member (its codes cascade), its audit rows, and the Xero
    // connection the race tests make (the Xero suite clears these tables too).
    await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [MEMBER_ID, XERO_TOKEN_ENTITY] } } });
    await prisma.xeroToken.deleteMany();
    await prisma.xeroConnection.deleteMany();
    await prisma.integrationCredential.deleteMany({ where: { provider: { in: ["xero-oauth", "google"] } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { startsWith: "google:" } } });
    credentials.resetIntegrationCredentialCacheForTests();
  }

  async function read(key: string) {
    credentials.resetIntegrationCredentialCacheForTests();
    return credentials.readIntegrationCredentialRow(prisma, PROVIDER, key);
  }

  async function auditRows(key: string) {
    return prisma.auditLog.count({ where: { entityId: `${PROVIDER}:${key}` } });
  }

  async function storedSource(key: string) {
    const row = await prisma.integrationCredential.findUnique({
      where: { provider_key: { provider: PROVIDER, key } },
      select: { secretSource: true, labelVersion: true },
    });
    return row;
  }

  function set(key: string, value: string, expect: Parameters<typeof credentials.setIntegrationCredential>[0]["expect"], actor: typeof ADMIN | typeof REFRESH_JOB = ADMIN) {
    return credentials.setIntegrationCredential({ provider: PROVIDER, key, value, actor, expect });
  }

  async function versionOf(key: string) {
    const resolution = await read(key);
    if (resolution.status === "not_configured") throw new Error(`no row for ${key}`);
    return resolution.version;
  }

  async function blockedOnLock(): Promise<number> {
    const rows = await observerClient.$queryRaw<Array<{ waiting: number }>>`
      SELECT COUNT(*)::int AS "waiting"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND pid <> pg_backend_pid()
    `;
    return rows[0]?.waiting ?? 0;
  }

  async function waitForBlocked(expected: number) {
    const startedAt = process.hrtime.bigint();
    let seen = 0;
    while (realElapsedMs(startedAt) < BARRIER_TIMEOUT_MS) {
      seen = await blockedOnLock();
      if (seen >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `Timed out waiting for ${expected} credential writes to block at their claim — saw ${seen}. ` +
        "The version-guarded write no longer claims the row it read (integration-credential-claim.ts).",
    );
  }

  function holdRow(key: string) {
    const held = deferred();
    const release = deferred();
    const done = holderClient.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT 1 FROM "IntegrationCredential" WHERE "provider" = ${PROVIDER} AND "key" = ${key} FOR UPDATE`;
        held.resolve();
        await release.promise;
      },
      { timeout: 15_000 },
    );
    return { held: held.promise, release: release.resolve, done };
  }

  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, LABEL);
    savedEnv = Object.fromEntries(SAVED_ENV.map((name) => [name, process.env[name]]));
    process.env.DATABASE_URL = RACE_DB_URL;
    process.env.AUTH_SECRET = AUTH;
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.DATA_ENCRYPTION_KEYS;
    ({ prisma } = await import("@/lib/prisma"));
    credentials = await import("@/lib/integration-credentials");
    ({ StaleCredentialWriteError } = await import("@/lib/integration-credential-actor"));
    reencrypt = await import("@/lib/data-encryption-reencrypt");
    twoFactor = await import("@/lib/two-factor");
    xeroStore = await import("@/lib/xero-token-store");
    const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] = await Promise.all([
      import("@prisma/client"),
      import("@/lib/prisma-adapter"),
    ]);
    const separate = (applicationName: string) => {
      const url = new URL(RACE_DB_URL);
      url.searchParams.set("connection_limit", "1");
      url.searchParams.set("application_name", applicationName);
      return new SeparatePrismaClient({ adapter: createPrismaPgAdapter(url.toString()) });
    };
    holderClient = separate("race-4456-holder");
    observerClient = separate("race-4456-observer");
    await Promise.all([holderClient.$connect(), observerClient.$connect()]);
  }, 60_000);

  beforeEach(async () => {
    process.env.AUTH_SECRET = AUTH;
    delete process.env.DATA_ENCRYPTION_KEYS;
    delete process.env.DATA_ENCRYPTION_LEGACY_KEY;
    await clear();
  });

  afterAll(async () => {
    try {
      if (prisma) await clear();
      await Promise.all([holderClient?.$disconnect(), observerClient?.$disconnect()]);
    } finally {
      restoreEnv();
    }
  });

  it("acceptance: a ring-written credential survives rotating AUTH_SECRET; a legacy one needs re-entry", async () => {
    await set("legacy", "legacy-value", { expect: "absent" });
    process.env.DATA_ENCRYPTION_KEYS = RING;
    await set("ring", "ring-value", { expect: "absent" });
    expect(await storedSource("legacy")).toEqual({ secretSource: "AUTH_SECRET", labelVersion: "integration-credential:v1" });
    expect(await storedSource("ring")).toEqual({ secretSource: "DATA_ENCRYPTION_KEY:k1", labelVersion: "integration-credential:v2" });

    process.env.AUTH_SECRET = ROTATED_AUTH;
    const ring = await read("ring");
    expect(ring.status === "configured" && ring.value).toBe("ring-value");
    expect((await read("legacy")).status).toBe("needs_reentry");
  });

  it("re-keys a legacy row with an ordinary version-guarded write, keeping its value", async () => {
    await set("rekey", "same-value", { expect: "absent" });
    const version = await versionOf("rekey");
    process.env.DATA_ENCRYPTION_KEYS = RING;

    await set("rekey", "same-value", { expect: "version", version }, REFRESH_JOB);

    expect(await storedSource("rekey")).toEqual({ secretSource: "DATA_ENCRYPTION_KEY:k1", labelVersion: "integration-credential:v2" });
    process.env.AUTH_SECRET = ROTATED_AUTH;
    const after = await read("rekey");
    expect(after.status === "configured" && after.value).toBe("same-value");
  });

  it("a row that changed underneath a version-guarded write makes it lose with no side effect, and a retry wins", async () => {
    await set("moved", "original", { expect: "absent" });
    const stale = await versionOf("moved");
    process.env.DATA_ENCRYPTION_KEYS = RING;
    // A token refresh lands first, under the current key.
    await set("moved", "refreshed", { expect: "version", version: stale }, REFRESH_JOB);
    const auditBefore = await auditRows("moved");
    const rowBefore = await prisma.integrationCredential.findUnique({
      where: { provider_key: { provider: PROVIDER, key: "moved" } },
    });

    await expect(set("moved", "original", { expect: "version", version: stale })).rejects.toBeInstanceOf(
      StaleCredentialWriteError,
    );

    // Lost: nothing changed and nothing was audited.
    expect(await auditRows("moved")).toBe(auditBefore);
    expect(
      await prisma.integrationCredential.findUnique({ where: { provider_key: { provider: PROVIDER, key: "moved" } } }),
    ).toEqual(rowBefore);
    const current = await read("moved");
    expect(current.status === "configured" && current.value).toBe("refreshed");

    // Retried from a fresh read, it wins, under the current key.
    await set("moved", "second", { expect: "version", version: await versionOf("moved") });
    const retried = await read("moved");
    expect(retried.status === "configured" && retried.value).toBe("second");
    expect((await storedSource("moved"))?.secretSource).toBe("DATA_ENCRYPTION_KEY:k1");
  });

  it("two ring writes holding the same version, forced to meet at the claim, let exactly one through", async () => {
    process.env.DATA_ENCRYPTION_KEYS = RING;
    await set("raced", "start", { expect: "absent" });
    const version = await versionOf("raced");
    const auditBefore = await auditRows("raced");

    const holder = holdRow("raced");
    await holder.held;
    const writes = Promise.allSettled([
      set("raced", "writer-a", { expect: "version", version }),
      set("raced", "writer-b", { expect: "version", version }),
    ]);
    await waitForBlocked(2);
    holder.release();
    await holder.done;
    const [a, b] = await writes;

    const outcomes = [a, b].map((outcome) => outcome.status);
    expect(outcomes.sort()).toEqual(["fulfilled", "rejected"]);
    const loser = [a, b].find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(StaleCredentialWriteError);
    const winner = a.status === "fulfilled" ? "writer-a" : "writer-b";
    const stored = await read("raced");
    expect(stored.status === "configured" && stored.value).toBe(winner);
    expect(await auditRows("raced")).toBe(auditBefore + 1);
  });
  // ---------------------------------------------------------------------------
  // PR 2: `pnpm run data-keys:reencrypt` against real rows and row locks.
  // ---------------------------------------------------------------------------

  const noPause = async () => undefined;
  const runReencrypt = (options: { retire?: boolean; maxPasses?: number; providers?: string[] } = {}) =>
    reencrypt.reencryptStoredData({
      dryRun: false,
      retireLegacyRecoveryCodes: options.retire ?? false,
      maxPasses: options.maxPasses,
      pause: noPause,
      scope: { providers: options.providers ?? [PROVIDER], memberIds: [MEMBER_ID] },
    });

  const LEGACY_CODE = "AAAA-BBBB-CCCC";
  const TOTP_SECRET = "JBSWY3DPEHPK3PXP";

  /** Legacy data, as a club has it before the ring: two credentials, a TOTP member, two codes. */
  async function seedLegacy() {
    await set("client_id", "id-value", { expect: "absent" });
    await set("client_secret", "secret-value", { expect: "absent" });
    await prisma.member.create({
      data: {
        id: MEMBER_ID,
        email: "race-4456@example.invalid",
        passwordHash: "not-a-real-password",
        firstName: "Key",
        lastName: "Ring",
        ageTier: "ADULT",
        totpSecret: twoFactor.encryptTwoFactorSecret(TOTP_SECRET),
      },
    });
    await prisma.twoFactorRecoveryCode.createMany({
      data: [
        { memberId: MEMBER_ID, codeHash: twoFactor.hashRecoveryCode(LEGACY_CODE) },
        { memberId: MEMBER_ID, codeHash: twoFactor.hashRecoveryCode("DDDD-EEEE-FFFF"), usedAt: new Date() },
      ],
    });
  }

  async function storedTotp() {
    return (await prisma.member.findUniqueOrThrow({ where: { id: MEMBER_ID }, select: { totpSecret: true } })).totpSecret!;
  }

  it("leaves no row on the old key after a run, every value still reading after AUTH_SECRET is rotated", async () => {
    await seedLegacy();
    process.env.DATA_ENCRYPTION_KEYS = RING;

    const report = await runReencrypt({ retire: true });

    expect(report.credentials).toEqual({ moved: 2, lostClaims: 0, unreadable: 0, remaining: 0 });
    expect(report.authenticatorSecrets).toEqual({ moved: 1, lostClaims: 0, unreadable: 0, remaining: 0 });
    expect(report.recoveryCodes).toEqual({ legacyUnused: 0, retired: 1, olderRingKeyUnused: 0 });
    expect(await storedSource("client_id")).toEqual({ secretSource: "DATA_ENCRYPTION_KEY:k1", labelVersion: "integration-credential:v2" });
    expect(await storedSource("client_secret")).toMatchObject({ secretSource: "DATA_ENCRYPTION_KEY:k1" });
    expect(await storedTotp()).toMatch(/^v2:k1:/);
    // Each credential move audited once, as the job, in its transaction.
    const audits = await prisma.auditLog.findMany({
      where: { entityId: { startsWith: `${PROVIDER}:` }, metadata: { path: ["systemActor"], equals: "data-key-reencrypt" } },
      select: { entityId: true, metadata: true },
    });
    expect(audits.map((row) => row.entityId).sort()).toEqual([`${PROVIDER}:client_id`, `${PROVIDER}:client_secret`]);
    expect(JSON.stringify(audits)).not.toMatch(/id-value|secret-value/);
    expect(
      await prisma.auditLog.findMany({ where: { entityId: MEMBER_ID }, select: { action: true }, orderBy: { action: "asc" } }),
    ).toEqual([{ action: "security.two_factor.recovery_codes_retired" }, { action: "security.two_factor.secret_rewrapped" }]);

    process.env.AUTH_SECRET = ROTATED_AUTH;
    process.env.DATA_ENCRYPTION_LEGACY_KEY = "retired";
    const id = await read("client_id");
    expect(id.status === "configured" && id.value).toBe("id-value");
    expect(twoFactor.decryptTwoFactorSecret(await storedTotp())).toBe(TOTP_SECRET);
    // The retired code signs no one in, here or on a colour without the ring,
    // and its member is still told to regenerate.
    expect(await twoFactor.consumeRecoveryCode(MEMBER_ID, LEGACY_CODE)).toBe(false);
    expect(await twoFactor.memberHoldsRetiredRecoveryCodes(MEMBER_ID)).toBe(true);
    process.env.AUTH_SECRET = AUTH;
    delete process.env.DATA_ENCRYPTION_LEGACY_KEY;
    delete process.env.DATA_ENCRYPTION_KEYS;
    expect(await twoFactor.consumeRecoveryCode(MEMBER_ID, LEGACY_CODE)).toBe(false);
    expect(await twoFactor.memberHoldsRetiredRecoveryCodes(MEMBER_ID)).toBe(true);
  });

  it("keeps a provider verified: a moved credential keeps its own updatedAt, so the marker stays fresh (#4456 review C3)", async () => {
    const google = await import("@/lib/google-config");
    for (const key of ["client_id", "client_secret"]) {
      await credentials.setIntegrationCredential({ provider: "google", key, value: `${key}-value`, actor: ADMIN, expect: { expect: "absent" } });
    }
    process.env.DATA_ENCRYPTION_KEYS = RING;
    await google.recordGoogleVerified();
    expect((await google.getGoogleSetupState()).verified).toBe(true);
    const before = await prisma.integrationCredential.findMany({
      where: { provider: "google", key: { in: ["client_id", "client_secret"] } },
      select: { key: true, updatedAt: true },
      orderBy: { key: "asc" },
    });
    // Long enough that a bumped timestamp would differ from the marker's. (On
    // Prisma 7.10 the store's compare-and-set does not bump `updatedAt` anyway;
    // the next test pins that the re-encrypt's write keeps it by contract.)
    await new Promise((resolve) => setTimeout(resolve, 25));

    const report = await runReencrypt({ providers: ["google"] });

    expect(report.credentials).toMatchObject({ moved: 2, remaining: 0 });
    const after = await prisma.integrationCredential.findMany({
      where: { provider: "google", key: { in: ["client_id", "client_secret"] } },
      select: { key: true, updatedAt: true, secretSource: true },
      orderBy: { key: "asc" },
    });
    expect(after.map((row) => row.secretSource)).toEqual(["DATA_ENCRYPTION_KEY:k1", "DATA_ENCRYPTION_KEY:k1"]);
    expect(after.map((row) => row.updatedAt.getTime())).toEqual(before.map((row) => row.updatedAt.getTime()));
    expect((await google.getGoogleSetupState()).verified).toBe(true);
  });

  it("the store writes the timestamp it is told to keep, so the re-encrypt never depends on Prisma's own (#4456 review C3)", async () => {
    await set("stamped", "value", { expect: "absent" });
    const version = await versionOf("stamped");
    const kept = new Date("2026-01-01T00:00:00.000Z");
    process.env.DATA_ENCRYPTION_KEYS = RING;

    await credentials.withCredentialTransaction([PROVIDER], (tx) =>
      credentials.setIntegrationCredentialInTransaction({
        tx,
        provider: PROVIDER,
        key: "stamped",
        value: "value",
        actor: { kind: "system", actor: "data-key-reencrypt" },
        expect: { expect: "version", version },
        cause: { kind: "data-key-reencrypt" },
        keepUpdatedAt: kept,
      }),
    );

    const row = await prisma.integrationCredential.findUniqueOrThrow({
      where: { provider_key: { provider: PROVIDER, key: "stamped" } },
      select: { updatedAt: true, secretSource: true },
    });
    expect(row).toEqual({ updatedAt: kept, secretSource: "DATA_ENCRYPTION_KEY:k1" });
  });

  it("moves everything again to a newer ring key, and a second run finds nothing to do", async () => {
    await seedLegacy();
    process.env.DATA_ENCRYPTION_KEYS = RING;
    await runReencrypt();
    process.env.DATA_ENCRYPTION_KEYS = RING_2;

    const rotated = await runReencrypt();
    expect(rotated.credentials).toMatchObject({ moved: 2, remaining: 0 });
    expect(rotated.authenticatorSecrets).toMatchObject({ moved: 1, remaining: 0 });
    expect(await storedSource("client_secret")).toMatchObject({ secretSource: "DATA_ENCRYPTION_KEY:k2" });
    expect(await storedTotp()).toMatch(/^v2:k2:/);
    // The legacy code was not retired, so it is still counted.
    expect(rotated.recoveryCodes.legacyUnused).toBe(1);

    const again = await runReencrypt();
    expect(again.credentials).toEqual({ moved: 0, lostClaims: 0, unreadable: 0, remaining: 0 });
    expect(again.authenticatorSecrets).toEqual({ moved: 0, lostClaims: 0, unreadable: 0, remaining: 0 });
    expect(again.passes).toBe(0);
  });

  it("a dry run changes no row and writes no audit row", async () => {
    await seedLegacy();
    process.env.DATA_ENCRYPTION_KEYS = RING;
    const before = await prisma.integrationCredential.findMany({ where: { provider: PROVIDER }, orderBy: { key: "asc" } });
    const totpBefore = await storedTotp();

    const report = await reencrypt.reencryptStoredData({
      dryRun: true,
      retireLegacyRecoveryCodes: true,
      pause: noPause,
      scope: { providers: [PROVIDER], memberIds: [MEMBER_ID] },
    });

    expect(report).toMatchObject({ credentials: { moved: 2, remaining: 2 }, authenticatorSecrets: { moved: 1, remaining: 1 } });
    expect(report.recoveryCodes).toEqual({ legacyUnused: 1, retired: 1, olderRingKeyUnused: 0 });
    expect(await prisma.integrationCredential.findMany({ where: { provider: PROVIDER }, orderBy: { key: "asc" } })).toEqual(before);
    expect(await storedTotp()).toBe(totpBefore);
    expect(await auditRows("client_id")).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityId: MEMBER_ID } })).toBe(0);
  });

  describe("a Xero token refresh racing the re-encrypt (#4456 PR 2)", () => {
    function tokens(tag: string) {
      return {
        accessToken: `race-4456-access-${tag}`,
        refreshToken: `race-4456-refresh-${tag}`,
        expiresAt: new Date(Date.now() + 1_800_000),
        tenantId: TENANT,
      };
    }

    async function connectLegacy() {
      await xeroStore.saveXeroTokens(tokens("connected"), { actor: ADMIN });
      process.env.DATA_ENCRYPTION_KEYS = RING;
    }

    async function tokenSetSource() {
      return (
        await prisma.integrationCredential.findUniqueOrThrow({
          where: { provider_key: { provider: "xero-oauth", key: "token-set" } },
          select: { secretSource: true },
        })
      ).secretSource;
    }

    const moveTokenSet = (maxPasses = 1) => runReencrypt({ providers: ["xero-oauth"], maxPasses });

    it("with the refresh lease held, the re-encrypt loses and the refresh saves its rotated pair, under the current key", async () => {
      await connectLegacy();
      const claim = await xeroStore.claimXeroTokenRefreshLease();
      if (!claim.claimed) throw new Error("expected the lease");
      // The refresh is now at Xero, its refresh token spent.

      const lost = await moveTokenSet();
      expect(lost.credentials).toMatchObject({ moved: 0, lostClaims: 1, remaining: 1 });
      expect(await tokenSetSource()).toBe("AUTH_SECRET");

      await xeroStore.saveXeroTokens(tokens("refreshed"), { actor: REFRESH_JOB, lease: claim.lease });
      expect((await xeroStore.loadXeroTokens())?.refreshToken).toBe("race-4456-refresh-refreshed");
      // The refresh wrote under the current key itself, so the next run has nothing to move.
      expect(await tokenSetSource()).toBe("DATA_ENCRYPTION_KEY:k1");
      expect((await moveTokenSet()).credentials).toEqual({ moved: 0, lostClaims: 0, unreadable: 0, remaining: 0 });
      process.env.AUTH_SECRET = ROTATED_AUTH;
      expect((await xeroStore.loadXeroTokens())?.refreshToken).toBe("race-4456-refresh-refreshed");
    });

    it("never takes over an EXPIRED lease: a stalled refresh still in flight saves its rotated pair (#4456 review C1)", async () => {
      await connectLegacy();
      // A refresh claimed ten minutes ago and is still at Xero: its two-minute lease has run out.
      const claim = await xeroStore.claimXeroTokenRefreshLease({ now: new Date(Date.now() - 10 * 60_000) });
      if (!claim.claimed) throw new Error("expected the lease");
      expect(claim.leaseUntil.getTime()).toBeLessThan(Date.now());

      const lost = await moveTokenSet();
      expect(lost.credentials).toMatchObject({ moved: 0, lostClaims: 1, remaining: 1 });
      expect(await tokenSetSource()).toBe("AUTH_SECRET");

      await xeroStore.saveXeroTokens(tokens("refreshed"), { actor: REFRESH_JOB, lease: claim.lease });
      expect((await xeroStore.loadXeroTokens())?.refreshToken).toBe("race-4456-refresh-refreshed");
      expect(await tokenSetSource()).toBe("DATA_ENCRYPTION_KEY:k1");
    });

    it("a re-encrypt that commits first makes the next claim read the moved row, and its save wins", async () => {
      await connectLegacy();
      expect((await moveTokenSet()).credentials).toMatchObject({ moved: 1 });

      const claim = await xeroStore.claimXeroTokenRefreshLease();
      if (!claim.claimed) throw new Error("expected the lease");
      expect(claim.tokens.refreshToken).toBe("race-4456-refresh-connected");
      await xeroStore.saveXeroTokens(tokens("refreshed"), { actor: REFRESH_JOB, lease: claim.lease });
      expect((await xeroStore.loadXeroTokens())?.refreshToken).toBe("race-4456-refresh-refreshed");
    });

    // Row-lock waiters are granted in arrival order, so each case queues its two
    // writers one at a time behind a held `XeroToken` lock to choose who goes first.
    it.each(["the refresh claim", "the re-encrypt"] as const)(
      "queued behind the XeroToken row lock with %s first, no refresh token is lost",
      async (first) => {
        await connectLegacy();
        const held = deferred();
        const release = deferred();
        const holder = holderClient.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT 1 FROM "XeroToken" FOR UPDATE`;
            held.resolve();
            await release.promise;
          },
          { timeout: 15_000 },
        );
        await held.promise;

        const claiming = () => xeroStore.claimXeroTokenRefreshLease();
        let claimP: ReturnType<typeof claiming>;
        let moveP: ReturnType<typeof moveTokenSet>;
        if (first === "the refresh claim") {
          claimP = claiming();
          await waitForBlocked(1);
          moveP = moveTokenSet();
        } else {
          moveP = moveTokenSet();
          await waitForBlocked(1);
          claimP = claiming();
        }
        await waitForBlocked(2);
        release.resolve();
        await holder;
        const [claim, report] = await Promise.all([claimP, moveP]);

        // The claim always wins its lease: the re-encrypt never holds one.
        if (!claim.claimed) throw new Error("expected the lease");
        if (first === "the refresh claim") {
          // It found the lease held: lost, nothing written.
          expect(report.credentials).toMatchObject({ moved: 0, lostClaims: 1 });
          expect(claim.tokens.refreshToken).toBe("race-4456-refresh-connected");
        } else {
          // It moved the row first; the claim then read the moved row's version.
          expect(report.credentials).toMatchObject({ moved: 1, lostClaims: 0 });
          expect(await tokenSetSource()).toBe("DATA_ENCRYPTION_KEY:k1");
        }
        await xeroStore.saveXeroTokens(tokens("refreshed"), { actor: REFRESH_JOB, lease: claim.lease });
        expect((await xeroStore.loadXeroTokens())?.refreshToken).toBe("race-4456-refresh-refreshed");

        // Moved by the re-encrypt or, when it lost, by the refresh's own save.
        expect(await tokenSetSource()).toBe("DATA_ENCRYPTION_KEY:k1");
        expect((await moveTokenSet()).credentials).toMatchObject({ moved: 0, remaining: 0 });
        process.env.AUTH_SECRET = ROTATED_AUTH;
        expect((await xeroStore.loadXeroTokens())?.refreshToken).toBe("race-4456-refresh-refreshed");
      },
    );
  });
});
