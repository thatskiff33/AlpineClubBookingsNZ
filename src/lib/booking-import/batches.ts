/**
 * What the import screen reads (#5005, child C): the dry run, the batch list,
 * and one batch's totals beside its reversal preview. Read-only. Totals come from
 * the stored rows, so the finished batch can be checked against the old
 * system's records: imported plus refused equals the file.
 */
import { BookingImportRowStatus, type BookingImportBatchStatus } from "@prisma/client";

import type { ParsedImportBooking } from "@/lib/booking-import/parse";
import { bookingImportBatchKey, planBookingImport, type BookingImportPlan } from "@/lib/booking-import/plan";
import { planBookingImportReversal, type BookingImportReversalPlan } from "@/lib/booking-import/reverse";
import type { ClubDateFormat } from "@/lib/club-time";
import { prisma } from "@/lib/prisma";

export type BookingImportTotalsSummary = {
  bookings: number;
  guests: number;
  guestNights: number;
  amountCents: number;
};

export type BookingImportBatchSummary = {
  id: string;
  lodgeId: string;
  lodgeName: string;
  status: BookingImportBatchStatus;
  confirmedAt: string;
  confirmedByName: string | null;
  completedAt: string | null;
  reversedAt: string | null;
  reversedByName: string | null;
  /** Every booking in the file, as confirmed. */
  file: BookingImportTotalsSummary;
  imported: BookingImportTotalsSummary;
  refused: BookingImportTotalsSummary;
  reversed: BookingImportTotalsSummary;
  /** Bookings a stopped confirm has not reached yet. */
  pending: number;
};

const BATCH_SELECT = {
  id: true,
  lodgeId: true,
  status: true,
  confirmedAt: true,
  confirmedByMemberId: true,
  completedAt: true,
  reversedAt: true,
  reversedByMemberId: true,
  bookingCount: true,
  guestCount: true,
  guestNightCount: true,
  amountCents: true,
  lodge: { select: { name: true } },
} as const;

/** The most recent batches the list shows. */
const BATCH_LIST_LIMIT = 100;

async function summarise(
  batches: Awaited<ReturnType<typeof readBatches>>,
): Promise<BookingImportBatchSummary[]> {
  if (batches.length === 0) return [];
  const ids = batches.map((batch) => batch.id);
  const grouped = await prisma.bookingImportRow.groupBy({
    by: ["batchId", "status"],
    where: { batchId: { in: ids } },
    _count: { _all: true },
    _sum: { guestCount: true, guestNightCount: true, amountCents: true },
  });
  const officerIds = [
    ...new Set(
      batches.flatMap((batch) =>
        batch.reversedByMemberId ? [batch.confirmedByMemberId, batch.reversedByMemberId] : [batch.confirmedByMemberId],
      ),
    ),
  ];
  // Actor ids are plain columns (`INV-PRIV-011`); a merged or erased officer has no name.
  const officers = await prisma.member.findMany({
    where: { id: { in: officerIds } },
    select: { id: true, firstName: true, lastName: true },
  });
  const nameOf = (id: string | null) => {
    const officer = id ? officers.find((member) => member.id === id) : undefined;
    return officer ? `${officer.firstName} ${officer.lastName}`.trim() : null;
  };
  const totalsFor = (batchId: string, status: BookingImportRowStatus): BookingImportTotalsSummary => {
    const group = grouped.find((entry) => entry.batchId === batchId && entry.status === status);
    return {
      bookings: group?._count._all ?? 0,
      guests: group?._sum.guestCount ?? 0,
      guestNights: group?._sum.guestNightCount ?? 0,
      amountCents: group?._sum.amountCents ?? 0,
    };
  };
  return batches.map((batch) => ({
    id: batch.id,
    lodgeId: batch.lodgeId,
    lodgeName: batch.lodge.name,
    status: batch.status,
    confirmedAt: batch.confirmedAt.toISOString(),
    confirmedByName: nameOf(batch.confirmedByMemberId),
    completedAt: batch.completedAt?.toISOString() ?? null,
    reversedAt: batch.reversedAt?.toISOString() ?? null,
    reversedByName: nameOf(batch.reversedByMemberId),
    file: {
      bookings: batch.bookingCount,
      guests: batch.guestCount,
      guestNights: batch.guestNightCount,
      amountCents: batch.amountCents,
    },
    imported: totalsFor(batch.id, BookingImportRowStatus.IMPORTED),
    refused: totalsFor(batch.id, BookingImportRowStatus.REFUSED),
    reversed: totalsFor(batch.id, BookingImportRowStatus.REVERSED),
    pending: totalsFor(batch.id, BookingImportRowStatus.PENDING).bookings,
  }));
}

function readBatches(where: { id?: string }) {
  return prisma.bookingImportBatch.findMany({
    where,
    orderBy: [{ confirmedAt: "desc" }, { id: "desc" }],
    take: BATCH_LIST_LIMIT,
    select: BATCH_SELECT,
  });
}

/** The batches confirmed so far, newest first. */
export async function listBookingImportBatches(): Promise<BookingImportBatchSummary[]> {
  return summarise(await readBatches({}));
}

/**
 * One batch: its totals and, for every booking in it, what a reversal would
 * do and why. Null when there is no such batch.
 */
export async function getBookingImportBatch(input: {
  batchId: string;
  today: Date;
}): Promise<{ batch: BookingImportBatchSummary; reversal: BookingImportReversalPlan } | null> {
  const [batch] = await summarise(await readBatches({ id: input.batchId }));
  if (!batch) return null;
  const reversal = await planBookingImportReversal(prisma, { batchId: batch.id, today: input.today });
  if (!reversal) return null;
  return { batch, reversal };
}

/**
 * The dry run: the plan the officer confirms, and the batch the same file
 * already made, if any (so a repeated upload resumes it rather than starting
 * again). Writes nothing. Null when the lodge does not exist.
 */
export async function previewBookingImport(input: {
  lodgeId: string;
  bookings: readonly ParsedImportBooking[];
  today: Date;
  format: ClubDateFormat;
}): Promise<{ plan: BookingImportPlan; existingBatch: { id: string; status: BookingImportBatchStatus } | null } | null> {
  const lodge = await prisma.lodge.findUnique({ where: { id: input.lodgeId }, select: { id: true } });
  if (!lodge) return null;
  const existingBatch = await prisma.bookingImportBatch.findUnique({
    where: { batchKey: bookingImportBatchKey(input.lodgeId, input.bookings) },
    select: { id: true, status: true },
  });
  const plan = await planBookingImport(prisma, { ...input, batchId: existingBatch?.id ?? null });
  return { plan, existingBatch };
}
