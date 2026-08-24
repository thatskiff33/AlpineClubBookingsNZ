import { beforeEach, describe, expect, it, vi } from "vitest";

// -----------------------------------------------------------------------------
// F7 (#1355): Xero API calls (OAuth refresh, searches, creates, and their
// up-to-120s retry sleeps) must run OUTSIDE the advisory-locked transaction.
// Pre-#1355 the whole resolution ran inside prisma.$transaction with the 5s
// interactive default: a slow Xero call aborted the transaction AFTER the
// external side effect (contact created in Xero, local link rolled back), and
// op-log writes on the global client recorded SUCCEEDED for rolled-back work.
// -----------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  txMemberFindUnique: vi.fn(),
  txMemberFindFirst: vi.fn(),
  txMemberUpdate: vi.fn(),
  txXeroOperationFindFirst: vi.fn(),
  // #2623 T7: the phase-2 link transaction closes any provider-created
  // recovery whose own contact is the one it just linked.
  txXeroOperationFindMany: vi.fn(),
  txXeroOperationUpdateMany: vi.fn(),
  txExecuteRaw: vi.fn(),
  txQueryRaw: vi.fn(),
  transaction: vi.fn(),
  getContacts: vi.fn(),
  createContacts: vi.fn(),
  getAuthenticatedXeroClient: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  upsertXeroObjectLink: vi.fn(),
  syncManagedXeroContactGroupForMember: vi.fn(),
  recordProviderCreatedContactPendingLocalLink: vi.fn(),
  environmentSafetySettingsFindUnique: vi.fn(),
  containmentFindUnique: vi.fn(),
  containmentUpsert: vi.fn(),
}));

vi.mock("@/lib/xero-contact-create-recovery", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/xero-contact-create-recovery")>();
  return {
    ...actual,
    recordProviderCreatedContactPendingLocalLink:
      mocks.recordProviderCreatedContactPendingLocalLink,
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: mocks.memberFindUnique,
    },
    $transaction: mocks.transaction,
    // #3034/#3036: the funnel asks which installation this is before it does
    // anything. A MISSING delegate is an UNREADABLE override, which resolves
    // UNKNOWN whatever the declaration says, and #3036 then refuses every Xero
    // write — so without this the suite would test the refusal path instead of
    // the transaction boundary it is about. Inline, because `vi.mock` factories
    // are hoisted above this file's imports.
    environmentSafetySettings: {
      findUnique: mocks.environmentSafetySettingsFindUnique,
    },
    xeroSandboxContactContainment: {
      findUnique: mocks.containmentFindUnique,
      upsert: mocks.containmentUpsert,
    },
  },
}));

vi.mock("@/lib/xero-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-sync")>();
  return {
    ...actual,
    buildXeroIdempotencyKey: vi.fn((...parts: unknown[]) => parts.join(":")),
    startXeroSyncOperation: mocks.startXeroSyncOperation,
    completeXeroSyncOperation: mocks.completeXeroSyncOperation,
    failXeroSyncOperation: mocks.failXeroSyncOperation,
    upsertXeroObjectLink: mocks.upsertXeroObjectLink,
  };
});

vi.mock("@/lib/xero-api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-api-client")>();
  return {
    ...actual,
    getAuthenticatedXeroClient: mocks.getAuthenticatedXeroClient,
    callXeroApi: vi.fn((fn: () => unknown) => fn()),
  };
});

vi.mock("@/lib/xero-contact-groups", () => ({
  syncManagedXeroContactGroupForMember:
    mocks.syncManagedXeroContactGroupForMember,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { findOrCreateXeroContact } from "@/lib/xero-contacts";
import {
  declareEnvironmentRole,
  expectEnvironmentRolePremise,
} from "@/lib/__tests__/helpers/environment-role";

const MEMBER = {
  id: "member-1",
  firstName: "Alice",
  lastName: "Example",
  email: "alice@example.org",
  phoneNumber: null,
  phoneCountryCode: null,
  phoneAreaCode: null,
  xeroContactId: null,
};

describe("findOrCreateXeroContact transaction boundary (#1355)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The club's LIVE site, where #3036's containment is a no-op — so this
    // suite still measures exactly the transaction boundary it always did.
    declareEnvironmentRole("production");
    mocks.environmentSafetySettingsFindUnique.mockResolvedValue(null);
    mocks.containmentFindUnique.mockResolvedValue(null);
    mocks.containmentUpsert.mockResolvedValue({});
    mocks.memberFindUnique.mockResolvedValue({ ...MEMBER });
    mocks.getAuthenticatedXeroClient.mockResolvedValue({
      xero: {
        accountingApi: {
          getContacts: mocks.getContacts,
          createContacts: mocks.createContacts,
        },
      },
      tenantId: "tenant-1",
    });
    mocks.getContacts.mockResolvedValue({ body: { contacts: [] } });
    mocks.createContacts.mockResolvedValue({
      body: { contacts: [{ contactID: "contact-new", name: "Alice Example" }] },
    });
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op-1" });
    mocks.completeXeroSyncOperation.mockResolvedValue(undefined);
    mocks.failXeroSyncOperation.mockResolvedValue(undefined);
    mocks.upsertXeroObjectLink.mockResolvedValue({ id: "link-1" });
    mocks.syncManagedXeroContactGroupForMember.mockResolvedValue(undefined);
    mocks.recordProviderCreatedContactPendingLocalLink.mockResolvedValue(undefined);
    mocks.txExecuteRaw.mockResolvedValue(1);
    mocks.txQueryRaw.mockImplementation(
      async (_strings: TemplateStringsArray, memberId: string) => [{ id: memberId }],
    );
    mocks.txMemberFindUnique.mockResolvedValue({
      ...MEMBER,
      passwordHash: null,
    });
    mocks.txMemberFindFirst.mockResolvedValue(null);
    mocks.txXeroOperationFindFirst.mockResolvedValue(null);
    mocks.txXeroOperationFindMany.mockResolvedValue([]);
    mocks.txXeroOperationUpdateMany.mockResolvedValue({ count: 0 });
    mocks.txMemberUpdate.mockResolvedValue({ id: "member-1" });
    mocks.transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          $executeRaw: mocks.txExecuteRaw,
          $queryRaw: mocks.txQueryRaw,
          member: {
            findUnique: mocks.txMemberFindUnique,
            findFirst: mocks.txMemberFindFirst,
            update: mocks.txMemberUpdate,
          },
          xeroSyncOperation: {
            findFirst: mocks.txXeroOperationFindFirst,
            findMany: mocks.txXeroOperationFindMany,
            updateMany: mocks.txXeroOperationUpdateMany,
          },
        })
    );
  });

  it("commits the reservation before create and keeps the provider outside both short transactions", async () => {
    await expectEnvironmentRolePremise("PRODUCTION");
    await expect(findOrCreateXeroContact("member-1")).resolves.toBe(
      "contact-new"
    );

    // The Xero search AND create both complete before prisma.$transaction is
    // ever entered — a slow provider call can no longer blow the 5s
    // interactive-transaction budget or roll back local state after the
    // external side effect.
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    const reservationTxOrder = mocks.transaction.mock.invocationCallOrder[0];
    const linkTxOrder = mocks.transaction.mock.invocationCallOrder[1];
    expect(mocks.getContacts.mock.invocationCallOrder[0]).toBeLessThan(
      reservationTxOrder,
    );
    expect(mocks.createContacts.mock.invocationCallOrder[0]).toBeGreaterThan(
      reservationTxOrder,
    );
    expect(mocks.createContacts.mock.invocationCallOrder[0]).toBeLessThan(
      linkTxOrder,
    );
    // The short transaction still takes the per-member advisory lock and
    // writes the link.
    expect(mocks.txExecuteRaw).toHaveBeenCalled();
    expect(mocks.txMemberUpdate).toHaveBeenCalledWith({
      where: { id: "member-1" },
      data: { xeroContactId: "contact-new" },
    });
    // Op-log completion is post-commit and references the committed contact.
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op-1",
      expect.objectContaining({ xeroObjectId: "contact-new" })
    );
    expect(
      mocks.completeXeroSyncOperation.mock.invocationCallOrder[0]
    ).toBeGreaterThan(linkTxOrder);
  });

  it("keeps first-writer-wins when a concurrent resolver linked while our Xero work ran", async () => {
    // The reservation re-read still sees no link. Phase 2 then sees the
    // DIFFERENT contact that won while provider work ran.
    // #2597: the reservation now builds the Xero contact payload from the
    // LOCKED row rather than a stale pre-lock read, so this re-read must carry
    // the full contact shape or payload validation fails before the boundary
    // this test is about.
    mocks.txMemberFindUnique
      .mockResolvedValueOnce({ ...MEMBER, passwordHash: null })
      .mockResolvedValueOnce({ xeroContactId: "contact-other" });

    await expect(findOrCreateXeroContact("member-1")).resolves.toBe(
      "contact-other"
    );

    // No overwrite of the winner's link.
    expect(mocks.txMemberUpdate).not.toHaveBeenCalled();
    // The operation is closed HONESTLY: the created contact exists in Xero
    // but was superseded locally — never recorded as a plain success with a
    // link it does not have.
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op-1",
      expect.objectContaining({
        responsePayload: expect.objectContaining({
          resolution: "superseded_by_concurrent_link",
          linkedContactId: "contact-other",
        }),
      })
    );
  });

  it("records the operation FAILED (never SUCCEEDED) when the local link fails after the Xero create", async () => {
    // Pre-#1355 this was the op-log lie: the tx aborted post-create, the
    // local link rolled back, and the op stayed SUCCEEDED.
    mocks.transaction
      .mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          $executeRaw: mocks.txExecuteRaw,
          $queryRaw: mocks.txQueryRaw,
          member: {
            findUnique: mocks.txMemberFindUnique,
            findFirst: mocks.txMemberFindFirst,
            update: mocks.txMemberUpdate,
          },
          xeroSyncOperation: {
            findFirst: mocks.txXeroOperationFindFirst,
            findMany: mocks.txXeroOperationFindMany,
            updateMany: mocks.txXeroOperationUpdateMany,
          },
        }),
      )
      .mockRejectedValueOnce(new Error("transaction aborted"));

    await expect(findOrCreateXeroContact("member-1")).rejects.toThrow(
      "transaction aborted"
    );

    expect(mocks.completeXeroSyncOperation).not.toHaveBeenCalled();
    expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith(
      "op-1",
      expect.objectContaining({ message: "transaction aborted" }),
      expect.objectContaining({
        phase: "local_link_after_xero_resolution",
        providerContactCreated: true,
      })
    );
  });

  it("records matched-existing local-link failures as not provider-created", async () => {
    mocks.getContacts
      .mockResolvedValueOnce({ body: { contacts: [] } })
      .mockResolvedValueOnce({
        body: {
          contacts: [
            { contactID: "contact-matched", name: "Alice Example" },
          ],
        },
      });
    mocks.createContacts.mockRejectedValue({
      response: { statusCode: 400 },
      message: JSON.stringify({
        body: {
          Message: "A validation exception occurred",
          Elements: [
            {
              ValidationErrors: [
                {
                  Message:
                    "The contact name Alice Example is already assigned to another contact. The contact name must be unique across all active contacts.",
                },
              ],
            },
          ],
        },
      }),
    });
    mocks.transaction
      .mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          $executeRaw: mocks.txExecuteRaw,
          $queryRaw: mocks.txQueryRaw,
          member: {
            findUnique: mocks.txMemberFindUnique,
            findFirst: mocks.txMemberFindFirst,
            update: mocks.txMemberUpdate,
          },
          xeroSyncOperation: {
            findFirst: mocks.txXeroOperationFindFirst,
            findMany: mocks.txXeroOperationFindMany,
            updateMany: mocks.txXeroOperationUpdateMany,
          },
        }),
      )
      .mockRejectedValueOnce(new Error("transaction aborted"));

    await expect(findOrCreateXeroContact("member-1")).rejects.toThrow(
      "transaction aborted"
    );

    expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith(
      "op-1",
      expect.objectContaining({ message: "transaction aborted" }),
      expect.objectContaining({
        phase: "local_link_after_xero_resolution",
        resolvedContactId: "contact-matched",
        providerContactCreated: false,
      })
    );
  });

  it("links an email match through the short transaction without creating anything", async () => {
    mocks.getContacts.mockResolvedValue({
      body: { contacts: [{ contactID: "contact-matched", name: "Alice Example" }] },
    });

    await expect(findOrCreateXeroContact("member-1")).resolves.toBe(
      "contact-matched"
    );

    expect(mocks.createContacts).not.toHaveBeenCalled();
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
    // linkMatchedXeroContact ran inside the tx: conflict check + link write.
    expect(mocks.txMemberFindFirst).toHaveBeenCalled();
    expect(mocks.txMemberUpdate).toHaveBeenCalledWith({
      where: { id: "member-1" },
      data: { xeroContactId: "contact-matched" },
    });
    expect(mocks.getContacts.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.transaction.mock.invocationCallOrder[0]
    );
  });

  it("rechecks the steady-state member under the row fence before refreshing its canonical link", async () => {
    mocks.memberFindUnique.mockResolvedValue({
      ...MEMBER,
      xeroContactId: "contact-existing",
    });
    mocks.txMemberFindUnique.mockResolvedValue({
      ...MEMBER,
      passwordHash: null,
      xeroContactId: "contact-existing",
    });

    await expect(findOrCreateXeroContact("member-1")).resolves.toBe(
      "contact-existing"
    );

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.getAuthenticatedXeroClient).not.toHaveBeenCalled();
    expect(mocks.upsertXeroObjectLink).toHaveBeenCalledWith(
      expect.objectContaining({ xeroObjectId: "contact-existing" }),
      expect.objectContaining({ store: expect.anything() }),
    );
  });
});
