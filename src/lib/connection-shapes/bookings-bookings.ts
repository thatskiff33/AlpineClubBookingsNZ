/**
 * What the Bookings & Beds booking officer actions return (ALP-719,
 * `INV-MCP-006`): the booking calendar and search, the on-behalf pickers, and
 * the officer tools on one booking (`/api/admin/bookings/**`). The catalogue
 * entry and the route's `connectionJson` both read these (`INV-SSOT`).
 *
 * Where a route builds its answer inline, the answer's type is declared here
 * and the route builds its answer as that type, so a shape cannot name a field
 * the route does not send. Types only from the route modules: nothing here
 * reaches the database.
 *
 * Left out on purpose, for the connection only (the admin screens still get
 * them): provider references (payment and Xero invoice ids), internal audit
 * action names, the address
 * an email went to, and the booker's email on a search result.
 */
import type { BookingStatus } from "@prisma/client";

import type { copyBookingToDraft } from "@/lib/admin-booking-copy";
import type { BookingFreshCopyTemplate } from "@/lib/booking-fresh-email-copy-templates";
import type { HoldConflictBooking } from "@/lib/capacity";
import { connectionShapeFor, eachEntry, type ConnectionShapeFor } from "@/lib/connection-projection";
import type { PartnerSharingCandidate } from "@/lib/double-bed-sharing";
import type { MemberGuestCandidateResponse } from "@/lib/member-guest-find";
import type { NonMemberContactResult, NonMemberContactSuggestion } from "@/lib/non-member-contact";
import type { writeRequestedRoom } from "@/lib/requested-room-write";
import type { ResolvedMemberFamily } from "@/lib/resolve-member-family";

// ── The booking list and search ─────────────────────────────────────────────

/** One booking on the month calendar (`GET /api/admin/bookings`). */
export interface AdminCalendarBooking {
  id: string;
  memberName: string;
  checkIn: string;
  checkOut: string;
  status: string;
  deletedAt: string | null;
  /** The most guests on any one night of the booking inside the month. */
  guestCount: number;
}

export interface AdminBookingsCalendarAnswer {
  bookings: AdminCalendarBooking[];
  /** Free beds per night, keyed `YYYY-MM-DD`; empty for an all-lodges view. */
  availability: Record<string, number>;
}

export const ADMIN_BOOKINGS_CALENDAR_CONNECTION_SHAPE = connectionShapeFor<AdminBookingsCalendarAnswer>({
  bookings: {
    id: true,
    memberName: true,
    checkIn: true,
    checkOut: true,
    status: true,
    deletedAt: true,
    guestCount: true,
  },
  availability: eachEntry(true),
});

/** One search result (`GET /api/admin/bookings/search`). */
export interface AdminBookingSearchResult {
  id: string;
  memberName: string;
  memberEmail: string | null;
  checkIn: string;
  checkOut: string;
  status: string;
  deletedAt: string | null;
  guestCount: number;
  paymentId: string | null;
  xeroInvoiceId: string | null;
  canForceSyncInvoice: boolean;
  forceSyncInvoiceReason: string | null;
}

export interface AdminBookingSearchAnswer {
  bookings: AdminBookingSearchResult[];
}

export const ADMIN_BOOKING_SEARCH_CONNECTION_SHAPE = connectionShapeFor<AdminBookingSearchAnswer>({
  bookings: {
    id: true,
    memberName: true,
    checkIn: true,
    checkOut: true,
    status: true,
    deletedAt: true,
    guestCount: true,
  },
});

// ── On-behalf pickers ───────────────────────────────────────────────────────

const MEMBER_FAMILY_SHAPE = {
  familyGroupId: true,
  familyGroupName: true,
  familyGroupIds: true,
  familyMembers: { id: true, firstName: true, lastName: true, ageTier: true, relationship: true },
  ownDependants: { id: true, firstName: true, lastName: true },
} as const;

/** `GET /api/admin/bookings/eligible-family?forMemberId=`. */
export const ADMIN_MEMBER_FAMILY_CONNECTION_SHAPE = connectionShapeFor<ResolvedMemberFamily>(MEMBER_FAMILY_SHAPE);

/** `GET /api/admin/bookings/[id]/eligible-family`. */
export type AdminBookingEligibleFamilyAnswer = ResolvedMemberFamily & {
  partnerSharingCandidates: PartnerSharingCandidate[];
};

export const ADMIN_BOOKING_ELIGIBLE_FAMILY_CONNECTION_SHAPE = connectionShapeFor<AdminBookingEligibleFamilyAnswer>({
  ...MEMBER_FAMILY_SHAPE,
  partnerSharingCandidates: {
    id: true,
    firstName: true,
    lastName: true,
    partnerOfMemberId: true,
    partnerOfName: true,
  },
});

/**
 * `GET /api/admin/bookings/non-member-contact`: a contact read, so the
 * address and phone the officer matches on are kept.
 */
export const ADMIN_NON_MEMBER_CONTACT_SUGGESTIONS_CONNECTION_SHAPE = connectionShapeFor<{
  contacts: NonMemberContactSuggestion[];
}>({
  contacts: {
    id: true,
    firstName: true,
    lastName: true,
    email: true,
    isPlaceholderEmail: true,
    role: true,
    phoneNumber: true,
    bookingCount: true,
  },
});

/** `POST /api/admin/bookings/non-member-contact`. */
export const ADMIN_NON_MEMBER_CONTACT_CONNECTION_SHAPE = connectionShapeFor<{
  contact: NonMemberContactResult;
  reused: boolean;
}>({
  contact: { id: true, firstName: true, lastName: true, email: true, isPlaceholderEmail: true },
  reused: true,
});

const MEMBER_GUEST_CANDIDATE_SHAPE = { memberId: true, firstName: true, lastName: true, ageTier: true } as const;

/** `POST /api/admin/bookings/[id]/member-guest-candidates`, the email mode: `candidates` alone. */
export const ADMIN_MEMBER_GUEST_EMAIL_CANDIDATES_CONNECTION_SHAPE = connectionShapeFor<MemberGuestCandidateResponse>({
  candidates: MEMBER_GUEST_CANDIDATE_SHAPE,
});

/** `GET /api/admin/bookings/[id]/member-guest-candidates`, the name mode: adds `truncated`. */
export const ADMIN_MEMBER_GUEST_NAME_CANDIDATES_CONNECTION_SHAPE = connectionShapeFor<MemberGuestCandidateResponse>({
  candidates: MEMBER_GUEST_CANDIDATE_SHAPE,
  truncated: true,
});

// ── Officer tools on one booking ────────────────────────────────────────────

/** `POST /api/admin/bookings/[id]/copy`. */
export const ADMIN_BOOKING_COPY_CONNECTION_SHAPE = connectionShapeFor<
  Awaited<ReturnType<typeof copyBookingToDraft>>
>({
  bookingId: true,
  sourceBookingId: true,
  checkIn: true,
  checkOut: true,
  status: true,
});

/** `POST /api/admin/bookings/[id]/additional-payment-reminder`. */
export interface AdminAdditionalPaymentReminderAnswer {
  success: true;
  sentAt: Date;
  additionalAmountCents: number;
}

export const ADMIN_ADDITIONAL_PAYMENT_REMINDER_CONNECTION_SHAPE =
  connectionShapeFor<AdminAdditionalPaymentReminderAnswer>({
    success: true,
    sentAt: true,
    additionalAmountCents: true,
  });

/** `POST /api/admin/bookings/[id]/capacity-hold`. */
export interface AdminCapacityHoldAnswer {
  success: true;
  overbooked: boolean;
  overbookDates: string[];
  adminCapacityHoldAt: Date | null;
}

export const ADMIN_CAPACITY_HOLD_CONNECTION_SHAPE = connectionShapeFor<AdminCapacityHoldAnswer>({
  success: true,
  overbooked: true,
  overbookDates: true,
  adminCapacityHoldAt: true,
});

/** `DELETE /api/admin/bookings/[id]/capacity-hold`. */
export interface AdminCapacityHoldReleaseAnswer {
  success: true;
}

export const ADMIN_CAPACITY_HOLD_RELEASE_CONNECTION_SHAPE = connectionShapeFor<AdminCapacityHoldReleaseAnswer>({
  success: true,
});

/**
 * One booking overlapping a whole-lodge hold (`HoldConflictBooking`), as every
 * action that lists hold conflicts sends it: this one and the booking-request
 * hold and approval actions (`INV-SSOT`).
 */
export const HOLD_CONFLICT_CONNECTION_FIELDS = {
  id: true,
  memberName: true,
  checkIn: true,
  checkOut: true,
  guestCount: true,
  status: true,
  overridden: true,
} as const satisfies ConnectionShapeFor<HoldConflictBooking>;

/** `POST /api/admin/bookings/[id]/exclusive-hold`. */
export interface AdminExclusiveHoldAnswer {
  success: true;
  wholeLodgeHold: boolean;
  wholeLodgeHoldAt: Date | null;
  conflicts: HoldConflictBooking[];
  bedAllocationReconcile: {
    enabled: boolean;
    deletedCount: number;
    createdCount: number;
    promotedCount: number;
  };
}

export const ADMIN_EXCLUSIVE_HOLD_CONNECTION_SHAPE = connectionShapeFor<AdminExclusiveHoldAnswer>({
  success: true,
  wholeLodgeHold: true,
  wholeLodgeHoldAt: true,
  conflicts: HOLD_CONFLICT_CONNECTION_FIELDS,
  bedAllocationReconcile: { enabled: true, deletedCount: true, createdCount: true, promotedCount: true },
});

/** `POST /api/admin/bookings/[id]/force-confirm`. */
export interface AdminForceConfirmAnswer {
  success: true;
  auditAction: string;
  overbooked: boolean;
  overbookDates: string[];
  status: BookingStatus;
  unpaidFinishedStay: boolean;
}

export const ADMIN_FORCE_CONFIRM_CONNECTION_SHAPE = connectionShapeFor<AdminForceConfirmAnswer>({
  success: true,
  overbooked: true,
  overbookDates: true,
  status: true,
  unpaidFinishedStay: true,
});

/** `POST /api/admin/bookings/[id]/fresh-email-copy`. */
export interface AdminFreshEmailCopyAnswer {
  success: true;
  template: BookingFreshCopyTemplate;
  sentTo: string;
  archivedFailureCount: number;
  warning: string | null;
}

export const ADMIN_FRESH_EMAIL_COPY_CONNECTION_SHAPE = connectionShapeFor<AdminFreshEmailCopyAnswer>({
  success: true,
  template: true,
  archivedFailureCount: true,
  warning: true,
});

/** `POST /api/admin/bookings/[id]/no-emails`. */
export interface AdminNoEmailsAnswer {
  success: true;
  noEmails: boolean;
  noEmailsAt: Date | null;
  noEmailsByMemberId: string | null;
  changed: boolean;
  hasLiveWaitlistOffer: boolean;
}

export const ADMIN_NO_EMAILS_CONNECTION_SHAPE = connectionShapeFor<AdminNoEmailsAnswer>({
  success: true,
  noEmails: true,
  noEmailsAt: true,
  changed: true,
  hasLiveWaitlistOffer: true,
});

type RequestedRoomAnswer = Awaited<ReturnType<typeof writeRequestedRoom>>;

/** `PUT /api/admin/bookings/[id]/requested-room`: the booking and the room it now asks for. */
export const ADMIN_REQUESTED_ROOM_CONNECTION_SHAPE = connectionShapeFor<RequestedRoomAnswer>({
  id: true,
  requestedRoomId: true,
  requestedRoom: { id: true, name: true, active: true },
});

/** `DELETE /api/admin/bookings/[id]/requested-room`: the room is always null after a clear. */
export const ADMIN_REQUESTED_ROOM_CLEARED_CONNECTION_SHAPE = connectionShapeFor<RequestedRoomAnswer>({
  id: true,
  requestedRoomId: true,
});

/** `POST /api/admin/bookings/[id]/return-to-waitlist`. */
export interface AdminReturnToWaitlistAnswer {
  success: true;
  status: BookingStatus;
  /** The place shown to the officer; null while "No emails" is on. */
  waitlistPosition: number | null;
}

export const ADMIN_RETURN_TO_WAITLIST_CONNECTION_SHAPE = connectionShapeFor<AdminReturnToWaitlistAnswer>({
  success: true,
  status: true,
  waitlistPosition: true,
});

/** `GET /api/admin/bookings/[id]/work-party`. */
export interface AdminBookingWorkPartyOptionsAnswer {
  currentWorkParty: { id: string; name: string } | null;
  removal: { eligible: boolean; reason: string | null } | null;
  workParties: Array<{
    id: string;
    name: string;
    startDate: string;
    endDate: string;
    discountPercent: number;
    lodgeName: string | null;
    eligible: boolean;
    reason: string | null;
  }>;
}

export const ADMIN_BOOKING_WORK_PARTY_OPTIONS_CONNECTION_SHAPE =
  connectionShapeFor<AdminBookingWorkPartyOptionsAnswer>({
    currentWorkParty: { id: true, name: true },
    removal: { eligible: true, reason: true },
    workParties: {
      id: true,
      name: true,
      startDate: true,
      endDate: true,
      discountPercent: true,
      lodgeName: true,
      eligible: true,
      reason: true,
    },
  });
