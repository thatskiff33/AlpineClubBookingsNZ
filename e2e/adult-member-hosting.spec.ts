import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  test,
} from "@playwright/test";

import { loginPersona, storageStatePath } from "./helpers/auth";
import {
  bookingCreateIsolation,
  postBookingCreate,
} from "./helpers/booking-create-client-ip";
import { E2E_ADMIN, ROLE_PERSONAS, WAITLISTER } from "./helpers/fixtures";
import { overrideModules, setModuleSettings } from "./helpers/modules";
import { cancelMemberBookingsOnDate } from "./helpers/reset";
import { stayWindowForAttempt } from "./helpers/stay-dates";
// #3232: the linked move needs a SECOND window derived from this spec's own, and
// the seeded season bands to check it against. Both are the single sources the
// rest of the date space already uses (prisma/e2e-fixtures.ts).
import { SEEDED_SEASONS, shiftDateOnly } from "../prisma/e2e-fixtures";

/**
 * #2569 / #2576 / #2597 — the adult-member hosting rule end to end against the
 * real app.
 *
 * Four things only production-mode running can show, and each is an acceptance
 * criterion rather than a nice-to-have:
 *
 *  1. THE SETTINGS CARD'S TWO DIMENSIONS (#2569). The consequence and the
 *     host-scope set resolve INDEPENDENTLY and each reports its own source. Unit
 *     tests pin the resolver; only the running app can show the saved values coming
 *     back through the API and being stated on the card the operator reads.
 *  2. THE ENFORCED REFUSAL (#2569 §1). A booking that breaks the rule is REFUSED
 *     rather than recorded for review — a real 409 from the real create path, with
 *     the reason code a client can act on. A unit test can only show the evaluator
 *     returning a violation; it cannot show the booking failing to exist.
 *  3. SAME-OWNER COVERAGE AND THE REFUSED CHANGE (#2576). A second booking on the
 *     SAME member account supplies the adult member, so a booking that would
 *     otherwise be refused is accepted; and cancelling that source booking is then
 *     refused, because it would leave the first one uncovered. This is the whole
 *     point of the scope and it is intrinsically multi-booking, so it cannot be
 *     shown anywhere but here.
 *  4. ACTIVE COVER RESTORATION (#2597). After an officer accepts the loss and the
 *     dependent carries an incident, a different booking writer creates replacement
 *     active cover. The incident resolves as COVERAGE_RESTORED while the accepted
 *     dependent keeps its status. Deterministic lock-winner timing belongs in the
 *     disposable real-PostgreSQL suite, never production browser automation.
 *
 * DRIVEN THROUGH THE PRODUCT'S OWN APIs except where the officer product surface
 * is itself the contract. Same reasoning as `policy-exception-approval.spec.ts`:
 * the booking wizard is covered by `booking.spec.ts`, so setup uses APIs and stays
 * focused on policy semantics. The two deliberate browser paths prove what an
 * operator reads on the settings card and that the booking-detail cancellation
 * control can consume the refusal, preserve its exact proposal and complete the
 * strict override without exposing an opaque booking id.
 *
 * SELF-RESTORING. The club-wide hosting policy is a real club setting that every
 * other spec's bookings run through, so it is put back to DISABLED in `afterAll`
 * whatever happens, and the bookings this spec creates are cancelled by member and
 * date the same way the rest of the suite cleans up.
 */

test.describe.configure({ mode: "serial" });

const MEMBER_NAME = `${WAITLISTER.firstName} ${WAITLISTER.lastName}`;

let adminContext: BrowserContext;
let bookingOfficerContext: BrowserContext;
let memberContext: BrowserContext;
let admin: APIRequestContext;
let bookingOfficer: APIRequestContext;
let member: APIRequestContext;
let ownerMemberId: string;

/** A future in-season window with room, chosen once so both bookings share it. */
let WINDOW: { checkIn: string; checkOut: string };

/** Booking ids to clear even if a step failed part-way. */
const createdBookingIds: string[] = [];

/**
 * What the route ALWAYS returns. Every scope is present on a read, so the
 * `toEqual` assertions below stay closed-world — and that is deliberate: a
 * third scope shipped in #3037 and this spec failed rather than quietly
 * asserting two thirds of the answer. This mirror is hand-maintained, so
 * closed-world equality is the only thing keeping it honest.
 */
type HostScopes = {
  sameBooking: boolean;
  sameBookingOwner: boolean;
  sameGroupTrip: boolean;
};

/**
 * What a WRITE may name. `sameGroupTrip` is optional on the route (#3037), and
 * omitting it preserves whatever is stored rather than clearing it — so the
 * writes below deliberately do not name it, which keeps that behaviour under
 * test instead of papering over it with an explicit `false`.
 */
type HostScopeWrite = Partial<HostScopes> &
  Pick<HostScopes, "sameBooking" | "sameBookingOwner">;

/**
 * Every status the admin booking list can filter on (its own `VALID_STATUSES`).
 * `AWAITING_REVIEW` is deliberately absent from that set in the route, so it
 * cannot be listed at all — the same limitation `e2e/helpers/reset.ts` records.
 */
const LISTABLE_STATUSES = [
  "DRAFT",
  "PENDING",
  "PAYMENT_PENDING",
  "CONFIRMED",
  "PAID",
  "COMPLETED",
  "CANCELLED",
  "BUMPED",
  "WAITLISTED",
  "WAITLIST_OFFERED",
].join(",");

/**
 * Save the club-wide hosting policy, carrying the revision we just read.
 *
 * The route compare-and-swaps on that revision, so reading first is not
 * defensiveness — a blind write is refused, which is the behaviour #2569 wanted.
 */
async function setClubHostingPolicy(options: {
  mode: "DISABLED" | "ADMIN_REVIEW_REQUIRED" | "ENFORCED";
  hostScopes: HostScopeWrite | null;
}): Promise<void> {
  const current = await admin.get(
    "/api/admin/booking-policies/adult-member-hosting",
  );
  expect(
    current.ok(),
    `read hosting policy (${current.status()}): ${await current.text()}`,
  ).toBeTruthy();
  // The keyed settings route returns the selected row at the response root
  // (with `version: 0` for the synthesized never-saved state), not under a
  // `club` envelope. Carry every positive revision so the second write is a
  // genuine compare-and-swap instead of an accidental blind-create attempt.
  const body = (await current.json()) as { version?: number };

  const saved = await admin.put(
    "/api/admin/booking-policies/adult-member-hosting",
    {
      data: {
        mode: options.mode,
        hostScopes: options.hostScopes,
        capacityMode: "NO_HOLD",
        ...(body.version ? { version: body.version } : {}),
      },
    },
  );
  expect(
    saved.ok(),
    `save hosting policy ${options.mode} (${saved.status()}): ${await saved.text()}`,
  ).toBeTruthy();
}

async function readClubHostingPolicy(): Promise<{
  mode: string;
  hostScopes: HostScopes;
  modeSource: string;
  hostScopeSource: string;
}> {
  const res = await admin.get(
    "/api/admin/booking-policies/adult-member-hosting",
  );
  expect(res.ok(), `read hosting policy (${res.status()})`).toBeTruthy();
  const body = (await res.json()) as {
    effective: {
      mode: string;
      hostScopes: HostScopes;
      modeSource: string;
      hostScopeSource: string;
    };
  };
  return body.effective;
}

async function resolveOwnerMemberId(): Promise<string> {
  const res = await admin.get(
    `/api/admin/members?search=${encodeURIComponent(WAITLISTER.email)}&pageSize=5`,
  );
  expect(res.ok(), `resolve booking member (${res.status()})`).toBeTruthy();
  const body = (await res.json()) as {
    members?: Array<{ id: string; email: string }>;
  };
  const match = (body.members ?? []).find(
    (candidate) => candidate.email === WAITLISTER.email,
  );
  expect(
    match?.id,
    "the booking persona must resolve to a member id",
  ).toBeTruthy();
  return match!.id;
}

/** Create a booking as the member, returning the response for the caller to judge. */
function createMemberBooking(
  guests: Array<Record<string, unknown>>,
  retry: number,
) {
  return postBookingCreate(
    member,
    bookingCreateIsolation("adult-hosting-refusal", retry),
    {
      data: {
        checkIn: WINDOW.checkIn,
        checkOut: WINDOW.checkOut,
        guests,
      },
    },
  );
}

/**
 * Create the active source on behalf of the owner. This reaches CONFIRMED without
 * live Stripe, and deliberately makes `createdById` differ from `Booking.memberId`:
 * if coverage accidentally keys on the creator, the dependent below is refused.
 */
function createCoveringBooking(retry: number) {
  return postBookingCreate(
    admin,
    bookingCreateIsolation("adult-hosting-cross-booking", retry),
    {
      data: {
        checkIn: WINDOW.checkIn,
        checkOut: WINDOW.checkOut,
        forMemberId: ownerMemberId,
        paymentMethod: "internet_banking",
        guests: [
          {
            firstName: WAITLISTER.firstName,
            lastName: WAITLISTER.lastName,
            ageTier: "ADULT",
            isMember: true,
            memberId: ownerMemberId,
          },
        ],
      },
    },
  );
}

/**
 * Create the covered booking through a DIFFERENT officer from the source.
 * Both bookings therefore share only `Booking.memberId`, not `createdById`, while
 * the provider-free Internet Banking hold makes the dependent genuinely
 * CONFIRMED. That distinction matters for the post-confirmation incident contract:
 * a merely PENDING booking is protected from losing prospective cover, but it does
 * not receive an urgent incident until the club has accepted it (§7, §16).
 */
function createConfirmedDependentBooking(retry: number) {
  return postBookingCreate(
    bookingOfficer,
    bookingCreateIsolation("adult-hosting-cross-booking", retry),
    {
      data: {
        checkIn: WINDOW.checkIn,
        checkOut: WINDOW.checkOut,
        forMemberId: ownerMemberId,
        paymentMethod: "internet_banking",
        guests: [
          {
            firstName: "Covered",
            lastName: "Guest",
            ageTier: "ADULT",
            isMember: false,
          },
        ],
      },
    },
  );
}

/**
 * Run provider-free confirmed-booking setup with the two required switches on,
 * then restore the exact shared settings even when the booking request fails.
 */
async function withInternetBankingHolds<T>(work: () => Promise<T>): Promise<T> {
  const moduleSnapshot = await overrideModules(admin, {
    xeroIntegration: true,
    internetBankingPayments: true,
  });
  let bankingSnapshot:
    | {
        holdBedSlots: boolean;
        holdDays: number;
        minimumDaysBeforeCheckIn: number;
      }
    | undefined;
  try {
    const banking = await admin.get("/api/admin/internet-banking-settings");
    expect(
      banking.ok(),
      `read Internet Banking settings (${banking.status()})`,
    ).toBe(true);
    bankingSnapshot = (
      (await banking.json()) as { settings: typeof bankingSnapshot }
    ).settings;
    expect(bankingSnapshot).toBeTruthy();
    const enabled = await admin.put("/api/admin/internet-banking-settings", {
      data: {
        holdBedSlots: true,
        holdDays: bankingSnapshot!.holdDays,
        minimumDaysBeforeCheckIn: 0,
      },
    });
    expect(
      enabled.ok(),
      `enable Internet Banking holds (${enabled.status()}): ${await enabled.text()}`,
    ).toBe(true);
    return await work();
  } finally {
    if (bankingSnapshot) {
      const restored = await admin.put("/api/admin/internet-banking-settings", {
        data: bankingSnapshot,
      });
      expect(
        restored.ok(),
        `restore Internet Banking settings (${restored.status()})`,
      ).toBe(true);
    }
    await setModuleSettings(admin, moduleSnapshot);
  }
}

/**
 * Every live booking this member owns that checks in on our window, read through
 * the ADMIN list because that is the only booking-listing API the product exposes
 * (`e2e/helpers/reset.ts` reads the same one for the same reason).
 */
async function memberBookingsOnWindow(): Promise<
  Array<{ id: string; status: string; checkIn: string }>
> {
  const calendarMonth = WINDOW.checkIn.slice(0, 7);
  // An EXPLICIT status list rather than `status=all`, because that value falls
  // through to the route's default filter and quietly excludes DRAFT — and "the
  // refused booking does not exist in ANY status" is precisely the assertion that
  // needs to see a draft if one was left behind.
  const listed = await admin.get(
    `/api/admin/bookings?calendarMonth=${calendarMonth}&status=${LISTABLE_STATUSES}`,
  );
  expect(
    listed.ok(),
    `GET /api/admin/bookings?calendarMonth=${calendarMonth} (${listed.status()})`,
  ).toBeTruthy();
  const body = (await listed.json()) as {
    bookings: Array<{
      id: string;
      memberName: string;
      checkIn: string;
      status: string;
      deletedAt: string | null;
    }>;
  };
  return (
    body.bookings
      .filter(
        (booking) =>
          booking.memberName === MEMBER_NAME &&
          booking.checkIn === WINDOW.checkIn &&
          !booking.deletedAt,
      )
      // CANCELLED rows are kept: the override step below asserts that the dependent
      // booking is NOT cancelled, which only means something if a cancelled row would
      // have been visible here.

      .map((booking) => ({
        id: booking.id,
        status: booking.status,
        checkIn: booking.checkIn,
      }))
  );
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  adminContext = await browser.newContext({
    storageState: storageStatePath(E2E_ADMIN.email),
  });
  admin = adminContext.request;
  // Role-boundary personas do not have pre-generated storage state. Log the
  // Booking Officer in explicitly, then reuse that isolated context's request
  // client so source and dependent have different `createdById` values.
  bookingOfficerContext = await browser.newContext();
  const bookingOfficerPage = await bookingOfficerContext.newPage();
  await loginPersona(
    bookingOfficerPage,
    ROLE_PERSONAS.ADMIN_BOOKINGS.email,
    "198.51.100.70",
  );
  await bookingOfficerPage.close();
  bookingOfficer = bookingOfficerContext.request;

  // Wanda is seeded PAID with a complete, confirmed profile. Alice's booking
  // setup deliberately completes her profile in another spec, so using Alice
  // here would make this focused file depend on repository-wide execution order.
  memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await loginPersona(memberPage, WAITLISTER.email, "198.51.100.69");
  member = memberContext.request;
  ownerMemberId = await resolveOwnerMemberId();

  // `stayWindowForAttempt` hands out a distinct in-season window per spec/attempt,
  // which is what keeps concurrent specs off each other's capacity.
  const window = stayWindowForAttempt(9, test.info().retry);
  WINDOW = { checkIn: window.checkIn, checkOut: window.checkOut };

  // Start from a clean slate for this member and window: a leftover from a
  // previous attempt would supply cover and make the refusal cases pass for the
  // wrong reason.
  await cancelMemberBookingsOnDate(admin, {
    memberName: MEMBER_NAME,
    checkIn: WINDOW.checkIn,
  });
});

test.afterAll(async () => {
  // Put the club setting back FIRST: it gates every other spec's bookings, and a
  // failure below must not leave the club refusing them.
  try {
    await setClubHostingPolicy({ mode: "DISABLED", hostScopes: null });
  } finally {
    await cancelMemberBookingsOnDate(admin, {
      memberName: MEMBER_NAME,
      checkIn: WINDOW.checkIn,
    }).catch(() => undefined);
    await bookingOfficerContext?.close();
    await adminContext?.close();
    await memberContext?.close();
  }
});

test("the card resolves and states the two dimensions independently (#2569)", async () => {
  await setClubHostingPolicy({
    mode: "ADMIN_REVIEW_REQUIRED",
    hostScopes: { sameBooking: true, sameBookingOwner: false },
  });
  let effective = await readClubHostingPolicy();
  expect(effective.mode).toBe("ADMIN_REVIEW_REQUIRED");
  expect(effective.hostScopes).toEqual({
    sameBooking: true,
    sameBookingOwner: false,
    // #3037 defaults OFF and a write that does not name it must not turn it on.
    sameGroupTrip: false,
  });

  // Move ONE dimension. The other must not follow it — that independence is the
  // whole shape of #2569's model, and a resolver that coupled them would still
  // pass every single-dimension test.
  await setClubHostingPolicy({
    mode: "ENFORCED",
    hostScopes: { sameBooking: true, sameBookingOwner: true },
  });
  effective = await readClubHostingPolicy();
  expect(effective.mode).toBe("ENFORCED");
  expect(effective.hostScopes).toEqual({
    sameBooking: true,
    sameBookingOwner: true,
    // Moving BOTH original dimensions must still leave the third where it was:
    // the new scope is independent of them, not carried along by either.
    sameGroupTrip: false,
  });
  expect(effective.modeSource).toBe("CLUB_WIDE");
  expect(effective.hostScopeSource).toBe("CLUB_WIDE");

  // ...and the operator's own card says so, in the words they will read.
  const page = await adminContext.newPage();
  await page.goto("/admin/booking-policies/adult-member-hosting");
  const inForce = page.getByText("In force here now").first();
  await expect(inForce).toBeVisible();
  const panel = page
    .locator("div")
    .filter({ hasText: "In force here now" })
    .last();
  await expect(panel).toContainText("Another booking on the same account");
  await page.close();
});

test("an enforcing club refuses a booking with no adult member cover (#2569 §1)", async ({}, testInfo) => {
  const refused = await createMemberBooking(
    [
      {
        firstName: "Hosting",
        lastName: "Guest",
        ageTier: "ADULT",
        isMember: false,
      },
    ],
    testInfo.retry,
  );
  expect(
    refused.status(),
    `uncovered booking must be refused, not recorded (${refused.status()}): ` +
      `${await refused.text()}`,
  ).toBe(409);
  const body = (await refused.json()) as { code?: string; error?: string };
  expect(body.code).toBe("ADULT_MEMBER_HOSTING_REQUIRED");
  // The refusal is actionable: it names the nights and offers the exception door.
  expect(body.error ?? "").toMatch(/adult member/i);

  // AND THE BOOKING DOES NOT EXIST IN ANY STATUS. This is the assertion a unit test
  // cannot make, and it is the whole difference between the enforced consequence and
  // the review one: under review there would be a booking here, waiting.
  const live = (await memberBookingsOnWindow()).filter(
    // CANCELLED is excluded HERE and only here: `beforeAll` clears the window by
    // cancelling rather than deleting, so a cancelled row is evidence of the
    // cleanup, not of a booking this refusal should have prevented.
    (row) => row.status !== "CANCELLED",
  );
  expect(
    live,
    "the refused booking must not have been created in any live status",
  ).toEqual([]);
});

test("same-owner cover can be removed with authority and restored by another active booking (#2576, #2597)", async ({}, testInfo) => {
  // 1. THE SOURCE. A booking carrying the member themselves, who is a qualifying
  //    adult member attending those exact nights at that exact lodge.
  // Internet Banking is the isolated suite's provider-free route to CONFIRMED,
  // but enabling Xero globally would make Wanda's later member calls hit the
  // separate Xero-contact gate. Hold both switches only around this admin
  // on-behalf create, then restore the exact module snapshot before proceeding.
  const { source, dependent } = await withInternetBankingHolds(async () => ({
    source: await createCoveringBooking(testInfo.retry),
    dependent: await createConfirmedDependentBooking(testInfo.retry),
  }));
  expect(
    source.ok(),
    `create the covering booking (${source.status()}): ${await source.text()}`,
  ).toBeTruthy();
  const sourceBooking = (await source.json()) as {
    id: string;
    status: string;
    memberId: string;
    createdById: string | null;
  };
  createdBookingIds.push(sourceBooking.id);
  expect(sourceBooking.memberId).toBe(ownerMemberId);
  // Only genuinely confirmed active attendance may cover (§3), so the premise of
  // the next step is that this booking really reached one of those states.
  expect(
    ["CONFIRMED", "PAID"],
    `covering booking must be confirmed active attendance (got ${sourceBooking.status})`,
  ).toContain(sourceBooking.status);

  // 2. THE DEPENDENT. The same party shape that was refused above — and this time
  //    it is accepted and CONFIRMED, because the adult member on the other booking
  //    covers every night of it. A different officer created each booking, so the
  //    relationship proven here is Booking.memberId rather than createdById.
  expect(
    dependent.ok(),
    `same-owner cover must allow this booking (${dependent.status()}): ` +
      `${await dependent.text()}`,
  ).toBeTruthy();
  const dependentBooking = (await dependent.json()) as {
    id: string;
    status: string;
    memberId: string;
    createdById: string | null;
    hasNonMembers: boolean;
    guests: Array<{ isMember: boolean }>;
  };
  createdBookingIds.push(dependentBooking.id);
  expect(dependentBooking.memberId).toBe(ownerMemberId);
  expect(dependentBooking.createdById).not.toBe(sourceBooking.createdById);
  expect(dependentBooking.hasNonMembers).toBe(true);
  expect(dependentBooking.guests).toEqual([
    expect.objectContaining({ isMember: false }),
  ]);
  expect(
    ["CONFIRMED", "PAID"],
    `dependent booking must be confirmed before its cover can become an incident (got ${dependentBooking.status})`,
  ).toContain(dependentBooking.status);

  // 3. THE REFUSED CHANGE (§6). Cancelling the source would strand the dependent,
  //    so the member's own cancel is refused — and the source is left untouched.
  const blocked = await member.post(
    `/api/bookings/${sourceBooking.id}/cancel`,
    {
      data: { refundMethod: "credit" },
    },
  );
  expect(
    blocked.status(),
    `stranding cancel must be refused (${blocked.status()}): ${await blocked.text()}`,
  ).toBe(409);
  const blockedBody = (await blocked.json()) as {
    code?: string;
    strandedBookings?: Array<{ bookingId: string; nights: string[] }>;
  };
  expect(blockedBody.code).toBe("SAME_OWNER_COVERAGE_WOULD_BREAK");
  // It names the member's OWN affected booking and the exact nights — the thing
  // they need in order to fix it.
  expect(
    (blockedBody.strandedBookings ?? []).map((row) => row.bookingId),
  ).toContain(dependentBooking.id);
  expect((blockedBody.strandedBookings ?? [])[0]?.nights ?? []).toContain(
    WINDOW.checkIn,
  );

  // The rollback is real: the source booking is still live and still confirmed.
  const afterRefusal = await memberBookingsOnWindow();
  const survivor = afterRefusal.find((row) => row.id === sourceBooking.id);
  expect(survivor, "the refused cancel must have rolled back").toBeTruthy();
  expect(["CONFIRMED", "PAID"]).toContain(survivor!.status);

  // 4. AN OFFICER GETS THE EXPLICIT OVERRIDE DOOR (§7), THROUGH THE REAL UI.
  //    The first cancellation names the affected booking and nights; the
  //    confirmed retry carries the exact refused-state key and mandatory private
  //    reason without asking the officer's email choice a second time. The
  //    dependent booking keeps its status rather than being cancelled with the
  //    source, and the club's durable incident and audit trail record the action.
  const officerPage = await adminContext.newPage();
  await officerPage.goto(`/bookings/${sourceBooking.id}`);
  await officerPage
    .getByRole("button", { name: "Cancel on behalf of member" })
    .click();
  await officerPage
    .getByRole("button", { name: "Confirm Cancellation" })
    .click();
  await expect(
    officerPage.getByText("Email the member about this cancellation?"),
  ).toBeVisible();

  const needsOverridePromise = officerPage.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/bookings/${sourceBooking.id}/cancel`),
  );
  await officerPage
    .getByRole("button", { name: "Cancel without emailing" })
    .click();
  const needsOverride = await needsOverridePromise;
  expect(needsOverride.status()).toBe(409);
  const needsOverrideBody = (await needsOverride.json()) as {
    code?: string;
    requiresOverrideReason?: boolean;
    strandedStateKey?: string;
    strandedBookings?: Array<{
      bookingId: string;
      reference: string;
      lodgeName: string;
      nights: string[];
    }>;
  };
  expect(needsOverrideBody).toMatchObject({
    code: "SAME_OWNER_COVERAGE_OVERRIDE_REQUIRED",
    requiresOverrideReason: true,
  });
  expect(needsOverrideBody.strandedBookings?.[0]).toMatchObject({
    bookingId: dependentBooking.id,
    nights: expect.arrayContaining([WINDOW.checkIn]),
  });
  expect(needsOverrideBody.strandedStateKey).toMatch(/^v1:[0-9a-f]{64}$/);

  const stranded = needsOverrideBody.strandedBookings?.[0];
  expect(
    stranded,
    "the officer refusal must carry display-safe evidence",
  ).toBeTruthy();
  if (!stranded) throw new Error("Missing hosting-coverage evidence");
  const overridePrompt = officerPage
    .getByRole("alert")
    .filter({ hasText: "Separate hosting coverage override required" });
  await expect(overridePrompt).toContainText(stranded.reference);
  await expect(overridePrompt).toContainText(stranded.lodgeName);
  await expect(overridePrompt).toContainText(
    `Nights: ${stranded.nights.join(", ")}`,
  );
  // The UI presents the member-safe reference, never the opaque database id.
  await expect(officerPage.getByText(dependentBooking.id)).toHaveCount(0);

  const overrideReason = "E2E officer confirms the dependent hosting incident";
  await officerPage
    .getByLabel("Private hosting override reason (required)")
    .fill(overrideReason);
  await officerPage
    .getByLabel(/I confirm these exact affected bookings and nights/i)
    .check();

  const retryRequestPromise = officerPage.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().endsWith(`/api/bookings/${sourceBooking.id}/cancel`),
  );
  const overriddenPromise = officerPage.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/bookings/${sourceBooking.id}/cancel`),
  );
  await officerPage
    .getByRole("button", { name: "Confirm hosting override and cancel" })
    .click();
  const [retryRequest, overridden] = await Promise.all([
    retryRequestPromise,
    overriddenPromise,
  ]);
  expect(retryRequest.postDataJSON()).toEqual({
    refundMethod: "card",
    notifyMember: false,
    hostingCoverageOverride: {
      acknowledged: true,
      reason: overrideReason,
      strandedStateKey: needsOverrideBody.strandedStateKey,
    },
  });
  expect(
    overridden.ok(),
    `officer cancel must be allowed (${overridden.status()}): ${await overridden.text()}`,
  ).toBeTruthy();
  await expect(
    officerPage.getByText("Booking cancelled on behalf of the member"),
  ).toBeVisible();
  // The retry bypasses the already-settled email choice instead of reopening the
  // dialog and accidentally changing the proposal to which the key was bound.
  await expect(
    officerPage.getByText("Email the member about this cancellation?"),
  ).toHaveCount(0);
  await officerPage.close();

  const afterOverride = await memberBookingsOnWindow();
  const dependentRow = afterOverride.find(
    (row) => row.id === dependentBooking.id,
  );
  expect(
    dependentRow,
    "the dependent booking must still be there after the override",
  ).toBeTruthy();
  expect(
    ["CONFIRMED", "PAID"],
    "the dependent booking must keep its accepted lifecycle (§7, §16)",
  ).toContain(dependentRow!.status);

  const incidentPage = await adminContext.newPage();
  await incidentPage.goto("/admin/bookings#hosting-coverage-incidents");
  const incidentSection = incidentPage.locator("#hosting-coverage-incidents");
  await expect(incidentSection).toContainText(stranded.reference);
  await expect(incidentSection).toContainText("officer override");
  await incidentPage.close();

  const audit = await admin.get(
    "/api/admin/audit-log?" +
      new URLSearchParams({
        eventType: "booking.hostingCoverage.incidentOpened",
        q: dependentBooking.id,
        pageSize: "10",
      }).toString(),
  );
  expect(audit.ok(), `read hosting incident audit (${audit.status()})`).toBe(
    true,
  );
  const auditBody = (await audit.json()) as {
    data?: Array<{
      action: string;
      entityId: string | null;
      details: string | null;
    }>;
  };
  expect(auditBody.data).toContainEqual(
    expect.objectContaining({
      action: "booking.hostingCoverage.incidentOpened",
      entityId: dependentBooking.id,
      details: overrideReason,
    }),
  );

  // 5. ACTIVE COVER COMES BACK (#2597). Creating a replacement source is a
  //    different booking writer from the officer cancellation above. Its queue
  //    obligation must survive attribution fencing, reconcile the already-active
  //    dependent and close the incident without changing that booking's lifecycle.
  const restoredCover = await withInternetBankingHolds(() =>
    createCoveringBooking(testInfo.retry),
  );
  expect(
    restoredCover.ok(),
    `create replacement cover (${restoredCover.status()}): ${await restoredCover.text()}`,
  ).toBeTruthy();
  const restoredCoverBooking = (await restoredCover.json()) as {
    id: string;
    status: string;
    memberId: string;
  };
  createdBookingIds.push(restoredCoverBooking.id);
  expect(restoredCoverBooking.memberId).toBe(ownerMemberId);
  expect(["CONFIRMED", "PAID"]).toContain(restoredCoverBooking.status);

  const restoredIncidentPage = await adminContext.newPage();
  await restoredIncidentPage.goto("/admin/bookings#hosting-coverage-incidents");
  await expect
    .poll(
      async () => {
        await restoredIncidentPage.reload();
        return restoredIncidentPage
          .locator("#hosting-coverage-incidents")
          .getByText(stranded.reference)
          .count();
      },
      {
        message: "replacement active cover must resolve the dependent incident",
        timeout: 15_000,
      },
    )
    .toBe(0);
  await restoredIncidentPage.close();

  const afterRestoration = await memberBookingsOnWindow();
  const restoredDependent = afterRestoration.find(
    (row) => row.id === dependentBooking.id,
  );
  expect(
    restoredDependent,
    "restoring cover must keep the dependent booking",
  ).toBeTruthy();
  expect(["CONFIRMED", "PAID"]).toContain(restoredDependent!.status);

  const resolutionAudit = await admin.get(
    "/api/admin/audit-log?" +
      new URLSearchParams({
        eventType: "booking.hostingCoverage.incidentResolved",
        q: dependentBooking.id,
        pageSize: "10",
      }).toString(),
  );
  expect(
    resolutionAudit.ok(),
    `read hosting resolution audit (${resolutionAudit.status()})`,
  ).toBe(true);
  const resolutionAuditBody = (await resolutionAudit.json()) as {
    data?: Array<{ action: string; entityId: string | null; summary?: string }>;
  };
  expect(resolutionAuditBody.data).toContainEqual(
    expect.objectContaining({
      action: "booking.hostingCoverage.incidentResolved",
      entityId: dependentBooking.id,
      summary: expect.stringContaining("COVERAGE_RESTORED"),
    }),
  );
});

/**
 * #3232 — THE LINKED MOVE, end to end, and the one thing only the running app can
 * show: that BOTH bookings really moved.
 *
 * Everything else about this feature has a home. The dependent read is
 * `adult-member-hosting-same-owner.test.ts`, the orchestration and the money are
 * `booking-linked-date-move-service.test.ts`, the 409 on the wire is
 * `modify-linked-move.test.ts`, and the offer as the member reads it is
 * `hosting-coverage-linked-move-ui-contract.test.ts`. None of them can show two
 * real bookings in one real database both sitting on new nights afterwards, which
 * is the acceptance criterion the whole issue turns on: "no state exists in which
 * one booking moved and the other did not."
 *
 * IT ALSO SHOWS THE DEADLOCK IS GONE, which is the reason the offer exists rather
 * than a refusal. Before this, a member owning both bookings could move neither:
 * moving the one carrying the adult was refused for stranding the other, and
 * moving the other was refused by the same rule from the other end.
 *
 * DATES ARE COUNTED FROM THIS SPEC'S OWN WINDOW and are deliberately NOT Mondays.
 * Every `stayWindow` index in the suite is a Monday, so a Thursday pair cannot
 * collide with another spec's band however the bases are reallocated — see
 * `e2e-stay-window-disjointness.test.ts` for why an unverifiable disjointness
 * claim is not good enough here. Both windows are asserted to fall inside a
 * seeded season, so a run date that pushed one into the season gap fails loudly
 * with the reason instead of failing as an out-of-season price.
 */
test("moving one booking offers to move the other, and both really move (#3232)", async ({}, testInfo) => {
  test.setTimeout(180_000);

  // Thursday-to-Saturday, and the same again a week later: two nights each, both
  // clear of every Monday window in the suite.
  const start = shiftDateOnly(WINDOW.checkIn, 3);
  const target = shiftDateOnly(WINDOW.checkIn, 10);
  const inSeason = (checkIn: string) => {
    const nights = [checkIn, shiftDateOnly(checkIn, 1)];
    return SEEDED_SEASONS.some((season) =>
      nights.every((night) => night >= season.start && night <= season.end),
    );
  };
  for (const window of [start, target]) {
    expect(
      inSeason(window),
      `the linked-move window ${window} must fall inside a seeded season - it ` +
        `is derived from this spec's stay window (${WINDOW.checkIn}), so a run ` +
        `date that pushes it into the ~30-day season gap needs the base index ` +
        `moved rather than this assertion relaxed. See docs/E2E_PLAYWRIGHT.md.`,
    ).toBe(true);
  }

  await setClubHostingPolicy({
    mode: "ENFORCED",
    hostScopes: { sameBooking: true, sameBookingOwner: true },
  });

  // The pair: one booking carrying the member (a qualifying adult), and one
  // carrying a non-member guest that is compliant only through it.
  const { source, dependent } = await withInternetBankingHolds(async () => ({
    source: await postBookingCreate(
      admin,
      bookingCreateIsolation("linked-move-pair", testInfo.retry),
      {
        data: {
          checkIn: start,
          checkOut: shiftDateOnly(start, 2),
          forMemberId: ownerMemberId,
          paymentMethod: "internet_banking",
          guests: [
            {
              firstName: WAITLISTER.firstName,
              lastName: WAITLISTER.lastName,
              ageTier: "ADULT",
              isMember: true,
              memberId: ownerMemberId,
            },
          ],
        },
      },
    ),
    dependent: await postBookingCreate(
      bookingOfficer,
      bookingCreateIsolation("linked-move-pair", testInfo.retry),
      {
        data: {
          checkIn: start,
          checkOut: shiftDateOnly(start, 2),
          forMemberId: ownerMemberId,
          paymentMethod: "internet_banking",
          guests: [
            {
              firstName: "Linked",
              lastName: "Guest",
              ageTier: "ADULT",
              isMember: false,
            },
          ],
        },
      },
    ),
  }));

  expect(
    source.ok(),
    `create the covering booking (${source.status()}): ${await source.text()}`,
  ).toBe(true);
  expect(
    dependent.ok(),
    `same-owner cover must allow the dependent (${dependent.status()}): ` +
      `${await dependent.text()}`,
  ).toBe(true);
  const sourceBooking = (await source.json()) as { id: string; status: string };
  const dependentBooking = (await dependent.json()) as {
    id: string;
    status: string;
  };
  createdBookingIds.push(sourceBooking.id, dependentBooking.id);
  for (const booking of [sourceBooking, dependentBooking]) {
    expect(
      ["CONFIRMED", "PAID"],
      `both bookings must be confirmed active attendance (got ${booking.status})`,
    ).toContain(booking.status);
  }

  // 1. THE OFFER. The member moves the booking carrying the adult away from the
  //    other one. Before #3232 this either silently stranded the dependent or -
  //    once the read was widened - refused with nowhere to go.
  const move = { checkIn: target, checkOut: shiftDateOnly(target, 2) };
  const offered = await member.put(`/api/bookings/${sourceBooking.id}/modify`, {
    data: move,
  });
  expect(
    offered.status(),
    `the move must raise the linked-move offer (${offered.status()}): ` +
      `${await offered.text()}`,
  ).toBe(409);
  const offer = (await offered.json()) as {
    code?: string;
    requiresLinkedMoveChoice?: boolean;
    acceptStateKey?: string;
    declineStateKey?: string;
    linkedMoveAvailable?: boolean;
    linkedBookings?: Array<{
      bookingId: string;
      proposedCheckIn: string;
      proposedCheckOut: string;
      uncoveredNights: string[];
    }>;
    combinedAmountDueCents?: number;
    combinedRefundCents?: number;
    combinedChangeFeeCents?: number;
  };
  expect(offer.code).toBe("SAME_OWNER_COVERAGE_LINKED_MOVE_REQUIRED");
  expect(offer.requiresLinkedMoveChoice).toBe(true);
  expect(offer.linkedMoveAvailable).toBe(true);
  // It names the member's OWN affected booking, where it would go, and which
  // nights lose their adult if it stays.
  expect(offer.linkedBookings).toEqual([
    expect.objectContaining({
      bookingId: dependentBooking.id,
      proposedCheckIn: target,
      proposedCheckOut: shiftDateOnly(target, 2),
    }),
  ]);
  expect(offer.linkedBookings?.[0]?.uncoveredNights).toContain(start);
  // Two keys, because the two arms bind different things - a hazard, and a price.
  expect(offer.acceptStateKey).toMatch(/^v1:[0-9a-f]{64}$/);
  expect(offer.declineStateKey).toMatch(/^v1:[0-9a-f]{64}$/);
  expect(offer.acceptStateKey).not.toBe(offer.declineStateKey);
  // Integer cents, every one of them.
  for (const cents of [
    offer.combinedAmountDueCents,
    offer.combinedRefundCents,
    offer.combinedChangeFeeCents,
  ]) {
    expect(Number.isInteger(cents)).toBe(true);
  }

  // 2. THE WRONG KEY IS REFUSED. Declining binds the hazard alone, so it cannot
  //    stand in for an acceptance of a price.
  const wrongArm = await member.put(
    `/api/bookings/${sourceBooking.id}/modify`,
    {
      data: {
        ...move,
        hostingCoverageLinkedMove: {
          choice: "MOVE_BOTH",
          acknowledged: true,
          stateKey: offer.declineStateKey,
        },
      },
    },
  );
  expect(
    wrongArm.status(),
    `the decline key must not accept the offer (${wrongArm.status()})`,
  ).toBe(409);

  // 3. THE MOVE. One acceptance, both bookings.
  const applied = await member.put(`/api/bookings/${sourceBooking.id}/modify`, {
    data: {
      ...move,
      hostingCoverageLinkedMove: {
        choice: "MOVE_BOTH",
        acknowledged: true,
        stateKey: offer.acceptStateKey,
      },
    },
  });
  expect(
    applied.ok(),
    `the accepted linked move must succeed (${applied.status()}): ` +
      `${await applied.text()}`,
  ).toBe(true);

  // 4. AND BOTH REALLY MOVED. This is the assertion no unit test can make: two
  //    rows in a real database, on the new nights, after one request.
  const moved = await admin.get(
    `/api/admin/bookings?calendarMonth=${target.slice(0, 7)}&status=${LISTABLE_STATUSES}`,
  );
  expect(moved.ok(), `list bookings for ${target} (${moved.status()})`).toBe(
    true,
  );
  const movedBody = (await moved.json()) as {
    bookings: Array<{ id: string; checkIn: string; deletedAt: string | null }>;
  };
  const byId = new Map(
    movedBody.bookings
      .filter((booking) => !booking.deletedAt)
      .map((booking) => [booking.id, booking.checkIn]),
  );
  expect(
    byId.get(sourceBooking.id),
    "the booking the member moved must be on the new nights",
  ).toBe(target);
  expect(
    byId.get(dependentBooking.id),
    "the booking that was relying on it must have moved with it - a state where " +
      "only one moved is the thing #3232 promises cannot exist",
  ).toBe(target);
});
