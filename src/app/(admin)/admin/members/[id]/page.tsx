"use client"

import { useEffect, useState, use } from "react"
import { useSession } from "next-auth/react"
import { useRouter } from "next/navigation"
import { MemberAddressFields } from "@/components/member-address-fields"
import { XeroRecordActivityPanel } from "@/components/admin/xero-record-activity-panel"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ArrowLeft, ExternalLink, User, Calendar, CreditCard, Clock, Pencil, Search, Link2, Plus } from "lucide-react"
import {
  NZ_COUNTRY_CODE,
  postalMatchesPhysical,
  withDefaultNzCountry,
  type MemberAddressValues,
} from "@/lib/member-address"
import { bookingStatusClass, bookingStatusLabel, subscriptionStatusClass } from "@/lib/status-colors"

interface XeroSearchResult {
  contactId: string; name: string; email: string | null; isLinked: boolean; linkedMemberName: string | null
}

interface MemberDetail {
  id: string; firstName: string; lastName: string; email: string
  phoneCountryCode: string | null; phoneAreaCode: string | null; phoneNumber: string | null
  dateOfBirth: string | null
  role: "MEMBER" | "ADMIN"; ageTier: string
  active: boolean; forcePasswordChange: boolean; xeroContactId: string | null; joinedDate: string | null; createdAt: string
  canLogin: boolean
  xeroContactGroups: Array<{ id: string; name: string }>
  inheritEmailFromId: string | null
  inheritEmailFrom: { id: string; firstName: string; lastName: string; email: string } | null
  familyGroups: { id: string; name: string | null }[]
  subscriptions: Array<{ id: string; seasonYear: number; status: string; xeroInvoiceId: string | null; paidAt: string | null }>
  bookings: Array<{ id: string; checkIn: string; checkOut: string; status: string; finalPriceCents: number; _count: { guests: number } }>
  auditLogs: Array<{ id: string; action: string; details: string | null; createdAt: string }>
  stats: { totalBookings: number; totalSpendCents: number; lastStay: string | null }
  dependents: Array<{ id: string; firstName: string; lastName: string; ageTier: string; active: boolean; dateOfBirth: string | null; canLogin: boolean }>
  streetAddressLine1: string | null; streetAddressLine2: string | null; streetCity: string | null
  streetRegion: string | null; streetPostalCode: string | null; streetCountry: string | null
  postalAddressLine1: string | null; postalAddressLine2: string | null; postalCity: string | null
  postalRegion: string | null; postalPostalCode: string | null; postalCountry: string | null
}

interface CreditHistoryItem {
  id: string
  amountCents: number
  type: "CANCELLATION_REFUND" | "ADMIN_ADJUSTMENT" | "BOOKING_APPLIED"
  description: string
  createdAt: string
  sourceBooking: { id: string; checkIn: string; checkOut: string } | null
  appliedToBooking: { id: string; checkIn: string; checkOut: string } | null
}

interface EditForm {
  firstName: string; lastName: string; email: string
  phoneCountryCode: string; phoneAreaCode: string; phoneNumber: string
  dateOfBirth: string; role: "MEMBER" | "ADMIN"; active: boolean; forcePasswordChange: boolean
  inheritEmailFromId: string | null
  streetAddressLine1: string; streetAddressLine2: string; streetCity: string
  streetRegion: string; streetPostalCode: string; streetCountry: string
  postalAddressLine1: string; postalAddressLine2: string; postalCity: string
  postalRegion: string; postalPostalCode: string; postalCountry: string
}

interface DependentForm extends MemberAddressValues {
  firstName: string
  lastName: string
  email: string
  dateOfBirth: string
  phoneCountryCode: string
  phoneAreaCode: string
  phoneNumber: string
}

function memberUsesSamePostalAddress(member: Pick<MemberDetail, keyof MemberAddressValues>) {
  const postalHasValues = [
    member.postalAddressLine1,
    member.postalAddressLine2,
    member.postalCity,
    member.postalRegion,
    member.postalPostalCode,
    member.postalCountry,
  ].some((value) => value?.trim())

  if (!postalHasValues) {
    return Boolean(
      member.streetAddressLine1?.trim() ||
      member.streetCity?.trim() ||
      member.streetPostalCode?.trim(),
    )
  }

  return postalMatchesPhysical({
    streetAddressLine1: member.streetAddressLine1,
    streetAddressLine2: member.streetAddressLine2,
    streetCity: member.streetCity,
    streetRegion: member.streetRegion,
    streetPostalCode: member.streetPostalCode,
    streetCountry: withDefaultNzCountry(member.streetCountry),
    postalAddressLine1: member.postalAddressLine1,
    postalAddressLine2: member.postalAddressLine2,
    postalCity: member.postalCity,
    postalRegion: member.postalRegion,
    postalPostalCode: member.postalPostalCode,
    postalCountry: withDefaultNzCountry(member.postalCountry),
  })
}

export default function MemberDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const { data: session } = useSession()
  const [member, setMember] = useState<MemberDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [pageError, setPageError] = useState("")
  const [success, setSuccess] = useState("")
  const [xeroError, setXeroError] = useState("")
  const [editOpen, setEditOpen] = useState(false)
  const [form, setForm] = useState<EditForm>({ firstName: "", lastName: "", email: "", phoneCountryCode: "", phoneAreaCode: "", phoneNumber: "", dateOfBirth: "", role: "MEMBER", active: true, forcePasswordChange: false, inheritEmailFromId: null, streetAddressLine1: "", streetAddressLine2: "", streetCity: "", streetRegion: "", streetPostalCode: "", streetCountry: "", postalAddressLine1: "", postalAddressLine2: "", postalCity: "", postalRegion: "", postalPostalCode: "", postalCountry: "" })
  const [editPostalSameAsPhysical, setEditPostalSameAsPhysical] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState("")
  const [dependentOpen, setDependentOpen] = useState(false)
  const [dependentForm, setDependentForm] = useState<DependentForm>({ firstName: "", lastName: "", email: "", dateOfBirth: "", phoneCountryCode: "", phoneAreaCode: "", phoneNumber: "", streetAddressLine1: "", streetAddressLine2: "", streetCity: "", streetRegion: "", streetPostalCode: "", streetCountry: NZ_COUNTRY_CODE, postalAddressLine1: "", postalAddressLine2: "", postalCity: "", postalRegion: "", postalPostalCode: "", postalCountry: NZ_COUNTRY_CODE })
  const [dependentPostalSameAsPhysical, setDependentPostalSameAsPhysical] = useState(false)
  const [dependentSaving, setDependentSaving] = useState(false)
  const [dependentFormError, setDependentFormError] = useState("")
  // Account credit state
  const [creditBalance, setCreditBalance] = useState<number>(0)
  const [creditHistory, setCreditHistory] = useState<CreditHistoryItem[]>([])
  const [creditLoading, setCreditLoading] = useState(true)
  const [creditError, setCreditError] = useState("")
  const [showAdjustmentForm, setShowAdjustmentForm] = useState(false)
  const [adjustmentAmount, setAdjustmentAmount] = useState("")
  const [adjustmentDescription, setAdjustmentDescription] = useState("")
  const [adjustmentSaving, setAdjustmentSaving] = useState(false)
  const [adjustmentError, setAdjustmentError] = useState("")

  // Xero link/push state
  const [xeroSearchOpen, setXeroSearchOpen] = useState(false)
  const [xeroSearchQuery, setXeroSearchQuery] = useState("")
  const [xeroSearchResults, setXeroSearchResults] = useState<XeroSearchResult[]>([])
  const [xeroSearching, setXeroSearching] = useState(false)
  const [xeroLinking, setXeroLinking] = useState(false)
  const [xeroPushing, setXeroPushing] = useState(false)
  const isAdultMember = member?.ageTier === "ADULT"

  const fetchMember = async () => {
    try {
      const res = await fetch(`/api/admin/members/${id}`)
      if (!res.ok) { setPageError(res.status === 404 ? "Member not found" : "Failed to load member"); setLoading(false); return }
      setMember(await res.json())
      setPageError("")
    } catch { setPageError("Failed to load member") }
    finally { setLoading(false) }
  }

  const fetchCredits = async () => {
    setCreditLoading(true); setCreditError("")
    try {
      const res = await fetch(`/api/admin/members/${id}/credits`)
      if (!res.ok) { setCreditError("Failed to load credits"); return }
      const data = await res.json()
      setCreditBalance(data.balanceCents)
      setCreditHistory(data.history)
    } catch { setCreditError("Failed to load credits") }
    finally { setCreditLoading(false) }
  }

  const handleAdjustmentSubmit = async () => {
    const cents = Math.round(parseFloat(adjustmentAmount) * 100)
    if (isNaN(cents) || cents === 0) { setAdjustmentError("Enter a non-zero amount"); return }
    if (!adjustmentDescription.trim()) { setAdjustmentError("Description is required"); return }
    setAdjustmentSaving(true); setAdjustmentError("")
    try {
      const res = await fetch(`/api/admin/members/${id}/credits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountCents: cents, description: adjustmentDescription.trim() }),
      })
      if (!res.ok) { const data = await res.json(); throw new Error(data.error || "Failed to save adjustment") }
      setShowAdjustmentForm(false)
      setAdjustmentAmount("")
      setAdjustmentDescription("")
      setSuccess("Credit adjustment applied")
      setTimeout(() => setSuccess(""), 3000)
      await fetchCredits()
    } catch (err) { setAdjustmentError(err instanceof Error ? err.message : "Failed to save adjustment") }
    finally { setAdjustmentSaving(false) }
  }

  useEffect(() => { fetchMember(); fetchCredits() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  const openEditDialog = () => {
    if (!member) return
    setForm({
      firstName: member.firstName,
      lastName: member.lastName,
      email: member.email,
      phoneCountryCode: member.phoneCountryCode || "",
      phoneAreaCode: member.phoneAreaCode || "",
      phoneNumber: member.phoneNumber || "",
      dateOfBirth: member.dateOfBirth ? new Date(member.dateOfBirth).toISOString().split("T")[0] : "",
      role: member.role,
      active: member.active,
      forcePasswordChange: member.forcePasswordChange,
      inheritEmailFromId: member.inheritEmailFromId,
      streetAddressLine1: member.streetAddressLine1 || "",
      streetAddressLine2: member.streetAddressLine2 || "",
      streetCity: member.streetCity || "",
      streetRegion: member.streetRegion || "",
      streetPostalCode: member.streetPostalCode || "",
      streetCountry: withDefaultNzCountry(member.streetCountry),
      postalAddressLine1: member.postalAddressLine1 || "",
      postalAddressLine2: member.postalAddressLine2 || "",
      postalCity: member.postalCity || "",
      postalRegion: member.postalRegion || "",
      postalPostalCode: member.postalPostalCode || "",
      postalCountry: withDefaultNzCountry(member.postalCountry),
    })
    setEditPostalSameAsPhysical(memberUsesSamePostalAddress({
      streetAddressLine1: member.streetAddressLine1,
      streetAddressLine2: member.streetAddressLine2,
      streetCity: member.streetCity,
      streetRegion: member.streetRegion,
      streetPostalCode: member.streetPostalCode,
      streetCountry: member.streetCountry,
      postalAddressLine1: member.postalAddressLine1,
      postalAddressLine2: member.postalAddressLine2,
      postalCity: member.postalCity,
      postalRegion: member.postalRegion,
      postalPostalCode: member.postalPostalCode,
      postalCountry: member.postalCountry,
    } as Pick<MemberDetail, keyof MemberAddressValues>))
    setFormError("")
    setEditOpen(true)
  }

  const openDependentDialog = () => {
    if (!member) return

    const inheritedEmailAddress = member.inheritEmailFrom?.email || member.email

    setDependentForm({
      firstName: "",
      lastName: member.lastName,
      email: inheritedEmailAddress,
      dateOfBirth: "",
      phoneCountryCode: member.phoneCountryCode || "",
      phoneAreaCode: member.phoneAreaCode || "",
      phoneNumber: member.phoneNumber || "",
      streetAddressLine1: member.streetAddressLine1 || "",
      streetAddressLine2: member.streetAddressLine2 || "",
      streetCity: member.streetCity || "",
      streetRegion: member.streetRegion || "",
      streetPostalCode: member.streetPostalCode || "",
      streetCountry: withDefaultNzCountry(member.streetCountry),
      postalAddressLine1: member.postalAddressLine1 || "",
      postalAddressLine2: member.postalAddressLine2 || "",
      postalCity: member.postalCity || "",
      postalRegion: member.postalRegion || "",
      postalPostalCode: member.postalPostalCode || "",
      postalCountry: withDefaultNzCountry(member.postalCountry),
    })
    setDependentPostalSameAsPhysical(memberUsesSamePostalAddress({
      streetAddressLine1: member.streetAddressLine1,
      streetAddressLine2: member.streetAddressLine2,
      streetCity: member.streetCity,
      streetRegion: member.streetRegion,
      streetPostalCode: member.streetPostalCode,
      streetCountry: member.streetCountry,
      postalAddressLine1: member.postalAddressLine1,
      postalAddressLine2: member.postalAddressLine2,
      postalCity: member.postalCity,
      postalRegion: member.postalRegion,
      postalPostalCode: member.postalPostalCode,
      postalCountry: member.postalCountry,
    } as Pick<MemberDetail, keyof MemberAddressValues>))
    setDependentFormError("")
    setDependentOpen(true)
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
          phoneCountryCode: form.phoneCountryCode || null,
          phoneAreaCode: form.phoneAreaCode || null,
          phoneNumber: form.phoneNumber || null,
          dateOfBirth: form.dateOfBirth || null,
          role: form.role,
          active: form.active,
          forcePasswordChange: form.forcePasswordChange,
          inheritEmailFromId: form.inheritEmailFromId || null,
          streetAddressLine1: form.streetAddressLine1 || null,
          streetAddressLine2: form.streetAddressLine2 || null,
          streetCity: form.streetCity || null,
          streetRegion: form.streetRegion || null,
          streetPostalCode: form.streetPostalCode || null,
          streetCountry: form.streetCountry || null,
          postalAddressLine1: form.postalAddressLine1 || null,
          postalAddressLine2: form.postalAddressLine2 || null,
          postalCity: form.postalCity || null,
          postalRegion: form.postalRegion || null,
          postalPostalCode: form.postalPostalCode || null,
          postalCountry: form.postalCountry || null,
          postalSameAsPhysical: editPostalSameAsPhysical,
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

  const updateEditAddressFields = (patch: Partial<MemberAddressValues>) => {
    setForm((current) => ({ ...current, ...patch }))
  }

  const handleCreateDependent = async () => {
    if (!member) return

    const inheritedEmailSourceId = member.inheritEmailFromId || member.id

    setDependentSaving(true)
    setDependentFormError("")

    try {
      const res = await fetch("/api/admin/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: dependentForm.firstName,
          lastName: dependentForm.lastName,
          email: dependentForm.email,
          dateOfBirth: dependentForm.dateOfBirth || null,
          phoneCountryCode: dependentForm.phoneCountryCode || null,
          phoneAreaCode: dependentForm.phoneAreaCode || null,
          phoneNumber: dependentForm.phoneNumber || null,
          role: "MEMBER",
          ageTier: "CHILD",
          active: true,
          canLogin: false,
          parentMemberId: member.id,
          inheritParentEmail: true,
          inheritEmailFromId: inheritedEmailSourceId,
          streetAddressLine1: dependentForm.streetAddressLine1 || null,
          streetAddressLine2: dependentForm.streetAddressLine2 || null,
          streetCity: dependentForm.streetCity || null,
          streetRegion: dependentForm.streetRegion || null,
          streetPostalCode: dependentForm.streetPostalCode || null,
          streetCountry: dependentForm.streetCountry || null,
          postalAddressLine1: dependentForm.postalAddressLine1 || null,
          postalAddressLine2: dependentForm.postalAddressLine2 || null,
          postalCity: dependentForm.postalCity || null,
          postalRegion: dependentForm.postalRegion || null,
          postalPostalCode: dependentForm.postalPostalCode || null,
          postalCountry: dependentForm.postalCountry || null,
          postalSameAsPhysical: dependentPostalSameAsPhysical,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to create dependent")
      }

      setDependentOpen(false)
      setSuccess("Dependent created successfully")
      setTimeout(() => setSuccess(""), 3000)
      setLoading(true)
      await fetchMember()
    } catch (err) {
      setDependentFormError(err instanceof Error ? err.message : "Failed to create dependent")
    } finally {
      setDependentSaving(false)
    }
  }

  const updateDependentAddressFields = (patch: Partial<MemberAddressValues>) => {
    setDependentForm((current) => ({ ...current, ...patch }))
  }

  const handleXeroSearch = async () => {
    if (!xeroSearchQuery || xeroSearchQuery.length < 2) return
    setXeroSearching(true)
    setXeroError("")
    try {
      const res = await fetch(`/api/admin/xero/search-contacts?q=${encodeURIComponent(xeroSearchQuery)}`)
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Search failed")
      }
      const data = await res.json()
      setXeroSearchResults(data.contacts ?? [])
    } catch (err) {
      setXeroSearchResults([])
      setXeroError(err instanceof Error ? err.message : "Search failed")
    }
    finally { setXeroSearching(false) }
  }

  const handleXeroLink = async (xeroContactId: string) => {
    setXeroLinking(true); setXeroError("")
    try {
      const res = await fetch(`/api/admin/members/${id}/xero-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ xeroContactId }),
      })
      if (!res.ok) { const data = await res.json(); throw new Error(data.error || "Link failed") }
      setXeroSearchOpen(false)
      setSuccess("Member linked to Xero contact")
      setTimeout(() => setSuccess(""), 3000)
      setLoading(true)
      await fetchMember()
    } catch (err) { setXeroError(err instanceof Error ? err.message : "Link failed") }
    finally { setXeroLinking(false) }
  }

  const handleXeroPush = async () => {
    setXeroPushing(true); setXeroError("")
    try {
      const res = await fetch(`/api/admin/members/${id}/xero-push`, { method: "POST" })
      if (!res.ok) { const data = await res.json(); throw new Error(data.error || "Push failed") }
      setSuccess("Member created in Xero")
      setTimeout(() => setSuccess(""), 3000)
      setLoading(true)
      await fetchMember()
    } catch (err) { setXeroError(err instanceof Error ? err.message : "Push failed") }
    finally { setXeroPushing(false) }
  }

  const isSelf = session?.user?.id === id

  if (loading) return <div className="py-12 text-center"><p className="text-sm text-slate-500">Loading member details...</p></div>
  if (pageError || !member) return (
    <div className="space-y-4">
      <Button variant="outline" onClick={() => router.push("/admin/members")}><ArrowLeft className="h-4 w-4 mr-2" />Back to Members</Button>
      <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-md text-sm">{pageError || "Member not found"}</div>
    </div>
  )

  const fmt = (cents: number) => new Intl.NumberFormat("en-NZ", { style: "currency", currency: "NZD" }).format(cents / 100)
  const fmtDate = (d: string) => new Date(d).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" })

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
          <div className="flex gap-2 shrink-0 flex-wrap">
            {isAdultMember && (
              <Button variant="outline" size="sm" onClick={openDependentDialog}>
                <Plus className="h-4 w-4 mr-1" />
                Add Dependent
              </Button>
            )}
            {member.xeroContactId ? (
              <a href={`https://go.xero.com/Contacts/View/${member.xeroContactId}`} target="_blank" rel="noopener noreferrer">
                <Button variant="outline" size="sm"><ExternalLink className="h-4 w-4 mr-1" />View in Xero</Button>
              </a>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={() => { setXeroSearchOpen(true); setXeroSearchQuery(""); setXeroSearchResults([]); setXeroError(""); }}><Link2 className="h-4 w-4 mr-1" />Link to Xero</Button>
                <Button variant="outline" size="sm" onClick={handleXeroPush} disabled={xeroPushing}><Plus className="h-4 w-4 mr-1" />{xeroPushing ? "Creating..." : "Create in Xero"}</Button>
              </>
            )}
            <Button size="sm" onClick={openEditDialog}><Pencil className="h-4 w-4 mr-1" />Edit Member</Button>
          </div>
        </div>
      </div>

      {success && <div className="p-3 bg-green-50 border border-green-200 text-green-700 rounded-md text-sm">{success}</div>}
      {xeroError && !xeroSearchOpen && <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-md text-sm">{xeroError}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card><CardContent className="pt-6"><div className="flex items-center gap-3"><User className="h-8 w-8 text-slate-400" /><div><p className="text-xs text-slate-500 uppercase tracking-wide">Age Tier</p><p className="text-lg font-semibold">{member.ageTier.charAt(0) + member.ageTier.slice(1).toLowerCase()}</p>{member.dateOfBirth && <p className="text-xs text-slate-400">DOB: {fmtDate(member.dateOfBirth)}</p>}</div></div></CardContent></Card>
        <Card><CardContent className="pt-6"><div className="flex items-center gap-3"><Calendar className="h-8 w-8 text-slate-400" /><div><p className="text-xs text-slate-500 uppercase tracking-wide">Total Bookings</p><p className="text-lg font-semibold">{member.stats.totalBookings}</p></div></div></CardContent></Card>
        <Card><CardContent className="pt-6"><div className="flex items-center gap-3"><CreditCard className="h-8 w-8 text-slate-400" /><div><p className="text-xs text-slate-500 uppercase tracking-wide">Total Spend</p><p className="text-lg font-semibold">{fmt(member.stats.totalSpendCents)}</p></div></div></CardContent></Card>
        <Card><CardContent className="pt-6"><div className="flex items-center gap-3"><Clock className="h-8 w-8 text-slate-400" /><div><p className="text-xs text-slate-500 uppercase tracking-wide">Last Stay</p><p className="text-lg font-semibold">{member.stats.lastStay ? fmtDate(member.stats.lastStay) : "Never"}</p></div></div></CardContent></Card>
      </div>

      <Card><CardHeader><CardTitle className="text-base font-medium">Member Information</CardTitle></CardHeader><CardContent><dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
        <div><dt className="text-slate-500">Phone</dt><dd className="font-medium">{member.phoneNumber ? [member.phoneCountryCode ? `+${member.phoneCountryCode}` : null, member.phoneAreaCode, member.phoneNumber].filter(Boolean).join(" ") : "Not provided"}</dd></div>
        <div><dt className="text-slate-500">Member Since</dt><dd className="font-medium">{fmtDate(member.joinedDate || member.createdAt)}{member.joinedDate && <span className="text-xs text-slate-400 ml-1">(from Xero)</span>}</dd></div>
        <div><dt className="text-slate-500">Login</dt><dd className="font-medium">{member.canLogin ? <Badge variant="secondary" className="bg-slate-100 text-slate-700 border-slate-200">Can Login</Badge> : <Badge variant="secondary" className="bg-purple-100 text-purple-800 border-purple-200">Non-Login</Badge>}</dd></div>
        <div><dt className="text-slate-500">Email Inheritance</dt><dd className="font-medium">{member.inheritEmailFrom ? <span className="text-xs">{member.inheritEmailFrom.firstName} {member.inheritEmailFrom.lastName} <span className="text-slate-400">({member.inheritEmailFrom.email})</span></span> : <span className="text-xs text-slate-500">Own email</span>}</dd></div>
        <div><dt className="text-slate-500">Family Groups</dt><dd className="font-medium">{member.familyGroups && member.familyGroups.length > 0 ? <div className="flex flex-wrap gap-1">{member.familyGroups.map(fg => <Badge key={fg.id} variant="secondary" className="bg-indigo-50 text-indigo-700 border-indigo-200">{fg.name || "Unnamed"}</Badge>)}</div> : <span className="text-xs text-slate-500">None</span>}</dd></div>
        <div>
          <dt className="text-slate-500">Xero Contact</dt>
          <dd className="font-medium space-y-2">
            <div>
              {member.xeroContactId ? (
                <a href={`https://go.xero.com/Contacts/View/${member.xeroContactId}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline inline-flex items-center gap-1">
                  {member.xeroContactId}
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                "Not linked"
              )}
            </div>
            {member.xeroContactGroups.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {member.xeroContactGroups.map((group) => (
                  <Badge key={group.id} variant="secondary" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                    {group.name}
                  </Badge>
                ))}
              </div>
            )}
          </dd>
        </div>
      </dl></CardContent></Card>

      <XeroRecordActivityPanel localModel="Member" localId={id} compact />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base font-medium">Dependents</CardTitle>
          {isAdultMember && (
            <Button variant="outline" size="sm" onClick={openDependentDialog}>
              <Plus className="h-4 w-4 mr-1" />
              Add Dependent
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {member.dependents.length === 0 ? (
            <p className="text-sm text-slate-500">
              {isAdultMember
                ? "No dependents linked to this member yet."
                : "Only adult members can manage dependents."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Age Tier</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Date of Birth</TableHead>
                  <TableHead>Login</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {member.dependents.map((dependent) => (
                  <TableRow key={dependent.id}>
                    <TableCell className="font-medium">
                      {dependent.firstName} {dependent.lastName}
                    </TableCell>
                    <TableCell>
                      {dependent.ageTier.charAt(0) + dependent.ageTier.slice(1).toLowerCase()}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={dependent.active ? "default" : "destructive"}
                        className={dependent.active ? "bg-green-100 text-green-800 hover:bg-green-200 border-green-200" : ""}
                      >
                        {dependent.active ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell>{dependent.dateOfBirth ? fmtDate(dependent.dateOfBirth) : "-"}</TableCell>
                    <TableCell>
                      {dependent.canLogin ? (
                        <Badge variant="secondary" className="bg-slate-100 text-slate-700 border-slate-200">
                          Can Login
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="bg-purple-100 text-purple-800 border-purple-200">
                          Non-Login
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => router.push(`/admin/members/${dependent.id}`)}
                      >
                        View
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card><CardHeader><CardTitle className="text-base font-medium">Subscription History</CardTitle></CardHeader><CardContent>
        {member.subscriptions.length === 0 ? <p className="text-sm text-slate-500">No subscription records</p> : (
          <Table><TableHeader><TableRow><TableHead>Season Year</TableHead><TableHead>Status</TableHead><TableHead>Paid At</TableHead><TableHead>Xero Invoice</TableHead></TableRow></TableHeader><TableBody>{member.subscriptions.map((sub) => (
            <TableRow key={sub.id}><TableCell className="font-medium">{sub.seasonYear}/{sub.seasonYear + 1}</TableCell><TableCell><Badge variant="secondary" className={subscriptionStatusClass(sub.status)}>{sub.status.replace("_", " ")}</Badge></TableCell><TableCell>{sub.paidAt ? fmtDate(sub.paidAt) : "-"}</TableCell><TableCell>{sub.xeroInvoiceId ? <a href={`https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${sub.xeroInvoiceId}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline inline-flex items-center gap-1">View <ExternalLink className="h-3 w-3" /></a> : "-"}</TableCell></TableRow>
          ))}</TableBody></Table>)}
      </CardContent></Card>

      <Card><CardHeader><CardTitle className="text-base font-medium">Booking History</CardTitle></CardHeader><CardContent>
        {member.bookings.length === 0 ? <p className="text-sm text-slate-500">No bookings yet</p> : (
          <Table><TableHeader><TableRow><TableHead>Check In</TableHead><TableHead>Check Out</TableHead><TableHead>Status</TableHead><TableHead>Guests</TableHead><TableHead>Amount</TableHead></TableRow></TableHeader><TableBody>{member.bookings.map((booking) => (
            <TableRow key={booking.id}><TableCell>{fmtDate(booking.checkIn)}</TableCell><TableCell>{fmtDate(booking.checkOut)}</TableCell><TableCell><Badge variant="secondary" className={bookingStatusClass(booking.status)}>{bookingStatusLabel(booking.status)}</Badge></TableCell><TableCell>{booking._count.guests}</TableCell><TableCell>{fmt(booking.finalPriceCents)}</TableCell></TableRow>
          ))}</TableBody></Table>)}
      </CardContent></Card>

      <Card><CardHeader><CardTitle className="text-base font-medium">Audit Log</CardTitle></CardHeader><CardContent>
        {member.auditLogs.length === 0 ? <p className="text-sm text-slate-500">No audit records</p> : (
          <div className="space-y-3">{member.auditLogs.map((log) => (
            <div key={log.id} className="flex items-start justify-between border-b border-slate-100 pb-2 last:border-0"><div><p className="text-sm font-medium text-slate-700">{log.action}</p>{log.details && <p className="text-xs text-slate-500 mt-0.5">{log.details}</p>}</div><span className="text-xs text-slate-400 whitespace-nowrap ml-4">{fmtDate(log.createdAt)}</span></div>
          ))}</div>)}
      </CardContent></Card>

      <Card><CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2"><CardTitle className="text-base font-medium">Account Credit</CardTitle><div className="flex items-center gap-3"><span className={`text-lg font-semibold ${creditBalance > 0 ? "text-green-700" : creditBalance < 0 ? "text-red-700" : "text-slate-700"}`}>{`$${(creditBalance / 100).toFixed(2)}`}</span><Button size="sm" variant="outline" onClick={() => { setShowAdjustmentForm(!showAdjustmentForm); setAdjustmentError("") }}>{showAdjustmentForm ? "Cancel" : "Add Adjustment"}</Button></div></CardHeader><CardContent>
        {showAdjustmentForm && (
          <div className="mb-4 p-4 border border-slate-200 rounded-md bg-slate-50 space-y-3">
            {adjustmentError && <div className="p-2 bg-red-50 border border-red-200 text-red-700 rounded text-sm">{adjustmentError}</div>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="adj-amount">Amount ($)</Label>
                <Input id="adj-amount" type="number" step="0.01" placeholder="e.g. 25.00 or -10.00" value={adjustmentAmount} onChange={e => setAdjustmentAmount(e.target.value)} />
                <p className="text-xs text-slate-500">Positive = add credit, negative = deduct</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="adj-desc">Description *</Label>
                <Input id="adj-desc" placeholder="Reason for adjustment" value={adjustmentDescription} onChange={e => setAdjustmentDescription(e.target.value)} maxLength={500} />
              </div>
            </div>
            <Button size="sm" onClick={handleAdjustmentSubmit} disabled={adjustmentSaving}>{adjustmentSaving ? "Saving..." : "Submit Adjustment"}</Button>
          </div>
        )}
        {creditLoading ? <p className="text-sm text-slate-500">Loading credit history...</p> : creditError ? <p className="text-sm text-red-600">{creditError}</p> : creditHistory.length === 0 ? <p className="text-sm text-slate-500">No credit transactions</p> : (
          <Table><TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Type</TableHead><TableHead>Amount</TableHead><TableHead>Description</TableHead><TableHead>Booking Ref</TableHead></TableRow></TableHeader><TableBody>{creditHistory.map((item) => (
            <TableRow key={item.id}>
              <TableCell className="text-sm">{fmtDate(item.createdAt)}</TableCell>
              <TableCell><Badge variant="secondary" className={item.type === "CANCELLATION_REFUND" ? "bg-orange-100 text-orange-800 border-orange-200" : item.type === "ADMIN_ADJUSTMENT" ? "bg-blue-100 text-blue-800 border-blue-200" : "bg-purple-100 text-purple-800 border-purple-200"}>{item.type.replace(/_/g, " ")}</Badge></TableCell>
              <TableCell className={`font-medium ${item.amountCents > 0 ? "text-green-700" : "text-red-700"}`}>{`${item.amountCents > 0 ? "+" : ""}$${(item.amountCents / 100).toFixed(2)}`}</TableCell>
              <TableCell className="text-sm text-slate-600 max-w-[200px] truncate">{item.description}</TableCell>
              <TableCell className="text-sm">{item.sourceBooking ? <span className="text-blue-600">{fmtDate(item.sourceBooking.checkIn)} - {fmtDate(item.sourceBooking.checkOut)}</span> : item.appliedToBooking ? <span className="text-purple-600">{fmtDate(item.appliedToBooking.checkIn)} - {fmtDate(item.appliedToBooking.checkOut)}</span> : "-"}</TableCell>
            </TableRow>
          ))}</TableBody></Table>
        )}
      </CardContent></Card>

      <Dialog open={xeroSearchOpen} onOpenChange={setXeroSearchOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Link to Xero Contact</DialogTitle>
            <DialogDescription>Search for an existing Xero contact to link to {member.firstName} {member.lastName}.</DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Input
              placeholder="Search by name or email..."
              value={xeroSearchQuery}
              onChange={e => { setXeroSearchQuery(e.target.value); if (xeroError) setXeroError("") }}
              onKeyDown={e => e.key === "Enter" && handleXeroSearch()}
            />
            <Button onClick={handleXeroSearch} disabled={xeroSearching || xeroSearchQuery.length < 2}>
              <Search className="h-4 w-4 mr-1" />{xeroSearching ? "..." : "Search"}
            </Button>
          </div>
          {xeroError && <div className="p-2 bg-red-50 border border-red-200 text-red-700 rounded text-sm">{xeroError}</div>}
          <div className="max-h-64 overflow-y-auto space-y-2">
            {xeroSearchResults.length === 0 && !xeroSearching && xeroSearchQuery.length >= 2 && (
              <p className="text-sm text-slate-500 text-center py-4">No contacts found</p>
            )}
            {xeroSearchResults.map(c => (
              <div key={c.contactId} className="flex items-center justify-between p-2 border rounded hover:bg-slate-50">
                <div>
                  <p className="text-sm font-medium">{c.name}</p>
                  {c.email && <p className="text-xs text-slate-500">{c.email}</p>}
                  {c.isLinked && <p className="text-xs text-amber-600">Already linked to {c.linkedMemberName}</p>}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={c.isLinked || xeroLinking}
                  onClick={() => handleXeroLink(c.contactId)}
                >
                  {xeroLinking ? "..." : "Link"}
                </Button>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={dependentOpen} onOpenChange={setDependentOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Dependent</DialogTitle>
            <DialogDescription>
              Create a dependent managed under {member.firstName} {member.lastName}. Phone and address default from the parent and can be adjusted before saving.
            </DialogDescription>
          </DialogHeader>
          {dependentFormError && <div className="p-2 bg-red-50 border border-red-200 text-red-700 rounded text-sm">{dependentFormError}</div>}
          <div className="grid gap-4 py-2">
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
              This dependent will be created as a non-login member and inherit notifications from the parent email.
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="dependent-firstName">First Name *</Label>
                <Input
                  id="dependent-firstName"
                  value={dependentForm.firstName}
                  onChange={e => setDependentForm(f => ({ ...f, firstName: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="dependent-lastName">Last Name *</Label>
                <Input
                  id="dependent-lastName"
                  value={dependentForm.lastName}
                  onChange={e => setDependentForm(f => ({ ...f, lastName: e.target.value }))}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="dependent-email">Email *</Label>
              <Input
                id="dependent-email"
                type="email"
                value={dependentForm.email}
                onChange={e => setDependentForm(f => ({ ...f, email: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                This can match the parent email. Delivery will still be controlled by the inherited-email settings.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="dependent-dateOfBirth">Date of Birth *</Label>
              <Input
                id="dependent-dateOfBirth"
                type="date"
                value={dependentForm.dateOfBirth}
                onChange={e => setDependentForm(f => ({ ...f, dateOfBirth: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">Age tier will be calculated automatically from date of birth.</p>
            </div>

            <div className="space-y-2">
              <Label>Phone</Label>
              <div className="flex gap-2">
                <Input className="w-20" placeholder="64" value={dependentForm.phoneCountryCode} onChange={e => setDependentForm(f => ({ ...f, phoneCountryCode: e.target.value }))} maxLength={5} aria-label="Country code" />
                <Input className="w-20" placeholder="27" value={dependentForm.phoneAreaCode} onChange={e => setDependentForm(f => ({ ...f, phoneAreaCode: e.target.value }))} maxLength={5} aria-label="Area code" />
                <Input className="flex-1" placeholder="123 4567" value={dependentForm.phoneNumber} onChange={e => setDependentForm(f => ({ ...f, phoneNumber: e.target.value }))} maxLength={15} aria-label="Phone number" />
              </div>
            </div>

            <MemberAddressFields
              idPrefix="dependent"
              onSameAsPhysicalChange={setDependentPostalSameAsPhysical}
              onValuesChange={updateDependentAddressFields}
              sameAsPhysical={dependentPostalSameAsPhysical}
              values={dependentForm}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDependentOpen(false)} disabled={dependentSaving}>Cancel</Button>
            <Button onClick={handleCreateDependent} disabled={dependentSaving}>
              {dependentSaving ? "Creating..." : "Create Dependent"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
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
              <Label>Phone</Label>
              <div className="flex gap-2">
                <Input className="w-20" placeholder="64" value={form.phoneCountryCode} onChange={e => setForm(f => ({ ...f, phoneCountryCode: e.target.value }))} maxLength={5} aria-label="Country code" />
                <Input className="w-20" placeholder="27" value={form.phoneAreaCode} onChange={e => setForm(f => ({ ...f, phoneAreaCode: e.target.value }))} maxLength={5} aria-label="Area code" />
                <Input className="flex-1" placeholder="123 4567" value={form.phoneNumber} onChange={e => setForm(f => ({ ...f, phoneNumber: e.target.value }))} maxLength={15} aria-label="Phone number" />
              </div>
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
            {!member.canLogin && (
              <div className="space-y-2">
                <Label htmlFor="edit-inheritEmailFromId">Inherit Email From (optional)</Label>
                <p className="text-xs text-muted-foreground">
                  Enter the member ID of an adult whose email this member should use for notifications.
                  Leave blank to use their own email.
                </p>
                <Input
                  id="edit-inheritEmailFromId"
                  value={form.inheritEmailFromId || ""}
                  onChange={e => setForm(f => ({ ...f, inheritEmailFromId: e.target.value.trim() || null }))}
                  placeholder="Adult member ID (leave blank for own email)"
                />
                {member.inheritEmailFrom && (
                  <p className="text-xs text-green-700">Currently inheriting from: {member.inheritEmailFrom.firstName} {member.inheritEmailFrom.lastName} ({member.inheritEmailFrom.email})</p>
                )}
              </div>
            )}
            <MemberAddressFields
              idPrefix="edit-member"
              onSameAsPhysicalChange={setEditPostalSameAsPhysical}
              onValuesChange={updateEditAddressFields}
              sameAsPhysical={editPostalSameAsPhysical}
              values={form}
            />
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
