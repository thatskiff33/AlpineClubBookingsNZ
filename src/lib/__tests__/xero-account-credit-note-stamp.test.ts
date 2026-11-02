import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4685: the account-credit note's stamp writes the one credit its row names,
 * by id; a row queued before #4685 names none and falls back to the old match,
 * one credit at a time. Real PostgreSQL proves the same in
 * `xero-account-credit-note-stamp.realdb.test.ts`.
 */
const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { memberCredit: { findFirst: mocks.findFirst, updateMany: mocks.updateMany } },
}));

import { stampCancellationCreditXeroNote } from "@/lib/xero-account-credit-note-stamp";
import { internetBankingLateCashCreditDescription, isInternetBankingLateCashCredit } from "@/lib/internet-banking-late-cash-credit";

const base = { memberId: "member_1", bookingId: "booking_1234567890", refundAmountCents: 5000, creditNoteId: "cn_1" };
const owned = { memberId: "member_1", sourceBookingId: "booking_1234567890", type: "CANCELLATION_REFUND" };

describe("stampCancellationCreditXeroNote (#4685)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirst.mockResolvedValue(null);
    mocks.updateMany.mockResolvedValue({ count: 1 });
  });

  it("MUTATION: a named credit is stamped by its id, under the null guard, and no other row is matched", async () => {
    await expect(stampCancellationCreditXeroNote({ ...base, memberCreditId: "credit_b" })).resolves.toBe("credit_b");

    // The one read is the holder check: no candidate search on the id path.
    expect(mocks.findFirst).toHaveBeenCalledTimes(1);
    expect(mocks.findFirst).toHaveBeenCalledWith({ where: { ...owned, xeroCreditNoteId: "cn_1" }, select: { id: true } });
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "credit_b", ...owned, amountCents: 5000, xeroCreditNoteId: null },
      data: { xeroCreditNoteId: "cn_1" },
    });
  });

  it("a named credit that already names a note is left alone, and nothing else takes this one", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await expect(stampCancellationCreditXeroNote({ ...base, memberCreditId: "credit_b" })).resolves.toBeNull();
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
  });

  it("a note already on one of the booking's cancellation credits never stamps a second", async () => {
    mocks.findFirst.mockResolvedValueOnce({ id: "credit_a" });

    await expect(stampCancellationCreditXeroNote({ ...base, memberCreditId: "credit_b" })).resolves.toBeNull();
    await expect(stampCancellationCreditXeroNote(base)).resolves.toBeNull();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("MUTATION: a row queued before #4685 falls back to the old match, oldest credit first, and stamps one", async () => {
    mocks.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "credit_a" });

    await expect(stampCancellationCreditXeroNote(base)).resolves.toBe("credit_a");

    expect(mocks.findFirst).toHaveBeenLastCalledWith({
      where: {
        ...owned,
        amountCents: 5000,
        description: {
          in: [
            "Cancellation refund for booking booking_",
            "Internet Banking payment credit for booking booking_",
            "Internet Banking payment credit for cancelled booking booking_",
          ],
        },
        xeroCreditNoteId: null,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.updateMany).toHaveBeenCalledWith({ where: { id: "credit_a", xeroCreditNoteId: null }, data: { xeroCreditNoteId: "cn_1" } });
  });

  it("MUTATION (PR #4706 review): a fallback pass that lost its candidate to THIS note stops - the note is never put on a second credit", async () => {
    mocks.findFirst
      .mockResolvedValueOnce(null) // holder check
      .mockResolvedValueOnce({ id: "credit_a" })
      .mockResolvedValueOnce({ id: "credit_a" }); // holder check: a concurrent writer stamped cn_1 on credit_a
    mocks.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(stampCancellationCreditXeroNote(base)).resolves.toBeNull();
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.findFirst).toHaveBeenNthCalledWith(3, { where: { ...owned, xeroCreditNoteId: "cn_1" }, select: { id: true } });
  });

  it("the fallback moves to the next candidate when another writer stamped the first with another note, and stops when none is left", async () => {
    mocks.findFirst
      .mockResolvedValueOnce(null) // holder check
      .mockResolvedValueOnce({ id: "credit_a" })
      .mockResolvedValueOnce(null) // holder check: credit_a took some other note
      .mockResolvedValueOnce({ id: "credit_b" })
      .mockResolvedValueOnce(null);
    mocks.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

    await expect(stampCancellationCreditXeroNote(base)).resolves.toBe("credit_b");
    expect(mocks.updateMany).toHaveBeenCalledTimes(2);

    vi.clearAllMocks();
    mocks.findFirst.mockResolvedValue(null);
    await expect(stampCancellationCreditXeroNote(base)).resolves.toBeNull();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});

describe("internetBankingLateCashCreditDescription (PR #4706 review)", () => {
  it("spells the pipeline's two descriptions once, under the prefix its readers key on", () => {
    expect(internetBankingLateCashCreditDescription("booking_1234567890", { bookingCancelled: false })).toBe("Internet Banking payment credit for booking booking_");
    expect(internetBankingLateCashCreditDescription("booking_1234567890", { bookingCancelled: true })).toBe("Internet Banking payment credit for cancelled booking booking_");
    for (const bookingCancelled of [false, true]) {
      const description = internetBankingLateCashCreditDescription("booking_1234567890", { bookingCancelled });
      expect(isInternetBankingLateCashCredit({ description, type: "CANCELLATION_REFUND" })).toBe(true);
    }
  });
});
