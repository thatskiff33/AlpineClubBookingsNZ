import { type APIRequestContext, type BrowserContext, expect, test } from "../helpers/accessibility";

import { loginPersona } from "../helpers/auth";
import { E2E_ADMIN, SECOND_LODGE, WAITLISTER } from "../helpers/fixtures";
import {
  cancelMemberBookingsOnDate,
  cancelOpenExceptionRequests,
  deactivateMinimumStayPolicies,
} from "../helpers/reset";
import { stayWindow } from "../helpers/stay-dates";

/**
 * Multi-lodge coverage for TLR-8C (#2526): a booking-policy exception is decided
 * and EXECUTED at the lodge it was frozen against.
 *
 * The failure this exists to catch is a lodge leak — a rule configured for one
 * lodge stopping bookings at another, or an approval creating the booking at the
 * club's default lodge because that is what a missing `lodgeId` falls back to.
 * The proposal freezes its lodge, and the approval's capacity recheck and
 * canonical create must both use THAT lodge.
 *
 * Runs only in the `multi-lodge` project (E2E_MULTI_LODGE=1), which has no auth
 * setup dependency, so both actors log in for themselves.
 *
 * Retry idempotency (#2302, docs/E2E_PLAYWRIGHT.md): every attempt takes its own
 * stay window and its own policy NAME, and clears both before it starts. Stay
 * indices 0-9 belong to other specs, 11-12 to the whole-lodge spec, 13-18 to the
 * consent spec and 19-24 to the member-guest edit spec; 25-27 are this file's,
 * one per attempt.
 */

test.describe.configure({ mode: "serial" });

// A PREFIX, not the name: each attempt appends its own suffix, because a second
// ACTIVE policy sharing a (scope, name) pair is refused outright (#2363). One
// prefix-matched reset therefore clears every attempt's leftovers.
const POLICY_NAME_PREFIX = "E2E lodge-B policy exception minimum stay";
const MEMBER_NAME = `${WAITLISTER.firstName} ${WAITLISTER.lastName}`;

let adminContext: BrowserContext;
let memberContext: BrowserContext;
let admin: APIRequestContext;
let lodgeAId: string;
let lodgeBId: string;
let memberId: string;

type ListedBooking = {
  id: string;
  memberName: string;
  checkIn: string;
  status: string;
  deletedAt: string | null;
};

/**
 * The bookings the admin calendar reports for ONE lodge in one month.
 *
 * The calendar list projects no lodge of its own (src/app/api/admin/bookings
 * /route.ts returns id, member, dates, status and guest count), so the lodge is
 * read the way the product reads it: through the route's own `lodgeId` filter,
 * which is an EXACT per-lodge match — `lodgeNullTolerantScope` is now a plain
 * `{ lodgeId }` because `Booking.lodgeId` is NOT NULL (src/lib/lodges.ts). Asking
 * both lodges the same question therefore proves the lodge from two sides, and
 * the default-lodge fallback this spec exists to catch appears as the exact
 * inverse.
 */
async function bookingsAtLodge(
  calendarMonth: string,
  lodgeId: string,
): Promise<ListedBooking[]> {
  const listed = await admin.get(
    `/api/admin/bookings?calendarMonth=${calendarMonth}` +
      `&status=PAYMENT_PENDING,PENDING&lodgeId=${encodeURIComponent(lodgeId)}`,
  );
  expect(
    listed.ok(),
    `admin bookings list for lodge ${lodgeId}: ${listed.status()} ${await listed.text()}`,
  ).toBeTruthy();
  return ((await listed.json()) as { bookings: ListedBooking[] }).bookings;
}

/** This member's live bookings checking in on `checkIn`, at one lodge. */
function ownBookingsOnNight(
  bookings: ListedBooking[],
  { bookingId, checkIn }: { bookingId: string | null; checkIn: string },
) {
  return bookings.filter(
    (booking) =>
      !booking.deletedAt &&
      (booking.id === bookingId ||
        (booking.memberName === MEMBER_NAME && booking.checkIn === checkIn)),
  );
}

/**
 * Withdraw every open exception request this member left behind, through the
 * shared helper (#2562) — the member read answers the member DTO now, whose
 * `status` is the member's own word rather than the Prisma enum, so a local
 * `status === "REQUESTED"` loop would clean up nothing while reporting success.
 */
async function cancelOpenRequests(member: APIRequestContext) {
  await cancelOpenExceptionRequests(member);
}

test.beforeAll(async ({ browser }) => {
  // A fresh login incl. first-time two-factor enrollment needs more than the
  // default hook budget on a loaded CI runner.
  test.setTimeout(240_000);

  adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await loginPersona(adminPage, E2E_ADMIN.email);
  await adminPage.close();
  admin = adminContext.request;

  memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await loginPersona(memberPage, WAITLISTER.email);
  await memberPage.close();

  const lodges = await memberContext.request.get("/api/lodges");
  expect(lodges.ok(), "/api/lodges must succeed for a signed-in member").toBeTruthy();
  const body = (await lodges.json()) as { lodges: Array<{ id: string; name: string }> };
  const lodgeB = body.lodges.find((lodge) => lodge.name === SECOND_LODGE.name);
  // Lodge A is the club's ORIGINAL lodge, and the seed refuses to run unless it
  // is still the club default (e2e/setup/seed-second-lodge.ts) — so it is the
  // lodge a missing `lodgeId` would fall back to, and the one the negative
  // assertion below has to be made against.
  const lodgeA = body.lodges.find((lodge) => lodge.name !== SECOND_LODGE.name);
  expect(
    lodgeA && lodgeB,
    `both lodges must be bookable by the member: ${JSON.stringify(body.lodges)}`,
  ).toBeTruthy();
  lodgeAId = (lodgeA as { id: string }).id;
  lodgeBId = (lodgeB as { id: string }).id;

  const members = await admin.get(
    `/api/admin/members?search=${encodeURIComponent(WAITLISTER.email)}&pageSize=5`,
  );
  expect(members.ok()).toBeTruthy();
  const memberBody = (await members.json()) as {
    members: Array<{ id: string; email: string }>;
  };
  memberId = (
    memberBody.members.find(
      (row) => row.email.toLowerCase() === WAITLISTER.email.toLowerCase(),
    ) as { id: string }
  ).id;
});

test.afterAll(async () => {
  if (admin && lodgeBId) {
    await cancelOpenRequests(memberContext.request);
    await deactivateMinimumStayPolicies(admin, {
      namePrefix: POLICY_NAME_PREFIX,
      lodgeId: lodgeBId,
    });
  }
  await adminContext?.close();
  await memberContext?.close();
});

test("an exception raised at the second lodge is approved and executed AT that lodge", async ({}, testInfo) => {
  // A window and a policy name PER ATTEMPT (#2302): attempt 0 leaves a real
  // lodge-B booking and an active lodge-B rule behind whenever it fails after the
  // approval, and a retry that reused either would fail on the leftover rather
  // than on the behaviour.
  const window = stayWindow(25 + testInfo.retry);
  const checkIn = window.checkIn;
  const checkOut = window.nights[1]; // one night, so the two-night minimum bites
  const policyName = `${POLICY_NAME_PREFIX} (attempt ${testInfo.retry})`;

  // Idempotent setup, re-run on every attempt: clear this spec's own leftovers
  // at BOTH lodges before asking for the night again. A clean first attempt
  // clears nothing.
  await deactivateMinimumStayPolicies(admin, {
    namePrefix: POLICY_NAME_PREFIX,
    lodgeId: lodgeBId,
  });
  await cancelOpenRequests(memberContext.request);
  await cancelMemberBookingsOnDate(admin, { memberName: MEMBER_NAME, checkIn });

  // Two-night minimum AT LODGE B ONLY. A per-lodge row REPLACES the club-wide
  // set for that lodge, so lodge A is untouched by it.
  const created = await admin.post("/api/admin/booking-policies/minimum-stay", {
    data: {
      name: policyName,
      startDate: "2020-01-01",
      endDate: "2099-12-31",
      triggerDays: [0, 1, 2, 3, 4, 5, 6],
      minimumNights: 2,
      capacityMode: "NO_HOLD",
      active: true,
      lodgeId: lodgeBId,
    },
  });
  expect(
    created.ok(),
    `lodge-B minimum-stay policy create: ${created.status()} ${await created.text()}`,
  ).toBeTruthy();

  const submitted = await memberContext.request.post(
    "/api/bookings/exception-requests",
    {
      data: {
        lodgeId: lodgeBId,
        checkIn,
        checkOut,
        guests: [
          {
            firstName: WAITLISTER.firstName,
            lastName: WAITLISTER.lastName,
            ageTier: "ADULT",
            isMember: true,
            memberId,
          },
        ],
        memberMessage: "One night at the second lodge, driving back the next day.",
      },
    },
  );
  expect(
    submitted.status(),
    `lodge-B exception request: ${await submitted.text()}`,
  ).toBe(201);
  const request = (await submitted.json()) as { id: string; reasonCodes: string[] };
  expect(request.reasonCodes).toContain("MINIMUM_STAY");

  const queue = await admin.get(
    "/api/admin/booking-exception-requests?status=REQUESTED&pageSize=100",
  );
  expect(queue.ok()).toBeTruthy();
  const queued = ((await queue.json()) as {
    data: Array<{ id: string; version: number; lodgeId: string | null }>;
  }).data.find((row) => row.id === request.id);
  expect(queued, "the lodge-B request must reach the officer queue").toBeTruthy();
  // The queue reports the lodge the proposal was FROZEN against, not the club default.
  expect(queued?.lodgeId).toBe(lodgeBId);

  const approved = await admin.patch(
    `/api/admin/booking-exception-requests/${request.id}`,
    {
      data: {
        action: "approve",
        source: "NEW_BOOKING",
        expectedVersion: queued?.version,
        confirm: true,
        adminNotes: "Second lodge has room; one night is fine there.",
      },
    },
  );
  expect(approved.status(), `approve: ${await approved.text()}`).toBe(200);
  const outcome = (await approved.json()) as { createdBookingId: string | null };
  expect(outcome.createdBookingId).toBeTruthy();

  // The booking landed at LODGE B, and nowhere else. Asked of each lodge in turn:
  // exactly the created booking at lodge B, nothing at all at lodge A — which is
  // where a missing or defaulted `lodgeId` would have put it.
  const calendarMonth = checkIn.slice(0, 7);
  const atLodgeB = ownBookingsOnNight(
    await bookingsAtLodge(calendarMonth, lodgeBId),
    { bookingId: outcome.createdBookingId, checkIn },
  );
  expect(
    atLodgeB.map((booking) => booking.id),
    `the approval must have created exactly one booking on that night at ${SECOND_LODGE.name}`,
  ).toEqual([outcome.createdBookingId]);

  const atLodgeA = ownBookingsOnNight(
    await bookingsAtLodge(calendarMonth, lodgeAId),
    { bookingId: outcome.createdBookingId, checkIn },
  );
  expect(
    atLodgeA.map((booking) => `${booking.status} ${booking.id}`),
    "no booking may exist at the club's default lodge — an exception frozen " +
      "against the second lodge must not execute anywhere else",
  ).toEqual([]);

  // Clean up so a retry starts from the same place, and prove once more that the
  // booking was really there (the reset verifies its own post-condition).
  const cleared = await cancelMemberBookingsOnDate(admin, {
    memberName: MEMBER_NAME,
    checkIn,
  });
  expect(
    cleared,
    "the approval must have left exactly one real booking on that night",
  ).toBe(1);
});
