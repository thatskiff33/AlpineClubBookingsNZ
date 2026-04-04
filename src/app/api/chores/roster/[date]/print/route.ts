import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"

/**
 * GET /api/chores/roster/[date]/print
 * Returns roster data formatted for the print view
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  const session = await auth()
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 })
  }

  const { date: dateStr } = await params
  const date = new Date(dateStr + "T00:00:00")
  if (isNaN(date.getTime())) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 })
  }

  const assignments = await prisma.choreAssignment.findMany({
    where: { date },
    include: {
      choreTemplate: true,
      bookingGuest: true,
    },
    orderBy: { choreTemplate: { sortOrder: "asc" } },
  })

  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: ["CONFIRMED", "COMPLETED"] },
      checkIn: { lte: date },
      checkOut: { gt: date },
    },
    include: { guests: true },
  })

  const guestCount = bookings.reduce((sum, b) => sum + b.guests.length, 0)

  // Group by chore
  const byChore = new Map<string, {
    sortOrder: number
    name: string
    description: string | null
    guests: string[]
  }>()

  for (const a of assignments) {
    if (!byChore.has(a.choreTemplateId)) {
      byChore.set(a.choreTemplateId, {
        sortOrder: a.choreTemplate.sortOrder,
        name: a.choreTemplate.name,
        description: a.choreTemplate.description,
        guests: [],
      })
    }
    if (a.bookingGuest) {
      byChore.get(a.choreTemplateId)!.guests.push(
        `${a.bookingGuest.firstName} ${a.bookingGuest.lastName}`
      )
    }
  }

  const chores = [...byChore.values()].sort((a, b) => a.sortOrder - b.sortOrder)

  return NextResponse.json({
    date: dateStr,
    guestCount,
    chores,
  })
}
