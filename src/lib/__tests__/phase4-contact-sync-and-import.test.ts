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
    getContactGroup: vi.fn(),
    getContactGroups: vi.fn(),
    getContacts: vi.fn(),
    getInvoices: vi.fn(),
    updateContact: vi.fn(),
  };

  return {
    accountingApi,
    buildXeroIdempotencyKey: vi.fn((...parts: unknown[]) => parts.join(":")),
    buildXeroPayloadHash: vi.fn(() => "payload-hash"),
    completeXeroSyncOperation: vi.fn(),
    failXeroSyncOperation: vi.fn(),
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
      xeroContactGroupCache: {
        deleteMany: vi.fn(),
        findMany: vi.fn(),
        upsert: vi.fn(),
        updateMany: vi.fn(),
      },
      xeroContactGroupMembershipCache: {
        findMany: vi.fn(),
        deleteMany: vi.fn(),
        createMany: vi.fn(),
        updateMany: vi.fn(),
      },
      member: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn(),
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
      auditLog: {
        create: vi.fn(),
      },
      $transaction: vi.fn(),
    },
    recordXeroApiUsage: vi.fn(),
    sanitizeForJson: vi.fn((value: unknown) => value),
    startXeroSyncOperation: vi.fn(),
    upsertXeroObjectLink: vi.fn(),
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
  getXeroErrorBodyMessage: vi.fn(() => undefined),
  getXeroErrorStatusCode: vi.fn(
    (error: { response?: { statusCode?: number } }) => error?.response?.statusCode
  ),
}));
vi.mock("@/lib/xero-links", () => ({
  buildXeroContactUrl: vi.fn((id: string) => `https://xero.test/contacts/${id}`),
  buildXeroInvoiceUrl: vi.fn((id: string) => `https://xero.test/invoices/${id}`),
}));
vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: mocks.buildXeroIdempotencyKey,
  buildXeroPayloadHash: mocks.buildXeroPayloadHash,
  completeXeroSyncOperation: mocks.completeXeroSyncOperation,
  failXeroSyncOperation: mocks.failXeroSyncOperation,
  sanitizeForJson: mocks.sanitizeForJson,
  startXeroSyncOperation: mocks.startXeroSyncOperation,
  upsertXeroObjectLink: mocks.upsertXeroObjectLink,
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
  findPotentialXeroContactsForMember,
  importMembersFromXeroGroups,
  refreshXeroContactGroupCache,
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
    mocks.prisma.xeroContactGroupCache.deleteMany.mockResolvedValue({ count: 0 });
    mocks.prisma.xeroContactGroupCache.findMany.mockResolvedValue([]);
    mocks.prisma.xeroContactGroupCache.upsert.mockResolvedValue({});
    mocks.prisma.xeroContactGroupCache.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.xeroContactGroupMembershipCache.findMany.mockResolvedValue([]);
    mocks.prisma.xeroContactGroupMembershipCache.deleteMany.mockResolvedValue({ count: 0 });
    mocks.prisma.xeroContactGroupMembershipCache.createMany.mockResolvedValue({ count: 0 });
    mocks.prisma.xeroContactGroupMembershipCache.updateMany.mockResolvedValue({ count: 0 });
    mocks.prisma.member.update.mockResolvedValue({});
    mocks.prisma.auditLog.create.mockResolvedValue({});
    mocks.prisma.member.create.mockResolvedValue({
      id: "member_new",
      email: "new@example.com",
    });
    mocks.prisma.member.findUnique.mockResolvedValue(null);
    mocks.prisma.member.findMany.mockResolvedValue([]);
    mocks.prisma.familyGroupMember.findFirst.mockResolvedValue(null);
    mocks.prisma.familyGroupMember.create.mockResolvedValue({});
    mocks.prisma.familyGroupMember.createMany.mockResolvedValue({});
    mocks.prisma.familyGroup.create.mockResolvedValue({ id: "family_1" });
    mocks.prisma.$transaction.mockImplementation(
      async (callback: (tx: typeof mocks.prisma) => Promise<unknown>) =>
        callback(mocks.prisma)
    );
    mocks.recordXeroApiUsage.mockResolvedValue(undefined);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_1" });
    mocks.completeXeroSyncOperation.mockResolvedValue(undefined);
    mocks.failXeroSyncOperation.mockResolvedValue(undefined);
    mocks.accountingApi.getContactGroup.mockReset();
    mocks.accountingApi.getContactGroups.mockReset();
    mocks.accountingApi.getContacts.mockReset();
    mocks.accountingApi.getInvoices.mockReset();
    mocks.accountingApi.updateContact.mockResolvedValue({
      body: { contacts: [{ contactID: "contact_1" }] },
    });
  });

  it("repairs missing contact snapshots when refreshing Xero contact groups", async () => {
    mocks.accountingApi.getContactGroups.mockResolvedValue({
      body: {
        contactGroups: [
          {
            contactGroupID: "group_1",
            name: "Adults",
            status: "ACTIVE",
          },
        ],
      },
    });
    mocks.accountingApi.getContactGroup.mockResolvedValue({
      body: {
        contactGroups: [
          {
            contacts: [
              { contactID: "contact_missing", name: "Missing Person" },
              { contactID: "contact_cached", name: "Cached Person" },
            ],
          },
        ],
      },
    });
    mocks.prisma.xeroContactCache.findMany.mockResolvedValue([
      { contactId: "contact_cached" },
    ]);
    mocks.accountingApi.getContacts.mockResolvedValue({
      body: {
        contacts: [
          {
            contactID: "contact_missing",
            name: "Missing Person",
            firstName: "Missing",
            lastName: "Person",
            emailAddress: "missing@example.com",
            contactStatus: "ACTIVE",
          },
        ],
      },
    });

    const result = await refreshXeroContactGroupCache({
      repairMissingContactCache: true,
    });

    expect(result).toEqual([
      { id: "group_1", name: "Adults", contactCount: 2 },
    ]);
    expect(mocks.accountingApi.getContacts).toHaveBeenCalledWith(
      "tenant_1",
      undefined,
      undefined,
      undefined,
      ["contact_missing"]
    );
    expect(mocks.prisma.xeroContactCache.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { contactId: "contact_missing" },
        create: expect.objectContaining({
          contactId: "contact_missing",
          emailAddress: "missing@example.com",
        }),
        update: expect.objectContaining({
          contactId: "contact_missing",
          emailAddress: "missing@example.com",
        }),
      })
    );
    expect(mocks.prisma.xeroContactGroupMembershipCache.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          contactGroupId: "group_1",
          contactId: "contact_missing",
          contactName: "Missing Person",
        }),
        expect.objectContaining({
          contactGroupId: "group_1",
          contactId: "contact_cached",
          contactName: "Cached Person",
        }),
      ]),
      skipDuplicates: true,
    });
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
    expect(mocks.prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "xero.contact.synced_to_member",
        subjectMemberId: "member_1",
        entityType: "Member",
        entityId: "member_1",
        category: "xero",
        metadata: expect.objectContaining({
          xeroContactId: "contact_1",
          changedFields: expect.arrayContaining([
            "xeroContactLink",
            "phone",
            "streetAddress",
          ]),
        }),
      }),
    });
    expect(
      JSON.stringify(mocks.prisma.auditLog.create.mock.calls[0][0].data.metadata)
    ).not.toContain("1112222");

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

  it("selectively refreshes cached contact-group memberships from changed contacts", async () => {
    mocks.prisma.xeroSyncCursor.findUnique.mockResolvedValue({
      cursorDateTime: new Date("2026-04-14T10:00:00.000Z"),
      lastSuccessfulSyncAt: new Date("2026-04-14T10:05:00.000Z"),
      metadata: {},
    });
    mocks.accountingApi.getContacts.mockResolvedValue({
      body: {
        contacts: [
          {
            contactID: "contact_1",
            name: "Group Refresh Contact",
            emailAddress: "groups@example.com",
            contactGroups: [
              {
                contactGroupID: "group_existing",
                name: "Existing Group",
                status: "ACTIVE",
              },
              {
                contactGroupID: "group_new",
                name: "New Group",
                status: "ACTIVE",
              },
            ],
          },
        ],
      },
    });
    mocks.prisma.xeroContactGroupMembershipCache.findMany.mockResolvedValue([
      { contactGroupId: "group_old" },
      { contactGroupId: "group_existing" },
    ]);
    mocks.prisma.xeroContactGroupCache.findMany.mockResolvedValue([
      {
        contactGroupId: "group_existing",
        name: "Existing Group",
      },
    ]);
    mocks.prisma.member.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await syncContactsFromXero();

    expect(mocks.prisma.xeroContactGroupMembershipCache.deleteMany).toHaveBeenCalledWith({
      where: {
        contactId: "contact_1",
        contactGroupId: { in: ["group_old"] },
      },
    });
    expect(mocks.prisma.xeroContactGroupMembershipCache.updateMany).toHaveBeenCalledWith({
      where: {
        contactId: "contact_1",
        contactGroupId: { in: ["group_existing"] },
      },
      data: expect.objectContaining({
        contactName: "Group Refresh Contact",
      }),
    });
    expect(mocks.prisma.xeroContactGroupMembershipCache.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          contactGroupId: "group_new",
          contactId: "contact_1",
          contactName: "Group Refresh Contact",
        }),
      ],
      skipDuplicates: true,
    });
    expect(mocks.prisma.xeroContactGroupCache.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { contactGroupId: "group_existing" },
        update: expect.objectContaining({
          name: "Existing Group",
          status: "ACTIVE",
        }),
      })
    );
    expect(mocks.prisma.xeroContactGroupCache.updateMany).toHaveBeenCalledWith({
      where: {
        contactGroupId: { in: ["group_old"] },
        contactCount: { gt: 0 },
      },
      data: expect.objectContaining({
        contactCount: { decrement: 1 },
      }),
    });
    expect(mocks.prisma.xeroContactGroupCache.updateMany).toHaveBeenCalledWith({
      where: {
        contactGroupId: { in: ["group_new"] },
      },
      data: expect.objectContaining({
        contactCount: { increment: 1 },
      }),
    });
    expect(mocks.prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { timeout: 15000 }
    );
    expect(mocks.prisma.xeroSyncCursor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          resourceType: "CONTACT_GROUP_CACHE",
          scope: "default",
        }),
        update: expect.objectContaining({
          lastSuccessfulSyncAt: expect.any(Date),
        }),
      })
    );
  });

  it("repairs a linked Xero contact when first and last names are reversed", async () => {
    mocks.prisma.xeroSyncCursor.findUnique.mockResolvedValue({
      cursorDateTime: null,
      lastSuccessfulSyncAt: new Date("2026-04-14T10:05:00.000Z"),
      metadata: {},
    });
    mocks.accountingApi.getContacts.mockResolvedValue({
      body: {
        contacts: [
          {
            contactID: "contact_1",
            name: "TestLast, TestFirst",
            firstName: "TestLast",
            lastName: "TestFirst",
            emailAddress: "reversed-name@example.com",
          },
        ],
      },
    });
    mocks.accountingApi.updateContact.mockResolvedValue({
      body: { contacts: [{ contactID: "contact_1" }] },
    });
    mocks.prisma.member.findFirst.mockResolvedValueOnce({
      id: "member_1",
      firstName: "TestFirst",
      lastName: "TestLast",
      email: "reversed-name@example.com",
      active: true,
      xeroContactId: "contact_1",
      joinedDate: null,
      phoneNumber: null,
      streetAddressLine1: null,
      postalAddressLine1: null,
    });

    const report = await syncContactsFromXero();

    expect(report.skippedNameMismatch).toEqual([]);
    expect(report.updated).toEqual([
      {
        name: "TestFirst TestLast",
        memberId: "member_1",
        xeroContactId: "contact_1",
        changes: ["Xero contact name set to TestFirst TestLast"],
      },
    ]);
    expect(mocks.accountingApi.updateContact).toHaveBeenCalledWith(
      "tenant_1",
      "contact_1",
      {
        contacts: [
          expect.objectContaining({
            contactID: "contact_1",
            name: "TestFirst TestLast",
            firstName: "TestFirst",
            lastName: "TestLast",
          }),
        ],
      },
      "contact:contact_1:repair-name-order:payload-hash:v1"
    );
    expect(mocks.prisma.member.update).not.toHaveBeenCalled();
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_1",
      expect.objectContaining({
        xeroObjectType: "CONTACT",
        xeroObjectId: "contact_1",
      })
    );
  });

  it("does not auto-link a member when the email matches but the names differ", async () => {
    mocks.prisma.xeroSyncCursor.findUnique.mockResolvedValue({
      cursorDateTime: null,
      lastSuccessfulSyncAt: new Date("2026-04-14T10:05:00.000Z"),
      metadata: {},
    });
    mocks.accountingApi.getContacts.mockResolvedValue({
      body: {
        contacts: [
          {
            contactID: "contact_mismatch",
            name: "John Smith",
            firstName: "John",
            lastName: "Smith",
            emailAddress: "shared@example.com",
          },
        ],
      },
    });
    mocks.prisma.member.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "member_1",
        firstName: "Jane",
        lastName: "Doe",
        email: "shared@example.com",
        active: true,
        xeroContactId: null,
        joinedDate: null,
        phoneNumber: null,
        streetAddressLine1: null,
        postalAddressLine1: null,
      });

    const report = await syncContactsFromXero();

    expect(report.updated).toEqual([]);
    expect(report.skippedNameMismatch).toEqual([
      {
        memberId: "member_1",
        memberName: "Jane Doe",
        memberEmail: "shared@example.com",
        xeroContactId: "contact_mismatch",
        xeroContactName: "John Smith",
        xeroContactEmail: "shared@example.com",
        reasons: ["First name differs", "Last name differs"],
      },
    ]);
    expect(mocks.prisma.member.update).not.toHaveBeenCalled();
  });

  it("does not report a name mismatch for an email match that is already linked to another Xero contact", async () => {
    mocks.prisma.xeroSyncCursor.findUnique.mockResolvedValue({
      cursorDateTime: null,
      lastSuccessfulSyncAt: new Date("2026-04-14T10:05:00.000Z"),
      metadata: {},
    });
    mocks.accountingApi.getContacts.mockResolvedValue({
      body: {
        contacts: [
          {
            contactID: "contact_duplicate_email",
            name: "John Smith",
            firstName: "John",
            lastName: "Smith",
            emailAddress: "shared@example.com",
          },
        ],
      },
    });
    mocks.prisma.member.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "member_1",
        firstName: "Jane",
        lastName: "Doe",
        email: "shared@example.com",
        active: true,
        xeroContactId: "contact_current_link",
        joinedDate: null,
        phoneNumber: null,
        streetAddressLine1: null,
        postalAddressLine1: null,
      });

    const report = await syncContactsFromXero();

    expect(report.updated).toEqual([]);
    expect(report.skippedNameMismatch).toEqual([]);
    expect(report.skippedOther).toEqual([
      {
        name: "John Smith",
        xeroContactId: "contact_duplicate_email",
        reason:
          "Matching member Jane Doe is already linked to a different Xero contact",
      },
    ]);
    expect(mocks.prisma.member.update).not.toHaveBeenCalled();
  });

  it("does not backfill an already-linked member when the linked contact name differs", async () => {
    mocks.prisma.xeroSyncCursor.findUnique.mockResolvedValue({
      cursorDateTime: null,
      lastSuccessfulSyncAt: new Date("2026-04-14T10:05:00.000Z"),
      metadata: {},
    });
    mocks.accountingApi.getContacts.mockResolvedValue({
      body: {
        contacts: [
          {
            contactID: "contact_linked_mismatch",
            name: "John Smith",
            firstName: "John",
            lastName: "Smith",
            emailAddress: "linked@example.com",
            phones: [
              {
                phoneType: "MOBILE",
                phoneCountryCode: "64",
                phoneAreaCode: "27",
                phoneNumber: "1234567",
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
    });
    mocks.prisma.member.findFirst.mockResolvedValueOnce({
      id: "member_1",
      firstName: "Jane",
      lastName: "Doe",
      email: "linked@example.com",
      active: true,
      xeroContactId: "contact_linked_mismatch",
      joinedDate: null,
      phoneNumber: null,
      streetAddressLine1: null,
      postalAddressLine1: null,
    });

    const report = await syncContactsFromXero();

    expect(report.updated).toEqual([]);
    expect(report.skippedNameMismatch).toEqual([
      {
        memberId: "member_1",
        memberName: "Jane Doe",
        memberEmail: "linked@example.com",
        xeroContactId: "contact_linked_mismatch",
        xeroContactName: "John Smith",
        xeroContactEmail: "linked@example.com",
        reasons: ["First name differs", "Last name differs"],
      },
    ]);
    expect(mocks.prisma.member.update).not.toHaveBeenCalled();
  });

  it("finds potential Xero contacts even when accents or punctuation differ", async () => {
    mocks.prisma.member.findUnique.mockResolvedValue({
      id: "member_1",
      firstName: "José",
      lastName: "O'Connor-Smith",
      email: "jose@example.com",
    });
    mocks.accountingApi.getContacts
      .mockResolvedValueOnce({
        body: {
          contacts: [
            {
              contactID: "contact_1",
              name: "Jose O Connor Smith",
              emailAddress: "jose@example.com",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        body: {
          contacts: [
            {
              contactID: "contact_1",
              name: "Jose O Connor Smith",
              emailAddress: "jose@example.com",
            },
          ],
        },
      });

    const matches = await findPotentialXeroContactsForMember("member_1");

    expect(matches).toEqual([
      {
        contactId: "contact_1",
        name: "Jose O Connor Smith",
        email: "jose@example.com",
        isLinked: false,
        linkedMemberName: null,
        matchReasons: ["Exact email match", "Exact name match"],
        xeroLink: "https://xero.test/contacts/contact_1",
      },
    ]);
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
