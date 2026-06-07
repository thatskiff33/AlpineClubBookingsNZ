import type { FinanceAccessLevel } from "@prisma/client"
import type {
  AdminActor,
  AuditLogEntry,
  ParentLinkSummary,
} from "@/lib/admin-member-detail-helpers"
import type { MemberAddressValues } from "@/lib/member-address"

export interface MemberDeleteEligibilityBlocker {
  code: string
  label: string
  count?: number
}

export interface MemberDeleteEligibility {
  eligible: boolean
  blockers: MemberDeleteEligibilityBlocker[]
  checkedAt: string
}

export interface LifecycleActor {
  id: string
  name: string
  email: string
}

export interface MemberLifecycleActionRequest {
  id: string
  memberId: string
  action: "ARCHIVE" | "DELETE"
  status: "REQUESTED" | "APPROVED" | "REJECTED"
  reason: string
  reviewNote: string | null
  requestedAt: string
  reviewedAt: string | null
  processedAt: string | null
  requestedBy: LifecycleActor | null
  reviewedBy: LifecycleActor | null
  memberSnapshot?: unknown
}

export interface EmailInheritanceSearchResult {
  id: string
  firstName: string
  lastName: string
  email: string
  active?: boolean
}

export interface OpenCancellationRequestSummary {
  id: string
  status: string
  reason: string | null
  submittedAt: string
  participantId: string
  participantStatus: string
  requestedBy: { id: string; name: string; email: string } | null
  requestedByCurrentAdmin: boolean
}

export interface ParentMemberSummary {
  id: string
  firstName: string
  lastName: string
  email: string
  ageTier: string
  active: boolean
  canLogin: boolean
  inheritEmailFromId?: string | null
}

export interface MemberPromoCode {
  id: string
  code: string
  description: string | null
  type: "PERCENTAGE" | "FIXED_AMOUNT" | "FREE_NIGHTS" | "FIXED_NIGHTLY_PRICE"
  percentOff: number | null
  valueCents: number | null
  freeNightsPerIndividual: number | null
  lifetimeFreeNightsCap: number | null
  fixedNightlyPriceCents: number | null
  fixedNightlyMode: "SET_PRICE" | "CAP_ONLY" | null
  assignedAt: string | null
  active: boolean
  archivedAt: string | null
  validFrom: string | null
  validUntil: string | null
  bookingStartFrom: string | null
  bookingStartUntil: string | null
  maxRedemptionsTotal: number | null
  currentRedemptions: number
  maxUsesPerMember: number | null
  redemptionCount: number
  freeNightsUsed: number
  visibleToMember: boolean
  statusReason: string
}

export interface MemberDetail {
  id: string
  firstName: string
  lastName: string
  email: string
  phoneCountryCode: string | null
  phoneAreaCode: string | null
  phoneNumber: string | null
  dateOfBirth: string | null
  role: "MEMBER" | "ADMIN"
  ageTier: string
  financeAccessLevel: FinanceAccessLevel
  active: boolean
  forcePasswordChange: boolean
  xeroContactId: string | null
  joinedDate: string | null
  createdAt: string
  canLogin: boolean
  cancelledAt: string | null
  cancelledReason: string | null
  archivedAt: string | null
  archivedReason: string | null
  archivedViaLifecycleActionRequestId: string | null
  parentMemberId: string | null
  secondaryParentId: string | null
  parent: ParentMemberSummary | null
  secondaryParent: ParentMemberSummary | null
  parentLinks: ParentLinkSummary[]
  xeroContactGroupsLoaded: boolean
  xeroContactGroups: Array<{ id: string; name: string }>
  inheritEmailFromId: string | null
  inheritEmailFrom: {
    id: string
    firstName: string
    lastName: string
    email: string
  } | null
  familyGroups: { id: string; name: string | null }[]
  subscriptions: Array<{
    id: string
    seasonYear: number
    status: string
    xeroInvoiceId: string | null
    paidAt: string | null
  }>
  bookings: Array<{
    id: string
    checkIn: string
    checkOut: string
    status: string
    finalPriceCents: number
    _count: { guests: number }
  }>
  promoCodes: MemberPromoCode[]
  lifecycleActionRequests: MemberLifecycleActionRequest[]
  openCancellationRequest: OpenCancellationRequestSummary | null
  auditLogs: AuditLogEntry[]
  deleteEligibility: MemberDeleteEligibility
  stats: { totalBookings: number; totalSpendCents: number; lastStay: string | null }
  dependents: Array<{
    id: string
    firstName: string
    lastName: string
    ageTier: string
    active: boolean
    dateOfBirth: string | null
    canLogin: boolean
    parentLinkType?: "PRIMARY" | "SECONDARY"
  }>
  streetAddressLine1: string | null
  streetAddressLine2: string | null
  streetCity: string | null
  streetRegion: string | null
  streetPostalCode: string | null
  streetCountry: string | null
  postalAddressLine1: string | null
  postalAddressLine2: string | null
  postalCity: string | null
  postalRegion: string | null
  postalPostalCode: string | null
  postalCountry: string | null
}

export interface EditForm {
  firstName: string
  lastName: string
  email: string
  phoneCountryCode: string
  phoneAreaCode: string
  phoneNumber: string
  dateOfBirth: string
  joinedDate: string
  role: "MEMBER" | "ADMIN"
  ageTier: string
  financeAccessLevel: FinanceAccessLevel
  active: boolean
  canLogin: boolean
  forcePasswordChange: boolean
  inheritEmailFromId: string | null
  streetAddressLine1: string
  streetAddressLine2: string
  streetCity: string
  streetRegion: string
  streetPostalCode: string
  streetCountry: string
  postalAddressLine1: string
  postalAddressLine2: string
  postalCity: string
  postalRegion: string
  postalPostalCode: string
  postalCountry: string
}

export interface DependentForm extends MemberAddressValues {
  firstName: string
  lastName: string
  email: string
  dateOfBirth: string
  phoneCountryCode: string
  phoneAreaCode: string
  phoneNumber: string
}

export type DependentDialogMode = "create" | "link"

export interface LinkDependentSearchResult {
  id: string
  firstName: string
  lastName: string
  email: string
  ageTier: string
  active: boolean
  canLogin: boolean
  dateOfBirth: string | null
  parentLinks: ParentLinkSummary[]
}

export interface LinkParentSearchResult extends ParentMemberSummary {
  dateOfBirth: string | null
  familyGroups: { id: string; name: string | null }[]
}

export interface CreditHistoryItem {
  id: string
  amountCents: number
  type: "CANCELLATION_REFUND" | "BOOKING_MODIFICATION_REFUND" | "ADMIN_ADJUSTMENT" | "BOOKING_APPLIED"
  description: string
  createdAt: string
  requestedBy: AdminActor | null
  approvedBy: AdminActor | null
  approvalRequest: { createdAt: string; reviewedAt: string | null } | null
  sourceBooking: { id: string; checkIn: string; checkOut: string } | null
  appliedToBooking: { id: string; checkIn: string; checkOut: string } | null
}

export interface PendingCreditAdjustmentItem {
  id: string
  amountCents: number
  description: string
  createdAt: string
  requestedBy: AdminActor
}
