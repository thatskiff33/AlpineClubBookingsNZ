import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { getFinanceXeroEncryptionKey } from "@/lib/xero-config";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;

export interface FinanceXeroTokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  tenantId?: string;
}

export interface FinanceXeroTokenRecord extends FinanceXeroTokenData {
  id: string;
}

function getFinanceEncryptionKey(): Buffer {
  const key = getFinanceXeroEncryptionKey();
  if (!key) {
    throw new Error("FINANCE_XERO_ENCRYPTION_KEY environment variable is required (32-byte hex string)");
  }

  const buffer = Buffer.from(key, "hex");
  if (buffer.length !== 32) {
    throw new Error("FINANCE_XERO_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)");
  }

  return buffer;
}

export function encryptFinanceXeroToken(plaintext: string): string {
  const key = getFinanceEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

export function decryptFinanceXeroToken(encrypted: string): string {
  const key = getFinanceEncryptionKey();
  const parts = encrypted.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted token format");
  }

  const iv = Buffer.from(parts[0], "hex");
  const authTag = Buffer.from(parts[1], "hex");
  const ciphertext = parts[2];
  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

export async function saveFinanceXeroTokens(tokens: FinanceXeroTokenData): Promise<void> {
  const encryptedAccessToken = encryptFinanceXeroToken(tokens.accessToken);
  const encryptedRefreshToken = encryptFinanceXeroToken(tokens.refreshToken);

  await prisma.$transaction(async (tx) => {
    const existing = await tx.financeXeroToken.findFirst();
    if (existing) {
      await tx.financeXeroToken.update({
        where: { id: existing.id },
        data: {
          accessToken: encryptedAccessToken,
          refreshToken: encryptedRefreshToken,
          expiresAt: tokens.expiresAt,
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
    accessToken: decryptFinanceXeroToken(record.accessToken),
    refreshToken: decryptFinanceXeroToken(record.refreshToken),
    expiresAt: record.expiresAt,
    tenantId: record.tenantId ?? undefined,
  };
}

export async function getFinanceXeroConnectionStatus(): Promise<{
  connected: boolean;
  tenantId: string | null;
  tokenExpiresAt: Date | null;
}> {
  const record = await prisma.financeXeroToken.findFirst();
  if (!record) {
    return {
      connected: false,
      tenantId: null,
      tokenExpiresAt: null,
    };
  }

  return {
    connected: true,
    tenantId: record.tenantId,
    tokenExpiresAt: record.expiresAt,
  };
}

export async function clearFinanceXeroTokens(): Promise<void> {
  await prisma.financeXeroToken.deleteMany();
}
