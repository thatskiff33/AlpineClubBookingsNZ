import type { AgeTier } from "@prisma/client"
import type { XeroAccount, XeroItem } from "@/lib/xero-admin-cache"
import type { XeroMappingWritableKey } from "@/lib/xero-account-mapping-keys"

export interface XeroStatus {
  connected: boolean
  // A token row exists but no longer decrypts (env→DB upgrade / auth-secret
  // change, #2079): reconnect required, not "connected". Optional for older
  // response shapes.
  needsReentry?: boolean
  tenantId: string | null
  tokenExpiresAt: string | null
}

/** Live connection-health probe result (#2105), returned by `/status?probe=1`. */
export type XeroTokenHealth =
  | "ok"
  | "reconnect_required"
  | "rate_limited"
  | "error"

export interface XeroConnectionProbe {
  tokenHealth: XeroTokenHealth
  checkedAt: string
  lastErrorMessage: string | null
  cached: boolean
}

export interface XeroReferenceCacheMeta {
  source: "memory" | "database" | "xero"
  lastRefreshedAt: string
  expiresAt: string
}

export type SectionKey =
  | "health"
  | "contactGroupMismatches"
  | "contactLinkMismatches"
  | "operations"
  | "inbound"
  | "contactSync"
  | "membershipSync"
  | "usage"
  | "mappings"
  | "setup"

export const SECTION_STORAGE_KEY = "admin-xero-section-state-v1"

export const SECTION_DEFAULTS: Record<SectionKey, boolean> = {
  health: true,
  contactGroupMismatches: false,
  contactLinkMismatches: false,
  operations: true,
  inbound: true,
  contactSync: true,
  membershipSync: true,
  usage: false,
  mappings: false,
  setup: false,
}

export interface SyncResult {
  total?: number
  matched?: number
  updated?: number
  checked?: number
  errors?: number
  errorDetails?: Array<{ member: string; error: string }>
  message?: string
  mode?: "incremental" | "backfill"
  created?: number
  createdAsDependent?: number
  createdMembers?: Array<{ name: string; email: string; xeroContactId: string; group: string }>
  createdDependents?: Array<{
    name: string
    email: string
    xeroContactId: string
    group: string
    parentMemberId: string
    parentName: string
  }>
  linkedExisting?: number
  linkedExistingDetails?: Array<{
    name: string
    email: string
    memberId: string
    xeroContactId: string
    group: string
  }>
  // #2108: membership-type import results.
  assignmentsCreated?: number
  keptExistingAssignments?: Array<{
    memberId: string
    name: string
    group: string
    existingMembershipTypeId: string
    attemptedMembershipTypeId: string
    existingMembershipTypeName: string | null
    attemptedMembershipTypeName: string | null
    sameType: boolean
  }>
  droppedDuplicates?: Array<{
    name: string
    xeroContactId: string
    group: string
    keptGroup: string
  }>
  // #2108 (L3): two different Xero contacts linking to the same member with
  // conflicting type mappings — the loser is reported here, not silently dropped.
  memberCollisions?: Array<{
    memberId: string
    name: string
    keptGroup: string
    keptMembershipTypeId: string | null
    droppedGroup: string
    droppedMembershipTypeId: string | null
  }>
  skippedExisting?: number
  skippedNoEmail?: number
  skippedNoEmailDetails?: Array<{ name: string; xeroContactId: string }>
  skippedArchived?: number
  skippedArchivedDetails?: Array<{
    name: string
    xeroContactId: string
    group: string
    reason?: string
  }>
  groupsProcessed?: string[]
  syncReport?: SyncReport
}

export interface SyncReport {
  created: Array<{ name: string; email: string; xeroContactId: string; group?: string }>
  updated: Array<{ name: string; memberId: string; xeroContactId: string; changes: string[] }>
  skippedNoChanges: number
  skippedNameMismatch: Array<{
    memberId: string
    memberName: string
    memberEmail: string
    xeroContactId: string
    xeroContactName: string
    xeroContactEmail: string | null
    reasons: string[]
  }>
  skippedNoEmail: Array<{ name: string; xeroContactId: string }>
  skippedOther: Array<{ name: string; xeroContactId?: string; reason: string }>
  errors: Array<{ name: string; xeroContactId?: string; error: string }>
  total: number
}

export interface ContactGroup {
  id: string
  name: string
  contactCount: number
}

// Import mode (#2108): mirrors the member-grouping vocabulary. "ageTiers" is
// today's behaviour (map each group to an age tier); "membershipTypes" maps to a
// membership type; "both" maps to a type and a bookable tier.
export type ImportMode = "ageTiers" | "membershipTypes" | "both"

export interface GroupMapping {
  groupId: string
  groupName: string
  ageTier: AgeTier | "SKIP"
  // #2108: set in "membershipTypes" / "both" modes.
  membershipTypeId?: string
}

// A single active membership type, as returned by GET /api/admin/membership-types
// (the subset the import UI needs).
export interface ImportMembershipTypeOption {
  id: string
  name: string
  isActive: boolean
  allowedAgeTiers: AgeTier[]
}

interface DuplicateContact {
  contactID: string
  name: string
  firstName?: string
  lastName?: string
  emailAddress: string
  hasInvoices: boolean
  invoiceCount: number
  contactStatus: string
  updatedDateUTC?: string
  xeroLink: string
  memberId?: string
  memberActive?: boolean
}

export interface DuplicateGroup {
  email: string
  contacts: DuplicateContact[]
  canCreateFamilyGroup: boolean
  eligibleMemberIds: string[]
  suggestedGroupName?: string
}

export interface DuplicateResult {
  duplicateGroups: DuplicateGroup[]
  totalContacts: number
  totalDuplicateEmails: number
  filteredByFamilyGroup: number
}

export interface ForceSyncMemberOption {
  id: string
  firstName: string
  lastName: string
  email: string
  active: boolean
  xeroContactId: string | null
}

export interface ForceSyncXeroContactOption {
  contactId: string
  name: string
  firstName: string | null
  lastName: string | null
  email: string | null
  isLinked: boolean
  linkedMemberId: string | null
  linkedMemberName: string | null
  existingMemberId: string | null
  existingMemberName: string | null
  canImportAsMember: boolean
  importBlockReason: string | null
}

export interface ForceSyncBookingOption {
  id: string
  memberName: string
  memberEmail: string
  checkIn: string
  checkOut: string
  status: string
  guestCount: number
  paymentId: string | null
  xeroInvoiceId: string | null
  canForceSyncInvoice: boolean
  forceSyncInvoiceReason: string | null
}

export interface XeroHealthSnapshot {
  unlinkedMembers: { count: number; href: string }
  failedOperations: { count: number; legacyCount: number }
  pendingOperations: { count: number }
  lastMembershipRefresh: { at: string | null; lastCronStatus: string | null; lastCronStartedAt: string | null }
  missingInvoices: { count: number }
  contactGroupMismatches: { count: number; cacheReady: boolean }
  contactLinkMismatches: { count: number; cacheReady: boolean }
  apiBudget: { status: "healthy" | "warning" | "critical" | "exhausted" | "unknown"; usagePercent: number | null; totalCalls: number | null; failedCalls: number | null }
}

interface MissingInvoiceBooking {
  bookingId: string
  paymentId: string
  memberId: string
  memberName: string
  memberEmail: string
  status: "PAID"
  checkIn: string
  checkOut: string
  createdAt: string
  hasLinkedInvoice: boolean
}

export interface MissingInvoicesResponse {
  count: number
  bookings: MissingInvoiceBooking[]
}

// Mode-driven member-grouping mismatch (E8, #1934). Mirrors
// MemberGroupingDiffEntry from src/lib/xero-member-grouping-resync.ts.
interface ContactGroupMismatch {
  memberId: string
  memberName: string
  memberEmail: string
  ageTier: AgeTier
  xeroContactId: string
  managedGroup: {
    id: string
    name: string | null
  } | null
  addGroupId: string | null
  removeGroupIds: string[]
}

// Summary returned by the POST resync-from-Xero branch of the mismatch
// endpoints (#1441).
interface ContactCacheResyncSummary {
  requestedContacts: number
  resyncedContacts: number
  removedContacts: number
  resyncedAt: string
}

// Information-only residue: a member no rule matches who still sits in
// managed-universe group(s). Never written to by any sync path.
interface ContactGroupInformationalEntry {
  memberId: string
  memberName: string
  memberEmail: string
  ageTier: AgeTier
  xeroContactId: string
  unexpectedManagedGroupIds: string[]
}

export interface ContactGroupMismatchResponse {
  mode: "NONE" | "MEMBERSHIP_TYPE" | "MEMBERSHIP_TYPE_AND_AGE"
  cacheReady: boolean
  lastRefreshedAt: string | null
  activeRuleCount: number
  membersConsidered: number
  mismatchCount: number
  addCount: number
  removeCount: number
  estimatedXeroCalls: number
  skippedNoContact: Array<{ memberId: string; memberName: string }>
  mismatches: ContactGroupMismatch[]
  informationalCount: number
  informational: ContactGroupInformationalEntry[]
  resync?: ContactCacheResyncSummary
}

interface ContactLinkMismatch {
  memberId: string
  memberName: string
  memberEmail: string
  active: boolean
  xeroContactId: string
  xeroContactName: string
  xeroContactEmail: string | null
  reasons: string[]
}

export interface ContactLinkMismatchResponse {
  cacheReady: boolean
  lastRefreshedAt: string | null
  count: number
  mismatches: ContactLinkMismatch[]
  resync?: ContactCacheResyncSummary
}

export interface XeroOperation {
  id: string
  direction: string
  entityType: string
  operationType: string
  localModel: string | null
  localId: string | null
  localUrl: string | null
  status: string
  idempotencyKey: string | null
  correlationKey: string | null
  attemptCount: number
  replayable: boolean
  lastErrorCode: string | null
  lastErrorMessage: string | null
  requestPayload: unknown
  responsePayload: unknown
  xeroObjectType: string | null
  xeroObjectId: string | null
  xeroObjectNumber: string | null
  xeroObjectUrl: string | null
  createdByMemberId: string | null
  startedAt: string | null
  completedAt: string | null
  manuallyResolvedAt: string | null
  manuallyResolvedReason: string | null
  manuallyResolvedById: string | null
  createdAt: string
  updatedAt: string
  supported: boolean
  reason: string | null
  failureState: "ACTIVE" | "REPAIRED" | "SUPERSEDED" | null
  failureStateReason: string | null
  failureRootKey: string | null
}

export interface XeroInboundEvent {
  id: string
  source: string
  eventCategory: string | null
  eventType: string
  resourceId: string | null
  eventCreatedAt: string | null
  correlationKey: string
  payload: unknown
  status: string
  errorMessage: string | null
  processedAt: string | null
  createdAt: string
  updatedAt: string
  xeroObjectUrl: string | null
  canReplay: boolean
}

interface XeroUsageBucket {
  label: string
  count: number
  successCount: number
  failureCount: number
}

interface XeroUsageFailure {
  id: string
  operation: string
  workflow: string | null
  resourceType: string
  rateLimitCategory: string | null
  statusCode: number | null
  errorMessage: string | null
  createdAt: string
}

export interface XeroUsageSummary {
  budget: {
    limit: number
    thresholds: Array<{
      fraction: number
      callCount: number
    }>
  }
  today: {
    usageDate: string
    totalCalls: number
    successfulCalls: number
    failedCalls: number
    dayRateLimitHits: number
    minuteRateLimitHits: number
    lastRateLimitCategory: string | null
    lastRateLimitAt: string | null
    usagePercent: number
    budgetStatus: "healthy" | "warning" | "critical" | "exhausted"
  }
  byOperation: XeroUsageBucket[]
  topWorkflows: XeroUsageBucket[]
  recentFailures: XeroUsageFailure[]
  lastDailyLimitEvent: XeroUsageFailure | null
}

export type MembershipSyncMode = "incremental" | "backfill"

type MappingValue = {
  code: string | null
  itemCode: string | null
}

// One row per writable mapping key, straight off the registry (#2717): the
// panel's shape can no longer drift from the set of keys the API accepts.
export type AccountMappings = Record<XeroMappingWritableKey, MappingValue>

export type HutFeeMap = Record<string, { itemCode: string }>
// Item-code-only since #1931 (E5): joining-fee amounts live in the JoiningFee
// schedule (fee-configuration page), not on Xero item-code mapping rows.
export type EntranceFeeMap = Record<string, { itemCode: string | null }>

export type CreditItemMappingKey = "hutFeeRefundItem" | "membershipCancellationCredit"

export type { XeroAccount, XeroItem }
