"use client"

import type { AgeTier, FinanceAccessLevel } from "@prisma/client"
import { useEffect, useState, useCallback } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  MemberPasswordActionButton,
  getMemberPasswordActionKind,
} from "@/components/admin/member-password-action-button"
import { Users, ExternalLink, ArrowUpDown, ArrowUp, ArrowDown, X, Download, Upload, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react"
import { loadAdminXeroContactGroups } from "@/lib/admin-xero-contact-groups"
import { MEMBER_SETUP_INVITE_TTL_DAYS } from "@/lib/member-setup-invite"
import {
  ADMIN_PASSWORD_RESET_EXPIRY_OPTIONS,
  DEFAULT_ADMIN_PASSWORD_RESET_EXPIRY_WINDOW,
  getAdminPasswordResetExpiryLabel,
  type AdminPasswordResetExpiryWindow,
} from "@/lib/password-reset"

interface Member {
  id: string; firstName: string; lastName: string; email: string
  phoneCountryCode: string | null; phoneAreaCode: string | null; phoneNumber: string | null
  dateOfBirth: string | null
  role: "MEMBER" | "ADMIN"; ageTier: AgeTier
  financeAccessLevel: FinanceAccessLevel
  active: boolean; xeroContactId: string | null
  xeroContactGroupsLoaded: boolean
  xeroContactGroups: Array<{ id: string; name: string }>
  subscriptionStatus: "NOT_INVOICED" | "UNPAID" | "PAID" | "OVERDUE" | null
  subscriptionXeroInvoiceId: string | null; createdAt: string; joinedDate: string | null
  forcePasswordChange: boolean
  hasCompletedAccountSetup: boolean
  pendingInviteExpiresAt: string | null
  canLogin: boolean
  streetAddressLine1: string | null; streetAddressLine2: string | null; streetCity: string | null
  streetRegion: string | null; streetPostalCode: string | null; streetCountry: string | null
  postalAddressLine1: string | null; postalAddressLine2: string | null; postalCity: string | null
  postalRegion: string | null; postalPostalCode: string | null; postalCountry: string | null
  familyGroups: { id: string; name: string | null }[]
}

interface XeroSearchResult {
  contactId: string
  name: string
  email: string | null
  isLinked: boolean
  linkedMemberName: string | null
  matchReasons?: string[]
  xeroLink?: string
}

interface PendingXeroCreateDecision {
  memberId: string
  memberName: string
  createEntranceFeeInvoice: boolean
  suggestedContacts: XeroSearchResult[]
}

interface MemberForm {
  firstName: string; lastName: string; email: string
  phoneCountryCode: string; phoneAreaCode: string; phoneNumber: string
  dateOfBirth: string; role: "MEMBER" | "ADMIN"; ageTier: AgeTier
  financeAccessLevel: FinanceAccessLevel
  active: boolean; sendInvite: boolean; forcePasswordChange: boolean
  joinedDate: string; canLogin: boolean
  streetAddressLine1: string; streetAddressLine2: string; streetCity: string
  streetRegion: string; streetPostalCode: string; streetCountry: string
  postalAddressLine1: string; postalAddressLine2: string; postalCity: string
  postalRegion: string; postalPostalCode: string; postalCountry: string
}


interface XeroContactGroup { id: string; name: string; contactCount: number }
interface XeroFeatureFlags {
  autoLoadContactGroups: boolean
  liveMemberGroupLookups: boolean
}

interface Filters { role: string; financeAccess: string; active: string; ageTier: string; xeroLinked: string; subscription: string; xeroContactGroup: string }
interface ImportRow { firstName: string; lastName: string; email: string; phone?: string; dateOfBirth?: string; role?: string }
interface PasswordActionTarget {
  label: string
  inviteIds: string[]
  resendInviteIds: string[]
  resetIds: string[]
}

const financeAccessLabels: Record<FinanceAccessLevel, string> = {
  NONE: "None",
  VIEWER: "Viewer",
  MANAGER: "Manager",
}

const financeAccessBadgeClass: Record<FinanceAccessLevel, string> = {
  NONE: "bg-slate-100 text-slate-700 border-slate-200",
  VIEWER: "bg-amber-100 text-amber-800 border-amber-200",
  MANAGER: "bg-emerald-100 text-emerald-800 border-emerald-200",
}

const emptyForm: MemberForm = {
  firstName: "", lastName: "", email: "",
  phoneCountryCode: "", phoneAreaCode: "", phoneNumber: "",
  dateOfBirth: "", role: "MEMBER", ageTier: "ADULT",
  financeAccessLevel: "NONE",
  active: true, sendInvite: false, forcePasswordChange: false,
  joinedDate: "", canLogin: true,
  streetAddressLine1: "", streetAddressLine2: "", streetCity: "",
  streetRegion: "", streetPostalCode: "", streetCountry: "",
  postalAddressLine1: "", postalAddressLine2: "", postalCity: "",
  postalRegion: "", postalPostalCode: "", postalCountry: "",
}
const emptyFilters: Filters = { role: "", financeAccess: "", active: "", ageTier: "", xeroLinked: "", subscription: "", xeroContactGroup: "" }

function getMissingFieldsForXeroCreate(form: MemberForm): string[] {
  const missing: string[] = []

  if (!form.firstName.trim()) missing.push("First Name")
  if (!form.lastName.trim()) missing.push("Last Name")
  if (!form.email.trim()) missing.push("Email")
  if (!form.phoneCountryCode.trim() || !form.phoneAreaCode.trim() || !form.phoneNumber.trim()) missing.push("Phone")
  if (!form.dateOfBirth) missing.push("Date of Birth")
  if (!form.joinedDate) missing.push("Joined Date")
  if (!form.streetAddressLine1.trim() || !form.streetCity.trim() || !form.streetRegion.trim() || !form.streetPostalCode.trim() || !form.streetCountry.trim()) missing.push("Physical Address")
  if (!form.postalAddressLine1.trim() || !form.postalCity.trim() || !form.postalRegion.trim() || !form.postalPostalCode.trim() || !form.postalCountry.trim()) missing.push("Postal Address")

  return missing
}

function parseCsvLine(line: string): string[] {
  const result: string[] = []; let current = ""; let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++ }
      else if (ch === '"') { inQuotes = false }
      else { current += ch }
    } else {
      if (ch === '"') { inQuotes = true }
      else if (ch === ",") { result.push(current.trim()); current = "" }
      else { current += ch }
    }
  }
  result.push(current.trim()); return result
}

export default function MembersPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [members, setMembers] = useState<Member[]>([])
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState(searchParams.get("q") || "")
  const [debouncedSearch, setDebouncedSearch] = useState(search)
  const [page, setPage] = useState(parseInt(searchParams.get("page") || "1", 10))
  const [pageSize] = useState(25)
  const [sortBy, setSortBy] = useState(searchParams.get("sortBy") || "name")
  const [sortDir, setSortDir] = useState<"asc" | "desc">((searchParams.get("sortDir") as "asc" | "desc") || "asc")
  const [filters, setFilters] = useState<Filters>({
    role: searchParams.get("role") || "",
    financeAccess: searchParams.get("financeAccess") || "",
    active: searchParams.get("active") || "",
    ageTier: searchParams.get("ageTier") || "",
    xeroLinked: searchParams.get("xeroLinked") || "",
    subscription: searchParams.get("subscription") || "",
    xeroContactGroup: searchParams.get("xeroContactGroup") || "",
  })
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingMember, setEditingMember] = useState<Member | null>(null)
  const [form, setForm] = useState<MemberForm>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState("")
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false)
  const [bulkAction, setBulkAction] = useState("")
  const [bulkRole, setBulkRole] = useState<"MEMBER" | "ADMIN">("MEMBER")
  const [bulkLoading, setBulkLoading] = useState(false)
  const [passwordActionDialogOpen, setPasswordActionDialogOpen] = useState(false)
  const [passwordActionTarget, setPasswordActionTarget] = useState<PasswordActionTarget | null>(null)
  const [passwordActionLoading, setPasswordActionLoading] = useState(false)
  const [resetExpiryWindow, setResetExpiryWindow] = useState<AdminPasswordResetExpiryWindow>(
    DEFAULT_ADMIN_PASSWORD_RESET_EXPIRY_WINDOW
  )
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [importRows, setImportRows] = useState<ImportRow[]>([])
  const [importSendInvites, setImportSendInvites] = useState(false)
  const [importLoading, setImportLoading] = useState(false)
  const [importResult, setImportResult] = useState<{ created: number; skipped: number; errors: Array<{ row: number; errors: string[] }> } | null>(null)
  const [xeroConnected, setXeroConnected] = useState<boolean | null>(null)
  const [xeroFeatures, setXeroFeatures] = useState<XeroFeatureFlags>({
    autoLoadContactGroups: false,
    liveMemberGroupLookups: false,
  })
  const [refreshingXeroGroups, setRefreshingXeroGroups] = useState(false)
  const [xeroContactGroupsList, setXeroContactGroupsList] = useState<XeroContactGroup[]>([])
  const [xeroChoice, setXeroChoice] = useState<"" | "link" | "create" | "change">("")
  const [xeroUnlinking, setXeroUnlinking] = useState(false)
  const [xeroSearchQuery, setXeroSearchQuery] = useState("")
  const [xeroSearchResults, setXeroSearchResults] = useState<XeroSearchResult[]>([])
  const [xeroSearchLoading, setXeroSearchLoading] = useState(false)
  const [selectedXeroContactId, setSelectedXeroContactId] = useState("")
  const [xeroCreateEntranceFeeInvoice, setXeroCreateEntranceFeeInvoice] = useState(false)
  const [pendingXeroCreateDecision, setPendingXeroCreateDecision] = useState<PendingXeroCreateDecision | null>(null)
  const [pendingXeroDecisionContactId, setPendingXeroDecisionContactId] = useState("")
  const [pendingXeroDecisionError, setPendingXeroDecisionError] = useState("")
  const [pendingXeroDecisionLoading, setPendingXeroDecisionLoading] = useState(false)

  useEffect(() => { const t = setTimeout(() => { setDebouncedSearch(search); setPage(1) }, 300); return () => clearTimeout(t) }, [search])

  useEffect(() => {
    fetch("/api/admin/xero/status")
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to load Xero status")
        return res.json()
      })
      .then((data) => {
        const connected = Boolean(data.connected)
        setXeroConnected(connected)
        setXeroFeatures({
          autoLoadContactGroups: Boolean(data.features?.autoLoadContactGroups),
          liveMemberGroupLookups: Boolean(data.features?.liveMemberGroupLookups),
        })
        if (
          connected &&
          data.features?.autoLoadContactGroups &&
          data.features?.liveMemberGroupLookups
        ) {
          fetch("/api/admin/xero/contact-groups")
            .then(res => res.ok ? res.json() : null)
            .then(data => { if (data?.groups) setXeroContactGroupsList(data.groups) })
            .catch(() => {})
        }
      })
      .catch(() => setXeroConnected(false))
  }, [])

  useEffect(() => {
    const params = new URLSearchParams()
    if (debouncedSearch) params.set("q", debouncedSearch)
    if (page > 1) params.set("page", String(page))
    if (sortBy !== "name") params.set("sortBy", sortBy)
    if (sortDir !== "asc") params.set("sortDir", sortDir)
    Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v) })
    const qs = params.toString()
    router.replace(qs ? `/admin/members?${qs}` : "/admin/members", { scroll: false })
  }, [debouncedSearch, page, sortBy, sortDir, filters, router])

  const fetchMembers = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      if (debouncedSearch) params.set("q", debouncedSearch)
      params.set("page", String(page))
      params.set("pageSize", String(pageSize))
      params.set("sortBy", sortBy)
      params.set("sortDir", sortDir)
      Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v) })
      const res = await fetch(`/api/admin/members?${params.toString()}`)
      if (!res.ok) throw new Error("Failed to fetch members")
      const data = await res.json()
      setMembers(data.members); setTotal(data.total); setTotalPages(data.totalPages)
    } catch { setError("Failed to load members") }
    finally { setLoading(false) }
  }, [debouncedSearch, page, pageSize, sortBy, sortDir, filters])

  useEffect(() => { fetchMembers() }, [fetchMembers])

  const handleRefreshXeroGroups = useCallback(async () => {
    if (!xeroConnected) return

    setRefreshingXeroGroups(true)
    setError("")
    setSuccess("")
    try {
      const result = await loadAdminXeroContactGroups({ refreshFromXero: true })
      setXeroContactGroupsList(result.groups)
      await fetchMembers()
      setSuccess(
        result.groups.length > 0
          ? "Refreshed Xero contact groups"
          : "Refreshed Xero contact groups. No active groups were returned."
      )
      setTimeout(() => setSuccess(""), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to refresh Xero contact groups")
    } finally {
      setRefreshingXeroGroups(false)
    }
  }, [fetchMembers, xeroConnected])

  const toggleSort = (col: string) => { if (sortBy === col) setSortDir(d => d === "asc" ? "desc" : "asc"); else { setSortBy(col); setSortDir("asc") }; setPage(1) }
  const SortIcon = ({ col }: { col: string }) => { if (sortBy !== col) return <ArrowUpDown className="h-3 w-3 ml-1 opacity-40" />; return sortDir === "asc" ? <ArrowUp className="h-3 w-3 ml-1" /> : <ArrowDown className="h-3 w-3 ml-1" /> }
  const setFilter = (key: keyof Filters, value: string) => { setFilters(f => ({ ...f, [key]: value })); setPage(1) }
  const clearFilters = () => { setFilters(emptyFilters); setPage(1) }
  const activeFilterCount = Object.values(filters).filter(Boolean).length
  const toggleSelect = (id: string) => setSelectedIds(s => {
    const n = new Set(s)
    if (n.has(id)) {
      n.delete(id)
    } else {
      n.add(id)
    }
    return n
  })
  const toggleSelectAll = () => { if (selectedIds.size === members.length) setSelectedIds(new Set()); else setSelectedIds(new Set(members.map(m => m.id))) }
  const getPasswordActionTarget = (ids: string[], label: string): PasswordActionTarget => {
    const memberById = new Map(members.map((member) => [member.id, member]))

    return ids.reduce<PasswordActionTarget>(
      (target, id) => {
        const member = memberById.get(id)
        if (!member) return target
        const actionKind = getMemberPasswordActionKind(member)
        if (actionKind === "reset-password") target.resetIds.push(id)
        else if (actionKind === "resend-invite") target.resendInviteIds.push(id)
        else if (actionKind === "invite") target.inviteIds.push(id)
        return target
      },
      { label, inviteIds: [], resendInviteIds: [], resetIds: [] }
    )
  }
  const openPasswordActionDialog = (ids: string[], label: string) => {
    setPasswordActionTarget(getPasswordActionTarget(ids, label))
    setResetExpiryWindow(DEFAULT_ADMIN_PASSWORD_RESET_EXPIRY_WINDOW)
    setPasswordActionDialogOpen(true)
  }
  const openCreateDialog = () => {
    setEditingMember(null)
    setForm(emptyForm)
    setXeroChoice("")
    setXeroSearchQuery("")
    setXeroSearchResults([])
    setSelectedXeroContactId("")
    setXeroCreateEntranceFeeInvoice(false)
    setFormError("")
    setDialogOpen(true)
  }
  const handleXeroUnlink = async (memberId: string) => {
    setXeroUnlinking(true)
    setFormError("")
    try {
      const res = await fetch(`/api/admin/members/${memberId}/xero-unlink`, { method: "POST" })
      if (!res.ok) { const data = await res.json(); throw new Error(data.error || "Failed to unlink") }
      if (editingMember) {
        setEditingMember({ ...editingMember, xeroContactId: null, xeroContactGroups: [] })
      }
      setXeroChoice("")
      setSuccess("Xero contact unlinked")
      setTimeout(() => setSuccess(""), 3000)
      fetchMembers()
    } catch (err) { setFormError(err instanceof Error ? err.message : "Failed to unlink Xero contact") }
    finally { setXeroUnlinking(false) }
  }

  const handleXeroLink = async (memberId: string, contactId: string) => {
    setFormError("")
    try {
      const res = await fetch(`/api/admin/members/${memberId}/xero-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ xeroContactId: contactId }),
      })
      if (!res.ok) { const data = await res.json(); throw new Error(data.error || "Failed to link") }
      const data = await res.json()
      if (editingMember) {
        setEditingMember({ ...editingMember, xeroContactId: contactId, xeroContactGroups: [] })
      }
      setXeroChoice("")
      setSelectedXeroContactId("")
      setXeroSearchResults([])
      setSuccess(`Linked to Xero contact: ${data.contactName}`)
      setTimeout(() => setSuccess(""), 3000)
      fetchMembers()
    } catch (err) { setFormError(err instanceof Error ? err.message : "Failed to link Xero contact") }
  }

  const requestXeroPush = async (
    memberId: string,
    options?: { createEntranceFeeInvoice?: boolean; forceCreate?: boolean }
  ) => {
    const res = await fetch(`/api/admin/members/${memberId}/xero-push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        createEntranceFeeInvoice: Boolean(options?.createEntranceFeeInvoice),
        forceCreate: Boolean(options?.forceCreate),
      }),
    })
    const data = await res.json().catch(() => ({}))

    if (res.status === 409 && Array.isArray(data.suggestedContacts)) {
      return {
        status: "needsDecision" as const,
        suggestedContacts: data.suggestedContacts as XeroSearchResult[],
      }
    }

    if (!res.ok) {
      throw new Error(data.error || "Failed to create Xero contact")
    }

    return {
      status: "created" as const,
      data,
    }
  }

  const handleXeroPush = async (memberId: string, memberName: string) => {
    setFormError("")
    try {
      const result = await requestXeroPush(memberId, {
        createEntranceFeeInvoice: xeroCreateEntranceFeeInvoice,
      })

      if (result.status === "needsDecision") {
        setPendingXeroCreateDecision({
          memberId,
          memberName,
          createEntranceFeeInvoice: xeroCreateEntranceFeeInvoice,
          suggestedContacts: result.suggestedContacts,
        })
        setPendingXeroDecisionContactId(
          result.suggestedContacts.find((contact) => !contact.isLinked)?.contactId ?? ""
        )
        setPendingXeroDecisionError("")
        return
      }

      const data = result.data
      if (editingMember) {
        setEditingMember({ ...editingMember, xeroContactId: data.xeroContactId, xeroContactGroups: [] })
      }
      setXeroChoice("")
      setSuccess(
        xeroCreateEntranceFeeInvoice && data.entranceFeeInvoiceQueued
          ? "Xero contact created, linked, and entrance fee invoice queued"
          : "Xero contact created and linked"
      )
      setTimeout(() => setSuccess(""), 3000)
      if (data.warning || (xeroCreateEntranceFeeInvoice && data.entranceFeeInvoiceMessage && !data.entranceFeeInvoiceQueued)) {
        setError(data.warning || data.entranceFeeInvoiceMessage)
        setTimeout(() => setError(""), 8000)
      }
      fetchMembers()
    } catch (err) { setFormError(err instanceof Error ? err.message : "Failed to create Xero contact") }
  }

  const openEditDialog = (member: Member) => {
    router.push(`/admin/members/${member.id}?edit=true`)
  }

  const closePendingXeroCreateDecision = () => {
    setPendingXeroCreateDecision(null)
    setPendingXeroDecisionContactId("")
    setPendingXeroDecisionError("")
    setPendingXeroDecisionLoading(false)
  }

  const handlePendingXeroDecisionLink = async () => {
    if (!pendingXeroCreateDecision || !pendingXeroDecisionContactId) return

    setPendingXeroDecisionLoading(true)
    setPendingXeroDecisionError("")
    try {
      const res = await fetch(`/api/admin/members/${pendingXeroCreateDecision.memberId}/xero-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ xeroContactId: pendingXeroDecisionContactId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || "Failed to link Xero contact")
      }

      if (editingMember?.id === pendingXeroCreateDecision.memberId) {
        setEditingMember({
          ...editingMember,
          xeroContactId: pendingXeroDecisionContactId,
          xeroContactGroups: [],
        })
      }

      closePendingXeroCreateDecision()
      setXeroChoice("")
      setSuccess(`Linked to Xero contact: ${data.contactName}`)
      setTimeout(() => setSuccess(""), 3000)
      fetchMembers()
    } catch (err) {
      setPendingXeroDecisionError(err instanceof Error ? err.message : "Failed to link Xero contact")
    } finally {
      setPendingXeroDecisionLoading(false)
    }
  }

  const handlePendingXeroDecisionForceCreate = async () => {
    if (!pendingXeroCreateDecision) return

    setPendingXeroDecisionLoading(true)
    setPendingXeroDecisionError("")
    try {
      const result = await requestXeroPush(pendingXeroCreateDecision.memberId, {
        forceCreate: true,
        createEntranceFeeInvoice: pendingXeroCreateDecision.createEntranceFeeInvoice,
      })

      if (result.status !== "created") {
        throw new Error("Failed to create Xero contact")
      }

      if (editingMember?.id === pendingXeroCreateDecision.memberId) {
        setEditingMember({
          ...editingMember,
          xeroContactId: result.data.xeroContactId,
          xeroContactGroups: [],
        })
      }

      const warning =
        result.data.warning ||
        (pendingXeroCreateDecision.createEntranceFeeInvoice &&
        result.data.entranceFeeInvoiceMessage &&
        !result.data.entranceFeeInvoiceQueued
          ? result.data.entranceFeeInvoiceMessage
          : undefined)

      closePendingXeroCreateDecision()
      setXeroChoice("")
      setSuccess(
        pendingXeroCreateDecision.createEntranceFeeInvoice && result.data.entranceFeeInvoiceQueued
          ? "Xero contact created, linked, and entrance fee invoice queued"
          : "Xero contact created and linked"
      )
      setTimeout(() => setSuccess(""), 3000)
      if (warning) {
        setError(warning)
        setTimeout(() => setError(""), 8000)
      }
      fetchMembers()
    } catch (err) {
      setPendingXeroDecisionError(err instanceof Error ? err.message : "Failed to create Xero contact")
    } finally {
      setPendingXeroDecisionLoading(false)
    }
  }

  const handleXeroSearch = async () => {
    const query = xeroSearchQuery.trim() || form.email.trim() || [form.firstName.trim(), form.lastName.trim()].filter(Boolean).join(" ")
    if (query.length < 2) {
      setFormError("Enter at least 2 characters in the Xero search field, or complete the member name/email first.")
      return
    }

    setXeroSearchLoading(true)
    setFormError("")
    try {
      const res = await fetch(`/api/admin/xero/search-contacts?q=${encodeURIComponent(query)}`)
      if (!res.ok) { const data = await res.json(); throw new Error(data.error || "Failed to search Xero contacts") }
      const data = await res.json()
      const availableContacts = (data.contacts as XeroSearchResult[]).filter((contact) => !contact.isLinked)
      setXeroSearchResults(availableContacts)
      if (availableContacts.length === 0) {
        setSelectedXeroContactId("")
      }
    } catch (err) {
      setXeroSearchResults([])
      setSelectedXeroContactId("")
      setFormError(err instanceof Error ? err.message : "Failed to search Xero contacts")
    } finally {
      setXeroSearchLoading(false)
    }
  }

  const handleSave = async () => {
    setSaving(true); setFormError("")
    try {
      if (!editingMember && xeroConnected === null) {
        throw new Error("Still checking Xero connection status. Please try again in a moment.")
      }
      if (!editingMember && xeroConnected) {
        if (!xeroChoice) {
          throw new Error("Choose whether to link an existing Xero contact or create a new one.")
        }
        if (xeroChoice === "link" && !selectedXeroContactId) {
          throw new Error("Select an existing unlinked Xero contact before creating the member.")
        }
        if (xeroChoice === "create") {
          const missingFields = getMissingFieldsForXeroCreate(form)
          if (missingFields.length > 0) {
            throw new Error(`Complete these fields before creating in Xero: ${missingFields.join(", ")}`)
          }
        }
      }

      const url = editingMember ? `/api/admin/members/${editingMember.id}` : "/api/admin/members"
      const body: Record<string, unknown> = { firstName: form.firstName, lastName: form.lastName, email: form.email, phoneCountryCode: form.phoneCountryCode || null, phoneAreaCode: form.phoneAreaCode || null, phoneNumber: form.phoneNumber || null, dateOfBirth: form.dateOfBirth || null, role: form.role, ageTier: form.ageTier, financeAccessLevel: form.financeAccessLevel, active: form.active, canLogin: form.canLogin, joinedDate: form.joinedDate || null, streetAddressLine1: form.streetAddressLine1 || null, streetAddressLine2: form.streetAddressLine2 || null, streetCity: form.streetCity || null, streetRegion: form.streetRegion || null, streetPostalCode: form.streetPostalCode || null, streetCountry: form.streetCountry || null, postalAddressLine1: form.postalAddressLine1 || null, postalAddressLine2: form.postalAddressLine2 || null, postalCity: form.postalCity || null, postalRegion: form.postalRegion || null, postalPostalCode: form.postalPostalCode || null, postalCountry: form.postalCountry || null }
      if (editingMember) {
        body.forcePasswordChange = form.forcePasswordChange
      }
      if (!editingMember) {
        body.sendInvite = form.sendInvite
      }
      const res = await fetch(url, { method: editingMember ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      if (!res.ok) { const data = await res.json(); throw new Error(data.error || "Save failed") }
      const data = await res.json()

      let warning = data.warning as string | undefined
      let successMessage = editingMember ? "Member updated" : "Member created"

      if (!editingMember && xeroConnected) {
        if (xeroChoice === "link") {
          const linkRes = await fetch(`/api/admin/members/${data.id}/xero-link`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ xeroContactId: selectedXeroContactId }),
          })
          if (!linkRes.ok) {
            const linkData = await linkRes.json().catch(() => ({}))
            warning = `Member created, but Xero link failed: ${linkData.error || "Unknown error"}`
          } else {
            successMessage = "Member created and linked to Xero"
          }
        } else if (xeroChoice === "create") {
          try {
            const pushResult = await requestXeroPush(data.id, {
              createEntranceFeeInvoice: xeroCreateEntranceFeeInvoice,
            })

            if (pushResult.status === "needsDecision") {
              setPendingXeroCreateDecision({
                memberId: data.id,
                memberName: `${data.firstName || form.firstName} ${data.lastName || form.lastName}`.trim(),
                createEntranceFeeInvoice: xeroCreateEntranceFeeInvoice,
                suggestedContacts: pushResult.suggestedContacts,
              })
              setPendingXeroDecisionContactId(
                pushResult.suggestedContacts.find((contact) => !contact.isLinked)?.contactId ?? ""
              )
              setPendingXeroDecisionError("")
              successMessage = "Member created locally. Review the suggested Xero matches before creating a new contact."
            } else {
              successMessage =
                xeroCreateEntranceFeeInvoice && pushResult.data.entranceFeeInvoiceQueued
                  ? "Member created, pushed to Xero, and entrance fee invoice queued"
                  : "Member created and pushed to Xero"
              warning =
                pushResult.data.warning ||
                (xeroCreateEntranceFeeInvoice &&
                pushResult.data.entranceFeeInvoiceMessage &&
                !pushResult.data.entranceFeeInvoiceQueued
                  ? pushResult.data.entranceFeeInvoiceMessage
                  : warning)
            }
          } catch (err) {
            warning = `Member created, but Xero contact creation failed: ${err instanceof Error ? err.message : "Unknown error"}`
          }
        }
      }

      setDialogOpen(false)
      setSuccess(successMessage)
      setTimeout(() => setSuccess(""), 3000)
      if (warning) {
        setError(warning)
        setTimeout(() => setError(""), 8000)
      }
      fetchMembers()
    } catch (err) { setFormError(err instanceof Error ? err.message : "Save failed") }
    finally { setSaving(false) }
  }

  const handleBulkAction = async () => {
    setBulkLoading(true)
    try {
      const body: Record<string, unknown> = { ids: [...selectedIds], action: bulkAction }
      if (bulkAction === "set-role") body.role = bulkRole
      const res = await fetch("/api/admin/members/bulk-update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      if (!res.ok) { const data = await res.json(); throw new Error(data.error || "Bulk update failed") }
      const data = await res.json()
      setSuccess(`Updated ${data.updated} member(s)`); setTimeout(() => setSuccess(""), 3000)
      setBulkDialogOpen(false); setSelectedIds(new Set()); fetchMembers()
    } catch (err) { setError(err instanceof Error ? err.message : "Bulk update failed") }
    finally { setBulkLoading(false) }
  }

  const sendPasswordResetRequest = async (memberIds: string[]) => {
    const res = await fetch("/api/admin/members/send-password-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberIds, expiryWindow: resetExpiryWindow }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || "Failed to send password reset")
    return data as { sent: number; skipped: number; expiryLabel: string }
  }

  const sendSetupInviteRequest = async (memberIds: string[]) => {
    const res = await fetch("/api/admin/members/send-setup-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberIds }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || "Failed to send setup invite")
    return data as { sent: number; skipped: number }
  }

  const handleSendPasswordAction = async () => {
    if (!passwordActionTarget) return
    setPasswordActionLoading(true)

    const setupInviteIds = [
      ...passwordActionTarget.inviteIds,
      ...passwordActionTarget.resendInviteIds,
    ]

    const inviteOperation = setupInviteIds.length > 0
      ? sendSetupInviteRequest(setupInviteIds)
      : Promise.resolve(null)
    const resetOperation = passwordActionTarget.resetIds.length > 0
      ? sendPasswordResetRequest(passwordActionTarget.resetIds)
      : Promise.resolve(null)

    const [inviteResult, resetResult] = await Promise.allSettled([inviteOperation, resetOperation])
    const successMessages: string[] = []
    const errorMessages: string[] = []

    if (inviteResult.status === "fulfilled" && inviteResult.value) {
      successMessages.push(
        inviteResult.value.skipped > 0
          ? `Sent ${inviteResult.value.sent} setup invite(s). ${inviteResult.value.skipped} skipped (inactive or non-login).`
          : `Sent ${inviteResult.value.sent} setup invite(s).`
      )
    } else if (inviteResult.status === "rejected") {
      errorMessages.push(inviteResult.reason instanceof Error ? inviteResult.reason.message : "Failed to send setup invite")
    }

    if (resetResult.status === "fulfilled" && resetResult.value) {
      successMessages.push(
        resetResult.value.skipped > 0
          ? `Sent ${resetResult.value.sent} password reset email(s) with a ${resetResult.value.expiryLabel} window. ${resetResult.value.skipped} skipped (inactive or non-login).`
          : `Sent ${resetResult.value.sent} password reset email(s) with a ${resetResult.value.expiryLabel} window.`
      )
    } else if (resetResult.status === "rejected") {
      errorMessages.push(resetResult.reason instanceof Error ? resetResult.reason.message : "Failed to send password reset")
    }

    if (successMessages.length > 0) {
      setSuccess(successMessages.join(" "))
      setTimeout(() => setSuccess(""), 5000)
      setPasswordActionDialogOpen(false)
      setPasswordActionTarget(null)
      setSelectedIds(new Set())
      fetchMembers()
    }

    if (errorMessages.length > 0) {
      setError(errorMessages.join(" "))
    }

    setPasswordActionLoading(false)
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target?.result as string; if (!text) return
      const lines = text.split(/\\r?\\n/).filter(l => l.trim())
      if (lines.length < 2) { setError("CSV must have a header row and at least one data row"); return }
      const headers = parseCsvLine(lines[0]).map(h => h.toLowerCase().replace(/\\s+/g, ""))
      const rows: ImportRow[] = []
      for (let i = 1; i < lines.length; i++) {
        const vals = parseCsvLine(lines[i]); if (vals.length < 3) continue
        const row: ImportRow = { firstName: "", lastName: "", email: "" }
        headers.forEach((h, idx) => { const v = vals[idx] || ""; if (h === "firstname" || h === "first_name" || h === "first") row.firstName = v; else if (h === "lastname" || h === "last_name" || h === "last") row.lastName = v; else if (h === "email" || h === "emailaddress" || h === "email_address") row.email = v; else if (h === "phone" || h === "phonenumber" || h === "phone_number") row.phone = v; else if (h === "dateofbirth" || h === "date_of_birth" || h === "dob") row.dateOfBirth = v; else if (h === "role") row.role = v.toUpperCase() })
        if (row.firstName && row.lastName && row.email) rows.push(row)
      }
      setImportRows(rows); setImportResult(null)
    }
    reader.readAsText(file)
  }

  const handleImport = async () => {
    setImportLoading(true)
    try {
      const res = await fetch("/api/admin/members/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows: importRows, sendInvites: importSendInvites, autoLinkXero: false }) })
      if (!res.ok) { const data = await res.json(); throw new Error(data.error || "Import failed") }
      setImportResult(await res.json()); fetchMembers()
    } catch (err) { setError(err instanceof Error ? err.message : "Import failed") }
    finally { setImportLoading(false) }
  }

  const buildExportUrl = () => { const p = new URLSearchParams(); if (debouncedSearch) p.set("q", debouncedSearch); Object.entries(filters).forEach(([k, v]) => { if (v) p.set(k, v) }); const qs = p.toString(); return qs ? `/api/admin/members/export?${qs}` : "/api/admin/members/export" }
  const statusConfig: Record<string, { className: string; label: string }> = { PAID: { className: "bg-green-100 text-green-800 border-green-200 hover:bg-green-200", label: "Paid" }, UNPAID: { className: "bg-yellow-100 text-yellow-800 border-yellow-200 hover:bg-yellow-200", label: "Unpaid" }, OVERDUE: { className: "bg-red-100 text-red-800 border-red-200 hover:bg-red-200", label: "Overdue" }, NOT_INVOICED: { className: "bg-slate-100 text-slate-600 border-slate-200 hover:bg-slate-200", label: "Not Invoiced" } }
  const selectedMembers = members.filter((member) => selectedIds.has(member.id))
  const selectedInviteCount = selectedMembers.filter((member) => getMemberPasswordActionKind(member) === "invite").length
  const selectedResendInviteCount = selectedMembers.filter((member) => getMemberPasswordActionKind(member) === "resend-invite").length
  const selectedResetCount = selectedMembers.filter((member) => getMemberPasswordActionKind(member) === "reset-password").length
  const selectedPasswordActionCount = selectedInviteCount + selectedResendInviteCount + selectedResetCount
  const selectedInviteTotalCount = selectedInviteCount + selectedResendInviteCount
  const bulkPasswordActionLabel =
    selectedPasswordActionCount === 0
      ? "No Login Email Action"
      : selectedInviteTotalCount > 0 && selectedResetCount > 0
      ? "Invite / Reset Password"
      : selectedResetCount > 0
        ? "Send Password Reset"
        : selectedResendInviteCount > 0 && selectedInviteCount === 0
          ? "Resend Invite"
          : "Send Invite"
  const passwordActionInviteCount = passwordActionTarget?.inviteIds.length ?? 0
  const passwordActionResendInviteCount = passwordActionTarget?.resendInviteIds.length ?? 0
  const passwordActionInviteTotalCount = passwordActionInviteCount + passwordActionResendInviteCount
  const passwordActionResetCount = passwordActionTarget?.resetIds.length ?? 0
  const passwordActionTitle =
    passwordActionResetCount > 0 && passwordActionInviteTotalCount === 0
      ? "Send Password Reset"
      : passwordActionInviteTotalCount > 0 && passwordActionResetCount === 0
        ? passwordActionResendInviteCount > 0 && passwordActionInviteCount === 0
          ? "Resend Account Setup Invite"
          : "Send Account Setup Invite"
        : "Send Login Emails"
  const passwordActionButtonLabel =
    passwordActionResetCount > 0 && passwordActionInviteTotalCount === 0
      ? "Send Reset Email"
      : passwordActionInviteTotalCount > 0 && passwordActionResetCount === 0
        ? passwordActionResendInviteCount > 0 && passwordActionInviteCount === 0
          ? "Resend Invite"
          : "Send Invite"
        : "Send Emails"
  const passwordActionDescription =
    passwordActionInviteTotalCount > 0 && passwordActionResetCount > 0
      ? `Send login emails to ${passwordActionTarget?.label}. ${passwordActionInviteCount} member(s) will receive a first-time account setup invite. ${passwordActionResendInviteCount} member(s) will receive a fresh account setup invite. ${passwordActionResetCount} member(s) will receive a password reset email.`
      : passwordActionResetCount > 0
        ? `Send a password reset email to ${passwordActionTarget?.label}. They will receive a link to set a new password.`
        : passwordActionResendInviteCount > 0 && passwordActionInviteCount === 0
          ? `Send a fresh account setup email to ${passwordActionTarget?.label}. The current pending invite will be replaced with a new ${MEMBER_SETUP_INVITE_TTL_DAYS}-day link.`
          : `Send a first-time password setup email to ${passwordActionTarget?.label}. They will receive a link to activate their account and choose a password (expires in ${MEMBER_SETUP_INVITE_TTL_DAYS} days).`

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div><h1 className="text-2xl font-bold text-slate-900">Members</h1><p className="mt-1 text-sm text-slate-500">{total} member{total !== 1 ? "s" : ""}{debouncedSearch ? ` matching \"${debouncedSearch}\"` : " total"}</p></div>
        <div className="flex gap-2">
          {xeroConnected && (
            <Button variant="outline" size="sm" onClick={handleRefreshXeroGroups} disabled={refreshingXeroGroups}>
              <RefreshCw className={`h-4 w-4 mr-1 ${refreshingXeroGroups ? "animate-spin" : ""}`} />
              {refreshingXeroGroups ? "Refreshing Xero Groups..." : "Refresh Xero Groups"}
            </Button>
          )}
          <a href={buildExportUrl()}><Button variant="outline" size="sm"><Download className="h-4 w-4 mr-1" />Export CSV</Button></a><Button variant="outline" size="sm" onClick={() => { setImportRows([]); setImportResult(null); setImportDialogOpen(true) }}><Upload className="h-4 w-4 mr-1" />Import CSV</Button><Button onClick={openCreateDialog}>Add Member</Button>
        </div>
      </div>
      {error && <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-md text-sm">{error}<button onClick={() => setError("")} className="ml-2 underline">Dismiss</button></div>}
      {success && <div className="p-3 bg-green-50 border border-green-200 text-green-700 rounded-md text-sm">{success}</div>}
      {xeroConnected && !xeroFeatures.liveMemberGroupLookups && (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
          Xero group filters are disabled by default. Use Refresh Xero Groups to populate the cached Xero badges shown in this page.
        </div>
      )}
      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[200px] max-w-sm"><Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name or email..." className="bg-white" /></div>
        <Select value={filters.role || "all"} onValueChange={v => setFilter("role", v === "all" ? "" : v)}><SelectTrigger className="w-[130px]"><SelectValue placeholder="Role" /></SelectTrigger><SelectContent><SelectItem value="all">All Roles</SelectItem><SelectItem value="MEMBER">Member</SelectItem><SelectItem value="ADMIN">Admin</SelectItem></SelectContent></Select>
        <Select value={filters.financeAccess || "all"} onValueChange={v => setFilter("financeAccess", v === "all" ? "" : v)}><SelectTrigger className="w-[170px]"><SelectValue placeholder="Finance" /></SelectTrigger><SelectContent><SelectItem value="all">All Finance Access</SelectItem><SelectItem value="NONE">No Finance Access</SelectItem><SelectItem value="VIEWER">Finance Viewer</SelectItem><SelectItem value="MANAGER">Finance Manager</SelectItem></SelectContent></Select>
        <Select value={filters.active || "all"} onValueChange={v => setFilter("active", v === "all" ? "" : v)}><SelectTrigger className="w-[130px]"><SelectValue placeholder="Status" /></SelectTrigger><SelectContent><SelectItem value="all">All Status</SelectItem><SelectItem value="true">Active</SelectItem><SelectItem value="false">Inactive</SelectItem></SelectContent></Select>
        <Select value={filters.ageTier || "all"} onValueChange={v => setFilter("ageTier", v === "all" ? "" : v)}><SelectTrigger className="w-[130px]"><SelectValue placeholder="Age Tier" /></SelectTrigger><SelectContent><SelectItem value="all">All Tiers</SelectItem><SelectItem value="INFANT">Infant</SelectItem><SelectItem value="CHILD">Child</SelectItem><SelectItem value="YOUTH">Youth</SelectItem><SelectItem value="ADULT">Adult</SelectItem></SelectContent></Select>
        <Select value={filters.xeroLinked || "all"} onValueChange={v => setFilter("xeroLinked", v === "all" ? "" : v)}><SelectTrigger className="w-[130px]"><SelectValue placeholder="Xero" /></SelectTrigger><SelectContent><SelectItem value="all">All Xero</SelectItem><SelectItem value="true">Linked</SelectItem><SelectItem value="false">Not Linked</SelectItem></SelectContent></Select>
        <Select value={filters.subscription || "all"} onValueChange={v => setFilter("subscription", v === "all" ? "" : v)}><SelectTrigger className="w-[150px]"><SelectValue placeholder="Subscription" /></SelectTrigger><SelectContent><SelectItem value="all">All Subs</SelectItem><SelectItem value="PAID">Paid</SelectItem><SelectItem value="UNPAID">Unpaid</SelectItem><SelectItem value="OVERDUE">Overdue</SelectItem><SelectItem value="NOT_INVOICED">Not Invoiced</SelectItem><SelectItem value="NONE">No Record</SelectItem></SelectContent></Select>
        {xeroFeatures.liveMemberGroupLookups && xeroContactGroupsList.length > 0 && <Select value={filters.xeroContactGroup || "all"} onValueChange={v => setFilter("xeroContactGroup", v === "all" ? "" : v)}><SelectTrigger className="w-[170px]"><SelectValue placeholder="Xero Group" /></SelectTrigger><SelectContent><SelectItem value="all">All Xero Groups</SelectItem>{xeroContactGroupsList.map(g => <SelectItem key={g.id} value={g.id}>{g.name} ({g.contactCount})</SelectItem>)}</SelectContent></Select>}
        {activeFilterCount > 0 && <Button variant="ghost" size="sm" onClick={clearFilters}><X className="h-4 w-4 mr-1" />Clear ({activeFilterCount})</Button>}
      </div>
      {activeFilterCount > 0 && <div className="flex flex-wrap gap-2">{Object.entries(filters).filter(([,v]) => v).map(([k, v]) => { const displayValue = k === "xeroContactGroup" ? (xeroContactGroupsList.find(g => g.id === v)?.name ?? v) : v; return <Badge key={k} variant="secondary" className="inline-flex items-center gap-1 cursor-pointer" onClick={() => setFilter(k as keyof Filters, "")}>{k}: {displayValue}<X className="h-3 w-3" /></Badge> })}</div>}
      {selectedIds.size > 0 && <div className="flex items-center gap-3 p-3 bg-blue-50 border border-blue-200 rounded-md"><span className="text-sm font-medium text-blue-700">{selectedIds.size} selected</span><Button size="sm" variant="outline" onClick={() => { setBulkAction("deactivate"); setBulkDialogOpen(true) }}>Deactivate</Button><Button size="sm" variant="outline" onClick={() => { setBulkAction("reactivate"); setBulkDialogOpen(true) }}>Reactivate</Button><Button size="sm" variant="outline" onClick={() => { setBulkAction("set-role"); setBulkDialogOpen(true) }}>Change Role</Button><Button size="sm" variant="outline" disabled={selectedPasswordActionCount === 0} onClick={() => openPasswordActionDialog([...selectedIds], `${selectedPasswordActionCount} selected login member(s)`)}>{bulkPasswordActionLabel}</Button><Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}><X className="h-4 w-4" /></Button></div>}

      <Card><CardHeader className="pb-0"><CardTitle className="text-base font-medium">Member List</CardTitle></CardHeader><CardContent className="pt-4">
        {loading ? <div className="py-12 text-center"><p className="text-sm text-slate-500">Loading members...</p></div>
        : members.length === 0 ? <div className="py-12 text-center"><Users className="mx-auto h-10 w-10 text-slate-300 mb-3" /><p className="text-sm font-medium text-slate-500">{debouncedSearch ? `No members found matching \"${debouncedSearch}\"` : "No members yet"}</p></div>
        : <div className="overflow-x-auto"><Table><TableHeader><TableRow>
            <TableHead className="w-10"><input type="checkbox" checked={selectedIds.size === members.length && members.length > 0} onChange={toggleSelectAll} className="h-4 w-4 rounded border-gray-300" /></TableHead>
            <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("name")}><span className="inline-flex items-center">Name<SortIcon col="name" /></span></TableHead>
            <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("email")}><span className="inline-flex items-center">Email<SortIcon col="email" /></span></TableHead>
            <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("role")}><span className="inline-flex items-center">Role<SortIcon col="role" /></span></TableHead>
            <TableHead>Finance</TableHead>
            <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("ageTier")}><span className="inline-flex items-center">Age Tier<SortIcon col="ageTier" /></span></TableHead>
            <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("active")}><span className="inline-flex items-center">Status<SortIcon col="active" /></span></TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Family Group</TableHead>
            <TableHead>Subscription</TableHead><TableHead>Xero</TableHead>
            <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("createdAt")}><span className="inline-flex items-center">Joined<SortIcon col="createdAt" /></span></TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow></TableHeader><TableBody>
            {members.map(member => <TableRow key={member.id} className="hover:bg-slate-50">
              <TableCell><input type="checkbox" checked={selectedIds.has(member.id)} onChange={() => toggleSelect(member.id)} className="h-4 w-4 rounded border-gray-300" /></TableCell>
              <TableCell className="font-medium"><Link href={`/admin/members/${member.id}`} className="text-blue-600 hover:underline">{member.firstName} {member.lastName}</Link>{member.forcePasswordChange && <Badge variant="destructive" className="ml-2 text-xs">PW Reset</Badge>}</TableCell>
              <TableCell className="text-slate-600">{member.email}</TableCell>
              <TableCell><Badge variant={member.role === "ADMIN" ? "default" : "secondary"} className={member.role === "ADMIN" ? "bg-blue-600 text-white hover:bg-blue-700" : ""}>{member.role}</Badge></TableCell>
              <TableCell><Badge variant="secondary" className={financeAccessBadgeClass[member.financeAccessLevel]}>{financeAccessLabels[member.financeAccessLevel]}</Badge></TableCell>
              <TableCell><span className="text-sm text-slate-600">{member.ageTier.charAt(0) + member.ageTier.slice(1).toLowerCase()}</span></TableCell>
              <TableCell><Badge variant={member.active ? "default" : "destructive"} className={member.active ? "bg-green-100 text-green-800 hover:bg-green-200 border-green-200" : ""}>{member.active ? "Active" : "Inactive"}</Badge></TableCell>
              <TableCell>{member.canLogin ? <Badge variant="secondary" className="bg-slate-100 text-slate-700 border-slate-200">Can Login</Badge> : <Badge variant="secondary" className="bg-purple-100 text-purple-800 border-purple-200">Non-Login</Badge>}</TableCell>
              <TableCell>{member.familyGroups && member.familyGroups.length > 0 ? <div className="flex flex-wrap gap-1">{member.familyGroups.map(fg => <Link key={fg.id} href={`/admin/family-groups?edit=${fg.id}`}><Badge variant="secondary" className="bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100 cursor-pointer">{fg.name || "Unnamed Group"}</Badge></Link>)}</div> : <span className="text-xs text-slate-400">-</span>}</TableCell>
              <TableCell>{member.subscriptionStatus ? (() => { const cfg = statusConfig[member.subscriptionStatus] || statusConfig.NOT_INVOICED; const badge = <Badge variant="secondary" className={`${cfg.className} ${member.subscriptionXeroInvoiceId ? "cursor-pointer inline-flex items-center gap-1" : ""}`}>{cfg.label}{member.subscriptionXeroInvoiceId && <ExternalLink className="h-3 w-3" />}</Badge>; return member.subscriptionXeroInvoiceId ? <a href={`https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${member.subscriptionXeroInvoiceId}`} target="_blank" rel="noopener noreferrer">{badge}</a> : badge })() : <span className="text-xs text-slate-400">-</span>}</TableCell>
              <TableCell>
                <div className="space-y-1">
                  {member.xeroContactId ? (
                    <a href={`https://go.xero.com/app/contacts/contact/${member.xeroContactId}`} target="_blank" rel="noopener noreferrer">
                      <Badge variant="secondary" className="bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 cursor-pointer inline-flex items-center gap-1">
                        Linked
                        <ExternalLink className="h-3 w-3" />
                      </Badge>
                    </a>
                  ) : (
                    <span className="text-xs text-slate-400">-</span>
                  )}
                  {member.xeroContactGroups.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {member.xeroContactGroups.map((group) => (
                        <Badge key={group.id} variant="secondary" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                          {group.name}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {member.xeroContactId && !member.xeroContactGroupsLoaded && (
                    <p className="text-xs text-slate-400">Cached groups not refreshed yet</p>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-slate-500 text-sm">{new Date(member.joinedDate || member.createdAt).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" })}</TableCell>
              <TableCell className="text-right"><div className="flex justify-end gap-1"><MemberPasswordActionButton member={member} onClick={() => openPasswordActionDialog([member.id], `${member.firstName} ${member.lastName}`)} /><Button variant="outline" size="sm" onClick={() => openEditDialog(member)}>Edit</Button></div></TableCell>
            </TableRow>)}
          </TableBody></Table></div>}
        {totalPages > 1 && <div className="flex items-center justify-between mt-4 pt-4 border-t"><p className="text-sm text-slate-500">Page {page} of {totalPages}</p><div className="flex gap-1"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}><ChevronLeft className="h-4 w-4" /></Button>{Array.from({ length: Math.min(5, totalPages) }, (_, i) => { let pn: number; if (totalPages <= 5) pn = i + 1; else if (page <= 3) pn = i + 1; else if (page >= totalPages - 2) pn = totalPages - 4 + i; else pn = page - 2 + i; return <Button key={pn} variant={pn === page ? "default" : "outline"} size="sm" onClick={() => setPage(pn)}>{pn}</Button> })}<Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}><ChevronRight className="h-4 w-4" /></Button></div></div>}
      </CardContent></Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingMember ? "Edit Member" : "Add Member"}</DialogTitle>
            <DialogDescription>
              {editingMember ? "Update the member details." : "Create a new member account."}
            </DialogDescription>
          </DialogHeader>
          {formError && <div className="p-2 bg-red-50 border border-red-200 text-red-700 rounded text-sm">{formError}</div>}
          <div className="grid gap-4 py-2">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="canLogin"
                checked={form.canLogin}
                onChange={e => setForm(f => ({ ...f, canLogin: e.target.checked, sendInvite: e.target.checked ? f.sendInvite : false, financeAccessLevel: e.target.checked ? f.financeAccessLevel : "NONE" }))}
                className="h-4 w-4 rounded border-gray-300"
              />
              <Label htmlFor="canLogin">Can Login</Label>
              <p className="text-xs text-muted-foreground ml-2">
                Adults who can sign in and make bookings. Uncheck for children/youth managed by family group.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="firstName">First Name *</Label>
                <Input id="firstName" value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lastName">Last Name *</Label>
                <Input id="lastName" value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))} />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">Email *</Label>
              <Input id="email" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
            </div>

            <div className="space-y-2">
              <Label>Phone</Label>
              <div className="flex gap-2">
                <Input className="w-20" placeholder="64" value={form.phoneCountryCode} onChange={e => setForm(f => ({ ...f, phoneCountryCode: e.target.value }))} maxLength={5} aria-label="Country code" />
                <Input className="w-20" placeholder="27" value={form.phoneAreaCode} onChange={e => setForm(f => ({ ...f, phoneAreaCode: e.target.value }))} maxLength={5} aria-label="Area code" />
                <Input className="flex-1" placeholder="123 4567" value={form.phoneNumber} onChange={e => setForm(f => ({ ...f, phoneNumber: e.target.value }))} maxLength={15} aria-label="Phone number" />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="dateOfBirth">Date of Birth</Label>
                <Input id="dateOfBirth" type="date" value={form.dateOfBirth} onChange={e => setForm(f => ({ ...f, dateOfBirth: e.target.value }))} />
                <p className="text-xs text-muted-foreground">Age tier is calculated automatically from date of birth.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="joinedDate">{!editingMember && xeroChoice === "create" ? "Joined Date *" : "Joined Date"}</Label>
                <Input id="joinedDate" type="date" value={form.joinedDate} onChange={e => setForm(f => ({ ...f, joinedDate: e.target.value }))} />
                <p className="text-xs text-muted-foreground">Required when creating a new Xero contact.</p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Role</Label>
                <Select value={form.role} onValueChange={v => setForm(f => ({ ...f, role: v as "MEMBER" | "ADMIN" }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MEMBER">Member</SelectItem>
                    <SelectItem value="ADMIN">Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Finance Access</Label>
                <Select
                  value={form.financeAccessLevel}
                  onValueChange={v => setForm(f => ({ ...f, financeAccessLevel: v as FinanceAccessLevel }))}
                  disabled={!form.canLogin}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NONE">No Finance Access</SelectItem>
                    <SelectItem value="VIEWER">Finance Viewer</SelectItem>
                    <SelectItem value="MANAGER">Finance Manager</SelectItem>
                  </SelectContent>
                </Select>
                {!form.canLogin && <p className="text-xs text-muted-foreground">Finance access only applies to login-enabled members.</p>}
              </div>
              <div className="space-y-2">
                <Label>Age Tier</Label>
                <Select value={form.ageTier} onValueChange={v => setForm(f => ({ ...f, ageTier: v as AgeTier }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="INFANT">Infant</SelectItem>
                    <SelectItem value="CHILD">Child</SelectItem>
                    <SelectItem value="YOUTH">Youth</SelectItem>
                    <SelectItem value="ADULT">Adult</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <fieldset className="space-y-3 pt-2 border-t">
              <legend className="text-sm font-medium">Physical Address</legend>
              <Input placeholder="Address line 1" value={form.streetAddressLine1} onChange={e => setForm(f => ({ ...f, streetAddressLine1: e.target.value }))} maxLength={200} />
              <Input placeholder="Address line 2" value={form.streetAddressLine2} onChange={e => setForm(f => ({ ...f, streetAddressLine2: e.target.value }))} maxLength={200} />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <Input placeholder="City" value={form.streetCity} onChange={e => setForm(f => ({ ...f, streetCity: e.target.value }))} maxLength={200} />
                <Input placeholder="Region" value={form.streetRegion} onChange={e => setForm(f => ({ ...f, streetRegion: e.target.value }))} maxLength={200} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <Input placeholder="Postal code" value={form.streetPostalCode} onChange={e => setForm(f => ({ ...f, streetPostalCode: e.target.value }))} maxLength={20} />
                <Input placeholder="Country" value={form.streetCountry} onChange={e => setForm(f => ({ ...f, streetCountry: e.target.value }))} maxLength={100} />
              </div>
            </fieldset>

            <fieldset className="space-y-3 pt-2 border-t">
              <legend className="text-sm font-medium">Postal Address</legend>
              <Input placeholder="Address line 1" value={form.postalAddressLine1} onChange={e => setForm(f => ({ ...f, postalAddressLine1: e.target.value }))} maxLength={200} />
              <Input placeholder="Address line 2" value={form.postalAddressLine2} onChange={e => setForm(f => ({ ...f, postalAddressLine2: e.target.value }))} maxLength={200} />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <Input placeholder="City" value={form.postalCity} onChange={e => setForm(f => ({ ...f, postalCity: e.target.value }))} maxLength={200} />
                <Input placeholder="Region" value={form.postalRegion} onChange={e => setForm(f => ({ ...f, postalRegion: e.target.value }))} maxLength={200} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <Input placeholder="Postal code" value={form.postalPostalCode} onChange={e => setForm(f => ({ ...f, postalPostalCode: e.target.value }))} maxLength={20} />
                <Input placeholder="Country" value={form.postalCountry} onChange={e => setForm(f => ({ ...f, postalCountry: e.target.value }))} maxLength={100} />
              </div>
            </fieldset>

            {xeroConnected === true && (
              <fieldset className="space-y-3 pt-2 border-t">
                <legend className="text-sm font-medium">Xero</legend>

                {/* Existing member: show current link status with change/unlink/link options */}
                {editingMember && editingMember.xeroContactId && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className="bg-blue-50 text-blue-700 border-blue-200">Linked</Badge>
                        <a href={`https://go.xero.com/app/contacts/contact/${editingMember.xeroContactId}`} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-600 hover:underline inline-flex items-center gap-1">
                          View in Xero <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                      <div className="flex gap-2">
                        <Button type="button" variant="outline" size="sm" onClick={() => setXeroChoice(xeroChoice === "change" ? "" : "change")}>
                          {xeroChoice === "change" ? "Cancel Change" : "Change Contact"}
                        </Button>
                        <Button type="button" variant="outline" size="sm" onClick={() => handleXeroUnlink(editingMember.id)} disabled={xeroUnlinking}>
                          {xeroUnlinking ? "Unlinking..." : "Unlink"}
                        </Button>
                      </div>
                    </div>
                    {editingMember.xeroContactGroups.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {editingMember.xeroContactGroups.map((group) => (
                          <Badge key={group.id} variant="secondary" className="bg-emerald-50 text-emerald-700 border-emerald-200">{group.name}</Badge>
                        ))}
                      </div>
                    )}
                    {!editingMember.xeroContactGroupsLoaded && (
                      <p className="text-xs text-slate-500">
                        Cached contact groups have not been refreshed yet.
                      </p>
                    )}
                    {xeroChoice === "change" && (
                      <div className="space-y-3 rounded-md border border-blue-200 bg-blue-50 p-3">
                        <p className="text-sm text-blue-800">Search for a different Xero contact to link to this member. The current link will be replaced.</p>
                        <div className="flex gap-2">
                          <Input placeholder="Search Xero by name or email" value={xeroSearchQuery} onChange={e => setXeroSearchQuery(e.target.value)} onKeyDown={e => e.key === "Enter" && handleXeroSearch()} />
                          <Button type="button" variant="outline" onClick={handleXeroSearch} disabled={xeroSearchLoading}>{xeroSearchLoading ? "Searching..." : "Search"}</Button>
                        </div>
                        {xeroSearchResults.length > 0 && (
                          <div className="space-y-2">
                            <Label>Available Xero contacts</Label>
                            <Select value={selectedXeroContactId || undefined} onValueChange={setSelectedXeroContactId}>
                              <SelectTrigger><SelectValue placeholder="Select a Xero contact" /></SelectTrigger>
                              <SelectContent>
                                {xeroSearchResults.map((contact) => (
                                  <SelectItem key={contact.contactId} value={contact.contactId}>{contact.name}{contact.email ? ` (${contact.email})` : ""}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                        {selectedXeroContactId && (
                          <Button type="button" size="sm" onClick={() => handleXeroLink(editingMember.id, selectedXeroContactId)}>
                            Link to Selected Contact
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Existing member: not linked — offer to link or create */}
                {editingMember && !editingMember.xeroContactId && (
                  <div className="space-y-3">
                    <p className="text-sm text-slate-600">This member is not linked to a Xero contact.</p>
                    <Select
                      value={xeroChoice || undefined}
                      onValueChange={(value) => {
                        setXeroChoice(value as "link" | "create")
                        setFormError("")
                        setSelectedXeroContactId("")
                        if (value !== "link") { setXeroSearchQuery(""); setXeroSearchResults([]) }
                        if (value !== "create") { setXeroCreateEntranceFeeInvoice(false) }
                      }}
                    >
                      <SelectTrigger><SelectValue placeholder="Link or create a Xero contact..." /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="link">Link an existing Xero contact</SelectItem>
                        <SelectItem value="create">Create a new Xero contact</SelectItem>
                      </SelectContent>
                    </Select>

                    {xeroChoice === "link" && (
                      <div className="space-y-3">
                        <div className="flex gap-2">
                          <Input placeholder="Search Xero by name or email" value={xeroSearchQuery} onChange={e => setXeroSearchQuery(e.target.value)} onKeyDown={e => e.key === "Enter" && handleXeroSearch()} />
                          <Button type="button" variant="outline" onClick={handleXeroSearch} disabled={xeroSearchLoading}>{xeroSearchLoading ? "Searching..." : "Search"}</Button>
                        </div>
                        {xeroSearchResults.length > 0 && (
                          <div className="space-y-2">
                            <Label>Available Xero contacts</Label>
                            <Select value={selectedXeroContactId || undefined} onValueChange={setSelectedXeroContactId}>
                              <SelectTrigger><SelectValue placeholder="Select a Xero contact" /></SelectTrigger>
                              <SelectContent>
                                {xeroSearchResults.map((contact) => (
                                  <SelectItem key={contact.contactId} value={contact.contactId}>{contact.name}{contact.email ? ` (${contact.email})` : ""}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <p className="text-xs text-muted-foreground">Only unlinked Xero contacts are shown.</p>
                          </div>
                        )}
                        {selectedXeroContactId && (
                          <Button type="button" size="sm" onClick={() => handleXeroLink(editingMember.id, selectedXeroContactId)}>
                            Link to Selected Contact
                          </Button>
                        )}
                      </div>
                    )}

                    {xeroChoice === "create" && (
                      <div className="space-y-3">
                        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                          Creating a new Xero contact requires First Name, Last Name, Email, Phone, Postal Address, Physical Address, Date of Birth, and Joined Date. Save changes first, then create. We&apos;ll check for similar Xero contacts before a brand-new contact is created.
                        </div>
                        <div className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            id="edit-xero-create-invoice"
                            checked={xeroCreateEntranceFeeInvoice}
                            onChange={e => setXeroCreateEntranceFeeInvoice(e.target.checked)}
                            className="mt-0.5 h-4 w-4 rounded border-gray-300"
                          />
                          <div>
                            <Label htmlFor="edit-xero-create-invoice">Create membership entrance fee invoice after contact creation</Label>
                            <p className="text-xs text-muted-foreground">Leave this unchecked if you only want to create and link the Xero contact for now.</p>
                          </div>
                        </div>
                        <Button type="button" size="sm" onClick={() => handleXeroPush(editingMember.id, `${editingMember.firstName} ${editingMember.lastName}`)} disabled={(() => { const m = getMissingFieldsForXeroCreate(form); return m.length > 0 })()}>
                          Create Xero Contact
                        </Button>
                        {(() => { const m = getMissingFieldsForXeroCreate(form); return m.length > 0 ? <p className="text-xs text-red-600">Missing: {m.join(", ")}</p> : null })()}
                      </div>
                    )}
                  </div>
                )}

                {/* New member: original create flow */}
                {!editingMember && (
                  <>
                    <div className="space-y-2">
                      <Label>After creating this member</Label>
                      <Select
                        value={xeroChoice || undefined}
                        onValueChange={(value) => {
                          const nextChoice = value as "link" | "create"
                          setXeroChoice(nextChoice)
                          setFormError("")
                          setSelectedXeroContactId("")
                          if (nextChoice !== "link") {
                            setXeroSearchQuery("")
                            setXeroSearchResults([])
                          }
                          if (nextChoice !== "create") {
                            setXeroCreateEntranceFeeInvoice(false)
                          }
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Choose whether to link or create a Xero contact" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="link">Link an existing Xero contact</SelectItem>
                          <SelectItem value="create">Create a new Xero contact</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {xeroChoice === "link" && (
                      <div className="space-y-3">
                        <div className="flex gap-2">
                          <Input
                            placeholder="Search Xero by name or email"
                            value={xeroSearchQuery}
                            onChange={e => setXeroSearchQuery(e.target.value)}
                            onKeyDown={e => e.key === "Enter" && handleXeroSearch()}
                          />
                          <Button type="button" variant="outline" onClick={handleXeroSearch} disabled={xeroSearchLoading}>
                            {xeroSearchLoading ? "Searching..." : "Search"}
                          </Button>
                        </div>
                        <div className="space-y-2">
                          <Label>Available Xero contacts</Label>
                          <Select value={selectedXeroContactId || undefined} onValueChange={setSelectedXeroContactId}>
                            <SelectTrigger>
                              <SelectValue placeholder={xeroSearchResults.length > 0 ? "Select a Xero contact" : "Search to load unlinked Xero contacts"} />
                            </SelectTrigger>
                            <SelectContent>
                              {xeroSearchResults.map((contact) => (
                                <SelectItem key={contact.contactId} value={contact.contactId}>
                                  {contact.name}{contact.email ? ` (${contact.email})` : ""}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <p className="text-xs text-muted-foreground">
                            Only unlinked Xero contacts are shown here. If none match, switch to Create.
                          </p>
                        </div>
                      </div>
                    )}

                    {xeroChoice === "create" && (
                      <div className="space-y-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                        <p>
                          Creating a new Xero contact requires First Name, Last Name, Email, Phone, Postal Address, Physical Address, Date of Birth, and Joined Date. We&apos;ll check for similar Xero contacts before a brand-new contact is created.
                        </p>
                        <div className="flex items-start gap-2 text-slate-900">
                          <input
                            type="checkbox"
                            id="create-xero-create-invoice"
                            checked={xeroCreateEntranceFeeInvoice}
                            onChange={e => setXeroCreateEntranceFeeInvoice(e.target.checked)}
                            className="mt-0.5 h-4 w-4 rounded border-gray-300"
                          />
                          <div>
                            <Label htmlFor="create-xero-create-invoice">Create membership entrance fee invoice after contact creation</Label>
                            <p className="text-xs text-amber-900/80">Leave this unchecked if you only want to create and link the Xero contact for now.</p>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </fieldset>
            )}

            {!editingMember && xeroConnected === false && (
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
                Xero is not connected right now. This member will be created locally only.
              </div>
            )}

            {!editingMember && xeroConnected === null && (
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
                Checking Xero connection status...
              </div>
            )}

            {editingMember && (
              <div className="flex items-center gap-2">
                <input type="checkbox" id="active" checked={form.active} onChange={e => setForm(f => ({ ...f, active: e.target.checked }))} className="h-4 w-4 rounded border-gray-300" />
                <Label htmlFor="active">Active</Label>
              </div>
            )}

            {editingMember && (
              <div className="flex items-center gap-2">
                <input type="checkbox" id="forcePasswordChange" checked={form.forcePasswordChange} onChange={e => setForm(f => ({ ...f, forcePasswordChange: e.target.checked }))} className="h-4 w-4 rounded border-gray-300" />
                <Label htmlFor="forcePasswordChange">Force Password Change on Next Login</Label>
              </div>
            )}

            {!editingMember && form.canLogin && (
              <div className="flex items-center gap-2">
                <input type="checkbox" id="sendInvite" checked={form.sendInvite} onChange={e => setForm(f => ({ ...f, sendInvite: e.target.checked }))} className="h-4 w-4 rounded border-gray-300" />
                <Label htmlFor="sendInvite">Send account setup invite ({MEMBER_SETUP_INVITE_TTL_DAYS}-day link)</Label>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving || (!editingMember && xeroConnected === null)}>
              {saving ? "Saving..." : editingMember ? "Save Changes" : "Create Member"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(pendingXeroCreateDecision)}
        onOpenChange={(open) => { if (!open) closePendingXeroCreateDecision() }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Review Similar Xero Contacts</DialogTitle>
            <DialogDescription>
              {pendingXeroCreateDecision
                ? `We found existing Xero contacts that may match ${pendingXeroCreateDecision.memberName}. Link one of these if appropriate, or create a brand-new contact anyway.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {pendingXeroDecisionError && <div className="p-2 bg-red-50 border border-red-200 text-red-700 rounded text-sm">{pendingXeroDecisionError}</div>}
          {pendingXeroCreateDecision && (
            <div className="space-y-3">
              <div className="max-h-[360px] overflow-y-auto space-y-2">
                {pendingXeroCreateDecision.suggestedContacts.map((contact) => (
                  <label
                    key={contact.contactId}
                    className={`flex items-start gap-3 rounded-md border p-3 ${
                      contact.isLinked ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-white"
                    }`}
                  >
                    <input
                      type="radio"
                      name="pending-xero-contact"
                      value={contact.contactId}
                      checked={pendingXeroDecisionContactId === contact.contactId}
                      onChange={() => setPendingXeroDecisionContactId(contact.contactId)}
                      disabled={contact.isLinked}
                      className="mt-1 h-4 w-4 border-gray-300"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-slate-900">{contact.name}</p>
                        {contact.matchReasons && contact.matchReasons.map((reason) => (
                          <Badge key={`${contact.contactId}-${reason}`} variant="secondary" className="bg-blue-50 text-blue-700 border-blue-200">
                            {reason}
                          </Badge>
                        ))}
                      </div>
                      {contact.email && <p className="text-xs text-slate-500">{contact.email}</p>}
                      {contact.isLinked && (
                        <p className="text-xs text-amber-700">
                          Already linked to {contact.linkedMemberName}
                        </p>
                      )}
                      {contact.xeroLink && (
                        <a href={contact.xeroLink} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-blue-600 hover:underline">
                          View in Xero
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                  </label>
                ))}
              </div>
              {pendingXeroCreateDecision.createEntranceFeeInvoice && (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  If you choose <span className="font-medium">Create New Contact Anyway</span>, the membership entrance fee invoice will also be queued.
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={closePendingXeroCreateDecision} disabled={pendingXeroDecisionLoading}>Do This Later</Button>
            <Button variant="outline" onClick={handlePendingXeroDecisionLink} disabled={pendingXeroDecisionLoading || !pendingXeroDecisionContactId}>
              {pendingXeroDecisionLoading ? "Working..." : "Link Selected Contact"}
            </Button>
            <Button onClick={handlePendingXeroDecisionForceCreate} disabled={pendingXeroDecisionLoading}>
              {pendingXeroDecisionLoading ? "Working..." : "Create New Contact Anyway"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={bulkDialogOpen} onOpenChange={setBulkDialogOpen}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>Bulk {bulkAction === "set-role" ? "Change Role" : bulkAction === "deactivate" ? "Deactivate" : "Reactivate"}</DialogTitle><DialogDescription>This will affect {selectedIds.size} selected member(s).</DialogDescription></DialogHeader>{bulkAction === "set-role" && <div className="space-y-2"><Label>New Role</Label><Select value={bulkRole} onValueChange={v => setBulkRole(v as "MEMBER" | "ADMIN")}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="MEMBER">Member</SelectItem><SelectItem value="ADMIN">Admin</SelectItem></SelectContent></Select></div>}<DialogFooter><Button variant="outline" onClick={() => setBulkDialogOpen(false)} disabled={bulkLoading}>Cancel</Button><Button onClick={handleBulkAction} disabled={bulkLoading} variant={bulkAction === "deactivate" ? "destructive" : "default"}>{bulkLoading ? "Processing..." : "Confirm"}</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={passwordActionDialogOpen} onOpenChange={(open) => { setPasswordActionDialogOpen(open); if (!open) setPasswordActionTarget(null) }}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>{passwordActionTitle}</DialogTitle><DialogDescription>{passwordActionDescription}</DialogDescription></DialogHeader>{passwordActionResetCount > 0 && <div className="space-y-2"><Label htmlFor="reset-expiry-window">Reset link expiry</Label><Select value={resetExpiryWindow} onValueChange={(value) => setResetExpiryWindow(value as AdminPasswordResetExpiryWindow)}><SelectTrigger id="reset-expiry-window"><SelectValue placeholder="Select expiry" /></SelectTrigger><SelectContent>{ADMIN_PASSWORD_RESET_EXPIRY_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select><p className="text-sm text-slate-500">This applies to password reset emails only. The current selection expires in {getAdminPasswordResetExpiryLabel(resetExpiryWindow)}.</p></div>}<DialogFooter><Button variant="outline" onClick={() => { setPasswordActionDialogOpen(false); setPasswordActionTarget(null) }} disabled={passwordActionLoading}>Cancel</Button><Button onClick={handleSendPasswordAction} disabled={passwordActionLoading}>{passwordActionLoading ? "Sending..." : passwordActionButtonLabel}</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}><DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>Import Members from CSV</DialogTitle><DialogDescription>Upload a CSV with columns: First Name, Last Name, Email, Phone (optional), Date of Birth (optional), Role (optional).</DialogDescription></DialogHeader><div className="space-y-4"><div><Label htmlFor="csvFile">CSV File</Label><Input id="csvFile" type="file" accept=".csv" onChange={handleFileUpload} className="mt-1" /></div>{importRows.length > 0 && !importResult && <div><p className="text-sm font-medium mb-2">{importRows.length} rows parsed</p><div className="max-h-48 overflow-y-auto border rounded text-xs"><Table><TableHeader><TableRow><TableHead>First Name</TableHead><TableHead>Last Name</TableHead><TableHead>Email</TableHead><TableHead>Role</TableHead></TableRow></TableHeader><TableBody>{importRows.slice(0, 10).map((row, i) => <TableRow key={i}><TableCell>{row.firstName}</TableCell><TableCell>{row.lastName}</TableCell><TableCell>{row.email}</TableCell><TableCell>{row.role || "MEMBER"}</TableCell></TableRow>)}</TableBody></Table>{importRows.length > 10 && <p className="text-xs text-slate-500 p-2">...and {importRows.length - 10} more</p>}</div><div className="flex items-center gap-2 mt-3"><input type="checkbox" id="sendInvites" checked={importSendInvites} onChange={e => setImportSendInvites(e.target.checked)} className="h-4 w-4 rounded border-gray-300" /><Label htmlFor="sendInvites">Send account setup invites ({MEMBER_SETUP_INVITE_TTL_DAYS}-day links)</Label></div></div>}{importResult && <div className="space-y-2"><p className="text-sm"><span className="font-medium text-green-700">{importResult.created} created</span>, <span className="font-medium text-yellow-700">{importResult.skipped} skipped</span>, <span className="font-medium text-red-700">{importResult.errors.length} errors</span></p>{importResult.errors.length > 0 && <div className="max-h-32 overflow-y-auto text-xs text-red-600 border border-red-200 rounded p-2">{importResult.errors.map((e, i) => <p key={i}>Row {e.row}: {e.errors.join(", ")}</p>)}</div>}</div>}</div><DialogFooter><Button variant="outline" onClick={() => setImportDialogOpen(false)}>Close</Button>{importRows.length > 0 && !importResult && <Button onClick={handleImport} disabled={importLoading}>{importLoading ? "Importing..." : `Import ${importRows.length} Members`}</Button>}</DialogFooter></DialogContent></Dialog>
    </div>
  )
}
