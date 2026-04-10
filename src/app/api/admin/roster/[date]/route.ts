import { NextRequest, NextResponse } from "next/server"
import type { Prisma } from "@prisma/client"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { allocateChores, ChoreTemplateInput, GuestInput, ChoreHistoryEntry } from "@/lib/chore-allocator"
import { getBookingGuestDisplayAgeTier } from "@/lib/booking-guests"
import { sendChoreRosterEmail } from "@/lib/email"
import { createGuestChoreToken } from "@/lib/guest-chore-token"
import { getEffectiveEmail } from "@/lib/member-utils"
import { addDaysDateOnly, formatDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date-only"
import { z } from "zod"
import logger from "@/lib/logger"

const rosterActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("reassign"),
    assignmentId: z.string().min(1),
    bookingGuestId: z.string().min(1),
  }),
  z.object({
    action: z.literal("add"),
    choreTemplateId: z.string().min(1),
    bookingGuestId: z.string().min(1),
    bookingId: z.string().min(1),
  }),
  z.object({
    action: z.literal("remove"),
    assignmentId: z.string().min(1),
  }),
  z.object({
    action: z.literal("regenerate"),
    includeNonEssential: z.boolean().optional(),
    overwriteConfirmed: z.boolean().optional(),
  }),
  z.object({ action: z.literal("confirm") }),
  z.object({ action: z.literal("email") }),
])

async function getGuestsForDate(date: Date): Promise<GuestInput[]> {
  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: ["CONFIRMED", "PAID", "COMPLETED"] },
      checkIn: { lte: date },
      checkOut: { gt: date },
    },
    include: {
      guests: {
        include: {
          member: {
            select: { ageTier: true },
          },
        },
      },
    },
  })

  const nextDay = addDaysDateOnly(date, 1)

  return bookings.flatMap((b) =>
    b.guests.map((g) => ({
      id: g.id,
      bookingId: b.id,
      firstName: g.firstName,
      lastName: g.lastName,
      ageTier: getBookingGuestDisplayAgeTier(g),
      isArriving: b.checkIn.getTime() === date.getTime(),
      isDeparting: b.checkOut.getTime() === nextDay.getTime(),
    }))
  )
}

async function buildSuggestedAllocations(
  tx: Prisma.TransactionClient,
  date: Date,
  guests: GuestInput[],
  includeNonEssential: boolean | undefined
) {
  const choreTemplates = await tx.choreTemplate.findMany({
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
    timeOfDay: t.timeOfDay,
    frequencyMode: t.frequencyMode,
    frequencyDays: t.frequencyDays,
    frequencyDaysOfWeek: t.frequencyDaysOfWeek,
  }))

  const lookbackDate = addDaysDateOnly(date, -4)

  const historyRecords = await tx.choreAssignment.findMany({
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

  const lastRosteredRecords = await tx.choreAssignment.groupBy({
    by: ["choreTemplateId"],
    where: { date: { lt: date } },
    _max: { date: true },
  })
  const choreLastRosteredDates = new Map<string, Date>()
  for (const rec of lastRosteredRecords) {
    if (rec._max.date) {
      choreLastRosteredDates.set(rec.choreTemplateId, rec._max.date)
    }
  }

  const options: {
    includeNonEssential?: boolean
    choreLastRosteredDates?: Map<string, Date>
    currentDate?: Date
  } = { choreLastRosteredDates, currentDate: date }

  if (includeNonEssential !== undefined) {
    options.includeNonEssential = includeNonEssential
  }

  return allocateChores(templateInputs, guests, history, options)
}

async function lockRosterDate(tx: Prisma.TransactionClient, date: Date) {
  const lockKey = `roster:${formatDateOnly(date)}`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`
}

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
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 })
  }

  const { date: dateStr } = await params
  if (!isDateOnlyString(dateStr)) {
    return NextResponse.json({ error: "Invalid date format" }, { status: 400 })
  }
  const date = parseDateOnly(dateStr)
  if (isNaN(date.getTime())) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 })
  }

  const searchParams = req.nextUrl.searchParams
  const regenerate = searchParams.get("regenerate") === "true"
  const includeNonEssentialParam = searchParams.get("includeNonEssential")

  const guests = await getGuestsForDate(date)

  // Wrap check + create in a transaction to prevent concurrent duplicate assignments
  const existing = await prisma.$transaction(async (tx) => {
    await lockRosterDate(tx, date)

    let current = await tx.choreAssignment.findMany({
      where: { date },
      include: {
        choreTemplate: true,
        bookingGuest: {
          include: {
            member: {
              select: { ageTier: true },
            },
          },
        },
      },
    })

    // If regenerating, delete SUGGESTED assignments (keep CONFIRMED/COMPLETED)
    if (regenerate) {
      await tx.choreAssignment.deleteMany({
        where: { date, status: "SUGGESTED" },
      })
      current = current.filter((a) => a.status !== "SUGGESTED")
    }

    // If no assignments or only non-SUGGESTED remain after regeneration, auto-suggest
    const hasSuggested = current.some((a) => a.status === "SUGGESTED")
    const hasConfirmed = current.some((a) => a.status === "CONFIRMED" || a.status === "COMPLETED")

    if (!hasSuggested && !hasConfirmed) {
      const allocations = await buildSuggestedAllocations(
        tx,
        date,
        guests,
        includeNonEssentialParam !== null ? includeNonEssentialParam === "true" : undefined
      )

      // Save allocations
      if (allocations.length > 0) {
        await tx.choreAssignment.createMany({
          data: allocations.map((a) => ({
            choreTemplateId: a.choreTemplateId,
            bookingId: a.bookingId,
            bookingGuestId: a.bookingGuestId,
            date,
            status: "SUGGESTED",
          })),
        })
      }
    }

    // Re-fetch after potential creation
    return tx.choreAssignment.findMany({
      where: { date },
      include: {
        choreTemplate: true,
        bookingGuest: {
          include: {
            member: {
              select: { ageTier: true },
            },
          },
        },
      },
    })
  })

  // Get all active chore templates for the UI
  const allTemplates = await prisma.choreTemplate.findMany({
    where: { active: true },
    orderBy: { sortOrder: "asc" },
  })

  // Get 4-day history for each guest (for display)
  const lookbackDate = addDaysDateOnly(date, -4)

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
      date: formatDateOnly(h.date),
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
      guestAgeTier: a.bookingGuest ? getBookingGuestDisplayAgeTier(a.bookingGuest) : null,
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
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 })
  }

  const { date: dateStr } = await params
  if (!isDateOnlyString(dateStr)) {
    return NextResponse.json({ error: "Invalid date format" }, { status: 400 })
  }
  const date = parseDateOnly(dateStr)
  if (isNaN(date.getTime())) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const parsed = rosterActionSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const data = parsed.data

  try {
  switch (data.action) {
    case "reassign": {
      await prisma.choreAssignment.update({
        where: { id: data.assignmentId },
        data: { bookingGuestId: data.bookingGuestId },
      })
      break
    }
    case "add": {
      await prisma.choreAssignment.create({
        data: {
          choreTemplateId: data.choreTemplateId,
          bookingId: data.bookingId,
          bookingGuestId: data.bookingGuestId,
          date,
          status: "SUGGESTED",
        },
      })
      break
    }
    case "remove": {
      await prisma.choreAssignment.delete({ where: { id: data.assignmentId } })
      break
    }
    case "regenerate": {
      const regenerateResult = await prisma.$transaction(async (tx) => {
        await lockRosterDate(tx, date)

        const currentAssignments = await tx.choreAssignment.findMany({
          where: { date },
          select: { status: true },
        })

        const hasConfirmed = currentAssignments.some(
          (assignment) =>
            assignment.status === "CONFIRMED" || assignment.status === "COMPLETED"
        )

        if (hasConfirmed && !data.overwriteConfirmed) {
          return { conflict: true as const }
        }

        const guests = await getGuestsForDate(date)
        const deleteWhere = hasConfirmed
          ? { date }
          : { date, status: "SUGGESTED" as const }

        await tx.choreAssignment.deleteMany({ where: deleteWhere })

        const allocations = await buildSuggestedAllocations(
          tx,
          date,
          guests,
          data.includeNonEssential
        )

        if (allocations.length > 0) {
          await tx.choreAssignment.createMany({
            data: allocations.map((allocation) => ({
              choreTemplateId: allocation.choreTemplateId,
              bookingId: allocation.bookingId,
              bookingGuestId: allocation.bookingGuestId,
              date,
              status: "SUGGESTED",
            })),
          })
        }

        return { conflict: false as const }
      })

      if (regenerateResult.conflict) {
        return NextResponse.json(
          {
            error:
              "Roster already confirmed. Confirm overwrite to regenerate it.",
          },
          { status: 409 }
        )
      }
      break
    }
    case "confirm": {
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
              member: {
                select: {
                  email: true,
                  inheritEmailFromId: true,
                  inheritEmailFrom: { select: { email: true } },
                },
              },
            },
          },
        },
      })

      // Group assignments by guest, resolving effective email for dependents
      const byGuest = new Map<string, {
        email: string | null
        name: string
        chores: Array<{ name: string; description: string | null }>
      }>()

      for (const a of assignments) {
        if (!a.bookingGuest) continue
        const guestId = a.bookingGuest.id
        if (!byGuest.has(guestId)) {
          const effectiveEmail = a.bookingGuest.member
            ? await getEffectiveEmail(a.bookingGuest.member)
            : null
          byGuest.set(guestId, {
            email: effectiveEmail,
            name: `${a.bookingGuest.firstName} ${a.bookingGuest.lastName}`,
            chores: [],
          })
        }
        byGuest.get(guestId)!.chores.push({
          name: a.choreTemplate.name,
          description: a.choreTemplate.description,
        })
      }

      // Generate per-guest chore tokens and send emails
      const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000"
      const emailPromises: Promise<{
        guestId: string
        name: string
        email: string
      }>[] = []
      for (const [guestId, guest] of byGuest) {
        if (guest.email) {
          const recipientEmail = guest.email
          emailPromises.push(
            (async () => {
              // Delete old tokens for this guest+date to prevent duplicates
              await prisma.guestChoreToken.deleteMany({
                where: { bookingGuestId: guestId, date },
              })
              const token = await createGuestChoreToken(guestId, date)
              const choreLink = `${baseUrl}/chores/${token}`
              await sendChoreRosterEmail(
                recipientEmail,
                guest.name,
                dateStr,
                guest.chores,
                choreLink
              )
              return {
                guestId,
                name: guest.name,
                email: recipientEmail,
              }
            })()
          )
        }
      }

      const results = await Promise.allSettled(emailPromises)
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => ({
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        }))

      return NextResponse.json({
        success: true,
        partialFailure: failures.length > 0,
        sent: results.filter((result) => result.status === "fulfilled").length,
        failed: failures.length,
        failures,
      })
    }
  }
  } catch (err) {
    logger.error({ err }, "Error processing roster action")
    return NextResponse.json({ error: "Failed to process roster action" }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
