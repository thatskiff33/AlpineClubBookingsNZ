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
 * - Xero's remaining credit on the note is less than what the app still has to
 *   allocate from it (the acceptance's comparison): the lot's slices on this note
 *   that Xero does not hold yet, plus what the engine will draw from the lot for the
 *   member's applied credit no slice covers yet (`unslicedDrawCents`);
 * - Xero's list shows spend the app has no record of that the ledger has not
 *   absorbed: the inbound mirror's arithmetic (`planOutsideSpendMirror`, #4270)
 *   leaves some of it on credit drawn onto a booking (`leftForAllocationCents`).
 *
 * THE DRAW IS THE ENGINE'S OWN. The engine fills a booking's applied credit from the
 * member's lots oldest first (`CREDIT_LOT_USE_ORDER`), each lot giving its free
 * credit (amount, less all slices, less its note's write-down). The flag reads the
 * lots through the engine's own loader (`loadFreeCreditLots`) and replays its fill
 * (`fillLotsInOrder`) for the member's total uncovered credit, so credit an older
 * lot will take never counts against this note. The total that lands on a lot does
 * not depend on which booking the engine allocates first, but which booking's
 * credit lands there does, so every waiting booking with uncovered credit is named
 * when any of it lands on the lot (the conservative choice).
 *
 * A CANCELLED BOOKING COUNTS while the engine still works for it. A cancel with
 * nothing captured settles the booking's applied credit (`appliedCreditSettledByCancel`,
 * #3836): its invoice is cleared by a note sized net of the slices already committed,
 * so the engine plans nothing new for it, though it still sends those slices. A
 * cancel after capture settles nothing: the engine plans and allocates as for a live
 * booking. So a cancelled booking's unheld slices always count, and its uncovered
 * credit counts unless the cancel settled it. It is named like any other booking:
 * the converge refuses a cancelled booking, so only an officer can act on it.
 *
 * The cheap comparison runs first: a note Xero can still cover never reaches the
 * outside-spend read, the balance or the mirror's arithmetic.
 *
 * LEFT OUT, so the flag clears once the work is dealt with: a booking whose
 * applied-credit allocation an officer resolved in Xero (`getBlockingOperation`'s
 * "resolved" answer, on the booking's queued allocation or on the slice's own
 * attempt). Those bookings are returned apart (`resolvedAllocations`) for the
 * repair check's resolved-in-Xero report. A close the converge made itself
 * (`isClosedByCreditSpentOutsideApp`, #4338) is not an officer's resolve: it leaves
 * the work to a fresh attempt, and its write-down is already in the ledger, so the
 * slice is judged as any other and is never reported as resolved.
 *
 * The flag lags Xero by the webhook and cursor-sync delay (read-after-write lag): a
 * spend shows when the note's next event is reconciled, and a reversal clears the
 * same way. The converge (#4219) and the mirror, not this flag, act on the ledger.
 */
import { CreditType, type Prisma } from "@prisma/client";
import { getMemberCreditBalance } from "@/lib/member-credit";
import { bookingsAppliedCreditSettledByCancel, unallocatedAppliedCreditCentsByBooking } from "@/lib/xero-applied-credit-ledger-state";
import { loadFreeCreditLots } from "@/lib/xero-applied-credit-lots";
import { fillLotsInOrder } from "@/lib/xero-applied-credit-plan";
import { fundingLotWhere, slicesHeldInXero } from "@/lib/xero-applied-credit-slice-lookup";
import { getBlockingOperation } from "@/lib/xero-booking-repair-object-resolution";
import { xeroOperationSelect, type XeroOperationRecord } from "@/lib/xero-booking-repair-types";
import { planOutsideSpendMirror } from "@/lib/xero-credit-note-mirror-plan";
import { judgeOutsideSpendEvidence, outsideSpendCents } from "@/lib/xero-credit-note-outside-spend";
import { newestSpendReadings } from "@/lib/xero-credit-note-spend-evidence";
import { XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE } from "@/lib/xero-operation-outbox-payload";
import { isClosedByCreditSpentOutsideApp } from "@/lib/xero-operation-resolution";

/** A booking left out of a flag because an officer resolved its allocation in Xero. */
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
  /** The part of that the engine will draw from this lot for applied credit no slice covers yet. */
  unslicedDrawCents: number;
  /** What Xero shows spent on things the app has no record of. */
  outsideSpendCents: number;
  /** The part of that spend the ledger cannot absorb because bookings draw on it. */
  leftForAllocationCents: number;
  /** The bookings still waiting to draw on the note, sorted. */
  bookingIds: string[];
  /** The note's bookings left out because an officer resolved their allocation in Xero. */
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

/** The allocation attempts' select: the repair's, plus who resolved it (an officer, or the converge). */
const operationSelect = { ...xeroOperationSelect, manuallyResolvedById: true } as const;

/** The officer's resolve among these attempts, or null; a converge close is not one (#4338). */
function officerResolved(match: ReturnType<typeof getBlockingOperation>): XeroOperationRecord | null {
  if (match?.kind !== "resolved") return null;
  const operation = match.resolvedOperation as XeroOperationRecord & { manuallyResolvedById: string | null };
  return isClosedByCreditSpentOutsideApp(operation) ? null : operation;
}

/** Of these bookings, those whose queued allocation an officer resolved (by booking). */
async function bookingStates(db: Prisma.TransactionClient, bookingIds: string[]) {
  const bookings = bookingIds.length
    ? await db.booking.findMany({ where: { id: { in: bookingIds } }, select: { id: true, payment: { select: { id: true } } } })
    : [];
  const paymentIds = bookings.flatMap((b) => (b.payment ? [b.payment.id] : []));
  const operations = paymentIds.length
    ? await db.xeroSyncOperation.findMany({
        where: { localModel: "Payment", localId: { in: paymentIds }, entityType: "ALLOCATION" },
        select: operationSelect,
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      })
    : [];
  const resolved = new Map<string, XeroOperationRecord>();
  for (const booking of bookings) {
    if (!booking.payment) continue;
    const ops = operations.filter((op) => op.localId === booking.payment!.id);
    const operation = officerResolved(getBlockingOperation(ops, "ALLOCATION", "ALLOCATE", { payloadQueueType: XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE }));
    if (operation) resolved.set(booking.id, operation);
  }
  return resolved;
}

/** Of these slices, those whose own allocation attempt an officer resolved. */
async function resolvedSlices(db: Prisma.TransactionClient, sliceIds: string[]): Promise<Map<string, XeroOperationRecord>> {
  if (sliceIds.length === 0) return new Map();
  const operations = await db.xeroSyncOperation.findMany({
    where: { localModel: "MemberCreditNoteAllocation", localId: { in: sliceIds }, entityType: "ALLOCATION" },
    select: operationSelect,
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
  });
  const resolved = new Map<string, XeroOperationRecord>();
  for (const sliceId of sliceIds) {
    const operation = officerResolved(getBlockingOperation(operations.filter((op) => op.localId === sliceId), "ALLOCATION", "ALLOCATE"));
    if (operation) resolved.set(sliceId, operation);
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
  const memberIds = [...new Set(candidates.map((lot) => lot.memberId))];
  const [unsliced, creditLots] = await Promise.all([unslicedAppliedByMember(db, memberIds), loadFreeCreditLots(db, memberIds)]);
  const waitingBookingIds = [...new Set([...unheld.map((s) => s.appliedToBookingId), ...[...unsliced.values()].flatMap((m) => [...m.keys()])])];
  const uncoveredBookingIds = [...unsliced.values()].flatMap((m) => [...m.keys()]);
  const [resolvedBookings, settledByCancel, resolvedSliceOps] = await Promise.all([
    bookingStates(db, waitingBookingIds),
    bookingsAppliedCreditSettledByCancel(uncoveredBookingIds, db),
    resolvedSlices(db, unheld.map((slice) => slice.id)),
  ]);
  // Read once per member, and only for a member whose note gets past the cheap comparison.
  const balances = new Map<string, Promise<number>>();
  const balanceOf = (memberId: string) => {
    if (!balances.has(memberId)) balances.set(memberId, getMemberCreditBalance(memberId, db));
    return balances.get(memberId)!;
  };

  const found: CreditNoteSpentOutsideApp[] = [];
  for (const lot of candidates) {
    const noteId = lot.xeroCreditNoteId!;
    const reading = readings.get(noteId)!;
    const remainingCents = reading.remainingCents!;
    const lotSlices = slices.filter((slice) => slice.memberCreditId === lot.id);

    // The bookings this note answers to, split into still waiting and resolved by an officer.
    const resolvedAllocations = new Map<string, XeroOperationRecord>();
    const waiting = new Set<string>();
    const resolvedOf = (bookingId: string, sliceId?: string) => (sliceId ? resolvedSliceOps.get(sliceId) : undefined) ?? resolvedBookings.get(bookingId);
    let pendingSliceCents = 0;
    for (const slice of lotSlices) {
      // Only this note's slices: the flag asks what Xero must still take from THIS note.
      // A cancelled booking's slice counts too: the engine still sends committed slices.
      if (held.has(slice.id) || slice.xeroCreditNoteId !== noteId) continue;
      const operation = resolvedOf(slice.appliedToBookingId, slice.id);
      if (operation) {
        resolvedAllocations.set(slice.appliedToBookingId, operation);
        continue;
      }
      pendingSliceCents += slice.amountCents;
      waiting.add(slice.appliedToBookingId);
    }

    // The engine's own draw from this lot for the credit no slice covers yet.
    const member = creditLots.get(lot.memberId) ?? { lots: [], writtenDownByNote: new Map<string, number>() };
    // A cancel that settled the booking's credit leaves the engine nothing new to plan for it.
    const uncovered = [...(unsliced.get(lot.memberId) ?? new Map<string, number>())].filter(([bookingId]) => !settledByCancel.has(bookingId));
    const drawnHere = (cents: number) => fillLotsInOrder(member.lots, cents).slices.find((slice) => slice.lot.memberCreditId === lot.id)?.amountCents ?? 0;
    const live = uncovered.filter(([bookingId]) => !resolvedOf(bookingId));
    const sumOf = (entries: Array<[string, number]>) => entries.reduce((sum, [, cents]) => sum + cents, 0);
    const unslicedDrawCents = drawnHere(sumOf(live));
    if (unslicedDrawCents > 0) for (const [bookingId] of live) waiting.add(bookingId);
    if (drawnHere(sumOf(uncovered)) > 0) {
      for (const [bookingId] of uncovered) {
        const operation = resolvedOf(bookingId);
        if (operation) resolvedAllocations.set(bookingId, operation);
      }
    }
    const pendingAllocationCents = pendingSliceCents + unslicedDrawCents;
    // Xero can still cover every allocation the app has to make from this note: nothing
    // will be refused. Checked first, so a healthy note costs no further read.
    if (remainingCents >= pendingAllocationCents) continue;

    const spentCents = await outsideSpendCents(db, reading.allocations, reading.payments);
    // A short cut, not a rule: with no outside spend the plan leaves nothing either.
    if (spentCents <= 0) continue;
    const plan = planOutsideSpendMirror({
      lotCents: lot.amountCents,
      // The mirror's own figure: every slice drawn from the lot (#4270), whichever note carries it.
      sliceCents: lotSlices.reduce((sum, slice) => sum + slice.amountCents, 0),
      writtenDownCents: member.writtenDownByNote.get(noteId) ?? 0,
      outsideSpendCents: spentCents,
      balanceCents: await balanceOf(lot.memberId),
    });
    if (plan.leftForAllocationCents <= 0) continue;

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
