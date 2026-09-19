import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst, findMany, updateMany } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn(),
}));

// #2939: the inbound patch's own transaction, for the two-homes refusal block
// at the foot of this file. Kept separate from the operation-only mock above so
// the existing suites are untouched by it.
const patchMocks = vi.hoisted(() => ({
  executeRaw: vi.fn(),
  memberFindUnique: vi.fn(),
  memberUpdate: vi.fn(),
  organisationFindFirst: vi.fn(),
  upsertXeroObjectLink: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroSyncOperation: { findFirst, findMany, updateMany },
    $transaction: patchMocks.transaction,
  },
}));
vi.mock("@/lib/xero-sync", () => ({
  completeXeroSyncOperation: vi.fn(),
  upsertXeroObjectLink: patchMocks.upsertXeroObjectLink,
}));

import { XeroContactTwoHomesError } from "@/lib/xero-contact-home";
import {
  applyInboundMemberContactPatch,
  ambiguousMemberContactCreateReservationWhere,
  assertNoMemberContactChangeBlockerForDeletion,
  assertNoMemberContactCreateBlockerForDeletion,
  closeProviderCreatedContactRecoveryForLinkedContact,
  findMemberContactChangeMergeBlocker,
  getMemberContactCreateRecoveryPending,
  getMemberContactCreateRecoveryState,
  hasMemberContactCreateMergeBlocker,
  hasMemberContactChangeMergeBlocker,
  hasUnresolvedMemberContactCreateRecovery,
  isProviderCreatedLocalLinkFailurePayload,
  lockMemberForManualXeroContactLink,
  memberContactCreateMergeBlockerWhere,
  memberContactChangeMergeBlockerWhere,
  recordProviderCreatedContactPendingLocalLink,
  unresolvedMemberContactCreateRecoveryWhere,
  XERO_CONTACT_CREATE_IN_PROGRESS_CODE,
  XERO_CONTACT_CREATE_IN_PROGRESS_MESSAGE,
  XERO_MEMBER_UNAVAILABLE_CODE,
} from "@/lib/xero-contact-create-recovery";

describe("unresolved member Xero contact-create recovery proof", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires the exact failed outbound create phase and unresolved operator state", () => {
    expect(unresolvedMemberContactCreateRecoveryWhere("member-1")).toEqual({
      direction: "OUTBOUND",
      entityType: "CONTACT",
      operationType: "CREATE",
      localModel: "Member",
      localId: "member-1",
      manuallyResolvedAt: null,
      OR: [
        {
          status: "FAILED",
          AND: [
            {
              responsePayload: {
                path: ["phase"],
                equals: "local_link_after_xero_resolution",
              },
            },
            {
              responsePayload: {
                path: ["providerContactCreated"],
                equals: true,
              },
            },
          ],
        },
        {
          status: { in: ["RUNNING", "FAILED"] },
          AND: [
            {
              responsePayload: {
                path: ["phase"],
                equals: "provider_contact_created_local_link_pending",
              },
            },
            {
              responsePayload: {
                path: ["providerContactCreated"],
                equals: true,
              },
            },
          ],
        },
      ],
    });
  });

  it("locks the target member before refusing a manual link against an ambiguous create", async () => {
    const executeRaw = vi.fn().mockResolvedValue(1);
    const memberFindUnique = vi.fn().mockResolvedValue({
      id: "member-1",
      email: "member@example.test",
      passwordHash: null,
      xeroContactId: null,
    });
    const operationFindFirst = vi.fn().mockResolvedValue({ id: "operation-1" });

    await expect(
      lockMemberForManualXeroContactLink(
        {
          $executeRaw: executeRaw,
          member: { findUnique: memberFindUnique } as never,
          xeroSyncOperation: { findFirst: operationFindFirst } as never,
        },
        "member-1",
      ),
    ).rejects.toMatchObject({
      code: XERO_CONTACT_CREATE_IN_PROGRESS_CODE,
      statusCode: 409,
      message: XERO_CONTACT_CREATE_IN_PROGRESS_MESSAGE,
    });
    expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      operationFindFirst.mock.invocationCallOrder[0],
    );
    expect(operationFindFirst).toHaveBeenCalledWith({
      where: ambiguousMemberContactCreateReservationWhere("member-1"),
      select: { id: true },
    });
  });

  it("refuses an anonymised member under the manual-link row lock before reading create operations", async () => {
    const executeRaw = vi.fn().mockResolvedValue(1);
    const memberFindUnique = vi.fn().mockResolvedValue({
      id: "member-1",
      email: "deleted-member@deleted.invalid",
      passwordHash: "DELETED_ACCOUNT",
      xeroContactId: null,
    });
    const operationFindFirst = vi.fn();

    await expect(
      lockMemberForManualXeroContactLink(
        {
          $executeRaw: executeRaw,
          member: { findUnique: memberFindUnique } as never,
          xeroSyncOperation: { findFirst: operationFindFirst } as never,
        },
        "member-1",
      ),
    ).rejects.toMatchObject({
      code: XERO_MEMBER_UNAVAILABLE_CODE,
      statusCode: 409,
    });
    expect(operationFindFirst).not.toHaveBeenCalled();
  });

  it.each([
    [
      "running",
      { id: "running", status: "RUNNING", lastErrorCode: null, responsePayload: null },
    ],
    [
      "stale orphaned",
      {
        id: "stale",
        status: "FAILED",
        lastErrorCode: "ORPHANED_STALE_RUNNING",
        responsePayload: null,
      },
    ],
    [
      "provider-created link pending",
      {
        id: "provider-created",
        status: "FAILED",
        lastErrorCode: null,
        responsePayload: {
          phase: "provider_contact_created_local_link_pending",
          providerContactCreated: true,
        },
      },
    ],
  ])("blocks deletion on the complete %s recovery proof", async (_label, operation) => {
    const operationFindFirst = vi.fn().mockResolvedValue(operation);

    await expect(
      assertNoMemberContactCreateBlockerForDeletion("member-1", {
        xeroSyncOperation: { findFirst: operationFindFirst } as never,
      }),
    ).rejects.toMatchObject({
      code: "XERO_CONTACT_CREATE_BLOCKS_DELETION",
      statusCode: 409,
    });
    expect(operationFindFirst).toHaveBeenCalledWith({
      where: memberContactCreateMergeBlockerWhere("member-1"),
      select: {
        id: true,
        status: true,
        lastErrorCode: true,
        responsePayload: true,
      },
    });
  });

  it("accepts actual provider creation and rejects matched-existing phases", () => {
    expect(
      isProviderCreatedLocalLinkFailurePayload({
        phase: "provider_contact_created_local_link_pending",
        providerContactCreated: true,
      }),
    ).toBe(true);
    expect(
      isProviderCreatedLocalLinkFailurePayload({
        phase: "local_link_after_xero_resolution",
        providerContactCreated: true,
      }),
    ).toBe(true);
    expect(
      isProviderCreatedLocalLinkFailurePayload({
        phase: "local_link_after_xero_resolution",
        providerContactCreated: false,
      }),
    ).toBe(false);
    expect(
      isProviderCreatedLocalLinkFailurePayload({
        phase: "local_link_after_xero_resolution",
      }),
    ).toBe(false);
  });

  it("blocks merge on the exact RUNNING reservation without claiming provider recovery", async () => {
    findFirst
      .mockResolvedValueOnce({ id: "operation-running", status: "RUNNING" })
      .mockResolvedValueOnce({
        id: "operation-running",
        responsePayload: null,
      });

    await expect(
      hasMemberContactCreateMergeBlocker("member-1"),
    ).resolves.toBe(true);
    await expect(
      hasUnresolvedMemberContactCreateRecovery("member-1"),
    ).resolves.toBe(false);
    expect(findFirst).toHaveBeenNthCalledWith(1, {
      where: memberContactCreateMergeBlockerWhere("member-1"),
      select: {
        id: true,
        status: true,
        lastErrorCode: true,
        responsePayload: true,
      },
    });
  });

  it("blocks merge and deletion on a RUNNING member CONTACT UPDATE only", async () => {
    findFirst.mockResolvedValueOnce({ id: "operation-update-running" });

    await expect(
      hasMemberContactChangeMergeBlocker("member-1"),
    ).resolves.toBe(true);
    // #2623 T7: the blocker read now also returns what the refusal has to name.
    expect(findFirst).toHaveBeenCalledWith({
      where: memberContactChangeMergeBlockerWhere("member-1"),
      select: {
        id: true,
        operationType: true,
        status: true,
        xeroObjectId: true,
        responsePayload: true,
      },
    });
    expect(memberContactChangeMergeBlockerWhere("member-1")).toEqual(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "CONTACT",
        localModel: "Member",
        localId: "member-1",
        OR: expect.arrayContaining([
          { operationType: "UPDATE", status: "RUNNING" },
        ]),
      }),
    );
  });

  it("keeps stale-reset pending-link proof unresolved and merge-blocking", async () => {
    const staleResetProof = {
      id: "operation-stale-reset",
      status: "FAILED",
      responsePayload: {
        phase: "provider_contact_created_local_link_pending",
        providerContactCreated: true,
        resolvedContactId: "contact-provider-only",
      },
    };
    findFirst
      .mockResolvedValueOnce(staleResetProof)
      .mockResolvedValueOnce(staleResetProof);

    await expect(
      hasUnresolvedMemberContactCreateRecovery("member-1"),
    ).resolves.toBe(true);
    await expect(
      hasMemberContactCreateMergeBlocker("member-1"),
    ).resolves.toBe(true);
    expect(unresolvedMemberContactCreateRecoveryWhere("member-1")).toEqual(
      expect.objectContaining({
        OR: expect.arrayContaining([
          expect.objectContaining({
            status: { in: ["RUNNING", "FAILED"] },
          }),
        ]),
      }),
    );
    expect(memberContactCreateMergeBlockerWhere("member-1")).toEqual(
      expect.objectContaining({
        OR: expect.arrayContaining([
          expect.objectContaining({
            status: "FAILED",
            OR: expect.arrayContaining([
              expect.objectContaining({
                AND: expect.arrayContaining([
                  expect.objectContaining({
                    responsePayload: {
                      path: ["phase"],
                      equals:
                        "provider_contact_created_local_link_pending",
                    },
                  }),
                ]),
              }),
            ]),
          }),
        ]),
      }),
    );
  });

  it("reports an unmarked RUNNING reservation without claiming provider creation", async () => {
    findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "operation-running" });

    await expect(
      getMemberContactCreateRecoveryState({
        memberId: "member-1",
        xeroContactId: null,
      }),
    ).resolves.toBe("CREATE_IN_PROGRESS");
  });

  it("keeps an unmarked stale-reset reservation ambiguous until resolution", async () => {
    findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "operation-stale-reset" })
      .mockResolvedValueOnce({
        id: "operation-stale-reset",
        status: "FAILED",
        lastErrorCode: "ORPHANED_STALE_RUNNING",
        responsePayload: null,
      });

    await expect(
      getMemberContactCreateRecoveryState({
        memberId: "member-1",
        xeroContactId: null,
      }),
    ).resolves.toBe("CREATE_IN_PROGRESS");
    expect(findFirst).toHaveBeenNthCalledWith(2, {
      where: ambiguousMemberContactCreateReservationWhere("member-1"),
      select: { id: true },
    });
    expect(ambiguousMemberContactCreateReservationWhere("member-1")).toEqual(
      expect.objectContaining({
        manuallyResolvedAt: null,
        OR: [
          { status: "RUNNING" },
          {
            status: "FAILED",
            lastErrorCode: "ORPHANED_STALE_RUNNING",
          },
        ],
      }),
    );
    await expect(
      hasMemberContactCreateMergeBlocker("member-1"),
    ).resolves.toBe(true);
  });

  it("retains the stronger state for stale-reset provider-created proof", async () => {
    findFirst.mockResolvedValueOnce({
      id: "operation-stale-reset",
      responsePayload: {
        phase: "provider_contact_created_local_link_pending",
        providerContactCreated: true,
      },
    });

    await expect(
      getMemberContactCreateRecoveryState({
        memberId: "member-1",
        xeroContactId: null,
      }),
    ).resolves.toBe("PROVIDER_CREATED_LINK_PENDING");
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it("persists provider-created proof while the operation remains active", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    await recordProviderCreatedContactPendingLocalLink({
      operationId: "operation-1",
      resolvedContactId: "contact-1",
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "operation-1",
        status: "RUNNING",
        manuallyResolvedAt: null,
      },
      data: {
        responsePayload: {
          phase: "provider_contact_created_local_link_pending",
          providerContactCreated: true,
          resolvedContactId: "contact-1",
        },
        xeroObjectType: "CONTACT",
        xeroObjectId: "contact-1",
      },
    });
  });

  it("reports pending only when the authoritative query finds a row", async () => {
    findFirst
      .mockResolvedValueOnce({
        id: "operation-1",
        responsePayload: {
          phase: "local_link_after_xero_resolution",
          providerContactCreated: true,
        },
      })
      .mockResolvedValueOnce({
        id: "operation-2",
        responsePayload: {
          phase: "local_link_after_xero_resolution",
          providerContactCreated: false,
        },
      })
      .mockResolvedValueOnce(null);

    await expect(
      hasUnresolvedMemberContactCreateRecovery("member-1"),
    ).resolves.toBe(true);
    await expect(
      hasUnresolvedMemberContactCreateRecovery("member-1"),
    ).resolves.toBe(false);
    await expect(
      hasUnresolvedMemberContactCreateRecovery("member-1"),
    ).resolves.toBe(false);
    expect(findFirst).toHaveBeenCalledWith({
      where: unresolvedMemberContactCreateRecoveryWhere("member-1"),
      select: { id: true, responsePayload: true },
    });
  });

  it("keeps the next authoritative member GET in recovery while the durable pre-link marker is active", async () => {
    findFirst.mockResolvedValue({
      id: "operation-running",
      responsePayload: {
        phase: "provider_contact_created_local_link_pending",
        providerContactCreated: true,
        resolvedContactId: "contact-provider-only",
      },
    });

    await expect(
      getMemberContactCreateRecoveryPending({
        memberId: "member-1",
        xeroContactId: null,
      }),
    ).resolves.toBe(true);
  });

  it("can run the strict proof lookup on an in-flight transaction client", async () => {
    const txFindFirst = vi.fn().mockResolvedValue({
      id: "operation-tx",
      responsePayload: {
        phase: "local_link_after_xero_resolution",
        providerContactCreated: true,
      },
    });

    await expect(
      hasUnresolvedMemberContactCreateRecovery("member-tx", {
        xeroSyncOperation: { findFirst: txFindFirst } as never,
      }),
    ).resolves.toBe(true);
    expect(txFindFirst).toHaveBeenCalledWith({
      where: unresolvedMemberContactCreateRecoveryWhere("member-tx"),
      select: { id: true, responsePayload: true },
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("returns false for a linked member without querying recovery operations", async () => {
    await expect(
      getMemberContactCreateRecoveryPending({
        memberId: "member-1",
        xeroContactId: "contact-1",
      }),
    ).resolves.toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
  });
});

/**
 * #2623 T7. `manuallyResolvedAt` used to be written in exactly one place in the
 * whole codebase — the explicit admin resolve action — and no link path ever
 * transitioned a failed CREATE to SUCCEEDED. A member who WAS successfully
 * linked after a provider-created/link-failed create therefore kept blocking
 * member merge and account deletion indefinitely, while their own detail page
 * reported a clean Xero state and said nothing about where the remedy lived.
 */
describe("closing a provider-created contact-create recovery on a successful link (#2623 T7)", () => {
  const providerCreatedRecovery = (resolvedContactId: string) => ({
    id: "operation-recovered",
    responsePayload: {
      phase: "provider_contact_created_local_link_pending",
      providerContactCreated: true,
      resolvedContactId,
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    updateMany.mockResolvedValue({ count: 1 });
  });

  it("closes the operation whose own contact is the one now linked", async () => {
    findMany.mockResolvedValue([providerCreatedRecovery("contact-provider")]);

    await expect(
      closeProviderCreatedContactRecoveryForLinkedContact(
        { xeroSyncOperation: { findMany, updateMany } as never },
        "member-1",
        "contact-provider",
      ),
    ).resolves.toEqual({
      operationIds: ["operation-recovered"],
      closedCount: 1,
    });

    // Only FAILED rows are ever read: a RUNNING reservation is live provider
    // work and must not be declared succeeded by a link path.
    expect(findMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "CONTACT",
        operationType: "CREATE",
        localModel: "Member",
        localId: "member-1",
        manuallyResolvedAt: null,
        status: "FAILED",
      }),
    );
    // Status-guarded claim: a concurrent admin resolve simply wins.
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["operation-recovered"] },
        status: "FAILED",
        manuallyResolvedAt: null,
      },
      data: expect.objectContaining({
        status: "SUCCEEDED",
        lastErrorCode: null,
        lastErrorMessage: null,
        xeroObjectType: "CONTACT",
        xeroObjectId: "contact-provider",
        responsePayload: {
          phase: "local_link_committed_after_provider_created_recovery",
          providerContactCreated: true,
          resolvedContactId: "contact-provider",
          linkedContactId: "contact-provider",
        },
      }),
    });
    // #2314: the stored URL stays organisation-agnostic.
    expect(updateMany.mock.calls[0][0].data.xeroObjectUrl).not.toContain(
      "shortcode",
    );
  });

  it("leaves a DIFFERENT provider contact open, because that is a real duplicate", async () => {
    findMany.mockResolvedValue([providerCreatedRecovery("contact-other")]);

    await expect(
      closeProviderCreatedContactRecoveryForLinkedContact(
        { xeroSyncOperation: { findMany, updateMany } as never },
        "member-1",
        "contact-provider",
      ),
    ).resolves.toEqual({ operationIds: [], closedCount: 0 });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("leaves a create with no proven provider contact open", async () => {
    findMany.mockResolvedValue([
      {
        id: "operation-unproven",
        responsePayload: {
          phase: "local_link_after_xero_resolution",
          providerContactCreated: false,
          resolvedContactId: "contact-provider",
        },
      },
      { id: "operation-bare", responsePayload: null },
    ]);

    await expect(
      closeProviderCreatedContactRecoveryForLinkedContact(
        { xeroSyncOperation: { findMany, updateMany } as never },
        "member-1",
        "contact-provider",
      ),
    ).resolves.toEqual({ operationIds: [], closedCount: 0 });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("is idempotent: a replay finds nothing left to close", async () => {
    findMany.mockResolvedValue([]);

    await expect(
      closeProviderCreatedContactRecoveryForLinkedContact(
        { xeroSyncOperation: { findMany, updateMany } as never },
        "member-1",
        "contact-provider",
      ),
    ).resolves.toEqual({ operationIds: [], closedCount: 0 });
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("the blocker refusal and the member display read one predicate (#2623 T7)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("names the exact operation and its provider contact", async () => {
    findFirst.mockResolvedValue({
      id: "operation-blocking",
      operationType: "CREATE",
      status: "FAILED",
      xeroObjectId: "contact-provider",
      responsePayload: {
        phase: "local_link_after_xero_resolution",
        providerContactCreated: true,
        resolvedContactId: "contact-provider",
      },
    });

    await expect(
      findMemberContactChangeMergeBlocker("member-1"),
    ).resolves.toEqual({
      operationId: "operation-blocking",
      operationType: "CREATE",
      status: "FAILED",
      providerContactId: "contact-provider",
    });
  });

  it("carries that operation id into the deletion refusal", async () => {
    findFirst.mockResolvedValue({
      id: "operation-blocking",
      operationType: "CREATE",
      status: "FAILED",
      xeroObjectId: null,
      responsePayload: null,
    });

    await expect(
      assertNoMemberContactChangeBlockerForDeletion("member-1", {
        xeroSyncOperation: { findFirst } as never,
      }),
    ).rejects.toMatchObject({
      code: "XERO_CONTACT_CREATE_BLOCKS_DELETION",
      statusCode: 409,
      operationId: "operation-blocking",
    });
  });

  /**
   * The disagreement this closes: the member detail display short-circuits to
   * "nothing to report" as soon as the member is LINKED, which is correct for
   * the create-in-flight question it answers but was the ONLY Xero signal on the
   * page. So a linked member with an open blocking operation looked clean while
   * merge and deletion refused them. The page now also reads the blocker itself.
   */
  it("still reports no create-recovery state for a linked member, while the blocker is visible", async () => {
    findFirst.mockResolvedValue({
      id: "operation-blocking",
      operationType: "CREATE",
      status: "FAILED",
      xeroObjectId: "contact-provider",
      responsePayload: null,
    });

    await expect(
      getMemberContactCreateRecoveryState({
        memberId: "member-1",
        xeroContactId: "contact-linked",
      }),
    ).resolves.toBeNull();
    await expect(
      hasMemberContactChangeMergeBlocker("member-1"),
    ).resolves.toBe(true);
    await expect(
      findMemberContactChangeMergeBlocker("member-1"),
    ).resolves.toMatchObject({ operationId: "operation-blocking" });
  });
});

describe("the inbound contact patch takes the two-homes refusal (#2939)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    patchMocks.executeRaw.mockResolvedValue(1);
    patchMocks.memberFindUnique.mockResolvedValue({
      id: "member-1",
      email: "teacher@example.com",
      passwordHash: "hash",
      xeroContactId: null,
      dateOfBirth: null,
      joinedDate: null,
      phoneNumber: null,
      streetAddressLine1: null,
      postalAddressLine1: null,
    });
    patchMocks.organisationFindFirst.mockResolvedValue(null);
    findMany.mockResolvedValue([]);
    patchMocks.transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          $executeRaw: patchMocks.executeRaw,
          member: {
            findUnique: patchMocks.memberFindUnique,
            update: patchMocks.memberUpdate,
          },
          organisation: { findFirst: patchMocks.organisationFindFirst },
          xeroSyncOperation: { findMany, updateMany },
        }),
    );
  });

  it("refuses to claim a contact an Organisation already holds", async () => {
    /*
      INV-INT-018, and the case that needs no race: a school's organisation
      contact carries the school's own address, which is routinely the address
      of the teacher the club corresponds with. An inbound contact sync finding
      that address on a member would have claimed the school's Xero customer for
      a person, which is exactly what #2912 settled must never happen.
    */
    patchMocks.organisationFindFirst.mockResolvedValue({
      id: "org-1",
      name: "Tokoroa Primary School",
    });

    await expect(
      applyInboundMemberContactPatch({
        memberId: "member-1",
        xeroContactId: "contact-1",
      }),
    ).rejects.toBeInstanceOf(XeroContactTwoHomesError);

    // Nothing was written: the refusal precedes the update, and it names the
    // holder rather than choosing between them.
    expect(patchMocks.memberUpdate).not.toHaveBeenCalled();
    expect(patchMocks.upsertXeroObjectLink).not.toHaveBeenCalled();
  });

  it("claims the link when no other record holds the contact", async () => {
    const result = await applyInboundMemberContactPatch({
      memberId: "member-1",
      xeroContactId: "contact-1",
    });

    expect(result.linked).toBe(true);
    expect(patchMocks.memberUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ xeroContactId: "contact-1" }),
      }),
    );
  });

  it("leaves a blank-field backfill onto the holder alone", async () => {
    /*
      The narrowness of the refusal, stated as behaviour. A member who already
      holds this contact is claiming nothing, so a second home — if one somehow
      exists — was made by another writer, and refusing an unrelated backfill
      would break a repair without unmaking it.
    */
    patchMocks.memberFindUnique.mockResolvedValue({
      id: "member-1",
      email: "teacher@example.com",
      passwordHash: "hash",
      xeroContactId: "contact-1",
      dateOfBirth: null,
      joinedDate: null,
      phoneNumber: null,
      streetAddressLine1: null,
      postalAddressLine1: null,
    });
    patchMocks.organisationFindFirst.mockResolvedValue({
      id: "org-1",
      name: "Tokoroa Primary School",
    });

    const result = await applyInboundMemberContactPatch({
      memberId: "member-1",
      xeroContactId: "contact-1",
      patch: { phoneNumber: "021000000" },
    });

    expect(result.linked).toBe(false);
    expect(result.appliedFields).toContain("phoneNumber");
  });
});
