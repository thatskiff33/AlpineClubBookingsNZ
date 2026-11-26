/**
 * What the application and request-queue actions send an AI app connection
 * (ALP-720, `INV-MCP-006`).
 *
 * Each queue sends what an officer needs to see who a request is about, what
 * it asks and where it stands. The screens' own extras stay behind: an
 * applicant's date of birth, phone, address and family members' details, a
 * lifecycle request's member snapshot, sign-in flags and access roles, and the Xero detail of a
 * cancellation blocker (only that an unpaid invoice blocks approval, never its
 * number, amount or links). Each list is sent once, under its own name, not
 * also under the `data` alias the screens read.
 */
import type { AdminListPage } from "@/lib/admin-list-page";
import {
  connectionShapeFor,
  type ConnectionShape,
  type EveryFieldOf,
} from "@/lib/connection-projection";
import type { getAdminMembershipCancellationRequests } from "@/lib/membership-cancellation-admin";
import type { MembershipCancellationBlocker } from "@/lib/membership-cancellation-blocker-messages";
import type { SerializedMembershipCancellationRequest } from "@/lib/membership-cancellation-requests";
import type {
  createMemberArchiveRequest,
  getAdminMemberLifecycleRequests,
} from "@/lib/member-lifecycle-actions";

/** The list envelope every capped queue answers with (`adminListPage`). */
const LIST_PAGE_FIELDS = { page: true, pageSize: true, total: true, totalPages: true } as const;

/** An officer named on a request: who raised or decided it. */
const OFFICER_SHAPE = { id: true, name: true } as const;

// ---------------------------------------------------------------------------
// Membership applications (`GET /api/admin/member-applications`)
// ---------------------------------------------------------------------------

/** One application as the route answers it: the fields a connection may be sent. */
interface MemberApplicationAnswer {
  id: string;
  applicantFirstName: string;
  applicantLastName: string;
  applicantEmail: string;
  familyMemberCount: number;
  nominator1Id: string | null;
  nominator2Id: string | null;
  nominator1Name: string | null;
  nominator2Name: string | null;
  nominator1ConfirmedAt: string | null;
  nominator2ConfirmedAt: string | null;
  nominator1TokenExpiresAt: string | null;
  nominator2TokenExpiresAt: string | null;
  nominator1TokenLastSentAt: string | null;
  nominator2TokenLastSentAt: string | null;
  nominator1ReminderCount: number;
  nominator2ReminderCount: number;
  nominatorReminderLimit: number;
  nominator1ReminderExhausted: boolean;
  nominator2ReminderExhausted: boolean;
  status: string;
  adminNotes: string | null;
  reviewerName: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export const MEMBER_APPLICATION_LIST_CONNECTION_SHAPE = connectionShapeFor<
  { applications: MemberApplicationAnswer[]; pendingCount: number } & AdminListPage
>({
  applications: {
    id: true,
    applicantFirstName: true,
    applicantLastName: true,
    applicantEmail: true,
    familyMemberCount: true,
    nominator1Id: true,
    nominator2Id: true,
    nominator1Name: true,
    nominator2Name: true,
    nominator1ConfirmedAt: true,
    nominator2ConfirmedAt: true,
    nominator1TokenExpiresAt: true,
    nominator2TokenExpiresAt: true,
    nominator1TokenLastSentAt: true,
    nominator2TokenLastSentAt: true,
    nominator1ReminderCount: true,
    nominator2ReminderCount: true,
    nominatorReminderLimit: true,
    nominator1ReminderExhausted: true,
    nominator2ReminderExhausted: true,
    status: true,
    adminNotes: true,
    reviewerName: true,
    reviewedAt: true,
    createdAt: true,
  },
  pendingCount: true,
  ...LIST_PAGE_FIELDS,
});

/** `POST .../nominations/refresh`. A warning names a nominator whose email failed. */
export const NOMINATIONS_REFRESHED_CONNECTION_SHAPE = connectionShapeFor<{
  success: boolean;
  refreshedCount: number;
  warnings: string[];
}>({ success: true, refreshedCount: true, warnings: true });

/** `POST .../nominators/[slot]/replace`. */
export const NOMINATOR_REPLACED_CONNECTION_SHAPE = connectionShapeFor<{
  success: boolean;
  replacementNominatorId: string;
  warnings: string[];
}>({ success: true, replacementNominatorId: true, warnings: true });

// ---------------------------------------------------------------------------
// Archive and deletion requests an officer raised (lifecycle requests)
// ---------------------------------------------------------------------------

type LifecycleRequestList = Awaited<ReturnType<typeof getAdminMemberLifecycleRequests>>;

/**
 * Not the member snapshot (a deletion request's copy of the member's record),
 * the target's sign-in flag or the archive note on their record.
 */
export const MEMBER_LIFECYCLE_REQUEST_LIST_CONNECTION_SHAPE = connectionShapeFor<LifecycleRequestList>({
  requests: {
    id: true,
    memberId: true,
    action: true,
    status: true,
    reason: true,
    reviewNote: true,
    requestedAt: true,
    reviewedAt: true,
    processedAt: true,
    requestedByMemberId: true,
    requestedBy: OFFICER_SHAPE,
    reviewedBy: OFFICER_SHAPE,
    member: { id: true, name: true, email: true, active: true, cancelledAt: true, archivedAt: true },
    targetName: true,
  },
  pendingCount: true,
  ...LIST_PAGE_FIELDS,
});

type ArchiveRequestCreated = Awaited<ReturnType<typeof createMemberArchiveRequest>>;

export const MEMBER_ARCHIVE_REQUESTED_CONNECTION_SHAPE = connectionShapeFor<ArchiveRequestCreated>({
  request: {
    id: true,
    memberId: true,
    action: true,
    status: true,
    reason: true,
    requestedAt: true,
    requestedByMemberId: true,
  },
});

// ---------------------------------------------------------------------------
// Membership cancellation requests
// ---------------------------------------------------------------------------

/**
 * What a raised or re-sent cancellation request answers with: the request and
 * each member it would cancel, and any email that could not be sent.
 */
export const MEMBERSHIP_CANCELLATION_REQUEST_RESULT_CONNECTION_SHAPE = connectionShapeFor<{
  request: SerializedMembershipCancellationRequest;
  emailWarnings: string[];
}>({
  request: {
    id: true,
    status: true,
    reason: true,
    submittedAt: true,
    participants: {
      id: true,
      memberId: true,
      name: true,
      email: true,
      status: true,
      confirmationTokenExpiresAt: true,
      confirmedAt: true,
      declinedAt: true,
    },
  },
  emailWarnings: true,
});

type CancellationQueue = Awaited<ReturnType<typeof getAdminMembershipCancellationRequests>>;
type CancellationQueueRequest = CancellationQueue["requests"][number];
type CancellationQueueParticipant = CancellationQueueRequest["participants"][number];

/**
 * A blocker says what kind it is; a booking blocker also names the booking.
 * An invoice blocker sends its kind only: that money is owing in Xero, or that
 * the check could not be made.
 */
const CANCELLATION_BLOCKER_SHAPE = connectionShapeFor<EveryFieldOf<MembershipCancellationBlocker>>({
  type: true,
  bookingId: true,
  bookingStatus: true,
  checkIn: true,
  checkOut: true,
});

const CANCELLATION_PARTICIPANT_SHAPE: ConnectionShape = {
  ...connectionShapeFor<Omit<CancellationQueueParticipant, "blockers">>({
    id: true,
    memberId: true,
    name: true,
    email: true,
    active: true,
    cancelledAt: true,
    status: true,
    reason: true,
    adminNote: true,
    confirmationTokenExpiresAt: true,
    confirmedAt: true,
    declinedAt: true,
    reviewedAt: true,
    cancelledAtParticipant: true,
    reviewedBy: OFFICER_SHAPE,
    invoiceCheckSkipped: true,
    accountType: true,
    includedWithoutOwnOrSecondAdultConfirmation: true,
  }),
  blockers: CANCELLATION_BLOCKER_SHAPE,
};

const CANCELLATION_QUEUE_REQUEST_SHAPE: ConnectionShape = {
  ...connectionShapeFor<Omit<CancellationQueueRequest, "participants">>({
    id: true,
    status: true,
    reason: true,
    adminNote: true,
    submittedAt: true,
    reviewedAt: true,
    completedAt: true,
    requestedBy: OFFICER_SHAPE,
    reviewedBy: OFFICER_SHAPE,
  }),
  participants: CANCELLATION_PARTICIPANT_SHAPE,
};

/** Not the shared-invoice notice, the age group or the sign-in flag. */
export const MEMBERSHIP_CANCELLATION_REQUEST_LIST_CONNECTION_SHAPE: ConnectionShape = {
  ...connectionShapeFor<Omit<CancellationQueue, "requests">>({ pendingCount: true, ...LIST_PAGE_FIELDS }),
  requests: CANCELLATION_QUEUE_REQUEST_SHAPE,
};

// ---------------------------------------------------------------------------
// Self-service account deletion requests (`GET /api/admin/deletion-requests`)
// ---------------------------------------------------------------------------

interface DeletionRequestAnswer {
  id: string;
  status: string;
  reason: string | null;
  adminNote: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  member: { id: string; firstName: string; lastName: string; email: string; active: boolean };
}

/** Not the member's role. */
export const DELETION_REQUEST_LIST_CONNECTION_SHAPE = connectionShapeFor<
  { requests: DeletionRequestAnswer[] } & AdminListPage
>({
  requests: {
    id: true,
    status: true,
    reason: true,
    adminNote: true,
    reviewedBy: true,
    reviewedAt: true,
    createdAt: true,
    member: { id: true, firstName: true, lastName: true, email: true, active: true },
  },
  ...LIST_PAGE_FIELDS,
});
