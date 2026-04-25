"use client"

import type { AgeTier } from "@prisma/client"
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
import { Users, ExternalLink, ArrowUpDown, ArrowUp, ArrowDown, X, Download, Upload, ChevronLeft, ChevronRight } from "lucide-react"
import { MEMBER_SETUP_INVITE_TTL_DAYS } from "@/lib/member-setup-invite"

interface Member {
  id: string; firstName: string; lastName: string; email: string
  phoneCountryCode: string | null; phoneAreaCode: string | null; phoneNumber: string | null
  dateOfBirth: string | null
  role: "MEMBER" | "ADMIN"; ageTier: AgeTier
  active: boolean; xeroContactId: string | null
  xeroContactGroupsLoaded: boolean
  xeroContactGroups: Array<{ id: string; name: string }>
  subscriptionStatus: "NOT_INVOICED" | "UNPAID" | "PAID" | "OVERDUE" | null
  subscriptionXeroInvoiceId: string | null; createdAt: string; joinedDate: string | null
  forcePasswordChange: boolean
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
}

interface MemberForm {
  firstName: string; lastName: string; email: string
  phoneCountryCode: string; phoneAreaCode: string; phoneNumber: string
  dateOfBirth: string; role: "MEMBER" | "ADMIN"; ageTier: AgeTier
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

interface Filters { role: string; active: string; ageTier: string; xeroLinked: string; subscription: string; xeroContactGroup: string }
interface ImportRow { firstName: string; lastName: string; email: string; phone?: string; dateOfBirth?: string; role?: string }

const emptyForm: MemberForm = {
  firstName: "", lastName: "", email: "",
  phoneCountryCode: "", phoneAreaCode: "", phoneNumber: "",
  dateOfBirth: "", role: "MEMBER", ageTier: "ADULT",
  active: true, sendInvite: false, forcePasswordChange: false,
  joinedDate: "", canLogin: true,
  streetAddressLine1: "", streetAddressLine2: "", streetCity: "",
  streetRegion: "", streetPostalCode: "", streetCountry: "",
  postalAddressLine1: "", postalAddressLine2: "", postalCity: "",
  postalRegion: "", postalPostalCode: "", postalCountry: "",
}
const emptyFilters: Filters = { role: "", active: "", ageTier: "", xeroLinked: "", subscription: "", xeroContactGroup: "" }

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
  const [setupInviteDialogOpen, setSetupInviteDialogOpen] = useState(false)
  const [setupInviteTarget, setSetupInviteTarget] = useState<{ ids: string[]; label: string } | null>(null)
  const [setupInviteLoading, setSetupInviteLoading] = useState(false)
  const [resetPasswordDialogOpen, setResetPasswordDialogOpen] = useState(false)
  const [resetPasswordTarget, setResetPasswordTarget] = useState<{ ids: string[]; label: string } | null>(null)
  const [resetPasswordLoading, setResetPasswordLoading] = useState(false)
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
  const [xeroContactGroupsList, setXeroContactGroupsList] = useState<XeroContactGroup[]>([])
  const [xeroChoice, setXeroChoice] = useState<"" | "link" | "create" | "change">("")
  const [xeroUnlinking, setXeroUnlinking] = useState(false)
  const [xeroSearchQuery, setXeroSearchQuery] = useState("")
  const [xeroSearchResults, setXeroSearchResults] = useState<XeroSearchResult[]>([])
  const [xeroSearchLoading, setXeroSearchLoading] = useState(false)
  const [selectedXeroContactId, setSelectedXeroContactId] = useState("")

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
  const openCreateDialog = () => {
    setEditingMember(null)
    setForm(emptyForm)
    setXeroChoice("")
    setXeroSearchQuery("")
    setXeroSearchResults([])
    setSelectedXeroContactId("")
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

  const handleXeroPush = async (memberId: string) => {
    setFormError("")
    try {
      const res = await fetch(`/api/admin/members/${memberId}/xero-push`, { method: "POST" })
      if (!res.ok) { const data = await res.json(); throw new Error(data.error || "Failed to create Xero contact") }
      const data = await res.json()
      if (editingMember) {
        setEditingMember({ ...editingMember, xeroContactId: data.xeroContactId, xeroContactGroups: [] })
      }
      setXeroChoice("")
      setSuccess("Xero contact created and linked")
      setTimeout(() => setSuccess(""), 3000)
      fetchMembers()
    } catch (err) { setFormError(err instanceof Error ? err.message : "Failed to create Xero contact") }
  }

  const openEditDialog = (member: Member) => {
    setEditingMember(member)
    setXeroChoice("")
    setXeroSearchQuery("")
    setXeroSearchResults([])
    setSelectedXeroContactId("")
    setForm({
      firstName: member.firstName,
      lastName: member.lastName,
      email: member.email,
      phoneCountryCode: member.phoneCountryCode || "",
      phoneAreaCode: member.phoneAreaCode || "",
      phoneNumber: member.phoneNumber || "",
      dateOfBirth: member.dateOfBirth ? new Date(member.dateOfBirth).toISOString().split("T")[0] : "",
      role: member.role,
      ageTier: member.ageTier,
      active: member.active,
      sendInvite: false,
      forcePasswordChange: member.forcePasswordChange,
      joinedDate: member.joinedDate ? new Date(member.joinedDate).toISOString().split("T")[0] : "",
      canLogin: member.canLogin,
      streetAddressLine1: member.streetAddressLine1 || "",
      streetAddressLine2: member.streetAddressLine2 || "",
      streetCity: member.streetCity || "",
      streetRegion: member.streetRegion || "",
      streetPostalCode: member.streetPostalCode || "",
      streetCountry: member.streetCountry || "",
      postalAddressLine1: member.postalAddressLine1 || "",
      postalAddressLine2: member.postalAddressLine2 || "",
      postalCity: member.postalCity || "",
      postalRegion: member.postalRegion || "",
      postalPostalCode: member.postalPostalCode || "",
      postalCountry: member.postalCountry || "",
    })
    setFormError("")
    setDialogOpen(true)
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
      const body: Record<string, unknown> = { firstName: form.firstName, lastName: form.lastName, email: form.email, phoneCountryCode: form.phoneCountryCode || null, phoneAreaCode: form.phoneAreaCode || null, phoneNumber: form.phoneNumber || null, dateOfBirth: form.dateOfBirth || null, role: form.role, ageTier: form.ageTier, active: form.active, canLogin: form.canLogin, joinedDate: form.joinedDate || null, streetAddressLine1: form.streetAddressLine1 || null, streetAddressLine2: form.streetAddressLine2 || null, streetCity: form.streetCity || null, streetRegion: form.streetRegion || null, streetPostalCode: form.streetPostalCode || null, streetCountry: form.streetCountry || null, postalAddressLine1: form.postalAddressLine1 || null, postalAddressLine2: form.postalAddressLine2 || null, postalCity: form.postalCity || null, postalRegion: form.postalRegion || null, postalPostalCode: form.postalPostalCode || null, postalCountry: form.postalCountry || null }
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
          const pushRes = await fetch(`/api/admin/members/${data.id}/xero-push`, { method: "POST" })
          if (!pushRes.ok) {
            const pushData = await pushRes.json().catch(() => ({}))
            warning = `Member created, but Xero contact creation failed: ${pushData.error || "Unknown error"}`
          } else {
            successMessage = "Member created and pushed to Xero"
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

  const handleSendPasswordReset = async () => {
    if (!resetPasswordTarget) return
    setResetPasswordLoading(true)
    try {
      const res = await fetch("/api/admin/members/send-password-reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memberIds: resetPasswordTarget.ids }) })
      if (!res.ok) { const data = await res.json(); throw new Error(data.error || "Failed to send password reset") }
      const data = await res.json()
      const msg = data.skipped > 0 ? `Sent ${data.sent} password reset email(s). ${data.skipped} skipped (inactive or dependent).` : `Sent ${data.sent} password reset email(s).`
      setSuccess(msg); setTimeout(() => setSuccess(""), 5000)
      setResetPasswordDialogOpen(false); setResetPasswordTarget(null); setSelectedIds(new Set())
    } catch (err) { setError(err instanceof Error ? err.message : "Failed to send password reset"); setResetPasswordDialogOpen(false) }
    finally { setResetPasswordLoading(false) }
  }

  const handleSendSetupInvite = async () => {
    if (!setupInviteTarget) return
    setSetupInviteLoading(true)
    try {
      const res = await fetch("/api/admin/members/send-setup-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberIds: setupInviteTarget.ids }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to send setup invite")
      }
      const data = await res.json()
      const msg = data.skipped > 0
        ? `Sent ${data.sent} setup invite(s). ${data.skipped} skipped (inactive or dependent).`
        : `Sent ${data.sent} setup invite(s).`
      setSuccess(msg); setTimeout(() => setSuccess(""), 5000)
      setSetupInviteDialogOpen(false); setSetupInviteTarget(null); setSelectedIds(new Set())
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send setup invite")
      setSetupInviteDialogOpen(false)
    } finally {
      setSetupInviteLoading(false)
    }
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

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div><h1 className="text-2xl font-bold text-slate-900">Members</h1><p className="mt-1 text-sm text-slate-500">{total} member{total !== 1 ? "s" : ""}{debouncedSearch ? ` matching \"${debouncedSearch}\"` : " total"}</p></div>
        <div className="flex gap-2"><a href={buildExportUrl()}><Button variant="outline" size="sm"><Download className="h-4 w-4 mr-1" />Export CSV</Button></a><Button variant="outline" size="sm" onClick={() => { setImportRows([]); setImportResult(null); setImportDialogOpen(true) }}><Upload className="h-4 w-4 mr-1" />Import CSV</Button><Button onClick={openCreateDialog}>Add Member</Button></div>
      </div>
      {error && <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-md text-sm">{error}<button onClick={() => setError("")} className="ml-2 underline">Dismiss</button></div>}
      {success && <div className="p-3 bg-green-50 border border-green-200 text-green-700 rounded-md text-sm">{success}</div>}
      {xeroConnected && !xeroFeatures.liveMemberGroupLookups && (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
          Xero group lookups are disabled by default. Member pages stay local-only until groups are refreshed explicitly from the Xero admin tools.
        </div>
      )}
      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[200px] max-w-sm"><Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name or email..." className="bg-white" /></div>
        <Select value={filters.role || "all"} onValueChange={v => setFilter("role", v === "all" ? "" : v)}><SelectTrigger className="w-[130px]"><SelectValue placeholder="Role" /></SelectTrigger><SelectContent><SelectItem value="all">All Roles</SelectItem><SelectItem value="MEMBER">Member</SelectItem><SelectItem value="ADMIN">Admin</SelectItem></SelectContent></Select>
        <Select value={filters.active || "all"} onValueChange={v => setFilter("active", v === "all" ? "" : v)}><SelectTrigger className="w-[130px]"><SelectValue placeholder="Status" /></SelectTrigger><SelectContent><SelectItem value="all">All Status</SelectItem><SelectItem value="true">Active</SelectItem><SelectItem value="false">Inactive</SelectItem></SelectContent></Select>
        <Select value={filters.ageTier || "all"} onValueChange={v => setFilter("ageTier", v === "all" ? "" : v)}><SelectTrigger className="w-[130px]"><SelectValue placeholder="Age Tier" /></SelectTrigger><SelectContent><SelectItem value="all">All Tiers</SelectItem><SelectItem value="INFANT">Infant</SelectItem><SelectItem value="CHILD">Child</SelectItem><SelectItem value="YOUTH">Youth</SelectItem><SelectItem value="ADULT">Adult</SelectItem></SelectContent></Select>
        <Select value={filters.xeroLinked || "all"} onValueChange={v => setFilter("xeroLinked", v === "all" ? "" : v)}><SelectTrigger className="w-[130px]"><SelectValue placeholder="Xero" /></SelectTrigger><SelectContent><SelectItem value="all">All Xero</SelectItem><SelectItem value="true">Linked</SelectItem><SelectItem value="false">Not Linked</SelectItem></SelectContent></Select>
        <Select value={filters.subscription || "all"} onValueChange={v => setFilter("subscription", v === "all" ? "" : v)}><SelectTrigger className="w-[150px]"><SelectValue placeholder="Subscription" /></SelectTrigger><SelectContent><SelectItem value="all">All Subs</SelectItem><SelectItem value="PAID">Paid</SelectItem><SelectItem value="UNPAID">Unpaid</SelectItem><SelectItem value="OVERDUE">Overdue</SelectItem><SelectItem value="NOT_INVOICED">Not Invoiced</SelectItem><SelectItem value="NONE">No Record</SelectItem></SelectContent></Select>
        {xeroFeatures.liveMemberGroupLookups && xeroContactGroupsList.length > 0 && <Select value={filters.xeroContactGroup || "all"} onValueChange={v => setFilter("xeroContactGroup", v === "all" ? "" : v)}><SelectTrigger className="w-[170px]"><SelectValue placeholder="Xero Group" /></SelectTrigger><SelectContent><SelectItem value="all">All Xero Groups</SelectItem>{xeroContactGroupsList.map(g => <SelectItem key={g.id} value={g.id}>{g.name} ({g.contactCount})</SelectItem>)}</SelectContent></Select>}
        {activeFilterCount > 0 && <Button variant="ghost" size="sm" onClick={clearFilters}><X className="h-4 w-4 mr-1" />Clear ({activeFilterCount})</Button>}
      </div>
      {activeFilterCount > 0 && <div className="flex flex-wrap gap-2">{Object.entries(filters).filter(([,v]) => v).map(([k, v]) => { const displayValue = k === "xeroContactGroup" ? (xeroContactGroupsList.find(g => g.id === v)?.name ?? v) : v; return <Badge key={k} variant="secondary" className="inline-flex items-center gap-1 cursor-pointer" onClick={() => setFilter(k as keyof Filters, "")}>{k}: {displayValue}<X className="h-3 w-3" /></Badge> })}</div>}
      {selectedIds.size > 0 && <div className="flex items-center gap-3 p-3 bg-blue-50 border border-blue-200 rounded-md"><span className="text-sm font-medium text-blue-700">{selectedIds.size} selected</span><Button size="sm" variant="outline" onClick={() => { setBulkAction("deactivate"); setBulkDialogOpen(true) }}>Deactivate</Button><Button size="sm" variant="outline" onClick={() => { setBulkAction("reactivate"); setBulkDialogOpen(true) }}>Reactivate</Button><Button size="sm" variant="outline" onClick={() => { setBulkAction("set-role"); setBulkDialogOpen(true) }}>Change Role</Button><Button size="sm" variant="outline" onClick={() => { setSetupInviteTarget({ ids: [...selectedIds], label: `${selectedIds.size} selected member(s)` }); setSetupInviteDialogOpen(true) }}>Send Setup Invite</Button><Button size="sm" variant="outline" onClick={() => { setResetPasswordTarget({ ids: [...selectedIds], label: `${selectedIds.size} selected member(s)` }); setResetPasswordDialogOpen(true) }}>Send Password Reset</Button><Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}><X className="h-4 w-4" /></Button></div>}

      <Card><CardHeader className="pb-0"><CardTitle className="text-base font-medium">Member List</CardTitle></CardHeader><CardContent className="pt-4">
        {loading ? <div className="py-12 text-center"><p className="text-sm text-slate-500">Loading members...</p></div>
        : members.length === 0 ? <div className="py-12 text-center"><Users className="mx-auto h-10 w-10 text-slate-300 mb-3" /><p className="text-sm font-medium text-slate-500">{debouncedSearch ? `No members found matching \"${debouncedSearch}\"` : "No members yet"}</p></div>
        : <div className="overflow-x-auto"><Table><TableHeader><TableRow>
            <TableHead className="w-10"><input type="checkbox" checked={selectedIds.size === members.length && members.length > 0} onChange={toggleSelectAll} className="h-4 w-4 rounded border-gray-300" /></TableHead>
            <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("name")}><span className="inline-flex items-center">Name<SortIcon col="name" /></span></TableHead>
            <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("email")}><span className="inline-flex items-center">Email<SortIcon col="email" /></span></TableHead>
            <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("role")}><span className="inline-flex items-center">Role<SortIcon col="role" /></span></TableHead>
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
              <TableCell className="text-right"><div className="flex justify-end gap-1"><Button variant="outline" size="sm" onClick={() => { setSetupInviteTarget({ ids: [member.id], label: `${member.firstName} ${member.lastName}` }); setSetupInviteDialogOpen(true) }}>Invite</Button><Button variant="outline" size="sm" onClick={() => { setResetPasswordTarget({ ids: [member.id], label: `${member.firstName} ${member.lastName}` }); setResetPasswordDialogOpen(true) }}>Reset Password</Button><Button variant="outline" size="sm" onClick={() => openEditDialog(member)}>Edit</Button></div></TableCell>
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
                onChange={e => setForm(f => ({ ...f, canLogin: e.target.checked, sendInvite: e.target.checked ? f.sendInvite : false }))}
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

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                          Creating a new Xero contact requires First Name, Last Name, Email, Phone, Postal Address, Physical Address, Date of Birth, and Joined Date. Save changes first, then create.
                        </div>
                        <Button type="button" size="sm" onClick={() => handleXeroPush(editingMember.id)} disabled={(() => { const m = getMissingFieldsForXeroCreate(form); return m.length > 0 })()}>
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
                      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                        Creating a new Xero contact requires First Name, Last Name, Email, Phone, Postal Address, Physical Address, Date of Birth, and Joined Date.
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
      <Dialog open={bulkDialogOpen} onOpenChange={setBulkDialogOpen}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>Bulk {bulkAction === "set-role" ? "Change Role" : bulkAction === "deactivate" ? "Deactivate" : "Reactivate"}</DialogTitle><DialogDescription>This will affect {selectedIds.size} selected member(s).</DialogDescription></DialogHeader>{bulkAction === "set-role" && <div className="space-y-2"><Label>New Role</Label><Select value={bulkRole} onValueChange={v => setBulkRole(v as "MEMBER" | "ADMIN")}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="MEMBER">Member</SelectItem><SelectItem value="ADMIN">Admin</SelectItem></SelectContent></Select></div>}<DialogFooter><Button variant="outline" onClick={() => setBulkDialogOpen(false)} disabled={bulkLoading}>Cancel</Button><Button onClick={handleBulkAction} disabled={bulkLoading} variant={bulkAction === "deactivate" ? "destructive" : "default"}>{bulkLoading ? "Processing..." : "Confirm"}</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={setupInviteDialogOpen} onOpenChange={setSetupInviteDialogOpen}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>Send Account Setup Invite</DialogTitle><DialogDescription>Send a first-time password setup email to {setupInviteTarget?.label}. They will receive a link to activate their account and choose a password (expires in {MEMBER_SETUP_INVITE_TTL_DAYS} days).</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => { setSetupInviteDialogOpen(false); setSetupInviteTarget(null) }} disabled={setupInviteLoading}>Cancel</Button><Button onClick={handleSendSetupInvite} disabled={setupInviteLoading}>{setupInviteLoading ? "Sending..." : "Send Invite"}</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={resetPasswordDialogOpen} onOpenChange={setResetPasswordDialogOpen}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>Send Password Reset</DialogTitle><DialogDescription>Send a password reset email to {resetPasswordTarget?.label}. They will receive a link to set a new password (expires in 1 hour).</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => { setResetPasswordDialogOpen(false); setResetPasswordTarget(null) }} disabled={resetPasswordLoading}>Cancel</Button><Button onClick={handleSendPasswordReset} disabled={resetPasswordLoading}>{resetPasswordLoading ? "Sending..." : "Send Reset Email"}</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}><DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>Import Members from CSV</DialogTitle><DialogDescription>Upload a CSV with columns: First Name, Last Name, Email, Phone (optional), Date of Birth (optional), Role (optional).</DialogDescription></DialogHeader><div className="space-y-4"><div><Label htmlFor="csvFile">CSV File</Label><Input id="csvFile" type="file" accept=".csv" onChange={handleFileUpload} className="mt-1" /></div>{importRows.length > 0 && !importResult && <div><p className="text-sm font-medium mb-2">{importRows.length} rows parsed</p><div className="max-h-48 overflow-y-auto border rounded text-xs"><Table><TableHeader><TableRow><TableHead>First Name</TableHead><TableHead>Last Name</TableHead><TableHead>Email</TableHead><TableHead>Role</TableHead></TableRow></TableHeader><TableBody>{importRows.slice(0, 10).map((row, i) => <TableRow key={i}><TableCell>{row.firstName}</TableCell><TableCell>{row.lastName}</TableCell><TableCell>{row.email}</TableCell><TableCell>{row.role || "MEMBER"}</TableCell></TableRow>)}</TableBody></Table>{importRows.length > 10 && <p className="text-xs text-slate-500 p-2">...and {importRows.length - 10} more</p>}</div><div className="flex items-center gap-2 mt-3"><input type="checkbox" id="sendInvites" checked={importSendInvites} onChange={e => setImportSendInvites(e.target.checked)} className="h-4 w-4 rounded border-gray-300" /><Label htmlFor="sendInvites">Send account setup invites ({MEMBER_SETUP_INVITE_TTL_DAYS}-day links)</Label></div></div>}{importResult && <div className="space-y-2"><p className="text-sm"><span className="font-medium text-green-700">{importResult.created} created</span>, <span className="font-medium text-yellow-700">{importResult.skipped} skipped</span>, <span className="font-medium text-red-700">{importResult.errors.length} errors</span></p>{importResult.errors.length > 0 && <div className="max-h-32 overflow-y-auto text-xs text-red-600 border border-red-200 rounded p-2">{importResult.errors.map((e, i) => <p key={i}>Row {e.row}: {e.errors.join(", ")}</p>)}</div>}</div>}</div><DialogFooter><Button variant="outline" onClick={() => setImportDialogOpen(false)}>Close</Button>{importRows.length > 0 && !importResult && <Button onClick={handleImport} disabled={importLoading}>{importLoading ? "Importing..." : `Import ${importRows.length} Members`}</Button>}</DialogFooter></DialogContent></Dialog>
    </div>
  )
}
