"use client"

import type { AgeTier } from "@prisma/client"
import { useEffect, useState, useCallback } from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { loadAdminXeroContactGroups } from "@/lib/admin-xero-contact-groups"
import {
  formatRedactedJson,
  redactSensitiveText,
} from "@/lib/redact-sensitive-json"
import { buildHrefWithReturnTo, buildPathWithSearch } from "@/lib/internal-return-path"
import type { XeroAccount, XeroItem } from "@/lib/xero-admin-cache"

interface XeroStatus {
  connected: boolean
  tenantId: string | null
  tokenExpiresAt: string | null
}

interface XeroReferenceCacheMeta {
  source: "memory" | "database" | "xero"
  lastRefreshedAt: string
  expiresAt: string
}

interface SyncResult {
  total?: number
  matched?: number
  updated?: number
  checked?: number
  errors?: number
  errorDetails?: Array<{ member: string; error: string }>
  message?: string
  mode?: "incremental" | "backfill"
  // Import-specific fields
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
  skippedExisting?: number
  linkedExisting?: number
  linkedExistingDetails?: Array<{
    name: string
    email: string
    memberId: string
    xeroContactId: string
    group: string
  }>
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
  // Detailed sync report fields (#29)
  syncReport?: SyncReport
}

interface SyncReport {
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

interface ContactGroup {
  id: string
  name: string
  contactCount: number
}

interface GroupMapping {
  groupId: string
  groupName: string
  ageTier: AgeTier | "SKIP"
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

interface DuplicateGroup {
  email: string
  contacts: DuplicateContact[]
  canCreateFamilyGroup: boolean
  eligibleMemberIds: string[]
  suggestedGroupName?: string
}

interface DuplicateResult {
  duplicateGroups: DuplicateGroup[]
  totalContacts: number
  totalDuplicateEmails: number
  filteredByFamilyGroup: number
}

interface ForceSyncMemberOption {
  id: string
  firstName: string
  lastName: string
  email: string
  active: boolean
  xeroContactId: string | null
}

interface ForceSyncXeroContactOption {
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

interface ForceSyncBookingOption {
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

interface XeroOperation {
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
  createdAt: string
  updatedAt: string
  supported: boolean
  reason: string | null
  failureState: "ACTIVE" | "REPAIRED" | "SUPERSEDED" | null
  failureStateReason: string | null
  failureRootKey: string | null
}

interface XeroInboundEvent {
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

function formatReferenceCacheLabel(label: string, cache: XeroReferenceCacheMeta | null) {
  if (!cache) {
    return `${label}: no cache metadata yet`
  }

  const sourceLabel =
    cache.source === "database"
      ? "shared cache"
      : cache.source === "memory"
        ? "memory cache"
        : "live Xero"

  return `${label}: ${sourceLabel}, refreshed ${new Date(cache.lastRefreshedAt).toLocaleString()}, expires ${new Date(cache.expiresAt).toLocaleString()}`
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

interface XeroUsageSummary {
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

interface XeroHealthSnapshot {
  unlinkedMembers: {
    count: number
    href: string
  }
  failedOperations: {
    count: number
    legacyCount: number
  }
  pendingOperations: {
    count: number
  }
  lastMembershipRefresh: {
    at: string | null
    lastCronStatus: string | null
    lastCronStartedAt: string | null
  }
  missingInvoices: {
    count: number
  }
  contactGroupMismatches: {
    count: number
    cacheReady: boolean
  }
  contactLinkMismatches: {
    count: number
    cacheReady: boolean
  }
  apiBudget: {
    status: "healthy" | "warning" | "critical" | "exhausted" | "unknown"
    usagePercent: number | null
    totalCalls: number | null
    failedCalls: number | null
  }
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

interface MissingInvoicesResponse {
  count: number
  bookings: MissingInvoiceBooking[]
}

interface ConfiguredAgeTierContactGroup {
  tier: AgeTier
  label: string
  sortOrder: number
  groupId: string
  groupName: string | null
  isDefault: boolean
}

interface ContactGroupMismatch {
  memberId: string
  memberName: string
  memberEmail: string
  ageTier: AgeTier
  xeroContactId: string
  defaultGroup: {
    id: string
    name: string | null
  } | null
  acceptedGroups: Array<{
    id: string
    name: string | null
    isDefault: boolean
  }>
  actualGroups: Array<{
    id: string
    name: string
  }>
  unexpectedManagedGroups: Array<{
    id: string
    name: string
    tier: AgeTier | null
  }>
  missingExpectedGroup: boolean
}

interface ContactGroupMismatchResponse {
  cacheReady: boolean
  lastRefreshedAt: string | null
  configuredMappings: ConfiguredAgeTierContactGroup[]
  count: number
  mismatches: ContactGroupMismatch[]
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

interface ContactLinkMismatchResponse {
  cacheReady: boolean
  lastRefreshedAt: string | null
  count: number
  mismatches: ContactLinkMismatch[]
}

type MembershipSyncMode = "incremental" | "backfill"

type SectionKey =
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

const SECTION_STORAGE_KEY = "admin-xero-section-state-v1"
const SECTION_DEFAULTS: Record<SectionKey, boolean> = {
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

type MappingValue = {
  code: string | null
  itemCode: string | null
}

type AccountMappings = {
  hutFeesIncome: MappingValue
  hutFeeRefunds: MappingValue
  stripeBankAccount: MappingValue
  stripeFees: MappingValue
  subscriptionIncome: MappingValue
  hutFeeItem: MappingValue
  hutFeeRefundItem: MappingValue
  entranceFeeItem: MappingValue
  entranceFeeAmountCents: MappingValue
}

// Account code mapping keys (shown with chart-of-accounts dropdown)
const ACCOUNT_MAPPING_KEYS = ["hutFeesIncome", "hutFeeRefunds", "stripeBankAccount", "stripeFees", "subscriptionIncome"] as const

const MAPPING_LABELS: Record<string, string> = {
  hutFeesIncome: "Hut Fees Income",
  hutFeeRefunds: "Hut Fee Refunds",
  stripeBankAccount: "Stripe Bank Account",
  stripeFees: "Stripe Fees",
  subscriptionIncome: "Subscription Income",
}

const MAPPING_DESCRIPTIONS: Record<string, string> = {
  hutFeesIncome: "Sales account for booking income line items",
  hutFeeRefunds: "Account for refund credit notes",
  stripeBankAccount: "Bank account used to record Stripe payments",
  stripeFees: "Expense account for Stripe transaction fees (optional)",
  subscriptionIncome: "Account code used to detect annual subscription invoices",
}

/** Which Xero account types each mapping accepts */
const MAPPING_TYPE_FILTER: Record<string, string> = {
  hutFeesIncome: "REVENUE",
  hutFeeRefunds: "REVENUE",
  stripeBankAccount: "BANK",
  stripeFees: "EXPENSE",
  subscriptionIncome: "REVENUE",
}

function SyncReportSection({
  title,
  count,
  defaultOpen,
  children,
}: {
  title: string
  count: number
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen ?? false)
  if (count === 0) return null
  return (
    <div className="border rounded-md">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 text-sm font-medium text-left hover:bg-slate-50"
      >
        <span>{title} ({count})</span>
        <span className="text-xs text-slate-400">{open ? "▼" : "▶"}</span>
      </button>
      {open && <div className="px-3 pb-3 space-y-1 border-t">{children}</div>}
    </div>
  )
}

function SyncReportView({ report, returnTo }: { report: SyncReport; returnTo: string }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Scanned {report.total} Xero contacts
      </p>

      <SyncReportSection title="Updated Members" count={report.updated.length}>
        {report.updated.map((u, i) => (
          <div key={i} className="flex items-start justify-between text-xs py-1 border-b last:border-0">
            <div>
              <a
                href={buildHrefWithReturnTo(`/admin/members/${u.memberId}`, returnTo)}
                className="text-blue-600 hover:underline font-medium"
              >
                {u.name}
              </a>
              <ul className="mt-0.5 text-slate-500 list-disc list-inside">
                {u.changes.map((c, j) => <li key={j}>{c}</li>)}
              </ul>
            </div>
            <a href={`https://go.xero.com/Contacts/View/${u.xeroContactId}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline shrink-0 ml-2">Xero ↗</a>
          </div>
        ))}
      </SyncReportSection>

      <SyncReportSection title="Already Linked (No Changes)" count={report.skippedNoChanges}>
        <p className="text-xs text-slate-500 pt-1">{report.skippedNoChanges} contacts were already linked and had no data to update.</p>
      </SyncReportSection>

      <SyncReportSection title="Skipped — Name Mismatch" count={report.skippedNameMismatch.length} defaultOpen={true}>
        {report.skippedNameMismatch.map((mismatch, i) => (
          <div key={i} className="flex items-start justify-between gap-3 text-xs py-1 border-b last:border-0">
            <div>
              <a
                href={buildHrefWithReturnTo(`/admin/members/${mismatch.memberId}`, returnTo)}
                className="text-blue-600 hover:underline font-medium"
              >
                {mismatch.memberName}
              </a>
              <p className="text-slate-500">{mismatch.memberEmail}</p>
              <p className="text-slate-500">
                Xero contact: {mismatch.xeroContactName}
                {mismatch.xeroContactEmail ? ` (${mismatch.xeroContactEmail})` : ""}
              </p>
              <p className="text-amber-700">{mismatch.reasons.join(", ")}</p>
            </div>
            <a href={`https://go.xero.com/Contacts/View/${mismatch.xeroContactId}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline shrink-0">
              Xero ↗
            </a>
          </div>
        ))}
      </SyncReportSection>

      <SyncReportSection title="Skipped — No Email" count={report.skippedNoEmail.length}>
        {report.skippedNoEmail.map((s, i) => (
          <div key={i} className="flex items-center justify-between text-xs py-1 border-b last:border-0">
            <span>{s.name}</span>
            <a href={`https://go.xero.com/Contacts/View/${s.xeroContactId}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline shrink-0 ml-2">Open in Xero ↗</a>
          </div>
        ))}
      </SyncReportSection>

      <SyncReportSection title="Skipped — Other Reasons" count={report.skippedOther.length}>
        {report.skippedOther.map((s, i) => (
          <div key={i} className="flex items-center justify-between text-xs py-1 border-b last:border-0">
            <div>
              <span className="font-medium">{s.name}</span>
              <span className="text-slate-500 ml-1">— {s.reason}</span>
            </div>
            {s.xeroContactId && (
              <a href={`https://go.xero.com/Contacts/View/${s.xeroContactId}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline shrink-0 ml-2">Xero ↗</a>
            )}
          </div>
        ))}
      </SyncReportSection>

      <SyncReportSection title="Errors" count={report.errors.length} defaultOpen={true}>
        {report.errors.map((e, i) => (
          <div key={i} className="flex items-center justify-between text-xs py-1 border-b last:border-0 text-red-700">
            <div>
              <span className="font-medium">{e.name}</span>
              <span className="ml-1">— {e.error}</span>
            </div>
            {e.xeroContactId && (
              <a href={`https://go.xero.com/Contacts/View/${e.xeroContactId}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline shrink-0 ml-2">Xero ↗</a>
            )}
          </div>
        ))}
      </SyncReportSection>

      {report.created.length > 0 && (
        <SyncReportSection title="Newly Created Members" count={report.created.length}>
          {report.created.map((c, i) => (
            <div key={i} className="flex items-center justify-between text-xs py-1 border-b last:border-0">
              <div>
                <span className="font-medium">{c.name}</span>
                <span className="text-slate-500 ml-1">{c.email}</span>
                {c.group && <Badge variant="secondary" className="ml-1 text-[10px] py-0">{c.group}</Badge>}
              </div>
              <a href={`https://go.xero.com/Contacts/View/${c.xeroContactId}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline shrink-0 ml-2">Xero ↗</a>
            </div>
          ))}
        </SyncReportSection>
      )}
    </div>
  )
}

function SectionCard({
  id,
  title,
  description,
  open,
  onToggle,
  actions,
  children,
}: {
  id: string
  title: string
  description: string
  open: boolean
  onToggle: (nextOpen: boolean) => void
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Card id={id} className="mb-6 scroll-mt-24">
      <CardHeader className="gap-4 md:flex-row md:items-start md:justify-between">
        <button
          type="button"
          onClick={() => onToggle(!open)}
          className="flex w-full items-start justify-between gap-3 text-left md:flex-1"
        >
          <div className="space-y-1">
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <span className="pt-0.5 text-xs text-muted-foreground">{open ? "▼" : "▶"}</span>
        </button>
        {actions ? (
          <div className="flex shrink-0 items-center gap-2" onClick={(event) => event.stopPropagation()}>
            {actions}
          </div>
        ) : null}
      </CardHeader>
      {open ? <CardContent>{children}</CardContent> : null}
    </Card>
  )
}

function HealthStatCard({
  label,
  value,
  subtitle,
  badge,
  href,
  onClick,
}: {
  label: string
  value: React.ReactNode
  subtitle: string
  badge?: React.ReactNode
  href?: string
  onClick?: () => void
}) {
  const className =
    "flex h-full flex-col rounded-xl border bg-white p-4 text-left shadow-sm transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"

  const content = (
    <>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
          <div className="mt-2 break-words text-2xl font-semibold leading-tight">{value}</div>
        </div>
        {badge ? (
          <div className="max-w-full shrink-0 [&>*]:max-w-full [&>*]:whitespace-normal [&>*]:text-center [&>*]:leading-4">
            {badge}
          </div>
        ) : null}
      </div>
      <p className="mt-4 text-sm leading-5 text-muted-foreground">{subtitle}</p>
    </>
  )

  if (href) {
    return (
      <a href={href} className={className}>
        {content}
      </a>
    )
  }

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={`${className} w-full`}>
        {content}
      </button>
    )
  }

  return <div className={className}>{content}</div>
}

export default function XeroPage() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [status, setStatus] = useState<XeroStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null)
  const [error, setError] = useState("")
  const [connectSuccess, setConnectSuccess] = useState(false)
  const [sectionOpen, setSectionOpen] = useState<Record<SectionKey, boolean>>(SECTION_DEFAULTS)
  const [healthSnapshot, setHealthSnapshot] = useState<XeroHealthSnapshot | null>(null)
  const [loadingHealth, setLoadingHealth] = useState(false)
  const [contactGroupMismatches, setContactGroupMismatches] = useState<ContactGroupMismatchResponse | null>(null)
  const [loadingContactGroupMismatches, setLoadingContactGroupMismatches] = useState(false)
  const [contactLinkMismatches, setContactLinkMismatches] = useState<ContactLinkMismatchResponse | null>(null)
  const [loadingContactLinkMismatches, setLoadingContactLinkMismatches] = useState(false)
  const [missingInvoiceDetails, setMissingInvoiceDetails] = useState<MissingInvoicesResponse | null>(null)
  const [loadingMissingInvoices, setLoadingMissingInvoices] = useState(false)
  const [showMissingInvoices, setShowMissingInvoices] = useState(false)
  const [triggeringMissingInvoices, setTriggeringMissingInvoices] = useState(false)
  const [unlinkingMismatchMemberId, setUnlinkingMismatchMemberId] = useState<string | null>(null)
  const [retryingAllFailed, setRetryingAllFailed] = useState(false)
  const [forceSyncType, setForceSyncType] = useState<"CONTACT" | "INVOICE" | "MEMBERSHIP">("CONTACT")
  const [forceSyncing, setForceSyncing] = useState(false)
  const [forceSyncMemberSearch, setForceSyncMemberSearch] = useState("")
  const [forceSyncMemberResults, setForceSyncMemberResults] = useState<ForceSyncMemberOption[]>([])
  const [forceSyncMemberSearching, setForceSyncMemberSearching] = useState(false)
  const [selectedForceSyncMember, setSelectedForceSyncMember] = useState<ForceSyncMemberOption | null>(null)
  const [forceSyncXeroContactResults, setForceSyncXeroContactResults] = useState<ForceSyncXeroContactOption[]>([])
  const [forceSyncXeroContactSearching, setForceSyncXeroContactSearching] = useState(false)
  const [importingXeroContactId, setImportingXeroContactId] = useState<string | null>(null)
  const [forceSyncBookingSearch, setForceSyncBookingSearch] = useState("")
  const [forceSyncBookingResults, setForceSyncBookingResults] = useState<ForceSyncBookingOption[]>([])
  const [forceSyncBookingSearching, setForceSyncBookingSearching] = useState(false)
  const [selectedForceSyncBooking, setSelectedForceSyncBooking] = useState<ForceSyncBookingOption | null>(null)

  // Import state
  const [contactGroups, setContactGroups] = useState<ContactGroup[]>([])
  const [groupMappings, setGroupMappings] = useState<GroupMapping[]>([])
  const [loadingGroups, setLoadingGroups] = useState(false)
  const [refreshingGroups, setRefreshingGroups] = useState(false)
  const [sendInvites, setSendInvites] = useState(false)
  const [repairMissingContactCache, setRepairMissingContactCache] = useState(false)

  // Duplicate detection state
  const [duplicates, setDuplicates] = useState<DuplicateResult | null>(null)
  const [scanningDuplicates, setScanningDuplicates] = useState(false)
  const [creatingFamilyGroup, setCreatingFamilyGroup] = useState<string | null>(null)

  // Account mappings state
  const [accountMappings, setAccountMappings] = useState<AccountMappings | null>(null)
  const [savedMappings, setSavedMappings] = useState<AccountMappings | null>(null)
  const [chartOfAccounts, setChartOfAccounts] = useState<XeroAccount[]>([])
  const [xeroItems, setXeroItems] = useState<XeroItem[]>([])
  const [accountCacheMeta, setAccountCacheMeta] = useState<XeroReferenceCacheMeta | null>(null)
  const [itemCacheMeta, setItemCacheMeta] = useState<XeroReferenceCacheMeta | null>(null)
  const [loadingMappings, setLoadingMappings] = useState(false)
  const [refreshingReferenceData, setRefreshingReferenceData] = useState(false)
  const [savingMappings, setSavingMappings] = useState(false)
  const [mappingError, setMappingError] = useState("")
  const [mappingSaved, setMappingSaved] = useState(false)
  const [isEditingMappings, setIsEditingMappings] = useState(false)
  const [operations, setOperations] = useState<XeroOperation[]>([])
  const [loadingOperations, setLoadingOperations] = useState(false)
  const [operationStatusFilter, setOperationStatusFilter] = useState("all")
  const [operationEntityFilter, setOperationEntityFilter] = useState("all")
  const [retryingOperationId, setRetryingOperationId] = useState<string | null>(null)
  const [inboundEvents, setInboundEvents] = useState<XeroInboundEvent[]>([])
  const [loadingInboundEvents, setLoadingInboundEvents] = useState(false)
  const [inboundEventStatusFilter, setInboundEventStatusFilter] = useState("all")
  const [inboundEventCategoryFilter, setInboundEventCategoryFilter] = useState("all")
  const [replayingInboundEventId, setReplayingInboundEventId] = useState<string | null>(null)
  const [operationMessage, setOperationMessage] = useState("")
  const [usageSummary, setUsageSummary] = useState<XeroUsageSummary | null>(null)
  const [loadingUsage, setLoadingUsage] = useState(false)

  // Granular item code mappings state
  type HutFeeMap = Record<string, { itemCode: string }>
  type EntranceFeeMap = Record<string, { itemCode: string | null; amountCents: number | null }>
  const [hutFeeItemCodes, setHutFeeItemCodes] = useState<HutFeeMap>({})
  const [savedHutFeeItemCodes, setSavedHutFeeItemCodes] = useState<HutFeeMap>({})
  const [entranceFeeItemCodes, setEntranceFeeItemCodes] = useState<EntranceFeeMap>({})
  const [savedEntranceFeeItemCodes, setSavedEntranceFeeItemCodes] = useState<EntranceFeeMap>({})
  const currentXeroPath = buildPathWithSearch(pathname, searchParams.toString())

  const scrollToSection = useCallback((section: SectionKey) => {
    setSectionOpen((prev) => ({ ...prev, [section]: true }))
    window.setTimeout(() => {
      document.getElementById(`xero-section-${section}`)?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      })
    }, 0)
  }, [])

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/xero/status")
      if (!res.ok) throw new Error("Failed to fetch status")
      const data = await res.json()
      setStatus(data)
    } catch {
      setError("Failed to load Xero connection status")
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchHealth = useCallback(async () => {
    setLoadingHealth(true)
    try {
      const res = await fetch("/api/admin/xero/health")
      if (!res.ok) throw new Error("Failed to fetch Xero health")
      const data = await res.json()
      setHealthSnapshot(data)
    } catch {
      setError("Failed to load Xero health snapshot")
    } finally {
      setLoadingHealth(false)
    }
  }, [])

  const fetchMissingInvoices = useCallback(async () => {
    setLoadingMissingInvoices(true)
    try {
      const res = await fetch("/api/admin/xero/missing-invoices")
      if (!res.ok) throw new Error("Failed to fetch missing invoices")
      const data = await res.json()
      setMissingInvoiceDetails(data)
    } catch {
      setError("Failed to load bookings missing Xero invoices")
    } finally {
      setLoadingMissingInvoices(false)
    }
  }, [])

  const fetchContactGroupMismatches = useCallback(async () => {
    setLoadingContactGroupMismatches(true)
    try {
      const res = await fetch("/api/admin/xero/contact-group-mismatches?limit=200")
      if (!res.ok) throw new Error("Failed to fetch contact group mismatches")
      const data = await res.json()
      setContactGroupMismatches(data)
    } catch {
      setError("Failed to load Xero contact group mismatches")
    } finally {
      setLoadingContactGroupMismatches(false)
    }
  }, [])

  const fetchContactLinkMismatches = useCallback(async () => {
    setLoadingContactLinkMismatches(true)
    try {
      const res = await fetch("/api/admin/xero/contact-link-mismatches?limit=200")
      if (!res.ok) throw new Error("Failed to fetch contact link mismatches")
      const data = await res.json()
      setContactLinkMismatches(data)
    } catch {
      setError("Failed to load Xero contact link mismatches")
    } finally {
      setLoadingContactLinkMismatches(false)
    }
  }, [])

  const fetchAccountMappings = useCallback(async (options?: { forceRefresh?: boolean }) => {
    setLoadingMappings(true)
    try {
      const refreshSuffix = options?.forceRefresh ? "?refresh=1" : ""
      const [mappingsRes, accountsRes, itemsRes, itemCodeRes] = await Promise.all([
        fetch("/api/admin/xero/account-mappings"),
        fetch(`/api/admin/xero/chart-of-accounts${refreshSuffix}`),
        fetch(`/api/admin/xero/items${refreshSuffix}`),
        fetch("/api/admin/xero/item-code-mappings"),
      ])
      if (mappingsRes.ok) {
        const data = await mappingsRes.json()
        setAccountMappings(data)
        setSavedMappings(data)
      }
      if (accountsRes.ok) {
        const data = await accountsRes.json()
        setChartOfAccounts(data.accounts ?? [])
        setAccountCacheMeta(data.cache ?? null)
      }
      if (itemsRes.ok) {
        const data = await itemsRes.json()
        setXeroItems(data.items ?? [])
        setItemCacheMeta(data.cache ?? null)
      }
      if (itemCodeRes.ok) {
        const data = await itemCodeRes.json()
        setHutFeeItemCodes(data.hutFees ?? {})
        setSavedHutFeeItemCodes(data.hutFees ?? {})
        setEntranceFeeItemCodes(data.entranceFees ?? {})
        setSavedEntranceFeeItemCodes(data.entranceFees ?? {})
      }
    } catch {
      setMappingError("Failed to load account mappings")
    } finally {
      setLoadingMappings(false)
    }
  }, [])

  const refreshReferenceData = useCallback(async () => {
    setRefreshingReferenceData(true)
    try {
      await fetchAccountMappings({ forceRefresh: true })
    } finally {
      setRefreshingReferenceData(false)
    }
  }, [fetchAccountMappings])

  const fetchOperations = useCallback(async (statusFilter: string, entityFilter: string) => {
    setLoadingOperations(true)
    try {
      const params = new URLSearchParams({
        status: statusFilter,
        entityType: entityFilter,
        direction: "all",
        limit: "25",
      })
      const res = await fetch(`/api/admin/xero/operations?${params.toString()}`)
      if (!res.ok) throw new Error("Failed to fetch Xero operations")
      const data = await res.json()
      setOperations(data.data ?? [])
    } catch {
      setError("Failed to load Xero operation history")
    } finally {
      setLoadingOperations(false)
    }
  }, [])

  const fetchInboundEvents = useCallback(async (statusFilter: string, categoryFilter: string) => {
    setLoadingInboundEvents(true)
    try {
      const params = new URLSearchParams({
        status: statusFilter,
        eventCategory: categoryFilter,
        source: "all",
        limit: "25",
      })
      const res = await fetch(`/api/admin/xero/inbound-events?${params.toString()}`)
      if (!res.ok) throw new Error("Failed to fetch Xero inbound events")
      const data = await res.json()
      setInboundEvents(data.data ?? [])
    } catch {
      setError("Failed to load Xero inbound events")
    } finally {
      setLoadingInboundEvents(false)
    }
  }, [])

  const fetchUsage = useCallback(async () => {
    setLoadingUsage(true)
    try {
      const res = await fetch("/api/admin/xero/usage")
      if (!res.ok) throw new Error("Failed to fetch Xero API usage")
      const data = await res.json()
      setUsageSummary(data)
    } catch {
      setError("Failed to load Xero API usage")
    } finally {
      setLoadingUsage(false)
    }
  }, [])

  const loadContactGroups = useCallback(
    async (options?: {
      refreshFromXero?: boolean
      fallbackToRefreshIfEmpty?: boolean
      repairMissingContactCache?: boolean
    }) => {
      if (options?.refreshFromXero) {
        setRefreshingGroups(true)
      } else {
        setLoadingGroups(true)
      }
      setError("")

      try {
        const result = await loadAdminXeroContactGroups({
          refreshFromXero: options?.refreshFromXero,
          fallbackToRefreshIfEmpty: options?.fallbackToRefreshIfEmpty,
          repairMissingContactCache: options?.repairMissingContactCache,
        })

        setContactGroups(result.groups)
        setGroupMappings((prev) =>
          result.groups.map((group) => {
            const existing = prev.find((mapping) => mapping.groupId === group.id)
            return {
              groupId: group.id,
              groupName: group.name,
              ageTier: existing?.ageTier ?? "SKIP",
            }
          })
        )

        await fetchHealth()
        if (sectionOpen.contactGroupMismatches) {
          await fetchContactGroupMismatches()
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load Xero contact groups"
        )
      } finally {
        setLoadingGroups(false)
        setRefreshingGroups(false)
      }
    },
    [fetchContactGroupMismatches, fetchHealth, sectionOpen.contactGroupMismatches]
  )

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  useEffect(() => {
    try {
      const storedState = window.localStorage.getItem(SECTION_STORAGE_KEY)
      if (!storedState) return
      const parsed = JSON.parse(storedState) as Partial<Record<SectionKey, boolean>>
      setSectionOpen((prev) => ({
        ...prev,
        ...parsed,
      }))
    } catch {
      // Ignore malformed localStorage state and fall back to defaults.
    }
  }, [])

  useEffect(() => {
    window.localStorage.setItem(SECTION_STORAGE_KEY, JSON.stringify(sectionOpen))
  }, [sectionOpen])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const connected = params.get("connected")
    const errorParam = params.get("error")
    if (connected === "true") {
      setConnectSuccess(true)
      fetchStatus()
    }
    if (errorParam) {
      setError(decodeURIComponent(errorParam))
    }
  }, [fetchStatus])

  // Load account mappings whenever Xero is connected
  useEffect(() => {
    if (status?.connected) {
      fetchAccountMappings()
    }
  }, [status?.connected, fetchAccountMappings])

  useEffect(() => {
    if (status?.connected) {
      void loadContactGroups()
    } else {
      setContactGroups([])
      setGroupMappings([])
    }
  }, [loadContactGroups, status?.connected])

  useEffect(() => {
    if (status?.connected) {
      fetchOperations(operationStatusFilter, operationEntityFilter)
    }
  }, [status?.connected, operationStatusFilter, operationEntityFilter, fetchOperations])

  useEffect(() => {
    if (status?.connected) {
      fetchInboundEvents(inboundEventStatusFilter, inboundEventCategoryFilter)
    }
  }, [status?.connected, inboundEventStatusFilter, inboundEventCategoryFilter, fetchInboundEvents])

  useEffect(() => {
    if (status?.connected) {
      fetchUsage()
    }
  }, [status?.connected, fetchUsage])

  useEffect(() => {
    if (status?.connected) {
      fetchHealth()
    } else {
      setHealthSnapshot(null)
      setContactGroupMismatches(null)
      setContactLinkMismatches(null)
      setMissingInvoiceDetails(null)
      setShowMissingInvoices(false)
    }
  }, [status?.connected, fetchHealth])

  useEffect(() => {
    if (
      status?.connected &&
      sectionOpen.contactGroupMismatches &&
      !contactGroupMismatches &&
      !loadingContactGroupMismatches
    ) {
      void fetchContactGroupMismatches()
    }
  }, [
    contactGroupMismatches,
    fetchContactGroupMismatches,
    loadingContactGroupMismatches,
    sectionOpen.contactGroupMismatches,
    status?.connected,
  ])

  useEffect(() => {
    if (
      status?.connected &&
      sectionOpen.contactLinkMismatches &&
      !contactLinkMismatches &&
      !loadingContactLinkMismatches
    ) {
      void fetchContactLinkMismatches()
    }
  }, [
    contactLinkMismatches,
    fetchContactLinkMismatches,
    loadingContactLinkMismatches,
    sectionOpen.contactLinkMismatches,
    status?.connected,
  ])

  useEffect(() => {
    if (forceSyncType === "INVOICE" || selectedForceSyncMember) {
      setForceSyncMemberResults([])
      setForceSyncMemberSearching(false)
      return
    }

    const query = forceSyncMemberSearch.trim()
    if (query.length < 2) {
      setForceSyncMemberResults([])
      setForceSyncMemberSearching(false)
      return
    }

    let cancelled = false
    setForceSyncMemberSearching(true)

    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin/members?q=${encodeURIComponent(query)}&pageSize=8`)
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          throw new Error(data.error || "Failed to search members")
        }

        if (!cancelled) {
          setForceSyncMemberResults(
            (data.members ?? []).map((member: ForceSyncMemberOption) => ({
              id: member.id,
              firstName: member.firstName,
              lastName: member.lastName,
              email: member.email,
              active: member.active,
              xeroContactId: member.xeroContactId ?? null,
            }))
          )
        }
      } catch (err) {
        if (!cancelled) {
          setForceSyncMemberResults([])
          setError(err instanceof Error ? err.message : "Failed to search members")
        }
      } finally {
        if (!cancelled) {
          setForceSyncMemberSearching(false)
        }
      }
    }, 250)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [forceSyncMemberSearch, forceSyncType, selectedForceSyncMember])

  useEffect(() => {
    if (forceSyncType !== "CONTACT" || selectedForceSyncMember) {
      setForceSyncXeroContactResults([])
      setForceSyncXeroContactSearching(false)
      return
    }

    const query = forceSyncMemberSearch.trim()
    if (query.length < 2) {
      setForceSyncXeroContactResults([])
      setForceSyncXeroContactSearching(false)
      return
    }

    let cancelled = false
    setForceSyncXeroContactSearching(true)

    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin/xero/search-contacts?q=${encodeURIComponent(query)}`)
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          throw new Error(data.error || "Failed to search Xero contacts")
        }

        if (!cancelled) {
          setForceSyncXeroContactResults(data.contacts ?? [])
        }
      } catch (err) {
        if (!cancelled) {
          setForceSyncXeroContactResults([])
          setError(err instanceof Error ? err.message : "Failed to search Xero contacts")
        }
      } finally {
        if (!cancelled) {
          setForceSyncXeroContactSearching(false)
        }
      }
    }, 250)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [forceSyncMemberSearch, forceSyncType, selectedForceSyncMember])

  useEffect(() => {
    if (forceSyncType !== "INVOICE" || selectedForceSyncBooking) {
      setForceSyncBookingResults([])
      setForceSyncBookingSearching(false)
      return
    }

    const query = forceSyncBookingSearch.trim()
    if (query.length < 2) {
      setForceSyncBookingResults([])
      setForceSyncBookingSearching(false)
      return
    }

    let cancelled = false
    setForceSyncBookingSearching(true)

    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin/bookings/search?q=${encodeURIComponent(query)}&limit=8`)
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          throw new Error(data.error || "Failed to search bookings")
        }

        if (!cancelled) {
          setForceSyncBookingResults(data.bookings ?? [])
        }
      } catch (err) {
        if (!cancelled) {
          setForceSyncBookingResults([])
          setError(err instanceof Error ? err.message : "Failed to search bookings")
        }
      } finally {
        if (!cancelled) {
          setForceSyncBookingSearching(false)
        }
      }
    }, 250)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [forceSyncBookingSearch, forceSyncType, selectedForceSyncBooking])

  const handleRetryOperation = async (operationId: string) => {
    setRetryingOperationId(operationId)
    setOperationMessage("")
    setError("")
    try {
      const res = await fetch(`/api/admin/xero/operations/${operationId}/retry`, {
        method: "POST",
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || "Failed to retry Xero operation")
      }
      setOperationMessage(data.message || "Xero operation queued for background retry.")
      await Promise.all([
        fetchOperations(operationStatusFilter, operationEntityFilter),
        fetchHealth(),
      ])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to retry Xero operation")
    } finally {
      setRetryingOperationId(null)
    }
  }

  const handleReplayInboundEvent = async (eventId: string) => {
    setReplayingInboundEventId(eventId)
    setOperationMessage("")
    setError("")
    try {
      const res = await fetch(`/api/admin/xero/inbound-events/${eventId}/replay`, {
        method: "POST",
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || "Failed to replay Xero inbound event")
      }
      setOperationMessage(data.message || "Xero inbound event replayed.")
      await Promise.all([
        fetchInboundEvents(inboundEventStatusFilter, inboundEventCategoryFilter),
        fetchOperations(operationStatusFilter, operationEntityFilter),
        fetchHealth(),
      ])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to replay Xero inbound event")
    } finally {
      setReplayingInboundEventId(null)
    }
  }

  const handleRetryAllFailed = async () => {
    setRetryingAllFailed(true)
    setOperationMessage("")
    setError("")
    try {
      const res = await fetch("/api/admin/xero/operations/retry-all", {
        method: "POST",
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || "Failed to queue failed Xero operations")
      }
      setOperationMessage(data.message || "Queued failed Xero operations for retry.")
      await Promise.all([
        fetchOperations(operationStatusFilter, operationEntityFilter),
        fetchHealth(),
      ])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to queue failed Xero operations")
    } finally {
      setRetryingAllFailed(false)
    }
  }

  const handleToggleMissingInvoices = async () => {
    const nextOpen = !showMissingInvoices
    setShowMissingInvoices(nextOpen)
    if (nextOpen && !missingInvoiceDetails && !loadingMissingInvoices) {
      await fetchMissingInvoices()
    }
  }

  const handleTriggerMissingInvoices = async () => {
    setTriggeringMissingInvoices(true)
    setOperationMessage("")
    setError("")
    try {
      const res = await fetch("/api/admin/xero/missing-invoices", {
        method: "POST",
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || "Failed to queue missing invoices")
      }
      setOperationMessage(data.message || "Queued missing booking invoices.")
      await Promise.all([
        fetchHealth(),
        fetchOperations(operationStatusFilter, operationEntityFilter),
        fetchMissingInvoices(),
      ])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to queue missing invoices")
    } finally {
      setTriggeringMissingInvoices(false)
    }
  }

  const handleUnlinkContactMismatch = async (memberId: string) => {
    setUnlinkingMismatchMemberId(memberId)
    setOperationMessage("")
    setError("")
    try {
      const res = await fetch(`/api/admin/members/${memberId}/xero-unlink`, {
        method: "POST",
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || "Failed to unlink member from Xero")
      }

      setOperationMessage("Member unlinked from Xero. Open the member record to relink the correct contact.")
      await Promise.all([
        fetchHealth(),
        fetchContactLinkMismatches(),
        contactGroupMismatches ? fetchContactGroupMismatches() : Promise.resolve(),
      ])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to unlink member from Xero")
    } finally {
      setUnlinkingMismatchMemberId(null)
    }
  }

  const handleForceSync = async () => {
    const selectedBooking = selectedForceSyncBooking
    const selectedMember = selectedForceSyncMember

    if (forceSyncType === "INVOICE") {
      if (!selectedBooking) {
        setError("Search for and select the booking you want to sync.")
        return
      }

      if (!selectedBooking.canForceSyncInvoice) {
        setError(selectedBooking.forceSyncInvoiceReason || "This booking cannot be synced right now.")
        return
      }
    } else if (!selectedMember) {
      setError("Search for and select the member you want to sync.")
      return
    }

    setForceSyncing(true)
    setOperationMessage("")
    setError("")
    try {
      let query = ""
      if (forceSyncType === "INVOICE") {
        if (!selectedBooking) {
          throw new Error("Missing selected booking for invoice sync.")
        }
        query = selectedBooking.id
      } else {
        if (!selectedMember) {
          throw new Error("Missing selected member for targeted sync.")
        }
        query = selectedMember.id
      }

      const res = await fetch("/api/admin/xero/force-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          syncType: forceSyncType,
          query,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || "Failed targeted Xero sync")
      }
      setOperationMessage(data.message || "Targeted Xero sync queued.")
      await Promise.all([
        fetchHealth(),
        fetchOperations(operationStatusFilter, operationEntityFilter),
      ])
      if (forceSyncType === "INVOICE") {
        await fetchMissingInvoices()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed targeted Xero sync")
    } finally {
      setForceSyncing(false)
    }
  }

  const handleImportXeroContactAsMember = async (contact: ForceSyncXeroContactOption) => {
    if (!contact.canImportAsMember) {
      setError(contact.importBlockReason || "This Xero contact cannot be imported.")
      return
    }

    setImportingXeroContactId(contact.contactId)
    setOperationMessage("")
    setError("")
    try {
      const res = await fetch("/api/admin/xero/import-member-contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ xeroContactId: contact.contactId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || "Failed to import Xero contact")
      }

      setSelectedForceSyncMember({
        id: data.memberId,
        firstName: data.memberFirstName || contact.firstName || contact.name,
        lastName: data.memberLastName || contact.lastName || "",
        email: data.memberEmail,
        active: data.active ?? true,
        xeroContactId: data.xeroContactId,
      })
      setForceSyncMemberSearch("")
      setForceSyncMemberResults([])
      setForceSyncXeroContactResults([])
      setOperationMessage(data.warning ? `${data.message} ${data.warning}` : data.message)
      await fetchHealth()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import Xero contact")
    } finally {
      setImportingXeroContactId(null)
    }
  }

  const handleForceSyncTypeChange = (value: "CONTACT" | "INVOICE" | "MEMBERSHIP") => {
    setForceSyncType(value)
    setError("")
    setSelectedForceSyncMember(null)
    setForceSyncMemberSearch("")
    setForceSyncMemberResults([])
    setForceSyncXeroContactResults([])
    setForceSyncXeroContactSearching(false)
    setImportingXeroContactId(null)
    setSelectedForceSyncBooking(null)
    setForceSyncBookingSearch("")
    setForceSyncBookingResults([])
  }

  const handleConnect = () => {
    window.location.href = "/api/admin/xero/connect"
  }

  const handleDisconnect = async () => {
    if (!confirm("Are you sure you want to disconnect Xero? This will remove all stored tokens.")) {
      return
    }
    try {
      const res = await fetch("/api/admin/xero/disconnect", { method: "POST" })
      if (!res.ok) throw new Error("Failed to disconnect")
      setStatus({ connected: false, tenantId: null, tokenExpiresAt: null })
      setSyncResult(null)
      setHealthSnapshot(null)
      setContactLinkMismatches(null)
      setMissingInvoiceDetails(null)
      setShowMissingInvoices(false)
    } catch {
      setError("Failed to disconnect Xero")
    }
  }

  const handleSyncContacts = async () => {
    setSyncing("contacts")
    setSyncResult(null)
    setError("")
    try {
      const res = await fetch("/api/admin/xero/sync-contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullResync: true }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Sync failed")
      }
      const data = await res.json()
      setSyncResult(data)
      await loadContactGroups()
      await fetchHealth()
      if (sectionOpen.contactLinkMismatches) {
        await fetchContactLinkMismatches()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Contact sync failed")
    } finally {
      setSyncing(null)
    }
  }

  const handleSyncMemberships = async (mode: MembershipSyncMode = "incremental") => {
    setSyncing(mode === "backfill" ? "memberships-backfill" : "memberships")
    setSyncResult(null)
    setError("")
    try {
      const res = await fetch(`/api/admin/xero/sync-memberships?mode=${mode}`, { method: "POST" })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Sync failed")
      }
      const data = await res.json()
      setSyncResult(data)
      await fetchHealth()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Membership sync failed")
    } finally {
      setSyncing(null)
    }
  }

  const handleFetchGroups = async () => {
    await loadContactGroups({
      fallbackToRefreshIfEmpty: true,
      repairMissingContactCache: true,
    })
  }

  const handleImportMembers = async () => {
    const selectedMappings = groupMappings.filter((m) => m.ageTier !== "SKIP")
    if (selectedMappings.length === 0) {
      setError("Please select at least one group to import")
      return
    }

    const groupNames = selectedMappings.map((m) => m.groupName).join(", ")
    if (
      !confirm(
        `Import members from ${selectedMappings.length} group(s): ${groupNames}?\n\n${
          sendInvites
            ? "Invite emails will be sent to all new members."
            : "No invite emails will be sent."
        }`
      )
    ) {
      return
    }

    setSyncing("import")
    setSyncResult(null)
    setError("")
    try {
      const res = await fetch("/api/admin/xero/import-members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          groupMappings: selectedMappings,
          sendInvites,
          repairMissingContactCache,
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Import failed")
      }
      const data = await res.json()
      setSyncResult(data)
      await fetchHealth()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Member import failed")
    } finally {
      setSyncing(null)
    }
  }

  const updateGroupMapping = (groupId: string, ageTier: GroupMapping["ageTier"]) => {
    setGroupMappings((prev) =>
      prev.map((m) => (m.groupId === groupId ? { ...m, ageTier } : m))
    )
  }

  const handleSaveAccountMappings = async () => {
    if (!accountMappings) return
    setSavingMappings(true)
    setMappingError("")
    setMappingSaved(false)
    try {
      // Save legacy account mappings
      const res = await fetch("/api/admin/xero/account-mappings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(accountMappings),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to save mappings")
      }
      const data = await res.json()
      setAccountMappings(data)
      setSavedMappings(data)

      // Save granular item code mappings
      const itemCodeRes = await fetch("/api/admin/xero/item-code-mappings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hutFees: hutFeeItemCodes, entranceFees: entranceFeeItemCodes }),
      })
      if (!itemCodeRes.ok) {
        const itemData = await itemCodeRes.json()
        throw new Error(itemData.error || "Failed to save item code mappings")
      }
      const itemData = await itemCodeRes.json()
      setHutFeeItemCodes(itemData.hutFees ?? {})
      setSavedHutFeeItemCodes(itemData.hutFees ?? {})
      setEntranceFeeItemCodes(itemData.entranceFees ?? {})
      setSavedEntranceFeeItemCodes(itemData.entranceFees ?? {})

      setIsEditingMappings(false)
      setMappingSaved(true)
      setTimeout(() => setMappingSaved(false), 3000)
    } catch (err) {
      setMappingError(err instanceof Error ? err.message : "Failed to save mappings")
    } finally {
      setSavingMappings(false)
    }
  }

  const handleScanDuplicates = async () => {
    setScanningDuplicates(true)
    setDuplicates(null)
    setError("")
    try {
      const res = await fetch("/api/admin/xero/duplicate-contacts")
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Duplicate scan failed")
      }
      const data: DuplicateResult = await res.json()
      setDuplicates(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Duplicate scan failed")
    } finally {
      setScanningDuplicates(false)
    }
  }

  const handleCreateFamilyGroup = async (group: DuplicateGroup) => {
    const name = group.suggestedGroupName || `Family (${group.email})`
    setCreatingFamilyGroup(group.email)
    setError("")
    try {
      const res = await fetch("/api/admin/family-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          memberIds: group.eligibleMemberIds,
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to create family group")
      }
      // Remove this group from the displayed duplicates
      setDuplicates((prev) =>
        prev
          ? {
              ...prev,
              duplicateGroups: prev.duplicateGroups.filter((g) => g.email !== group.email),
              filteredByFamilyGroup: prev.filteredByFamilyGroup + 1,
            }
          : prev
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create family group")
    } finally {
      setCreatingFamilyGroup(null)
    }
  }

  const operationStatusClass = (status: string) => {
    switch (status) {
      case "SUCCEEDED":
      case "PROCESSED":
        return "bg-green-600"
      case "PARTIAL":
        return "bg-amber-500"
      case "FAILED":
        return "bg-red-600"
      case "PENDING":
      case "RECEIVED":
        return "bg-slate-600"
      case "RUNNING":
      case "PROCESSING":
        return "bg-blue-600"
      default:
        return ""
    }
  }

  const failureStateBadgeClass = (state: XeroOperation["failureState"]) => {
    switch (state) {
      case "ACTIVE":
        return "bg-red-600"
      case "REPAIRED":
        return "bg-green-600"
      case "SUPERSEDED":
        return "bg-slate-600"
      default:
        return ""
    }
  }

  const failureStateLabel = (state: XeroOperation["failureState"]) => {
    switch (state) {
      case "ACTIVE":
        return "Active"
      case "REPAIRED":
        return "Repaired"
      case "SUPERSEDED":
        return "Superseded"
      default:
        return null
    }
  }

  const inboundEventActionLabel = (status: string) => {
    switch (status) {
      case "FAILED":
        return "Retry"
      case "RECEIVED":
        return "Process Now"
      default:
        return "Replay"
    }
  }

  const formatJson = (value: unknown) => formatRedactedJson(value)

  const shortId = (value: string | null | undefined) =>
    value ? (value.length > 12 ? `${value.slice(0, 12)}...` : value) : "-"

  const usageToneClass = (status: XeroUsageSummary["today"]["budgetStatus"] | undefined) => {
    switch (status) {
      case "warning":
        return "bg-amber-500"
      case "critical":
        return "bg-orange-600"
      case "exhausted":
        return "bg-red-600"
      default:
        return "bg-green-600"
    }
  }

  const healthBudgetToneClass = (status: XeroHealthSnapshot["apiBudget"]["status"]) => {
    if (status === "unknown") {
      return "bg-slate-600"
    }
    return usageToneClass(status)
  }

  const setSectionState = useCallback((section: SectionKey, nextOpen: boolean) => {
    setSectionOpen((prev) => ({ ...prev, [section]: nextOpen }))
  }, [])

  if (loading) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold mb-4">Xero Integration</h1>
        <p className="text-muted-foreground">Loading...</p>
      </div>
    )
  }

  return (
    <div className="max-w-6xl p-6">
      <h1 className="mb-2 text-2xl font-bold">Xero Integration</h1>
      <p className="mb-6 text-muted-foreground">
        Connect to Xero for automatic invoice creation, membership verification, and contact sync.
      </p>

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
          <button onClick={() => setError("")} className="ml-2 underline">
            Dismiss
          </button>
        </div>
      )}

      {operationMessage && (
        <div className="mb-4 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-700">
          {operationMessage}
          <button onClick={() => setOperationMessage("")} className="ml-2 underline">
            Dismiss
          </button>
        </div>
      )}

      {connectSuccess && (
        <div className="mb-4 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-700">
          Xero connected successfully!
          <button onClick={() => setConnectSuccess(false)} className="ml-2 underline">
            Dismiss
          </button>
        </div>
      )}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            Connection Status
            {status?.connected ? (
              <Badge variant="default" className="bg-green-600">
                Connected
              </Badge>
            ) : (
              <Badge variant="secondary">Not Connected</Badge>
            )}
          </CardTitle>
          <CardDescription>
            {status?.connected
              ? "Xero is connected and ready for syncing."
              : "Connect your Xero organisation to enable accounting integration."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {status?.connected ? (
            <div className="space-y-3">
              <div className="text-sm">
                <span className="text-muted-foreground">Tenant ID:</span>{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">{status.tenantId}</code>
              </div>
              {status.tokenExpiresAt && (
                <div className="text-sm">
                  <span className="text-muted-foreground">Token expires:</span>{" "}
                  {new Date(status.tokenExpiresAt).toLocaleString("en-NZ")}
                  <span className="ml-1 text-muted-foreground">(auto-refreshes)</span>
                </div>
              )}
              <Button variant="destructive" size="sm" onClick={handleDisconnect}>
                Disconnect Xero
              </Button>
            </div>
          ) : (
            <Button onClick={handleConnect}>Connect Xero</Button>
          )}
        </CardContent>
      </Card>

      {status?.connected && (
        <>
          <SectionCard
            id="xero-section-health"
            title="Health Snapshot"
            description="Quick checks for link coverage, stuck work, missing invoices, and daily Xero budget pressure."
            open={sectionOpen.health}
            onToggle={(nextOpen) => setSectionState("health", nextOpen)}
            actions={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void Promise.all([fetchHealth(), fetchUsage()])
                }}
                disabled={loadingHealth}
              >
                {loadingHealth ? "Refreshing..." : "Refresh Health"}
              </Button>
            }
          >
            {loadingHealth && !healthSnapshot ? (
              <p className="text-sm text-muted-foreground">Loading health snapshot...</p>
            ) : healthSnapshot ? (
              <div className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                  <HealthStatCard
                    label="Unlinked members"
                    value={healthSnapshot.unlinkedMembers.count}
                    subtitle="Active members without a Xero contact link."
                    href={healthSnapshot.unlinkedMembers.href}
                  />
                  <HealthStatCard
                    label="Active failed issues"
                    value={healthSnapshot.failedOperations.count}
                    subtitle={
                      healthSnapshot.failedOperations.legacyCount > 0
                        ? `Replayable failures that still need action. ${healthSnapshot.failedOperations.legacyCount} older failed row${healthSnapshot.failedOperations.legacyCount === 1 ? "" : "s"} are already repaired or superseded.`
                        : "Replayable failures that still need action."
                    }
                    badge={
                      <Badge className={healthSnapshot.failedOperations.count > 0 ? "bg-red-600" : "bg-green-600"}>
                        {healthSnapshot.failedOperations.count > 0 ? "Needs attention" : "Clear"}
                      </Badge>
                    }
                    onClick={() => scrollToSection("operations")}
                  />
                  <HealthStatCard
                    label="Pending operations"
                    value={healthSnapshot.pendingOperations.count}
                    subtitle="Queued or running work that has not completed yet."
                    badge={
                      <Badge className={healthSnapshot.pendingOperations.count > 0 ? "bg-slate-600" : "bg-green-600"}>
                        {healthSnapshot.pendingOperations.count > 0 ? "In flight" : "Idle"}
                      </Badge>
                    }
                    onClick={() => scrollToSection("operations")}
                  />
                  <HealthStatCard
                    label="Last membership refresh"
                    value={
                      <span className="text-base font-semibold">
                        {healthSnapshot.lastMembershipRefresh.at
                          ? new Date(healthSnapshot.lastMembershipRefresh.at).toLocaleString("en-NZ")
                          : "Never"}
                      </span>
                    }
                    subtitle={
                      healthSnapshot.lastMembershipRefresh.lastCronStatus
                        ? `Last cron status: ${healthSnapshot.lastMembershipRefresh.lastCronStatus}`
                        : "No cron run recorded yet."
                    }
                    onClick={() => scrollToSection("membershipSync")}
                  />
                  <HealthStatCard
                    label="Group mismatches"
                    value={healthSnapshot.contactGroupMismatches.count}
                    subtitle={
                      healthSnapshot.contactGroupMismatches.cacheReady
                        ? "Linked members whose managed Xero group does not match their current age tier."
                        : "Refresh Xero contact groups before mismatch checks can run."
                    }
                    badge={
                      <Badge
                        className={
                          !healthSnapshot.contactGroupMismatches.cacheReady
                            ? "bg-slate-600"
                            : healthSnapshot.contactGroupMismatches.count > 0
                              ? "bg-amber-500"
                              : "bg-green-600"
                        }
                      >
                        {!healthSnapshot.contactGroupMismatches.cacheReady
                          ? "Cache needed"
                          : healthSnapshot.contactGroupMismatches.count > 0
                            ? "Review"
                            : "Clear"}
                      </Badge>
                    }
                    onClick={() => scrollToSection("contactGroupMismatches")}
                  />
                  <HealthStatCard
                    label="Link mismatches"
                    value={healthSnapshot.contactLinkMismatches.count}
                    subtitle={
                      healthSnapshot.contactLinkMismatches.cacheReady
                        ? "Linked members whose local name does not match the cached Xero contact name."
                        : "Run contact sync before name mismatch checks can run."
                    }
                    badge={
                      <Badge
                        className={
                          !healthSnapshot.contactLinkMismatches.cacheReady
                            ? "bg-slate-600"
                            : healthSnapshot.contactLinkMismatches.count > 0
                              ? "bg-amber-500"
                              : "bg-green-600"
                        }
                      >
                        {!healthSnapshot.contactLinkMismatches.cacheReady
                          ? "Cache needed"
                          : healthSnapshot.contactLinkMismatches.count > 0
                            ? "Review"
                            : "Clear"}
                      </Badge>
                    }
                    onClick={() => scrollToSection("contactLinkMismatches")}
                  />
                  <HealthStatCard
                    label="API budget"
                    value={
                      healthSnapshot.apiBudget.usagePercent != null
                        ? `${Math.round(healthSnapshot.apiBudget.usagePercent * 100)}%`
                        : "Unknown"
                    }
                    subtitle={
                      healthSnapshot.apiBudget.totalCalls != null
                        ? `${healthSnapshot.apiBudget.totalCalls} calls today, ${healthSnapshot.apiBudget.failedCalls ?? 0} failed`
                        : "Usage snapshot not available yet."
                    }
                    badge={<Badge className={healthBudgetToneClass(healthSnapshot.apiBudget.status)}>{healthSnapshot.apiBudget.status}</Badge>}
                    onClick={() => scrollToSection("usage")}
                  />
                </div>

                <div className="rounded-lg border p-4">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold">Missing invoice detector</h3>
                        <Badge className={healthSnapshot.missingInvoices.count > 0 ? "bg-amber-500" : "bg-green-600"}>
                          {healthSnapshot.missingInvoices.count}
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        Bookings with a payment but no successful Xero invoice sync on record.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" size="sm" onClick={handleToggleMissingInvoices}>
                        {showMissingInvoices ? "Hide Details" : "Show Details"}
                      </Button>
                      <Button
                        size="sm"
                        onClick={handleTriggerMissingInvoices}
                        disabled={triggeringMissingInvoices || healthSnapshot.missingInvoices.count === 0}
                      >
                        {triggeringMissingInvoices ? "Queueing..." : "Trigger All Missing"}
                      </Button>
                    </div>
                  </div>

                  {showMissingInvoices ? (
                    <div className="mt-4 border-t pt-4">
                      {loadingMissingInvoices && !missingInvoiceDetails ? (
                        <p className="text-sm text-muted-foreground">Loading missing invoice details...</p>
                      ) : missingInvoiceDetails ? (
                        missingInvoiceDetails.count === 0 ? (
                          <p className="text-sm text-green-700">No paid or confirmed bookings are currently missing a Xero invoice.</p>
                        ) : (
                          <div className="space-y-3">
                            <p className="text-sm text-muted-foreground">
                              Showing {missingInvoiceDetails.bookings.length} of {missingInvoiceDetails.count} booking{missingInvoiceDetails.count !== 1 ? "s" : ""}.
                            </p>
                            {missingInvoiceDetails.bookings.map((booking) => (
                              <div key={booking.bookingId} className="rounded-md border p-3">
                                <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                                  <div className="space-y-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <a
                                        href={buildHrefWithReturnTo(`/bookings/${booking.bookingId}`, currentXeroPath)}
                                        className="text-sm font-medium text-blue-600 hover:underline"
                                      >
                                        Booking {shortId(booking.bookingId)}
                                      </a>
                                      <Badge variant="outline">{booking.status}</Badge>
                                    </div>
                                    <p className="text-sm">
                                      <a
                                        href={buildHrefWithReturnTo(`/admin/members/${booking.memberId}`, currentXeroPath)}
                                        className="text-blue-600 hover:underline"
                                      >
                                        {booking.memberName}
                                      </a>
                                      <span className="ml-2 text-muted-foreground">{booking.memberEmail}</span>
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                      {new Date(booking.checkIn).toLocaleDateString("en-NZ")} to{" "}
                                      {new Date(booking.checkOut).toLocaleDateString("en-NZ")} • Payment {shortId(booking.paymentId)}
                                    </p>
                                  </div>
                                  <p className="text-xs text-muted-foreground">
                                    Created {new Date(booking.createdAt).toLocaleString("en-NZ")}
                                  </p>
                                </div>
                              </div>
                            ))}
                          </div>
                        )
                      ) : (
                        <p className="text-sm text-muted-foreground">No missing invoice details loaded yet.</p>
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No health data recorded yet.</p>
            )}
          </SectionCard>

          <SectionCard
            id="xero-section-contactGroupMismatches"
            title="Contact Group Mismatches"
            description="Audit linked members against the managed Xero contact-group mapping configured in Age Group Settings."
            open={sectionOpen.contactGroupMismatches}
            onToggle={(nextOpen) => setSectionState("contactGroupMismatches", nextOpen)}
            actions={
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchContactGroupMismatches()}
                disabled={loadingContactGroupMismatches}
              >
                {loadingContactGroupMismatches ? "Refreshing..." : "Refresh"}
              </Button>
            }
          >
            {loadingContactGroupMismatches && !contactGroupMismatches ? (
              <p className="text-sm text-muted-foreground">Loading contact group mismatches...</p>
            ) : contactGroupMismatches ? (
              <div className="space-y-4">
                <div className="flex flex-col gap-3 rounded-lg border p-4 md:flex-row md:items-start md:justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold">Managed mapping status</h3>
                      <Badge
                        className={
                          !contactGroupMismatches.cacheReady
                            ? "bg-slate-600"
                            : contactGroupMismatches.count > 0
                              ? "bg-amber-500"
                              : "bg-green-600"
                        }
                      >
                        {!contactGroupMismatches.cacheReady
                          ? "Cache needed"
                          : `${contactGroupMismatches.count} mismatch${contactGroupMismatches.count === 1 ? "" : "es"}`}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {contactGroupMismatches.configuredMappings.length > 0
                        ? `Configured mappings: ${Array.from(
                            contactGroupMismatches.configuredMappings.reduce(
                              (groups, mapping) => {
                                const existing = groups.get(mapping.tier) ?? []
                                existing.push(
                                  `${mapping.groupName ?? mapping.groupId}${mapping.isDefault ? " (default)" : ""}`
                                )
                                groups.set(mapping.tier, existing)
                                return groups
                              },
                              new Map<AgeTier, string[]>()
                            )
                          )
                            .map(([tier, groups]) => `${tier} → ${groups.join(", ")}`)
                            .join("; ")}`
                        : "No age-tier to Xero contact-group mappings are configured yet."}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {contactGroupMismatches.cacheReady && contactGroupMismatches.lastRefreshedAt
                        ? `Cache last refreshed ${new Date(contactGroupMismatches.lastRefreshedAt).toLocaleString("en-NZ")}.`
                        : "The shared Xero contact-group cache has not been refreshed yet."}
                    </p>
                  </div>
                  <a
                    href="/admin/age-tier-settings"
                    className="text-sm text-blue-600 hover:underline"
                  >
                    Open Age Group Settings
                  </a>
                </div>

                {!contactGroupMismatches.cacheReady ? (
                  <p className="text-sm text-muted-foreground">
                    Refresh Xero contact groups before relying on this audit.
                  </p>
                ) : contactGroupMismatches.mismatches.length === 0 ? (
                  <p className="text-sm text-green-700">
                    No linked members are currently mismatched against the managed age-tier mappings.
                  </p>
                ) : (
                  <div className="space-y-3">
                    <p className="text-sm text-muted-foreground">
                      Showing {contactGroupMismatches.mismatches.length} of {contactGroupMismatches.count} mismatch{contactGroupMismatches.count === 1 ? "" : "es"}.
                    </p>
                    {contactGroupMismatches.mismatches.map((mismatch) => (
                      <div key={mismatch.memberId} className="rounded-md border p-3">
                        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                          <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <a
                                href={buildHrefWithReturnTo(`/admin/members/${mismatch.memberId}`, currentXeroPath)}
                                className="text-sm font-medium text-blue-600 hover:underline"
                              >
                                {mismatch.memberName}
                              </a>
                              <Badge variant="outline">{mismatch.ageTier}</Badge>
                              {mismatch.missingExpectedGroup ? (
                                <Badge className="bg-red-600">Missing accepted group</Badge>
                              ) : null}
                              {mismatch.unexpectedManagedGroups.length > 0 ? (
                                <Badge className="bg-amber-500">
                                  {mismatch.unexpectedManagedGroups.length} extra managed group{mismatch.unexpectedManagedGroups.length === 1 ? "" : "s"}
                                </Badge>
                              ) : null}
                            </div>
                            <p className="text-sm text-muted-foreground">{mismatch.memberEmail}</p>
                            <p className="text-xs text-muted-foreground">
                              Accepted managed groups:{" "}
                              {mismatch.acceptedGroups
                                .map((group) =>
                                  `${group.name ?? group.id}${group.isDefault ? " (default)" : ""}`
                                )
                                .join(", ")}
                            </p>
                            {mismatch.defaultGroup ? (
                              <p className="text-xs text-muted-foreground">
                                Default write group: {mismatch.defaultGroup.name ?? mismatch.defaultGroup.id}
                              </p>
                            ) : null}
                            <p className="text-xs text-muted-foreground">
                              Actual cached groups:{" "}
                              {mismatch.actualGroups.length > 0
                                ? mismatch.actualGroups.map((group) => group.name).join(", ")
                                : "None"}
                            </p>
                            {mismatch.unexpectedManagedGroups.length > 0 ? (
                              <p className="text-xs text-amber-700">
                                Unexpected managed groups:{" "}
                                {mismatch.unexpectedManagedGroups
                                  .map((group) =>
                                    group.tier ? `${group.name} (${group.tier})` : group.name
                                  )
                                  .join(", ")}
                              </p>
                            ) : null}
                          </div>
                          <a
                            href={`https://go.xero.com/app/contacts/contact/${mismatch.xeroContactId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm text-blue-600 hover:underline"
                          >
                            Open in Xero
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No mismatch audit has been loaded yet.</p>
            )}
          </SectionCard>

          <SectionCard
            id="xero-section-contactLinkMismatches"
            title="Contact Link Mismatches"
            description="Audit linked members whose local name differs from the cached Xero contact name."
            open={sectionOpen.contactLinkMismatches}
            onToggle={(nextOpen) => setSectionState("contactLinkMismatches", nextOpen)}
            actions={
              <Button
                variant="outline"
                size="sm"
                onClick={() => void fetchContactLinkMismatches()}
                disabled={loadingContactLinkMismatches}
              >
                {loadingContactLinkMismatches ? "Refreshing..." : "Refresh"}
              </Button>
            }
          >
            {loadingContactLinkMismatches && !contactLinkMismatches ? (
              <p className="text-sm text-muted-foreground">Loading contact link mismatches...</p>
            ) : contactLinkMismatches ? (
              <div className="space-y-4">
                <div className="flex flex-col gap-3 rounded-lg border p-4 md:flex-row md:items-start md:justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold">Member/contact name audit</h3>
                      <Badge
                        className={
                          !contactLinkMismatches.cacheReady
                            ? "bg-slate-600"
                            : contactLinkMismatches.count > 0
                              ? "bg-amber-500"
                              : "bg-green-600"
                        }
                      >
                        {!contactLinkMismatches.cacheReady
                          ? "Cache needed"
                          : `${contactLinkMismatches.count} mismatch${contactLinkMismatches.count === 1 ? "" : "es"}`}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Compares linked members against the cached Xero contact snapshot. Use this to unlink bad email-based matches, then relink the correct contact from the member record.
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {contactLinkMismatches.cacheReady && contactLinkMismatches.lastRefreshedAt
                        ? `Contact cache last refreshed ${new Date(contactLinkMismatches.lastRefreshedAt).toLocaleString("en-NZ")}.`
                        : "The shared Xero contact cache has not been refreshed yet."}
                    </p>
                  </div>
                </div>

                {!contactLinkMismatches.cacheReady ? (
                  <p className="text-sm text-muted-foreground">
                    Run contact sync before relying on this audit.
                  </p>
                ) : contactLinkMismatches.mismatches.length === 0 ? (
                  <p className="text-sm text-green-700">
                    No linked members are currently mismatched against the cached Xero contact names.
                  </p>
                ) : (
                  <div className="space-y-3">
                    <p className="text-sm text-muted-foreground">
                      Showing {contactLinkMismatches.mismatches.length} of {contactLinkMismatches.count} mismatch{contactLinkMismatches.count === 1 ? "" : "es"}.
                    </p>
                    {contactLinkMismatches.mismatches.map((mismatch) => (
                      <div key={mismatch.memberId} className="rounded-md border p-3">
                        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                          <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <a
                                href={buildHrefWithReturnTo(`/admin/members/${mismatch.memberId}`, currentXeroPath)}
                                className="text-sm font-medium text-blue-600 hover:underline"
                              >
                                {mismatch.memberName}
                              </a>
                              <Badge variant={mismatch.active ? "default" : "secondary"} className={mismatch.active ? "bg-green-600" : ""}>
                                {mismatch.active ? "Active" : "Inactive"}
                              </Badge>
                            </div>
                            <p className="text-sm text-muted-foreground">{mismatch.memberEmail}</p>
                            <p className="text-xs text-muted-foreground">
                              Cached Xero contact: {mismatch.xeroContactName}
                              {mismatch.xeroContactEmail ? ` (${mismatch.xeroContactEmail})` : ""}
                            </p>
                            <p className="text-xs text-amber-700">
                              {mismatch.reasons.join(", ")}
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <a
                              href={buildHrefWithReturnTo(`/admin/members/${mismatch.memberId}`, currentXeroPath)}
                              className="inline-flex"
                            >
                              <Button variant="outline" size="sm">Open Member</Button>
                            </a>
                            <a
                              href={`https://go.xero.com/app/contacts/contact/${mismatch.xeroContactId}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex"
                            >
                              <Button variant="outline" size="sm">Open in Xero</Button>
                            </a>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleUnlinkContactMismatch(mismatch.memberId)}
                              disabled={unlinkingMismatchMemberId === mismatch.memberId}
                            >
                              {unlinkingMismatchMemberId === mismatch.memberId ? "Unlinking..." : "Unlink"}
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No contact link mismatch audit has been loaded yet.</p>
            )}
          </SectionCard>

          <SectionCard
            id="xero-section-operations"
            title="Xero Operations"
            description="Recent outbound sync attempts and replayable failures."
            open={sectionOpen.operations}
            onToggle={(nextOpen) => setSectionState("operations", nextOpen)}
            actions={
              <>
                <Button
                  size="sm"
                  onClick={handleRetryAllFailed}
                  disabled={retryingAllFailed || (healthSnapshot?.failedOperations.count ?? 0) === 0}
                >
                  {retryingAllFailed ? "Queueing..." : "Retry Active Failed"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fetchOperations(operationStatusFilter, operationEntityFilter)}
                  disabled={loadingOperations}
                >
                  {loadingOperations ? "Refreshing..." : "Refresh"}
                </Button>
              </>
            }
          >
            <div className="space-y-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-center">
                <div className="w-full md:w-48">
                  <Label className="mb-1 block text-xs text-muted-foreground">Status</Label>
                  <Select value={operationStatusFilter} onValueChange={setOperationStatusFilter}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All statuses</SelectItem>
                      <SelectItem value="FAILED">Failed</SelectItem>
                      <SelectItem value="PENDING">Pending</SelectItem>
                      <SelectItem value="PARTIAL">Partial</SelectItem>
                      <SelectItem value="RUNNING">Running</SelectItem>
                      <SelectItem value="SUCCEEDED">Succeeded</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="w-full md:w-48">
                  <Label className="mb-1 block text-xs text-muted-foreground">Entity</Label>
                  <Select value={operationEntityFilter} onValueChange={setOperationEntityFilter}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All entities</SelectItem>
                      <SelectItem value="CONTACT">Contact</SelectItem>
                      <SelectItem value="CONTACT_GROUP">Contact Group</SelectItem>
                      <SelectItem value="INVOICE">Invoice</SelectItem>
                      <SelectItem value="PAYMENT">Payment</SelectItem>
                      <SelectItem value="CREDIT_NOTE">Credit Note</SelectItem>
                      <SelectItem value="ALLOCATION">Allocation</SelectItem>
                      <SelectItem value="SUBSCRIPTION">Subscription</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {loadingOperations ? (
                <p className="text-sm text-muted-foreground">Loading recent operations...</p>
              ) : operations.length === 0 ? (
                <p className="text-sm text-muted-foreground">No Xero operations recorded yet.</p>
              ) : (
                <div className="space-y-3">
                  {operations.map((operation) => (
                    <div key={operation.id} className="space-y-2 rounded-md border p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="default" className={operationStatusClass(operation.status)}>
                          {operation.status}
                        </Badge>
                        {operation.failureState ? (
                          <Badge variant="default" className={failureStateBadgeClass(operation.failureState)}>
                            {failureStateLabel(operation.failureState)}
                          </Badge>
                        ) : null}
                        <span className="text-sm font-medium">
                          {operation.entityType} {operation.operationType}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(operation.createdAt).toLocaleString("en-NZ")}
                        </span>
                      </div>

                      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                        <span>Direction: {operation.direction}</span>
                        <span>Attempt: {operation.attemptCount}</span>
                        {operation.localModel && (
                          <span>
                            Local:{" "}
                            {operation.localUrl ? (
                              <a href={operation.localUrl} className="text-blue-600 hover:underline">
                                {operation.localModel} {shortId(operation.localId)}
                              </a>
                            ) : (
                              `${operation.localModel} ${shortId(operation.localId)}`
                            )}
                          </span>
                        )}
                        {operation.xeroObjectId && (
                          <span>
                            Xero:{" "}
                            {operation.xeroObjectUrl ? (
                              <a
                                href={operation.xeroObjectUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 hover:underline"
                              >
                                {operation.xeroObjectNumber || shortId(operation.xeroObjectId)}
                              </a>
                            ) : (
                              operation.xeroObjectNumber || shortId(operation.xeroObjectId)
                            )}
                          </span>
                        )}
                      </div>

                      {operation.lastErrorMessage && (
                        <p className="text-sm text-red-700">
                          {operation.lastErrorCode ? `${operation.lastErrorCode}: ` : ""}
                          {redactSensitiveText(operation.lastErrorMessage)}
                        </p>
                      )}

                      {operation.failureStateReason && operation.status === "FAILED" ? (
                        <p className="text-xs text-muted-foreground">{operation.failureStateReason}</p>
                      ) : null}

                      <div className="flex flex-wrap items-center gap-2">
                        {operation.supported && operation.failureState !== "REPAIRED" && operation.failureState !== "SUPERSEDED" ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleRetryOperation(operation.id)}
                            disabled={retryingOperationId === operation.id}
                          >
                            {retryingOperationId === operation.id ? "Queueing..." : "Retry in background"}
                          </Button>
                        ) : operation.reason && (operation.status === "FAILED" || operation.status === "PARTIAL") ? (
                          <p className="text-xs text-muted-foreground">{operation.reason}</p>
                        ) : null}
                      </div>

                      <details className="rounded-md bg-slate-50 p-2">
                        <summary className="cursor-pointer text-xs font-medium text-slate-700">
                          View request / response payloads
                        </summary>
                        <div className="mt-2 grid gap-3 lg:grid-cols-2">
                          <div>
                            <p className="mb-1 text-xs font-medium text-slate-700">Request</p>
                            <pre className="max-h-64 overflow-auto rounded border bg-white p-2 text-[11px]">
                              {formatJson(operation.requestPayload)}
                            </pre>
                          </div>
                          <div>
                            <p className="mb-1 text-xs font-medium text-slate-700">Response</p>
                            <pre className="max-h-64 overflow-auto rounded border bg-white p-2 text-[11px]">
                              {formatJson(operation.responsePayload)}
                            </pre>
                          </div>
                        </div>
                      </details>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </SectionCard>

          <SectionCard
            id="xero-section-inbound"
            title="Inbound Events"
            description="Stored webhook events and their reconciliation state."
            open={sectionOpen.inbound}
            onToggle={(nextOpen) => setSectionState("inbound", nextOpen)}
            actions={
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchInboundEvents(inboundEventStatusFilter, inboundEventCategoryFilter)}
                disabled={loadingInboundEvents}
              >
                {loadingInboundEvents ? "Refreshing..." : "Refresh"}
              </Button>
            }
          >
            <div className="space-y-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-center">
                <div className="w-full md:w-48">
                  <Label className="mb-1 block text-xs text-muted-foreground">Status</Label>
                  <Select value={inboundEventStatusFilter} onValueChange={setInboundEventStatusFilter}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All statuses</SelectItem>
                      <SelectItem value="FAILED">Failed</SelectItem>
                      <SelectItem value="RECEIVED">Received</SelectItem>
                      <SelectItem value="PROCESSING">Processing</SelectItem>
                      <SelectItem value="PROCESSED">Processed</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="w-full md:w-48">
                  <Label className="mb-1 block text-xs text-muted-foreground">Category</Label>
                  <Select value={inboundEventCategoryFilter} onValueChange={setInboundEventCategoryFilter}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All categories</SelectItem>
                      <SelectItem value="CONTACT">Contact</SelectItem>
                      <SelectItem value="INVOICE">Invoice</SelectItem>
                      <SelectItem value="PAYMENT">Payment</SelectItem>
                      <SelectItem value="CREDIT_NOTE">Credit Note</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {loadingInboundEvents ? (
                <p className="text-sm text-muted-foreground">Loading stored inbound events...</p>
              ) : inboundEvents.length === 0 ? (
                <p className="text-sm text-muted-foreground">No stored inbound events found.</p>
              ) : (
                <div className="space-y-3">
                  {inboundEvents.map((event) => (
                    <div key={event.id} className="space-y-2 rounded-md border p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="default" className={operationStatusClass(event.status)}>
                          {event.status}
                        </Badge>
                        <span className="text-sm font-medium">
                          {event.eventCategory ?? "UNKNOWN"} {event.eventType}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(event.createdAt).toLocaleString("en-NZ")}
                        </span>
                      </div>

                      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                        <span>Source: {event.source}</span>
                        <span>
                          Correlation: <code>{shortId(event.correlationKey)}</code>
                        </span>
                        {event.resourceId && (
                          <span>
                            Resource:{" "}
                            {event.xeroObjectUrl ? (
                              <a
                                href={event.xeroObjectUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 hover:underline"
                              >
                                {shortId(event.resourceId)}
                              </a>
                            ) : (
                              shortId(event.resourceId)
                            )}
                          </span>
                        )}
                        {event.processedAt && (
                          <span>Processed: {new Date(event.processedAt).toLocaleString("en-NZ")}</span>
                        )}
                      </div>

                      {event.errorMessage && <p className="text-sm text-red-700">{event.errorMessage}</p>}

                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleReplayInboundEvent(event.id)}
                          disabled={!event.canReplay || replayingInboundEventId === event.id}
                        >
                          {replayingInboundEventId === event.id ? "Replaying..." : inboundEventActionLabel(event.status)}
                        </Button>
                        {!event.canReplay && (
                          <p className="text-xs text-muted-foreground">This event is currently being processed.</p>
                        )}
                      </div>

                      <details className="rounded-md bg-slate-50 p-2">
                        <summary className="cursor-pointer text-xs font-medium text-slate-700">
                          View stored payload
                        </summary>
                        <div className="mt-2">
                          <pre className="max-h-64 overflow-auto rounded border bg-white p-2 text-[11px]">
                            {formatJson(event.payload)}
                          </pre>
                        </div>
                      </details>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </SectionCard>

          <SectionCard
            id="xero-section-contactSync"
            title="Contact Sync"
            description="Run a broad link pass, or repair a single record with a targeted force sync."
            open={sectionOpen.contactSync}
            onToggle={(nextOpen) => setSectionState("contactSync", nextOpen)}
            actions={
              <Button onClick={handleSyncContacts} disabled={syncing !== null}>
                {syncing === "contacts" ? "Syncing..." : "Sync Contacts from Xero"}
              </Button>
            }
          >
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Link existing Tokoroa Alpine Club members to their Xero contacts by email address, or push a single member or booking without running a full sweep.
              </p>

              <div className="rounded-lg border p-4">
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold">Targeted force sync</h3>
                  <p className="text-sm text-muted-foreground">
                    Use this when one record is out of sync and you do not want to run the full admin workflow.
                  </p>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-[180px_minmax(0,1fr)_auto] md:items-end">
                  <div className="space-y-1">
                    <Label>Sync target</Label>
                    <Select value={forceSyncType} onValueChange={(value) => handleForceSyncTypeChange(value as "CONTACT" | "INVOICE" | "MEMBERSHIP")}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="CONTACT">Member contact</SelectItem>
                        <SelectItem value="INVOICE">Booking invoice</SelectItem>
                        <SelectItem value="MEMBERSHIP">Membership status</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1">
                    <Label>{forceSyncType === "INVOICE" ? "Booking" : "Member"}</Label>
                    {forceSyncType === "INVOICE" ? (
                      selectedForceSyncBooking ? (
                        <div className="rounded-md border bg-slate-50 px-3 py-2">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-slate-900">
                                {selectedForceSyncBooking.memberName}
                              </p>
                              <p className="truncate text-xs text-slate-500">
                                {selectedForceSyncBooking.memberEmail}
                              </p>
                              <p className="text-xs text-slate-500">
                                Booking ID: {selectedForceSyncBooking.id}
                                {" • "}
                                {selectedForceSyncBooking.checkIn} to {selectedForceSyncBooking.checkOut}
                                {" • "}
                                {selectedForceSyncBooking.guestCount} guest{selectedForceSyncBooking.guestCount === 1 ? "" : "s"}
                                {" • "}
                                {selectedForceSyncBooking.status}
                              </p>
                              <p
                                className={`text-xs ${
                                  selectedForceSyncBooking.canForceSyncInvoice
                                    ? "text-emerald-700"
                                    : "text-amber-700"
                                }`}
                              >
                                {selectedForceSyncBooking.canForceSyncInvoice
                                  ? "Ready to queue invoice sync."
                                  : selectedForceSyncBooking.forceSyncInvoiceReason}
                              </p>
                              {selectedForceSyncBooking.xeroInvoiceId ? (
                                <p className="text-xs text-slate-500">
                                  Xero invoice: {selectedForceSyncBooking.xeroInvoiceId}
                                </p>
                              ) : null}
                            </div>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setError("")
                                setSelectedForceSyncBooking(null)
                                setForceSyncBookingSearch("")
                                setForceSyncBookingResults([])
                              }}
                            >
                              Change
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="relative">
                          <Input
                            value={forceSyncBookingSearch}
                            onChange={(event) => {
                              setError("")
                              setForceSyncBookingSearch(event.target.value)
                            }}
                            placeholder="Search by booking reference, ID, member name, or email"
                          />
                          {forceSyncBookingSearching ? (
                            <div className="absolute right-3 top-2.5 text-xs text-slate-400">
                              Searching...
                            </div>
                          ) : null}
                          {forceSyncBookingResults.length > 0 ? (
                            <div className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-md border bg-white shadow-lg">
                              {forceSyncBookingResults.map((booking) => (
                                <button
                                  key={booking.id}
                                  type="button"
                                  onClick={() => {
                                    setError("")
                                    setSelectedForceSyncBooking(booking)
                                    setForceSyncBookingSearch("")
                                    setForceSyncBookingResults([])
                                  }}
                                  className="w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
                                >
                                  <div className="font-medium text-slate-900">
                                    {booking.memberName}
                                  </div>
                                  <div className="truncate text-xs text-slate-500">
                                    {booking.memberEmail}
                                  </div>
                                  <div className="text-xs text-slate-500">
                                    {booking.id}
                                    {" • "}
                                    {booking.checkIn} to {booking.checkOut}
                                    {" • "}
                                    {booking.guestCount} guest{booking.guestCount === 1 ? "" : "s"}
                                    {" • "}
                                    {booking.status}
                                  </div>
                                  {booking.forceSyncInvoiceReason ? (
                                    <div className="text-xs text-amber-700">
                                      {booking.forceSyncInvoiceReason}
                                    </div>
                                  ) : (
                                    <div className="text-xs text-emerald-700">
                                      Ready to queue invoice sync.
                                    </div>
                                  )}
                                </button>
                              ))}
                            </div>
                          ) : null}
                          {forceSyncBookingSearch.trim().length >= 2 && !forceSyncBookingSearching && forceSyncBookingResults.length === 0 ? (
                            <p className="mt-1 text-xs text-slate-500">
                              No matching bookings found yet.
                            </p>
                          ) : null}
                        </div>
                      )
                    ) : selectedForceSyncMember ? (
                      <div className="rounded-md border bg-slate-50 px-3 py-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-slate-900">
                              {selectedForceSyncMember.firstName} {selectedForceSyncMember.lastName}
                            </p>
                            <p className="truncate text-xs text-slate-500">
                              {selectedForceSyncMember.email}
                            </p>
                            <p className="text-xs text-slate-500">
                              Member ID: {selectedForceSyncMember.id}
                              {selectedForceSyncMember.xeroContactId ? " • already linked to Xero" : " • not yet linked to Xero"}
                              {!selectedForceSyncMember.active ? " • inactive" : ""}
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setError("")
                              setSelectedForceSyncMember(null)
                              setForceSyncMemberSearch("")
                              setForceSyncMemberResults([])
                              setForceSyncXeroContactResults([])
                            }}
                          >
                            Change
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="relative">
                        <Input
                          value={forceSyncMemberSearch}
                          onChange={(event) => {
                            setError("")
                            setForceSyncMemberSearch(event.target.value)
                          }}
                          placeholder={
                            forceSyncType === "CONTACT"
                              ? "Search TACBookings members and Xero contacts by name or email"
                              : "Search by member name, email, or member ID"
                          }
                        />
                        {forceSyncMemberSearching || forceSyncXeroContactSearching ? (
                          <div className="absolute right-3 top-2.5 text-xs text-slate-400">
                            Searching...
                          </div>
                        ) : null}
                        {forceSyncMemberResults.length > 0 || forceSyncXeroContactResults.length > 0 ? (
                          <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-md border bg-white shadow-lg">
                            {forceSyncMemberResults.length > 0 ? (
                              <div className={forceSyncXeroContactResults.length > 0 ? "border-b" : ""}>
                                {forceSyncType === "CONTACT" && forceSyncXeroContactResults.length > 0 ? (
                                  <div className="px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
                                    TACBookings members
                                  </div>
                                ) : null}
                                {forceSyncMemberResults.map((member) => (
                                  <button
                                    key={member.id}
                                    type="button"
                                    onClick={() => {
                                      setError("")
                                      setSelectedForceSyncMember(member)
                                      setForceSyncMemberSearch("")
                                      setForceSyncMemberResults([])
                                      setForceSyncXeroContactResults([])
                                    }}
                                    className="w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
                                  >
                                    <div className="font-medium text-slate-900">
                                      {member.firstName} {member.lastName}
                                    </div>
                                    <div className="truncate text-xs text-slate-500">
                                      {member.email}
                                    </div>
                                    <div className="text-xs text-slate-500">
                                      ID {member.id}
                                      {member.xeroContactId ? " • linked" : " • unlinked"}
                                      {!member.active ? " • inactive" : ""}
                                    </div>
                                  </button>
                                ))}
                              </div>
                            ) : null}
                            {forceSyncType === "CONTACT" && forceSyncXeroContactResults.length > 0 ? (
                              <div>
                                <div className="px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
                                  Xero contacts
                                </div>
                                {forceSyncXeroContactResults.map((contact) => (
                                  <div
                                    key={contact.contactId}
                                    className="flex items-start justify-between gap-3 px-3 py-2 text-sm hover:bg-slate-50"
                                  >
                                    <div className="min-w-0">
                                      <div className="font-medium text-slate-900">{contact.name}</div>
                                      <div className="truncate text-xs text-slate-500">
                                        {contact.email || "No email address"}
                                      </div>
                                      <div className={contact.canImportAsMember ? "text-xs text-emerald-700" : "text-xs text-amber-700"}>
                                        {contact.canImportAsMember
                                          ? "Can be imported as a linked TACBookings member."
                                          : contact.importBlockReason || "Cannot be imported from here."}
                                      </div>
                                    </div>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant={contact.canImportAsMember ? "default" : "outline"}
                                      onClick={() => handleImportXeroContactAsMember(contact)}
                                      disabled={
                                        !contact.canImportAsMember ||
                                        importingXeroContactId === contact.contactId ||
                                        syncing !== null
                                      }
                                    >
                                      {importingXeroContactId === contact.contactId ? "Importing..." : "Import"}
                                    </Button>
                                  </div>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                        {forceSyncMemberSearch.trim().length >= 2 &&
                        !forceSyncMemberSearching &&
                        !forceSyncXeroContactSearching &&
                        forceSyncMemberResults.length === 0 &&
                        forceSyncXeroContactResults.length === 0 ? (
                          <p className="mt-1 text-xs text-slate-500">
                            {forceSyncType === "CONTACT"
                              ? "No matching TACBookings members or Xero contacts found yet."
                              : "No matching member records found yet."}
                          </p>
                        ) : null}
                      </div>
                    )}
                  </div>

                  <Button
                    onClick={handleForceSync}
                    disabled={
                      forceSyncing
                      || (forceSyncType === "INVOICE"
                        ? !selectedForceSyncBooking || !selectedForceSyncBooking.canForceSyncInvoice
                        : !selectedForceSyncMember)
                    }
                  >
                    {forceSyncing ? "Running..." : "Run Force Sync"}
                  </Button>
                </div>

                <p className="mt-3 text-xs text-muted-foreground">
                  {forceSyncType === "CONTACT"
                    ? "Search by name or email. Select an existing TACBookings member to force-sync, or import an unlinked Xero contact when that member name does not already exist locally."
                    : forceSyncType === "INVOICE"
                      ? "Search for the booking by ID, member name, or email, then queue invoice creation only when that booking is eligible."
                      : "Search for the member by name or email, then refresh that member’s subscription state from Xero invoices."}
                </p>
              </div>
            </div>
          </SectionCard>

          <SectionCard
            id="xero-section-membershipSync"
            title="Membership Status Refresh"
            description="Check Xero invoices for active members and refresh the current season membership state."
            open={sectionOpen.membershipSync}
            onToggle={(nextOpen) => setSectionState("membershipSync", nextOpen)}
            actions={
              <>
                <Button
                  variant="outline"
                  onClick={() => handleSyncMemberships("backfill")}
                  disabled={syncing !== null}
                >
                  {syncing === "memberships-backfill" ? "Repairing..." : "Run Repair Backfill"}
                </Button>
                <Button
                  onClick={() => handleSyncMemberships("incremental")}
                  disabled={syncing !== null}
                >
                  {syncing === "memberships" ? "Refreshing..." : "Run Incremental Refresh"}
                </Button>
              </>
            }
          >
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                This runs automatically as a daily cron job. Only members already linked to Xero contacts can be refreshed.
              </p>
              <p className="text-sm text-muted-foreground">
                Incremental refresh is the normal low-API-cost path. Repair backfill is manual only and rechecks linked members whose local season status still looks stale.
              </p>
              <div className="rounded-md border bg-slate-50 p-3 text-sm">
                <p>
                  <span className="text-muted-foreground">Last refresh:</span>{" "}
                  {healthSnapshot?.lastMembershipRefresh.at
                    ? new Date(healthSnapshot.lastMembershipRefresh.at).toLocaleString("en-NZ")
                    : "No refresh recorded yet"}
                </p>
                {healthSnapshot?.lastMembershipRefresh.lastCronStartedAt ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Cron started {new Date(healthSnapshot.lastMembershipRefresh.lastCronStartedAt).toLocaleString("en-NZ")}
                    {healthSnapshot.lastMembershipRefresh.lastCronStatus
                      ? ` • ${healthSnapshot.lastMembershipRefresh.lastCronStatus}`
                      : ""}
                  </p>
                ) : null}
              </div>
            </div>
          </SectionCard>

          {syncResult && (
            <Card className="mb-6">
              <CardHeader>
                <CardTitle>Results</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 text-sm">
                  {syncResult.message && <p>{syncResult.message}</p>}

                  {syncResult.created !== undefined && (
                    <>
                      <p>
                        <span className="text-muted-foreground">New members created:</span>{" "}
                        <span className="font-medium text-green-700">{syncResult.created}</span>
                      </p>
                      {syncResult.createdMembers && syncResult.createdMembers.length > 0 && (
                        <ul className="ml-4 mt-1 space-y-0.5 text-sm">
                          {syncResult.createdMembers.map((member, i) => (
                            <li key={`${member.xeroContactId}-${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span>{member.name}</span>
                              <span className="text-xs text-muted-foreground">{member.email}</span>
                              <Badge variant="outline" className="text-xs">{member.group}</Badge>
                              <a
                                href={`https://go.xero.com/Contacts/View/${member.xeroContactId}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-blue-600 hover:underline"
                              >
                                Open in Xero ↗
                              </a>
                            </li>
                          ))}
                        </ul>
                      )}
                      {syncResult.createdAsDependent !== undefined && syncResult.createdAsDependent > 0 && (
                        <div>
                          <p>
                            <span className="text-muted-foreground">Family dependents created:</span>{" "}
                            <span className="font-medium text-blue-700">{syncResult.createdAsDependent}</span>
                          </p>
                          {syncResult.createdDependents && syncResult.createdDependents.length > 0 && (
                            <ul className="ml-4 mt-1 space-y-0.5 text-sm">
                              {syncResult.createdDependents.map((member, i) => (
                                <li key={`${member.xeroContactId}-${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                  <span>{member.name}</span>
                                  <span className="text-xs text-muted-foreground">{member.email}</span>
                                  <Badge variant="outline" className="text-xs">{member.group}</Badge>
                                  <span className="text-xs text-muted-foreground">Linked to {member.parentName}</span>
                                  <a
                                    href={`https://go.xero.com/Contacts/View/${member.xeroContactId}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-xs text-blue-600 hover:underline"
                                  >
                                    Open in Xero ↗
                                  </a>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                      {syncResult.skippedExisting !== undefined && syncResult.skippedExisting > 0 && (
                        <p>
                          <span className="text-muted-foreground">Skipped (already exist):</span>{" "}
                          {syncResult.skippedExisting}
                        </p>
                      )}
                      {syncResult.linkedExisting !== undefined && syncResult.linkedExisting > 0 && (
                        <div>
                          <p>
                            <span className="text-muted-foreground">Existing members linked to Xero:</span>{" "}
                            {syncResult.linkedExisting}
                          </p>
                          {syncResult.linkedExistingDetails && syncResult.linkedExistingDetails.length > 0 && (
                            <ul className="ml-4 mt-1 space-y-0.5 text-sm">
                              {syncResult.linkedExistingDetails.map((member, i) => (
                                <li key={`${member.memberId}-${member.xeroContactId}-${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                  <span>{member.name}</span>
                                  <span className="text-xs text-muted-foreground">{member.email}</span>
                                  <Badge variant="outline" className="text-xs">{member.group}</Badge>
                                  <a
                                    href={`https://go.xero.com/Contacts/View/${member.xeroContactId}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-xs text-blue-600 hover:underline"
                                  >
                                    Open in Xero ↗
                                  </a>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                      {syncResult.skippedNoEmail !== undefined && syncResult.skippedNoEmail > 0 && (
                        <div>
                          <p>
                            <span className="text-muted-foreground">Skipped (no email):</span>{" "}
                            {syncResult.skippedNoEmail}
                          </p>
                          {syncResult.skippedNoEmailDetails && syncResult.skippedNoEmailDetails.length > 0 && (
                            <ul className="ml-4 mt-1 space-y-0.5 text-sm">
                              {syncResult.skippedNoEmailDetails.map((c, i) => (
                                <li key={i} className="flex items-center gap-2">
                                  <span>{c.name}</span>
                                  <a
                                    href={`https://go.xero.com/Contacts/View/${c.xeroContactId}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-xs text-blue-600 hover:underline"
                                  >
                                    Open in Xero ↗
                                  </a>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                      {syncResult.skippedArchived !== undefined && syncResult.skippedArchived > 0 && (
                        <div>
                          <p>
                            <span className="text-muted-foreground">Skipped (not active in Xero):</span>{" "}
                            {syncResult.skippedArchived}
                          </p>
                          {syncResult.skippedArchivedDetails && syncResult.skippedArchivedDetails.length > 0 && (
                            <ul className="ml-4 mt-1 space-y-0.5 text-sm">
                              {syncResult.skippedArchivedDetails.map((contact, i) => (
                                <li key={`${contact.xeroContactId}-${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                  <span>{contact.name}</span>
                                  <Badge variant="outline" className="text-xs">{contact.group}</Badge>
                                  {contact.reason ? (
                                    <span className="text-xs text-muted-foreground">{contact.reason}</span>
                                  ) : null}
                                  <a
                                    href={`https://go.xero.com/Contacts/View/${contact.xeroContactId}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-xs text-blue-600 hover:underline"
                                  >
                                    Open in Xero ↗
                                  </a>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                      {syncResult.groupsProcessed && syncResult.groupsProcessed.length > 0 && (
                        <p>
                          <span className="text-muted-foreground">Groups processed:</span>{" "}
                          {syncResult.groupsProcessed.join(", ")}
                        </p>
                      )}
                    </>
                  )}

                  {syncResult.syncReport && <SyncReportView report={syncResult.syncReport} returnTo={currentXeroPath} />}

                  {syncResult.checked !== undefined && (
                    <>
                      <p>
                        <span className="text-muted-foreground">Members checked:</span>{" "}
                        {syncResult.checked}
                      </p>
                      {syncResult.checked === 0 && (
                        <p className="text-amber-600">
                          No members with linked Xero contacts found. Use the setup tools below to import and link members first.
                        </p>
                      )}
                    </>
                  )}

                  {syncResult.errors !== undefined && syncResult.errors > 0 && (
                    <div className="text-red-600">
                      <p>
                        <span className="text-muted-foreground">Errors:</span> {syncResult.errors}
                      </p>
                      {syncResult.errorDetails && syncResult.errorDetails.length > 0 && (
                        <ul className="mt-2 list-inside list-disc space-y-1 text-sm">
                          {syncResult.errorDetails.map((detail, i) => (
                            <li key={i}>
                              <span className="font-medium">{detail.member}</span>: {detail.error}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {status?.connected && (
        <>
          <SectionCard
            id="xero-section-usage"
            title="Xero API Budget"
            description="Daily call volume, hotspots, rate limits, and recent failures from local metering."
            open={sectionOpen.usage}
            onToggle={(nextOpen) => setSectionState("usage", nextOpen)}
            actions={
              <Button variant="outline" size="sm" onClick={fetchUsage} disabled={loadingUsage}>
                {loadingUsage ? "Refreshing..." : "Refresh Usage"}
              </Button>
            }
          >
            {loadingUsage && !usageSummary ? (
              <p className="text-sm text-muted-foreground">Loading usage summary...</p>
            ) : usageSummary ? (
              <div className="space-y-5">
                <div className="grid gap-3 md:grid-cols-4">
                  <div className="rounded-md border p-3">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Calls Today</p>
                    <p className="mt-1 text-2xl font-semibold">{usageSummary.today.totalCalls}</p>
                    <p className="text-xs text-muted-foreground">of {usageSummary.budget.limit} daily budget</p>
                  </div>
                  <div className="rounded-md border p-3">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Successful</p>
                    <p className="mt-1 text-2xl font-semibold">{usageSummary.today.successfulCalls}</p>
                    <p className="text-xs text-muted-foreground">Failed: {usageSummary.today.failedCalls}</p>
                  </div>
                  <div className="rounded-md border p-3">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Rate Limits</p>
                    <p className="mt-1 text-2xl font-semibold">
                      {usageSummary.today.dayRateLimitHits + usageSummary.today.minuteRateLimitHits}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Day: {usageSummary.today.dayRateLimitHits} • Minute: {usageSummary.today.minuteRateLimitHits}
                    </p>
                  </div>
                  <div className="rounded-md border p-3">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Status</p>
                    <div className="mt-1 flex items-center gap-2">
                      <Badge className={usageToneClass(usageSummary.today.budgetStatus)}>
                        {usageSummary.today.budgetStatus}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Last rate limit:{" "}
                      {usageSummary.today.lastRateLimitAt
                        ? new Date(usageSummary.today.lastRateLimitAt).toLocaleString("en-NZ")
                        : "none"}
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span>Budget progress</span>
                    <span>{Math.round(usageSummary.today.usagePercent * 100)}%</span>
                  </div>
                  <div className="h-3 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={`h-full ${usageToneClass(usageSummary.today.budgetStatus)}`}
                      style={{ width: `${Math.min(usageSummary.today.usagePercent * 100, 100)}%` }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Thresholds: {usageSummary.budget.thresholds.map((threshold) => threshold.callCount).join(" / ")} calls
                  </p>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-md border p-3">
                    <p className="mb-2 text-sm font-medium">Top Operations</p>
                    {usageSummary.byOperation.length > 0 ? (
                      <div className="space-y-2 text-sm">
                        {usageSummary.byOperation.map((bucket) => (
                          <div key={bucket.label} className="flex items-center justify-between gap-3">
                            <span className="truncate">{bucket.label}</span>
                            <span className="text-muted-foreground">{bucket.count} calls</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">No Xero calls recorded yet today.</p>
                    )}
                  </div>

                  <div className="rounded-md border p-3">
                    <p className="mb-2 text-sm font-medium">Top Workflows</p>
                    {usageSummary.topWorkflows.length > 0 ? (
                      <div className="space-y-2 text-sm">
                        {usageSummary.topWorkflows.map((bucket) => (
                          <div key={bucket.label} className="flex items-center justify-between gap-3">
                            <span className="truncate">{bucket.label}</span>
                            <span className="text-muted-foreground">{bucket.count} calls</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">No workflow hotspots recorded yet today.</p>
                    )}
                  </div>
                </div>

                <div className="rounded-md border p-3">
                  <p className="mb-2 text-sm font-medium">Recent Failures</p>
                  {usageSummary.recentFailures.length > 0 ? (
                    <div className="space-y-3">
                      {usageSummary.recentFailures.map((failure) => (
                        <div key={failure.id} className="rounded-md bg-slate-50 p-3 text-sm">
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-medium">{failure.workflow ?? failure.operation}</span>
                            <span className="text-xs text-muted-foreground">
                              {new Date(failure.createdAt).toLocaleString("en-NZ")}
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {failure.operation} • {failure.resourceType}
                            {failure.statusCode ? ` • HTTP ${failure.statusCode}` : ""}
                            {failure.rateLimitCategory ? ` • rate limit ${failure.rateLimitCategory}` : ""}
                          </p>
                          {failure.errorMessage && (
                            <p className="mt-2 text-xs text-red-700">{failure.errorMessage}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No failed Xero calls recorded yet today.</p>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No Xero usage data recorded yet.</p>
            )}
          </SectionCard>

          <SectionCard
            id="xero-section-mappings"
            title="Account Mappings"
            description="Map Tokoroa Alpine Club booking transactions to Xero accounts and items."
            open={sectionOpen.mappings}
            onToggle={(nextOpen) => setSectionState("mappings", nextOpen)}
          >
            {loadingMappings ? (
              <p className="text-sm text-muted-foreground">Loading accounts...</p>
            ) : (
              <div className="space-y-4">
                {mappingError && <p className="text-sm text-red-600">{mappingError}</p>}
                {mappingSaved && <p className="text-sm text-green-700">Account mappings saved.</p>}
                <div className="flex flex-col gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 md:flex-row md:items-center md:justify-between">
                  <div className="space-y-1">
                    <p>{formatReferenceCacheLabel("Accounts", accountCacheMeta)}</p>
                    <p>{formatReferenceCacheLabel("Items", itemCacheMeta)}</p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={refreshReferenceData}
                    disabled={loadingMappings || refreshingReferenceData}
                  >
                    {refreshingReferenceData ? "Refreshing..." : "Refresh Xero reference data"}
                  </Button>
                </div>

                <h4 className="text-sm font-semibold text-slate-700">Account Code Mappings</h4>
                {accountMappings && ACCOUNT_MAPPING_KEYS.map((key) => {
                  const typeFilter = MAPPING_TYPE_FILTER[key]
                  const filtered = chartOfAccounts.filter((a) => a.type === typeFilter)
                  const currentCode = accountMappings[key]?.code
                  const matchedAccount = filtered.find((a) => a.code === currentCode)
                  return (
                    <div key={key} className="grid grid-cols-3 gap-4 items-start">
                      <div>
                        <p className="text-sm font-medium">{MAPPING_LABELS[key]}</p>
                        <p className="text-xs text-muted-foreground">{MAPPING_DESCRIPTIONS[key]}</p>
                      </div>
                      <div className="col-span-2">
                        {isEditingMappings ? (
                          <Select
                            value={currentCode ?? "__none__"}
                            onValueChange={(val) =>
                              setAccountMappings((prev) =>
                                prev ? { ...prev, [key]: { ...prev[key], code: val === "__none__" ? null : val } } : prev
                              )
                            }
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select account..." />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none__">
                                <span className="text-muted-foreground">Not configured (use default)</span>
                              </SelectItem>
                              {filtered.map((account) => (
                                <SelectItem key={account.code} value={account.code}>
                                  {account.code} — {account.name}
                                </SelectItem>
                              ))}
                              {filtered.length === 0 && (
                                <SelectItem value="__empty__" disabled>
                                  No {typeFilter.toLowerCase()} accounts found
                                </SelectItem>
                              )}
                            </SelectContent>
                          </Select>
                        ) : (
                          <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                            {matchedAccount
                              ? `${matchedAccount.code} — ${matchedAccount.name}`
                              : currentCode
                                ? currentCode
                                : <span className="text-muted-foreground">Not configured (using default)</span>}
                          </p>
                        )}
                      </div>
                    </div>
                  )
                })}

                <Separator />
                <h4 className="text-sm font-semibold text-slate-700">Refund Item Code</h4>
                <p className="text-xs text-muted-foreground">
                  Xero Item for refund credit note line items. When set, Xero auto-fills the account code from the item configuration.
                </p>
                {accountMappings && (() => {
                  const key = "hutFeeRefundItem" as const
                  const currentItemCode = accountMappings[key]?.itemCode
                  const matchedItem = xeroItems.find((i) => i.code === currentItemCode)
                  return (
                    <div className="grid grid-cols-3 gap-4 items-start">
                      <div>
                        <p className="text-sm font-medium">Hut Fee Refund Item</p>
                        <p className="text-xs text-muted-foreground">Xero Item for refund credit note line items</p>
                      </div>
                      <div className="col-span-2">
                        {isEditingMappings ? (
                          <Select
                            value={currentItemCode ?? "__none__"}
                            onValueChange={(val) =>
                              setAccountMappings((prev) =>
                                prev ? { ...prev, [key]: { ...prev[key], itemCode: val === "__none__" ? null : val } } : prev
                              )
                            }
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select item..." />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none__">
                                <span className="text-muted-foreground">Not configured</span>
                              </SelectItem>
                              {xeroItems.map((item) => (
                                <SelectItem key={item.code} value={item.code}>
                                  {item.code} — {item.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                            {matchedItem
                              ? `${matchedItem.code} — ${matchedItem.name}`
                              : currentItemCode
                                ? currentItemCode
                                : <span className="text-muted-foreground">Not configured</span>}
                          </p>
                        )}
                      </div>
                    </div>
                  )
                })()}

                <Separator />
                <h4 className="text-sm font-semibold text-slate-700">Hut Fee Item Codes</h4>
                <p className="text-xs text-muted-foreground">
                  Map each combination of age tier, season, and membership status to a Xero Item.
                </p>
                {isEditingMappings && (
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (xeroItems.length === 0) return
                        const firstItem = xeroItems[0].code
                        const filled: HutFeeMap = {}
                        for (const tier of ["INFANT", "CHILD", "YOUTH", "ADULT"]) {
                          for (const season of ["WINTER", "SUMMER"]) {
                            for (const member of [true, false]) {
                              filled[`${tier}_${season}_${member}`] = { itemCode: firstItem }
                            }
                          }
                        }
                        setHutFeeItemCodes(filled)
                      }}
                    >
                      Copy first item to all
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setHutFeeItemCodes({})}>
                      Clear all
                    </Button>
                  </div>
                )}
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr>
                        <th className="text-left p-2 border-b font-medium text-slate-600">Age Tier</th>
                        <th className="text-left p-2 border-b font-medium text-slate-600">Winter / Member</th>
                        <th className="text-left p-2 border-b font-medium text-slate-600">Winter / Non-Member</th>
                        <th className="text-left p-2 border-b font-medium text-slate-600">Summer / Member</th>
                        <th className="text-left p-2 border-b font-medium text-slate-600">Summer / Non-Member</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(["ADULT", "YOUTH", "CHILD", "INFANT"] as const).map((tier) => (
                        <tr key={tier} className="border-b last:border-0">
                          <td className="p-2 font-medium text-slate-700">{tier}</td>
                          {(["WINTER_true", "WINTER_false", "SUMMER_true", "SUMMER_false"] as const).map((combo) => {
                            const mapKey = `${tier}_${combo}`
                            const currentCode = hutFeeItemCodes[mapKey]?.itemCode ?? null
                            const matchedItem = xeroItems.find((i) => i.code === currentCode)
                            return (
                              <td key={combo} className="p-2">
                                {isEditingMappings ? (
                                  <Select
                                    value={currentCode ?? "__none__"}
                                    onValueChange={(val) =>
                                      setHutFeeItemCodes((prev) => {
                                        const next = { ...prev }
                                        if (val === "__none__") {
                                          delete next[mapKey]
                                        } else {
                                          next[mapKey] = { itemCode: val }
                                        }
                                        return next
                                      })
                                    }
                                  >
                                    <SelectTrigger className="w-full min-w-[140px]">
                                      <SelectValue placeholder="Not set" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="__none__">
                                        <span className="text-muted-foreground">Not set</span>
                                      </SelectItem>
                                      {xeroItems.map((item) => (
                                        <SelectItem key={item.code} value={item.code}>
                                          {item.code}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                ) : (
                                  <span className={currentCode ? "text-slate-700" : "text-muted-foreground"}>
                                    {matchedItem ? `${matchedItem.code}` : currentCode ?? "Not set"}
                                  </span>
                                )}
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <Separator />
                <h4 className="text-sm font-semibold text-slate-700">Entrance Fee Categories</h4>
                <p className="text-xs text-muted-foreground">
                  Configure entrance fee amounts and Xero Item codes per membership category.
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr>
                        <th className="text-left p-2 border-b font-medium text-slate-600">Category</th>
                        <th className="text-left p-2 border-b font-medium text-slate-600">Xero Item</th>
                        <th className="text-left p-2 border-b font-medium text-slate-600 w-32">Amount (incl. GST)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {([
                        { key: "ADULT", label: "Adult" },
                        { key: "YOUTH", label: "Youth" },
                        { key: "CHILD", label: "Child" },
                        { key: "FAMILY", label: "Family" },
                      ] as const).map(({ key, label }) => {
                        const entry = entranceFeeItemCodes[key]
                        const currentCode = entry?.itemCode ?? null
                        const currentAmountCents = entry?.amountCents ?? null
                        const matchedItem = xeroItems.find((i) => i.code === currentCode)
                        return (
                          <tr key={key} className="border-b last:border-0">
                            <td className="p-2 font-medium text-slate-700">{label}</td>
                            <td className="p-2">
                              {isEditingMappings ? (
                                <Select
                                  value={currentCode ?? "__none__"}
                                  onValueChange={(val) =>
                                    setEntranceFeeItemCodes((prev) => {
                                      const next = { ...prev }
                                      if (val === "__none__") {
                                        if (next[key]) {
                                          next[key] = { ...next[key], itemCode: null }
                                        }
                                      } else {
                                        next[key] = { itemCode: val, amountCents: next[key]?.amountCents ?? null }
                                      }
                                      return next
                                    })
                                  }
                                >
                                  <SelectTrigger className="w-full min-w-[140px]">
                                    <SelectValue placeholder="Not set" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="__none__">
                                      <span className="text-muted-foreground">Not set</span>
                                    </SelectItem>
                                    {xeroItems.map((item) => (
                                      <SelectItem key={item.code} value={item.code}>
                                        {item.code} — {item.name}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              ) : (
                                <span className={currentCode ? "text-slate-700" : "text-muted-foreground"}>
                                  {matchedItem ? `${matchedItem.code}` : currentCode || "Not set"}
                                </span>
                              )}
                            </td>
                            <td className="p-2">
                              {isEditingMappings ? (
                                <div className="flex items-center gap-1">
                                  <span className="text-sm">$</span>
                                  <Input
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    placeholder="0.00"
                                    value={currentAmountCents != null && currentAmountCents > 0
                                      ? (currentAmountCents / 100).toFixed(2)
                                      : ""}
                                    onChange={(e) => {
                                      const dollars = parseFloat(e.target.value)
                                      const cents = isNaN(dollars) || dollars <= 0 ? null : Math.round(dollars * 100)
                                      setEntranceFeeItemCodes((prev) => ({
                                        ...prev,
                                        [key]: {
                                          itemCode: prev[key]?.itemCode ?? null,
                                          amountCents: cents,
                                        },
                                      }))
                                    }}
                                    className="w-24"
                                  />
                                </div>
                              ) : (
                                <span className={currentAmountCents ? "text-slate-700" : "text-muted-foreground"}>
                                  {currentAmountCents
                                    ? `$${(currentAmountCents / 100).toFixed(2)}`
                                    : "Not set"}
                                </span>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="pt-2 flex gap-2">
                  {isEditingMappings ? (
                    <>
                      <Button
                        onClick={handleSaveAccountMappings}
                        disabled={savingMappings || !accountMappings}
                      >
                        {savingMappings ? "Saving..." : "Save Changes"}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => {
                          setAccountMappings(savedMappings)
                          setHutFeeItemCodes(savedHutFeeItemCodes)
                          setEntranceFeeItemCodes(savedEntranceFeeItemCodes)
                          setIsEditingMappings(false)
                          setMappingError("")
                        }}
                        disabled={savingMappings}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button variant="outline" onClick={() => setIsEditingMappings(true)}>
                      Edit Mappings
                    </Button>
                  )}
                </div>
              </div>
            )}
          </SectionCard>
        </>
      )}

      {status?.connected && (
        <SectionCard
          id="xero-section-setup"
          title="Setup Tools"
          description="One-off import and duplicate cleanup tools used during Xero setup or remediation."
          open={sectionOpen.setup}
          onToggle={(nextOpen) => setSectionState("setup", nextOpen)}
        >
          <div className="space-y-6">
            <div className="space-y-4">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold">Import Members from Xero</h3>
                <p className="text-sm text-muted-foreground">
                  Import members from Xero contact groups into Tokoroa Alpine Club - Bookings and map each group to an age tier.
                </p>
              </div>

              {contactGroups.length === 0 ? (
                <Button onClick={handleFetchGroups} disabled={loadingGroups}>
                  {loadingGroups ? "Loading Groups..." : "Load Contact Groups"}
                </Button>
              ) : (
                <>
                  <div className="flex justify-end">
                    <Button
                      variant="outline"
                      onClick={() =>
                        loadContactGroups({
                          refreshFromXero: true,
                          repairMissingContactCache: true,
                        })
                      }
                      disabled={refreshingGroups}
                    >
                      {refreshingGroups
                        ? "Refreshing Groups..."
                        : "Refresh Contact Groups from Xero"}
                    </Button>
                  </div>

                  <div className="space-y-3">
                    {contactGroups.map((group) => {
                      const mapping = groupMappings.find((m) => m.groupId === group.id)
                      return (
                        <div key={group.id} className="flex items-center gap-4 rounded-md border p-3">
                          <div className="flex-1">
                            <p className="text-sm font-medium">{group.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {group.contactCount} contact{group.contactCount !== 1 ? "s" : ""}
                            </p>
                          </div>
                          <div className="w-40">
                            <Select
                              value={mapping?.ageTier || "SKIP"}
                              onValueChange={(value) => updateGroupMapping(group.id, value as GroupMapping["ageTier"])}
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="SKIP">Skip</SelectItem>
                                <SelectItem value="INFANT">Infant</SelectItem>
                                <SelectItem value="CHILD">Child</SelectItem>
                                <SelectItem value="YOUTH">Youth</SelectItem>
                                <SelectItem value="ADULT">Adult</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="sendInvites"
                      checked={sendInvites}
                      onChange={(e) => setSendInvites(e.target.checked)}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                    <Label htmlFor="sendInvites" className="text-sm">
                      Send invite emails to new members (password reset link, valid 7 days)
                    </Label>
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="repairMissingContactCache"
                      checked={repairMissingContactCache}
                      onChange={(e) => setRepairMissingContactCache(e.target.checked)}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                    <Label htmlFor="repairMissingContactCache" className="text-sm">
                      Repair missing contact snapshots during import
                    </Label>
                  </div>

                  <div className="flex gap-2">
                    <Button
                      onClick={handleImportMembers}
                      disabled={syncing !== null || groupMappings.every((m) => m.ageTier === "SKIP")}
                    >
                      {syncing === "import" ? "Importing..." : "Import Members"}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setContactGroups([])
                        setGroupMappings([])
                      }}
                    >
                      Reset
                    </Button>
                  </div>
                </>
              )}
            </div>

            <Separator />

            <div className="space-y-4">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold">Duplicates &amp; Family Groups</h3>
                <p className="text-sm text-muted-foreground">
                  Scan Xero contacts for duplicate email addresses and create family groups where appropriate.
                </p>
              </div>

              <Button onClick={handleScanDuplicates} disabled={scanningDuplicates || syncing !== null}>
                {scanningDuplicates ? "Scanning..." : "Scan for Duplicates & Family Groups"}
              </Button>

              {duplicates && (
                <div className="space-y-4">
                  <div className="flex flex-wrap gap-4 text-sm">
                    <span className="text-muted-foreground">
                      Total contacts scanned:{" "}
                      <span className="font-medium text-foreground">{duplicates.totalContacts}</span>
                    </span>
                    <span className="text-muted-foreground">
                      Duplicate emails found:{" "}
                      <span className="font-medium text-foreground">{duplicates.totalDuplicateEmails}</span>
                    </span>
                    {duplicates.filteredByFamilyGroup > 0 && (
                      <span className="text-muted-foreground">
                        Already in family groups (hidden):{" "}
                        <span className="font-medium text-foreground">{duplicates.filteredByFamilyGroup}</span>
                      </span>
                    )}
                  </div>

                  {duplicates.duplicateGroups.length === 0 ? (
                    <p className="text-sm text-green-700">No duplicate contacts found.</p>
                  ) : (
                    <div className="space-y-3">
                      {duplicates.duplicateGroups.map((group) => (
                        <div key={group.email} className="space-y-2 rounded-md border p-4">
                          <div className="flex items-center justify-between">
                            <p className="text-sm font-medium">
                              {group.email}
                              <span className="ml-2 text-xs font-normal text-muted-foreground">
                                ({group.contacts.length} contacts)
                              </span>
                              {group.suggestedGroupName && (
                                <span className="ml-2 text-xs font-normal text-blue-600">
                                  — {group.suggestedGroupName}
                                </span>
                              )}
                            </p>
                            {group.canCreateFamilyGroup && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleCreateFamilyGroup(group)}
                                disabled={creatingFamilyGroup === group.email}
                              >
                                {creatingFamilyGroup === group.email ? "Creating..." : "Create Family Group"}
                              </Button>
                            )}
                          </div>
                          <div className="space-y-1">
                            {group.contacts.map((contact) => (
                              <div
                                key={contact.contactID}
                                className="flex items-center gap-3 border-l-2 border-muted py-1 pl-2 text-sm"
                              >
                                <div className="min-w-0 flex-1">
                                  <span className="font-medium">{contact.name}</span>
                                  {contact.memberId && (
                                    <Badge variant="outline" className="ml-2 border-green-300 text-xs text-green-700">
                                      Tokoroa Alpine Club member
                                    </Badge>
                                  )}
                                  {contact.invoiceCount > 0 ? (
                                    <Badge variant="default" className="ml-2 bg-blue-600 text-xs">
                                      {contact.invoiceCount} invoice{contact.invoiceCount !== 1 ? "s" : ""}
                                    </Badge>
                                  ) : (
                                    <Badge variant="secondary" className="ml-2 text-xs">
                                      No invoices
                                    </Badge>
                                  )}
                                  <span className="ml-2 text-xs text-muted-foreground">{contact.contactStatus}</span>
                                </div>
                                <a
                                  href={contact.xeroLink}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="whitespace-nowrap text-xs text-blue-600 hover:underline"
                                >
                                  Open in Xero
                                </a>
                              </div>
                            ))}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {group.canCreateFamilyGroup
                              ? "These contacts match Tokoroa Alpine Club members. Create a family group to link them, or merge them in Xero."
                              : "Merge into the contact with invoices. Open each in Xero, then use Xero’s merge option from the contact with no invoices."}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </SectionCard>
      )}
    </div>
  )
}
