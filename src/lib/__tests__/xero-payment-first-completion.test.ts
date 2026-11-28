import { beforeEach, describe, expect, it, vi } from "vitest";

// #4279, #5289 B (`INV-LOCK-002`): the Payment-first completion. The races
// against the kept settle, through the real `completeXeroSyncOperation`, are in
// `kept-settle-queued-cancel.realdb.test.ts` (OUTBOUND cases); this pins the
// transaction's order, its refusals and when it decides.

const mocks = vi.hoisted(() => ({
  steps: [] as string[],
  paymentsOfInvoices: vi.fn(),
  decide: vi.fn(),
  sendFloorAlerts: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({ default: { error: mocks.logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/payment-transactions", () => ({
  lockPaymentForRefundedTotal: async (_tx: unknown, paymentId: string) => void mocks.steps.push(`lock ${paymentId}`),
  PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS: { maxWait: 1, timeout: 2 },
}));
vi.mock("@/lib/xero-inbound/bank-transfer-payment-of-invoice", () => ({ bankTransferPaymentIdsOfInvoices: mocks.paymentsOfInvoices }));
vi.mock("@/lib/xero-inbound/retire-unlisted-credit-note-allocations", () => ({
  decideBankTransferRefundedTotal: mocks.decide,
  sendFloorAlerts: mocks.sendFloorAlerts,
}));

import { completeUnderPaymentRows, noteAllocationIntentOf } from "@/lib/xero-payment-first-completion";

const tx = { name: "tx" };
const transaction = vi.fn(async (run: (client: never) => Promise<unknown>, options: unknown) => {
  mocks.steps.push(`transaction ${JSON.stringify(options)}`);
  const result = await run(tx as never);
  mocks.steps.push("commit");
  return result;
});
const db = { $transaction: transaction } as unknown as Parameters<typeof completeUnderPaymentRows>[0];
const allocation = { creditNoteId: "cn-1", invoiceIds: ["inv-1"] };

function complete(linksWritten = true) {
  let written = false;
  return {
    run: async () => {
      mocks.steps.push("claim and links");
      written = linksWritten;
      return { id: "op-1" };
    },
    linksRecorded: () => written,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.steps.length = 0;
  mocks.paymentsOfInvoices.mockResolvedValue(new Map([["inv-1", "pay-b"]]));
  mocks.decide.mockImplementation(async (_tx: unknown, target: { id: string }) => {
    mocks.steps.push(`decide ${target.id}`);
    return null;
  });
  mocks.sendFloorAlerts.mockImplementation(async (alerts: unknown[]) => void mocks.steps.push(`send ${alerts.length}`));
});

describe("noteAllocationIntentOf (#5289 B)", () => {
  const link = (role: string, invoiceId: string, options: { active?: boolean; localModel?: string } = {}) => ({
    localModel: options.localModel ?? "BookingModification",
    xeroObjectType: "ALLOCATION", role, ...(options.active === undefined ? {} : { active: options.active }), metadata: { creditNoteId: "cn-1", invoiceId, amountCents: 1_000 },
  });

  it("reads the invoices of a note's own active allocation links, and the note", () => {
    expect(noteAllocationIntentOf([{ localModel: "BookingModification", xeroObjectType: "CREDIT_NOTE", role: "MODIFICATION_CREDIT_NOTE" }, link("MODIFICATION_CREDIT_NOTE_ALLOCATION", "inv-1")])).toEqual({ creditNoteId: "cn-1", invoiceIds: ["inv-1"] });
  });

  it("MUTATION (review): a role-less allocation on the note's own anchor is one the refunded total counts, so it names its invoice too", () => {
    expect(noteAllocationIntentOf([link("CREDIT_NOTE_ALLOCATION", "inv-1")])).toEqual({ creditNoteId: "cn-1", invoiceIds: ["inv-1"] });
    expect(noteAllocationIntentOf([link("CREDIT_NOTE_ALLOCATION", "inv-1", { localModel: "Booking" })])).toEqual({ creditNoteId: "cn-1", invoiceIds: ["inv-1"] });
  });

  it("MUTATION: none for a refund note's allocation (role-less on the payment), another role, an inactive link, or no links", () => {
    expect(noteAllocationIntentOf([link("CREDIT_NOTE_ALLOCATION", "inv-1", { localModel: "Payment" })])).toBeNull();
    expect(noteAllocationIntentOf([link("APPLIED_CREDIT_ALLOCATION", "inv-1")])).toBeNull();
    expect(noteAllocationIntentOf([link("MODIFICATION_CREDIT_NOTE_ALLOCATION", "inv-1", { active: false })])).toBeNull();
    expect(noteAllocationIntentOf(undefined)).toBeNull();
  });
});

describe("completeUnderPaymentRows (#4279, #5289 B)", () => {
  it("MUTATION (INV-LOCK-002): both intents' Payment rows, one sorted set, before the claim; the total decided after the links; the alert after the commit", async () => {
    const { run, linksRecorded } = complete();
    await completeUnderPaymentRows(db, { adoption: { paymentId: "pay-c", creditNoteId: "cn-refund" }, allocation }, { retryClaim: true }, run, linksRecorded);
    expect(mocks.steps).toEqual([
      'transaction {"maxWait":1,"timeout":2}',
      "lock pay-b",
      "lock pay-c",
      "claim and links",
      "decide pay-b",
      "commit",
      "send 0",
    ]);
    expect(mocks.decide).toHaveBeenCalledWith(tx, { id: "pay-b", invoiceId: "inv-1", creditNoteId: "cn-1" }, true);
  });

  it("MUTATION (refused claim): a claim refused before any link decides nothing", async () => {
    const { run, linksRecorded } = complete(false);
    await completeUnderPaymentRows(db, { allocation }, undefined, run, linksRecorded);
    expect(mocks.steps).toContain("lock pay-b");
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it("decides nothing, and locks no Payment row, for an invoice with no one bank-transfer payment", async () => {
    mocks.paymentsOfInvoices.mockResolvedValue(new Map());
    const { run, linksRecorded } = complete();
    await completeUnderPaymentRows(db, { allocation }, undefined, run, linksRecorded);
    expect(mocks.steps.filter((step) => step.startsWith("lock"))).toEqual([]);
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it("sends the floor alerts it decided after the commit; a failed send is logged, never thrown", async () => {
    const alert = { paymentId: "pay-b" };
    mocks.decide.mockResolvedValue(alert);
    mocks.sendFloorAlerts.mockRejectedValueOnce(new Error("mail down"));
    const { run, linksRecorded } = complete();
    await expect(completeUnderPaymentRows(db, { allocation }, undefined, run, linksRecorded)).resolves.toEqual({ id: "op-1" });
    expect(mocks.sendFloorAlerts).toHaveBeenCalledWith([alert]);
    expect(mocks.logError).toHaveBeenCalled();
  });

  it("MUTATION (store refusal): an injected store is refused for an allocation, as for an adoption, which also needs a retry's own claim", async () => {
    const { run, linksRecorded } = complete();
    await expect(completeUnderPaymentRows(db, { allocation }, { store: tx as never }, run, linksRecorded)).rejects.toThrow(/#5289/);
    await expect(completeUnderPaymentRows(db, { adoption: { paymentId: "pay-c", creditNoteId: "cn-refund" } }, undefined, run, linksRecorded)).rejects.toThrow(/#4279/);
    expect(transaction).not.toHaveBeenCalled();
  });
});
