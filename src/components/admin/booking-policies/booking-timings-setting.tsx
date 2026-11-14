"use client"

import { useState } from "react"
import {
  BOOKING_TIMING_DAYS_MAX,
  BOOKING_TIMING_DAYS_MIN,
} from "@/config/club-settings-defaults"
import { BOOKING_TIMING_KEYS, type BookingTimings } from "@/lib/booking-timings"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

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

export function bookingTimingsDiffer(a: BookingTimings, b: BookingTimings): boolean {
  return BOOKING_TIMING_KEYS.some((key) => a[key] !== b[key])
}

/** The whole number the text holds, or null when it is empty or not a whole number. */
function wholeDays(text: string): number | null {
  if (text.trim() === "") return null
  const parsed = Number(text)
  return Number.isInteger(parsed) ? parsed : null
}

function withinBounds(days: number): boolean {
  return days >= BOOKING_TIMING_DAYS_MIN && days <= BOOKING_TIMING_DAYS_MAX
}

/**
 * Rendered in the Cancellation page's club-wide block beside the club's other
 * booking defaults, and saved with them: the timings are club answers, not a
 * lodge's (`INV-CONFIG-001`).
 *
 * The text an admin is typing stays in `drafts` until the field loses focus, so
 * clearing a field to retype it, or typing "14" after the caret at the end of
 * "7", does not snap to a clamped value half way through. Only a whole number
 * inside the bounds is staged while typing; on blur an out-of-bounds number is
 * pulled to the nearest bound and a blank or non-whole entry falls back to the
 * last staged value. The page saves from a button, so a blur always comes first.
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
  const [drafts, setDrafts] = useState<Partial<Record<keyof BookingTimings, string>>>({})
  // Leaving edit mode (Save or Cancel) drops any typed text, so a draft from one
  // edit never shows in the next. React's reset-on-prop-change pattern, no effect.
  const [wasEditing, setWasEditing] = useState(editing)
  if (wasEditing !== editing) {
    setWasEditing(editing)
    if (!editing) setDrafts({})
  }

  function typeDays(key: keyof BookingTimings, text: string) {
    setDrafts((current) => ({ ...current, [key]: text }))
    const days = wholeDays(text)
    if (days !== null && withinBounds(days)) onChange({ [key]: days })
  }

  function settleDays(key: keyof BookingTimings, text: string) {
    const days = wholeDays(text)
    if (days !== null && !withinBounds(days)) {
      onChange({
        [key]: Math.min(BOOKING_TIMING_DAYS_MAX, Math.max(BOOKING_TIMING_DAYS_MIN, days)),
      })
    }
    setDrafts((current) => {
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  return (
    <div className="space-y-3 rounded-md border p-3">
      <p className="text-sm font-medium">Reminder and hold timings</p>
      {TIMING_ROWS.map((row) => {
        const draft = drafts[row.key]
        const days = draft === undefined ? null : wholeDays(draft)
        const outOfBounds = draft !== undefined && (days === null || !withinBounds(days))
        return (
          <div key={row.key} className="space-y-1">
            <Label htmlFor={row.key}>{row.label}</Label>
            <div className="flex items-center space-x-2">
              <Input
                id={row.key}
                type="number"
                min={BOOKING_TIMING_DAYS_MIN}
                max={BOOKING_TIMING_DAYS_MAX}
                value={draft ?? String(timings[row.key])}
                onChange={(e) => typeDays(row.key, e.target.value)}
                onBlur={(e) => settleDays(row.key, e.target.value)}
                aria-describedby={`${row.key}Help`}
                aria-invalid={outOfBounds || undefined}
                className={`w-20 ${!editing ? "bg-muted text-muted-foreground" : ""}`}
                disabled={!editing}
              />
              <span className="text-sm text-muted-foreground">{row.unit}</span>
            </div>
            <p id={`${row.key}Help`} className="text-xs text-muted-foreground">
              {row.help}
            </p>
          </div>
        )
      })}
    </div>
  )
}
