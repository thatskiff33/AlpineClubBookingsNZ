/**
 * `pnpm run data-keys:reencrypt`'s library (#4456 PR 2): what it refuses, what
 * it moves and through which writer, how a lost claim is retried, what a dry
 * run leaves alone, and that nothing it reports carries a stored value.
 *
 * The writers are mocked at their module boundary — the store's own
 * compare-and-set is proved by `credential-write-contract.test.ts` and against
 * PostgreSQL by `data-encryption-key-ring.realdb.test.ts`, which also races a
 * real Xero refresh against this command.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  credentialRows: [] as Array<{ provider: string; key: string }>,
  memberRows: [] as Array<{ id: string; totpSecret: string }>,
  legacyHolders: [] as Array<{ memberId: string }>,
  counts: { credentials: 0, secrets: 0, legacyCodes: 0, olderCodes: 0 },
  prisma: {
    integrationCredential: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
    member: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
    twoFactorRecoveryCode: { findMany: vi.fn(), count: vi.fn() },
  },
  withCredentialTransaction: vi.fn(),
  readIntegrationCredentialRow: vi.fn(),
  setIntegrationCredentialInTransaction: vi.fn(),
  rewrapTwoFactorSecret: vi.fn(),
  retireLegacyRecoveryCodes: vi.fn(),
  fenceXeroTokenSetRewrite: vi.fn(),
  decryptTwoFactorSecret: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/integration-credentials", () => ({
  withCredentialTransaction: mocks.withCredentialTransaction,
  readIntegrationCredentialRow: mocks.readIntegrationCredentialRow,
  setIntegrationCredentialInTransaction: mocks.setIntegrationCredentialInTransaction,
}));
vi.mock("@/lib/two-factor-rekey", () => ({
  LEGACY_RECOVERY_CODE_WHERE: { NOT: { codeHash: { contains: ":" } } },
  rewrapTwoFactorSecret: mocks.rewrapTwoFactorSecret,
  retireLegacyRecoveryCodes: mocks.retireLegacyRecoveryCodes,
}));
vi.mock("@/lib/two-factor", () => ({ decryptTwoFactorSecret: mocks.decryptTwoFactorSecret }));
// A stored row's version is a hash of its encrypted columns; the double's rows
// carry it directly, so the stamp read can match (or not) the read before it.
vi.mock("@/lib/integration-credential-actor", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/integration-credential-actor");
  return {
    ...actual,
    credentialVersionOf: (row: { version?: string; ciphertext: string; iv: string; authTag: string }) =>
      row.version ?? actual.credentialVersionOf(row),
  };
});
vi.mock("@/lib/xero-token-store", () => ({
  XERO_OAUTH_TOKEN_PROVIDER: "xero-oauth",
  fenceXeroTokenSetRewrite: mocks.fenceXeroTokenSetRewrite,
}));

import {
  formatReencryptReport,
  reencryptLeftRows,
  reencryptStoredData,
  ReencryptRefusedError,
  type ReencryptOptions,
} from "@/lib/data-encryption-reencrypt";
import { StaleCredentialWriteError } from "@/lib/integration-credential-actor";

function testKey(seed: number): string {
  return Buffer.from(Array.from({ length: 32 }, (_, index) => (seed * 47 + index * 13) % 256)).toString("base64");
}
const K_NEW = testKey(2);
const RING = `k_2:${K_NEW},k1:${testKey(1)}`;
/** Sentinels: none may appear in a report, a line or an error. */
const PLAINTEXT = "sentinel-plaintext-credential-value";
const STORED_TOTP = "v1:sentinel-iv:sentinel-tag:sentinel-ciphertext";

const pause = vi.fn(async () => undefined);
const run = (overrides: Partial<ReencryptOptions> = {}) =>
  reencryptStoredData({ dryRun: false, retireLegacyRecoveryCodes: false, pause, ...overrides });

/** The row's own timestamp, which the move keeps (#4456 review C3). */
const STAMP = new Date("2026-06-01T00:00:00.000Z");
/** The stamp read: by default the same row the `stored` read just resolved. */
async function sameRowAsStored() {
  const last = mocks.readIntegrationCredentialRow.mock.results.at(-1);
  const stored = (await last?.value) as { version?: string } | undefined;
  return { ciphertext: "c", iv: "i", authTag: "t", updatedAt: STAMP, version: stored?.version };
}
const TX = { integrationCredential: { findUnique: vi.fn(sameRowAsStored) } };
function configured(secretSource = "AUTH_SECRET", version = "v-1") {
  return { status: "configured", value: PLAINTEXT, secretSource, sourceFlipped: false, labelVersion: "l", version };
}

const savedEnv = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_SECRET = "auth-secret-for-reencrypt-tests-0123456789abcd";
  process.env.DATA_ENCRYPTION_KEYS = RING;
  delete process.env.DATA_ENCRYPTION_LEGACY_KEY;
  mocks.credentialRows = [];
  mocks.memberRows = [];
  mocks.legacyHolders = [];
  mocks.counts = { credentials: 0, secrets: 0, legacyCodes: 0, olderCodes: 0 };
  mocks.prisma.integrationCredential.findMany.mockImplementation(async () => mocks.credentialRows);
  mocks.prisma.integrationCredential.count.mockImplementation(async () => mocks.counts.credentials);
  mocks.prisma.member.findMany.mockImplementation(async () => mocks.memberRows);
  // The key check's lookups (a row already under the target id) find nothing
  // by default: the first cut-over. Tests below arrange one.
  mocks.prisma.integrationCredential.findFirst.mockResolvedValue(null);
  mocks.prisma.member.findFirst.mockImplementation(async ({ where }: { where: { id?: string } }) =>
    where.id === undefined ? null : (mocks.memberRows.find((row) => row.id === where.id) ?? null),
  );
  mocks.prisma.member.count.mockImplementation(async () => mocks.counts.secrets);
  mocks.prisma.twoFactorRecoveryCode.findMany.mockImplementation(async () => mocks.legacyHolders);
  mocks.prisma.twoFactorRecoveryCode.count.mockImplementation(async ({ where }: { where: { codeHash?: unknown } }) =>
    where.codeHash === undefined ? mocks.counts.legacyCodes : mocks.counts.olderCodes,
  );
  mocks.withCredentialTransaction.mockImplementation(async (_providers: string[], work: (tx: unknown) => Promise<unknown>) =>
    work(TX),
  );
  mocks.readIntegrationCredentialRow.mockImplementation(async () => configured());
  mocks.setIntegrationCredentialInTransaction.mockResolvedValue({});
  mocks.fenceXeroTokenSetRewrite.mockResolvedValue(true);
  mocks.rewrapTwoFactorSecret.mockResolvedValue("moved");
  mocks.retireLegacyRecoveryCodes.mockResolvedValue(0);
  mocks.decryptTwoFactorSecret.mockReturnValue("JBSWY3DPEHPK3PXP");
});
afterEach(() => {
  process.env = { ...savedEnv };
});

function noWrites() {
  expect(mocks.withCredentialTransaction).not.toHaveBeenCalled();
  expect(mocks.setIntegrationCredentialInTransaction).not.toHaveBeenCalled();
  expect(mocks.rewrapTwoFactorSecret).not.toHaveBeenCalled();
  expect(mocks.retireLegacyRecoveryCodes).not.toHaveBeenCalled();
}

describe("refusal: no ring, or an invalid one (#4456 PR 2)", () => {
  it("refuses with no ring, before reading anything", async () => {
    delete process.env.DATA_ENCRYPTION_KEYS;
    await expect(run()).rejects.toThrow(ReencryptRefusedError);
    await expect(run()).rejects.toThrow(/DATA_ENCRYPTION_KEYS is not set, so there is no key to move stored data to/);
    expect(mocks.prisma.integrationCredential.findMany).not.toHaveBeenCalled();
    noWrites();
  });

  it("refuses an invalid ring, naming why and never the key", async () => {
    process.env.DATA_ENCRYPTION_KEYS = `k1:${K_NEW},k1:${K_NEW}`;
    const error = (await run().catch((caught: unknown) => caught)) as Error;
    expect(error).toBeInstanceOf(ReencryptRefusedError);
    expect(error.message).toMatch(/^Refused: DATA_ENCRYPTION_KEYS: the id "k1" appears more than once/);
    expect(error.message).not.toContain(K_NEW);
    noWrites();
  });

  it("refuses the legacy-read switch set without a ring", async () => {
    delete process.env.DATA_ENCRYPTION_KEYS;
    process.env.DATA_ENCRYPTION_LEGACY_KEY = "retired";
    await expect(run()).rejects.toThrow(/DATA_ENCRYPTION_LEGACY_KEY=retired needs DATA_ENCRYPTION_KEYS/);
    noWrites();
  });
});

describe("moving credentials (#4456 PR 2)", () => {
  it("selects every row not under the current key, matched literally, and moves each through the store's compare-and-set", async () => {
    mocks.credentialRows = [
      { provider: "stripe", key: "secret_key" },
      { provider: "xero", key: "client_secret" },
    ];
    mocks.readIntegrationCredentialRow
      .mockResolvedValueOnce(configured("AUTH_SECRET", "ver-a"))
      .mockResolvedValueOnce(configured("DATA_ENCRYPTION_KEY:k1", "ver-b"));

    const report = await run();

    expect(mocks.prisma.integrationCredential.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { NOT: { secretSource: "DATA_ENCRYPTION_KEY:k_2" } } }),
    );
    expect(mocks.withCredentialTransaction.mock.calls.map(([providers]) => providers)).toEqual([["stripe"], ["xero"]]);
    expect(mocks.setIntegrationCredentialInTransaction.mock.calls.map(([params]) => params)).toEqual([
      {
        tx: TX,
        provider: "stripe",
        key: "secret_key",
        value: PLAINTEXT,
        actor: { kind: "system", actor: "data-key-reencrypt" },
        expect: { expect: "version", version: "ver-a" },
        cause: { kind: "data-key-reencrypt" },
        keepUpdatedAt: STAMP,
      },
      expect.objectContaining({ provider: "xero", key: "client_secret", expect: { expect: "version", version: "ver-b" } }),
    ]);
    // Read on the claim's own transaction, not the cache.
    expect(mocks.readIntegrationCredentialRow).toHaveBeenCalledWith(TX, "stripe", "secret_key");
    expect(report.credentials).toEqual({ moved: 2, lostClaims: 0, unreadable: 0, remaining: 0 });
    expect(mocks.fenceXeroTokenSetRewrite).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
  });

  it("a lost claim writes nothing more, and is retried on the next pass after a pause", async () => {
    mocks.credentialRows = [{ provider: "stripe", key: "secret_key" }];
    mocks.setIntegrationCredentialInTransaction.mockRejectedValueOnce(
      new StaleCredentialWriteError({ provider: "stripe", key: "secret_key", expectation: { expect: "version", version: "v-1" }, observedVersion: "v-2" }),
    );

    const report = await run();

    expect(mocks.setIntegrationCredentialInTransaction).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenCalledExactlyOnceWith(2_000);
    expect(report.passes).toBe(2);
    expect(report.credentials).toMatchObject({ moved: 1, lostClaims: 0 });
  });

  it("reports what still loses after the last pass, and says to run again", async () => {
    mocks.credentialRows = [{ provider: "stripe", key: "secret_key" }];
    mocks.counts.credentials = 1;
    mocks.setIntegrationCredentialInTransaction.mockRejectedValue(
      new StaleCredentialWriteError({ provider: "stripe", key: "secret_key", expectation: { expect: "version", version: "v-1" }, observedVersion: null }),
    );

    const report = await run({ maxPasses: 3 });

    expect(mocks.setIntegrationCredentialInTransaction).toHaveBeenCalledTimes(3);
    expect(report.credentials).toEqual({ moved: 0, lostClaims: 1, unreadable: 0, remaining: 1 });
    expect(reencryptLeftRows(report)).toBe(true);
    expect(formatReencryptReport(report)).toContain(
      "Some rows changed while being moved (for example a Xero token refresh). Run again to move them.",
    );
  });

  it("fences the Xero token set on the token store's lease rows first, and treats a held lease as a lost claim", async () => {
    mocks.credentialRows = [{ provider: "xero-oauth", key: "token-set" }];
    mocks.fenceXeroTokenSetRewrite.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const report = await run();

    expect(mocks.fenceXeroTokenSetRewrite).toHaveBeenCalledTimes(2);
    expect(mocks.fenceXeroTokenSetRewrite.mock.calls[0]![0]).toBe(TX);
    // The held lease: nothing read, nothing written, on the first pass.
    expect(mocks.readIntegrationCredentialRow).toHaveBeenCalledTimes(1);
    expect(mocks.setIntegrationCredentialInTransaction).toHaveBeenCalledTimes(1);
    expect(report.credentials).toMatchObject({ moved: 1, lostClaims: 0 });
    // The fence came before the read on the pass that moved it.
    expect(mocks.fenceXeroTokenSetRewrite.mock.invocationCallOrder[1]!).toBeLessThan(
      mocks.readIntegrationCredentialRow.mock.invocationCallOrder[0]!,
    );
  });

  it("leaves an unreadable row, a vanished row and one already moved alone", async () => {
    mocks.credentialRows = [
      { provider: "a", key: "unreadable" },
      { provider: "a", key: "gone" },
      { provider: "a", key: "moved-meanwhile" },
    ];
    mocks.readIntegrationCredentialRow
      .mockResolvedValueOnce({ status: "needs_reentry", reason: "r", version: "v" })
      .mockResolvedValueOnce({ status: "not_configured" })
      .mockResolvedValueOnce(configured("DATA_ENCRYPTION_KEY:k_2"));

    const report = await run();

    expect(mocks.setIntegrationCredentialInTransaction).not.toHaveBeenCalled();
    expect(report.credentials).toMatchObject({ moved: 0, lostClaims: 0, unreadable: 1 });
    expect(pause).not.toHaveBeenCalled();
  });

  it("lets any other error stop the run", async () => {
    mocks.credentialRows = [{ provider: "a", key: "b" }];
    mocks.setIntegrationCredentialInTransaction.mockRejectedValueOnce(new Error("database went away"));
    await expect(run()).rejects.toThrow("database went away");
  });
});

describe("moving authenticator secrets (#4456 PR 2)", () => {
  it("selects secrets not under the current key with a literal prefix, and re-reads each before its claim", async () => {
    mocks.memberRows = [{ id: "m1", totpSecret: STORED_TOTP }];
    mocks.rewrapTwoFactorSecret.mockResolvedValueOnce("lost-claim").mockResolvedValueOnce("moved");

    const report = await run();

    expect(mocks.prisma.member.findMany.mock.calls[0]![0].select).toEqual({ id: true });
    const where = mocks.prisma.member.findMany.mock.calls[0]![0].where;
    expect(where).toEqual({
      AND: [{ totpSecret: { not: null } }, { NOT: { totpSecret: { startsWith: "v2:k\\_2:" } } }],
    });
    // Per-member re-reads only (the key check's lookup names no id).
    expect(mocks.prisma.member.findFirst.mock.calls.filter(([args]) => args.where.id === "m1")).toHaveLength(2);
    expect(mocks.rewrapTwoFactorSecret.mock.calls).toEqual([
      ["m1", STORED_TOTP],
      ["m1", STORED_TOTP],
    ]);
    expect(report.authenticatorSecrets).toMatchObject({ moved: 1, lostClaims: 0 });
  });

  it("skips a member whose secret was moved or cleared meanwhile, and counts an unreadable one", async () => {
    mocks.memberRows = [
      { id: "m1", totpSecret: STORED_TOTP },
      { id: "m2", totpSecret: STORED_TOTP },
    ];
    // m1's secret was moved or cleared meanwhile; m2's is still there.
    mocks.prisma.member.findFirst.mockImplementation(async ({ where }: { where: { id?: string } }) =>
      where.id === "m2" ? { totpSecret: STORED_TOTP } : null,
    );
    mocks.rewrapTwoFactorSecret.mockResolvedValueOnce("unreadable");

    const report = await run();

    expect(mocks.rewrapTwoFactorSecret).toHaveBeenCalledExactlyOnceWith("m2", STORED_TOTP);
    expect(report.authenticatorSecrets).toMatchObject({ moved: 0, unreadable: 1 });
    expect(formatReencryptReport(report).join("\n")).toMatch(/Unreadable rows cannot be moved/);
  });
});

describe("legacy recovery codes (#4456 PR 2, owner decision of 1 Nov 2026)", () => {
  it("counts them but retires nothing unless asked", async () => {
    mocks.counts.legacyCodes = 7;
    const report = await run();
    expect(mocks.retireLegacyRecoveryCodes).not.toHaveBeenCalled();
    expect(report.recoveryCodes).toEqual({ legacyUnused: 7, retired: 0, olderRingKeyUnused: 0 });
    expect(formatReencryptReport(report).join("\n")).toMatch(/Run with --retire-legacy-recovery-codes/);
  });

  it("retires them member by member when asked", async () => {
    mocks.legacyHolders = [{ memberId: "m1" }, { memberId: "m2" }];
    mocks.retireLegacyRecoveryCodes.mockResolvedValueOnce(3).mockResolvedValueOnce(2);

    const report = await run({ retireLegacyRecoveryCodes: true });

    expect(mocks.retireLegacyRecoveryCodes.mock.calls).toEqual([["m1"], ["m2"]]);
    expect(mocks.prisma.twoFactorRecoveryCode.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { usedAt: null, NOT: { codeHash: { contains: ":" } } },
        distinct: ["memberId"],
      }),
    );
    expect(report.recoveryCodes.retired).toBe(5);
    expect(formatReencryptReport(report)).toContain("TwoFactorRecoveryCode: legacy (AUTH_SECRET) unused: 0; retired 5");
  });

  it("counts unused codes under an older ring key, which keep that key needed", async () => {
    mocks.counts.olderCodes = 4;
    const report = await run();
    expect(report.recoveryCodes.olderRingKeyUnused).toBe(4);
    // Ring codes only (a `:`), minus the current key's and the retired ones, matched literally.
    expect(mocks.prisma.twoFactorRecoveryCode.count).toHaveBeenCalledWith({
      where: {
        usedAt: null,
        codeHash: { contains: ":" },
        NOT: [
          { codeHash: { startsWith: "k\\_2:" } },
          { codeHash: { startsWith: "retired.legacy-auth-secret:" } },
        ],
      },
    });
    expect(mocks.prisma.twoFactorRecoveryCode.count).toHaveBeenCalledWith({
      where: { usedAt: null, NOT: { codeHash: { contains: ":" } } },
    });
    expect(formatReencryptReport(report).join("\n")).toMatch(/Keep each older key in the ring/);
  });
});

describe("a dry run writes nothing (#4456 PR 2)", () => {
  it("reads, counts what would move, and claims, fences, re-wraps and retires nothing", async () => {
    mocks.credentialRows = [
      { provider: "xero-oauth", key: "token-set" },
      { provider: "a", key: "dead" },
    ];
    mocks.readIntegrationCredentialRow
      .mockResolvedValueOnce(configured())
      .mockResolvedValueOnce({ status: "needs_reentry", reason: "r", version: "v" });
    mocks.memberRows = [{ id: "m1", totpSecret: STORED_TOTP }];
    mocks.counts = { credentials: 2, secrets: 1, legacyCodes: 6, olderCodes: 0 };

    const report = await run({ dryRun: true, retireLegacyRecoveryCodes: true });

    noWrites();
    expect(mocks.fenceXeroTokenSetRewrite).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      dryRun: true,
      credentials: { moved: 1, unreadable: 1, remaining: 2 },
      authenticatorSecrets: { moved: 1, remaining: 1 },
      recoveryCodes: { legacyUnused: 6, retired: 6 },
    });
    const lines = formatReencryptReport(report);
    expect(lines[0]).toMatch(/to the key "k_2" \(dry run: nothing written\)/);
    expect(lines).toContain("IntegrationCredential: would move 1, lost claim 0, unreadable 1");
    expect(lines).toContain("TwoFactorRecoveryCode: legacy (AUTH_SECRET) unused: 6; would retire 6");
  });
});

describe("the report (#4456 PR 2)", () => {
  it("states what remains per table, and carries no stored value anywhere", async () => {
    mocks.credentialRows = [{ provider: "stripe", key: "secret_key" }];
    mocks.memberRows = [{ id: "m1", totpSecret: STORED_TOTP }];
    mocks.counts = { credentials: 0, secrets: 0, legacyCodes: 0, olderCodes: 0 };

    const report = await run();
    const lines = formatReencryptReport(report);

    expect(lines).toEqual([
      'Data-encryption re-encrypt to the key "k_2", 1 pass.',
      expect.stringMatching(
        /^Key "k_2", fingerprint [0-9a-f]{4}(-[0-9a-f]{4}){3}: NOT CHECKED, nothing is stored under it yet\. Compare this fingerprint with Admin → Setup/,
      ),
      "IntegrationCredential: moved 1, lost claim 0, unreadable 0",
      "IntegrationCredential: remaining on old keys: 0",
      "Member.totpSecret: moved 1, lost claim 0, unreadable 0",
      "Member.totpSecret: remaining on old keys: 0",
      "TwoFactorRecoveryCode: legacy (AUTH_SECRET) unused: 0",
      "TwoFactorRecoveryCode: unused under an older ring key: 0",
      "No credential or authenticator secret is left on AUTH_SECRET or an older key. You can rotate AUTH_SECRET, and set DATA_ENCRYPTION_LEGACY_KEY=retired to stop reading anything under it.",
    ]);
    expect(reencryptLeftRows(report)).toBe(false);
    const everything = JSON.stringify(report) + lines.join("\n");
    for (const value of [PLAINTEXT, STORED_TOTP, "sentinel", K_NEW, process.env.AUTH_SECRET!]) {
      expect(everything).not.toContain(value);
    }
  });
});

describe("the command proves its key is the app's before writing (#4456 review S1)", () => {
  it("refuses, writing nothing, when a row the app stored under the target id cannot be read here", async () => {
    mocks.credentialRows = [{ provider: "stripe", key: "secret_key" }];
    mocks.prisma.integrationCredential.findFirst.mockResolvedValue({ provider: "xero", key: "client_id" });
    mocks.readIntegrationCredentialRow.mockResolvedValueOnce({ status: "needs_reentry", reason: "r", version: "v" });

    const error = (await run().catch((caught: unknown) => caught)) as Error;

    expect(error).toBeInstanceOf(ReencryptRefusedError);
    expect(error.message).toMatch(/^Refused before writing anything: data the app stored under the key "k_2" cannot be read/);
    expect(error.message).toMatch(/the \.env in the current directory/);
    expect(error.message).not.toContain(K_NEW);
    expect(mocks.prisma.integrationCredential.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { secretSource: "DATA_ENCRYPTION_KEY:k_2" } }),
    );
    expect(mocks.readIntegrationCredentialRow).toHaveBeenCalledExactlyOnceWith(expect.anything(), "xero", "client_id");
    noWrites();
  });

  it("refuses on an authenticator secret under the target id it cannot decrypt, when no credential names it", async () => {
    mocks.prisma.member.findFirst.mockImplementation(async ({ where }: { where: { id?: string } }) =>
      where.id === undefined ? { totpSecret: "v2:k_2:aa:bb:cc" } : null,
    );
    mocks.decryptTwoFactorSecret.mockImplementationOnce(() => {
      throw new Error("Unsupported state or unable to authenticate data");
    });
    await expect(run()).rejects.toThrow(ReencryptRefusedError);
    noWrites();
  });

  it("says which stored row proved the key, before moving anything", async () => {
    mocks.credentialRows = [{ provider: "stripe", key: "secret_key" }];
    mocks.prisma.integrationCredential.findFirst.mockResolvedValue({ provider: "xero", key: "client_id" });
    mocks.readIntegrationCredentialRow.mockResolvedValueOnce(configured("DATA_ENCRYPTION_KEY:k_2"));

    const report = await run();

    expect(report.keyCheckedAgainst).toBe("a stored credential");
    expect(formatReencryptReport(report)[1]).toMatch(
      /^Key "k_2", fingerprint [0-9a-f]{4}(-[0-9a-f]{4}){3}: read a stored credential the app wrote under it, so this is the app's key\.$/,
    );
    expect(mocks.prisma.integrationCredential.findFirst.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.withCredentialTransaction.mock.invocationCallOrder[0]!,
    );
  });

  it("checks in a dry run too", async () => {
    mocks.prisma.integrationCredential.findFirst.mockResolvedValue({ provider: "xero", key: "client_id" });
    mocks.readIntegrationCredentialRow.mockResolvedValueOnce({ status: "needs_reentry", reason: "r", version: "v" });
    await expect(run({ dryRun: true })).rejects.toThrow(ReencryptRefusedError);
  });
});

describe("the kept timestamp comes from the row the claim is made on (#4456 review round 2, F3)", () => {
  it("a write landing between the value read and the timestamp read makes the move lose, writing nothing", async () => {
    mocks.credentialRows = [{ provider: "stripe", key: "secret_key" }];
    TX.integrationCredential.findUnique.mockImplementationOnce(async () => ({
      ciphertext: "c2",
      iv: "i2",
      authTag: "t2",
      updatedAt: new Date("2026-06-30T00:00:00.000Z"),
      version: "an-admin-save-landed",
    }));

    const report = await run({ maxPasses: 1 });

    expect(mocks.setIntegrationCredentialInTransaction).not.toHaveBeenCalled();
    expect(report.credentials).toMatchObject({ moved: 0, lostClaims: 1 });
    // The timestamp is read after the value, never before.
    expect(TX.integrationCredential.findUnique.mock.invocationCallOrder[0]!).toBeGreaterThan(
      mocks.readIntegrationCredentialRow.mock.invocationCallOrder.at(-1)!,
    );
  });
});

