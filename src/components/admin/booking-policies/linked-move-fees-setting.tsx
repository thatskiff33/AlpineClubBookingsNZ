"use client"

import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"

/**
 * #3232 D2. Club-wide, beside the other club-wide booking defaults, because
 * whether a second change fee is fair when the club's own supervision rule
 * compelled the move is a question about how the club treats its members — not
 * about one lodge's cancellation risk, which is what the fee TIERS price.
 */
export function LinkedMoveFeesSetting({
  chargeBoth,
  editing,
  onChange,
}: {
  chargeBoth: boolean
  editing: boolean
  onChange: (chargeBoth: boolean) => void
}) {
  return (
    <div className="flex items-start gap-3 rounded-md border p-3">
      <Checkbox
        id="linkedMoveBothFees"
        checked={chargeBoth}
        disabled={!editing}
        onCheckedChange={(v) => onChange(v === true)}
      />
      <div className="space-y-1">
        <Label htmlFor="linkedMoveBothFees">
          Charge the change fee on both bookings when a member moves two together
        </Label>
        <p className="text-xs text-muted-foreground">
          When a member changes the dates of a booking that another of their own
          bookings relies on for adult supervision, they are offered the chance
          to move both together. Both bookings really move, so by default both
          attract the change fee, shown as one combined figure. Turn this off to
          charge only the booking the member was editing — some clubs think the
          second fee is unfair when it was the club&apos;s own supervision rule
          that made the second move necessary.
        </p>
      </div>
    </div>
  )
}
