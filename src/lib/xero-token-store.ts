/**
 * Xero Token Storage
 *
 * Encrypts and persists Xero OAuth tokens (access, refresh, expiry, tenant)
 * and reports connection status. Keeps token plaintext out of the database.
 *
 * Since #3454 the authoritative copy lives in the encrypted integration
 * credential store, with the `XeroToken` row kept beside it for the blue-green
 * window — see "Where the tokens live" below.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import {
  recordCredentialMutation,
  CREDENTIAL_AUDIT_ACTIONS,
  type CredentialActor,
  type CredentialMutationCause,
  type CredentialRequestContext,
  type CredentialVersion,
  type CredentialWriteExpectation,
} from "@/lib/integration-credential-actor";
import {
  deleteIntegrationCredentialInTransaction,
  readIntegrationCredentialRow,
  setIntegrationCredentialInTransaction,
  withCredentialTransaction,
  type CredentialResolution,
} from "@/lib/integration-credentials";
import {
  getOperationalXeroEncryptionKey,
  peekOperationalXeroEncryptionKey,
} from "@/lib/xero-config";
import { invalidateXeroOrganisationCaches } from "@/lib/xero-organisation-cache-bus";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Thrown when a stored Xero OAuth token cannot be decrypted — the GCM tag fails
 * (the token was encrypted under a key the current auth secret no longer
 * derives) or the stored row is malformed. Both are unrecoverable and only an
 * admin RECONNECT fixes them, so this is a typed reconnect signal rather than an
 * opaque crypto error. It stays fail-closed (it still throws — never returns a
 * bogus token).
 *
 * `getXeroApiErrorInfo` and the connection probe's `classifyProbeError` map this
 * class (name-keyed, like XeroReconnectRequiredError) to the reconnect state, so
 * a token row left undecryptable by the env→DB upgrade (#2079) or an auth-secret
 * change surfaces the clean "reconnect Xero" prompt instead of an opaque 500.
 * Defined here (not extended from XeroReconnectRequiredError) to avoid a cycle
 * with xero-api-client, which imports this module.
 */
export class XeroTokenDecryptError extends Error {
  constructor(message = "Stored Xero token could not be decrypted") {
    super(message);
    this.name = "XeroTokenDecryptError";
  }
}

// The token-encryption key is the DB-backed, auto-generated, HKDF-wrapped Xero
// token key (#2079). `XERO_ENCRYPTION_KEY` no longer exists. Resolution is async
// (a cache-backed DB fetch); throws when the key cannot be resolved so callers
// surface a clean "reconnect Xero" rather than operate without encryption.
async function getEncryptionKey(): Promise<Buffer> {
  const key = await getOperationalXeroEncryptionKey();
  if (!key) {
    throw new Error(
      "Xero token encryption key is not available. Connect Xero from the admin panel (a strong AUTH_SECRET is required).",
    );
  }
  const buf = Buffer.from(key, "hex");
  if (buf.length !== 32) {
    throw new Error("Xero token encryption key must be a 64-character hex string (32 bytes)");
  }
  return buf;
}

// test seam
export async function encryptToken(plaintext: string): Promise<string> {
  const key = await getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();
  // Format: iv:authTag:ciphertext
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

/**
 * Pure decrypt with an explicit key. Throws on a malformed row or a GCM tag
 * failure. Callers wrap this to attach the right typed error / policy.
 */
function decryptWithKey(encrypted: string, key: Buffer): string {
  // `iv:authTag:ciphertext` and nothing else, said by the destructure rather
  // than by a length compared before three separate reads (#2800).
  const [ivHex, authTagHex, ciphertext, ...extraParts] = encrypted.split(":");
  if (
    ivHex === undefined ||
    authTagHex === undefined ||
    ciphertext === undefined ||
    extraParts.length > 0
  ) {
    throw new Error("Invalid encrypted token format");
  }
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error("Invalid encrypted token authentication tag length");
  }
  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// test seam
export async function decryptToken(encrypted: string): Promise<string> {
  // Key resolution failures (key not yet available) keep their own error; only
  // an actual decrypt failure of an existing row is the reconnect signal.
  const key = await getEncryptionKey();
  try {
    return decryptWithKey(encrypted, key);
  } catch {
    // A GCM tag failure (key rotated) or a malformed row: unrecoverable, and
    // only a reconnect fixes it. Typed so the API/probe surfaces reconnect,
    // fail-closed (still throws — never returns a token).
    throw new XeroTokenDecryptError();
  }
}

export interface TokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  tenantId?: string;
}

export interface XeroTokenRecord extends TokenData {
  /** The `XeroToken` row's id — the lease and connection row (#3454). */
  id: string;
  refreshInProgressUntil: Date | null;
  /**
   * The compare-and-set token of the credential-store copy as it was read, or
   * `null` when there was none yet (#3454). A refresh hands it back so its
   * write loses, rather than overwrites, if anybody replaced the set since.
   */
  storeVersion: CredentialVersion | null;
}

export const XERO_TOKEN_REFRESH_LEASE_MS = 2 * 60 * 1000;

export type XeroTokenRefreshLeaseClaim =
  | {
      claimed: true;
      tokens: XeroTokenRecord;
      leaseUntil: Date;
    }
  | {
      claimed: false;
      tokens: XeroTokenRecord | null;
      leaseUntil: Date | null;
    };

// ---------------------------------------------------------------------------
// Where the tokens live (#3454)
// ---------------------------------------------------------------------------
//
// THE AUTHORITATIVE COPY is ONE row of the encrypted integration-credential
// store, so every write names its actor, commits its audit row in the same
// transaction and declares what it expected to find (`INV-PRIV-020`). It is its
// own provider namespace rather than a key under "xero" for two reasons: a
// refresh every half hour must not drop the cached Xero client id and secret,
// and a token that no longer decrypts needs a RECONNECT, which is not the
// "re-enter your credentials" aggregate `providerNeedsReentry("xero")` drives.
//
// THE `XeroToken` ROW IS KEPT, AND WRITTEN IN THE SAME TRANSACTION, for the
// blue-green window. A deployed older colour reads and refreshes only that row,
// and Xero refresh tokens ROTATE — each is spendable once — so a copy the old
// code cannot see would split the connection: one side would end up holding a
// spent refresh token. Three rules prevent that:
//
//   1. every write here lands BOTH copies or neither, the `XeroToken` row in
//      exactly the format the old code decrypts;
//   2. the refresh lease stays on `XeroToken.refreshInProgressUntil`, the one
//      the old code claims, so old and new colours compete for ONE lease and
//      at most one of them spends a given refresh token;
//   3. a read decides which copy is current by a FINGERPRINT, never a clock.
//      The store copy records a hash of the `XeroToken` ciphertext written
//      beside it. If the row no longer matches, somebody who writes only that
//      row — the old code — rewrote it, and it is the newer copy. `updatedAt`
//      was rejected for this: each container stamps it from its own clock,
//      and being wrong once strands a spent refresh token. Every encrypt draws
//      a fresh IV, so any real rewrite changes the ciphertext; a lease claim
//      touches only `refreshInProgressUntil` and does not.
//
// While the window lasts, the `XeroToken` row is also the CONNECTION row: no
// row means not connected, whatever the store holds (the old colour may have
// disconnected), and `isXeroConnected` and the non-secret readers elsewhere
// read its `tenantId` and `expiresAt`, which every write here keeps exact.
// Retiring it is the contract step, filed as its own issue.
//
// THE STORE'S CACHE IS NEVER USED FOR THE TOKENS. `readIntegrationCredentialRow`
// reads through the database on the caller's client, so a refresh token another
// container has just rotated can never be served stale from this process.

/** The credential-store namespace for the Xero OAuth token set. */
export const XERO_OAUTH_TOKEN_PROVIDER = "xero-oauth";
/** The one row in that namespace. */
export const XERO_OAUTH_TOKEN_KEY = "token-set";

/** What the store row's encrypted value holds. Never logged, never audited. */
interface StoredXeroTokenSet {
  v: 1;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  tenantId: string | null;
  /** `mirrorFingerprint` of the `XeroToken` row written in the same transaction. */
  mirror: string;
}

interface LegacyXeroTokenRow {
  id: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  tenantId: string | null;
  refreshInProgressUntil: Date | null;
}

type XeroTokenDb = Pick<Prisma.TransactionClient, "xeroToken" | "integrationCredential">;

/** Who is writing the tokens, and from which request. Required on every write. */
export interface XeroTokenWriteContext {
  actor: CredentialActor;
  request?: CredentialRequestContext;
}

/**
 * A hash of the `XeroToken` row's identity and ciphertext. Non-secret: it is
 * SHA-256 over values that are themselves ciphertext, and it is stored only
 * inside the encrypted store value.
 */
function mirrorFingerprint(row: {
  id: string;
  accessToken: string;
  refreshToken: string;
}): string {
  return createHash("sha256")
    .update(`${row.id}:${row.accessToken}:${row.refreshToken}`, "utf8")
    .digest("hex");
}

function serializeStoredTokenSet(
  tokens: TokenData,
  tenantId: string | null,
  mirror: string,
): string {
  const value: StoredXeroTokenSet = {
    v: 1,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt.toISOString(),
    tenantId,
    mirror,
  };
  return JSON.stringify(value);
}

/** Parse the store value, or `null` when it is not a token set this code wrote. */
function parseStoredTokenSet(value: string): StoredXeroTokenSet | null {
  try {
    const parsed = JSON.parse(value) as Partial<StoredXeroTokenSet> | null;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      parsed.v !== 1 ||
      typeof parsed.accessToken !== "string" ||
      typeof parsed.refreshToken !== "string" ||
      typeof parsed.expiresAt !== "string" ||
      Number.isNaN(Date.parse(parsed.expiresAt)) ||
      (parsed.tenantId !== null && typeof parsed.tenantId !== "string") ||
      typeof parsed.mirror !== "string"
    ) {
      return null;
    }
    return parsed as StoredXeroTokenSet;
  } catch {
    // Never echo the value: it holds the tokens.
    return null;
  }
}

/**
 * The store copy, when it is the CURRENT one for this `XeroToken` row, or
 * `null` when the row must be read instead (no store copy, an unreadable or
 * malformed one, or a row the old code rewrote since).
 */
function currentStoreCopy(
  legacy: LegacyXeroTokenRow,
  stored: CredentialResolution,
): StoredXeroTokenSet | null {
  if (stored.status !== "configured") return null;
  const value = parseStoredTokenSet(stored.value);
  if (value === null) return null;
  return value.mirror === mirrorFingerprint(legacy) ? value : null;
}

function storeVersionOf(stored: CredentialResolution): CredentialVersion | null {
  return stored.status === "not_configured" ? null : stored.version;
}

/**
 * Read both copies on `db` and return the current token set, or `null` when no
 * `XeroToken` row exists (not connected). Decrypting a legacy row can resolve
 * the wrapped token key, exactly as it always has.
 */
async function readCurrentTokens(db: XeroTokenDb): Promise<XeroTokenRecord | null> {
  const legacy = await db.xeroToken.findFirst();
  if (!legacy) return null;
  const stored = await readIntegrationCredentialRow(
    db,
    XERO_OAUTH_TOKEN_PROVIDER,
    XERO_OAUTH_TOKEN_KEY,
  );
  const storeVersion = storeVersionOf(stored);
  const current = currentStoreCopy(legacy, stored);
  if (current !== null) {
    return {
      id: legacy.id,
      accessToken: current.accessToken,
      refreshToken: current.refreshToken,
      expiresAt: new Date(current.expiresAt),
      tenantId: current.tenantId ?? undefined,
      refreshInProgressUntil: legacy.refreshInProgressUntil,
      storeVersion,
    };
  }
  const [accessToken, refreshToken] = await Promise.all([
    decryptToken(legacy.accessToken),
    decryptToken(legacy.refreshToken),
  ]);
  return {
    id: legacy.id,
    accessToken,
    refreshToken,
    expiresAt: legacy.expiresAt,
    tenantId: legacy.tenantId ?? undefined,
    refreshInProgressUntil: legacy.refreshInProgressUntil,
    storeVersion,
  };
}

export interface SaveXeroTokenOptions extends XeroTokenWriteContext {
  /**
   * Present on a REFRESH: the lease this process claimed and the store version
   * it read with it. Absent on a connect, which replaces whatever was there.
   */
  lease?: {
    claimed: XeroTokenRecord;
    leaseUntil: Date;
  };
}

/**
 * Store a token set: both copies, one transaction, one audit row.
 *
 * A REFRESH (`options.lease`) is fenced twice. The `XeroToken` update is guarded
 * on the lease this process claimed — a reconnect or an expired lease in the
 * meantime matches nothing and the save throws — and the store write is a
 * compare-and-set on the version read with the lease, so a writer that
 * bypassed the lease makes this one lose too. Either failure rolls BOTH copies
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
  const [encryptedAccess, encryptedRefresh] = await Promise.all([
    encryptToken(tokens.accessToken),
    encryptToken(tokens.refreshToken),
  ]);

  const lease = options.lease;
  if (lease) {
    const tenantId = tokens.tenantId ?? null;
    const storeExpectation: CredentialWriteExpectation =
      lease.claimed.storeVersion === null
        ? { expect: "absent" }
        : { expect: "version", version: lease.claimed.storeVersion };
    await withCredentialTransaction([XERO_OAUTH_TOKEN_PROVIDER], async (tx) => {
      const updated = await tx.xeroToken.updateMany({
        where: {
          id: lease.claimed.id,
          refreshInProgressUntil: {
            lte: lease.leaseUntil,
          },
        },
        data: {
          accessToken: encryptedAccess,
          refreshToken: encryptedRefresh,
          expiresAt: tokens.expiresAt,
          tenantId,
          refreshInProgressUntil: null,
        },
      });

      if (updated.count !== 1) {
        throw new Error(
          "Xero token refresh lease expired before refreshed tokens could be saved"
        );
      }

      await setIntegrationCredentialInTransaction({
        tx,
        provider: XERO_OAUTH_TOKEN_PROVIDER,
        key: XERO_OAUTH_TOKEN_KEY,
        value: serializeStoredTokenSet(
          tokens,
          tenantId,
          mirrorFingerprint({
            id: lease.claimed.id,
            accessToken: encryptedAccess,
            refreshToken: encryptedRefresh,
          }),
        ),
        actor: options.actor,
        expect: storeExpectation,
        cause: { kind: "token-refresh" },
        request: options.request,
      });
    });
    // A refresh keeps the same organisation, so the org caches stay.
    return;
  }

  await withCredentialTransaction([XERO_OAUTH_TOKEN_PROVIDER], async (tx) => {
    const existing = await tx.xeroToken.findFirst();
    const row = existing
      ? await tx.xeroToken.update({
          where: { id: existing.id },
          data: {
            accessToken: encryptedAccess,
            refreshToken: encryptedRefresh,
            expiresAt: tokens.expiresAt,
            tenantId: tokens.tenantId ?? existing.tenantId,
            refreshInProgressUntil: null,
          },
        })
      : await tx.xeroToken.create({
          data: {
            accessToken: encryptedAccess,
            refreshToken: encryptedRefresh,
            expiresAt: tokens.expiresAt,
            tenantId: tokens.tenantId ?? null,
            refreshInProgressUntil: null,
          },
        });

    await setIntegrationCredentialInTransaction({
      tx,
      provider: XERO_OAUTH_TOKEN_PROVIDER,
      key: XERO_OAUTH_TOKEN_KEY,
      value: serializeStoredTokenSet(tokens, row.tenantId, mirrorFingerprint(row)),
      actor: options.actor,
      // A connect is a fresh grant the operator has just authorised; it
      // replaces whatever was stored and has nothing to be stale against.
      expect: { expect: "any" },
      cause: { kind: "oauth-connect" },
      request: options.request,
    });
  });

  // A connect/reconnect can bind a DIFFERENT Xero organisation, so drop the
  // in-process org caches (name/FYE/lock dates) — the wizard's right-org
  // confirmation must read the NEW org, not a stale name (#2080 F1).
  invalidateXeroOrganisationCaches();
}

export async function loadXeroTokens(): Promise<XeroTokenRecord | null> {
  return readCurrentTokens(prisma);
}

// Note: isXeroConnected below deliberately does NOT decrypt (it only reads
// tenantId presence), so it never depends on the token-encryption key and never
// throws for a rotated/absent key. getXeroConnectionStatus DOES a single,
// side-effect-free readability probe (see getXeroTokenReadability) so the admin
// status page reports "reconnect required" rather than "connected" over tokens
// that no longer decrypt (#2079 upgrade / auth-secret change).

export type XeroTokenReadability = "no_tokens" | "readable" | "unreadable";

/**
 * Whether the CURRENT copy of the Xero tokens decrypts with what this process
 * can resolve. SIDE-EFFECT-FREE: it PEEKS the wrapped token key (never generates
 * one — a status read must not mutate the DB) and never exposes the decrypted
 * value. Returns:
 *   - "no_tokens"   — no `XeroToken` row (not connected);
 *   - "unreadable"  — the current copy fails to decrypt (auth secret changed,
 *                     key missing) ⇒ the operator must reconnect;
 *   - "readable"    — decrypts cleanly.
 */
export async function getXeroTokenReadability(): Promise<XeroTokenReadability> {
  const legacy = await prisma.xeroToken.findFirst();
  if (!legacy) return "no_tokens";
  const stored = await readIntegrationCredentialRow(
    prisma,
    XERO_OAUTH_TOKEN_PROVIDER,
    XERO_OAUTH_TOKEN_KEY,
  );
  if (currentStoreCopy(legacy, stored) !== null) return "readable";

  const key = await peekOperationalXeroEncryptionKey();
  if (!key) return "unreadable";
  let keyBuf: Buffer;
  try {
    keyBuf = Buffer.from(key, "hex");
    if (keyBuf.length !== 32) return "unreadable";
  } catch {
    return "unreadable";
  }
  try {
    decryptWithKey(legacy.accessToken, keyBuf);
    return "readable";
  } catch {
    return "unreadable";
  }
}

export async function claimXeroTokenRefreshLease(options?: {
  now?: Date;
  leaseMs?: number;
}): Promise<XeroTokenRefreshLeaseClaim> {
  const now = options?.now ?? new Date();
  const leaseUntil = new Date(
    now.getTime() + (options?.leaseMs ?? XERO_TOKEN_REFRESH_LEASE_MS)
  );

  return prisma.$transaction(async (tx) => {
    // Both copies are read on THIS transaction's client, through the database,
    // so the refresh token handed back is the one stored now — never a cached
    // copy another container has already spent.
    const record = await readCurrentTokens(tx);
    if (!record) {
      return { claimed: false, tokens: null, leaseUntil: null };
    }

    const existingLeaseUntil = record.refreshInProgressUntil;
    if (existingLeaseUntil && existingLeaseUntil > now) {
      return {
        claimed: false,
        tokens: record,
        leaseUntil: existingLeaseUntil,
      };
    }

    // The lease lives on the `XeroToken` row, because that is the one a
    // deployed older colour claims (see the header above).
    const claimed = await tx.xeroToken.updateMany({
      where: {
        id: record.id,
        OR: [
          { refreshInProgressUntil: null },
          { refreshInProgressUntil: { lte: now } },
        ],
      },
      data: {
        refreshInProgressUntil: leaseUntil,
      },
    });

    if (claimed.count !== 1) {
      const latest = await readCurrentTokens(tx);
      return {
        claimed: false,
        tokens: latest,
        leaseUntil: latest?.refreshInProgressUntil ?? null,
      };
    }

    return {
      claimed: true,
      tokens: { ...record, refreshInProgressUntil: leaseUntil },
      leaseUntil,
    };
  });
}

/** Release a refresh lease. A lease is not a credential write and audits nothing. */
export async function releaseXeroTokenRefreshLease(
  tokenId: string,
  leaseUntil: Date
): Promise<void> {
  await prisma.xeroToken.updateMany({
    where: {
      id: tokenId,
      refreshInProgressUntil: {
        lte: leaseUntil,
      },
    },
    data: {
      refreshInProgressUntil: null,
    },
  });
}

/**
 * Check if Xero is currently connected (tokens exist and tenant is set).
 */
export async function isXeroConnected(): Promise<boolean> {
  const record = await prisma.xeroToken.findFirst();
  return record !== null && record.tenantId !== null;
}

/**
 * Get connection status details for the admin page. Reports a truthful
 * reconnect-required state when a token row exists but no longer decrypts
 * (needsReentry) — the "Connected" chip must never sit over dead tokens
 * (#2079). The readability probe is side-effect-free (peeks the key, never
 * generates or mutates) and never exposes the token value.
 */
export async function getXeroConnectionStatus(): Promise<{
  connected: boolean;
  needsReentry: boolean;
  tenantId: string | null;
  tokenExpiresAt: Date | null;
}> {
  const record = await prisma.xeroToken.findFirst();
  if (!record) {
    return {
      connected: false,
      needsReentry: false,
      tenantId: null,
      tokenExpiresAt: null,
    };
  }
  const readable = (await getXeroTokenReadability()) === "readable";
  return {
    connected: readable,
    needsReentry: !readable,
    tenantId: record.tenantId,
    tokenExpiresAt: record.expiresAt,
  };
}

/**
 * Destroy the stored Xero tokens — both copies — on a transaction the caller
 * owns, recording ONE audit row that names who did it and why (#3454).
 *
 * The row is written whenever a live grant was destroyed, which includes the
 * first-after-upgrade case where only the `XeroToken` copy existed: the store's
 * own delete records nothing when its row is absent, so this records it here,
 * through the same vocabulary. Nothing to destroy records nothing.
 */
export async function deleteXeroTokensInTransaction(
  params: XeroTokenWriteContext & {
    tx: Prisma.TransactionClient;
    cause: CredentialMutationCause;
  },
): Promise<boolean> {
  const legacy = await params.tx.xeroToken.deleteMany();
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
  if (!storeRemoved && legacy.count > 0) {
    await recordCredentialMutation(params.tx, {
      action: CREDENTIAL_AUDIT_ACTIONS.deleted,
      summary: `Deleted ${XERO_OAUTH_TOKEN_PROVIDER} credential "${XERO_OAUTH_TOKEN_KEY}" (pre-upgrade copy only)`,
      actor: params.actor,
      provider: XERO_OAUTH_TOKEN_PROVIDER,
      key: XERO_OAUTH_TOKEN_KEY,
      expectation: "any",
      cause: params.cause,
      request: params.request,
    });
  }
  return storeRemoved || legacy.count > 0;
}

/**
 * Remove all stored Xero tokens, in their own transaction. Used by the OAuth
 * disconnect after its best-effort revocation.
 */
export async function deleteXeroTokens(
  params: XeroTokenWriteContext & { cause: CredentialMutationCause },
): Promise<void> {
  await withCredentialTransaction([XERO_OAUTH_TOKEN_PROVIDER], (tx) =>
    deleteXeroTokensInTransaction({ ...params, tx }),
  );
  // Disconnect: no org is connected any more, so the cached org name/FYE/lock
  // dates must not linger for the next connection (F1).
  invalidateXeroOrganisationCaches();
}

/**
 * The Xero VERIFY-RESET in ONE transaction with the write that causes it (#3454).
 *
 * Saving a Xero client id or secret invalidates the OAuth app the stored tokens
 * belong to, so the tokens are destroyed. Both are database writes and nothing
 * calls Xero, so they commit together: the credential and the destruction of
 * the grant it orphaned can never land one without the other, and the two audit
 * rows share the request and say which credential caused the reset.
 */
export async function withXeroVerifyReset<T>(
  params: XeroTokenWriteContext & {
    /** The `provider:key` whose write causes the reset. A name, never a value. */
    causedByCredential: string;
    /** Providers whose cached credential rows the write touches. */
    providers: readonly string[];
  },
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const result = await withCredentialTransaction(
    [...params.providers, XERO_OAUTH_TOKEN_PROVIDER],
    async (tx) => {
      const written = await work(tx);
      await deleteXeroTokensInTransaction({
        tx,
        actor: params.actor,
        request: params.request,
        cause: { kind: "verify-reset", credential: params.causedByCredential },
      });
      return written;
    },
  );
  invalidateXeroOrganisationCaches();
  return result;
}
