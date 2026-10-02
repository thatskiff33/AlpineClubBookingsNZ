/**
 * The Xero OAuth tokens in the credential store, with the `XeroToken` mirror
 * kept for the blue-green window (#3454).
 *
 * WHAT THIS PROVES, against a STATEFUL double of the two tables and the audit
 * log, so a rolled-back transaction really leaves the rows as they were:
 *
 *   - every write lands both copies and ONE attributed audit row, or nothing;
 *   - the read decides which copy is current by the mirror fingerprint, in all
 *     four cases of the reconcile, and a lease claim does not move it;
 *   - a deployed OLD colour — which reads, refreshes and deletes only the
 *     `XeroToken` row — interleaved with this code never makes either side
 *     spend a refresh token that has already been rotated;
 *   - a refresh's save is fenced by the lease AND by the store's
 *     compare-and-set, and losing either rolls both copies back;
 *   - the verify-reset commits with the credential write that causes it;
 *   - no plaintext token reaches an audit row, a log line or an error.
 *
 * What it does NOT prove: Postgres row-lock behaviour under real concurrency.
 * That is `xero-token-credential-store.realdb.test.ts`.
 */
import { createCipheriv, randomBytes } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
  const state = {
    xeroToken: [] as Row[],
    credential: [] as Row[],
    audit: [] as Row[],
    nextId: 1,
    /** When set, the Nth audit write (1-based, counted from now) throws. */
    failAuditAt: null as number | null,
    /** Transactions currently open. */
    txDepth: 0,
    /** Writes made through the MODULE client while a transaction was open. */
    outsideTxWrites: [] as string[],
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

  const xeroToken = {
    findFirst: vi.fn(async () => clone(state.xeroToken[0] ?? null)),
    findUnique: vi.fn(async (args: { where: Row }) =>
      clone(state.xeroToken.find((row) => matches(row, args.where)) ?? null),
    ),
    create: vi.fn(async (args: { data: Row }) => {
      const row = {
        id: `xt-${state.nextId++}`,
        createdAt: now(),
        updatedAt: now(),
        refreshInProgressUntil: null,
        tenantId: null,
        ...args.data,
      };
      state.xeroToken.push(row);
      return clone(row);
    }),
    update: vi.fn(async (args: { where: Row; data: Row }) => {
      const row = state.xeroToken.find((candidate) => matches(candidate, args.where));
      if (!row) throw new Error("Record to update not found.");
      Object.assign(row, args.data, { updatedAt: now() });
      return clone(row);
    }),
    updateMany: vi.fn(async (args: { where: Row; data: Row }) => {
      let count = 0;
      for (const row of state.xeroToken) {
        if (matches(row, args.where)) {
          Object.assign(row, args.data, { updatedAt: now() });
          count += 1;
        }
      }
      return { count };
    }),
    deleteMany: vi.fn(async (args?: { where?: Row }) => {
      const before = state.xeroToken.length;
      state.xeroToken = state.xeroToken.filter((row) => !matches(row, args?.where));
      return { count: before - state.xeroToken.length };
    }),
  };

  const integrationCredential = {
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
  const READS = new Set(["findFirst", "findUnique", "findMany"]);
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

  const tx = { xeroToken, integrationCredential, auditLog };

  const db = {
    xeroToken: moduleClient("xeroToken", xeroToken),
    integrationCredential: moduleClient("integrationCredential", integrationCredential),
    auditLog: moduleClient("auditLog", auditLog),
    // A rolled-back transaction leaves every table as it found it.
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      const snapshot = clone({
        xeroToken: state.xeroToken,
        credential: state.credential,
        audit: state.audit,
      });
      state.txDepth += 1;
      try {
        return await work(tx);
      } catch (error) {
        state.xeroToken = snapshot.xeroToken;
        state.credential = snapshot.credential;
        state.audit = snapshot.audit;
        throw error;
      } finally {
        state.txDepth -= 1;
      }
    }),
  };

  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

  return {
    state,
    db,
    /** The transaction client's raw delegates, for interleaving hooks. */
    raw: tx,
    logger,
    tokenKey: { value: "a".repeat(64) as string | undefined },
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: h.db }));
vi.mock("@/lib/logger", () => ({ default: h.logger, logger: h.logger }));
vi.mock("@/lib/xero-config", () => ({
  getOperationalXeroEncryptionKey: vi.fn(async () => h.tokenKey.value),
  peekOperationalXeroEncryptionKey: vi.fn(async () => h.tokenKey.value),
}));

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
  decryptToken,
  deleteXeroTokens,
  getXeroTokenReadability,
  isXeroConnected,
  loadXeroTokens,
  releaseXeroTokenRefreshLease,
  saveXeroTokens,
  withXeroVerifyReset,
  type TokenData,
} from "@/lib/xero-token-store";

const ADMIN: CredentialActor = { kind: "admin", memberId: "admin-7" };
const REFRESH_JOB: CredentialActor = { kind: "system", actor: "xero-token-refresh" };
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const REQUEST = { id: "req-1", ipAddress: "10.0.0.1", userAgent: "test-agent" };

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

/** The format the PREVIOUS release writes into `XeroToken`, byte for byte. */
function oldColourEncrypt(plaintext: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(KEY_A, "hex"), iv, {
    authTagLength: 16,
  });
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${encrypted}`;
}

/**
 * The previous release's code paths, which know nothing of the store: it
 * claims the lease on `XeroToken`, rewrites only that row, and deletes only it.
 */
const oldColour = {
  async load(): Promise<TokenData & { id: string }> {
    const row = h.state.xeroToken[0];
    if (!row) throw new Error("old colour: not connected");
    return {
      id: row.id as string,
      accessToken: await decryptToken(row.accessToken as string),
      refreshToken: await decryptToken(row.refreshToken as string),
      expiresAt: row.expiresAt as Date,
      tenantId: (row.tenantId as string | null) ?? undefined,
    };
  },
  claimLease(now = new Date()): boolean {
    const row = h.state.xeroToken[0];
    const lease = row?.refreshInProgressUntil as Date | null | undefined;
    if (!row || (lease && lease > now)) return false;
    row.refreshInProgressUntil = new Date(now.getTime() + 120_000);
    return true;
  },
  save(tokens: TokenData): void {
    const row = h.state.xeroToken[0];
    Object.assign(row, {
      accessToken: oldColourEncrypt(tokens.accessToken),
      refreshToken: oldColourEncrypt(tokens.refreshToken),
      expiresAt: tokens.expiresAt,
      tenantId: tokens.tenantId ?? null,
      refreshInProgressUntil: null,
      updatedAt: new Date(),
    });
  },
  disconnect(): void {
    h.state.xeroToken = [];
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

/** The new code's refresh, exactly as `getAuthenticatedXeroClient` drives it. */
async function newColourRefresh(xero: ReturnType<typeof makeXero>): Promise<void> {
  const claim = await claimXeroTokenRefreshLease();
  if (!claim.claimed) throw new Error("new colour: lease not claimed");
  const next = xero.spend(claim.tokens.refreshToken);
  await saveXeroTokens(next, {
    actor: REFRESH_JOB,
    lease: { claimed: claim.tokens, leaseUntil: claim.leaseUntil },
  });
}

function credentialAudits(action?: string): Row[] {
  return h.state.audit.filter(
    (row) =>
      row.entityId === `${XERO_OAUTH_TOKEN_PROVIDER}:${XERO_OAUTH_TOKEN_KEY}` &&
      (action === undefined || row.action === action),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.xeroToken = [];
  h.state.credential = [];
  h.state.audit = [];
  h.state.failAuditAt = null;
  h.state.txDepth = 0;
  h.state.outsideTxWrites = [];
  h.tokenKey.value = KEY_A;
  resetIntegrationCredentialCacheForTests();
  delete process.env.NEXTAUTH_SECRET;
  process.env.AUTH_SECRET = "s".repeat(48);
});

afterEach(() => {
  // Every write a transaction composes went through that transaction's client.
  expect(h.state.outsideTxWrites).toEqual([]);
});

describe("a connect writes both copies and one attributed audit row (#3454)", () => {
  it("stores the set in the credential store and a mirror the old colour can read", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN, request: REQUEST });

    expect(h.state.xeroToken).toHaveLength(1);
    expect(h.state.credential).toHaveLength(1);
    expect(h.state.credential[0]).toMatchObject({
      provider: XERO_OAUTH_TOKEN_PROVIDER,
      key: XERO_OAUTH_TOKEN_KEY,
      updatedByUserId: "admin-7",
    });
    // The mirror is exactly what the previous release decrypts.
    await expect(oldColour.load()).resolves.toMatchObject({
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

  it("commits neither copy when the audit row fails", async () => {
    h.state.failAuditAt = 1;
    await expect(
      saveXeroTokens(tokenSet("c1"), { actor: ADMIN }),
    ).rejects.toThrow("audit write failed");
    expect(h.state.xeroToken).toEqual([]);
    expect(h.state.credential).toEqual([]);
  });
});

describe("the read reconciles the two copies by fingerprint, never by clock (#3454)", () => {
  it("no XeroToken row is NOT connected, whatever the store holds (the old colour disconnected)", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    oldColour.disconnect();

    expect(h.state.credential).toHaveLength(1);
    await expect(loadXeroTokens()).resolves.toBeNull();
    await expect(isXeroConnected()).resolves.toBe(false);
    await expect(getXeroTokenReadability()).resolves.toBe("no_tokens");
    // A read writes nothing, so it audits nothing.
    expect(credentialAudits()).toHaveLength(1);
  });

  it("a pre-upgrade XeroToken row with no store copy is read as it always was", async () => {
    h.state.xeroToken.push({
      id: "legacy-1",
      accessToken: oldColourEncrypt("access-legacy"),
      refreshToken: oldColourEncrypt("refresh-legacy"),
      expiresAt: new Date("2026-07-01T00:20:00.000Z"),
      tenantId: "tenant-legacy",
      refreshInProgressUntil: null,
    });

    await expect(loadXeroTokens()).resolves.toMatchObject({
      id: "legacy-1",
      accessToken: "access-legacy",
      refreshToken: "refresh-legacy",
      tenantId: "tenant-legacy",
      storeVersion: null,
    });
    expect(h.state.audit).toEqual([]);
  });

  it("a matching fingerprint reads the STORE copy — proved by a mirror this process cannot decrypt", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    // The wrapped token key is gone, so the mirror is undecryptable; only the
    // store copy can answer, and it does.
    h.tokenKey.value = KEY_B;

    await expect(loadXeroTokens()).resolves.toMatchObject({
      accessToken: "access-c1",
      refreshToken: "refresh-c1",
    });
    await expect(getXeroTokenReadability()).resolves.toBe("readable");
  });

  it("a lease claim alone does not move the fingerprint", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    expect(oldColour.claimLease()).toBe(true);
    h.tokenKey.value = KEY_B;

    await expect(loadXeroTokens()).resolves.toMatchObject({
      refreshToken: "refresh-c1",
      refreshInProgressUntil: expect.any(Date),
    });
  });

  it("a row the old colour rewrote is the NEWER copy, and is read instead of the store", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    const storedBefore = structuredClone(h.state.credential);
    oldColour.save(tokenSet("old-refresh"));

    // The store still holds c1, but it is no longer current.
    expect(h.state.credential).toEqual(storedBefore);
    await expect(loadXeroTokens()).resolves.toMatchObject({
      accessToken: "access-old-refresh",
      refreshToken: "refresh-old-refresh",
      storeVersion: expect.any(String),
    });
  });

  it("never answers from the credential store's cache: another container's write is seen at once", async () => {
    // What another container will have written: capture it, then rebuild this
    // process's own (older) state and warm the provider cache with it.
    await saveXeroTokens(tokenSet("other-container"), { actor: ADMIN });
    const theirs = structuredClone({
      xeroToken: h.state.xeroToken,
      credential: h.state.credential,
    });
    const theirVersion = (await loadXeroTokens())?.storeVersion;
    h.state.xeroToken = [];
    h.state.credential = [];
    resetIntegrationCredentialCacheForTests();
    await saveXeroTokens(tokenSet("ours"), { actor: ADMIN });
    await resolveIntegrationCredential(XERO_OAUTH_TOKEN_PROVIDER, XERO_OAUTH_TOKEN_KEY);

    // The other container commits; nothing in THIS process invalidates.
    h.state.xeroToken = theirs.xeroToken;
    h.state.credential = theirs.credential;

    const read = await loadXeroTokens();
    expect(read?.refreshToken).toBe("refresh-other-container");
    // The version a refresh would compare-and-set against is the stored one,
    // not a cached one that would make the write lose for no reason.
    expect(read?.storeVersion).toBe(theirVersion);
  });

  it("does NOT trust updatedAt: a store copy stamped later still loses to a rewritten row", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    oldColour.save(tokenSet("old-refresh"));
    // Clock skew between containers: the old colour's clock ran behind.
    h.state.xeroToken[0].updatedAt = new Date("2020-01-01T00:00:00.000Z");
    h.state.credential[0].updatedAt = new Date("2030-01-01T00:00:00.000Z");

    await expect(loadXeroTokens()).resolves.toMatchObject({
      refreshToken: "refresh-old-refresh",
    });
  });
});

describe("a refresh is fenced by the shared lease and by the store's compare-and-set (#3454)", () => {
  it("writes both copies and one audit row naming the refresh job; the lease is not audited", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    const xero = makeXero("refresh-c1");

    await newColourRefresh(xero);

    expect(h.state.xeroToken[0].refreshInProgressUntil).toBeNull();
    await expect(oldColour.load()).resolves.toMatchObject({
      refreshToken: "refresh-r1",
    });
    await expect(loadXeroTokens()).resolves.toMatchObject({
      refreshToken: "refresh-r1",
    });
    const audits = credentialAudits();
    expect(audits).toHaveLength(2); // the connect, then the refresh
    expect(audits[1].actorMemberId ?? null).toBeNull();
    expect(audits[1].metadata).toMatchObject({
      actorKind: "system",
      systemActor: "xero-token-refresh",
      expectation: "version",
      cause: "token-refresh",
    });
  });

  it("a release audits nothing", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    const claim = await claimXeroTokenRefreshLease();
    expect(claim.claimed).toBe(true);
    if (!claim.claimed) return;
    await releaseXeroTokenRefreshLease(claim.tokens.id, claim.leaseUntil);
    expect(h.state.xeroToken[0].refreshInProgressUntil).toBeNull();
    expect(credentialAudits()).toHaveLength(1);
  });

  it("the old colour and this one compete for ONE lease", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    expect(oldColour.claimLease()).toBe(true);
    const claim = await claimXeroTokenRefreshLease();
    expect(claim.claimed).toBe(false);

    h.state.xeroToken[0].refreshInProgressUntil = null;
    const ours = await claimXeroTokenRefreshLease();
    expect(ours.claimed).toBe(true);
    expect(oldColour.claimLease()).toBe(false);
  });

  it("a pre-upgrade row is refreshed into the store with an `absent` expectation", async () => {
    h.state.xeroToken.push({
      id: "legacy-1",
      accessToken: oldColourEncrypt("access-legacy"),
      refreshToken: oldColourEncrypt("refresh-legacy"),
      expiresAt: new Date("2026-07-01T00:20:00.000Z"),
      tenantId: "tenant-1",
      refreshInProgressUntil: null,
    });
    const xero = makeXero("refresh-legacy");

    await newColourRefresh(xero);

    expect(h.state.credential).toHaveLength(1);
    expect(credentialAudits()[0].metadata).toMatchObject({ expectation: "absent" });
    await expect(oldColour.load()).resolves.toMatchObject({ refreshToken: "refresh-r1" });
  });

  it("a reconnect during the refresh wins: the save throws and neither copy moves", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    const claim = await claimXeroTokenRefreshLease();
    if (!claim.claimed) throw new Error("expected the lease");
    await saveXeroTokens(tokenSet("reconnect"), { actor: ADMIN });
    const afterReconnect = structuredClone({
      xeroToken: h.state.xeroToken,
      credential: h.state.credential,
    });

    await expect(
      saveXeroTokens(tokenSet("late-refresh"), {
        actor: REFRESH_JOB,
        lease: { claimed: claim.tokens, leaseUntil: claim.leaseUntil },
      }),
    ).rejects.toThrow("lease expired");

    expect({ xeroToken: h.state.xeroToken, credential: h.state.credential }).toEqual(
      afterReconnect,
    );
    await expect(loadXeroTokens()).resolves.toMatchObject({
      refreshToken: "refresh-reconnect",
    });
  });

  it("a store copy replaced behind the lease makes the save LOSE and rolls the mirror back too", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    const claim = await claimXeroTokenRefreshLease();
    if (!claim.claimed) throw new Error("expected the lease");
    // A writer that bypassed the lease rewrote the store copy.
    await h.db.$transaction((tx) =>
      setIntegrationCredentialInTransaction({
        tx: tx as never,
        provider: XERO_OAUTH_TOKEN_PROVIDER,
        key: XERO_OAUTH_TOKEN_KEY,
        value: "{}",
        actor: ADMIN,
        expect: { expect: "any" },
      }),
    );
    const mirrorBefore = structuredClone(h.state.xeroToken);

    await expect(
      saveXeroTokens(tokenSet("refreshed"), {
        actor: REFRESH_JOB,
        lease: { claimed: claim.tokens, leaseUntil: claim.leaseUntil },
      }),
    ).rejects.toBeInstanceOf(StaleCredentialWriteError);

    // The lease-guarded mirror update ran first and was rolled back with it.
    expect(h.state.xeroToken).toEqual(mirrorBefore);
    expect(h.state.xeroToken[0].refreshInProgressUntil).toEqual(claim.leaseUntil);
  });
});

describe("interleaving inside a read: a write that commits between the two copies' reads (#3454 review)", () => {
  /** Run `during` once, at the store-row read, after that read has its answer. */
  function commitDuringStoreRead(during: () => Promise<unknown>) {
    const findUnique = h.raw.integrationCredential.findUnique;
    const original = findUnique.getMockImplementation();
    if (!original) throw new Error("expected the double's findUnique");
    findUnique.mockImplementationOnce(async (args: { where: Row }) => {
      const answer = await original(args);
      await during();
      return answer;
    });
  }

  it("a reconnect that commits while a refresh is being claimed survives the refresh", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    commitDuringStoreRead(() => saveXeroTokens(tokenSet("reconnect"), { actor: ADMIN }));

    const claim = await claimXeroTokenRefreshLease();
    if (claim.claimed) {
      // Xero, asked to refresh whatever the claim handed over.
      const next = { ...tokenSet("x"), refreshToken: `from-${claim.tokens.refreshToken}` };
      await saveXeroTokens(next, {
        actor: REFRESH_JOB,
        lease: { claimed: claim.tokens, leaseUntil: claim.leaseUntil },
      }).catch(() => undefined);
    }

    // The reconnect's grant is what is stored; nothing refreshed from c1 won.
    const stored = await loadXeroTokens();
    expect(stored?.refreshToken).toContain("reconnect");
    expect(stored?.refreshToken).not.toContain("c1");
    await expect(oldColour.load()).resolves.toMatchObject({
      refreshToken: expect.stringContaining("reconnect"),
    });
  });

  it("a reconnect that commits just before the lease is taken: the claim hands over the NEW refresh token", async () => {
    // In PostgreSQL a writer either commits before the claim's guarded UPDATE
    // takes the row lock, or waits for the claim to commit. This is the first
    // case: the claim must read the tokens AFTER taking the lock, so it can
    // only ever hand over what is stored now. A claim that read first handed
    // over the replaced grant's refresh token.
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    const updateMany = h.raw.xeroToken.updateMany;
    const original = updateMany.getMockImplementation();
    if (!original) throw new Error("expected the double's updateMany");
    updateMany.mockImplementationOnce(async (args: { where: Row; data: Row }) => {
      await saveXeroTokens(tokenSet("reconnect"), { actor: ADMIN });
      return original(args);
    });

    const claim = await claimXeroTokenRefreshLease();

    expect(claim.claimed).toBe(true);
    expect(claim.tokens?.refreshToken).toBe("refresh-reconnect");
    if (!claim.claimed) return;
    // And the refresh of it lands: the version it carries is the stored one.
    await saveXeroTokens(
      { ...tokenSet("r"), refreshToken: "refresh-from-reconnect" },
      { actor: REFRESH_JOB, lease: { claimed: claim.tokens, leaseUntil: claim.leaseUntil } },
    );
    await expect(loadXeroTokens()).resolves.toMatchObject({
      refreshToken: "refresh-from-reconnect",
    });
  });

  it("a read that straddles a save returns the NEW copy, not the one just replaced", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    commitDuringStoreRead(() => saveXeroTokens(tokenSet("c2"), { actor: ADMIN }));

    await expect(loadXeroTokens()).resolves.toMatchObject({ refreshToken: "refresh-c2" });
  });

  it("a read that straddles a disconnect reads as not connected, never the deleted tokens", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    commitDuringStoreRead(() =>
      deleteXeroTokens({ actor: ADMIN, cause: { kind: "oauth-disconnect" } }),
    );

    await expect(loadXeroTokens()).resolves.toBeNull();
  });
});

describe("a refresh refuses before spending the token when its save could not succeed (#3454 review)", () => {
  it("refuses under an auth secret the capture gate would reject", async () => {
    process.env.AUTH_SECRET = "too-short";
    await expect(assertXeroTokensCanBeStored()).rejects.toBeInstanceOf(
      XeroTokenSaveUnavailableError,
    );
    await expect(assertXeroTokensCanBeStored()).rejects.toThrow(/auth secret/);
  });

  it("refuses when the wrapped token key cannot be resolved", async () => {
    h.tokenKey.value = undefined;
    await expect(assertXeroTokensCanBeStored()).rejects.toThrow(/encryption key/);
  });

  it("passes when both would succeed, and writes nothing", async () => {
    await expect(assertXeroTokensCanBeStored()).resolves.toBeUndefined();
    expect(h.state.audit).toEqual([]);
    expect(h.state.credential).toEqual([]);
  });
});

describe("mixed runtime: the old colour interleaved with this one never spends a rotated token (#3454)", () => {
  it("survives refreshes alternating between the colours, both ways round", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    const xero = makeXero("refresh-c1");

    // Old colour refreshes first: it claims the lease on XeroToken, spends the
    // live token and writes only XeroToken.
    expect(oldColour.claimLease()).toBe(true);
    const fromOld = xero.spend((await oldColour.load()).refreshToken);
    oldColour.save(fromOld);

    // This colour must now spend what the old colour stored, not its own copy.
    await newColourRefresh(xero);
    // And the old colour must spend what this colour stored.
    expect(oldColour.claimLease()).toBe(true);
    oldColour.save(xero.spend((await oldColour.load()).refreshToken));
    await newColourRefresh(xero);
    await newColourRefresh(xero);

    // Every spend was the live token; none was a rotated one.
    expect(xero.spent).toEqual([
      "refresh-c1",
      "refresh-r1",
      "refresh-r2",
      "refresh-r3",
      "refresh-r4",
    ]);
    await expect(loadXeroTokens()).resolves.toMatchObject({ refreshToken: xero.live });
    await expect(oldColour.load()).resolves.toMatchObject({ refreshToken: xero.live });
  });
});

describe("destroying the tokens records who and why, once (#3454)", () => {
  it("a disconnect deletes both copies and writes ONE row naming the administrator", async () => {
    await saveXeroTokens(tokenSet("c1"), { actor: ADMIN });
    await deleteXeroTokens({ actor: ADMIN, request: REQUEST, cause: { kind: "oauth-disconnect" } });

    expect(h.state.xeroToken).toEqual([]);
    expect(h.state.credential).toEqual([]);
    const deletes = credentialAudits("integration.credential.deleted");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatchObject({ actorMemberId: "admin-7", requestId: "req-1" });
    expect(deletes[0].metadata).toMatchObject({ cause: "oauth-disconnect" });
  });

  it("still records destroying a pre-upgrade grant that only XeroToken held", async () => {
    h.state.xeroToken.push({
      id: "legacy-1",
      accessToken: oldColourEncrypt("a"),
      refreshToken: oldColourEncrypt("r"),
      expiresAt: new Date(),
      tenantId: "tenant-1",
      refreshInProgressUntil: null,
    });
    await deleteXeroTokens({ actor: ADMIN, cause: { kind: "oauth-disconnect" } });

    expect(h.state.xeroToken).toEqual([]);
    expect(credentialAudits("integration.credential.deleted")).toHaveLength(1);
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
      credential: h.state.credential,
    });
    h.state.failAuditAt = 2; // the credential's row lands, the token delete's does not

    await expect(saveClientSecret("new-client-secret")).rejects.toThrow(
      "audit write failed",
    );
    expect({ xeroToken: h.state.xeroToken, credential: h.state.credential }).toEqual(
      before,
    );
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

    // Connect, refresh, the reconcile-from-legacy read, a reconnect.
    await saveXeroTokens(sentinelSet("c1"), { actor: ADMIN, request: REQUEST });
    const claim = await claimXeroTokenRefreshLease();
    if (!claim.claimed) throw new Error("expected the lease");
    await saveXeroTokens(sentinelSet("r1"), {
      actor: REFRESH_JOB,
      lease: { claimed: claim.tokens, leaseUntil: claim.leaseUntil },
    });
    oldColour.save(sentinelSet("old"));
    await loadXeroTokens();
    await saveXeroTokens(sentinelSet("c2"), { actor: ADMIN });

    // A lease that expired under a reconnect.
    const lostLease = await claimXeroTokenRefreshLease();
    if (!lostLease.claimed) throw new Error("expected the lease");
    await saveXeroTokens(sentinelSet("c3"), { actor: ADMIN });
    await capture(() =>
      saveXeroTokens(sentinelSet("late"), {
        actor: REFRESH_JOB,
        lease: { claimed: lostLease.tokens, leaseUntil: lostLease.leaseUntil },
      }),
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
      saveXeroTokens(sentinelSet("stale"), {
        actor: REFRESH_JOB,
        lease: { claimed: staleLease.tokens, leaseUntil: staleLease.leaseUntil },
      }),
    );
    h.state.xeroToken[0].refreshInProgressUntil = null;

    // An undecryptable mirror with no current store copy (the auth secret moved).
    oldColour.save(sentinelSet("old-2"));
    h.tokenKey.value = KEY_B;
    await capture(() => loadXeroTokens());
    await getXeroTokenReadability();
    h.tokenKey.value = KEY_A;

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
    await saveXeroTokens(sentinelSet("c4"), { actor: ADMIN });
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

  it("neither table stores the token in plaintext", async () => {
    await saveXeroTokens(sentinelSet("c1"), { actor: ADMIN });
    expect(JSON.stringify([h.state.xeroToken, h.state.credential])).not.toContain(SENTINEL);
  });
});
