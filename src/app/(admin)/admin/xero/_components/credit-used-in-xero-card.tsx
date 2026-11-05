"use client"

import { AlertTriangle, CheckCircle2, Circle } from "lucide-react"
import { HealthStatCard, ToneChip } from "./shared"

/**
 * #4220 (owner decision, 24 Oct 2026): the Health Snapshot's count of credit notes
 * Xero shows used outside the app while bookings still wait to draw on them. The
 * count is derived on each load from what Xero already sent (no Xero call, nothing
 * stored); the booking repair check names the bookings. A server that sends no
 * count (an older build mid-deploy) shows "Unknown", never a reassuring "Clear".
 */
export function CreditUsedInXeroCard({ count }: { count: number | null }) {
  const badge =
    count === null ? (
      <ToneChip tone="neutral" icon={Circle}>Unknown</ToneChip>
    ) : count > 0 ? (
      <ToneChip tone="warning" icon={AlertTriangle}>Review</ToneChip>
    ) : (
      <ToneChip tone="success" icon={CheckCircle2}>Clear</ToneChip>
    )
  return (
    <HealthStatCard
      label="Credit used in Xero"
      value={count ?? "—"}
      subtitle={
        count === null
          ? "This server did not report the count. Reload once the update has finished; the booking repair check still lists the bookings."
          : "Credit notes used in Xero outside the app while bookings still wait to draw on them, so Xero will refuse those allocations. Check the notes in Xero; the booking repair check lists the bookings."
      }
      badge={badge}
    />
  )
}
