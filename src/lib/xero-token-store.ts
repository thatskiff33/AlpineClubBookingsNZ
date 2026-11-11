/**
 * Xero Token Storage
 *
 * Persists the Xero OAuth token set (access, refresh, expiry, tenant), owns the
 * connection row and the refresh lease, and reports connection status. Keeps
 * token plaintext out of the database.
 *
 * Since #3454 the tokens live in the encrypted integration credential store.
 * Since #3806 the connection's non-secret facts and the only refresh lease live
 * in `XeroConnection`. The old `XeroToken` table is gone.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import {
  recordCredentialMutation,
  CREDENTIAL_AUDIT_ACTIONS,
  type CredentialActor,
  type CredentialMutationCause,
  type CredentialRequestContext,
  type CredentialVersion,
} from "@/lib/integration-credential-actor";
import {
  deleteIntegrationCredentialInTransaction,
  deletedCredentialSummary,
  readIntegrationCredentialRow,
  setIntegrationCredentialInTransaction,
  withCredentialTransaction,
} from "@/lib/integration-credentials";
import { XERO_PROVIDER } from "@/lib/xero-config";
import {
  isConnectedTenant,
  readXeroConnection,
  XERO_CONNECTION_ID,
} from "@/lib/xero-connection";
import { invalidateXeroOrganisationCaches } from "@/lib/xero-organisation-cache-bus";
import {
  XeroTokenDecryptError,
  xeroTokenSaveRefusal,
  type XeroTokenSaveRefusal,
} from "@/lib/xero-token-errors";
import {
  serializeStoredTokenSet,
  tokenSetForConnection,
  type ConnectionTokenSetRefusal,
} from "@/lib/xero-token-set";

/**
 * Why a Xero connection needs attention: its stored tokens cannot be read
 * (a reconnect fixes it), or a refreshed pair could not be stored (only the
 * server's configuration fixes it; see `XeroTokenSaveRefusal`).
 */
export type XeroReentryCause = "tokens-unreadable" | XeroTokenSaveRefusal;

// Every caller already finds these here.
export {
  assertXeroTokensCanBeStored,
  XeroTokenDecryptError,
  XeroTokenSaveUnavailableError,
} from "@/lib/xero-token-errors";

export interface TokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  tenantId?: string;
}

export interface XeroTokenRecord extends TokenData {
  /** When the refresh lease releases, or null when none is held. */
  refreshInProgressUntil: Date | null;
}

/**
 * What a won claim hands to the save and the release. Opaque to callers: they
 * pass it back unchanged.
 */
export interface XeroRefreshLease {
  leaseUntil: Date;
  /** The credential-store version read under the lease; the save compares-and-sets on it. */
  storeVersion: CredentialVersion;
}

export const XERO_TOKEN_REFRESH_LEASE_MS = 2 * 60 * 1000;

export type XeroTokenRefreshLeaseClaim =
  | {
      claimed: true;
      tokens: XeroTokenRecord;
      leaseUntil: Date;
      lease: XeroRefreshLease;
    }
  | {
      claimed: false;
      tokens: XeroTokenRecord | null;
      leaseUntil: Date | null;
    };

// ---------------------------------------------------------------------------
// Where things live (#3454, #3806)
// ---------------------------------------------------------------------------
//
// THE TOKENS are ONE row of the encrypted integration-credential store
// (`xero-oauth` / `token-set`), so every write names its actor, commits its
// audit row in the same transaction and declares what it expected to find
// (`INV-PRIV-020`). It is its own provider namespace rather than a key under
// "xero": a refresh every half hour must not drop the cached Xero client id and
// secret, and a token that no longer decrypts needs a RECONNECT, which is not the
// "re-enter your credentials" aggregate `providerNeedsReentry("xero")` drives.
//
// THE CONNECTION AND THE LEASE are the one `XeroConnection` row: no row means
// not connected; it carries the tenant, the access token's expiry and the
// refresh lease, and nothing secret. `readXeroConnection` is the one reader of
// the facts (`xero-connection.ts`). There is no advisory lock (`INV-LOCK-001`).
// Inside one transaction the order is that row, then the credential-store write
// (`INV-LOCK-002`). `withCredentialTransaction` is only `prisma.$transaction`
// plus cache invalidation; it does not take a lock before the callback.
//
// TWO CONNECTS AT THE SAME MOMENT can still commit the connection row from one
// grant and the store copy from the other, because the store write uses
// `expect: "any"`. `tokenSetForConnection` reads a tenant disagreement as
// reconnect-required. That is the remaining limit. `XeroConnection` is a
// singleton, so the old "two token rows" limit is gone with the table.
//
// THE STORE'S CACHE IS NEVER USED FOR THE TOKENS: `readIntegrationCredentialRow`
// reads through the database on the caller's client, so a refresh token another
// container has just rotated can never be served stale from this process.

/** The credential-store namespace for the Xero OAuth token set. */
export const XERO_OAUTH_TOKEN_PROVIDER = "xero-oauth";
/** The one row in that namespace. */
export const XERO_OAUTH_TOKEN_KEY = "token-set";

/**
 * The wrapped key the old token ciphertext was encrypted under until #3806 R2.
 * Nothing here uses it any more. A leftover row would still be read by the
 * provider's re-entry aggregate, and after an auth-secret change nothing would
 * ever replace it, so the next connect, disconnect or verify-reset deletes it.
 */
const RETIRED_XERO_TOKEN_KEY = "token_key";

type XeroTokenDb = Pick<Prisma.TransactionClient, "xeroConnection" | "integrationCredential">;

/** Who is writing the tokens, and from which request. Required on every write. */
export interface XeroTokenWriteContext {
  actor: CredentialActor;
  request?: CredentialRequestContext;
}

interface CurrentTokens {
  record: XeroTokenRecord;
  storeVersion: CredentialVersion;
}

/**
 * Read the current token set on `db`, or `null` when Xero is not connected.
 * Throws `XeroTokenDecryptError` when a connection exists but its store copy is
 * missing, unreadable or malformed, or names a different organisation from the
 * connection (`tokenSetForConnection`): only a reconnect fixes that.
 */
async function readCurrentTokens(db: XeroTokenDb): Promise<CurrentTokens | null> {
  // The store row first: every writer that replaces the token set also rewrites
  // or deletes the connection row, so a disconnect committing between these
  // reads leaves the SECOND read saying "not connected".
  const stored = await readIntegrationCredentialRow(
    db,
    XERO_OAUTH_TOKEN_PROVIDER,
    XERO_OAUTH_TOKEN_KEY,
  );
  const connection = await db.xeroConnection.findUnique({
    where: { id: XERO_CONNECTION_ID },
    select: { tenantId: true, refreshInProgressUntil: true },
  });
  if (!connection) return null;
  const tokenSet = tokenSetForConnection(stored, connection.tenantId);
  if (!tokenSet.usable || stored.status !== "configured") {
    throw new XeroTokenDecryptError(
      tokenSet.usable ? undefined : TOKEN_SET_REFUSAL_MESSAGES[tokenSet.refusal],
    );
  }
  const value = tokenSet.value;
  return {
    record: {
      accessToken: value.accessToken,
      refreshToken: value.refreshToken,
      expiresAt: new Date(value.expiresAt),
      tenantId: value.tenantId ?? connection.tenantId ?? undefined,
      refreshInProgressUntil: connection.refreshInProgressUntil,
    },
    storeVersion: stored.version,
  };
}

/** Fixed sentences: an error about the token set never carries a value from it. */
const TOKEN_SET_REFUSAL_MESSAGES: Record<ConnectionTokenSetRefusal, string | undefined> = {
  absent: "No stored Xero token set exists for this connection",
  unreadable: undefined,
  "other-tenant":
    "The stored Xero token set belongs to a different Xero organisation from the connection",
};

const LEASE_LOST_MESSAGE =
  "Xero token refresh lease expired before refreshed tokens could be saved";

export interface SaveXeroTokenOptions extends XeroTokenWriteContext {
  /**
   * Present on a REFRESH: the lease this process claimed. Absent on a connect,
   * which replaces whatever was there.
   */
  lease?: XeroRefreshLease;
}

/**
 * Store a token set: the store copy and the connection row, one transaction,
 * one audit row.
 *
 * A REFRESH (`options.lease`) is fenced twice. The `XeroConnection` update is
 * guarded on the lease this process claimed — a reconnect or a later claim in
 * the meantime matches nothing and the save throws — and the store write is a
 * compare-and-set on the version the claim read under its lock, so a writer
 * that bypassed the lease makes this one lose too. Any failure rolls everything
 * back. The Xero call that produced these tokens happened outside any
 * transaction (`INV-INT-003`).
 *
 * A CONNECT replaces whatever was stored — the operator has just authorised a
 * fresh grant and there is nothing older to be stale against — and resets the
 * in-process organisation caches, because a reconnect can bind a different
 * organisation (#2080 F1).
 */
export async function saveXeroTokens(
  tokens: TokenData,
  options: SaveXeroTokenOptions,
): Promise<void> {
  const lease = options.lease;
  if (lease) {
    const tenantId = tokens.tenantId ?? null;
    await withCredentialTransaction([XERO_OAUTH_TOKEN_PROVIDER], async (tx) => {
      const connection = await tx.xeroConnection.updateMany({
        where: {
          id: XERO_CONNECTION_ID,
          refreshInProgressUntil: { lte: lease.leaseUntil },
        },
        data: {
          expiresAt: tokens.expiresAt,
          tenantId,
          refreshInProgressUntil: null,
        },
      });
      if (connection.count !== 1) throw new Error(LEASE_LOST_MESSAGE);

      await setIntegrationCredentialInTransaction({
        tx,
        provider: XERO_OAUTH_TOKEN_PROVIDER,
        key: XERO_OAUTH_TOKEN_KEY,
        value: serializeStoredTokenSet(tokens, tenantId),
        actor: options.actor,
        expect: { expect: "version", version: lease.storeVersion },
        cause: { kind: "token-refresh" },
        request: options.request,
      });
    });
    // A refresh keeps the same organisation, so the org caches stay.
    return;
  }

  await withCredentialTransaction(
    [XERO_OAUTH_TOKEN_PROVIDER, XERO_PROVIDER],
    async (tx) => {
      // A plain read, no lock: the tenant to keep if the grant named none.
      const previous = await tx.xeroConnection.findUnique({
        where: { id: XERO_CONNECTION_ID },
        select: { tenantId: true },
      });
      const tenantId = tokens.tenantId ?? previous?.tenantId ?? null;

      // The connection row first, then the store (the lock order above). A
      // connect clears any refresh in flight: its lease-guarded update finds
      // the lease nulled and matches nothing.
      await tx.xeroConnection.upsert({
        where: { id: XERO_CONNECTION_ID },
        create: { id: XERO_CONNECTION_ID, expiresAt: tokens.expiresAt, tenantId },
        update: { expiresAt: tokens.expiresAt, tenantId, refreshInProgressUntil: null },
        select: { id: true },
      });

      await setIntegrationCredentialInTransaction({
        tx,
        provider: XERO_OAUTH_TOKEN_PROVIDER,
        key: XERO_OAUTH_TOKEN_KEY,
        value: serializeStoredTokenSet(tokens, tenantId),
        actor: options.actor,
        // A connect is a fresh grant the operator has just authorised; it
        // replaces whatever was stored and has nothing to be stale against.
        expect: { expect: "any" },
        cause: { kind: "oauth-connect" },
        request: options.request,
      });
      await deleteRetiredTokenKey(tx, options, { kind: "oauth-connect" });
    },
  );

  // A connect/reconnect can bind a DIFFERENT Xero organisation, so drop the
  // in-process org caches (name/FYE/lock dates) — the wizard's right-org
  // confirmation must read the NEW org, not a stale name (#2080 F1).
  invalidateXeroOrganisationCaches();
}

/** Delete the retired wrapped token key, audited like any credential delete. */
async function deleteRetiredTokenKey(
  tx: Prisma.TransactionClient,
  context: XeroTokenWriteContext,
  cause: CredentialMutationCause,
): Promise<void> {
  await deleteIntegrationCredentialInTransaction({
    tx,
    provider: XERO_PROVIDER,
    key: RETIRED_XERO_TOKEN_KEY,
    actor: context.actor,
    expect: { expect: "any" },
    cause,
    request: context.request,
  });
}

export async function loadXeroTokens(): Promise<XeroTokenRecord | null> {
  return (await readCurrentTokens(prisma))?.record ?? null;
}

// Note: isXeroConnected below deliberately does NOT decrypt (it reads the
// connection row only), so it never throws for an unreadable token set.
// getXeroConnectionStatus DOES a single, side-effect-free readability probe so
// the admin status page reports "reconnect required" rather than "connected"
// over tokens that no longer decrypt (#2079 upgrade / auth-secret change).

export type XeroTokenReadability = "no_tokens" | "readable" | "unreadable";

/**
 * Whether the stored Xero tokens are usable. SIDE-EFFECT-FREE and never exposes
 * the decrypted value. Returns:
 *   - "no_tokens"   — no connection (not connected);
 *   - "unreadable"  — connected, but the store copy is missing, fails to decrypt
 *                     (auth secret changed), is malformed or names another
 *                     organisation than the connection ⇒ reconnect;
 *   - "readable"    — decrypts cleanly.
 */
export async function getXeroTokenReadability(): Promise<XeroTokenReadability> {
  // Store row first, for the reason `readCurrentTokens` gives.
  const stored = await readIntegrationCredentialRow(
    prisma,
    XERO_OAUTH_TOKEN_PROVIDER,
    XERO_OAUTH_TOKEN_KEY,
  );
  const connection = await readXeroConnection();
  if (connection === null) return "no_tokens";
  return tokenSetForConnection(stored, connection.tenantId).usable ? "readable" : "unreadable";
}

/** A lease row nobody holds at `now`: never claimed, or its lease has run out. */
const leaseIsFreeAt = (now: Date) => ({
  OR: [{ refreshInProgressUntil: null }, { refreshInProgressUntil: { lte: now } }],
});

/**
 * The data-key re-encrypt's fence (#4456): the connection row, guarded on NO
 * lease at all, never taking one over (an expired one may be a stalled
 * refresh). False while one is set; no connection row, no lease.
 * CONCURRENCY_AND_LOCKING.md.
 */
export async function fenceXeroTokenSetRewrite(tx: XeroTokenDb): Promise<boolean> {
  const unheld = { refreshInProgressUntil: null };
  const ours = await tx.xeroConnection.updateMany({
    where: { id: XERO_CONNECTION_ID, ...unheld },
    data: unheld,
  });
  if (ours.count === 1) return true;
  const row = await tx.xeroConnection.findUnique({
    where: { id: XERO_CONNECTION_ID },
    select: { id: true },
  });
  return row === null;
}

export async function claimXeroTokenRefreshLease(options?: {
  now?: Date;
  leaseMs?: number;
}): Promise<XeroTokenRefreshLeaseClaim> {
  const now = options?.now ?? new Date();
  const leaseUntil = new Date(now.getTime() + (options?.leaseMs ?? XERO_TOKEN_REFRESH_LEASE_MS));

  return prisma.$transaction(async (tx): Promise<XeroTokenRefreshLeaseClaim> => {
    // CLAIM FIRST, THEN READ (#3454 review). The winning update holds the
    // connection row's lock until this transaction commits, and every writer of
    // the token set — a connect, a refresh save, a disconnect, a verify-reset,
    // and the data-key re-encrypt through `fenceXeroTokenSetRewrite` — takes
    // that row first. So the store copy read below is the one that belongs to
    // this lease. A count other than 1 matched nothing: no row, or a lease
    // still held. Nothing was taken, so there is nothing to roll back.
    const claimed = await tx.xeroConnection.updateMany({
      where: { id: XERO_CONNECTION_ID, ...leaseIsFreeAt(now) },
      data: { refreshInProgressUntil: leaseUntil },
    });

    const current = await readCurrentTokens(tx);
    if (claimed.count !== 1) {
      return {
        claimed: false,
        tokens: current?.record ?? null,
        leaseUntil: current?.record.refreshInProgressUntil ?? null,
      };
    }
    if (!current) {
      // Unreachable: this transaction holds the connection row's lock.
      throw new Error("Xero connection disappeared under its own refresh lease");
    }
    return {
      claimed: true,
      tokens: { ...current.record, refreshInProgressUntil: leaseUntil },
      leaseUntil,
      lease: {
        leaseUntil,
        storeVersion: current.storeVersion,
      },
    };
  });
}

/**
 * Release a refresh lease, only if it is still this claim's (or an earlier
 * one's). A newer lease is left alone. A lease is not a credential write and
 * audits nothing.
 */
export async function releaseXeroTokenRefreshLease(lease: XeroRefreshLease): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.xeroConnection.updateMany({
      where: {
        id: XERO_CONNECTION_ID,
        refreshInProgressUntil: { lte: lease.leaseUntil },
      },
      data: { refreshInProgressUntil: null },
    });
  });
}

/**
 * Check if Xero is currently connected (a connection row that names a tenant).
 */
export async function isXeroConnected(): Promise<boolean> {
  return isConnectedTenant(await readXeroConnection());
}

/**
 * Get connection status details for the admin page. Reports a truthful
 * reconnect-required state when a connection exists but its tokens are not
 * usable (needsReentry) — the "Connected" chip must never sit over dead tokens
 * (#2079). The readability probe is side-effect-free and never exposes the
 * token value.
 */
export async function getXeroConnectionStatus(): Promise<{
  connected: boolean;
  needsReentry: boolean;
  /** Why it needs re-entry, so the panel advises the fix that works (#4456). */
  reentryCause?: XeroReentryCause;
  tenantId: string | null;
  tokenExpiresAt: Date | null;
}> {
  const connection = await readXeroConnection();
  if (!connection) {
    return {
      connected: false,
      needsReentry: false,
      tenantId: null,
      tokenExpiresAt: null,
    };
  }
  // Readable is not enough: when no refresh could store its rotated pair, the
  // tokens still decrypt but every call fails once the access token expires.
  // "Connected" must not sit over that (#3454 review). The SAME predicate as the
  // refresh pre-flight, so the two never disagree (#4456 review).
  const readable = (await getXeroTokenReadability()) === "readable";
  const refusal = await xeroTokenSaveRefusal();
  const usable = readable && refusal === null;
  return {
    connected: usable,
    needsReentry: !usable,
    ...(usable ? {} : { reentryCause: refusal?.reason ?? "tokens-unreadable" }),
    tenantId: connection.tenantId,
    tokenExpiresAt: connection.expiresAt,
  };
}

/**
 * Destroy the stored Xero tokens — the store copy and the connection — on a
 * transaction the caller owns, recording ONE audit row for the token set that
 * names who did it and why (#3454).
 *
 * The row is written whenever a connection was destroyed, which includes a
 * connection whose store copy was already missing (one made before #3454 and
 * never refreshed since): the store's own delete records nothing when its row is
 * absent, so this records it here, through the same vocabulary. Nothing to
 * destroy records nothing. The retired wrapped token key goes too.
 */
export async function deleteXeroTokensInTransaction(
  params: XeroTokenWriteContext & {
    tx: Prisma.TransactionClient;
    cause: CredentialMutationCause;
  },
): Promise<boolean> {
  const connection = await params.tx.xeroConnection.deleteMany();
  const storeRemoved = await deleteIntegrationCredentialInTransaction({
    tx: params.tx,
    provider: XERO_OAUTH_TOKEN_PROVIDER,
    key: XERO_OAUTH_TOKEN_KEY,
    actor: params.actor,
    // Destroying the tokens means "gone, whatever they were": a disconnect or a
    // verify-reset has no version it could be stale against.
    expect: { expect: "any" },
    cause: params.cause,
    request: params.request,
  });
  if (!storeRemoved && connection.count > 0) {
    await recordCredentialMutation(params.tx, {
      action: CREDENTIAL_AUDIT_ACTIONS.deleted,
      summary: `${deletedCredentialSummary(XERO_OAUTH_TOKEN_PROVIDER, XERO_OAUTH_TOKEN_KEY)} (pre-upgrade copy only)`,
      actor: params.actor,
      provider: XERO_OAUTH_TOKEN_PROVIDER,
      key: XERO_OAUTH_TOKEN_KEY,
      expectation: "any",
      cause: params.cause,
      request: params.request,
    });
  }
  await deleteRetiredTokenKey(params.tx, params, params.cause);
  return storeRemoved || connection.count > 0;
}

/**
 * Remove all stored Xero tokens, in their own transaction. Used by the OAuth
 * disconnect after its best-effort revocation.
 */
export async function deleteXeroTokens(
  params: XeroTokenWriteContext & { cause: CredentialMutationCause },
): Promise<void> {
  await withCredentialTransaction(
    [XERO_OAUTH_TOKEN_PROVIDER, XERO_PROVIDER],
    (tx) => deleteXeroTokensInTransaction({ ...params, tx }),
  );
  // Disconnect: no org is connected any more, so the cached org name/FYE/lock
  // dates must not linger for the next connection (F1).
  invalidateXeroOrganisationCaches();
}
