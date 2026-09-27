"use client"

import { Label } from "@/components/ui/label"

/**
 * #3639 (owner decision 26 Sep 2026): what happens to a card payment that goes
 * through after its booking was cancelled. Rendered in the Cancellation page's
 * club-wide block, because it is what happens to money after a cancellation,
 * and club-wide because it is how the club handles money, not a lodge's policy.
 */
export function LateCaptureRefundSetting({
  needsApproval,
  editing,
  canChange,
  onChange,
}: {
  needsApproval: boolean
  editing: boolean
  /**
   * #3639 review F2: changing it needs finance edit, which the server enforces;
   * a bookings-only officer sees it read-only and is told why. `undefined` while
   * the session resolves is treated as not yet allowed.
   */
  canChange: boolean | undefined
  onChange: (needsApproval: boolean) => void
}) {
  const disabled = !editing || canChange !== true
  return (
    <div className="space-y-1 rounded-md border p-3">
      <Label htmlFor="lateCaptureRefund">
        Payments that arrive after a booking was cancelled
      </Label>
      <select
        id="lateCaptureRefund"
        value={needsApproval ? "approve" : "automatic"}
        onChange={(e) => onChange(e.target.value === "approve")}
        disabled={disabled}
        aria-describedby="lateCaptureRefundHelp"
        className={`w-full max-w-md rounded-md border border-input px-3 py-2 text-sm ${disabled ? "bg-muted text-muted-foreground" : "bg-background"}`}
      >
        <option value="automatic">Refund them automatically</option>
        <option value="approve">A treasurer approves each refund</option>
      </select>
      <p id="lateCaptureRefundHelp" className="text-xs text-muted-foreground">
        Now and then a card payment goes through after its booking was
        cancelled. By default it is refunded to the card straight away. Choose
        treasurer approval to hold it instead: it waits under Payments, in the
        refund tasks, until someone with finance access refunds it to the card
        or keeps it with a note. This does not change what a cancellation
        refunds.
        {canChange === false
          ? " Only someone with finance edit access can change this setting."
          : null}
      </p>
    </div>
  )
}
