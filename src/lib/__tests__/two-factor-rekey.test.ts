/**
 * The data-key re-encrypt's two writers of a member's second factor (#4456 PR 2).
 *
 *   - re-wrapping an authenticator secret: the same secret under the current
 *     ring key, claimed on the exact stored value, audited as the job;
 *   - retiring legacy recovery codes (owner decision, 1 Nov 2026): unused codes
 *     hashed under the auth secret stop matching on every release, ring or not,
 *     while staying unused so the member is still told to regenerate.
 *
 * Real crypto; the database is a small stateful double that applies each
 * guarded `where` literally, so a claim on a stale value matches nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/club-identity-settings", () => ({
  getClubIdentitySync: () => ({ name: "Test Club", bookingsName: "Test Club - Bookings" }),
}));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn(async () => undefined) }));

type CodeRow = { id: string; memberId: string; codeHash: string; usedAt: Date | null };
type CodeWhere = {
  id?: string;
  memberId?: string;
  usedAt?: null;
  codeHash?: string | { in?: string[]; contains?: string };
  NOT?: CodeWhere;
};
const db = vi.hoisted(() => ({
  members: new Map<string, string | null>(),
  codes: [] as CodeRow[],
  /** test seam: runs once just before the next code claim, to race it. */
  beforeCodeClaim: null as null | (() => void),
}));

function codeMatches(row: CodeRow, where: CodeWhere): boolean {
  const hash = where.codeHash;
  return (
    (where.id === undefined || where.id === row.id) &&
    (where.memberId === undefined || where.memberId === row.memberId) &&
    (where.usedAt === undefined || row.usedAt === null) &&
    (hash === undefined ||
      (typeof hash === "string"
        ? hash === row.codeHash
        : (hash.in === undefined || hash.in.includes(row.codeHash)) &&
          (hash.contains === undefined || row.codeHash.includes(hash.contains)))) &&
    (where.NOT === undefined || !codeMatches(row, where.NOT))
  );
}

vi.mock("@/lib/prisma", () => {
  const client = {
    member: {
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; totpSecret?: string }; data: { totpSecret: string } }) => {
        if (!db.members.has(where.id)) return { count: 0 };
        if (where.totpSecret !== undefined && db.members.get(where.id) !== where.totpSecret) return { count: 0 };
        db.members.set(where.id, data.totpSecret);
        return { count: 1 };
      }),
    },
    twoFactorRecoveryCode: {
      findMany: vi.fn(async ({ where }: { where: CodeWhere }) => db.codes.filter((row) => codeMatches(row, where))),
      findFirst: vi.fn(async ({ where }: { where: CodeWhere }) => db.codes.find((row) => codeMatches(row, where)) ?? null),
      updateMany: vi.fn(async ({ where, data }: { where: CodeWhere; data: Partial<CodeRow> }) => {
        db.beforeCodeClaim?.();
        db.beforeCodeClaim = null;
        const rows = db.codes.filter((row) => codeMatches(row, where));
        for (const row of rows) Object.assign(row, data.usedAt === undefined ? data : { usedAt: new Date() });
        return { count: rows.length };
      }),
    },
    auditLog: {},
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(client)),
  };
  return { prisma: client };
});

import { createAuditLog } from "@/lib/audit";
import { DataKeyRingError } from "@/lib/data-encryption-key-material";
import {
  consumeRecoveryCode,
  decryptTwoFactorSecret,
  encryptTwoFactorSecret,
  hashRecoveryCode,
  memberHoldsRetiredRecoveryCodes,
} from "@/lib/two-factor";
import { retireLegacyRecoveryCodes, rewrapTwoFactorSecret } from "@/lib/two-factor-rekey";

function testKey(seed: number): string {
  return Buffer.from(Array.from({ length: 32 }, (_, index) => (seed * 41 + index * 23) % 256)).toString("base64");
}
const RING = `k1:${testKey(1)}`;
const AUTH = "auth-secret-for-two-factor-rekey-tests-0123456789";
const SECRET = "JBSWY3DPEHPK3PXP";

const savedEnv = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  db.members.clear();
  db.codes = [];
  db.beforeCodeClaim = null;
  process.env.AUTH_SECRET = AUTH;
  delete process.env.NEXTAUTH_SECRET;
  delete process.env.DATA_ENCRYPTION_KEYS;
  delete process.env.DATA_ENCRYPTION_LEGACY_KEY;
});
afterEach(() => {
  process.env = { ...savedEnv };
});

const auditActions = () => vi.mocked(createAuditLog).mock.calls.map(([row]) => row.action);

describe("re-wrapping an authenticator secret (#4456 PR 2)", () => {
  it("moves a legacy secret to the current ring key, the same secret, with one audit row", async () => {
    const legacy = encryptTwoFactorSecret(SECRET);
    db.members.set("m1", legacy);
    process.env.DATA_ENCRYPTION_KEYS = RING;

    await expect(rewrapTwoFactorSecret("m1", legacy)).resolves.toBe("moved");

    const stored = db.members.get("m1")!;
    expect(stored).toMatch(/^v2:k1:/);
    process.env.AUTH_SECRET = `${AUTH}-rotated`;
    expect(decryptTwoFactorSecret(stored)).toBe(SECRET);
    expect(auditActions()).toEqual(["security.two_factor.secret_rewrapped"]);
    const row = vi.mocked(createAuditLog).mock.calls[0]![0];
    expect(row).toMatchObject({ subjectMemberId: "m1", memberId: null, actorMemberId: null });
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(JSON.stringify(row)).not.toContain(stored);
  });

  it("loses its claim, writing and auditing nothing, when the secret changed after it was read", async () => {
    const read = encryptTwoFactorSecret(SECRET);
    process.env.DATA_ENCRYPTION_KEYS = RING;
    const reEnrolled = encryptTwoFactorSecret("NEWSECRETNEWSECR");
    db.members.set("m1", reEnrolled);

    await expect(rewrapTwoFactorSecret("m1", read)).resolves.toBe("lost-claim");

    expect(db.members.get("m1")).toBe(reEnrolled);
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it("calls a secret it cannot decrypt unreadable and writes nothing", async () => {
    process.env.DATA_ENCRYPTION_KEYS = `gone:${testKey(9)}`;
    const underRemovedKey = encryptTwoFactorSecret(SECRET);
    db.members.set("m1", underRemovedKey);
    process.env.DATA_ENCRYPTION_KEYS = RING;

    await expect(rewrapTwoFactorSecret("m1", underRemovedKey)).resolves.toBe("unreadable");
    expect(db.members.get("m1")).toBe(underRemovedKey);
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it("refuses with no ring, so it can never write under the auth secret", async () => {
    const legacy = encryptTwoFactorSecret(SECRET);
    db.members.set("m1", legacy);

    await expect(rewrapTwoFactorSecret("m1", legacy)).rejects.toBeInstanceOf(DataKeyRingError);
    expect(db.members.get("m1")).toBe(legacy);
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it("names the legacy-read switch when a legacy secret is read under it", () => {
    const legacy = encryptTwoFactorSecret(SECRET);
    process.env.DATA_ENCRYPTION_KEYS = RING;
    process.env.DATA_ENCRYPTION_LEGACY_KEY = "retired";
    expect(() => decryptTwoFactorSecret(legacy)).toThrow(
      /stored under AUTH_SECRET, which DATA_ENCRYPTION_LEGACY_KEY has retired for reads/,
    );
  });
});

describe("retiring legacy recovery codes (#4456 PR 2, owner decision of 1 Nov 2026)", () => {
  function seedCodes() {
    // Legacy codes, issued before the ring.
    const legacyCode = "AAAA-BBBB-CCCC";
    db.codes.push(
      { id: "c1", memberId: "m1", codeHash: hashRecoveryCode(legacyCode), usedAt: null },
      { id: "c2", memberId: "m1", codeHash: hashRecoveryCode("DDDD-EEEE-FFFF"), usedAt: null },
      { id: "c3", memberId: "m1", codeHash: hashRecoveryCode("1111-2222-3333"), usedAt: new Date(0) },
    );
    process.env.DATA_ENCRYPTION_KEYS = RING;
    // A code issued under the ring.
    db.codes.push({ id: "c4", memberId: "m1", codeHash: hashRecoveryCode("4444-5555-6666"), usedAt: null });
    return legacyCode;
  }

  it("retires only the unused legacy codes, with one audit row carrying the count", async () => {
    seedCodes();
    const before = db.codes.map((row) => ({ ...row }));

    await expect(retireLegacyRecoveryCodes("m1")).resolves.toBe(2);

    expect(db.codes.find((row) => row.id === "c1")!.codeHash).toBe(`retired.legacy-auth-secret:${before[0]!.codeHash}`);
    expect(db.codes.find((row) => row.id === "c2")!.codeHash).toBe(`retired.legacy-auth-secret:${before[1]!.codeHash}`);
    expect(db.codes.find((row) => row.id === "c3")).toEqual(before[2]);
    expect(db.codes.find((row) => row.id === "c4")).toEqual(before[3]);
    expect(db.codes.every((row) => row.id === "c3" || row.usedAt === null)).toBe(true);
    expect(auditActions()).toEqual(["security.two_factor.recovery_codes_retired"]);
    expect(vi.mocked(createAuditLog).mock.calls[0]![0].metadata).toMatchObject({ recoveryCodesRetired: 2 });
  });

  it("a retired code signs no one in on any instance, ring or not, and still tells its member", async () => {
    const legacyCode = seedCodes();
    await retireLegacyRecoveryCodes("m1");

    expect(await consumeRecoveryCode("m1", legacyCode)).toBe(false);
    // The instance without the ring, which still computes the legacy hash.
    delete process.env.DATA_ENCRYPTION_KEYS;
    expect(await consumeRecoveryCode("m1", legacyCode)).toBe(false);
    expect(await memberHoldsRetiredRecoveryCodes("m1")).toBe(true);
    process.env.DATA_ENCRYPTION_KEYS = RING;
    expect(await memberHoldsRetiredRecoveryCodes("m1")).toBe(true);
    // The witness: an unretired legacy code is still accepted without the ring.
    delete process.env.DATA_ENCRYPTION_KEYS;
    db.codes.push({ id: "c9", memberId: "m2", codeHash: hashRecoveryCode(legacyCode), usedAt: null });
    expect(await consumeRecoveryCode("m2", legacyCode)).toBe(true);
  });

  it("counts only codes it actually claimed: one used meanwhile is not retired", async () => {
    seedCodes();
    db.beforeCodeClaim = () => {
      db.codes.find((row) => row.id === "c1")!.usedAt = new Date();
    };

    await expect(retireLegacyRecoveryCodes("m1")).resolves.toBe(1);
    expect(db.codes.find((row) => row.id === "c1")!.codeHash).not.toMatch(/^retired\./);
    expect(vi.mocked(createAuditLog).mock.calls[0]![0].metadata).toMatchObject({ recoveryCodesRetired: 1 });
  });

  it("a code retired between its lookup and its use is not used: the two claims exclude each other (C2)", async () => {
    const legacyCode = "AAAA-BBBB-CCCC";
    // The instance without the ring, where the legacy code still matches.
    db.codes.push({ id: "c1", memberId: "m1", codeHash: hashRecoveryCode(legacyCode), usedAt: null });
    db.beforeCodeClaim = () => {
      const row = db.codes.find((candidate) => candidate.id === "c1")!;
      row.codeHash = `retired.legacy-auth-secret:${row.codeHash}`;
    };

    await expect(consumeRecoveryCode("m1", legacyCode)).resolves.toBe(false);
    expect(db.codes[0]!.usedAt).toBeNull();
  });

  it("records nothing for a member with no legacy codes", async () => {
    process.env.DATA_ENCRYPTION_KEYS = RING;
    db.codes.push({ id: "c1", memberId: "m1", codeHash: hashRecoveryCode("4444-5555-6666"), usedAt: null });

    await expect(retireLegacyRecoveryCodes("m1")).resolves.toBe(0);
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it("refuses with no ring", async () => {
    await expect(retireLegacyRecoveryCodes("m1")).rejects.toBeInstanceOf(DataKeyRingError);
  });
});

