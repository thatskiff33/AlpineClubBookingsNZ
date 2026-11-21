/**
 * The draft bookings an AI app connection is sent (ALP-653): the website's
 * draft routes answer with every booking and guest column, so a connection
 * gets this narrow shape instead. Kept apart from `member-self-read.ts` so the
 * booking-create route can use it without that module's imports.
 */
import "server-only";

import type { Prisma } from "@prisma/client";

import { calendarDateOfDateOnlyInstant } from "@/lib/club-time";
import { prisma } from "@/lib/prisma";

const MEMBER_DRAFT_SUMMARY_SELECT = {
  id: true,
  status: true,
  checkIn: true,
  checkOut: true,
  draftExpiresAt: true,
  notes: true,
  lodge: { select: { id: true, name: true } },
  guests: {
    select: { firstName: true, lastName: true, ageTier: true, isMember: true },
    orderBy: { id: "asc" },
  },
} as const satisfies Prisma.BookingSelect;

export interface MemberDraftSummary {
  readonly id: string;
  readonly status: string;
  /** First night, `YYYY-MM-DD`. */
  readonly checkIn: string;
  /** The morning the party leaves, `YYYY-MM-DD`. */
  readonly checkOut: string;
  /** When the draft lapses if it is not confirmed. */
  readonly draftExpiresAt: string | null;
  readonly lodge: { readonly id: string; readonly name: string };
  readonly notes: string | null;
  /** Names, age group and member status only: no dietary, consent or stay columns. */
  readonly guests: ReadonlyArray<{
    readonly firstName: string;
    readonly lastName: string;
    readonly ageTier: string;
    readonly isMember: boolean;
  }>;
}

type MemberDraftRow = Prisma.BookingGetPayload<{ select: typeof MEMBER_DRAFT_SUMMARY_SELECT }>;

/** The member's unexpired drafts, newest first: the website's own filter and order. */
export async function listMemberDraftSummaries(
  memberId: string,
  now: Date,
): Promise<MemberDraftSummary[]> {
  const rows = await prisma.booking.findMany({
    where: { memberId, deletedAt: null, status: "DRAFT", draftExpiresAt: { gt: now } },
    select: MEMBER_DRAFT_SUMMARY_SELECT,
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toDraftSummary);
}

/**
 * The draft a connection just created, in the same narrow shape: the create
 * route's own answer carries every booking and guest column, including any
 * dietary note copied from a guest's profile. Null if it is not the member's.
 */
export async function getMemberDraftSummary(
  memberId: string,
  bookingId: string,
): Promise<MemberDraftSummary | null> {
  const row = await prisma.booking.findFirst({
    where: { id: bookingId, memberId, deletedAt: null, status: "DRAFT" },
    select: MEMBER_DRAFT_SUMMARY_SELECT,
  });
  return row ? toDraftSummary(row) : null;
}

function toDraftSummary(row: MemberDraftRow): MemberDraftSummary {
  return {
    id: row.id,
    status: row.status,
    checkIn: calendarDateOfDateOnlyInstant(row.checkIn),
    checkOut: calendarDateOfDateOnlyInstant(row.checkOut),
    draftExpiresAt: row.draftExpiresAt?.toISOString() ?? null,
    lodge: { id: row.lodge.id, name: row.lodge.name },
    notes: row.notes,
    // Mapped field by field, so nothing beyond the four reaches a connection
    // even if the select above is ever widened.
    guests: row.guests.map((guest) => ({
      firstName: guest.firstName,
      lastName: guest.lastName,
      ageTier: guest.ageTier,
      isMember: guest.isMember,
    })),
  };
}
