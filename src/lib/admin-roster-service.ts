import type { Prisma } from "@prisma/client"
import { createHash } from "node:crypto"
import { prisma } from "@/lib/prisma"
import { compareOrdinal } from "@/lib/stable-digest"
import {
  allocateChores,
  filterChoresByFrequency,
  ChoreTemplateInput,
  GuestInput,
  ChoreHistoryEntry,
} from "@/lib/chore-allocator"
import { getLodgeCapacity, FALLBACK_LODGE_CAPACITY } from "@/lib/lodge-capacity"
import { getBookingGuestDisplayAgeTier } from "@/lib/booking-guests"
import { sendChoreRosterEmail, shouldSendChoreRoster } from "@/lib/email"
import { createGuestChoreToken } from "@/lib/guest-chore-token"
import { getEffectiveEmail } from "@/lib/member-utils"
import { addDaysDateOnly, formatDateOnly } from "@/lib/date-only"
import { lodgeNullTolerantScope } from "@/lib/lodges"
import {
  getOperationalRosterGuestsForDate,
  type OperationalRosterGuest,
} from "@/lib/roster-eligibility"
import { lockRosterEligibilityMutation } from "@/lib/roster-lock"
import { z } from "zod"
import logger from "@/lib/logger"
import { logAudit } from "@/lib/audit"

type JsonRouteResult = {
  body: unknown
  init?: ResponseInit
}

function jsonResult(body: unknown, init?: ResponseInit): JsonRouteResult {
  return { body, init }
}

export const rosterActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save"),
    baseRevision: z.string().min(1),
    acknowledgeCompletedReset: z.boolean(),
    assignments: z.array(z.object({
      rowKey: z.string().min(1),
      assignmentId: z.string().min(1).optional(),
      choreTemplateId: z.string().min(1),
      bookingGuestId: z.string().min(1),
    })),
  }),
  z.object({
    action: z.literal("regenerate"),
    includeNonEssential: z.boolean().optional(),
    overwriteConfirmed: z.boolean().optional(),
  }),
  z.object({ action: z.literal("confirm") }),
  z.object({ action: z.literal("email"), notifyMember: z.boolean().optional() }),
])

export type RosterActionInput = z.infer<typeof rosterActionSchema>

export const ROSTER_ERROR_COPY = {
  stale: "This roster changed while you were editing. Your changes were not saved. Reload the latest roster and try again.",
  ineligibleGuest: "Roster not saved. This person is no longer eligible for this lodge night. Choose another person or reload the roster.",
} as const

function rosterError(code: string, error: string, status: number, details?: unknown) {
  return jsonResult({ error, code, ...(details === undefined ? {} : { details }) }, { status })
}

function assignmentScope(date: Date, lodgeId: string) {
  return {
    date,
    booking: lodgeNullTolerantScope(lodgeId),
    choreTemplate: lodgeNullTolerantScope(lodgeId),
  }
}

type RevisionAssignment = {
  id: string
  choreTemplateId: string
  bookingId: string
  bookingGuestId: string | null
  status: string
  completedAt?: Date | null
  completedVia?: string | null
  updatedAt?: Date
}

export function createRosterRevision(assignments: RevisionAssignment[]) {
  const canonical = assignments
    .map((assignment) => ({
      id: assignment.id,
      choreTemplateId: assignment.choreTemplateId,
      bookingId: assignment.bookingId,
      bookingGuestId: assignment.bookingGuestId,
      status: assignment.status,
      completedAt: assignment.completedAt?.toISOString() ?? null,
      completedVia: assignment.completedVia ?? null,
      updatedAt: assignment.updatedAt?.toISOString() ?? null,
    }))
    // Ordinal (#3252): this order decides the bytes of the roster revision
    // token, which a later save re-derives and compares as a CAS check.
    .sort((a, b) => compareOrdinal(a.id, b.id))
  return createHash("sha256").update(JSON.stringify(canonical)).digest("base64url")
}

type RosterGuest = OperationalRosterGuest

/**
 * Who may be given a chore on this roster date.
 *
 * #2622 moved the query itself into `@/lib/roster-eligibility` so the kiosk
 * generate route reads the identical rule instead of keeping its own copy, and
 * swapped the night model for the operational day: a guest who checks out today
 * slept here last night and belongs on this morning's roster. Everything the
 * choke point guarded travelled with it unchanged — the D-12 consent predicate
 * on both the booking match and the guest include, the pending-review filter,
 * the operational booking statuses, lodge scoping and the explicit night rows.
 */
async function getGuestsForDate(
  date: Date,
  lodgeId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<RosterGuest[]> {
  return getOperationalRosterGuestsForDate(date, lodgeId, db)
}

async function buildSuggestedAllocations(
  tx: Prisma.TransactionClient,
  date: Date,
  guests: GuestInput[],
  includeNonEssential: boolean | undefined,
  lodgeId: string
) {
  const choreTemplates = await tx.choreTemplate.findMany({
    where: { active: true, ...lodgeNullTolerantScope(lodgeId) },
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
      booking: lodgeNullTolerantScope(lodgeId),
      choreTemplate: lodgeNullTolerantScope(lodgeId),
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
    where: {
      date: { lt: date },
      booking: lodgeNullTolerantScope(lodgeId),
      choreTemplate: lodgeNullTolerantScope(lodgeId),
    },
    _max: { date: true },
  })
  const choreLastRosteredDates = new Map<string, Date>()
  for (const rec of lastRosteredRecords) {
    if (rec._max.date) {
      choreLastRosteredDates.set(rec.choreTemplateId, rec._max.date)
    }
  }

  // #2021 (#1982/#2013 residual): scale per-chore people-counts by this lodge's
  // real resolved sleeping capacity (lodge-scoped), not the fixed display
  // constant. Resolved within the roster transaction so it sees the same client;
  // if the capacity read fails or resolves to a non-positive value, keep the
  // constant fallback (allocateChores' own default) so housekeeping never breaks.
  let capacity = FALLBACK_LODGE_CAPACITY
  try {
    const resolved = await getLodgeCapacity(
      lodgeId,
      tx as unknown as Parameters<typeof getLodgeCapacity>[1],
    )
    if (resolved > 0) capacity = resolved
  } catch (err) {
    logger.warn(
      { err, lodgeId },
      "Falling back to default lodge capacity for chore people-count scaling",
    )
  }

  const options: {
    includeNonEssential?: boolean
    choreLastRosteredDates?: Map<string, Date>
    currentDate?: Date
    capacity?: number
  } = { choreLastRosteredDates, currentDate: date, capacity }

  if (includeNonEssential !== undefined) {
    options.includeNonEssential = includeNonEssential
  }

  return allocateChores(templateInputs, guests, history, options)
}

async function loadRosterSnapshot(
  tx: Prisma.TransactionClient,
  date: Date,
  dateStr: string,
  lodgeId: string,
  knownGuests?: RosterGuest[],
) {
  const guests = knownGuests ?? await getGuestsForDate(date, lodgeId, tx)
  const assignments = await tx.choreAssignment.findMany({
    where: assignmentScope(date, lodgeId),
    include: {
      choreTemplate: true,
      bookingGuest: { include: { member: { select: { ageTier: true } } } },
    },
    orderBy: [{ choreTemplate: { sortOrder: "asc" } }, { id: "asc" }],
  })
  const templates = await tx.choreTemplate.findMany({
    where: { active: true, ...lodgeNullTolerantScope(lodgeId) },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  })
  const lastRosteredRecords = await tx.choreAssignment.groupBy({
    by: ["choreTemplateId"],
    where: {
      date: { lt: date },
      booking: lodgeNullTolerantScope(lodgeId),
      choreTemplate: lodgeNullTolerantScope(lodgeId),
    },
    _max: { date: true },
  })
  const lastRosteredDates = new Map<string, Date>()
  for (const record of lastRosteredRecords) {
    if (record._max.date) lastRosteredDates.set(record.choreTemplateId, record._max.date)
  }
  const dueTemplateIds = new Set(
    filterChoresByFrequency(templates, lastRosteredDates, date).map((template) => template.id),
  )

  const lookbackDate = addDaysDateOnly(date, -4)
  const guestHistory = await tx.choreAssignment.findMany({
    where: {
      date: { gte: lookbackDate, lt: date },
      bookingGuestId: { in: guests.map((guest) => guest.id) },
      booking: lodgeNullTolerantScope(lodgeId),
      choreTemplate: lodgeNullTolerantScope(lodgeId),
    },
    include: { choreTemplate: true },
    orderBy: { date: "desc" },
  })
  const historyByGuest: Record<string, Array<{ date: string; choreName: string }>> = {}
  for (const history of guestHistory) {
    if (!history.bookingGuestId) continue
    ;(historyByGuest[history.bookingGuestId] ??= []).push({
      date: formatDateOnly(history.date),
      choreName: history.choreTemplate.name,
    })
  }

  return {
    date: dateStr,
    lodgeId,
    revision: createRosterRevision(assignments),
    guests,
    assignments: assignments.map((assignment) => ({
      id: assignment.id,
      choreTemplateId: assignment.choreTemplateId,
      choreTemplateName: assignment.choreTemplate.name,
      choreDescription: assignment.choreTemplate.description,
      choreSortOrder: assignment.choreTemplate.sortOrder,
      bookingGuestId: assignment.bookingGuestId,
      guestName: assignment.bookingGuest
        ? `${assignment.bookingGuest.firstName} ${assignment.bookingGuest.lastName}`
        : null,
      guestAgeTier: assignment.bookingGuest
        ? getBookingGuestDisplayAgeTier(assignment.bookingGuest)
        : null,
      bookingId: assignment.bookingId,
      status: assignment.status,
    })),
    templates: templates.map((template) => ({
      ...template,
      isDueOnDate: dueTemplateIds.has(template.id),
    })),
    guestHistory: historyByGuest,
    guestCount: guests.length,
  }
}

export async function getAdminRosterForDate(params: {
  date: Date
  dateString: string
  regenerate: boolean
  includeNonEssential?: boolean
  lodgeId: string
}): Promise<JsonRouteResult> {
  const { date, dateString: dateStr, regenerate, includeNonEssential, lodgeId } = params
  const snapshot = await prisma.$transaction(async (tx) => {
    // Even the ordinary GET writes when the partition is empty: it auto-builds
    // SUGGESTED rows. Take the eligibility tiers before discovering whether
    // this invocation is read-only, otherwise the empty-partition race remains.
    await lockRosterEligibilityMutation(tx, lodgeId, date)
    const guests = await getGuestsForDate(date, lodgeId, tx)
    let current = await tx.choreAssignment.findMany({
      where: assignmentScope(date, lodgeId),
      select: { status: true },
    })
    if (regenerate) {
      await tx.choreAssignment.deleteMany({
        where: { ...assignmentScope(date, lodgeId), status: "SUGGESTED" },
      })
      current = current.filter((assignment) => assignment.status !== "SUGGESTED")
    }
    const hasRoster = current.some((assignment) =>
      assignment.status === "SUGGESTED" ||
      assignment.status === "CONFIRMED" ||
      assignment.status === "COMPLETED"
    )
    if (!hasRoster) {
      const allocations = await buildSuggestedAllocations(
        tx,
        date,
        guests,
        includeNonEssential,
        lodgeId,
      )
      if (allocations.length > 0) {
        await tx.choreAssignment.createMany({
          data: allocations.map((allocation) => ({
            choreTemplateId: allocation.choreTemplateId,
            bookingId: allocation.bookingId,
            bookingGuestId: allocation.bookingGuestId,
            date,
            status: "SUGGESTED" as const,
          })),
        })
      }
    }
    return loadRosterSnapshot(tx, date, dateStr, lodgeId, guests)
  })
  return jsonResult(snapshot)
}

export async function updateAdminRosterForDate(params: {
  date: Date
  dateString: string
  data: RosterActionInput
  lodgeId: string
  adminMemberId?: string
}): Promise<JsonRouteResult> {
  const { date, dateString: dateStr, data, lodgeId, adminMemberId } = params
  try {
  switch (data.action) {
    case "save": {
      const duplicateRowKey = new Set(data.assignments.map((assignment) => assignment.rowKey)).size
        !== data.assignments.length
      const existingIds = data.assignments
        .map((assignment) => assignment.assignmentId)
        .filter((id): id is string => Boolean(id))
      const duplicateAssignmentId = new Set(existingIds).size !== existingIds.length
      if (duplicateRowKey || duplicateAssignmentId) {
        return rosterError(
          "ROSTER_SAVE_INVALID",
          "Roster not saved. Each assignment row must be unique. Review the roster and try again.",
          400,
        )
      }

      const saveResult = await prisma.$transaction(async (tx) => {
        await lockRosterEligibilityMutation(tx, lodgeId, date)
        const current = await tx.choreAssignment.findMany({
          where: assignmentScope(date, lodgeId),
          select: {
            id: true,
            choreTemplateId: true,
            bookingId: true,
            bookingGuestId: true,
            status: true,
            completedAt: true,
            completedVia: true,
            updatedAt: true,
          },
        })
        if (createRosterRevision(current) !== data.baseRevision) {
          return { error: rosterError("ROSTER_STALE", ROSTER_ERROR_COPY.stale, 409) }
        }
        if (
          current.some((assignment) => assignment.status === "COMPLETED") &&
          !data.acknowledgeCompletedReset
        ) {
          return {
            error: rosterError(
              "ROSTER_COMPLETED_ACK_REQUIRED",
              "Roster not saved. Completed chores will return to Suggested when this edit is saved. Acknowledge that reset before continuing.",
              409,
            ),
          }
        }

        const currentById = new Map(current.map((assignment) => [assignment.id, assignment]))
        for (const submitted of data.assignments) {
          if (!submitted.assignmentId) continue
          const existing = currentById.get(submitted.assignmentId)
          if (!existing || existing.choreTemplateId !== submitted.choreTemplateId) {
            return {
              error: rosterError(
                "ROSTER_ASSIGNMENT_INVALID",
                "Roster not saved. One or more assignment rows no longer belong to this lodge night. Reload the roster and try again.",
                400,
                { rowKey: submitted.rowKey },
              ),
            }
          }
        }

        const templateIds = [...new Set(data.assignments.map((assignment) => assignment.choreTemplateId))]
        const templates = templateIds.length === 0
          ? []
          : await tx.choreTemplate.findMany({
              where: {
                id: { in: templateIds },
                active: true,
                ...lodgeNullTolerantScope(lodgeId),
              },
              select: { id: true },
            })
        const validTemplateIds = new Set(templates.map((template) => template.id))
        const invalidTemplateRow = data.assignments.find(
          (assignment) => !validTemplateIds.has(assignment.choreTemplateId),
        )
        if (invalidTemplateRow) {
          return {
            error: rosterError(
              "ROSTER_TEMPLATE_INVALID",
              "Roster not saved. This chore is no longer active for this lodge. Reload the roster and review your changes.",
              400,
              { rowKey: invalidTemplateRow.rowKey },
            ),
          }
        }

        const eligibleGuests = await getGuestsForDate(date, lodgeId, tx)
        const eligibleById = new Map(eligibleGuests.map((guest) => [guest.id, guest]))
        const invalidGuestRow = data.assignments.find(
          (assignment) => !eligibleById.has(assignment.bookingGuestId),
        )
        if (invalidGuestRow) {
          return {
            error: rosterError(
              "ROSTER_GUEST_INELIGIBLE",
              ROSTER_ERROR_COPY.ineligibleGuest,
              400,
              { rowKey: invalidGuestRow.rowKey },
            ),
          }
        }

        const retainedIds = new Set(existingIds)
        const removedIds = current
          .filter((assignment) => !retainedIds.has(assignment.id))
          .map((assignment) => assignment.id)
        if (removedIds.length > 0) {
          await tx.choreAssignment.deleteMany({
            where: { id: { in: removedIds }, ...assignmentScope(date, lodgeId) },
          })
        }
        for (const submitted of data.assignments) {
          const guest = eligibleById.get(submitted.bookingGuestId)!
          if (submitted.assignmentId) {
            await tx.choreAssignment.updateMany({
              where: {
                id: submitted.assignmentId,
                ...assignmentScope(date, lodgeId),
              },
              data: {
                choreTemplateId: submitted.choreTemplateId,
                bookingGuestId: submitted.bookingGuestId,
                bookingId: guest.bookingId,
                status: "SUGGESTED",
                completedAt: null,
                completedVia: null,
              },
            })
          } else {
            await tx.choreAssignment.create({
              data: {
                choreTemplateId: submitted.choreTemplateId,
                bookingGuestId: submitted.bookingGuestId,
                bookingId: guest.bookingId,
                date,
                status: "SUGGESTED",
              },
            })
          }
        }
        return {
          snapshot: await loadRosterSnapshot(tx, date, dateStr, lodgeId, eligibleGuests),
        }
      })
      if (saveResult.error) return saveResult.error
      return jsonResult(saveResult.snapshot)
    }
    case "regenerate": {
      const regenerateResult = await prisma.$transaction(async (tx) => {
        await lockRosterEligibilityMutation(tx, lodgeId, date)

        const currentAssignments = await tx.choreAssignment.findMany({
          where: assignmentScope(date, lodgeId),
          select: { status: true },
        })

        const hasConfirmed = currentAssignments.some(
          (assignment) =>
            assignment.status === "CONFIRMED" || assignment.status === "COMPLETED"
        )

        if (hasConfirmed && !data.overwriteConfirmed) {
          return { conflict: true as const }
        }

        const guests = await getGuestsForDate(date, lodgeId, tx)
        const deleteWhere = hasConfirmed
          ? assignmentScope(date, lodgeId)
          : { ...assignmentScope(date, lodgeId), status: "SUGGESTED" as const }

        await tx.choreAssignment.deleteMany({ where: deleteWhere })

        const allocations = await buildSuggestedAllocations(
          tx,
          date,
          guests,
          data.includeNonEssential,
          lodgeId
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
        return rosterError(
          "ROSTER_REGENERATE_CONFLICT",
          "Roster was not regenerated because it contains confirmed or completed chores. Confirm the overwrite warning and try again.",
          409,
        )
      }
      break
    }
    case "confirm": {
      const confirmResult = await prisma.$transaction(async (tx) => {
        await lockRosterEligibilityMutation(tx, lodgeId, date)
        const suggested = await tx.choreAssignment.findMany({
          where: {
            ...assignmentScope(date, lodgeId),
            status: "SUGGESTED",
          },
          select: {
            bookingGuestId: true,
            bookingId: true,
            choreTemplate: { select: { active: true } },
          },
        })
        const eligibleGuests = new Map(
          (await getGuestsForDate(date, lodgeId, tx)).map((guest) => [guest.id, guest.bookingId]),
        )
        if (suggested.some((assignment) =>
          assignment.bookingGuestId === null ||
          eligibleGuests.get(assignment.bookingGuestId) !== assignment.bookingId
        )) return { invalid: "guest" as const }
        if (suggested.some((assignment) => !assignment.choreTemplate.active)) {
          return { invalid: "template" as const }
        }
        await tx.choreAssignment.updateMany({
          where: {
            ...assignmentScope(date, lodgeId),
            status: "SUGGESTED",
          },
          data: { status: "CONFIRMED" },
        })
        return { success: true as const }
      })
      if ("invalid" in confirmResult) {
        return rosterError(
          confirmResult.invalid === "guest" ? "ROSTER_CONFIRM_GUEST_INELIGIBLE" : "ROSTER_CONFIRM_TEMPLATE_INVALID",
          confirmResult.invalid === "guest"
            ? "Roster not confirmed. A person is no longer eligible for this lodge night. Edit or regenerate the roster and try again."
            : "Roster not confirmed. A chore is no longer active for this lodge. Regenerate the roster and try again.",
          409,
        )
      }
      break
    }
    case "email": {
      // #1785 (#1769b sweep): the admin can suppress the whole roster send.
      // SUPPRESS (notifyMember === false) short-circuits BEFORE any token work
      // or email — no token deletion, no new tokens, no sends — so previously
      // emailed chore links stay valid. Only the suppression is audited; the
      // default/true notify path writes no audit field (mirrors #1769a).
      if (data.notifyMember === false) {
        logAudit({
          action: "ADMIN_CHORE_ROSTER_EMAIL_SUPPRESSED",
          memberId: adminMemberId,
          category: "communication",
          severity: "info",
          summary: "Admin suppressed the chore-roster email send",
          details: JSON.stringify({ date: dateStr, lodgeId, notifyMember: false }),
          metadata: { date: dateStr, lodgeId, notifyMember: false },
        })
        return jsonResult({
          success: true,
          suppressed: true,
          sent: 0,
          skipped: 0,
          failed: 0,
          failures: [],
        })
      }

      // Select and validate the complete fan-out under the same short-lived
      // eligibility locks as Save/Confirm. Provider calls remain below, after
      // this transaction commits.
      const emailSelection = await prisma.$transaction(async (tx) => {
        await lockRosterEligibilityMutation(tx, lodgeId, date)
        const assignments = await tx.choreAssignment.findMany({
          where: assignmentScope(date, lodgeId),
          include: {
            choreTemplate: true,
            bookingGuest: {
              include: {
                member: {
                  select: {
                    id: true,
                    email: true,
                    inheritEmailFromId: true,
                    inheritEmailFrom: { select: { email: true } },
                  },
                },
              },
            },
          },
        })
        const eligibleGuests = new Map(
          (await getGuestsForDate(date, lodgeId, tx)).map((guest) => [guest.id, guest.bookingId]),
        )
        if (assignments.some((assignment) =>
          assignment.bookingGuestId === null ||
          eligibleGuests.get(assignment.bookingGuestId) !== assignment.bookingId
        )) return { invalid: "guest" as const }
        if (assignments.some((assignment) => !assignment.choreTemplate.active)) {
          return { invalid: "template" as const }
        }
        return { assignments }
      })
      if ("invalid" in emailSelection) {
        return rosterError(
          emailSelection.invalid === "guest" ? "ROSTER_EMAIL_GUEST_INELIGIBLE" : "ROSTER_EMAIL_TEMPLATE_INVALID",
          emailSelection.invalid === "guest"
            ? "Roster emails were not sent because a person is no longer eligible for this lodge night. Reload the roster and try again."
            : "Roster emails were not sent because a chore is no longer active for this lodge. Regenerate the roster and try again.",
          409,
        )
      }
      const assignments = emailSelection.assignments

      // Group assignments by guest, resolving effective email for dependents
      const byGuest = new Map<string, {
        email: string | null
        // #2258: the booking whose stay this roster covers, so the per-booking
        // "No emails" switch can withhold the roster mail. NOT NULL on
        // ChoreAssignment, so a roster is always attributable to a booking.
        bookingId: string
        // #1285: the guest's own member id (null for non-member guests) plus the
        // member they inherit their email from (if any), so the roster send can
        // resolve the effective choreRoster preference (Option C hybrid).
        memberId: string | null
        inheritEmailFromId: string | null
        // The member whose inbox actually receives this email. This differs
        // from memberId for a dependent who inherits an adult's address.
        recipientMemberId: string | null
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
            bookingId: a.bookingId,
            memberId: a.bookingGuest.member?.id ?? null,
            inheritEmailFromId: a.bookingGuest.member?.inheritEmailFromId ?? null,
            recipientMemberId: a.bookingGuest.member?.inheritEmailFrom
              ? a.bookingGuest.member.inheritEmailFromId
              : (a.bookingGuest.member?.id ?? null),
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
      let skipped = 0
      for (const [guestId, guest] of byGuest) {
        if (!guest.email) continue
        // #1285 Option C (hybrid): resolve the guest's effective chore-roster
        // preference BEFORE creating a token, so an opted-out recipient is
        // suppressed without leaving an orphaned GuestChoreToken behind.
        const wantsRoster = await shouldSendChoreRoster(
          guest.memberId,
          guest.inheritEmailFromId,
        )
        if (!wantsRoster) {
          skipped++
          logger.debug(
            { guestId, memberId: guest.memberId, date: dateStr },
            "Skipped chore roster email — recipient opted out of the choreRoster category",
          )
          continue
        }
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
              {
                bookingId: guest.bookingId,
                recipient: guest.recipientMemberId
                  ? { kind: "member", memberId: guest.recipientMemberId }
                  : { kind: "non-login-public-contact" },
              },
              recipientEmail,
              guest.name,
              dateStr,
              guest.chores,
              choreLink,
              lodgeId,
            )
            return {
              guestId,
              name: guest.name,
              email: recipientEmail,
            }
          })()
        )
      }

      const results = await Promise.allSettled(emailPromises)
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => ({
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        }))

      return jsonResult({
        success: true,
        partialFailure: failures.length > 0,
        sent: results.filter((result) => result.status === "fulfilled").length,
        failed: failures.length,
        // #1285: guests suppressed by their (or their primary's) choreRoster
        // opt-out. Surfaced so the admin isn't confused when sent < guest count.
        skipped,
        failures,
      })
    }
  }
  } catch (err) {
    logger.error({ err }, "Error processing roster action")
    const failures = {
      save: {
        code: "ROSTER_SERVICE_UNAVAILABLE",
        error: "Roster not saved because the service could not be reached. Your draft is still here; try Save again.",
      },
      regenerate: {
        code: "ROSTER_REGENERATE_FAILED",
        error: "Roster was not regenerated because the service is unavailable. Nothing was changed; try again.",
      },
      confirm: {
        code: "ROSTER_CONFIRM_FAILED",
        error: "Roster was not confirmed because the service is unavailable. Nothing was changed; try again.",
      },
      email: {
        code: "ROSTER_EMAIL_FAILED",
        error: "Roster emails were not sent because the service is unavailable. Nothing was changed; try again.",
      },
    } as const
    const failure = failures[data.action]
    return rosterError(failure.code, failure.error, 500)
  }

  return jsonResult({ success: true })
}
