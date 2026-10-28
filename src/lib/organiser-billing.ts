/** Shared organiser payer and combined-invoice resolution (#4299, #4292). */
import type { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api-error";
import { paidByOrganiserInternetBanking } from "@/lib/group-organiser-paid";
import type { findOrCreateXeroContact } from "@/lib/xero-contacts";

export const ORGANISER_COMBINED_INVOICE_MISSING_MESSAGE =
  "The group organiser's combined invoice is not on record, so this booking cannot be changed. Contact the club to restore the invoice record first.";

type OrganiserPlace = Parameters<typeof paidByOrganiserInternetBanking>[0] & { id: string };
type BillingStore = Pick<Prisma.TransactionClient, "groupBooking">;

/**
 * Local reads only: edit callers supply their locked transaction. A refunded
 * settlement remains resolvable for historical repair and later refund notes.
 * The child mirror identifies who paid; absence of its own invoice is expected.
 */
export async function resolveOrganiserBilling(db: BillingStore, booking: OrganiserPlace) {
  if (!paidByOrganiserInternetBanking(booking)) return null;
  const group = await db.groupBooking.findUnique({
    where: { organiserBookingId: booking.parentBookingId! },
    select: {
      organiserBookingId: true,
      organiserMemberId: true,
      organiserMember: true,
      settlement: { select: { id: true, source: true, xeroInvoiceId: true } },
    },
  });
  if (!group?.settlement?.xeroInvoiceId || group.settlement.source !== "INTERNET_BANKING") {
    throw new ApiError(ORGANISER_COMBINED_INVOICE_MISSING_MESSAGE, 409);
  }
  return {
    settlementId: group.settlement.id,
    combinedInvoiceId: group.settlement.xeroInvoiceId,
    organiserMemberId: group.organiserMemberId,
    organiserBookingId: group.organiserBookingId,
    organiser: group.organiserMember,
    placeBookingId: booking.id,
  };
}

export type OrganiserBilling = NonNullable<Awaited<ReturnType<typeof resolveOrganiserBilling>>>;

/** Provider contact lookup/repair; call only outside a database transaction. */
export async function resolveOrganiserXeroContact(
  billing: Pick<OrganiserBilling, "organiserMemberId">,
  options?: Parameters<typeof findOrCreateXeroContact>[1],
): Promise<string> {
  const { findOrCreateXeroContact } = await import("@/lib/xero-contacts");
  return findOrCreateXeroContact(billing.organiserMemberId, options);
}
