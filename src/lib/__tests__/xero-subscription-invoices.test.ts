import { beforeEach, describe, expect, it, vi } from "vitest";
import { Invoice, LineAmountTypes } from "xero-node";

const enqueueMocks = vi.hoisted(() => ({
  chargeFindUnique: vi.fn(),
  operationFindFirst: vi.fn(),
  startOperation: vi.fn(),
  chargeUpdate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    membershipSubscriptionCharge: { findUnique: enqueueMocks.chargeFindUnique, update: enqueueMocks.chargeUpdate },
    xeroSyncOperation: { findFirst: enqueueMocks.operationFindFirst },
  },
}));
vi.mock("@/lib/xero-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/xero-sync")>()),
  startXeroSyncOperation: enqueueMocks.startOperation,
}));

import {
  enqueueMembershipSubscriptionChargeOperation,
  subscriptionInvoiceMatchesSnapshot,
} from "@/lib/xero-subscription-invoices";

describe("enqueueMembershipSubscriptionChargeOperation ignores VOIDED charges (#2147)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enqueueMocks.operationFindFirst.mockResolvedValue(null);
    enqueueMocks.startOperation.mockResolvedValue({ id: "op-1" });
    enqueueMocks.chargeUpdate.mockResolvedValue({});
  });

  it("no-ops a VOIDED charge (RETRY_CHARGE must not re-enqueue it)", async () => {
    enqueueMocks.chargeFindUnique.mockResolvedValue({
      id: "charge-void", status: "VOIDED", billingBasis: "PER_MEMBER", xeroInvoiceId: "xi", emailSentAt: null,
    });
    const result = await enqueueMembershipSubscriptionChargeOperation("charge-void");
    expect(result).toEqual({ queueOperationId: null, message: "No subscription invoice work is required." });
    expect(enqueueMocks.startOperation).not.toHaveBeenCalled();
    expect(enqueueMocks.chargeUpdate).not.toHaveBeenCalled();
  });

  it("still enqueues a QUEUED charge (control)", async () => {
    enqueueMocks.chargeFindUnique.mockResolvedValue({
      id: "charge-live", status: "QUEUED", billingBasis: "PER_MEMBER", xeroInvoiceId: null, emailSentAt: null,
    });
    const result = await enqueueMembershipSubscriptionChargeOperation("charge-live");
    expect(result.queueOperationId).toBe("op-1");
    expect(enqueueMocks.startOperation).toHaveBeenCalledTimes(1);
  });
});

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    invoiceID: "invoice-1",
    type: Invoice.TypeEnum.ACCREC,
    status: Invoice.StatusEnum.AUTHORISED,
    reference: "MEMSUB-reference",
    contact: { contactID: "contact-1" },
    lineAmountTypes: LineAmountTypes.Inclusive,
    date: "2026-07-01",
    dueDate: "2026-07-31",
    total: 120,
    lineItems: [{ quantity: 1, unitAmount: 120, lineAmount: 120, accountCode: "203", itemCode: "SUB", taxType: "OUTPUT2" }],
    ...overrides,
  };
}

describe("Xero membership subscription invoice adoption", () => {
  const snapshot = {
    contactId: "contact-1",
    amountCents: 12_000,
    lines: [{ amountCents: 12_000, accountCode: "203", itemCode: "SUB" as string | null }],
    dueDays: 30,
    reference: "MEMSUB-reference",
  };

  it("adopts only an exact reference, recipient, GST-inclusive amount, account and ACCREC match", () => {
    expect(subscriptionInvoiceMatchesSnapshot({ invoice: invoice(), ...snapshot })).toBe(true);
  });

  // The due interval is measured from `invoice.date` and `invoice.dueDate`, and
  // both are typed `string` while `xero-node` hands back a `Date` for a
  // Microsoft-JSON payload. `invoiceDueIntervalDays` used to carry its own copy
  // of that classification; it now calls the Xero boundary, so this pins that
  // ALL FOUR wire shapes still measure the same thirty days and the charge
  // still adopts its own invoice (CT-5, #2869 review). A shape that stopped
  // being read would return `null` and send the charge to `CONFLICT`.
  it.each([
    ["plain calendar dates", "2026-07-01", "2026-07-31"],
    ["offset-less date-times", "2026-07-01T00:00:00", "2026-07-31T00:00:00"],
    ["offset-bearing instants", "2026-07-01T00:00:00Z", "2026-07-31T00:00:00Z"],
    // 1782864000000 = 2026-07-01T00:00Z, 1785456000000 = 2026-07-31T00:00Z.
    ["Microsoft-JSON strings", "/Date(1782864000000+0000)/", "/Date(1785456000000+0000)/"],
  ])("measures the same due interval from %s", (_label, date, dueDate) => {
    expect(
      subscriptionInvoiceMatchesSnapshot({
        invoice: invoice({ date, dueDate } as Partial<Invoice>),
        ...snapshot,
      }),
    ).toBe(true);
  });

  it("adopts an invoice whose dates the SDK already deserialised into Dates", () => {
    expect(
      subscriptionInvoiceMatchesSnapshot({
        invoice: invoice({
          date: new Date("2026-07-01T00:00:00.000Z"),
          dueDate: new Date("2026-07-31T00:00:00.000Z"),
        } as unknown as Partial<Invoice>),
        ...snapshot,
      }),
    ).toBe(true);
  });

  it.each([
    ["amount mismatch", invoice({ total: 119.99 })],
    ["recipient mismatch", invoice({ contact: { contactID: "other" } })],
    ["account mismatch", invoice({ lineItems: [{ quantity: 1, unitAmount: 120, lineAmount: 120, accountCode: "200" }] })],
    ["missing item", invoice({ lineItems: [{ quantity: 1, unitAmount: 120, lineAmount: 120, accountCode: "203", taxType: "OUTPUT2" }] })],
    ["wrong item", invoice({ lineItems: [{ quantity: 1, unitAmount: 120, lineAmount: 120, accountCode: "203", itemCode: "OTHER", taxType: "OUTPUT2" }] })],
    ["due interval drift", invoice({ dueDate: "2026-08-01" })],
    ["GST treatment mismatch", invoice({ lineItems: [{ quantity: 1, unitAmount: 120, lineAmount: 120, accountCode: "203", taxType: "NONE" }] })],
    ["reference mismatch", invoice({ reference: "manual-reference" })],
    ["draft invoice", invoice({ status: Invoice.StatusEnum.DRAFT })],
    ["submitted invoice", invoice({ status: Invoice.StatusEnum.SUBMITTED })],
    ["paid invoice", invoice({ status: Invoice.StatusEnum.PAID })],
    ["voided invoice", invoice({ status: Invoice.StatusEnum.VOIDED })],
  ])("rejects %s without provider correction", (_label, providerInvoice) => {
    expect(subscriptionInvoiceMatchesSnapshot({ invoice: providerInvoice, ...snapshot })).toBe(false);
  });

  /*
    #2685 review — AN UNREADABLE AMOUNT MUST MATCH NOTHING.

    `invoiceCents` and `lineCents` fell back to `?? 0` when the provider figure
    could not be converted. Zero is not a safe "unknown": a WAIVED or fully
    discounted component snapshots as `amountCents: 0`, so an invoice nobody
    could read compared EQUAL to it and would have been adopted as that charge's
    own invoice. Both helpers now refuse, and `null === number` is false, so the
    match fails instead.

    Reaching it needs a payload the Xero SDK's JSON cannot produce — a string or
    a `NaN` where a number belongs — which is exactly why it was worth closing
    rather than arguing about: it costs nothing and removes the question.
  */
  describe("an invoice whose amount cannot be read is never adopted", () => {
    const waived = {
      contactId: "contact-1",
      amountCents: 0,
      lines: [{ amountCents: 0, accountCode: "203", itemCode: "SUB" as string | null }],
      dueDays: 30,
      reference: "MEMSUB-reference",
    };

    it.each([
      [
        "a NaN invoice total with unreadable lines",
        invoice({
          total: Number.NaN,
          lineItems: [
            {
              quantity: 1,
              unitAmount: 120,
              lineAmount: Number.NaN,
              accountCode: "203",
              itemCode: "SUB",
              taxType: "OUTPUT2",
            },
          ],
        }),
      ],
      [
        "a string line amount summing to a string",
        invoice({
          total: undefined,
          lineItems: [
            {
              quantity: 1,
              unitAmount: 120,
              lineAmount: "0.00" as unknown as number,
              accountCode: "203",
              itemCode: "SUB",
              taxType: "OUTPUT2",
            },
          ],
        }),
      ],
    ])("refuses to adopt %s against a zero-cent snapshot", (_label, providerInvoice) => {
      expect(
        subscriptionInvoiceMatchesSnapshot({ invoice: providerInvoice, ...waived }),
      ).toBe(false);
    });

    it("still adopts a genuinely zero-cent invoice (the control)", () => {
      // The refusal must be about UNREADABLE, not about zero: a real waived
      // component still adopts, or this fix would have broken free memberships.
      const zeroInvoice = invoice({
        total: 0,
        lineItems: [
          {
            quantity: 1,
            unitAmount: 0,
            lineAmount: 0,
            accountCode: "203",
            itemCode: "SUB",
            taxType: "OUTPUT2",
          },
        ],
      });
      expect(
        subscriptionInvoiceMatchesSnapshot({ invoice: zeroInvoice, ...waived }),
      ).toBe(true);
    });
  });

  it("matches null snapshot item only when the provider item is absent or null", () => {
    const noItemSnapshot = { ...snapshot, lines: [{ amountCents: 12_000, accountCode: "203", itemCode: null as string | null }] };
    expect(subscriptionInvoiceMatchesSnapshot({
      invoice: invoice({ lineItems: [{ quantity: 1, unitAmount: 120, lineAmount: 120, accountCode: "203", taxType: "OUTPUT2" }] }),
      ...noItemSnapshot,
    })).toBe(true);
    expect(subscriptionInvoiceMatchesSnapshot({ invoice: invoice(), ...noItemSnapshot })).toBe(false);
  });

  describe("multi-line component invoices (#1932, E6)", () => {
    const multi = () => invoice({
      total: 150,
      lineItems: [
        { quantity: 1, unitAmount: 100, lineAmount: 100, accountCode: "203", itemCode: "SUB", taxType: "OUTPUT2" },
        { quantity: 1, unitAmount: 50, lineAmount: 50, accountCode: "260", itemCode: undefined, taxType: "OUTPUT2" },
      ],
    });
    const multiSnapshot = {
      contactId: "contact-1",
      amountCents: 15_000,
      lines: [
        { amountCents: 10_000, accountCode: "203", itemCode: "SUB" as string | null },
        { amountCents: 5_000, accountCode: "260", itemCode: null as string | null },
      ],
      dueDays: 30,
      reference: "MEMSUB-reference",
    };

    it("adopts an exact full-line-array match in order", () => {
      expect(subscriptionInvoiceMatchesSnapshot({ invoice: multi(), ...multiSnapshot })).toBe(true);
    });

    it("rejects when a line count differs", () => {
      expect(subscriptionInvoiceMatchesSnapshot({ invoice: invoice({ total: 150 }), ...multiSnapshot })).toBe(false);
    });

    it("rejects when the lines are the same set but out of order", () => {
      const swapped = invoice({
        total: 150,
        lineItems: [
          { quantity: 1, unitAmount: 50, lineAmount: 50, accountCode: "260", itemCode: undefined, taxType: "OUTPUT2" },
          { quantity: 1, unitAmount: 100, lineAmount: 100, accountCode: "203", itemCode: "SUB", taxType: "OUTPUT2" },
        ],
      });
      expect(subscriptionInvoiceMatchesSnapshot({ invoice: swapped, ...multiSnapshot })).toBe(false);
    });

    it("rejects when a single line's account differs but the total still foots", () => {
      const drifted = invoice({
        total: 150,
        lineItems: [
          { quantity: 1, unitAmount: 100, lineAmount: 100, accountCode: "999", itemCode: "SUB", taxType: "OUTPUT2" },
          { quantity: 1, unitAmount: 50, lineAmount: 50, accountCode: "260", itemCode: undefined, taxType: "OUTPUT2" },
        ],
      });
      expect(subscriptionInvoiceMatchesSnapshot({ invoice: drifted, ...multiSnapshot })).toBe(false);
    });
  });
});
