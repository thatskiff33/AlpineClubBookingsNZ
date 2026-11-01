/**
 * Two-factor secrets and code hashes under the data-encryption key ring (#4456).
 *
 *   - authenticator secrets: `v1` (auth secret) still reads; a ring write is
 *     `v2:<id>:…` under the CURRENT key and survives an AUTH_SECRET rotation;
 *     a `v2` row names its key and is read under that key alone;
 *   - recovery, email and session-challenge hashes: stored under the current
 *     key with its id, found by any ring key, and — the owner's decision of
 *     1 Nov 2026 — recovery codes hashed under the auth secret stop working at
 *     cut-over, and the member holding them is told.
 *
 * The database is a small stateful double keyed on the hash column, so a
 * lookup succeeds only if the hash it computes is the one a write stored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/club-identity-settings", () => ({
  getClubIdentitySync: () => ({ name: "Test Club", bookingsName: "Test Club - Bookings" }),
}));

type CodeRow = { id: string; memberId: string; codeHash: string; usedAt: Date | null };
const db = vi.hoisted(() => ({ recovery: [] as CodeRow[], email: [] as Array<{ id: string; memberId: string; codeHash: string; used: boolean; expiresAt: Date }> }));

function matches(row: { memberId: string; codeHash: string }, where: { memberId?: string; codeHash?: { in: string[] } }) {
  return (where.memberId === undefined || where.memberId === row.memberId) && (where.codeHash?.in.includes(row.codeHash) ?? false);
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    twoFactorRecoveryCode: {
      findFirst: vi.fn(async ({ where }) => db.recovery.find((row) => matches(row, where)) ?? null),
      findMany: vi.fn(async ({ where }) =>
        db.recovery.filter((row) => row.memberId === where.memberId && row.usedAt === null),
      ),
      updateMany: vi.fn(async ({ where }) => {
        const row = db.recovery.find((candidate) => candidate.id === where.id && candidate.usedAt === null);
        if (row) row.usedAt = new Date();
        return { count: row ? 1 : 0 };
      }),
    },
    twoFactorEmailCode: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async ({ data }) => {
        db.email.push({ id: `e${db.email.length}`, used: false, ...data });
        return data;
      }),
      findFirst: vi.fn(async ({ where }) => db.email.find((row) => matches(row, where)) ?? null),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    twoFactorSessionChallenge: {
      deleteMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(async () => ({})),
    },
    $transaction: vi.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
  },
}));

import { prisma } from "@/lib/prisma";
import {
  consumeRecoveryCode,
  consumeTwoFactorSessionChallenge,
  createTwoFactorEmailCode,
  decryptTwoFactorSecret,
  encryptTwoFactorSecret,
  hashRecoveryCode,
  hashTwoFactorCode,
  isRetiredRecoveryCodeHash,
  memberHoldsRetiredRecoveryCodes,
  twoFactorCodeHashCandidates,
  verifyTwoFactorEmailCode,
} from "@/lib/two-factor";
import { codeHashKeyId, twoFactorSecretKeyId } from "@/lib/two-factor-key-format";

function testKey(seed: number): string {
  return Buffer.from(Array.from({ length: 32 }, (_, index) => (seed * 41 + index * 13) % 256)).toString("base64");
}
const K1 = testKey(1);
const K2 = testKey(2);
const AUTH = "two-factor-key-ring-auth-secret-0123456789";

const savedEnv = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  db.recovery.length = 0;
  db.email.length = 0;
  delete process.env.DATA_ENCRYPTION_KEYS;
  delete process.env.NEXTAUTH_SECRET;
  process.env.AUTH_SECRET = AUTH;
});
afterEach(() => {
  process.env = { ...savedEnv };
});

function storeRecoveryCode(memberId: string, code: string) {
  db.recovery.push({ id: `r${db.recovery.length}`, memberId, codeHash: hashRecoveryCode(code), usedAt: null });
}

describe("authenticator secrets: v1 and v2 (#4456)", () => {
  it("with no ring, writes the unchanged v1 format", () => {
    const stored = encryptTwoFactorSecret("BASE32SECRET");
    expect(stored.split(":")).toHaveLength(4);
    expect(stored.startsWith("v1:")).toBe(true);
    expect(decryptTwoFactorSecret(stored)).toBe("BASE32SECRET");
  });

  it("with a ring, writes v2 under the current key, and it survives rotating or removing AUTH_SECRET", () => {
    process.env.DATA_ENCRYPTION_KEYS = `k2:${K2},k1:${K1}`;
    const stored = encryptTwoFactorSecret("BASE32SECRET");
    expect(stored.startsWith("v2:k2:")).toBe(true);
    process.env.AUTH_SECRET = "a-completely-different-auth-secret-value-xyz";
    expect(decryptTwoFactorSecret(stored)).toBe("BASE32SECRET");
    delete process.env.AUTH_SECRET;
    process.env.DATA_ENCRYPTION_KEYS = `k2:${K2}`;
    expect(decryptTwoFactorSecret(stored)).toBe("BASE32SECRET");
  });

  it("still reads a v1 secret once a ring is set", () => {
    const legacy = encryptTwoFactorSecret("LEGACYSECRET");
    process.env.DATA_ENCRYPTION_KEYS = `k1:${K1}`;
    expect(decryptTwoFactorSecret(legacy)).toBe("LEGACYSECRET");
  });

  it("reads a v2 secret under the key it names only, and names a missing key", () => {
    process.env.DATA_ENCRYPTION_KEYS = `k1:${K1}`;
    const underK1 = encryptTwoFactorSecret("K1SECRET");
    process.env.DATA_ENCRYPTION_KEYS = `k2:${K2},k1:${K1}`;
    expect(() => decryptTwoFactorSecret(underK1.replace("v2:k1:", "v2:k2:"))).toThrow();
    expect(() => decryptTwoFactorSecret(underK1.replace("v2:k1:", "v2:legacy-auth-secret:"))).toThrow(
      /Invalid encrypted two-factor secret format/,
    );
    process.env.DATA_ENCRYPTION_KEYS = `k2:${K2}`;
    expect(() => decryptTwoFactorSecret(underK1)).toThrow(/"k1" this two-factor secret was written under is not in DATA_ENCRYPTION_KEYS/);
  });
});

describe("which key a stored secret or hash names, for the readiness counts (#4456 review)", () => {
  it("reads the key id off what the writers actually store", () => {
    expect(twoFactorSecretKeyId(encryptTwoFactorSecret("LEGACY"))).toBe("legacy-auth-secret");
    expect(codeHashKeyId(hashRecoveryCode("AAAA-BBBB-CCCC"))).toBe("legacy-auth-secret");
    process.env.DATA_ENCRYPTION_KEYS = `k2:${K2},k1:${K1}`;
    expect(twoFactorSecretKeyId(encryptTwoFactorSecret("RING"))).toBe("k2");
    expect(codeHashKeyId(hashRecoveryCode("AAAA-BBBB-CCCC"))).toBe("k2");
    for (const unrecognised of ["v2:legacy-auth-secret:a:b:c", "v3:x:a:b:c", "v1:a:b", "plaintext"]) {
      expect(twoFactorSecretKeyId(unrecognised)).toBeNull();
    }
  });
});

describe("code hashes under the ring (#4456)", () => {
  it("with no ring, a hash is the unprefixed legacy HMAC and the only lookup candidate", () => {
    const hash = hashTwoFactorCode("123456");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(twoFactorCodeHashCandidates("123456")).toEqual([hash]);
  });

  it("with a ring, stores under the current key with its id and looks up under every ring key", () => {
    process.env.DATA_ENCRYPTION_KEYS = `k2:${K2},k1:${K1}`;
    const hash = hashTwoFactorCode("123456");
    expect(hash).toMatch(/^k2:[0-9a-f]{64}$/);
    const candidates = twoFactorCodeHashCandidates("123456");
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toBe(hash);
    expect(candidates[1]).toMatch(/^k1:/);
  });

  it("a recovery code issued under one ring key still works after a newer key is added in front", async () => {
    process.env.DATA_ENCRYPTION_KEYS = `k1:${K1}`;
    storeRecoveryCode("member-1", "ABCD-EFGH-IJKL");
    process.env.DATA_ENCRYPTION_KEYS = `k2:${K2},k1:${K1}`;
    process.env.AUTH_SECRET = "rotated-auth-secret-0123456789abcdefghij";
    await expect(consumeRecoveryCode("member-2", "abcd efgh ijkl")).resolves.toBe(false);
    expect(vi.mocked(prisma.twoFactorRecoveryCode.findFirst)).toHaveBeenLastCalledWith({
      where: expect.objectContaining({ memberId: "member-2" }),
    });
    await expect(consumeRecoveryCode("member-1", "abcd efgh ijkl")).resolves.toBe(true);
    await expect(consumeRecoveryCode("member-1", "ABCD-EFGH-IJKL")).resolves.toBe(false);
  });

  it("an email code issued under the ring verifies under the ring", async () => {
    process.env.DATA_ENCRYPTION_KEYS = `k1:${K1}`;
    const { code } = await createTwoFactorEmailCode("member-1");
    expect(db.email[0]?.codeHash).toMatch(/^k1:/);
    await expect(verifyTwoFactorEmailCode("member-1", code)).resolves.toBe(true);
    expect(vi.mocked(prisma.twoFactorEmailCode.findFirst)).toHaveBeenLastCalledWith({
      where: expect.objectContaining({ memberId: "member-1" }),
    });
  });

  it("a session challenge is consumed by any ring key's hash", async () => {
    process.env.DATA_ENCRYPTION_KEYS = `k2:${K2},k1:${K1}`;
    await consumeTwoFactorSessionChallenge("member-1", "raw-token");
    expect(vi.mocked(prisma.twoFactorSessionChallenge.deleteMany)).toHaveBeenCalledWith({
      where: expect.objectContaining({ tokenHash: { in: twoFactorCodeHashCandidates("raw-token") } }),
    });
  });
});

describe("legacy recovery codes are invalidated at cut-over, and the member is told (owner, 1 Nov 2026)", () => {
  it("a code hashed under the auth secret works with no ring and stops working once a ring is set", async () => {
    storeRecoveryCode("member-1", "AAAA-BBBB-CCCC");
    storeRecoveryCode("member-1", "DDDD-EEEE-FFFF");
    await expect(memberHoldsRetiredRecoveryCodes("member-1")).resolves.toBe(false);
    await expect(consumeRecoveryCode("member-1", "AAAA-BBBB-CCCC")).resolves.toBe(true);

    process.env.DATA_ENCRYPTION_KEYS = `k1:${K1}`;
    await expect(consumeRecoveryCode("member-1", "DDDD-EEEE-FFFF")).resolves.toBe(false);
    // ...and the member still holding it is the one the notice is for.
    await expect(memberHoldsRetiredRecoveryCodes("member-1")).resolves.toBe(true);
    await expect(memberHoldsRetiredRecoveryCodes("member-2")).resolves.toBe(false);
  });

  it("a member who regenerated under the ring is not told", async () => {
    process.env.DATA_ENCRYPTION_KEYS = `k1:${K1}`;
    storeRecoveryCode("member-1", "AAAA-BBBB-CCCC");
    await expect(memberHoldsRetiredRecoveryCodes("member-1")).resolves.toBe(false);
  });

  it("a ring code becomes retired when its key leaves the ring", () => {
    process.env.DATA_ENCRYPTION_KEYS = `k1:${K1}`;
    const underK1 = hashRecoveryCode("AAAA-BBBB-CCCC");
    const legacy = `${"0".repeat(64)}`;
    expect(isRetiredRecoveryCodeHash(underK1)).toBe(false);
    expect(isRetiredRecoveryCodeHash(legacy)).toBe(true);
    process.env.DATA_ENCRYPTION_KEYS = `k2:${K2}`;
    expect(isRetiredRecoveryCodeHash(underK1)).toBe(true);
    delete process.env.DATA_ENCRYPTION_KEYS;
    expect(isRetiredRecoveryCodeHash(legacy)).toBe(false);
  });

  it("an invalid ring makes the advisory notice answer false rather than break the page", async () => {
    storeRecoveryCode("member-1", "AAAA-BBBB-CCCC");
    process.env.DATA_ENCRYPTION_KEYS = "k1:short";
    await expect(memberHoldsRetiredRecoveryCodes("member-1")).resolves.toBe(false);
  });
});
