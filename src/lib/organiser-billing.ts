/** Shared organiser payer and combined-invoice resolution (#4299, #4292). */
import type { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api-error";
import { paidByOrganiserInternetBanking } from "@/lib/group-organiser-paid";
import type { findOrCreateXeroContact } from "@/lib/xero-contacts";

export const ORGANISER_COMBINED_INVOICE_MISSING_MESSAGE =
  "The group organiser's combined invoice is not on record, so this booking cannot be changed. Contact the club to restore the invoice record first.";

/**
 * #4299 B1 (`INV-PAY-148`): a place the group organiser paid by internet banking
 * is settled on the organiser's combined invoice and never gets a primary
 * invoice of its own. The one refusal code and sentence for both fences: the
 * enqueue choke point and the invoice handler behind it.
 */
export const ORGANISER_COMBINED_INVOICE_PLACE_REFUSAL = "ORGANISER_PAID_INTERNET_BANKING" as const;
export const ORGANISER_COMBINED_INVOICE_PLACE_MESSAGE =
  "The group organiser paid this place by internet banking; it is settled on the organiser's combined invoice, so no invoice of its own is raised.";

type OrganiserPlace = Parameters<typeof paidByOrganiserInternetBanking>[0] & { id: string };
type BillingStore = Pick<Prisma.TransactionClient, "groupBooking">;

/** The organiser fields billing needs; never the whole Member row (it holds secrets). */
const ORGANISER_SELECT = { id: true, firstName: true, lastName: true, email: true } as const;

/**
 * Local reads only: edit callers supply their locked transaction. A refunded
 * settlement remains resolvable for historical repair and later refund notes.
 * The child mirror identifies who paid; absence of its own invoice is expected.
 * Null: not an organiser-paid internet-banking place. "missing": it is one, but
 * no internet-banking combined invoice is on record.
 */
export async function readOrganiserBilling(db: BillingStore, booking: OrganiserPlace) {
  if (!paidByOrganiserInternetBanking(booking)) return null;
  const group = await db.groupBooking.findUnique({
    where: { organiserBookingId: booking.parentBookingId! },
    select: {
      organiserBookingId: true,
      organiserMemberId: true,
      organiserMember: { select: ORGANISER_SELECT },
      settlement: { select: { id: true, source: true, xeroInvoiceId: true } },
    },
  });
  if (!group?.settlement?.xeroInvoiceId || group.settlement.source !== "INTERNET_BANKING") return "missing" as const;
  return {
    settlementId: group.settlement.id,
    combinedInvoiceId: group.settlement.xeroInvoiceId,
    organiserMemberId: group.organiserMemberId,
    organiserBookingId: group.organiserBookingId,
    organiser: group.organiserMember,
    placeBookingId: booking.id,
  };
}

/** As `readOrganiserBilling`, refusing (409) a place whose combined invoice is missing. */
export async function resolveOrganiserBilling(db: BillingStore, booking: OrganiserPlace) {
  const billing = await readOrganiserBilling(db, booking);
  if (billing === "missing") throw new ApiError(ORGANISER_COMBINED_INVOICE_MISSING_MESSAGE, 409);
  return billing;
}

export type OrganiserBilling = NonNullable<Awaited<ReturnType<typeof resolveOrganiserBilling>>>;

/**
 * N-a: only an INCREASE needs the combined invoice, to bill the organiser; a
 * reduction or a no-price change saves as before. One predicate for the save
 * (`resolveOrganiserBillingForNet`) and the quote that previews it.
 */
export async function organiserCombinedInvoiceRefusal(db: BillingStore, booking: OrganiserPlace, netChargeCents: number): Promise<string | null> {
  return combinedInvoiceRefusalFor(await readOrganiserBilling(db, booking), netChargeCents);
}

/** N5: the one "an increase, and no combined invoice" rule, over one read. */
function combinedInvoiceRefusalFor(billing: Awaited<ReturnType<typeof readOrganiserBilling>>, netChargeCents: number): string | null {
  return netChargeCents > 0 && billing === "missing" ? ORGANISER_COMBINED_INVOICE_MISSING_MESSAGE : null;
}

/** The save's read: the billing, or null; refuses (409) what the quote's refusal names. */
export async function resolveOrganiserBillingForNet(db: BillingStore, booking: OrganiserPlace, netChargeCents: number) {
  const billing = await readOrganiserBilling(db, booking);
  const refusal = combinedInvoiceRefusalFor(billing, netChargeCents);
  if (refusal) throw new ApiError(refusal, 409);
  return billing === "missing" ? null : billing;
}

/** Provider contact lookup/repair; call only outside a database transaction. */
export async function resolveOrganiserXeroContact(
  billing: Pick<OrganiserBilling, "organiserMemberId">,
  options?: Parameters<typeof findOrCreateXeroContact>[1],
): Promise<string> {
  const { findOrCreateXeroContact } = await import("@/lib/xero-contacts");
  return findOrCreateXeroContact(billing.organiserMemberId, options);
}
