"use client"

import { AlertTriangle, CheckCircle2 } from "lucide-react"
import { HealthStatCard, ToneChip } from "./shared"

/**
 * #4220 (owner decision, 24 Oct 2026): the Health Snapshot's count of credit notes
 * Xero shows used outside the app while bookings still wait to draw on them. The
 * count is derived on each load from what Xero already sent (no Xero call, nothing
 * stored); the booking repair check names the bookings.
 */
export function CreditUsedInXeroCard({ count }: { count: number }) {
  return (
    <HealthStatCard
      label="Credit used in Xero"
      value={count}
      subtitle="Credit notes used in Xero outside the app while bookings still wait to draw on them, so Xero will refuse those allocations. Check the notes in Xero; the booking repair check lists the bookings."
      badge={count > 0 ? <ToneChip tone="warning" icon={AlertTriangle}>Review</ToneChip> : <ToneChip tone="success" icon={CheckCircle2}>Clear</ToneChip>}
    />
  )
}
