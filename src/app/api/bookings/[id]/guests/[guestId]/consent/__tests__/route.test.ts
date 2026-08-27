import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/*
  Route tests for POST /api/bookings/[id]/guests/[guestId]/consent (epic #2305,
  MG2 #2307).

  THE ONE THING THESE TESTS EXIST TO HOLD DOWN is the route's uniform 403. Its
  own docblock says IDOR is the primary security concern on this endpoint,
  because the two ids it takes are exactly the two an attacker would want to
  probe, and the answer to that is that EVERY AUTHORISATION failure — no such
  guest row, a row on somebody else's booking, a row that is not a member-guest
  at all, a request that has already been answered, and a caller who is neither
  the target nor an accepted delegate — comes back as the same status with the
  same bytes. A "helpful" 404 for the missing-guest case, or a distinct message
  for the already-answered case, turns the endpoint back into an existence
  oracle, so the first test below compares all five responses byte for byte
  rather than asserting a status per case.

  ONE ANSWER SITS BELOW THAT LINE and is deliberately NOT byte-identical: a
  caller who has already proved they are the target or an accepted delegate gets
  404 with the shared "cancelled or removed" sentence on a SOFT-DELETED booking
  (#2700, INV-ADDPAY-034/035). It is not a hole in the uniformity above, because
  it is unreachable until the target/delegate check has passed — the five cases
  compared byte for byte here all fail before it. That guard lives in the
  consent service and is pinned in
  src/lib/__tests__/member-guest-consent-deleted-booking.test.ts, including the
  ordering: a stranger on a deleted booking still gets the same 403 as on a live
  one. Nothing new may be added ABOVE the target/delegate check.

  Mock shape follows the neighbouring MG2 suite
  (src/app/api/admin/member-guest-settings/__tests__/route.test.ts) and the
  whole-lodge route suite: the guards, the rate limiter's decision, the module
  read and the outbound side effects are stubbed, but the CONSENT SERVICE ITSELF
  IS REAL. That matters — two of the five failure situations (already answered,
  not the target or a delegate) are decided inside
  `respondToMemberGuestConsent`, and stubbing the service would have reduced
  those two rows to assertions about a mock. `$transaction` runs its callback
  against the same delegate mocks, so the status-guarded claim really executes.
*/

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  applyRateLimit: vi.fn(),
  isEffectiveModuleEnabled: vi.fn(),
  guestFindUnique: vi.fn(),
  guestUpdateMany: vi.fn(),
  bookingFindUnique: vi.fn(),
  txBookingFindUnique: vi.fn(),
  memberFindUnique: vi.fn(),
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
  getDefaultLodgeId: vi.fn(),
  removeBookingGuestInTransaction: vi.fn(),
  canRespondForTarget: vi.fn(),
  resolveNotificationRecipients: vi.fn(),
  reconcileBedAllocationsForBooking: vi.fn(),
  logAudit: vi.fn(),
  sendOutcomeEmail: vi.fn(),
  sendExpiredEmail: vi.fn(),
  enqueueHostingCoverage: vi.fn().mockResolvedValue(0),
  settleHostingCoverage: vi.fn().mockResolvedValue(undefined),
  // Declared inside vi.hoisted so the class exists before the hoisted vi.mock
  // factory below closes over it. The service narrows refusals with
  // `instanceof`, so the blocked-decline test has to throw this exact class.
  TestRemovalError: class TestRemovalError extends Error {
    status = 400;
  },
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: h.requireActiveSessionUser,
}));
// The real `rateLimiters` table is kept on purpose: the bucket assertion below
// is only worth anything if it compares against the config the route will
// actually run with, not against a shape re-typed in this file.
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, applyRateLimit: h.applyRateLimit };
});
vi.mock("@/lib/admin-modules", () => ({
  isEffectiveModuleEnabled: h.isEffectiveModuleEnabled,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    bookingGuest: { findUnique: h.guestFindUnique, updateMany: h.guestUpdateMany },
    booking: { findUnique: h.bookingFindUnique },
    member: { findUnique: h.memberFindUnique },
    $transaction: h.transaction,
    $executeRaw: h.executeRaw,
  },
}));
vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: h.acquireLodgeCapacityLock,
}));
vi.mock("@/lib/lodges", () => ({ getDefaultLodgeId: h.getDefaultLodgeId }));
vi.mock("@/lib/booking-guest-removal-service", () => ({
  BookingGuestRemovalError: h.TestRemovalError,
  removeBookingGuestInTransaction: h.removeBookingGuestInTransaction,
}));
vi.mock("@/lib/member-guest-delegate", () => ({
  familyAdultDelegateResolver: {
    canRespondForTarget: h.canRespondForTarget,
    resolveNotificationRecipients: h.resolveNotificationRecipients,
  },
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: h.reconcileBedAllocationsForBooking,
}));
vi.mock("@/lib/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/email/member-guest", () => ({
  sendMemberGuestConsentOutcomeEmail: h.sendOutcomeEmail,
  sendMemberGuestConsentExpiredEmail: h.sendExpiredEmail,
}));
vi.mock("@/lib/adult-member-hosting-review", () => ({
  enqueueHostingCoverageReevaluationForMember: h.enqueueHostingCoverage,
}));
vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: h.settleHostingCoverage,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { rateLimiters } from "@/lib/rate-limit";
import { POST } from "../route";

const BOOKING_ID = "booking-1";
const GUEST_ID = "guest-1";
const TARGET_ID = "member-target";
const DELEGATE_ID = "member-delegate";
const STRANGER_ID = "member-stranger";
const OWNER_ID = "member-owner";

/** The ordinary row this endpoint exists to answer: a live, unanswered ask. */
const PENDING_GUEST = {
  id: GUEST_ID,
  memberId: TARGET_ID,
  consentStatus: "PENDING",
  consentExpiresAt: new Date("2026-08-20T00:00:00.000Z"),
  bookingId: BOOKING_ID,
};

function makeRequest(body: unknown, raw?: string) {
  return new NextRequest(
    `http://localhost/api/bookings/${BOOKING_ID}/guests/${GUEST_ID}/consent`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw ?? JSON.stringify(body),
    },
  );
}

function callRoute(
  request: NextRequest,
  ids: { id?: string; guestId?: string } = {},
) {
  return POST(request, {
    params: Promise.resolve({
      id: ids.id ?? BOOKING_ID,
      guestId: ids.guestId ?? GUEST_ID,
    }),
  });
}

/** Status plus the response's exact bytes, which is what uniformity means here. */
async function answer(
  action: unknown = "APPROVE",
  ids: { id?: string; guestId?: string } = {},
) {
  const res = await callRoute(makeRequest({ action }), ids);
  return { status: res.status, body: await res.text() };
}

/**
 * Make one request see one guest row.
 *
 * `mockResolvedValueOnce` would be wrong here and the mistake is easy to make:
 * the row is read TWICE per request — once by the route, to learn the target's
 * id before a decline deletes it, and once by the service, which re-reads it to
 * authorize — so a one-shot mock leaves the second read on the default PENDING
 * row and quietly turns a refusal case into an approval.
 */
function withGuestRow(row: unknown) {
  h.guestFindUnique.mockResolvedValue(row);
}

beforeEach(() => {
  vi.clearAllMocks();

  h.applyRateLimit.mockResolvedValue(null);
  h.auth.mockResolvedValue({ user: { id: TARGET_ID } });
  h.requireActiveSessionUser.mockResolvedValue(null);
  h.isEffectiveModuleEnabled.mockResolvedValue(true);

  h.guestFindUnique.mockResolvedValue({ ...PENDING_GUEST });
  h.guestUpdateMany.mockResolvedValue({ count: 1 });
  h.txBookingFindUnique.mockResolvedValue({ id: BOOKING_ID, lodgeId: "lodge-1" });
  h.getDefaultLodgeId.mockResolvedValue("lodge-default");
  h.acquireLodgeCapacityLock.mockResolvedValue(undefined);
  h.removeBookingGuestInTransaction.mockResolvedValue({
    accountCreditAmountCents: 4500,
  });
  h.canRespondForTarget.mockResolvedValue(false);
  h.resolveNotificationRecipients.mockResolvedValue([]);

  // Post-commit reads: the outcome email needs the booking and the target's
  // Member row, because a successful decline has already deleted the guest row.
  h.bookingFindUnique.mockResolvedValue({
    id: BOOKING_ID,
    lodgeId: "lodge-1",
    checkIn: new Date("2026-09-01T00:00:00.000Z"),
    checkOut: new Date("2026-09-03T00:00:00.000Z"),
    member: {
      id: OWNER_ID,
      email: "owner@example.com",
      firstName: "Olive",
      lastName: "Owner",
    },
  });
  h.memberFindUnique.mockResolvedValue({
    id: TARGET_ID,
    email: "target@example.com",
    firstName: "Nadia",
    lastName: "Ngata",
  });

  h.transaction.mockImplementation(
    async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        $executeRaw: h.executeRaw,
        booking: { findUnique: h.txBookingFindUnique },
        bookingGuest: { updateMany: h.guestUpdateMany },
      }),
  );
});

describe("the uniform 403 (IDOR)", () => {
  it("answers every failure situation with the identical status AND bytes", async () => {
    // (1) No such guest row.
    withGuestRow(null);
    const missingGuest = await answer();

    // (2) A real row, but on somebody else's booking — the pairing an attacker
    // walking booking ids against a known guest id would probe.
    withGuestRow({ ...PENDING_GUEST, bookingId: "booking-somebody-else" });
    const wrongBooking = await answer();

    // (3) A real row on the right booking that is not a member guest at all
    // (a plain named guest has no memberId, so there is nobody to consent).
    withGuestRow({ ...PENDING_GUEST, memberId: null });
    const notAMemberGuest = await answer();

    // (4) Already answered. Indistinguishable from "not yours" on purpose:
    // otherwise the endpoint reports who is on which booking.
    withGuestRow({ ...PENDING_GUEST, consentStatus: "CONFIRMED" });
    const alreadyResolved = await answer();

    // (5) A signed-in member who is neither the target nor an accepted family
    // delegate.
    withGuestRow({ ...PENDING_GUEST });
    h.auth.mockResolvedValue({ user: { id: STRANGER_ID } });
    h.canRespondForTarget.mockResolvedValue(false);
    const notEntitled = await answer();

    const all = [
      missingGuest,
      wrongBooking,
      notAMemberGuest,
      alreadyResolved,
      notEntitled,
    ];
    // Byte-compared, not status-compared: a future 404, or a kinder message on
    // any one of these, fails here.
    for (const outcome of all) {
      expect(outcome).toEqual({ status: 403, body: '{"error":"Forbidden"}' });
      expect(outcome).toEqual(all[0]);
    }
  });

  it("writes nothing on any of those refusals", async () => {
    for (const guest of [
      null,
      { ...PENDING_GUEST, bookingId: "booking-somebody-else" },
      { ...PENDING_GUEST, memberId: null },
      { ...PENDING_GUEST, consentStatus: "DECLINED" },
    ]) {
      vi.clearAllMocks();
      h.applyRateLimit.mockResolvedValue(null);
      h.auth.mockResolvedValue({ user: { id: TARGET_ID } });
      h.requireActiveSessionUser.mockResolvedValue(null);
      h.isEffectiveModuleEnabled.mockResolvedValue(true);
      withGuestRow(guest);

      const { status } = await answer();
      expect(status).toBe(403);
      // No claim, no removal, no audit entry and no email: a refused caller
      // must not be able to tell from a side effect what they could not tell
      // from the response.
      expect(h.guestUpdateMany).not.toHaveBeenCalled();
      expect(h.removeBookingGuestInTransaction).not.toHaveBeenCalled();
      expect(h.logAudit).not.toHaveBeenCalled();
      expect(h.sendOutcomeEmail).not.toHaveBeenCalled();
    }
  });

  it("gives a probe on a made-up guest id the same answer as a real settled one", async () => {
    // The pair the delegate page's Playwright probe proves in the browser,
    // proved here at the layer where the decision is made.
    withGuestRow(null);
    const fabricated = await answer("APPROVE", { guestId: "does-not-exist" });

    withGuestRow({ ...PENDING_GUEST, consentStatus: "CONFIRMED" });
    h.auth.mockResolvedValue({ user: { id: OWNER_ID } });
    const realButSettled = await answer();

    expect(fabricated).toEqual(realButSettled);
  });
});

describe("the module gate", () => {
  it("refuses with the same 403 when the member-guests module is off", async () => {
    h.isEffectiveModuleEnabled.mockResolvedValue(false);
    expect(await answer()).toEqual({ status: 403, body: '{"error":"Forbidden"}' });
  });

  it("reads no guest row at all when the module is off", async () => {
    // The gate sits BEFORE the guest read on purpose: a club with the module off
    // has no consent requests, so the endpoint must not even look one up.
    h.isEffectiveModuleEnabled.mockResolvedValue(false);
    await answer();
    expect(h.guestFindUnique).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("asks about the member-guests module specifically", async () => {
    await answer();
    expect(h.isEffectiveModuleEnabled).toHaveBeenCalledWith("memberGuests");
  });
});

describe("the rate limiter", () => {
  it("applies the member-guest consent bucket to the incoming request", async () => {
    const request = makeRequest({ action: "APPROVE" });
    await callRoute(request);
    expect(h.applyRateLimit).toHaveBeenCalledTimes(1);
    expect(h.applyRateLimit).toHaveBeenCalledWith(
      rateLimiters.memberGuestConsentRespond,
      request,
    );
  });

  it("uses the bucket the limiter table declares for this endpoint", async () => {
    // Pinned because volume is the only way to probe a uniform-403 endpoint at
    // all, and this allowance is what makes that uneconomic.
    expect(rateLimiters.memberGuestConsentRespond).toMatchObject({
      id: "member-guest-consent-respond",
      limit: 30,
      windowSeconds: 15 * 60,
      authSensitive: true,
    });
  });

  it("returns the limiter's own response and does no other work", async () => {
    h.applyRateLimit.mockResolvedValue(
      new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 }),
    );
    const res = await callRoute(makeRequest({ action: "APPROVE" }));
    expect(res.status).toBe(429);
    // The limiter runs before the session read, so a flood cannot be used to
    // hammer the session store either.
    expect(h.auth).not.toHaveBeenCalled();
    expect(h.guestFindUnique).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });
});

describe("session and input guards", () => {
  it("returns 401 to a caller with no session", async () => {
    h.auth.mockResolvedValue(null);
    const res = await callRoute(makeRequest({ action: "APPROVE" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorised" });
    expect(h.guestFindUnique).not.toHaveBeenCalled();
  });

  it("hands back whatever the deactivated-account guard decides", async () => {
    h.requireActiveSessionUser.mockResolvedValue(
      new Response(JSON.stringify({ error: "Account is deactivated" }), {
        status: 403,
      }),
    );
    const res = await callRoute(makeRequest({ action: "APPROVE" }));
    expect(res.status).toBe(403);
    expect(h.guestFindUnique).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing action", {}],
    ["a lower-case action", { action: "approve" }],
    ["an unknown action", { action: "MAYBE" }],
    ["a non-string action", { action: 1 }],
  ])("rejects %s with 400 and touches no row", async (_label, body) => {
    const res = await callRoute(makeRequest(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "action must be 'APPROVE' or 'DECLINE'",
    });
    expect(h.guestFindUnique).not.toHaveBeenCalled();
  });

  it("rejects an unparseable body with the same 400", async () => {
    const res = await callRoute(makeRequest(undefined, "{ not json"));
    expect(res.status).toBe(400);
    expect(h.guestFindUnique).not.toHaveBeenCalled();
  });
});

describe("APPROVE", () => {
  it("confirms the target's own place and reports it", async () => {
    const res = await callRoute(makeRequest({ action: "APPROVE" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "APPROVED" });

    // The status-guarded claim, not a bare update by id: that guard is the whole
    // idempotency story (two delegates answering at once resolve to one winner).
    expect(h.guestUpdateMany).toHaveBeenCalledTimes(1);
    const claim = h.guestUpdateMany.mock.calls[0][0];
    expect(claim.where).toEqual({ id: GUEST_ID, consentStatus: "PENDING" });
    expect(claim.data).toMatchObject({
      consentStatus: "CONFIRMED",
      consentRespondedByMemberId: TARGET_ID,
    });

    // An approval adds a real guest, and only this call site gives them a bed.
    expect(h.reconcileBedAllocationsForBooking).toHaveBeenCalledWith({
      bookingId: BOOKING_ID,
    });
    expect(h.removeBookingGuestInTransaction).not.toHaveBeenCalled();
    expect(h.enqueueHostingCoverage).toHaveBeenCalledWith(
      TARGET_ID,
      expect.any(Object),
      // #3123: the club's day, resolved before the transaction opened.
      expect.any(Date),
      { cause: "SYSTEM_CHANGE", actorMemberId: TARGET_ID },
    );
    expect(h.settleHostingCoverage).toHaveBeenCalledWith({
      bookingId: BOOKING_ID,
    });
    expect(h.sendOutcomeEmail).toHaveBeenCalledTimes(1);
    expect(h.logAudit).toHaveBeenCalledTimes(1);
    expect(h.logAudit.mock.calls[0][0]).toMatchObject({
      action: "member_guest_consent_approved",
      entityId: GUEST_ID,
      subjectMemberId: TARGET_ID,
    });
  });

  it("lets an accepted family delegate approve on the target's behalf", async () => {
    h.auth.mockResolvedValue({ user: { id: DELEGATE_ID } });
    h.canRespondForTarget.mockResolvedValue(true);

    const res = await callRoute(makeRequest({ action: "APPROVE" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "APPROVED" });
    expect(h.canRespondForTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        actorMemberId: DELEGATE_ID,
        targetMemberId: TARGET_ID,
      }),
    );
    // The responder recorded is the person who actually answered.
    expect(h.guestUpdateMany.mock.calls[0][0].data.consentRespondedByMemberId).toBe(
      DELEGATE_ID,
    );
    expect(h.enqueueHostingCoverage).toHaveBeenCalledWith(
      TARGET_ID,
      expect.any(Object),
      // #3123: the club's day, resolved before the transaction opened.
      expect.any(Date),
      { cause: "SYSTEM_CHANGE", actorMemberId: DELEGATE_ID },
    );
    expect(h.settleHostingCoverage).toHaveBeenCalledWith({
      bookingId: BOOKING_ID,
    });
  });

  it("reports a lost claim as success, with no second set of side effects", async () => {
    // Somebody got there first. Reporting an error would invite a retry loop
    // against a terminal state.
    h.guestUpdateMany.mockResolvedValue({ count: 0 });
    const res = await callRoute(makeRequest({ action: "APPROVE" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "ALREADY_RESOLVED" });
    expect(h.sendOutcomeEmail).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
    expect(h.reconcileBedAllocationsForBooking).not.toHaveBeenCalled();
  });
});

describe("DECLINE", () => {
  it("releases the held place through the shared removal path", async () => {
    const res = await callRoute(makeRequest({ action: "DECLINE" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "DECLINED" });

    expect(h.guestUpdateMany.mock.calls[0][0].data).toMatchObject({
      consentStatus: "DECLINED",
      consentRespondedByMemberId: TARGET_ID,
    });
    // ONE removal semantics: a decline goes through the same path a member's own
    // self-removal uses, carrying the consent authority that permits it.
    expect(h.removeBookingGuestInTransaction).toHaveBeenCalledTimes(1);
    expect(h.removeBookingGuestInTransaction.mock.calls[0][0]).toMatchObject({
      bookingId: BOOKING_ID,
      guestId: GUEST_ID,
      actorRole: "MEMBER",
      consentAuthority: {
        kind: "CONSENT_DECLINE",
        guestId: GUEST_ID,
        targetMemberId: TARGET_ID,
      },
    });
    expect(h.logAudit.mock.calls[0][0]).toMatchObject({
      action: "member_guest_consent_declined",
      outcome: "success",
    });
  });

  it("reports a refused decline as a 400 carrying the removal path's own words", async () => {
    // D-14: a member who never consented is still subject to the ordinary
    // self-removal blockers, and the honest answer is the real sentence.
    h.removeBookingGuestInTransaction.mockRejectedValue(
      new h.TestRemovalError("Cannot remove the last guest from a booking"),
    );
    const res = await callRoute(makeRequest({ action: "DECLINE" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      outcome: "BLOCKED",
      consentStatus: "DECLINED",
      reason: "LAST_GUEST",
      error: "Cannot remove the last guest from a booking",
    });
    // A blocked row needs a human, so it is audited as important-and-failed.
    expect(h.logAudit.mock.calls[0][0]).toMatchObject({
      severity: "important",
      outcome: "failure",
    });
  });
});
