import { describe, expect, it, vi } from "vitest";
import {
  anchorCaptureHasReceipt,
  bookingHasPaidUnnamedSupplementary,
  bookingHasUnattributedCaptures,
  captureChangeId,
  keptInvoiceBillsChangeCapture,
} from "@/lib/additional-capture-receipt-link";
import { buildEditFinancialReviewChargeReason } from "@/lib/payment-recovery-keys";

// #3953 round 7 (INV-PAY-139): the change a capture pays for, and the reads
// the per-anchor lock's callers make about captures no change can be read from.

function store(input: {
  captures?: Array<{ id: string; stripePaymentIntentId?: string | null }>;
  kept?: Array<{ queueType: string }>;
  link?: { id: string } | null;
  receipts?: Array<{ status: string; requestPayload: unknown; manuallyResolvedAt?: Date | null }>;
  supplementaries?: Array<{ requestPayload: unknown }>;
  unattributed?: number;
  modifications?: Array<{ id: string }>;
  paymentLinks?: Array<{ localId: string }>;
  queuedOnChanges?: Array<{ localId: string; requestPayload: unknown }>;
}) {
  return {
    paymentTransaction: {
      findMany: vi.fn(async () => input.captures ?? []),
      count: vi.fn(async () => input.unattributed ?? 0),
    },
    xeroObjectLink: {
      findFirst: vi.fn(async () => input.link ?? null),
      findMany: vi.fn(async () => input.paymentLinks ?? []),
    },
    bookingModification: { findMany: vi.fn(async () => input.modifications ?? []) },
    xeroSyncOperation: {
      findMany: vi.fn(async (args: { where: { queueType: string; localModel?: string } }) =>
        args.where.queueType === "KEPT_LATE_CAPTURE_INVOICE"
          ? (input.kept ?? [])
          : args.where.queueType !== "SUPPLEMENTARY_INVOICE"
          ? (input.receipts ?? [])
          : args.where.localModel
            ? (input.queuedOnChanges ?? [])
            : (input.supplementaries ?? []),
      ),
    },
  };
}

const UNATTRIBUTED = {
  payment: { bookingId: "booking_1" },
  kind: "ADDITIONAL",
  bookingModificationId: null,
  OR: [{ reason: null }, { NOT: { reason: { startsWith: "edit\\_financial\\_review\\_charge\\_" } } }],
};

describe("captureChangeId", () => {
  it("reads the stamp first, then a review charge's reason, else nothing", () => {
    expect(captureChangeId({ bookingModificationId: "mod_1", reason: buildEditFinancialReviewChargeReason("mod_2") })).toBe("mod_1");
    expect(captureChangeId({ bookingModificationId: null, reason: buildEditFinancialReviewChargeReason("mod_2") })).toBe("mod_2");
    expect(captureChangeId({ bookingModificationId: null, reason: "member_price_increase" })).toBeNull();
    expect(captureChangeId({ bookingModificationId: null, reason: null })).toBeNull();
    // The bare prefix names no change.
    expect(captureChangeId({ bookingModificationId: null, reason: buildEditFinancialReviewChargeReason("") })).toBeNull();
  });
});

describe("bookingHasUnattributedCaptures", () => {
  it("counts the booking's change captures with no stamp and no review-charge reason, matching the prefix literally", async () => {
    const db = store({ unattributed: 1 });
    await expect(bookingHasUnattributedCaptures(db as never, "booking_1")).resolves.toBe(true);
    expect(db.paymentTransaction.count).toHaveBeenCalledWith({ where: UNATTRIBUTED });
    await expect(bookingHasUnattributedCaptures(store({}) as never, "booking_1")).resolves.toBe(false);
  });
});

describe("bookingHasPaidUnnamedSupplementary", () => {
  it("is true only for a live supplementary invoice that records a payment without naming its capture", async () => {
    const named = { requestPayload: { bookingId: "booking_1", paymentIntentId: "pi_1" } };
    const unpaid = { requestPayload: { bookingId: "booking_1", recordPayment: false } };
    const gap = { requestPayload: { bookingId: "booking_1", primaryInvoiceGap: true } };
    const unnamed = { requestPayload: { bookingId: "booking_1", recordPayment: true } };
    await expect(bookingHasPaidUnnamedSupplementary(store({ supplementaries: [named, unpaid, gap] }) as never, "booking_1")).resolves.toBe(false);
    const db = store({ supplementaries: [named, unnamed] });
    await expect(bookingHasPaidUnnamedSupplementary(db as never, "booking_1")).resolves.toBe(true);
    expect(db.xeroSyncOperation.findMany).toHaveBeenCalledWith({
      where: { queueType: "SUPPLEMENTARY_INVOICE", status: { not: "CANCELLED" }, requestPayload: { path: ["bookingId"], equals: "booking_1" } },
      select: { requestPayload: true },
    });
  });
});

describe("bookingHasPaidUnnamedSupplementary - an invoice from before #3641 (rounds 9 and 11)", () => {
  const modifications = [{ id: "mod_old" }];
  const paymentLinks = [{ localId: "mod_old" }];

  it("MUTATION round 11: a change's paid invoice whose queued row names its capture, or marks a gap invoice, leaves the receipt free", async () => {
    for (const requestPayload of [
      { queueType: "SUPPLEMENTARY_INVOICE", paymentIntentId: "pi_named" },
      { queueType: "SUPPLEMENTARY_INVOICE", primaryInvoiceGap: true, coveredPaymentIntentIds: [] },
    ]) {
      const db = store({ modifications, paymentLinks, queuedOnChanges: [{ localId: "mod_old", requestPayload }] });
      await expect(bookingHasPaidUnnamedSupplementary(db as never, "booking_1")).resolves.toBe(false);
    }
  });

  it("MUTATION: a flattened invoice from before #3641 - its payment linked, no queued row saying what it records - still refuses", async () => {
    for (const queuedOnChanges of [[], [{ localId: "mod_old", requestPayload: { invoices: [{ lineItems: [] }] } }]]) {
      const db = store({ modifications, paymentLinks, queuedOnChanges });
      await expect(bookingHasPaidUnnamedSupplementary(db as never, "booking_1")).resolves.toBe(true);
      expect(db.xeroObjectLink.findMany).toHaveBeenCalledWith({
        where: { localModel: "BookingModification", localId: { in: ["mod_old"] }, role: "SUPPLEMENTARY_INVOICE_PAYMENT", active: true },
        select: { localId: true },
      });
      expect(db.xeroSyncOperation.findMany).toHaveBeenCalledWith({
        where: { queueType: "SUPPLEMENTARY_INVOICE", localModel: "BookingModification", localId: { in: ["mod_old"] }, status: { not: "CANCELLED" } },
        select: { localId: true, requestPayload: true },
      });
    }
    await expect(bookingHasPaidUnnamedSupplementary(store({ modifications }) as never, "booking_1")).resolves.toBe(false);
  });
});

describe("anchorCaptureHasReceipt", () => {
  it("asks about the change's stamped and review-charge captures and the named one - never the booking's unattributed ones (round 9)", async () => {
    const db = store({ captures: [{ id: "tx_1" }], link: { id: "link_1" } });
    await expect(
      anchorCaptureHasReceipt(db as never, { bookingId: "booking_1", bookingModificationId: "mod_1", paymentIntentId: "pi_1" }),
    ).resolves.toBe(true);
    expect(db.paymentTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          kind: "ADDITIONAL",
          OR: [
            { bookingModificationId: "mod_1" },
            { reason: buildEditFinancialReviewChargeReason("mod_1") },
            { stripePaymentIntentId: "pi_1" },
          ],
        },
      }),
    );
  });

  it("MUTATION round 9: asks about the booking's unattributed captures only for an invoice naming no capture", async () => {
    const db = store({});
    await anchorCaptureHasReceipt(db as never, { bookingId: "booking_1", bookingModificationId: "mod_1", paymentIntentId: null });
    expect(db.paymentTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          kind: "ADDITIONAL",
          OR: [{ bookingModificationId: "mod_1" }, { reason: buildEditFinancialReviewChargeReason("mod_1") }, UNATTRIBUTED],
        },
      }),
    );
  });

  it("asks only about the unattributed captures where the invoice names no change and no capture", async () => {
    const db = store({});
    await expect(
      anchorCaptureHasReceipt(db as never, { bookingId: "booking_1", bookingModificationId: null, paymentIntentId: null }),
    ).resolves.toBe(false);
    expect(db.paymentTransaction.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { kind: "ADDITIONAL", OR: [UNATTRIBUTED] } }));
    expect(db.xeroObjectLink.findFirst).not.toHaveBeenCalled();
  });

  it("round 12: with decidedOnly, counts a stored plan or a link, never a bare RUNNING row", async () => {
    const input = { bookingId: "booking_1", bookingModificationId: "mod_1", paymentIntentId: null };
    const captures = [{ id: "tx_1" }];
    const decidedOnly = { decidedOnly: true };
    await expect(anchorCaptureHasReceipt(store({ captures, receipts: [{ status: "RUNNING", requestPayload: {} }] }) as never, input, decidedOnly)).resolves.toBe(false);
    await expect(
      anchorCaptureHasReceipt(store({ captures, receipts: [{ status: "RUNNING", requestPayload: { plan: { invoiceId: "inv_1" } } }] }) as never, input, decidedOnly),
    ).resolves.toBe(true);
    await expect(anchorCaptureHasReceipt(store({ captures, link: { id: "link_1" } }) as never, input, decidedOnly)).resolves.toBe(true);
  });

  it("MUTATION #4324 (INV-PAY-144): counts a kept late capture's own invoice naming one of the captures, in both modes", async () => {
    const input = { bookingId: "booking_1", bookingModificationId: "mod_1", paymentIntentId: "pi_kept" };
    const captures = [{ id: "tx_1", stripePaymentIntentId: "pi_kept" }];
    const kept = [{ queueType: "KEPT_LATE_CAPTURE_INVOICE" }];
    await expect(anchorCaptureHasReceipt(store({ captures, kept }) as never, input)).resolves.toBe(true);
    await expect(anchorCaptureHasReceipt(store({ captures, kept }) as never, input, { decidedOnly: true })).resolves.toBe(true);
    await expect(anchorCaptureHasReceipt(store({ captures }) as never, input)).resolves.toBe(false);
    const db = store({ captures, kept });
    await anchorCaptureHasReceipt(db as never, input);
    expect(db.xeroSyncOperation.findMany).toHaveBeenCalledWith({
      where: {
        queueType: "KEPT_LATE_CAPTURE_INVOICE",
        status: { not: "CANCELLED" },
        OR: [{ requestPayload: { path: ["paymentIntentId"], equals: "pi_kept" } }],
      },
      select: { queueType: true },
    });
  });

  it("MUTATION #4324 item 11: a change is billed by a live kept-capture invoice naming one of its captures, read by its stamp or review reason", async () => {
    const captures = [{ id: "tx_1", stripePaymentIntentId: "pi_kept" }];
    const db = store({ captures, kept: [{ queueType: "KEPT_LATE_CAPTURE_INVOICE" }] });
    await expect(keptInvoiceBillsChangeCapture(db as never, "mod_1")).resolves.toBe(true);
    expect(db.paymentTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: "ADDITIONAL",
          OR: [{ bookingModificationId: "mod_1" }, { reason: buildEditFinancialReviewChargeReason("mod_1") }],
        }),
      }),
    );
    await expect(keptInvoiceBillsChangeCapture(store({ captures }) as never, "mod_1")).resolves.toBe(false);
    await expect(keptInvoiceBillsChangeCapture(store({ kept: [{ queueType: "KEPT_LATE_CAPTURE_INVOICE" }] }) as never, "mod_1")).resolves.toBe(false);
  });

  it("#3403 review 2 (F6): with queuedCounts, a receipt that will still run counts - queued, or failed before deciding and not resolved by hand", async () => {
    const input = { bookingId: "booking_1", bookingModificationId: null, paymentIntentId: "pi_carrier" };
    const captures = [{ id: "tx_1" }];
    const queuedCounts = { queuedCounts: true };
    const has = (receipt: { status: string; manuallyResolvedAt?: Date | null }) =>
      anchorCaptureHasReceipt(store({ captures, receipts: [{ requestPayload: {}, manuallyResolvedAt: null, ...receipt }] }) as never, input, queuedCounts);
    await expect(has({ status: "PENDING" })).resolves.toBe(true);
    await expect(has({ status: "WAITING_PAYMENT" })).resolves.toBe(true);
    await expect(has({ status: "FAILED" })).resolves.toBe(true);
    await expect(has({ status: "PARTIAL" })).resolves.toBe(true);
    await expect(has({ status: "FAILED", manuallyResolvedAt: new Date() })).resolves.toBe(false);
    await expect(has({ status: "SUCCEEDED" })).resolves.toBe(false);
    // Without the option the old answer stands: a PENDING row with no plan is not a recorder.
    await expect(
      anchorCaptureHasReceipt(store({ captures, receipts: [{ status: "PENDING", requestPayload: {}, manuallyResolvedAt: null }] }) as never, input),
    ).resolves.toBe(false);
  });

  it("counts a RUNNING row or a stored plan, never a PENDING row with no plan", async () => {
    const input = { bookingId: "booking_1", bookingModificationId: "mod_1", paymentIntentId: null };
    const captures = [{ id: "tx_1" }];
    await expect(anchorCaptureHasReceipt(store({ captures, receipts: [{ status: "PENDING", requestPayload: {} }] }) as never, input)).resolves.toBe(false);
    await expect(anchorCaptureHasReceipt(store({ captures, receipts: [{ status: "RUNNING", requestPayload: {} }] }) as never, input)).resolves.toBe(true);
    await expect(
      anchorCaptureHasReceipt(store({ captures, receipts: [{ status: "PENDING", requestPayload: { plan: { invoiceId: "inv_1" } } }] }) as never, input),
    ).resolves.toBe(true);
  });
});
