import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
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
  it("locks global then lodge before the school whole-lodge conversion", () => {
    const school = source("src/lib/school-booking-request.ts");
    const conversion = school.slice(
      school.lastIndexOf("conversion = await prisma.$transaction"),
    );
    expectInOrder(conversion, [
      "pg_advisory_xact_lock(1)",
      "acquireLodgeCapacityLock",
      "reconcileBedAllocationsForBookingWithLodgeLockHeld",
    ]);
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
});
