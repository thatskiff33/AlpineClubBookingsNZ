"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"

interface RefundAppealButtonProps {
  bookingId: string
  maxRefundableCents: number
}

interface RefundRequestData {
  id: string
  status: "PENDING" | "APPROVED" | "REJECTED"
  reason: string
  requestedAmountCents: number | null
  approvedAmountCents: number | null
  adminNotes: string | null
  createdAt: string
  reviewedAt: string | null
}

export function RefundAppealButton({
  bookingId,
  maxRefundableCents,
}: RefundAppealButtonProps) {
  const [showForm, setShowForm] = useState(false)
  const [reason, setReason] = useState("")
  const [requestedAmount, setRequestedAmount] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")
  const [existingRequests, setExistingRequests] = useState<RefundRequestData[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`/api/bookings/${bookingId}/refund-request`)
      .then((res) => res.json())
      .then((data) => setExistingRequests(data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [bookingId])

  const hasPending = existingRequests.some((r) => r.status === "PENDING")

  async function handleSubmit() {
    setSubmitting(true)
    setError("")
    try {
      const body: Record<string, unknown> = { reason }
      if (requestedAmount) {
        body.requestedAmountCents = Math.round(parseFloat(requestedAmount) * 100)
      }

      const res = await fetch(`/api/bookings/${bookingId}/refund-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to submit")
      }

      const newReq = await res.json()
      setExistingRequests((prev) => [newReq, ...prev])
      setSuccess("Your refund appeal has been submitted. We'll review it and get back to you.")
      setShowForm(false)
      setReason("")
      setRequestedAmount("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle>Refund Appeal</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {existingRequests.length > 0 && (
          <div className="space-y-2">
            {existingRequests.map((req) => (
              <div key={req.id} className="bg-slate-50 rounded-md p-3 text-sm space-y-1">
                <div className="flex items-center justify-between">
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
                  <span className="text-xs text-muted-foreground">
                    {new Date(req.createdAt).toLocaleDateString("en-NZ")}
                  </span>
                </div>
                <p className="text-muted-foreground">{req.reason}</p>
                {req.approvedAmountCents != null && req.approvedAmountCents > 0 && (
                  <p>
                    Refunded: <strong>${(req.approvedAmountCents / 100).toFixed(2)}</strong>
                  </p>
                )}
                {req.adminNotes && (
                  <p className="text-muted-foreground italic">{req.adminNotes}</p>
                )}
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="bg-destructive/10 text-destructive px-3 py-2 rounded-md text-sm">
            {error}
          </div>
        )}
        {success && (
          <div className="bg-green-50 text-green-800 px-3 py-2 rounded-md text-sm border border-green-200">
            {success}
          </div>
        )}

        {!showForm && !hasPending && maxRefundableCents > 0 && (
          <div>
            <p className="text-sm text-muted-foreground mb-3">
              If you believe you are entitled to a larger refund, you can submit an appeal for review.
            </p>
            <Button variant="outline" onClick={() => setShowForm(true)}>
              Request Refund Appeal
            </Button>
          </div>
        )}

        {hasPending && (
          <p className="text-sm text-muted-foreground">
            Your refund appeal is pending review. We&apos;ll notify you once it&apos;s been processed.
          </p>
        )}

        {showForm && (
          <div className="space-y-3 border-t pt-4">
            <div className="space-y-2">
              <Label htmlFor="reason">Reason for appeal</Label>
              <textarea
                id="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[100px]"
                placeholder="Please explain why you believe you deserve an additional refund..."
                maxLength={2000}
              />
              <p className="text-xs text-muted-foreground">{reason.length}/2000</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="amount">Requested amount (optional)</Label>
              <div className="flex items-center gap-2">
                <span className="text-sm">$</span>
                <Input
                  id="amount"
                  type="number"
                  step="0.01"
                  min="0"
                  max={(maxRefundableCents / 100).toFixed(2)}
                  value={requestedAmount}
                  onChange={(e) => setRequestedAmount(e.target.value)}
                  className="w-32"
                  placeholder="0.00"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Maximum: ${(maxRefundableCents / 100).toFixed(2)}
              </p>
            </div>

            <div className="flex gap-2">
              <Button
                onClick={handleSubmit}
                disabled={submitting || reason.length < 10}
              >
                {submitting ? "Submitting..." : "Submit Appeal"}
              </Button>
              <Button variant="outline" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
