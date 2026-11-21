import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  taskFindUnique: vi.fn(),
  taskFindMany: vi.fn(),
  linkFindFirst: vi.fn(),
  changeLinkFindFirst: vi.fn(),
  keptResolvedFindMany: vi.fn(),
  operationFindMany: vi.fn(),
  captureFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    manualRefundTask: {
      findUnique: (...a: unknown[]) => mocks.taskFindUnique(...a),
      findMany: (...a: unknown[]) => mocks.taskFindMany(...a),
    },
    xeroObjectLink: {
      // Round 10: a change's own invoice link is asked apart from the task's.
      findFirst: (args: { where: { role?: string } }) =>
        args.where.role === "SUPPLEMENTARY_INVOICE" ? mocks.changeLinkFindFirst(args) : mocks.linkFindFirst(args),
    },
    paymentTransaction: {
      findUnique: (...a: unknown[]) => mocks.captureFindUnique(...a),
    },
    xeroSyncOperation: {
      findMany: (args: { where: { queueType?: string } }) =>
        args.where.queueType === "KEPT_LATE_CAPTURE_INVOICE"
          ? mocks.keptResolvedFindMany(args)
          : mocks.operationFindMany(args),
    },
  },
}));

import {
  findKeptLateCaptureInvoiceIdForPayment,
  findClosedLateCaptureRecords,
  findLateCapturePaymentIntents,
  lateCaptureNotableRefundCents,
  readLateCaptureXeroReceipt,
  readPaidAnotherWayLateCaptureXeroReceipt,
} from "@/lib/late-capture-xero-receipt";
import {
  cancelledBookingModificationRefundReason,
  cancelledBookingPrimaryPaymentRefundReason,
} from "@/lib/deleted-booking-modification-payment";

/**
 * #3635 (review F2, round-3 R1/R5, orchestrator decision 29 Sep 2026): whether
 * a refund of a late capture gets the app's refund note is asked of the
 * capture's OWN invoice rows, never of the booking's pre-cancel invoice, and
 * a receipt an officer recorded by hand gets none.
 */
beforeEach(() => {
  vi.clearAllMocks();
  mocks.taskFindUnique.mockResolvedValue({ id: "task_kept" });
  mocks.linkFindFirst.mockResolvedValue(null);
  mocks.changeLinkFindFirst.mockResolvedValue(null);
  mocks.keptResolvedFindMany.mockResolvedValue([]);
  mocks.operationFindMany.mockResolvedValue([]);
  mocks.taskFindMany.mockResolvedValue([{ id: "task_kept" }]);
  mocks.captureFindUnique.mockResolvedValue({ amountCents: 8000 });
});

describe("readLateCaptureXeroReceipt", () => {
  it("is recorded, naming the kept invoice, once it is in Xero (the task's active link), not while it is only queued", async () => {
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({ kind: "none" });
    mocks.linkFindFirst.mockResolvedValue({ xeroObjectId: "inv_kept" });
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({
      kind: "recorded",
      recordedCents: 8000,
      invoiceId: "inv_kept",
    });
    expect(mocks.linkFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          localModel: "ManualRefundTask",
          localId: "task_kept",
          role: "KEPT_LATE_CAPTURE_INVOICE",
          active: true,
        }),
      }),
    );
  });

  it("is resolved by hand once an officer recorded the kept invoice and resolved it in Xero, so no automatic note is owed", async () => {
    mocks.keptResolvedFindMany.mockResolvedValue([{ xeroObjectId: null }]);
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({ kind: "resolved-by-hand" });
    expect(mocks.keptResolvedFindMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        localModel: "ManualRefundTask",
        localId: "task_kept",
        queueType: "KEPT_LATE_CAPTURE_INVOICE",
        status: { not: "CANCELLED" },
        manuallyResolvedAt: { not: null },
      }),
      select: { xeroObjectId: true },
    });
  });

  // #3924 round 10 (finding 1): a row resolved by hand AFTER the app sent
  // it is the app's own invoice in Xero, so a refund closed as paid another
  // way is noted against that id - the kept receipt's row, and a change's.
  // Round 11: for that close only; every card-refund path keeps the officer's
  // record (`late-capture-xero-receipt-verdicts.test.ts`).
  it("MUTATION: round 10: a row resolved by hand after the app sent it is recorded against its invoice id when paid another way", async () => {
    mocks.keptResolvedFindMany.mockResolvedValue([{ xeroObjectId: "inv_kept" }]);
    await expect(readPaidAnotherWayLateCaptureXeroReceipt("pi_late")).resolves.toEqual({ kind: "recorded", recordedCents: 8000, invoiceId: "inv_kept" });
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({ kind: "resolved-by-hand" });
    mocks.keptResolvedFindMany.mockResolvedValue([]);
    // PARTIAL (its payment failed) and then resolved by hand.
    mocks.operationFindMany.mockResolvedValue([
      { status: "PARTIAL", xeroObjectId: "inv_change", manuallyResolvedAt: new Date("2026-06-20T00:00:00Z") },
    ]);
    await expect(readPaidAnotherWayLateCaptureXeroReceipt("pi_late")).resolves.toEqual({ kind: "recorded", recordedCents: 8000, invoiceId: "inv_change" });
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({ kind: "resolved-by-hand" });
  });

  // #3924 round 10 (finding 2): a change whose invoice is linked in Xero is
  // recorded against the link, though its row failed after it - round 11:
  // when paid another way only.
  it("MUTATION: round 10: a change's active SUPPLEMENTARY_INVOICE link is the receipt when paid another way", async () => {
    mocks.operationFindMany.mockResolvedValue([
      { status: "FAILED", xeroObjectId: null, manuallyResolvedAt: null, localModel: "BookingModification", localId: "mod_1" },
    ]);
    mocks.changeLinkFindFirst.mockResolvedValue({ xeroObjectId: "inv_linked" });
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({ kind: "recorded", recordedCents: 8000, invoiceId: null, invoiceFailed: true });
    expect(mocks.changeLinkFindFirst).not.toHaveBeenCalled();
    await expect(readPaidAnotherWayLateCaptureXeroReceipt("pi_late")).resolves.toEqual({ kind: "recorded", recordedCents: 8000, invoiceId: "inv_linked" });
    expect(mocks.changeLinkFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ localModel: "BookingModification", localId: "mod_1" }],
          xeroObjectType: "INVOICE",
          role: "SUPPLEMENTARY_INVOICE",
          active: true,
        }),
      }),
    );
  });

  it("is recorded for the change's supplementary invoice released for this intent, naming it once sent, never a waiting or withdrawn one", async () => {
    mocks.operationFindMany.mockResolvedValue([
      { status: "PENDING", xeroObjectId: null, manuallyResolvedAt: null },
    ]);
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({
      kind: "recorded",
      recordedCents: 8000,
      invoiceId: null,
    });
    mocks.operationFindMany.mockResolvedValue([
      { status: "SUCCEEDED", xeroObjectId: "inv_change", manuallyResolvedAt: null },
    ]);
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({
      kind: "recorded",
      recordedCents: 8000,
      invoiceId: "inv_change",
    });
    expect(mocks.operationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          queueType: "SUPPLEMENTARY_INVOICE",
          status: { notIn: ["WAITING_PAYMENT", "CANCELLED"] },
          requestPayload: { path: ["paymentIntentId"], equals: "pi_late" },
        }),
      }),
    );
    // A released one an officer resolved by hand is the officer's record.
    mocks.operationFindMany.mockResolvedValue([
      { status: "FAILED", xeroObjectId: null, manuallyResolvedAt: new Date("2026-06-20T00:00:00Z") },
    ]);
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({ kind: "resolved-by-hand" });
  });

  // #3924 round 9: a released invoice that FAILED reaches Xero only through
  // an officer's retry, so it is told apart from one queued or sending.
  it("MUTATION: says when every unsent released invoice FAILED, and not while any is queued or sending", async () => {
    const failed = { status: "FAILED", xeroObjectId: null, manuallyResolvedAt: null };
    mocks.operationFindMany.mockResolvedValue([failed]);
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({
      kind: "recorded",
      recordedCents: 8000,
      invoiceId: null,
      invoiceFailed: true,
    });
    mocks.operationFindMany.mockResolvedValue([failed, { ...failed, status: "RUNNING" }]);
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({ kind: "recorded", recordedCents: 8000, invoiceId: null });
    mocks.operationFindMany.mockResolvedValue([failed, { status: "SUCCEEDED", xeroObjectId: "inv_change", manuallyResolvedAt: null }]);
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({ kind: "recorded", recordedCents: 8000, invoiceId: "inv_change" });
  });

  // #3924 round 10 (finding 2): a FAILED change invoice that attempted
  // `createInvoices` may be in Xero, so an officer checks Xero first.
  it("MUTATION: round 10: a FAILED change invoice whose payload carries the attempted invoices may be in Xero", async () => {
    mocks.operationFindMany.mockResolvedValue([
      { status: "FAILED", xeroObjectId: null, manuallyResolvedAt: null, requestPayload: { invoices: [{}] } },
    ]);
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({
      kind: "recorded",
      recordedCents: 8000,
      invoiceId: null,
      invoiceFailed: true,
      invoiceMayBeInXero: true,
    });
  });
});

describe("#4324: a kept change capture's own receipt (review M-F4, `INV-SSOT`)", () => {
  const receiptRow = (status: string, extra: Record<string, unknown> = {}) => ({
    localId: "ptx_change",
    status,
    manuallyResolvedAt: null,
    requestPayload: { queueType: "ADDITIONAL_CAPTURE_RECEIPT", paymentIntentId: "pi_late" },
    ...extra,
  });
  beforeEach(() => {
    mocks.operationFindMany.mockImplementation(async (args: { where: { queueType?: string } }) =>
      args.where.queueType === "ADDITIONAL_CAPTURE_RECEIPT" ? [receiptRow("SUCCEEDED")] : [],
    );
  });

  it("MUTATION: reads its payment link on the capture's ledger row, whatever the link's metadata names", async () => {
    mocks.linkFindFirst.mockImplementation(async (args: { where: { role?: string; localId?: string } }) =>
      args.where.role === "ADDITIONAL_CAPTURE_PAYMENT" && args.where.localId === "ptx_change"
        ? { metadata: { invoiceId: "inv_primary" } }
        : null,
    );
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({ kind: "recorded", recordedCents: 8000, invoiceId: "inv_primary" });
  });

  it("classifies its rows where no link exists: decided and FAILED may be in Xero; resolved by hand is the officer's", async () => {
    mocks.operationFindMany.mockImplementation(async (args: { where: { queueType?: string } }) =>
      args.where.queueType === "ADDITIONAL_CAPTURE_RECEIPT" ? [receiptRow("FAILED", { requestPayload: { plan: { invoiceId: "inv_primary" } } })] : [],
    );
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({
      kind: "recorded",
      recordedCents: 8000,
      invoiceId: null,
      invoiceFailed: true,
      invoiceMayBeInXero: true,
    });
    mocks.operationFindMany.mockImplementation(async (args: { where: { queueType?: string } }) =>
      args.where.queueType === "ADDITIONAL_CAPTURE_RECEIPT" ? [receiptRow("FAILED", { manuallyResolvedAt: new Date("2026-06-20") })] : [],
    );
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({ kind: "resolved-by-hand" });
  });

  it("is nothing while its only row is undecided or withdrawn", async () => {
    mocks.operationFindMany.mockImplementation(async (args: { where: { queueType?: string } }) =>
      args.where.queueType === "ADDITIONAL_CAPTURE_RECEIPT" ? [receiptRow("PENDING"), receiptRow("CANCELLED", { requestPayload: { plan: {} } })] : [],
    );
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({ kind: "none" });
  });
});

/**
 * #4383 (`INV-PAY-110`, `INV-PAY-139`): the capture's own receipt is capped at
 * its invoices' room, so its verdict says how much of the capture Xero holds:
 * the gross capture less what its stored plan put on no invoice.
 */
describe("#4383: how much of the capture the receipt recorded", () => {
  const plan = (capturedCents: number, legs: number[]) => ({
    target: "PRIMARY_INVOICE",
    invoiceId: "inv_0",
    amountCents: legs[0],
    capturedCents,
    date: "2026-06-20",
    legs: legs.map((amountCents, index) => ({ target: index === 0 ? "PRIMARY_INVOICE" : "CHANGE_INVOICE", invoiceId: `inv_${index}`, amountCents })),
  });
  const queued = { queueType: "ADDITIONAL_CAPTURE_RECEIPT", bookingId: "b1", paymentId: "p1", paymentTransactionId: "ptx_change", paymentIntentId: "pi_late" };
  const receiptRows = (rows: Array<Record<string, unknown>>) =>
    mocks.operationFindMany.mockImplementation(async (args: { where: { queueType?: string } }) =>
      args.where.queueType === "ADDITIONAL_CAPTURE_RECEIPT"
        ? rows.map((row) => ({ localId: "ptx_change", manuallyResolvedAt: null, responsePayload: null, ...row }))
        : [],
    );
  const linked = () =>
    mocks.linkFindFirst.mockImplementation(async (args: { where: { role?: string } }) =>
      args.where.role === "ADDITIONAL_CAPTURE_PAYMENT" ? { metadata: { invoiceId: "inv_0" } } : null,
    );

  it("MUTATION: an 8000 capture its receipt recorded as 5000 is recorded for 5000, linked or decided and not yet linked", async () => {
    receiptRows([{ status: "SUCCEEDED", requestPayload: { ...queued, plan: plan(8000, [5000]) } }]);
    linked();
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({ kind: "recorded", invoiceId: "inv_0", recordedCents: 5000 });
    await expect(readPaidAnotherWayLateCaptureXeroReceipt("pi_late")).resolves.toEqual({ kind: "recorded", invoiceId: "inv_0", recordedCents: 5000 });
    mocks.linkFindFirst.mockResolvedValue(null);
    receiptRows([{ status: "RUNNING", requestPayload: { ...queued, plan: plan(8000, [5000]) } }]);
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({ kind: "recorded", invoiceId: null, recordedCents: 5000 });
    receiptRows([{ status: "FAILED", requestPayload: { ...queued, plan: plan(8000, [5000]) } }]);
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({
      kind: "recorded",
      invoiceId: null,
      recordedCents: 5000,
      invoiceFailed: true,
      invoiceMayBeInXero: true,
    });
  });

  it("counts every planned leg, linked yet or not, and what another writer recorded of the capture", async () => {
    linked();
    receiptRows([{ status: "RUNNING", requestPayload: { ...queued, plan: plan(8000, [3000, 2000]) } }]);
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toMatchObject({ recordedCents: 5000 });
    // 2000 of the 8000 another writer recorded: the receipt's plan captured 6000, and placed 4000.
    receiptRows([{ status: "SUCCEEDED", requestPayload: { ...queued, plan: plan(6000, [4000]) } }]);
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toMatchObject({ recordedCents: 6000 });
    // Uncapped: the whole capture.
    receiptRows([{ status: "SUCCEEDED", requestPayload: { ...queued, plan: plan(8000, [8000]) } }]);
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toMatchObject({ recordedCents: 8000 });
  });

  it("reads the plan its completion copied to the response when the request carries none, and the gross with no plan at all", async () => {
    linked();
    receiptRows([{ status: "SUCCEEDED", requestPayload: queued, responsePayload: { plan: plan(8000, [5000]) } }]);
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toMatchObject({ recordedCents: 5000 });
    receiptRows([{ status: "SUCCEEDED", requestPayload: queued }]);
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toMatchObject({ recordedCents: 8000 });
  });

  it("is the gross capture for a kept invoice or a released change invoice, and caps nothing where the capture's row is missing", async () => {
    mocks.operationFindMany.mockImplementation(async (args: { where: { queueType?: string } }) =>
      args.where.queueType === "SUPPLEMENTARY_INVOICE" ? [{ status: "SUCCEEDED", xeroObjectId: "inv_change", manuallyResolvedAt: null }] : [],
    );
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({ kind: "recorded", invoiceId: "inv_change", recordedCents: 8000 });
    mocks.linkFindFirst.mockResolvedValue({ xeroObjectId: "inv_kept" });
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({ kind: "recorded", invoiceId: "inv_kept", recordedCents: 8000 });
    mocks.captureFindUnique.mockResolvedValue(null);
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({ kind: "recorded", invoiceId: "inv_kept", recordedCents: null });
  });
});

describe("lateCaptureNotableRefundCents (#4383)", () => {
  it("is the refund capped at what the receipt recorded, and nothing without a recorded receipt", () => {
    const capped = { kind: "recorded", invoiceId: "inv_0", recordedCents: 5000 } as const;
    expect(lateCaptureNotableRefundCents(capped, 8000)).toBe(5000);
    expect(lateCaptureNotableRefundCents(capped, 3000)).toBe(3000);
    expect(lateCaptureNotableRefundCents({ ...capped, recordedCents: null }, 8000)).toBe(8000);
    expect(lateCaptureNotableRefundCents({ kind: "resolved-by-hand" }, 8000)).toBe(0);
    expect(lateCaptureNotableRefundCents({ kind: "none" }, 8000)).toBe(0);
  });
});

describe("findLateCapturePaymentIntents (round-3 R1)", () => {
  it("finds an intent an approval task owns and one the webhook refunded automatically, and nothing else", async () => {
    mocks.taskFindMany.mockResolvedValue([
      { lateCaptureApprovalIntentId: "pi_owned", reason: null },
      { lateCaptureApprovalIntentId: null, reason: cancelledBookingPrimaryPaymentRefundReason("pi_auto") },
    ]);
    const found = await findLateCapturePaymentIntents(["pi_owned", "pi_auto", "pi_ordinary"]);
    expect([...found].sort()).toEqual(["pi_auto", "pi_owned"]);
  });

  it("asks nothing for no intents", async () => {
    await expect(findLateCapturePaymentIntents([])).resolves.toEqual(new Set());
    expect(mocks.taskFindMany).not.toHaveBeenCalled();
  });
});

describe("findClosedLateCaptureRecords (#4149)", () => {
  it("never reads a treasurer-approved row as a hand completion: the approval marker on the confirm route's own #2700 row wins", async () => {
    mocks.taskFindMany.mockResolvedValue([
      // #3639: the hold put the marker on the confirm route's OPEN row, and the approval completed it.
      { lateCaptureApprovalIntentId: "pi_held", reason: cancelledBookingModificationRefundReason("pi_held"), status: "COMPLETED" },
    ]);
    expect(Object.fromEntries(await findClosedLateCaptureRecords(["pi_held"]))).toEqual({ pi_held: "record" });
  });

  it("still reads a SEPARATE unmarked hand-COMPLETED #2700 row on an approved capture as a hand completion: two payments", async () => {
    mocks.taskFindMany.mockResolvedValue([
      { lateCaptureApprovalIntentId: "pi_held", reason: null, status: "DISMISSED" },
      { lateCaptureApprovalIntentId: null, reason: cancelledBookingModificationRefundReason("pi_held"), status: "COMPLETED" },
    ]);
    expect(Object.fromEntries(await findClosedLateCaptureRecords(["pi_held"]))).toEqual({ pi_held: "hand-completed" });
    // In either order.
    mocks.taskFindMany.mockResolvedValue([
      { lateCaptureApprovalIntentId: null, reason: cancelledBookingModificationRefundReason("pi_held"), status: "COMPLETED" },
      { lateCaptureApprovalIntentId: "pi_held", reason: null, status: "DISMISSED" },
    ]);
    expect(Object.fromEntries(await findClosedLateCaptureRecords(["pi_held"]))).toEqual({ pi_held: "hand-completed" });
  });


  it("counts an approval task in any status and a closed automatic-refund row, not an OPEN #2700 row the refund never closed, and tells a hand completion apart", async () => {
    mocks.taskFindMany.mockResolvedValue([
      { lateCaptureApprovalIntentId: "pi_owned", reason: null, status: "OPEN" },
      { lateCaptureApprovalIntentId: null, reason: cancelledBookingPrimaryPaymentRefundReason("pi_recorded"), status: "DISMISSED" },
      { lateCaptureApprovalIntentId: null, reason: cancelledBookingModificationRefundReason("pi_by_hand"), status: "COMPLETED" },
      { lateCaptureApprovalIntentId: null, reason: cancelledBookingModificationRefundReason("pi_open"), status: "OPEN" },
    ]);
    const ids = ["pi_owned", "pi_recorded", "pi_by_hand", "pi_open"];

    expect(Object.fromEntries(await findClosedLateCaptureRecords(ids))).toEqual({
      pi_owned: "record",
      pi_recorded: "record",
      pi_by_hand: "hand-completed",
    });
    // The OPEN row still marks a known late capture everywhere else (the note-eligible cash).
    expect([...(await findLateCapturePaymentIntents(ids))].sort()).toEqual([...ids].sort());
  });
});

describe("findKeptLateCaptureInvoiceIdForPayment", () => {
  it("names the payment's kept invoice, for the refund note to answer", async () => {
    mocks.linkFindFirst.mockResolvedValue({ xeroObjectId: "inv_kept" });
    await expect(findKeptLateCaptureInvoiceIdForPayment("payment-1")).resolves.toBe("inv_kept");
    mocks.taskFindMany.mockResolvedValue([]);
    await expect(findKeptLateCaptureInvoiceIdForPayment("payment-1")).resolves.toBeNull();
  });
});
