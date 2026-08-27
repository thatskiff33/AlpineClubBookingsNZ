"use client"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatPromoBenefit } from "@/lib/admin-member-detail-helpers"
import { useClubTime } from "@/components/club-time-provider"
import { formatPayloadCalendarDay } from "../../../_lib/calendar-day"
import { formatPayloadInstantDate } from "../../../_lib/payload-instant"
import type { MemberPromoCode } from "../_types"

export function MemberPromoCodesCard({ promoCodes, className }: { promoCodes: MemberPromoCode[]; className?: string }) {
  // Both kinds appear in this one cell. `assignedAt` is a real INSTANT — when
  // the assignment row was written — and reads in the club's persisted zone.
  // The promo window (`validFrom`/`validUntil`) and the stay gate
  // (`bookingStartFrom`/`bookingStartUntil`) are `@db.Date` CALENDAR DAYS and
  // carry no zone: projecting them is `INV-DATE-019`, and a day early on the
  // stay gate is the difference between a code that works for a booking and
  // one that does not.
  const clubTime = useClubTime()
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-base font-medium">Promo Codes</CardTitle>
      </CardHeader>
      <CardContent>
        {promoCodes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No promo codes assigned to this member.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Benefit</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Validity</TableHead>
                <TableHead>Usage</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {promoCodes.map((promo) => (
                <TableRow key={promo.id || promo.code}>
                  <TableCell>
                    <div className="space-y-1">
                      <Badge variant="secondary" className="font-mono">
                        {promo.code}
                      </Badge>
                      {promo.description && (
                        <p className="max-w-xs text-xs text-muted-foreground">{promo.description}</p>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm font-medium">{formatPromoBenefit(promo)}</TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      <Badge
                        variant="secondary"
                        className={
                          promo.visibleToMember
                            ? "bg-success-3 text-success-11 border-success-6"
                            : "bg-warning-3 text-warning-11 border-warning-6"
                        }
                      >
                        {promo.visibleToMember ? "Visible to member" : "Not currently usable"}
                      </Badge>
                      <p className="text-xs text-muted-foreground">{promo.statusReason}</p>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    <div className="space-y-1">
                      <p>Assigned {promo.assignedAt ? formatPayloadInstantDate(clubTime, promo.assignedAt) : "unknown"}</p>
                      <p>
                        Valid {promo.validFrom ? formatPayloadCalendarDay(promo.validFrom) : "now"} -{" "}
                        {promo.validUntil ? formatPayloadCalendarDay(promo.validUntil) : "no end"}
                      </p>
                      {(promo.bookingStartFrom || promo.bookingStartUntil) && (
                        <p>
                          Stay dates {promo.bookingStartFrom ? formatPayloadCalendarDay(promo.bookingStartFrom) : "any"} -{" "}
                          {promo.bookingStartUntil ? formatPayloadCalendarDay(promo.bookingStartUntil) : "any"}
                        </p>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    <div className="space-y-1">
                      {/* Both figures count only applications that actually
                          gave someone a benefit — the same rule the caps
                          enforce (#2299) — and both are counted per member per
                          booking, so the wording says "benefits", not
                          "redemptions". */}
                      <p>
                        {promo.currentRedemptions}
                        {promo.maxRedemptionsTotal !== null ? ` of ${promo.maxRedemptionsTotal}` : ""} benefits given, all members
                      </p>
                      <p>
                        {promo.redemptionCount}
                        {promo.maxUsesPerMember !== null ? ` of ${promo.maxUsesPerMember}` : ""} benefits given to this member
                      </p>
                      {promo.type === "FREE_NIGHTS" && promo.lifetimeFreeNightsCap !== null && (
                        <p>
                          {promo.freeNightsUsed}/{promo.lifetimeFreeNightsCap} free nights used (lifetime)
                        </p>
                      )}
                      {promo.type === "FREE_NIGHTS" &&
                        promo.lifetimeFreeNightsCap === null &&
                        promo.freeNightsPerIndividual !== null && (
                          <p>
                            {promo.freeNightsUsed} free nights used · {promo.freeNightsPerIndividual} per booking
                          </p>
                        )}
                      {promo.maxUsesPerMember === 1 && <p>Single use per member</p>}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
