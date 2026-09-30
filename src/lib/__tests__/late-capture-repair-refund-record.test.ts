import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/**
 * #3635 (N4): the repair tool's record-and-note says, per intent, what really
 * happened, so the operator's result message claims no record and no note that
 * was not written, and a suspected double payment is escalated as the webhook
 * escalates it.
 */
const mocks = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  transactionFindFirst: vi.fn(),
  record: vi.fn(),
  announce: vi.fn(),
  readReceipt: vi.fn(),
  note: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: mocks.bookingFindUnique },
    paymentTransaction: { findFirst: mocks.transactionFindFirst },
  },
}));
vi.mock("@/lib/cancelled-booking-late-capture", () => ({
  recordAutomaticLateCaptureRefund: mocks.record,
  announceAutomaticLateCaptureRefund: mocks.announce,
}));
vi.mock("@/lib/late-capture-xero-receipt", () => ({
  readLateCaptureXeroReceipt: mocks.readReceipt,
}));
vi.mock("@/lib/late-capture-refund-credit-note", () => ({
  noteLateCaptureRefunds: mocks.note,
}));

import { recordAndNoteRepairedLateCaptureRefunds } from "@/lib/late-capture-repair-refund-record";

const run = (intents: string[]) =>
  recordAndNoteRepairedLateCaptureRefunds({
    bookingId: "booking_1",
    paymentId: "payment_1",
    refunds: intents.map((paymentIntentId) => ({ paymentIntentId, amountCents: 1000 })),
    format: CLUB_FORMAT_TEST,
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bookingFindUnique.mockResolvedValue({
    memberId: "member_1",
    member: { firstName: "Ann", lastName: "Lee" },
    organisation: null,
    checkIn: new Date("2026-08-01"),
    checkOut: new Date("2026-08-03"),
    deletedAt: null,
  });
  mocks.transactionFindFirst.mockResolvedValue({ kind: "PRIMARY" });
  mocks.record.mockResolvedValue({ bookingDeleted: false, recorded: true, handCompletedAfterRefund: false });
  mocks.announce.mockResolvedValue(undefined);
  mocks.readReceipt.mockResolvedValue({ kind: "recorded" });
  mocks.note.mockResolvedValue("queued");
});

describe("recordAndNoteRepairedLateCaptureRefunds (#3635 N4)", () => {
  it("a lost record is reported, and that intent is never noted", async () => {
    mocks.record
      .mockResolvedValueOnce({ bookingDeleted: false, recorded: false, handCompletedAfterRefund: false })
      .mockResolvedValueOnce({ bookingDeleted: false, recorded: true, handCompletedAfterRefund: false });

    const outcome = await run(["pi_lost", "pi_ok"]);

    expect(outcome.recordFailed).toEqual(["pi_lost"]);
    expect(outcome.noted).toEqual(["pi_ok"]);
    expect(mocks.note).toHaveBeenCalledTimes(1);
    expect(mocks.note).toHaveBeenCalledWith({ paymentId: "payment_1", paymentIntentId: "pi_ok" });
    expect(mocks.readReceipt).not.toHaveBeenCalledWith("pi_lost");
  });

  it("reports noted only for a queued note: nothing owed and a failed enqueue are their own lists", async () => {
    mocks.note.mockResolvedValueOnce("nothing-owed").mockResolvedValueOnce("failed");

    const outcome = await run(["pi_covered", "pi_failed"]);

    expect(outcome.noted).toEqual([]);
    expect(outcome.alreadyNoted).toEqual(["pi_covered"]);
    expect(outcome.noteFailed).toEqual(["pi_failed"]);
  });

  it("escalates a suspected double payment through the webhook's own announcement, and only then", async () => {
    const conflict = { bookingDeleted: false, recorded: true, handCompletedAfterRefund: true };
    mocks.record
      .mockResolvedValueOnce(conflict)
      .mockResolvedValueOnce({ bookingDeleted: false, recorded: true, handCompletedAfterRefund: false });

    const outcome = await run(["pi_twice", "pi_once"]);

    expect(outcome.doubleRefundSuspected).toEqual(["pi_twice"]);
    expect(mocks.announce).toHaveBeenCalledTimes(1);
    expect(mocks.announce).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: "pi_twice", bookingId: "booking_1" }),
      conflict,
      CLUB_FORMAT_TEST,
    );
  });

  it("an escalation that throws does not stop the record-and-note", async () => {
    mocks.record.mockResolvedValue({ bookingDeleted: false, recorded: true, handCompletedAfterRefund: true });
    mocks.announce.mockRejectedValue(new Error("mail down"));

    const outcome = await run(["pi_twice"]);

    expect(outcome.doubleRefundSuspected).toEqual(["pi_twice"]);
    expect(outcome.noted).toEqual(["pi_twice"]);
  });
});
