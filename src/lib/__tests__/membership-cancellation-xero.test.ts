import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Contact } from "xero-node";

import {
  declareEnvironmentRole,
  expectEnvironmentRolePremise,
  undeclareEnvironmentRole,
} from "@/lib/__tests__/helpers/environment-role";

const mocks = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  environmentSafetySettingsFindUnique: vi.fn(),
  containmentFindUnique: vi.fn(),
  containmentUpsert: vi.fn(),
  memberSubscriptionFindUnique: vi.fn(),
  xeroObjectLinkFindFirst: vi.fn(),
  xeroObjectLinkCreateMany: vi.fn(),
  xeroSyncOperationUpdate: vi.fn(),
  xeroSyncOperationFindFirst: vi.fn(),
  callXeroApi: vi.fn(),
  getAuthenticatedXeroClient: vi.fn(),
  getResolvedAccountMapping: vi.fn(),
  refreshXeroContactCachesFromContact: vi.fn(),
  loadMembershipCancellationSettings: vi.fn(),
  getManagedGroupUniverse: vi.fn(),
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
  // #2392 (review NEW-1): the archive re-asks the unpaid-invoice question live,
  // immediately before it archives. Default: nothing owing.
  loadInvoiceBlockers: vi.fn(),
  // #2400: who else the subscription invoice still covers. Default: nobody, so
  // the leaver is the last one out and the invoice is credited in full.
  findOtherLiveMembersCovered: vi.fn(),
  // #2400 (review F3): the invoice a coverage claim says the subscription is
  // billed on, for a member who carries no `xeroInvoiceId` of their own.
  findSubscriptionInvoiceIdFromCoverage: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: mocks.memberFindUnique,
    },
    /*
      #3034/#3036: the cancellation credit note is the fifth credit-note creator
      and the one that does not go through `findOrCreateXeroContact`, so it asks
      which installation this is and proves the contact contained before raising
      anything. A MISSING `environmentSafetySettings` delegate is an UNREADABLE
      override, which resolves UNKNOWN whatever the declaration says — so without
      this the suite would test the refusal instead of the credit note. Declared
      inline because `vi.hoisted` runs above this file's imports.
    */
    environmentSafetySettings: {
      findUnique: mocks.environmentSafetySettingsFindUnique,
    },
    xeroSandboxContactContainment: {
      findUnique: mocks.containmentFindUnique,
      upsert: mocks.containmentUpsert,
    },
    memberSubscription: {
      findUnique: mocks.memberSubscriptionFindUnique,
    },
    xeroObjectLink: {
      findFirst: mocks.xeroObjectLinkFindFirst,
      createMany: mocks.xeroObjectLinkCreateMany,
    },
    xeroSyncOperation: {
      update: mocks.xeroSyncOperationUpdate,
      findFirst: mocks.xeroSyncOperationFindFirst,
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

vi.mock("@/lib/membership-cancellation-invoice-blockers", () => ({
  loadMembershipCancellationInvoiceBlockersByMemberId: mocks.loadInvoiceBlockers,
}));

vi.mock("@/lib/membership-cancellation-subscription-credit", () => ({
  findOtherLiveMembersCoveredBySubscriptionInvoice:
    mocks.findOtherLiveMembersCovered,
  findSubscriptionInvoiceIdFromCoverage:
    mocks.findSubscriptionInvoiceIdFromCoverage,
}));

vi.mock("@/lib/xero-member-grouping", () => ({
  getManagedGroupUniverse: mocks.getManagedGroupUniverse,
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
import { frozenTestNow } from "@/lib/__tests__/helpers/clock";
import { expectClubTimeZonePremise } from "@/lib/__tests__/helpers/club-time-zone";

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
    vi.unstubAllEnvs();
    /*
      This suite is about the cancellation flow, so it runs as the club's LIVE
      site — where INV-CONFIG-005 is a no-op and every assertion below is about
      unchanged behaviour. The copy and undeclared cases have their own block.
    */
    declareEnvironmentRole("production");
    mocks.environmentSafetySettingsFindUnique.mockResolvedValue(null);
    mocks.containmentFindUnique.mockResolvedValue(null);
    mocks.containmentUpsert.mockResolvedValue({});
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
    // Default: the cancellation credit note has already settled, so the contact
    // archive guard lets archiving proceed. Tests override this to exercise the
    // deferral path.
    mocks.xeroSyncOperationFindFirst.mockResolvedValue({ status: "SUCCEEDED" });
    mocks.failXeroSyncOperation.mockResolvedValue({});
    mocks.refreshXeroContactCachesFromContact.mockResolvedValue(undefined);
    mocks.loadInvoiceBlockers.mockImplementation(
      async (memberIds: readonly string[]) =>
        new Map(memberIds.map((memberId) => [memberId, []])),
    );
    mocks.findOtherLiveMembersCovered.mockResolvedValue([]);
    mocks.findSubscriptionInvoiceIdFromCoverage.mockResolvedValue(null);
    // #2400 (review F1): the per-invoice credit claim. Default: this run takes
    // it, which is what every pre-existing test assumes implicitly.
    mocks.xeroObjectLinkCreateMany.mockResolvedValue({ count: 1 });
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

  // #2834: this file used to date both documents by truncating the clock to its
  // UTC day, through a private `formatDate` clone of its own — which no search
  // for callers of the shared `xero-invoice-helpers` wrapper would have found.
  // For roughly the first half of every New Zealand day the UTC day is still
  // yesterday, and a credit note's date decides its GST period and, at 1 April,
  // its financial year. Both instants below are chosen so a wrong zone fails
  // them: 00:00 NZST, which any zone shallower than UTC+12 gets wrong, and 00:30
  // NZDT, which a fixed +12 zone with no daylight saving gets wrong.
  describe.each([
    {
      label: "NZST (UTC+12), the first instant of a club day",
      instant: new Date("2026-06-14T12:00:00.000Z"),
      utcDay: "2026-06-14",
      clubDay: "2026-06-15",
    },
    {
      label: "NZDT (UTC+13), 00:30 on a club day",
      instant: new Date("2026-01-14T11:30:00.000Z"),
      utcDay: "2026-01-14",
      clubDay: "2026-01-15",
    },
  ])("the cancellation credit note and its allocation — $label", ({
    instant,
    utcDay,
    clubDay,
  }) => {
    beforeEach(() => {
      // Say what actually happened before any date assertion can turn an
      // environment problem into what looks like the product bug.
      expectClubTimeZonePremise();
      // A fixture that drifted out of the divergence window would pass vacuously.
      expect(instant.toISOString().slice(0, 10)).toBe(utcDay);
      // The root freeze pins midday NZ, where both calendars agree — the one
      // window this defect does not live in.
      vi.setSystemTime(instant);
    });

    afterEach(() => {
      // Hand the clock back so the root `beforeEach` re-freezes the DEFAULT
      // instant for every test declared after this block: `ensureFrozenTestClock()`
      // returns early whenever anything is already mocking `Date`, so it never
      // overwrites — nor restores — a deliberate pin (docs/TESTING.md rule 4).
      vi.useRealTimers();
    });

    it("are both dated on the club's calendar day", async () => {
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
        body: { creditNotes: [{ creditNoteID: "cn_1", creditNoteNumber: "CN-1" }] },
      });
      mocks.createCreditNoteAllocation.mockResolvedValue({
        body: { allocations: [{ amount: 123.45 }] },
      });

      await expect(
        createXeroMembershipCancellationCreditNote({
          subscriptionId: "sub_1",
          requestId: "request_1",
          participantId: "participant_1",
          syncOperationId: "op_1",
        }),
      ).resolves.toBe("cn_1");

      const creditNote = mocks.createCreditNotes.mock.calls[0][1].creditNotes[0];
      expect(creditNote.date).toBe(clubDay);
      expect(creditNote.date).not.toBe(utcDay);

      const [, , allocationBody] = mocks.createCreditNoteAllocation.mock.calls[0];
      expect(allocationBody.allocations[0].date).toBe(clubDay);
      expect(allocationBody.allocations[0].date).not.toBe(utcDay);
    });
  });

  // The restore proof for the block above. Declared after it, so it runs after
  // it, and it fails the moment that `afterEach` stops handing the clock back —
  // which is all that keeps a scoped pin from silently re-dating every test
  // below to 14 January 2026. `frozenTestNow()` rather than the literal so the
  // rollover canary's `TEST_CLOCK_ISO` / `TEST_CLOCK_OFFSET_DAYS` runs agree.
  it("hands the default frozen clock back to every test declared after the pinned block", () => {
    expect(new Date().toISOString()).toBe(frozenTestNow().toISOString());
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

  // #2400: a family is billed with ONE invoice covering everyone in it, and the
  // credit note below is for that invoice's WHOLE remaining balance.
  describe("shared family invoices", () => {
    function unpaidFamilySubscription() {
      mocks.memberSubscriptionFindUnique.mockResolvedValue({
        id: "sub_1",
        memberId: "member_1",
        seasonYear: 2026,
        status: "UNPAID",
        xeroInvoiceId: "inv_family",
        xeroInvoiceNumber: "INV-0042",
        member: {
          id: "member_1",
          firstName: "Ada",
          lastName: "Smith",
          xeroContactId: "contact_1",
        },
      });
      mocks.getInvoice.mockResolvedValue({
        body: {
          invoices: [
            {
              invoiceID: "inv_family",
              invoiceNumber: "INV-0042",
              amountDue: 300,
              contact: { contactID: "contact_1" },
            },
          ],
        },
      });
      mocks.createCreditNotes.mockResolvedValue({
        body: { creditNotes: [{ creditNoteID: "cn_1", creditNoteNumber: "CN-1" }] },
      });
      mocks.createCreditNoteAllocation.mockResolvedValue({
        body: { allocations: [{ amount: 300 }] },
      });
    }

    it("credits the invoice's whole remaining balance when the leaver is the last member it covers", async () => {
      unpaidFamilySubscription();
      mocks.findOtherLiveMembersCovered.mockResolvedValue([]);

      await expect(
        createXeroMembershipCancellationCreditNote({
          subscriptionId: "sub_1",
          requestId: "request_1",
          participantId: "participant_1",
          syncOperationId: "op_1",
        }),
      ).resolves.toBe("cn_1");

      expect(mocks.findOtherLiveMembersCovered).toHaveBeenCalledWith({
        invoiceId: "inv_family",
        leavingMemberId: "member_1",
      });
      expect(
        mocks.createCreditNotes.mock.calls[0][1].creditNotes[0].lineItems[0]
          .unitAmount,
      ).toBe(300);
      expect(mocks.createCreditNoteAllocation).toHaveBeenCalledWith(
        "tenant_1",
        "cn_1",
        { allocations: [{ invoice: { invoiceID: "inv_family" }, amount: 300, date: expect.any(String) }] },
        undefined,
        expect.any(String),
      );
    });

    it("raises nothing at all while the invoice still covers a member who is staying", async () => {
      unpaidFamilySubscription();
      mocks.findOtherLiveMembersCovered.mockResolvedValue([
        { memberId: "member_2", name: "Bob Smith" },
      ]);

      await expect(
        createXeroMembershipCancellationCreditNote({
          subscriptionId: "sub_1",
          requestId: "request_1",
          participantId: "participant_1",
          syncOperationId: "op_1",
        }),
      ).resolves.toBeNull();

      expect(mocks.createCreditNotes).not.toHaveBeenCalled();
      expect(mocks.createCreditNoteAllocation).not.toHaveBeenCalled();
      // The whole answer is local, so the skip does not even authenticate.
      expect(mocks.getAuthenticatedXeroClient).not.toHaveBeenCalled();
      expect(mocks.getInvoice).not.toHaveBeenCalled();
      expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
        "op_1",
        expect.objectContaining({
          responsePayload: expect.objectContaining({
            skipped: true,
            reason: "shared_invoice_covers_remaining_members",
            invoiceId: "inv_family",
            sharedWith: [{ memberId: "member_2", name: "Bob Smith" }],
          }),
        }),
      );
    });

    // #2400 (review F1). The reviewer is told to approve a whole family in a
    // burst, each approval fires an unawaited outbox kick, and two drains
    // overlap: one runs member A's credit note while another runs member C's.
    // By then EVERY covered member carries `cancelledAt`, so both read
    // `sharedWith = []`, both read amountDue 300, and both would create a $300
    // credit note under different Xero idempotency keys. One allocation lands,
    // the other is rejected as an over-allocation, and $300 of unallocated
    // credit sits on the family's contact ready to be spent.
    it("raises nothing when a sibling's cancellation already owns the credit for this invoice", async () => {
      unpaidFamilySubscription();
      mocks.findOtherLiveMembersCovered.mockResolvedValue([]);
      // The sibling won the insert race, so this one's claim conflicts.
      mocks.xeroObjectLinkCreateMany.mockResolvedValue({ count: 0 });
      mocks.xeroObjectLinkFindFirst
        // The existing-credit-note lookup — keyed on THIS subscription, so a
        // racing sibling's credit note is invisible to it.
        .mockResolvedValueOnce(null)
        // The claim holder.
        .mockResolvedValueOnce({ metadata: { subscriptionId: "sub_sibling" } });

      await expect(
        createXeroMembershipCancellationCreditNote({
          subscriptionId: "sub_1",
          requestId: "request_1",
          participantId: "participant_1",
          syncOperationId: "op_1",
        }),
      ).resolves.toBeNull();

      // A lost claim runs NO side effect: no Xero call at all.
      expect(mocks.getAuthenticatedXeroClient).not.toHaveBeenCalled();
      expect(mocks.createCreditNotes).not.toHaveBeenCalled();
      expect(mocks.createCreditNoteAllocation).not.toHaveBeenCalled();
      expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
        "op_1",
        expect.objectContaining({
          responsePayload: expect.objectContaining({
            skipped: true,
            reason: "invoice_credit_claimed_by_other_cancellation",
            invoiceId: "inv_family",
            holderSubscriptionId: "sub_sibling",
          }),
        }),
      );
    });

    it("claims the invoice before it authenticates, keyed on the invoice and not the member", async () => {
      unpaidFamilySubscription();
      mocks.findOtherLiveMembersCovered.mockResolvedValue([]);

      await expect(
        createXeroMembershipCancellationCreditNote({
          subscriptionId: "sub_1",
          requestId: "request_1",
          participantId: "participant_1",
          syncOperationId: "op_1",
        }),
      ).resolves.toBe("cn_1");

      expect(mocks.xeroObjectLinkCreateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skipDuplicates: true,
          data: [
            expect.objectContaining({
              localId: "inv_family",
              xeroObjectId: "inv_family",
              role: "MEMBERSHIP_CANCELLATION_CREDIT_INVOICE_CLAIM",
            }),
          ],
        }),
      );
      expect(
        mocks.xeroObjectLinkCreateMany.mock.invocationCallOrder[0],
      ).toBeLessThan(mocks.getAuthenticatedXeroClient.mock.invocationCallOrder[0]);
    });

    it("lets the same subscription's own retry through, because the claim records who holds it", async () => {
      unpaidFamilySubscription();
      mocks.findOtherLiveMembersCovered.mockResolvedValue([]);
      mocks.xeroObjectLinkCreateMany.mockResolvedValue({ count: 0 });
      mocks.xeroObjectLinkFindFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ metadata: { subscriptionId: "sub_1" } });

      await expect(
        createXeroMembershipCancellationCreditNote({
          subscriptionId: "sub_1",
          requestId: "request_1",
          participantId: "participant_1",
          syncOperationId: "op_1",
        }),
      ).resolves.toBe("cn_1");
    });

    it("does not claim the invoice while other covered members are staying", async () => {
      unpaidFamilySubscription();
      mocks.findOtherLiveMembersCovered.mockResolvedValue([
        { memberId: "member_2", name: "Bob Smith" },
      ]);

      await createXeroMembershipCancellationCreditNote({
        subscriptionId: "sub_1",
        requestId: "request_1",
        participantId: "participant_1",
        syncOperationId: "op_1",
      });

      // Claiming here would fence the sibling who WILL legitimately credit it.
      expect(mocks.xeroObjectLinkCreateMany).not.toHaveBeenCalled();
    });

    // #2400 (review F3). Invoice covers A, B and C; C's subscription is PAID —
    // marked paid by hand, or already PAID when the invoice was raised, in which
    // case C carries no `xeroInvoiceId` at all and is covered only by the
    // charge's coverage claim. A skips (C live), B skips (C live), and C credits
    // nothing, so the invoice keeps its full balance forever having told the
    // reviewer the last cancellation would clear it.
    it("reports the invoice a whole-family cancellation is about to strand", async () => {
      mocks.memberSubscriptionFindUnique.mockResolvedValue({
        id: "sub_c",
        memberId: "member_3",
        seasonYear: 2026,
        status: "PAID",
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        member: {
          id: "member_3",
          firstName: "Cy",
          lastName: "Smith",
          xeroContactId: "contact_1",
        },
      });
      // No invoice link of their own — the coverage claim is the only record.
      mocks.findSubscriptionInvoiceIdFromCoverage.mockResolvedValue(
        "inv_family",
      );
      // A and B have already been cancelled, so nobody is left covered.
      mocks.findOtherLiveMembersCovered.mockResolvedValue([]);

      await expect(
        createXeroMembershipCancellationCreditNote({
          subscriptionId: "sub_c",
          requestId: "request_1",
          participantId: "participant_3",
          syncOperationId: "op_3",
        }),
      ).resolves.toBeNull();

      expect(mocks.sendAdminXeroSyncErrorAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          errorType: "membership_cancellation_shared_invoice_left_uncredited",
          errorMessage: expect.stringContaining("inv_family"),
        }),
      );
      expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
        "op_3",
        expect.objectContaining({
          responsePayload: expect.objectContaining({
            skipped: true,
            reason: "subscription_status_not_creditable",
            sharedInvoiceLeftUncredited: expect.objectContaining({
              invoiceId: "inv_family",
              lastCoveredMember: true,
            }),
          }),
          xeroObjectId: "inv_family",
        }),
      );
    });

    it("says nothing about a stranded invoice while somebody covered is still with the club", async () => {
      mocks.memberSubscriptionFindUnique.mockResolvedValue({
        id: "sub_c",
        memberId: "member_3",
        seasonYear: 2026,
        status: "PAID",
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        member: {
          id: "member_3",
          firstName: "Cy",
          lastName: "Smith",
          xeroContactId: "contact_1",
        },
      });
      mocks.findSubscriptionInvoiceIdFromCoverage.mockResolvedValue(
        "inv_family",
      );
      mocks.findOtherLiveMembersCovered.mockResolvedValue([
        { memberId: "member_1", name: "Ada Smith" },
      ]);

      await createXeroMembershipCancellationCreditNote({
        subscriptionId: "sub_c",
        requestId: "request_1",
        participantId: "participant_3",
        syncOperationId: "op_3",
      });

      expect(mocks.sendAdminXeroSyncErrorAlert).not.toHaveBeenCalled();
    });

    it("names the stranded invoice in the PAID-subscription alert too", async () => {
      mocks.memberSubscriptionFindUnique.mockResolvedValue({
        id: "sub_c",
        memberId: "member_3",
        seasonYear: 2026,
        status: "PAID",
        xeroInvoiceId: "inv_family",
        xeroInvoiceNumber: "INV-0042",
        member: {
          id: "member_3",
          firstName: "Cy",
          lastName: "Smith",
          xeroContactId: "contact_1",
        },
      });
      mocks.findOtherLiveMembersCovered.mockResolvedValue([]);

      await createXeroMembershipCancellationCreditNote({
        subscriptionId: "sub_c",
        requestId: "request_1",
        participantId: "participant_3",
        syncOperationId: "op_3",
      });

      expect(mocks.sendAdminXeroSyncErrorAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          errorType: "membership_cancellation_paid_subscription_no_refund",
          errorMessage: expect.stringContaining("INV-0042"),
        }),
      );
    });

    it("skips again on a re-run rather than drifting into a credit note", async () => {
      unpaidFamilySubscription();
      mocks.findOtherLiveMembersCovered.mockResolvedValue([
        { memberId: "member_2", name: "Bob Smith" },
      ]);

      for (const _run of [1, 2, 3]) {
        await expect(
          createXeroMembershipCancellationCreditNote({
            subscriptionId: "sub_1",
            requestId: "request_1",
            participantId: "participant_1",
            syncOperationId: "op_1",
          }),
        ).resolves.toBeNull();
      }

      expect(mocks.createCreditNotes).not.toHaveBeenCalled();
      expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
    });

    it("credits in full on the retry that follows the rest of the family being cancelled", async () => {
      unpaidFamilySubscription();
      mocks.findOtherLiveMembersCovered.mockResolvedValueOnce([
        { memberId: "member_2", name: "Bob Smith" },
      ]);

      await expect(
        createXeroMembershipCancellationCreditNote({
          subscriptionId: "sub_1",
          requestId: "request_1",
          participantId: "participant_1",
          syncOperationId: "op_1",
        }),
      ).resolves.toBeNull();

      // Bob has since been cancelled, so the same operation retried now finds
      // nobody left and credits the invoice in full.
      mocks.findOtherLiveMembersCovered.mockResolvedValue([]);

      await expect(
        createXeroMembershipCancellationCreditNote({
          subscriptionId: "sub_1",
          requestId: "request_1",
          participantId: "participant_1",
          syncOperationId: "op_1",
        }),
      ).resolves.toBe("cn_1");

      expect(mocks.createCreditNotes).toHaveBeenCalledTimes(1);
      expect(
        mocks.createCreditNotes.mock.calls[0][1].creditNotes[0].lineItems[0]
          .unitAmount,
      ).toBe(300);
    });

    it("finishes allocating a credit note that already exists, whoever the invoice now covers", async () => {
      unpaidFamilySubscription();
      // A previous run created the note; only the allocation is outstanding.
      mocks.xeroObjectLinkFindFirst
        .mockResolvedValueOnce({
          xeroObjectId: "cn_existing",
          xeroObjectNumber: "CN-9",
          xeroObjectUrl: "https://xero/cn_existing",
        })
        .mockResolvedValueOnce(null);
      mocks.findOtherLiveMembersCovered.mockResolvedValue([
        { memberId: "member_2", name: "Bob Smith" },
      ]);

      await expect(
        createXeroMembershipCancellationCreditNote({
          subscriptionId: "sub_1",
          requestId: "request_1",
          participantId: "participant_1",
          syncOperationId: "op_1",
        }),
      ).resolves.toBe("cn_existing");

      // The money is already credited in Xero — abandoning it unallocated would
      // be worse than finishing the job, so the shared check is not consulted.
      expect(mocks.findOtherLiveMembersCovered).not.toHaveBeenCalled();
      expect(mocks.createCreditNoteAllocation).toHaveBeenCalledWith(
        "tenant_1",
        "cn_existing",
        { allocations: [{ invoice: { invoiceID: "inv_family" }, amount: 300, date: expect.any(String) }] },
        undefined,
        expect.any(String),
      );
    });
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
    mocks.getManagedGroupUniverse.mockResolvedValue(["adult_group", "youth_group"]);
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

  it("defers archiving the Xero contact until the cancellation credit note has settled", async () => {
    // The credit note's outbox operation is still pending, so archiving now
    // would block it. The contact operation must fail (for retry) and leave the
    // contact untouched rather than archive prematurely.
    mocks.xeroSyncOperationFindFirst.mockResolvedValue({ status: "PENDING" });
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
    mocks.getManagedGroupUniverse.mockResolvedValue(["adult_group"]);
    mocks.getContact.mockResolvedValue({
      body: {
        contacts: [
          {
            contactID: "contact_1",
            contactStatus: Contact.ContactStatusEnum.ACTIVE,
            contactGroups: [{ contactGroupID: "adult_group", name: "Adults" }],
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
    ).rejects.toThrow(/credit note/i);

    // No contact mutation while deferring: no archive, no group changes.
    expect(mocks.updateContact).not.toHaveBeenCalled();
    expect(mocks.deleteContactGroupContact).not.toHaveBeenCalled();
    expect(mocks.createContactGroupContacts).not.toHaveBeenCalled();
    // Operation is failed so it is retried after the credit note posts.
    expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith(
      "op_1",
      expect.any(Error),
    );
  });

  // #2392 (review NEW-1): the approval-time gate cannot be the last word,
  // because this operation runs off the outbox later — a cancellation approved
  // while archiving was OFF (so no check ever ran) archives here the moment an
  // admin switches archiving on.
  describe("the archive re-checks the money before it runs", () => {
    function readyToArchive() {
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
        xeroContactGroups: [],
      });
      mocks.getManagedGroupUniverse.mockResolvedValue([]);
      mocks.getContact.mockResolvedValue({
        body: {
          contacts: [
            {
              contactID: "contact_1",
              contactStatus: Contact.ContactStatusEnum.ACTIVE,
              contactGroups: [],
            },
          ],
        },
      });
      mocks.updateContact.mockResolvedValue({ body: { contacts: [] } });
    }

    it("asks live, not from the review queue's memo", async () => {
      readyToArchive();

      await syncXeroMembershipCancellationContact({
        memberId: "member_1",
        requestId: "request_1",
        participantId: "participant_1",
        syncOperationId: "op_1",
      });

      expect(mocks.loadInvoiceBlockers).toHaveBeenCalledWith(["member_1"], {
        fresh: true,
      });
      expect(mocks.updateContact).toHaveBeenCalled();
    });

    it("defers the archive while the contact still has money owing", async () => {
      readyToArchive();
      mocks.loadInvoiceBlockers.mockResolvedValue(
        new Map([
          [
            "member_1",
            [
              {
                type: "unpaid_invoice",
                invoiceId: "inv-1",
                invoiceNumber: "INV-0042",
                invoiceStatus: "AUTHORISED",
                direction: "receivable",
                amountDueCents: 12050,
                currency: "NZD",
                dueDate: "2026-06-30",
                xeroUrl: null,
                xeroContactUrl: null,
              },
            ],
          ],
        ]),
      );

      await expect(
        syncXeroMembershipCancellationContact({
          memberId: "member_1",
          requestId: "request_1",
          participantId: "participant_1",
          syncOperationId: "op_1",
        }),
      ).rejects.toThrow(/INV-0042/);

      // Nothing is archived, and the operation is failed so it retries once the
      // invoice is paid, credited or voided — rather than being abandoned.
      expect(mocks.updateContact).not.toHaveBeenCalled();
      expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith(
        "op_1",
        expect.any(Error),
      );
    });

    it("defers the archive when the check itself could not run", async () => {
      readyToArchive();
      mocks.loadInvoiceBlockers.mockResolvedValue(
        new Map([
          [
            "member_1",
            [{ type: "invoice_check_unavailable", reason: "disconnected" }],
          ],
        ]),
      );

      await expect(
        syncXeroMembershipCancellationContact({
          memberId: "member_1",
          requestId: "request_1",
          participantId: "participant_1",
          syncOperationId: "op_1",
        }),
      ).rejects.toThrow(/Xero is not connected/);

      expect(mocks.updateContact).not.toHaveBeenCalled();
    });

    it("does not ask when this operation is not archiving anything", async () => {
      readyToArchive();
      mocks.loadMembershipCancellationSettings.mockResolvedValue({
        warningText: "",
        rejoinProcessText: "",
        xeroArchiveContactsOnCancellation: false,
        xeroContactGroups: [],
      });

      await syncXeroMembershipCancellationContact({
        memberId: "member_1",
        requestId: "request_1",
        participantId: "participant_1",
        syncOperationId: "op_1",
      });

      expect(mocks.loadInvoiceBlockers).not.toHaveBeenCalled();
      expect(mocks.updateContact).not.toHaveBeenCalled();
    });
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
    mocks.getManagedGroupUniverse.mockResolvedValue(["adult_group"]);
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

  /**
   * INV-CONFIG-005 (#3036 review P0-2). THE FIFTH CREDIT-NOTE CREATOR.
   *
   * The other four resolve their contact through `findOrCreateXeroContact`, which
   * contains it. This one takes its contact from the invoice it is crediting, so on
   * a copy restored from the club's live database it raised a credit note against a
   * contact nothing on this installation had ever proved contained — exactly what
   * this issue's acceptance criteria forbid.
   *
   * The exposure is not merely a consistency argument. The allocation is sized from
   * Xero's `amountDue` read a moment earlier; a concurrent partial payment, or an
   * allocation that fails after the credit note exists, leaves the invoice still
   * outstanding against that contact, and Xero emails its reminders to whatever
   * address the contact holds, from its own servers.
   */
  describe("the cancellation credit note on a copy (INV-CONFIG-005)", () => {
    function subscriptionFixture() {
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
    }

    beforeEach(() => {
      subscriptionFixture();
      mocks.memberFindUnique.mockResolvedValue({
        email: "alice@example.com",
        xeroContactId: "contact_1",
      });
    });

    it("contains the contact before the credit note is raised", async () => {
      declareEnvironmentRole("non-production");
      await expectEnvironmentRolePremise("NON_PRODUCTION");
      mocks.getContact.mockResolvedValue({
        body: {
          contacts: [
            { contactID: "contact_1", emailAddress: "alice@example.com" },
          ],
        },
      });
      mocks.updateContact.mockResolvedValue({ body: {} });

      await expect(
        createXeroMembershipCancellationCreditNote({
          subscriptionId: "sub_1",
          requestId: "request_1",
          participantId: "participant_1",
          createdByMemberId: "admin_1",
          syncOperationId: "op_1",
        }),
      ).resolves.toBe("cn_1");

      expect(mocks.updateContact).toHaveBeenCalledWith(
        "tenant_1",
        "contact_1",
        {
          contacts: [
            {
              contactID: "contact_1",
              emailAddress: expect.stringContaining("@xero-sandbox.invalid"),
            },
          ],
        },
        expect.any(String),
      );
      expect(mocks.containmentUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ rewroteAddress: true }),
        }),
      );
    });

    it("contains the INVOICE's contact, not the member's link, when they differ", async () => {
      /*
        The permissive defect this replaced. `contactId` on this path is
        `invoice.contact?.contactID ?? subscription.member.xeroContactId`, and
        that `??` exists because the two CAN differ: a member merge nulls the
        loser's link while the loser's invoices keep the loser's contact, and the
        admin re-link route writes a new link while existing invoices keep the old
        one. The first version of this check resolved the member's link, so it
        contained contact A and raised the credit note against contact B — which
        nothing had proved contained, and which Xero would remind a real member
        about if the allocation left the invoice outstanding.
      */
      declareEnvironmentRole("non-production");
      await expectEnvironmentRolePremise("NON_PRODUCTION");
      mocks.memberFindUnique.mockResolvedValue({
        email: "alice@example.com",
        xeroContactId: "contact_survivor",
      });
      mocks.getInvoice.mockResolvedValue({
        body: {
          invoices: [
            {
              invoiceID: "inv_sub_1",
              invoiceNumber: "INV-1",
              amountDue: 123.45,
              contact: { contactID: "contact_loser" },
            },
          ],
        },
      });
      mocks.getContact.mockResolvedValue({
        body: {
          contacts: [
            { contactID: "contact_loser", emailAddress: "alice@example.com" },
          ],
        },
      });
      mocks.updateContact.mockResolvedValue({ body: {} });

      await expect(
        createXeroMembershipCancellationCreditNote({
          subscriptionId: "sub_1",
          requestId: "request_1",
          participantId: "participant_1",
          createdByMemberId: "admin_1",
          syncOperationId: "op_1",
        }),
      ).resolves.toBe("cn_1");

      // The contact the credit note is raised against is the one contained.
      expect(mocks.getContact).toHaveBeenCalledWith("tenant_1", "contact_loser");
      expect(mocks.containmentUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { xeroContactId: "contact_loser" },
        }),
      );
      const creditNote = mocks.createCreditNotes.mock.calls[0][1].creditNotes[0];
      expect(creditNote.contact).toEqual({ contactID: "contact_loser" });
    });

    it("raises NO credit note when containment cannot be proved", async () => {
      declareEnvironmentRole("non-production");
      await expectEnvironmentRolePremise("NON_PRODUCTION");
      mocks.getContact.mockRejectedValue(new Error("503 from Xero"));

      await expect(
        createXeroMembershipCancellationCreditNote({
          subscriptionId: "sub_1",
          requestId: "request_1",
          participantId: "participant_1",
          createdByMemberId: "admin_1",
          syncOperationId: "op_1",
        }),
      ).rejects.toThrow(/cannot prove the contact is unable to reach a member/);
      expect(mocks.createCreditNotes).not.toHaveBeenCalled();
      expect(mocks.createCreditNoteAllocation).not.toHaveBeenCalled();
    });

    it("raises NO credit note on an installation that has declared nothing", async () => {
      undeclareEnvironmentRole();
      await expectEnvironmentRolePremise("UNKNOWN");

      await expect(
        createXeroMembershipCancellationCreditNote({
          subscriptionId: "sub_1",
          requestId: "request_1",
          participantId: "participant_1",
          createdByMemberId: "admin_1",
          syncOperationId: "op_1",
        }),
      ).rejects.toThrow(/APP_ENVIRONMENT_ROLE/);
      expect(mocks.createCreditNotes).not.toHaveBeenCalled();
    });

    it("changes nothing on the club's live site", async () => {
      declareEnvironmentRole("production");
      await expectEnvironmentRolePremise("PRODUCTION");

      await expect(
        createXeroMembershipCancellationCreditNote({
          subscriptionId: "sub_1",
          requestId: "request_1",
          participantId: "participant_1",
          createdByMemberId: "admin_1",
          syncOperationId: "op_1",
        }),
      ).resolves.toBe("cn_1");

      expect(mocks.updateContact).not.toHaveBeenCalled();
      expect(mocks.containmentFindUnique).not.toHaveBeenCalled();
      expect(mocks.containmentUpsert).not.toHaveBeenCalled();
    });
  });
});
