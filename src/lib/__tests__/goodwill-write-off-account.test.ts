/**
 * Goodwill posts to its own EXPENSE account, and to exactly where it used to
 * while that mapping is unset (#2717; owner decision, 10 Aug 2026). Goodwill
 * means an ADMIN ADJUSTMENT: credit a club chose to grant and was never owed.
 * A noteless lot that is a member's own refunded money is not goodwill and is
 * pinned here too, because "has it got a Xero note yet?" cannot tell them apart.
 *
 * These drive the REAL mapping resolver through the real credit-note builder —
 * only the Xero client, the ledger lock and the outbox are stubbed — so the
 * assertions are about the line that would actually reach Xero. Mocking
 * `xero-mappings` here would have made every one of them vacuous.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreditType } from "@prisma/client";
import type { CreditNote, LineItem } from "xero-node";

const h = vi.hoisted(() => {
  const mappingRows = new Map<
    string,
    { code: string | null; itemCode: string | null }
  >();

  const state = {
    /**
     * Positive credit lots the member holds. A lot's TYPE — not its lack of a
     * Xero note — is what decides where a minted slice of it posts (#2717).
     */
    lots: [] as Array<{
      id: string;
      memberId: string;
      amountCents: number;
      type: CreditType;
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
          type: l.type,
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

// File-level, so every describe below starts from an empty mapping table. A
// per-describe hook only covers its own block, and a mapping left behind by an
// earlier block would make an "unset" assertion test a configured club.
beforeEach(() => {
  vi.clearAllMocks();
  h.mappingRows.clear();
  h.state.lots = [];
  h.state.appliedCents = 0;
  retryWrite.mockReset();
});

/**
 * Run the engine over the given noteless credit lots and return the lines of
 * the credit note it would send to Xero.
 */
async function mintedLines(
  lots: Array<{ id: string; amountCents: number; type: CreditType }>,
): Promise<LineItem[]> {
  h.state.appliedCents = lots.reduce((sum, lot) => sum + lot.amountCents, 0);
  h.state.lots = lots.map((lot) => ({
    id: lot.id,
    memberId: "m1",
    amountCents: lot.amountCents,
    type: lot.type,
    xeroCreditNoteId: null,
  }));

  let sent: CreditNote | undefined;
  retryWrite.mockImplementation(async (options) => {
    // The engine hands us the payload builder it would hand the Xero write, so
    // this captures the note as it would actually be created. The options type
    // declares the payload `unknown`, hence the narrowing here.
    const payload = options.buildRequestPayload("contact-1") as {
      creditNotes: CreditNote[];
    };
    sent = payload.creditNotes[0];
    return {
      body: { creditNotes: [{ creditNoteID: "cn-new", creditNoteNumber: "CN-1" }] },
    };
  });

  await allocateAppliedCreditForBooking("b1");
  expect(sent).toBeDefined();
  const lines = sent!.lineItems ?? [];
  expect(lines.length).toBeGreaterThan(0);
  return lines;
}

/**
 * The single line minted for a member holding ONE goodwill lot — an ADMIN
 * ADJUSTMENT, which is what the owner's decision is about.
 */
async function mintedGoodwillLine(appliedCents = 3000): Promise<LineItem> {
  const lines = await mintedLines([
    { id: "c1", amountCents: appliedCents, type: CreditType.ADMIN_ADJUSTMENT },
  ]);
  expect(lines).toHaveLength(1);
  return lines[0];
}

describe("goodwill credit spent on a booking (#2717)", () => {
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

/**
 * #2717 blocker: the mint used to choose its account by asking whether a lot had
 * a Xero note YET, which is not the accounting question the owner answered.
 *
 * Restored cancellation credit (#1547) is the sharp case. It is the member's own
 * prepaid money coming back, it is written with no note, and NOTHING ever
 * backfills one — `backfillCancellationCreditXeroNote` matches three literal
 * descriptions and "Credit restored from cancelled booking …" is not among them.
 * Booked as goodwill it would show the club an expense it never incurred beside
 * revenue it did bill; net profit is unchanged, which is exactly why nobody
 * notices until a treasurer asks what the goodwill line is.
 */
describe("a noteless lot that is NOT goodwill stays on hutFeeRefunds (#2717)", () => {
  beforeEach(() => {
    // Goodwill IS configured throughout, so the only thing separating the two
    // destinations is the lot's credit type.
    h.mappingRows.set("hutFeeRefunds", { code: "200", itemCode: null });
    h.mappingRows.set("goodwillWriteOffs", { code: "404", itemCode: null });
  });

  it("posts restored cancellation credit to the refund account, not goodwill", async () => {
    const lines = await mintedLines([
      { id: "c1", amountCents: 3000, type: CreditType.CANCELLATION_REFUND },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].accountCode).toBe("200");
  });

  it("posts a downward-reprice refund to the refund account", async () => {
    const lines = await mintedLines([
      {
        id: "c1",
        amountCents: 3000,
        type: CreditType.BOOKING_MODIFICATION_REFUND,
      },
    ]);
    expect(lines[0].accountCode).toBe("200");
  });

  it("splits a mixed remainder across two lines on ONE note", async () => {
    const lines = await mintedLines([
      { id: "c1", amountCents: 2000, type: CreditType.CANCELLATION_REFUND },
      { id: "c2", amountCents: 1500, type: CreditType.ADMIN_ADJUSTMENT },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => [line.accountCode, line.unitAmount])).toEqual([
      ["200", 20],
      ["404", 15],
    ]);
    // One note, one allocation, the same total: only the coding is split.
    const total = lines.reduce((sum, line) => sum + (line.unitAmount ?? 0), 0);
    expect(total).toBe(35);
  });
});

describe("an unconfigured club's note is unchanged by the split (#2717)", () => {
  it("keeps a mixed remainder on ONE line while goodwill is unset", async () => {
    // Both shares resolve to the hut-fee-refund mapping verbatim, so they merge
    // back into the single line every existing club has always had. Anything
    // else would change an upgrading club's Xero note on the day it upgrades.
    h.mappingRows.set("hutFeeRefunds", { code: "202", itemCode: "REFUND-ITEM" });
    const lines = await mintedLines([
      { id: "c1", amountCents: 2000, type: CreditType.CANCELLATION_REFUND },
      { id: "c2", amountCents: 1500, type: CreditType.ADMIN_ADJUSTMENT },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].unitAmount).toBe(35);
    expect(lines[0].accountCode).toBe("202");
    expect(lines[0].itemCode).toBe("REFUND-ITEM");
  });
});

/**
 * The other half of the owner's decision: ordinary hut-fee refunds — money a
 * member actually paid, handed back — are NOT goodwill and stay where they are.
 *
 * This reads the writers from disk because the rule is about which mapping key
 * each one NAMES, which is a static fact no behavioural test states as plainly.
 * The regression it exists to catch is a later change routing every credit note
 * through the new mapping "for consistency", which would put real refunds into
 * an expense account and overstate both revenue and costs.
 */
describe("INV-INT-021 / INV-PAY-023: ordinary refunds stay on hutFeeRefunds", () => {
  const REFUND_WRITERS = [
    "src/lib/xero-credit-notes.ts",
    "src/lib/xero-modification-credit-notes.ts",
    "src/lib/xero-supplementary-invoices.ts",
  ];

  it.each(REFUND_WRITERS)("%s resolves hutFeeRefunds and never goodwill", async (file) => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(file), "utf-8");
    expect(
      source.includes('getResolvedAccountMapping("hutFeeRefunds")'),
      `${file} no longer resolves the hutFeeRefunds mapping (INV-PAY-023)`,
    ).toBe(true);
    expect(
      source.includes("goodwillWriteOffs"),
      `${file} is an ordinary refund writer and must not post to the goodwill ` +
        "expense mapping (INV-INT-021): a refund reduces what the club billed, " +
        "it is not a cost the club chose to bear",
    ).toBe(false);
  });
});
