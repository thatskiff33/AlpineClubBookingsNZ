import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function standingFanoutBody(review: string): string {
  const start = review.indexOf(
    "export async function enqueueHostingCoverageReevaluationForMember",
  );
  return review.slice(start, review.indexOf("\nexport ", start + 1));
}

function participantFunction(participants: string, name: string): string {
  const start = participants.indexOf(`export async function ${name}`);
  return participants.slice(start, participants.indexOf("\n/**", start + 1));
}

function holdBody(quotes: string): string {
  const start = quotes.indexOf("export async function holdBookingRequestSlots");
  return quotes.slice(start);
}

function hasStandingFanoutBarrierContract(
  review: string,
  participants: string,
): boolean {
  const fanout = standingFanoutBody(review);
  const targetLock = participantFunction(
    participants,
    "lockHostingCoverageMemberLifecycleTarget",
  );
  const lock = fanout.indexOf(
    "await lockHostingCoverageMemberLifecycleTarget(db, memberId)",
  );
  const firstRead = fanout.indexOf(
    "await loadHostingCoverageMemberFanoutCandidates(memberId, db, today)",
  );
  const emptyReturn = fanout.indexOf("if (plannedAttended.length === 0) return 0");

  return (
    lock >= 0 &&
    firstRead > lock &&
    emptyReturn > firstRead &&
    /SELECT 1[\s\S]*?FROM "Member"[\s\S]*?WHERE "id" = \$\{memberId\}[\s\S]*?FOR UPDATE NOWAIT/.test(
      targetLock,
    ) &&
    targetLock.includes("isPostgresLockNotAvailable(error)") &&
    targetLock.includes("throw new HostingCoverageParticipantRetryError()") &&
    targetLock.includes("if (locked !== 1)") &&
    !targetLock.includes("FOR NO KEY UPDATE")
  );
}

function hasLinkedMemberHoldContract(
  quotes: string,
  participants: string,
): boolean {
  const hold = holdBody(quotes);
  const linkedLock = participantFunction(
    participants,
    "lockActiveBookingRequestLinkedMembers",
  );
  const markers = [
    "await acquireLodgeCapacityLock(tx, bookingLodgeId)",
    "const currentRequest = await tx.bookingRequest.findUnique({",
    "const currentLinkedMembers = linkedGuestMemberMap(",
    "await lockActiveBookingRequestLinkedMembers(",
    "const claimed = await tx.bookingRequest.updateMany({",
    "const held = await tx.booking.create({",
  ];
  const positions = markers.map((marker) => hold.indexOf(marker));
  const ordered = positions.every(
    (position, index) =>
      position >= 0 && (index === 0 || position > positions[index - 1]),
  );

  return (
    ordered &&
    hold.includes("select: { version: true, linkedGuestMembers: true }") &&
    hold.includes("currentRequest.version !== request.version") &&
    hold.includes("const expectedLinkedEntries = [...linkedMembers.entries()]") &&
    hold.includes(
      "const currentLinkedEntries = [...currentLinkedMembers.entries()]",
    ) &&
    hold.includes("JSON.stringify(currentLinkedEntries) !==") &&
    hold.includes("JSON.stringify(expectedLinkedEntries)") &&
    hold.includes("[...currentLinkedMembers.values()]") &&
    hold.includes("version: request.version") &&
    /SELECT 1[\s\S]*?FROM "Member"[\s\S]*?WHERE "id" IN \(\$\{Prisma\.join\(memberIds\)\}\)[\s\S]*?ORDER BY "id"[\s\S]*?FOR KEY SHARE/.test(
      linkedLock,
    ) &&
    linkedLock.indexOf("await db.member.findMany({") >
      linkedLock.indexOf("FOR KEY SHARE") &&
    linkedLock.includes("select: { id: true, active: true, archivedAt: true }") &&
    linkedLock.includes("member.active !== true") &&
    linkedLock.includes("member.archivedAt !== null")
  );
}

describe("standing fanout and booking-request linked-member fencing (#2597)", () => {
  const route = readRepoFile(
    "src/app/api/admin/deletion-requests/[id]/route.ts",
  );
  const participants = readRepoFile(
    "src/lib/adult-member-hosting-queue-participants.ts",
  );
  const review = readRepoFile("src/lib/adult-member-hosting-review.ts");
  const quotes = readRepoFile("src/lib/booking-request-quotes.ts");
  const holdRoute = readRepoFile(
    "src/app/api/admin/booking-requests/[id]/hold/route.ts",
  );
  const sendQuoteRoute = readRepoFile(
    "src/app/api/admin/booking-requests/[id]/send-quote/route.ts",
  );

  it("pins the shared subject NOWAIT barrier before the first candidate read and empty return", () => {
    expect(hasStandingFanoutBarrierContract(review, participants)).toBe(true);
    expect(route).not.toContain("lockHostingCoverageMemberLifecycleTarget");

    const routeMarkers = [
      "acquireFuturePartnerSharedAllocationLocks(tx, [member.id], clubTodayForSweep)",
      "acquireMemberLifecycleLocks(tx, [member.id])",
      "enqueueHostingCoverageReevaluationForMember(member.id, tx, clubTodayForSweep,",
      "await tx.member.update({",
      "await tx.bookingGuest.updateMany({",
    ];
    const positions = routeMarkers.map((marker) => route.indexOf(marker));
    expect(
      positions.every(
        (position, index) =>
          position >= 0 && (index === 0 || position > positions[index - 1]),
      ),
    ).toBe(true);
  });

  it("pins the transaction-authoritative linked-member lock and active re-read before claim and create", () => {
    expect(hasLinkedMemberHoldContract(quotes, participants)).toBe(true);
    for (const routeSource of [holdRoute, sendQuoteRoute]) {
      expect(routeSource).toContain(
        "const hostingRetry = hostingCoverageParticipantRetryResponse(err)",
      );
      expect(routeSource).toContain("if (hostingRetry) return hostingRetry");
    }
  });

  it("kills shared-barrier removal, downgrade, blocking, and late-placement mutations", () => {
    const removed = review.replace(
      "await lockHostingCoverageMemberLifecycleTarget(db, memberId);",
      "",
    );
    const downgraded = participants.replace(
      "FOR UPDATE NOWAIT",
      "FOR NO KEY UPDATE NOWAIT",
    );
    const blocking = participants.replace("FOR UPDATE NOWAIT", "FOR UPDATE");
    const unmapped55P03 = participants.replace(
      "if (isPostgresLockNotAvailable(error)) {",
      "if (false) {",
    );
    const fanout = standingFanoutBody(review);
    const lock = "await lockHostingCoverageMemberLifecycleTarget(db, memberId);";
    const read =
      "const plannedAttended = await loadHostingCoverageMemberFanoutCandidates(memberId, db, today);";
    const movedBody = fanout.replace(lock, "").replace(read, `${read}\n  ${lock}`);
    const moved = review.replace(fanout, movedBody);
    const emptyReturn = "if (plannedAttended.length === 0) return 0;";
    const afterEmptyBody = fanout
      .replace(lock, "")
      .replace(emptyReturn, `${emptyReturn}\n  ${lock}`);
    const afterEmpty = review.replace(fanout, afterEmptyBody);

    expect(hasStandingFanoutBarrierContract(removed, participants)).toBe(false);
    expect(hasStandingFanoutBarrierContract(review, downgraded)).toBe(false);
    expect(hasStandingFanoutBarrierContract(review, blocking)).toBe(false);
    expect(hasStandingFanoutBarrierContract(review, unmapped55P03)).toBe(false);
    expect(hasStandingFanoutBarrierContract(moved, participants)).toBe(false);
    expect(hasStandingFanoutBarrierContract(afterEmpty, participants)).toBe(false);
  });

  it("kills stale-snapshot, unlocked-read, eligibility, and post-create hold mutations", () => {
    const staleSnapshot = quotes.replace(
      "[...currentLinkedMembers.values()]",
      "[...linkedMembers.values()]",
    );
    const noVersionFence = quotes.replace("version: request.version,", "");
    const noCurrentLinkProof = quotes.replace(
      /\s+const expectedLinkedEntries = \[\.\.\.linkedMembers\.entries\(\)\]\.sort\([\s\S]*?\n\s+}\n\s+await lockActiveBookingRequestLinkedMembers/,
      "\n      await lockActiveBookingRequestLinkedMembers",
    );
    const noActiveCheck = participants.replace("member.active !== true ||", "");
    const noArchiveCheck = participants.replace(
      "member.archivedAt !== null,",
      "false,",
    );
    const hold = holdBody(quotes);
    const lockCall = `await lockActiveBookingRequestLinkedMembers(\n        tx,\n        [...currentLinkedMembers.values()],\n      );`;
    const create = "const held = await tx.booking.create({";
    const reconcile =
      "await reconcileAdultMemberHostingReviewWithSiblings(held.id, tx);";
    const movedHoldBody = hold
      .replace(lockCall, "")
      .replace(reconcile, `${lockCall}\n\n      ${reconcile}`);
    const postCreate = quotes.replace(hold, movedHoldBody);
    const afterClaimHoldBody = hold
      .replace(lockCall, "")
      .replace(create, `${lockCall}\n\n      ${create}`);
    const postClaim = quotes.replace(hold, afterClaimHoldBody);

    expect(hasLinkedMemberHoldContract(staleSnapshot, participants)).toBe(false);
    expect(hasLinkedMemberHoldContract(noVersionFence, participants)).toBe(false);
    expect(hasLinkedMemberHoldContract(noCurrentLinkProof, participants)).toBe(false);
    expect(hasLinkedMemberHoldContract(quotes, noActiveCheck)).toBe(false);
    expect(hasLinkedMemberHoldContract(quotes, noArchiveCheck)).toBe(false);
    expect(hasLinkedMemberHoldContract(postClaim, participants)).toBe(false);
    expect(hasLinkedMemberHoldContract(postCreate, participants)).toBe(false);
  });

  it("keeps the hold on lodge -> linked Member rows without a new global or source Booking lock", () => {
    const hold = holdBody(quotes);
    const reconcile = hold.indexOf(
      "reconcileAdultMemberHostingReviewWithSiblings(held.id, tx)",
    );

    expect(reconcile).toBeGreaterThanOrEqual(0);
    expect(hold.slice(0, reconcile)).not.toContain("pg_advisory_xact_lock(1)");
    expect(hold.slice(0, reconcile)).not.toMatch(
      /FROM "Booking"[\s\S]*?FOR (?:KEY SHARE|UPDATE)/,
    );
  });
});
