import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    $transaction: vi.fn(),
    financeXeroToken: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import {
  clearFinanceXeroTokens,
  decryptFinanceXeroToken,
  encryptFinanceXeroToken,
  getFinanceXeroConnectionStatus,
  loadFinanceXeroTokens,
  saveFinanceXeroTokens,
} from "@/lib/finance-xero-token-store";

const originalEnv = { ...process.env };

function restoreEnv() {
  process.env = { ...originalEnv };
}

describe("finance-xero-token-store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreEnv();
    mockPrisma.$transaction.mockImplementation(async (callback: (tx: typeof mockPrisma) => Promise<unknown>) =>
      callback(mockPrisma)
    );
  });

  afterEach(() => {
    restoreEnv();
  });

  it("encrypts and decrypts finance tokens with the finance-only encryption key", () => {
    process.env.FINANCE_XERO_ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    const encrypted = encryptFinanceXeroToken("finance-access-token");
    expect(encrypted).not.toBe("finance-access-token");
    expect(encrypted.split(":")).toHaveLength(3);
    expect(decryptFinanceXeroToken(encrypted)).toBe("finance-access-token");
  });

  it("does not fall back to the operational encryption key", () => {
    process.env.XERO_ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    delete process.env.FINANCE_XERO_ENCRYPTION_KEY;

    expect(() => encryptFinanceXeroToken("finance-access-token")).toThrow(
      "FINANCE_XERO_ENCRYPTION_KEY"
    );
  });

  it("persists and loads finance tokens through the finance-only table", async () => {
    process.env.FINANCE_XERO_ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const expiresAt = new Date("2026-04-20T10:00:00.000Z");

    mockPrisma.financeXeroToken.findFirst.mockResolvedValueOnce(null);
    mockPrisma.financeXeroToken.create.mockResolvedValue({ id: "finance-token-1" });

    await saveFinanceXeroTokens({
      accessToken: "finance-access-token",
      refreshToken: "finance-refresh-token",
      expiresAt,
      tenantId: "tenant-123",
    });

    expect(mockPrisma.financeXeroToken.create).toHaveBeenCalledTimes(1);
    const createArgs = mockPrisma.financeXeroToken.create.mock.calls[0][0];
    expect(createArgs.data.accessToken).not.toBe("finance-access-token");
    expect(createArgs.data.refreshToken).not.toBe("finance-refresh-token");

    mockPrisma.financeXeroToken.findFirst.mockResolvedValueOnce({
      id: "finance-token-1",
      accessToken: createArgs.data.accessToken,
      refreshToken: createArgs.data.refreshToken,
      expiresAt,
      tenantId: "tenant-123",
    });

    await expect(loadFinanceXeroTokens()).resolves.toMatchObject({
      id: "finance-token-1",
      accessToken: "finance-access-token",
      refreshToken: "finance-refresh-token",
      expiresAt,
      tenantId: "tenant-123",
    });
  });

  it("reports finance connection status from the finance-only token table", async () => {
    const expiresAt = new Date("2026-04-20T10:00:00.000Z");
    mockPrisma.financeXeroToken.findFirst.mockResolvedValueOnce({
      id: "finance-token-1",
      accessToken: "encrypted-access",
      refreshToken: "encrypted-refresh",
      expiresAt,
      tenantId: "tenant-123",
    });

    await expect(getFinanceXeroConnectionStatus()).resolves.toEqual({
      connected: true,
      tenantId: "tenant-123",
      tokenExpiresAt: expiresAt,
    });
  });

  it("clears finance tokens from the finance-only table", async () => {
    mockPrisma.financeXeroToken.deleteMany.mockResolvedValue({ count: 1 });

    await clearFinanceXeroTokens();

    expect(mockPrisma.financeXeroToken.deleteMany).toHaveBeenCalledTimes(1);
  });
});
