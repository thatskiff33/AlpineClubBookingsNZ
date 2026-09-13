/**
 * Goodwill posts to its own EXPENSE account, and to exactly where it used to
 * while that mapping is unset (#2717; owner decision, 10 Aug 2026).
 *
 * These drive the REAL mapping resolver through the real credit-note builder —
 * only the Xero client, the ledger lock and the outbox are stubbed — so the
 * assertions are about the line that would actually reach Xero. Mocking
 * `xero-mappings` here would have made every one of them vacuous.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreditNote } from "xero-node";

const h = vi.hoisted(() => {
  const mappingRows = new Map<
    string,
    { code: string | null; itemCode: string | null }
  >();

  const state = {
    /** Positive credit lots the member holds; a null note id is a goodwill lot. */
    lots: [] as Array<{
      id: string;
      memberId: string;
      amountCents: number;
      xeroCreditNoteId: string | null;
    }>,
    appliedCents: 0,
  };

  const prismaStub = {
    xeroAccountMapping: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        mappingRows.get(where.key) ?? null,
    },
    booking: {
      findUnique: async () => ({
        id: "b1",
        memberId: "m1",
        payment: { id: "p1", xeroInvoiceId: "inv1" },
      }),
    },
    memberCredit: {
      aggregate: async () => ({ _sum: { amountCents: -state.appliedCents } }),
      findMany: async () =>
        state.lots.map((l) => ({
          id: l.id,
          amountCents: l.amountCents,
          xeroCreditNoteId: l.xeroCreditNoteId,
        })),
      updateMany: async () => ({ count: 1 }),
    },
    memberCreditNoteAllocation: {
      groupBy: async () => [],
      upsert: async () => ({ id: "jr1" }),
      findUnique: async () => null,
    },
    xeroObjectLink: {
      findFirst: async () => null,
    },
    $transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> =>
      cb(prismaStub),
  };

  return { state, mappingRows, prismaStub };
});

vi.mock("@/lib/prisma", () => ({ prisma: h.prismaStub }));
vi.mock("@/lib/member-credit", () => ({ lockMemberCreditLedger: vi.fn() }));
vi.mock("@/lib/xero-credit-notes", () => ({
  allocateCreditNoteToInvoice: vi.fn(),
}));
vi.mock("@/lib/xero-applied-credit-operation-serialization", () => ({
  assertNoAppliedCreditDeallocationFence: vi.fn(),
}));
vi.mock("@/lib/xero-sync", () => ({
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  startXeroSyncOperation: vi.fn(async () => ({ id: "op1" })),
  buildXeroIdempotencyKey: vi.fn(() => "idem-key"),
}));
vi.mock("@/lib/xero-api-client", () => ({
  callXeroApi: vi.fn(),
  getAuthenticatedXeroClient: vi.fn(async () => ({
    xero: { accountingApi: { createCreditNotes: vi.fn() } },
    tenantId: "tenant-1",
  })),
}));
vi.mock("@/lib/xero-contacts", () => ({
  findOrCreateXeroContact: vi.fn(async () => "contact-1"),
  retryXeroWriteWithContactRepair: vi.fn(),
}));
vi.mock("@/lib/club-time-zone-runtime", () => ({
  readClubTimeZoneOutsideRequest: vi.fn(async () => "Pacific/Auckland"),
}));

import { allocateAppliedCreditForBooking } from "@/lib/xero-applied-credit-allocation";
import { retryXeroWriteWithContactRepair } from "@/lib/xero-contacts";

const retryWrite = vi.mocked(retryXeroWriteWithContactRepair);

/**
 * Run the engine for a member holding ONE goodwill (noteless) credit lot and
 * return the credit-note line the engine would send to Xero.
 */
async function mintedGoodwillLine(appliedCents = 3000) {
  h.state.appliedCents = appliedCents;
  h.state.lots = [
    { id: "c1", memberId: "m1", amountCents: appliedCents, xeroCreditNoteId: null },
  ];

  let sent: CreditNote | undefined;
  retryWrite.mockImplementation(
    // The engine hands us the payload builder it would hand the Xero write, so
    // this captures the note as it would actually be created.
    async (params: {
      buildRequestPayload: (contactId: string) => { creditNotes: CreditNote[] };
    }) => {
      sent = params.buildRequestPayload("contact-1").creditNotes[0];
      return {
        body: { creditNotes: [{ creditNoteID: "cn-new", creditNoteNumber: "CN-1" }] },
      };
    },
  );

  await allocateAppliedCreditForBooking("b1");
  expect(sent).toBeDefined();
  const line = sent!.lineItems?.[0];
  expect(line).toBeDefined();
  return line!;
}

describe("goodwill credit applied to an Internet Banking booking (#2717)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.mappingRows.clear();
    retryWrite.mockReset();
  });

  it("posts to the club's chosen EXPENSE account once goodwillWriteOffs is set", async () => {
    h.mappingRows.set("hutFeeRefunds", { code: "200", itemCode: null });
    h.mappingRows.set("goodwillWriteOffs", { code: "404", itemCode: null });
    const line = await mintedGoodwillLine();
    expect(line.accountCode).toBe("404");
  });

  it("does not borrow the refund ITEM, which would re-route the line to the refund account", async () => {
    // A Xero Item carries its own account and wins over the line's account
    // code, so carrying the hut-fee-refund item onto a goodwill line would
    // quietly undo the split the club just configured.
    h.mappingRows.set("hutFeeRefunds", { code: "200", itemCode: "REFUND-ITEM" });
    h.mappingRows.set("goodwillWriteOffs", { code: "404", itemCode: null });
    const line = await mintedGoodwillLine();
    expect(line.itemCode).toBeUndefined();
    expect(line.accountCode).toBe("404");
  });

  describe("while goodwillWriteOffs is unset, the destination is unchanged", () => {
    it("uses the club's configured refund account", async () => {
      h.mappingRows.set("hutFeeRefunds", { code: "202", itemCode: null });
      const line = await mintedGoodwillLine();
      expect(line.accountCode).toBe("202");
    });

    it("carries the refund ITEM exactly as it did before", async () => {
      // No chosen code, but an item: the pre-#2717 rule leaves the default
      // "200" OFF the line so Xero takes the account from the item.
      h.mappingRows.set("hutFeeRefunds", { code: null, itemCode: "REFUND-ITEM" });
      const line = await mintedGoodwillLine();
      expect(line.itemCode).toBe("REFUND-ITEM");
      expect(line.accountCode).toBeUndefined();
    });

    it("keeps the account code on the line when the club configured 200 explicitly", async () => {
      h.mappingRows.set("hutFeeRefunds", { code: "200", itemCode: "REFUND-ITEM" });
      h.mappingRows.set("goodwillWriteOffs", { code: null, itemCode: null });
      const line = await mintedGoodwillLine();
      expect(line.accountCode).toBe("200");
    });

    it("uses the application default when no mapping row exists at all", async () => {
      const line = await mintedGoodwillLine();
      expect(line.accountCode).toBe("200");
      expect(line.itemCode).toBeUndefined();
    });
  });

  it("keeps the amount in integer cents, whichever account it posts to", async () => {
    h.mappingRows.set("goodwillWriteOffs", { code: "404", itemCode: null });
    const line = await mintedGoodwillLine(12345);
    expect(line.unitAmount).toBe(123.45);
    expect(line.quantity).toBe(1);
    expect(line.taxType).toBe("OUTPUT2");
  });
});
