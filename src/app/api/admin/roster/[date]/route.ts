import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { allocateChores, ChoreTemplateInput, GuestInput, ChoreHistoryEntry } from "@/lib/chore-allocator"
import { sendChoreRosterEmail } from "@/lib/email"

/**
 * GET /api/admin/roster/[date]
 * Returns the roster for a given date. If no assignments exist, auto-suggests.
 *
 * Query params:
 *   ?includeNonEssential=true/false  (override occupancy-based selection)
 *   ?regenerate=true                 (force re-suggest, deletes existing SUGGESTED)
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  const session = await auth()
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { date: dateStr } = await params
  const date = new Date(dateStr + "T00:00:00")
  if (isNaN(date.getTime())) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 })
  }

  const searchParams = req.nextUrl.searchParams
  const regenerate = searchParams.get("regenerate") === "true"
  const includeNonEssentialParam = searchParams.get("includeNonEssential")

  // Get all confirmed guests staying on this date
  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: ["CONFIRMED", "COMPLETED"] },
      checkIn: { lte: date },
      checkOut: { gt: date },
    },
    include: {
      guests: true,
    },
  })

  const guests: GuestInput[] = bookings.flatMap((b) =>
    b.guests.map((g) => ({
      id: g.id,
      bookingId: b.id,
      firstName: g.firstName,
      lastName: g.lastName,
      ageTier: g.ageTier,
    }))
  )

  // Check for existing assignments
  let existing = await prisma.choreAssignment.findMany({
    where: { date },
    include: {
      choreTemplate: true,
      bookingGuest: true,
    },
  })

  // If regenerating, delete SUGGESTED assignments (keep CONFIRMED/COMPLETED)
  if (regenerate) {
    await prisma.choreAssignment.deleteMany({
      where: { date, status: "SUGGESTED" },
    })
    existing = existing.filter((a) => a.status !== "SUGGESTED")
  }

  // If no assignments or only non-SUGGESTED remain after regeneration, auto-suggest
  const hasSuggested = existing.some((a) => a.status === "SUGGESTED")
  const hasConfirmed = existing.some((a) => a.status === "CONFIRMED" || a.status === "COMPLETED")

  if (!hasSuggested && !hasConfirmed) {
    // Auto-suggest
    const choreTemplates = await prisma.choreTemplate.findMany({
      where: { active: true },
      orderBy: { sortOrder: "asc" },
    })

    const templateInputs: ChoreTemplateInput[] = choreTemplates.map((t) => ({
      id: t.id,
      name: t.name,
      recommendedPeopleMin: t.recommendedPeopleMin,
      recommendedPeopleMax: t.recommendedPeopleMax,
      isEssential: t.isEssential,
      ageRestriction: t.ageRestriction,
      minAge: t.minAge,
      sortOrder: t.sortOrder,
    }))

    // 4-day lookback for chore history
    const lookbackDate = new Date(date)
    lookbackDate.setDate(lookbackDate.getDate() - 4)

    const historyRecords = await prisma.choreAssignment.findMany({
      where: {
        date: { gte: lookbackDate, lt: date },
        bookingGuestId: { in: guests.map((g) => g.id) },
      },
    })

    const history: ChoreHistoryEntry[] = historyRecords
      .filter((h) => h.bookingGuestId !== null)
      .map((h) => ({
        guestId: h.bookingGuestId!,
        choreTemplateId: h.choreTemplateId,
        date: h.date,
      }))

    const options: { includeNonEssential?: boolean } = {}
    if (includeNonEssentialParam !== null) {
      options.includeNonEssential = includeNonEssentialParam === "true"
    }

    const allocations = allocateChores(templateInputs, guests, history, options)

    // Save allocations
    if (allocations.length > 0) {
      await prisma.choreAssignment.createMany({
        data: allocations.map((a) => ({
          choreTemplateId: a.choreTemplateId,
          bookingId: a.bookingId,
          bookingGuestId: a.bookingGuestId,
          date,
          status: "SUGGESTED",
        })),
      })
    }

    // Re-fetch
    existing = await prisma.choreAssignment.findMany({
      where: { date },
      include: {
        choreTemplate: true,
        bookingGuest: true,
      },
    })
  }

  // Get all active chore templates for the UI
  const allTemplates = await prisma.choreTemplate.findMany({
    where: { active: true },
    orderBy: { sortOrder: "asc" },
  })

  // Get 4-day history for each guest (for display)
  const lookbackDate = new Date(date)
  lookbackDate.setDate(lookbackDate.getDate() - 4)

  const guestHistory = await prisma.choreAssignment.findMany({
    where: {
      date: { gte: lookbackDate, lt: date },
      bookingGuestId: { in: guests.map((g) => g.id) },
    },
    include: { choreTemplate: true },
    orderBy: { date: "desc" },
  })

  // Group history by guest
  const historyByGuest: Record<string, Array<{ date: string; choreName: string }>> = {}
  for (const h of guestHistory) {
    if (!h.bookingGuestId) continue
    if (!historyByGuest[h.bookingGuestId]) {
      historyByGuest[h.bookingGuestId] = []
    }
    historyByGuest[h.bookingGuestId].push({
      date: h.date.toISOString().split("T")[0],
      choreName: h.choreTemplate.name,
    })
  }

  return NextResponse.json({
    date: dateStr,
    guests,
    assignments: existing.map((a) => ({
      id: a.id,
      choreTemplateId: a.choreTemplateId,
      choreTemplateName: a.choreTemplate.name,
      choreDescription: a.choreTemplate.description,
      choreSortOrder: a.choreTemplate.sortOrder,
      bookingGuestId: a.bookingGuestId,
      guestName: a.bookingGuest
        ? `${a.bookingGuest.firstName} ${a.bookingGuest.lastName}`
        : null,
      guestAgeTier: a.bookingGuest?.ageTier ?? null,
      bookingId: a.bookingId,
      status: a.status,
    })),
    templates: allTemplates,
    guestHistory: historyByGuest,
    guestCount: guests.length,
  })
}

/**
 * PUT /api/admin/roster/[date]
 * Update assignments for a date (reassign guests, add/remove assignments)
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  const session = await auth()
  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { date: dateStr } = await params
  const date = new Date(dateStr + "T00:00:00")
  if (isNaN(date.getTime())) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 })
  }

  const body = await req.json()
  const { action, assignmentId, bookingGuestId, choreTemplateId, bookingId } = body

  switch (action) {
    case "reassign": {
      // Reassign a specific assignment to a different guest
      if (!assignmentId || !bookingGuestId) {
        return NextResponse.json({ error: "assignmentId and bookingGuestId required" }, { status: 400 })
      }
      await prisma.choreAssignment.update({
        where: { id: assignmentId },
        data: { bookingGuestId },
      })
      break
    }
    case "add": {
      // Add a new assignment
      if (!choreTemplateId || !bookingGuestId || !bookingId) {
        return NextResponse.json({ error: "choreTemplateId, bookingGuestId, and bookingId required" }, { status: 400 })
      }
      await prisma.choreAssignment.create({
        data: {
          choreTemplateId,
          bookingId,
          bookingGuestId,
          date,
          status: "SUGGESTED",
        },
      })
      break
    }
    case "remove": {
      // Remove an assignment
      if (!assignmentId) {
        return NextResponse.json({ error: "assignmentId required" }, { status: 400 })
      }
      await prisma.choreAssignment.delete({ where: { id: assignmentId } })
      break
    }
    case "confirm": {
      // Confirm all SUGGESTED assignments for this date
      await prisma.choreAssignment.updateMany({
        where: { date, status: "SUGGESTED" },
        data: { status: "CONFIRMED" },
      })
      break
    }
    case "email": {
      // Send roster email to all guests for this date
      const assignments = await prisma.choreAssignment.findMany({
        where: { date },
        include: {
          choreTemplate: true,
          bookingGuest: {
            include: {
              member: true,
            },
          },
        },
      })

      // Group assignments by guest
      const byGuest = new Map<string, {
        email: string | null
        name: string
        chores: Array<{ name: string; description: string | null }>
      }>()

      for (const a of assignments) {
        if (!a.bookingGuest) continue
        const guestId = a.bookingGuest.id
        if (!byGuest.has(guestId)) {
          byGuest.set(guestId, {
            email: a.bookingGuest.member?.email ?? null,
            name: `${a.bookingGuest.firstName} ${a.bookingGuest.lastName}`,
            chores: [],
          })
        }
        byGuest.get(guestId)!.chores.push({
          name: a.choreTemplate.name,
          description: a.choreTemplate.description,
        })
      }

      // Send emails to guests who have an email (members)
      const emailPromises: Promise<void>[] = []
      for (const [, guest] of byGuest) {
        if (guest.email) {
          emailPromises.push(
            sendChoreRosterEmail(
              guest.email,
              guest.name,
              dateStr,
              guest.chores
            )
          )
        }
      }
      await Promise.all(emailPromises)
      break
    }
    default:
      return NextResponse.json({ error: "Invalid action" }, { status: 400 })
  }

  return NextResponse.json({ success: true })
}
