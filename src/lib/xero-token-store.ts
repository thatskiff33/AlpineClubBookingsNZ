/**
 * Xero Token Storage
 *
 * Encrypts and persists Xero OAuth tokens (access, refresh, expiry, tenant)
 * and reports connection status. Keeps token plaintext out of the database.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { prisma } from "./prisma";
import { getOperationalXeroEncryptionKey } from "@/lib/xero-config";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const key = getOperationalXeroEncryptionKey();
  if (!key) {
    throw new Error("XERO_ENCRYPTION_KEY environment variable is required (32-byte hex string)");
  }
  const buf = Buffer.from(key, "hex");
  if (buf.length !== 32) {
    throw new Error("XERO_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)");
  }
  return buf;
}

export function encryptToken(plaintext: string): string {
  const key = getEncryptionKey();
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

export function decryptToken(encrypted: string): string {
  const key = getEncryptionKey();
  const parts = encrypted.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted token format");
  }
  const iv = Buffer.from(parts[0], "hex");
  const authTag = Buffer.from(parts[1], "hex");
  const ciphertext = parts[2];
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

function serializeTokenData(tokens: TokenData) {
  return {
    accessToken: encryptToken(tokens.accessToken),
    refreshToken: encryptToken(tokens.refreshToken),
    expiresAt: tokens.expiresAt,
    tenantId: tokens.tenantId ?? null,
    refreshInProgressUntil: null,
  };
}

function deserializeTokenRecord(record: {
  id: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  tenantId: string | null;
  refreshInProgressUntil: Date | null;
}): XeroTokenRecord {
  return {
    id: record.id,
    accessToken: decryptToken(record.accessToken),
    refreshToken: decryptToken(record.refreshToken),
    expiresAt: record.expiresAt,
    tenantId: record.tenantId ?? undefined,
    refreshInProgressUntil: record.refreshInProgressUntil,
  };
}

export async function saveXeroTokens(
  tokens: TokenData,
  options?: SaveXeroTokenOptions
): Promise<void> {
  const data = serializeTokenData(tokens);

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

  const encryptedAccess = encryptToken(tokens.accessToken);
  const encryptedRefresh = encryptToken(tokens.refreshToken);

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
}

export async function loadXeroTokens(): Promise<XeroTokenRecord | null> {
  const record = await prisma.xeroToken.findFirst();
  if (!record) return null;

  return deserializeTokenRecord(record);
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
        tokens: deserializeTokenRecord(record),
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
        tokens: latest ? deserializeTokenRecord(latest) : null,
        leaseUntil: latest?.refreshInProgressUntil ?? null,
      };
    }

    return {
      claimed: true,
      tokens: deserializeTokenRecord({
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
 * Get connection status details for the admin page.
 */
export async function getXeroConnectionStatus(): Promise<{
  connected: boolean;
  tenantId: string | null;
  tokenExpiresAt: Date | null;
}> {
  const record = await prisma.xeroToken.findFirst();
  if (!record) {
    return { connected: false, tenantId: null, tokenExpiresAt: null };
  }
  return {
    connected: true,
    tenantId: record.tenantId,
    tokenExpiresAt: record.expiresAt,
  };
}

/**
 * Remove all stored Xero tokens. Used by disconnect flows after best-effort revocation.
 */
export async function deleteXeroTokens(): Promise<void> {
  await prisma.xeroToken.deleteMany();
}
