// #4381 (owner decision 28 Nov 2026 on #4381, "automate it now"; INV-PAY-144):
// which one Xero document already records a late change capture, so a
// paid-another-way close's bank note credits it - or that none can be named
// for certain, so the close stores `none` and the treasurer records it by hand.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recorder: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ kind: "receipt" })),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/additional-capture-recorder", () => ({
  readCaptureRecorder: (...args: unknown[]) => mocks.recorder(...args),
}));

import { readLateCaptureRecordedElsewhere } from "@/lib/late-capture-recorded-elsewhere";

const CAPTURE = { kind: "ADDITIONAL", amountCents: 8_000, paymentId: "p-1", bookingModificationId: "mod-1", reason: null };
const GAP_ROW = {
  status: "SUCCEEDED",
  xeroObjectId: null as string | null,
  localModel: "BookingModification",
  localId: "mod-0",
  requestPayload: { queueType: "SUPPLEMENTARY_INVOICE", bookingId: "b-1", priceDiffCents: 9_000, changeFeeCents: 0, primaryInvoiceGap: true, coveredCaptureCents: { pi_late: 8_000 } } as Record<string, unknown>,
};
const OWN_ROW = {
  status: "SUCCEEDED",
  xeroObjectId: "inv-change" as string | null,
  localModel: "BookingModification",
  localId: "mod-1",
  requestPayload: { queueType: "SUPPLEMENTARY_INVOICE", bookingId: "b-1", priceDiffCents: 8_000, changeFeeCents: 0, recordPayment: true } as Record<string, unknown>,
};

function store(overrides: { capture?: unknown; payment?: unknown; links?: unknown[]; receiptRow?: unknown; row?: unknown; supplementaryLink?: unknown } = {}) {
  return {
    paymentTransaction: { findUnique: vi.fn(async () => ("capture" in overrides ? overrides.capture : CAPTURE)) },
    payment: { findUnique: vi.fn(async () => ("payment" in overrides ? overrides.payment : { bookingId: "b-1", xeroInvoiceId: "inv-primary" })) },
    xeroObjectLink: {
      findMany: vi.fn(async () => overrides.links ?? []),
      findFirst: vi.fn(async () => overrides.supplementaryLink ?? null),
    },
    xeroSyncOperation: {
      findMany: vi.fn(async () => (overrides.receiptRow ? [overrides.receiptRow] : [])),
      findUnique: vi.fn(async () => overrides.row ?? null),
    },
    bookingModification: {},
    manualRefundTask: {},
  };
}

const read = (db: ReturnType<typeof store>) => readLateCaptureRecordedElsewhere(db as never, "pi_late");

beforeEach(() => {
  mocks.recorder.mockReset();
  mocks.recorder.mockResolvedValue({ kind: "receipt" });
});

describe("readLateCaptureRecordedElsewhere", () => {
  it("MUTATION: the primary invoice recorded the capture at its link - that invoice, for the gross capture", async () => {
    mocks.recorder.mockResolvedValue({ kind: "primary-invoice" });
    const db = store();
    expect(await read(db)).toEqual({ kind: "document", invoiceId: "inv-primary", recordedCents: 8_000 });
    expect(mocks.recorder).toHaveBeenCalledWith(
      { bookingId: "b-1", primaryInvoiceId: "inv-primary", paymentIntentId: "pi_late", bookingModificationId: "mod-1" },
      db,
    );
  });

  it("the primary invoice's id from its active link where the payment's field is not synced", async () => {
    mocks.recorder.mockResolvedValue({ kind: "primary-invoice" });
    const db = store({
      payment: { bookingId: "b-1", xeroInvoiceId: null },
      links: [{ role: "PRIMARY_INVOICE", xeroObjectType: "INVOICE", active: true, xeroObjectId: "inv-linked" }],
    });
    expect(await read(db)).toEqual({ kind: "document", invoiceId: "inv-linked", recordedCents: 8_000 });
  });

  it("MUTATION: a gap invoice covering the whole capture without naming it - that invoice's Xero id, from its link", async () => {
    mocks.recorder.mockResolvedValue({ kind: "supplementary-invoice", operationId: "gap-1" });
    expect(await read(store({ row: GAP_ROW, supplementaryLink: { xeroObjectId: "inv-gap" } }))).toEqual({
      kind: "document",
      invoiceId: "inv-gap",
      recordedCents: 8_000,
    });
  });

  it("MUTATION: the change's own paying invoice billing the whole capture - that invoice", async () => {
    mocks.recorder.mockResolvedValue({ kind: "supplementary-invoice", operationId: "own-1" });
    expect(await read(store({ row: OWN_ROW }))).toEqual({ kind: "document", invoiceId: "inv-change", recordedCents: 8_000 });
  });

  it.each([
    ["a gap invoice covering only part (the primary has the rest)", { ...GAP_ROW, requestPayload: { ...GAP_ROW.requestPayload, coveredCaptureCents: { pi_late: 5_000 } } }],
    ["a legacy gap invoice with no cents", { ...GAP_ROW, requestPayload: { ...GAP_ROW.requestPayload, coveredCaptureCents: undefined } }],
    ["an own invoice billing less than the capture", { ...OWN_ROW, requestPayload: { ...OWN_ROW.requestPayload, priceDiffCents: 7_999 } }],
    ["an own invoice whose figure cannot be read", { ...OWN_ROW, requestPayload: { recordPayment: true } }],
    ["an invoice not yet in Xero", { ...OWN_ROW, xeroObjectId: null }],
    ["an invoice still waiting for its payment", { ...OWN_ROW, status: "WAITING_PAYMENT" }],
  ])("MUTATION: %s - unidentified", async (_label, row) => {
    mocks.recorder.mockResolvedValue({ kind: "supplementary-invoice", operationId: "doc-1" });
    expect(await read(store({ row }))).toEqual({ kind: "unidentified" });
  });

  it("a supplementary recorder with no row to read - unidentified", async () => {
    mocks.recorder.mockResolvedValue({ kind: "supplementary-invoice", operationId: null });
    expect(await read(store())).toEqual({ kind: "unidentified" });
  });

  it("the credit-release sweep - left as it is (owner, until #4380)", async () => {
    mocks.recorder.mockResolvedValue({ kind: "credit-release-sweep" });
    expect(await read(store())).toEqual({ kind: "credit-release-sweep" });
  });

  it.each([
    ["the capture's own receipt records it", { kind: "receipt" }],
    ["a kept-capture invoice records it", { kind: "kept-late-capture-invoice", operationId: "kept-1" }],
  ])("%s - not elsewhere", async (_label, recorder) => {
    mocks.recorder.mockResolvedValue(recorder);
    expect(await read(store())).toEqual({ kind: "not-elsewhere" });
  });

  it("MUTATION: the capture has its own receipt row - its record, never another writer's", async () => {
    mocks.recorder.mockResolvedValue({ kind: "primary-invoice" });
    expect(await read(store({ receiptRow: { status: "PENDING", responsePayload: null } }))).toEqual({ kind: "not-elsewhere" });
    // Finished with its payment sent, or by a skip that names no other writer: still its own.
    expect(await read(store({ receiptRow: { status: "SUCCEEDED", responsePayload: { paymentId: "xero-pay-1" } } }))).toEqual({ kind: "not-elsewhere" });
    expect(await read(store({ receiptRow: { status: "FAILED", responsePayload: { skipped: "recorded-by-primary-invoice" } } }))).toEqual({ kind: "not-elsewhere" });
    expect(mocks.recorder).not.toHaveBeenCalled();
  });

  it("MUTATION (lane review of #5534): a receipt row that stood down for another writer is not the capture's record - that writer's invoice is read", async () => {
    mocks.recorder.mockResolvedValue({ kind: "primary-invoice" });
    const stoodDown = { status: "SUCCEEDED", responsePayload: { skipped: "recorded-by-primary-invoice", primaryInvoiceId: "inv-primary" } };
    expect(await read(store({ receiptRow: stoodDown }))).toEqual({ kind: "document", invoiceId: "inv-primary", recordedCents: 8_000 });
    // The sweep's stand-down stays the sweep's (#4380).
    mocks.recorder.mockResolvedValue({ kind: "credit-release-sweep" });
    expect(await read(store({ receiptRow: { status: "SUCCEEDED", responsePayload: { skipped: "recorded-by-credit-release-sweep" } } }))).toEqual({
      kind: "credit-release-sweep",
    });
  });

  it.each([
    ["the booking's own payment", { capture: { ...CAPTURE, kind: "PRIMARY" } }],
    ["no capture row", { capture: null }],
    ["a booking Xero never invoiced", { payment: { bookingId: "b-1", xeroInvoiceId: null } }],
  ])("%s - not elsewhere", async (_label, overrides) => {
    mocks.recorder.mockResolvedValue({ kind: "primary-invoice" });
    expect(await read(store(overrides))).toEqual({ kind: "not-elsewhere" });
  });
});
