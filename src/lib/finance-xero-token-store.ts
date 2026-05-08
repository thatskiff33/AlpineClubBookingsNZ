import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { getFinanceXeroEncryptionKey } from "@/lib/xero-config";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

export interface FinanceXeroTokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  tenantId?: string;
}

export interface FinanceXeroTokenRecord extends FinanceXeroTokenData {
  id: string;
}

interface FinanceEncryptionKeyCandidate {
  encryptionKeyVersion: number;
  key: Buffer;
}

function parseFinanceEncryptionKey(
  rawKey: string | undefined,
  envName: string
): Buffer {
  if (!rawKey) {
    throw new Error(
      "FINANCE_XERO_ENCRYPTION_KEY environment variable is required (32-byte hex string)"
    );
  }

  const buffer = Buffer.from(rawKey, "hex");
  if (buffer.length !== 32) {
    throw new Error(`${envName} must be a 64-character hex string (32 bytes)`);
  }

  return buffer;
}

function getFinanceEncryptionKeyVersion() {
  const rawVersion = process.env.FINANCE_XERO_ENCRYPTION_KEY_VERSION;
  const parsedVersion = rawVersion ? Number.parseInt(rawVersion, 10) : 1;
  return Number.isFinite(parsedVersion) && parsedVersion > 0 ? parsedVersion : 1;
}

function getFinanceEncryptionKey(): Buffer {
  const key = getFinanceXeroEncryptionKey();
  return parseFinanceEncryptionKey(key, "FINANCE_XERO_ENCRYPTION_KEY");
}

function getFinanceEncryptionCandidateKeys(): FinanceEncryptionKeyCandidate[] {
  const currentVersion = getFinanceEncryptionKeyVersion();
  const candidateKeys: FinanceEncryptionKeyCandidate[] = [
    {
      encryptionKeyVersion: currentVersion,
      key: getFinanceEncryptionKey(),
    },
  ];
  const previousKey =
    process.env.FINANCE_XERO_ENCRYPTION_KEY_PREVIOUS ??
    process.env.FINANCE_XERO_PREVIOUS_ENCRYPTION_KEY;
  if (previousKey) {
    candidateKeys.push({
      encryptionKeyVersion: Math.max(currentVersion - 1, 1),
      key: parseFinanceEncryptionKey(
        previousKey,
        "FINANCE_XERO_ENCRYPTION_KEY_PREVIOUS"
      ),
    });
  }

  return candidateKeys;
}

function decryptWithFinanceKey(encrypted: string, key: Buffer): string {
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

function decryptFinanceXeroTokenWithFallback(
  encrypted: string,
  encryptionKeyVersion?: number | null
): string {
  const candidateKeys = getFinanceEncryptionCandidateKeys().sort((a, b) => {
    if (a.encryptionKeyVersion === encryptionKeyVersion) {
      return -1;
    }
    if (b.encryptionKeyVersion === encryptionKeyVersion) {
      return 1;
    }
    return a.encryptionKeyVersion - b.encryptionKeyVersion;
  });

  let fallbackError: Error | null = null;
  for (const candidateKey of candidateKeys) {
    try {
      return decryptWithFinanceKey(encrypted, candidateKey.key);
    } catch (error) {
      fallbackError =
        error instanceof Error ? error : new Error(String(error));
    }
  }

  throw fallbackError ?? new Error("Unable to decrypt finance token");
}

export function encryptFinanceXeroToken(plaintext: string): string {
  const key = getFinanceEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

export function decryptFinanceXeroToken(encrypted: string): string {
  const key = getFinanceEncryptionKey();
  return decryptWithFinanceKey(encrypted, key);
}

export async function saveFinanceXeroTokens(tokens: FinanceXeroTokenData): Promise<void> {
  const encryptedAccessToken = encryptFinanceXeroToken(tokens.accessToken);
  const encryptedRefreshToken = encryptFinanceXeroToken(tokens.refreshToken);
  const encryptionKeyVersion = getFinanceEncryptionKeyVersion();

  await prisma.$transaction(async (tx) => {
    const existing = await tx.financeXeroToken.findFirst();
    if (existing) {
      await tx.financeXeroToken.update({
        where: { id: existing.id },
        data: {
          accessToken: encryptedAccessToken,
          refreshToken: encryptedRefreshToken,
          expiresAt: tokens.expiresAt,
          encryptionKeyVersion,
          tenantId: tokens.tenantId ?? existing.tenantId,
        },
      });
      return;
    }

    await tx.financeXeroToken.create({
      data: {
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        expiresAt: tokens.expiresAt,
        encryptionKeyVersion,
        tenantId: tokens.tenantId ?? null,
      },
    });
  });
}

export async function loadFinanceXeroTokens(): Promise<FinanceXeroTokenRecord | null> {
  const record = await prisma.financeXeroToken.findFirst();
  if (!record) {
    return null;
  }

  return {
    id: record.id,
    accessToken: decryptFinanceXeroTokenWithFallback(
      record.accessToken,
      record.encryptionKeyVersion
    ),
    refreshToken: decryptFinanceXeroTokenWithFallback(
      record.refreshToken,
      record.encryptionKeyVersion
    ),
    expiresAt: record.expiresAt,
    tenantId: record.tenantId ?? undefined,
  };
}

export async function getFinanceXeroConnectionStatus(): Promise<{
  connected: boolean;
  hasStoredTokens: boolean;
  tenantId: string | null;
  tokenExpiresAt: Date | null;
}> {
  const record = await prisma.financeXeroToken.findFirst();
  if (!record) {
    return {
      connected: false,
      hasStoredTokens: false,
      tenantId: null,
      tokenExpiresAt: null,
    };
  }

  return {
    connected: record.tenantId !== null,
    hasStoredTokens: true,
    tenantId: record.tenantId,
    tokenExpiresAt: record.expiresAt,
  };
}

export async function clearFinanceXeroTokens(): Promise<void> {
  await prisma.financeXeroToken.deleteMany();
}
