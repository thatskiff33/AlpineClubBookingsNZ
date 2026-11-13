import { clubTaxTreatmentOn, loadClubTaxSchedule } from "@/lib/club-tax-settings";
import { clubCalendarDateOf, requireInstant, type Instant } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { prisma } from "@/lib/prisma";
import { xeroTaxRenderingOf, type XeroTaxRendering } from "@/lib/xero-tax-rendering";

/**
 * WHICH TAX TREATMENT A XERO DOCUMENT CARRIES (#4632, owner decision A, 11 Nov
 * 2026). Each charge's treatment is fixed by its ANCHOR, the moment the charge
 * was made, never the day a document is rendered or sent: a booking made before
 * the club's GST registration or rate changes keeps the treatment in force when
 * it was made, for its whole life, so its invoice, every edit's document and
 * every credit note agree with each other and with the member-money journal,
 * which splits its charges on the same anchor (`booking-posting.ts`).
 *
 * - a booking's documents: the club date of `Booking.createdAt`; a group's
 *   combined documents, and a place's documents billed to its organiser, use
 *   the organiser's booking;
 * - a subscription charge, and the note that cancels it:
 *   `MembershipSubscriptionCharge.createdAt`; a cancellation credits an invoice,
 *   so its anchor is the charge that raised that invoice, or, for an invoice
 *   older than charge rows, the subscription's own `createdAt`;
 * - a document with no charge row (the entrance fee): its outbox operation's
 *   `createdAt`, or the moment of a direct write, which creates its operation then.
 *
 * Read OUTSIDE any transaction (`INV-LOCK-004`), through the module client: the
 * schedule, the club's zone and the anchor row are all read here. A schedule
 * that cannot be read throws, and the document is not sent; it is never sent
 * under a guessed treatment.
 */
export type XeroTaxAnchor =
  | { kind: "booking"; bookingId: string }
  /** A group place billed to its organiser: the organiser's booking, or the place's own when it has no parent. */
  | { kind: "organiser-billed-place"; bookingId: string }
  | { kind: "subscription-charge"; chargeId: string }
  | { kind: "subscription-invoice"; invoiceId: string; subscriptionId: string }
  | { kind: "xero-operation"; operationId: string }
  | { kind: "instant"; at: Instant };

async function anchorInstant(anchor: XeroTaxAnchor): Promise<Instant> {
  switch (anchor.kind) {
    case "instant":
      return requireInstant(anchor.at);
    case "booking": {
      const row = await prisma.booking.findUnique({ where: { id: anchor.bookingId }, select: { createdAt: true } });
      if (!row) throw new Error(`Booking ${anchor.bookingId} does not exist, so its documents have no tax anchor.`);
      return requireInstant(row.createdAt);
    }
    case "organiser-billed-place": {
      const place = await prisma.booking.findUnique({
        where: { id: anchor.bookingId },
        select: { createdAt: true, parentBooking: { select: { createdAt: true } } },
      });
      if (!place) throw new Error(`Booking ${anchor.bookingId} does not exist, so its documents have no tax anchor.`);
      return requireInstant(place.parentBooking?.createdAt ?? place.createdAt);
    }
    case "subscription-invoice": {
      const charge = await prisma.membershipSubscriptionCharge.findUnique({
        where: { xeroInvoiceId: anchor.invoiceId },
        select: { createdAt: true },
      });
      if (charge) return requireInstant(charge.createdAt);
      const subscription = await prisma.memberSubscription.findUnique({
        where: { id: anchor.subscriptionId },
        select: { createdAt: true },
      });
      if (!subscription) throw new Error(`Subscription ${anchor.subscriptionId} does not exist, so its documents have no tax anchor.`);
      return requireInstant(subscription.createdAt);
    }
    case "xero-operation": {
      const row = await prisma.xeroSyncOperation.findUnique({
        where: { id: anchor.operationId },
        select: { createdAt: true },
      });
      if (!row) throw new Error(`Xero operation ${anchor.operationId} does not exist, so its document has no tax anchor.`);
      return requireInstant(row.createdAt);
    }
    case "subscription-charge": {
      const row = await prisma.membershipSubscriptionCharge.findUnique({
        where: { id: anchor.chargeId },
        select: { createdAt: true },
      });
      if (!row) throw new Error(`Subscription charge ${anchor.chargeId} does not exist, so its documents have no tax anchor.`);
      return requireInstant(row.createdAt);
    }
  }
}

/** The Xero rendering of the treatment in force on the anchor's club date. */
export async function resolveXeroTaxRendering(anchor: XeroTaxAnchor): Promise<XeroTaxRendering> {
  const [at, schedule, zone] = await Promise.all([
    anchorInstant(anchor),
    loadClubTaxSchedule(prisma),
    readClubTimeZoneOutsideRequest(),
  ]);
  return xeroTaxRenderingOf(clubTaxTreatmentOn(schedule, clubCalendarDateOf(at, zone)));
}
