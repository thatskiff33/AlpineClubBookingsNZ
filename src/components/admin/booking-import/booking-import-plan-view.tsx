"use client"

import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useClubFormat } from "@/components/club-format-provider"
import { BOOKING_IMPORT_REFUSAL_LABELS } from "@/lib/booking-import/labels"
import { formatStayDate } from "@/lib/club-time"
import type { BookingImportPlan, BookingImportRefusalCode, BookingImportTotals } from "@/lib/booking-import/plan"
import { formatCents } from "@/lib/utils"

/** Bookings, guests, guest-nights and dollars, side by side. */
export function BookingImportTotalsList({ label, totals }: { label: string; totals: BookingImportTotals }) {
  const format = useClubFormat()
  return (
    <div className="rounded-md border p-3">
      <p className="text-sm font-medium">{label}</p>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">Bookings</dt>
          <dd className="font-medium">{totals.bookings}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Guests</dt>
          <dd className="font-medium">{totals.guests}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Guest-nights</dt>
          <dd className="font-medium">{totals.guestNights}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Amount paid</dt>
          <dd className="font-medium">{formatCents(totals.amountCents, format)}</dd>
        </div>
      </dl>
    </div>
  )
}

function sumTotals(a: BookingImportTotals, b: BookingImportTotals): BookingImportTotals {
  return {
    bookings: a.bookings + b.bookings,
    guests: a.guests + b.guests,
    guestNights: a.guestNights + b.guestNights,
    amountCents: a.amountCents + b.amountCents,
  }
}

/**
 * The import preview (#5005, child C): totals to check against the old
 * system's report (imported plus refused equals the file), refused bookings
 * by reason, beds per night beside the lodge's capacity, and every booking
 * with its outcome, reasons and the app-rate typing check.
 */
export function BookingImportPlanView({ plan }: { plan: BookingImportPlan }) {
  const format = useClubFormat()
  const refusedCodes = Object.entries(plan.refusedByCode) as [BookingImportRefusalCode, BookingImportTotals][]
  return (
    <div className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-3">
        <BookingImportTotalsList label="Will import" totals={plan.importTotals} />
        <BookingImportTotalsList label="Refused" totals={plan.refusedTotals} />
        <BookingImportTotalsList label="Whole file" totals={sumTotals(plan.importTotals, plan.refusedTotals)} />
      </div>

      {refusedCodes.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Refused, by first reason</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Reason</TableHead>
                <TableHead className="text-right">Bookings</TableHead>
                <TableHead className="text-right">Guests</TableHead>
                <TableHead className="text-right">Guest-nights</TableHead>
                <TableHead className="text-right">Amount paid</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {refusedCodes.map(([code, totals]) => (
                <TableRow key={code}>
                  <TableCell>{BOOKING_IMPORT_REFUSAL_LABELS[code]}</TableCell>
                  <TableCell className="text-right">{totals.bookings}</TableCell>
                  <TableCell className="text-right">{totals.guests}</TableCell>
                  <TableCell className="text-right">{totals.guestNights}</TableCell>
                  <TableCell className="text-right">{formatCents(totals.amountCents, format)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      ) : null}

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Beds per night</h3>
        <p className="text-xs text-muted-foreground">
          Refused beds were sold in the old system but are not held here until the booking is entered by hand.
        </p>
        <div className="max-h-64 overflow-auto rounded-md border">
          <Table>
            <TableHeader className="sticky top-0 bg-muted">
              <TableRow>
                <TableHead>Night</TableHead>
                <TableHead className="text-right">Capacity</TableHead>
                <TableHead className="text-right">Already held</TableHead>
                <TableHead className="text-right">Importing</TableHead>
                <TableHead className="text-right">After import</TableHead>
                <TableHead className="text-right">Refused</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plan.nights.map((night) => (
                <TableRow key={night.night}>
                  <TableCell>
                    {formatStayDate(night.night, format)}
                    {night.wholeLodgeHeld ? <Badge variant="secondary" className="ml-2">Held exclusively</Badge> : null}
                  </TableCell>
                  <TableCell className="text-right">{night.capacity}</TableCell>
                  <TableCell className="text-right">{night.heldBeds}</TableCell>
                  <TableCell className="text-right">{night.importBeds}</TableCell>
                  <TableCell className="text-right">{night.projectedBeds}</TableCell>
                  <TableCell className="text-right">{night.refusedBeds}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {plan.overFullNights.length > 0 ? (
          <ul className="space-y-1 text-sm">
            {plan.overFullNights.map((night) => (
              <li key={night.night}>
                <span className="font-medium">{formatStayDate(night.night, format)}</span> is full: {night.fitted.join(", ") || "no booking"} fit;{" "}
                {night.refused.join(", ")} {night.refused.length === 1 ? "does" : "do"} not.
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Bookings</h3>
        <div className="max-h-96 overflow-auto rounded-md border">
          <Table>
            <TableHeader className="sticky top-0 bg-muted">
              <TableRow>
                <TableHead>Line</TableHead>
                <TableHead>Booking Ref</TableHead>
                <TableHead>Stay</TableHead>
                <TableHead className="text-right">Guests</TableHead>
                <TableHead className="text-right">Amount paid</TableHead>
                <TableHead className="text-right">At the app&apos;s rates</TableHead>
                <TableHead>Outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plan.rows.map((row) => (
                <TableRow key={row.bookingRef} className="align-top">
                  <TableCell>{row.firstLineNumber}</TableCell>
                  <TableCell className="font-medium">{row.bookingRef}</TableCell>
                  <TableCell>
                    {formatStayDate(row.checkIn, format)} to {formatStayDate(row.checkOut, format)}
                  </TableCell>
                  <TableCell className="text-right">{row.guestCount}</TableCell>
                  <TableCell className="text-right">{formatCents(row.amountCents, format)}</TableCell>
                  <TableCell className="text-right">
                    {row.appRateCents === null ? (
                      "—"
                    ) : (
                      <>
                        {formatCents(row.appRateCents, format)}
                        {row.appRateDifferenceCents ? (
                          <span className="block text-xs text-muted-foreground">
                            paid {formatCents(Math.abs(row.appRateDifferenceCents), format)}{" "}
                            {row.appRateDifferenceCents > 0 ? "more" : "less"}
                          </span>
                        ) : null}
                      </>
                    )}
                  </TableCell>
                  <TableCell>
                    {row.outcome === "IMPORT" ? (
                      <Badge variant="outline">{row.alreadyImported ? "Imported" : "Will import"}</Badge>
                    ) : (
                      <Badge variant="destructive">Refused</Badge>
                    )}
                    {row.refusals.map((refusal) => (
                      <span key={refusal.message} className="mt-1 block text-xs text-destructive">
                        {refusal.message}
                      </span>
                    ))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  )
}
