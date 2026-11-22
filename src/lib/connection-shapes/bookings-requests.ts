/**
 * What the Bookings & Beds booking-request officer actions return (ALP-719,
 * `INV-MCP-006`): the queue of group, school and whole-lodge requests and the
 * officer's steps on one request (`/api/admin/booking-requests/**`). The
 * catalogue entry and the route's `connectionJson` both read these
 * (`INV-SSOT`).
 *
 * Where a route builds its answer inline, the answer's type is declared here
 * and the route builds its answer as that type, so a shape cannot name a field
 * the route does not send. Types only from the route modules: nothing here
 * reaches the database.
 *
 * Left out on purpose, for the connection only (the admin screens still get
 * them): the ids of the officers who priced or reviewed a request (the queue
 * names them), internal quote, other-lodge and school-record ids no action
 * takes, the guest-row ids and the requester-relative flags of a member-night
 * clash in `check_booking_request_member_links`, and the address an
 * attendee-confirmation email went to. A refusal is never projected
 * (`INV-MCP-006`): the 409 a hold, quote or approval answers on a member-night
 * clash carries the clash as the admin screen gets it, guest-row ids included.
 */
import type {
  BookingRequestPricingMode,
  BookingRequestQuoteStatus,
  BookingStatus,
  Role,
} from "@prisma/client";

import type { BookingRequestPendingCounts } from "@/lib/admin-booking-request-pending-counts";
import type { AdminListPage } from "@/lib/admin-list-page";
import type { BookingMemberNightConflict } from "@/lib/booking-member-night-conflicts";
import type { serializeBookingRequestForAdmin } from "@/lib/booking-request";
import type { parseBookingRequestQuoteOptions } from "@/lib/booking-request-quotes";
import type { SuggestedGuestNightRates } from "@/lib/booking-request-suggested-rates";
import type { HoldConflictBooking } from "@/lib/capacity";
import {
  connectionShapeFor,
  eachEntry,
  type ConnectionShapeFor,
  type EveryFieldOf,
} from "@/lib/connection-projection";
import { HOLD_CONFLICT_CONNECTION_FIELDS } from "@/lib/connection-shapes/bookings-bookings";
import type { SchoolRecordPreview } from "@/lib/school-organisation-preview";

// ── One request ─────────────────────────────────────────────────────────────

/** One request as the officer reads it (`serializeBookingRequestForAdmin`). */
export type AdminBookingRequestView = ReturnType<typeof serializeBookingRequestForAdmin>;

const BOOKING_REQUEST_FIELDS = {
  id: true,
  type: true,
  status: true,
  version: true,
  lodgeId: true,
  lodgeName: true,
  otherLodgeName: true,
  exclusivityRequested: true,
  requestedByMemberId: true,
  applyAccountCredit: true,
  schoolName: true,
  teachers: { firstName: true, lastName: true, email: true },
  pendingAdultCount: true,
  pendingAdultsWriteEnabled: true,
  cateringPreference: true,
  linkedGuestMembers: { guestIndex: true, memberId: true },
  contactFirstName: true,
  contactLastName: true,
  contactEmail: true,
  contactPhone: true,
  checkIn: true,
  checkOut: true,
  guests: { firstName: true, lastName: true, ageTier: true },
  // Each sent only when that stored part of the request cannot be read.
  guestDataNeedsAttention: true,
  linkedMemberDataNeedsAttention: true,
  teacherDataNeedsAttention: true,
  message: true,
  indicativePriceCents: true,
  priceCents: true,
  verifiedAt: true,
  pricedAt: true,
  reviewedAt: true,
  declineReason: true,
  convertedBookingId: true,
  convertedMemberId: true,
  attendeesConfirmedAt: true,
  heldBookingId: true,
  acceptedQuoteOptionId: true,
  acceptedPriceCents: true,
  acceptedAt: true,
  responseMessage: true,
  responseMessageAt: true,
  createdAt: true,
} as const satisfies ConnectionShapeFor<AdminBookingRequestView>;

/** `POST /api/admin/booking-requests/[id]/price`: the priced request. */
export const ADMIN_BOOKING_REQUEST_CONNECTION_SHAPE =
  connectionShapeFor<AdminBookingRequestView>(BOOKING_REQUEST_FIELDS);

// ── Quotes ──────────────────────────────────────────────────────────────────

/** One priced option of a quote, as stored. */
export type AdminBookingRequestQuoteOption = ReturnType<typeof parseBookingRequestQuoteOptions>[number];

const QUOTE_OPTION_FIELDS = {
  id: true,
  label: true,
  cateringOption: true,
  totalCents: true,
  pricingMode: true,
  guestNightRates: { ageTier: true, isMember: true, rateCents: true },
  guestBreakdown: {
    guestIndex: true,
    kind: true,
    firstName: true,
    lastName: true,
    ageTier: true,
    isMember: true,
    memberId: true,
    nightCount: true,
    rateCents: true,
    totalCents: true,
  },
} as const satisfies ConnectionShapeFor<AdminBookingRequestQuoteOption>;

/** `POST /api/admin/booking-requests/[id]/quote` (Save quote). */
export interface AdminBookingRequestQuoteSavedAnswer {
  id: string;
  version: number;
  status: BookingRequestQuoteStatus;
  pricingMode: BookingRequestPricingMode;
  options: AdminBookingRequestQuoteOption[];
}

export const ADMIN_BOOKING_REQUEST_QUOTE_SAVED_CONNECTION_SHAPE =
  connectionShapeFor<AdminBookingRequestQuoteSavedAnswer>({
    version: true,
    status: true,
    pricingMode: true,
    options: QUOTE_OPTION_FIELDS,
  });

/** `POST /api/admin/booking-requests/[id]/send-quote`. */
export interface AdminBookingRequestQuoteSentAnswer {
  success: true;
  id: string;
  version: number;
  status: BookingRequestQuoteStatus;
  expiresAt: string | null;
  emailDelivered: boolean;
  options: AdminBookingRequestQuoteOption[];
}

export const ADMIN_BOOKING_REQUEST_QUOTE_SENT_CONNECTION_SHAPE =
  connectionShapeFor<AdminBookingRequestQuoteSentAnswer>({
    success: true,
    version: true,
    status: true,
    expiresAt: true,
    emailDelivered: true,
    options: QUOTE_OPTION_FIELDS,
  });

// ── The queue ───────────────────────────────────────────────────────────────

/** A request's latest quote on the queue. */
export interface AdminBookingRequestLatestQuote {
  id: string;
  version: number;
  status: BookingRequestQuoteStatus;
  pricingMode: BookingRequestPricingMode;
  sentAt: string | null;
  responseTokenExpiresAt: string | null;
  options: AdminBookingRequestQuoteOption[];
}

/** One row of `GET /api/admin/booking-requests`. */
export type AdminBookingRequestQueueRow = AdminBookingRequestView & {
  schoolGroupSoftCap: number;
  heldBookingStatus: BookingStatus | null;
  pricedByMemberName: string | null;
  reviewedByMemberName: string | null;
  requestedByMemberName: string | null;
  latestQuote: AdminBookingRequestLatestQuote | null;
  quoteDataNeedsAttention?: boolean;
  wholeLodgeFlatTotalCents: number | null;
  suggestedGuestNightRates: SuggestedGuestNightRates;
};

export type AdminBookingRequestQueueAnswer = AdminListPage & {
  data: AdminBookingRequestQueueRow[];
  memberWholeLodgeChoosesPaymentMethod: boolean;
};

export const ADMIN_BOOKING_REQUEST_QUEUE_CONNECTION_SHAPE = connectionShapeFor<AdminBookingRequestQueueAnswer>({
  data: {
    ...BOOKING_REQUEST_FIELDS,
    schoolGroupSoftCap: true,
    heldBookingStatus: true,
    pricedByMemberName: true,
    reviewedByMemberName: true,
    requestedByMemberName: true,
    latestQuote: {
      version: true,
      status: true,
      pricingMode: true,
      sentAt: true,
      responseTokenExpiresAt: true,
      options: QUOTE_OPTION_FIELDS,
    },
    quoteDataNeedsAttention: true,
    wholeLodgeFlatTotalCents: true,
    suggestedGuestNightRates: eachEntry({ nonMemberCents: true, memberCents: true }),
  },
  page: true,
  pageSize: true,
  total: true,
  totalPages: true,
  memberWholeLodgeChoosesPaymentMethod: true,
});

/** `GET /api/admin/booking-requests/pending-counts`: every count is kept. */
export const ADMIN_BOOKING_REQUEST_PENDING_COUNTS_CONNECTION_SHAPE = connectionShapeFor<BookingRequestPendingCounts>({
  bookingReviews: true,
  lockedPeriodChangeRequests: true,
  policyExceptionRequests: true,
  publicBookingRequests: true,
});

// ── Contacts, conflicts and the school record ───────────────────────────────

/** `GET /api/admin/booking-requests/[id]/contacts`. */
export interface AdminBookingRequestContactsAnswer {
  contacts: Array<{
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    role: Role;
    phoneNumber: string | null;
    bookingCount: number;
  }>;
}

/** A contact read, so the address and phone the officer matches on are kept. */
export const ADMIN_BOOKING_REQUEST_CONTACTS_CONNECTION_SHAPE = connectionShapeFor<AdminBookingRequestContactsAnswer>({
  contacts: {
    id: true,
    firstName: true,
    lastName: true,
    email: true,
    role: true,
    phoneNumber: true,
    bookingCount: true,
  },
});

/** `GET /api/admin/booking-requests/[id]/hold-conflicts`. */
export interface AdminBookingRequestHoldConflictsAnswer {
  lodgeId: string;
  lodgeCapacity: number;
  nights: Array<{
    date: string;
    availableBeds: number;
    occupiedBeds: number;
    wholeLodgeHeld: boolean;
  }>;
  conflicts: HoldConflictBooking[];
}

export const ADMIN_BOOKING_REQUEST_HOLD_CONFLICTS_CONNECTION_SHAPE =
  connectionShapeFor<AdminBookingRequestHoldConflictsAnswer>({
    lodgeId: true,
    lodgeCapacity: true,
    nights: { date: true, availableBeds: true, occupiedBeds: true, wholeLodgeHeld: true },
    conflicts: HOLD_CONFLICT_CONNECTION_FIELDS,
  });

/**
 * `POST /api/admin/booking-requests/[id]/link-conflicts`. The clashing
 * booking is the officer's to see; the guest-row id and the flags that only
 * mean something to the member who made the booking are not sent.
 */
export const ADMIN_BOOKING_REQUEST_LINK_CONFLICTS_CONNECTION_SHAPE = connectionShapeFor<{
  conflicts: BookingMemberNightConflict[];
}>({
  conflicts: {
    memberId: true,
    memberName: true,
    conflictingNights: true,
    bookingId: true,
    bookingStatus: true,
    bookingOwnerName: true,
    bookingCheckIn: true,
    bookingCheckOut: true,
  },
});

/** `GET /api/admin/booking-requests/[id]/school-record`. */
export const ADMIN_BOOKING_REQUEST_SCHOOL_RECORD_CONNECTION_SHAPE = connectionShapeFor<{
  schoolRecord: SchoolRecordPreview;
}>({
  schoolRecord: {
    normalisedName: true,
    known: true,
    schoolRecordName: true,
    schoolRecordArchived: true,
    schoolRecordHasXeroCustomer: true,
    currentContactNames: true,
    currentContactNamesTruncated: true,
  },
});

// ── Holding beds, approving and the school's adults ─────────────────────────

/** `POST /api/admin/booking-requests/[id]/hold`. */
export interface AdminBookingRequestHoldAnswer {
  success: true;
  bookingId: string;
  reused: boolean;
}

export const ADMIN_BOOKING_REQUEST_HOLD_CONNECTION_SHAPE = connectionShapeFor<AdminBookingRequestHoldAnswer>({
  success: true,
  bookingId: true,
  reused: true,
});

/** `POST /api/admin/booking-requests/[id]/approve`: one answer per kind of request. */
export type AdminBookingRequestApprovalAnswer =
  | {
      success: true;
      type: "MEMBER_WHOLE_LODGE";
      bookingId: string;
      memberId: string;
      priceCents: number;
      guestCount: number;
      invoiceMode: "member" | "paid" | "xero" | "manual" | null;
      exclusiveHoldConflicts: HoldConflictBooking[];
    }
  | {
      success: true;
      type: "SCHOOL";
      bookingId: string;
      memberId: string | null;
      priceCents: number;
      invoiceMode: "xero" | "manual";
      teacherCount: number;
      teacherHutLeaderAssignmentsCreated: boolean;
      alreadyConverted: boolean;
      exclusiveHoldConflicts: HoldConflictBooking[];
    }
  | {
      success: true;
      type: "GENERAL";
      bookingId: string;
      memberId: string;
      priceCents: number;
      paymentLinkExpiresAt: string;
    };

/** Every field of any approval answer: a field the route gains must be decided here. */
export const ADMIN_BOOKING_REQUEST_APPROVAL_CONNECTION_SHAPE = connectionShapeFor<
  EveryFieldOf<AdminBookingRequestApprovalAnswer>
>({
  success: true,
  type: true,
  bookingId: true,
  memberId: true,
  priceCents: true,
  guestCount: true,
  invoiceMode: true,
  teacherCount: true,
  teacherHutLeaderAssignmentsCreated: true,
  alreadyConverted: true,
  paymentLinkExpiresAt: true,
  exclusiveHoldConflicts: HOLD_CONFLICT_CONNECTION_FIELDS,
});

/** `POST /api/admin/booking-requests/[id]/resend-attendee-confirmation`. */
export interface AdminBookingRequestAttendeeConfirmationAnswer {
  success: true;
  sentTo: string;
}

export const ADMIN_BOOKING_REQUEST_ATTENDEE_CONFIRMATION_CONNECTION_SHAPE =
  connectionShapeFor<AdminBookingRequestAttendeeConfirmationAnswer>({ success: true });

/** `POST /api/admin/booking-requests/[id]/resolve-pending-adults`. */
export interface AdminBookingRequestPendingAdultsAnswer {
  request: AdminBookingRequestView | null;
  pendingAdultCount: number;
  version: number;
}

export const ADMIN_BOOKING_REQUEST_PENDING_ADULTS_CONNECTION_SHAPE =
  connectionShapeFor<AdminBookingRequestPendingAdultsAnswer>({
    request: BOOKING_REQUEST_FIELDS,
    pendingAdultCount: true,
    version: true,
  });
