import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CREDIT_NOTE_SPENT_OUTSIDE_APP_CODE,
  CreditNoteSpentOutsideAppError,
  creditNoteIsShortForAllocation,
  isCreditNoteOverAllocationRejection,
  terminalXeroErrorCode,
} from "@/lib/xero-credit-note-spent-outside-app";

/**
 * #4218 — a credit note spent in Xero outside the app fails its allocation once,
 * with a named code, and is not retried.
 */

const mocks = vi.hoisted(() => ({
  getCreditNote: vi.fn(),
  createCreditNoteAllocation: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  xeroSyncOperationUpdate: vi.fn(),
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
vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: async () => ({
    xero: {
      accountingApi: {
        getCreditNote: mocks.getCreditNote,
        createCreditNoteAllocation: mocks.createCreditNoteAllocation,
      },
    },
    tenantId: "tenant_1",
  }),
  callXeroApi: async (call: () => Promise<unknown>) => call(),
}));
vi.mock("@/lib/club-format-settings", async () => {
  const { CLUB_FORMAT_TEST } = await import("./support/club-format-fixture");
  return { getClubFormat: async () => CLUB_FORMAT_TEST };
});
vi.mock("@/lib/club-time-zone-runtime", () => ({
  readClubTimeZoneOutsideRequest: async () => "Pacific/Auckland",
}));

import { allocateCreditNoteToInvoice } from "@/lib/xero-credit-notes";

const OVER_ALLOCATION_400 =
  "Credit Note cannot be allocated as the allocation amount is greater than the amount remaining on the Credit Note";

function note(overrides: Record<string, unknown> = {}) {
  return {
    body: {
      creditNotes: [
        { status: "AUTHORISED", remainingCredit: 52.5, allocations: [], ...overrides },
      ],
    },
  };
}

describe("creditNoteIsShortForAllocation", () => {
  const open = { status: "AUTHORISED", allocatedToInvoiceCents: [] as number[] };

  it("is short when the note has less left than the slice", () => {
    expect(creditNoteIsShortForAllocation({ ...open, remainingCents: 0 }, 5250)).toBe(true);
    expect(creditNoteIsShortForAllocation({ ...open, remainingCents: 5249 }, 5250)).toBe(true);
  });

  it("is not short when the note has enough, to the cent", () => {
    expect(creditNoteIsShortForAllocation({ ...open, remainingCents: 5250 }, 5250)).toBe(false);
    expect(creditNoteIsShortForAllocation({ ...open, remainingCents: 9000 }, 5250)).toBe(false);
  });

  it("reads a fully used note (PAID) as short", () => {
    expect(
      creditNoteIsShortForAllocation(
        { status: "PAID", remainingCents: 0, allocatedToInvoiceCents: [] },
        5250,
      ),
    ).toBe(true);
  });

  it("never judges what it cannot read", () => {
    expect(creditNoteIsShortForAllocation({ ...open, remainingCents: null }, 5250)).toBe(false);
    for (const status of ["VOIDED", "DELETED", "DRAFT", undefined]) {
      expect(
        creditNoteIsShortForAllocation(
          { status, remainingCents: 0, allocatedToInvoiceCents: [] },
          5250,
        ),
      ).toBe(false);
    }
  });

  it("does not mistake this allocation's own earlier success for an outside spend", () => {
    expect(
      creditNoteIsShortForAllocation(
        { status: "PAID", remainingCents: 0, allocatedToInvoiceCents: [5250] },
        5250,
      ),
    ).toBe(false);
  });
});

describe("isCreditNoteOverAllocationRejection", () => {
  it("matches Xero's wording in an Error or a serialised body, and nothing else", () => {
    expect(isCreditNoteOverAllocationRejection(new Error(OVER_ALLOCATION_400))).toBe(true);
    expect(
      isCreditNoteOverAllocationRejection({ body: { Elements: [{ ValidationErrors: [{ Message: OVER_ALLOCATION_400 }] }] } }),
    ).toBe(true);
    expect(isCreditNoteOverAllocationRejection(new Error("Invoice is already paid"))).toBe(false);
    expect(isCreditNoteOverAllocationRejection(undefined)).toBe(false);
  });
});

describe("terminalXeroErrorCode", () => {
  it("names only the dedicated error", () => {
    const error = new CreditNoteSpentOutsideAppError("x", "cn", 0, 5250);
    expect(terminalXeroErrorCode(error)).toBe(CREDIT_NOTE_SPENT_OUTSIDE_APP_CODE);
    expect(terminalXeroErrorCode(new Error(OVER_ALLOCATION_400))).toBeNull();
  });
});

describe("allocateCreditNoteToInvoice — spent outside the app (#4218)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_1" });
    mocks.completeXeroSyncOperation.mockResolvedValue(undefined);
    mocks.failXeroSyncOperation.mockResolvedValue(undefined);
    mocks.createCreditNoteAllocation.mockResolvedValue({ body: {} });
  });

  it("fails once with the dedicated error and sends nothing when the note is spent", async () => {
    mocks.getCreditNote.mockResolvedValue(note({ status: "PAID", remainingCredit: 0 }));

    const result = allocateCreditNoteToInvoice("cn_1", "inv_1", 5250);

    await expect(result).rejects.toBeInstanceOf(CreditNoteSpentOutsideAppError);
    await expect(result).rejects.toMatchObject({
      code: CREDIT_NOTE_SPENT_OUTSIDE_APP_CODE,
      remainingCents: 0,
      requestedCents: 5250,
    });
    expect(mocks.createCreditNoteAllocation).not.toHaveBeenCalled();
    expect(mocks.failXeroSyncOperation).toHaveBeenCalledTimes(1);
    const [, recorded] = mocks.failXeroSyncOperation.mock.calls[0];
    expect(recorded).toBeInstanceOf(CreditNoteSpentOutsideAppError);
    expect((recorded as Error).message).toMatch(/only .* left in Xero; it was used outside the app/);
  });

  it("behaves exactly as before when the note has enough left", async () => {
    mocks.getCreditNote.mockResolvedValue(note({ remainingCredit: 52.5 }));

    await allocateCreditNoteToInvoice("cn_1", "inv_1", 5250);

    expect(mocks.createCreditNoteAllocation).toHaveBeenCalledTimes(1);
    expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("falls through to today's behaviour when the note cannot be read", async () => {
    mocks.getCreditNote.mockRejectedValue(new Error("Xero is down"));

    await allocateCreditNoteToInvoice("cn_1", "inv_1", 5250);

    expect(mocks.createCreditNoteAllocation).toHaveBeenCalledTimes(1);
    expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("re-sends an allocation whose own earlier success already consumed the note", async () => {
    mocks.getCreditNote.mockResolvedValue(
      note({
        status: "PAID",
        remainingCredit: 0,
        allocations: [{ invoice: { invoiceID: "inv_1" }, amount: 52.5 }],
      }),
    );

    await allocateCreditNoteToInvoice("cn_1", "inv_1", 5250);

    expect(mocks.createCreditNoteAllocation).toHaveBeenCalledTimes(1);
    expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("converts Xero's own over-allocation 400 when the pre-flight read lagged", async () => {
    mocks.getCreditNote
      .mockResolvedValueOnce(note({ remainingCredit: 52.5 }))
      .mockResolvedValueOnce(note({ status: "PAID", remainingCredit: 0 }));
    mocks.createCreditNoteAllocation.mockRejectedValue(new Error(OVER_ALLOCATION_400));

    await expect(allocateCreditNoteToInvoice("cn_1", "inv_1", 5250)).rejects.toBeInstanceOf(
      CreditNoteSpentOutsideAppError,
    );
    expect(mocks.failXeroSyncOperation.mock.calls[0][1]).toBeInstanceOf(CreditNoteSpentOutsideAppError);
  });

  it("keeps the original error when the re-read after a 400 shows the note has enough", async () => {
    const original = new Error(OVER_ALLOCATION_400);
    mocks.getCreditNote.mockResolvedValue(note({ remainingCredit: 52.5 }));
    mocks.createCreditNoteAllocation.mockRejectedValue(original);

    await expect(allocateCreditNoteToInvoice("cn_1", "inv_1", 5250)).rejects.toBe(original);
    expect(mocks.failXeroSyncOperation.mock.calls[0][1]).toBe(original);
  });
});
