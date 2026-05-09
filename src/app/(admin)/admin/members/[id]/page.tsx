"use client"

import { useCallback, useEffect, useState, use } from "react"
import { useSession } from "next-auth/react"
import { useRouter, useSearchParams } from "next/navigation"
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

type FinanceAccessLevel = "NONE" | "VIEWER" | "MANAGER"

interface XeroSearchResult {
  contactId: string; name: string; email: string | null; isLinked: boolean; linkedMemberName: string | null
  matchReasons?: string[]
  xeroLink?: string
}

interface XeroPushResponse {
  xeroContactId: string
  xeroLink: string
  entranceFeeInvoiceQueued?: boolean
  entranceFeeInvoiceMessage?: string
  warning?: string
}

interface AdminActor {
  id: string
  firstName: string
  lastName: string
}

interface EmailInheritanceSearchResult {
  id: string
  firstName: string
  lastName: string
  email: string
  active?: boolean
}

interface MemberDetail {
  id: string; firstName: string; lastName: string; email: string
  phoneCountryCode: string | null; phoneAreaCode: string | null; phoneNumber: string | null
  dateOfBirth: string | null
  role: "MEMBER" | "ADMIN"; ageTier: string
  financeAccessLevel: FinanceAccessLevel
  active: boolean; forcePasswordChange: boolean; xeroContactId: string | null; joinedDate: string | null; createdAt: string
  canLogin: boolean
  xeroContactGroupsLoaded: boolean
  xeroContactGroups: Array<{ id: string; name: string }>
  inheritEmailFromId: string | null
  inheritEmailFrom: { id: string; firstName: string; lastName: string; email: string } | null
  familyGroups: { id: string; name: string | null }[]
  subscriptions: Array<{ id: string; seasonYear: number; status: string; xeroInvoiceId: string | null; paidAt: string | null }>
  bookings: Array<{ id: string; checkIn: string; checkOut: string; status: string; finalPriceCents: number; _count: { guests: number } }>
  auditLogs: AuditLogEntry[]
  stats: { totalBookings: number; totalSpendCents: number; lastStay: string | null }
  dependents: Array<{ id: string; firstName: string; lastName: string; ageTier: string; active: boolean; dateOfBirth: string | null; canLogin: boolean }>
  streetAddressLine1: string | null; streetAddressLine2: string | null; streetCity: string | null
  streetRegion: string | null; streetPostalCode: string | null; streetCountry: string | null
  postalAddressLine1: string | null; postalAddressLine2: string | null; postalCity: string | null
  postalRegion: string | null; postalPostalCode: string | null; postalCountry: string | null
}

interface AuditActor {
  id: string
  firstName: string
  lastName: string
  email: string
}

interface AuditLogEntry {
  id: string
  action: string
  details: string | null
  createdAt: string
  actor: AuditActor | null
}

interface InviteAuditDetails {
  recipientEmail?: string
  recipientName?: string
  kind?: "invite" | "reset"
  expiryLabel?: string
}

interface CreditHistoryItem {
  id: string
  amountCents: number
  type: "CANCELLATION_REFUND" | "ADMIN_ADJUSTMENT" | "BOOKING_APPLIED"
  description: string
  createdAt: string
  requestedBy: AdminActor | null
  approvedBy: AdminActor | null
  approvalRequest: { createdAt: string; reviewedAt: string | null } | null
  sourceBooking: { id: string; checkIn: string; checkOut: string } | null
  appliedToBooking: { id: string; checkIn: string; checkOut: string } | null
}

interface PendingCreditAdjustmentItem {
  id: string
  amountCents: number
  description: string
  createdAt: string
  requestedBy: AdminActor
}

interface EditForm {
  firstName: string; lastName: string; email: string
  phoneCountryCode: string; phoneAreaCode: string; phoneNumber: string
  dateOfBirth: string; joinedDate: string
  role: "MEMBER" | "ADMIN"; ageTier: string; financeAccessLevel: FinanceAccessLevel; active: boolean; canLogin: boolean; forcePasswordChange: boolean
  inheritEmailFromId: string | null
  streetAddressLine1: string; streetAddressLine2: string; streetCity: string
  streetRegion: string; streetPostalCode: string; streetCountry: string
  postalAddressLine1: string; postalAddressLine2: string; postalCity: string
  postalRegion: string; postalPostalCode: string; postalCountry: string
}

const financeAccessLabels: Record<FinanceAccessLevel, string> = {
  NONE: "No Finance Access",
  VIEWER: "Finance Viewer",
  MANAGER: "Finance Manager",
}

const financeAccessBadgeClass: Record<FinanceAccessLevel, string> = {
  NONE: "bg-slate-100 text-slate-700 border-slate-200",
  VIEWER: "bg-amber-100 text-amber-800 border-amber-200",
  MANAGER: "bg-emerald-100 text-emerald-800 border-emerald-200",
}

function formatAdminName(admin: AdminActor | null | undefined) {
  return admin ? `${admin.firstName} ${admin.lastName}` : "Unknown admin"
}

export function parseInviteAuditDetails(details: string | null): InviteAuditDetails | null {
  if (!details) return null

  try {
    const parsed = JSON.parse(details) as InviteAuditDetails
    if (typeof parsed !== "object" || parsed === null) return null
    return parsed
  } catch {
    return null
  }
}

export function getAuditActorDisplayName(actor: AuditActor | null | undefined) {
  if (!actor) return "System"

  const fullName = `${actor.firstName} ${actor.lastName}`.trim()
  return fullName || actor.email || "System"
}

export function formatMemberAuditLogSummary(
  log: AuditLogEntry,
  formattedTimestamp: string
) {
  const parsedDetails = parseInviteAuditDetails(log.details)
  const actorName = getAuditActorDisplayName(log.actor)

  if (log.action === "member.setup-invite-sent" && parsedDetails?.recipientEmail) {
    return `Invited via email to ${parsedDetails.recipientEmail} on ${formattedTimestamp} by ${actorName}`
  }

  if (log.action === "member.password-reset-sent" && parsedDetails?.recipientEmail) {
    return `Password reset sent to ${parsedDetails.recipientEmail} on ${formattedTimestamp} by ${actorName}`
  }

  return log.action
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

function getMissingFieldsForXeroCreate(form: EditForm): string[] {
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

export default function MemberDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const searchParams = useSearchParams()
  const { data: session } = useSession()
  const [member, setMember] = useState<MemberDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [pageError, setPageError] = useState("")
  const [success, setSuccess] = useState("")
  const [xeroError, setXeroError] = useState("")
  const [editOpen, setEditOpen] = useState(false)
  const [form, setForm] = useState<EditForm>({ firstName: "", lastName: "", email: "", phoneCountryCode: "", phoneAreaCode: "", phoneNumber: "", dateOfBirth: "", joinedDate: "", role: "MEMBER", ageTier: "ADULT", financeAccessLevel: "NONE", active: true, canLogin: true, forcePasswordChange: false, inheritEmailFromId: null, streetAddressLine1: "", streetAddressLine2: "", streetCity: "", streetRegion: "", streetPostalCode: "", streetCountry: "", postalAddressLine1: "", postalAddressLine2: "", postalCity: "", postalRegion: "", postalPostalCode: "", postalCountry: "" })
  const [editPostalSameAsPhysical, setEditPostalSameAsPhysical] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState("")
  const [hasHandledInitialEditParam, setHasHandledInitialEditParam] = useState(false)
  const [inheritEmailSearch, setInheritEmailSearch] = useState("")
  const [inheritEmailSearchResults, setInheritEmailSearchResults] = useState<EmailInheritanceSearchResult[]>([])
  const [inheritEmailSearchError, setInheritEmailSearchError] = useState("")
  const [inheritEmailSearching, setInheritEmailSearching] = useState(false)
  const [selectedInheritEmailSource, setSelectedInheritEmailSource] = useState<EmailInheritanceSearchResult | null>(null)
  const [dependentOpen, setDependentOpen] = useState(false)
  const [dependentForm, setDependentForm] = useState<DependentForm>({ firstName: "", lastName: "", email: "", dateOfBirth: "", phoneCountryCode: "", phoneAreaCode: "", phoneNumber: "", streetAddressLine1: "", streetAddressLine2: "", streetCity: "", streetRegion: "", streetPostalCode: "", streetCountry: NZ_COUNTRY_CODE, postalAddressLine1: "", postalAddressLine2: "", postalCity: "", postalRegion: "", postalPostalCode: "", postalCountry: NZ_COUNTRY_CODE })
  const [dependentPostalSameAsPhysical, setDependentPostalSameAsPhysical] = useState(false)
  const [dependentSaving, setDependentSaving] = useState(false)
  const [dependentFormError, setDependentFormError] = useState("")
  // Account credit state
  const [creditBalance, setCreditBalance] = useState<number>(0)
  const [creditHistory, setCreditHistory] = useState<CreditHistoryItem[]>([])
  const [pendingAdjustmentRequests, setPendingAdjustmentRequests] = useState<PendingCreditAdjustmentItem[]>([])
  const [creditLoading, setCreditLoading] = useState(true)
  const [creditError, setCreditError] = useState("")
  const [showAdjustmentForm, setShowAdjustmentForm] = useState(false)
  const [adjustmentAmount, setAdjustmentAmount] = useState("")
  const [adjustmentDescription, setAdjustmentDescription] = useState("")
  const [adjustmentIdempotencyKey, setAdjustmentIdempotencyKey] = useState<string | null>(null)
  const [adjustmentSaving, setAdjustmentSaving] = useState(false)
  const [adjustmentError, setAdjustmentError] = useState("")
  const [reviewingAdjustmentId, setReviewingAdjustmentId] = useState<string | null>(null)

  // Xero link/push state
  const [xeroSearchOpen, setXeroSearchOpen] = useState(false)
  const [xeroSearchQuery, setXeroSearchQuery] = useState("")
  const [xeroSearchResults, setXeroSearchResults] = useState<XeroSearchResult[]>([])
  const [xeroSearching, setXeroSearching] = useState(false)
  const [xeroChoice, setXeroChoice] = useState<"" | "change">("")
  const [xeroLinking, setXeroLinking] = useState(false)
  const [selectedXeroContactId, setSelectedXeroContactId] = useState("")
  const [xeroUnlinking, setXeroUnlinking] = useState(false)
  const [xeroPushing, setXeroPushing] = useState(false)
  const [xeroCreateOpen, setXeroCreateOpen] = useState(false)
  const [xeroCreateEntranceFeeInvoice, setXeroCreateEntranceFeeInvoice] = useState(false)
  const [xeroCreateDecisionOpen, setXeroCreateDecisionOpen] = useState(false)
  const [xeroCreateDecisionResults, setXeroCreateDecisionResults] = useState<XeroSearchResult[]>([])
  const [xeroDecisionContactId, setXeroDecisionContactId] = useState("")
  const [xeroDecisionError, setXeroDecisionError] = useState("")
  const isAdultMember = member?.ageTier === "ADULT"
  const memberId = member?.id
  const shouldAutoOpenEdit = searchParams.get("edit") === "true"

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
      setPendingAdjustmentRequests(data.pendingRequests ?? [])
    } catch { setCreditError("Failed to load credits") }
    finally { setCreditLoading(false) }
  }

  const handleAdjustmentSubmit = async () => {
    const cents = Math.round(parseFloat(adjustmentAmount) * 100)
    if (isNaN(cents) || cents === 0) { setAdjustmentError("Enter a non-zero amount"); return }
    if (!adjustmentDescription.trim()) { setAdjustmentError("Description is required"); return }
    const idempotencyKey = adjustmentIdempotencyKey ?? crypto.randomUUID()
    if (!adjustmentIdempotencyKey) {
      setAdjustmentIdempotencyKey(idempotencyKey)
    }
    setAdjustmentSaving(true); setAdjustmentError("")
    try {
      const res = await fetch(`/api/admin/members/${id}/credits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountCents: cents,
          description: adjustmentDescription.trim(),
          idempotencyKey,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { throw new Error(data.error || "Failed to save adjustment") }
      setShowAdjustmentForm(false)
      setAdjustmentAmount("")
      setAdjustmentDescription("")
      setAdjustmentIdempotencyKey(null)
      setSuccess(data.message || "Credit adjustment submitted for approval")
      setTimeout(() => setSuccess(""), 3000)
      await fetchCredits()
    } catch (err) { setAdjustmentError(err instanceof Error ? err.message : "Failed to save adjustment") }
    finally { setAdjustmentSaving(false) }
  }

  const toggleAdjustmentForm = () => {
    setAdjustmentError("")
    setAdjustmentIdempotencyKey(
      showAdjustmentForm ? null : crypto.randomUUID()
    )
    setShowAdjustmentForm((current) => !current)
  }

  const handleReviewAdjustmentRequest = async (
    requestId: string,
    decision: "APPROVE" | "REJECT"
  ) => {
    setReviewingAdjustmentId(requestId)
    setAdjustmentError("")
    try {
      const res = await fetch(`/api/admin/members/${id}/credits/${requestId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to review adjustment")
      }

      const data = await res.json()
      setSuccess(data.message || "Adjustment reviewed")
      setTimeout(() => setSuccess(""), 3000)
      await fetchCredits()
    } catch (err) {
      setAdjustmentError(
        err instanceof Error ? err.message : "Failed to review adjustment"
      )
    } finally {
      setReviewingAdjustmentId(null)
    }
  }

  useEffect(() => { fetchMember(); fetchCredits() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setHasHandledInitialEditParam(false)
  }, [id])

  useEffect(() => {
    if (!editOpen || !memberId || form.canLogin) {
      setInheritEmailSearchResults([])
      setInheritEmailSearchError("")
      setInheritEmailSearching(false)
      return
    }

    const query = inheritEmailSearch.trim()
    if (query.length < 2) {
      setInheritEmailSearchResults([])
      setInheritEmailSearchError("")
      setInheritEmailSearching(false)
      return
    }

    let cancelled = false
    setInheritEmailSearching(true)
    setInheritEmailSearchError("")

    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          q: query,
          pageSize: "8",
          inheritEmailEligible: "true",
          excludeId: memberId,
        })
        const res = await fetch(`/api/admin/members?${params.toString()}`)
        const data = await res.json().catch(() => ({}))

        if (!res.ok) {
          throw new Error(data.error || "Failed to search eligible adult members")
        }

        if (!cancelled) {
          setInheritEmailSearchResults(
            (data.members ?? [])
              .map((candidate: {
                id: string
                firstName: string
                lastName: string
                email: string
                active: boolean
              }) => ({
                id: candidate.id,
                firstName: candidate.firstName,
                lastName: candidate.lastName,
                email: candidate.email,
                active: candidate.active,
              }))
              .filter((candidate: EmailInheritanceSearchResult) => candidate.id !== selectedInheritEmailSource?.id)
          )
        }
      } catch (error) {
        if (!cancelled) {
          setInheritEmailSearchResults([])
          setInheritEmailSearchError(error instanceof Error ? error.message : "Failed to search eligible adult members")
        }
      } finally {
        if (!cancelled) {
          setInheritEmailSearching(false)
        }
      }
    }, 300)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [editOpen, form.canLogin, inheritEmailSearch, memberId, selectedInheritEmailSource?.id])

  const openEditDialog = useCallback(() => {
    if (!member) return
    setForm({
      firstName: member.firstName,
      lastName: member.lastName,
      email: member.email,
      phoneCountryCode: member.phoneCountryCode || "",
      phoneAreaCode: member.phoneAreaCode || "",
      phoneNumber: member.phoneNumber || "",
      dateOfBirth: member.dateOfBirth ? new Date(member.dateOfBirth).toISOString().split("T")[0] : "",
      joinedDate: member.joinedDate ? new Date(member.joinedDate).toISOString().split("T")[0] : "",
      role: member.role,
      ageTier: member.ageTier,
      financeAccessLevel: member.financeAccessLevel,
      active: member.active,
      canLogin: member.canLogin,
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
    setSelectedInheritEmailSource(member.inheritEmailFrom ? {
      id: member.inheritEmailFrom.id,
      firstName: member.inheritEmailFrom.firstName,
      lastName: member.inheritEmailFrom.lastName,
      email: member.inheritEmailFrom.email,
    } : null)
    setInheritEmailSearch("")
    setInheritEmailSearchResults([])
    setInheritEmailSearchError("")
    setXeroChoice("")
    setSelectedXeroContactId("")
    setXeroSearchQuery("")
    setXeroSearchResults([])
    setXeroCreateEntranceFeeInvoice(false)
    setXeroError("")
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
  }, [member])

  useEffect(() => {
    if (
      hasHandledInitialEditParam ||
      !shouldAutoOpenEdit ||
      loading ||
      !member
    ) {
      return
    }

    openEditDialog()
    setHasHandledInitialEditParam(true)
  }, [hasHandledInitialEditParam, loading, member, openEditDialog, shouldAutoOpenEdit])

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
          joinedDate: form.joinedDate || null,
          role: form.role,
          ageTier: form.ageTier,
          financeAccessLevel: form.financeAccessLevel,
          active: form.active,
          canLogin: form.canLogin,
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

  const selectInheritEmailSource = (source: EmailInheritanceSearchResult) => {
    setSelectedInheritEmailSource(source)
    setForm((current) => ({ ...current, inheritEmailFromId: source.id }))
    setInheritEmailSearch("")
    setInheritEmailSearchResults([])
    setInheritEmailSearchError("")
  }

  const clearInheritEmailSource = () => {
    setSelectedInheritEmailSource(null)
    setForm((current) => ({ ...current, inheritEmailFromId: null }))
    setInheritEmailSearch("")
    setInheritEmailSearchResults([])
    setInheritEmailSearchError("")
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
      setXeroChoice("")
      setSelectedXeroContactId("")
      setXeroSearchQuery("")
      setXeroSearchResults([])
      setXeroSearchOpen(false)
      setSuccess("Member linked to Xero contact")
      setTimeout(() => setSuccess(""), 3000)
      setLoading(true)
      await fetchMember()
    } catch (err) { setXeroError(err instanceof Error ? err.message : "Link failed") }
    finally { setXeroLinking(false) }
  }

  const handleXeroUnlink = async () => {
    setXeroUnlinking(true); setXeroError("")
    try {
      const res = await fetch(`/api/admin/members/${id}/xero-unlink`, { method: "POST" })
      if (!res.ok) { const data = await res.json(); throw new Error(data.error || "Unlink failed") }
      setXeroChoice("")
      setSelectedXeroContactId("")
      setXeroSearchQuery("")
      setXeroSearchResults([])
      setXeroCreateEntranceFeeInvoice(false)
      setSuccess("Member unlinked from Xero")
      setTimeout(() => setSuccess(""), 3000)
      setLoading(true)
      await fetchMember()
    } catch (err) { setXeroError(err instanceof Error ? err.message : "Unlink failed") }
    finally { setXeroUnlinking(false) }
  }

  const requestXeroPush = async (options?: {
    createEntranceFeeInvoice?: boolean
    forceCreate?: boolean
  }) => {
    const res = await fetch(`/api/admin/members/${id}/xero-push`, {
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
      throw new Error(data.error || "Push failed")
    }

    return {
      status: "created" as const,
      data,
    }
  }

  const applyXeroPushSuccess = async (
    data: XeroPushResponse,
    createEntranceFeeInvoice: boolean
  ) => {
    setXeroChoice("")
    setSelectedXeroContactId("")
    setXeroSearchQuery("")
    setXeroSearchResults([])
    setXeroCreateOpen(false)
    setXeroCreateDecisionOpen(false)
    setXeroCreateDecisionResults([])
    setXeroDecisionContactId("")
    setXeroDecisionError("")
    setSuccess(
      createEntranceFeeInvoice && data.entranceFeeInvoiceQueued
        ? "Member created in Xero and entrance fee invoice queued"
        : "Member created in Xero"
    )
    setTimeout(() => setSuccess(""), 3000)

    const warning =
      typeof data.warning === "string"
        ? data.warning
        : createEntranceFeeInvoice &&
          typeof data.entranceFeeInvoiceMessage === "string" &&
          !data.entranceFeeInvoiceQueued
          ? data.entranceFeeInvoiceMessage
          : ""

    if (warning) {
      setXeroError(warning)
    }

    setLoading(true)
    await fetchMember()
  }

  const handleXeroPush = async (forceCreate = false) => {
    setXeroPushing(true); setXeroError("")
    try {
      const result = await requestXeroPush({
        createEntranceFeeInvoice: xeroCreateEntranceFeeInvoice,
        forceCreate,
      })
      if (result.status === "needsDecision") {
        setXeroCreateOpen(false)
        setXeroCreateDecisionResults(result.suggestedContacts)
        setXeroDecisionContactId(
          result.suggestedContacts.find((contact) => !contact.isLinked)?.contactId ?? ""
        )
        setXeroDecisionError("")
        setXeroCreateDecisionOpen(true)
        return
      }

      await applyXeroPushSuccess(result.data, xeroCreateEntranceFeeInvoice)
    } catch (err) { setXeroError(err instanceof Error ? err.message : "Push failed") }
    finally { setXeroPushing(false) }
  }

  const handleXeroDecisionLink = async () => {
    if (!xeroDecisionContactId) return

    setXeroLinking(true)
    setXeroDecisionError("")
    try {
      const res = await fetch(`/api/admin/members/${id}/xero-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ xeroContactId: xeroDecisionContactId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || "Link failed")
      }
      setXeroChoice("")
      setSelectedXeroContactId("")
      setXeroSearchQuery("")
      setXeroSearchResults([])
      setXeroCreateDecisionOpen(false)
      setXeroCreateDecisionResults([])
      setXeroDecisionContactId("")
      setSuccess("Member linked to Xero contact")
      setTimeout(() => setSuccess(""), 3000)
      setLoading(true)
      await fetchMember()
    } catch (err) {
      setXeroDecisionError(err instanceof Error ? err.message : "Link failed")
    } finally {
      setXeroLinking(false)
    }
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
  const fmtDateTime = (d: string) => new Date(d).toLocaleString("en-NZ", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" })

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
              <Badge variant="secondary" className={financeAccessBadgeClass[member.financeAccessLevel]}>{financeAccessLabels[member.financeAccessLevel]}</Badge>
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
              <>
                <a href={`https://go.xero.com/Contacts/View/${member.xeroContactId}`} target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" size="sm"><ExternalLink className="h-4 w-4 mr-1" />View in Xero</Button>
                </a>
                <Button variant="outline" size="sm" onClick={() => { setXeroSearchOpen(true); setXeroSearchQuery(""); setXeroSearchResults([]); setXeroError(""); }}>
                  <Link2 className="h-4 w-4 mr-1" />Change Link
                </Button>
                <Button variant="outline" size="sm" onClick={handleXeroUnlink} disabled={xeroUnlinking}>
                  {xeroUnlinking ? "Unlinking..." : "Unlink"}
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={() => { setXeroSearchOpen(true); setXeroSearchQuery(""); setXeroSearchResults([]); setXeroError(""); }}><Link2 className="h-4 w-4 mr-1" />Link to Xero</Button>
                <Button variant="outline" size="sm" onClick={() => { setXeroCreateEntranceFeeInvoice(false); setXeroCreateOpen(true); setXeroError(""); }} disabled={xeroPushing}><Plus className="h-4 w-4 mr-1" />{xeroPushing ? "Creating..." : "Create in Xero"}</Button>
              </>
            )}
            <Button size="sm" onClick={openEditDialog}><Pencil className="h-4 w-4 mr-1" />Edit Member</Button>
          </div>
        </div>
      </div>

      {success && <div className="p-3 bg-green-50 border border-green-200 text-green-700 rounded-md text-sm">{success}</div>}
      {xeroError && !xeroSearchOpen && !editOpen && !xeroCreateOpen && !xeroCreateDecisionOpen && (
        <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-md text-sm">{xeroError}</div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card><CardContent className="pt-6"><div className="flex items-center gap-3"><User className="h-8 w-8 text-slate-400" /><div><p className="text-xs text-slate-500 uppercase tracking-wide">Age Tier</p><p className="text-lg font-semibold">{member.ageTier.charAt(0) + member.ageTier.slice(1).toLowerCase()}</p>{member.dateOfBirth && <p className="text-xs text-slate-400">DOB: {fmtDate(member.dateOfBirth)}</p>}</div></div></CardContent></Card>
        <Card><CardContent className="pt-6"><div className="flex items-center gap-3"><Calendar className="h-8 w-8 text-slate-400" /><div><p className="text-xs text-slate-500 uppercase tracking-wide">Total Bookings</p><p className="text-lg font-semibold">{member.stats.totalBookings}</p></div></div></CardContent></Card>
        <Card><CardContent className="pt-6"><div className="flex items-center gap-3"><CreditCard className="h-8 w-8 text-slate-400" /><div><p className="text-xs text-slate-500 uppercase tracking-wide">Total Spend</p><p className="text-lg font-semibold">{fmt(member.stats.totalSpendCents)}</p></div></div></CardContent></Card>
        <Card><CardContent className="pt-6"><div className="flex items-center gap-3"><Clock className="h-8 w-8 text-slate-400" /><div><p className="text-xs text-slate-500 uppercase tracking-wide">Last Stay</p><p className="text-lg font-semibold">{member.stats.lastStay ? fmtDate(member.stats.lastStay) : "Never"}</p></div></div></CardContent></Card>
      </div>

      <Card><CardHeader><CardTitle className="text-base font-medium">Member Information</CardTitle></CardHeader><CardContent><dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
        <div><dt className="text-slate-500">Phone</dt><dd className="font-medium">{member.phoneNumber ? [member.phoneCountryCode ? `+${member.phoneCountryCode}` : null, member.phoneAreaCode, member.phoneNumber].filter(Boolean).join(" ") : "Not provided"}</dd></div>
        <div><dt className="text-slate-500">Member Since</dt><dd className="font-medium">{fmtDate(member.joinedDate || member.createdAt)}{member.joinedDate && <span className="text-xs text-slate-400 ml-1">(from Xero)</span>}</dd></div>
        <div><dt className="text-slate-500">Finance Access</dt><dd className="font-medium"><Badge variant="secondary" className={financeAccessBadgeClass[member.financeAccessLevel]}>{financeAccessLabels[member.financeAccessLevel]}</Badge></dd></div>
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
            {!member.xeroContactId && (
              <p className="text-xs text-amber-700">
                Membership refresh skips unlinked members. Link or create a Xero
                contact before expecting subscription status to update
                automatically.
              </p>
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
              <p className="text-xs text-slate-500">
                Cached contact groups have not been refreshed yet.
              </p>
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
          <div className="space-y-3">{member.auditLogs.map((log) => {
            const timestamp = fmtDateTime(log.createdAt)
            const structuredDetails = parseInviteAuditDetails(log.details)
            const isInviteAudit = log.action === "member.setup-invite-sent" || log.action === "member.password-reset-sent"

            return (
              <div key={log.id} className="flex items-start justify-between border-b border-slate-100 pb-2 last:border-0">
                <div>
                  <p className="text-sm font-medium text-slate-700">{formatMemberAuditLogSummary(log, timestamp)}</p>
                  {(!isInviteAudit || !structuredDetails) && <p className="text-xs text-slate-500 mt-0.5">By {getAuditActorDisplayName(log.actor)}</p>}
                  {log.details && (!isInviteAudit || !structuredDetails) && <p className="text-xs text-slate-500 mt-0.5">{log.details}</p>}
                </div>
                <span className="text-xs text-slate-400 whitespace-nowrap ml-4">{timestamp}</span>
              </div>
            )
          })}</div>)}
      </CardContent></Card>

      <Card><CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2"><CardTitle className="text-base font-medium">Account Credit</CardTitle><div className="flex items-center gap-3"><span className={`text-lg font-semibold ${creditBalance > 0 ? "text-green-700" : creditBalance < 0 ? "text-red-700" : "text-slate-700"}`}>{`$${(creditBalance / 100).toFixed(2)}`}</span><Button size="sm" variant="outline" onClick={toggleAdjustmentForm}>{showAdjustmentForm ? "Cancel" : "Request Adjustment"}</Button></div></CardHeader><CardContent>
        {adjustmentError && <div className="mb-4 p-2 bg-red-50 border border-red-200 text-red-700 rounded text-sm">{adjustmentError}</div>}
        {showAdjustmentForm && (
          <div className="mb-4 p-4 border border-slate-200 rounded-md bg-slate-50 space-y-3">
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
            <p className="text-xs text-slate-500">A different admin must approve this request before the member&apos;s credit balance changes.</p>
            <Button size="sm" onClick={handleAdjustmentSubmit} disabled={adjustmentSaving}>{adjustmentSaving ? "Saving..." : "Submit for Approval"}</Button>
          </div>
        )}
        {creditLoading ? <p className="text-sm text-slate-500">Loading credit history...</p> : creditError ? <p className="text-sm text-red-600">{creditError}</p> : (
          <>
            {pendingAdjustmentRequests.length > 0 && (
              <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-4">
                <div className="mb-3">
                  <p className="text-sm font-medium text-amber-900">Pending manual adjustments</p>
                  <p className="text-xs text-amber-800">Each request needs approval from a different admin before it becomes account credit.</p>
                </div>
                <Table><TableHeader><TableRow><TableHead>Requested</TableHead><TableHead>Amount</TableHead><TableHead>Description</TableHead><TableHead>Requested By</TableHead><TableHead className="text-right">Action</TableHead></TableRow></TableHeader><TableBody>{pendingAdjustmentRequests.map((item) => {
                  const isOwnRequest = session?.user?.id === item.requestedBy.id
                  const isReviewing = reviewingAdjustmentId === item.id
                  return (
                    <TableRow key={item.id}>
                      <TableCell className="text-sm">{fmtDate(item.createdAt)}</TableCell>
                      <TableCell className={`font-medium ${item.amountCents > 0 ? "text-green-700" : "text-red-700"}`}>{`${item.amountCents > 0 ? "+" : ""}$${(item.amountCents / 100).toFixed(2)}`}</TableCell>
                      <TableCell className="text-sm text-slate-600 max-w-[260px] truncate">{item.description}</TableCell>
                      <TableCell className="text-sm">{formatAdminName(item.requestedBy)}</TableCell>
                      <TableCell className="text-right">
                        {isOwnRequest ? (
                          <span className="text-xs text-amber-700">Needs another admin</span>
                        ) : (
                          <div className="flex items-center justify-end gap-2">
                            <Button size="sm" variant="outline" disabled={isReviewing} onClick={() => handleReviewAdjustmentRequest(item.id, "APPROVE")}>{isReviewing ? "Working..." : "Approve"}</Button>
                            <Button size="sm" variant="ghost" disabled={isReviewing} onClick={() => handleReviewAdjustmentRequest(item.id, "REJECT")}>Reject</Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}</TableBody></Table>
              </div>
            )}
            {creditHistory.length === 0 ? <p className="text-sm text-slate-500">No credit transactions</p> : (
          <Table><TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Type</TableHead><TableHead>Amount</TableHead><TableHead>Description</TableHead><TableHead>Approval</TableHead><TableHead>Booking Ref</TableHead></TableRow></TableHeader><TableBody>{creditHistory.map((item) => (
            <TableRow key={item.id}>
              <TableCell className="text-sm">{fmtDate(item.createdAt)}</TableCell>
              <TableCell><Badge variant="secondary" className={item.type === "CANCELLATION_REFUND" ? "bg-orange-100 text-orange-800 border-orange-200" : item.type === "ADMIN_ADJUSTMENT" ? "bg-blue-100 text-blue-800 border-blue-200" : "bg-purple-100 text-purple-800 border-purple-200"}>{item.type.replace(/_/g, " ")}</Badge></TableCell>
              <TableCell className={`font-medium ${item.amountCents > 0 ? "text-green-700" : "text-red-700"}`}>{`${item.amountCents > 0 ? "+" : ""}$${(item.amountCents / 100).toFixed(2)}`}</TableCell>
              <TableCell className="text-sm text-slate-600 max-w-[200px] truncate">{item.description}</TableCell>
              <TableCell className="text-xs text-slate-600">
                {item.type === "ADMIN_ADJUSTMENT" && (item.requestedBy || item.approvedBy) ? (
                  <div className="space-y-1">
                    {item.requestedBy && <p>Requested by {formatAdminName(item.requestedBy)}</p>}
                    {item.approvedBy && <p>Approved by {formatAdminName(item.approvedBy)}{item.approvalRequest?.reviewedAt ? ` on ${fmtDate(item.approvalRequest.reviewedAt)}` : ""}</p>}
                  </div>
                ) : (
                  <span className="text-slate-400">-</span>
                )}
              </TableCell>
              <TableCell className="text-sm">{item.sourceBooking ? <span className="text-blue-600">{fmtDate(item.sourceBooking.checkIn)} - {fmtDate(item.sourceBooking.checkOut)}</span> : item.appliedToBooking ? <span className="text-purple-600">{fmtDate(item.appliedToBooking.checkIn)} - {fmtDate(item.appliedToBooking.checkOut)}</span> : "-"}</TableCell>
            </TableRow>
          ))}</TableBody></Table>
            )}
          </>
        )}
      </CardContent></Card>

      <Dialog open={xeroSearchOpen} onOpenChange={setXeroSearchOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{member.xeroContactId ? "Change Xero Contact Link" : "Link to Xero Contact"}</DialogTitle>
            <DialogDescription>
              {member.xeroContactId
                ? `Search for a different Xero contact to relink ${member.firstName} ${member.lastName}.`
                : `Search for an existing Xero contact to link to ${member.firstName} ${member.lastName}.`}
            </DialogDescription>
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

      <Dialog open={xeroCreateOpen} onOpenChange={setXeroCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create Xero Contact</DialogTitle>
            <DialogDescription>
              Create a brand-new Xero contact for {member.firstName} {member.lastName}. We&apos;ll check for similar existing contacts before the new contact is created.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              Use this only when you&apos;re confident the member should not be linked to an existing Xero contact.
            </div>
            <div className="flex items-start gap-2">
              <input
                type="checkbox"
                id="member-detail-xero-create-invoice"
                checked={xeroCreateEntranceFeeInvoice}
                onChange={e => setXeroCreateEntranceFeeInvoice(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-gray-300"
              />
              <div>
                <Label htmlFor="member-detail-xero-create-invoice">Create membership entrance fee invoice after contact creation</Label>
                <p className="text-xs text-muted-foreground">Leave this unchecked if you only want to create and link the Xero contact for now.</p>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setXeroCreateOpen(false)} disabled={xeroPushing}>Cancel</Button>
            <Button onClick={() => handleXeroPush(false)} disabled={xeroPushing}>
              {xeroPushing ? "Checking..." : "Continue"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={xeroCreateDecisionOpen}
        onOpenChange={(open) => {
          setXeroCreateDecisionOpen(open)
          if (!open) {
            setXeroCreateDecisionResults([])
            setXeroDecisionContactId("")
            setXeroDecisionError("")
          }
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Review Similar Xero Contacts</DialogTitle>
            <DialogDescription>
              We found existing Xero contacts that may already belong to {member.firstName} {member.lastName}. Link one of these if appropriate, or create a new contact anyway.
            </DialogDescription>
          </DialogHeader>
          {xeroDecisionError && <div className="p-2 bg-red-50 border border-red-200 text-red-700 rounded text-sm">{xeroDecisionError}</div>}
          <div className="space-y-3">
            <div className="max-h-[360px] overflow-y-auto space-y-2">
              {xeroCreateDecisionResults.map((contact) => (
                <label
                  key={contact.contactId}
                  className={`flex items-start gap-3 rounded-md border p-3 ${
                    contact.isLinked ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-white"
                  }`}
                >
                  <input
                    type="radio"
                    name="member-detail-potential-xero-contact"
                    value={contact.contactId}
                    checked={xeroDecisionContactId === contact.contactId}
                    onChange={() => setXeroDecisionContactId(contact.contactId)}
                    disabled={contact.isLinked}
                    className="mt-1 h-4 w-4 border-gray-300"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-slate-900">{contact.name}</p>
                      {contact.matchReasons?.map((reason) => (
                        <Badge key={`${contact.contactId}-${reason}`} variant="secondary" className="bg-blue-50 text-blue-700 border-blue-200">
                          {reason}
                        </Badge>
                      ))}
                    </div>
                    {contact.email && <p className="text-xs text-slate-500">{contact.email}</p>}
                    {contact.isLinked && (
                      <p className="text-xs text-amber-700">Already linked to {contact.linkedMemberName}</p>
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
            {xeroCreateEntranceFeeInvoice && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                If you choose <span className="font-medium">Create New Contact Anyway</span>, the membership entrance fee invoice will also be queued.
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setXeroCreateDecisionOpen(false)} disabled={xeroLinking || xeroPushing}>Do This Later</Button>
            <Button variant="outline" onClick={handleXeroDecisionLink} disabled={xeroLinking || xeroPushing || !xeroDecisionContactId}>
              {xeroLinking ? "Linking..." : "Link Selected Contact"}
            </Button>
            <Button onClick={() => handleXeroPush(true)} disabled={xeroLinking || xeroPushing}>
              {xeroPushing ? "Creating..." : "Create New Contact Anyway"}
            </Button>
          </DialogFooter>
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
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="edit-canLogin"
                checked={form.canLogin}
                onChange={e => setForm(f => ({
                  ...f,
                  canLogin: e.target.checked,
                  financeAccessLevel: e.target.checked ? f.financeAccessLevel : "NONE",
                }))}
                className="h-4 w-4 rounded border-gray-300"
                disabled={isSelf}
              />
              <Label htmlFor="edit-canLogin">Can Login</Label>
              <p className="text-xs text-muted-foreground ml-2">
                Adults who can sign in and make bookings. Uncheck for children or youth managed by family group.
                {isSelf ? " You cannot disable login for your own admin account." : ""}
              </p>
            </div>
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
              <Label htmlFor="edit-joinedDate">Joined Date</Label>
              <Input id="edit-joinedDate" type="date" value={form.joinedDate} onChange={e => setForm(f => ({ ...f, joinedDate: e.target.value }))} />
              <p className="text-xs text-muted-foreground">Used for finance and Xero-linked member history.</p>
            </div>
            <fieldset className="space-y-3 rounded-md border border-slate-200 p-4">
              <legend className="px-1 text-sm font-medium">Xero</legend>
              <p className="text-sm text-slate-600">
                Manage this member&apos;s linked Xero contact from the same editor.
              </p>
              {xeroError && (
                <div className="p-2 bg-red-50 border border-red-200 text-red-700 rounded text-sm">
                  {xeroError}
                </div>
              )}
              {member.xeroContactId ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary" className="bg-blue-50 text-blue-700 border-blue-200">
                      Linked
                    </Badge>
                    <a
                      href={`https://go.xero.com/Contacts/View/${member.xeroContactId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-blue-600 hover:underline inline-flex items-center gap-1"
                    >
                      View in Xero
                      <ExternalLink className="h-3 w-3" />
                    </a>
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
                  {member.xeroContactId && !member.xeroContactGroupsLoaded && (
                    <p className="text-xs text-slate-500">
                      Cached contact groups have not been refreshed yet.
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setXeroChoice(xeroChoice === "change" ? "" : "change")
                        setSelectedXeroContactId("")
                        setXeroSearchQuery("")
                        setXeroSearchResults([])
                        setXeroError("")
                      }}
                    >
                      <Link2 className="h-4 w-4 mr-1" />
                      {xeroChoice === "change" ? "Cancel Change" : "Change Link"}
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={handleXeroUnlink} disabled={xeroUnlinking}>
                      {xeroUnlinking ? "Unlinking..." : "Unlink"}
                    </Button>
                  </div>
                  {xeroChoice === "change" && (
                    <div className="space-y-3 rounded-md border border-blue-200 bg-blue-50 p-3">
                      <p className="text-sm text-blue-800">
                        Search for a different Xero contact to link to this member. The current link will be replaced.
                      </p>
                      <div className="flex gap-2">
                        <Input
                          placeholder="Search Xero by name or email"
                          value={xeroSearchQuery}
                          onChange={e => setXeroSearchQuery(e.target.value)}
                          onKeyDown={e => e.key === "Enter" && handleXeroSearch()}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          onClick={handleXeroSearch}
                          disabled={xeroSearching || xeroSearchQuery.trim().length < 2}
                        >
                          {xeroSearching ? "Searching..." : "Search"}
                        </Button>
                      </div>
                      {xeroSearchResults.filter((contact) => !contact.isLinked).length > 0 && (
                        <div className="space-y-2">
                          <Label>Available Xero contacts</Label>
                          <Select value={selectedXeroContactId || undefined} onValueChange={setSelectedXeroContactId}>
                            <SelectTrigger>
                              <SelectValue placeholder="Select a Xero contact" />
                            </SelectTrigger>
                            <SelectContent>
                              {xeroSearchResults
                                .filter((contact) => !contact.isLinked)
                                .map((contact) => (
                                  <SelectItem key={contact.contactId} value={contact.contactId}>
                                    {contact.name}{contact.email ? ` (${contact.email})` : ""}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                      {selectedXeroContactId && (
                        <Button type="button" size="sm" onClick={() => handleXeroLink(selectedXeroContactId)} disabled={xeroLinking}>
                          {xeroLinking ? "Linking..." : "Link to Selected Contact"}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-slate-600">This member is not linked to a Xero contact.</p>
                  <p className="text-xs text-amber-700">
                    Membership refresh skips unlinked members. Link or create a Xero contact before expecting subscription status to update automatically.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setXeroSearchOpen(true)
                        setXeroSearchQuery("")
                        setXeroSearchResults([])
                        setXeroError("")
                      }}
                    >
                      <Link2 className="h-4 w-4 mr-1" />
                      Link to Xero
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setXeroCreateEntranceFeeInvoice(false)
                        setXeroCreateOpen(true)
                        setXeroError("")
                      }}
                      disabled={xeroPushing}
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      {xeroPushing ? "Creating..." : "Create in Xero"}
                    </Button>
                  </div>
                  {getMissingFieldsForXeroCreate(form).length > 0 && (
                    <p className="text-xs text-slate-500">
                      Missing for Xero creation: {getMissingFieldsForXeroCreate(form).join(", ")}
                    </p>
                  )}
                </div>
              )}
            </fieldset>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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
                <Select value={form.ageTier} onValueChange={v => setForm(f => ({ ...f, ageTier: v }))}>
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
            <div className="flex items-center gap-2">
              <input type="checkbox" id="edit-active" checked={form.active} onChange={e => setForm(f => ({ ...f, active: e.target.checked }))} className="h-4 w-4 rounded border-gray-300" disabled={isSelf} />
              <Label htmlFor="edit-active">Active</Label>
              {isSelf && <span className="text-xs text-muted-foreground ml-1">(cannot deactivate own account)</span>}
            </div>
            <div className="flex items-center gap-2">
              <input type="checkbox" id="edit-forcePasswordChange" checked={form.forcePasswordChange} onChange={e => setForm(f => ({ ...f, forcePasswordChange: e.target.checked }))} className="h-4 w-4 rounded border-gray-300" />
              <Label htmlFor="edit-forcePasswordChange">Force Password Change on Next Login</Label>
            </div>
            {!form.canLogin && (
              <div className="space-y-2">
                <Label htmlFor="edit-inheritEmailSearch">Notification Email Recipient (optional)</Label>
                <p className="text-xs text-muted-foreground">
                  Search for a primary adult member who should receive this member&apos;s notifications.
                  Leave it blank to use this member&apos;s own email address instead.
                </p>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
                  {selectedInheritEmailSource ? (
                    <div className="space-y-2">
                      <div className="font-medium text-slate-900">
                        Sending notifications to {selectedInheritEmailSource.firstName} {selectedInheritEmailSource.lastName}
                      </div>
                      <div className="text-xs text-slate-600">
                        {selectedInheritEmailSource.email} · Member ID {selectedInheritEmailSource.id}
                        {selectedInheritEmailSource.active === false ? " · Inactive" : ""}
                      </div>
                      <Button type="button" variant="outline" size="sm" onClick={clearInheritEmailSource}>
                        Use this member&apos;s own email instead
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <div className="font-medium text-slate-900">Using this member&apos;s own email</div>
                      <div className="text-xs text-slate-600">{form.email || "No email set on this member"}</div>
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  <Input
                    id="edit-inheritEmailSearch"
                    value={inheritEmailSearch}
                    onChange={e => setInheritEmailSearch(e.target.value)}
                    placeholder={selectedInheritEmailSource ? "Search to replace the selected adult" : "Search adult members by name or email"}
                  />
                  {inheritEmailSearching ? (
                    <p className="text-xs text-muted-foreground">Searching eligible adult members...</p>
                  ) : inheritEmailSearchError ? (
                    <p className="text-xs text-red-600">{inheritEmailSearchError}</p>
                  ) : inheritEmailSearch.trim().length >= 2 ? (
                    inheritEmailSearchResults.length > 0 ? (
                      <div className="max-h-48 space-y-2 overflow-auto rounded-md border border-slate-200 bg-white p-2">
                        {inheritEmailSearchResults.map((candidate) => (
                          <button
                            key={candidate.id}
                            type="button"
                            className="w-full rounded-md border border-slate-200 px-3 py-2 text-left text-sm hover:bg-slate-50"
                            onClick={() => selectInheritEmailSource(candidate)}
                          >
                            <div className="font-medium text-slate-900">
                              {candidate.firstName} {candidate.lastName}
                            </div>
                            <div className="text-xs text-slate-600">
                              {candidate.email} · Member ID {candidate.id}
                              {candidate.active === false ? " · Inactive" : ""}
                            </div>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        No eligible primary adult members matched &quot;{inheritEmailSearch.trim()}&quot;.
                      </p>
                    )
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Only primary adult members can be selected. Start typing at least 2 characters to search.
                    </p>
                  )}
                </div>
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
