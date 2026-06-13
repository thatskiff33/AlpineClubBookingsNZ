"use client"

import { useCallback, useEffect, useState, use } from "react"
import { useSession } from "next-auth/react"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { ArrowLeft } from "lucide-react"
import { FamilyGroupEditorDialog } from "@/components/admin/family-group-editor-dialog"
import type { XeroSearchResult } from "@/components/admin/xero-suggested-contact-card"
import {
  formatMemberAuditLogSummary as formatMemberAuditLogSummaryHelper,
  getAuditActorDisplayName as getAuditActorDisplayNameHelper,
  getMemberDetailBackLabel,
  memberUsesSamePostalAddress,
  parseInviteAuditDetails as parseInviteAuditDetailsHelper,
  shouldDefaultLinkSideEffects,
} from "@/lib/admin-member-detail-helpers"
import { resolveInternalReturnPath } from "@/lib/internal-return-path"
import { useXeroEntranceFeeDecision } from "@/lib/admin-xero-entrance-fee"
import {
  linkMemberXeroContact,
  pushMemberToXero,
  searchXeroContacts,
  unlinkMemberXeroContact,
  type XeroPushResponse,
} from "@/lib/admin-member-xero-actions"
import {
  NZ_COUNTRY_NAME,
  withDefaultNzCountry,
  type MemberAddressValues,
} from "@/lib/member-address"
import { MemberDetailHeader } from "./_components/member-detail-header"
import { MemberStatsCards } from "./_components/member-stats-cards"
import { MemberInfoCard } from "./_components/member-info-card"
import { MemberDeletionCard } from "./_components/member-deletion-card"
import { MemberLifecycleCard } from "./_components/member-lifecycle-card"
import { MemberParentLinksCard } from "./_components/member-parent-links-card"
import { MemberPromoCodesCard } from "./_components/member-promo-codes-card"
import { MemberDependentsCard } from "./_components/member-dependents-card"
import { MemberCreditCard } from "./_components/member-credit-card"
import { MemberHistoryAccordion } from "./_components/member-history-accordion"
import { MemberEditDialog } from "./_components/member-edit-dialog"
import { MemberXeroLinkDialog } from "./_components/member-xero-link-dialog"
import { MemberXeroCreateDialog } from "./_components/member-xero-create-dialog"
import { MemberXeroDecisionDialog } from "./_components/member-xero-decision-dialog"
import { MemberParentLinkDialog } from "./_components/member-parent-link-dialog"
import { MemberDependentDialog } from "./_components/member-dependent-dialog"
import { MemberDeleteRequestDialog } from "./_components/member-delete-request-dialog"
import { MemberDeleteReviewDialog } from "./_components/member-delete-review-dialog"
import { useCollapsibleMemberSections } from "./_hooks/use-collapsible-member-sections"
import type {
  CreditHistoryItem,
  DependentDialogMode,
  DependentForm,
  EditForm,
  EmailInheritanceSearchResult,
  LinkDependentSearchResult,
  LinkParentSearchResult,
  MemberDetail,
  MemberLifecycleActionRequest,
  PendingCreditAdjustmentItem,
} from "./_types"

// Re-exports preserve the existing import paths used by tests and other callers
// that previously imported these helpers from the page route.
export const formatMemberAuditLogSummary = formatMemberAuditLogSummaryHelper
export const parseInviteAuditDetails = parseInviteAuditDetailsHelper
export const getAuditActorDisplayName = getAuditActorDisplayNameHelper

const defaultEditForm: EditForm = {
  firstName: "",
  lastName: "",
  email: "",
  phoneCountryCode: "",
  phoneAreaCode: "",
  phoneNumber: "",
  dateOfBirth: "",
  joinedDate: "",
  role: "MEMBER",
  ageTier: "ADULT",
  financeAccessLevel: "NONE",
  active: true,
  canLogin: true,
  forcePasswordChange: false,
  inheritEmailFromId: null,
  streetAddressLine1: "",
  streetAddressLine2: "",
  streetCity: "",
  streetRegion: "",
  streetPostalCode: "",
  streetCountry: "",
  postalAddressLine1: "",
  postalAddressLine2: "",
  postalCity: "",
  postalRegion: "",
  postalPostalCode: "",
  postalCountry: "",
}

const defaultDependentForm: DependentForm = {
  firstName: "",
  lastName: "",
  email: "",
  dateOfBirth: "",
  phoneCountryCode: "",
  phoneAreaCode: "",
  phoneNumber: "",
  streetAddressLine1: "",
  streetAddressLine2: "",
  streetCity: "",
  streetRegion: "",
  streetPostalCode: "",
  streetCountry: NZ_COUNTRY_NAME,
  postalAddressLine1: "",
  postalAddressLine2: "",
  postalCity: "",
  postalRegion: "",
  postalPostalCode: "",
  postalCountry: NZ_COUNTRY_NAME,
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
  const [relationshipError, setRelationshipError] = useState("")
  const [xeroError, setXeroError] = useState("")

  // Edit dialog state
  const [editOpen, setEditOpen] = useState(false)
  const [form, setForm] = useState<EditForm>(defaultEditForm)
  const [editPostalSameAsPhysical, setEditPostalSameAsPhysical] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState("")
  const [hasHandledInitialEditParam, setHasHandledInitialEditParam] = useState(false)
  const [inheritEmailSearch, setInheritEmailSearch] = useState("")
  const [inheritEmailSearchResults, setInheritEmailSearchResults] = useState<EmailInheritanceSearchResult[]>([])
  const [inheritEmailSearchError, setInheritEmailSearchError] = useState("")
  const [inheritEmailSearching, setInheritEmailSearching] = useState(false)
  const [selectedInheritEmailSource, setSelectedInheritEmailSource] = useState<EmailInheritanceSearchResult | null>(null)

  // Dependent dialog state
  const [dependentOpen, setDependentOpen] = useState(false)
  const [dependentForm, setDependentForm] = useState<DependentForm>(defaultDependentForm)
  const [dependentPostalSameAsPhysical, setDependentPostalSameAsPhysical] = useState(false)
  const [dependentSaving, setDependentSaving] = useState(false)
  const [dependentFormError, setDependentFormError] = useState("")
  const [dependentMode, setDependentMode] = useState<DependentDialogMode>("create")
  const [linkDependentSearch, setLinkDependentSearch] = useState("")
  const [linkDependentSearchResults, setLinkDependentSearchResults] = useState<LinkDependentSearchResult[]>([])
  const [linkDependentSearching, setLinkDependentSearching] = useState(false)
  const [selectedLinkDependent, setSelectedLinkDependent] = useState<LinkDependentSearchResult | null>(null)
  const [linkDependentInheritEmail, setLinkDependentInheritEmail] = useState(false)
  const [linkDependentNotificationParentId, setLinkDependentNotificationParentId] = useState("")
  const [linkDependentDisableLogin, setLinkDependentDisableLogin] = useState(false)
  const [linkDependentFamilyGroupIds, setLinkDependentFamilyGroupIds] = useState<string[]>([])

  // Parent link dialog state
  const [parentLinkOpen, setParentLinkOpen] = useState(false)
  const [parentLinkSearch, setParentLinkSearch] = useState("")
  const [parentLinkSearchResults, setParentLinkSearchResults] = useState<LinkParentSearchResult[]>([])
  const [parentLinkSearching, setParentLinkSearching] = useState(false)
  const [selectedLinkParent, setSelectedLinkParent] = useState<LinkParentSearchResult | null>(null)
  const [parentLinkInheritEmail, setParentLinkInheritEmail] = useState(false)
  const [parentLinkNotificationParentId, setParentLinkNotificationParentId] = useState("")
  const [parentLinkDisableLogin, setParentLinkDisableLogin] = useState(false)
  const [parentLinkFamilyGroupIds, setParentLinkFamilyGroupIds] = useState<string[]>([])
  const [parentLinkSaving, setParentLinkSaving] = useState(false)
  const [parentLinkError, setParentLinkError] = useState("")
  const [unlinkingDependentId, setUnlinkingDependentId] = useState<string | null>(null)
  const [familyGroupEditorId, setFamilyGroupEditorId] = useState<string | null>(null)

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

  // Lifecycle state
  const [archiveReason, setArchiveReason] = useState("")
  const [archiveReviewNotes, setArchiveReviewNotes] = useState<Record<string, string>>({})
  const [archiveActionLoading, setArchiveActionLoading] = useState<string | null>(null)
  const [archiveError, setArchiveError] = useState("")
  const [cancellationReason, setCancellationReason] = useState("")
  const [cancellationSubmitting, setCancellationSubmitting] = useState(false)
  const [cancellationError, setCancellationError] = useState("")

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
  const {
    xeroCreateEntranceFeeInvoice,
    setXeroCreateEntranceFeeInvoice,
    xeroEntranceFeeSkipReason,
    setXeroEntranceFeeSkipReason,
    xeroEntranceFeeAmount,
    setXeroEntranceFeeAmount,
    xeroEntranceFeeNarration,
    setXeroEntranceFeeNarration,
    resetXeroEntranceFeeDecision,
    buildXeroEntranceFeeInvoiceOptions,
  } = useXeroEntranceFeeDecision()
  const [xeroCreateDecisionOpen, setXeroCreateDecisionOpen] = useState(false)
  const [xeroCreateDecisionResults, setXeroCreateDecisionResults] = useState<XeroSearchResult[]>([])
  const [xeroDecisionContactId, setXeroDecisionContactId] = useState("")
  const [xeroDecisionError, setXeroDecisionError] = useState("")

  // Delete state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleteReason, setDeleteReason] = useState("")
  const [deleteError, setDeleteError] = useState("")
  const [deleteSubmitting, setDeleteSubmitting] = useState(false)
  const [deleteReviewDialog, setDeleteReviewDialog] = useState<{
    request: MemberLifecycleActionRequest
    action: "approve" | "reject"
  } | null>(null)
  const [deleteReviewNote, setDeleteReviewNote] = useState("")
  const [deleteReviewError, setDeleteReviewError] = useState("")
  const [deleteReviewSubmitting, setDeleteReviewSubmitting] = useState(false)

  const { openSections, onValueChange: onSectionsChange } = useCollapsibleMemberSections()

  const isAdultMember = member?.ageTier === "ADULT"
  const memberIsArchived = Boolean(member?.archivedAt)
  const memberLifecycleLocked = Boolean(member?.cancelledAt || member?.archivedAt)
  const memberId = member?.id
  const shouldAutoOpenEdit = searchParams.get("edit") === "true"
  const backHref = resolveInternalReturnPath(searchParams.get("returnTo"), "/admin/members")
  const backLabel = getMemberDetailBackLabel(backHref)
  const currentMemberQuery = searchParams.toString()
  const currentMemberPath = currentMemberQuery
    ? `/admin/members/${id}?${currentMemberQuery}`
    : `/admin/members/${id}`

  const fetchMember = async () => {
    try {
      const res = await fetch(`/api/admin/members/${id}`)
      if (!res.ok) {
        setPageError(res.status === 404 ? "Member not found" : "Failed to load member")
        setLoading(false)
        return
      }
      setMember(await res.json())
      setPageError("")
    } catch {
      setPageError("Failed to load member")
    } finally {
      setLoading(false)
    }
  }

  const fetchCredits = async () => {
    setCreditLoading(true)
    setCreditError("")
    try {
      const res = await fetch(`/api/admin/members/${id}/credits`)
      if (!res.ok) {
        setCreditError("Failed to load credits")
        return
      }
      const data = await res.json()
      setCreditBalance(data.balanceCents)
      setCreditHistory(data.history)
      setPendingAdjustmentRequests(data.pendingRequests ?? [])
    } catch {
      setCreditError("Failed to load credits")
    } finally {
      setCreditLoading(false)
    }
  }

  const handleAdjustmentSubmit = async () => {
    const cents = Math.round(parseFloat(adjustmentAmount) * 100)
    if (isNaN(cents) || cents === 0) {
      setAdjustmentError("Enter a non-zero amount")
      return
    }
    if (!adjustmentDescription.trim()) {
      setAdjustmentError("Description is required")
      return
    }
    const idempotencyKey = adjustmentIdempotencyKey ?? crypto.randomUUID()
    if (!adjustmentIdempotencyKey) {
      setAdjustmentIdempotencyKey(idempotencyKey)
    }
    setAdjustmentSaving(true)
    setAdjustmentError("")
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
      if (!res.ok) {
        throw new Error(data.error || "Failed to save adjustment")
      }
      setShowAdjustmentForm(false)
      setAdjustmentAmount("")
      setAdjustmentDescription("")
      setAdjustmentIdempotencyKey(null)
      setSuccess(data.message || "Credit adjustment submitted for approval")
      setTimeout(() => setSuccess(""), 3000)
      await fetchCredits()
    } catch (err) {
      setAdjustmentError(err instanceof Error ? err.message : "Failed to save adjustment")
    } finally {
      setAdjustmentSaving(false)
    }
  }

  const toggleAdjustmentForm = () => {
    setAdjustmentError("")
    setAdjustmentIdempotencyKey(showAdjustmentForm ? null : crypto.randomUUID())
    setShowAdjustmentForm((current) => !current)
  }

  const handleReviewAdjustmentRequest = async (requestId: string, decision: "APPROVE" | "REJECT") => {
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
      setAdjustmentError(err instanceof Error ? err.message : "Failed to review adjustment")
    } finally {
      setReviewingAdjustmentId(null)
    }
  }

  const handleSubmitArchiveRequest = async () => {
    const reason = archiveReason.trim()
    if (!reason) {
      setArchiveError("Archive reason is required")
      return
    }

    setArchiveActionLoading("request")
    setArchiveError("")
    try {
      const res = await fetch(`/api/admin/members/${id}/lifecycle/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || "Failed to request archive")
      }

      setArchiveReason("")
      setSuccess("Archive request submitted")
      setTimeout(() => setSuccess(""), 3000)
      setLoading(true)
      await fetchMember()
    } catch (err) {
      setArchiveError(err instanceof Error ? err.message : "Failed to request archive")
    } finally {
      setArchiveActionLoading(null)
    }
  }

  const handleReviewArchiveRequest = async (requestId: string, action: "approve" | "reject") => {
    setArchiveActionLoading(`${action}:${requestId}`)
    setArchiveError("")
    try {
      const res = await fetch(`/api/admin/member-lifecycle-action-requests/${requestId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          note: archiveReviewNotes[requestId]?.trim() || undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || "Failed to review archive request")
      }

      setArchiveReviewNotes((current) => {
        const next = { ...current }
        delete next[requestId]
        return next
      })
      setSuccess(action === "approve" ? "Member archived" : "Archive request rejected")
      setTimeout(() => setSuccess(""), 3000)
      setLoading(true)
      await fetchMember()
    } catch (err) {
      setArchiveError(err instanceof Error ? err.message : "Failed to review archive request")
    } finally {
      setArchiveActionLoading(null)
    }
  }

  const handleSubmitCancellationRequest = async () => {
    const reason = cancellationReason.trim()
    if (!reason) {
      setCancellationError("Cancellation reason is required")
      return
    }

    setCancellationSubmitting(true)
    setCancellationError("")
    try {
      const res = await fetch(`/api/admin/members/${id}/membership-cancellation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || "Failed to request cancellation")
      }

      setCancellationReason("")
      setSuccess("Cancellation request submitted")
      setTimeout(() => setSuccess(""), 3000)
      setLoading(true)
      await fetchMember()
    } catch (err) {
      setCancellationError(err instanceof Error ? err.message : "Failed to request cancellation")
    } finally {
      setCancellationSubmitting(false)
    }
  }

  useEffect(() => {
    fetchMember()
    fetchCredits()
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

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

  useEffect(() => {
    if (!dependentOpen || dependentMode !== "link" || !memberId) {
      setLinkDependentSearchResults([])
      setLinkDependentSearching(false)
      return
    }

    const query = linkDependentSearch.trim()
    if (query.length < 2) {
      setLinkDependentSearchResults([])
      setLinkDependentSearching(false)
      return
    }

    let cancelled = false
    setLinkDependentSearching(true)

    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          q: query,
          pageSize: "8",
          dependentLinkEligibleFor: memberId,
        })
        const res = await fetch(`/api/admin/members?${params.toString()}`)
        const data = await res.json().catch(() => ({}))

        if (!res.ok) {
          throw new Error(data.error || "Failed to search members")
        }

        if (!cancelled) {
          setLinkDependentSearchResults(
            (data.members ?? [])
              .map((candidate: LinkDependentSearchResult) => ({
                id: candidate.id,
                firstName: candidate.firstName,
                lastName: candidate.lastName,
                email: candidate.email,
                ageTier: candidate.ageTier,
                active: candidate.active,
                canLogin: candidate.canLogin,
                dateOfBirth: candidate.dateOfBirth,
                parentLinks: candidate.parentLinks ?? [],
              }))
              .filter((candidate: LinkDependentSearchResult) => candidate.id !== selectedLinkDependent?.id)
          )
        }
      } catch (error) {
        if (!cancelled) {
          setLinkDependentSearchResults([])
          setDependentFormError(error instanceof Error ? error.message : "Failed to search members")
        }
      } finally {
        if (!cancelled) {
          setLinkDependentSearching(false)
        }
      }
    }, 300)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [dependentMode, dependentOpen, linkDependentSearch, memberId, selectedLinkDependent?.id])

  useEffect(() => {
    if (!parentLinkOpen || !memberId || (member?.parentLinks?.length ?? 0) >= 2) {
      setParentLinkSearchResults([])
      setParentLinkSearching(false)
      return
    }

    const query = parentLinkSearch.trim()
    if (query.length < 2) {
      setParentLinkSearchResults([])
      setParentLinkSearching(false)
      return
    }

    let cancelled = false
    setParentLinkSearching(true)
    setParentLinkError("")

    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          q: query,
          pageSize: "8",
          parentLinkEligibleFor: memberId,
        })
        const res = await fetch(`/api/admin/members?${params.toString()}`)
        const data = await res.json().catch(() => ({}))

        if (!res.ok) {
          throw new Error(data.error || "Failed to search parent members")
        }

        if (!cancelled) {
          setParentLinkSearchResults(
            (data.members ?? [])
              .map((candidate: LinkParentSearchResult) => ({
                id: candidate.id,
                firstName: candidate.firstName,
                lastName: candidate.lastName,
                email: candidate.email,
                ageTier: candidate.ageTier,
                active: candidate.active,
                canLogin: candidate.canLogin,
                dateOfBirth: candidate.dateOfBirth,
                familyGroups: candidate.familyGroups ?? [],
              }))
              .filter((candidate: LinkParentSearchResult) => candidate.id !== selectedLinkParent?.id)
          )
        }
      } catch (error) {
        if (!cancelled) {
          setParentLinkSearchResults([])
          setParentLinkError(error instanceof Error ? error.message : "Failed to search parent members")
        }
      } finally {
        if (!cancelled) {
          setParentLinkSearching(false)
        }
      }
    }, 300)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [member?.parentLinks?.length, memberId, parentLinkOpen, parentLinkSearch, selectedLinkParent?.id])

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
    setSelectedInheritEmailSource(
      member.inheritEmailFrom
        ? {
            id: member.inheritEmailFrom.id,
            firstName: member.inheritEmailFrom.firstName,
            lastName: member.inheritEmailFrom.lastName,
            email: member.inheritEmailFrom.email,
          }
        : null
    )
    setInheritEmailSearch("")
    setInheritEmailSearchResults([])
    setInheritEmailSearchError("")
    setXeroChoice("")
    setSelectedXeroContactId("")
    setXeroSearchQuery("")
    setXeroSearchResults([])
    setXeroCreateEntranceFeeInvoice(false)
    setXeroError("")
    setEditPostalSameAsPhysical(
      memberUsesSamePostalAddress({
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
      })
    )
    setFormError("")
    setEditOpen(true)
  }, [member, setXeroCreateEntranceFeeInvoice])

  useEffect(() => {
    if (hasHandledInitialEditParam || !shouldAutoOpenEdit || loading || !member) {
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
    setDependentPostalSameAsPhysical(
      memberUsesSamePostalAddress({
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
      })
    )
    setDependentFormError("")
    setDependentMode("create")
    setLinkDependentSearch("")
    setLinkDependentSearchResults([])
    setLinkDependentSearching(false)
    setSelectedLinkDependent(null)
    setLinkDependentInheritEmail(false)
    setLinkDependentNotificationParentId("")
    setLinkDependentDisableLogin(false)
    setLinkDependentFamilyGroupIds(member.familyGroups.map((group) => group.id))
    setDependentOpen(true)
  }

  const handleSave = async () => {
    setSaving(true)
    setFormError("")
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
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Save failed")
      }
      setEditOpen(false)
      setSuccess("Member updated successfully")
      setTimeout(() => setSuccess(""), 3000)
      setLoading(true)
      await fetchMember()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Save failed")
    } finally {
      setSaving(false)
    }
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
          active: true,
          canLogin: false,
          parentMemberId: member.id,
          inheritParentEmail: true,
          inheritEmailFromId: inheritedEmailSourceId,
          familyGroupIds: member.familyGroups.map((group) => group.id),
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

  const selectLinkDependent = (candidate: LinkDependentSearchResult) => {
    const defaultSideEffects = shouldDefaultLinkSideEffects(candidate.ageTier)
    setSelectedLinkDependent(candidate)
    setLinkDependentInheritEmail(defaultSideEffects)
    setLinkDependentNotificationParentId(defaultSideEffects ? member?.id ?? "" : "")
    setLinkDependentDisableLogin(defaultSideEffects)
    setLinkDependentFamilyGroupIds(member?.familyGroups.map((group) => group.id) ?? [])
    setLinkDependentSearch("")
    setLinkDependentSearchResults([])
    setDependentFormError("")
  }

  const clearLinkDependent = () => {
    setSelectedLinkDependent(null)
    setLinkDependentInheritEmail(false)
    setLinkDependentNotificationParentId("")
    setLinkDependentDisableLogin(false)
    setLinkDependentFamilyGroupIds(member?.familyGroups.map((group) => group.id) ?? [])
    setLinkDependentSearch("")
    setLinkDependentSearchResults([])
    setDependentFormError("")
  }

  const toggleLinkFamilyGroup = (familyGroupId: string, checked: boolean) => {
    setLinkDependentFamilyGroupIds((current) =>
      checked
        ? Array.from(new Set([...current, familyGroupId]))
        : current.filter((idValue) => idValue !== familyGroupId)
    )
  }

  const handleLinkDependent = async () => {
    if (!member || !selectedLinkDependent) return

    setDependentSaving(true)
    setDependentFormError("")

    try {
      const res = await fetch(`/api/admin/members/${member.id}/dependents/link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          memberId: selectedLinkDependent.id,
          inheritEmail: Boolean(linkDependentNotificationParentId) || linkDependentInheritEmail,
          inheritEmailFromId: linkDependentNotificationParentId || null,
          disableLogin: linkDependentDisableLogin,
          addToFamilyGroupIds: linkDependentFamilyGroupIds,
        }),
      })
      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        throw new Error(data.error || "Failed to link dependent")
      }

      setDependentOpen(false)
      setSuccess("Dependent linked successfully")
      setTimeout(() => setSuccess(""), 3000)
      setLoading(true)
      await fetchMember()
    } catch (err) {
      setDependentFormError(err instanceof Error ? err.message : "Failed to link dependent")
    } finally {
      setDependentSaving(false)
    }
  }

  const openParentLinkDialog = () => {
    if (!member) return
    const defaultSideEffects = shouldDefaultLinkSideEffects(member.ageTier)
    setParentLinkSearch("")
    setParentLinkSearchResults([])
    setParentLinkSearching(false)
    setSelectedLinkParent(null)
    setParentLinkInheritEmail(defaultSideEffects)
    setParentLinkNotificationParentId("")
    setParentLinkDisableLogin(defaultSideEffects)
    setParentLinkFamilyGroupIds([])
    setParentLinkError("")
    setParentLinkOpen(true)
  }

  const selectLinkParent = (candidate: LinkParentSearchResult) => {
    if (!member) return
    const defaultSideEffects = shouldDefaultLinkSideEffects(member.ageTier)
    setSelectedLinkParent(candidate)
    setParentLinkInheritEmail(defaultSideEffects)
    setParentLinkNotificationParentId(defaultSideEffects ? candidate.id : "")
    setParentLinkDisableLogin(defaultSideEffects)
    setParentLinkFamilyGroupIds(candidate.familyGroups.map((group) => group.id))
    setParentLinkSearch("")
    setParentLinkSearchResults([])
    setParentLinkError("")
  }

  const clearLinkParent = () => {
    if (!member) return
    const defaultSideEffects = shouldDefaultLinkSideEffects(member.ageTier)
    setSelectedLinkParent(null)
    setParentLinkInheritEmail(defaultSideEffects)
    setParentLinkNotificationParentId("")
    setParentLinkDisableLogin(defaultSideEffects)
    setParentLinkFamilyGroupIds([])
    setParentLinkSearch("")
    setParentLinkSearchResults([])
    setParentLinkError("")
  }

  const toggleParentLinkFamilyGroup = (familyGroupId: string, checked: boolean) => {
    setParentLinkFamilyGroupIds((current) =>
      checked
        ? Array.from(new Set([...current, familyGroupId]))
        : current.filter((idValue) => idValue !== familyGroupId)
    )
  }

  const handleLinkParent = async () => {
    if (!member || !selectedLinkParent) return

    setParentLinkSaving(true)
    setParentLinkError("")
    setRelationshipError("")

    try {
      const res = await fetch(`/api/admin/members/${selectedLinkParent.id}/dependents/link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          memberId: member.id,
          inheritEmail: Boolean(parentLinkNotificationParentId) || parentLinkInheritEmail,
          inheritEmailFromId: parentLinkNotificationParentId || null,
          disableLogin: parentLinkDisableLogin,
          addToFamilyGroupIds: parentLinkFamilyGroupIds,
        }),
      })
      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        throw new Error(data.error || "Failed to link parent")
      }

      setParentLinkOpen(false)
      setSuccess("Parent linked successfully")
      setTimeout(() => setSuccess(""), 3000)
      setLoading(true)
      await fetchMember()
    } catch (err) {
      setParentLinkError(err instanceof Error ? err.message : "Failed to link parent")
    } finally {
      setParentLinkSaving(false)
    }
  }

  const handleUnlinkDependent = async (
    parentId: string,
    dependentId: string,
    dependentName: string
  ) => {
    if (!confirm(`Remove the parent/dependant link for ${dependentName}?`)) return

    setUnlinkingDependentId(dependentId)
    setRelationshipError("")

    try {
      const res = await fetch(`/api/admin/members/${parentId}/dependents/${dependentId}`, {
        method: "DELETE",
      })
      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        throw new Error(data.error || "Failed to remove parent/dependant link")
      }

      setSuccess("Parent/dependant link removed")
      setTimeout(() => setSuccess(""), 3000)
      setLoading(true)
      await fetchMember()
    } catch (err) {
      setRelationshipError(err instanceof Error ? err.message : "Failed to remove parent/dependant link")
    } finally {
      setUnlinkingDependentId(null)
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
      const contacts = await searchXeroContacts(xeroSearchQuery)
      setXeroSearchResults(contacts)
    } catch (err) {
      setXeroSearchResults([])
      setXeroError(err instanceof Error ? err.message : "Search failed")
    } finally {
      setXeroSearching(false)
    }
  }

  const handleXeroLink = async (xeroContactId: string) => {
    setXeroLinking(true)
    setXeroError("")
    try {
      await linkMemberXeroContact(id, xeroContactId)
      setXeroChoice("")
      setSelectedXeroContactId("")
      setXeroSearchQuery("")
      setXeroSearchResults([])
      setXeroSearchOpen(false)
      setSuccess("Member linked to Xero contact")
      setTimeout(() => setSuccess(""), 3000)
      setLoading(true)
      await fetchMember()
    } catch (err) {
      setXeroError(err instanceof Error ? err.message : "Link failed")
    } finally {
      setXeroLinking(false)
    }
  }

  const handleXeroUnlink = async () => {
    setXeroUnlinking(true)
    setXeroError("")
    try {
      await unlinkMemberXeroContact(id)
      setXeroChoice("")
      setSelectedXeroContactId("")
      setXeroSearchQuery("")
      setXeroSearchResults([])
      resetXeroEntranceFeeDecision()
      setSuccess("Member unlinked from Xero")
      setTimeout(() => setSuccess(""), 3000)
      setLoading(true)
      await fetchMember()
    } catch (err) {
      setXeroError(err instanceof Error ? err.message : "Unlink failed")
    } finally {
      setXeroUnlinking(false)
    }
  }

  const applyXeroPushSuccess = async (data: XeroPushResponse, createEntranceFeeInvoice: boolean) => {
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
    setXeroPushing(true)
    setXeroError("")
    if (forceCreate) {
      setXeroDecisionError("")
    }
    try {
      const entranceFeeInvoiceOptions = buildXeroEntranceFeeInvoiceOptions()
      const result = await pushMemberToXero(id, {
        ...entranceFeeInvoiceOptions,
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

      await applyXeroPushSuccess(result.data, entranceFeeInvoiceOptions.createEntranceFeeInvoice)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Push failed"
      if (forceCreate) {
        setXeroDecisionError(message)
      } else {
        setXeroError(message)
      }
    } finally {
      setXeroPushing(false)
    }
  }

  const handleXeroDecisionLink = async () => {
    if (!xeroDecisionContactId) return

    setXeroLinking(true)
    setXeroDecisionError("")
    try {
      await linkMemberXeroContact(id, xeroDecisionContactId)
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

  const handleCreateDeleteRequest = async () => {
    if (!member) return
    setDeleteSubmitting(true)
    setDeleteError("")
    try {
      const res = await fetch(`/api/admin/members/${member.id}/lifecycle/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: deleteReason }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || "Failed to create delete request")
      }

      setDeleteDialogOpen(false)
      setDeleteReason("")
      setSuccess("Delete request submitted for second-admin review")
      setTimeout(() => setSuccess(""), 3000)
      setLoading(true)
      await fetchMember()
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to create delete request")
    } finally {
      setDeleteSubmitting(false)
    }
  }

  const handleReviewDeleteRequest = async () => {
    if (!deleteReviewDialog) return
    setDeleteReviewSubmitting(true)
    setDeleteReviewError("")
    try {
      const res = await fetch(`/api/admin/member-lifecycle-action-requests/${deleteReviewDialog.request.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: deleteReviewDialog.action,
          note: deleteReviewNote || undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || "Failed to review delete request")
      }

      setDeleteReviewDialog(null)
      setDeleteReviewNote("")
      setSuccess(
        deleteReviewDialog.action === "approve" ? "Member deleted and snapshot retained" : "Delete request rejected"
      )
      setTimeout(() => setSuccess(""), 3000)
      if (deleteReviewDialog.action === "approve") {
        router.push(backHref)
        return
      }
      setLoading(true)
      await fetchMember()
    } catch (err) {
      setDeleteReviewError(err instanceof Error ? err.message : "Failed to review delete request")
    } finally {
      setDeleteReviewSubmitting(false)
    }
  }

  const isSelf = session?.user?.id === id

  if (loading) {
    return (
      <div className="py-12 text-center">
        <p className="text-sm text-slate-500">Loading member details...</p>
      </div>
    )
  }
  if (pageError || !member) {
    return (
      <div className="space-y-4">
        <Button variant="outline" onClick={() => router.push(backHref)}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          {backLabel}
        </Button>
        <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-md text-sm">
          {pageError || "Member not found"}
        </div>
      </div>
    )
  }

  const lifecycleRequests = member.lifecycleActionRequests ?? []
  const deleteRequests = lifecycleRequests.filter((request) => request.action === "DELETE")
  const pendingDeleteRequest = deleteRequests.find((request) => request.status === "REQUESTED")
  const deleteBlockers = member.deleteEligibility.blockers
  const approvalBlockers = deleteBlockers.filter((blocker) => blocker.code !== "pending_delete_request")
  const canReviewPendingDeleteRequest =
    Boolean(pendingDeleteRequest) && pendingDeleteRequest?.requestedBy?.id !== session?.user?.id
  const archiveRequests = lifecycleRequests.filter((request) => request.action === "ARCHIVE")
  const pendingArchiveRequest = archiveRequests.find((request) => request.status === "REQUESTED") ?? null
  const reviewedArchiveRequests = archiveRequests.filter((request) => request.status !== "REQUESTED").slice(0, 3)
  const isArchiveRequester = pendingArchiveRequest?.requestedBy?.id === session?.user?.id
  const canRequestArchive = Boolean(
    member.cancelledAt && !member.archivedAt && !pendingArchiveRequest
  )
  const openCancellationRequest = member.openCancellationRequest
  const canRequestCancellation = Boolean(
    member.role === "MEMBER" &&
      member.active &&
      !member.cancelledAt &&
      !member.archivedAt &&
      !openCancellationRequest
  )

  const openLinkXero = () => {
    setXeroSearchOpen(true)
    setXeroSearchQuery("")
    setXeroSearchResults([])
    setXeroError("")
  }

  const openCreateXero = () => {
    resetXeroEntranceFeeDecision()
    setXeroCreateOpen(true)
    setXeroError("")
  }

  // Suppress unused-variable warnings for state that is still wired into other
  // computations via the closure (inherit flags participate in the inheritEmail
  // request body construction even though they're read inline above).
  void linkDependentInheritEmail
  void parentLinkInheritEmail

  return (
    <div className="space-y-6">
      <MemberDetailHeader
        member={member}
        backHref={backHref}
        backLabel={backLabel}
        isAdultMember={isAdultMember}
        memberIsArchived={memberIsArchived}
        pendingDeleteRequest={pendingDeleteRequest}
        xeroPushing={xeroPushing}
        xeroUnlinking={xeroUnlinking}
        onOpenDependentDialog={openDependentDialog}
        onOpenLinkXero={openLinkXero}
        onOpenCreateXero={openCreateXero}
        onUnlinkXero={handleXeroUnlink}
        onOpenEditDialog={openEditDialog}
      />

      {success && (
        <div className="p-3 bg-green-50 border border-green-200 text-green-700 rounded-md text-sm">{success}</div>
      )}
      {relationshipError && (
        <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-md text-sm">{relationshipError}</div>
      )}
      {xeroError && !xeroSearchOpen && !editOpen && !xeroCreateOpen && !xeroCreateDecisionOpen && (
        <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-md text-sm">{xeroError}</div>
      )}

      <MemberDeletionCard
        deleteEligibility={member.deleteEligibility}
        deleteRequests={deleteRequests}
        pendingDeleteRequest={pendingDeleteRequest}
        approvalBlockerCount={approvalBlockers.length}
        canReviewPendingDeleteRequest={canReviewPendingDeleteRequest}
        onOpenRequestDialog={() => {
          setDeleteDialogOpen(true)
          setDeleteReason("")
          setDeleteError("")
        }}
        onOpenReviewDialog={(request, action) => {
          setDeleteReviewDialog({ request, action })
          setDeleteReviewNote("")
          setDeleteReviewError("")
        }}
      />

      <MemberStatsCards member={member} />

      <MemberInfoCard member={member} onEditFamilyGroup={setFamilyGroupEditorId} />

      <MemberParentLinksCard
        member={member}
        memberIsArchived={memberIsArchived}
        currentMemberPath={currentMemberPath}
        unlinkingDependentId={unlinkingDependentId}
        onOpenParentLinkDialog={openParentLinkDialog}
        onUnlinkParent={handleUnlinkDependent}
      />

      <MemberPromoCodesCard promoCodes={member.promoCodes} />

      <MemberDependentsCard
        member={member}
        isAdultMember={isAdultMember}
        memberIsArchived={memberIsArchived}
        currentMemberPath={currentMemberPath}
        unlinkingDependentId={unlinkingDependentId}
        onOpenDependentDialog={openDependentDialog}
        onUnlinkDependent={handleUnlinkDependent}
      />

      <MemberHistoryAccordion
        memberId={id}
        subscriptions={member.subscriptions}
        bookings={member.bookings}
        openSections={openSections}
        onValueChange={onSectionsChange}
        creditCard={
          <MemberCreditCard
            creditBalance={creditBalance}
            creditHistory={creditHistory}
            creditLoading={creditLoading}
            creditError={creditError}
            pendingAdjustmentRequests={pendingAdjustmentRequests}
            reviewingAdjustmentId={reviewingAdjustmentId}
            showAdjustmentForm={showAdjustmentForm}
            adjustmentError={adjustmentError}
            adjustmentAmount={adjustmentAmount}
            adjustmentDescription={adjustmentDescription}
            adjustmentSaving={adjustmentSaving}
            onToggleAdjustmentForm={toggleAdjustmentForm}
            onChangeAdjustmentAmount={setAdjustmentAmount}
            onChangeAdjustmentDescription={setAdjustmentDescription}
            onSubmitAdjustment={handleAdjustmentSubmit}
            onReviewAdjustment={handleReviewAdjustmentRequest}
          />
        }
      />

      <MemberLifecycleCard
        member={member}
        pendingArchiveRequest={pendingArchiveRequest}
        reviewedArchiveRequests={reviewedArchiveRequests}
        isArchiveRequester={isArchiveRequester}
        canRequestArchive={canRequestArchive}
        canRequestCancellation={canRequestCancellation}
        openCancellationRequest={openCancellationRequest}
        archiveError={archiveError}
        archiveReason={archiveReason}
        archiveReviewNotes={archiveReviewNotes}
        archiveActionLoading={archiveActionLoading}
        cancellationError={cancellationError}
        cancellationReason={cancellationReason}
        cancellationSubmitting={cancellationSubmitting}
        onChangeArchiveReason={setArchiveReason}
        onChangeArchiveReviewNote={(requestId, value) =>
          setArchiveReviewNotes((current) => ({ ...current, [requestId]: value }))
        }
        onChangeCancellationReason={setCancellationReason}
        onSubmitArchive={handleSubmitArchiveRequest}
        onSubmitCancellation={handleSubmitCancellationRequest}
        onReviewArchive={handleReviewArchiveRequest}
      />

      <FamilyGroupEditorDialog
        groupId={familyGroupEditorId}
        open={Boolean(familyGroupEditorId)}
        onOpenChange={(open) => {
          if (!open) setFamilyGroupEditorId(null)
        }}
        onChanged={() => {
          setSuccess("Family group updated successfully")
          setTimeout(() => setSuccess(""), 3000)
          setLoading(true)
          void fetchMember()
        }}
      />

      <MemberXeroLinkDialog
        open={xeroSearchOpen}
        onOpenChange={setXeroSearchOpen}
        member={member}
        query={xeroSearchQuery}
        results={xeroSearchResults}
        searching={xeroSearching}
        linking={xeroLinking}
        error={xeroError}
        onChangeQuery={setXeroSearchQuery}
        onClearError={() => setXeroError("")}
        onSearch={handleXeroSearch}
        onLink={handleXeroLink}
      />

      <MemberXeroCreateDialog
        open={xeroCreateOpen}
        onOpenChange={setXeroCreateOpen}
        member={member}
        pushing={xeroPushing}
        error={xeroError}
        createEntranceFeeInvoice={xeroCreateEntranceFeeInvoice}
        entranceFeeSkipReason={xeroEntranceFeeSkipReason}
        entranceFeeAmount={xeroEntranceFeeAmount}
        entranceFeeNarration={xeroEntranceFeeNarration}
        onChangeCreateEntranceFeeInvoice={setXeroCreateEntranceFeeInvoice}
        onChangeEntranceFeeSkipReason={setXeroEntranceFeeSkipReason}
        onChangeEntranceFeeAmount={setXeroEntranceFeeAmount}
        onChangeEntranceFeeNarration={setXeroEntranceFeeNarration}
        onSubmit={() => handleXeroPush(false)}
      />

      <MemberXeroDecisionDialog
        open={xeroCreateDecisionOpen}
        onOpenChange={(open) => {
          setXeroCreateDecisionOpen(open)
          if (!open) {
            setXeroCreateDecisionResults([])
            setXeroDecisionContactId("")
            setXeroDecisionError("")
          }
        }}
        member={member}
        results={xeroCreateDecisionResults}
        selectedContactId={xeroDecisionContactId}
        createEntranceFeeInvoice={xeroCreateEntranceFeeInvoice}
        linking={xeroLinking}
        pushing={xeroPushing}
        error={xeroDecisionError}
        onSelectContact={setXeroDecisionContactId}
        onConfirmLink={handleXeroDecisionLink}
        onCreateAnyway={() => handleXeroPush(true)}
      />

      <MemberParentLinkDialog
        open={parentLinkOpen}
        onOpenChange={setParentLinkOpen}
        member={member}
        search={parentLinkSearch}
        searching={parentLinkSearching}
        searchResults={parentLinkSearchResults}
        selected={selectedLinkParent}
        notificationParentId={parentLinkNotificationParentId}
        disableLogin={parentLinkDisableLogin}
        familyGroupIds={parentLinkFamilyGroupIds}
        saving={parentLinkSaving}
        error={parentLinkError}
        onChangeSearch={(value) => {
          setParentLinkSearch(value)
          setSelectedLinkParent(null)
          setParentLinkError("")
        }}
        onSelectCandidate={selectLinkParent}
        onClearSelection={clearLinkParent}
        onChangeNotificationParentId={(value) => {
          setParentLinkNotificationParentId(value)
          setParentLinkInheritEmail(Boolean(value))
        }}
        onChangeDisableLogin={setParentLinkDisableLogin}
        onToggleFamilyGroup={toggleParentLinkFamilyGroup}
        onSubmit={handleLinkParent}
      />

      <MemberDependentDialog
        open={dependentOpen}
        onOpenChange={setDependentOpen}
        member={member}
        mode={dependentMode}
        onChangeMode={(value) => {
          setDependentMode(value)
          setDependentFormError("")
        }}
        error={dependentFormError}
        saving={dependentSaving}
        createForm={dependentForm}
        createPostalSameAsPhysical={dependentPostalSameAsPhysical}
        onChangeCreateForm={setDependentForm}
        onChangeCreatePostalSameAsPhysical={setDependentPostalSameAsPhysical}
        onChangeCreateAddressFields={updateDependentAddressFields}
        onSubmitCreate={handleCreateDependent}
        linkSearch={linkDependentSearch}
        linkSearching={linkDependentSearching}
        linkSearchResults={linkDependentSearchResults}
        linkSelected={selectedLinkDependent}
        linkNotificationParentId={linkDependentNotificationParentId}
        linkDisableLogin={linkDependentDisableLogin}
        linkFamilyGroupIds={linkDependentFamilyGroupIds}
        onChangeLinkSearch={(value) => {
          setLinkDependentSearch(value)
          setSelectedLinkDependent(null)
          setDependentFormError("")
        }}
        onSelectLinkCandidate={selectLinkDependent}
        onClearLinkSelection={clearLinkDependent}
        onChangeLinkNotificationParentId={(value) => {
          setLinkDependentNotificationParentId(value)
          setLinkDependentInheritEmail(Boolean(value))
        }}
        onChangeLinkDisableLogin={setLinkDependentDisableLogin}
        onToggleLinkFamilyGroup={toggleLinkFamilyGroup}
        onSubmitLink={handleLinkDependent}
      />

      <MemberDeleteRequestDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        reason={deleteReason}
        error={deleteError}
        submitting={deleteSubmitting}
        onChangeReason={setDeleteReason}
        onSubmit={handleCreateDeleteRequest}
      />

      <MemberDeleteReviewDialog
        dialog={deleteReviewDialog}
        approvalBlockers={approvalBlockers}
        reviewNote={deleteReviewNote}
        error={deleteReviewError}
        submitting={deleteReviewSubmitting}
        onClose={() => {
          setDeleteReviewDialog(null)
          setDeleteReviewNote("")
          setDeleteReviewError("")
        }}
        onChangeReviewNote={setDeleteReviewNote}
        onSubmit={handleReviewDeleteRequest}
      />

      <MemberEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        member={member}
        form={form}
        formError={formError}
        saving={saving}
        isSelf={isSelf}
        memberLifecycleLocked={memberLifecycleLocked}
        postalSameAsPhysical={editPostalSameAsPhysical}
        selectedInheritEmailSource={selectedInheritEmailSource}
        inheritEmailSearch={inheritEmailSearch}
        inheritEmailSearching={inheritEmailSearching}
        inheritEmailSearchError={inheritEmailSearchError}
        inheritEmailSearchResults={inheritEmailSearchResults}
        xeroError={xeroError}
        xeroChoice={xeroChoice}
        xeroSearchQuery={xeroSearchQuery}
        xeroSearchResults={xeroSearchResults}
        xeroSearching={xeroSearching}
        xeroLinking={xeroLinking}
        xeroUnlinking={xeroUnlinking}
        xeroPushing={xeroPushing}
        selectedXeroContactId={selectedXeroContactId}
        onChangeForm={setForm}
        onChangeAddressFields={updateEditAddressFields}
        onChangePostalSameAsPhysical={setEditPostalSameAsPhysical}
        onChangeInheritEmailSearch={setInheritEmailSearch}
        onSelectInheritEmailSource={selectInheritEmailSource}
        onClearInheritEmailSource={clearInheritEmailSource}
        onChangeXeroSearchQuery={setXeroSearchQuery}
        onChangeSelectedXeroContactId={setSelectedXeroContactId}
        onChangeXeroChoice={setXeroChoice}
        onClearXeroError={() => setXeroError("")}
        onOpenLinkXero={openLinkXero}
        onOpenCreateXero={openCreateXero}
        onXeroSearch={handleXeroSearch}
        onXeroLink={handleXeroLink}
        onXeroUnlink={handleXeroUnlink}
        onSubmit={handleSave}
      />
    </div>
  )
}
