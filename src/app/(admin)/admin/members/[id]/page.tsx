"use client"

import { useEffect, useState, use } from "react"
import { useSession } from "next-auth/react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ArrowLeft, ExternalLink, User, Calendar, CreditCard, Clock, Pencil } from "lucide-react"

interface MemberDetail {
  id: string; firstName: string; lastName: string; email: string
  phone: string | null; dateOfBirth: string | null
  role: "MEMBER" | "ADMIN"; ageTier: "ADULT" | "YOUTH" | "CHILD"
  active: boolean; forcePasswordChange: boolean; xeroContactId: string | null; joinedDate: string | null; createdAt: string
  parentMemberId: string | null
  parent: { id: string; firstName: string; lastName: string } | null
  secondaryParentId: string | null
  secondaryParent: { id: string; firstName: string; lastName: string } | null
  _count: { dependents: number; secondaryDependents: number }
  subscriptions: Array<{ id: string; seasonYear: number; status: string; xeroInvoiceId: string | null; paidAt: string | null }>
  bookings: Array<{ id: string; checkIn: string; checkOut: string; status: string; finalPriceCents: number; _count: { guests: number } }>
  auditLogs: Array<{ id: string; action: string; details: string | null; createdAt: string }>
  stats: { totalBookings: number; totalSpendCents: number; lastStay: string | null }
}

interface EditForm {
  firstName: string; lastName: string; email: string; phone: string
  dateOfBirth: string; role: "MEMBER" | "ADMIN"; active: boolean; forcePasswordChange: boolean
}

export default function MemberDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const { data: session } = useSession()
  const [member, setMember] = useState<MemberDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")
  const [editOpen, setEditOpen] = useState(false)
  const [form, setForm] = useState<EditForm>({ firstName: "", lastName: "", email: "", phone: "", dateOfBirth: "", role: "MEMBER", active: true, forcePasswordChange: false })
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState("")

  const fetchMember = async () => {
    try {
      const res = await fetch(`/api/admin/members/${id}`)
      if (!res.ok) { setError(res.status === 404 ? "Member not found" : "Failed to load member"); setLoading(false); return }
      setMember(await res.json())
    } catch { setError("Failed to load member") }
    finally { setLoading(false) }
  }

  useEffect(() => { fetchMember() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  const openEditDialog = () => {
    if (!member) return
    setForm({
      firstName: member.firstName,
      lastName: member.lastName,
      email: member.email,
      phone: member.phone || "",
      dateOfBirth: member.dateOfBirth ? new Date(member.dateOfBirth).toISOString().split("T")[0] : "",
      role: member.role,
      active: member.active,
      forcePasswordChange: member.forcePasswordChange,
    })
    setFormError("")
    setEditOpen(true)
  }

  const handleSave = async () => {
    setSaving(true); setFormError("")
    try {
      const res = await fetch(`/api/admin/members/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: form.firstName,
          lastName: form.lastName,
          email: form.email,
          phone: form.phone || null,
          dateOfBirth: form.dateOfBirth || null,
          role: form.role,
          active: form.active,
          forcePasswordChange: form.forcePasswordChange,
        }),
      })
      if (!res.ok) { const data = await res.json(); throw new Error(data.error || "Save failed") }
      setEditOpen(false)
      setSuccess("Member updated successfully")
      setTimeout(() => setSuccess(""), 3000)
      setLoading(true)
      await fetchMember()
    } catch (err) { setFormError(err instanceof Error ? err.message : "Save failed") }
    finally { setSaving(false) }
  }

  const isSelf = session?.user?.id === id

  if (loading) return <div className="py-12 text-center"><p className="text-sm text-slate-500">Loading member details...</p></div>
  if (error || !member) return (
    <div className="space-y-4">
      <Button variant="outline" onClick={() => router.push("/admin/members")}><ArrowLeft className="h-4 w-4 mr-2" />Back to Members</Button>
      <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-md text-sm">{error || "Member not found"}</div>
    </div>
  )

  const fmt = (cents: number) => new Intl.NumberFormat("en-NZ", { style: "currency", currency: "NZD" }).format(cents / 100)
  const fmtDate = (d: string) => new Date(d).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" })
  const subCls = (s: string) => s === "PAID" ? "bg-green-100 text-green-800 border-green-200" : s === "OVERDUE" ? "bg-red-100 text-red-800 border-red-200" : s === "UNPAID" ? "bg-yellow-100 text-yellow-800 border-yellow-200" : "bg-slate-100 text-slate-600 border-slate-200"
  const bkCls = (s: string) => s === "CONFIRMED" ? "bg-green-100 text-green-800 border-green-200" : s === "COMPLETED" ? "bg-blue-100 text-blue-800 border-blue-200" : s === "CANCELLED" ? "bg-red-100 text-red-800 border-red-200" : s === "BUMPED" ? "bg-orange-100 text-orange-800 border-orange-200" : "bg-yellow-100 text-yellow-800 border-yellow-200"

  return (
    <div className="space-y-6">
      <div>
        <Button variant="ghost" size="sm" className="mb-2 -ml-2" onClick={() => router.push("/admin/members")}><ArrowLeft className="h-4 w-4 mr-1" /> Back to Members</Button>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">{member.firstName} {member.lastName}</h1>
            <p className="mt-1 text-sm text-slate-500">{member.email}</p>
            <div className="flex flex-wrap gap-2 mt-2">
              <Badge variant={member.role === "ADMIN" ? "default" : "secondary"} className={member.role === "ADMIN" ? "bg-blue-600 text-white hover:bg-blue-700" : ""}>{member.role}</Badge>
              <Badge variant={member.active ? "default" : "destructive"} className={member.active ? "bg-green-100 text-green-800 hover:bg-green-200 border-green-200" : ""}>{member.active ? "Active" : "Inactive"}</Badge>
              {member.forcePasswordChange && <Badge variant="destructive" className="text-xs">PW Reset Required</Badge>}
            </div>
          </div>
          <div className="flex gap-2 shrink-0">
            {member.xeroContactId && (
              <a href={`https://go.xero.com/Contacts/View/${member.xeroContactId}`} target="_blank" rel="noopener noreferrer">
                <Button variant="outline" size="sm"><ExternalLink className="h-4 w-4 mr-1" />View in Xero</Button>
              </a>
            )}
            <Button size="sm" onClick={openEditDialog}><Pencil className="h-4 w-4 mr-1" />Edit Member</Button>
          </div>
        </div>
      </div>

      {success && <div className="p-3 bg-green-50 border border-green-200 text-green-700 rounded-md text-sm">{success}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card><CardContent className="pt-6"><div className="flex items-center gap-3"><User className="h-8 w-8 text-slate-400" /><div><p className="text-xs text-slate-500 uppercase tracking-wide">Age Tier</p><p className="text-lg font-semibold">{member.ageTier.charAt(0) + member.ageTier.slice(1).toLowerCase()}</p>{member.dateOfBirth && <p className="text-xs text-slate-400">DOB: {fmtDate(member.dateOfBirth)}</p>}</div></div></CardContent></Card>
        <Card><CardContent className="pt-6"><div className="flex items-center gap-3"><Calendar className="h-8 w-8 text-slate-400" /><div><p className="text-xs text-slate-500 uppercase tracking-wide">Total Bookings</p><p className="text-lg font-semibold">{member.stats.totalBookings}</p></div></div></CardContent></Card>
        <Card><CardContent className="pt-6"><div className="flex items-center gap-3"><CreditCard className="h-8 w-8 text-slate-400" /><div><p className="text-xs text-slate-500 uppercase tracking-wide">Total Spend</p><p className="text-lg font-semibold">{fmt(member.stats.totalSpendCents)}</p></div></div></CardContent></Card>
        <Card><CardContent className="pt-6"><div className="flex items-center gap-3"><Clock className="h-8 w-8 text-slate-400" /><div><p className="text-xs text-slate-500 uppercase tracking-wide">Last Stay</p><p className="text-lg font-semibold">{member.stats.lastStay ? fmtDate(member.stats.lastStay) : "Never"}</p></div></div></CardContent></Card>
      </div>

      <Card><CardHeader><CardTitle className="text-base font-medium">Member Information</CardTitle></CardHeader><CardContent><dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
        <div><dt className="text-slate-500">Phone</dt><dd className="font-medium">{member.phone || "Not provided"}</dd></div>
        <div><dt className="text-slate-500">Member Since</dt><dd className="font-medium">{fmtDate(member.joinedDate || member.createdAt)}{member.joinedDate && <span className="text-xs text-slate-400 ml-1">(from Xero)</span>}</dd></div>
        <div><dt className="text-slate-500">Type</dt><dd className="font-medium">{member.parentMemberId ? <><Badge variant="secondary" className="bg-purple-100 text-purple-800 border-purple-200">Dependent</Badge>{member.parent && <span className="ml-1 text-xs">of {member.parent.firstName} {member.parent.lastName}</span>}{member.secondaryParent && <span className="ml-1 text-xs">& {member.secondaryParent.firstName} {member.secondaryParent.lastName}</span>}</> : <><Badge variant="secondary" className="bg-slate-100 text-slate-700 border-slate-200">Primary</Badge>{(member._count.dependents + member._count.secondaryDependents) > 0 && <span className="ml-1 text-xs">{member._count.dependents + member._count.secondaryDependents} dependent(s)</span>}</>}</dd></div>
        <div><dt className="text-slate-500">Xero Contact ID</dt><dd className="font-medium">{member.xeroContactId ? <a href={`https://go.xero.com/Contacts/View/${member.xeroContactId}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline inline-flex items-center gap-1">{member.xeroContactId}<ExternalLink className="h-3 w-3" /></a> : "Not linked"}</dd></div>
      </dl></CardContent></Card>

      <Card><CardHeader><CardTitle className="text-base font-medium">Subscription History</CardTitle></CardHeader><CardContent>
        {member.subscriptions.length === 0 ? <p className="text-sm text-slate-500">No subscription records</p> : (
          <Table><TableHeader><TableRow><TableHead>Season Year</TableHead><TableHead>Status</TableHead><TableHead>Paid At</TableHead><TableHead>Xero Invoice</TableHead></TableRow></TableHeader><TableBody>{member.subscriptions.map((sub) => (
            <TableRow key={sub.id}><TableCell className="font-medium">{sub.seasonYear}/{sub.seasonYear + 1}</TableCell><TableCell><Badge variant="secondary" className={subCls(sub.status)}>{sub.status.replace("_", " ")}</Badge></TableCell><TableCell>{sub.paidAt ? fmtDate(sub.paidAt) : "-"}</TableCell><TableCell>{sub.xeroInvoiceId ? <a href={`https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${sub.xeroInvoiceId}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline inline-flex items-center gap-1">View <ExternalLink className="h-3 w-3" /></a> : "-"}</TableCell></TableRow>
          ))}</TableBody></Table>)}
      </CardContent></Card>

      <Card><CardHeader><CardTitle className="text-base font-medium">Booking History</CardTitle></CardHeader><CardContent>
        {member.bookings.length === 0 ? <p className="text-sm text-slate-500">No bookings yet</p> : (
          <Table><TableHeader><TableRow><TableHead>Check In</TableHead><TableHead>Check Out</TableHead><TableHead>Status</TableHead><TableHead>Guests</TableHead><TableHead>Amount</TableHead></TableRow></TableHeader><TableBody>{member.bookings.map((booking) => (
            <TableRow key={booking.id}><TableCell>{fmtDate(booking.checkIn)}</TableCell><TableCell>{fmtDate(booking.checkOut)}</TableCell><TableCell><Badge variant="secondary" className={bkCls(booking.status)}>{booking.status}</Badge></TableCell><TableCell>{booking._count.guests}</TableCell><TableCell>{fmt(booking.finalPriceCents)}</TableCell></TableRow>
          ))}</TableBody></Table>)}
      </CardContent></Card>

      <Card><CardHeader><CardTitle className="text-base font-medium">Audit Log</CardTitle></CardHeader><CardContent>
        {member.auditLogs.length === 0 ? <p className="text-sm text-slate-500">No audit records</p> : (
          <div className="space-y-3">{member.auditLogs.map((log) => (
            <div key={log.id} className="flex items-start justify-between border-b border-slate-100 pb-2 last:border-0"><div><p className="text-sm font-medium text-slate-700">{log.action}</p>{log.details && <p className="text-xs text-slate-500 mt-0.5">{log.details}</p>}</div><span className="text-xs text-slate-400 whitespace-nowrap ml-4">{fmtDate(log.createdAt)}</span></div>
          ))}</div>)}
      </CardContent></Card>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Member</DialogTitle>
            <DialogDescription>Update details for {member.firstName} {member.lastName}.</DialogDescription>
          </DialogHeader>
          {formError && <div className="p-2 bg-red-50 border border-red-200 text-red-700 rounded text-sm">{formError}</div>}
          <div className="grid gap-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-firstName">First Name *</Label>
                <Input id="edit-firstName" value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-lastName">Last Name *</Label>
                <Input id="edit-lastName" value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-email">Email *</Label>
              <Input id="edit-email" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-phone">Phone</Label>
              <Input id="edit-phone" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-dateOfBirth">Date of Birth</Label>
              <Input id="edit-dateOfBirth" type="date" value={form.dateOfBirth} onChange={e => setForm(f => ({ ...f, dateOfBirth: e.target.value }))} />
              <p className="text-xs text-muted-foreground">Age tier is calculated automatically from date of birth.</p>
            </div>
            <div className="space-y-2">
              <Label>Role</Label>
              <Select value={form.role} onValueChange={v => setForm(f => ({ ...f, role: v as "MEMBER" | "ADMIN" }))} disabled={isSelf}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="MEMBER">Member</SelectItem>
                  <SelectItem value="ADMIN">Admin</SelectItem>
                </SelectContent>
              </Select>
              {isSelf && <p className="text-xs text-muted-foreground">You cannot change your own role.</p>}
            </div>
            <div className="flex items-center gap-2">
              <input type="checkbox" id="edit-active" checked={form.active} onChange={e => setForm(f => ({ ...f, active: e.target.checked }))} className="h-4 w-4 rounded border-gray-300" disabled={isSelf} />
              <Label htmlFor="edit-active">Active</Label>
              {isSelf && <span className="text-xs text-muted-foreground ml-1">(cannot deactivate own account)</span>}
            </div>
            <div className="flex items-center gap-2">
              <input type="checkbox" id="edit-forcePasswordChange" checked={form.forcePasswordChange} onChange={e => setForm(f => ({ ...f, forcePasswordChange: e.target.checked }))} className="h-4 w-4 rounded border-gray-300" />
              <Label htmlFor="edit-forcePasswordChange">Force Password Change on Next Login</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>{saving ? "Saving..." : "Save Changes"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
