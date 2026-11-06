import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { postBookingConfirmationLedgerLines } from "@/lib/booking-ledger-confirmation-sync";
import type { ConfirmationPostingBooking } from "@/lib/booking-ledger-confirmation-posting";
import { memberMoneyTestContext } from "./support/member-money-fixtures";

// #4627: the journal half is proven on PostgreSQL (`booking-ledger-journal.realdb.test.ts`); here, that it is called.
const journalPost = vi.hoisted(() => vi.fn(async () => null));
vi.mock("@/lib/member-money/doors", () => ({ postBookingLedgerJournal: journalPost }));
const journal = memberMoneyTestContext();

const booking: ConfirmationPostingBooking = {
  id: "confirmation-sync-booking", lodgeId: "confirmation-sync-lodge", totalPriceCents: 6000, promoAdjustmentCents: 0,
  guests: [{ id: "confirmation-sync-guest", firstName: "Test", lastName: "Guest", ageTier: "ADULT", rateMembershipTypeId: null,
    nights: [{ stayDate: new Date("2026-09-01T00:00:00.000Z"), priceCents: 6000 }] }],
};

function store(confirmed = false) {
  const createMany = vi.fn().mockImplementation(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
  const tx = { bookingLedgerLine: { findFirst: vi.fn().mockResolvedValue(confirmed ? { id: "old-confirmation" } : null), createMany } };
  return { tx: tx as unknown as Prisma.TransactionClient, createMany };
}

describe("the shared PAID confirmation poster (INV-PAY-047)", () => {
  it("posts the stored charge with its original confirmation keys", async () => {
    const db = store();
    await postBookingConfirmationLedgerLines(db.tx, booking, journal);
    expect(db.createMany).toHaveBeenCalledWith(expect.objectContaining({ data: [expect.objectContaining({
      bookingId: booking.id, kind: "GUEST_NIGHT", amountCents: 6000, anchorKind: "CONFIRMATION", anchorId: booking.id,
    })], skipDuplicates: true }));
    // #4627 (R01): the same lines, by their keys, into the journal in the same transaction.
    expect(journalPost).toHaveBeenCalledWith(db.tx, journal, {
      bookingId: booking.id, lodgeId: booking.lodgeId, event: { kind: "confirmation" },
      postingKeys: ["confirmation:confirmation-sync-booking:night:confirmation-sync-guest:2026-09-01"],
    });
  });
  it("keeps the existing per-booking fence even if guest/night ids change", async () => {
    const db = store(true);
    journalPost.mockClear();
    await postBookingConfirmationLedgerLines(db.tx, booking, journal);
    expect(db.createMany).not.toHaveBeenCalled();
    expect(journalPost).not.toHaveBeenCalled();
  });
  it("propagates a database write failure so the caller's PAID transaction rolls back", async () => {
    const db = store();
    db.createMany.mockRejectedValueOnce(new Error("synthetic statement refusal"));
    await expect(postBookingConfirmationLedgerLines(db.tx, booking, journal)).rejects.toThrow("synthetic statement refusal");
  });
});
