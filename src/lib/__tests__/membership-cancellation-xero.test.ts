import { beforeEach, describe, expect, it, vi } from "vitest";
import { Contact } from "xero-node";

const mocks = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  memberSubscriptionFindUnique: vi.fn(),
  xeroObjectLinkFindFirst: vi.fn(),
  xeroSyncOperationUpdate: vi.fn(),
  callXeroApi: vi.fn(),
  getAuthenticatedXeroClient: vi.fn(),
  getResolvedAccountMapping: vi.fn(),
  refreshXeroContactCachesFromContact: vi.fn(),
  loadMembershipCancellationSettings: vi.fn(),
  getAgeTierXeroContactGroupMappings: vi.fn(),
  buildXeroPayloadHash: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  upsertXeroObjectLink: vi.fn(),
  getInvoice: vi.fn(),
  createCreditNotes: vi.fn(),
  createCreditNoteAllocation: vi.fn(),
  getContact: vi.fn(),
  deleteContactGroupContact: vi.fn(),
  createContactGroupContacts: vi.fn(),
  updateContact: vi.fn(),
  sendAdminXeroSyncErrorAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: mocks.memberFindUnique,
    },
    memberSubscription: {
      findUnique: mocks.memberSubscriptionFindUnique,
    },
    xeroObjectLink: {
      findFirst: mocks.xeroObjectLinkFindFirst,
    },
    xeroSyncOperation: {
      update: mocks.xeroSyncOperationUpdate,
    },
  },
}));

vi.mock("@/lib/xero", () => ({
  callXeroApi: mocks.callXeroApi,
  getAuthenticatedXeroClient: mocks.getAuthenticatedXeroClient,
  getResolvedAccountMapping: mocks.getResolvedAccountMapping,
  refreshXeroContactCachesFromContact: mocks.refreshXeroContactCachesFromContact,
}));

vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: (...parts: Array<string | number | boolean | null | undefined>) =>
    parts
      .filter((part): part is string | number | boolean => part !== null && part !== undefined && part !== "")
      .map((part) => String(part))
      .join(":"),
  buildXeroPayloadHash: mocks.buildXeroPayloadHash,
  completeXeroSyncOperation: mocks.completeXeroSyncOperation,
  failXeroSyncOperation: mocks.failXeroSyncOperation,
  sanitizeForJson: (value: unknown) => value,
  startXeroSyncOperation: mocks.startXeroSyncOperation,
  upsertXeroObjectLink: mocks.upsertXeroObjectLink,
}));

vi.mock("@/lib/membership-cancellation-settings", () => ({
  loadMembershipCancellationSettings: mocks.loadMembershipCancellationSettings,
}));

vi.mock("@/lib/age-tier-xero-groups", () => ({
  getAgeTierXeroContactGroupMappings: mocks.getAgeTierXeroContactGroupMappings,
}));

vi.mock("@/lib/email", () => ({
  sendAdminXeroSyncErrorAlert: mocks.sendAdminXeroSyncErrorAlert,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  createXeroMembershipCancellationCreditNote,
  syncXeroMembershipCancellationContact,
} from "@/lib/membership-cancellation-xero";

function xeroClient() {
  return {
    accountingApi: {
      getInvoice: mocks.getInvoice,
      createCreditNotes: mocks.createCreditNotes,
      createCreditNoteAllocation: mocks.createCreditNoteAllocation,
      getContact: mocks.getContact,
      deleteContactGroupContact: mocks.deleteContactGroupContact,
      createContactGroupContacts: mocks.createContactGroupContacts,
      updateContact: mocks.updateContact,
    },
  };
}

describe("membership cancellation Xero operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.callXeroApi.mockImplementation(async (runner: () => unknown) => runner());
    mocks.getAuthenticatedXeroClient.mockResolvedValue({
      xero: xeroClient(),
      tenantId: "tenant_1",
    });
    mocks.getResolvedAccountMapping.mockResolvedValue({
      code: "206",
      itemCode: "CANCEL-CREDIT",
      codeExplicitlyConfigured: true,
    });
    mocks.buildXeroPayloadHash.mockReturnValue("payload_hash");
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "alloc_op_1" });
    mocks.completeXeroSyncOperation.mockResolvedValue({});
    mocks.upsertXeroObjectLink.mockResolvedValue({});
    mocks.xeroObjectLinkFindFirst.mockResolvedValue(null);
    mocks.xeroSyncOperationUpdate.mockResolvedValue({});
    mocks.refreshXeroContactCachesFromContact.mockResolvedValue(undefined);
  });

  it("creates and allocates a subscription cancellation credit note using the membership cancellation mapping", async () => {
    mocks.memberSubscriptionFindUnique.mockResolvedValue({
      id: "sub_1",
      memberId: "member_1",
      seasonYear: 2026,
      status: "UNPAID",
      xeroInvoiceId: "inv_sub_1",
      member: {
        id: "member_1",
        firstName: "Alice",
        lastName: "Smith",
        xeroContactId: "contact_1",
      },
    });
    mocks.getInvoice.mockResolvedValue({
      body: {
        invoices: [
          {
            invoiceID: "inv_sub_1",
            invoiceNumber: "INV-1",
            amountDue: 123.45,
            contact: { contactID: "contact_1" },
          },
        ],
      },
    });
    mocks.createCreditNotes.mockResolvedValue({
      body: {
        creditNotes: [{ creditNoteID: "cn_1", creditNoteNumber: "CN-1" }],
      },
    });
    mocks.createCreditNoteAllocation.mockResolvedValue({
      body: { allocations: [{ amount: 123.45 }] },
    });

    await expect(
      createXeroMembershipCancellationCreditNote({
        subscriptionId: "sub_1",
        requestId: "request_1",
        participantId: "participant_1",
        createdByMemberId: "admin_1",
        syncOperationId: "op_1",
      }),
    ).resolves.toBe("cn_1");

    const creditNoteRequest = mocks.createCreditNotes.mock.calls[0][1];
    const lineItem = creditNoteRequest.creditNotes[0].lineItems[0];
    expect(lineItem).toEqual(
      expect.objectContaining({
        accountCode: "206",
        itemCode: "CANCEL-CREDIT",
        quantity: 1,
        unitAmount: 123.45,
      }),
    );
    expect(mocks.createCreditNoteAllocation).toHaveBeenCalledWith(
      "tenant_1",
      "cn_1",
      {
        allocations: [
          {
            invoice: { invoiceID: "inv_sub_1" },
            amount: 123.45,
            date: expect.any(String),
          },
        ],
      },
      undefined,
      "credit-note:cn_1:membership-cancellation:invoice:inv_sub_1:12345:v1",
    );
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_1",
      expect.objectContaining({
        status: "SUCCEEDED",
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: "cn_1",
        extraLinks: expect.arrayContaining([
          expect.objectContaining({
            localModel: "MemberSubscription",
            localId: "sub_1",
            role: "MEMBERSHIP_CANCELLATION_CREDIT_NOTE",
          }),
          expect.objectContaining({
            localModel: "MembershipCancellationRequestParticipant",
            localId: "participant_1",
          }),
          expect.objectContaining({
            localModel: "MembershipCancellationRequest",
            localId: "request_1",
          }),
        ]),
      }),
    );
  });

  it("alerts admins instead of silently skipping when a paid subscription is cancelled", async () => {
    mocks.memberSubscriptionFindUnique.mockResolvedValue({
      id: "sub_1",
      memberId: "member_1",
      seasonYear: 2026,
      status: "PAID",
      xeroInvoiceId: "inv_sub_1",
      member: {
        id: "member_1",
        firstName: "Alice",
        lastName: "Smith",
        xeroContactId: "contact_1",
      },
    });

    await expect(
      createXeroMembershipCancellationCreditNote({
        subscriptionId: "sub_1",
        requestId: "request_1",
        participantId: "participant_1",
        syncOperationId: "op_1",
      }),
    ).resolves.toBeNull();

    expect(mocks.getAuthenticatedXeroClient).not.toHaveBeenCalled();
    expect(mocks.createCreditNotes).not.toHaveBeenCalled();
    expect(mocks.sendAdminXeroSyncErrorAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        errorType: "membership_cancellation_paid_subscription_no_refund",
        operation: "createXeroMembershipCancellationCreditNote",
      }),
    );
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_1",
      expect.objectContaining({
        responsePayload: expect.objectContaining({
          skipped: true,
          reason: "paid_subscription_no_refund",
          status: "PAID",
          adminAlertSent: true,
        }),
      }),
    );
  });

  it("removes managed age-tier groups, adds cancelled groups, and archives the Xero contact", async () => {
    mocks.memberFindUnique.mockResolvedValue({
      id: "member_1",
      firstName: "Alice",
      lastName: "Smith",
      ageTier: "ADULT",
      xeroContactId: "contact_1",
    });
    mocks.loadMembershipCancellationSettings.mockResolvedValue({
      warningText: "",
      rejoinProcessText: "",
      xeroArchiveContactsOnCancellation: true,
      xeroContactGroups: [{ groupId: "cancelled_group", groupName: "Cancelled" }],
    });
    mocks.getAgeTierXeroContactGroupMappings.mockResolvedValue([
      { tier: "ADULT", groupId: "adult_group", groupName: "Adults" },
      { tier: "YOUTH", groupId: "youth_group", groupName: "Youth" },
    ]);
    mocks.getContact
      .mockResolvedValueOnce({
        body: {
          contacts: [
            {
              contactID: "contact_1",
              contactStatus: Contact.ContactStatusEnum.ACTIVE,
              contactGroups: [
                { contactGroupID: "adult_group", name: "Adults" },
                { contactGroupID: "other_group", name: "Other" },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        body: {
          contacts: [
            {
              contactID: "contact_1",
              contactStatus: Contact.ContactStatusEnum.ARCHIVED,
              contactGroups: [{ contactGroupID: "cancelled_group", name: "Cancelled" }],
            },
          ],
        },
      });
    mocks.deleteContactGroupContact.mockResolvedValue({});
    mocks.createContactGroupContacts.mockResolvedValue({});
    mocks.updateContact.mockResolvedValue({ body: { contacts: [{ contactID: "contact_1" }] } });

    await expect(
      syncXeroMembershipCancellationContact({
        memberId: "member_1",
        requestId: "request_1",
        participantId: "participant_1",
        createdByMemberId: "admin_1",
        syncOperationId: "op_1",
      }),
    ).resolves.toEqual({
      memberId: "member_1",
      xeroContactId: "contact_1",
      addedGroupIds: ["cancelled_group"],
      removedGroupIds: ["adult_group"],
      archived: true,
      skippedReason: null,
    });

    expect(mocks.deleteContactGroupContact).toHaveBeenCalledWith(
      "tenant_1",
      "adult_group",
      "contact_1",
    );
    expect(mocks.createContactGroupContacts).toHaveBeenCalledWith(
      "tenant_1",
      "cancelled_group",
      { contacts: [{ contactID: "contact_1" }] },
      "contact:contact_1:cancelled-contact-group-add:cancelled_group:v1",
    );
    expect(mocks.updateContact).toHaveBeenCalledWith(
      "tenant_1",
      "contact_1",
      {
        contacts: [
          {
            contactID: "contact_1",
            contactStatus: Contact.ContactStatusEnum.ARCHIVED,
          },
        ],
      },
      "contact:contact_1:membership-cancellation-archive:participant_1:v1",
    );
  });

  it("is idempotent when cancellation contact groups and archive status are already applied", async () => {
    mocks.memberFindUnique.mockResolvedValue({
      id: "member_1",
      firstName: "Alice",
      lastName: "Smith",
      ageTier: "ADULT",
      xeroContactId: "contact_1",
    });
    mocks.loadMembershipCancellationSettings.mockResolvedValue({
      warningText: "",
      rejoinProcessText: "",
      xeroArchiveContactsOnCancellation: true,
      xeroContactGroups: [{ groupId: "cancelled_group", groupName: "Cancelled" }],
    });
    mocks.getAgeTierXeroContactGroupMappings.mockResolvedValue([
      { tier: "ADULT", groupId: "adult_group", groupName: "Adults" },
    ]);
    mocks.getContact.mockResolvedValue({
      body: {
        contacts: [
          {
            contactID: "contact_1",
            contactStatus: Contact.ContactStatusEnum.ARCHIVED,
            contactGroups: [{ contactGroupID: "cancelled_group", name: "Cancelled" }],
          },
        ],
      },
    });

    await expect(
      syncXeroMembershipCancellationContact({
        memberId: "member_1",
        requestId: "request_1",
        participantId: "participant_1",
        syncOperationId: "op_1",
      }),
    ).resolves.toEqual({
      memberId: "member_1",
      xeroContactId: "contact_1",
      addedGroupIds: [],
      removedGroupIds: [],
      archived: false,
      skippedReason: null,
    });

    expect(mocks.deleteContactGroupContact).not.toHaveBeenCalled();
    expect(mocks.createContactGroupContacts).not.toHaveBeenCalled();
    expect(mocks.updateContact).not.toHaveBeenCalled();
  });
});
