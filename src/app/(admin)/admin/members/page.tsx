"use client"

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

interface Member {
  id: string; firstName: string; lastName: string; email: string
  phone: string | null; dateOfBirth: string | null
  role: "MEMBER" | "ADMIN"; ageTier: "ADULT" | "YOUTH" | "CHILD"
  active: boolean; xeroContactId: string | null
  subscriptionStatus: "NOT_INVOICED" | "UNPAID" | "PAID" | "OVERDUE" | null
  subscriptionXeroInvoiceId: string | null; createdAt: string
}

interface MemberForm {
  firstName: string; lastName: string; email: string; phone: string
  dateOfBirth: string; role: "MEMBER" | "ADMIN"; ageTier: "ADULT" | "YOUTH" | "CHILD"
  active: boolean; sendInvite: boolean
}

interface Filters { role: string; active: string; ageTier: string; xeroLinked: string; subscription: string }
interface ImportRow { firstName: string; lastName: string; email: string; phone?: string; dateOfBirth?: string; role?: string }

const emptyForm: MemberForm = { firstName: "", lastName: "", email: "", phone: "", dateOfBirth: "", role: "MEMBER", ageTier: "ADULT", active: true, sendInvite: false }
const emptyFilters: Filters = { role: "", active: "", ageTier: "", xeroLinked: "", subscription: "" }
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
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [importRows, setImportRows] = useState<ImportRow[]>([])
  const [importSendInvites, setImportSendInvites] = useState(false)
  const [importLoading, setImportLoading] = useState(false)
  const [importResult, setImportResult] = useState<{ created: number; skipped: number; errors: Array<{ row: number; errors: string[] }> } | null>(null)

  useEffect(() => { const t = setTimeout(() => setDebouncedSearch(search), 300); return () => clearTimeout(t) }, [search])

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
  const toggleSelect = (id: string) => setSelectedIds(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const toggleSelectAll = () => { if (selectedIds.size === members.length) setSelectedIds(new Set()); else setSelectedIds(new Set(members.map(m => m.id))) }
  const openCreateDialog = () => { setEditingMember(null); setForm(emptyForm); setFormError(""); setDialogOpen(true) }
  const openEditDialog = (member: Member) => { setEditingMember(member); setForm({ firstName: member.firstName, lastName: member.lastName, email: member.email, phone: member.phone || "", dateOfBirth: member.dateOfBirth ? new Date(member.dateOfBirth).toISOString().split("T")[0] : "", role: member.role, ageTier: member.ageTier, active: member.active, sendInvite: false }); setFormError(""); setDialogOpen(true) }

  const handleSave = async () => {
    setSaving(true); setFormError("")
    try {
      const url = editingMember ? `/api/admin/members/${editingMember.id}` : "/api/admin/members"
      const body: Record<string, unknown> = { firstName: form.firstName, lastName: form.lastName, email: form.email, phone: form.phone || null, dateOfBirth: form.dateOfBirth || null, role: form.role, ageTier: form.ageTier, active: form.active }
      if (!editingMember) body.sendInvite = form.sendInvite
      const res = await fetch(url, { method: editingMember ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      if (!res.ok) { const data = await res.json(); throw new Error(data.error || "Save failed") }
      setDialogOpen(false); setSuccess(editingMember ? "Member updated" : "Member created"); setTimeout(() => setSuccess(""), 3000); fetchMembers()
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
      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[200px] max-w-sm"><Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name or email..." className="bg-white" /></div>
        <Select value={filters.role || "all"} onValueChange={v => setFilter("role", v === "all" ? "" : v)}><SelectTrigger className="w-[130px]"><SelectValue placeholder="Role" /></SelectTrigger><SelectContent><SelectItem value="all">All Roles</SelectItem><SelectItem value="MEMBER">Member</SelectItem><SelectItem value="ADMIN">Admin</SelectItem></SelectContent></Select>
        <Select value={filters.active || "all"} onValueChange={v => setFilter("active", v === "all" ? "" : v)}><SelectTrigger className="w-[130px]"><SelectValue placeholder="Status" /></SelectTrigger><SelectContent><SelectItem value="all">All Status</SelectItem><SelectItem value="true">Active</SelectItem><SelectItem value="false">Inactive</SelectItem></SelectContent></Select>
        <Select value={filters.ageTier || "all"} onValueChange={v => setFilter("ageTier", v === "all" ? "" : v)}><SelectTrigger className="w-[130px]"><SelectValue placeholder="Age Tier" /></SelectTrigger><SelectContent><SelectItem value="all">All Tiers</SelectItem><SelectItem value="ADULT">Adult</SelectItem><SelectItem value="YOUTH">Youth</SelectItem><SelectItem value="CHILD">Child</SelectItem></SelectContent></Select>
        <Select value={filters.xeroLinked || "all"} onValueChange={v => setFilter("xeroLinked", v === "all" ? "" : v)}><SelectTrigger className="w-[130px]"><SelectValue placeholder="Xero" /></SelectTrigger><SelectContent><SelectItem value="all">All Xero</SelectItem><SelectItem value="true">Linked</SelectItem><SelectItem value="false">Not Linked</SelectItem></SelectContent></Select>
        <Select value={filters.subscription || "all"} onValueChange={v => setFilter("subscription", v === "all" ? "" : v)}><SelectTrigger className="w-[150px]"><SelectValue placeholder="Subscription" /></SelectTrigger><SelectContent><SelectItem value="all">All Subs</SelectItem><SelectItem value="PAID">Paid</SelectItem><SelectItem value="UNPAID">Unpaid</SelectItem><SelectItem value="OVERDUE">Overdue</SelectItem><SelectItem value="NOT_INVOICED">Not Invoiced</SelectItem><SelectItem value="NONE">No Record</SelectItem></SelectContent></Select>
        {activeFilterCount > 0 && <Button variant="ghost" size="sm" onClick={clearFilters}><X className="h-4 w-4 mr-1" />Clear ({activeFilterCount})</Button>}
      </div>
      {activeFilterCount > 0 && <div className="flex flex-wrap gap-2">{Object.entries(filters).filter(([,v]) => v).map(([k, v]) => <Badge key={k} variant="secondary" className="inline-flex items-center gap-1 cursor-pointer" onClick={() => setFilter(k as keyof Filters, "")}>{k}: {v}<X className="h-3 w-3" /></Badge>)}</div>}
      {selectedIds.size > 0 && <div className="flex items-center gap-3 p-3 bg-blue-50 border border-blue-200 rounded-md"><span className="text-sm font-medium text-blue-700">{selectedIds.size} selected</span><Button size="sm" variant="outline" onClick={() => { setBulkAction("deactivate"); setBulkDialogOpen(true) }}>Deactivate</Button><Button size="sm" variant="outline" onClick={() => { setBulkAction("reactivate"); setBulkDialogOpen(true) }}>Reactivate</Button><Button size="sm" variant="outline" onClick={() => { setBulkAction("set-role"); setBulkDialogOpen(true) }}>Change Role</Button><Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}><X className="h-4 w-4" /></Button></div>}

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
            <TableHead>Subscription</TableHead><TableHead>Xero</TableHead>
            <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("createdAt")}><span className="inline-flex items-center">Joined<SortIcon col="createdAt" /></span></TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow></TableHeader><TableBody>
            {members.map(member => <TableRow key={member.id} className="hover:bg-slate-50">
              <TableCell><input type="checkbox" checked={selectedIds.has(member.id)} onChange={() => toggleSelect(member.id)} className="h-4 w-4 rounded border-gray-300" /></TableCell>
              <TableCell className="font-medium"><Link href={`/admin/members/${member.id}`} className="text-blue-600 hover:underline">{member.firstName} {member.lastName}</Link></TableCell>
              <TableCell className="text-slate-600">{member.email}</TableCell>
              <TableCell><Badge variant={member.role === "ADMIN" ? "default" : "secondary"} className={member.role === "ADMIN" ? "bg-blue-600 text-white hover:bg-blue-700" : ""}>{member.role}</Badge></TableCell>
              <TableCell><span className="text-sm text-slate-600">{member.ageTier.charAt(0) + member.ageTier.slice(1).toLowerCase()}</span></TableCell>
              <TableCell><Badge variant={member.active ? "default" : "destructive"} className={member.active ? "bg-green-100 text-green-800 hover:bg-green-200 border-green-200" : ""}>{member.active ? "Active" : "Inactive"}</Badge></TableCell>
              <TableCell>{member.subscriptionStatus ? (() => { const cfg = statusConfig[member.subscriptionStatus] || statusConfig.NOT_INVOICED; const badge = <Badge variant="secondary" className={`${cfg.className} ${member.subscriptionXeroInvoiceId ? "cursor-pointer inline-flex items-center gap-1" : ""}`}>{cfg.label}{member.subscriptionXeroInvoiceId && <ExternalLink className="h-3 w-3" />}</Badge>; return member.subscriptionXeroInvoiceId ? <a href={`https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${member.subscriptionXeroInvoiceId}`} target="_blank" rel="noopener noreferrer">{badge}</a> : badge })() : <span className="text-xs text-slate-400">-</span>}</TableCell>
              <TableCell>{member.xeroContactId ? <a href={`https://go.xero.com/app/contacts/contact/${member.xeroContactId}`} target="_blank" rel="noopener noreferrer"><Badge variant="secondary" className="bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 cursor-pointer inline-flex items-center gap-1">Linked<ExternalLink className="h-3 w-3" /></Badge></a> : <span className="text-xs text-slate-400">-</span>}</TableCell>
              <TableCell className="text-slate-500 text-sm">{new Date(member.createdAt).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" })}</TableCell>
              <TableCell className="text-right"><Button variant="outline" size="sm" onClick={() => openEditDialog(member)}>Edit</Button></TableCell>
            </TableRow>)}
          </TableBody></Table></div>}
        {totalPages > 1 && <div className="flex items-center justify-between mt-4 pt-4 border-t"><p className="text-sm text-slate-500">Page {page} of {totalPages}</p><div className="flex gap-1"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}><ChevronLeft className="h-4 w-4" /></Button>{Array.from({ length: Math.min(5, totalPages) }, (_, i) => { let pn: number; if (totalPages <= 5) pn = i + 1; else if (page <= 3) pn = i + 1; else if (page >= totalPages - 2) pn = totalPages - 4 + i; else pn = page - 2 + i; return <Button key={pn} variant={pn === page ? "default" : "outline"} size="sm" onClick={() => setPage(pn)}>{pn}</Button> })}<Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}><ChevronRight className="h-4 w-4" /></Button></div></div>}
      </CardContent></Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>{editingMember ? "Edit Member" : "Add Member"}</DialogTitle><DialogDescription>{editingMember ? "Update the member details." : "Create a new member account."}</DialogDescription></DialogHeader>{formError && <div className="p-2 bg-red-50 border border-red-200 text-red-700 rounded text-sm">{formError}</div>}<div className="grid gap-4 py-2"><div className="grid grid-cols-2 gap-4"><div className="space-y-2"><Label htmlFor="firstName">First Name *</Label><Input id="firstName" value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))} /></div><div className="space-y-2"><Label htmlFor="lastName">Last Name *</Label><Input id="lastName" value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))} /></div></div><div className="space-y-2"><Label htmlFor="email">Email *</Label><Input id="email" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} /></div><div className="space-y-2"><Label htmlFor="phone">Phone</Label><Input id="phone" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} /></div><div className="space-y-2"><Label htmlFor="dateOfBirth">Date of Birth</Label><Input id="dateOfBirth" type="date" value={form.dateOfBirth} onChange={e => setForm(f => ({ ...f, dateOfBirth: e.target.value }))} /><p className="text-xs text-muted-foreground">Age tier is calculated automatically from date of birth.</p></div><div className="grid grid-cols-2 gap-4"><div className="space-y-2"><Label>Role</Label><Select value={form.role} onValueChange={v => setForm(f => ({ ...f, role: v as "MEMBER" | "ADMIN" }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="MEMBER">Member</SelectItem><SelectItem value="ADMIN">Admin</SelectItem></SelectContent></Select></div><div className="space-y-2"><Label>Age Tier</Label><Select value={form.ageTier} onValueChange={v => setForm(f => ({ ...f, ageTier: v as "ADULT" | "YOUTH" | "CHILD" }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ADULT">Adult</SelectItem><SelectItem value="YOUTH">Youth</SelectItem><SelectItem value="CHILD">Child</SelectItem></SelectContent></Select></div></div>{editingMember && <div className="flex items-center gap-2"><input type="checkbox" id="active" checked={form.active} onChange={e => setForm(f => ({ ...f, active: e.target.checked }))} className="h-4 w-4 rounded border-gray-300" /><Label htmlFor="active">Active</Label></div>}{!editingMember && <div className="flex items-center gap-2"><input type="checkbox" id="sendInvite" checked={form.sendInvite} onChange={e => setForm(f => ({ ...f, sendInvite: e.target.checked }))} className="h-4 w-4 rounded border-gray-300" /><Label htmlFor="sendInvite">Send invite email (password reset link)</Label></div>}</div><DialogFooter><Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>Cancel</Button><Button onClick={handleSave} disabled={saving}>{saving ? "Saving..." : editingMember ? "Save Changes" : "Create Member"}</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={bulkDialogOpen} onOpenChange={setBulkDialogOpen}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>Bulk {bulkAction === "set-role" ? "Change Role" : bulkAction === "deactivate" ? "Deactivate" : "Reactivate"}</DialogTitle><DialogDescription>This will affect {selectedIds.size} selected member(s).</DialogDescription></DialogHeader>{bulkAction === "set-role" && <div className="space-y-2"><Label>New Role</Label><Select value={bulkRole} onValueChange={v => setBulkRole(v as "MEMBER" | "ADMIN")}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="MEMBER">Member</SelectItem><SelectItem value="ADMIN">Admin</SelectItem></SelectContent></Select></div>}<DialogFooter><Button variant="outline" onClick={() => setBulkDialogOpen(false)} disabled={bulkLoading}>Cancel</Button><Button onClick={handleBulkAction} disabled={bulkLoading} variant={bulkAction === "deactivate" ? "destructive" : "default"}>{bulkLoading ? "Processing..." : "Confirm"}</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}><DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>Import Members from CSV</DialogTitle><DialogDescription>Upload a CSV with columns: First Name, Last Name, Email, Phone (optional), Date of Birth (optional), Role (optional).</DialogDescription></DialogHeader><div className="space-y-4"><div><Label htmlFor="csvFile">CSV File</Label><Input id="csvFile" type="file" accept=".csv" onChange={handleFileUpload} className="mt-1" /></div>{importRows.length > 0 && !importResult && <div><p className="text-sm font-medium mb-2">{importRows.length} rows parsed</p><div className="max-h-48 overflow-y-auto border rounded text-xs"><Table><TableHeader><TableRow><TableHead>First Name</TableHead><TableHead>Last Name</TableHead><TableHead>Email</TableHead><TableHead>Role</TableHead></TableRow></TableHeader><TableBody>{importRows.slice(0, 10).map((row, i) => <TableRow key={i}><TableCell>{row.firstName}</TableCell><TableCell>{row.lastName}</TableCell><TableCell>{row.email}</TableCell><TableCell>{row.role || "MEMBER"}</TableCell></TableRow>)}</TableBody></Table>{importRows.length > 10 && <p className="text-xs text-slate-500 p-2">...and {importRows.length - 10} more</p>}</div><div className="flex items-center gap-2 mt-3"><input type="checkbox" id="sendInvites" checked={importSendInvites} onChange={e => setImportSendInvites(e.target.checked)} className="h-4 w-4 rounded border-gray-300" /><Label htmlFor="sendInvites">Send invite emails</Label></div></div>}{importResult && <div className="space-y-2"><p className="text-sm"><span className="font-medium text-green-700">{importResult.created} created</span>, <span className="font-medium text-yellow-700">{importResult.skipped} skipped</span>, <span className="font-medium text-red-700">{importResult.errors.length} errors</span></p>{importResult.errors.length > 0 && <div className="max-h-32 overflow-y-auto text-xs text-red-600 border border-red-200 rounded p-2">{importResult.errors.map((e, i) => <p key={i}>Row {e.row}: {e.errors.join(", ")}</p>)}</div>}</div>}</div><DialogFooter><Button variant="outline" onClick={() => setImportDialogOpen(false)}>Close</Button>{importRows.length > 0 && !importResult && <Button onClick={handleImport} disabled={importLoading}>{importLoading ? "Importing..." : `Import ${importRows.length} Members`}</Button>}</DialogFooter></DialogContent></Dialog>
    </div>
  )
}
