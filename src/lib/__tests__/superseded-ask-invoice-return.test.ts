import { beforeEach, describe, expect, it, vi } from "vitest";

import { matchesWhere, type WhereRow } from "./support/prisma-where";

/*
  #3403 review (M1; `INV-PAY-140`): A CAPTURE OF A SUPERSEDED ASK TAKES ITS
  INVOICE BACK. The real module over an in-memory outbox answering through the
  shared Prisma `where` evaluator; only the anchor lock is doubled. The
  PostgreSQL proof - a declined ask paid from a stale tab after its invoice
  moved - is in `superseded-ask-invoice-carry.realdb.test.ts`.

  Frozen clock inherited; nothing here reads a date.
*/

const mocks = vi.hoisted(() => ({
  lockAnchor: vi.fn(),
  anchorCaptureHasReceipt: vi.fn(async () => false),
  beforeWrite: { value: null as null | (() => void) },
}));

type Row = WhereRow & { id: string };
let operations: Row[] = [];
const where = (filter: unknown) =>
  operations.filter((row) => matchesWhere(row, filter as Record<string, unknown>, { label: "return test outbox" }));

vi.mock("@/lib/prisma", () => {
  const client = {
    xeroSyncOperation: {
      findMany: async (args: { where: unknown }) => where(args.where).map((row) => ({ ...row })),
      updateMany: async (args: { where: unknown; data: Record<string, unknown> }) => {
        mocks.beforeWrite.value?.();
        const matched = where(args.where);
        for (const row of matched) Object.assign(row, args.data);
        return { count: matched.length };
      },
    },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(client),
  };
  return { prisma: client };
});
vi.mock("@/lib/xero-supplementary-invoice-enqueue", () => ({ lockSupplementaryInvoiceAnchor: mocks.lockAnchor }));
vi.mock("@/lib/additional-capture-receipt-link", () => ({ anchorCaptureHasReceipt: mocks.anchorCaptureHasReceipt }));

import { returnMovedInvoicesToCapturedIntent } from "@/lib/superseded-ask-invoice-return";

function invoice(id: string, payload: Record<string, unknown>, overrides: Partial<Row> = {}): Row {
  return {
    id,
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    queueType: "SUPPLEMENTARY_INVOICE",
    status: "WAITING_PAYMENT",
    localModel: "BookingModification",
    localId: "mod_a",
    correlationKey: `key_${id}`,
    requestPayload: { queueType: "SUPPLEMENTARY_INVOICE", priceDiffCents: 5000, changeFeeCents: 0, recordPayment: true, ...payload },
    ...overrides,
  };
}
const payloadOf = (id: string) => operations.find((row) => row.id === id)!.requestPayload as Record<string, unknown>;

beforeEach(() => {
  operations = [];
  mocks.lockAnchor.mockReset();
  mocks.anchorCaptureHasReceipt.mockReset();
  mocks.anchorCaptureHasReceipt.mockResolvedValue(false);
  mocks.beforeWrite.value = null;
});

describe("returnMovedInvoicesToCapturedIntent", () => {
  it("returns A's moved, still-waiting invoice to A, as if never moved, under A's change's key", async () => {
    operations = [invoice("op_a", { paymentIntentId: "pi_b", parkedFromPaymentIntentId: "pi_a" })];

    expect(await returnMovedInvoicesToCapturedIntent("pi_a")).toBe(1);

    expect(payloadOf("op_a")).toEqual(expect.objectContaining({ paymentIntentId: "pi_a", priceDiffCents: 5000, recordPayment: true }));
    expect(payloadOf("op_a")).not.toHaveProperty("parkedFromPaymentIntentId");
    expect(mocks.lockAnchor.mock.calls.map((call) => call[1])).toEqual(["mod_a"]);
  });

  it("leaves an invoice the carrier's capture already released, and one first parked elsewhere", async () => {
    operations = [
      invoice("op_released", { paymentIntentId: "pi_b", parkedFromPaymentIntentId: "pi_a" }, { status: "PENDING" }),
      invoice("op_other", { paymentIntentId: "pi_b", parkedFromPaymentIntentId: "pi_z" }, { localId: "mod_z" }),
      invoice("op_own", { paymentIntentId: "pi_b" }, { localId: "mod_b" }),
    ];
    const before = JSON.stringify(operations);

    expect(await returnMovedInvoicesToCapturedIntent("pi_a")).toBe(0);
    expect(JSON.stringify(operations)).toBe(before);
  });

  it("a write guarded on what it read: a restate or release landing first is never written over", async () => {
    operations = [invoice("op_a", { paymentIntentId: "pi_b", parkedFromPaymentIntentId: "pi_a" })];
    mocks.beforeWrite.value = () => {
      operations[0]!.correlationKey = "key_raised";
    };

    expect(await returnMovedInvoicesToCapturedIntent("pi_a")).toBe(0);
    expect(payloadOf("op_a").paymentIntentId).toBe("pi_b");
  });

  describe("review 2 (F2): whether it records a payment is decided again for the capture taking it back", () => {
    it("the unpaid a move onto a carrier with its own receipt wrote does not survive: paid again for A's capture", async () => {
      operations = [
        invoice("op_a", {
          bookingId: "booking_1",
          paymentIntentId: "pi_b",
          parkedFromPaymentIntentId: "pi_a",
          recordPayment: false,
          movedUnpaidOntoCarrier: true,
        }),
      ];

      expect(await returnMovedInvoicesToCapturedIntent("pi_a")).toBe(1);

      expect(payloadOf("op_a")).toEqual(expect.objectContaining({ paymentIntentId: "pi_a", recordPayment: true }));
      expect(payloadOf("op_a")).not.toHaveProperty("movedUnpaidOntoCarrier");
      expect(mocks.anchorCaptureHasReceipt).toHaveBeenCalledWith(expect.anything(), {
        bookingId: "booking_1",
        bookingModificationId: "mod_a",
        paymentIntentId: "pi_a",
      });
    });

    it("unpaid where A's own receipt already records A's capture: one recorder", async () => {
      operations = [invoice("op_a", { bookingId: "booking_1", paymentIntentId: "pi_b", parkedFromPaymentIntentId: "pi_a" })];
      mocks.anchorCaptureHasReceipt.mockResolvedValue(true);

      expect(await returnMovedInvoicesToCapturedIntent("pi_a")).toBe(1);
      expect(payloadOf("op_a")).toEqual(expect.objectContaining({ paymentIntentId: "pi_a", recordPayment: false }));
    });

    it("an invoice raised unpaid before any move stays unpaid", async () => {
      operations = [invoice("op_a", { paymentIntentId: "pi_b", parkedFromPaymentIntentId: "pi_a", recordPayment: false })];

      expect(await returnMovedInvoicesToCapturedIntent("pi_a")).toBe(1);
      expect(payloadOf("op_a")).toEqual(expect.objectContaining({ paymentIntentId: "pi_a", recordPayment: false }));
    });
  });
});
