import type { Prisma } from "@prisma/client";
import type { BookingChargeAccount } from "./booking-charges";
import { componentKey, liveComponentGross } from "./components";
import { memberMoneyEventKeys } from "./keys";

/**
 * What the journal holds of each booking's charges, for the comparison report
 * (#4627, Ledger M3b; `pnpm run booking-ledger:census`). A read only, inside the
 * census's read-only snapshot.
 *
 * `charged` says the booking's R01 is in the journal: only then is it in the
 * population M3b posts, and every later legacy charge line must be bridged. A
 * booking confirmed before M3b is back-posted whole by M9 and is not compared.
 */
export interface BookingJournalCharges {
  charged: boolean;
  components: ReadonlyArray<{ account: BookingChargeAccount; chargeIdentity: string; liveGrossCents: number }>;
  /** The booking's legacy lines a journal batch links (`MemberMoneySourceLink`). */
  bridgedLineIds: ReadonlySet<string>;
  /**
   * When the journal took its first R01, for any booking: a booking created after
   * it and confirmed with no R01 is a door that skipped the journal. Null before
   * the first. The same for every booking in one read.
   */
  journalSince: Date | null;
}

const CHARGE_ACCOUNTS: readonly BookingChargeAccount[] = ["BOOKING_REVENUE", "FEE_REVENUE"];

/** A booking charge component's live gross, as the posted legs leave it. */
export type LiveChargeComponent = BookingJournalCharges["components"][number];

const LEG_SELECT = {
  account: true, chargeIdentity: true, side: true, amountCents: true,
  grossCents: true, netCents: true, taxCents: true, taxCode: true, bookingId: true, lodgeId: true,
} as const;
type ChargeLeg = Prisma.MemberMoneyLineGetPayload<{ select: typeof LEG_SELECT }>;

/** Each charge component the legs post, with the gross it still carries: the one rule for the doors and the census. */
function liveChargeComponents(legs: readonly ChargeLeg[]): LiveChargeComponent[] {
  const gross = liveComponentGross(legs);
  return [...new Map(legs.map((leg) => [componentKey(leg.account, leg.chargeIdentity!), leg])).entries()]
    .map(([key, leg]) => ({
      account: leg.account as BookingChargeAccount,
      chargeIdentity: leg.chargeIdentity!,
      liveGrossCents: gross.get(key) ?? 0,
    }));
}

const chargeLegsOf = (bookingIds: readonly string[]) => ({
  bookingId: { in: [...bookingIds] }, account: { in: [...CHARGE_ACCOUNTS] }, chargeIdentity: { not: null },
});

/** One booking's live charge components, read inside a door's transaction under `lock(1)`. */
export async function readBookingLiveComponents(
  db: Pick<Prisma.TransactionClient, "memberMoneyLine">,
  bookingId: string,
): Promise<LiveChargeComponent[]> {
  return liveChargeComponents(await db.memberMoneyLine.findMany({ where: chargeLegsOf([bookingId]), orderBy: { id: "asc" }, select: LEG_SELECT }));
}

export async function readBookingJournalCharges(
  db: Pick<Prisma.TransactionClient, "memberMoneyEvent" | "memberMoneyLine" | "memberMoneySourceLink">,
  bookingIds: readonly string[],
): Promise<Map<string, BookingJournalCharges>> {
  const result = new Map<string, BookingJournalCharges>();
  if (bookingIds.length === 0) return result;
  const keys = new Map<string, string>(bookingIds.map((bookingId) => [memberMoneyEventKeys.bookingCharge(bookingId), bookingId]));
  const charged = await db.memberMoneyEvent.findMany({ where: { eventKey: { in: [...keys.keys()] } }, select: { eventKey: true } });
  const chargedIds = new Set(charged.map((event) => keys.get(event.eventKey)));
  const legs = await db.memberMoneyLine.findMany({ where: chargeLegsOf(bookingIds), orderBy: { id: "asc" }, select: LEG_SELECT });
  const first = await db.memberMoneyEvent.aggregate({ where: { eventKey: { startsWith: "booking-charge:" } }, _min: { recordedAt: true } });
  const journalSince = first._min.recordedAt ?? null;
  const links = await db.memberMoneySourceLink.findMany({
    where: { bookingLedgerLine: { bookingId: { in: [...bookingIds] } } },
    orderBy: { id: "asc" },
    select: { bookingLedgerLineId: true, bookingLedgerLine: { select: { bookingId: true } } },
  });
  const bridged = new Map<string, Set<string>>();
  for (const link of links) {
    const bookingId = link.bookingLedgerLine?.bookingId;
    if (!bookingId || !link.bookingLedgerLineId) continue;
    bridged.set(bookingId, (bridged.get(bookingId) ?? new Set<string>()).add(link.bookingLedgerLineId));
  }
  const byBooking = new Map<string, ChargeLeg[]>();
  for (const leg of legs) byBooking.set(leg.bookingId!, [...(byBooking.get(leg.bookingId!) ?? []), leg]);
  for (const bookingId of bookingIds) {
    result.set(bookingId, {
      charged: chargedIds.has(bookingId),
      components: liveChargeComponents(byBooking.get(bookingId) ?? []),
      bridgedLineIds: bridged.get(bookingId) ?? new Set(),
      journalSince,
    });
  }
  return result;
}
