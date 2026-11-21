/**
 * What a member may read about themselves through the JSON API (ALP-653).
 *
 * The bookings and profile pages read the database directly and render it, so
 * there was no route an AI app connection could be pointed at. These are the
 * reads behind `GET /api/bookings/mine`, `GET /api/bookings/[id]` and
 * `GET /api/profile/summary`: a fixed list of fields, chosen for a member
 * looking at their own record, and nothing an officer-only screen shows.
 */
import "server-only";

import type { Prisma } from "@prisma/client";

import { bookingsWithOpenFinancialReview } from "@/lib/booking-financial-review-visibility";
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

/** A member's bookings as they are listed: newest stay first, stable within a day (#771). */
export const MEMBER_BOOKING_LIST_ORDER = [
  { checkIn: "desc" },
  { createdAt: "desc" },
] as const satisfies Prisma.BookingOrderByWithRelationInput[];

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
  /** Null when the member is a guest on someone else's booking: not theirs to see. */
  readonly finalPriceCents: number | null;
  /**
   * True while a change to the booking has money held for an officer to check
   * (#3033), so the price is not yet the last word. The bookings page says
   * "being checked" beside the same figure.
   */
  readonly priceBeingChecked: boolean;
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

function toSummary(
  row: MemberBookingRow,
  memberId: string,
  underFinancialReview: ReadonlySet<string>,
): MemberBookingSummary {
  const madeByMe = bookingOwner(row).memberId === memberId;
  return {
    id: row.id,
    status: row.status,
    checkIn: calendarDateOfDateOnlyInstant(row.checkIn),
    checkOut: calendarDateOfDateOnlyInstant(row.checkOut),
    lodge: row.lodge,
    // The price and the organiser's note belong to the member who booked.
    finalPriceCents: madeByMe ? row.finalPriceCents : null,
    priceBeingChecked: madeByMe && underFinancialReview.has(row.id),
    madeByMe,
    notes: madeByMe ? row.notes : null,
    guests: row.guests,
  };
}

export const MEMBER_BOOKING_LIST_LIMIT = 200;

export interface MemberBookingList {
  readonly bookings: MemberBookingSummary[];
  /** True when the member has older bookings than the ones listed. */
  readonly truncated: boolean;
}

export async function listMemberBookingSummaries(memberId: string): Promise<MemberBookingList> {
  const found = await prisma.booking.findMany({
    where: memberVisibleBookingWhere(memberId),
    select: MEMBER_BOOKING_SUMMARY_SELECT,
    orderBy: [...MEMBER_BOOKING_LIST_ORDER],
    // One more than is returned, so a longer list is known and never guessed.
    take: MEMBER_BOOKING_LIST_LIMIT + 1,
  });
  const rows = found.slice(0, MEMBER_BOOKING_LIST_LIMIT);
  const underFinancialReview = await bookingsWithOpenFinancialReview(rows.map((row) => row.id));
  return {
    bookings: rows.map((row) => toSummary(row, memberId, underFinancialReview)),
    truncated: found.length > MEMBER_BOOKING_LIST_LIMIT,
  };
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
  if (!row) return null;
  return toSummary(row, memberId, await bookingsWithOpenFinancialReview([row.id]));
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

/*
 * What an AI app connection receives from three routes the website also
 * reads (ALP-653). Each route answers the website exactly as before; only a
 * request carrying the principal header (`arrivesAsMcpConnection`) gets the
 * narrower answer below, so the connection is sent what its action needs and
 * nothing a browser screen happens to use.
 */

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
  readonly guests: MemberBookingSummary["guests"];
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

export interface MemberFamilyForConnection {
  readonly displayName: string | null;
  readonly familyMembers: ReadonlyArray<{
    readonly id: string;
    readonly firstName: string;
    readonly lastName: string;
    readonly ageTier: string;
    readonly relationship: string;
    readonly canBeBooked: boolean;
  }>;
}

interface FamilyMemberBody {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: string;
  relationship: string;
  canBeBooked: boolean;
}

/**
 * The family answer narrowed to who can go on a booking: no dates of birth,
 * email addresses, parent links, notes or pending-request details.
 */
export function familyForConnection(body: {
  displayName?: string | null;
  familyMembers?: ReadonlyArray<FamilyMemberBody>;
}): MemberFamilyForConnection {
  return {
    displayName: body.displayName ?? null,
    familyMembers: (body.familyMembers ?? []).map((member) => ({
      id: member.id,
      firstName: member.firstName,
      lastName: member.lastName,
      ageTier: member.ageTier,
      relationship: member.relationship,
      canBeBooked: member.canBeBooked,
    })),
  };
}

/** Subscription-status fields a connection is not sent: the invoice links open the invoice for anyone holding them. */
export const SUBSCRIPTION_FIELDS_WITHHELD_FROM_CONNECTIONS = ["invoiceUrl", "rawInvoiceUrl"] as const;
