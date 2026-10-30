import type { BookingModification, Prisma } from "@prisma/client";
import { paidByOrganiserInternetBanking } from "@/lib/group-organiser-paid";
import { enqueueOrganiserExtraInvoiceInTransaction } from "@/lib/xero-operation-outbox";

/** Queue with the change, under its existing global lock, so provider outages cannot lose the bill. */
export async function queueOrganiserExtraForChange(
  tx: Prisma.TransactionClient,
  booking: Parameters<typeof paidByOrganiserInternetBanking>[0] & { id: string },
  change: Pick<BookingModification, "id" | "memberId" | "priceDiffCents" | "changeFeeCents">,
): Promise<void> {
  if (!paidByOrganiserInternetBanking(booking) || change.priceDiffCents + change.changeFeeCents <= 0) return;
  await enqueueOrganiserExtraInvoiceInTransaction({
    bookingId: booking.id,
    bookingModificationId: change.id,
    priceDiffCents: change.priceDiffCents,
    changeFeeCents: change.changeFeeCents,
    createdByMemberId: change.memberId,
  }, tx);
}
