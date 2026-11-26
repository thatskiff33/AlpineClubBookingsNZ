/**
 * What the Lodge Operations chore and work-party officer actions return
 * (ALP-722, `INV-MCP-006`). The catalogue entry and the route's
 * `connectionJson` both read these (`INV-SSOT`).
 *
 * Kept: what an officer's AI app needs to read and change a chore or a work
 * party: ids, names, dates, the discount, counts and money in integer cents.
 * Dropped: row timestamps, the work party's internal promo code id, and the
 * email address of each member whose booking attends a work party.
 *
 * The chore list route answers the browser a bare array; a connection's
 * answer must be an object, so the route sends a connection the list under
 * `chores`.
 *
 * Types only from the route modules: nothing here reaches the database.
 */
import type { BookingStatus, ChoreTemplate, WorkPartyEvent } from "@prisma/client";

import { type ConnectionShapeFor, connectionShapeFor } from "@/lib/connection-projection";

// ---------------------------------------------------------------------------
// Chores
// ---------------------------------------------------------------------------

const CHORE_SHAPE = {
  id: true,
  name: true,
  description: true,
  recommendedPeopleMin: true,
  recommendedPeopleMax: true,
  isEssential: true,
  ageRestriction: true,
  conditionalNote: true,
  minAge: true,
  sortOrder: true,
  timeOfDay: true,
  frequencyMode: true,
  frequencyDays: true,
  frequencyDaysOfWeek: true,
  active: true,
  lodgeId: true,
} as const satisfies ConnectionShapeFor<ChoreTemplate>;

export const ADMIN_CHORE_CONNECTION_SHAPE = connectionShapeFor<ChoreTemplate>(CHORE_SHAPE);

export const ADMIN_CHORE_LIST_CONNECTION_SHAPE = connectionShapeFor<{ chores: ChoreTemplate[] }>({
  chores: CHORE_SHAPE,
});

// ---------------------------------------------------------------------------
// Work parties
// ---------------------------------------------------------------------------

const WORK_PARTY_SHAPE = {
  id: true,
  name: true,
  description: true,
  startDate: true,
  endDate: true,
  discountPercent: true,
  active: true,
  lodgeId: true,
} as const satisfies ConnectionShapeFor<WorkPartyEvent>;

/** One work party of `GET /api/admin/work-parties`, with what the card shows beside it. */
export type AdminWorkPartyListRow = WorkPartyEvent & {
  lodgeName: string | null;
  onCalendar: boolean;
  canAddToCalendar: boolean;
  bookingCount: number;
  totalDiscountCents: number;
};

export const ADMIN_WORK_PARTY_LIST_CONNECTION_SHAPE = connectionShapeFor<{ events: AdminWorkPartyListRow[] }>({
  events: {
    ...WORK_PARTY_SHAPE,
    lodgeName: true,
    onCalendar: true,
    canAddToCalendar: true,
    bookingCount: true,
    totalDiscountCents: true,
  },
});

/** `GET /api/admin/work-parties/[id]`: the work party and each booking attending it. */
export type AdminWorkPartyDetail = {
  event: WorkPartyEvent;
  attendingBookings: Array<{
    id: string;
    discountCents: number;
    createdAt: Date;
    booking: { id: string; checkIn: Date; checkOut: Date; status: BookingStatus; finalPriceCents: number };
    /** Null for a redemption with no member (a non-member booking). */
    member: { id: string; firstName: string; lastName: string; email: string } | null;
  }>;
  totalDiscountCents: number;
};

export const ADMIN_WORK_PARTY_DETAIL_CONNECTION_SHAPE = connectionShapeFor<AdminWorkPartyDetail>({
  event: WORK_PARTY_SHAPE,
  attendingBookings: {
    id: true,
    discountCents: true,
    booking: { id: true, checkIn: true, checkOut: true, status: true, finalPriceCents: true },
    member: { id: true, firstName: true, lastName: true },
  },
  totalDiscountCents: true,
});

/** The create's answer; `calendarWarning` says when the calendar entries could not be written. */
export const ADMIN_WORK_PARTY_CREATED_CONNECTION_SHAPE = connectionShapeFor<{
  event: WorkPartyEvent;
  calendarWarning: string | null;
}>({
  event: WORK_PARTY_SHAPE,
  calendarWarning: true,
});

export const ADMIN_WORK_PARTY_UPDATED_CONNECTION_SHAPE = connectionShapeFor<{ event: WorkPartyEvent }>({
  event: WORK_PARTY_SHAPE,
});

export const ADMIN_WORK_PARTY_CALENDAR_CONNECTION_SHAPE = connectionShapeFor<{ entryCount: number }>({
  entryCount: true,
});
