import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.hoisted(() => vi.fn());
const findTasks = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: { xeroSyncOperation: { findMany }, manualRefundTask: { findMany: findTasks } } }));

import {
  invoiceCorrectionNoteIds,
  noCashModificationNoteIds,
  readModificationNoteCash,
} from "@/lib/xero-inbound/account-credit-modification-notes";
import { UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE } from "@/lib/xero-review-task-key";

/**
 * Which modification credit notes moved no cash, so never fold into a
 * payment's refunded total. #3979 (`INV-PAY-125`) adds the invoice correction
 * (`INV-PAY-116`) beside #3809's account-credit wording and #3954's
 * billed-offset scope. Read from the wording the note's operation recorded
 * when it was raised.
 */
function operation(xeroObjectId: string, requestPayload: Record<string, unknown>, localModel = "BookingModification") {
  return { xeroObjectId, localId: xeroObjectId, localModel, requestPayload };
}

describe("noCashModificationNoteIds (#3809, #3954, #3979)", () => {
  beforeEach(() => { findMany.mockReset(); findTasks.mockReset().mockResolvedValue([]); });

  it("an unpaid edit hand-back is no cash, but a review on that edit and legacy notes keep their own treatment (#4315)", async () => {
    findMany.mockResolvedValue([
      operation("edit", { refundMethod: "internet-banking" }),
      { ...operation("review", { refundMethod: "internet-banking", reviewTaskId: "review-task" }), localId: "edit" },
      operation("legacy", { refundMethod: "internet-banking" }),
    ]);
    findTasks.mockResolvedValue([{ kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: "edit-refund-hand-back:edit" }]);
    expect(await noCashModificationNoteIds(["edit", "review", "legacy"])).toEqual(new Set(["edit"]));
    expect(findTasks).toHaveBeenCalledWith(expect.objectContaining({ where: {
      occurrenceKey: { in: ["edit-refund-hand-back:edit", "edit-refund-hand-back:legacy"] },
      status: { not: "COMPLETED" },
    } }));
  });

  it("an invoice correction moved no cash; a refund by any method did", async () => {
    findMany.mockResolvedValue([
      operation("cn-correction", { refundAmountCents: 10_000, noteWording: "invoice-correction" }),
      operation("cn-bank", { refundAmountCents: 10_000, refundMethod: "internet-banking" }),
      operation("cn-card", { refundAmountCents: 10_000, refundMethod: "card" }),
      operation("cn-cash", { refundAmountCents: 10_000, refundMethod: "internet-banking", noteWording: "cash" }),
      operation("cn-credit", { refundAmountCents: 10_000, refundMethod: "account-credit" }),
      operation("cn-offset", { refundAmountCents: 10_000, reviewTaskId: UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE }),
      operation("cn-legacy", { refundAmountCents: 10_000 }),
    ]);

    const ids = await noCashModificationNoteIds([
      "cn-correction",
      "cn-bank",
      "cn-card",
      "cn-cash",
      "cn-credit",
      "cn-offset",
      "cn-legacy",
    ]);

    expect([...ids].sort()).toEqual(["cn-correction", "cn-credit", "cn-offset"]);
  });

  it("a clearing note is not a modification note's wording and stays as it was", async () => {
    findMany.mockResolvedValue([
      operation("cn-clearing", { refundAmountCents: 10_000, clearsUnpaidInvoice: true, noteWording: "invoice-correction" }),
    ]);

    // `readModificationNoteWording` reads a clearing note as clearing only,
    // never with a wording beside it.
    expect(await noCashModificationNoteIds(["cn-clearing"])).toEqual(new Set());
  });

  it("asks nothing for no notes", async () => {
    expect(await noCashModificationNoteIds([])).toEqual(new Set());
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("readModificationNoteCash and invoiceCorrectionNoteIds (#3979)", () => {
  beforeEach(() => findMany.mockReset());

  it("classifies the modification notes among applied ones; another kind of note is absent", async () => {
    findMany.mockResolvedValue([
      operation("cn-refund", { refundMethod: "internet-banking" }),
      operation("cn-correction", { noteWording: "invoice-correction" }),
      operation("cn-offset", { noteWording: "invoice-correction", reviewTaskId: UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE }),
      operation("cn-clearing", { clearsUnpaidInvoice: true }, "Booking"),
      operation("cn-account-credit", { refundAmountCents: 1 }, "Payment"),
    ]);

    expect(
      await readModificationNoteCash(["cn-refund", "cn-correction", "cn-offset", "cn-clearing", "cn-account-credit"]),
    ).toEqual(
      new Map([
        ["cn-refund", "refund"],
        ["cn-correction", "correction"],
        ["cn-offset", "no-cash"],
        ["cn-clearing", "refund"],
      ]),
    );
  });

  it("names the invoice corrections whose count depends on the payment - never #3954's billed offset", async () => {
    findMany.mockResolvedValue([
      operation("cn-correction", { noteWording: "invoice-correction" }),
      operation("cn-offset", { noteWording: "invoice-correction", reviewTaskId: UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE }),
    ]);

    expect(await invoiceCorrectionNoteIds(["cn-correction", "cn-offset"])).toEqual(new Set(["cn-correction"]));
  });
});

describe("an account-credit note read for the settle (#3979 final review)", () => {
  beforeEach(() => findMany.mockReset());

  it("MUTATION: an edit's credit kept on account moved no cash, though its payload names no refund method", async () => {
    findMany.mockResolvedValue([
      { xeroObjectId: "cn-edit-credit", localModel: "BookingModification", queueType: "MODIFICATION_ACCOUNT_CREDIT_NOTE", requestPayload: { refundAmountCents: 8000 } },
      { xeroObjectId: "cn-payload-only", localModel: "BookingModification", queueType: null, requestPayload: { queueType: "MODIFICATION_ACCOUNT_CREDIT_NOTE" } },
    ]);

    expect(await readModificationNoteCash(["cn-edit-credit", "cn-payload-only"])).toEqual(
      new Map([
        ["cn-edit-credit", "no-cash"],
        ["cn-payload-only", "no-cash"],
      ]),
    );
  });
});
