import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(),
    member: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };

  const prisma = {
    $transaction: vi.fn(async (callback) => callback(tx)),
    xeroToken: {
      findFirst: vi.fn(),
    },
  };

  const xeroClientInstance = {
    initialize: vi.fn().mockResolvedValue(undefined),
    setTokenSet: vi.fn(),
    refreshWithRefreshToken: vi.fn(),
    accountingApi: {
      getContacts: vi.fn(),
    },
  };

  return {
    prisma,
    tx,
    xeroClientInstance,
    XeroClient: vi.fn(function MockXeroClient() {
      return xeroClientInstance;
    }),
    upsertXeroObjectLink: vi.fn(),
    startXeroSyncOperation: vi.fn(),
    completeXeroSyncOperation: vi.fn(),
    failXeroSyncOperation: vi.fn(),
    recordXeroApiUsage: vi.fn(),
    logger: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  };
});

vi.mock("xero-node", () => ({
  XeroClient: mocks.XeroClient,
  Contact: class {},
  ContactGroup: class {},
  Invoice: {
    TypeEnum: { ACCREC: "ACCREC" },
    StatusEnum: { AUTHORISED: "AUTHORISED" },
  },
  LineItem: class {},
  LineAmountTypes: { Inclusive: "Inclusive" },
  CreditNote: {
    TypeEnum: { ACCRECCREDIT: "ACCRECCREDIT" },
    StatusEnum: { AUTHORISED: "AUTHORISED" },
  },
  Payment: class {},
  Phone: {
    PhoneTypeEnum: { MOBILE: "MOBILE" },
  },
  Address: class {},
}));

vi.mock("@/lib/prisma", () => ({
  prisma: mocks.prisma,
}));

vi.mock("@/lib/email", () => ({
  sendPasswordResetEmail: vi.fn(),
}));

vi.mock("@/lib/pricing", () => ({
  getSeasonYear: vi.fn(),
  getStayNights: vi.fn(),
}));

vi.mock("@/lib/phone", () => ({
  formatXeroPhone: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  default: mocks.logger,
}));

vi.mock("@/lib/xero-api-usage", () => ({
  recordXeroApiUsage: mocks.recordXeroApiUsage,
}));

vi.mock("@/lib/xero-links", () => ({
  buildXeroContactUrl: vi.fn((contactId: string) => `https://go.xero.test/contact/${contactId}`),
  buildXeroInvoiceUrl: vi.fn((invoiceId: string) => `https://go.xero.test/invoice/${invoiceId}`),
}));

vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: vi.fn((...parts: unknown[]) => parts.join(":")),
  buildXeroPayloadHash: vi.fn(() => "payload-hash"),
  completeXeroSyncOperation: mocks.completeXeroSyncOperation,
  failXeroSyncOperation: mocks.failXeroSyncOperation,
  startXeroSyncOperation: mocks.startXeroSyncOperation,
  upsertXeroObjectLink: mocks.upsertXeroObjectLink,
}));

import {
  encryptToken,
  findOrCreateXeroContact,
  resetXeroRateLimitStateForTests,
} from "@/lib/xero";

describe("findOrCreateXeroContact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetXeroRateLimitStateForTests();
    vi.stubEnv(
      "XERO_ENCRYPTION_KEY",
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    );

    mocks.prisma.$transaction.mockImplementation(async (callback) => callback(mocks.tx));
    mocks.tx.$executeRaw.mockResolvedValue(undefined);
    mocks.tx.member.update.mockResolvedValue({ id: "mem_1", xeroContactId: "xero_new" });
    mocks.prisma.xeroToken.findFirst.mockResolvedValue(null);
    mocks.xeroClientInstance.accountingApi.getContacts.mockResolvedValue({
      body: { contacts: [] },
    });
  });

  it("trusts an existing member.xeroContactId without verifying it via Xero", async () => {
    mocks.tx.member.findUnique.mockResolvedValue({
      id: "mem_1",
      email: "member@example.com",
      xeroContactId: "xero_existing",
    });

    await expect(findOrCreateXeroContact("mem_1")).resolves.toBe("xero_existing");

    expect(mocks.prisma.xeroToken.findFirst).not.toHaveBeenCalled();
    expect(mocks.xeroClientInstance.accountingApi.getContacts).not.toHaveBeenCalled();
    expect(mocks.tx.member.update).not.toHaveBeenCalled();
    expect(mocks.upsertXeroObjectLink).toHaveBeenCalledWith({
      localModel: "Member",
      localId: "mem_1",
      xeroObjectType: "CONTACT",
      xeroObjectId: "xero_existing",
      xeroObjectUrl: "https://go.xero.test/contact/xero_existing",
      role: "CONTACT",
    });
  });

  it("can explicitly repair an existing link by re-searching Xero and updating the member link", async () => {
    mocks.tx.member.findUnique.mockResolvedValue({
      id: "mem_1",
      email: "member@example.com",
      xeroContactId: "xero_stale",
    });
    mocks.prisma.xeroToken.findFirst.mockResolvedValue({
      id: "token_1",
      accessToken: encryptToken("access"),
      refreshToken: encryptToken("refresh"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      tenantId: "tenant_1",
    });
    mocks.xeroClientInstance.accountingApi.getContacts.mockResolvedValue({
      body: {
        contacts: [{ contactID: "xero_repaired" }],
      },
    });

    await expect(
      findOrCreateXeroContact("mem_1", { repairExistingLink: true })
    ).resolves.toBe("xero_repaired");

    expect(mocks.xeroClientInstance.accountingApi.getContacts).toHaveBeenCalledWith(
      "tenant_1",
      undefined,
      'EmailAddress="member@example.com"'
    );
    expect(mocks.tx.member.update).toHaveBeenCalledWith({
      where: { id: "mem_1" },
      data: { xeroContactId: "xero_repaired" },
    });
    expect(mocks.upsertXeroObjectLink).toHaveBeenCalledWith({
      localModel: "Member",
      localId: "mem_1",
      xeroObjectType: "CONTACT",
      xeroObjectId: "xero_repaired",
      xeroObjectUrl: "https://go.xero.test/contact/xero_repaired",
      role: "CONTACT",
      metadata: {
        linkedVia: "email_match_repair",
        repairedFromXeroContactId: "xero_stale",
      },
    });
  });
});
