/**
 * The Xero OAuth tokens in the credential store (#3454), as #3806 left them:
 * the connection and the only refresh lease on `XeroConnection`, and the token
 * set only in the credential store.
 *
 * WHAT THIS PROVES, against a STATEFUL double of those two tables, so a
 * rolled-back transaction really leaves the rows as they were:
 *
 *   - a connect, refresh or disconnect lands the store copy and the connection
 *     with one attributed audit row, or nothing;
 *   - no connection means not connected, and a connection whose store copy is
 *     missing, unreadable or another organisation is a reconnect;
 *   - a refresh claims the one lease, and its save is fenced by that lease and
 *     the store's compare-and-set: losing either rolls everything back;
 *   - a store copy R2 wrote, `mirror` and all, still loads, and a `mirror` that
 *     is not a string does not;
 *   - no plaintext token reaches an audit row, a log line or an error.
 *
 * What it does NOT prove: Postgres row-lock behaviour under real concurrency.
 * That is `xero-token-credential-store.realdb.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
  const state = {
    xeroConnection: [] as Row[],
    credential: [] as Row[],
    audit: [] as Row[],
    nextId: 1,
    /** When set, the Nth audit write (1-based, counted from now) throws. */
    failAuditAt: null as number | null,
    /** Transactions currently open. */
    txDepth: 0,
    /** Writes made through the MODULE client while a transaction was open. */
    outsideTxWrites: [] as string[],
    /** Called once, just before the next `xeroConnection.updateMany`, then cleared. */
    beforeNextConnectionUpdate: null as null | (() => Promise<void> | void),
  };

  const clone = <T>(value: T): T => structuredClone(value);

  /** The subset of Prisma's `where` the token and credential stores use. */
  function matches(row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    for (const [field, condition] of Object.entries(where)) {
      if (field === "OR") {
        if (!(condition as Row[]).some((branch) => matches(row, branch))) {
          return false;
        }
        continue;
      }
      if (field === "provider_key") {
        const { provider, key } = condition as { provider: string; key: string };
        if (row.provider !== provider || row.key !== key) return false;
        continue;
      }
      const value = row[field];
      if (condition === null) {
        if (value !== null && value !== undefined) return false;
        continue;
      }
      if (condition instanceof Date) {
        if (!(value instanceof Date) || value.getTime() !== condition.getTime()) {
          return false;
        }
        continue;
      }
      if (typeof condition === "object" && condition !== null) {
        const ops = condition as { lte?: Date };
        if (ops.lte !== undefined) {
          // Prisma: a NULL column never satisfies `lte`.
          if (!(value instanceof Date) || value.getTime() > ops.lte.getTime()) {
            return false;
          }
        }
        continue;
      }
      if (value !== condition) return false;
    }
    return true;
  }

  const now = () => new Date();

  const xeroConnection = {
    findUnique: vi.fn(async (args: { where: Row }) =>
      clone(state.xeroConnection.find((row) => matches(row, args.where)) ?? null),
    ),
    updateMany: vi.fn(async (args: { where: Row; data: Row }) => {
      const hook = state.beforeNextConnectionUpdate;
      state.beforeNextConnectionUpdate = null;
      if (hook) await hook();
      let count = 0;
      for (const row of state.xeroConnection) {
        if (matches(row, args.where)) {
          Object.assign(row, args.data, { updatedAt: now() });
          count += 1;
        }
      }
      return { count };
    }),
    upsert: vi.fn(async (args: { where: Row; create: Row; update: Row }) => {
      const row = state.xeroConnection.find((candidate) => matches(candidate, args.where));
      if (row) {
        Object.assign(row, args.update, { updatedAt: now() });
        return clone(row);
      }
      const created = {
        refreshInProgressUntil: null,
        createdAt: now(),
        updatedAt: now(),
        ...args.create,
      };
      state.xeroConnection.push(created);
      return clone(created);
    }),
    deleteMany: vi.fn(async () => {
      const before = state.xeroConnection.length;
      state.xeroConnection = [];
      return { count: before };
    }),
  };

  const integrationCredential = {
    // #4456: rows already under a ring key, asked before an AUTH_SECRET write.
    count: vi.fn(async (args: { where: { secretSource: { startsWith: string } } }) =>
      // A LIKE prefix as `exactPrefix` writes it: drop its escapes to compare literally.
      state.credential.filter((row) =>
        String(row.secretSource).startsWith(args.where.secretSource.startsWith.replace(/\\(.)/g, "$1")),
      ).length,
    ),
    findUnique: vi.fn(async (args: { where: Row }) =>
      clone(state.credential.find((row) => matches(row, args.where)) ?? null),
    ),
    findMany: vi.fn(async (args: { where: Row }) =>
      clone(state.credential.filter((row) => matches(row, args.where))),
    ),
    create: vi.fn(async (args: { data: Row }) => {
      if (
        state.credential.some(
          (row) => row.provider === args.data.provider && row.key === args.data.key,
        )
      ) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      const row = { id: `ic-${state.nextId++}`, createdAt: now(), updatedAt: now(), ...args.data };
      state.credential.push(row);
      return clone(row);
    }),
    upsert: vi.fn(async (args: { where: Row; create: Row; update: Row }) => {
      const row = state.credential.find((candidate) => matches(candidate, args.where));
      if (row) {
        Object.assign(row, args.update, { updatedAt: now() });
        return clone(row);
      }
      const created = { id: `ic-${state.nextId++}`, createdAt: now(), updatedAt: now(), ...args.create };
      state.credential.push(created);
      return clone(created);
    }),
    updateMany: vi.fn(async (args: { where: Row; data: Row }) => {
      let count = 0;
      for (const row of state.credential) {
        if (matches(row, args.where)) {
          Object.assign(row, args.data, { updatedAt: now() });
          count += 1;
        }
      }
      return { count };
    }),
    deleteMany: vi.fn(async (args: { where: Row }) => {
      const before = state.credential.length;
      state.credential = state.credential.filter((row) => !matches(row, args.where));
      return { count: before - state.credential.length };
    }),
  };

  const auditLog = {
    create: vi.fn(async (args: { data: Row }) => {
      if (state.failAuditAt !== null) {
        state.failAuditAt -= 1;
        if (state.failAuditAt === 0) {
          state.failAuditAt = null;
          throw new Error("audit write failed");
        }
      }
      state.audit.push(clone(args.data));
      return { id: `audit-${state.audit.length}` };
    }),
  };

  /**
   * THE TRANSACTION CLIENT IS A DIFFERENT OBJECT FROM THE MODULE CLIENT, over
   * the same tables. A write through the module client while a transaction is
   * open would, in PostgreSQL, commit on its own whatever the transaction
   * later did — so the double records it, and every test asserts there were
   * none.
   */
  const READS = new Set(["findFirst", "findUnique", "findMany", "count"]);
  function moduleClient<T extends Record<string, (...args: never[]) => unknown>>(
    table: string,
    delegate: T,
  ): T {
    const guarded: Record<string, unknown> = {};
    for (const [method, fn] of Object.entries(delegate)) {
      guarded[method] = (...args: never[]) => {
        if (state.txDepth > 0 && !READS.has(method)) {
          state.outsideTxWrites.push(`${table}.${method}`);
        }
        return fn(...args);
      };
    }
    return guarded as T;
  }

  const member = { count: vi.fn(async () => 0) };
  const twoFactorRecoveryCode = { count: vi.fn(async () => 0) };
  const tx = { xeroConnection, integrationCredential, auditLog, member, twoFactorRecoveryCode };

  const db = {
    xeroConnection: moduleClient("xeroConnection", xeroConnection),
    integrationCredential: moduleClient("integrationCredential", integrationCredential),
    auditLog: moduleClient("auditLog", auditLog),
    member: moduleClient("member", member),
    twoFactorRecoveryCode: moduleClient("twoFactorRecoveryCode", twoFactorRecoveryCode),
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      const snapshot = clone({
        xeroConnection: state.xeroConnection,
        credential: state.credential,
        audit: state.audit,
      });
      state.txDepth += 1;
      try {
        return await work(tx);
      } catch (error) {
        state.xeroConnection = snapshot.xeroConnection;
        state.credential = snapshot.credential;
        state.audit = snapshot.audit;
        throw error;
      } finally {
        state.txDepth -= 1;
      }
    }),
  };

  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

  return { state, db, raw: tx, logger };
});

vi.mock("@/lib/prisma", () => ({ prisma: h.db }));
vi.mock("@/lib/logger", () => ({ default: h.logger, logger: h.logger }));

import {
  StaleCredentialWriteError,
  type CredentialActor,
} from "@/lib/integration-credential-actor";
import {
  resetIntegrationCredentialCacheForTests,
  resolveIntegrationCredential,
  setIntegrationCredentialInTransaction,
} from "@/lib/integration-credentials";
import {
  XERO_OAUTH_TOKEN_KEY,
  XERO_OAUTH_TOKEN_PROVIDER,
  XeroTokenDecryptError,
  XeroTokenSaveUnavailableError,
  assertXeroTokensCanBeStored,
  claimXeroTokenRefreshLease,
  deleteXeroTokens,
  fenceXeroTokenSetRewrite,
  getXeroTokenReadability,
  isXeroConnected,
  loadXeroTokens,
  releaseXeroTokenRefreshLease,
  saveXeroTokens,
  type TokenData,
} from "@/lib/xero-token-store";
import { withXeroVerifyReset } from "@/lib/xero-verify-reset";

const ADMIN: CredentialActor = { kind: "admin", memberId: "admin-7" };
const REFRESH_JOB: CredentialActor = { kind: "system", actor: "xero-token-refresh" };
const REQUEST = { id: "req-1", ipAddress: "10.0.0.1", userAgent: "test-agent" };

/**
 * The fence takes the generated transaction client (`xeroConnection` and
 * `integrationCredential` only, now the token table is gone). This double
 * implements the calls the store makes. It is not a `XeroConnectionDelegate`:
 * that type also requires `findUniqueOrThrow`, `findFirst`, `findMany`,
 * `fields`, and the rest. The assertion is this boundary. `XeroTokenDb` stays
 * the generated pick.
 */
function asXeroTokenDb(raw: typeof h.raw): Parameters<typeof fenceXeroTokenSetRewrite>[0] {
  return raw as unknown as Parameters<typeof fenceXeroTokenSetRewrite>[0];
}

/** Distinctive enough that a substring search cannot match it by accident. */
const SENTINEL = "xero_SENTINEL_7d41c0a9e2b54f3e8a6PLAINTEXT";

function tokenSet(tag: string, tenantId = "tenant-1"): TokenData {
  return {
    accessToken: `access-${tag}`,
    refreshToken: `refresh-${tag}`,
    expiresAt: new Date("2026-07-01T00:30:00.000Z"),
    tenantId,
  };
}

function credentialAudits(action?: string): Row[] {
  return h.state.audit.filter(
    (row) =>
      row.entityId === `${XERO_OAUTH_TOKEN_PROVIDER}:${XERO_OAUTH_TOKEN_KEY}` &&
      (action === undefined || row.action === action),
  );
}

function leaseUntil(): Date | null {
  return (h.state.xeroConnection[0]?.refreshInProgressUntil as Date | null) ?? null;
}

function storedTokenSet(): Row | null {
  const row = h.state.credential.find(
    (candidate) =>
      candidate.provider === XERO_OAUTH_TOKEN_PROVIDER && candidate.key === XERO_OAUTH_TOKEN_KEY,
  );
  return row ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.xeroConnection = [];
  h.state.credential = [];
  h.state.audit = [];
  h.state.failAuditAt = null;
  h.state.txDepth = 0;
  h.state.outsideTxWrites = [];
  h.state.beforeNextConnectionUpdate = null;
  resetIntegrationCredentialCacheForTests();
  delete process.env.NEXTAUTH_SECRET;
  process.env.AUTH_SECRET = "s".repeat(48);
});

afterEach(() => {
  expect(h.state.outsideTxWrites).toEqual([]);
});

describe("a connect writes the store copy and the connection, with one audit row (#3806)", () => {
  it("stores the set and does not record a mirror", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN, request: REQUEST });

    expect(h.state.credential).toHaveLength(1);
    expect(h.state.credential[0]).toMatchObject({
      provider: XERO_OAUTH_TOKEN_PROVIDER,
      key: XERO_OAUTH_TOKEN_KEY,
      updatedByUserId: "admin-7",
    });
    expect(h.state.xeroConnection).toEqual([
      expect.objectContaining({ id: "default", tenantId: "tenant-1", refreshInProgressUntil: null }),
    ]);
    await expect(loadXeroTokens()).resolves.toMatchObject({
      accessToken: "access-c1",
      refreshToken: "refresh-c1",
      tenantId: "tenant-1",
    });

    const audits = credentialAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "integration.credential.set",
      category: "security",
      actorMemberId: "admin-7",
      requestId: "req-1",
      ipAddress: "10.0.0.1",
    });
    expect(audits[0].metadata).toMatchObject({
      actorKind: "admin",
      expectation: "any",
      cause: "oauth-connect",
    });
  });

  it("keeps the previous tenant when the grant names none", async () => {
    await saveXeroTokens(tokenSet("c1", "tenant-kept"), { actor: ADMIN });
    await saveXeroTokens({ ...tokenSet("c2"), tenantId: undefined }, { actor: ADMIN });
    expect(h.state.xeroConnection[0].tenantId).toBe("tenant-kept");
  });

  it("commits nothing when the audit row fails", async () => {
    h.state.failAuditAt = 1;
    await expect(saveXeroTokens(tokenSet("c1"), { actor: ADMIN })).rejects.toThrow(
      "audit write failed",
    );
    expect(h.state.xeroConnection).toEqual([]);
    expect(h.state.credential).toEqual([]);
  });

  it("deletes the retired wrapped token key, audited as the connecting administrator's act", async () => {
    h.state.credential.push({
      id: "ic-key",
      provider: "xero",
      key: "token_key",
      ciphertext: "x",
      iv: "y",
      authTag: "z",
      labelVersion: "xero-token-key:v1",
      secretSource: "AUTH_SECRET",
    });

    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN, request: REQUEST });

    expect(h.state.credential.map((row) => `${row.provider}:${row.key}`)).toEqual([
      `${XERO_OAUTH_TOKEN_PROVIDER}:${XERO_OAUTH_TOKEN_KEY}`,
    ]);
    const keyAudits = h.state.audit.filter((row) => row.entityId === "xero:token_key");
    expect(keyAudits).toHaveLength(1);
    expect(keyAudits[0]).toMatchObject({
      action: "integration.credential.deleted",
      actorMemberId: "admin-7",
    });
  });
});

describe("the read takes the store copy only, and the connection decides connected (#3806)", () => {
  it("no connection is NOT connected, whatever the store holds", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    h.state.xeroConnection = [];

    await expect(loadXeroTokens()).resolves.toBeNull();
    await expect(getXeroTokenReadability()).resolves.toBe("no_tokens");
    await expect(isXeroConnected()).resolves.toBe(false);
  });

  it("a connection with no store copy is a reconnect", async () => {
    h.state.xeroConnection.push({
      id: "default",
      tenantId: "tenant-1",
      expiresAt: tokenSet("pre").expiresAt,
      refreshInProgressUntil: null,
    });

    await expect(loadXeroTokens()).rejects.toBeInstanceOf(XeroTokenDecryptError);
    await expect(getXeroTokenReadability()).resolves.toBe("unreadable");
    await expect(claimXeroTokenRefreshLease()).rejects.toBeInstanceOf(XeroTokenDecryptError);
    expect(leaseUntil()).toBeNull();
  });

  it("a store copy naming another organisation than the connection is a reconnect", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    h.state.xeroConnection[0]!.tenantId = "tenant-elsewhere";

    await expect(loadXeroTokens()).rejects.toThrow(
      new XeroTokenDecryptError(
        "The stored Xero token set belongs to a different Xero organisation from the connection",
      ),
    );
    await expect(getXeroTokenReadability()).resolves.toBe("unreadable");
    await expect(claimXeroTokenRefreshLease()).rejects.toBeInstanceOf(XeroTokenDecryptError);
    expect(leaseUntil()).toBeNull();
  });

  it("a store copy that names no organisation takes the connection's", async () => {
    await saveXeroTokens({ ...tokenSet("c1"), tenantId: undefined }, { actor: ADMIN });
    h.state.xeroConnection[0]!.tenantId = "tenant-1";

    await expect(loadXeroTokens()).resolves.toMatchObject({ tenantId: "tenant-1" });
    await expect(getXeroTokenReadability()).resolves.toBe("readable");
  });

  it("still loads a store copy R2 wrote with a mirror string, and rejects one that is not a string", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });

    async function replace(value: Record<string, unknown>) {
      await h.db.$transaction((tx) =>
        setIntegrationCredentialInTransaction({
          tx: tx as never,
          provider: XERO_OAUTH_TOKEN_PROVIDER,
          key: XERO_OAUTH_TOKEN_KEY,
          value: JSON.stringify(value),
          actor: ADMIN,
          expect: { expect: "any" },
        }),
      );
    }

    await replace({
      v: 1,
      accessToken: "access-mirrored",
      refreshToken: "refresh-mirrored",
      expiresAt: "2026-07-01T00:30:00.000Z",
      tenantId: "tenant-1",
      mirror: "a".repeat(64),
    });
    await expect(loadXeroTokens()).resolves.toMatchObject({ refreshToken: "refresh-mirrored" });

    await replace({
      v: 1,
      accessToken: "access-bad",
      refreshToken: "refresh-bad",
      expiresAt: "2026-07-01T00:30:00.000Z",
      tenantId: "tenant-1",
      mirror: 1,
    });
    await expect(loadXeroTokens()).rejects.toBeInstanceOf(XeroTokenDecryptError);
    await expect(getXeroTokenReadability()).resolves.toBe("unreadable");
  });

  it("never answers from the credential store's cache: another container's write is seen at once", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    await resolveIntegrationCredential(XERO_OAUTH_TOKEN_PROVIDER, XERO_OAUTH_TOKEN_KEY);
    await h.db.$transaction((tx) =>
      setIntegrationCredentialInTransaction({
        tx: tx as never,
        provider: XERO_OAUTH_TOKEN_PROVIDER,
        key: XERO_OAUTH_TOKEN_KEY,
        value: JSON.stringify({
          v: 1,
          accessToken: "access-elsewhere",
          refreshToken: "refresh-elsewhere",
          expiresAt: "2026-07-01T00:30:00.000Z",
          tenantId: "tenant-1",
        }),
        actor: REFRESH_JOB,
        expect: { expect: "any" },
        cause: { kind: "token-refresh" },
      }),
    );

    await expect(loadXeroTokens()).resolves.toMatchObject({ refreshToken: "refresh-elsewhere" });
  });

  it("reports the connection's lease to a waiter", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    const held = new Date(Date.now() + 120_000);
    h.state.xeroConnection[0]!.refreshInProgressUntil = held;

    const loaded = await loadXeroTokens();
    expect(loaded?.refreshInProgressUntil).toEqual(held);
  });
});

describe("a refresh claims the one lease and is fenced by it and by the store's compare-and-set (#3806)", () => {
  it("writes the store copy and the connection, and one audit row naming the refresh job", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    h.state.audit = [];

    const claim = await claimXeroTokenRefreshLease();
    if (!claim.claimed) throw new Error("expected the lease");
    expect(leaseUntil()).toEqual(claim.leaseUntil);
    expect(Object.keys(claim.lease).sort()).toEqual(["leaseUntil", "storeVersion"]);
    const next = { ...tokenSet("r1"), expiresAt: new Date("2026-07-01T01:00:00.000Z") };
    await saveXeroTokens(next, { actor: REFRESH_JOB, lease: claim.lease });

    expect(h.state.xeroConnection[0]).toMatchObject({
      expiresAt: next.expiresAt,
      refreshInProgressUntil: null,
    });
    await expect(loadXeroTokens()).resolves.toMatchObject({ refreshToken: "refresh-r1" });
    const audits = credentialAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "integration.credential.set" });
    expect(audits[0].actorMemberId ?? null).toBeNull();
    expect(audits[0].metadata).toMatchObject({
      actorKind: "system",
      systemActor: "xero-token-refresh",
      expectation: "version",
      cause: "token-refresh",
    });
    expect(storedTokenSet()).not.toBeNull();
  });

  it("a release clears its own lease and audits nothing, and leaves a newer lease alone", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    h.state.audit = [];
    const claim = await claimXeroTokenRefreshLease();
    if (!claim.claimed) throw new Error("expected the lease");

    await releaseXeroTokenRefreshLease(claim.lease);

    expect(leaseUntil()).toBeNull();
    expect(h.state.audit).toEqual([]);

    const again = await claimXeroTokenRefreshLease();
    if (!again.claimed) throw new Error("expected the lease");
    const newer = new Date(again.leaseUntil.getTime() + 60_000);
    h.state.xeroConnection[0]!.refreshInProgressUntil = newer;
    await releaseXeroTokenRefreshLease(again.lease);
    expect(leaseUntil()).toEqual(newer);
  });

  it("takes nothing when the connection lease is held elsewhere", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    const elsewhere = new Date(Date.now() + 120_000);
    h.state.xeroConnection[0]!.refreshInProgressUntil = elsewhere;

    const claim = await claimXeroTokenRefreshLease();

    expect(claim.claimed).toBe(false);
    expect(leaseUntil()).toEqual(elsewhere);
    expect(claim.tokens?.refreshToken).toBe("refresh-c1");
  });

  it("a reconnect during the refresh wins: the save throws and nothing moves", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    const claim = await claimXeroTokenRefreshLease();
    if (!claim.claimed) throw new Error("expected the lease");
    await saveXeroTokens(tokenSet("c2"), { actor: ADMIN });
    const before = structuredClone({
      xeroConnection: h.state.xeroConnection,
      credential: h.state.credential,
    });

    await expect(
      saveXeroTokens(tokenSet("late"), { actor: REFRESH_JOB, lease: claim.lease }),
    ).rejects.toThrow("lease expired");
    expect({
      xeroConnection: h.state.xeroConnection,
      credential: h.state.credential,
    }).toEqual(before);
    await expect(loadXeroTokens()).resolves.toMatchObject({ refreshToken: "refresh-c2" });
  });

  it("a later lease makes the save lose before it writes the store", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    const claim = await claimXeroTokenRefreshLease();
    if (!claim.claimed) throw new Error("expected the lease");
    const later = new Date(claim.leaseUntil.getTime() + 60_000);
    h.state.xeroConnection[0]!.refreshInProgressUntil = later;
    const before = structuredClone({
      xeroConnection: h.state.xeroConnection,
      credential: h.state.credential,
    });

    await expect(
      saveXeroTokens(tokenSet("late"), { actor: REFRESH_JOB, lease: claim.lease }),
    ).rejects.toThrow("lease expired");
    expect({
      xeroConnection: h.state.xeroConnection,
      credential: h.state.credential,
    }).toEqual(before);
  });

  it("a store copy replaced behind the lease makes the save LOSE and rolls the connection back", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    const claim = await claimXeroTokenRefreshLease();
    if (!claim.claimed) throw new Error("expected the lease");
    await h.db.$transaction((tx) =>
      setIntegrationCredentialInTransaction({
        tx: tx as never,
        provider: XERO_OAUTH_TOKEN_PROVIDER,
        key: XERO_OAUTH_TOKEN_KEY,
        value: JSON.stringify({
          v: 1,
          accessToken: "access-bypass",
          refreshToken: "refresh-bypass",
          expiresAt: "2026-07-01T00:30:00.000Z",
          tenantId: "tenant-1",
        }),
        actor: ADMIN,
        expect: { expect: "any" },
      }),
    );
    const before = structuredClone(h.state.xeroConnection);

    await expect(
      saveXeroTokens(tokenSet("r1"), { actor: REFRESH_JOB, lease: claim.lease }),
    ).rejects.toBeInstanceOf(StaleCredentialWriteError);
    expect(h.state.xeroConnection).toEqual(before);
    expect(leaseUntil()).toEqual(claim.leaseUntil);
  });

  it("claims FIRST and reads second: a reconnect committing just before the lease hands over the NEW token", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    h.state.beforeNextConnectionUpdate = () => saveXeroTokens(tokenSet("c2"), { actor: ADMIN });

    const claim = await claimXeroTokenRefreshLease();
    if (!claim.claimed) throw new Error("expected the lease");
    expect(claim.tokens.refreshToken).toBe("refresh-c2");

    await saveXeroTokens(tokenSet("r1"), { actor: REFRESH_JOB, lease: claim.lease });
    await expect(loadXeroTokens()).resolves.toMatchObject({ refreshToken: "refresh-r1" });
  });

  it("the re-encrypt fence loses while a lease is set, including one that has already expired", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    expect(await fenceXeroTokenSetRewrite(asXeroTokenDb(h.raw))).toBe(true);

    const claim = await claimXeroTokenRefreshLease({ now: new Date(Date.now() - 10 * 60_000) });
    if (!claim.claimed) throw new Error("expected the lease");
    expect(claim.leaseUntil.getTime()).toBeLessThan(Date.now());
    expect(await fenceXeroTokenSetRewrite(asXeroTokenDb(h.raw))).toBe(false);

    h.state.xeroConnection = [];
    expect(await fenceXeroTokenSetRewrite(asXeroTokenDb(h.raw))).toBe(true);
  });
});

describe("a refresh refuses before spending the token when its save could not succeed (#3454 review)", () => {
  it("refuses under an auth secret the capture gate would reject", async () => {
    process.env.AUTH_SECRET = "too-short";
    await expect(assertXeroTokensCanBeStored()).rejects.toBeInstanceOf(XeroTokenSaveUnavailableError);
    await expect(assertXeroTokensCanBeStored()).rejects.toMatchObject({
      reason: "auth-secret-weak",
      message: expect.stringMatching(/auth secret.*the refresh token was not spent/i),
    });
  });

  it("names an invalid ring as itself, never as a weak auth secret (#4456 review)", async () => {
    process.env.DATA_ENCRYPTION_KEYS = "k1:not-a-key";
    try {
      await expect(assertXeroTokensCanBeStored()).rejects.toMatchObject({
        reason: "data-key-ring-invalid",
        message: expect.stringMatching(/^DATA_ENCRYPTION_KEYS: .*the refresh token was not spent\.$/),
      });
    } finally {
      delete process.env.DATA_ENCRYPTION_KEYS;
    }
  });

  it("lets a database error from its question propagate as itself, spending nothing (#4456 review)", async () => {
    h.raw.integrationCredential.count.mockRejectedValueOnce(new Error("database unavailable"));
    const refusal = assertXeroTokensCanBeStored();
    await expect(refusal).rejects.toThrow("database unavailable");
    await expect(refusal).rejects.not.toBeInstanceOf(XeroTokenSaveUnavailableError);
  });

  it("refuses before spending the token when the ring is unset but a credential is under a ring key (#4456)", async () => {
    delete process.env.DATA_ENCRYPTION_KEYS;
    h.state.credential.push({
      id: "ic-ring",
      provider: "stripe",
      key: "secret_key",
      ciphertext: "00",
      iv: "00",
      authTag: "00",
      secretSource: "DATA_ENCRYPTION_KEY:k1",
      labelVersion: "integration-credential:v2",
      updatedByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(assertXeroTokensCanBeStored()).rejects.toBeInstanceOf(XeroTokenSaveUnavailableError);
    await expect(assertXeroTokensCanBeStored()).rejects.toMatchObject({
      reason: "data-key-ring-missing",
      message: expect.stringMatching(/DATA_ENCRYPTION_KEYS is not set\. Set it back as it was, or set a new key/),
    });
  });

  it("passes when the save would succeed, and writes nothing", async () => {
    await assertXeroTokensCanBeStored();
    expect(h.state.credential).toEqual([]);
    expect(h.state.audit).toEqual([]);
  });
});

describe("destroying the tokens records who and why, once (#3454)", () => {
  it("a disconnect deletes the connection and the store copy and writes ONE row naming the administrator", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    h.state.audit = [];

    await deleteXeroTokens({ actor: ADMIN, request: REQUEST, cause: { kind: "oauth-disconnect" } });

    expect(h.state.xeroConnection).toEqual([]);
    expect(h.state.credential).toEqual([]);
    const audits = credentialAudits("integration.credential.deleted");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorMemberId: "admin-7", requestId: "req-1" });
    expect(audits[0].metadata).toMatchObject({ cause: "oauth-disconnect" });
  });

  it("still records destroying a connection whose store copy was already gone", async () => {
    h.state.xeroConnection.push({
      id: "default",
      tenantId: "tenant-1",
      expiresAt: tokenSet("pre").expiresAt,
      refreshInProgressUntil: null,
    });

    await deleteXeroTokens({ actor: ADMIN, cause: { kind: "oauth-disconnect" } });

    expect(h.state.xeroConnection).toEqual([]);
    const audits = credentialAudits("integration.credential.deleted");
    expect(audits).toHaveLength(1);
    expect(audits[0].summary).toContain("pre-upgrade copy only");
  });

  it("records nothing when there was nothing to destroy", async () => {
    await deleteXeroTokens({ actor: ADMIN, cause: { kind: "oauth-disconnect" } });
    expect(h.state.audit).toEqual([]);
  });
});

describe("the verify-reset commits with the credential write that causes it (#3454)", () => {
  async function saveClientSecret(value: string) {
    return withXeroVerifyReset(
      {
        actor: ADMIN,
        request: REQUEST,
        causedByCredential: "xero:client_secret",
        providers: ["xero"],
      },
      (tx) =>
        setIntegrationCredentialInTransaction({
          tx,
          provider: "xero",
          key: "client_secret",
          value,
          actor: ADMIN,
          expect: { expect: "any" },
          request: REQUEST,
        }),
    );
  }

  it("writes the credential and destroys the tokens as one action an operator can read as one", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    h.state.audit = [];

    await saveClientSecret("new-client-secret");

    expect(h.state.xeroConnection).toEqual([]);
    expect(h.state.credential.map((row) => `${row.provider}:${row.key}`)).toEqual([
      "xero:client_secret",
    ]);
    expect(h.state.audit.map((row) => row.action)).toEqual([
      "integration.credential.set",
      "integration.credential.deleted",
    ]);
    expect(new Set(h.state.audit.map((row) => row.requestId))).toEqual(new Set(["req-1"]));
    expect(h.state.audit[1].metadata).toMatchObject({
      cause: "verify-reset",
      causedByCredential: "xero:client_secret",
    });
  });

  it("rolls the credential write back when destroying the tokens fails", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    const before = structuredClone({
      xeroConnection: h.state.xeroConnection,
      credential: h.state.credential,
    });
    h.state.failAuditAt = 2;

    await expect(saveClientSecret("new-client-secret")).rejects.toThrow("audit write failed");
    expect({
      xeroConnection: h.state.xeroConnection,
      credential: h.state.credential,
    }).toEqual(before);
  });
});

describe("no plaintext token reaches an audit row, a log line or an error (#3454)", () => {
  const sentinelSet = (tag: string): TokenData => ({
    accessToken: `${SENTINEL}-access-${tag}`,
    refreshToken: `${SENTINEL}-refresh-${tag}`,
    expiresAt: new Date("2026-07-01T00:30:00.000Z"),
    tenantId: "tenant-1",
  });

  function serialised(value: unknown): unknown {
    return value instanceof Error
      ? { ...value, name: value.name, message: value.message, stack: value.stack }
      : value;
  }

  it("drives every token-store door with a sentinel token and finds it nowhere it must not be", async () => {
    const errors: unknown[] = [];
    const capture = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        errors.push(error);
      }
    };

    await saveXeroTokens(sentinelSet("c1"), { actor: ADMIN, request: REQUEST });
    const claim = await claimXeroTokenRefreshLease();
    if (!claim.claimed) throw new Error("expected the lease");
    await saveXeroTokens(sentinelSet("r1"), { actor: REFRESH_JOB, lease: claim.lease });
    await loadXeroTokens();
    await saveXeroTokens(sentinelSet("c2"), { actor: ADMIN });

    const lostLease = await claimXeroTokenRefreshLease();
    if (!lostLease.claimed) throw new Error("expected the lease");
    await saveXeroTokens(sentinelSet("c3"), { actor: ADMIN });
    await capture(() =>
      saveXeroTokens(sentinelSet("late"), { actor: REFRESH_JOB, lease: lostLease.lease }),
    );

    const staleLease = await claimXeroTokenRefreshLease();
    if (!staleLease.claimed) throw new Error("expected the lease");
    await h.db.$transaction((tx) =>
      setIntegrationCredentialInTransaction({
        tx: tx as never,
        provider: XERO_OAUTH_TOKEN_PROVIDER,
        key: XERO_OAUTH_TOKEN_KEY,
        value: JSON.stringify({
          v: 1,
          accessToken: `${SENTINEL}-access-bypass`,
          refreshToken: `${SENTINEL}-refresh-bypass`,
          expiresAt: "2026-07-01T00:30:00.000Z",
          tenantId: "tenant-1",
        }),
        actor: ADMIN,
        expect: { expect: "any" },
      }),
    );
    await capture(() =>
      saveXeroTokens(sentinelSet("stale"), { actor: REFRESH_JOB, lease: staleLease.lease }),
    );
    await releaseXeroTokenRefreshLease(staleLease.lease);

    await saveXeroTokens(sentinelSet("c4"), { actor: ADMIN });
    process.env.AUTH_SECRET = "t".repeat(48);
    await capture(() => loadXeroTokens());
    await getXeroTokenReadability();
    process.env.AUTH_SECRET = "s".repeat(48);

    await withXeroVerifyReset(
      { actor: ADMIN, request: REQUEST, causedByCredential: "xero:client_id", providers: ["xero"] },
      (tx) =>
        setIntegrationCredentialInTransaction({
          tx,
          provider: "xero",
          key: "client_id",
          value: "client-id",
          actor: ADMIN,
          expect: { expect: "any" },
        }),
    );
    await saveXeroTokens(sentinelSet("c5"), { actor: ADMIN });
    await deleteXeroTokens({ actor: ADMIN, cause: { kind: "oauth-disconnect" } });

    expect(errors).toHaveLength(3);
    expect(errors.some((error) => error instanceof StaleCredentialWriteError)).toBe(true);
    expect(errors.some((error) => error instanceof XeroTokenDecryptError)).toBe(true);
    expect(h.state.audit.length).toBeGreaterThanOrEqual(7);

    const emitted = JSON.stringify([
      h.state.audit,
      h.logger.error.mock.calls,
      h.logger.warn.mock.calls,
      h.logger.info.mock.calls,
      h.logger.debug.mock.calls,
      errors.map(serialised),
    ]);
    expect(emitted).not.toContain(SENTINEL);
  });

  it("the instrument SEES a sentinel parked on an error's own property", () => {
    const error = Object.assign(new Error("ok"), { params: { refreshToken: SENTINEL } });
    expect(JSON.stringify([serialised(error)])).toContain(SENTINEL);
  });

  it("no table stores the token in plaintext", async () => {
    await saveXeroTokens(sentinelSet("c1"), { actor: ADMIN });
    expect(JSON.stringify([h.state.xeroConnection, h.state.credential])).not.toContain(SENTINEL);
  });
});
