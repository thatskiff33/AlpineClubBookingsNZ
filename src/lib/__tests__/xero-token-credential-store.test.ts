/**
 * The Xero OAuth tokens in the credential store (#3454), as #3806 R2 left them:
 * the connection and the refresh lease on `XeroConnection`, and the old
 * `XeroToken` row kept, with no ciphertext written or read, for the previous
 * release.
 *
 * WHAT THIS PROVES, against a STATEFUL double of the four tables, so a
 * rolled-back transaction really leaves the rows as they were — and with the
 * migration's trigger emulated, so `XeroConnection` follows `XeroToken` here
 * as it does in PostgreSQL:
 *
 *   - every write lands the store copy, the connection and the previous
 *     release's row with ONE attributed audit row, or nothing;
 *   - the store copy is the only one read, and a connection without a usable
 *     one is a reconnect, never a fallback;
 *   - the previous release (#3454) — which reads, refreshes, connects and
 *     disconnects only through `XeroToken` and the store — reads the STORE copy
 *     after every write here, and interleaved with this code never makes either
 *     side spend a refresh token that has already been rotated;
 *   - a refresh claims both leases or neither, and its save is fenced by both
 *     leases and the store's compare-and-set: losing any rolls everything back;
 *   - the retired wrapped token key goes with the next connect, disconnect or
 *     verify-reset, audited under that operation's actor;
 *   - no plaintext token reaches an audit row, a log line or an error.
 *
 * What it does NOT prove: Postgres row-lock behaviour under real concurrency, or
 * the real trigger. That is `xero-token-credential-store.realdb.test.ts`.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
  const state = {
    xeroToken: [] as Row[],
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
    /** Called once, just before the next `xeroToken.updateMany`, then cleared. */
    beforeNextTokenUpdate: null as null | (() => Promise<void> | void),
    /** Every column name a `xeroToken` call passed in `data` or `select`. */
    tokenColumnsNamed: new Set<string>(),
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
        const ops = condition as { lte?: Date; not?: unknown };
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

  /** `updatedAt` DESC, then `id` DESC — `XERO_TOKEN_ROW_ORDER` and the trigger's order. */
  function latestTokenRow(): Row | null {
    const rows = [...state.xeroToken].sort((a, b) => {
      const byTime = (b.updatedAt as Date).getTime() - (a.updatedAt as Date).getTime();
      if (byTime !== 0) return byTime;
      return String(b.id).localeCompare(String(a.id));
    });
    return rows[0] ?? null;
  }

  /**
   * The migration's statement trigger on `XeroToken`: follow the latest row's
   * tenant and expiry, delete the connection when no row is left, never touch
   * the lease, and write nothing when neither value changed.
   */
  function followTokenTable(): void {
    const latest = latestTokenRow();
    if (!latest) {
      state.xeroConnection = [];
      return;
    }
    const connection = state.xeroConnection[0];
    if (!connection) {
      state.xeroConnection = [
        {
          id: "default",
          tenantId: latest.tenantId ?? null,
          expiresAt: latest.expiresAt,
          refreshInProgressUntil: null,
          createdAt: now(),
          updatedAt: now(),
        },
      ];
      return;
    }
    const sameExpiry =
      (connection.expiresAt as Date).getTime() === (latest.expiresAt as Date).getTime();
    if (connection.tenantId !== (latest.tenantId ?? null) || !sameExpiry) {
      Object.assign(connection, {
        tenantId: latest.tenantId ?? null,
        expiresAt: latest.expiresAt,
        updatedAt: now(),
      });
    }
  }

  function noteColumns(args: { data?: Row; select?: Row } | undefined): void {
    for (const part of [args?.data, args?.select]) {
      for (const column of Object.keys(part ?? {})) state.tokenColumnsNamed.add(column);
    }
  }

  const xeroToken = {
    findFirst: vi.fn(async (args?: { select?: Row }) => {
      noteColumns(args);
      return clone(latestTokenRow());
    }),
    findUnique: vi.fn(async (args: { where: Row }) =>
      clone(state.xeroToken.find((row) => matches(row, args.where)) ?? null),
    ),
    create: vi.fn(async (args: { data: Row; select?: Row }) => {
      noteColumns(args);
      const row = {
        id: `xt-${String(state.nextId++).padStart(4, "0")}`,
        // The database's '' default: the client cannot name these (#3806).
        accessToken: "",
        refreshToken: "",
        createdAt: now(),
        updatedAt: now(),
        refreshInProgressUntil: null,
        tenantId: null,
        ...args.data,
      };
      state.xeroToken.push(row);
      followTokenTable();
      return clone(row);
    }),
    updateMany: vi.fn(async (args: { where: Row; data: Row }) => {
      noteColumns(args);
      const hook = state.beforeNextTokenUpdate;
      state.beforeNextTokenUpdate = null;
      if (hook) await hook();
      let count = 0;
      for (const row of state.xeroToken) {
        if (matches(row, args.where)) {
          Object.assign(row, args.data, { updatedAt: now() });
          count += 1;
        }
      }
      followTokenTable();
      return { count };
    }),
    deleteMany: vi.fn(async (args?: { where?: Row }) => {
      const before = state.xeroToken.length;
      state.xeroToken = state.xeroToken.filter((row) => !matches(row, args?.where));
      followTokenTable();
      return { count: before - state.xeroToken.length };
    }),
  };

  const xeroConnection = {
    findUnique: vi.fn(async (args: { where: Row }) =>
      clone(state.xeroConnection.find((row) => matches(row, args.where)) ?? null),
    ),
    updateMany: vi.fn(async (args: { where: Row; data: Row }) => {
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
      state.credential.filter((row) => String(row.secretSource).startsWith(args.where.secretSource.startsWith)).length,
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
   * none. Without this, passing `prisma` where `tx` belongs is invisible here.
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

  const tx = { xeroToken, xeroConnection, integrationCredential, auditLog };

  const db = {
    xeroToken: moduleClient("xeroToken", xeroToken),
    xeroConnection: moduleClient("xeroConnection", xeroConnection),
    integrationCredential: moduleClient("integrationCredential", integrationCredential),
    auditLog: moduleClient("auditLog", auditLog),
    // A rolled-back transaction leaves every table as it found it.
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      const snapshot = clone({
        xeroToken: state.xeroToken,
        xeroConnection: state.xeroConnection,
        credential: state.credential,
        audit: state.audit,
      });
      state.txDepth += 1;
      try {
        return await work(tx);
      } catch (error) {
        state.xeroToken = snapshot.xeroToken;
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

  return { state, db, raw: tx, logger, followTokenTable, latestTokenRow };
});

vi.mock("@/lib/prisma", () => ({ prisma: h.db }));
vi.mock("@/lib/logger", () => ({ default: h.logger, logger: h.logger }));

import {
  StaleCredentialWriteError,
  type CredentialActor,
} from "@/lib/integration-credential-actor";
import {
  readIntegrationCredentialRow,
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
/** The previous release's wrapped token key; only its own emulation uses it. */
const OLD_KEY = Buffer.from("a".repeat(64), "hex");

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

function oldEncrypt(plaintext: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", OLD_KEY, iv, { authTagLength: 16 });
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${encrypted}`;
}

function oldDecrypt(value: string): string {
  const [iv, tag, body] = value.split(":");
  const decipher = createDecipheriv("aes-256-gcm", OLD_KEY, Buffer.from(iv!, "hex"), {
    authTagLength: 16,
  });
  decipher.setAuthTag(Buffer.from(tag!, "hex"));
  return decipher.update(body!, "hex", "utf8") + decipher.final("utf8");
}

/** #3454's fingerprint of a `XeroToken` row, byte for byte. */
function fingerprint(row: Row): string {
  return createHash("sha256")
    .update(`${row.id}:${row.accessToken}:${row.refreshToken}`, "utf8")
    .digest("hex");
}

/**
 * THE PREVIOUS RELEASE (#3454), whose code paths know nothing of
 * `XeroConnection`: it reads the store copy only while its fingerprint matches
 * the latest `XeroToken` row (else that row's own ciphertext), claims its lease
 * on that row, and writes both copies itself. Its writes reach `XeroConnection`
 * through the trigger, which `followTokenTable` emulates.
 */
const oldRelease = {
  async load(): Promise<(TokenData & { source: "store" | "row" }) | null> {
    const stored = await readIntegrationCredentialRow(
      h.raw as never,
      XERO_OAUTH_TOKEN_PROVIDER,
      XERO_OAUTH_TOKEN_KEY,
    );
    const row = h.latestTokenRow();
    if (!row) return null;
    if (stored.status === "configured") {
      const value = JSON.parse(stored.value) as Row;
      if (typeof value.mirror === "string" && value.mirror === fingerprint(row)) {
        return {
          source: "store",
          accessToken: value.accessToken as string,
          refreshToken: value.refreshToken as string,
          expiresAt: new Date(value.expiresAt as string),
          tenantId: (value.tenantId as string | null) ?? undefined,
        };
      }
    }
    // The fallback that would read a stale or empty row: what R2 must never cause.
    return {
      source: "row",
      accessToken: oldDecrypt(row.accessToken as string),
      refreshToken: oldDecrypt(row.refreshToken as string),
      expiresAt: row.expiresAt as Date,
      tenantId: (row.tenantId as string | null) ?? undefined,
    };
  },
  claimLease(now = new Date()): boolean {
    const row = h.latestTokenRow();
    const lease = row?.refreshInProgressUntil as Date | null | undefined;
    if (!row || (lease && lease > now)) return false;
    const live = h.state.xeroToken.find((candidate) => candidate.id === row.id)!;
    live.refreshInProgressUntil = new Date(now.getTime() + 120_000);
    live.updatedAt = new Date();
    return true;
  },
  async write(tokens: TokenData, cause: "oauth-connect" | "token-refresh"): Promise<void> {
    await h.db.$transaction(async (tx) => {
      const row = h.latestTokenRow();
      const access = oldEncrypt(tokens.accessToken);
      const refresh = oldEncrypt(tokens.refreshToken);
      const id = (row?.id as string | undefined) ?? `xt-old-${h.state.nextId++}`;
      if (row) {
        Object.assign(h.state.xeroToken.find((candidate) => candidate.id === id)!, {
          accessToken: access,
          refreshToken: refresh,
          expiresAt: tokens.expiresAt,
          tenantId: tokens.tenantId ?? null,
          refreshInProgressUntil: null,
          updatedAt: new Date(),
        });
      } else {
        h.state.xeroToken.push({
          id,
          accessToken: access,
          refreshToken: refresh,
          expiresAt: tokens.expiresAt,
          tenantId: tokens.tenantId ?? null,
          refreshInProgressUntil: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      h.followTokenTable();
      await setIntegrationCredentialInTransaction({
        tx: tx as never,
        provider: XERO_OAUTH_TOKEN_PROVIDER,
        key: XERO_OAUTH_TOKEN_KEY,
        value: JSON.stringify({
          v: 1,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt.toISOString(),
          tenantId: tokens.tenantId ?? null,
          mirror: fingerprint({ id, accessToken: access, refreshToken: refresh }),
        }),
        actor: cause === "oauth-connect" ? ADMIN : REFRESH_JOB,
        expect: { expect: "any" },
        cause: { kind: cause },
      });
    });
  },
  disconnect(): void {
    h.state.xeroToken = [];
    h.followTokenTable();
    h.state.credential = h.state.credential.filter(
      (row) => row.provider !== XERO_OAUTH_TOKEN_PROVIDER,
    );
  },
};

/**
 * Xero's side of the grant: one live refresh token at a time, and spending it
 * rotates it. Spending a superseded token is the failure this lane prevents.
 */
function makeXero(initialRefresh: string) {
  let live = initialRefresh;
  let issued = 0;
  const spent: string[] = [];
  return {
    spend(refreshToken: string): TokenData {
      spent.push(refreshToken);
      if (refreshToken !== live) {
        throw new Error(`invalid_grant: ${refreshToken} was already rotated`);
      }
      issued += 1;
      live = `refresh-r${issued}`;
      return { ...tokenSet(`r${issued}`), refreshToken: live };
    },
    spent,
    get live() {
      return live;
    },
  };
}

/** This release's refresh, exactly as `getAuthenticatedXeroClient` drives it. */
async function newRefresh(xero: ReturnType<typeof makeXero>): Promise<void> {
  const claim = await claimXeroTokenRefreshLease();
  if (!claim.claimed) throw new Error("R2: lease not claimed");
  const next = xero.spend(claim.tokens.refreshToken);
  await saveXeroTokens(next, { actor: REFRESH_JOB, lease: claim.lease });
}

function credentialAudits(action?: string): Row[] {
  return h.state.audit.filter(
    (row) =>
      row.entityId === `${XERO_OAUTH_TOKEN_PROVIDER}:${XERO_OAUTH_TOKEN_KEY}` &&
      (action === undefined || row.action === action),
  );
}

function leases() {
  return {
    previousRelease: (h.latestTokenRow()?.refreshInProgressUntil as Date | null) ?? null,
    ours: (h.state.xeroConnection[0]?.refreshInProgressUntil as Date | null) ?? null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.xeroToken = [];
  h.state.xeroConnection = [];
  h.state.credential = [];
  h.state.audit = [];
  h.state.failAuditAt = null;
  h.state.txDepth = 0;
  h.state.outsideTxWrites = [];
  h.state.beforeNextTokenUpdate = null;
  h.state.tokenColumnsNamed = new Set();
  resetIntegrationCredentialCacheForTests();
  delete process.env.NEXTAUTH_SECRET;
  process.env.AUTH_SECRET = "s".repeat(48);
});

afterEach(() => {
  // Every write a transaction composes went through that transaction's client.
  expect(h.state.outsideTxWrites).toEqual([]);
  // This release never names the previous release's ciphertext (#3806).
  expect([...h.state.tokenColumnsNamed].filter((c) => /Token$/.test(c))).toEqual([]);
});

describe("a connect writes the store copy, the connection and the previous release's row, with one audit row (#3806)", () => {
  it("stores the set, and the previous release reads the STORE copy of it", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN, request: REQUEST });

    expect(h.state.credential).toHaveLength(1);
    expect(h.state.credential[0]).toMatchObject({
      provider: XERO_OAUTH_TOKEN_PROVIDER,
      key: XERO_OAUTH_TOKEN_KEY,
      updatedByUserId: "admin-7",
    });
    // The row the previous release treats as "connected": present, current,
    // and holding no ciphertext.
    expect(h.state.xeroToken).toHaveLength(1);
    expect(h.state.xeroToken[0]).toMatchObject({
      accessToken: "",
      refreshToken: "",
      tenantId: "tenant-1",
      expiresAt: tokenSet("c1").expiresAt,
      refreshInProgressUntil: null,
    });
    expect(h.state.xeroConnection).toEqual([
      expect.objectContaining({ id: "default", tenantId: "tenant-1", refreshInProgressUntil: null }),
    ]);
    await expect(oldRelease.load()).resolves.toMatchObject({
      source: "store",
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

  it("replaces a row the previous release wrote, so its ciphertext goes and its fingerprint still matches", async () => {
    await oldRelease.write(tokenSet("old"), "oauth-connect");
    const oldRow = h.latestTokenRow()!;
    expect(oldRow.accessToken).not.toBe("");

    await saveXeroTokens(tokenSet("c2"), { actor: ADMIN });

    expect(h.state.xeroToken).toHaveLength(1);
    expect(h.state.xeroToken[0].id).not.toBe(oldRow.id);
    expect(h.state.xeroToken[0].accessToken).toBe("");
    await expect(oldRelease.load()).resolves.toMatchObject({
      source: "store",
      refreshToken: "refresh-c2",
    });
  });

  it("keeps the previous tenant when the grant names none", async () => {
    await saveXeroTokens(tokenSet("c1", "tenant-kept"), { actor: ADMIN });
    await saveXeroTokens({ ...tokenSet("c2"), tenantId: undefined }, { actor: ADMIN });
    expect(h.state.xeroConnection[0].tenantId).toBe("tenant-kept");
  });

  it("commits nothing when the audit row fails", async () => {
    h.state.failAuditAt = 1;
    await expect(
      saveXeroTokens(tokenSet("c1"), { actor: ADMIN }),
    ).rejects.toThrow("audit write failed");
    expect(h.state.xeroToken).toEqual([]);
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

  it("a connection with no store copy is a reconnect, never a read of the old row", async () => {
    // A connection the previous release made before #3454 and never refreshed.
    await oldRelease.write(tokenSet("pre"), "oauth-connect");
    h.state.credential = [];

    await expect(loadXeroTokens()).rejects.toBeInstanceOf(XeroTokenDecryptError);
    await expect(getXeroTokenReadability()).resolves.toBe("unreadable");
    await expect(claimXeroTokenRefreshLease()).rejects.toBeInstanceOf(XeroTokenDecryptError);
    // The failed claim rolled back: no lease is left held.
    expect(leases()).toEqual({ previousRelease: null, ours: null });
  });

  it("a store copy naming another organisation than the connection is a reconnect (#3806 review)", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    // A release from before #3454 reconnected to another organisation: it wrote
    // XeroToken only, the trigger carried the tenant over, the store kept the old grant.
    h.state.xeroToken[0]!.tenantId = "tenant-elsewhere";
    h.state.xeroConnection[0]!.tenantId = "tenant-elsewhere";

    await expect(loadXeroTokens()).rejects.toThrow(
      new XeroTokenDecryptError(
        "The stored Xero token set belongs to a different Xero organisation from the connection",
      ),
    );
    await expect(getXeroTokenReadability()).resolves.toBe("unreadable");
    await expect(claimXeroTokenRefreshLease()).rejects.toBeInstanceOf(XeroTokenDecryptError);
    expect(leases()).toEqual({ previousRelease: null, ours: null });
  });

  it("a store copy that names no organisation takes the connection's", async () => {
    await saveXeroTokens({ ...tokenSet("c1"), tenantId: undefined }, { actor: ADMIN });
    h.state.xeroConnection[0]!.tenantId = "tenant-1";

    await expect(loadXeroTokens()).resolves.toMatchObject({ tenantId: "tenant-1" });
    await expect(getXeroTokenReadability()).resolves.toBe("readable");
  });

  it("reads the previous release's own writes, through the store copy it wrote", async () => {
    await oldRelease.write(tokenSet("old"), "oauth-connect");
    await expect(loadXeroTokens()).resolves.toMatchObject({
      refreshToken: "refresh-old",
      tenantId: "tenant-1",
    });
    await expect(isXeroConnected()).resolves.toBe(true);
  });

  it("never answers from the credential store's cache: another container's write is seen at once", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    // Warm the provider cache with the CURRENT set.
    await resolveIntegrationCredential(XERO_OAUTH_TOKEN_PROVIDER, XERO_OAUTH_TOKEN_KEY);
    // Another container refreshes (the previous release, say).
    await oldRelease.write(tokenSet("elsewhere"), "token-refresh");
    await expect(loadXeroTokens()).resolves.toMatchObject({
      refreshToken: "refresh-elsewhere",
    });
  });

  it("reports the previous release's lease to a waiter", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    oldRelease.claimLease();
    const loaded = await loadXeroTokens();
    expect(loaded?.refreshInProgressUntil).toEqual(leases().previousRelease);
  });
});

describe("a refresh claims both leases and is fenced by both and by the store's compare-and-set (#3806)", () => {
  it("writes the store copy and both rows, and one audit row naming the refresh job", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    const rowId = h.state.xeroToken[0].id;
    h.state.audit = [];

    const claim = await claimXeroTokenRefreshLease();
    if (!claim.claimed) throw new Error("expected the lease");
    expect(leases()).toEqual({ previousRelease: claim.leaseUntil, ours: claim.leaseUntil });
    const next = { ...tokenSet("r1"), expiresAt: new Date("2026-07-01T01:00:00.000Z") };
    await saveXeroTokens(next, { actor: REFRESH_JOB, lease: claim.lease });

    expect(h.state.xeroToken).toEqual([
      expect.objectContaining({
        id: rowId,
        accessToken: "",
        expiresAt: next.expiresAt,
        refreshInProgressUntil: null,
      }),
    ]);
    expect(h.state.xeroConnection[0]).toMatchObject({
      expiresAt: next.expiresAt,
      refreshInProgressUntil: null,
    });
    await expect(oldRelease.load()).resolves.toMatchObject({
      source: "store",
      refreshToken: "refresh-r1",
    });
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
  });

  it("a release clears both leases and audits nothing", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    h.state.audit = [];
    const claim = await claimXeroTokenRefreshLease();
    if (!claim.claimed) throw new Error("expected the lease");

    await releaseXeroTokenRefreshLease(claim.lease);

    expect(leases()).toEqual({ previousRelease: null, ours: null });
    expect(h.state.audit).toEqual([]);
  });

  it("the previous release and this one compete for ONE lease, both ways round", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });

    expect(oldRelease.claimLease()).toBe(true);
    const lost = await claimXeroTokenRefreshLease();
    expect(lost.claimed).toBe(false);
    // Losing took nothing: no half lease of ours is left behind.
    expect(leases().ours).toBeNull();

    h.state.xeroToken[0].refreshInProgressUntil = null;
    const won = await claimXeroTokenRefreshLease();
    expect(won.claimed).toBe(true);
    expect(oldRelease.claimLease()).toBe(false);
  });

  it("gives the previous release's lease back when its own is held elsewhere (never half a lease)", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    const elsewhere = new Date(Date.now() + 120_000);
    h.state.xeroConnection[0].refreshInProgressUntil = elsewhere;

    const claim = await claimXeroTokenRefreshLease();

    expect(claim.claimed).toBe(false);
    expect(leases()).toEqual({ previousRelease: null, ours: elsewhere });
    expect(claim.tokens?.refreshToken).toBe("refresh-c1");
  });

  it("claims only its own lease while no XeroToken row exists", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    // A connection with no row for the previous release (the R3 shape).
    const connection = h.state.xeroConnection[0];
    h.state.xeroToken = [];
    h.state.xeroConnection = [connection];

    const claim = await claimXeroTokenRefreshLease();
    if (!claim.claimed) throw new Error("expected the lease");
    expect(claim.lease.tokenRowId).toBeNull();
    await saveXeroTokens(tokenSet("r1"), { actor: REFRESH_JOB, lease: claim.lease });
    expect(h.state.xeroConnection[0].refreshInProgressUntil).toBeNull();
  });

  it("a reconnect during the refresh wins: the save throws and nothing moves", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    const claim = await claimXeroTokenRefreshLease();
    if (!claim.claimed) throw new Error("expected the lease");
    await saveXeroTokens(tokenSet("c2"), { actor: ADMIN });
    const before = structuredClone({
      xeroToken: h.state.xeroToken,
      xeroConnection: h.state.xeroConnection,
      credential: h.state.credential,
    });

    await expect(
      saveXeroTokens(tokenSet("late"), { actor: REFRESH_JOB, lease: claim.lease }),
    ).rejects.toThrow("lease expired");
    expect({
      xeroToken: h.state.xeroToken,
      xeroConnection: h.state.xeroConnection,
      credential: h.state.credential,
    }).toEqual(before);
    await expect(loadXeroTokens()).resolves.toMatchObject({ refreshToken: "refresh-c2" });
  });

  it("the previous release reconnecting in place during the refresh also wins", async () => {
    await oldRelease.write(tokenSet("old"), "oauth-connect");
    const claim = await claimXeroTokenRefreshLease();
    if (!claim.claimed) throw new Error("expected the lease");
    // Its connect clears its own lease on the same row; ours stays set.
    await oldRelease.write(tokenSet("old-2"), "oauth-connect");

    await expect(
      saveXeroTokens(tokenSet("late"), { actor: REFRESH_JOB, lease: claim.lease }),
    ).rejects.toThrow("lease expired");
    await expect(oldRelease.load()).resolves.toMatchObject({
      source: "store",
      refreshToken: "refresh-old-2",
    });
  });

  it("a store copy replaced behind the leases makes the save LOSE and rolls everything back", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    const claim = await claimXeroTokenRefreshLease();
    if (!claim.claimed) throw new Error("expected the lease");
    await h.db.$transaction((tx) =>
      setIntegrationCredentialInTransaction({
        tx: tx as never,
        provider: XERO_OAUTH_TOKEN_PROVIDER,
        key: XERO_OAUTH_TOKEN_KEY,
        value: JSON.stringify({ ...tokenSet("bypass"), v: 1, expiresAt: "2026-07-01T00:30:00.000Z" }),
        actor: ADMIN,
        expect: { expect: "any" },
      }),
    );
    const before = structuredClone({
      xeroToken: h.state.xeroToken,
      xeroConnection: h.state.xeroConnection,
    });

    await expect(
      saveXeroTokens(tokenSet("r1"), { actor: REFRESH_JOB, lease: claim.lease }),
    ).rejects.toBeInstanceOf(StaleCredentialWriteError);
    expect({ xeroToken: h.state.xeroToken, xeroConnection: h.state.xeroConnection }).toEqual(
      before,
    );
  });

  it("claims FIRST and reads second: a reconnect committing just before the lease hands over the NEW token", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    // The previous release reconnects in the instant before our claim's update.
    h.state.beforeNextTokenUpdate = () => oldRelease.write(tokenSet("c2"), "oauth-connect");

    const claim = await claimXeroTokenRefreshLease();
    if (!claim.claimed) throw new Error("expected the lease");
    expect(claim.tokens.refreshToken).toBe("refresh-c2");

    // And the save under that claim lands on the reconnect's version.
    await saveXeroTokens(tokenSet("r1"), { actor: REFRESH_JOB, lease: claim.lease });
    await expect(oldRelease.load()).resolves.toMatchObject({
      source: "store",
      refreshToken: "refresh-r1",
    });
  });
});

describe("a refresh refuses before spending the token when its save could not succeed (#3454 review)", () => {
  it("refuses under an auth secret the capture gate would reject", async () => {
    process.env.AUTH_SECRET = "too-short";
    await expect(assertXeroTokensCanBeStored()).rejects.toBeInstanceOf(
      XeroTokenSaveUnavailableError,
    );
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
  });

  it("passes when the save would succeed, and writes nothing", async () => {
    await assertXeroTokensCanBeStored();
    expect(h.state.credential).toEqual([]);
    expect(h.state.audit).toEqual([]);
  });
});

describe("mixed runtime: the previous release interleaved with this one never spends a rotated token (#3806)", () => {
  it("survives refreshes alternating between the releases, both ways round", async () => {
    const xero = makeXero("refresh-c1");
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });

    for (let round = 0; round < 3; round += 1) {
      await newRefresh(xero);
      // The previous release, through its own read, claim and dual write.
      const seen = await oldRelease.load();
      expect(seen?.source).toBe("store");
      expect(oldRelease.claimLease()).toBe(true);
      await oldRelease.write(xero.spend(seen!.refreshToken), "token-refresh");
    }

    await newRefresh(xero);
    await expect(loadXeroTokens()).resolves.toMatchObject({ refreshToken: xero.live });
    await expect(oldRelease.load()).resolves.toMatchObject({
      source: "store",
      refreshToken: xero.live,
    });
  });

  it("follows the previous release's disconnect and its first connect", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    oldRelease.disconnect();
    await expect(isXeroConnected()).resolves.toBe(false);
    await expect(loadXeroTokens()).resolves.toBeNull();

    await oldRelease.write(tokenSet("again", "tenant-2"), "oauth-connect");
    await expect(isXeroConnected()).resolves.toBe(true);
    expect(h.state.xeroConnection[0].tenantId).toBe("tenant-2");
  });
});

describe("destroying the tokens records who and why, once (#3454)", () => {
  it("a disconnect deletes every copy and writes ONE row naming the administrator", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    h.state.audit = [];

    await deleteXeroTokens({ actor: ADMIN, request: REQUEST, cause: { kind: "oauth-disconnect" } });

    expect(h.state.xeroToken).toEqual([]);
    expect(h.state.xeroConnection).toEqual([]);
    expect(h.state.credential).toEqual([]);
    const audits = credentialAudits("integration.credential.deleted");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorMemberId: "admin-7", requestId: "req-1" });
    expect(audits[0].metadata).toMatchObject({ cause: "oauth-disconnect" });
  });

  it("still records destroying a connection whose store copy was already gone", async () => {
    await oldRelease.write(tokenSet("pre"), "oauth-connect");
    h.state.credential = [];
    h.state.audit = [];

    await deleteXeroTokens({ actor: ADMIN, cause: { kind: "oauth-disconnect" } });

    expect(h.state.xeroToken).toEqual([]);
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

    expect(h.state.xeroToken).toEqual([]);
    expect(h.state.xeroConnection).toEqual([]);
    expect(h.state.credential.map((row) => `${row.provider}:${row.key}`)).toEqual([
      "xero:client_secret",
    ]);
    expect(h.state.audit.map((row) => row.action)).toEqual([
      "integration.credential.set",
      "integration.credential.deleted",
    ]);
    // One request, one administrator, and the delete says what caused it.
    expect(new Set(h.state.audit.map((row) => row.requestId))).toEqual(new Set(["req-1"]));
    expect(h.state.audit[1].metadata).toMatchObject({
      cause: "verify-reset",
      causedByCredential: "xero:client_secret",
    });
  });

  it("rolls the credential write back when destroying the tokens fails", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    const before = structuredClone({
      xeroToken: h.state.xeroToken,
      xeroConnection: h.state.xeroConnection,
      credential: h.state.credential,
    });
    h.state.failAuditAt = 2; // the credential's row lands, the token delete's does not

    await expect(saveClientSecret("new-client-secret")).rejects.toThrow(
      "audit write failed",
    );
    expect({
      xeroToken: h.state.xeroToken,
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

    // Connect, refresh, a reconnect.
    await saveXeroTokens(sentinelSet("c1"), { actor: ADMIN, request: REQUEST });
    const claim = await claimXeroTokenRefreshLease();
    if (!claim.claimed) throw new Error("expected the lease");
    await saveXeroTokens(sentinelSet("r1"), { actor: REFRESH_JOB, lease: claim.lease });
    await loadXeroTokens();
    await saveXeroTokens(sentinelSet("c2"), { actor: ADMIN });

    // A lease that expired under a reconnect.
    const lostLease = await claimXeroTokenRefreshLease();
    if (!lostLease.claimed) throw new Error("expected the lease");
    await saveXeroTokens(sentinelSet("c3"), { actor: ADMIN });
    await capture(() =>
      saveXeroTokens(sentinelSet("late"), { actor: REFRESH_JOB, lease: lostLease.lease }),
    );

    // A stale compare-and-set.
    const staleLease = await claimXeroTokenRefreshLease();
    if (!staleLease.claimed) throw new Error("expected the lease");
    await h.db.$transaction((tx) =>
      setIntegrationCredentialInTransaction({
        tx: tx as never,
        provider: XERO_OAUTH_TOKEN_PROVIDER,
        key: XERO_OAUTH_TOKEN_KEY,
        value: JSON.stringify(sentinelSet("bypass")),
        actor: ADMIN,
        expect: { expect: "any" },
      }),
    );
    await capture(() =>
      saveXeroTokens(sentinelSet("stale"), { actor: REFRESH_JOB, lease: staleLease.lease }),
    );
    await releaseXeroTokenRefreshLease(staleLease.lease);

    // A store copy written under an auth secret that has since changed.
    await saveXeroTokens(sentinelSet("c4"), { actor: ADMIN });
    process.env.AUTH_SECRET = "t".repeat(48);
    await capture(() => loadXeroTokens());
    await getXeroTokenReadability();
    process.env.AUTH_SECRET = "s".repeat(48);

    // The verify-reset, then the disconnect of a fresh connection.
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

    // The instrument saw real traffic, including the failures.
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

  it("no table stores the token in plaintext, and XeroToken stores no ciphertext either", async () => {
    await saveXeroTokens(sentinelSet("c1"), { actor: ADMIN });
    expect(
      JSON.stringify([h.state.xeroToken, h.state.xeroConnection, h.state.credential]),
    ).not.toContain(SENTINEL);
    expect(h.state.xeroToken[0]).toMatchObject({ accessToken: "", refreshToken: "" });
  });
});
