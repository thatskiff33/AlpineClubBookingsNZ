"use client"

import {
  BOOKING_TIMING_DAYS_MAX,
  BOOKING_TIMING_DAYS_MIN,
  DEFAULT_BOOKING_DEFAULTS,
} from "@/config/club-settings-defaults"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/** The club's three booking timings, in days (#4932). */
export interface BookingTimings {
  preArrivalReminderDays: number
  additionalPaymentReminderDays: number
  policyExceptionHoldDays: number
}

const TIMING_ROWS: ReadonlyArray<{
  key: keyof BookingTimings
  label: string
  unit: string
  help: string
}> = [
  {
    key: "preArrivalReminderDays",
    label: "Pre-arrival reminder",
    unit: "days before check-in",
    help: "When the reminder with arrival details goes out. A booking already reminded is not reminded again.",
  },
  {
    key: "additionalPaymentReminderDays",
    label: "First reminder to pay an extra amount",
    unit: "days after it is raised",
    help: "How long a member has to pay an extra amount from a booking change before the first reminder goes out.",
  },
  {
    key: "policyExceptionHoldDays",
    label: "Policy-exception hold",
    unit: "days",
    help: "How long a policy-exception request keeps its beds while officers decide, or until the first held night if that is sooner. A change applies to new requests; one already waiting keeps its deadline.",
  },
]

const TIMING_KEYS = [
  "preArrivalReminderDays",
  "additionalPaymentReminderDays",
  "policyExceptionHoldDays",
] as const satisfies ReadonlyArray<keyof BookingTimings>

/**
 * The timings from a GET or PUT echo, or just the timings of a larger draft for
 * the save body; a value it lacks is the shipped default.
 */
export function bookingTimingsFrom(data: Partial<BookingTimings>): BookingTimings {
  return {
    preArrivalReminderDays:
      data.preArrivalReminderDays ?? DEFAULT_BOOKING_DEFAULTS.preArrivalReminderDays,
    additionalPaymentReminderDays:
      data.additionalPaymentReminderDays ??
      DEFAULT_BOOKING_DEFAULTS.additionalPaymentReminderDays,
    policyExceptionHoldDays:
      data.policyExceptionHoldDays ?? DEFAULT_BOOKING_DEFAULTS.policyExceptionHoldDays,
  }
}

export function bookingTimingsDiffer(a: BookingTimings, b: BookingTimings): boolean {
  return TIMING_KEYS.some((key) => a[key] !== b[key])
}

function clampDays(value: string, fallback: number): number {
  const parsed = parseInt(value, 10)
  if (Number.isNaN(parsed)) return fallback
  return Math.min(BOOKING_TIMING_DAYS_MAX, Math.max(BOOKING_TIMING_DAYS_MIN, parsed))
}

/**
 * Rendered in the Cancellation page's club-wide block beside the club's other
 * booking defaults, and saved with them: the timings are club answers, not a
 * lodge's (`INV-CONFIG-001`).
 */
export function BookingTimingsSetting({
  timings,
  editing,
  onChange,
}: {
  timings: BookingTimings
  editing: boolean
  onChange: (patch: Partial<BookingTimings>) => void
}) {
  return (
    <div className="space-y-3 rounded-md border p-3">
      <p className="text-sm font-medium">Reminder and hold timings</p>
      {TIMING_ROWS.map((row) => (
        <div key={row.key} className="space-y-1">
          <Label htmlFor={row.key}>{row.label}</Label>
          <div className="flex items-center space-x-2">
            <Input
              id={row.key}
              type="number"
              min={BOOKING_TIMING_DAYS_MIN}
              max={BOOKING_TIMING_DAYS_MAX}
              value={timings[row.key]}
              onChange={(e) =>
                onChange({ [row.key]: clampDays(e.target.value, timings[row.key]) })
              }
              aria-describedby={`${row.key}Help`}
              className={`w-20 ${!editing ? "bg-muted text-muted-foreground" : ""}`}
              disabled={!editing}
            />
            <span className="text-sm text-muted-foreground">{row.unit}</span>
          </div>
          <p id={`${row.key}Help`} className="text-xs text-muted-foreground">
            {row.help}
          </p>
        </div>
      ))}
    </div>
  )
}
