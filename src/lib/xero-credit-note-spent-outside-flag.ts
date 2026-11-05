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
 * EARLY: the candidates are every funding lot whose note has a stored reading, not
 * only lots the allocation engine has already sliced. A booking whose applied credit
 * is not allocated yet (a card booking allocates at invoice or capture) is warned
 * about before the engine's first attempt, not after Xero refuses it.
 *
 * A NOTE IS FLAGGED ONLY WHEN ALL OF THESE HOLD, so an outage, a half-written list
 * or the app's own unrecorded work never raises a false alarm:
 *
 * - it funds exactly one lot (a shared note is left alone, as the mirror leaves it);
 * - the newest stored reading passes the mirror's own gates
 *   (`judgeOutsideSpendEvidence`: active, explained by Xero's list, settled);
 * - Xero's list shows spend the app has no record of that the ledger has not
 *   absorbed: the inbound mirror's arithmetic (`planOutsideSpendMirror`, #4270)
 *   leaves some of it on credit drawn onto a booking (`leftForAllocationCents`);
 * - Xero's remaining credit on the note is less than what the app still has to
 *   allocate from it (the acceptance's comparison): the lot's slices on this note
 *   that Xero does not hold yet, plus the member's applied credit no slice covers
 *   yet, capped at what the lot has left to give (`unslicedDrawCents`).
 *
 * The second term is an upper bound on what the engine will draw from this note: it
 * plans across the member's lots oldest first (`CREDIT_LOT_USE_ORDER`), so an older
 * lot may take some of it. That bound cannot raise a false alarm on its own: the
 * mirror's arithmetic must still leave spend on booked credit, which it does only
 * when the member's balance cannot absorb the spend.
 *
 * LEFT OUT, so the flag clears once the work is dealt with: a cancelled booking (the
 * converge refuses one, and its invoice is cleared by a note instead); a booking whose
 * applied-credit allocation an officer resolved in Xero, or the converge closed as
 * credit spent outside the app (`getBlockingOperation`'s "resolved" answer, on the
 * booking's queued allocation or on the slice's own attempt). Those bookings are
 * returned apart (`resolvedAllocations`) for the repair check's resolved-in-Xero
 * report; they never count toward a flag.
 *
 * The flag lags Xero by the webhook and cursor-sync delay (read-after-write lag): a
 * spend shows when the note's next event is reconciled, and a reversal clears the
 * same way. The converge (#4219) and the mirror, not this flag, act on the ledger.
 */
import { CreditType, type Prisma } from "@prisma/client";
import { getMemberCreditBalance } from "@/lib/member-credit";
import { unallocatedAppliedCreditCentsByBooking } from "@/lib/xero-applied-credit-ledger-state";
import { fundingLotWhere, slicesHeldInXero } from "@/lib/xero-applied-credit-slice-lookup";
import { getBlockingOperation } from "@/lib/xero-booking-repair-object-resolution";
import { xeroOperationSelect, type XeroOperationRecord } from "@/lib/xero-booking-repair-types";
import { planOutsideSpendMirror } from "@/lib/xero-credit-note-mirror-plan";
import { judgeOutsideSpendEvidence, outsideSpendCents } from "@/lib/xero-credit-note-outside-spend";
import { newestSpendReadings } from "@/lib/xero-credit-note-spend-evidence";
import { writtenDownCentsByCreditNote } from "@/lib/xero-credit-note-write-down";
import { XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE } from "@/lib/xero-operation-outbox-payload";

/** A booking left out of a flag because its allocation was resolved by hand or closed by the converge. */
export interface ResolvedAppliedCreditAllocation {
  bookingId: string;
  operation: XeroOperationRecord;
}

/** One credit note Xero shows spent outside the app while bookings still wait to draw on it. */
export interface CreditNoteSpentOutsideApp {
  creditNoteId: string;
  memberId: string;
  lotId: string;
  /** Xero's remaining credit on the note, from the stored reading. */
  xeroRemainingCents: number;
  /** What the app still has to allocate from the note: pending slices plus the unsliced draw. */
  pendingAllocationCents: number;
  /** The part of that from the lot's slices on this note Xero does not hold yet. */
  pendingSliceCents: number;
  /** The part of that from applied credit no slice covers yet, capped at what the lot has left. */
  unslicedDrawCents: number;
  /** What Xero shows spent on things the app has no record of. */
  outsideSpendCents: number;
  /** The part of that spend the ledger cannot absorb because bookings draw on it. */
  leftForAllocationCents: number;
  /** The bookings still waiting to draw on the note, sorted. */
  bookingIds: string[];
  /** The note's bookings left out because their allocation was resolved by hand or closed by the converge. */
  resolvedAllocations: ResolvedAppliedCreditAllocation[];
  /** When the reading was taken. */
  observedAt: Date;
}

type Slice = { id: string; memberCreditId: string; xeroCreditNoteId: string; appliedToBookingId: string; amountCents: number };

/** The member ids whose lots the named bookings draw on, or will. */
async function membersOfBookings(db: Prisma.TransactionClient, bookingIds: string[]): Promise<string[]> {
  const [applied, slices] = await Promise.all([
    db.memberCredit.findMany({
      where: { appliedToBookingId: { in: bookingIds }, type: CreditType.BOOKING_APPLIED },
      select: { memberId: true },
    }),
    db.memberCreditNoteAllocation.findMany({ where: { appliedToBookingId: { in: bookingIds } }, select: { memberCreditId: true } }),
  ]);
  const slicedLots = slices.length
    ? await db.memberCredit.findMany({ where: { id: { in: [...new Set(slices.map((s) => s.memberCreditId))] } }, select: { memberId: true } })
    : [];
  return [...new Set([...applied, ...slicedLots].map((row) => row.memberId))];
}

/** Per member, the applied credit of each booking that no slice covers yet. */
async function unslicedAppliedByMember(db: Prisma.TransactionClient, memberIds: string[]): Promise<Map<string, Map<string, number>>> {
  const rows = await db.memberCredit.findMany({
    where: { memberId: { in: memberIds }, type: CreditType.BOOKING_APPLIED, xeroCreditNoteId: null, appliedToBookingId: { not: null } },
    select: { memberId: true, appliedToBookingId: true },
  });
  const ownerOf = new Map(rows.flatMap((row) => (row.appliedToBookingId ? [[row.appliedToBookingId, row.memberId] as const] : [])));
  const unallocated = await unallocatedAppliedCreditCentsByBooking([...ownerOf.keys()], db);
  const waiting = [...unallocated].filter(([, cents]) => cents > 0).map(([bookingId]) => bookingId);
  const sliced = waiting.length
    ? await db.memberCreditNoteAllocation.groupBy({ by: ["appliedToBookingId"], where: { appliedToBookingId: { in: waiting } }, _sum: { amountCents: true } })
    : [];
  const slicedCents = new Map(sliced.map((row) => [row.appliedToBookingId, row._sum.amountCents ?? 0]));
  const byMember = new Map<string, Map<string, number>>();
  for (const bookingId of waiting) {
    const cents = (unallocated.get(bookingId) ?? 0) - (slicedCents.get(bookingId) ?? 0);
    const memberId = ownerOf.get(bookingId);
    if (cents <= 0 || !memberId) continue;
    byMember.set(memberId, (byMember.get(memberId) ?? new Map()).set(bookingId, cents));
  }
  return byMember;
}

/** Of these bookings, the cancelled ones and those whose queued allocation was resolved (by booking). */
async function bookingStates(db: Prisma.TransactionClient, bookingIds: string[]) {
  const bookings = bookingIds.length
    ? await db.booking.findMany({ where: { id: { in: bookingIds } }, select: { id: true, status: true, payment: { select: { id: true } } } })
    : [];
  const cancelled = new Set(bookings.filter((b) => b.status === "CANCELLED").map((b) => b.id));
  const paymentIds = bookings.flatMap((b) => (b.payment ? [b.payment.id] : []));
  const operations = paymentIds.length
    ? await db.xeroSyncOperation.findMany({
        where: { localModel: "Payment", localId: { in: paymentIds }, entityType: "ALLOCATION" },
        select: xeroOperationSelect,
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      })
    : [];
  const resolved = new Map<string, XeroOperationRecord>();
  for (const booking of bookings) {
    if (!booking.payment) continue;
    const ops = operations.filter((op) => op.localId === booking.payment!.id);
    const match = getBlockingOperation(ops, "ALLOCATION", "ALLOCATE", { payloadQueueType: XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE });
    if (match?.kind === "resolved") resolved.set(booking.id, match.resolvedOperation);
  }
  return { cancelled, resolved };
}

/** Of these slices, those whose own allocation attempt was resolved by hand or closed by the converge. */
async function resolvedSlices(db: Prisma.TransactionClient, sliceIds: string[]): Promise<Map<string, XeroOperationRecord>> {
  if (sliceIds.length === 0) return new Map();
  const operations = await db.xeroSyncOperation.findMany({
    where: { localModel: "MemberCreditNoteAllocation", localId: { in: sliceIds }, entityType: "ALLOCATION" },
    select: xeroOperationSelect,
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
  });
  const resolved = new Map<string, XeroOperationRecord>();
  for (const sliceId of sliceIds) {
    const match = getBlockingOperation(operations.filter((op) => op.localId === sliceId), "ALLOCATION", "ALLOCATE");
    if (match?.kind === "resolved") resolved.set(sliceId, match.resolvedOperation);
  }
  return resolved;
}

/**
 * Every credit note Xero shows spent outside the app while a booking still waits to
 * draw on it: for the members whose credit these bookings draw on (only the notes
 * naming one of them), or for every funding lot when none is named. Database reads only.
 */
export async function findCreditNotesSpentOutsideApp(
  db: Prisma.TransactionClient,
  options: { bookingIds?: readonly string[]; now?: Date } = {},
): Promise<CreditNoteSpentOutsideApp[]> {
  const now = options.now ?? new Date();
  let memberScope: Prisma.MemberCreditWhereInput = {};
  if (options.bookingIds) {
    if (options.bookingIds.length === 0) return [];
    const memberIds = await membersOfBookings(db, [...options.bookingIds]);
    if (memberIds.length === 0) return [];
    memberScope = { memberId: { in: memberIds } };
  }

  // Every funding lot (in scope) whose note has a reading that passes the mirror's gates.
  const lots = await db.memberCredit.findMany({
    where: { ...memberScope, ...fundingLotWhere({ not: null }) },
    select: { id: true, memberId: true, amountCents: true, xeroCreditNoteId: true },
  });
  const noteIds = [...new Set(lots.flatMap((lot) => (lot.xeroCreditNoteId ? [lot.xeroCreditNoteId] : [])))];
  if (noteIds.length === 0) return [];
  const readings = await newestSpendReadings(db, { xeroObjectId: { in: noteIds } });
  const judged = lots.filter((lot) => {
    const reading = lot.xeroCreditNoteId ? readings.get(lot.xeroCreditNoteId) : undefined;
    return reading !== undefined && reading.remainingCents !== null && judgeOutsideSpendEvidence(reading, now) === null;
  });
  if (judged.length === 0) return [];

  // A note that funds more than one lot (any member's) is left alone, as the mirror leaves it.
  const judgedNoteIds = [...new Set(judged.map((lot) => lot.xeroCreditNoteId!))];
  const fundingLots = await db.memberCredit.groupBy({ by: ["xeroCreditNoteId"], where: fundingLotWhere({ in: judgedNoteIds }), _count: { _all: true } });
  const shared = new Set(fundingLots.flatMap((row) => (row._count._all > 1 && row.xeroCreditNoteId ? [row.xeroCreditNoteId] : [])));
  const candidates = judged.filter((lot) => !shared.has(lot.xeroCreditNoteId!));
  if (candidates.length === 0) return [];

  // Only the candidates' slices: the mirror's sum, and the ones still to send.
  const slices: Slice[] = await db.memberCreditNoteAllocation.findMany({
    where: { memberCreditId: { in: candidates.map((lot) => lot.id) } },
    select: { id: true, memberCreditId: true, xeroCreditNoteId: true, appliedToBookingId: true, amountCents: true },
  });
  const held = await slicesHeldInXero(db, slices.map((slice) => slice.id));
  const unheld = slices.filter((slice) => !held.has(slice.id));
  const unsliced = await unslicedAppliedByMember(db, [...new Set(candidates.map((lot) => lot.memberId))]);
  const waitingBookingIds = [...new Set([...unheld.map((s) => s.appliedToBookingId), ...[...unsliced.values()].flatMap((m) => [...m.keys()])])];
  const [{ cancelled, resolved: resolvedBookings }, resolvedSliceOps] = await Promise.all([
    bookingStates(db, waitingBookingIds),
    resolvedSlices(db, unheld.map((slice) => slice.id)),
  ]);

  const found: CreditNoteSpentOutsideApp[] = [];
  for (const lot of candidates) {
    const noteId = lot.xeroCreditNoteId!;
    const reading = readings.get(noteId)!;
    const remainingCents = reading.remainingCents!;
    const lotSlices = slices.filter((slice) => slice.memberCreditId === lot.id);

    // The bookings this note answers to, split into still waiting and dealt with by hand.
    const resolvedAllocations = new Map<string, XeroOperationRecord>();
    const waiting = new Set<string>();
    const consider = (bookingId: string, sliceId?: string): boolean => {
      if (cancelled.has(bookingId)) return false;
      const operation = (sliceId ? resolvedSliceOps.get(sliceId) : undefined) ?? resolvedBookings.get(bookingId);
      if (operation) resolvedAllocations.set(bookingId, operation);
      return !operation;
    };
    let pendingSliceCents = 0;
    for (const slice of lotSlices) {
      // Only this note's slices: the flag asks what Xero must still take from THIS note.
      if (held.has(slice.id) || slice.xeroCreditNoteId !== noteId || !consider(slice.appliedToBookingId, slice.id)) continue;
      pendingSliceCents += slice.amountCents;
      waiting.add(slice.appliedToBookingId);
    }

    const spentCents = await outsideSpendCents(db, reading.allocations, reading.payments);
    // A short cut, not a rule: with no outside spend the plan leaves nothing either.
    if (spentCents <= 0) continue;
    const writtenDownCents = (await writtenDownCentsByCreditNote(db, lot.memberId, [noteId])).get(noteId) ?? 0;
    // The mirror's own figure: every slice drawn from the lot (#4270), whichever note carries it.
    const sliceCents = lotSlices.reduce((sum, slice) => sum + slice.amountCents, 0);
    const plan = planOutsideSpendMirror({
      lotCents: lot.amountCents,
      sliceCents,
      writtenDownCents,
      outsideSpendCents: spentCents,
      balanceCents: await getMemberCreditBalance(lot.memberId, db),
    });
    if (plan.leftForAllocationCents <= 0) continue;

    // What the engine can still draw from this lot for credit no slice covers yet; a
    // booking is answered by this note only while the lot has something left to give.
    const headroomCents = Math.max(0, lot.amountCents - sliceCents - writtenDownCents);
    const unslicedBookings = headroomCents > 0 ? [...(unsliced.get(lot.memberId) ?? new Map<string, number>())].filter(([bookingId]) => consider(bookingId)) : [];
    const unslicedDrawCents = Math.min(headroomCents, unslicedBookings.reduce((sum, [, cents]) => sum + cents, 0));
    if (unslicedDrawCents > 0) for (const [bookingId] of unslicedBookings) waiting.add(bookingId);
    const pendingAllocationCents = pendingSliceCents + unslicedDrawCents;
    // Xero can still cover every allocation the app has to make from this note: nothing will be refused.
    if (remainingCents >= pendingAllocationCents) continue;

    found.push({
      creditNoteId: noteId,
      memberId: lot.memberId,
      lotId: lot.id,
      xeroRemainingCents: remainingCents,
      pendingAllocationCents,
      pendingSliceCents,
      unslicedDrawCents,
      outsideSpendCents: spentCents,
      leftForAllocationCents: plan.leftForAllocationCents,
      bookingIds: [...waiting].sort(),
      resolvedAllocations: [...resolvedAllocations]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([bookingId, operation]) => ({ bookingId, operation })),
      observedAt: reading.observedAt,
    });
  }
  if (!options.bookingIds) return found;
  const named = new Set(options.bookingIds);
  return found.filter(
    (note) => note.bookingIds.some((id) => named.has(id)) || note.resolvedAllocations.some((r) => named.has(r.bookingId)),
  );
}
