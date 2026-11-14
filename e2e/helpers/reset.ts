import { expect, type APIRequestContext } from "@playwright/test";

/**
 * RETRY IDEMPOTENCY HELPERS (issue #2302).
 *
 * `playwright.config.ts` sets `retries: 2` in CI. A retry re-runs the test (and,
 * for a `mode: "serial"` group, the WHOLE group) against the database the failed
 * attempt left behind — the suite prepares its seed ONCE per run, never between
 * attempts. So any spec that permanently mutates seeded state on its way to an
 * assertion turns one transient failure into three deterministic ones, and the
 * reported error becomes the pollution rather than the real cause.
 *
 * Three of the flakes in #2302 were exactly this:
 *  - `waitlist.spec.ts:57` — attempt 0 created Wanda's booking on the seeded-full
 *    window, so retries got `BOOKING_MEMBER_NIGHT_CONFLICT` where the spec
 *    asserts `CAPACITY_EXCEEDED`.
 *  - `xero-setup-wizard.spec.ts:48` — attempt 0 advanced the persisted wizard
 *    cursor past step 1, so retries never saw the step-1 heading.
 *  - `stripe-payment.spec.ts:40` — attempt 0 booked the persona onto its stay
 *    window, so retries could not reach the review step at all.
 *
 * The rule these helpers exist to enforce: a spec that mutates state must make
 * its OWN setup idempotent, in a `beforeAll`/`beforeEach` that re-runs on every
 * attempt. Never a sleep, never a retry-count bump, never a loosened assertion.
 * See docs/E2E_PLAYWRIGHT.md → "Retry idempotency".
 */

// Booking statuses this helper clears, all of which `GET /api/admin/bookings`
// can filter on:
//  - the six `POST /api/bookings/<id>/cancel` accepts, and
//  - DRAFT, which cancel REFUSES (it is not in CANCELLABLE_BOOKING_STATUSES,
//    src/lib/booking-cancel.ts) but which does hold a member night while
//    unexpired — it is in MEMBER_NIGHT_CONFLICT_BOOKING_STATUSES. A leftover
//    draft is exactly what an on-behalf/wizard attempt that died before payment
//    leaves behind, so it is cleared through the product's own admin delete
//    (`DELETE /api/bookings/<id>` hard-deletes a draft for an ADMIN actor —
//    src/lib/booking-delete.ts) rather than silently missed.
//
// Known blind spots, none of them reachable from the specs that call this today,
// all of them now VISIBLE rather than silent (the post-condition below re-lists
// and fails if anything it can see survives):
//  - AWAITING_REVIEW: cancellable, and the list route accepts it since #4923, but
//    it is not in CLEARABLE_STATUSES, so a leftover in that status is neither
//    listed nor cleared here. Adding it is an e2e behaviour change that needs the
//    e2e stack to prove. Whole-lodge requests are the only source and that spec
//    does its own cleanup.
//  - COMPLETED: holds a member night and is listable, but nothing can cancel it.
//    Only the completion sweep produces it, and CRON_ENABLED is off in the E2E
//    stack.
//  - Ownership: the list route reports `memberName` for the booking OWNER only
//    (it returns no guest names), so a leftover where this member is a GUEST on
//    someone else's booking cannot be matched. Every caller here books the
//    member as the owner.
const CLEARABLE_STATUSES = [
  "DRAFT",
  "PENDING",
  "PAYMENT_PENDING",
  "CONFIRMED",
  "PAID",
  "WAITLISTED",
  "WAITLIST_OFFERED",
] as const;
const CLEARABLE_STATUS_FILTER = CLEARABLE_STATUSES.join(",");

type ListedBooking = {
  id: string;
  memberName: string;
  checkIn: string;
  status: string;
  deletedAt: string | null;
};

async function listLeftovers(
  adminRequest: APIRequestContext,
  { memberName, calendarMonth, checkIns }: {
    memberName: string;
    calendarMonth: string;
    checkIns: readonly string[];
  },
): Promise<ListedBooking[]> {
  const listed = await adminRequest.get(
    `/api/admin/bookings?calendarMonth=${calendarMonth}&status=${CLEARABLE_STATUS_FILTER}`,
  );
  expect(
    listed.ok(),
    `GET /api/admin/bookings?calendarMonth=${calendarMonth} (${listed.status()})`,
  ).toBeTruthy();

  const body = (await listed.json()) as { bookings: ListedBooking[] };
  return body.bookings.filter(
    (booking) =>
      booking.memberName === memberName &&
      checkIns.includes(booking.checkIn) &&
      !booking.deletedAt,
  );
}

/**
 * Clears every live booking a named member OWNS that checks in on one of the
 * given dates, and returns how many it cleared (0 on a clean first attempt).
 *
 * CANCELLED is outside `MEMBER_NIGHT_CONFLICT_BOOKING_STATUSES`
 * (src/lib/booking-member-night-conflicts.ts) and outside the capacity-holding
 * set, so cancelling restores the pre-attempt invariant for every status the
 * cancel route accepts; a DRAFT, which it refuses, is hard-deleted instead.
 *
 * Both effects are then VERIFIED: the same query is re-run and must come back
 * empty. A silent no-op — a filter that no longer matches the response shape, a
 * status nothing here can clear — would otherwise degrade into exactly the
 * retry pollution this helper exists to prevent, and would do it invisibly.
 *
 * Driven entirely through the admin API the product already exposes: no direct
 * database access is introduced into the Playwright process, and no test-only
 * endpoint is added.
 *
 * @param adminRequest an ADMIN-authenticated request context. Full admin, for
 *   three reasons: the cancel route's `notifyMember` opt-out is
 *   booking-management-admin only; the started-stay block (#2029) is waived for
 *   ADMIN, which a leftover shifted into the past needs; and only an admin may
 *   delete another member's draft.
 * @param checkIn one check-in date, or several (a spec whose booking MOVES can
 *   leave it on any of the dates it moves through).
 */
export async function cancelMemberBookingsOnDate(
  adminRequest: APIRequestContext,
  {
    memberName,
    checkIn,
  }: { memberName: string; checkIn: string | readonly string[] },
): Promise<number> {
  const checkIns = typeof checkIn === "string" ? [checkIn] : [...checkIn];
  const months = [...new Set(checkIns.map((date) => date.slice(0, 7)))];

  let cleared = 0;
  for (const calendarMonth of months) {
    const monthCheckIns = checkIns.filter((date) =>
      date.startsWith(calendarMonth),
    );
    const leftovers = await listLeftovers(adminRequest, {
      memberName,
      calendarMonth,
      checkIns: monthCheckIns,
    });
    if (leftovers.length === 0) continue;

    for (const booking of leftovers) {
      if (booking.status === "DRAFT") {
        const deleted = await adminRequest.delete(`/api/bookings/${booking.id}`);
        expect(
          deleted.ok(),
          `delete leftover DRAFT booking ${booking.id} on ${booking.checkIn} ` +
            `(${deleted.status()}): ${await deleted.text()}`,
        ).toBeTruthy();
        continue;
      }
      // Credit, not card: none of these leftovers has a captured payment, so no
      // provider call is made either way, and `credit` needs no Stripe intent to
      // exist. Note this is NOT necessarily the no-payment fast flip — only
      // WAITLISTED/WAITLIST_OFFERED/AWAITING_REVIEW are in
      // NO_PAYMENT_CANCELLABLE_STATUSES, so a leftover that reached CONFIRMED
      // (e.g. via admin force-confirm) takes the general cancel path. With
      // nothing captured that path still moves no money and calls no provider.
      const cancelled = await adminRequest.post(
        `/api/bookings/${booking.id}/cancel`,
        { data: { refundMethod: "credit", notifyMember: false } },
      );
      expect(
        cancelled.ok(),
        `cancel leftover ${booking.status} booking ${booking.id} on ` +
          `${booking.checkIn} (${cancelled.status()}): ${await cancelled.text()}`,
      ).toBeTruthy();
    }
    cleared += leftovers.length;

    // Post-condition: the leftovers really are gone, not merely "the request
    // returned 200".
    const surviving = await listLeftovers(adminRequest, {
      memberName,
      calendarMonth,
      checkIns: monthCheckIns,
    });
    expect(
      surviving.map((booking) => `${booking.status} ${booking.id} on ${booking.checkIn}`),
      `leftover bookings for ${memberName} survived the reset on ` +
        `${monthCheckIns.join(", ")} — this attempt would run against a dirty ` +
        `database (see docs/E2E_PLAYWRIGHT.md → "Retry idempotency")`,
    ).toEqual([]);
  }

  return cleared;
}

type MinimumStayPolicyRow = {
  id: string;
  name: string;
  active: boolean;
  version: number;
};

/**
 * Deactivates every ACTIVE minimum-stay policy whose name starts with
 * `namePrefix` in one scope, and returns how many it cleared (0 on a clean first
 * attempt).
 *
 * A spec that stands a booking rule UP in order to break it must take it down
 * again, or its own retry cannot stand it up at all: the create route refuses a
 * second ACTIVE policy sharing a (scope, name) pair with 409
 * `POLICY_NAME_CONFLICT` (#2363,
 * `src/app/api/admin/booking-policies/minimum-stay/route.ts`). That is exactly
 * how run 30772673366 turned one real failure into three — both retries died in
 * setup, on the conflict, instead of re-running the behaviour.
 *
 * Two details of the route this drives are easy to get wrong, and both are the
 * reason this lives here rather than in each spec:
 *  - DELETE is a DEACTIVATE (`active: false`), and the create's conflict check is
 *    ACTIVE-only, so deactivating is enough to free the name.
 *  - DELETE REQUIRES the row's `version` in the body. A bodyless call throws on
 *    `request.json()`, answers 500, and leaves the policy active — silently, if
 *    the caller ignores the status.
 * Hence the version, the asserted status, and the verified post-condition.
 *
 * @param adminRequest an ADMIN-authenticated request context (`bookings:edit`).
 * @param namePrefix the spec's own policy-name prefix. Matching on a prefix, not
 *   equality, is what lets a spec give each ATTEMPT its own policy name and still
 *   have one call clear every attempt's leftovers.
 * @param lodgeId the partition to clear: a lodge id for that lodge's override
 *   set, omitted for the club-wide set. The list route matches the partition
 *   EXACTLY — never null-tolerant — so the two are cleared independently.
 */
export async function deactivateMinimumStayPolicies(
  adminRequest: APIRequestContext,
  { namePrefix, lodgeId }: { namePrefix: string; lodgeId?: string },
): Promise<number> {
  const listUrl = lodgeId
    ? `/api/admin/booking-policies/minimum-stay?lodgeId=${encodeURIComponent(lodgeId)}`
    : "/api/admin/booking-policies/minimum-stay";

  async function listStale(): Promise<MinimumStayPolicyRow[]> {
    const listed = await adminRequest.get(listUrl);
    expect(listed.ok(), `GET ${listUrl} (${listed.status()})`).toBeTruthy();
    const policies = (await listed.json()) as MinimumStayPolicyRow[];
    return policies.filter(
      (policy) => policy.active && policy.name.startsWith(namePrefix),
    );
  }

  const stale = await listStale();
  for (const policy of stale) {
    const deleted = await adminRequest.delete(
      `/api/admin/booking-policies/minimum-stay/${policy.id}`,
      { data: { version: policy.version } },
    );
    expect(
      deleted.ok(),
      `deactivate leftover minimum-stay policy "${policy.name}" ` +
        `(${deleted.status()}): ${await deleted.text()}`,
    ).toBeTruthy();
  }

  if (stale.length > 0) {
    // Post-condition: the names really are free again, not merely "the request
    // returned 200".
    const surviving = await listStale();
    expect(
      surviving.map((policy) => `${policy.name} (${policy.id})`),
      `active minimum-stay policies matching "${namePrefix}" survived the reset ` +
        `— this attempt would run against a dirty database (see ` +
        `docs/E2E_PLAYWRIGHT.md → "Retry idempotency")`,
    ).toEqual([]);
  }

  return stale.length;
}

/**
 * Withdraw every booking-policy exception request this member still has open —
 * BOTH flavours (#2562).
 *
 * Why it is a shared helper and not three copies. The member read
 * (`GET /api/bookings/exception-requests`) answers the MEMBER DTO
 * (`src/lib/member-exception-requests.ts`), whose `status` is the member's own
 * word (`pending`, `pending-capacity-conflict`, ...) and NOT the Prisma enum. Two
 * specs each carried their own loop keyed on `status === "REQUESTED"`, so when
 * #2562 unified that read they would each have silently matched nothing, left the
 * member's open request in place, and failed the NEXT attempt on
 * `OPEN_EXCEPTION_REQUEST` — a cleanup that reports success while cleaning up
 * nothing is the #2302 pathology exactly.
 *
 * It keys on `canWithdraw` instead, which is the DTO field derived from the very
 * condition the cancel services' guarded claims name, so it cannot drift from
 * "the API would accept a withdrawal" the way a copied status string can. A
 * MODIFICATION request is withdrawn on its booking's own route; a NEW_BOOKING one
 * on the standalone route.
 *
 * Idempotent: a member with nothing open does nothing, and a lost claim (an
 * officer decided it in between) is tolerated rather than asserted, because the
 * post-condition below is the assertion that matters.
 */
export async function cancelOpenExceptionRequests(
  memberRequest: APIRequestContext,
): Promise<number> {
  type MemberExceptionRow = {
    id: string;
    source: "NEW_BOOKING" | "MODIFICATION";
    bookingId: string | null;
    canWithdraw: boolean;
  };

  async function listOpen(): Promise<MemberExceptionRow[]> {
    const listed = await memberRequest.get("/api/bookings/exception-requests");
    if (!listed.ok()) return [];
    const rows = (await listed.json()) as MemberExceptionRow[];
    return rows.filter((row) => row.canWithdraw);
  }

  const open = await listOpen();
  for (const row of open) {
    const path =
      row.source === "MODIFICATION" && row.bookingId
        ? `/api/bookings/${row.bookingId}/exception-requests/${row.id}`
        : `/api/bookings/exception-requests/${row.id}`;
    await memberRequest.patch(path, { data: { action: "cancel" } });
  }

  if (open.length > 0) {
    // Post-condition: they really are closed. Without this the helper reports a
    // count and proves nothing, which is what the copies it replaces did.
    const surviving = await listOpen();
    expect(
      surviving.map((row) => `${row.source}:${row.id}`),
      "open booking-policy exception requests survived the reset — this attempt " +
        "would be refused with OPEN_EXCEPTION_REQUEST (see " +
        'docs/E2E_PLAYWRIGHT.md → "Retry idempotency")',
    ).toEqual([]);
  }

  return open.length;
}

/**
 * Returns the Xero setup wizard to its pre-attempt state: disconnected, with the
 * persisted step cursor rewound to step one.
 *
 * Both endpoints are idempotent — `disconnectXero()` is a no-op when no tokens
 * are stored (src/lib/xero-oauth.ts), and the wizard-progress write is a plain
 * upsert — so this is safe to run on a clean first attempt.
 *
 * Credentials are deliberately NOT cleared: the wizard spec re-enters them
 * through the "Replace credentials" branch, which is itself worth exercising.
 */
export async function resetXeroSetupWizard(
  adminRequest: APIRequestContext,
): Promise<void> {
  const disconnected = await adminRequest.post("/api/admin/xero/disconnect");
  expect(
    disconnected.ok(),
    `POST /api/admin/xero/disconnect (${disconnected.status()})`,
  ).toBeTruthy();

  const rewound = await adminRequest.post(
    "/api/admin/integrations/wizard-progress",
    {
      data: {
        wizardId: "xero",
        currentStepId: "create-app",
        completedStepIds: [],
      },
    },
  );
  expect(
    rewound.ok(),
    `POST /api/admin/integrations/wizard-progress (${rewound.status()})`,
  ).toBeTruthy();
}
