"use client"

import { useState, useEffect } from "react"
import { toast } from "sonner"
import { humanizeStatus } from "@/lib/status-colors"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { FieldHint, useFieldHint } from "@/components/ui/field-hint"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { useClubTime } from "@/components/club-time-provider";
import { MONEY_INPUT_PROPS, parseDecimalDollarsToCents } from "@/lib/money-input"

interface RefundAppealButtonProps {
  bookingId: string
  maxRefundableCents: number
  description?: string
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

/**
 * When the member raised the refund appeal.
 *
 * A real INSTANT, projected through the club's PERSISTED timezone (CT-4, #2870;
 * INV-CONFIG-002) rather than the container's `TZ`. `instantDate` keeps the
 * medium "16 Apr 2026" shape this line has always shown; only the zone's
 * AUTHORITY moved. The zone reaches this browser as data through
 * `ClubTimeProvider` - never from the viewer's own clock.
 */
function useAppealStampFormatter() {
  const clubTime = useClubTime();
  return (value: string) => clubTime.instantDate(new Date(value));
}

export function RefundAppealButton({
  bookingId,
  maxRefundableCents,
  description = "If you believe you are entitled to a larger refund, you can submit an appeal for review.",
}: RefundAppealButtonProps) {
  const formatAppealStamp = useAppealStampFormatter()
  const [showForm, setShowForm] = useState(false)
  const [reason, setReason] = useState("")
  const [requestedAmount, setRequestedAmount] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")
  const [existingRequests, setExistingRequests] = useState<RefundRequestData[]>([])
  const [loading, setLoading] = useState(true)
  /*
    #2264: the amount box carried a "0.00" placeholder — grey text inside the
    control that reads as an amount already requested, and that vanishes on the
    first keystroke. The format example now lives in the SAME paragraph that
    already stated the maximum, rather than as a second line saying much the
    same thing, and that paragraph is wired to the input with aria-describedby
    so it is announced on focus instead of being invisible to a screen reader.
  */
  const amountHint = useFieldHint()

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
      if (requestedAmount.trim()) {
        /*
          #2685: an amount this parser refuses is now REFUSED. It used to become
          `NaN`, and `JSON.stringify` writes `NaN` as `null` — so a mistyped
          amount was silently dropped from the request and the appeal was filed
          as though no amount had been asked for at all.
        */
        const cents = parseDecimalDollarsToCents(requestedAmount)
        if (cents === null) {
          setError("Enter an amount in dollars and cents, for example 45.00.")
          return
        }
        /*
          The box is `type="text"` now (#2685), so the browser no longer refuses
          an over-cap amount on its own — a `max` attribute only constrains a
          number input. That constraint was worth keeping, so it is stated here
          instead, where it can also say what the cap actually is.
        */
        if (cents > maxRefundableCents) {
          setError(
            `That is more than can be refunded on this booking. The most you can ask for is $${(maxRefundableCents / 100).toFixed(2)}.`,
          )
          return
        }
        body.requestedAmountCents = cents
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
      toast.success("Your refund appeal has been submitted. We'll review it and get back to you.")
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
              <div key={req.id} className="bg-card rounded-md p-3 text-sm space-y-1">
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
                    {humanizeStatus(req.status)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {formatAppealStamp(req.createdAt)}
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
          // `role="alert"` (#2685 review): this banner carries the refusal for a
          // refund amount a member typed, and without it a screen-reader user
          // pressing Submit heard nothing at all — the message was drawn and
          // never announced.
          <div
            role="alert"
            className="bg-destructive/10 text-destructive px-3 py-2 rounded-md text-sm"
          >
            {error}
          </div>
        )}

        {!showForm && !hasPending && maxRefundableCents > 0 && (
          <div>
            <p className="text-sm text-muted-foreground mb-3">
              {description}
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
                  {...MONEY_INPUT_PROPS}
                  value={requestedAmount}
                  onChange={(e) => setRequestedAmount(e.target.value)}
                  className="w-32"
                  {...amountHint.fieldProps}
                />
              </div>
              <FieldHint {...amountHint.hintProps}>
                Example: 0.00 — maximum ${(maxRefundableCents / 100).toFixed(2)}
              </FieldHint>
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
