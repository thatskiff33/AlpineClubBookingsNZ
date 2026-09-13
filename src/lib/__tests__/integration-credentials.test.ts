import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const prisma = {
    integrationCredential: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    // Every mutator runs inside one transaction with its audit row (#2723).
    // Handing the callback the SAME double is what makes the assertions below
    // able to say the credential statement and the audit row went to one client.
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(
    async (callback: (tx: typeof prisma) => unknown) => callback(prisma),
  );
  return { prisma };
});

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));

import { encryptCredential, INTEGRATION_CREDENTIAL_LABEL } from "@/lib/integration-crypto";
import {
  CredentialActorError,
  CredentialExpectationError,
  StaleCredentialWriteError,
  credentialVersionOf,
  type CredentialActor,
} from "@/lib/integration-credential-actor";
import {
  CACHE_TTL_MS,
  deleteIntegrationCredential,
  ensureGeneratedCredential,
  getIntegrationsNeedingReentry,
  resetIntegrationCredentialCacheForTests,
  resolveIntegrationCredential,
  setIntegrationCredential,
} from "@/lib/integration-credentials";

const STRONG_SECRET = "a".repeat(48);
/** Every write in this file names an actor; the store has no other mode. */
const ADMIN: CredentialActor = { kind: "admin", memberId: "member-1" };
const SYSTEM: CredentialActor = {
  kind: "system",
  actor: "xero-token-key-generation",
};
const OTHER_STRONG_SECRET = "b".repeat(48);
const originalEnv = { ...process.env };

/** Build a realistic stored row for (provider,key,value), encrypted now. */
function storedRow(provider: string, key: string, value: string) {
  const enc = encryptCredential({
    provider,
    key,
    plaintext: value,
    label: INTEGRATION_CREDENTIAL_LABEL,
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
    async (callback: (tx: unknown) => unknown) => callback(mocks.prisma),
  );
  mocks.prisma.auditLog.create.mockResolvedValue({});
  mocks.prisma.integrationCredential.findUnique.mockResolvedValue(null);
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

    mocks.prisma.integrationCredential.upsert.mockResolvedValue({
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

describe("ensureGeneratedCredential: create-only / create-or-lose (FIX-6)", () => {
  const P2002 = Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
  });

  it("generates via create (never upsert) when no row exists", async () => {
    mocks.prisma.integrationCredential.findMany.mockResolvedValue([]);
    mocks.prisma.integrationCredential.create.mockResolvedValue({});

    const value = await ensureGeneratedCredential({
      provider: "xero",
      key: "token_key",
      label: INTEGRATION_CREDENTIAL_LABEL,
      generate: () => "fresh-generated-key",
      actor: SYSTEM,
    });

    expect(value).toBe("fresh-generated-key");
    expect(mocks.prisma.integrationCredential.create).toHaveBeenCalledTimes(1);
    // Genuinely create-only: no last-writer-wins upsert.
    expect(mocks.prisma.integrationCredential.upsert).not.toHaveBeenCalled();
  });

  it("on a P2002 create race, returns the winner's value (not ours)", async () => {
    // First resolve: not configured. After the losing create, re-resolve finds
    // the concurrent creator's row.
    mocks.prisma.integrationCredential.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValue([storedRow("xero", "token_key", "winner-key")]);
    mocks.prisma.integrationCredential.create.mockRejectedValueOnce(P2002);

    const value = await ensureGeneratedCredential({
      provider: "xero",
      key: "token_key",
      label: INTEGRATION_CREDENTIAL_LABEL,
      generate: () => "loser-key",
      actor: SYSTEM,
    });

    expect(value).toBe("winner-key");
  });

  it("never overwrites a readable key — returns the existing value", async () => {
    mocks.prisma.integrationCredential.findMany.mockResolvedValue([
      storedRow("xero", "token_key", "already-there"),
    ]);
    const generate = vi.fn(() => "should-not-be-used");

    const value = await ensureGeneratedCredential({
      provider: "xero",
      key: "token_key",
      label: INTEGRATION_CREDENTIAL_LABEL,
      generate,
      actor: SYSTEM,
    });

    expect(value).toBe("already-there");
    expect(generate).not.toHaveBeenCalled();
    expect(mocks.prisma.integrationCredential.create).not.toHaveBeenCalled();
    expect(mocks.prisma.integrationCredential.updateMany).not.toHaveBeenCalled();
  });

  it("replaces an unreadable (needs_reentry) row via a claim keyed on its stale ciphertext", async () => {
    // Row written under AUTH_SECRET, now unreadable because the secret rotated.
    const staleRow = storedRow("xero", "token_key", "dead-material");
    process.env.AUTH_SECRET = OTHER_STRONG_SECRET; // strands the row → needs_reentry
    mocks.prisma.integrationCredential.findMany.mockResolvedValue([staleRow]);
    mocks.prisma.integrationCredential.updateMany.mockResolvedValue({ count: 1 });

    const value = await ensureGeneratedCredential({
      provider: "xero",
      key: "token_key",
      label: INTEGRATION_CREDENTIAL_LABEL,
      generate: () => "regenerated-key",
      actor: SYSTEM,
    });

    expect(value).toBe("regenerated-key");
    // The claim is scoped to the exact dead ciphertext, so a racing writer's
    // claim matches zero rows instead of clobbering the winner.
    expect(mocks.prisma.integrationCredential.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          provider: "xero",
          key: "token_key",
          ciphertext: staleRow.ciphertext,
        }),
      }),
    );
  });

  it("adopts the winner when the replacement claim loses (count 0)", async () => {
    const staleRow = storedRow("xero", "token_key", "dead-material");
    process.env.AUTH_SECRET = OTHER_STRONG_SECRET;
    // Winner already replaced the dead row with material readable under the
    // current secret.
    const winnerRow = storedRow("xero", "token_key", "winner-regenerated");
    mocks.prisma.integrationCredential.findMany
      .mockResolvedValueOnce([staleRow])
      .mockResolvedValue([winnerRow]);
    mocks.prisma.integrationCredential.updateMany.mockResolvedValue({ count: 0 });

    const value = await ensureGeneratedCredential({
      provider: "xero",
      key: "token_key",
      label: INTEGRATION_CREDENTIAL_LABEL,
      generate: () => "our-losing-key",
      actor: SYSTEM,
    });

    expect(value).toBe("winner-regenerated");
  });
});
