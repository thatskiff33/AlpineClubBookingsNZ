import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreditType } from "@prisma/client";
import { CreditNote, LineAmountTypes } from "xero-node";

/**
 * #4431 (`INV-INT-037`): the worker stamps the one credit it was queued for.
 * The in-memory update honours only the `where` the worker sends, so deleting
 * the `xeroCreditNoteId: null` guard lets a second note id overwrite this row
 * and the mutation test below fails.
 */
const state = vi.hoisted(() => ({
  credits: new Map<string, {
    id: string;
    memberId: string;
    amountCents: number;
    type: string;
    description: string;
    xeroCreditNoteId: string | null;
  }>(),
  links: [] as Array<{ localId: string; xeroObjectId: string; role: string; active: boolean }>,
  operation: {
    id: "op-grant",
    idempotencyKey: "member-credit:credit_12345678:admin-grant-credit-note:2500:hutFeeRefunds:v1",
    createdByMemberId: "admin-approver",
    localId: "credit_12345678",
  },
}));

const mocks = vi.hoisted(() => ({
  findOrCreateXeroContact: vi.fn(async () => "contact-current"),
  createCreditNotes: vi.fn<
    (
      tenantId: string,
      body: {
        creditNotes: Array<{
          lineItems: Array<{ accountCode?: string; itemCode?: string; taxType?: string }>;
        }>;
      },
      summarizeErrors?: boolean,
      unitdp?: number,
      idempotencyKey?: string,
    ) => Promise<{ body: { creditNotes: Array<{ creditNoteID: string; creditNoteNumber: string }> } }>
  >(async () => ({
    body: { creditNotes: [{ creditNoteID: "cn-new", creditNoteNumber: "CN-9" }] },
  })),
  getResolvedAccountMappingWithFallback: vi.fn(async (): Promise<{
    code: string;
    itemCode: string | null;
    codeExplicitlyConfigured: boolean;
    sourceKey: string;
    usingFallback: boolean;
  }> => ({
    code: "610",
    itemCode: null,
    codeExplicitlyConfigured: true,
    sourceKey: "hutFeeRefunds",
    usingFallback: false,
  })),
  completeXeroSyncOperation: vi.fn(async () => ({ id: "op-grant" })),
  failXeroSyncOperation: vi.fn(async () => ({ id: "op-grant" })),
  repairPayloads: [] as unknown[],
  upsertXeroObjectLink: vi.fn(async (link: { localId: string; xeroObjectId: string; role: string }) => {
    const credit = state.credits.get(link.localId);
    if (credit?.xeroCreditNoteId !== link.xeroObjectId) {
      throw new Error("The link was written before the credit was stamped.");
    }
    state.links.push({ ...link, active: true });
  }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    memberCredit: {
      findUnique: async ({ where }: { where: { id: string } }) => state.credits.get(where.id) ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; type?: string; amountCents?: number; xeroCreditNoteId?: string | null };
        data: { xeroCreditNoteId: string };
      }) => {
        const row = state.credits.get(where.id);
        if (!row) return { count: 0 };
        if (where.type !== undefined && row.type !== where.type) return { count: 0 };
        if (where.amountCents !== undefined && row.amountCents !== where.amountCents) return { count: 0 };
        if ("xeroCreditNoteId" in where && row.xeroCreditNoteId !== where.xeroCreditNoteId) return { count: 0 };
        row.xeroCreditNoteId = data.xeroCreditNoteId;
        return { count: 1 };
      },
    },
    xeroSyncOperation: {
      findUnique: async () => state.operation,
    },
    xeroObjectLink: {
      findFirst: async ({ where }: { where: { localId: string; role: string; active: boolean } }) =>
        state.links.find(
          (link) => link.localId === where.localId && link.role === where.role && link.active === where.active,
        ) ?? null,
    },
  },
}));

vi.mock("@/lib/xero-contacts", () => ({
  findOrCreateXeroContact: mocks.findOrCreateXeroContact,
  retryXeroWriteWithContactRepair: async (input: {
    currentContactId: string;
    buildRequestPayload: (contactId: string) => unknown;
    run: (args: { contactId: string }) => Promise<unknown>;
  }) => {
    mocks.repairPayloads.push(input.buildRequestPayload("contact-repaired"));
    return input.run({ contactId: input.currentContactId });
  },
}));

vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: async () => ({
    xero: { accountingApi: { createCreditNotes: mocks.createCreditNotes } },
    tenantId: "tenant-1",
  }),
  callXeroApi: async (fn: () => Promise<unknown>) => fn(),
}));

vi.mock("@/lib/xero-mappings", () => ({
  getResolvedAccountMappingWithFallback: mocks.getResolvedAccountMappingWithFallback,
}));

vi.mock("@/lib/club-time-zone-runtime", () => ({
  readClubTimeZoneOutsideRequest: async () => "Pacific/Auckland",
}));

vi.mock("@/lib/xero-provider-dates", () => ({
  xeroDocumentDateForClubToday: (zone: string) => `date-for-${zone}`,
}));

vi.mock("@/lib/xero-sync", () => ({
  completeXeroSyncOperation: mocks.completeXeroSyncOperation,
  failXeroSyncOperation: mocks.failXeroSyncOperation,
  upsertXeroObjectLink: mocks.upsertXeroObjectLink,
}));

import { ADMIN_GRANT_CREDIT_NOTE_ROLE } from "@/lib/admin-grant-credit-note";
import { readAdminGrantCreditNotePayload } from "@/lib/admin-grant-credit-note-payload";
import { createAdminGrantCreditNote } from "@/lib/xero-admin-grant-credit-note";
import { xeroClaim } from "@/lib/__tests__/helpers/xero-claim";

const CREDIT_ID = "credit_12345678";

function seedCredit(overrides: Partial<{
  memberId: string;
  amountCents: number;
  type: string;
  description: string;
  xeroCreditNoteId: string | null;
}> = {}) {
  state.credits.set(CREDIT_ID, {
    id: CREDIT_ID,
    memberId: "member-current",
    amountCents: 2500,
    type: CreditType.ADMIN_ADJUSTMENT,
    description: "Double charge",
    xeroCreditNoteId: null,
    ...overrides,
  });
}

const payload = {
  queueType: "ADMIN_GRANT_CREDIT_NOTE" as const,
  amountCents: 2500,
  mappingKey: "hutFeeRefunds" as const,
  memberCreditId: CREDIT_ID,
};

describe("createAdminGrantCreditNote (#4431)", () => {
  beforeEach(() => {
    state.credits.clear();
    state.links.length = 0;
    state.operation = {
      id: "op-grant",
      idempotencyKey: "member-credit:credit_12345678:admin-grant-credit-note:2500:hutFeeRefunds:v1",
      createdByMemberId: "admin-approver",
      localId: CREDIT_ID,
    };
    vi.clearAllMocks();
    mocks.repairPayloads.length = 0;
    seedCredit();
  });

  it("raises one note for the credit's current member, stamps that row, then records the link", async () => {
    await createAdminGrantCreditNote({ syncOperation: xeroClaim("op-grant"), payload });

    expect(mocks.findOrCreateXeroContact).toHaveBeenCalledWith("member-current", {
      createdByMemberId: "admin-approver",
    });
    expect(mocks.getResolvedAccountMappingWithFallback).toHaveBeenCalledWith("hutFeeRefunds");
    expect(mocks.createCreditNotes).toHaveBeenCalledTimes(1);
    const [tenantId, body, summarizeErrors, unitdp, idempotencyKey] = mocks.createCreditNotes.mock.calls[0];
    expect(tenantId).toBe("tenant-1");
    expect(summarizeErrors).toBeUndefined();
    expect(unitdp).toBeUndefined();
    expect(idempotencyKey).toBe(state.operation.idempotencyKey);
    expect(body).toEqual({
      creditNotes: [{
        type: CreditNote.TypeEnum.ACCRECCREDIT,
        contact: { contactID: "contact-current" },
        date: "date-for-Pacific/Auckland",
        lineAmountTypes: LineAmountTypes.Inclusive,
        lineItems: [{
          description: "Account credit granted: Double charge",
          quantity: 1,
          unitAmount: 25,
          taxType: "OUTPUT2",
          accountCode: "610",
        }],
        reference: "Admin credit credit_1",
        status: CreditNote.StatusEnum.AUTHORISED,
      }],
    });
    expect(state.credits.get(CREDIT_ID)?.xeroCreditNoteId).toBe("cn-new");
    expect(mocks.upsertXeroObjectLink).toHaveBeenCalledWith(expect.objectContaining({
      localModel: "MemberCredit",
      localId: CREDIT_ID,
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: "cn-new",
      role: ADMIN_GRANT_CREDIT_NOTE_ROLE,
    }));
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      xeroClaim("op-grant"),
      expect.objectContaining({ xeroObjectId: "cn-new" }),
    );
    expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();

    mocks.createCreditNotes.mockClear();
    await createAdminGrantCreditNote({ syncOperation: xeroClaim("op-grant"), payload });
    expect(mocks.createCreditNotes).not.toHaveBeenCalled();
    expect(state.credits.get(CREDIT_ID)?.xeroCreditNoteId).toBe("cn-new");
  });

  it("keeps the queue fields on the payload a contact repair stores", async () => {
    await createAdminGrantCreditNote({ syncOperation: xeroClaim("op-grant"), payload });
    expect(readAdminGrantCreditNotePayload(mocks.repairPayloads[0])).toEqual(payload);
  });

  it("uses the mapping the payload names, including a Goodwill key whose account falls back", async () => {
    mocks.getResolvedAccountMappingWithFallback.mockResolvedValueOnce({
      code: "200",
      itemCode: "HUT",
      codeExplicitlyConfigured: false,
      sourceKey: "hutFeeRefunds",
      usingFallback: true,
    });
    await createAdminGrantCreditNote({
      syncOperation: xeroClaim("op-grant"),
      payload: { ...payload, mappingKey: "goodwillWriteOffs" },
    });
    expect(mocks.getResolvedAccountMappingWithFallback).toHaveBeenCalledWith("goodwillWriteOffs");
    const note = mocks.createCreditNotes.mock.calls[0][1].creditNotes[0];
    expect(note.lineItems[0]).toEqual(expect.objectContaining({ itemCode: "HUT", taxType: "OUTPUT2" }));
    expect(note.lineItems[0].accountCode).toBeUndefined();
  });

  it("fails a credit that is not a positive admin adjustment for the payload amount, before calling Xero", async () => {
    seedCredit({ type: CreditType.CANCELLATION_REFUND });
    await expect(
      createAdminGrantCreditNote({ syncOperation: xeroClaim("op-grant"), payload }),
    ).rejects.toThrow(/positive admin adjustment/);
    expect(mocks.createCreditNotes).not.toHaveBeenCalled();
    expect(mocks.completeXeroSyncOperation).not.toHaveBeenCalled();
    expect(state.credits.get(CREDIT_ID)?.xeroCreditNoteId).toBeNull();
  });

  it("MUTATION: a credit that already holds a different note id is not overwritten", async () => {
    seedCredit({ xeroCreditNoteId: "cn-existing" });
    await expect(
      createAdminGrantCreditNote({ syncOperation: xeroClaim("op-grant"), payload }),
    ).rejects.toThrow(/different Xero credit note/);
    expect(state.credits.get(CREDIT_ID)?.xeroCreditNoteId).toBe("cn-existing");
    expect(mocks.completeXeroSyncOperation).not.toHaveBeenCalled();
    expect(mocks.upsertXeroObjectLink).not.toHaveBeenCalled();
    expect(mocks.failXeroSyncOperation).toHaveBeenCalled();
  });

  it("a replay that already stamped this note id finishes the link without a second note", async () => {
    seedCredit({ xeroCreditNoteId: "cn-new" });
    await createAdminGrantCreditNote({ syncOperation: xeroClaim("op-grant"), payload });
    expect(mocks.createCreditNotes).toHaveBeenCalledTimes(1);
    expect(state.credits.get(CREDIT_ID)?.xeroCreditNoteId).toBe("cn-new");
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalled();
  });
});
