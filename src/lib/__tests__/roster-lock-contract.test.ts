import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import {
  lockRosterDateRangesAndDates,
  lockRosterDates,
  rosterOperationalDayRange,
} from "@/lib/roster-lock"
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

const ROOT = process.cwd()
const WRITERS = [
  "src/app/api/lodge/guests/[date]/depart/route.ts",
  "src/app/api/lodge/roster/[date]/confirm/route.ts",
  "src/app/api/lodge/roster/[date]/route.ts",
  "src/lib/admin-roster-service.ts",
  "src/lib/booking-guest-removal-service.ts",
  "src/lib/booking-modify-plan.ts",
  "src/lib/chore-cleanup.ts",
] as const

/**
 * Every caller that derives a roster-date lock set from a STAY ENVELOPE (#2622).
 *
 * Reviewed allowlist, enforced by a scan below rather than spot-checks, because
 * the failure mode is a NEW caller passing a raw `{ start: checkIn, end:
 * checkOut }` night range and leaving the check-out day's partition unlocked.
 */
const ENVELOPE_LOCK_CALLERS = [
  "src/lib/booking-batch-modification-service.ts",
  "src/lib/booking-date-modification-service.ts",
] as const

function source(file: string) {
  return fs.readFileSync(path.join(ROOT, file), "utf8")
}

function expectCallOrder(
  file: string,
  contents: string,
  markers: readonly string[],
) {
  let previous = -1
  for (const marker of markers) {
    const position = contents.indexOf(marker)
    expect(position, `${file}: missing ${marker}`).toBeGreaterThan(previous)
    previous = position
  }
}

function allSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) return allSourceFiles(absolute)
    return /\.(ts|tsx)$/.test(entry.name) ? [absolute] : []
  })
}

describe("roster-date lock source contract (#2586)", () => {
  it("keeps every ChoreAssignment writer in the reviewed participant inventory", () => {
    const found = allSourceFiles(path.join(ROOT, "src"))
      .filter((file) => !file.includes(`${path.sep}__tests__${path.sep}`))
      .filter((file) => /choreAssignment\.(?:create|createMany|update|updateMany|delete|deleteMany)\s*\(/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(ROOT, file).replaceAll("\\", "/"))
      .sort()
    expect(found).toEqual([...WRITERS].sort())
  }, CENSUS_TIMEOUT_MS)

  it("pins direct whole-roster and row writers to the shared roster-date lock", () => {
    expect(source("src/lib/admin-roster-service.ts")).toMatch(/await lockRosterEligibilityMutation\(tx, lodgeId, date\)/)
    expect(source("src/app/api/lodge/roster/[date]/confirm/route.ts")).toMatch(/await lockRosterEligibilityMutation\(tx, lodgeId, date\)/)
    expect(source("src/app/api/lodge/roster/[date]/route.ts")).toMatch(/await lockRosterDate\(tx, date\)/)
  })

  it("pins cleanup writers to sorted multi-date roster locks before deletion", () => {
    for (const file of [
      "src/app/api/lodge/guests/[date]/depart/route.ts",
      "src/lib/booking-guest-removal-service.ts",
      "src/lib/chore-cleanup.ts",
    ]) {
      const contents = source(file)
      expect(contents).toContain("await lockRosterDates(")
      expect(contents.indexOf("await lockRosterDates(")).toBeLessThan(contents.lastIndexOf("choreAssignment.delete"))
    }

    const dateService = source("src/lib/booking-date-modification-service.ts")
    expect(dateService.lastIndexOf("await lockRosterDateRangesAndDates(")).toBeLessThan(
      dateService.lastIndexOf("cleanupChoreAssignmentsForGuestStayRanges("),
    )
    expect(dateService).toContain("rosterDatesAlreadyLocked: true")

    const batchService = source("src/lib/booking-batch-modification-service.ts")
    expect(batchService.lastIndexOf("await lockRosterDateRangesAndDates(")).toBeLessThan(
      batchService.lastIndexOf("applyChoreCleanup("),
    )
    expect(batchService).toContain("rosterDatesAlreadyLocked: true")
  })

  it("keeps roster-date locks before member keys, tuple writes, and hosting-owner reconciliation", () => {
    // This is the cross-PR order between #2590's roster-date key and #2591's
    // coverage-owner key. The hosting reconciler acquires the owner key internally,
    // so its call site must remain after every roster-aware write. Moving the
    // reconciler above any lock marker below is the mutation this contract kills.
    const batchFile = "src/lib/booking-batch-modification-service.ts"
    const batch = source(batchFile)
    expectCallOrder(batchFile, batch, [
      "await lockRosterDateRangesAndDates(",
      "const guestPlan = await prepareGuestPlan(",
      "const { createdGuests } = await applyGuestChanges(",
      "await createBookingModificationCredit(",
      "await reconcileAdultMemberHostingReviewWithSiblings(",
    ])

    const dateFile = "src/lib/booking-date-modification-service.ts"
    const dateService = source(dateFile)
    const standardStart = dateService.indexOf(
      "export async function modifyBookingDates(",
    )
    const shiftStart = dateService.indexOf(
      "export async function adminShiftBookingDates(",
    )
    expect(standardStart).toBeGreaterThan(-1)
    expect(shiftStart).toBeGreaterThan(standardStart)

    const standard = dateService.slice(standardStart, shiftStart)
    expectCallOrder(`${dateFile}#modifyBookingDates`, standard, [
      "await lockRosterDateRangesAndDates(",
      "await assertNoBookingMemberNightConflicts(",
      "await tx.bookingGuest.update(",
      "await createBookingModificationCredit(",
      "await reconcileAdultMemberHostingReviewWithSiblings(",
    ])

    const shift = dateService.slice(shiftStart)
    expectCallOrder(`${dateFile}#adminShiftBookingDates`, shift, [
      "await lockRosterDateRangesAndDates(",
      "await assertNoBookingMemberNightConflicts(",
      "await tx.bookingGuest.update(",
      "await reconcileAdultMemberHostingReviewWithSiblings(",
    ])

    const removalFile = "src/lib/booking-guest-removal-service.ts"
    const removalService = source(removalFile)
    const removalStart = removalService.indexOf(
      "export async function removeBookingGuestInTransaction(",
    )
    const cleanupStart = removalService.indexOf(
      "async function removeGuestChoreAssignments(",
    )
    expect(removalStart).toBeGreaterThan(-1)
    expect(cleanupStart).toBeGreaterThan(removalStart)

    const removal = removalService.slice(removalStart, cleanupStart)
    expectCallOrder(`${removalFile}#removeBookingGuestInTransaction`, removal, [
      "await removeGuestChoreAssignments(",
      "await tx.bookingGuest.delete(",
      "await createBookingModificationCredit(",
      "await reconcileAdultMemberHostingReviewWithSiblings(",
    ])

    const cleanup = removalService.slice(cleanupStart)
    expectCallOrder(`${removalFile}#removeGuestChoreAssignments`, cleanup, [
      "await lockRosterDates(",
      "await tx.choreAssignment.deleteMany(",
    ])
  })

  it("keeps departure and chore-template mutation ordered with roster validation", () => {
    const departure = source("src/app/api/lodge/guests/[date]/depart/route.ts")
    expect(departure.indexOf("pg_advisory_xact_lock(1)")).toBeLessThan(
      departure.indexOf("acquireLodgeCapacityLock(tx, lodgeId)"),
    )
    expect(departure.indexOf("acquireLodgeCapacityLock(tx, lodgeId)")).toBeLessThan(
      departure.indexOf("await lockRosterDates"),
    )
    expect(departure.indexOf("await lockRosterDates")).toBeLessThan(
      departure.indexOf("tx.bookingGuest.update"),
    )

    const templateMutation = source("src/app/api/admin/chores/[id]/route.ts")
    expect(templateMutation).toContain("acquireLodgeCapacityLock(tx, effectiveLodgeId)")
    expect(templateMutation.indexOf("acquireLodgeCapacityLock(tx, effectiveLodgeId)")).toBeLessThan(
      templateMutation.indexOf("tx.choreTemplate.update"),
    )

    const configApply = source("src/lib/config-transfer/apply.ts")
    // The apply takes the lodge keys inside its category-keys helper, which it
    // calls after the singleton and before the in-lock re-plan.
    const applyFn = configApply.slice(configApply.indexOf("export async function applyConfigImport"))
    const configLock = applyFn.indexOf("await acquireConfigImportLock(tx)")
    const categoryKeys = applyFn.indexOf("await lockSelectedCategoryKeys(tx, parsed, params.selectedCategories)")
    const inLockReplan = applyFn.indexOf("const replan = await buildImportPlanFromParsed")
    expect(configLock).toBeGreaterThan(-1)
    expect(categoryKeys).toBeGreaterThan(configLock)
    expect(inLockReplan).toBeGreaterThan(categoryKeys)
    const categoryKeysHelper = configApply.slice(
      configApply.indexOf("async function lockSelectedCategoryKeys"),
      configApply.indexOf("export type BootstrapBackupSkip"),
    )
    expect(categoryKeysHelper).toContain('if (applies("lodge-config"))')
    expect(categoryKeysHelper).toContain("await lockAffectedLodgeConfigLodges(tx, parsed.files)")
    const importedLodgeLockHelper = configApply.slice(
      configApply.indexOf("async function lockAffectedLodgeConfigLodges"),
      configApply.indexOf("export type BootstrapBackupSkip"),
    )
    expect(importedLodgeLockHelper).toContain("lodges.map(({ id }) => id).sort()")
    expect(importedLodgeLockHelper).toContain("await acquireLodgeCapacityLock(tx, lodgeId)")

    for (const lodgeIdentityWriter of [
      "src/app/api/admin/lodges/route.ts",
      "src/app/api/admin/lodges/[id]/route.ts",
    ]) {
      const contents = source(lodgeIdentityWriter)
      expect(contents).toContain("await acquireConfigImportLock(tx)")
      expect(contents.indexOf("await acquireConfigImportLock(tx)")).toBeLessThan(
        contents.lastIndexOf("buildUniqueLodgeSlug("),
      )
    }

    const lodgeOps = source("src/lib/config-transfer/categories/lodge-ops.ts")
    expect(lodgeOps).toContain("ctx.tx.choreTemplate.update")
    expect(configApply).toContain("await acquireLodgeCapacityLock(tx, lodgeId)")
  })

  it("keeps every roster-eligibility writer on a shared global or lodge tier", () => {
    const protocols = [
      {
        file: "src/app/api/admin/bookings/[id]/review/route.ts",
        markers: ["pg_advisory_xact_lock(1)", "acquireLodgeCapacityLock"],
      },
      {
        file: "src/app/api/bookings/[id]/guests/route.ts",
        markers: ["acquireLodgeCapacityLock"],
      },
      {
        file: "src/lib/member-guest-consent-service.ts",
        markers: ["pg_advisory_xact_lock(1)", "acquireLodgeCapacityLock"],
      },
      {
        file: "src/lib/booking-guest-removal-service.ts",
        markers: ["pg_advisory_xact_lock(1)", "acquireLodgeCapacityLock", "lockRosterDates"],
      },
      {
        file: "src/lib/booking-date-modification-service.ts",
        markers: ["pg_advisory_xact_lock(1)", "acquireLodgeCapacityLock", "lockRosterDateRangesAndDates"],
      },
      {
        file: "src/lib/booking-batch-modification-service.ts",
        markers: ["pg_advisory_xact_lock(1)", "acquireLodgeCapacityLock", "lockRosterDateRangesAndDates"],
      },
    ]

    for (const { file, markers } of protocols) {
      const contents = source(file)
      for (const marker of markers) expect(contents, file).toContain(marker)
    }
  })

  it("keeps review eligibility positive so rejected and unresolved rows stay blocked", () => {
    const contents = source("src/lib/booking-review.ts")
    expect(contents).toContain("{ requiresAdminReview: false }")
    expect(contents).toContain("{ adminReviewStatus: AdminReviewStatus.APPROVED }")
  })

  it("keeps the public admin mutation contract free of legacy immediate row actions", () => {
    const contents = source("src/lib/admin-roster-service.ts")
    expect(contents).not.toContain('z.literal("reassign")')
    expect(contents).not.toContain('z.literal("add")')
    expect(contents).not.toContain('z.literal("remove")')
    expect(contents).toContain('action: z.literal("save")')
  })

  it("derives every envelope lock set through the checkout-inclusive helper (#2622)", () => {
    // A raw `{ start: checkIn, end: checkOut }` locks only the NIGHTS, leaving
    // the check-out day's partition — where a departure-morning row now lives —
    // unlocked while the booking's dates move underneath it.
    //
    // Scanned, not hard-coded: pinning two known files would let a FOURTH
    // `lockRosterDateRangesAndDates` caller appear with a raw night range and
    // regress this silently. Mirrors the WRITERS inventory above.
    const found = allSourceFiles(path.join(ROOT, "src"))
      .filter((file) => !file.includes(`${path.sep}__tests__${path.sep}`))
      .filter((file) => /await lockRosterDateRangesAndDates\s*\(/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(ROOT, file).replaceAll("\\", "/"))
      .sort()
    expect(found).toEqual([...ENVELOPE_LOCK_CALLERS].sort())

    for (const file of ENVELOPE_LOCK_CALLERS) {
      const contents = source(file)
      expect(contents, file).toContain("rosterOperationalDayRange(")
      expect(contents.replace(/\s+/g, " "), file).not.toMatch(
        /\{ start: \w+\.?\w*[Cc]heckIn, end: \w+\.?\w*[Cc]heckOut \}/,
      )
    }
    expect(source("src/lib/roster-lock.ts")).toContain(
      "addDaysDateOnly(checkOut, 1)",
    )
  }, CENSUS_TIMEOUT_MS)
})

// ---------------------------------------------------------------------------
// The lock SETS themselves, not just the call sites (#2622)
// ---------------------------------------------------------------------------

function day(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`)
}

/** Capture the roster keys a lock helper actually acquires, in order. */
function recordingTx() {
  const keys: string[] = []
  const tx = {
    $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      keys.push(String(values[0]))
      return 1
    },
  }
  // The helpers only ever call `$executeRaw`; a real PrismaPromise is not
  // needed to observe which keys, in which order, they ask for.
  return { keys, tx: tx as unknown as Parameters<typeof lockRosterDates>[0] }
}

describe("roster-date lock sets are checkout-inclusive (#2622)", () => {
  it("locks the check-out day as well as every night", async () => {
    const { keys, tx } = recordingTx()
    await lockRosterDateRangesAndDates(
      tx,
      [rosterOperationalDayRange(day("2026-07-10"), day("2026-07-13"))],
      [],
    )
    expect(keys).toEqual([
      "roster:2026-07-10",
      "roster:2026-07-11",
      "roster:2026-07-12",
      "roster:2026-07-13",
    ])
  })

  it("MUTATION PROBE: a date change holds BOTH the old and the new check-out day", async () => {
    // The exact set a booking date change must hold. Drop either check-out key
    // and a concurrent whole-roster Save can insert a departure-morning row
    // into a partition this transaction has already decided to clean up.
    const { keys, tx } = recordingTx()
    await lockRosterDateRangesAndDates(
      tx,
      [
        rosterOperationalDayRange(day("2026-07-10"), day("2026-07-12")),
        rosterOperationalDayRange(day("2026-07-14"), day("2026-07-16")),
      ],
      [],
    )
    expect(keys).toContain("roster:2026-07-12") // old check-out day
    expect(keys).toContain("roster:2026-07-16") // new check-out day
    expect(keys).toEqual([
      "roster:2026-07-10",
      "roster:2026-07-11",
      "roster:2026-07-12",
      "roster:2026-07-14",
      "roster:2026-07-15",
      "roster:2026-07-16",
    ])
  })

  it("keeps one ascending, de-duplicated order across overlapping envelopes and stored dates", async () => {
    // Deadlock safety: every roster key this transaction will ever take is
    // acquired once, ascending, before the first tuple write.
    const { keys, tx } = recordingTx()
    await lockRosterDateRangesAndDates(
      tx,
      [
        rosterOperationalDayRange(day("2026-07-12"), day("2026-07-14")),
        rosterOperationalDayRange(day("2026-07-10"), day("2026-07-12")),
      ],
      [day("2026-07-20"), day("2026-07-09"), day("2026-07-14")],
    )
    expect(keys).toEqual([
      "roster:2026-07-09",
      "roster:2026-07-10",
      "roster:2026-07-11",
      "roster:2026-07-12",
      "roster:2026-07-13",
      "roster:2026-07-14",
      "roster:2026-07-20",
    ])
    expect(new Set(keys).size).toBe(keys.length)
    expect([...keys].sort()).toEqual(keys)
  })

  it("still locks stored assignment dates alone for the guest-scoped writers", async () => {
    // Guest removal and kiosk departure derive their sets from STORED rows
    // rather than an envelope, so they pick up checkout-day rows automatically
    // and needed no widening. This pins that they stay sorted.
    const { keys, tx } = recordingTx()
    await lockRosterDates(tx, [day("2026-07-14"), day("2026-07-11"), day("2026-07-14")])
    expect(keys).toEqual(["roster:2026-07-11", "roster:2026-07-14"])
  })
})
