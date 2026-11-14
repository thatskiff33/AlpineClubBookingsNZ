/**
 * The paid-booking import's writer (#5005, child A; `INV-PAY-155`,
 * `INV-CAP-040`). Unreachable until child C ships its route.
 *
 * It re-plans the file and refuses when the plan differs from the one the
 * officer confirmed, then writes each will-import booking in its OWN
 * transaction, never one transaction for the batch (`INV-LOCK-001`):
 *
 *   lock(1) → lodge capacity key → person-night keys → member-credit key
 *
 * (`INV-LOCK-002`; the settle takes the credit key). Under those locks it
 * claims the row with a status-guarded update, repeats every planner check,
 * creates the booking awaiting payment at the imported price with EVEN_SPLIT
 * night rows, and settles it through the manual settlement's sibling entry
 * point — or, for a free stay, the zero-price confirmation path. A row that no
 * longer passes is recorded refused and the next row carries on.
 *
 * Nothing here emails, queues Xero, calls Stripe or opens a recovery row.
 */
import {
  BookingEventType,
  BookingImportBatchStatus,
  BookingImportRowStatus,
  BookingStatus,
  PaymentStatus,
  Prisma,
} from "@prisma/client";

import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import { recordAdultMemberHostingReviewForNewBooking } from "@/lib/adult-member-hosting-review";
import { logAudit } from "@/lib/audit";
import { reconcileBedAllocationsForBookingWithGlobalLockHeld } from "@/lib/bed-allocation-lifecycle";
import {
  BOOKING_IMPORT_HOSTING_REFUSAL,
  bookingImportBatchKey,
  checkImportBooking,
  emptyBookingImportFileState,
  joinBookingImportRefusals,
  planBookingImport,
  splitBookingImportRefusals,
  type BookingImportPlan,
  type BookingImportRefusal,
  type ResolvedImportBooking,
} from "@/lib/booking-import/plan";
import { loadBookingImportLodge, loadBookingImportMembers, resolveImportBooking } from "@/lib/booking-import/resolve";
import type { ParsedImportBooking } from "@/lib/booking-import/parse";
import { postStoredBookingConfirmationLedgerLines } from "@/lib/booking-ledger-confirmation-sync";
import { buildApprovalGuestNights, toPipelineGuestCreateData } from "@/lib/booking-request-shared";
import { computeMemberGuestBoundary } from "@/lib/booking-guests";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import type { ClubDateFormat } from "@/lib/club-time";
import {
  resolveBookingMoneyPostingContext,
  type BookingJournalContext,
} from "@/lib/member-money/doors";
import {
  resolveBookingGuestDietary,
  resolveBookingGuestDietarySeeding,
  type BookingGuestDietarySeeding,
} from "@/lib/member-dietary-booking-writes";
import { buildMemberGuestConsentWrite } from "@/lib/member-guest-consent";
import { ManualBookingPaymentError, settleImportedBookingInTransaction } from "@/lib/payment-reconciliation";
import { prisma } from "@/lib/prisma";

/** Thrown inside a booking's transaction to roll it back and record the row refused. */
class ImportRowRefused extends Error {
  constructor(readonly refusals: BookingImportRefusal[]) {
    super("BOOKING_IMPORT_ROW_REFUSED");
  }
}

export type BookingImportRowResult =
  | { bookingRef: string; outcome: "IMPORTED"; bookingId: string }
  | { bookingRef: string; outcome: "REFUSED"; refusals: BookingImportRefusal[] };

export type BookingImportConfirmResult =
  /** The fresh plan differs from the one confirmed: nothing was written. */
  | { outcome: "stale"; plan: BookingImportPlan }
  /** The batch was reversed (#5005 child B); its file cannot be confirmed again. */
  | { outcome: "reversed"; batchId: string }
  | { outcome: "completed"; batchId: string; rows: BookingImportRowResult[] };

/**
 * Confirm a planned import. `digest` is the digest of the preview the officer
 * saw. Safe to run again with the same file: the batch key finds the batch,
 * decided rows are skipped, and each row's claim makes a concurrent confirm
 * write each booking once.
 */
export async function confirmBookingImport(input: {
  lodgeId: string;
  bookings: readonly ParsedImportBooking[];
  digest: string;
  officerMemberId: string;
  today: Date;
  format: ClubDateFormat;
}): Promise<BookingImportConfirmResult> {
  const { lodgeId, bookings, officerMemberId, today, format } = input;

  // Everything the transactions need from outside them, resolved once (`INV-LOCK-004`).
  const [journal, dietarySeeding] = await Promise.all([
    resolveBookingMoneyPostingContext(),
    resolveBookingGuestDietarySeeding(),
  ]);

  const existing = await prisma.bookingImportBatch.findUnique({
    where: { batchKey: bookingImportBatchKey(lodgeId, bookings) },
    select: { id: true, status: true },
  });
  if (existing?.status === BookingImportBatchStatus.REVERSED) {
    return { outcome: "reversed", batchId: existing.id };
  }
  const plan = await planBookingImport(prisma, {
    lodgeId,
    bookings,
    today,
    format,
    batchId: existing?.id ?? null,
  });
  if (plan.digest !== input.digest) return { outcome: "stale", plan };

  const batchId = existing?.id ?? (await createBatch(plan, officerMemberId));
  await prisma.bookingImportRow.createMany({
    data: plan.rows.map((row) => ({
      batchId,
      lodgeId,
      bookingRef: row.bookingRef,
      firstLineNumber: row.firstLineNumber,
      status: row.outcome === "IMPORT" ? BookingImportRowStatus.PENDING : BookingImportRowStatus.REFUSED,
      refusalReason: row.outcome === "IMPORT" ? null : joinBookingImportRefusals(row.refusals),
      refusalCode: row.outcome === "IMPORT" ? null : (row.refusals[0]?.code ?? null),
      amountCents: row.amountCents,
      guestCount: row.guestCount,
      guestNightCount: row.guestNightCount,
      decidedAt: row.outcome === "IMPORT" ? null : new Date(),
    })),
    skipDuplicates: true,
  });

  const byRef = new Map(bookings.map((booking) => [booking.bookingRef, booking]));
  const pending = await prisma.bookingImportRow.findMany({
    where: { batchId, status: BookingImportRowStatus.PENDING },
    orderBy: { firstLineNumber: "asc" },
    select: { id: true, bookingRef: true },
  });
  for (const row of pending) {
    const booking = byRef.get(row.bookingRef);
    // The batch key covers every booking in the file, so a pending row's booking is here.
    if (!booking) throw new Error("A pending import row has no booking in the confirmed file");
    await importOneBooking({
      batchId,
      rowId: row.id,
      lodgeId,
      booking,
      officerMemberId,
      today,
      format,
      journal,
      dietarySeeding,
    });
  }

  const remaining = await prisma.bookingImportRow.count({
    where: { batchId, status: BookingImportRowStatus.PENDING },
  });
  if (remaining === 0) {
    const completed = await prisma.bookingImportBatch.updateMany({
      where: { id: batchId, status: BookingImportBatchStatus.OPEN },
      data: { status: BookingImportBatchStatus.COMPLETED, completedAt: new Date() },
    });
    if (completed.count === 1) {
      const imported = await prisma.bookingImportRow.count({
        where: { batchId, status: BookingImportRowStatus.IMPORTED },
      });
      logAudit({
        action: "booking_import.completed",
        memberId: officerMemberId,
        actorMemberId: officerMemberId,
        entityType: "BookingImportBatch",
        entityId: batchId,
        targetId: batchId,
        category: "booking",
        outcome: "success",
        summary: "Paid-booking import batch completed",
        metadata: {
          lodgeId,
          bookings: plan.rows.length,
          imported,
          refused: plan.rows.length - imported,
        },
      });
    }
  }

  const rows = await prisma.bookingImportRow.findMany({
    where: { batchId },
    orderBy: { firstLineNumber: "asc" },
    select: { bookingRef: true, status: true, bookingId: true, refusalReason: true, refusalCode: true },
  });
  return {
    outcome: "completed",
    batchId,
    rows: rows.map((row): BookingImportRowResult =>
      row.status === BookingImportRowStatus.IMPORTED && row.bookingId
        ? { bookingRef: row.bookingRef, outcome: "IMPORTED", bookingId: row.bookingId }
        : {
            bookingRef: row.bookingRef,
            outcome: "REFUSED",
            refusals: splitBookingImportRefusals(row.refusalReason, row.refusalCode),
          },
    ),
  };
}

/** Creates the batch, or finds the one a concurrent confirm of the same file just created. */
async function createBatch(plan: BookingImportPlan, officerMemberId: string): Promise<string> {
  const totals = {
    bookingCount: plan.importTotals.bookings + plan.refusedTotals.bookings,
    guestCount: plan.importTotals.guests + plan.refusedTotals.guests,
    guestNightCount: plan.importTotals.guestNights + plan.refusedTotals.guestNights,
    amountCents: plan.importTotals.amountCents + plan.refusedTotals.amountCents,
  };
  try {
    const batch = await prisma.bookingImportBatch.create({
      data: {
        lodgeId: plan.lodgeId,
        batchKey: plan.batchKey,
        digest: plan.digest,
        confirmedByMemberId: officerMemberId,
        ...totals,
      },
      select: { id: true },
    });
    return batch.id;
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") throw err;
    const batch = await prisma.bookingImportBatch.findUniqueOrThrow({
      where: { batchKey: plan.batchKey },
      select: { id: true },
    });
    return batch.id;
  }
}

type ImportOneInput = {
  batchId: string;
  rowId: string;
  lodgeId: string;
  booking: ParsedImportBooking;
  officerMemberId: string;
  today: Date;
  format: ClubDateFormat;
  journal: BookingJournalContext;
  dietarySeeding: BookingGuestDietarySeeding;
};

async function importOneBooking(input: ImportOneInput): Promise<void> {
  let created: { bookingId: string; resolved: ResolvedImportBooking } | null;
  try {
    created = await prisma.$transaction((tx) => writeOneBooking(tx, input), {
      timeout: 30_000,
    });
  } catch (err) {
    const refusals =
      err instanceof ImportRowRefused
        ? err.refusals
        : err instanceof ManualBookingPaymentError
          ? [{ code: "NOT_SETTLED" as const, message: `The payment could not be recorded: ${err.message}` }]
          : null;
    if (!refusals) throw err;
    // Guarded on PENDING: a concurrent confirm that imported the row wins.
    await prisma.bookingImportRow.updateMany({
      where: { id: input.rowId, status: BookingImportRowStatus.PENDING },
      data: {
        status: BookingImportRowStatus.REFUSED,
        refusalReason: joinBookingImportRefusals(refusals),
        refusalCode: refusals[0]?.code ?? null,
        decidedAt: new Date(),
      },
    });
    return;
  }
  if (!created) return;

  const { bookingId, resolved } = created;
  // `INV-HOST-039`: the confirming path drains the coverage work it may have
  // queued. The row was refused if it would leave anyone uncovered (O3).
  await settleHostingCoverageAfterCommit({ bookingId });
  logAudit({
    action: "booking_import.booking_imported",
    memberId: input.officerMemberId,
    actorMemberId: input.officerMemberId,
    subjectMemberId: resolved.ownerMemberId,
    entityType: "Booking",
    entityId: bookingId,
    targetId: bookingId,
    category: "booking",
    outcome: "success",
    summary: "Paid booking imported from another booking system",
    metadata: {
      batchId: input.batchId,
      bookingRef: resolved.bookingRef,
      amountCents: resolved.totalCents,
      guestCount: resolved.guests.length,
    },
  });
}

/**
 * One booking, under its locks. Returns null when another confirm already
 * decided the row; throws `ImportRowRefused` to roll back and refuse it.
 */
async function writeOneBooking(
  tx: Prisma.TransactionClient,
  input: ImportOneInput,
): Promise<{ bookingId: string; resolved: ResolvedImportBooking } | null> {
  const { batchId, rowId, lodgeId, booking, officerMemberId } = input;

  // `INV-LOCK-001`: lock(1) excludes cancel, capture, refund and hold release
  // while the booking is created and settled; the lodge key serialises the bed
  // claim with every other writer at this lodge (`INV-LOCK-002`).
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
  await acquireLodgeCapacityLock(tx, lodgeId);

  // Every planner check again, under the locks: lodge, members, Booking Ref,
  // person-night (whose keys it takes), hosting, supervision and capacity.
  const { lodge, activeLodgeCount } = await loadBookingImportLodge(tx, lodgeId);
  if (!lodge) throw new Error("The lodge to import into does not exist");
  const context = { lodge, activeLodgeCount, today: input.today, format: input.format };
  const members = await loadBookingImportMembers(tx, [booking]);
  const { resolved, refusals } = resolveImportBooking(booking, context, members);
  if (!resolved) throw new ImportRowRefused(refusals);
  const checked = await checkImportBooking(tx, context, resolved, {
    file: emptyBookingImportFileState(),
    batchId,
    lock: true,
  });
  if (checked.refusals.length > 0) throw new ImportRowRefused(checked.refusals);

  const claimed = await tx.bookingImportRow.updateMany({
    where: { id: rowId, status: BookingImportRowStatus.PENDING },
    data: { status: BookingImportRowStatus.IMPORTED, decidedAt: new Date() },
  });
  if (claimed.count === 0) return null;

  const guests = await importGuestRows(tx, resolved, officerMemberId);
  const dietary = await resolveBookingGuestDietary(tx, input.dietarySeeding, guests);
  const created = await tx.booking.create({
    data: {
      memberId: resolved.ownerMemberId,
      lodgeId,
      checkIn: resolved.checkIn,
      checkOut: resolved.checkOut,
      status: BookingStatus.PAYMENT_PENDING,
      totalPriceCents: resolved.totalCents,
      finalPriceCents: resolved.totalCents,
      hasNonMembers: resolved.guests.some((guest) => !guest.isMember),
      notes: resolved.notes || null,
      createdById: officerMemberId,
      guests: {
        create: guests.map((guest, index) => toPipelineGuestCreateData(guest, dietary[index])),
      },
    },
    select: { id: true },
  });

  if (resolved.totalCents > 0) {
    // The one settlement body (`INV-PAY-038`): it re-derives the amount owing
    // under the locks, refuses a booking that does not fit (`INV-PAY-040`),
    // writes the manual provenance and the CASH_RECORDED line, and places beds.
    await settleImportedBookingInTransaction(
      tx,
      created.id,
      {
        actingAdminMemberId: officerMemberId,
        note: `Imported paid booking: batch ${batchId}, Booking Ref ${resolved.bookingRef}`,
        expectedAmountCents: resolved.totalCents,
      },
      input.journal,
    );
  } else {
    // A free stay: the manual settle refuses nothing owing, so it takes the
    // zero-price confirmation path `createConfirmedBooking` uses (#4660): a $0
    // payment, PAID, the confirmation lines, and bed placement.
    await tx.payment.create({
      data: {
        bookingId: created.id,
        amountCents: 0,
        creditAppliedCents: 0,
        status: PaymentStatus.SUCCEEDED,
      },
    });
    const confirmed = await tx.booking.updateMany({
      where: { id: created.id, status: BookingStatus.PAYMENT_PENDING },
      data: { status: BookingStatus.PAID },
    });
    if (confirmed.count !== 1) throw new Error("The free imported booking lost its confirmation claim");
    await postStoredBookingConfirmationLedgerLines(tx, created.id, input.journal);
    await reconcileBedAllocationsForBookingWithGlobalLockHeld({ bookingId: created.id, db: tx });
  }

  // `INV-HOST-030`: last inside the transaction, so it sees the booking as
  // created. The planner already refused an uncovered party (O3); a violation
  // here means the club's rule moved under the locks, so the row is refused.
  const hosting = await recordAdultMemberHostingReviewForNewBooking(created.id, tx, null);
  if (hosting.violation) {
    throw new ImportRowRefused([BOOKING_IMPORT_HOSTING_REFUSAL]);
  }

  await tx.bookingEvent.createMany({
    data: [BookingEventType.CREATED, BookingEventType.MEMBER_PAID].map((type) => ({
      bookingId: created.id,
      type,
      actorMemberId: officerMemberId,
      amountCents: resolved.totalCents,
      reason: type === BookingEventType.MEMBER_PAID ? "booking_import" : null,
    })),
  });
  await tx.bookingImportRow.update({ where: { id: rowId }, data: { bookingId: created.id } });
  return { bookingId: created.id, resolved };
}

/**
 * The guest rows at the imported price, with EVEN_SPLIT nights
 * (`INV-MONEY-028`). A member guest from outside the owner's family is an
 * officer assignment, never a pending consent request (`INV-GUEST-005`,
 * `INV-GUEST-011`); its notice is not sent, because the import sends nothing.
 */
async function importGuestRows(
  tx: Prisma.TransactionClient,
  booking: ResolvedImportBooking,
  officerMemberId: string,
) {
  const memberIds = booking.guests.flatMap((guest) => (guest.memberId ? [guest.memberId] : []));
  const boundary = await computeMemberGuestBoundary(tx, booking.ownerMemberId, memberIds);
  const now = new Date();
  return booking.guests.map((guest) => {
    const scope = guest.memberId ? boundary.scopeByMemberId.get(guest.memberId) : undefined;
    const consent =
      scope === "BEYOND_FAMILY"
        ? buildMemberGuestConsentWrite({
            scope,
            approvalRequired: true,
            actor: { kind: "ADMIN", adminMemberId: officerMemberId },
            now,
          }).columns
        : undefined;
    return {
      firstName: guest.firstName,
      lastName: guest.lastName,
      ageTier: guest.ageTier,
      isMember: guest.isMember,
      memberId: guest.memberId,
      stayStart: guest.stayStart,
      stayEnd: guest.stayEnd,
      priceCents: guest.priceCents,
      memberGuestConsent: consent,
      nights: buildApprovalGuestNights({
        checkIn: guest.stayStart,
        checkOut: guest.stayEnd,
        priceCents: guest.priceCents,
      }),
    };
  });
}
