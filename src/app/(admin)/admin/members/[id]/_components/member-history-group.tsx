"use client"

import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AuditTimeline } from "@/components/audit-timeline"
import { XeroRecordActivityPanel } from "@/components/admin/xero-record-activity-panel"
import { bookingStatusClass, bookingStatusLabel } from "@/lib/status-colors"
import { formatCents } from "@/lib/utils"
// `checkIn` and `checkOut` are `@db.Date` LODGE NIGHTS — calendar days with no
// timezone. The formatter they used to go through projected them into the
// environment's zone, which for a club behind UTC names the night before the
// member actually arrived. `INV-DATE-019`.
import { formatPayloadCalendarDay } from "../../../_lib/calendar-day"
import type { MemberDetail } from "../_types"

function BookingHistoryTable({
  bookings,
}: {
  bookings: MemberDetail["bookings"]
}) {
  if (bookings.length === 0) {
    return <p className="text-sm text-muted-foreground">No bookings yet</p>
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Check In</TableHead>
          <TableHead>Check Out</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Guests</TableHead>
          <TableHead>Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {bookings.map((booking) => (
          <TableRow key={booking.id}>
            <TableCell>{formatPayloadCalendarDay(booking.checkIn)}</TableCell>
            <TableCell>{formatPayloadCalendarDay(booking.checkOut)}</TableCell>
            <TableCell>
              <Badge
                variant="secondary"
                className={bookingStatusClass(booking.status)}
              >
                {bookingStatusLabel(booking.status)}
              </Badge>
            </TableCell>
            <TableCell>{booking._count.guests}</TableCell>
            <TableCell>{formatCents(booking.finalPriceCents)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function MemberHistoryGroup({
  memberId,
  bookings,
}: {
  memberId: string
  bookings: MemberDetail["bookings"]
}) {
  return (
    <Tabs defaultValue="bookings">
      <TabsList>
        <TabsTrigger value="bookings">Bookings</TabsTrigger>
        <TabsTrigger value="xero-activity">Xero Activity</TabsTrigger>
        <TabsTrigger value="audit-log">Audit Log</TabsTrigger>
      </TabsList>
      <TabsContent value="bookings" className="pt-2">
        <BookingHistoryTable bookings={bookings} />
      </TabsContent>
      <TabsContent value="xero-activity" className="pt-2">
        <XeroRecordActivityPanel
          localModel="Member"
          localId={memberId}
          compact
          className="border-0 shadow-none"
        />
      </TabsContent>
      <TabsContent value="audit-log" className="pt-2">
        <AuditTimeline
          endpoint={`/api/admin/members/${memberId}/audit-log`}
          showMetadata
          showAdminEntityLinks
        />
      </TabsContent>
    </Tabs>
  )
}
