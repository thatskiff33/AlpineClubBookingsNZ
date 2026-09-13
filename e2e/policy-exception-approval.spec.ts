import { type APIRequestContext, type BrowserContext, expect, test } from "@playwright/test";

import { storageStatePath } from "./helpers/auth";
import { E2E_ADMIN, WAITLIST_FULL_WINDOW } from "./helpers/fixtures";
import { personas } from "./helpers/personas";
import {
  cancelMemberBookingsOnDate,
  cancelOpenExceptionRequests,
  deactivateMinimumStayPolicies,
} from "./helpers/reset";
import { oneNightCheckOut, stayWindowForAttempt } from "./helpers/stay-dates";

/**
 * TLR-8C (#2526) — the booking-policy exception REQUEST → APPROVE → EXECUTE
 * round trip, end to end against the real app.
 *
 * The two rows the acceptance criteria name:
 *  1. HAPPY PATH — a member is stopped by the minimum-stay rule, asks an admin,
 *     and the approval CREATES THE BOOKING. Approving is not a status flip, so
 *     the assertion is that a real booking exists for the member afterwards.
 *  2. NO_HOLD CAPACITY CONFLICT — a NO_HOLD request reserves nothing while it
 *     waits, so the lodge can fill underneath it. Approving one that no longer
 *     fits must leave it PENDING and say so — never approve it, never oversell.
 *     The seeded-full waitlist window is a lodge that cannot fit it.
 *
 * The state-changing steps go through the product's own APIs rather than the
 * booking wizard: the member-facing request UI is #2524's coverage, and driving
 * the decision by API keeps THIS spec about the approval semantics (capacity,
 * pending-versus-approved, the guarded version claim) instead of form clicking.
 * One UI assertion still opens the officer queue, because "the queue shows the
 * request age and the frozen evidence" is itself an acceptance criterion.
 */

test.describe.configure({ mode: "serial" });

const POLICY_NAME = "E2E policy-exception minimum stay";
const MEMBER_NAME = `${personas.booker.firstName} ${personas.booker.lastName}`;

let adminContext: BrowserContext;
let memberContext: BrowserContext;
let admin: APIRequestContext;
let memberId: string;

/** Take this spec's club-wide minimum-stay rule back down. Safe to re-run. */
async function deleteSpecPolicies(api: APIRequestContext) {
  await deactivateMinimumStayPolicies(api, { namePrefix: POLICY_NAME });
}

/**
 * Withdraw every open exception request this member left behind.
 *
 * The loop itself is the shared `cancelOpenExceptionRequests` helper (#2562): the
 * member read now answers the member DTO, whose `status` is the member's own word
 * rather than the Prisma enum, so a locally-copied `status === "REQUESTED"` check
 * would match nothing and clean up nothing.
 */
async function cancelOpenRequestsFor(
  member: APIRequestContext,
  memberEmailId: string,
) {
  expect(memberEmailId).toBeTruthy();
  await cancelOpenExceptionRequests(member);
}

async function memberIdFor(api: APIRequestContext, email: string): Promise<string> {
  const response = await api.get(
    `/api/admin/members?search=${encodeURIComponent(email)}&pageSize=5`,
  );
  expect(response.ok(), `admin member search for ${email}`).toBeTruthy();
  const body = (await response.json()) as {
    members: Array<{ id: string; email: string }>;
  };
  const member = body.members.find(
    (row) => row.email.toLowerCase() === email.toLowerCase(),
  );
  expect(member, `${email} must exist in the seeded database`).toBeTruthy();
  return (member as { id: string }).id;
}

type QueueRow = {
  id: string;
  version: number;
  source: string;
  reasonCodes: string[];
  aggregateCapacityMode: string;
  conflictCount: number;
};

async function queueItem(
  api: APIRequestContext,
  requestId: string,
): Promise<QueueRow | undefined> {
  const response = await api.get(
    "/api/admin/booking-exception-requests?status=REQUESTED&pageSize=100",
  );
  expect(response.ok(), "officer exception queue must load").toBeTruthy();
  const body = (await response.json()) as { data: QueueRow[] };
  return body.data.find((row) => row.id === requestId);
}

async function submitOneNightRequest(
  member: APIRequestContext,
  checkIn: string,
  checkOut: string,
  message: string,
) {
  return member.post("/api/bookings/exception-requests", {
    data: {
      checkIn,
      checkOut,
      guests: [
        {
          firstName: personas.booker.firstName,
          lastName: personas.booker.lastName,
          ageTier: "ADULT",
          isMember: true,
          memberId,
        },
      ],
      memberMessage: message,
    },
  });
}

test.beforeAll(async ({ browser }) => {
  adminContext = await browser.newContext({
    storageState: storageStatePath(E2E_ADMIN.email),
  });
  memberContext = await browser.newContext({
    storageState: storageStatePath(personas.booker.email),
  });
  admin = adminContext.request;
  memberId = await memberIdFor(admin, personas.booker.email);

  // Idempotent setup (#2302): a retry re-runs the whole serial group against the
  // database the failed attempt left behind, so clear this spec's own leftovers
  // before creating them again. A clean first attempt clears nothing.
  await deleteSpecPolicies(admin);
  await cancelOpenRequestsFor(memberContext.request, memberId);

  // A NO_HOLD two-night minimum across every day, spanning the whole seeded
  // season band. NO_HOLD on purpose: it is the mode whose approval RECHECKS
  // capacity (the second row under test), and it reserves nothing, so the two
  // tests below cannot starve each other of beds.
  const created = await admin.post("/api/admin/booking-policies/minimum-stay", {
    data: {
      name: POLICY_NAME,
      startDate: "2020-01-01",
      endDate: "2099-12-31",
      triggerDays: [0, 1, 2, 3, 4, 5, 6],
      minimumNights: 2,
      capacityMode: "NO_HOLD",
      active: true,
    },
  });
  expect(
    created.ok(),
    `minimum-stay policy create: ${created.status()} ${await created.text()}`,
  ).toBeTruthy();
});

test.afterAll(async () => {
  if (admin) {
    await cancelOpenRequestsFor(memberContext.request, memberId);
    await deleteSpecPolicies(admin);
  }
  await adminContext?.close();
  await memberContext?.close();
});

test("a refused one-night stay becomes a request an officer approves — and the booking exists", async ({}, testInfo) => {
  const window = stayWindowForAttempt(21, testInfo.retry);
  const checkIn = window.checkIn;
  const checkOut = oneNightCheckOut(window);

  // A retry must start from the same place: clear any booking a failed attempt
  // left on this window before asking for it again.
  await cancelMemberBookingsOnDate(admin, { memberName: MEMBER_NAME, checkIn });

  // 1. The member asks. The proposal is frozen server-side; the client's claimed
  //    violations are never trusted.
  const submitted = await submitOneNightRequest(
    memberContext.request,
    checkIn,
    checkOut,
    "Only free for the one night — happy to pay the full two-night rate.",
  );
  expect(
    submitted.status(),
    `exception request create: ${await submitted.text()}`,
  ).toBe(201);
  const request = (await submitted.json()) as {
    id: string;
    reasonCodes: string[];
    aggregateCapacityMode: string;
  };
  expect(request.reasonCodes).toContain("MINIMUM_STAY");
  expect(request.aggregateCapacityMode).toBe("NO_HOLD");

  // 2. It reaches the officer queue carrying the version a decision needs.
  const queued = await queueItem(admin, request.id);
  expect(queued, "the request must appear in the officer queue").toBeTruthy();
  expect(queued?.source).toBe("NEW_BOOKING");
  expect(queued?.reasonCodes).toContain("MINIMUM_STAY");

  // 3. The queue SCREEN shows it with its age and the rule it breaks.
  const page = await adminContext.newPage();
  await page.goto("/admin/booking-requests?tab=exceptions");
  await expect(page.getByText("Rules this request breaks").first()).toBeVisible();
  await expect(page.getByText(/asked (just now|\d+ min ago)/).first()).toBeVisible();
  await expect(page.getByText("Minimum stay").first()).toBeVisible();
  await page.close();

  // 4. An approval that was not explicitly confirmed is refused outright.
  const unconfirmed = await admin.patch(
    `/api/admin/booking-exception-requests/${request.id}`,
    {
      data: {
        action: "approve",
        source: "NEW_BOOKING",
        expectedVersion: queued?.version,
      },
    },
  );
  expect(unconfirmed.status()).toBe(400);

  // 5. The officer approves. This EXECUTES the reviewed proposal.
  const approved = await admin.patch(
    `/api/admin/booking-exception-requests/${request.id}`,
    {
      data: {
        action: "approve",
        source: "NEW_BOOKING",
        expectedVersion: queued?.version,
        confirm: true,
        adminNotes: "One-off — the lodge is quiet that week.",
      },
    },
  );
  expect(approved.status(), `approve: ${await approved.text()}`).toBe(200);
  const outcome = (await approved.json()) as {
    status: string;
    createdBookingId: string | null;
  };
  expect(outcome.status).toBe("APPROVED");
  expect(
    outcome.createdBookingId,
    "approving a new-booking exception must CREATE the booking, not merely mark the request approved",
  ).toBeTruthy();

  // 6. A second decision on the same (now stale) version cannot re-approve it —
  //    the guarded version claim is the single-flight.
  const replay = await admin.patch(
    `/api/admin/booking-exception-requests/${request.id}`,
    {
      data: {
        action: "approve",
        source: "NEW_BOOKING",
        expectedVersion: queued?.version,
        confirm: true,
      },
    },
  );
  expect(replay.status()).toBe(409);

  // 7. The booking really exists, owned by the member who asked, on the night
  //    they asked for — and clearing it proves it was there.
  const cleared = await cancelMemberBookingsOnDate(admin, {
    memberName: MEMBER_NAME,
    checkIn,
  });
  expect(
    cleared,
    "the approval must have left a real booking for the member on that night",
  ).toBeGreaterThan(0);
});

test("a NO_HOLD request the lodge can no longer fit stays PENDING, never approved", async () => {
  // The seeded-full window: 22 guests already hold every bed there.
  const checkIn = WAITLIST_FULL_WINDOW.checkIn;
  const checkOut = oneNightCheckOut(WAITLIST_FULL_WINDOW);

  const submitted = await submitOneNightRequest(
    memberContext.request,
    checkIn,
    checkOut,
    "Would take a single night if anything opens up.",
  );
  expect(
    submitted.status(),
    `exception request create on the full window: ${await submitted.text()}`,
  ).toBe(201);
  const request = (await submitted.json()) as { id: string };

  const queued = await queueItem(admin, request.id);
  expect(queued?.aggregateCapacityMode).toBe("NO_HOLD");

  const approved = await admin.patch(
    `/api/admin/booking-exception-requests/${request.id}`,
    {
      data: {
        action: "approve",
        source: "NEW_BOOKING",
        expectedVersion: queued?.version,
        confirm: true,
      },
    },
  );
  // Kept pending, in those words — reported as a conflict, never as a success.
  expect(approved.status()).toBe(409);
  const body = (await approved.json()) as {
    status: string;
    keptPending: boolean;
    error: string;
  };
  expect(body.status).toBe("REQUESTED");
  expect(body.keptPending).toBe(true);
  expect(body.error).toMatch(/room/i);

  // The request is STILL OPEN — a capacity conflict does not fail it — and the
  // attempt was recorded so the queue can explain why it has not executed.
  const stillQueued = await queueItem(admin, request.id);
  expect(
    stillQueued,
    "a kept-pending request stays in the REQUESTED queue",
  ).toBeTruthy();
  expect(stillQueued?.conflictCount).toBeGreaterThan(0);
  // Nothing was created: no booking exists for the member on that night.
  const strayBookings = await cancelMemberBookingsOnDate(admin, {
    memberName: MEMBER_NAME,
    checkIn,
  });
  expect(
    strayBookings,
    "a kept-pending approval must not have created a booking",
  ).toBe(0);

  // The officer refuses it instead. A refusal always carries a reason.
  const noReason = await admin.patch(
    `/api/admin/booking-exception-requests/${request.id}`,
    {
      data: {
        action: "reject",
        source: "NEW_BOOKING",
        expectedVersion: stillQueued?.version,
      },
    },
  );
  expect(noReason.status()).toBe(400);

  const refused = await admin.patch(
    `/api/admin/booking-exception-requests/${request.id}`,
    {
      data: {
        action: "reject",
        source: "NEW_BOOKING",
        expectedVersion: stillQueued?.version,
        adminNotes: "That week is full every year — sorry.",
      },
    },
  );
  expect(refused.status(), `reject: ${await refused.text()}`).toBe(200);
  expect((await refused.json()).status).toBe("REJECTED");
  expect(await queueItem(admin, request.id)).toBeUndefined();
});
