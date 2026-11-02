/**
 * Xero Token Storage
 *
 * Persists the Xero OAuth token set (access, refresh, expiry, tenant), owns the
 * connection row and the refresh lease, and reports connection status. Keeps
 * token plaintext out of the database.
 *
 * Since #3454 the tokens live in the encrypted integration credential store;
 * since #3806 R2 the connection's non-secret facts and the refresh lease live in
 * `XeroConnection`, and the `XeroToken` row is kept only for the previous release
 * — see "Where things live" below.
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
import { XERO_TOKEN_ROW_ORDER } from "@/lib/xero-token-row-order";
import { credentialCaptureAvailable } from "@/lib/integration-crypto";
import { XeroTokenDecryptError } from "@/lib/xero-token-errors";
import {
  freshRowMirror,
  serializeStoredTokenSet,
  tokenSetForConnection,
  type ConnectionTokenSetRefusal,
} from "@/lib/xero-token-set";

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
  /**
   * When a refresh in progress somewhere releases its lease: the later of this
   * release's lease and the previous release's (#3806), or null when neither is
   * held. A process that lost the claim waits on it.
   */
  refreshInProgressUntil: Date | null;
}

/**
 * What a won claim hands to the save and the release. Opaque to callers: they
 * pass it back unchanged.
 */
export interface XeroRefreshLease {
  leaseUntil: Date;
  /**
   * The `XeroToken` row whose lease was claimed beside ours, or null when there
   * was no such row (#3806: the previous release claims only that one).
   */
  tokenRowId: string | null;
  /** The credential-store version read under the lease; the save compares-and-sets on it. */
  storeVersion: CredentialVersion;
  /** The store copy's mirror fingerprint, carried forward unchanged (see rule 3 below). */
  mirror: string;
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
// Where things live (#3454, #3806 R2)
// ---------------------------------------------------------------------------
//
// THE TOKENS are ONE row of the encrypted integration-credential store
// (`xero-oauth` / `token-set`), so every write names its actor, commits its
// audit row in the same transaction and declares what it expected to find
// (`INV-PRIV-020`). It is its own provider namespace rather than a key under
// "xero": a refresh every half hour must not drop the cached Xero client id and
// secret, and a token that no longer decrypts needs a RECONNECT, which is not the
// "re-enter your credentials" aggregate `providerNeedsReentry("xero")` drives.
// It is the only copy this release reads: there is no fallback.
//
// THE CONNECTION AND THE LEASE are the one `XeroConnection` row: no row means
// not connected; it carries the tenant, the access token's expiry and the
// refresh lease, and nothing secret. `readXeroConnection` is the one reader of
// the facts (`xero-connection.ts`).
//
// THE `XeroToken` ROW STAYS FOR THE PREVIOUS RELEASE (#3454), which can run
// beside this one during a deploy and after a rollback. That code reads,
// refreshes, connects and disconnects through `XeroToken` alone, treats no row
// as not connected, claims its lease on `XeroToken.refreshInProgressUntil`, and
// reads the store copy only while the store's `mirror` matches a hash of the
// row's id and ciphertext. Xero refresh tokens ROTATE — each is spendable once —
// so if the two releases ever disagreed about the current tokens, one of them
// would end up holding a spent refresh token. Four rules prevent that:
//
//   1. while connected the row is PRESENT, with `tenantId` and `expiresAt`
//      current, written in the same transaction as every connect and refresh;
//   2. a refresh claims BOTH leases, `XeroToken`'s first and then ours, in one
//      transaction, so this release and the previous one compete for one
//      refresh token. `XeroToken` first is also the order a statement trigger
//      on that table fixes for every writer of either release: it keeps
//      `XeroConnection` in step with what the previous release writes there,
//      so its connect, refresh and disconnect reach this release too;
//   3. this release never writes or reads the row's ciphertext columns (they
//      are `@ignore`d in the schema), so the store copy's `mirror` stays valid.
//      A connect replaces the row with a fresh one whose ciphertext columns the
//      database fills with '', and records the hash of exactly that; a refresh
//      leaves the row's ciphertext alone and carries the `mirror` it read under
//      the lease. The previous release therefore always reads the store copy;
//   4. a write the previous release makes rewrites both copies itself (it is
//      the #3454 dual-write), so its rows keep matching too.
//
// The trigger and the row go in R3 (#3806). THE STORE'S CACHE IS NEVER USED FOR
// THE TOKENS: `readIntegrationCredentialRow` reads through the database on the
// caller's client, so a refresh token another container has just rotated can
// never be served stale from this process.

/** The credential-store namespace for the Xero OAuth token set. */
export const XERO_OAUTH_TOKEN_PROVIDER = "xero-oauth";
/** The one row in that namespace. */
export const XERO_OAUTH_TOKEN_KEY = "token-set";

/**
 * The wrapped key the `XeroToken` ciphertext was encrypted under until #3806 R2.
 * Nothing here uses it any more. A leftover row would still be read by the
 * provider's re-entry aggregate, and after an auth-secret change nothing would
 * ever replace it, so the next connect, disconnect or verify-reset deletes it.
 */
const RETIRED_XERO_TOKEN_KEY = "token_key";

type XeroTokenDb = Pick<
  Prisma.TransactionClient,
  "xeroToken" | "xeroConnection" | "integrationCredential"
>;

/** Who is writing the tokens, and from which request. Required on every write. */
export interface XeroTokenWriteContext {
  actor: CredentialActor;
  request?: CredentialRequestContext;
}

function laterOf(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

interface CurrentTokens {
  record: XeroTokenRecord;
  storeVersion: CredentialVersion;
  mirror: string;
}

/**
 * Read the current token set on `db`, or `null` when Xero is not connected.
 * Throws `XeroTokenDecryptError` when a connection exists but its store copy is
 * missing, unreadable or malformed, or names a different organisation from the
 * connection (`tokenSetForConnection`): only a reconnect fixes that, and there
 * is no other copy this release may read.
 */
async function readCurrentTokens(db: XeroTokenDb): Promise<CurrentTokens | null> {
  // The store row first: every writer of either release that replaces the token
  // set also rewrites or deletes the connection row, so a disconnect committing
  // between these reads leaves the SECOND read saying "not connected".
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
  const previousReleaseLease = await db.xeroToken.findFirst({
    orderBy: XERO_TOKEN_ROW_ORDER,
    select: { refreshInProgressUntil: true },
  });
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
      refreshInProgressUntil: laterOf(
        connection.refreshInProgressUntil,
        previousReleaseLease?.refreshInProgressUntil ?? null,
      ),
    },
    storeVersion: stored.version,
    mirror: value.mirror ?? "",
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
 * Store a token set: the store copy, the connection row and the previous
 * release's row, one transaction, one audit row.
 *
 * A REFRESH (`options.lease`) is fenced three times. The `XeroToken` and
 * `XeroConnection` updates are each guarded on the lease this process claimed —
 * a reconnect or a later claim in the meantime matches nothing and the save
 * throws — and the store write is a compare-and-set on the version the claim read
 * under its lock, so a writer that bypassed the leases makes this one lose too.
 * Any failure rolls everything back. The Xero call that produced these tokens
 * happened outside any transaction (`INV-INT-003`).
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
      // `XeroToken` first: the lock order the trigger on it fixes (rule 2).
      if (lease.tokenRowId !== null) {
        const previousRelease = await tx.xeroToken.updateMany({
          where: {
            id: lease.tokenRowId,
            refreshInProgressUntil: { lte: lease.leaseUntil },
          },
          data: {
            expiresAt: tokens.expiresAt,
            tenantId,
            refreshInProgressUntil: null,
          },
        });
        if (previousRelease.count !== 1) throw new Error(LEASE_LOST_MESSAGE);
      }

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
        // The row's ciphertext is untouched, so its fingerprint is unchanged.
        value: serializeStoredTokenSet(tokens, tenantId, lease.mirror),
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

      // `XeroToken` first (rule 2). Replacing the row rather than updating it
      // means its ciphertext columns are the database's '' default, whose
      // fingerprint this release knows without reading them (rule 3). It also
      // fences any refresh in flight: its lease-guarded update finds no row.
      //
      // KNOWN LIMIT: two connects at the same moment can leave TWO rows, as they
      // could under #3454 — neither delete sees the other's uncommitted insert.
      // No delete follows the connection upsert to tidy that up, because it
      // would take `XeroToken` row locks after `XeroConnection`'s, the reverse
      // of rule 2. It is tolerated instead: every reader of either release
      // takes the most recently written row (`XERO_TOKEN_ROW_ORDER`), so both
      // releases still claim the same lease; the first refresh rewrites that
      // row and the connection from the store copy, the last connect's; and
      // the next connect or disconnect deletes both. If the two connects named
      // different organisations and the connection followed the other one, the
      // store copy no longer matches it and reads as "reconnect required"
      // (`tokenSetForConnection`).
      await tx.xeroToken.deleteMany();
      const row = await tx.xeroToken.create({
        data: { expiresAt: tokens.expiresAt, tenantId },
        select: { id: true },
      });
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
        value: serializeStoredTokenSet(tokens, tenantId, freshRowMirror(row.id)),
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

/** The claim lost to a lease held on `XeroConnection` alone; rolls our claim back. */
class XeroConnectionLeaseHeld extends Error {}

export async function claimXeroTokenRefreshLease(options?: {
  now?: Date;
  leaseMs?: number;
}): Promise<XeroTokenRefreshLeaseClaim> {
  const now = options?.now ?? new Date();
  const leaseUntil = new Date(
    now.getTime() + (options?.leaseMs ?? XERO_TOKEN_REFRESH_LEASE_MS)
  );
  const leaseIsFree = {
    OR: [
      { refreshInProgressUntil: null },
      { refreshInProgressUntil: { lte: now } },
    ],
  };

  try {
    return await prisma.$transaction(async (tx): Promise<XeroTokenRefreshLeaseClaim> => {
      const connection = await tx.xeroConnection.findUnique({
        where: { id: XERO_CONNECTION_ID },
        select: { id: true },
      });
      if (!connection) {
        return { claimed: false, tokens: null, leaseUntil: null };
      }

      // CLAIM FIRST, THEN READ (#3454 review), and BOTH LEASES (#3806 R2).
      //
      // The previous release's lease first: it claims only
      // `XeroToken.refreshInProgressUntil`, so that is where the two releases
      // exclude each other, and `XeroToken` first is the lock order the trigger
      // fixes for every writer (rule 2 above). Ours second: it is the lease that
      // stays when `XeroToken` goes. A claim that wins holds both rows' locks
      // until this transaction commits, and every writer of the token set — a
      // connect, a refresh save, a disconnect, a verify-reset, of either release
      // — takes one of them first. So the store copy read below is the one that
      // belongs to this lease, and the version the save compares-and-sets on is
      // the one read under it.
      const tokenRow = await tx.xeroToken.findFirst({
        select: { id: true },
        orderBy: XERO_TOKEN_ROW_ORDER,
      });
      let won = true;
      if (tokenRow) {
        const previousRelease = await tx.xeroToken.updateMany({
          where: { id: tokenRow.id, ...leaseIsFree },
          data: { refreshInProgressUntil: leaseUntil },
        });
        won = previousRelease.count === 1;
      }
      if (won) {
        const ours = await tx.xeroConnection.updateMany({
          where: { id: XERO_CONNECTION_ID, ...leaseIsFree },
          data: { refreshInProgressUntil: leaseUntil },
        });
        if (ours.count !== 1) {
          // Somebody holds our lease without the previous release's: give the
          // one we just took back rather than hold half a lease.
          if (tokenRow) throw new XeroConnectionLeaseHeld();
          won = false;
        }
      }

      // Read on THIS transaction's client, through the database, so the refresh
      // token handed back is the one stored now — never a cached copy another
      // container has already spent.
      const current = await readCurrentTokens(tx);
      if (!won) {
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
          tokenRowId: tokenRow?.id ?? null,
          storeVersion: current.storeVersion,
          mirror: current.mirror,
        },
      };
    });
  } catch (error) {
    if (!(error instanceof XeroConnectionLeaseHeld)) throw error;
    const current = await readCurrentTokens(prisma);
    return {
      claimed: false,
      tokens: current?.record ?? null,
      leaseUntil: current?.record.refreshInProgressUntil ?? null,
    };
  }
}

/**
 * Release a refresh lease — both halves, `XeroToken`'s first. Each only if it is
 * still this claim's (or an earlier one's). A lease is not a credential write and
 * audits nothing.
 */
export async function releaseXeroTokenRefreshLease(
  lease: XeroRefreshLease,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    if (lease.tokenRowId !== null) {
      await tx.xeroToken.updateMany({
        where: {
          id: lease.tokenRowId,
          refreshInProgressUntil: { lte: lease.leaseUntil },
        },
        data: { refreshInProgressUntil: null },
      });
    }
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
  // Readable is not enough: under a key the capture gate now refuses,
  // the tokens still decrypt but no refresh can store its rotated pair, so every
  // call fails once the access token expires. "Connected" must not sit over
  // that (#3454 review).
  const usable =
    (await getXeroTokenReadability()) === "readable" && credentialCaptureAvailable();
  return {
    connected: usable,
    needsReentry: !usable,
    tenantId: connection.tenantId,
    tokenExpiresAt: connection.expiresAt,
  };
}

/**
 * Destroy the stored Xero tokens — the store copy, the connection and the
 * previous release's row — on a transaction the caller owns, recording ONE audit
 * row for the token set that names who did it and why (#3454).
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
  // `XeroToken` first (rule 2); its trigger then deletes the connection too.
  const previousRelease = await params.tx.xeroToken.deleteMany();
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
  const connectionRemoved = previousRelease.count > 0 || connection.count > 0;
  if (!storeRemoved && connectionRemoved) {
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
  return storeRemoved || connectionRemoved;
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
