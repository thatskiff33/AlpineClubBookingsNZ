/**
 * What a member may read about themselves through the JSON API (ALP-653).
 *
 * The bookings and profile pages read the database directly and render it, so
 * there was no route an AI app connection could be pointed at. These are the
 * reads behind `GET /api/bookings`, `GET /api/bookings/[id]` and
 * `GET /api/profile`: a fixed list of fields, chosen for a member looking at
 * their own record, and nothing an officer-only screen shows.
 */
import "server-only";

import type { Prisma } from "@prisma/client";

import { bookingOwner } from "@/lib/booking-owner";
import { calendarDateOfDateOnlyInstant } from "@/lib/club-time";
import { prisma } from "@/lib/prisma";

/** A booking the member made, or one they are a guest on. Never a deleted one. */
export function memberVisibleBookingWhere(memberId: string): Prisma.BookingWhereInput {
  return {
    deletedAt: null,
    OR: [{ memberId }, { guests: { some: { memberId } } }],
  };
}

const MEMBER_BOOKING_SUMMARY_SELECT = {
  id: true,
  memberId: true,
  status: true,
  checkIn: true,
  checkOut: true,
  finalPriceCents: true,
  notes: true,
  lodge: { select: { id: true, name: true } },
  guests: {
    select: { firstName: true, lastName: true, ageTier: true, isMember: true },
    orderBy: { id: "asc" },
  },
} as const satisfies Prisma.BookingSelect;

type MemberBookingRow = Prisma.BookingGetPayload<{ select: typeof MEMBER_BOOKING_SUMMARY_SELECT }>;

export interface MemberBookingSummary {
  readonly id: string;
  readonly status: string;
  /** First night, `YYYY-MM-DD`. */
  readonly checkIn: string;
  /** The morning the party leaves, `YYYY-MM-DD`. */
  readonly checkOut: string;
  readonly lodge: { readonly id: string; readonly name: string };
  readonly finalPriceCents: number;
  /** False when the member is a guest on someone else's booking. */
  readonly madeByMe: boolean;
  readonly notes: string | null;
  readonly guests: ReadonlyArray<{
    readonly firstName: string;
    readonly lastName: string;
    readonly ageTier: string;
    readonly isMember: boolean;
  }>;
}

function toSummary(row: MemberBookingRow, memberId: string): MemberBookingSummary {
  const madeByMe = bookingOwner(row).memberId === memberId;
  return {
    id: row.id,
    status: row.status,
    checkIn: calendarDateOfDateOnlyInstant(row.checkIn),
    checkOut: calendarDateOfDateOnlyInstant(row.checkOut),
    lodge: row.lodge,
    // The price and the organiser's note belong to the member who booked.
    finalPriceCents: madeByMe ? row.finalPriceCents : 0,
    madeByMe,
    notes: madeByMe ? row.notes : null,
    guests: row.guests,
  };
}

const MEMBER_BOOKING_LIST_LIMIT = 200;

export async function listMemberBookingSummaries(
  memberId: string,
): Promise<MemberBookingSummary[]> {
  const rows = await prisma.booking.findMany({
    where: memberVisibleBookingWhere(memberId),
    select: MEMBER_BOOKING_SUMMARY_SELECT,
    // The bookings page's order: newest stay first, stable within a day.
    orderBy: [{ checkIn: "desc" }, { createdAt: "desc" }],
    take: MEMBER_BOOKING_LIST_LIMIT,
  });
  return rows.map((row) => toSummary(row, memberId));
}

/** Null for a booking that does not exist and for one that is not theirs. */
export async function getMemberBookingSummary(
  memberId: string,
  bookingId: string,
): Promise<MemberBookingSummary | null> {
  const row = await prisma.booking.findFirst({
    where: { AND: [{ id: bookingId }, memberVisibleBookingWhere(memberId)] },
    select: MEMBER_BOOKING_SUMMARY_SELECT,
  });
  return row ? toSummary(row, memberId) : null;
}

const MEMBER_PROFILE_SUMMARY_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phoneCountryCode: true,
  phoneAreaCode: true,
  phoneNumber: true,
  streetAddressLine1: true,
  streetAddressLine2: true,
  streetCity: true,
  streetRegion: true,
  streetPostalCode: true,
  streetCountry: true,
  ageTier: true,
  twoFactorEnabled: true,
} as const satisfies Prisma.MemberSelect;

export type MemberProfileSummary = Prisma.MemberGetPayload<{
  select: typeof MEMBER_PROFILE_SUMMARY_SELECT;
}>;

export async function getMemberProfileSummary(
  memberId: string,
): Promise<MemberProfileSummary | null> {
  return prisma.member.findUnique({
    where: { id: memberId },
    select: MEMBER_PROFILE_SUMMARY_SELECT,
  });
}
