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
 *      a third connection's row lock, let exactly one through.
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
const AUTH = "race-4456-auth-secret-0123456789abcdefghijklmn";
const ROTATED_AUTH = "race-4456-rotated-secret-0123456789abcdefghij";

function testKey(seed: number): string {
  return Buffer.from(Array.from({ length: 32 }, (_, index) => (seed * 53 + index * 19) % 256)).toString("base64");
}
const RING = `k1:${testKey(1)}`;

/** The variables this suite changes, as it found them (#4107). */
const SAVED_ENV = ["AUTH_SECRET", "NEXTAUTH_SECRET", "DATA_ENCRYPTION_KEYS"] as const;
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

let prisma: typeof import("@/lib/prisma")["prisma"];
let credentials: typeof import("@/lib/integration-credentials");
let StaleCredentialWriteError: typeof import("@/lib/integration-credential-actor")["StaleCredentialWriteError"];
let holderClient: PrismaClient;
let observerClient: PrismaClient;

(RUN ? describe : describe.skip)(LABEL, { timeout: RACE_TEST_TIMEOUT_MS }, () => {
  async function clear() {
    await prisma.integrationCredential.deleteMany({ where: { provider: PROVIDER } });
    await prisma.auditLog.deleteMany({ where: { entityId: { startsWith: `${PROVIDER}:` } } });
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
});
