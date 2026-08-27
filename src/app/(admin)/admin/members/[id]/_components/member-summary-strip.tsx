"use client"

import { Card, CardContent } from "@/components/ui/card"
import { Calendar, Clock, CreditCard, IdCard, User, Wallet } from "lucide-react"
import { formatCents } from "@/lib/utils"
import { seasonSelectLabel } from "@/lib/season-label"
import { formatAgeYearsMonths } from "@/lib/member-age"
// #3123: the member's age is rendered IN THE BROWSER, so "today" cannot come
// from this bundle — `APP_TIME_ZONE` here is whatever `NEXT_PUBLIC_TZ` was at
// build time, not the club's persisted zone (`INV-CONFIG-002`). It arrives as
// data through the provider the `(admin)` layout mounts (`AppProviders` ->
// `AppProvidersClient` -> `ClubTimeProvider`). The age year on this strip is
// what an administrator reads while confirming WHICH member record an
// identity-sensitive action applies to (#2568), so a day's drift here is not
// cosmetic.
import { useClubTime } from "@/components/club-time-provider"
// Both values this strip dates are CALENDAR DAYS with no timezone: a date of
// birth, and `lastStay`, which is the maximum `checkOut` of the member's
// bookings — a `@db.Date` lodge night. Projecting either through a zone is
// `INV-DATE-019`; for a club behind UTC it ages the member a day and moves
// their last night off the one they stayed.
import { formatPayloadCalendarDay } from "../../../_lib/calendar-day"
import { formatAgeTierName } from "@/lib/use-age-tier-options"
import type { MemberDetail } from "../_types"
import type { LucideIcon } from "lucide-react"

interface MemberSummaryStripProps {
  member: MemberDetail
  membershipLabel: string
  creditBalance: number
  creditLoading: boolean
}

function SummaryItem({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: LucideIcon
  label: string
  value: string
  detail?: string | null
}) {
  return (
    <div className="flex items-center gap-3 bg-card px-4 py-3">
      <Icon className="h-6 w-6 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p className="truncate text-sm font-semibold">{value}</p>
        {detail ? (
          <p className="truncate text-xs text-muted-foreground">{detail}</p>
        ) : null}
      </div>
    </div>
  )
}

export function MemberSummaryStrip({
  member,
  membershipLabel,
  creditBalance,
  creditLoading,
}: MemberSummaryStripProps) {
  const clubClock = useClubTime()
  const memberExactAge = member.dateOfBirth
    ? formatAgeYearsMonths(member.dateOfBirth, clubClock.today())
    : null

  return (
    <Card className="overflow-hidden">
      <CardContent className="grid grid-cols-1 gap-px bg-border p-0 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <SummaryItem
          icon={User}
          label="Age Tier"
          value={formatAgeTierName(member.ageTier)}
          detail={
            member.dateOfBirth
              ? `DOB: ${formatPayloadCalendarDay(member.dateOfBirth)}${memberExactAge ? ` (${memberExactAge})` : ""}`
              : null
          }
        />
        <SummaryItem
          icon={IdCard}
          label="Membership"
          value={membershipLabel}
          detail={`${seasonSelectLabel(member.currentSeasonYear)} season`}
        />
        <SummaryItem
          icon={Wallet}
          label="Credit"
          value={creditLoading ? "—" : formatCents(creditBalance)}
        />
        <SummaryItem
          icon={Calendar}
          label="Total Bookings"
          value={String(member.stats.totalBookings)}
        />
        <SummaryItem
          icon={CreditCard}
          label="Total Spend"
          value={formatCents(member.stats.totalSpendCents)}
        />
        <SummaryItem
          icon={Clock}
          label="Last Stay"
          value={
            member.stats.lastStay
              ? formatPayloadCalendarDay(member.stats.lastStay)
              : "Never"
          }
        />
      </CardContent>
    </Card>
  )
}
