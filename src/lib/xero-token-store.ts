/**
 * Xero Token Storage
 *
 * Encrypts and persists Xero OAuth tokens (access, refresh, expiry, tenant)
 * and reports connection status. Keeps token plaintext out of the database.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { prisma } from "./prisma";
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
  id: string;
  refreshInProgressUntil: Date | null;
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

export interface SaveXeroTokenOptions {
  claimedTokenId?: string;
  refreshLeaseUntil?: Date;
}

async function serializeTokenData(tokens: TokenData) {
  const [accessToken, refreshToken] = await Promise.all([
    encryptToken(tokens.accessToken),
    encryptToken(tokens.refreshToken),
  ]);
  return {
    accessToken,
    refreshToken,
    expiresAt: tokens.expiresAt,
    tenantId: tokens.tenantId ?? null,
    refreshInProgressUntil: null,
  };
}

async function deserializeTokenRecord(record: {
  id: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  tenantId: string | null;
  refreshInProgressUntil: Date | null;
}): Promise<XeroTokenRecord> {
  const [accessToken, refreshToken] = await Promise.all([
    decryptToken(record.accessToken),
    decryptToken(record.refreshToken),
  ]);
  return {
    id: record.id,
    accessToken,
    refreshToken,
    expiresAt: record.expiresAt,
    tenantId: record.tenantId ?? undefined,
    refreshInProgressUntil: record.refreshInProgressUntil,
  };
}

export async function saveXeroTokens(
  tokens: TokenData,
  options?: SaveXeroTokenOptions
): Promise<void> {
  const data = await serializeTokenData(tokens);

  if (options?.claimedTokenId && options.refreshLeaseUntil) {
    const updated = await prisma.xeroToken.updateMany({
      where: {
        id: options.claimedTokenId,
        refreshInProgressUntil: {
          lte: options.refreshLeaseUntil,
        },
      },
      data,
    });

    if (updated.count !== 1) {
      throw new Error(
        "Xero token refresh lease expired before refreshed tokens could be saved"
      );
    }

    return;
  }

  const [encryptedAccess, encryptedRefresh] = await Promise.all([
    encryptToken(tokens.accessToken),
    encryptToken(tokens.refreshToken),
  ]);

  // Atomic upsert via transaction to prevent concurrent token refresh race conditions.
  // Two concurrent refreshes could both read the same row and overwrite each other.
  await prisma.$transaction(async (tx) => {
    const existing = await tx.xeroToken.findFirst();
    if (existing) {
      await tx.xeroToken.update({
        where: { id: existing.id },
        data: {
          accessToken: encryptedAccess,
          refreshToken: encryptedRefresh,
          expiresAt: tokens.expiresAt,
          tenantId: tokens.tenantId ?? existing.tenantId,
          refreshInProgressUntil: null,
        },
      });
    } else {
      await tx.xeroToken.create({
        data: {
          accessToken: encryptedAccess,
          refreshToken: encryptedRefresh,
          expiresAt: tokens.expiresAt,
          tenantId: tokens.tenantId ?? null,
          refreshInProgressUntil: null,
        },
      });
    }
  });

  // A connect/reconnect can bind a DIFFERENT Xero organisation, so drop the
  // in-process org caches (name/FYE/lock dates) — the wizard's right-org
  // confirmation must read the NEW org, not a stale name (#2080 F1). NOTE: the
  // refresh-lease branch above returns early and never reaches here, because a
  // token refresh keeps the same organisation and must not defeat the cache.
  invalidateXeroOrganisationCaches();
}

export async function loadXeroTokens(): Promise<XeroTokenRecord | null> {
  const record = await prisma.xeroToken.findFirst();
  if (!record) return null;

  return deserializeTokenRecord(record);
}

// Note: isXeroConnected below deliberately does NOT decrypt (it only reads
// tenantId presence), so it never depends on the token-encryption key and never
// throws for a rotated/absent key. getXeroConnectionStatus DOES a single,
// side-effect-free readability probe (see getXeroTokenReadability) so the admin
// status page reports "reconnect required" rather than "connected" over tokens
// that no longer decrypt (#2079 upgrade / auth-secret change).

export type XeroTokenReadability = "no_tokens" | "readable" | "unreadable";

/**
 * Whether the stored Xero access token can be decrypted with the currently
 * resolvable token key. SIDE-EFFECT-FREE: it PEEKS the token key (never
 * generates one — a status read must not mutate the DB) and never exposes the
 * decrypted value. Returns:
 *   - "no_tokens"   — no token row stored;
 *   - "unreadable"  — key missing/unreadable, or the token row fails GCM
 *                     (auth secret changed) ⇒ the operator must reconnect;
 *   - "readable"    — decrypts cleanly.
 *
 * A stored `record` may be passed to avoid a duplicate DB read.
 */
export async function getXeroTokenReadability(record?: {
  accessToken: string;
} | null): Promise<XeroTokenReadability> {
  const row =
    record === undefined
      ? await prisma.xeroToken.findFirst({ select: { accessToken: true } })
      : record;
  if (!row) return "no_tokens";
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
    decryptWithKey(row.accessToken, keyBuf);
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
    const record = await tx.xeroToken.findFirst();
    if (!record) {
      return { claimed: false, tokens: null, leaseUntil: null };
    }

    const existingLeaseUntil = record.refreshInProgressUntil;
    if (existingLeaseUntil && existingLeaseUntil > now) {
      return {
        claimed: false,
        tokens: await deserializeTokenRecord(record),
        leaseUntil: existingLeaseUntil,
      };
    }

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
      const latest = await tx.xeroToken.findUnique({
        where: { id: record.id },
      });
      return {
        claimed: false,
        tokens: latest ? await deserializeTokenRecord(latest) : null,
        leaseUntil: latest?.refreshInProgressUntil ?? null,
      };
    }

    return {
      claimed: true,
      tokens: await deserializeTokenRecord({
        ...record,
        refreshInProgressUntil: leaseUntil,
      }),
      leaseUntil,
    };
  });
}

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
  const readable =
    (await getXeroTokenReadability({ accessToken: record.accessToken })) ===
    "readable";
  return {
    connected: readable,
    needsReentry: !readable,
    tenantId: record.tenantId,
    tokenExpiresAt: record.expiresAt,
  };
}

/**
 * Remove all stored Xero tokens. Used by disconnect flows after best-effort revocation.
 */
export async function deleteXeroTokens(): Promise<void> {
  await prisma.xeroToken.deleteMany();
  // Disconnect / credential verify-reset: no org is connected any more, so the
  // cached org name/FYE/lock dates must not linger for the next connection (F1).
  invalidateXeroOrganisationCaches();
}
