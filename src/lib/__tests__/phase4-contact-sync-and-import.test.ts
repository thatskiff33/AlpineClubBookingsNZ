import { createCipheriv } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function encryptForTest(plaintext: string) {
  const key = Buffer.from(TEST_KEY, "hex");
  const iv = Buffer.alloc(16, 7);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

const mocks = vi.hoisted(() => {
  const accountingApi = {
    getContacts: vi.fn(),
    getInvoices: vi.fn(),
  };

  return {
    accountingApi,
    prisma: {
      xeroToken: {
        findFirst: vi.fn(),
      },
      xeroSyncCursor: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
      },
      xeroContactCache: {
        upsert: vi.fn(),
        findMany: vi.fn(),
      },
      xeroContactGroupMembershipCache: {
        findMany: vi.fn(),
      },
      member: {
        findFirst: vi.fn(),
        update: vi.fn(),
        create: vi.fn(),
      },
      passwordResetToken: {
        create: vi.fn(),
      },
      familyGroupMember: {
        findFirst: vi.fn(),
        create: vi.fn(),
        createMany: vi.fn(),
      },
      familyGroup: {
        create: vi.fn(),
      },
      xeroAccountMapping: {
        findUnique: vi.fn(),
      },
      $transaction: vi.fn(),
    },
    recordXeroApiUsage: vi.fn(),
    logger: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/email", () => ({
  sendPasswordResetEmail: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));
vi.mock("@/lib/pricing", () => ({
  getSeasonYear: vi.fn(),
  getStayNights: vi.fn(),
}));
vi.mock("@/lib/phone", () => ({
  formatXeroPhone: vi.fn((phone: { phoneNumber?: string | null }) => phone.phoneNumber ?? null),
}));
vi.mock("@/lib/xero-api-usage", () => ({
  recordXeroApiUsage: mocks.recordXeroApiUsage,
}));
vi.mock("@/lib/xero-error-shape", () => ({
  getXeroErrorHeader: vi.fn(
    (error: { response?: { headers?: Record<string, string> } }, header: string) =>
      error?.response?.headers?.[header]
  ),
  getXeroErrorStatusCode: vi.fn(
    (error: { response?: { statusCode?: number } }) => error?.response?.statusCode
  ),
}));
vi.mock("@/lib/xero-links", () => ({
  buildXeroContactUrl: vi.fn((id: string) => `https://xero.test/contacts/${id}`),
  buildXeroInvoiceUrl: vi.fn((id: string) => `https://xero.test/invoices/${id}`),
}));
vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: vi.fn(),
  buildXeroPayloadHash: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  sanitizeForJson: vi.fn((value: unknown) => value),
  startXeroSyncOperation: vi.fn(),
  upsertXeroObjectLink: vi.fn(),
}));
vi.mock("bcryptjs", () => ({
  hash: vi.fn().mockResolvedValue("placeholder-hash"),
}));
vi.mock("xero-node", () => ({
  XeroClient: class {
    accountingApi = mocks.accountingApi;
    initialize = vi.fn().mockResolvedValue(undefined);
    setTokenSet = vi.fn();
    refreshWithRefreshToken = vi.fn();
  },
  Contact: class {},
  ContactGroup: { StatusEnum: { ACTIVE: "ACTIVE" } },
  Invoice: {
    StatusEnum: {
      PAID: "PAID",
      AUTHORISED: "AUTHORISED",
      SUBMITTED: "SUBMITTED",
    },
  },
  LineItem: class {},
  LineAmountTypes: {},
  CreditNote: class {},
  Payment: class {},
  Phone: { PhoneTypeEnum: { MOBILE: "MOBILE" } },
  Address: { AddressTypeEnum: { STREET: "STREET", POBOX: "POBOX" } },
}));

import {
  importMembersFromXeroGroups,
  syncContactsFromXero,
} from "@/lib/xero";

describe("Phase 4 contact sync and cached import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("XERO_ENCRYPTION_KEY", TEST_KEY);

    mocks.prisma.xeroToken.findFirst.mockResolvedValue({
      id: "token_1",
      accessToken: encryptForTest("access-token"),
      refreshToken: encryptForTest("refresh-token"),
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      tenantId: "tenant_1",
    });
    mocks.prisma.xeroSyncCursor.upsert.mockResolvedValue({});
    mocks.prisma.xeroContactCache.upsert.mockResolvedValue({});
    mocks.prisma.xeroContactCache.findMany.mockResolvedValue([]);
    mocks.prisma.xeroContactGroupMembershipCache.findMany.mockResolvedValue([]);
    mocks.prisma.member.update.mockResolvedValue({});
    mocks.prisma.member.create.mockResolvedValue({
      id: "member_new",
      email: "new@example.com",
    });
    mocks.prisma.familyGroupMember.findFirst.mockResolvedValue(null);
    mocks.prisma.familyGroupMember.create.mockResolvedValue({});
    mocks.prisma.familyGroupMember.createMany.mockResolvedValue({});
    mocks.prisma.familyGroup.create.mockResolvedValue({ id: "family_1" });
    mocks.recordXeroApiUsage.mockResolvedValue(undefined);
  });

  it("uses the contact sync cursor and skips first-invoice lookups in the default sync path", async () => {
    mocks.prisma.xeroSyncCursor.findUnique.mockResolvedValue({
      cursorDateTime: new Date("2026-04-14T10:00:00.000Z"),
      lastSuccessfulSyncAt: new Date("2026-04-14T10:05:00.000Z"),
      metadata: {
        retryContactIds: ["contact_retry"],
      },
    });
    mocks.accountingApi.getContacts
      .mockResolvedValueOnce({
        body: {
          contacts: [
            {
              contactID: "contact_1",
              name: "John Smith",
              emailAddress: "john@example.com",
              phones: [
                {
                  phoneType: "MOBILE",
                  phoneCountryCode: "64",
                  phoneAreaCode: "27",
                  phoneNumber: "1112222",
                },
              ],
              addresses: [
                {
                  addressType: "STREET",
                  addressLine1: "1 Alpine Way",
                  city: "Wanaka",
                  region: "Otago",
                  postalCode: "9305",
                  country: "NZ",
                },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        body: {
          contacts: [
            {
              contactID: "contact_retry",
              name: "Retry Contact",
            },
          ],
        },
      });
    mocks.prisma.member.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "member_1",
        firstName: "John",
        lastName: "Smith",
        xeroContactId: null,
        joinedDate: null,
        phoneNumber: null,
        streetAddressLine1: null,
        postalAddressLine1: null,
      })
      .mockResolvedValueOnce(null);

    const report = await syncContactsFromXero();

    expect(report.total).toBe(2);
    expect(report.updated).toHaveLength(1);
    expect(report.skippedNoEmail).toEqual([
      { name: "Retry Contact", xeroContactId: "contact_retry" },
    ]);
    expect(mocks.accountingApi.getInvoices).not.toHaveBeenCalled();

    const firstGetContactsCall = mocks.accountingApi.getContacts.mock.calls[0];
    expect(firstGetContactsCall[1]?.toISOString()).toBe(
      "2026-04-14T09:58:00.000Z"
    );
    expect(firstGetContactsCall[5]).toBe(1);

    const retryGetContactsCall = mocks.accountingApi.getContacts.mock.calls[1];
    expect(retryGetContactsCall[4]).toEqual(["contact_retry"]);

    const updatedMemberCall = mocks.prisma.member.update.mock.calls[0][0];
    expect(updatedMemberCall).toEqual({
      where: { id: "member_1" },
      data: expect.objectContaining({
        xeroContactId: "contact_1",
        phoneCountryCode: "64",
        phoneAreaCode: "27",
        phoneNumber: "1112222",
        streetAddressLine1: "1 Alpine Way",
      }),
    });
    expect(updatedMemberCall.data).not.toHaveProperty("joinedDate");

    expect(mocks.prisma.xeroSyncCursor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          resourceType: "CONTACT_SYNC",
          metadata: expect.objectContaining({
            changedContactCount: 1,
            retryContactIds: [],
          }),
        }),
      })
    );
  });

  it("imports members from cached group memberships and cached contacts without live Xero fetches", async () => {
    mocks.prisma.xeroSyncCursor.findUnique
      .mockResolvedValueOnce({
        cursorDateTime: new Date("2026-04-14T08:00:00.000Z"),
        lastSuccessfulSyncAt: new Date("2026-04-14T08:05:00.000Z"),
        metadata: {},
      })
      .mockResolvedValueOnce({
        cursorDateTime: new Date("2026-04-14T09:00:00.000Z"),
        lastSuccessfulSyncAt: new Date("2026-04-14T09:05:00.000Z"),
        metadata: {},
      });
    mocks.prisma.xeroContactGroupMembershipCache.findMany.mockResolvedValue([
      { contactGroupId: "group_1", contactId: "contact_1" },
    ]);
    mocks.prisma.xeroContactCache.findMany.mockResolvedValue([
      {
        contactId: "contact_1",
        name: "New Person",
        firstName: "New",
        lastName: "Person",
        emailAddress: "new@example.com",
        companyNumber: "02/03/2004",
        contactStatus: "ACTIVE",
        phoneCountryCode: "64",
        phoneAreaCode: "27",
        phoneNumber: "3334444",
        streetAddressLine1: "2 Snow Road",
        streetAddressLine2: null,
        streetCity: "Wanaka",
        streetRegion: "Otago",
        streetPostalCode: "9305",
        streetCountry: "NZ",
        postalAddressLine1: "PO Box 2",
        postalAddressLine2: null,
        postalCity: "Wanaka",
        postalRegion: "Otago",
        postalPostalCode: "9343",
        postalCountry: "NZ",
      },
    ]);
    mocks.prisma.member.findFirst.mockResolvedValue(null);

    const result = await importMembersFromXeroGroups(
      [{ groupId: "group_1", groupName: "Adults", ageTier: "ADULT" as any }],
      false
    );

    expect(result).toMatchObject({
      created: 1,
      errors: 0,
      groupsProcessed: ["Adults"],
    });
    expect(mocks.accountingApi.getContacts).not.toHaveBeenCalled();

    const createCall = mocks.prisma.member.create.mock.calls[0][0];
    expect(createCall.data).toEqual(
      expect.objectContaining({
        email: "new@example.com",
        firstName: "New",
        lastName: "Person",
        xeroContactId: "contact_1",
        phoneNumber: "3334444",
        streetAddressLine1: "2 Snow Road",
        postalAddressLine1: "PO Box 2",
      })
    );
    expect(createCall.data.joinedDate).toBeUndefined();
  });

  it("fails cached group import with a repair message when contact snapshots are missing", async () => {
    mocks.prisma.xeroSyncCursor.findUnique
      .mockResolvedValueOnce({
        cursorDateTime: new Date("2026-04-14T08:00:00.000Z"),
        lastSuccessfulSyncAt: new Date("2026-04-14T08:05:00.000Z"),
        metadata: {},
      })
      .mockResolvedValueOnce({
        cursorDateTime: new Date("2026-04-14T09:00:00.000Z"),
        lastSuccessfulSyncAt: new Date("2026-04-14T09:05:00.000Z"),
        metadata: {},
      });
    mocks.prisma.xeroContactGroupMembershipCache.findMany.mockResolvedValue([
      { contactGroupId: "group_1", contactId: "contact_missing" },
    ]);
    mocks.prisma.xeroContactCache.findMany.mockResolvedValue([]);

    await expect(
      importMembersFromXeroGroups(
        [{ groupId: "group_1", groupName: "Adults", ageTier: "ADULT" as any }],
        false
      )
    ).rejects.toThrow("Run contact sync first");

    expect(mocks.accountingApi.getContacts).not.toHaveBeenCalled();
  });
});
