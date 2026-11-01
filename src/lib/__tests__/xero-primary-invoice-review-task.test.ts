import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  xeroSyncOperation: { findFirst: vi.fn(), create: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: { xeroSyncOperation: mocks.xeroSyncOperation } }));
vi.mock("@/lib/club-format-settings", async () => {
  const { CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture");
  return { getClubFormat: vi.fn(async () => CLUB_FORMAT_TEST) };
});

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

import {
  primaryInvoiceReviewCorrelationKey,
  primaryInvoiceReviewMessage,
  raisePrimaryInvoiceReviewTask,
} from "@/lib/xero-primary-invoice-review-task";

/**
 * #3980: a gap the primary invoice's check cannot bill automatically becomes a
 * Xero Operations task - a FAILED, non-replayable operation the treasurer
 * resolves in Xero - raised once per invoice and direction.
 */
describe("the primary invoice's Xero Operations task (#3980)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.xeroSyncOperation.findFirst.mockResolvedValue(null);
    mocks.xeroSyncOperation.create.mockResolvedValue({ id: "op_review" });
  });

  it("is a failed, non-replayable operation on the booking, with its own types and key", async () => {
    await expect(
      raisePrimaryInvoiceReviewTask({
        kind: "OVERBILLED",
        bookingId: "booking_12345678",
        xeroInvoiceId: "inv_1",
        gapCents: -5_000,
        figures: { worthCentsAtLink: 25_000 },
        createdByMemberId: "member_1",
      }),
    ).resolves.toEqual({ operationId: "op_review", alreadyRaised: false });
    expect(mocks.xeroSyncOperation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        direction: "OUTBOUND",
        entityType: "REVIEW",
        operationType: "PRIMARY_INVOICE_WORTH_GAP",
        localModel: "Booking",
        localId: "booking_12345678",
        status: "FAILED",
        replayable: false,
        correlationKey: "primary-invoice-review:overbilled:booking_12345678:inv_1",
        lastErrorCode: "PRIMARY_INVOICE_OVERBILLED",
        lastErrorMessage: expect.stringContaining("bills $50.00 more than the booking is worth"),
        createdByMemberId: "member_1",
      }),
      select: { id: true },
    });
    // Never an idempotency key, so it is never counted as an attempt of the create.
    expect(mocks.xeroSyncOperation.create.mock.calls[0][0].data).not.toHaveProperty("idempotencyKey");
  });

  it("is raised once: a re-run finds the first and writes nothing", async () => {
    mocks.xeroSyncOperation.findFirst.mockResolvedValue({ id: "op_first" });
    await expect(
      raisePrimaryInvoiceReviewTask({
        kind: "UNDERBILLED",
        bookingId: "booking_1",
        xeroInvoiceId: "inv_1",
        gapCents: 8_000,
        figures: {},
      }),
    ).resolves.toEqual({ operationId: "op_first", alreadyRaised: true });
    expect(mocks.xeroSyncOperation.findFirst).toHaveBeenCalledWith({
      where: {
        correlationKey: "primary-invoice-review:underbilled:booking_1:inv_1",
        entityType: "REVIEW",
        operationType: "PRIMARY_INVOICE_WORTH_GAP",
      },
      select: { id: true },
    });
    expect(mocks.xeroSyncOperation.create).not.toHaveBeenCalled();
  });

  it("tells the treasurer what to do in each direction, in plain figures", () => {
    expect(primaryInvoiceReviewCorrelationKey({ bookingId: "b", xeroInvoiceId: "i", kind: "UNDERBILLED" })).toBe(
      "primary-invoice-review:underbilled:b:i",
    );
    expect(primaryInvoiceReviewMessage({ kind: "OVERBILLED", bookingId: "abcdefgh-1", gapCents: -5_000 }, CLUB_FORMAT_TEST)).toBe(
      "The primary Xero invoice for Booking abcdefgh bills $50.00 more than the booking is worth: the booking was changed while the invoice was being raised. Check the invoice and raise a credit note for $50.00 in Xero if one is due, then choose Resolve (fixed in Xero).",
    );
    // Review M5: how the reduction behind an overcharge settled, so its refund is accounted for too.
    expect(
      primaryInvoiceReviewMessage(
        {
          kind: "OVERBILLED",
          bookingId: "abcdefgh-1",
          gapCents: -5_000,
          settledBy: { refundAmountCents: 3_000, accountCreditAmountCents: 0, appliedCreditGivenBackCents: 0, unpaidAskOffsetCents: 2_000 },
        },
        CLUB_FORMAT_TEST,
      ),
    ).toContain("The change was settled by a refund of $30.00 paid out, $20.00 taken off an unpaid payment request; account for that too.");
    expect(primaryInvoiceReviewMessage({ kind: "UNDERBILLED", bookingId: "abcdefgh-1", gapCents: 8_000 }, CLUB_FORMAT_TEST)).toContain(
      "bills $80.00 less than the booking is worth",
    );
    // #4324 (`INV-PAY-144`): the change that would carry it is billed by a kept late capture's own invoice.
    expect(
      primaryInvoiceReviewMessage({ kind: "UNDERBILLED", bookingId: "abcdefgh-1", gapCents: 8_000, keptInvoiceBillsChange: true }, CLUB_FORMAT_TEST),
    ).toBe(
      "The primary Xero invoice for Booking abcdefgh bills $80.00 less than the booking is worth: the booking was changed while the invoice was being raised, and the change that would carry the difference is already billed by the Xero invoice for a late card payment the club kept. Check both invoices and bill in Xero whatever part of $80.00 that invoice does not already bill, then choose Resolve (fixed in Xero).",
    );
  });
});
