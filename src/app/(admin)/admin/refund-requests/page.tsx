"use client"

import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import { useSession } from "next-auth/react"
import { useRouter, useSearchParams } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { DatasetResetButton } from "@/components/admin/dataset-reset-button"
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  ADMIN_VIEW_ONLY_ACTION_REASON,
  useAdminAreaEditAccess,
} from "@/hooks/use-admin-area-edit-access"
import { BookingNoEmailsNotice } from "@/components/booking-no-emails-notice"
import { getCancellationSettlementBreakdown } from "@/lib/payment-status-display"
import { buildHrefWithReturnTo } from "@/lib/internal-return-path"
import { useClubTime } from "@/components/club-time-provider"
import { parseInstant, type BoundClubTime } from "@/lib/club-time"
import { formatPayloadCalendarDay } from "../_lib/calendar-day"
import { parseDecimalDollarsToCents } from "@/lib/money-input"

type ReviewFilter = "PENDING" | "APPROVED" | "REJECTED" | "ALL"
const reviewFilters = new Set<ReviewFilter>(["PENDING", "APPROVED", "REJECTED", "ALL"])

function isReviewFilter(value: string | null): value is ReviewFilter {
  return reviewFilters.has(value as ReviewFilter)
}

interface RefundRequestData {
  id: string
  bookingId: string
  memberId: string
  reason: string
  requestedAmountCents: number | null
  status: "PENDING" | "APPROVED" | "REJECTED"
  adminNotes: string | null
  approvedAmountCents: number | null
  reviewedAt: string | null
  createdAt: string
  booking: {
    id: string
    checkIn: string
    checkOut: string
    finalPriceCents: number
    status: string
    // #2259: the per-booking "No emails" switch. A refund outcome email
    // (`refund-request-approved` / `refund-request-declined`) is booking-scoped,
    // so the mailer withholds it while the switch is on — the notify prompt
    // stops offering the choice.
    noEmails: boolean
    creditsFromCancellation: Array<{
      amountCents: number
      description: string | null
    }>
    payment: {
      amountCents: number
      refundedAmountCents: number
      stripePaymentIntentId: string | null
    } | null
  }
  member: {
    id: string
    firstName: string
    lastName: string
    email: string
  }
}

interface AdminActor {
  id: string
  firstName: string
  lastName: string
}

interface CreditApprovalRequestData {
  id: string
  memberId: string
  amountCents: number
  description: string
  status: "PENDING" | "APPROVED" | "REJECTED"
  createdAt: string
  reviewedAt: string | null
  member: {
    id: string
    firstName: string
    lastName: string
    email: string
  }
  requestedBy: AdminActor
  reviewedBy: AdminActor | null
  approvedCredit: {
    id: string
    createdAt: string
  } | null
}

function formatCents(cents: number): string {
  return "$" + (cents / 100).toFixed(2)
}

function formatAdminName(admin: AdminActor | null | undefined) {
  return admin ? `${admin.firstName} ${admin.lastName}` : "Unknown admin"
}

// Submission, review and credit stamps are real INSTANTS, projected through
// the club's persisted zone (CT-4, #2870; INV-CONFIG-002).
function formatDateTime(clubTime: BoundClubTime, value: string | null) {
  const instant = value === null ? null : parseInstant(value)
  if (instant === null) {
    return null
  }

  return clubTime.instantDateTime(instant)
}

// A booking's check-in/check-out is a CALENDAR DATE — a `@db.Date` column the
// API serialises as UTC midnight. It takes no zone; reading it through one
// named the night before for any club behind UTC (INV-DATE-019).
function formatStayDay(value: string) {
  return formatPayloadCalendarDay(value)
}

export default function RefundRequestsPage() {
  const clubTime = useClubTime()
  const router = useRouter()
  const searchParams = useSearchParams()
  const initialFilter = searchParams.get("status")
  const { data: session } = useSession()
  const canEditFinance = useAdminAreaEditAccess("finance")
  const [refundRequests, setRefundRequests] = useState<RefundRequestData[]>([])
  const [creditApprovals, setCreditApprovals] = useState<CreditApprovalRequestData[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<ReviewFilter>(
    isReviewFilter(initialFilter) ? initialFilter : "PENDING"
  )
  const [reviewingRefundId, setReviewingRefundId] = useState<string | null>(null)
  const [reviewingCreditId, setReviewingCreditId] = useState<string | null>(null)
  const [adminNotes, setAdminNotes] = useState("")
  const [approvedAmount, setApprovedAmount] = useState("")
  const [processingRefund, setProcessingRefund] = useState(false)
  const [error, setError] = useState("")
  // #1792: the pending approve/reject action waiting on the admin's notify-or-not
  // choice, plus whether the choice dialog is open. A refund appellant always has
  // an email on file, so the dialog is shown for every approve and reject — the
  // #1769a honesty rule ("only ask when an email would send") is satisfied here
  // by the fact that an email always would.
  const [notifyChoice, setNotifyChoice] = useState<
    { id: string; status: "APPROVED" | "REJECTED"; noEmails: boolean } | null
  >(null)
  const [notifyDialogOpen, setNotifyDialogOpen] = useState(false)
  const currentParams = new URLSearchParams(searchParams.toString())
  currentParams.delete("status")
  if (filter !== "PENDING") currentParams.set("status", filter)
  const currentQuery = currentParams.toString()
  const currentRefundRequestsPath = currentQuery
    ? `/admin/refund-requests?${currentQuery}`
    : "/admin/refund-requests"

  useEffect(() => {
    router.replace(currentRefundRequestsPath, { scroll: false })
  }, [currentRefundRequestsPath, router])

  const fetchRequests = useCallback(async () => {
    setLoading(true)
    setError("")

    try {
      const [refundRes, creditRes] = await Promise.all([
        fetch(`/api/admin/refund-requests?status=${filter}`),
        fetch(`/api/admin/credit-approvals?status=${filter}`),
      ])

      if (!refundRes.ok || !creditRes.ok) {
        throw new Error("Failed to fetch")
      }

      const [refundData, creditData] = await Promise.all([
        refundRes.json(),
        creditRes.json(),
      ])

      setRefundRequests(
        Array.isArray(refundData)
          ? refundData
          : Array.isArray(refundData?.data)
            ? refundData.data
            : []
      )
      setCreditApprovals(Array.isArray(creditData) ? creditData : [])
    } catch {
      setError("Failed to load review queue")
    } finally {
      setLoading(false)
    }
    // setState functions are referentially stable; they are listed so the
    // manual dependencies match what the React Compiler infers.
  }, [filter, setCreditApprovals, setError, setLoading, setRefundRequests])

  useEffect(() => {
    fetchRequests()
  }, [fetchRequests])

  // #1792: open the notify-choice dialog for an approve/reject action. Approve
  // validates the amount up front so the admin never gets the dialog then an
  // error; reject has nothing to pre-validate.
  function startRefundNotifyChoice(id: string, status: "APPROVED" | "REJECTED") {
    setError("")
    if (status === "APPROVED") {
      // #2685: the exact parser, so "50x" is refused instead of approving $50.
      const cents = parseDecimalDollarsToCents(approvedAmount)
      if (cents === null || cents <= 0) {
        setError("Please enter a valid refund amount")
        return
      }
    }
    // #2259: carry the appeal's booking-level "No emails" state into the choice
    // so the dialog can drop an email option the mailer will not honour. Read
    // off the already-loaded queue row — no extra fetch per action.
    setNotifyChoice({
      id,
      status,
      noEmails:
        refundRequests.find((request) => request.id === id)?.booking
          .noEmails === true,
    })
    setNotifyDialogOpen(true)
  }

  // #1792: dispatch the pending notify choice. Close the dialog without clearing
  // the choice so the copy keeps its wording while the dialog fades out.
  function confirmNotify(notifyMember: boolean) {
    const choice = notifyChoice
    setNotifyDialogOpen(false)
    if (!choice) return
    void handleRefundReview(choice.id, choice.status, notifyMember)
  }

  /**
   * #2259 H1: dispatch the silenced path with NO notify choice at all.
   *
   * `notifyMember: false` makes the route skip the send outright, so the
   * mailer's gate never runs and no `SKIPPED_NO_EMAILS` row is recorded — the
   * booking's withheld-list banner would then omit the refund outcome the
   * member was never told about. Omitting the flag lets the send be ATTEMPTED
   * and withheld, which records the row and leaves the audit trail honestly
   * showing that no officer choice was made, because none was offered.
   */
  function confirmSilenced() {
    const choice = notifyChoice
    setNotifyDialogOpen(false)
    if (!choice) return
    void handleRefundReview(choice.id, choice.status, undefined, true)
  }

  async function handleRefundReview(
    id: string,
    status: "APPROVED" | "REJECTED",
    notifyMember: boolean | undefined,
    noEmails = false
  ) {
    setProcessingRefund(true)
    setError("")

    try {
      const body: Record<string, unknown> = {
        status,
        adminNotes: adminNotes || undefined,
        // #1792: absent = notify (default), false = suppress the outcome email.
        // #2259: the silenced path deliberately sends ABSENT, so the mailer's
        // gate withholds AND records rather than the route skipping the send.
        ...(notifyMember !== undefined ? { notifyMember } : {}),
      }

      if (status === "APPROVED") {
        const cents = parseDecimalDollarsToCents(approvedAmount)
        if (cents === null || cents <= 0) {
          setError("Please enter a valid refund amount")
          setProcessingRefund(false)
          return
        }
        body.approvedAmountCents = cents
      }

      const res = await fetch(`/api/admin/refund-requests/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to process")
      }

      setReviewingRefundId(null)
      setAdminNotes("")
      setApprovedAmount("")
      toast.success(
        (status === "APPROVED"
          ? "Refund approved and processed"
          : "Appeal rejected") +
          (noEmails
            ? " Emails are off for this booking, so nothing was sent — the withheld message is listed on the booking."
            : notifyMember === false
              ? " The member was not emailed."
              : "")
      )
      await fetchRequests()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setProcessingRefund(false)
    }
  }

  async function handleCreditReview(
    request: CreditApprovalRequestData,
    decision: "APPROVE" | "REJECT"
  ) {
    setReviewingCreditId(request.id)
    setError("")

    try {
      const res = await fetch(
        `/api/admin/members/${request.member.id}/credits/${request.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision }),
        }
      )

      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || "Failed to review credit adjustment")
      }

      toast.success(
        data.message ||
          (decision === "APPROVE"
            ? "Credit adjustment approved and applied"
            : "Credit adjustment rejected")
      )
      await fetchRequests()
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to review credit adjustment"
      )
    } finally {
      setReviewingCreditId(null)
    }
  }

  function startRefundReview(req: RefundRequestData) {
    setReviewingRefundId(req.id)
    setAdminNotes("")

    const payment = req.booking.payment
    if (payment) {
      const maxRefundable = (payment.amountCents - payment.refundedAmountCents) / 100
      setApprovedAmount(
        req.requestedAmountCents
          ? Math.min(req.requestedAmountCents / 100, maxRefundable).toFixed(2)
          : maxRefundable.toFixed(2)
      )
    }
  }

  const totalItems = refundRequests.length + creditApprovals.length

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the `space-y-*` stack so
    the empty wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEditFinance} className="mb-6">
      Your admin role can view refund appeals and credit approvals but cannot
      approve, reject, or process them.
    </AdminViewOnlySectionBanner>
  )

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Refund Appeals & Credits</h1>
        <p className="text-muted-foreground mt-1">
          Review refund appeals and manual credit approvals from one queue
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="bg-destructive/10 text-destructive px-4 py-3 rounded-md"
        >
          {error}
          <button onClick={() => setError("")} className="ml-2 underline">Dismiss</button>
        </div>
      )}


      <div className="flex gap-2">
        {(["PENDING", "APPROVED", "REJECTED", "ALL"] as const).map((status) => (
          <Button
            key={status}
            variant={filter === status ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter(status)}
          >
            {status === "ALL" ? "All" : status.charAt(0) + status.slice(1).toLowerCase()}
          </Button>
        ))}
        <DatasetResetButton
          disabled={filter === "PENDING"}
          onReset={() => setFilter("PENDING")}
        />
      </div>

      {loading ? (
        <div className="text-center py-8">Loading...</div>
      ) : totalItems === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          No {filter === "ALL" ? "" : filter.toLowerCase() + " "}refund appeals or credit approvals found.
        </div>
      ) : (
        <div className="space-y-8">
          {refundRequests.length > 0 && (
            <section className="space-y-4">
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-semibold">Refund Appeals</h2>
                <Badge variant="secondary">{refundRequests.length}</Badge>
              </div>

              <div className="space-y-4">
                {refundRequests.map((req) => {
                  const payment = req.booking.payment
                  const settlement = payment
                    ? getCancellationSettlementBreakdown(
                        payment.refundedAmountCents,
                        req.booking.creditsFromCancellation
                      )
                    : null
                  const maxRefundable = payment
                    ? payment.amountCents - payment.refundedAmountCents
                    : 0
                  const isReviewing = reviewingRefundId === req.id

                  return (
                    <Card key={req.id}>
                      <CardHeader>
                        <div className="flex items-center justify-between">
                          <CardTitle className="text-lg">
                            {req.member.firstName} {req.member.lastName}
                          </CardTitle>
                          <Badge
                            variant={
                              req.status === "PENDING"
                                ? "outline"
                                : req.status === "APPROVED"
                                  ? "default"
                                  : "destructive"
                            }
                          >
                            {req.status}
                          </Badge>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                          <div>
                            <span className="text-muted-foreground">Check-in:</span>{" "}
                            {formatStayDay(req.booking.checkIn)}
                          </div>
                          <div>
                            <span className="text-muted-foreground">Check-out:</span>{" "}
                            {formatStayDay(req.booking.checkOut)}
                          </div>
                          {payment && (
                            <>
                              <div>
                                <span className="text-muted-foreground">Paid:</span>{" "}
                                {formatCents(payment.amountCents)}
                              </div>
                              <div>
                                <span className="text-muted-foreground">Remaining:</span>{" "}
                                {formatCents(maxRefundable)}
                              </div>
                              <div>
                                <span className="text-muted-foreground">To card:</span>{" "}
                                {formatCents(settlement?.refundToOriginalMethodCents ?? 0)}
                              </div>
                              <div>
                                <span className="text-muted-foreground">As credit:</span>{" "}
                                {formatCents(settlement?.accountCreditCents ?? 0)}
                              </div>
                            </>
                          )}
                        </div>

                        {settlement && settlement.restoredAppliedCreditCents > 0 && (
                          <p className="text-sm text-muted-foreground">
                            Restored prior credit:{" "}
                            {formatCents(settlement.restoredAppliedCreditCents)}
                          </p>
                        )}

                        {req.requestedAmountCents && (
                          <p className="text-sm">
                            <span className="text-muted-foreground">Requested amount:</span>{" "}
                            <strong>{formatCents(req.requestedAmountCents)}</strong>
                          </p>
                        )}

                        <div className="bg-muted rounded-md p-3">
                          <p className="text-sm font-medium mb-1">Reason:</p>
                          <p className="text-sm whitespace-pre-wrap">{req.reason}</p>
                        </div>

                        <p className="text-xs text-muted-foreground">
                          Submitted {formatDateTime(clubTime, req.createdAt)}
                        </p>

                        {req.status !== "PENDING" && (
                          <div className="border-t pt-3 mt-3">
                            {req.approvedAmountCents != null && req.approvedAmountCents > 0 && (
                              <p className="text-sm">
                                <span className="text-muted-foreground">Refunded:</span>{" "}
                                <strong>{formatCents(req.approvedAmountCents)}</strong>
                              </p>
                            )}
                            {req.adminNotes && (
                              <p className="text-sm mt-1">
                                <span className="text-muted-foreground">Admin notes:</span>{" "}
                                {req.adminNotes}
                              </p>
                            )}
                            {req.reviewedAt && (
                              <p className="text-xs text-muted-foreground mt-1">
                                Reviewed {formatDateTime(clubTime, req.reviewedAt)}
                              </p>
                            )}
                          </div>
                        )}

                        {req.status === "PENDING" && !isReviewing && (
                          <div className="flex gap-2 pt-2">
                            <ViewOnlyActionButton
                              canEdit={canEditFinance}
                              describeReason={false}
                              size="sm"
                              onClick={() => startRefundReview(req)}
                            >
                              Review
                            </ViewOnlyActionButton>
                          </div>
                        )}

                        {isReviewing && (
                          <div className="border-t pt-4 mt-3 space-y-3">
                            <div className="space-y-2">
                              <Label htmlFor="approvedAmount">Refund Amount ($)</Label>
                              <Input
                                id="approvedAmount"
                                type="number"
                                step="0.01"
                                min="0"
                                max={(maxRefundable / 100).toFixed(2)}
                                value={approvedAmount}
                                onChange={(e) => setApprovedAmount(e.target.value)}
                                disabled={!canEditFinance}
                                title={
                                  !canEditFinance
                                    ? ADMIN_VIEW_ONLY_ACTION_REASON
                                    : undefined
                                }
                                className="w-40"
                              />
                              <p className="text-xs text-muted-foreground">
                                Max refundable: {formatCents(maxRefundable)}
                              </p>
                            </div>
                            <div className="space-y-2">
                              <Label htmlFor="adminNotes">Admin Notes (optional)</Label>
                              <textarea
                                id="adminNotes"
                                value={adminNotes}
                                onChange={(e) => setAdminNotes(e.target.value)}
                                disabled={!canEditFinance}
                                title={
                                  !canEditFinance
                                    ? ADMIN_VIEW_ONLY_ACTION_REASON
                                    : undefined
                                }
                                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                rows={3}
                                placeholder="Notes visible to the member..."
                              />
                            </div>
                            <div className="flex gap-2">
                              <ViewOnlyActionButton
                                canEdit={canEditFinance}
                                describeReason={false}
                                size="sm"
                                onClick={() => startRefundNotifyChoice(req.id, "APPROVED")}
                                disabled={processingRefund}
                              >
                                {processingRefund ? "Processing..." : "Approve & Refund"}
                              </ViewOnlyActionButton>
                              <ViewOnlyActionButton
                                canEdit={canEditFinance}
                                describeReason={false}
                                size="sm"
                                variant="destructive"
                                onClick={() => startRefundNotifyChoice(req.id, "REJECTED")}
                                disabled={processingRefund}
                              >
                                Reject
                              </ViewOnlyActionButton>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setReviewingRefundId(null)}
                                disabled={processingRefund}
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            </section>
          )}

          {creditApprovals.length > 0 && (
            <section className="space-y-4">
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-semibold">Manual Credit Approvals</h2>
                <Badge variant="secondary">{creditApprovals.length}</Badge>
              </div>

              <div className="space-y-4">
                {creditApprovals.map((request) => {
                  const isOwnRequest = session?.user?.id === request.requestedBy.id
                  const isReviewing = reviewingCreditId === request.id
                  const creditLedgerHref = buildHrefWithReturnTo(
                    `/admin/members/${request.member.id}#account-credit`,
                    currentRefundRequestsPath
                  )

                  return (
                    <Card key={request.id}>
                      <CardHeader>
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <CardTitle className="text-lg">
                              <Link
                                href={buildHrefWithReturnTo(`/admin/members/${request.member.id}`, currentRefundRequestsPath)}
                                className="hover:underline"
                              >
                                {request.member.firstName} {request.member.lastName}
                              </Link>
                            </CardTitle>
                            <p className="text-sm text-muted-foreground mt-1">
                              {request.member.email}
                            </p>
                          </div>
                          <Badge
                            variant={
                              request.status === "PENDING"
                                ? "outline"
                                : request.status === "APPROVED"
                                  ? "default"
                                  : "destructive"
                            }
                          >
                            {request.status}
                          </Badge>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-4">
                          <div>
                            <span className="text-muted-foreground">Amount:</span>{" "}
                            <span
                              className={
                                request.amountCents > 0
                                  ? "font-medium text-success-11"
                                  : "font-medium text-danger-11"
                              }
                            >
                              {request.amountCents > 0 ? "+" : ""}
                              {formatCents(request.amountCents)}
                            </span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Requested by:</span>{" "}
                            {formatAdminName(request.requestedBy)}
                          </div>
                          <div>
                            <span className="text-muted-foreground">Requested:</span>{" "}
                            {formatDateTime(clubTime, request.createdAt)}
                          </div>
                          <div>
                            <span className="text-muted-foreground">Member:</span>{" "}
                            <Link
                              href={buildHrefWithReturnTo(`/admin/members/${request.member.id}`, currentRefundRequestsPath)}
                              className="text-info-11 hover:underline"
                            >
                              Open member
                            </Link>
                          </div>
                        </div>

                        <div className="bg-muted rounded-md p-3">
                          <p className="text-sm font-medium mb-1">Reason:</p>
                          <p className="text-sm whitespace-pre-wrap">
                            {request.description}
                          </p>
                        </div>

                        {request.status !== "PENDING" && (
                          <div className="border-t pt-3 mt-3 text-sm space-y-1">
                            <p>
                              <span className="text-muted-foreground">Reviewed by:</span>{" "}
                              {formatAdminName(request.reviewedBy)}
                            </p>
                            {request.reviewedAt && (
                              <p>
                                <span className="text-muted-foreground">Reviewed:</span>{" "}
                                {formatDateTime(clubTime, request.reviewedAt)}
                              </p>
                            )}
                            {request.approvedCredit && (
                              <p>
                                <span className="text-muted-foreground">Applied credit:</span>{" "}
                                <Link
                                  href={creditLedgerHref}
                                  className="text-info-11 hover:underline"
                                >
                                  View credit ledger
                                </Link>
                                {request.approvedCredit.createdAt && (
                                  <span className="text-muted-foreground">
                                    {" "}
                                    ({formatDateTime(clubTime, request.approvedCredit.createdAt)})
                                  </span>
                                )}
                              </p>
                            )}
                          </div>
                        )}

                        {request.status === "PENDING" && (
                          <div className="border-t pt-3 mt-3 flex flex-wrap items-center gap-2">
                            {isOwnRequest ? (
                              <span className="text-sm text-warning-11">
                                Needs another admin to approve this request.
                              </span>
                            ) : (
                              <>
                                <ViewOnlyActionButton
                                  canEdit={canEditFinance}
                                  describeReason={false}
                                  size="sm"
                                  variant="outline"
                                  disabled={isReviewing}
                                  onClick={() => handleCreditReview(request, "APPROVE")}
                                >
                                  {isReviewing ? "Working..." : "Approve"}
                                </ViewOnlyActionButton>
                                <ViewOnlyActionButton
                                  canEdit={canEditFinance}
                                  describeReason={false}
                                  size="sm"
                                  variant="destructive"
                                  disabled={isReviewing}
                                  onClick={() => handleCreditReview(request, "REJECT")}
                                >
                                  Reject
                                </ViewOnlyActionButton>
                              </>
                            )}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            </section>
          )}
        </div>
      )}

      {/* #1792: per-action member-email choice, mirroring the #1695/#1705/#1769a
          pattern. The refund decision is applied either way; the choice is
          recorded in the audit log. A refund appellant always has an email on
          file, so the dialog is shown for every approve and reject. */}
      <Dialog
        open={notifyDialogOpen}
        onOpenChange={(open) => {
          if (!open && !processingRefund) setNotifyDialogOpen(false)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {notifyChoice?.noEmails
                ? notifyChoice.status === "REJECTED"
                  ? "Reject this appeal?"
                  : "Process this refund?"
                : notifyChoice?.status === "REJECTED"
                  ? "Email the member about this decision?"
                  : "Email the member about this refund?"}
            </DialogTitle>
            <DialogDescription>
              {notifyChoice?.noEmails
                ? notifyChoice.status === "REJECTED"
                  ? "The appeal will be rejected."
                  : "The refund will be processed."
                : notifyChoice?.status === "REJECTED"
                  ? "The appeal is rejected either way. Choose whether the member receives the standard refund-appeal outcome email — your choice is recorded in the audit log."
                  : "The refund is processed either way. Choose whether the member receives the standard refund-appeal outcome email — your choice is recorded in the audit log."}
            </DialogDescription>
          </DialogHeader>
          {/* #2259: with the booking's "No emails" switch on the outcome email
              is withheld whatever is chosen, so the choice is not offered. */}
          {notifyChoice?.noEmails && <BookingNoEmailsNotice />}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              disabled={processingRefund}
              onClick={() =>
                notifyChoice?.noEmails ? confirmSilenced() : confirmNotify(false)
              }
            >
              {notifyChoice?.noEmails
                ? notifyChoice.status === "REJECTED"
                  ? "Reject appeal"
                  : "Approve refund"
                : notifyChoice?.status === "REJECTED"
                  ? "Reject without emailing"
                  : "Approve without emailing"}
            </Button>
            {!notifyChoice?.noEmails && (
              <Button disabled={processingRefund} onClick={() => confirmNotify(true)}>
                {notifyChoice?.status === "REJECTED"
                  ? "Reject and email member"
                  : "Approve and email member"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
    </div>
  )
}
