import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CREDIT_NOTE_SPENT_OUTSIDE_APP_CODE,
  CreditNoteSpentOutsideAppError,
  isCreditNoteOverAllocationText,
  noteAllocationCentsForInvoice,
  refusalMeansSpentOutsideApp,
} from "@/lib/xero-credit-note-spent-outside-app";
import { namedXeroErrorCode } from "@/lib/xero-sync-error-text";
import { xeroRefusedOperation } from "@/lib/xero-error-shape";

/**
 * #4218 — when Xero refuses an allocation because the credit note was spent
 * outside the app, the operation records a named code and a plain reason.
 */

const mocks = vi.hoisted(() => ({
  getCreditNote: vi.fn(),
  createCreditNoteAllocation: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  xeroSyncOperationUpdate: vi.fn(),
  callXeroApiOptions: vi.fn(),
  getClubFormat: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { xeroSyncOperation: { update: mocks.xeroSyncOperationUpdate } },
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/xero-links", () => ({
  buildXeroInvoiceUrl: (id: string) => `https://xero.test/invoice/${id}`,
  buildXeroCreditNoteUrl: (id: string) => `https://xero.test/credit-note/${id}`,
  stripXeroOrgShortCode: (url: string) => url,
}));
vi.mock("@/lib/xero-sync", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-sync");
  return {
    ...actual,
    startXeroSyncOperation: mocks.startXeroSyncOperation,
    completeXeroSyncOperation: mocks.completeXeroSyncOperation,
    failXeroSyncOperation: mocks.failXeroSyncOperation,
  };
});
vi.mock("@/lib/xero-api-client", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-api-client")),
  getAuthenticatedXeroClient: async () => ({
    xero: {
      accountingApi: {
        getCreditNote: mocks.getCreditNote,
        createCreditNoteAllocation: mocks.createCreditNoteAllocation,
      },
    },
    tenantId: "tenant_1",
  }),
  callXeroApi: async (call: () => Promise<unknown>, options?: unknown) => {
    mocks.callXeroApiOptions(options);
    return call();
  },
}));
vi.mock("@/lib/club-format-settings", () => ({ getClubFormat: mocks.getClubFormat }));
vi.mock("@/lib/club-time-zone-runtime", () => ({
  readClubTimeZoneOutsideRequest: async () => "Pacific/Auckland",
}));

import { allocateCreditNoteToInvoice } from "@/lib/xero-credit-notes";

const OVER_ALLOCATION_400 =
  "Credit Note cannot be allocated as the allocation amount is greater than the amount remaining on the Credit Note";

function note(overrides: Record<string, unknown> = {}) {
  return { body: { creditNotes: [{ status: "PAID", remainingCredit: 0, ...overrides }] } };
}

describe("isCreditNoteOverAllocationText", () => {
  it("matches Xero's wording, in any case, and nothing else", () => {
    expect(isCreditNoteOverAllocationText(OVER_ALLOCATION_400)).toBe(true);
    expect(isCreditNoteOverAllocationText(OVER_ALLOCATION_400.toLowerCase())).toBe(true);
    expect(isCreditNoteOverAllocationText("Invoice is already paid")).toBe(false);
    expect(isCreditNoteOverAllocationText("")).toBe(false);
  });
});

describe("refusalMeansSpentOutsideApp", () => {
  it("stands when the read shows less than the slice", () => {
    expect(refusalMeansSpentOutsideApp({ remainingCents: 0, allocatedToInvoiceCents: [] }, 5250)).toBe(true);
    expect(refusalMeansSpentOutsideApp({ remainingCents: 5249, allocatedToInvoiceCents: [] }, 5250)).toBe(true);
  });

  it("is disproved when the note now has enough, to the cent", () => {
    expect(refusalMeansSpentOutsideApp({ remainingCents: 5250, allocatedToInvoiceCents: [] }, 5250)).toBe(false);
  });

  it("is disproved by this invoice's own earlier allocation of at least the slice", () => {
    expect(refusalMeansSpentOutsideApp({ remainingCents: 0, allocatedToInvoiceCents: [5250] }, 5250)).toBe(false);
    expect(refusalMeansSpentOutsideApp({ remainingCents: 0, allocatedToInvoiceCents: [5249] }, 5250)).toBe(true);
  });
});

describe("noteAllocationCentsForInvoice", () => {
  const toCents = (amount: unknown) => (typeof amount === "number" ? Math.round(amount * 100) : null);

  it("keeps only this invoice's allocations and skips an amount that is not exact cents", () => {
    expect(
      noteAllocationCentsForInvoice(
        [
          { invoice: { invoiceID: "inv_1" }, amount: 52.5 },
          { invoice: { invoiceID: "inv_other" }, amount: 99 },
          { invoice: { invoiceID: "inv_1" }, amount: "bad" },
          { invoice: null, amount: 1 },
        ],
        "inv_1",
        toCents,
      ),
    ).toEqual([5250]);
    expect(noteAllocationCentsForInvoice(undefined, "inv_1", toCents)).toEqual([]);
  });
});

describe("namedXeroErrorCode", () => {
  it("names only the dedicated error", () => {
    const error = new CreditNoteSpentOutsideAppError("x", "cn", 0, 5250);
    expect(namedXeroErrorCode(error)).toBe(CREDIT_NOTE_SPENT_OUTSIDE_APP_CODE);
    expect(namedXeroErrorCode(new Error(OVER_ALLOCATION_400))).toBeNull();
  });
});

describe("xeroRefusedOperation", () => {
  it("counts the named code as a Xero refusal, as it counted the bare 400", () => {
    expect(xeroRefusedOperation({ status: "FAILED", lastErrorCode: CREDIT_NOTE_SPENT_OUTSIDE_APP_CODE })).toBe(true);
    expect(xeroRefusedOperation({ status: "FAILED", lastErrorCode: "400" })).toBe(true);
    expect(xeroRefusedOperation({ status: "FAILED", lastErrorCode: "429" })).toBe(false);
    expect(xeroRefusedOperation({ status: "SUCCEEDED", lastErrorCode: CREDIT_NOTE_SPENT_OUTSIDE_APP_CODE })).toBe(false);
  });
});

describe("allocateCreditNoteToInvoice — credit note spent outside the app (#4218)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { CLUB_FORMAT_TEST } = await import("./support/club-format-fixture");
    mocks.getClubFormat.mockResolvedValue(CLUB_FORMAT_TEST);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_1" });
    mocks.completeXeroSyncOperation.mockResolvedValue(undefined);
    mocks.failXeroSyncOperation.mockResolvedValue(undefined);
    mocks.createCreditNoteAllocation.mockResolvedValue({ body: {} });
  });

  it("sends the allocation without any read beforehand", async () => {
    await allocateCreditNoteToInvoice("cn_1", "inv_1", 5250);

    expect(mocks.createCreditNoteAllocation).toHaveBeenCalledTimes(1);
    expect(mocks.getCreditNote).not.toHaveBeenCalled();
    expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("turns Xero's over-allocation refusal into the named error, with the amount left", async () => {
    const original = new Error(OVER_ALLOCATION_400);
    mocks.createCreditNoteAllocation.mockRejectedValue(original);
    mocks.getCreditNote.mockResolvedValue(note({ remainingCredit: 0 }));

    const result = allocateCreditNoteToInvoice("cn_1", "inv_1", 5250);

    await expect(result).rejects.toBeInstanceOf(CreditNoteSpentOutsideAppError);
    await expect(result).rejects.toMatchObject({
      code: CREDIT_NOTE_SPENT_OUTSIDE_APP_CODE,
      remainingCents: 0,
      requestedCents: 5250,
      cause: original,
    });
    expect(mocks.failXeroSyncOperation).toHaveBeenCalledTimes(1);
    const [, recorded] = mocks.failXeroSyncOperation.mock.calls[0];
    expect(recorded).toBeInstanceOf(CreditNoteSpentOutsideAppError);
    expect((recorded as Error).message).toMatch(/only .* left in Xero; it was used outside the app/);
  });

  it("converts the real SDK refusal, which arrives as a JSON string", async () => {
    mocks.createCreditNoteAllocation.mockRejectedValue(
      JSON.stringify({ response: { statusCode: 400, body: { Elements: [{ ValidationErrors: [{ Message: OVER_ALLOCATION_400 }] }] } } }),
    );
    mocks.getCreditNote.mockResolvedValue(note());

    await expect(allocateCreditNoteToInvoice("cn_1", "inv_1", 5250)).rejects.toBeInstanceOf(
      CreditNoteSpentOutsideAppError,
    );
  });

  it("carries Xero's own list of what was done to the note: its allocations and its payments, in exact cents", async () => {
    mocks.createCreditNoteAllocation.mockRejectedValue(new Error(OVER_ALLOCATION_400));
    mocks.getCreditNote.mockResolvedValue(
      note({
        remainingCredit: 0,
        total: 52.5,
        allocations: [
          { invoice: { invoiceID: "inv_other" }, amount: 20 },
          { invoice: { invoiceID: "inv_bad" }, amount: 0.005 },
          { invoice: { invoiceID: "inv_removed" }, amount: 9, isDeleted: true },
          { invoice: null, amount: 1 },
        ],
        payments: [{ paymentID: "pay_1", amount: 32.5 }, { paymentID: "pay_gone", amount: 4, status: "DELETED" }, { amount: 5 }],
      }),
    );

    await expect(allocateCreditNoteToInvoice("cn_1", "inv_1", 5250)).rejects.toMatchObject({
      xeroAllocations: [{ invoiceId: "inv_other", cents: 2000 }],
      xeroPayments: [{ paymentId: "pay_1", cents: 3250 }],
      totalCents: 5250,
    });
  });

  it("keeps the original error when the follow-up read fails, since the refusal alone is not proof", async () => {
    const original = new Error(OVER_ALLOCATION_400);
    mocks.createCreditNoteAllocation.mockRejectedValue(original);
    mocks.getCreditNote.mockRejectedValue(new Error("Xero is down"));

    await expect(allocateCreditNoteToInvoice("cn_1", "inv_1", 5250)).rejects.toBe(original);
    expect(mocks.failXeroSyncOperation.mock.calls[0][1]).toBe(original);
  });

  it("keeps the original error when Xero returns no credit note, or an amount that is not exact cents", async () => {
    const original = new Error(OVER_ALLOCATION_400);
    mocks.createCreditNoteAllocation.mockRejectedValue(original);

    mocks.getCreditNote.mockResolvedValueOnce({ body: { creditNotes: [] } });
    await expect(allocateCreditNoteToInvoice("cn_1", "inv_1", 5250)).rejects.toBe(original);

    mocks.getCreditNote.mockResolvedValueOnce(note({ remainingCredit: 0.005 }));
    await expect(allocateCreditNoteToInvoice("cn_1", "inv_1", 5250)).rejects.toBe(original);
  });

  it("leaves every other Xero error exactly as it was", async () => {
    const other = new Error("Invoice is already paid");
    mocks.createCreditNoteAllocation.mockRejectedValue(other);

    await expect(allocateCreditNoteToInvoice("cn_1", "inv_1", 5250)).rejects.toBe(other);
    expect(mocks.failXeroSyncOperation.mock.calls[0][1]).toBe(other);
    expect(mocks.getCreditNote).not.toHaveBeenCalled();
  });

  it("states the amount left, in the club's money format, when there is some", async () => {
    mocks.createCreditNoteAllocation.mockRejectedValue(new Error(OVER_ALLOCATION_400));
    mocks.getCreditNote.mockResolvedValue(note({ status: "AUTHORISED", remainingCredit: 12.5 }));

    await expect(allocateCreditNoteToInvoice("cn_1", "inv_1", 5250)).rejects.toMatchObject({
      remainingCents: 1250,
      message: expect.stringContaining("only $12.50 left in Xero"),
    });
  });

  it("falls back to generic wording when the club format cannot be read", async () => {
    mocks.createCreditNoteAllocation.mockRejectedValue(new Error(OVER_ALLOCATION_400));
    mocks.getCreditNote.mockResolvedValue(note({ remainingCredit: 12.5 }));
    mocks.getClubFormat.mockRejectedValue(new Error("settings unavailable"));

    await expect(allocateCreditNoteToInvoice("cn_1", "inv_1", 5250)).rejects.toMatchObject({
      remainingCents: 1250,
      message: expect.stringContaining("has less than this allocation needs left in Xero"),
    });
    expect(mocks.failXeroSyncOperation.mock.calls[0][1]).toBeInstanceOf(CreditNoteSpentOutsideAppError);
  });

  it("makes the follow-up read without arming the transient-outage breaker", async () => {
    mocks.createCreditNoteAllocation.mockRejectedValue(new Error(OVER_ALLOCATION_400));
    mocks.getCreditNote.mockResolvedValue(note());

    await expect(allocateCreditNoteToInvoice("cn_1", "inv_1", 5250)).rejects.toBeInstanceOf(
      CreditNoteSpentOutsideAppError,
    );
    expect(mocks.callXeroApiOptions).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "getCreditNote", armTransientBreaker: false }),
    );
  });

  it("does not wrap an error that is already the named error", async () => {
    const already = new CreditNoteSpentOutsideAppError("already", "cn_1", 0, 5250);
    mocks.createCreditNoteAllocation.mockRejectedValue(already);

    await expect(allocateCreditNoteToInvoice("cn_1", "inv_1", 5250)).rejects.toBe(already);
    expect(mocks.getCreditNote).not.toHaveBeenCalled();
  });

  it("keeps the original error when this invoice already holds the app's own allocation", async () => {
    const original = new Error(OVER_ALLOCATION_400);
    mocks.createCreditNoteAllocation.mockRejectedValue(original);
    mocks.getCreditNote.mockResolvedValue(
      note({ remainingCredit: 0, allocations: [{ invoice: { invoiceID: "inv_1" }, amount: 52.5 }] }),
    );

    await expect(allocateCreditNoteToInvoice("cn_1", "inv_1", 5250)).rejects.toBe(original);
    expect(mocks.failXeroSyncOperation.mock.calls[0][1]).toBe(original);
  });

  it("still names a note spent by an allocation to a DIFFERENT invoice", async () => {
    mocks.createCreditNoteAllocation.mockRejectedValue(new Error(OVER_ALLOCATION_400));
    mocks.getCreditNote.mockResolvedValue(
      note({ remainingCredit: 0, allocations: [{ invoice: { invoiceID: "inv_other" }, amount: 52.5 }] }),
    );

    await expect(allocateCreditNoteToInvoice("cn_1", "inv_1", 5250)).rejects.toBeInstanceOf(
      CreditNoteSpentOutsideAppError,
    );
  });

  it("keeps the original error when the note now shows enough credit", async () => {
    const original = new Error(OVER_ALLOCATION_400);
    mocks.createCreditNoteAllocation.mockRejectedValue(original);
    mocks.getCreditNote.mockResolvedValue(note({ status: "AUTHORISED", remainingCredit: 52.5 }));

    await expect(allocateCreditNoteToInvoice("cn_1", "inv_1", 5250)).rejects.toBe(original);
  });

  it("reads with no rate-limit retries and a short wait", async () => {
    mocks.createCreditNoteAllocation.mockRejectedValue(new Error(OVER_ALLOCATION_400));
    mocks.getCreditNote.mockResolvedValue(note());

    await expect(allocateCreditNoteToInvoice("cn_1", "inv_1", 5250)).rejects.toBeInstanceOf(
      CreditNoteSpentOutsideAppError,
    );
    expect(mocks.callXeroApiOptions).toHaveBeenCalledWith(
      expect.objectContaining({ maxRetries: 0, maxWaitSec: 5 }),
    );
  });
});
