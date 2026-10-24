import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { postBookingConfirmationLedgerLines } from "@/lib/booking-ledger-confirmation-sync";
import type { ConfirmationPostingBooking } from "@/lib/booking-ledger-confirmation-posting";

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
    await postBookingConfirmationLedgerLines(db.tx, booking);
    expect(db.createMany).toHaveBeenCalledWith(expect.objectContaining({ data: [expect.objectContaining({
      bookingId: booking.id, kind: "GUEST_NIGHT", amountCents: 6000, anchorKind: "CONFIRMATION", anchorId: booking.id,
    })], skipDuplicates: true }));
  });
  it("keeps the existing per-booking fence even if guest/night ids change", async () => {
    const db = store(true);
    await postBookingConfirmationLedgerLines(db.tx, booking);
    expect(db.createMany).not.toHaveBeenCalled();
  });
  it("propagates a database write failure so the caller's PAID transaction rolls back", async () => {
    const db = store();
    db.createMany.mockRejectedValueOnce(new Error("synthetic statement refusal"));
    await expect(postBookingConfirmationLedgerLines(db.tx, booking)).rejects.toThrow("synthetic statement refusal");
  });
});
