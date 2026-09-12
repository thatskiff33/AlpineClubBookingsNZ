import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function expectOrdered(body: string, markers: string[]): void {
  let cursor = -1;
  for (const marker of markers) {
    const next = body.indexOf(marker, cursor + 1);
    expect(next, `missing or misordered production marker: ${marker}`).toBeGreaterThan(cursor);
    cursor = next;
  }
}

/**
 * The slice for ONE transaction, bounded by the next one's opening line (#2887).
 *
 * This used to be `body.slice(body.indexOf(start))` — unbounded, to end of
 * file. For every transaction but the last that made the ordering assertion
 * unfalsifiable: markers belonging to a LATER transaction satisfied it. Moving
 * `acquireLodgeCapacityLock` in `createDraftBooking` to after
 * `resolveBookingLodgeId` and `assertMemberMayBookLodge` — reintroducing the
 * pre-#2701 race exactly — left all four assertions green, because the third
 * transaction's correctly-ordered markers were still downstream in the slice.
 * Only `createWaitlistedBooking` was genuinely pinned, and only because nothing
 * follows it.
 */
function transactionSlices(body: string, starts: readonly string[]): string[] {
  const offsets = starts.map((start) => {
    const at = body.indexOf(start);
    expect(at, `missing transaction opener: ${start}`).toBeGreaterThan(-1);
    return at;
  });
  // Bounds are only bounds if the openers appear in the order given; a source
  // reorder must fail loudly rather than silently widen a slice.
  for (let i = 1; i < offsets.length; i += 1) {
    expect(
      offsets[i],
      `transaction openers are out of source order at index ${i}`,
    ).toBeGreaterThan(offsets[i - 1]);
  }
  return offsets.map((from, i) =>
    body.slice(from, i + 1 < offsets.length ? offsets[i + 1] : body.length),
  );
}

describe("lodge admission and assignment lock topology (#2701)", () => {
  it("keeps every booking admission path behind the lodge key and post-lock scope reads", () => {
    const body = source("src/lib/booking-create.ts");
    // #2887 (L1): count the CALL, not one spelling of its argument. Keyed on
    // the literal `acquireLodgeCapacityLock(tx, lodgeId)`, a fourth admission
    // transaction written `acquireLodgeCapacityLock(tx, bookingLodgeId)` would
    // have left the count passing and been invisible to every assertion here.
    const LOCK_CALL = /await acquireLodgeCapacityLock\(\s*tx\s*,/g;
    const lock = "await acquireLodgeCapacityLock(tx,";
    const resolve = "const bookingLodgeId = await resolveBookingLodgeId(";

    expect(body.match(LOCK_CALL) ?? []).toHaveLength(3);
    expect(body.split(resolve)).toHaveLength(3);

    const slices = transactionSlices(body, [
      "const newBooking = await prisma.$transaction(async (tx) => {",
      "booking = await withOptionalTransaction(input.tx, async (tx) => {",
      "const { newBooking, position } = await prisma.$transaction(async (tx) => {",
    ]);
    for (const transaction of slices) {
      expectOrdered(transaction, [
        lock,
        "resolveBookingLodgeId(",
        "await assertMemberMayBookLodge(tx,",
      ]);
      // Each slice must carry its OWN lock — with the old unbounded slice a
      // transaction that had lost its lock entirely still found a later one's.
      expect(
        transaction.split(lock).length - 1,
        "a booking-admission transaction takes the lodge key exactly once",
      ).toBe(1);
    }
  });

  it("keeps lodge deactivation in config-to-capacity order with post-lock predicates", () => {
    const body = source("src/app/api/admin/lodges/[id]/route.ts");
    // The deactivation predicate itself moved into `lodge-deactivation-guard`
    // (#2887) because the route held two hand-copied versions of it, one either
    // side of the lock. What this case pins is unchanged: both locks, then the
    // re-read, then the predicate, then the write — in that order.
    expectOrdered(body, [
      "await acquireConfigImportLock(tx);",
      "await acquireLodgeCapacityLock(tx, parsedParams.data.id);",
      "const lockedExisting = await tx.lodge.findUnique(",
      "const lockedRefusal = await findLodgeDeactivationRefusal(tx, {",
      "const lodge = await tx.lodge.update(",
    ]);
    // …and the route no longer carries a second copy that could drift from it.
    expect(body).not.toContain("tx.memberLodgeAccess.count(");
    expect(body).not.toContain("prisma.memberLodgeAccess.count(");
  });

  it("puts EVERY HutLeaderAssignment writer behind the lodge key (#2887)", () => {
    // The doc in CONCURRENCY_AND_LOCKING claims one lodge cannot end up with
    // two overlapping hut leaders. Nothing enforces that in the database, so
    // the claim is only as true as the writer census: all three must decide
    // overlap under the key. Two of them did not until #2887.
    // #2698: the edit's and the delete's locked transactions moved OUT of the
    // route module and into `hut-leader-assignment-service.ts`, because the
    // route was on its 250-line ceiling and a Next route module cannot be split
    // any other way. The ORDER is what this census reads, so it reads it where
    // the order now lives — the route still owns the request-derived lock KEY
    // and the amend decision, both asserted below.
    const service = source("src/lib/hut-leader-assignment-service.ts");
    expectOrdered(service, [
      "export async function applyHutLeaderAssignmentEditUnderLocks(",
      "return prisma.$transaction(async (tx) => {",
      "await acquireLodgeCapacityLock(tx, input.intendedLodgeId);",
      "await findHutLeaderOverlapRefusal(tx, {",
      "await tx.hutLeaderAssignment.update(",
    ]);
    const put = source("src/app/api/admin/hut-leaders/[id]/route.ts");
    // …and no unlocked writer or unlocked overlap read survives in either.
    for (const body of [put, service]) {
      expect(body).not.toContain("await prisma.hutLeaderAssignment.update(");
      expect(body).not.toContain("await prisma.hutLeaderAssignment.findMany(");
      expect(body).not.toContain("await prisma.hutLeaderAssignment.delete(");
    }
    // The KEY is still derived in the route, from its own pre-lock read, and
    // handed to the service — so a stale key is still caught by the locked
    // re-read rather than acted on.
    expect(put).toContain("const intendedLodgeId = updateData.lodgeId ?? existing.lodgeId;");
    expect(put).toContain("lodgeId: existing.lodgeId,");

    // #2698: the DELETE is behind the key too. Removing a custodian bed hold
    // WIDENS the represented bed set of every overlapping whole-lodge hold
    // (INV-CAP-035), because that exclusion is derived from the live holds at
    // read time — so a delete is a capacity move and ran, until #2698, on the
    // base client outside any transaction.
    expectOrdered(
      service.slice(
        service.indexOf("export async function deleteHutLeaderAssignmentUnderLodgeLock("),
      ),
      [
        "return prisma.$transaction(async (tx) => {",
        "await acquireLodgeCapacityLock(tx, input.lodgeId);",
        "const locked = await tx.hutLeaderAssignment.findUnique(",
        "await tx.hutLeaderAssignment.delete(",
      ],
    );

    // #2698 amend path: the global cohort key is taken BEFORE the per-lodge key
    // (INV-LOCK-002) and only when the officer has accepted. Whether it is
    // taken is decided in the ROUTE, from the request, before any transaction
    // opens — which is what makes the order impossible to invert.
    for (const route of [
      "src/app/api/admin/hut-leaders/route.ts",
      "src/app/api/admin/hut-leaders/[id]/route.ts",
    ]) {
      expect(source(route)).toContain(
        "const amendRequested = parsed.data.amendOverlappingHolds === true;",
      );
    }
    expectOrdered(source("src/app/api/admin/hut-leaders/route.ts"), [
      "if (amendRequested) {",
      "await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;",
      "await acquireLodgeCapacityLock(tx,",
      "await validateCustodianBedHoldAndHoldAmendment(tx, {",
    ]);
    expectOrdered(service, [
      "if (input.amendAccepted) {",
      "await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;",
      "await acquireLodgeCapacityLock(tx, input.intendedLodgeId);",
      "await validateCustodianBedHoldAndHoldAmendment(tx, {",
    ]);

    const cron = source("src/lib/cron-hut-leader-auto-assign.ts");
    expectOrdered(cron, [
      "await prisma.$transaction(async (tx) => {",
      "await acquireLodgeCapacityLock(tx, lodge.id);",
      "await findHutLeaderOverlapRefusal(tx, {",
      "await tx.hutLeaderAssignment.create(",
    ]);
    expect(cron).not.toContain("await prisma.hutLeaderAssignment.create(");
    // #2887: `findMany` alone was too narrow — the club-wide gate that made the
    // lodge scoping below it unreachable was a `findFirst`, and this census
    // walked straight past it. Every unlocked READ of the table is refused now,
    // except the deliberate cheap pre-checks, which must name a lodge.
    for (const unlocked of [
      "await prisma.hutLeaderAssignment.findMany(",
      "await prisma.hutLeaderAssignment.update(",
      "await prisma.hutLeaderAssignment.delete(",
    ]) {
      expect(cron, `cron performs an unlocked ${unlocked}`).not.toContain(unlocked);
    }
    // The one permitted pre-lock read is the cheap already-assigned probe, and
    // it is lodge-scoped like everything else.
    const cheapProbe = cron.indexOf("await prisma.hutLeaderAssignment.findFirst(");
    if (cheapProbe !== -1) {
      expect(
        cron.slice(cheapProbe, cheapProbe + 400),
        "the cron's pre-lock already-assigned probe must name a lodge",
      ).toContain("lodgeNullTolerantScope(lodge.id)");
    }
    // Every lodge-scoped read in the job carries the scope; a club-wide one
    // suppressed valid auto-assignments at other lodges and raced the routes.
    expect(cron.match(/lodgeNullTolerantScope\(lodge\.id\)/g) ?? []).toHaveLength(3);
    // And the per-lodge decision replaced the club-wide adult count.
    // #2915's loop decides per (lodge, night); the count is per lodge because
    // the booking read above it is scoped to `lodge.id`.
    expect(cron).toContain("for (const lodge of activeLodges)");
    expect(cron).toContain("if (adultMembers.size !== 1) continue;");
  });

  it("keeps the HutLeaderAssignment writer census exhaustive at six (#2887)", () => {
    /*
      The doc's guarantee is only as true as this census. It was written as
      "every writer takes the key… all three of them" and there are SIX, so the
      sentence was checkable and false. Enumerated here by scanning src/ so a
      seventh cannot appear unnoticed and quietly widen the claim.
    */
    // Built fresh per file on purpose: a shared /g literal carries `lastIndex`
    // between calls, and one reused across ~2000 files does not report what
    // you think it does.
    const writes = (body: string) =>
      body.match(
        /(?:prisma|tx)\.hutLeaderAssignment\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\(/g,
      ) ?? [];
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__") walk(rel);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const body = readFileSync(join(process.cwd(), rel), "utf8");
          for (let i = writes(body).length; i > 0; i -= 1) found.push(rel);
        }
      }
    };
    walk("src");

    expect(found.sort()).toEqual([
      // Decide overlap -> must hold the key and re-read under it. Since #2698
      // the PUT's write lives in `hut-leader-assignment-service.ts`, with the
      // route deriving the key and the amend decision; the DELETE's write moved
      // to the same module and holds the lodge key too, because removing a
      // custodian hold widens every overlapping whole-lodge hold's represented
      // bed set. It removes only, so it still runs no overlap read.
      "src/lib/hut-leader-assignment-service.ts", // edit
      "src/lib/hut-leader-assignment-service.ts", // delete
      "src/app/api/admin/hut-leaders/[id]/pin/route.ts", // PIN rotate only
      "src/app/api/admin/hut-leaders/route.ts", // POST
      "src/lib/cron-hut-leader-auto-assign.ts",
      // Creates one row PER TEACHER, deliberately overlapping, under the key
      // but with no overlap read - the school-approval-path carve-out.
      "src/lib/school-booking-request.ts",
    ].sort());

    // The three overlap-deciding writers share ONE predicate now, so the rule
    // cannot drift between copies (#2887 review).
    for (const caller of [
      "src/app/api/admin/hut-leaders/route.ts",
      // The edit's decision, moved out of `[id]/route.ts` by #2698.
      "src/lib/hut-leader-assignment-service.ts",
      "src/lib/cron-hut-leader-auto-assign.ts",
    ]) {
      expect(source(caller), `${caller} stopped using the shared overlap guard`)
        .toContain("findHutLeaderOverlapRefusal(tx, {");
      // No caller keeps its own overlap read — pre-lock or post-lock. (The
      // GET list route's own `findMany` is a listing, not the predicate, and
      // lives behind `where: { lodgeId }` rather than the overlap window.)
      expect(
        source(caller),
        `${caller} kept its own copy of the overlap read`,
      ).not.toContain("tx.hutLeaderAssignment.findMany(");
    }
    // The guard is the only place the >1-day rule lives.
    expect(source("src/lib/hut-leader-overlap-guard.ts")).toContain("overlapDays > 1");

    // The school writer holds the lodge key even though it runs no overlap
    // read, so it still serializes against the three that do.
    expect(source("src/lib/school-booking-request.ts")).toContain(
      "acquireLodgeCapacityLock(",
    );
  });

  it("asks the deactivation predicate the same question before and under the lock", () => {
    // One predicate, two callers. A dependency class added to a copy rather
    // than to the shared helper is what this refuses to allow back.
    const body = source("src/app/api/admin/lodges/[id]/route.ts");
    expectOrdered(body, [
      "await findLodgeDeactivationRefusal(prisma, {",
      "await findLodgeDeactivationRefusal(tx, {",
    ]);

    const guard = source("src/lib/lodge-deactivation-guard.ts");
    for (const dependency of [
      "db.booking.count(",
      "db.hutLeaderAssignment.count(",
      "db.memberLodgeAccess.count(",
      "db.lodge.count(",
    ]) {
      expect(guard, `guard stopped reading ${dependency}`).toContain(dependency);
    }
    // The last-active-lodge rule and the dependency census are both refusals
    // the guard owns, not things a caller can forget to ask for.
    expect(guard).toContain("At least one lodge must remain active.");
    expect(guard).toContain("LODGE_HAS_DEPENDENCIES");
  });

  it("serializes role-only and bed-holding hut-leader assignments before authoritative reads", () => {
    const body = source("src/app/api/admin/hut-leaders/route.ts");
    expect(body).not.toContain("role-only assignment changes no capacity");
    expectOrdered(body, [
      "const created = await prisma.$transaction(async (tx) => {",
      "await acquireLodgeCapacityLock(tx, parsed.data.lodgeId);",
      "const lockedLodgeId = await resolveOptionalActiveLodgeId(",
      "const lockedMember = await tx.member.findUnique(",
      "await findHutLeaderOverlapRefusal(tx, {",
      "if (bedId) {",
      "await validateCustodianBedHoldAndHoldAmendment(tx, {",
      "const assignment = await tx.hutLeaderAssignment.create(",
    ]);
    expectOrdered(body, [
      "const { assignment } = created;",
      "await sendHutLeaderAssignmentEmail(",
    ]);
  });
});
