import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  // Every mutator runs inside one transaction with its audit row (#2723). The
  // transaction client is a SEPARATE double from the module client, so a store
  // that wrote its audit row outside the transaction is visible here rather
  // than indistinguishable — see the note in `credential-write-contract.test.ts`.
  const delegate = () => ({
    findMany: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
    // #4456: rows already under a ring key, asked before an AUTH_SECRET write.
    count: vi.fn(async () => 0),
  });
  const tx = {
    integrationCredential: delegate(),
    auditLog: { create: vi.fn() },
  };
  const prisma = {
    integrationCredential: delegate(),
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(
    async (callback: (client: typeof tx) => unknown) => callback(tx),
  );
  return { prisma, tx };
});

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));

import { WeakAuthSecretError, encryptCredential } from "@/lib/integration-crypto";
import { credentialVersionOf, type CredentialActor } from "@/lib/integration-credential-actor";
import {
  CACHE_TTL_MS,
  getIntegrationsNeedingReentry,
  readIntegrationCredentialRow,
  resetIntegrationCredentialCacheForTests,
  resolveIntegrationCredential,
  setIntegrationCredential,
} from "@/lib/integration-credentials";

const STRONG_SECRET = "a".repeat(48);
/** Every write in this file names an actor; the store has no other mode. */
const ADMIN: CredentialActor = { kind: "admin", memberId: "member-1" };
const OTHER_STRONG_SECRET = "b".repeat(48);
const originalEnv = { ...process.env };

/** Build a realistic stored row for (provider,key,value), encrypted now. */
function storedRow(provider: string, key: string, value: string) {
  const enc = encryptCredential({
    provider,
    key,
    plaintext: value,
  });
  return {
    id: `${provider}-${key}`,
    provider,
    key,
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    authTag: enc.authTag,
    secretSource: enc.secretSource,
    labelVersion: enc.labelVersion,
    createdAt: new Date(),
    updatedAt: new Date(),
    updatedByUserId: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.$transaction.mockImplementation(
    async (callback: (client: unknown) => unknown) => callback(mocks.tx),
  );
  mocks.tx.auditLog.create.mockResolvedValue({});
  mocks.tx.integrationCredential.findUnique.mockResolvedValue(null);
  resetIntegrationCredentialCacheForTests();
  delete process.env.NEXTAUTH_SECRET;
  process.env.AUTH_SECRET = STRONG_SECRET;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-21T00:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
  process.env = { ...originalEnv };
});

describe("integration-credentials: cross-process cache contract", () => {
  it("caches a negative for <= TTL, then a fresh (other-process) write becomes visible after TTL", async () => {
    mocks.prisma.integrationCredential.findMany.mockResolvedValue([]);
    // Cold read: DB says not configured — cached.
    expect((await resolveIntegrationCredential("xero", "client_id")).status).toBe(
      "not_configured",
    );

    // Another process writes the row; THIS process did not invalidate.
    mocks.prisma.integrationCredential.findMany.mockResolvedValue([
      storedRow("xero", "client_id", "db-value"),
    ]);

    // Still within TTL: the cached negative is served (bounded staleness).
    vi.advanceTimersByTime(CACHE_TTL_MS - 1);
    expect((await resolveIntegrationCredential("xero", "client_id")).status).toBe(
      "not_configured",
    );

    // Past TTL: the negative expired, the fresh write is now visible.
    vi.advanceTimersByTime(2);
    const resolved = await resolveIntegrationCredential("xero", "client_id");
    expect(resolved.status).toBe("configured");
    expect(resolved).toMatchObject({ value: "db-value" });
  });

  it("invalidates the writing process's cache immediately on write", async () => {
    mocks.prisma.integrationCredential.findMany.mockResolvedValue([]);
    expect((await resolveIntegrationCredential("xero", "client_id")).status).toBe(
      "not_configured",
    );

    mocks.tx.integrationCredential.upsert.mockResolvedValue({
      provider: "xero",
      key: "client_id",
      updatedAt: new Date(),
    });
    mocks.prisma.integrationCredential.findMany.mockResolvedValue([
      storedRow("xero", "client_id", "written"),
    ]);

    await setIntegrationCredential({
      provider: "xero",
      key: "client_id",
      value: "written",
      actor: ADMIN,
      expect: { expect: "any" },
    });

    // No TTL wait: the write invalidated this process's cache.
    const resolved = await resolveIntegrationCredential("xero", "client_id");
    expect(resolved).toMatchObject({ status: "configured", value: "written" });
  });

  it("never converts a DB error into a remembered negative", async () => {
    mocks.prisma.integrationCredential.findMany.mockRejectedValueOnce(
      new Error("db down"),
    );
    await expect(
      resolveIntegrationCredential("xero", "client_id"),
    ).rejects.toThrow("db down");

    // The error was not cached: the next read hits the DB and succeeds.
    mocks.prisma.integrationCredential.findMany.mockResolvedValue([
      storedRow("xero", "client_id", "recovered"),
    ]);
    const resolved = await resolveIntegrationCredential("xero", "client_id");
    expect(resolved).toMatchObject({ status: "configured", value: "recovered" });
  });
});

describe("integration-credentials: state + source-flip + re-entry", () => {
  it("flags a secret-source flip when the value is unchanged", async () => {
    // Row written under AUTH_SECRET.
    mocks.prisma.integrationCredential.findMany.mockResolvedValue([
      storedRow("xero", "webhook_key", "hook"),
    ]);
    // Same value now resolves from NEXTAUTH_SECRET.
    delete process.env.AUTH_SECRET;
    process.env.NEXTAUTH_SECRET = STRONG_SECRET;

    const resolved = await resolveIntegrationCredential("xero", "webhook_key");
    expect(resolved).toMatchObject({
      status: "configured",
      value: "hook",
      sourceFlipped: true,
    });
  });

  it("reports needs_reentry when the secret VALUE changed (GCM fails)", async () => {
    mocks.prisma.integrationCredential.findMany.mockResolvedValue([
      storedRow("xero", "client_id", "value"),
    ]);
    process.env.AUTH_SECRET = OTHER_STRONG_SECRET; // rotated

    const resolved = await resolveIntegrationCredential("xero", "client_id");
    expect(resolved.status).toBe("needs_reentry");
  });

  it("aggregates providers needing re-entry off the same detection path", async () => {
    const rows = [storedRow("xero", "client_id", "v")];
    mocks.prisma.integrationCredential.findMany.mockImplementation(
      async ({ where }: { where: { provider: string } }) =>
        where.provider === "xero" ? rows : [],
    );
    process.env.AUTH_SECRET = OTHER_STRONG_SECRET; // strand xero's rows

    expect(await getIntegrationsNeedingReentry(["xero", "stripe"])).toEqual([
      "xero",
    ]);
  });
});

describe("integration-credentials: uncached row re-read (#4366)", () => {
  it("reads the row through the caller's client and retains the version even when decryption fails", async () => {
    const row = storedRow("servernz", "api_key", "key-a");
    mocks.tx.integrationCredential.findUnique.mockResolvedValue(row);
    process.env.AUTH_SECRET = OTHER_STRONG_SECRET; // undecryptable: still versioned

    await expect(
      readIntegrationCredentialRow(mocks.tx as never, "servernz", "api_key"),
    ).resolves.toMatchObject({ status: "needs_reentry", version: credentialVersionOf(row) });
    expect(mocks.tx.integrationCredential.findUnique).toHaveBeenCalledWith({
      where: { provider_key: { provider: "servernz", key: "api_key" } },
    });
    expect(mocks.prisma.integrationCredential.findUnique).not.toHaveBeenCalled();
  });

  it("moves when the same value is saved again, and is null with no row", async () => {
    const first = storedRow("servernz", "api_key", "key-a");
    const again = storedRow("servernz", "api_key", "key-a");
    mocks.tx.integrationCredential.findUnique.mockResolvedValueOnce(first).mockResolvedValueOnce(again);

    const a1 = await readIntegrationCredentialRow(mocks.tx as never, "servernz", "api_key");
    const a2 = await readIntegrationCredentialRow(mocks.tx as never, "servernz", "api_key");
    expect(a1.status !== "not_configured" && a1.version).not.toBe(a2.status !== "not_configured" && a2.version);

    mocks.tx.integrationCredential.findUnique.mockResolvedValueOnce(null);
    await expect(
      readIntegrationCredentialRow(mocks.tx as never, "servernz", "api_key"),
    ).resolves.toEqual({ status: "not_configured" });
  });
});

describe("no AUTH_SECRET write while ring-keyed credentials exist (#4456 review)", () => {
  const RING_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => (index * 23 + 5) % 256)).toString("base64");
  const write = () =>
    setIntegrationCredential({ provider: "xero", key: "client_id", value: "v", actor: ADMIN, expect: { expect: "any" } });

  beforeEach(() => {
    delete process.env.DATA_ENCRYPTION_KEYS;
    mocks.tx.integrationCredential.upsert.mockResolvedValue({ provider: "xero", key: "client_id", updatedAt: new Date() });
  });

  it("refuses, writing and auditing nothing, when the ring is unset but a row is under a ring key", async () => {
    mocks.tx.integrationCredential.count.mockResolvedValueOnce(2);
    await expect(write()).rejects.toThrow(WeakAuthSecretError);
    mocks.tx.integrationCredential.count.mockResolvedValueOnce(2);
    await expect(write()).rejects.toThrow(/DATA_ENCRYPTION_KEYS is not set/);
    expect(mocks.tx.integrationCredential.count).toHaveBeenCalledWith({
      where: { secretSource: { startsWith: "DATA_ENCRYPTION_KEY:" } },
    });
    expect(mocks.tx.integrationCredential.upsert).not.toHaveBeenCalled();
    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("writes under AUTH_SECRET as before when nothing is under a ring key", async () => {
    await write();
    expect(mocks.tx.integrationCredential.upsert).toHaveBeenCalledOnce();
  });

  it("never asks when the write is under the ring", async () => {
    process.env.DATA_ENCRYPTION_KEYS = `k1:${RING_KEY}`;
    await write();
    expect(mocks.tx.integrationCredential.count).not.toHaveBeenCalled();
    expect(mocks.tx.integrationCredential.upsert).toHaveBeenCalledOnce();
  });
});

