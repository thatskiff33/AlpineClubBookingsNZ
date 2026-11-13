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
 *   combined documents use the organiser's booking;
 * - a subscription charge, and the note that cancels it:
 *   `MembershipSubscriptionCharge.createdAt`;
 * - a document with no charge row (the entrance fee): its outbox operation's
 *   `createdAt`, passed as an instant.
 *
 * Read OUTSIDE any transaction (`INV-LOCK-004`), through the module client: the
 * schedule, the club's zone and the anchor row are all read here. A schedule
 * that cannot be read throws, and the document is not sent; it is never sent
 * under a guessed treatment.
 */
export type XeroTaxAnchor =
  | { kind: "booking"; bookingId: string }
  | { kind: "subscription-charge"; chargeId: string }
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
