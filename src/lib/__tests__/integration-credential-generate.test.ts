/**
 * The SELF-GENERATED credential's create-only discipline (FIX-6, moved out of
 * `integration-credentials.test.ts` with the module it exercises — #2723).
 *
 * Its subject is the one mutator whose expectation is not the caller's to
 * choose: two containers generating the Xero token key at once must converge on
 * ONE stored value, so every path here is about which racer wins and what the
 * loser does next.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  // As in the store's own test: the TRANSACTION client is a separate double
  // from the module client, so a write that escaped its transaction is visible
  // here rather than indistinguishable.
  const delegate = () => ({
    findMany: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
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

import {
  encryptCredential,
  INTEGRATION_CREDENTIAL_LABEL,
} from "@/lib/integration-crypto";
import type { CredentialActor } from "@/lib/integration-credential-actor";
import { ensureGeneratedCredential } from "@/lib/integration-credential-generate";
import { resetIntegrationCredentialCacheForTests } from "@/lib/integration-credentials";

const STRONG_SECRET = "a".repeat(48);
const OTHER_STRONG_SECRET = "b".repeat(48);
const originalEnv = { ...process.env };

/** The generator's only production caller is a named background writer. */
const SYSTEM: CredentialActor = {
  kind: "system",
  actor: "xero-token-key-generation",
};

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
    async (callback: (client: unknown) => unknown) => callback(mocks.tx),
  );
  mocks.tx.auditLog.create.mockResolvedValue({});
  mocks.prisma.integrationCredential.findUnique.mockResolvedValue(null);
  mocks.tx.integrationCredential.findUnique.mockResolvedValue(null);
  resetIntegrationCredentialCacheForTests();
  delete process.env.NEXTAUTH_SECRET;
  process.env.AUTH_SECRET = STRONG_SECRET;
});
afterEach(() => {
  process.env = { ...originalEnv };
});

describe("ensureGeneratedCredential: create-only / create-or-lose (FIX-6)", () => {
  const P2002 = Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
  });

  it("generates via create (never upsert) when no row exists", async () => {
    mocks.prisma.integrationCredential.findMany.mockResolvedValue([]);
    mocks.tx.integrationCredential.create.mockResolvedValue({});

    const value = await ensureGeneratedCredential({
      provider: "xero",
      key: "token_key",
      label: INTEGRATION_CREDENTIAL_LABEL,
      generate: () => "fresh-generated-key",
      actor: SYSTEM,
    });

    expect(value).toBe("fresh-generated-key");
    expect(mocks.tx.integrationCredential.create).toHaveBeenCalledTimes(1);
    // Genuinely create-only: no last-writer-wins upsert.
    expect(mocks.tx.integrationCredential.upsert).not.toHaveBeenCalled();
  });

  it("on a P2002 create race, returns the winner's value (not ours)", async () => {
    // First resolve: not configured. After the losing create, re-resolve finds
    // the concurrent creator's row.
    mocks.prisma.integrationCredential.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValue([storedRow("xero", "token_key", "winner-key")]);
    mocks.tx.integrationCredential.create.mockRejectedValueOnce(P2002);

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
    expect(mocks.tx.integrationCredential.create).not.toHaveBeenCalled();
    expect(mocks.tx.integrationCredential.updateMany).not.toHaveBeenCalled();
  });

  it("replaces an unreadable (needs_reentry) row via a claim on its whole stale TUPLE", async () => {
    // Row written under AUTH_SECRET, now unreadable because the secret rotated.
    const staleRow = storedRow("xero", "token_key", "dead-material");
    process.env.AUTH_SECRET = OTHER_STRONG_SECRET; // strands the row → needs_reentry
    mocks.prisma.integrationCredential.findMany.mockResolvedValue([staleRow]);
    mocks.prisma.integrationCredential.findUnique.mockResolvedValue(staleRow);
    mocks.tx.integrationCredential.updateMany.mockResolvedValue({ count: 1 });

    const value = await ensureGeneratedCredential({
      provider: "xero",
      key: "token_key",
      label: INTEGRATION_CREDENTIAL_LABEL,
      generate: () => "regenerated-key",
      actor: SYSTEM,
    });

    expect(value).toBe("regenerated-key");
    // THE CLAIM NAMES ALL THREE ENCRYPTED COLUMNS, not the ciphertext alone.
    // An empty plaintext encrypts to an empty ciphertext under every IV
    // (measured), so a ciphertext-only claim is vacuous for that one value and
    // both racers would believe they had won. The iv and authTag are fresh on
    // every encrypt whatever the plaintext.
    expect(mocks.tx.integrationCredential.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          provider: "xero",
          key: "token_key",
          ciphertext: staleRow.ciphertext,
          iv: staleRow.iv,
          authTag: staleRow.authTag,
        }),
      }),
    );
  });

  it("claims the row it READ FROM THE DATABASE, not a cached copy of it", async () => {
    // The store's read cache holds rows for up to the TTL. A claim is only as
    // good as the tuple it names, so the replacement path re-reads the row
    // rather than claiming a version that may already have been replaced.
    const cachedRow = storedRow("xero", "token_key", "dead-material");
    const currentRow = storedRow("xero", "token_key", "also-dead-but-newer");
    process.env.AUTH_SECRET = OTHER_STRONG_SECRET;
    mocks.prisma.integrationCredential.findMany.mockResolvedValue([cachedRow]);
    mocks.prisma.integrationCredential.findUnique.mockResolvedValue(currentRow);
    mocks.tx.integrationCredential.updateMany.mockResolvedValue({ count: 1 });

    await ensureGeneratedCredential({
      provider: "xero",
      key: "token_key",
      label: INTEGRATION_CREDENTIAL_LABEL,
      generate: () => "regenerated-key",
      actor: SYSTEM,
    });

    expect(mocks.tx.integrationCredential.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ciphertext: currentRow.ciphertext }),
      }),
    );
  });

  it("adopts the winner when the replacement claim loses (count 0)", async () => {
    const staleRow = storedRow("xero", "token_key", "dead-material");
    process.env.AUTH_SECRET = OTHER_STRONG_SECRET;
    mocks.prisma.integrationCredential.findUnique.mockResolvedValue(staleRow);
    // Winner already replaced the dead row with material readable under the
    // current secret.
    const winnerRow = storedRow("xero", "token_key", "winner-regenerated");
    mocks.prisma.integrationCredential.findMany
      .mockResolvedValueOnce([staleRow])
      .mockResolvedValue([winnerRow]);
    mocks.tx.integrationCredential.updateMany.mockResolvedValue({ count: 0 });

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
