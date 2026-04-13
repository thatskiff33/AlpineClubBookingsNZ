"use client"

import type { AgeTier } from "@prisma/client"
import { useEffect, useState, useCallback } from "react"
import { useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import type { XeroAccount, XeroItem } from "@/lib/xero-admin-cache"

interface XeroStatus {
  connected: boolean
  tenantId: string | null
  tokenExpiresAt: string | null
}

interface SyncResult {
  total?: number
  matched?: number
  updated?: number
  checked?: number
  errors?: number
  errorDetails?: Array<{ member: string; error: string }>
  message?: string
  // Import-specific fields
  created?: number
  createdAsDependent?: number
  skippedExisting?: number
  linkedExisting?: number
  skippedNoEmail?: number
  skippedNoEmailDetails?: Array<{ name: string; xeroContactId: string }>
  groupsProcessed?: string[]
  // Detailed sync report fields (#29)
  syncReport?: SyncReport
}

interface SyncReport {
  created: Array<{ name: string; email: string; xeroContactId: string; group?: string }>
  updated: Array<{ name: string; memberId: string; xeroContactId: string; changes: string[] }>
  skippedNoChanges: number
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

function SyncReportView({ report }: { report: SyncReport }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Scanned {report.total} Xero contacts
      </p>

      <SyncReportSection title="Updated Members" count={report.updated.length}>
        {report.updated.map((u, i) => (
          <div key={i} className="flex items-start justify-between text-xs py-1 border-b last:border-0">
            <div>
              <a href={`/admin/members/${u.memberId}`} className="text-blue-600 hover:underline font-medium">{u.name}</a>
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

export default function XeroPage() {
  const searchParams = useSearchParams()
  const [status, setStatus] = useState<XeroStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null)
  const [error, setError] = useState("")

  // Import state
  const [contactGroups, setContactGroups] = useState<ContactGroup[]>([])
  const [groupMappings, setGroupMappings] = useState<GroupMapping[]>([])
  const [loadingGroups, setLoadingGroups] = useState(false)
  const [sendInvites, setSendInvites] = useState(false)

  // Duplicate detection state
  const [duplicates, setDuplicates] = useState<DuplicateResult | null>(null)
  const [scanningDuplicates, setScanningDuplicates] = useState(false)
  const [creatingFamilyGroup, setCreatingFamilyGroup] = useState<string | null>(null)

  // Account mappings state
  const [accountMappings, setAccountMappings] = useState<AccountMappings | null>(null)
  const [savedMappings, setSavedMappings] = useState<AccountMappings | null>(null)
  const [chartOfAccounts, setChartOfAccounts] = useState<XeroAccount[]>([])
  const [xeroItems, setXeroItems] = useState<XeroItem[]>([])
  const [loadingMappings, setLoadingMappings] = useState(false)
  const [savingMappings, setSavingMappings] = useState(false)
  const [mappingError, setMappingError] = useState("")
  const [mappingSaved, setMappingSaved] = useState(false)
  const [isEditingMappings, setIsEditingMappings] = useState(false)
  const [operations, setOperations] = useState<XeroOperation[]>([])
  const [loadingOperations, setLoadingOperations] = useState(false)
  const [operationStatusFilter, setOperationStatusFilter] = useState("all")
  const [operationEntityFilter, setOperationEntityFilter] = useState("all")
  const [retryingOperationId, setRetryingOperationId] = useState<string | null>(null)
  const [queueingOperationId, setQueueingOperationId] = useState<string | null>(null)
  const [operationMessage, setOperationMessage] = useState("")

  // Granular item code mappings state
  type HutFeeMap = Record<string, { itemCode: string }>
  type EntranceFeeMap = Record<string, { itemCode: string | null; amountCents: number | null }>
  const [hutFeeItemCodes, setHutFeeItemCodes] = useState<HutFeeMap>({})
  const [savedHutFeeItemCodes, setSavedHutFeeItemCodes] = useState<HutFeeMap>({})
  const [entranceFeeItemCodes, setEntranceFeeItemCodes] = useState<EntranceFeeMap>({})
  const [savedEntranceFeeItemCodes, setSavedEntranceFeeItemCodes] = useState<EntranceFeeMap>({})

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

  const fetchAccountMappings = useCallback(async () => {
    setLoadingMappings(true)
    try {
      const [mappingsRes, accountsRes, itemsRes, itemCodeRes] = await Promise.all([
        fetch("/api/admin/xero/account-mappings"),
        fetch("/api/admin/xero/chart-of-accounts"),
        fetch("/api/admin/xero/items"),
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
      }
      if (itemsRes.ok) {
        const data = await itemsRes.json()
        setXeroItems(data.items ?? [])
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

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  useEffect(() => {
    const connected = searchParams.get("connected")
    const errorParam = searchParams.get("error")
    if (connected === "true") {
      fetchStatus()
    }
    if (errorParam) {
      setError(decodeURIComponent(errorParam))
    }
  }, [searchParams, fetchStatus])

  // Load account mappings whenever Xero is connected
  useEffect(() => {
    if (status?.connected) {
      fetchAccountMappings()
    }
  }, [status?.connected, fetchAccountMappings])

  useEffect(() => {
    if (status?.connected) {
      fetchOperations(operationStatusFilter, operationEntityFilter)
    }
  }, [status?.connected, operationStatusFilter, operationEntityFilter, fetchOperations])

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
      setOperationMessage(data.message || "Xero operation retried.")
      await fetchOperations(operationStatusFilter, operationEntityFilter)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to retry Xero operation")
    } finally {
      setRetryingOperationId(null)
    }
  }

  const handleRequeueOperation = async (operationId: string) => {
    setQueueingOperationId(operationId)
    setOperationMessage("")
    setError("")
    try {
      const res = await fetch(`/api/admin/xero/operations/${operationId}/requeue`, {
        method: "POST",
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || "Failed to queue Xero operation retry")
      }
      setOperationMessage(data.message || "Xero operation queued for background retry.")
      await fetchOperations(operationStatusFilter, operationEntityFilter)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to queue Xero operation retry")
    } finally {
      setQueueingOperationId(null)
    }
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
    } catch {
      setError("Failed to disconnect Xero")
    }
  }

  const handleSyncContacts = async () => {
    setSyncing("contacts")
    setSyncResult(null)
    setError("")
    try {
      const res = await fetch("/api/admin/xero/sync-contacts", { method: "POST" })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Sync failed")
      }
      const data = await res.json()
      setSyncResult(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Contact sync failed")
    } finally {
      setSyncing(null)
    }
  }

  const handleSyncMemberships = async () => {
    setSyncing("memberships")
    setSyncResult(null)
    setError("")
    try {
      const res = await fetch("/api/admin/xero/sync-memberships", { method: "POST" })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Sync failed")
      }
      const data = await res.json()
      setSyncResult(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Membership sync failed")
    } finally {
      setSyncing(null)
    }
  }

  const handleFetchGroups = async () => {
    setLoadingGroups(true)
    setError("")
    try {
      const res = await fetch("/api/admin/xero/contact-groups")
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to fetch groups")
      }
      const data = await res.json()
      setContactGroups(data.groups)
      // Initialize mappings with "SKIP" for all groups
      setGroupMappings(
        data.groups.map((g: ContactGroup) => ({
          groupId: g.id,
          groupName: g.name,
          ageTier: "SKIP",
        }))
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch contact groups")
    } finally {
      setLoadingGroups(false)
    }
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
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Import failed")
      }
      const data = await res.json()
      setSyncResult(data)
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
        return "bg-green-600"
      case "PARTIAL":
        return "bg-amber-500"
      case "FAILED":
        return "bg-red-600"
      case "PENDING":
        return "bg-slate-600"
      case "RUNNING":
        return "bg-blue-600"
      default:
        return ""
    }
  }

  const formatJson = (value: unknown) => JSON.stringify(value ?? null, null, 2)

  const shortId = (value: string | null | undefined) =>
    value ? (value.length > 12 ? `${value.slice(0, 12)}...` : value) : "-"

  if (loading) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold mb-4">Xero Integration</h1>
        <p className="text-muted-foreground">Loading...</p>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-2xl font-bold mb-2">Xero Integration</h1>
      <p className="text-muted-foreground mb-6">
        Connect to Xero for automatic invoice creation, membership verification, and contact sync.
      </p>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-md text-sm">
          {error}
          <button onClick={() => setError("")} className="ml-2 underline">
            Dismiss
          </button>
        </div>
      )}

      {operationMessage && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 text-green-700 rounded-md text-sm">
          {operationMessage}
          <button onClick={() => setOperationMessage("")} className="ml-2 underline">
            Dismiss
          </button>
        </div>
      )}

      {searchParams.get("connected") === "true" && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 text-green-700 rounded-md text-sm">
          Xero connected successfully!
        </div>
      )}

      {/* Connection Status */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            Connection Status
            {status?.connected ? (
              <Badge variant="default" className="bg-green-600">Connected</Badge>
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
                <code className="text-xs bg-muted px-1 py-0.5 rounded">
                  {status.tenantId}
                </code>
              </div>
              {status.tokenExpiresAt && (
                <div className="text-sm">
                  <span className="text-muted-foreground">Token expires:</span>{" "}
                  {new Date(status.tokenExpiresAt).toLocaleString("en-NZ")}
                  <span className="text-muted-foreground ml-1">(auto-refreshes)</span>
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

      {/* Account Mappings - only show when connected */}
      {status?.connected && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Account Mappings</CardTitle>
            <CardDescription>
              Map TACBookings transactions to your Xero chart of accounts. Changes take effect
              on the next invoice or credit note created.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loadingMappings ? (
              <p className="text-sm text-muted-foreground">Loading accounts...</p>
            ) : (
              <div className="space-y-4">
                {mappingError && (
                  <p className="text-sm text-red-600">{mappingError}</p>
                )}
                {mappingSaved && (
                  <p className="text-sm text-green-700">Account mappings saved.</p>
                )}
                {/* Account Code Mappings */}
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
                          <p className="text-sm py-2 px-3 bg-slate-50 rounded-md border border-slate-200">
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

                {/* Refund Item Code */}
                <Separator />
                <h4 className="text-sm font-semibold text-slate-700">Refund Item Code</h4>
                <p className="text-xs text-muted-foreground">
                  Xero Item for refund credit note line items. When set, Xero auto-fills the account code from the Item&apos;s configuration.
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
                          <p className="text-sm py-2 px-3 bg-slate-50 rounded-md border border-slate-200">
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

                {/* Hut Fee Item Code Matrix */}
                <Separator />
                <h4 className="text-sm font-semibold text-slate-700">Hut Fee Item Codes</h4>
                <p className="text-xs text-muted-foreground">
                  Map each combination of age tier, season, and membership status to a Xero Item.
                  Each booking invoice line item will use the item code matching the guest&apos;s profile.
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
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setHutFeeItemCodes({})}
                    >
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

                {/* Entrance Fee Categories */}
                <Separator />
                <h4 className="text-sm font-semibold text-slate-700">Entrance Fee Categories</h4>
                <p className="text-xs text-muted-foreground">
                  Configure entrance fee amounts and Xero Item codes per membership category.
                  When a new member is added, the system automatically determines their category and creates a Xero invoice.
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
          </CardContent>
        </Card>
      )}

      {status?.connected && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Xero Operations</CardTitle>
            <CardDescription>
              Recent outbound sync attempts and webhook-related reconciliation state.
              Use this to inspect failures, confirm what was sent, and jump to related records.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
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
                    <SelectItem value="INVOICE">Invoice</SelectItem>
                    <SelectItem value="PAYMENT">Payment</SelectItem>
                    <SelectItem value="CREDIT_NOTE">Credit Note</SelectItem>
                    <SelectItem value="ALLOCATION">Allocation</SelectItem>
                    <SelectItem value="SUBSCRIPTION">Subscription</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="md:pt-5">
                <Button
                  variant="outline"
                  onClick={() => fetchOperations(operationStatusFilter, operationEntityFilter)}
                  disabled={loadingOperations}
                >
                  {loadingOperations ? "Refreshing..." : "Refresh"}
                </Button>
              </div>
            </div>

            {loadingOperations ? (
              <p className="text-sm text-muted-foreground">Loading recent operations...</p>
            ) : operations.length === 0 ? (
              <p className="text-sm text-muted-foreground">No Xero operations recorded yet.</p>
            ) : (
              <div className="space-y-3">
                {operations.map((operation) => (
                  <div key={operation.id} className="rounded-md border p-3 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="default" className={operationStatusClass(operation.status)}>
                        {operation.status}
                      </Badge>
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
                        {operation.lastErrorMessage}
                      </p>
                    )}

                    <div className="flex flex-wrap items-center gap-2">
                      {operation.supported ? (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleRetryOperation(operation.id)}
                            disabled={
                              retryingOperationId === operation.id || queueingOperationId === operation.id
                            }
                          >
                            {retryingOperationId === operation.id ? "Retrying..." : "Retry"}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleRequeueOperation(operation.id)}
                            disabled={
                              retryingOperationId === operation.id || queueingOperationId === operation.id
                            }
                          >
                            {queueingOperationId === operation.id ? "Queueing..." : "Requeue"}
                          </Button>
                        </>
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
                          <pre className="max-h-64 overflow-auto rounded bg-white p-2 text-[11px] border">
                            {formatJson(operation.requestPayload)}
                          </pre>
                        </div>
                        <div>
                          <p className="mb-1 text-xs font-medium text-slate-700">Response</p>
                          <pre className="max-h-64 overflow-auto rounded bg-white p-2 text-[11px] border">
                            {formatJson(operation.responsePayload)}
                          </pre>
                        </div>
                      </div>
                    </details>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Sync Operations - only show when connected */}
      {status?.connected && (
        <>
          {/* Import Members from Xero */}
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Import Members from Xero</CardTitle>
              <CardDescription>
                Import members from Xero contact groups into TACBookings. Select which groups
                to import and map each to an age tier. Existing members (matched by email)
                will be skipped but linked to their Xero contact.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {contactGroups.length === 0 ? (
                <Button
                  onClick={handleFetchGroups}
                  disabled={loadingGroups}
                >
                  {loadingGroups ? "Loading Groups..." : "Load Contact Groups from Xero"}
                </Button>
              ) : (
                <>
                  <div className="space-y-3">
                    {contactGroups.map((group) => {
                      const mapping = groupMappings.find((m) => m.groupId === group.id)
                      return (
                        <div
                          key={group.id}
                          className="flex items-center gap-4 p-3 border rounded-md"
                        >
                          <div className="flex-1">
                            <p className="font-medium text-sm">{group.name}</p>
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

                  <div className="flex gap-2">
                    <Button
                      onClick={handleImportMembers}
                      disabled={
                        syncing !== null ||
                        groupMappings.every((m) => m.ageTier === "SKIP")
                      }
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
            </CardContent>
          </Card>

          {/* Duplicate Contact Detection & Family Groups */}
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Duplicates &amp; Family Groups</CardTitle>
              <CardDescription>
                Scan Xero contacts for duplicate email addresses and suggest Family Group
                associations. Duplicates are shown with invoice counts so you can identify
                which contact to keep, merge them in Xero, or create Family Groups for
                members sharing an email.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button
                onClick={handleScanDuplicates}
                disabled={scanningDuplicates || syncing !== null}
              >
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
                        <div key={group.email} className="border rounded-md p-4 space-y-2">
                          <div className="flex items-center justify-between">
                            <p className="font-medium text-sm">
                              {group.email}
                              <span className="ml-2 text-xs text-muted-foreground font-normal">
                                ({group.contacts.length} contacts)
                              </span>
                              {group.suggestedGroupName && (
                                <span className="ml-2 text-xs text-blue-600 font-normal">
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
                                {creatingFamilyGroup === group.email
                                  ? "Creating..."
                                  : "Create Family Group"}
                              </Button>
                            )}
                          </div>
                          <div className="space-y-1">
                            {group.contacts.map((contact) => (
                              <div
                                key={contact.contactID}
                                className="flex items-center gap-3 text-sm pl-2 py-1 border-l-2 border-muted"
                              >
                                <div className="flex-1 min-w-0">
                                  <span className="font-medium">{contact.name}</span>
                                  {contact.memberId && (
                                    <Badge variant="outline" className="ml-2 text-xs border-green-300 text-green-700">
                                      TACBookings member
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
                                  <span className="ml-2 text-xs text-muted-foreground">
                                    {contact.contactStatus}
                                  </span>
                                </div>
                                <a
                                  href={contact.xeroLink}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-xs text-blue-600 hover:underline whitespace-nowrap"
                                >
                                  Open in Xero
                                </a>
                              </div>
                            ))}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {group.canCreateFamilyGroup
                              ? "These contacts match TACBookings members. Create a Family Group to link them, or merge in Xero."
                              : "Merge into the contact with invoices. Open each in Xero, then use Xero\u0027s \u0022Merge\u0022 option from the contact with no invoices."}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Contact Sync */}
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Contact Sync</CardTitle>
              <CardDescription>
                Link existing TACBookings members to their Xero contacts by email address.
                This is useful after members are already in the database.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={handleSyncContacts}
                disabled={syncing !== null}
              >
                {syncing === "contacts" ? "Syncing..." : "Sync Contacts from Xero"}
              </Button>
            </CardContent>
          </Card>

          {/* Membership Status Refresh */}
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Membership Status Refresh</CardTitle>
              <CardDescription>
                Check Xero invoices for all active members and update their subscription status
                for the current season year. This runs automatically as a daily cron job.
                Only checks members that have been linked to a Xero contact.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={handleSyncMemberships}
                disabled={syncing !== null}
              >
                {syncing === "memberships" ? "Refreshing..." : "Refresh Membership Statuses"}
              </Button>
            </CardContent>
          </Card>

          {/* Sync Results */}
          {syncResult && (
            <Card className="mb-6">
              <CardHeader>
                <CardTitle>Results</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 text-sm">
                  {syncResult.message && <p>{syncResult.message}</p>}

                  {/* Import results */}
                  {syncResult.created !== undefined && (
                    <>
                      <p>
                        <span className="text-muted-foreground">New members created:</span>{" "}
                        <span className="font-medium text-green-700">{syncResult.created}</span>
                      </p>
                      {syncResult.createdAsDependent !== undefined && syncResult.createdAsDependent > 0 && (
                        <p>
                          <span className="text-muted-foreground">Family dependents created:</span>{" "}
                          <span className="font-medium text-blue-700">{syncResult.createdAsDependent}</span>
                        </p>
                      )}
                      {syncResult.skippedExisting !== undefined && syncResult.skippedExisting > 0 && (
                        <p>
                          <span className="text-muted-foreground">Skipped (already exist):</span>{" "}
                          {syncResult.skippedExisting}
                        </p>
                      )}
                      {syncResult.linkedExisting !== undefined && syncResult.linkedExisting > 0 && (
                        <p>
                          <span className="text-muted-foreground">Existing members linked to Xero:</span>{" "}
                          {syncResult.linkedExisting}
                        </p>
                      )}
                      {syncResult.skippedNoEmail !== undefined && syncResult.skippedNoEmail > 0 && (
                        <div>
                          <p>
                            <span className="text-muted-foreground">Skipped (no email):</span>{" "}
                            {syncResult.skippedNoEmail}
                          </p>
                          {syncResult.skippedNoEmailDetails && syncResult.skippedNoEmailDetails.length > 0 && (
                            <ul className="mt-1 ml-4 text-sm space-y-0.5">
                              {syncResult.skippedNoEmailDetails.map((c, i) => (
                                <li key={i} className="flex items-center gap-2">
                                  <span>{c.name}</span>
                                  <a
                                    href={`https://go.xero.com/Contacts/View/${c.xeroContactId}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-blue-600 hover:underline text-xs"
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

                  {/* Detailed sync report (#29) */}
                  {syncResult.syncReport && (
                    <SyncReportView report={syncResult.syncReport} />
                  )}

                  {/* Membership results */}
                  {syncResult.checked !== undefined && (
                    <>
                      <p>
                        <span className="text-muted-foreground">Members checked:</span>{" "}
                        {syncResult.checked}
                      </p>
                      {syncResult.checked === 0 && (
                        <p className="text-amber-600">
                          No members with linked Xero contacts found. Use &quot;Import Members from Xero&quot;
                          above to import members from your Xero contact groups first.
                        </p>
                      )}
                    </>
                  )}

                  {syncResult.errors !== undefined && syncResult.errors > 0 && (
                    <div className="text-red-600">
                      <p>
                        <span className="text-muted-foreground">Errors:</span>{" "}
                        {syncResult.errors}
                      </p>
                      {syncResult.errorDetails && syncResult.errorDetails.length > 0 && (
                        <ul className="mt-2 text-sm space-y-1 list-disc list-inside">
                          {syncResult.errorDetails.map((detail, i) => (
                            <li key={i}>
                              <span className="font-medium">{detail.member}</span>:{" "}
                              {detail.error}
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

          <Separator className="my-6" />

          <div className="text-sm text-muted-foreground space-y-2">
            <h3 className="font-medium text-foreground">How it works</h3>
            <ul className="list-disc list-inside space-y-1">
              <li>
                <strong>Import members:</strong> Import members from Xero contact groups,
                mapping each group to an age tier (Adult, Youth, Child). New members get
                an invite email with a password reset link.
              </li>
              <li>
                <strong>Invoice creation:</strong> When a booking is confirmed and paid,
                an invoice is automatically created in Xero with line items per guest.
              </li>
              <li>
                <strong>Credit notes:</strong> When a booking is cancelled and refunded,
                a credit note is created against the original invoice.
              </li>
              <li>
                <strong>Membership verification:</strong> A daily cron job checks Xero
                invoices for keywords like &quot;subscription&quot; or &quot;membership&quot; to verify
                each member&apos;s subscription is paid for the current season.
              </li>
              <li>
                <strong>Contact sync:</strong> Members are matched to Xero contacts by email.
                New contacts are created automatically when invoices are generated.
              </li>
              <li>
                <strong>Two-way sync:</strong> Editing a member in the admin panel syncs
                changes to their linked Xero contact.
              </li>
            </ul>
          </div>
        </>
      )}
    </div>
  )
}
