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
import { describeExemptLineContract } from "./helpers/xero-exempt-line-contract";

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
      openingCreditBatchId: string | null;
    }>,
    appliedCents: 0,
    /** #4988: the club's stored tax category mappings (`XeroTaxCategoryMapping` rows). */
    taxCategoryRows: [] as Array<{ category: string; taxType: string; xeroTenantId: string }>,
    /** #4988: how often those rows were read, so "the resolver was not asked" is a fact. */
    taxCategoryReads: 0,
    /** #4988: mapping keys whose database read throws, as a dropped connection would. */
    failingMappingReads: new Set<string>(),
    /** #4988: the join row of a lot allocated from its own floating note; null when every lot is noteless. */
    floatingSlice: null as { id: string; amountCents: number } | null,
  };

  const prismaStub = {
    xeroAccountMapping: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        if (state.failingMappingReads.has(where.key)) throw new Error(`database read of ${where.key} failed`);
        return mappingRows.get(where.key) ?? null;
      },
    },
    booking: {
      findUnique: async () => ({
        id: "b1",
        memberId: "m1",
        payment: { id: "p1", xeroInvoiceId: "inv1" },
      }),
    },
    memberCredit: {
      // #3836: the engine's one batch predicate.
      // #4219's write-down read (by member and note) names no booking: nothing is written down here.
      groupBy: async ({ where }: { where: { appliedToBookingId?: { in: string[] } } }) =>
        (where.appliedToBookingId?.in ?? []).map((appliedToBookingId) => ({ appliedToBookingId, _sum: { amountCents: -state.appliedCents } })),
      findUnique: async () => null,
      aggregate: async () => ({ _sum: { amountCents: -state.appliedCents } }),
      // #4220: the one lot loader groups the rows it reads by member (the booking's, m1).
      findMany: async () =>
        state.lots.map((l) => ({
          id: l.id,
          memberId: "m1",
          amountCents: l.amountCents,
          type: l.type,
          xeroCreditNoteId: l.xeroCreditNoteId,
          openingCreditBatchId: l.openingCreditBatchId,
        })),
      updateMany: async () => ({ count: 1 }),
    },
    memberCreditNoteAllocation: {
      groupBy: async () => [],
      upsert: async () => ({ id: "jr1" }),
      // The committed slice of a lot that holds its own floating note, when a case has one.
      findUnique: async () => state.floatingSlice,
      // #4013: the committed slices a retry must keep; none here.
      findMany: async () => [],
    },
    xeroObjectLink: {
      findFirst: async () => null,
    },
    xeroTaxCategoryMapping: {
      findMany: async () => {
        state.taxCategoryReads += 1;
        return state.taxCategoryRows;
      },
    },
    // #4431: a mint asks whether a lot is waiting on its grant note. None here.
    xeroSyncOperation: {
      findMany: async () => [],
    },
    $transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> =>
      cb(prismaStub),
  };

  return { state, mappingRows, prismaStub, readXeroTaxRates: vi.fn() };
});

vi.mock("@/lib/xero-tax-anchors", () => import("./support/xero-tax-anchors-baseline"));
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
// #4988: the Exempt line's resolver is the real one; only what it reads from
// the connection and from Xero's tax rates is a double.
vi.mock("@/lib/xero-connection", () => ({
  readXeroConnection: async () => ({ tenantId: "tenant-1", expiresAt: new Date() }),
}));
vi.mock("@/lib/xero-tax-rates", () => ({ readXeroTaxRates: h.readXeroTaxRates }));

import { allocateAppliedCreditForBooking } from "@/lib/xero-applied-credit-allocation";
import { codeMintLine, mintLineItems } from "@/lib/xero-applied-credit-mint-accounts";
import { findOrCreateXeroContact, retryXeroWriteWithContactRepair } from "@/lib/xero-contacts";
import { allocateCreditNoteToInvoice } from "@/lib/xero-credit-notes";
import { XeroTaxCategoryUnavailableError } from "@/lib/xero-tax-categories";
import { BASELINE_XERO_TAX_RENDERING, xeroTaxRenderingOf } from "@/lib/xero-tax-rendering";
import { resolveXeroTaxRendering } from "./support/xero-tax-anchors-baseline";

const retryWrite = vi.mocked(retryXeroWriteWithContactRepair);

/** An active Xero tax rate, 0% unless told otherwise. */
const taxRate = (taxType: string, rateBasisPoints = 0) => ({
  taxType,
  name: taxType,
  rateBasisPoints,
  active: true,
  revenue: true,
  expenses: true,
});

/** #4988: map the club's Exempt category in the connected organisation, to a rate Xero carries at `rateBasisPoints`. */
function mapExempt(taxType: string, rateBasisPoints = 0) {
  h.state.taxCategoryRows = [{ category: "EXEMPT", taxType, xeroTenantId: "tenant-1" }];
  h.readXeroTaxRates.mockResolvedValue([taxRate(taxType, rateBasisPoints)]);
}

/** Every call that would reach the Xero provider: the contact lookup, the note create and an allocation. */
const providerWrites = () =>
  vi.mocked(findOrCreateXeroContact).mock.calls.length +
  retryWrite.mock.calls.length +
  vi.mocked(allocateCreditNoteToInvoice).mock.calls.length;

// File-level, so every describe below starts from an empty mapping table. A
// per-describe hook only covers its own block, and a mapping left behind by an
// earlier block would make an "unset" assertion test a configured club.
beforeEach(() => {
  vi.clearAllMocks();
  h.mappingRows.clear();
  h.state.lots = [];
  h.state.appliedCents = 0;
  h.state.taxCategoryRows = [];
  h.state.taxCategoryReads = 0;
  h.state.floatingSlice = null;
  h.state.failingMappingReads.clear();
  h.readXeroTaxRates.mockReset();
  h.readXeroTaxRates.mockResolvedValue([]);
  resolveXeroTaxRendering.mockResolvedValue(BASELINE_XERO_TAX_RENDERING);
  retryWrite.mockReset();
});

type TestLot = {
  id: string;
  amountCents: number;
  type: CreditType;
  openingCreditBatchId?: string;
  /** A lot that already holds its own floating Xero note is allocated, not minted. */
  xeroCreditNoteId?: string;
};

/**
 * Run the engine over the given credit lots and return the credit note it
 * would send to Xero for the noteless ones.
 */
async function mintedNote(lots: TestLot[]): Promise<CreditNote> {
  h.state.appliedCents = lots.reduce((sum, lot) => sum + lot.amountCents, 0);
  h.state.lots = lots.map((lot) => ({
    id: lot.id,
    memberId: "m1",
    amountCents: lot.amountCents,
    type: lot.type,
    xeroCreditNoteId: lot.xeroCreditNoteId ?? null,
    openingCreditBatchId: lot.openingCreditBatchId ?? null,
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
  return sent!;
}

/** The lines of that note. */
async function mintedLines(lots: TestLot[]): Promise<LineItem[]> {
  const lines = (await mintedNote(lots)).lineItems ?? [];
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
 * backfills one — `stampCancellationCreditXeroNote` stamps the credit a note names,
 * else three literal descriptions, and "Credit restored from cancelled booking …" is neither.
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

  it("posts a spent opening credit to the refund account, though it is an ADMIN_ADJUSTMENT (#4988)", async () => {
    // An opening credit is money the member already held in the club's old
    // system (INV-PAY-162), not a grant the club chose to give.
    const lines = await mintedLines([
      {
        id: "c1",
        amountCents: 3000,
        type: CreditType.ADMIN_ADJUSTMENT,
        openingCreditBatchId: "batch-1",
      },
    ]);
    expect(lines).toHaveLength(1);
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

/**
 * The owner's 16 Nov 2026 decision on #4988: spent opening credit posts to the
 * optional `openingCredits` mapping (a club's member-credits-held liability,
 * say), and to exactly where it posted before while that mapping is unset.
 */
describe("opening credit spent on a booking (#4988, INV-PAY-162)", () => {
  const openingLot = {
    id: "c1",
    amountCents: 3000,
    type: CreditType.ADMIN_ADJUSTMENT,
    openingCreditBatchId: "batch-1",
  };

  it("posts to the club's chosen opening-credits account once it is set", async () => {
    h.mappingRows.set("hutFeeRefunds", { code: "200", itemCode: "REFUND-ITEM" });
    h.mappingRows.set("goodwillWriteOffs", { code: "404", itemCode: null });
    h.mappingRows.set("openingCredits", { code: "2100", itemCode: null });
    // A registered club maps Exempt before it maps the account (17 Nov 2026).
    mapExempt("EXEMPTCODE");
    const lines = await mintedLines([openingLot]);
    expect(lines).toHaveLength(1);
    expect(lines[0].accountCode).toBe("2100");
    // The refund ITEM would carry its own account and undo the choice.
    expect(lines[0].itemCode).toBeUndefined();
    expect(lines[0].unitAmount).toBe(30);
  });

  it("while unset, codes the line exactly as the refund account, item and all", async () => {
    h.mappingRows.set("hutFeeRefunds", { code: null, itemCode: "REFUND-ITEM" });
    h.mappingRows.set("openingCredits", { code: null, itemCode: null });
    const lines = await mintedLines([openingLot]);
    expect(lines).toHaveLength(1);
    expect(lines[0].itemCode).toBe("REFUND-ITEM");
    expect(lines[0].accountCode).toBeUndefined();
  });

  it("while unset, merges with the refund share into the one line clubs had before", async () => {
    h.mappingRows.set("hutFeeRefunds", { code: "202", itemCode: null });
    const lines = await mintedLines([
      openingLot,
      { id: "c2", amountCents: 1500, type: CreditType.CANCELLATION_REFUND },
    ]);
    expect(lines.map((line) => [line.accountCode, line.unitAmount])).toEqual([["202", 45]]);
  });

  it("leaves every other credit kind where it was once the mapping is set", async () => {
    h.mappingRows.set("hutFeeRefunds", { code: "200", itemCode: null });
    h.mappingRows.set("goodwillWriteOffs", { code: "404", itemCode: null });
    h.mappingRows.set("openingCredits", { code: "2100", itemCode: null });
    mapExempt("EXEMPTCODE");
    const lines = await mintedLines([
      { id: "c1", amountCents: 1000, type: CreditType.CANCELLATION_REFUND },
      { id: "c2", amountCents: 700, type: CreditType.BOOKING_MODIFICATION_REFUND },
      { id: "c3", amountCents: 500, type: CreditType.BOOKING_APPLIED },
      { id: "c4", amountCents: 300, type: CreditType.ADMIN_ADJUSTMENT },
      { id: "c5", amountCents: 3000, type: CreditType.ADMIN_ADJUSTMENT, openingCreditBatchId: "batch-1" },
    ]);
    // One note, one line per destination, in the fixed order; integer cents.
    expect(lines.map((line) => [line.accountCode, line.unitAmount])).toEqual([
      ["200", 22],
      ["2100", 30],
      ["404", 3],
    ]);
  });
});

/**
 * The owner's 17 Nov 2026 decisions on #4988: the spent opening credit coded to
 * the mapped Opening Credits liability account carries the club's Exempt tax
 * category, mapped to one of its own Xero rates (#5209). Only that line, and
 * only while the account is mapped: every other line, and every line of a club
 * that leaves the account unset, is taxed as it was.
 */
describe("the spent opening credit's tax (#4988, INV-PAY-162)", () => {
  const openingLot: TestLot = {
    id: "c1",
    amountCents: 3000,
    type: CreditType.ADMIN_ADJUSTMENT,
    openingCreditBatchId: "batch-1",
  };

  it("MUTATION: carries the Exempt category's mapped Xero rate on the Opening Credits line, and only there", async () => {
    h.mappingRows.set("hutFeeRefunds", { code: "200", itemCode: null });
    h.mappingRows.set("goodwillWriteOffs", { code: "404", itemCode: null });
    h.mappingRows.set("openingCredits", { code: "2100", itemCode: null });
    mapExempt("EXEMPTCODE");
    const lines = await mintedLines([
      { id: "c0", amountCents: 1000, type: CreditType.CANCELLATION_REFUND },
      openingLot,
      { id: "c2", amountCents: 300, type: CreditType.ADMIN_ADJUSTMENT },
    ]);
    expect(lines.map((line) => [line.accountCode, line.unitAmount, line.taxType])).toEqual([
      ["200", 10, "OUTPUT2"],
      ["2100", 30, "EXEMPTCODE"],
      ["404", 3, "OUTPUT2"],
    ]);
  });

  it("MUTATION: with Opening Credits unmapped the note is byte-identical to the one sent before the Exempt line existed", async () => {
    // Captured from this same case run against the code before the Exempt line
    // (merge commit 979a74bdc7): never regenerated from the code under test.
    const BEFORE_EXEMPT_LINE =
      '{"type":"ACCRECCREDIT","contact":{"contactID":"contact-1"},"date":"2026-07-01","lineAmountTypes":"Inclusive",' +
      '"lineItems":[{"description":"Account credit applied to booking b1","quantity":1,"unitAmount":45,"taxType":"OUTPUT2","itemCode":"REFUND-ITEM"}],' +
      '"reference":"Applied credit - Booking b1","status":"AUTHORISED"}';
    h.mappingRows.set("hutFeeRefunds", { code: null, itemCode: "REFUND-ITEM" });
    // Exempt IS mapped, so only the account mapping keeps this note as it was.
    mapExempt("EXEMPTCODE");
    const note = await mintedNote([
      openingLot,
      { id: "c2", amountCents: 1500, type: CreditType.CANCELLATION_REFUND },
    ]);
    expect(JSON.stringify(note)).toBe(BEFORE_EXEMPT_LINE);
    // The Exempt resolver is not asked at all: no mapping read, no Xero rate read.
    expect(h.state.taxCategoryReads).toBe(0);
    expect(h.readXeroTaxRates).not.toHaveBeenCalled();
  });

  it("MUTATION: never folds the Exempt line into an income line that names the same account", async () => {
    // The mapping screen refuses this pairing, but two saves can race past it,
    // and the sender must not depend on the screen: one merged line could carry
    // only one of the two tax types.
    h.mappingRows.set("hutFeeRefunds", { code: "2100", itemCode: null });
    h.mappingRows.set("openingCredits", { code: "2100", itemCode: null });
    mapExempt("EXEMPTCODE");
    const lines = await mintedLines([
      { id: "c0", amountCents: 1500, type: CreditType.CANCELLATION_REFUND },
      openingLot,
    ]);
    expect(lines.map((line) => [line.accountCode, line.unitAmount, line.taxType])).toEqual([
      ["2100", 15, "OUTPUT2"],
      ["2100", 30, "EXEMPTCODE"],
    ]);
  });

  it("MUTATION: asks for the Exempt rate before the operation's first provider write, so nothing is part-allocated", async () => {
    // A second lot holds its own floating note, which the engine allocates
    // before it mints. Exempt is not mapped: the whole operation must stop
    // first, or the booking would sit part-allocated until someone maps it.
    h.mappingRows.set("openingCredits", { code: "2100", itemCode: null });
    h.state.floatingSlice = { id: "jr-floating", amountCents: 1500 };
    await expect(
      mintedNote([
        { id: "c0", amountCents: 1500, type: CreditType.CANCELLATION_REFUND, xeroCreditNoteId: "cn-floating" },
        openingLot,
      ]),
    ).rejects.toBeInstanceOf(XeroTaxCategoryUnavailableError);
    expect(allocateCreditNoteToInvoice).not.toHaveBeenCalled();
    expect(providerWrites()).toBe(0);
  });

  it("allocates the floating note and mints the Exempt line once the category is mapped", async () => {
    h.mappingRows.set("openingCredits", { code: "2100", itemCode: null });
    h.state.floatingSlice = { id: "jr-floating", amountCents: 1500 };
    mapExempt("EXEMPTCODE");
    const lines = await mintedLines([
      { id: "c0", amountCents: 1500, type: CreditType.CANCELLATION_REFUND, xeroCreditNoteId: "cn-floating" },
      openingLot,
    ]);
    expect(lines.map((line) => [line.accountCode, line.unitAmount, line.taxType])).toEqual([["2100", 30, "EXEMPTCODE"]]);
    // The floating note's slice, then the minted note's.
    expect(allocateCreditNoteToInvoice).toHaveBeenCalledTimes(2);
  });

  it("MUTATION: a failed read of the Opening Credits mapping fails the operation, never sends the share as a refund", async () => {
    // Read as "unset", the share would go out on Hut Fee Refunds under the income code, with no error.
    h.mappingRows.set("hutFeeRefunds", { code: "200", itemCode: null });
    h.mappingRows.set("openingCredits", { code: "2100", itemCode: null });
    mapExempt("EXEMPTCODE");
    h.state.failingMappingReads.add("openingCredits");
    await expect(mintedNote([openingLot])).rejects.toThrow("database read of openingCredits failed");
    expect(providerWrites()).toBe(0);
  });

  it("still falls back as before when another mapping's read fails", async () => {
    // Only the Opening Credits read is loud: goodwill keeps the resolver's fallback, as on main.
    h.mappingRows.set("hutFeeRefunds", { code: "202", itemCode: null });
    h.state.failingMappingReads.add("goodwillWriteOffs");
    const lines = await mintedLines([{ id: "c9", amountCents: 1000, type: CreditType.ADMIN_ADJUSTMENT }]);
    expect(lines.map((line) => [line.accountCode, line.taxType])).toEqual([["202", "OUTPUT2"]]);
  });

  it("names why the line is refused, in words an officer can act on", async () => {
    h.mappingRows.set("openingCredits", { code: "2100", itemCode: null });
    await expect(mintedNote([openingLot])).rejects.toThrow(
      "The Exempt tax category is not mapped to a Xero tax rate; map it on the Xero setup screen.",
    );
  });
});

describe("which minted line is Exempt, and what it is sent with (#4988)", () => {
  const resolved = (sourceKey: "openingCredits" | "hutFeeRefunds" | "goodwillWriteOffs", usingFallback: boolean) => ({
    code: "2100",
    itemCode: null,
    codeExplicitlyConfigured: true,
    sourceKey,
    usingFallback,
  });

  it("is the line whose account the Opening Credits mapping itself supplied, and no other", () => {
    expect(codeMintLine(resolved("openingCredits", false), 3000)).toEqual({
      amountCents: 3000,
      accountCode: "2100",
      taxCategory: "EXEMPT",
    });
    // Unset: resolved through the fallback, so coded with no category, as before.
    expect(codeMintLine(resolved("hutFeeRefunds", true), 3000)).toEqual({ amountCents: 3000, accountCode: "2100" });
    expect(codeMintLine(resolved("hutFeeRefunds", false), 3000)).toEqual({ amountCents: 3000, accountCode: "2100" });
    expect(codeMintLine(resolved("goodwillWriteOffs", false), 3000)).toEqual({ amountCents: 3000, accountCode: "2100" });
  });

  it("MUTATION: an Exempt line given no resolved tax is refused, never sent under the income code", () => {
    const exempt = { amountCents: 3000, accountCode: "2100", taxCategory: "EXEMPT" as const };
    expect(() => mintLineItems([exempt], "Credit applied", BASELINE_XERO_TAX_RENDERING)).toThrow(
      /never sent under the income code/,
    );
    // Resolved for an unregistered club it is an empty field, which is an answer.
    expect(mintLineItems([exempt], "Credit applied", xeroTaxRenderingOf({ registered: false }), {})).toEqual([
      { description: "Credit applied", quantity: 1, unitAmount: 30, accountCode: "2100" },
    ]);
  });
});

// #5209's contract for every sender of an Exempt line, run against this one:
// the real engine, the real mapping resolver and the real category resolver.
describeExemptLineContract("the applied-credit remainder note's spent opening credit", {
  arrange({ registered, exemptTaxType, exemptRateIsZero }) {
    vi.clearAllMocks();
    retryWrite.mockReset();
    h.mappingRows.clear();
    h.mappingRows.set("hutFeeRefunds", { code: "200", itemCode: null });
    h.mappingRows.set("openingCredits", { code: "2100", itemCode: null });
    resolveXeroTaxRendering.mockResolvedValue(
      registered ? BASELINE_XERO_TAX_RENDERING : xeroTaxRenderingOf({ registered: false }),
    );
    h.state.taxCategoryRows =
      exemptTaxType === null ? [] : [{ category: "EXEMPT", taxType: exemptTaxType, xeroTenantId: "tenant-1" }];
    h.readXeroTaxRates.mockReset();
    h.readXeroTaxRates.mockResolvedValue([taxRate("EXEMPTCODE", exemptRateIsZero ? 0 : 1500)]);
  },
  async renderLine() {
    const lines = await mintedLines([
      { id: "c1", amountCents: 3000, type: CreditType.ADMIN_ADJUSTMENT, openingCreditBatchId: "batch-1" },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].accountCode).toBe("2100");
    return lines[0];
  },
  providerWrites,
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
