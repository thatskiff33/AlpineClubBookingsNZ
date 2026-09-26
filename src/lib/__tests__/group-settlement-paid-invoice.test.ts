import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Invoice } from "xero-node";

/**
 * #3642 (`INV-PAY-105`): the bank-transfer arm of an organiser-pays group
 * settlement. A paid combined invoice settles the group only for exactly the
 * settlement's total, and a paid invoice that can settle nothing — one the
 * settlement abandoned, or one landing on a settlement a card already paid —
 * alerts the operators instead of being kept without a word.
 */

const mocks = vi.hoisted(() => ({
  settlementFindFirst: vi.fn(),
  settlementFindUnique: vi.fn(),
  linkFindFirst: vi.fn(),
  cooldownUpdateMany: vi.fn(),
  cooldownCreate: vi.fn(),
  applyFromInvoice: vi.fn(),
  sendAdminPaymentFailureAlert: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    groupBookingSettlement: {
      findFirst: mocks.settlementFindFirst,
      findUnique: mocks.settlementFindUnique,
    },
    xeroObjectLink: { findFirst: mocks.linkFindFirst },
    alertCooldown: {
      updateMany: mocks.cooldownUpdateMany,
      create: mocks.cooldownCreate,
    },
  },
}));
vi.mock("@/lib/group-settlement", () => ({
  applyGroupSettlementSucceededFromInvoice: mocks.applyFromInvoice,
}));
vi.mock("@/lib/email", () => ({
  sendAdminPaymentFailureAlert: mocks.sendAdminPaymentFailureAlert,
  sendAdminManualSettlementConflictAlert: vi.fn(),
  sendBookingCancelledEmail: vi.fn(),
  sendBookingConfirmedEmail: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { syncGroupSettlementForPaidInvoice } from "@/lib/xero-inbound/invoice-paid-effects";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

function paidInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    invoiceID: "xinv_1",
    status: "PAID",
    fullyPaidOnDate: "2026-07-02",
    amountPaid: 600,
    ...overrides,
  } as Invoice;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settlementFindFirst.mockResolvedValue(null);
  mocks.linkFindFirst.mockResolvedValue(null);
  mocks.cooldownUpdateMany.mockResolvedValue({ count: 0 });
  mocks.cooldownCreate.mockResolvedValue({});
  mocks.sendAdminPaymentFailureAlert.mockResolvedValue(undefined);
  mocks.settlementFindUnique.mockResolvedValue({
    amountCents: 80000,
    groupBooking: {
      organiserMember: { firstName: "Olive", lastName: "Organiser" },
      organiserBooking: { checkIn: new Date("2026-08-01"), checkOut: new Date("2026-08-03") },
    },
  });
});

describe("syncGroupSettlementForPaidInvoice (#3642)", () => {
  it("hands the invoice's cash to the settle, which judges it under the lock", async () => {
    mocks.settlementFindFirst.mockResolvedValue({
      id: "settle-1",
      status: "PENDING",
      stripePaymentIntentId: null,
    });
    mocks.applyFromInvoice.mockResolvedValue({ outcome: "settled", settledBookingIds: ["c1", "c2"] });

    const result = await syncGroupSettlementForPaidInvoice(paidInvoice(), CLUB_FORMAT_TEST);

    expect(mocks.applyFromInvoice).toHaveBeenCalledWith("xinv_1", CLUB_FORMAT_TEST, {
      collectedCents: 60000,
    });
    expect(result).toMatchObject({ settledGroupSettlements: 1, settledChildBookings: 2 });
  });

  it("alerts with both figures when the invoice was paid for less than the settlement (scenario A)", async () => {
    mocks.settlementFindFirst.mockResolvedValue({
      id: "settle-1",
      status: "PENDING",
      stripePaymentIntentId: null,
    });
    mocks.applyFromInvoice.mockResolvedValue({
      outcome: "amount_mismatch",
      settledBookingIds: [],
      mismatch: { reason: "collected", recordedCents: 80000, collectedCents: 60000, childrenCents: null },
    });

    const result = await syncGroupSettlementForPaidInvoice(paidInvoice(), CLUB_FORMAT_TEST);

    expect(result.settledGroupSettlements).toBe(0);
    expect(mocks.sendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
    const [alert] = mocks.sendAdminPaymentFailureAlert.mock.calls[0];
    expect(alert).toMatchObject({ memberName: "Olive Organiser", paymentIntentId: "xinv_1" });
    expect(alert.errorMessage).toMatch(/was paid \$600\.00, but the settlement it pays is \$800\.00/);
  });

  it("refuses to settle a whole group on a cash figure it could not read exactly", async () => {
    mocks.settlementFindFirst.mockResolvedValue({
      id: "settle-1",
      status: "PENDING",
      stripePaymentIntentId: null,
    });

    await syncGroupSettlementForPaidInvoice(
      paidInvoice({
        amountPaid: undefined,
        payments: [{ amount: "six hundred" as unknown as number, status: "AUTHORISED" } as never],
      }),
      CLUB_FORMAT_TEST
    );

    expect(mocks.applyFromInvoice).not.toHaveBeenCalled();
    expect(mocks.sendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
  });

  it("alerts when a paid invoice lands on a settlement a card already paid (scenario B)", async () => {
    mocks.settlementFindFirst.mockResolvedValue({
      id: "settle-1",
      status: "SUCCEEDED",
      stripePaymentIntentId: "pi_card",
    });

    await syncGroupSettlementForPaidInvoice(paidInvoice(), CLUB_FORMAT_TEST);

    expect(mocks.applyFromInvoice).not.toHaveBeenCalled();
    expect(mocks.sendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
    expect(mocks.sendAdminPaymentFailureAlert.mock.calls[0][0].errorMessage).toMatch(/paid twice/);
    expect(mocks.cooldownCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ key: "group-settlement-invoice-conflict:settle-1:xinv_1" }),
    });
  });

  it("stays quiet on a re-fetch of the invoice that settled the group", async () => {
    mocks.settlementFindFirst.mockResolvedValue({
      id: "settle-1",
      status: "SUCCEEDED",
      stripePaymentIntentId: null,
    });

    await syncGroupSettlementForPaidInvoice(paidInvoice(), CLUB_FORMAT_TEST);

    expect(mocks.applyFromInvoice).not.toHaveBeenCalled();
    expect(mocks.sendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  it("recognises a payment on an invoice the settlement abandoned, and alerts once per window", async () => {
    mocks.linkFindFirst.mockResolvedValue({ localId: "settle-1" });

    const first = await syncGroupSettlementForPaidInvoice(paidInvoice(), CLUB_FORMAT_TEST);
    // The cooldown row now exists and is fresh: a re-fetch stays quiet.
    mocks.cooldownCreate.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
    );
    await syncGroupSettlementForPaidInvoice(paidInvoice(), CLUB_FORMAT_TEST);

    expect(first.matchedGroupSettlements).toBe(1);
    expect(mocks.linkFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ xeroObjectId: "xinv_1", role: "GROUP_SETTLEMENT_INVOICE" }),
      })
    );
    expect(mocks.applyFromInvoice).not.toHaveBeenCalled();
    expect(mocks.sendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
    expect(mocks.sendAdminPaymentFailureAlert.mock.calls[0][0].errorMessage).toMatch(
      /after the settlement stopped using it/
    );
  });

  it("keeps a stable mismatch quiet on the next re-fetch of the same paid invoice", async () => {
    mocks.settlementFindFirst.mockResolvedValue({
      id: "settle-1",
      status: "PENDING",
      stripePaymentIntentId: null,
    });
    mocks.applyFromInvoice.mockResolvedValue({
      outcome: "amount_mismatch",
      settledBookingIds: [],
      mismatch: { reason: "collected", recordedCents: 80000, collectedCents: 60000, childrenCents: null },
    });

    await syncGroupSettlementForPaidInvoice(paidInvoice(), CLUB_FORMAT_TEST);
    mocks.cooldownCreate.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
    );
    await syncGroupSettlementForPaidInvoice(paidInvoice(), CLUB_FORMAT_TEST);

    expect(mocks.applyFromInvoice).toHaveBeenCalledTimes(2);
    expect(mocks.sendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
    expect(mocks.cooldownCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ key: "group-settlement-invoice-conflict:settle-1:xinv_1" }),
    });
  });

  it("reads a payment on a cancelled group's retired invoice as paid after the cancel", async () => {
    mocks.linkFindFirst.mockResolvedValue({ localId: "settle-1" });
    mocks.settlementFindUnique.mockImplementation(async (args: { select?: Record<string, unknown> }) =>
      args.select && "amountCents" in args.select
        ? {
            amountCents: 80000,
            groupBooking: {
              organiserMember: { firstName: "Olive", lastName: "Organiser" },
              organiserBooking: { checkIn: new Date("2026-08-01"), checkOut: new Date("2026-08-03") },
            },
          }
        : { groupBooking: { status: "CANCELLED" } }
    );

    await syncGroupSettlementForPaidInvoice(paidInvoice(), CLUB_FORMAT_TEST);

    expect(mocks.sendAdminPaymentFailureAlert.mock.calls[0][0].errorMessage).toMatch(
      /paid after the organiser cancelled the group/
    );
  });

  it("does not alert on the zero-cash clearing of an abandoned invoice", async () => {
    mocks.linkFindFirst.mockResolvedValue({ localId: "settle-1" });

    await syncGroupSettlementForPaidInvoice(paidInvoice({ amountPaid: 0 }), CLUB_FORMAT_TEST);

    expect(mocks.sendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  it("leaves an invoice that belongs to no group settlement alone", async () => {
    const result = await syncGroupSettlementForPaidInvoice(paidInvoice(), CLUB_FORMAT_TEST);

    expect(result.matchedGroupSettlements).toBe(0);
    expect(mocks.sendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });
});
