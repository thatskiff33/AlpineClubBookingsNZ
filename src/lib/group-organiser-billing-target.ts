/**
 * #4299 (`INV-PAY-142`): WHO A JOINER'S PLACE IS BILLED TO WHEN THE GROUP
 * ORGANISER PAID FOR IT BY INTERNET BANKING - the one read of the organiser's
 * billing target, shared by the edit doors that bill an increase to the
 * organiser, the organiser's extra invoice, the back-bill repair, and (#4292)
 * the per-refund notes against the same combined invoice (`INV-SSOT-001`).
 *
 * A joiner's place in such a group has no invoice of its own: its money was
 * taken on the group's ONE combined invoice, addressed to the organiser
 * (`xero-group-settlement-invoices.ts`). So anything the club bills or credits
 * for that place is addressed to the organiser's Xero contact and names that
 * combined invoice, read here from the group's `GroupBookingSettlement`.
 *
 * Takes the caller's store and no lock of its own. Every writer of the
 * settlement's `xeroInvoiceId` holds `lock(1)` (the combined invoice's bind,
 * `bindCreatedGroupSettlementInvoice`), so a caller under `lock(1)` reads a
 * stable answer; the after-commit callers (the invoice's handler) read the
 * frozen ids their row carries and use this only for the contact.
 */
import { PaymentSource, type Prisma } from "@prisma/client";

import type { FindOrCreateXeroContactOptions } from "@/lib/xero-contacts";

export type OrganiserBillingTarget = {
  groupBookingId: string;
  settlementId: string;
  organiserMemberId: string;
  organiserBookingId: string;
  /** The group's combined invoice, which every organiser-addressed document for the place names. */
  combinedInvoiceId: string;
  combinedInvoiceNumber: string | null;
};

/** Why no target could be read; the doors refuse the edit in the organiser's words (decision 4). */
export type OrganiserBillingTargetRefusal = "no-group" | "no-internet-banking-settlement" | "no-combined-invoice";

export type OrganiserBillingTargetRead =
  | { ok: true; target: OrganiserBillingTarget }
  | { ok: false; reason: OrganiserBillingTargetRefusal };

/**
 * Decision 4 (owner, 25 Oct 2026): an increase on such a place is refused when
 * the group has no combined invoice on record, rather than saved with nobody to
 * bill. Xero merely being unreachable is not this: the invoice is queued.
 */
export const ORGANISER_BILLING_NO_COMBINED_INVOICE_MESSAGE =
  "This place was paid for by the group organiser by bank transfer, so a change that raises its price is billed to the organiser on an extra invoice that names the group's invoice. The club has no record of that group invoice, so the change cannot be saved. Contact the club to make this change.";

/** The organiser's billing target for a joiner's booking, or why there is none. */
export async function readOrganiserBillingTarget(
  store: Pick<Prisma.TransactionClient, "groupBooking">,
  child: { parentBookingId: string | null },
): Promise<OrganiserBillingTargetRead> {
  if (!child.parentBookingId) return { ok: false, reason: "no-group" };
  const group = await store.groupBooking.findUnique({
    where: { organiserBookingId: child.parentBookingId },
    select: {
      id: true,
      organiserMemberId: true,
      organiserBookingId: true,
      settlement: { select: { id: true, source: true, xeroInvoiceId: true, xeroInvoiceNumber: true } },
    },
  });
  if (!group) return { ok: false, reason: "no-group" };
  const settlement = group.settlement;
  if (!settlement || settlement.source !== PaymentSource.INTERNET_BANKING) {
    return { ok: false, reason: "no-internet-banking-settlement" };
  }
  if (!settlement.xeroInvoiceId) return { ok: false, reason: "no-combined-invoice" };
  return {
    ok: true,
    target: {
      groupBookingId: group.id,
      settlementId: settlement.id,
      organiserMemberId: group.organiserMemberId,
      organiserBookingId: group.organiserBookingId,
      combinedInvoiceId: settlement.xeroInvoiceId,
      combinedInvoiceNumber: settlement.xeroInvoiceNumber,
    },
  };
}

/**
 * The organiser's Xero contact - the one every organiser-addressed document
 * uses: the group's combined invoice and the organiser's extra invoices
 * (#4292's notes too). The organiser is always a member (`GroupBooking.
 * organiserMemberId`), so this is that member's contact, resolved as every
 * member's is; the contact-repair retry takes the same member id.
 *
 * Loaded lazily, so the edit doors that read the target above do not pull the
 * Xero client graph into the save path.
 */
export async function findOrCreateOrganiserXeroContact(
  organiserMemberId: string,
  options?: FindOrCreateXeroContactOptions,
): Promise<string> {
  const { findOrCreateXeroContact } = await import("@/lib/xero-contacts");
  return findOrCreateXeroContact(organiserMemberId, options);
}
