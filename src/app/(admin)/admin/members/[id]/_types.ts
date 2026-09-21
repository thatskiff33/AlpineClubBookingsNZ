import type {
  FinanceAccessLevel,
  Gender,
  MembershipTypeBookingBehavior,
  MembershipTypeSubscriptionBehavior,
  Title,
} from "@prisma/client";
import type {
  AdminActor,
  AuditLogEntry,
  ParentLinkSummary,
} from "@/lib/admin-member-detail-helpers";
import type { DependentLinkIneligibleMatch } from "@/lib/dependent-link-eligibility";
import type { MemberAddressValues } from "@/lib/member-address";
import type { MembershipTypeAgeExemption } from "@/lib/membership-types";
import type { AppRole } from "@/lib/member-roles";
import type {
  MemberContactChangeBlocker,
  MemberContactCreateRecoveryState,
} from "@/lib/xero-contact-create-recovery";

export interface MemberDeleteEligibilityBlocker {
  code: string;
  label: string;
  count?: number;
}

export interface MemberDeleteEligibility {
  eligible: boolean;
  blockers: MemberDeleteEligibilityBlocker[];
  checkedAt: string;
}

interface LifecycleActor {
  id: string;
  name: string;
  email: string;
}

export interface MemberLifecycleActionRequest {
  id: string;
  memberId: string;
  action: "ARCHIVE" | "DELETE";
  status: "REQUESTED" | "APPROVED" | "REJECTED";
  reason: string;
  reviewNote: string | null;
  requestedAt: string;
  reviewedAt: string | null;
  processedAt: string | null;
  requestedBy: LifecycleActor | null;
  reviewedBy: LifecycleActor | null;
  memberSnapshot?: unknown;
}

export interface EmailInheritanceSearchResult {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  active?: boolean;
}

export interface OpenCancellationRequestSummary {
  id: string;
  status: string;
  reason: string | null;
  submittedAt: string;
  participantId: string;
  participantStatus: string;
  requestedBy: { id: string; name: string; email: string } | null;
  requestedByCurrentAdmin: boolean;
}

interface ParentMemberSummary {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  ageTier: string;
  active: boolean;
  canLogin: boolean;
  inheritEmailFromId?: string | null;
}

export interface MemberPromoCode {
  id: string;
  code: string;
  description: string | null;
  type: "PERCENTAGE" | "FIXED_AMOUNT" | "FREE_NIGHTS" | "FIXED_NIGHTLY_PRICE";
  percentOff: number | null;
  valueCents: number | null;
  freeNightsPerIndividual: number | null;
  lifetimeFreeNightsCap: number | null;
  fixedNightlyPriceCents: number | null;
  fixedNightlyMode: "SET_PRICE" | "CAP_ONLY" | null;
  assignedAt: string | null;
  active: boolean;
  archivedAt: string | null;
  validFrom: string | null;
  validUntil: string | null;
  bookingStartFrom: string | null;
  bookingStartUntil: string | null;
  maxRedemptionsTotal: number | null;
  currentRedemptions: number;
  maxUsesPerMember: number | null;
  redemptionCount: number;
  freeNightsUsed: number;
  visibleToMember: boolean;
  statusReason: string;
}

export interface MembershipTypeSummary {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isActive: boolean;
  isBuiltIn: boolean;
  bookingBehavior: MembershipTypeBookingBehavior;
  subscriptionBehavior: MembershipTypeSubscriptionBehavior;
  sortOrder: number;
}

export interface SeasonalMembershipAssignmentSummary {
  id: string;
  memberId: string;
  seasonYear: number;
  membershipTypeId: string;
  applyFrom: string | null;
  assignedByMemberId: string | null;
  createdAt: string;
  updatedAt: string;
  membershipType: MembershipTypeSummary;
}

export interface CommitteeRoleSummary {
  id: string;
  key: string;
  name: string;
  description: string | null;
  contactEmail: string | null;
  isActive: boolean;
  sortOrder: number;
  assignmentCount: number;
}

export interface CommitteeAssignmentSummary {
  id: string;
  memberId: string;
  committeeRoleId: string;
  blurb: string | null;
  sortOrder: number;
  published: boolean;
  showPhone: boolean;
  contactable: boolean;
  contactEmailMode: "ROLE" | "MEMBER" | "CUSTOM";
  contactEmailOverride: string | null;
  isActive: boolean;
  assignedByMemberId: string | null;
  createdAt: string;
  updatedAt: string;
  committeeRole: CommitteeRoleSummary;
  member: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string | null;
    role: string;
    active: boolean;
    displayName: string;
  };
  assignedBy: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    displayName: string;
  } | null;
}

export interface MemberDetail {
  id: string;
  title: Title | null;
  firstName: string;
  lastName: string;
  gender: Gender | null;
  email: string;
  phoneCountryCode: string | null;
  phoneAreaCode: string | null;
  phoneNumber: string | null;
  dateOfBirth: string | null;
  role: AppRole;
  // Role tokens: enum values or AccessRoleDefinition ids.
  accessRoles: string[];
  ageTier: string;
  financeAccessLevel: FinanceAccessLevel;
  active: boolean;
  deletedAt: string | null;
  // Member profile photo (MP4, epic #171). photoImageId present ⇒ has a photo;
  // photoUpdatedAt busts the img cache after a replace.
  photoImageId: string | null;
  photoUpdatedAt: string | null;
  forcePasswordChange: boolean;
  xeroContactId: string | null;
  xeroContactCreateRecoveryState?: MemberContactCreateRecoveryState | null;
  xeroContactCreateRecoveryPending?: boolean;
  /**
   * The open member CONTACT operation that currently refuses member merge and
   * account deletion, read from the same predicate those refusals use (#2623
   * T7). Present even when the member IS linked, which is exactly the case the
   * page used to render as clean.
   */
  xeroContactLifecycleBlocker?: MemberContactChangeBlocker | null;
  joinedDate: string | null;
  lifeMemberDate: string | null;
  occupation: string | null;
  createdAt: string;
  canLogin: boolean;
  requiresInduction: boolean;
  cancelledAt: string | null;
  cancelledReason: string | null;
  comments: string | null;
  archivedAt: string | null;
  archivedReason: string | null;
  archivedViaLifecycleActionRequestId: string | null;
  parentMemberId: string | null;
  secondaryParentId: string | null;
  parent: ParentMemberSummary | null;
  secondaryParent: ParentMemberSummary | null;
  parentLinks: ParentLinkSummary[];
  xeroContactGroupsLoaded: boolean;
  xeroContactGroups: Array<{ id: string; name: string }>;
  inheritEmailFromId: string | null;
  inheritEmailFrom: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  } | null;
  /**
   * #2282: the adult a dependant added under THIS member would actually inherit
   * their club email from — this member when they are a usable source, an
   * ancestor when they are not (a young parent, or anyone with only a
   * placeholder address), and `null` when nobody in reach can receive mail.
   * Server-resolved with the same walk the write paths use, so the page can say
   * where the child's mail will go before the admin commits to it.
   */
  dependentEmailSource: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  } | null;
  familyGroups: { id: string; name: string | null }[];
  // Per-member billing family selection + club billing mode (#1932, E6).
  billingFamilyGroupId: string | null;
  familyBillingMode:
    "BILL_FAMILY_VIA_BILLING_MEMBER" | "BILL_MEMBERS_INDIVIDUALLY";
  currentSeasonYear: number;
  // #2106: age-exemption of the member's current-season membership type —
  // FORCED (N/A only), ALLOWED (N/A hand-pickable), or DISALLOWED (no N/A);
  // null when the member has no current-season assignment (treat as DISALLOWED).
  currentSeasonAgeExemption: MembershipTypeAgeExemption | null;
  seasonalMembershipAssignments: SeasonalMembershipAssignmentSummary[];
  committeeAssignments: CommitteeAssignmentSummary[];
  subscriptions: Array<{
    id: string;
    seasonYear: number;
    status: string;
    xeroInvoiceId: string | null;
    paidAt: string | null;
  }>;
  bookings: Array<{
    id: string;
    checkIn: string;
    checkOut: string;
    status: string;
    finalPriceCents: number;
    _count: { guests: number };
  }>;
  promoCodes: MemberPromoCode[];
  lifecycleActionRequests: MemberLifecycleActionRequest[];
  openCancellationRequest: OpenCancellationRequestSummary | null;
  auditLogs: AuditLogEntry[];
  deleteEligibility: MemberDeleteEligibility;
  stats: {
    totalBookings: number;
    totalSpendCents: number;
    lastStay: string | null;
  };
  dependents: Array<{
    id: string;
    firstName: string;
    lastName: string;
    ageTier: string;
    active: boolean;
    dateOfBirth: string | null;
    canLogin: boolean;
    parentLinkType?: "PRIMARY" | "SECONDARY";
  }>;
  streetAddressLine1: string | null;
  streetAddressLine2: string | null;
  streetCity: string | null;
  streetRegion: string | null;
  streetPostalCode: string | null;
  streetCountry: string | null;
  postalAddressLine1: string | null;
  postalAddressLine2: string | null;
  postalCity: string | null;
  postalRegion: string | null;
  postalPostalCode: string | null;
  postalCountry: string | null;
}

export interface DependentForm extends MemberAddressValues {
  title: Title | "";
  gender: Gender | "";
  firstName: string;
  lastName: string;
  email: string;
  dateOfBirth: string;
  phoneCountryCode: string;
  phoneAreaCode: string;
  phoneNumber: string;
}

export type DependentDialogMode = "create" | "link";

export interface LinkDependentSearchResult {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  ageTier: string;
  active: boolean;
  canLogin: boolean;
  dateOfBirth: string | null;
  parentLinks: ParentLinkSummary[];
}

/**
 * A member the dependant-link search matched but could not offer, with the
 * plain-English reason (#2254). Returned by `GET /api/admin/members` only when
 * a `dependentLinkEligibleFor` search came back empty AND at least one match
 * was excluded — never as an empty array, so an empty rendered list is not
 * mistaken for "nothing matched your search".
 */
export type LinkDependentIneligibleMatch = DependentLinkIneligibleMatch;

export interface LinkParentSearchResult extends ParentMemberSummary {
  dateOfBirth: string | null;
  familyGroups: { id: string; name: string | null }[];
}

export interface CreditHistoryItem {
  id: string;
  amountCents: number;
  type:
    | "CANCELLATION_REFUND"
    | "BOOKING_MODIFICATION_REFUND"
    | "ADMIN_ADJUSTMENT"
    | "BOOKING_APPLIED";
  description: string;
  createdAt: string;
  requestedBy: AdminActor | null;
  approvedBy: AdminActor | null;
  approvalRequest: { createdAt: string; reviewedAt: string | null } | null;
  sourceBooking: { id: string; checkIn: string; checkOut: string } | null;
  appliedToBooking: { id: string; checkIn: string; checkOut: string } | null;
}

export interface PendingCreditAdjustmentItem {
  id: string;
  amountCents: number;
  description: string;
  createdAt: string;
  requestedBy: AdminActor;
}
