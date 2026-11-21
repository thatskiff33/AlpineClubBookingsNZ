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
import type { BookingMessageClubTokens } from "@/lib/booking-message-definitions";
import type { serializePublicCommitteeAssignment } from "@/lib/committee";
import type { CancelCardRefundSplit } from "@/lib/cancel-card-refund-shortfall";
import type { AuditTimelineResponse } from "@/lib/audit-query";
import {
  completeConnectionShapeFor,
  connectionShapeFor,
  eachEntry,
  type ConnectionShape,
} from "@/lib/connection-projection";
import type { MemberDraftSummary } from "@/lib/member-draft-summary";
import type { MemberLodgeRoster } from "@/lib/member-lodge-roster";
import {
  MEMBER_NOTIFICATION_PREFERENCE_KEYS,
  type MemberNotificationPreferences,
} from "@/lib/member-notification-preferences";
import type { MemberBookingSummary, MemberProfileSummary } from "@/lib/member-self-read";
import type { MemberNoticeView } from "@/lib/notices";
import type { AgeTierSettingData } from "@/lib/policies/age-tier";
import type { calculateCancellationPreview } from "@/lib/policies/booking-route-decisions";
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

/** Who can go on a booking: no dates of birth, email addresses, parent links, notes or pending requests. */
export const MEMBER_FAMILY_CONNECTION_SHAPE = connectionShapeFor<{
  displayName: string | null;
  familyMembers: Array<{
    id: string;
    firstName: string;
    lastName: string;
    ageTier: string;
    relationship: string;
    canBeBooked: boolean;
  }>;
}>({
  displayName: true,
  familyMembers: {
    id: true,
    firstName: true,
    lastName: true,
    ageTier: true,
    relationship: true,
    canBeBooked: true,
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

const MEMBER_NOTICE_SHAPE = completeConnectionShapeFor<MemberNoticeView>({
  id: true,
  title: true,
  bodyHtml: true,
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

type CancelPreviewAnswer = ReturnType<typeof calculateCancellationPreview> & {
  hasPayment: boolean;
  manualRefund: boolean;
  paymentSettledByHand: boolean;
  groupCancellationRefundCents: number;
  groupCancellationRefundNote: string;
  cardShortfall: CancelCardRefundSplit;
  refundDisputed: true;
  refundMethodForced: string | null;
};

export const CANCEL_PREVIEW_CONNECTION_SHAPE = completeConnectionShapeFor<CancelPreviewAnswer>({
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

export const CANCEL_BOOKING_CONNECTION_SHAPE = completeConnectionShapeFor<CancelBookingResult>({
  success: true,
  refundAmountCents: true,
  refundPercentage: true,
  refundMethod: true,
  creditAmountCents: true,
  creditRestoredCents: true,
  stripeRefundId: true,
  manualRefundTaskId: true,
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
 * What a profile save sends back: the `get_my_profile` fields it holds, never
 * the sign-in, role, Xero or date-of-birth columns the route reads to decide.
 */
export const MEMBER_PROFILE_UPDATE_CONNECTION_SHAPE = connectionShapeFor<MemberProfileSummary>({
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
});

export const NOTICE_READ_CONNECTION_SHAPE = connectionShapeFor<{ ok: boolean }>({ ok: true });

/** One notice with its body as plain text, so no markup reaches the app. */
export type MemberNoticeTextView = Omit<MemberNoticeView, "bodyHtml"> & { body: string };

export const MEMBER_NOTICE_CONNECTION_SHAPE = connectionShapeFor<{ notice: MemberNoticeTextView }>({
  notice: {
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
  },
});

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
