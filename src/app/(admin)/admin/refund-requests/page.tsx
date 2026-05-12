"use client"

import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import { useSession } from "next-auth/react"
import { useRouter, useSearchParams } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { getCancellationSettlementBreakdown } from "@/lib/payment-status-display"
import { buildHrefWithReturnTo } from "@/lib/internal-return-path"

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

function formatDateTime(value: string | null) {
  if (!value) {
    return null
  }

  return new Date(value).toLocaleDateString("en-NZ", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export default function RefundRequestsPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const initialFilter = searchParams.get("status")
  const { data: session } = useSession()
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
  const [success, setSuccess] = useState("")
  const currentRefundRequestsPath =
    filter === "PENDING" ? "/admin/refund-requests" : `/admin/refund-requests?status=${filter}`

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
  }, [filter])

  useEffect(() => {
    fetchRequests()
  }, [fetchRequests])

  async function handleRefundReview(id: string, status: "APPROVED" | "REJECTED") {
    setProcessingRefund(true)
    setError("")
    setSuccess("")

    try {
      const body: Record<string, unknown> = {
        status,
        adminNotes: adminNotes || undefined,
      }

      if (status === "APPROVED") {
        const cents = Math.round(parseFloat(approvedAmount) * 100)
        if (!cents || cents <= 0) {
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
      setSuccess(
        status === "APPROVED"
          ? "Refund approved and processed"
          : "Appeal rejected"
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
    setSuccess("")

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

      setSuccess(
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Refund Appeals & Credits</h1>
        <p className="text-muted-foreground mt-1">
          Review refund appeals and manual credit approvals from one queue
        </p>
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md">
          {error}
          <button onClick={() => setError("")} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      {success && (
        <div className="bg-green-50 text-green-800 px-4 py-3 rounded-md border border-green-200">
          {success}
          <button onClick={() => setSuccess("")} className="ml-2 underline">Dismiss</button>
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
                            {new Date(req.booking.checkIn).toLocaleDateString("en-NZ")}
                          </div>
                          <div>
                            <span className="text-muted-foreground">Check-out:</span>{" "}
                            {new Date(req.booking.checkOut).toLocaleDateString("en-NZ")}
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

                        <div className="bg-slate-50 rounded-md p-3">
                          <p className="text-sm font-medium mb-1">Reason:</p>
                          <p className="text-sm whitespace-pre-wrap">{req.reason}</p>
                        </div>

                        <p className="text-xs text-muted-foreground">
                          Submitted {formatDateTime(req.createdAt)}
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
                                Reviewed {formatDateTime(req.reviewedAt)}
                              </p>
                            )}
                          </div>
                        )}

                        {req.status === "PENDING" && !isReviewing && (
                          <div className="flex gap-2 pt-2">
                            <Button size="sm" onClick={() => startRefundReview(req)}>
                              Review
                            </Button>
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
                                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                rows={3}
                                placeholder="Notes visible to the member..."
                              />
                            </div>
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                onClick={() => handleRefundReview(req.id, "APPROVED")}
                                disabled={processingRefund}
                              >
                                {processingRefund ? "Processing..." : "Approve & Refund"}
                              </Button>
                              <Button
                                size="sm"
                                variant="destructive"
                                onClick={() => handleRefundReview(req.id, "REJECTED")}
                                disabled={processingRefund}
                              >
                                Reject
                              </Button>
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
                                  ? "font-medium text-green-700"
                                  : "font-medium text-red-700"
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
                            {formatDateTime(request.createdAt)}
                          </div>
                          <div>
                            <span className="text-muted-foreground">Member:</span>{" "}
                            <Link
                              href={buildHrefWithReturnTo(`/admin/members/${request.member.id}`, currentRefundRequestsPath)}
                              className="text-blue-600 hover:underline"
                            >
                              Open member
                            </Link>
                          </div>
                        </div>

                        <div className="bg-slate-50 rounded-md p-3">
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
                                {formatDateTime(request.reviewedAt)}
                              </p>
                            )}
                            {request.approvedCredit && (
                              <p>
                                <span className="text-muted-foreground">Applied credit:</span>{" "}
                                {request.approvedCredit.id}
                              </p>
                            )}
                          </div>
                        )}

                        {request.status === "PENDING" && (
                          <div className="border-t pt-3 mt-3 flex flex-wrap items-center gap-2">
                            {isOwnRequest ? (
                              <span className="text-sm text-amber-700">
                                Needs another admin to approve this request.
                              </span>
                            ) : (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={isReviewing}
                                  onClick={() => handleCreditReview(request, "APPROVE")}
                                >
                                  {isReviewing ? "Working..." : "Approve"}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  disabled={isReviewing}
                                  onClick={() => handleCreditReview(request, "REJECT")}
                                >
                                  Reject
                                </Button>
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
    </div>
  )
}
