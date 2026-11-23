/**
 * What each AI app action returns (ALP-718, `INV-MCP-006`): the one place a
 * catalogue entry's `returns` and its route's projection both read
 * (`INV-SSOT`).
 *
 * A route that answers a connection through `connectionJson` sends exactly
 * the fields named here and drops the rest. A stage 1 route whose whole
 * answer was already chosen for the member (ALP-653) is described with a
 * complete shape, which must name every field its answer's type has, so the
 * description cannot fall behind the route.
 *
 * Types only from the route modules: nothing here reaches the database.
 */
import type { CancelBookingResult } from "@/lib/booking-cancel-result";
import type { CancelPreviewAnswer } from "@/lib/cancel-preview-answer";
import type { BookingMessageClubTokens } from "@/lib/booking-message-definitions";
import type { serializePublicCommitteeAssignment } from "@/lib/committee";
import type { AuditTimelineResponse } from "@/lib/audit-query";
import {
  completeConnectionShapeFor,
  connectionShapeFor,
  eachEntry,
  type ConnectionShape,
  type EveryFieldOf,
} from "@/lib/connection-projection";
import type { MemberDraftSummary } from "@/lib/member-draft-summary";
import type { MemberGuestCandidateResponse } from "@/lib/member-guest-find";
import type {
  PartnerLinkMemberView,
  PartnerLinkState,
  PendingPartnerInviteIntent,
} from "@/lib/member-partner-link";
import type { MembershipCancellationOverview } from "@/lib/membership-cancellation-requests";
import type { MemberLodgeRoster } from "@/lib/member-lodge-roster";
import {
  MEMBER_NOTIFICATION_PREFERENCE_KEYS,
  type MemberNotificationPreferences,
} from "@/lib/member-notification-preferences";
import type { MemberBookingSummary, MemberProfileSummary } from "@/lib/member-self-read";
import type { MemberNoticeTextView } from "@/lib/member-notice-text";
import type { AgeTierSettingData } from "@/lib/policies/age-tier";
import type { WhakapapaCurlData } from "@/lib/whakapapa-report";

// --- Stage 1 (ALP-653) ------------------------------------------------------

export const AVAILABILITY_CONNECTION_SHAPE = connectionShapeFor<{
  availability: Record<string, number>;
  seasons: Record<string, { name: string; type: string }>;
  lodgeCapacity: number;
}>({
  availability: eachEntry(true),
  seasons: eachEntry({ name: true, type: true }),
  lodgeCapacity: true,
});

export const LODGE_LIST_CONNECTION_SHAPE = connectionShapeFor<{
  lodges: Array<{ id: string; name: string; travelNote: string | null }>;
}>({
  lodges: { id: true, name: true, travelNote: true },
});

const MEMBER_BOOKING_SUMMARY_SHAPE = completeConnectionShapeFor<MemberBookingSummary>({
  id: true,
  status: true,
  checkIn: true,
  checkOut: true,
  lodge: { id: true, name: true },
  finalPriceCents: true,
  priceBeingChecked: true,
  madeByMe: true,
  notes: true,
  guests: { firstName: true, lastName: true, ageTier: true, isMember: true },
});

export const MEMBER_BOOKING_LIST_CONNECTION_SHAPE: ConnectionShape = {
  bookings: MEMBER_BOOKING_SUMMARY_SHAPE,
  truncated: true,
};

export const MEMBER_BOOKING_CONNECTION_SHAPE: ConnectionShape = {
  booking: MEMBER_BOOKING_SUMMARY_SHAPE,
};

/**
 * Who can go on a booking, and the ids the family actions take (ALP-795):
 * the member's family group ids, each person's groups, whether they have
 * their own login, and whether the member may confirm their details. No dates
 * of birth, email addresses, parent links, notes or pending requests.
 */
export const MEMBER_FAMILY_CONNECTION_SHAPE = connectionShapeFor<{
  displayName: string | null;
  familyGroupIds: string[];
  familyMembers: Array<{
    id: string;
    firstName: string;
    lastName: string;
    ageTier: string;
    relationship: string;
    canBeBooked: boolean;
    canLogin: boolean;
    canCurrentUserConfirmDetails: boolean;
    familyGroupIds: string[];
  }>;
}>({
  displayName: true,
  familyGroupIds: true,
  familyMembers: {
    id: true,
    firstName: true,
    lastName: true,
    ageTier: true,
    relationship: true,
    canBeBooked: true,
    canLogin: true,
    canCurrentUserConfirmDetails: true,
    familyGroupIds: true,
  },
});

const MEMBER_PROFILE_SHAPE = completeConnectionShapeFor<MemberProfileSummary>({
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
});

export const MEMBER_PROFILE_CONNECTION_SHAPE: ConnectionShape = { profile: MEMBER_PROFILE_SHAPE };

/** One notice, its body as plain text (`memberNoticeAsText`), for `list_notices` and `get_notice` alike. */
const MEMBER_NOTICE_SHAPE = completeConnectionShapeFor<MemberNoticeTextView>({
  id: true,
  title: true,
  body: true,
  publishedAt: true,
  expiresAt: true,
  pinned: true,
  requiresAcknowledgement: true,
  read: true,
  readAt: true,
  acknowledged: true,
  acknowledgedAt: true,
});

export const MEMBER_NOTICE_LIST_CONNECTION_SHAPE: ConnectionShape = { notices: MEMBER_NOTICE_SHAPE };

export const MEMBER_DRAFT_SUMMARY_CONNECTION_SHAPE = completeConnectionShapeFor<MemberDraftSummary>({
  id: true,
  status: true,
  checkIn: true,
  checkOut: true,
  draftExpiresAt: true,
  lodge: { id: true, name: true },
  notes: true,
  guests: { firstName: true, lastName: true, ageTier: true, isMember: true },
});

export const MEMBER_DRAFT_LIST_CONNECTION_SHAPE: ConnectionShape = {
  drafts: MEMBER_DRAFT_SUMMARY_CONNECTION_SHAPE,
};

/** Every field of either cancel preview answer: a field the route gains must be decided here. */
export const CANCEL_PREVIEW_CONNECTION_SHAPE = completeConnectionShapeFor<EveryFieldOf<CancelPreviewAnswer>>({
  refundAmountCents: true,
  keptAmountCents: true,
  changeFeeCents: true,
  refundPercentage: true,
  creditRefundAmountCents: true,
  creditRefundPercentage: true,
  creditRestoredCents: true,
  totalPaidCents: true,
  hasPayment: true,
  manualRefund: true,
  paymentSettledByHand: true,
  groupCancellationRefundCents: true,
  groupCancellationRefundNote: true,
  cardShortfall: { cardCents: true, bankCents: true, checkCents: true },
  refundDisputed: true,
  refundMethodForced: true,
});

/**
 * What cancelling sends back: the refund figures and method. Never the Stripe
 * refund id or the officer task id, which identify records the member cannot
 * act on and the AI provider has no use for (data minimisation).
 */
export const CANCEL_BOOKING_CONNECTION_SHAPE = connectionShapeFor<CancelBookingResult>({
  success: true,
  refundAmountCents: true,
  refundPercentage: true,
  refundMethod: true,
  creditAmountCents: true,
  creditRestoredCents: true,
  refundDisputed: true,
  organiserRefund: { method: true, amountCents: true },
  ownCardRefund: { method: true, amountCents: true, byHandCents: true, toCheckCents: true },
  message: true,
});

export const CREDIT_BALANCE_CONNECTION_SHAPE = connectionShapeFor<{ balanceCents: number }>({
  balanceCents: true,
});

/**
 * The subscription status without the invoice links, which open the invoice
 * for anyone holding them.
 */
export const SUBSCRIPTION_STATUS_CONNECTION_SHAPE: ConnectionShape = {
  status: true,
  rawStatus: true,
  subscriptionRequired: true,
  effectiveStatusReason: true,
  seasonDisplay: true,
  invoiceNumber: true,
  rawInvoiceNumber: true,
  membershipTypeKey: true,
  membershipTypeName: true,
  membershipTypeSubscriptionBehavior: true,
  memberRateNotice: true,
  subscriptionLockoutMode: true,
};

// --- My account and club information (ALP-718) ------------------------------

export const MEMBER_NOTIFICATION_PREFERENCES_CONNECTION_SHAPE = connectionShapeFor<MemberNotificationPreferences>(
  Object.fromEntries(MEMBER_NOTIFICATION_PREFERENCE_KEYS.map((key) => [key, true])),
);

/**
 * What a profile save sends back: the `get_my_profile` fields, never the
 * sign-in, role, Xero or date-of-birth columns the route reads to decide.
 * Two-step sign-in is not on the saved row, so it is the one field left out.
 */
const { twoFactorEnabled: _notOnTheSavedRow, ...MEMBER_PROFILE_SAVED_SHAPE } = MEMBER_PROFILE_SHAPE;
export const MEMBER_PROFILE_UPDATE_CONNECTION_SHAPE: ConnectionShape = MEMBER_PROFILE_SAVED_SHAPE;

export const NOTICE_READ_CONNECTION_SHAPE = connectionShapeFor<{ ok: boolean }>({ ok: true });

export const MEMBER_NOTICE_CONNECTION_SHAPE: ConnectionShape = { notice: MEMBER_NOTICE_SHAPE };

/** The member's own timeline: when, what kind and what happened. No request details or metadata. */
export const MEMBER_ACCOUNT_ACTIVITY_CONNECTION_SHAPE = connectionShapeFor<AuditTimelineResponse>({
  data: { createdAt: true, category: true, outcome: true, summary: true },
  total: true,
  page: true,
  pageSize: true,
  totalPages: true,
  category: true,
});

/** Names and nights only, as the roster page shows them (`INV-PRIV-017`). */
export const LODGE_ROSTER_CONNECTION_SHAPE = connectionShapeFor<MemberLodgeRoster>({
  from: true,
  to: true,
  lodges: {
    lodgeName: true,
    people: { name: true, nights: true },
    groups: { label: true, count: true, nights: true },
    custodians: { name: true, nights: true },
    heldNights: true,
  },
});

export const AGE_GROUPS_CONNECTION_SHAPE = connectionShapeFor<{ settings: AgeTierSettingData[] }>({
  settings: { tier: true, label: true, minAge: true, maxAge: true, subscriptionRequiredForBooking: true },
});

export const BOOKING_MESSAGES_CONNECTION_SHAPE = connectionShapeFor<{
  messages: Record<string, string>;
  tokens: BookingMessageClubTokens;
}>({
  messages: eachEntry(true),
  tokens: { CLUB_NAME: true, CLUB_LODGE_NAME: true, BASE_URL: true, SUPPORT_EMAIL: true },
});

/** The public roster without photo or contact-form keys. */
export const COMMITTEE_CONNECTION_SHAPE = connectionShapeFor<{
  members: Array<ReturnType<typeof serializePublicCommitteeAssignment>>;
}>({
  members: { name: true, role: true, description: true },
});

export const SKIFIELD_REPORT_CONNECTION_SHAPE = connectionShapeFor<
  WhakapapaCurlData & { error: string; stale: boolean }
>({
  updated: true,
  roadStatus: { name: true, status: true, wheelRequirements: true, roadContent: true },
  facilities: { name: true, status: true },
  foodAndDrink: { name: true, status: true },
  lifts: { name: true, status: true },
  conditions: {
    name: true,
    temperature: true,
    wind: true,
    snowBase: true,
    snowfall24h: true,
    snowfall7d: true,
  },
  trails: {
    name: true,
    trails: { name: true, status: true, groomed: true, difficulty: true, size: true },
  },
  visibility: {
    roadStatus: true,
    lifts: true,
    facilities: true,
    foodAndDrink: true,
    conditions: true,
    trails: true,
  },
  error: true,
  stale: true,
});

// --- Family and membership (ALP-795) ----------------------------------------

/** A confirmed no-login family member: name, age group and profile state. Never the date of birth or the copied contact details. */
export const FAMILY_MEMBER_DETAILS_CONNECTION_SHAPE = connectionShapeFor<{
  member: { id: string; firstName: string; lastName: string; ageTier: string; canLogin: boolean };
  profileStatus: {
    isProfileComplete: boolean;
    isDetailsConfirmed: boolean;
    canBeBookedAsMember: boolean;
    missingFields: string[];
  };
}>({
  member: { id: true, firstName: true, lastName: true, ageTier: true, canLogin: true },
  profileStatus: { isProfileComplete: true, isDetailsConfirmed: true, canBeBookedAsMember: true, missingFields: true },
});

export const FAMILY_GROUP_CREATE_CONNECTION_SHAPE = connectionShapeFor<{
  message: string;
  requestId: string;
  familyGroupId: string;
  childRequestIds: string[];
}>({ message: true, requestId: true, familyGroupId: true, childRequestIds: true });

export const FAMILY_INVITE_CONNECTION_SHAPE = connectionShapeFor<{ message: string; invitationId: string }>({
  message: true,
  invitationId: true,
});

/** The four family requests an officer reviews: adult, child, join and removal. */
export const FAMILY_REQUEST_SUBMITTED_CONNECTION_SHAPE = connectionShapeFor<{ message: string; requestId: string }>({
  message: true,
  requestId: true,
});

/** Who invited the member, to which group, and when. Not the request row's other columns. */
export const FAMILY_INVITATIONS_CONNECTION_SHAPE = connectionShapeFor<{
  invitations: Array<{
    id: string;
    createdAt: Date;
    familyGroup: { id: string; name: string | null };
    requester: { id: string; firstName: string; lastName: string } | null;
  }>;
}>({
  invitations: {
    id: true,
    createdAt: true,
    familyGroup: { id: true, name: true },
    requester: { id: true, firstName: true, lastName: true },
  },
});

export const MEMBER_GUEST_OPTIONS_CONNECTION_SHAPE = connectionShapeFor<{
  enabled: boolean;
  openSearchEnabled: boolean;
  approvalRequired: boolean;
  pendingHoldExpiryDays: number;
}>({ enabled: true, openSearchEnabled: true, approvalRequired: true, pendingHoldExpiryDays: true });

/**
 * What the website's own guest picker shows of another member: id, name and
 * age group (owner decision D-19). Never a contact detail or a date of birth.
 * `truncated` is a boolean, never a count, as on the website.
 */
export const MEMBER_GUEST_CANDIDATES_CONNECTION_SHAPE = completeConnectionShapeFor<MemberGuestCandidateResponse>({
  candidates: { memberId: true, firstName: true, lastName: true, ageTier: true },
  truncated: true,
});

const PARTNER_LINK_MEMBER_SHAPE = completeConnectionShapeFor<PartnerLinkMemberView>({
  id: true,
  firstName: true,
  lastName: true,
  canLogin: true,
});

const PARTNER_LINK_VIEW_SHAPE = connectionShapeFor<PartnerLinkState["pendingIncoming"][number]>({
  id: true,
  status: true,
  partner: PARTNER_LINK_MEMBER_SHAPE,
  initiatedByMe: true,
  assignedByAdmin: true,
  confirmedAt: true,
  createdAt: true,
});

/**
 * The member's partnership, pending requests and one-step candidates. An
 * outstanding emailed invitation shows its id and expiry, never the address
 * it was sent to.
 */
export const PARTNER_LINK_STATE_CONNECTION_SHAPE = connectionShapeFor<
  PartnerLinkState & {
    oneStepCandidates: PartnerLinkMemberView[];
    pendingPartnerInvite: PendingPartnerInviteIntent | null;
  }
>({
  confirmed: PARTNER_LINK_VIEW_SHAPE,
  pendingIncoming: PARTNER_LINK_VIEW_SHAPE,
  pendingOutgoing: PARTNER_LINK_VIEW_SHAPE,
  oneStepCandidates: PARTNER_LINK_MEMBER_SHAPE,
  pendingPartnerInvite: { id: true, expiresAt: true },
});

/** A by-email request answers with the message only, whatever happened (D9); a family member request adds the link. */
export const PARTNER_LINK_REQUEST_CONNECTION_SHAPE = connectionShapeFor<{
  message: string;
  linkId: string | null;
  status: string;
}>({ message: true, linkId: true, status: true });

export const PARTNER_LINK_MESSAGE_CONNECTION_SHAPE = connectionShapeFor<{ message: string }>({ message: true });

/**
 * Who the member may ask to cancel, the club's warning and rejoining text, and
 * their visible requests. No email addresses, and none of the club's Xero
 * settings.
 */
export const MEMBERSHIP_CANCELLATION_OPTIONS_CONNECTION_SHAPE = connectionShapeFor<MembershipCancellationOverview>({
  settings: { warningText: true, rejoinProcessText: true },
  candidates: {
    id: true,
    name: true,
    ageTier: true,
    relationship: true,
    canLogin: true,
    requiresOwnConfirmation: true,
    eligible: true,
    ineligibleReason: true,
    familyGroupNames: true,
    activeRequest: { id: true, status: true, participantStatus: true, submittedAt: true },
  },
  requests: {
    id: true,
    status: true,
    reason: true,
    submittedAt: true,
    reviewedAt: true,
    completedAt: true,
    requestedBy: { id: true, name: true },
    participants: {
      id: true,
      memberId: true,
      name: true,
      ageTier: true,
      canLogin: true,
      active: true,
      status: true,
      confirmedAt: true,
      declinedAt: true,
    },
  },
});
