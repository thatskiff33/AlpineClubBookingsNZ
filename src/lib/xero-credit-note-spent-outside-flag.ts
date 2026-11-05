/**
 * #4220 (lane a; owner decision, 24 Oct 2026): the early warning that a credit note
 * backing a booking's applied credit was spent in Xero outside the app, so Xero will
 * refuse the booking's allocation (#4218) when the app tries it.
 *
 * READ-ONLY AND DERIVED ON EVERY ASK. It writes no ledger row, no Xero object, no
 * stored flag and no audit row, sends no email and makes no Xero call. The reading
 * it judges is the one the inbound reconcile kept with the note's link
 * (`xero-credit-note-spend-evidence.ts`). The repair check reports it as a finding
 * and the Xero health summary counts it.
 *
 * A NOTE IS FLAGGED ONLY WHEN ALL OF THESE HOLD, so an outage, a half-written list
 * or the app's own unrecorded work never raises a false alarm:
 *
 * - it funds exactly one lot, and some of that lot is drawn onto a booking by a
 *   slice Xero does not hold yet (`slicesHeldInXero`): credit still to allocate;
 * - a stored reading passes the mirror's own gates (`judgeOutsideSpendEvidence`:
 *   active, explained by Xero's list, settled);
 * - Xero's list shows spend the app has no record of that the ledger has not
 *   absorbed: the inbound mirror's arithmetic (`planOutsideSpendMirror`, #4270)
 *   leaves some of it on credit drawn onto a booking (`leftForAllocationCents`);
 * - Xero's remaining credit on the note is less than the credit the app still has
 *   to allocate from it (the acceptance's comparison): the allocation will be refused.
 *
 * The flag lags Xero by the webhook and cursor-sync delay (read-after-write lag): a
 * spend shows when the note's next event is reconciled, and a reversal clears the
 * same way. The converge (#4219) and the mirror, not this flag, act on the ledger.
 */
import type { Prisma } from "@prisma/client";
import { getMemberCreditBalance } from "@/lib/member-credit";
import { slicesHeldInXero } from "@/lib/xero-applied-credit-slice-lookup";
import { planOutsideSpendMirror } from "@/lib/xero-credit-note-mirror-plan";
import { judgeOutsideSpendEvidence, outsideSpendCents } from "@/lib/xero-credit-note-outside-spend";
import { readStoredSpendEvidence, type CreditNoteSpendReading } from "@/lib/xero-credit-note-spend-evidence";
import { NOT_A_CONVERGENCE_ROW, writtenDownCentsByCreditNote } from "@/lib/xero-credit-note-write-down";

/** One credit note Xero shows spent outside the app while bookings still wait to draw on it. */
export interface CreditNoteSpentOutsideApp {
  creditNoteId: string;
  memberId: string;
  lotId: string;
  /** Xero's remaining credit on the note, from the stored reading. */
  xeroRemainingCents: number;
  /** Credit the app still has to allocate from the note: its slices Xero does not hold yet. */
  pendingAllocationCents: number;
  /** What Xero shows spent on things the app has no record of. */
  outsideSpendCents: number;
  /** The part of that spend the ledger cannot absorb because bookings draw on it. */
  leftForAllocationCents: number;
  /** The bookings whose slice of the lot Xero does not hold yet, sorted. */
  bookingIds: string[];
  /** When the reading was taken. */
  observedAt: Date;
}

/** The newest trustworthy reading per note across its active links. */
async function readingsByNote(db: Prisma.TransactionClient, noteIds: string[]): Promise<Map<string, CreditNoteSpendReading>> {
  const links = await db.xeroObjectLink.findMany({
    where: { xeroObjectType: "CREDIT_NOTE", xeroObjectId: { in: noteIds }, active: true },
    select: { xeroObjectId: true, metadata: true },
  });
  const readings = new Map<string, CreditNoteSpendReading>();
  for (const link of links) {
    const reading = readStoredSpendEvidence(link.metadata);
    const kept = readings.get(link.xeroObjectId);
    if (reading && (!kept || reading.observedAt.getTime() > kept.observedAt.getTime())) readings.set(link.xeroObjectId, reading);
  }
  return readings;
}

/**
 * Every credit note Xero shows spent outside the app while a booking still waits to
 * draw on it: for the lots these bookings draw on, or for every lot when none is
 * named. Database reads only.
 */
export async function findCreditNotesSpentOutsideApp(
  db: Prisma.TransactionClient,
  options: { bookingIds?: readonly string[]; now?: Date } = {},
): Promise<CreditNoteSpentOutsideApp[]> {
  const now = options.now ?? new Date();
  let lotScope: Prisma.MemberCreditNoteAllocationWhereInput = {};
  if (options.bookingIds) {
    if (options.bookingIds.length === 0) return [];
    const scoped = await db.memberCreditNoteAllocation.findMany({
      where: { appliedToBookingId: { in: [...options.bookingIds] } },
      select: { memberCreditId: true },
    });
    if (scoped.length === 0) return [];
    lotScope = { memberCreditId: { in: [...new Set(scoped.map((slice) => slice.memberCreditId))] } };
  }

  // Every slice of those lots, not only the named bookings': what the note must still cover.
  const slices = await db.memberCreditNoteAllocation.findMany({
    where: lotScope,
    select: { id: true, memberCreditId: true, appliedToBookingId: true, amountCents: true },
  });
  const held = await slicesHeldInXero(db, slices.map((slice) => slice.id));
  const slicedByLot = new Map<string, number>();
  const pendingByLot = new Map<string, { cents: number; bookingIds: Set<string> }>();
  for (const slice of slices) {
    slicedByLot.set(slice.memberCreditId, (slicedByLot.get(slice.memberCreditId) ?? 0) + slice.amountCents);
    if (held.has(slice.id)) continue;
    const pending = pendingByLot.get(slice.memberCreditId) ?? { cents: 0, bookingIds: new Set<string>() };
    pending.cents += slice.amountCents;
    pending.bookingIds.add(slice.appliedToBookingId);
    pendingByLot.set(slice.memberCreditId, pending);
  }
  if (pendingByLot.size === 0) return [];

  const lots = await db.memberCredit.findMany({
    where: { id: { in: [...pendingByLot.keys()] }, xeroCreditNoteId: { not: null }, amountCents: { gt: 0 }, ...NOT_A_CONVERGENCE_ROW },
    select: { id: true, memberId: true, amountCents: true, xeroCreditNoteId: true },
  });
  const noteIds = [...new Set(lots.flatMap((lot) => (lot.xeroCreditNoteId ? [lot.xeroCreditNoteId] : [])))];
  if (noteIds.length === 0) return [];

  // A note that funds more than one lot is left alone, as the mirror leaves it.
  const fundingLots = await db.memberCredit.groupBy({
    by: ["xeroCreditNoteId"],
    where: { xeroCreditNoteId: { in: noteIds }, amountCents: { gt: 0 }, ...NOT_A_CONVERGENCE_ROW },
    _count: { _all: true },
  });
  const shared = new Set(fundingLots.flatMap((row) => (row._count._all > 1 && row.xeroCreditNoteId ? [row.xeroCreditNoteId] : [])));
  const readings = await readingsByNote(db, noteIds);

  const found: CreditNoteSpentOutsideApp[] = [];
  for (const lot of lots) {
    const noteId = lot.xeroCreditNoteId;
    const reading = noteId ? readings.get(noteId) : undefined;
    const pending = pendingByLot.get(lot.id);
    if (!noteId || !reading || !pending || shared.has(noteId)) continue;
    if (judgeOutsideSpendEvidence(reading, now) !== null || reading.remainingCents === null) continue;
    // Xero can still cover every allocation the app has to make from this note: nothing will be refused.
    if (reading.remainingCents >= pending.cents) continue;

    const spentCents = await outsideSpendCents(db, reading.allocations, reading.payments);
    // A short cut, not a rule: with no outside spend the plan leaves nothing either.
    if (spentCents <= 0) continue;
    const plan = planOutsideSpendMirror({
      lotCents: lot.amountCents,
      sliceCents: slicedByLot.get(lot.id) ?? 0,
      writtenDownCents: (await writtenDownCentsByCreditNote(db, lot.memberId, [noteId])).get(noteId) ?? 0,
      outsideSpendCents: spentCents,
      balanceCents: await getMemberCreditBalance(lot.memberId, db),
    });
    if (plan.leftForAllocationCents <= 0) continue;
    found.push({
      creditNoteId: noteId,
      memberId: lot.memberId,
      lotId: lot.id,
      xeroRemainingCents: reading.remainingCents,
      pendingAllocationCents: pending.cents,
      outsideSpendCents: spentCents,
      leftForAllocationCents: plan.leftForAllocationCents,
      bookingIds: [...pending.bookingIds].sort(),
      observedAt: reading.observedAt,
    });
  }
  return found;
}
