import fs, { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

/** Every `.ts`/`.tsx` source under `dir`, excluding declarations. */
function walkSources(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walkSources(full, files);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

function isTestFile(relPath: string): boolean {
  return (
    relPath.includes("__tests__") ||
    /\.(test|spec)\.tsx?$/.test(relPath) ||
    relPath.includes(".integration.")
  );
}

/**
 * The balanced `open`..`close` region starting at `openIndex`, so a nested
 * object or call inside a payload cannot end the match early. A substring
 * window would read the NEXT call's `data:` block as part of this one.
 */
function balancedFrom(
  text: string,
  openIndex: number,
  open: string,
  close: string,
): string {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    const char = text[i];
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex, i + 1);
    }
  }
  return text.slice(openIndex);
}

/**
 * Exactly one function's body, braces balanced from its own opening `{`.
 *
 * Every writer below used to be sliced out of the 4,484-line
 * `admin-bed-allocation.ts` by "from this signature to the next symbol's name",
 * and #2688 put each one at the END of its own small module — where that idiom
 * degenerates into "to end of file" and anything appended below the function can
 * satisfy an ordering chain on its behalf (#2688 review F2, measured on
 * `runAutoBedAllocation`). A balanced body needs no next-symbol anchor and
 * cannot be widened by anything outside the function.
 *
 * The parameter list is balanced first, then the return type is stepped over by
 * tracking angle brackets, so a `Promise<{ … }>` annotation is not mistaken for
 * the body.
 */
function functionBody(source: string, signature: string): string {
  const at = source.indexOf(signature);
  expect(at, `${signature} is not in this file`).toBeGreaterThanOrEqual(0);
  const parensAt = source.indexOf("(", at);
  const params = balancedFrom(source, parensAt, "(", ")");

  let angle = 0;
  let bodyAt = -1;
  for (let i = parensAt + params.length; i < source.length; i += 1) {
    const char = source[i];
    if (char === "<") angle += 1;
    else if (char === ">") angle = Math.max(0, angle - 1);
    else if (char === "{" && angle === 0) {
      bodyAt = i;
      break;
    }
  }
  expect(bodyAt, `${signature} has no body`).toBeGreaterThan(parensAt);
  return balancedFrom(source, bodyAt, "{", "}");
}

function between(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return text.slice(startIndex, endIndex);
}

function expectInOrder(text: string, tokens: readonly string[]): void {
  let cursor = -1;
  for (const token of tokens) {
    const next = text.indexOf(token, cursor + 1);
    expect(next, `Expected ${token} after offset ${cursor}`).toBeGreaterThan(
      cursor,
    );
    cursor = next;
  }
}

describe("bed allocation lock topology", () => {
  it("uses immutable sorted lodge keys and one lodge-narrowed selector for approval row locks and update", () => {
    const text = source("src/lib/bed-allocation-approval.ts");
    const selector = between(
      text,
      "function buildApproveBedAllocationsWhere",
      "export async function approveBedAllocationsWithLocksHeld",
    );
    expect(selector).toContain(
      "if (input.lodgeId) where.room = lodgeNullTolerantScope(input.lodgeId)",
    );
    const approval = functionBody(
      text,
      "export async function approveBedAllocations(input",
    );
    expectInOrder(approval, [
      "const lockWhere = buildApproveBedAllocationsWhere(input)",
      "await prisma.lodge.findMany",
      'orderBy: { id: "asc" }',
      "prisma.$transaction",
      "pg_advisory_xact_lock(1)",
      "acquireLodgeCapacityLock",
      "where: lockWhere",
      "ORDER BY \"id\"",
      "FOR UPDATE",
      "approveBedAllocationsWithLocksHeld",
      "createAuditLog",
    ]);
  });

  it("serializes reviewed removal global then actual sorted lodges then rows", () => {
    const text = source("src/lib/bed-allocation-removal.ts");
    const apply = functionBody(
      text,
      "export async function applyBedAllocationRemoval",
    );
    expectInOrder(apply, [
      "resolveImmutableLodgeKeys",
      "prisma.$transaction",
      "pg_advisory_xact_lock(1)",
      "acquireLodgeCapacityLock",
      "ORDER BY \"id\"",
      "FOR UPDATE",
      "deleteMany",
      "updateMany",
      "BED_ALLOCATION_REMOVAL_APPLIED",
      "BED_ALLOCATION_PARTNERS_PROMOTED",
    ]);
    expect(text).toContain(
      "for (const primaryKeyChunk of chunkValues(primaryKeys))",
    );
    for (const token of [
      "for (const lockIdChunk of lockIds)",
      "Prisma.join(lockIdChunk)",
      "chunkBedAllocationRemovalIds(selectedIds)",
      "chunkBedAllocationRemovalIds(siblingIds)",
    ]) {
      expect(apply).toContain(token);
    }
  });

  it("serializes reviewed moves global then sorted lodges, member families, and allocation rows", () => {
    const text = source("src/lib/bed-allocation-move.ts");
    const apply = functionBody(
      text,
      "export async function applyBedAllocationMove",
    );
    expectInOrder(apply, [
      "pg_advisory_xact_lock(1)",
      "loadRelatedRows(base, tx)",
      "moveLodgeIds(base, discoveryRows)",
      "acquireLodgeCapacityLock",
      "loadMoveState(base, tx)",
      "acquireMemberLifecycleLocks",
      "acquireMemberPartnerLinkLocks",
      "lockMoveRows",
      "authoritativeBase = await loadMoveBase",
      "authoritative = await loadMoveState",
      "preview.digest !== input.request.previewDigest",
      "updateReviewedMoveRows",
      "BED_ALLOCATION_MOVE_APPLIED",
    ]);
    // Asserted over the WHOLE module, not just this body: bounding the slice
    // above (#2688 review F2) would otherwise have narrowed this negative claim,
    // and "nowhere in the move writer" is what it means. There is no occurrence
    // in the file today.
    expect(text).not.toContain("lockMemberNights");
    expect(text).toContain('ORDER BY "bedId", "stayDate", "isSecondOccupant", "id"');
    expect(apply).toContain("{ timeout: 30_000, maxWait: 10_000 }");
    const guardedUpdate = between(
      text,
      "async function updateReviewedMoveRows",
      "export async function applyBedAllocationMove",
    );
    expect(guardedUpdate.match(/UPDATE "BedAllocation"/g) ?? []).toHaveLength(1);
    for (const guard of [
      'allocation."bookingId" = reviewed."bookingId"',
      'allocation."bookingGuestId" = reviewed."bookingGuestId"',
      'allocation."roomId" = reviewed."roomId"',
      'allocation."bedId" = reviewed."bedId"',
      'allocation."stayDate" = reviewed."stayDate"',
      'allocation."updatedAt" = reviewed."updatedAt"',
    ]) {
      expect(guardedUpdate).toContain(guard);
    }
  });

  it("keeps the reviewed-removal PostgreSQL races on the guarded CI harness and production writer entrypoints", () => {
    const harness = source(
      "src/lib/__tests__/concurrency-lock-races.realdb.test.ts",
    );
    expect(harness).toContain(
      'import "./bed-allocation-removal-races.realdb.test"',
    );

    const races = source(
      "src/lib/__tests__/bed-allocation-removal-races.realdb.test.ts",
    );
    expect(races).toContain(
      'process.env.RUN_CONCURRENCY_RACE_TESTS === "1"',
    );
    expect(races).toContain("CONCURRENCY_RACE_DATABASE_URL");
    expect(races).toContain("concurrency_race_1881");
    for (const writer of [
      "applyBedAllocationRemoval",
      "moveBedAllocationsSameDate",
      "runAutoBedAllocation",
      "reconcileBedAllocationsForBooking",
      "cancelBooking",
    ]) {
      expect(races).toContain(writer);
    }
  });

  it("rebuilds the board auto-allocation plan only after global then lodge", () => {
    // #2688: `runAutoBedAllocation` is now the whole of its own module. The
    // slice ran to end of file on that basis, which is true today and enforced
    // by nothing — anything appended below the function could satisfy the order
    // on its behalf (#2688 review F2). Brace-balanced from the function's own
    // body instead, so only this function can.
    const autoRun = functionBody(
      source("src/lib/bed-allocation-auto-allocate.ts"),
      "export async function runAutoBedAllocation(",
    );
    expectInOrder(autoRun, [
      "pg_advisory_xact_lock(1)",
      "acquireLodgeCapacityLock(tx, lodgeId)",
      "getBedAllocationDashboard",
      "suggestedAllocations.map",
      "bedAllocation.createMany",
    ]);
  });

  it("locks global exactly once then lodge before each school conversion", () => {
    const school = source("src/lib/school-booking-request.ts");
    const conversions = [
      between(
        school,
        "export async function approveSchoolBookingRequest(",
        "export type MemberWholeLodgeApprovalOverride",
      ),
      school.slice(
        school.indexOf(
          "export async function approveMemberWholeLodgeRequest(",
        ),
      ),
    ];

    for (const conversion of conversions) {
      expect(conversion.match(/pg_advisory_xact_lock\(1\)/g) ?? []).toHaveLength(
        1,
      );
      expectInOrder(conversion, [
        "pg_advisory_xact_lock(1)",
        "acquireLodgeCapacityLock",
        "reconcileBedAllocationsForBookingWithLodgeLockHeld",
      ]);
    }
  });

  it("locks global, lodge, then member credit for internet-banking expiry", () => {
    const release = between(
      source("src/lib/internet-banking-payment-cron.ts"),
      "function releaseOneHold",
      "export async function releaseExpiredInternetBankingHolds",
    );
    expectInOrder(release, [
      "pg_advisory_xact_lock(1)",
      "acquireLodgeCapacityLock",
      "lockMemberCreditLedger",
      "reconcileBedAllocationsForBookingWithLodgeLockHeld",
    ]);
  });

  it.each([
    ["src/lib/group-settlement.ts", "const candidateChildren"],
    [
      "src/lib/cron-group-settlement-reaper.ts",
      "const candidateChildren",
    ],
  ])("pre-locks and re-reads the child lodge union in %s", (file, marker) => {
    const text = source(file);
    const start = text.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const block = text.slice(start);
    expectInOrder(block, [
      "const candidateChildren",
      "candidateChildren.map((child) => child.lodgeId)",
      "acquireLodgeCapacityLock",
      "const children = await tx.booking.findMany",
      "!lockedLodgeIds.has(child.lodgeId)",
      "reconcileBedAllocationsForBookingWithLodgeLockHeld",
    ]);
  });

  it("takes the global cohort lock before a cancelled booking soft delete", () => {
    const softDelete = between(
      source("src/lib/booking-delete.ts"),
      "async function softDeleteCancelledBooking",
      "async function loadBookingForDelete",
    );
    expectInOrder(softDelete, [
      "prisma.$transaction",
      "pg_advisory_xact_lock(1)",
      "loadBookingForDelete",
      "reconcileBedAllocationsForBookingWithGlobalLockHeld",
    ]);
  });

  it("locks partner-share lodges then the member before the member-detail write and held sweep", () => {
    const memberDetail = source("src/lib/admin-member-detail-service.ts");
    const transaction = between(
      memberDetail,
      "const updated = await prisma.$transaction(async (tx) => {",
      "    if (\n      existing.active !== updated.active",
    );
    expectInOrder(transaction, [
      "acquireFuturePartnerSharedAllocationLocks(tx, [id], clubTodayDateOnly)",
      "acquireMemberLifecycleLocks(tx, [id])",
      "const updatedMember = await tx.member.update",
      "sweepFuturePartnerSharedAllocationsWithLocksHeld",
    ]);
  });

  it("locks partner-share lodges then every member before the bulk write and held sweep", () => {
    const bulkUpdate = source("src/app/api/admin/members/bulk-update/route.ts");
    const transaction = between(
      bulkUpdate,
      "const result = await prisma.$transaction(async (tx) => {",
      "    for (const { memberId, reason, swept } of sweptSharesByMember)",
    );
    expectInOrder(transaction, [
      "acquireFuturePartnerSharedAllocationLocks(tx, sweepLockMemberIds, clubTodayForBulk)",
      "acquireMemberLifecycleLocks(tx, sweepLockMemberIds)",
      "await tx.member.updateMany",
      "sweepFuturePartnerSharedAllocationsWithLocksHeld",
    ]);
  });

  it("status-guards every cross-lodge waitlist unwind before reconciliation", () => {
    const text = source("src/lib/waitlist-cross-lodge.ts");
    const revert = between(
      text,
      "async function revertOfferToWaitlisted",
      "const CROSS_LODGE_MINIMUM_STAY_ERROR",
    );
    expectInOrder(revert, [
      "booking.updateMany",
      "status: BookingStatus.WAITLIST_OFFERED",
      "reverted.count === 0",
      "reconcileBedAllocationsForBookingWithLodgeLockHeld",
    ]);

    const priceUnwind = between(
      text,
      'if (newBooking.finalPriceCents !== quotedPriceCents)',
      "// Phase 3",
    );
    expectInOrder(priceUnwind, [
      "pg_advisory_xact_lock(1)",
      "acquireLodgeCapacityLock",
      "booking.updateMany",
      "status: newBooking.status",
      "cancelled.count === 0",
      "reconcileBedAllocationsForBookingWithLodgeLockHeld",
      "status: BookingStatus.WAITLIST_OFFERED",
      "return refreshedOffer.count === 1",
      "!refreshedCurrentOffer",
    ]);

    const phaseThree = text.slice(text.indexOf("// Phase 3"));
    expectInOrder(phaseThree, [
      "pg_advisory_xact_lock(1)",
      "acquireLodgeCapacityLock",
      "booking.updateMany",
      "status: BookingStatus.WAITLIST_OFFERED",
      "updatedAt: entry.updatedAt",
      "waitlistOfferedAt: entry.waitlistOfferedAt",
      "waitlistOfferExpiresAt: entry.waitlistOfferExpiresAt",
      "waitlistOfferedLodgeId: entry.waitlistOfferedLodgeId",
      "waitlistOfferedPriceCents: entry.waitlistOfferedPriceCents",
      "cancelled.count === 0",
      "reconcileBedAllocationsForBookingWithLodgeLockHeld",
    ]);
  });

  it.each([
    ["src/lib/cron-waitlist.ts", "BookingStatus.WAITLIST_OFFERED"],
    ["src/lib/cron-complete-bookings.ts", "BookingStatus.PAID"],
  ])("uses locks, a fresh read, and a status claim in %s", (file, status) => {
    const text = source(file);
    expectInOrder(text, [
      "const candidates",
      "for (const candidate of candidates)",
      "prisma.$transaction",
      "pg_advisory_xact_lock(1)",
      "const key = await tx.booking.findUnique",
      "acquireLodgeCapacityLock",
      "const booking = await tx.booking.findUnique",
      "booking.updateMany",
      status,
      "claimed.count === 0",
      "reconcileBedAllocationsForBookingWithLodgeLockHeld",
    ]);
  });

  /**
   * `Booking.lodgeId` is IMMUTABLE for the row's life, and this is the only
   * thing that says so (#2672).
   *
   * Merge's partner-share lodge derivation
   * (`partnerShareGuestRowLodgeIds` in `bed-allocation-lifecycle.ts`) reads
   * `BookingGuest.memberId` and takes the booking's lodge key. Its completeness
   * argument has three legs; two are schema-enforced (`BedAllocation.bookingGuestId`
   * is a NOT NULL FK, `Booking.lodgeId`/`LodgeRoom.lodgeId` are NOT NULL) and the
   * third — that nothing ever MOVES a booking between lodges — was prose only.
   *
   * What breaking it costs, precisely: a merge derives lodge {A} and locks it;
   * a concurrent "move this booking to the other lodge" write re-points the
   * booking to B. A `Booking` update takes no lock on `Member`, so merge's
   * sorted `Member … FOR UPDATE` does not fence it, and
   * `assertPartnerShareLodgeCoverageWithLocksHeld` — which re-derives the LODGE
   * from the booking — cannot see a move committed after it runs.
   * `reconcileBedAllocationsForBookingWithLodgeLockHeld` then allocates at B and
   * the sweep judges bed inventory in a lodge merge never serialised against,
   * with NO refusal. That is strictly worse than the #2672 class it replaces,
   * which at least 409s.
   *
   * So the scan is deliberately structural rather than a string match: it walks
   * every non-test source, extracts the balanced `data`/`create`/`update`
   * payload of every `.booking.update`/`.updateMany`/`.upsert` call, and also
   * looks for a raw `UPDATE "Booking" … SET … "lodgeId"`. `prisma/migrations`
   * is out of scope on purpose — the one-off backfill
   * (`SET "lodgeId" = default_lodge_id() WHERE "lodgeId" IS NULL`) predates the
   * column being NOT NULL and is not a runtime writer.
   */
  it("keeps Booking.lodgeId immutable: no writer moves a booking between lodges", () => {
    const offenders: string[] = [];
    for (const file of walkSources(path.resolve(process.cwd(), "src"))) {
      const rel = path.relative(process.cwd(), file).split(path.sep).join("/");
      if (isTestFile(rel)) continue;
      const text = fs.readFileSync(file, "utf8");

      const writeCall = /\.booking\.(update|updateMany|upsert)\(/g;
      let call: RegExpExecArray | null;
      while ((call = writeCall.exec(text)) !== null) {
        const args = balancedFrom(text, text.indexOf("(", call.index), "(", ")");
        const payloadKey = /(?:^|[\s,{])(data|create|update)\s*:/g;
        let payloadMatch: RegExpExecArray | null;
        while ((payloadMatch = payloadKey.exec(args)) !== null) {
          const braceStart = args.indexOf(
            "{",
            payloadMatch.index + payloadMatch[0].length - 1,
          );
          if (braceStart === -1) continue;
          const payload = balancedFrom(args, braceStart, "{", "}");
          if (/(?:^|[\s,{])lodgeId\s*:/.test(payload)) {
            offenders.push(
              `${rel}: .booking.${call[1]}() ${payloadMatch[1]} block writes lodgeId`,
            );
          }
        }
      }

      if (
        /UPDATE\s+(?:"public"\.)?"?Booking"?[\s\S]{0,600}?\bSET\b[\s\S]{0,600}?"?lodgeId"?\s*=/i.test(
          text,
        )
      ) {
        offenders.push(`${rel}: raw UPDATE "Booking" … SET "lodgeId"`);
      }
    }

    expect(
      offenders,
      "INV-CAP-030 (#2672): merge's partner-share lodge derivation reads " +
        "Booking.lodgeId as IMMUTABLE for the row's life. A writer here reopens the " +
        "unlocked-lodge escape in its SILENT form — a booking moved mid-merge is " +
        "fenced by nothing (a Booking update takes no lock on Member, so merge's " +
        "`Member … FOR UPDATE` does not stop it) and the sweep judges bed inventory " +
        "in an unserialised lodge with NO refusal at all. If you genuinely need to " +
        "move a booking between lodges, give the guest-date writers a " +
        "`member-lifecycle:` tier first (issue #2672 Option 2) and re-do the " +
        "deadlock pass in docs/CONCURRENCY_AND_LOCKING.md -> " +
        '"Merge joins the bed-allocation cohort".',
    ).toEqual([]);
  });
});
