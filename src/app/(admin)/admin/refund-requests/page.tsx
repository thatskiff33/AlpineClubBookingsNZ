"use client"

import { useEffect, useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { getCancellationSettlementBreakdown } from "@/lib/payment-status-display"

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

function formatCents(cents: number): string {
  return "$" + (cents / 100).toFixed(2)
}

export default function RefundRequestsPage() {
  const [requests, setRequests] = useState<RefundRequestData[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<"PENDING" | "APPROVED" | "REJECTED" | "ALL">("PENDING")
  const [reviewingId, setReviewingId] = useState<string | null>(null)
  const [adminNotes, setAdminNotes] = useState("")
  const [approvedAmount, setApprovedAmount] = useState("")
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")

  const fetchRequests = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/admin/refund-requests?status=${filter}`)
      if (!res.ok) throw new Error("Failed to fetch")
      const data = await res.json()
      setRequests(data)
    } catch {
      setError("Failed to load refund requests")
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    fetchRequests()
  }, [fetchRequests])

  async function handleReview(id: string, status: "APPROVED" | "REJECTED") {
    setProcessing(true)
    setError("")
    setSuccess("")
    try {
      const body: Record<string, unknown> = { status, adminNotes: adminNotes || undefined }
      if (status === "APPROVED") {
        const cents = Math.round(parseFloat(approvedAmount) * 100)
        if (!cents || cents <= 0) {
          setError("Please enter a valid refund amount")
          setProcessing(false)
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
      setReviewingId(null)
      setAdminNotes("")
      setApprovedAmount("")
      setSuccess(status === "APPROVED" ? "Refund approved and processed" : "Appeal rejected")
      fetchRequests()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setProcessing(false)
    }
  }

  function startReview(req: RefundRequestData) {
    setReviewingId(req.id)
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Refund Appeals</h1>
        <p className="text-muted-foreground mt-1">
          Review and process member refund appeal requests
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
        {(["PENDING", "APPROVED", "REJECTED", "ALL"] as const).map((s) => (
          <Button
            key={s}
            variant={filter === s ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter(s)}
          >
            {s === "ALL" ? "All" : s.charAt(0) + s.slice(1).toLowerCase()}
          </Button>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-8">Loading...</div>
      ) : requests.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          No {filter === "ALL" ? "" : filter.toLowerCase()} refund appeals found.
        </div>
      ) : (
        <div className="space-y-4">
          {requests.map((req) => {
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
            const isReviewing = reviewingId === req.id

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
                    Submitted {new Date(req.createdAt).toLocaleDateString("en-NZ", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
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
                          Reviewed {new Date(req.reviewedAt).toLocaleDateString("en-NZ", {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </p>
                      )}
                    </div>
                  )}

                  {req.status === "PENDING" && !isReviewing && (
                    <div className="flex gap-2 pt-2">
                      <Button size="sm" onClick={() => startReview(req)}>
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
                          onClick={() => handleReview(req.id, "APPROVED")}
                          disabled={processing}
                        >
                          {processing ? "Processing..." : "Approve & Refund"}
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => handleReview(req.id, "REJECTED")}
                          disabled={processing}
                        >
                          Reject
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setReviewingId(null)}
                          disabled={processing}
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
      )}
    </div>
  )
}
