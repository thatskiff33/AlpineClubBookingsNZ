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
  resolveBookableLodgeId,
} from "./helpers/booking-create-client-ip";
import { personas } from "./helpers/personas";
import {
  E2E_ADMIN,
  NOMINATOR_TWO,
  WAITLIST_FULL_WINDOW,
  WAITLISTER,
} from "./helpers/fixtures";
import { monthKeyParts, stayWindow } from "./helpers/stay-dates";
import { overrideModules, setModuleSettings, type ModuleSettings } from "./helpers/modules";

/*
  #2263 (epic #2245) — the member whole-lodge request journey, and the privacy
  guarantee it is built around.

  Matrix rows (docs/END_TO_END_TEST_MATRIX.md):
    - Critical: member whole-lodge journey (submit → officer approves → hold).
    - Critical: uniform-response privacy (the byte-compare below).
    - High:     admin queue badges, availability strip, approve + hold.

  WHY THE BYTE-COMPARE LIVES HERE AND NOT IN VITEST. The unit layer runs with
  Prisma mocked, so "three worlds" there is a fiction: the same mock answers
  every question identically whatever the world is supposed to be, and the test
  passes without ever having had three worlds. The claim is only worth something
  against REAL ROWS, which means the seeded database and therefore Playwright.

  The three worlds, each VERIFIED FROM THE ADMIN SIDE before a single request is
  submitted — an unverified world would make the byte-compare vacuous, since
  three identical acknowledgements from three identically-empty worlds prove
  nothing:
    A. CLEAR       — a fresh stay window nothing else touches; free beds > 0.
    B. FULL        — WAITLIST_FULL_WINDOW, seeded past the lodge's capacity;
                     free beds 0.
    C. HELD        — a window this spec puts an exclusive whole-lodge hold on;
                     the hold route itself reports wholeLodgeHold back.

  MECHANICS THAT MATTER:
    - THREE DISTINCT MEMBER SESSIONS, one per world. The cap of two open
      requests per member and the shared per-member rate-limit window would
      otherwise make the result depend on submission order — the third
      submission from one member would 409 on the cap and the test would be
      asserting the wrong thing (or, worse, pass by comparing two identical
      error bodies).
    - All three personas HOLD A LOGIN. The obvious "third member" candidates do
      not: LODGE_FILL_OWNER is seeded `canLogin: false` (it exists only to own
      the capacity-filling booking), and Bob/Evan are seeded un-enrolled in
      two-factor so the 2FA specs can drive real enrollment — logging them in
      here would consume that state. Nadia (NOMINATOR_TWO) is seeded PAID with a
      complete, self-confirmed profile and already logs in for
      booking-cancel-refund.spec, which runs earlier in this serial suite. This
      spec only adds a booking REQUEST for her and asserts nothing about the
      bookings or account credit that spec owns.
    - RETRY-SAFE. CI retries this file up to twice and every retry re-submits.
      Each world submits from its OWN synthetic client IP (the same
      x-forwarded-for mechanism e2e/helpers/auth.ts uses for logins), so the
      shared per-IP window cannot decide the outcome; `beforeAll` clears any
      open member-origin request a previous attempt left behind, so the
      2-open-request cap cannot either; and world C reuses an existing booking
      and tolerates an already-set hold. Without all three, attempt 3 fails on a
      limiter or a duplicate rather than on the behaviour under test. The
      capacity-holding anchor's separate `POST /api/bookings` uses the shared
      booking-create census as well, so earlier spec retries cannot exhaust its
      setup bucket.
*/

test.describe.configure({ mode: "serial" });

// Indices 0–9 are taken by the other specs; these two are this file's alone, so
// the "clear" world really is clear and the "held" world is held by nothing but
// the hold this spec places.
const CLEAR_WINDOW = stayWindow(11);
const HELD_WINDOW = stayWindow(12);

const REQUEST_BODY = {
  headcount: 6,
  groupDescription: "Club alpine skills course",
};

// One private per-world IP bucket for the submissions. Deliberately outside
// auth.ts's 10.99.0.0/16 synthetic login range so a submission can never share
// a bucket with a login.
const WORLD_IPS = {
  clear: "10.77.1.1",
  full: "10.77.1.2",
  held: "10.77.1.3",
} as const;

// Statuses the create-cap counts and the withdraw claim accepts
// (MEMBER_WHOLE_LODGE_OPEN_STATUSES, src/lib/member-whole-lodge-requests.ts).
// Restated here on purpose: a Playwright spec must not import server modules,
// and an independent restatement is a second opinion rather than an echo.
const OPEN_STATUSES = new Set([
  "VERIFIED",
  "PRICED",
  "QUOTED",
  "QUOTE_SENT",
  "QUERY_PENDING",
  "MODIFICATION_REQUESTED",
]);

let adminContext: BrowserContext;
let aliceContext: BrowserContext;
let wandaContext: BrowserContext;
let nadiaContext: BrowserContext;

// Module + Internet Banking state to put back in afterAll. The Xero setup-wizard
// specs run immediately after this file (alphabetically), so leaving
// xeroIntegration flipped on would be somebody else's mystery failure.
let modulesBefore: ModuleSettings | null = null;
let ibSettingsBefore: {
  holdBedSlots: boolean;
  holdDays: number;
  minimumDaysBeforeCheckIn: number;
} | null = null;

/**
 * Every member-origin whole-lodge request sitting in the officer queue.
 *
 * Scoped to `status=VERIFIED`, which is where a member request lives for its
 * whole open life (it is created VERIFIED and the quote lifecycle is refused for
 * it), and deliberately NOT `status=ALL` — this spec only ever wants the member
 * rows, so the narrower filter is also the cheaper one.
 *
 * `ALL` used to return **500** on the seeded database: it includes the seeded
 * CONVERTED school request, whose guests carried `lastName: ""`, and the strict
 * `parseBookingRequestGuests` rejects an empty name, so serialising the page
 * threw. That pre-existing defect was found by this spec, filed as #2342, and
 * fixed there: admin reads are now tolerant (the row renders flagged) and the
 * seed gives the school children surnames. `ALL` now has its own end-to-end
 * guard below ("the officer queue's All filter survives the whole seeded
 * database"); this helper stays narrow because it only wants the member rows.
 */
async function listMemberOriginRequests(admin: APIRequestContext) {
  const response = await admin.get(
    "/api/admin/booking-requests?status=VERIFIED&pageSize=100",
  );
  // Status IN the message: a bare "expected true, received false" cannot tell a
  // 401 from a 400 from a 500, and this call is the spec's only window onto the
  // admin queue.
  expect(
    response.ok(),
    `GET /api/admin/booking-requests returned ${response.status()}: ${await response.text()}`,
  ).toBe(true);
  const body = (await response.json()) as {
    data: Array<{
      id: string;
      status: string;
      checkIn: string;
      requestedByMemberId: string | null;
      exclusivityRequested: boolean;
    }>;
  };
  return body.data.filter(
    (row) => row.requestedByMemberId && row.exclusivityRequested,
  );
}

/**
 * OCCUPIED beds per night as ANOTHER MEMBER sees them, plus the raw payloads.
 *
 * `/api/availability` takes a ZERO-BASED month and answers one month at a time,
 * so this fetches every month the nights span — a two-night window can cross a
 * month boundary, and a single-month fetch would report `undefined` for the rest
 * rather than a number.
 */
async function memberOccupiedBeds(
  context: BrowserContext,
  nights: string[],
): Promise<{ occupied: Record<string, number>; payloads: unknown[] }> {
  const occupied: Record<string, number> = {};
  const payloads: unknown[] = [];
  for (const month of new Set(nights.map((night) => night.slice(0, 7)))) {
    const { year, month: monthNumber } = monthKeyParts(month);
    const response = await context.request.get(
      `/api/availability?year=${year}&month=${monthNumber - 1}`,
    );
    // Asserted unconditionally: a skipped assertion is not an assertion.
    expect(
      response.ok(),
      `GET /api/availability for ${month} returned ${response.status()}: ${await response.text()}`,
    ).toBe(true);
    const body = (await response.json()) as {
      availability: Record<string, number>;
    };
    payloads.push(body);
    for (const night of nights) {
      if (night.slice(0, 7) !== month) continue;
      const count = body.availability[night];
      if (count === undefined) {
        throw new Error(`/api/availability for ${month} gave no answer for ${night}`);
      }
      occupied[night] = count;
    }
  }
  return { occupied, payloads };
}

/**
 * Free beds per night from the ADMIN calendar, which reports
 * `lodgeCapacity - occupiedBeds`. A whole-lodge-held night reads 0 there just
 * like a genuinely full one — that pin is the subject of its own test below —
 * so this separates CLEAR from FULL and is never used to prove the hold itself.
 */
async function adminFreeBeds(admin: APIRequestContext, nights: string[]) {
  const free: Record<string, number> = {};
  for (const month of new Set(nights.map((night) => night.slice(0, 7)))) {
    const response = await admin.get(
      `/api/admin/bookings?calendarMonth=${month}&status=all`,
    );
    expect(response.ok(), `admin calendar for ${month}`).toBe(true);
    const body = (await response.json()) as {
      availability: Record<string, number>;
    };
    for (const night of nights) {
      if (night.slice(0, 7) !== month) continue;
      free[night] = body.availability[night] ?? 0;
    }
  }
  return free;
}

test.beforeAll(async ({ browser }) => {
  // Two fresh logins (Wanda, Nadia), each possibly including first-time
  // two-factor enrollment: more than the default 90s hook budget on a loaded
  // runner. Alice and the admin reuse the storage state auth.setup.ts saved
  // (#1779), so this file adds no third login.
  test.setTimeout(300_000);

  adminContext = await browser.newContext({
    storageState: storageStatePath(E2E_ADMIN.email),
  });
  // Load an admin page ONCE before any `adminContext.request` call. Every other
  // spec in this suite reaches admin APIs from a context that has already
  // navigated (or via `page.request`), and this file's first CI run 401'd on an
  // admin API from a context whose session had never been materialised by a
  // navigation. It doubles as the cheapest possible assertion that the officer
  // can reach the queue at all.
  const adminWarmup = await adminContext.newPage();
  await adminWarmup.goto("/admin/booking-requests");
  await expect(
    adminWarmup.getByRole("heading", { name: /booking requests/i }).first(),
  ).toBeVisible();
  await adminWarmup.close();

  // World C needs a CONFIRMED (capacity-holding) booking, and the only route to
  // one without Stripe is an Internet Banking create — which the create route
  // gates on BOTH xeroIntegration AND internetBankingPayments, and which
  // e2e/setup/enable-e2e-modules.ts deliberately leaves OFF. Turn both on for
  // this file exactly as e2e/double-bed-sharing.spec.ts does for its
  // capacity-holding anchors, with holdBedSlots so the booking lands CONFIRMED.
  // Xero stays UNCONFIGURED, so the invoice this PR now enqueues is queued and
  // never sent. Both are restored in afterAll.
  modulesBefore = await overrideModules(adminContext.request, {
    xeroIntegration: true,
    internetBankingPayments: true,
  });
  const ibGet = await adminContext.request.get(
    "/api/admin/internet-banking-settings",
  );
  expect(ibGet.ok(), `GET IB settings (${ibGet.status()})`).toBe(true);
  ibSettingsBefore = (await ibGet.json()).settings;
  const ibPut = await adminContext.request.put(
    "/api/admin/internet-banking-settings",
    {
      data: {
        holdBedSlots: true,
        holdDays: ibSettingsBefore!.holdDays,
        minimumDaysBeforeCheckIn: 0,
      },
    },
  );
  expect(ibPut.ok(), `PUT IB settings (${ibPut.status()})`).toBe(true);

  aliceContext = await browser.newContext({
    storageState: storageStatePath(personas.booker.email),
  });

  wandaContext = await browser.newContext();
  const wandaPage = await wandaContext.newPage();
  await loginPersona(wandaPage, WAITLISTER.email);
  await wandaPage.close();

  nadiaContext = await browser.newContext();
  const nadiaPage = await nadiaContext.newPage();
  await loginPersona(nadiaPage, NOMINATOR_TWO.email);
  await nadiaPage.close();

});

/**
 * Retry hygiene: decline anything a previous attempt left open so the
 * 2-open-request cap starts from zero for all three members. Declining (not
 * withdrawing) needs no member session and releases nothing — a member-origin
 * row never holds capacity.
 *
 * Deliberately BEST-EFFORT and deliberately NOT in `beforeAll`. A throw in a
 * `beforeAll` skips every test in the file, which is exactly how the first
 * version of this spec came to report seven "passing" tests that had never run.
 * Housekeeping for a retry must never be able to do that: on the first attempt
 * of a fresh database there is nothing to clean, so a failure here is
 * information, not a reason to abandon the run.
 */
/**
 * Free the CLEAR window of anything a previous attempt of this file booked there.
 *
 * The approve test converts Alice's clear-window request into a CONFIRMED booking
 * that HOLDS THE WHOLE LODGE. On a CI retry those nights are then fully occupied,
 * so "the clear world is clear" fails and the file can never go green on attempt
 * 2 or 3. Cancelling is safe and cheap: nothing was paid, so the credit-method
 * cancel settles to nothing and simply releases the beds.
 *
 * Best-effort by design — on a first attempt there is nothing to find, so a
 * failure here is information rather than a reason to abandon the run.
 */
async function releaseClearWindowBookings(admin: APIRequestContext) {
  const month = CLEAR_WINDOW.checkIn.slice(0, 7);
  const response = await admin.get(
    `/api/admin/bookings?calendarMonth=${month}&status=all`,
  );
  if (!response.ok()) {
    console.warn(
      `[#2263] clear-window cleanup skipped: admin calendar returned ${response.status()}`,
    );
    return;
  }
  const body = (await response.json()) as {
    bookings: Array<{ id: string; checkIn: string; status: string }>;
  };
  for (const booking of body.bookings) {
    if (booking.checkIn !== CLEAR_WINDOW.checkIn) continue;
    if (booking.status === "CANCELLED") continue;
    const cancelled = await admin.post(`/api/bookings/${booking.id}/cancel`, {
      data: { refundMethod: "credit", notifyMember: false },
    });
    if (!cancelled.ok()) {
      console.warn(
        `[#2263] could not release clear-window booking ${booking.id}: ${cancelled.status()}`,
      );
    }
  }
}

async function clearLeftoverOpenRequests(admin: APIRequestContext) {
  const response = await admin.get(
    "/api/admin/booking-requests?status=VERIFIED&pageSize=100",
  );
  if (!response.ok()) {
    console.warn(
      `[#2263] leftover-request cleanup skipped: the admin queue returned ${response.status()}. ` +
        "A first attempt needs no cleanup; a retry may hit the open-request cap.",
    );
    return;
  }
  const body = (await response.json()) as {
    data: Array<{
      id: string;
      status: string;
      requestedByMemberId: string | null;
      exclusivityRequested: boolean;
    }>;
  };
  for (const row of body.data) {
    if (!row.requestedByMemberId || !row.exclusivityRequested) continue;
    if (!OPEN_STATUSES.has(row.status)) continue;
    const declined = await admin.post(
      `/api/admin/booking-requests/${row.id}/decline`,
      { data: { reason: null } },
    );
    if (!declined.ok()) {
      console.warn(
        `[#2263] could not decline leftover request ${row.id}: ${declined.status()}`,
      );
    }
  }
}

test.afterAll(async () => {
  // Restore before closing the contexts, and tolerate partial setup: this file
  // is followed by the Xero setup-wizard specs, which assume the module state
  // enable-e2e-modules.ts left behind.
  try {
    if (ibSettingsBefore) {
      await adminContext.request
        .put("/api/admin/internet-banking-settings", {
          data: {
            holdBedSlots: ibSettingsBefore.holdBedSlots,
            holdDays: ibSettingsBefore.holdDays,
            minimumDaysBeforeCheckIn: ibSettingsBefore.minimumDaysBeforeCheckIn,
          },
        })
        .catch(() => undefined);
    }
    if (modulesBefore) {
      await setModuleSettings(adminContext.request, modulesBefore).catch(
        () => undefined,
      );
    }
  } finally {
    await adminContext?.close();
    await aliceContext?.close();
    await wandaContext?.close();
    await nadiaContext?.close();
  }
});

/**
 * Submit one whole-lodge request and return the raw status + body BYTES.
 *
 * #2701: the route now REQUIRES `lodgeId` — an omitted lodge used to be stored
 * as the club's default, which is how a member could end up holding a lodge
 * they never chose. The real form reads the lodge list and sends the id even
 * when it renders no selector (ADR-002), so this does the same rather than
 * hardcoding a fixture id that a multi-lodge seed would invalidate.
 */
async function submitWholeLodgeRequest(
  context: BrowserContext,
  window: { checkIn: string; checkOut: string },
  clientIp: string,
) {
  const lodgeId = await resolveBookableLodgeId(context.request);
  expect(lodgeId, "the submitting member must be able to book some lodge").not.toBeNull();
  const response = await context.request.post(
    "/api/booking-requests/whole-lodge",
    {
      headers: { "x-forwarded-for": clientIp },
      data: {
        ...REQUEST_BODY,
        lodgeId,
        checkIn: window.checkIn,
        checkOut: window.checkOut,
      },
    },
  );
  return {
    status: response.status(),
    bytes: Buffer.from(await response.body()),
  };
}

// Captured in the byte-compare test and reused below, so the journey never
// sends a fourth request. Ownership matters later: the cross-member withdraw
// test must aim at a row its caller demonstrably does not own.
let aliceRequestId: string | null = null;
let wandaRequestId: string | null = null;
let approvedBookingId: string | null = null;

test("the acknowledgement is byte-identical whether the lodge is clear, full, or exclusively held", async ({}, testInfo) => {
  test.setTimeout(180_000);
  await clearLeftoverOpenRequests(adminContext.request);

  // --- World C setup: make HELD_WINDOW exclusively held ---------------------
  // An exclusive whole-lodge hold can only be granted to a booking that
  // ACTUALLY HOLDS CAPACITY (issue #173): holding the lodge for a booking that
  // reserves no bed would block nothing while the calendar stayed bookable. A
  // member self-book with no payment method lands PAYMENT_PENDING, which is
  // deliberately non-holding (#737), so the hold route refuses it — this spec
  // learned that the hard way once it finally ran.
  //
  // So the booking is created the way e2e/double-bed-sharing.spec.ts creates its
  // capacity-holding anchors: an ADMIN on-behalf create with
  // `paymentMethod: "internet_banking"`, which lands CONFIRMED without needing
  // Stripe. Then the admin sets the exclusive hold on it. From that moment every
  // OTHER member sees those nights as simply unavailable — the same word a
  // genuinely full lodge gets, which is the rule this whole test exists to prove
  // is not observable.
  //
  // On a CI retry Wanda already holds this window and the member-night lock
  // would refuse a second booking, so an existing one is reused. Read from the
  // admin calendar (there is no member GET /api/bookings), matched on both the
  // check-in and the owner so an unrelated booking can never be hijacked.
  const wandaFullName = `${WAITLISTER.firstName} ${WAITLISTER.lastName}`;
  const heldMonthResponse = await adminContext.request.get(
    `/api/admin/bookings?calendarMonth=${HELD_WINDOW.checkIn.slice(0, 7)}&status=all`,
  );
  expect(heldMonthResponse.ok(), await heldMonthResponse.text()).toBe(true);
  const heldMonth = (await heldMonthResponse.json()) as {
    bookings: Array<{
      id: string;
      checkIn: string;
      memberName: string;
      status: string;
    }>;
  };
  let holdBookingId = heldMonth.bookings.find(
    (booking) =>
      booking.checkIn === HELD_WINDOW.checkIn &&
      booking.memberName === wandaFullName &&
      // Only a CONFIRMED booking can carry the exclusive hold, so only a
      // CONFIRMED one is worth reusing on a retry.
      booking.status === "CONFIRMED",
  )?.id;

  if (!holdBookingId) {
    // Wanda's member id comes from her own session — the same way
    // e2e/waitlist.spec.ts gets it — so no admin member search is needed.
    const session = (await (
      await wandaContext.request.get("/api/auth/session")
    ).json()) as { user?: { id?: string } };
    const wandaMemberId = session.user?.id;
    expect(wandaMemberId, "could not resolve Wanda's member id").toBeTruthy();

    const holdBookingResponse = await postBookingCreate(
      adminContext.request,
      bookingCreateIsolation("whole-lodge-held-anchor", testInfo.retry),
      {
        data: {
          checkIn: HELD_WINDOW.checkIn,
          checkOut: HELD_WINDOW.checkOut,
          forMemberId: wandaMemberId,
          // Lands CONFIRMED — and therefore capacity-holding — with no Stripe.
          paymentMethod: "internet_banking",
          guests: [
            {
              firstName: WAITLISTER.firstName,
              lastName: WAITLISTER.lastName,
              ageTier: "ADULT",
              isMember: true,
              memberId: wandaMemberId,
            },
          ],
        },
      },
    );
    expect(
      holdBookingResponse.ok(),
      `could not create the booking to hold (${holdBookingResponse.status()}): ${await holdBookingResponse.text()}`,
    ).toBe(true);
    const holdBooking = (await holdBookingResponse.json()) as {
      booking?: { id?: string; status?: string };
      id?: string;
      status?: string;
    };
    holdBookingId = holdBooking.booking?.id ?? holdBooking.id;
    // The whole point of the internet-banking branch: assert the status rather
    // than hope, because a non-holding booking cannot take the hold below.
    expect(
      holdBooking.booking?.status ?? holdBooking.status,
      "the booking to hold must be CONFIRMED (capacity-holding)",
    ).toBe("CONFIRMED");
  }
  expect(holdBookingId).toBeTruthy();

  const setHold = await adminContext.request.post(
    `/api/admin/bookings/${holdBookingId}/exclusive-hold`,
    { data: { hold: true } },
  );
  if (setHold.ok()) {
    // The route reports the flag it just wrote. World C is proven by that,
    // not by assuming a 200 means the hold landed.
    const setHoldBody = (await setHold.json()) as { wholeLodgeHold?: boolean };
    expect(
      setHoldBody.wholeLodgeHold,
      "the exclusive-hold route did not report the hold as set",
    ).toBe(true);
  } else {
    // A retry: the hold is already on, which the route refuses with a 409 whose
    // message says exactly that. Any other failure must still fail the test.
    const text = await setHold.text();
    expect(
      setHold.status() === 409 && /already has an exclusive/i.test(text),
      `could not establish the exclusive hold: ${text}`,
    ).toBe(true);
  }

  // --- Worlds A and B verified from the admin side, BEFORE submitting -------
  // Retry hygiene for the CLEAR world. A previous attempt that got as far as the
  // approve test left a CONFIRMED, whole-lodge-HELD booking on these nights, so
  // the clear window is no longer clear and this whole file could never pass on
  // a retry. Cancel any booking this spec previously created there (nothing was
  // ever paid, so the credit-method cancel is a no-op settlement that just frees
  // the beds — the same teardown e2e/double-bed-sharing.spec.ts uses for its
  // holding bookings). Best-effort: on a first attempt there is nothing to find.
  await releaseClearWindowBookings(adminContext.request);

  const clearFree = await adminFreeBeds(
    adminContext.request,
    CLEAR_WINDOW.nights,
  );
  for (const night of CLEAR_WINDOW.nights) {
    expect(
      clearFree[night],
      `the "clear" world is not clear on ${night}`,
    ).toBeGreaterThan(0);
  }
  const fullFree = await adminFreeBeds(
    adminContext.request,
    WAITLIST_FULL_WINDOW.nights,
  );
  for (const night of WAITLIST_FULL_WINDOW.nights) {
    // The admin calendar reports `lodgeCapacity - occupied` UNFLOORED, and the
    // seeded fill is deliberately 22 guests against a 20-bed lodge, so this is
    // NEGATIVE rather than zero. What matters is that no bed is free.
    expect(
      fullFree[night],
      `the "full" world has beds free on ${night}`,
    ).toBeLessThanOrEqual(0);
  }

  // --- The three submissions, one member each -------------------------------
  const clear = await submitWholeLodgeRequest(
    aliceContext,
    CLEAR_WINDOW,
    WORLD_IPS.clear,
  );
  const full = await submitWholeLodgeRequest(
    wandaContext,
    WAITLIST_FULL_WINDOW,
    WORLD_IPS.full,
  );
  const held = await submitWholeLodgeRequest(
    nadiaContext,
    HELD_WINDOW,
    WORLD_IPS.held,
  );

  // All three must have SUCCEEDED. A 429 or 409 here would make the byte
  // comparison vacuous — three identical error bodies also compare equal.
  expect(clear.status, "clear-window submission did not succeed").toBe(201);
  expect(full.status, "full-window submission did not succeed").toBe(201);
  expect(held.status, "held-window submission did not succeed").toBe(201);

  // Buffer equality, not deep-equal on parsed JSON: two objects can be
  // deep-equal and still serialise to different bytes (key order, spacing), and
  // it is the BYTES on the wire that a member can measure.
  expect(
    full.bytes.equals(clear.bytes),
    "a full lodge produced a different acknowledgement from a clear one",
  ).toBe(true);
  expect(
    held.bytes.equals(clear.bytes),
    "an exclusively-held lodge produced a different acknowledgement from a clear one",
  ).toBe(true);

  // And the body echoes nothing that was submitted — no dates, no headcount, no
  // reference. An echo is a channel.
  const body = clear.bytes.toString("utf8");
  expect(body).not.toContain(CLEAR_WINDOW.checkIn);
  expect(body).not.toContain(String(REQUEST_BODY.headcount));
  expect(body).not.toContain("alpine skills");

  const rows = await listMemberOriginRequests(adminContext.request);
  aliceRequestId =
    rows.find(
      (row) =>
        row.checkIn.startsWith(CLEAR_WINDOW.checkIn) &&
        OPEN_STATUSES.has(row.status),
    )?.id ?? null;
  wandaRequestId =
    rows.find(
      (row) =>
        row.checkIn.startsWith(WAITLIST_FULL_WINDOW.checkIn) &&
        OPEN_STATUSES.has(row.status),
    )?.id ?? null;
  expect(
    aliceRequestId,
    "Alice's clear-window request is not in the queue",
  ).toBeTruthy();
  expect(
    wandaRequestId,
    "Wanda's full-window request is not in the queue",
  ).toBeTruthy();
});

test("the member sees no availability, price or capacity hint on the request form", async () => {
  const page = await aliceContext.newPage();
  await page.goto("/book");

  // The entry point sits beside the wizard, which is untouched.
  await expect(
    page.getByRole("link", { name: /book the whole lodge/i }),
  ).toBeVisible();

  await page.goto("/book/whole-lodge");
  await expect(
    page.getByRole("heading", { name: /book the whole lodge/i }),
  ).toBeVisible();

  // The form asks for a headcount and who the group is, and NOTHING that would
  // answer "is the lodge free that week?".
  await expect(page.getByLabel(/roughly how many people/i)).toBeVisible();
  await expect(page.getByLabel(/who is the group/i)).toBeVisible();

  // innerText, NOT textContent: textContent includes the text of inlined
  // <script> and <style> elements (the theme bootstrap and the CSS custom
  // properties), which no member ever reads and which trip a "$<digit>" price
  // sweep on minified JS. innerText is what is actually rendered.
  const content = await page.locator("body").innerText();
  expect(content).not.toMatch(/beds? (left|available|free)/i);
  expect(content).not.toMatch(/fully booked|at capacity|no beds/i);
  expect(content).not.toMatch(/exclusiv/i);
  // No price is quoted at request time.
  expect(content).not.toMatch(/\$\d/);

  await page.close();
});

test("the officer queue's All filter survives the whole seeded database (#2342)", async () => {
  // The regression this spec found and #2342 fixed, guarded end to end against
  // the real seeded Postgres rather than a mocked row: `status=ALL` widens past
  // the QUEUE statuses and pulls in every historical request, including the
  // CONVERTED school group. One row whose stored guests, member links, or saved
  // quote fail their schema used to throw while serialising the page, so the
  // officer got a 500 and NONE of the queue — the whole point of the fix is
  // that a bad row costs one row.
  const response = await adminContext.request.get(
    "/api/admin/booking-requests?status=ALL&pageSize=100",
  );
  expect(
    response.ok(),
    `GET /api/admin/booking-requests?status=ALL returned ${response.status()}: ${await response.text()}`,
  ).toBe(true);

  const body = (await response.json()) as {
    data: Array<{
      id: string;
      status: string;
      guests: unknown[];
      guestDataNeedsAttention?: boolean;
      linkedMemberDataNeedsAttention?: boolean;
      quoteDataNeedsAttention?: boolean;
    }>;
    total: number;
  };
  // ALL must be a SUPERSET of the narrower filter this spec otherwise uses —
  // otherwise a 200 could be an empty page hiding the same failure.
  expect(body.data.length).toBeGreaterThan(0);
  expect(body.total).toBeGreaterThanOrEqual(body.data.length);
  const verifiedOnly = await listMemberOriginRequests(adminContext.request);
  for (const row of verifiedOnly) {
    expect(body.data.some((candidate) => candidate.id === row.id)).toBe(true);
  }
  // The seed itself is clean (its school children now carry surnames), so no
  // seeded row should be flagged. This is the assertion that would have caught
  // the original defect: before the fix the request above never returned at all.
  for (const row of body.data) {
    expect(
      Boolean(
        row.guestDataNeedsAttention ||
          row.linkedMemberDataNeedsAttention ||
          row.quoteDataNeedsAttention,
      ),
      `seeded request ${row.id} (${row.status}) came back flagged`,
    ).toBe(false);
  }
});

test("the officer sees the member badges and the admin-only availability strip, and approving holds the lodge", async () => {
  test.setTimeout(180_000);

  const page = await adminContext.newPage();
  // ?tab=public, NOT the bare path: /admin/booking-requests opens on the
  // Approvals tab, and the public/member request queue is only MOUNTED when the
  // Public Requests tab is active. The bare path renders a page with none of
  // this feature's UI on it.
  await page.goto("/admin/booking-requests?tab=public");

  // Both badges: "Member" (this came from an account) and "Whole lodge
  // requested" (the exclusivity ask, which the queue never used to show).
  await expect(page.getByText("Whole lodge requested").first()).toBeVisible();
  await expect(page.getByText("Member", { exact: true }).first()).toBeVisible();

  // The availability strip is admin-only and collapsed by default.
  const strip = page
    .getByRole("button", { name: /show availability for these nights/i })
    .first();
  await expect(strip).toBeVisible();
  await strip.click();
  await expect(page.getByText(/beds|held/i).first()).toBeVisible();

  // Approve the CLEAR-window request. Its own admission must fit, which is why
  // the clear window is the one approved.
  const approve = await adminContext.request.post(
    `/api/admin/booking-requests/${aliceRequestId}/approve`,
    { data: { pricedHeadcount: REQUEST_BODY.headcount } },
  );
  expect(approve.ok(), await approve.text()).toBe(true);
  const approved = (await approve.json()) as {
    type: string;
    bookingId: string;
    priceCents: number;
    guestCount: number;
    invoiceMode: string | null;
    exclusiveHoldConflicts: unknown[];
  };
  expect(approved.type).toBe("MEMBER_WHOLE_LODGE");
  expect(approved.priceCents).toBeGreaterThan(0);
  expect(approved.guestCount).toBe(REQUEST_BODY.headcount);
  // The receivable is invoiced one way or the other — never neither (#2263).
  // Which one depends on whether the staging stack has the Xero module on.
  expect(["xero", "manual"]).toContain(approved.invoiceMode);
  // Conflict surfacing reaches the ADMIN caller (empty here — the window was
  // clear — but the field is part of the admin contract).
  expect(Array.isArray(approved.exclusiveHoldConflicts)).toBe(true);
  approvedBookingId = approved.bookingId;

  // Re-approving replays idempotently onto the SAME booking: no second booking,
  // no second charge, and no second invoice — `invoiceMode: null` says so
  // rather than fabricating a mode this call did not use.
  const replay = await adminContext.request.post(
    `/api/admin/booking-requests/${aliceRequestId}/approve`,
    { data: { pricedHeadcount: REQUEST_BODY.headcount } },
  );
  expect(replay.ok(), await replay.text()).toBe(true);
  const replayed = (await replay.json()) as {
    bookingId: string;
    priceCents: number;
    invoiceMode: string | null;
  };
  expect(replayed.bookingId).toBe(approved.bookingId);
  expect(replayed.invoiceMode).toBeNull();
  // The replay echoes the COMMITTED total, not a fresh recomputation.
  expect(replayed.priceCents).toBe(approved.priceCents);

  await page.close();
});

test("the approved whole-lodge booking is indistinguishable from a full lodge on another member's calendar", async () => {
  // The pin under test (ADR-001 decision 6; getMonthAvailability in
  // src/lib/capacity.ts): a whole-lodge-held night reports FULL occupancy on the
  // member calendar whatever the real headcount is. The approved booking has 6
  // guests against a 20-bed lodge, so WITHOUT the pin the held nights would read
  // 6 and be trivially distinguishable from a genuinely full lodge. This is a
  // positive assertion about the number, not a sweep for a forbidden word.
  //
  // The lodge's configured capacity and the admin-side truth (wholeLodgeHeld)
  // come from the ADMIN-only hold-conflicts route for the very same request, so
  // the two sides of the pin are asserted against each other rather than
  // against a hardcoded capacity that would rot with the seed.
  const holdConflicts = await adminContext.request.get(
    `/api/admin/booking-requests/${aliceRequestId}/hold-conflicts`,
  );
  expect(holdConflicts.ok(), await holdConflicts.text()).toBe(true);
  const adminView = (await holdConflicts.json()) as {
    lodgeCapacity: number;
    nights: Array<{ date: string; wholeLodgeHeld: boolean }>;
  };
  expect(adminView.lodgeCapacity).toBeGreaterThan(REQUEST_BODY.headcount);
  expect(adminView.nights.length).toBe(CLEAR_WINDOW.nights.length);
  for (const night of adminView.nights) {
    expect(
      night.wholeLodgeHeld,
      `the admin side does not see ${night.date} as whole-lodge held`,
    ).toBe(true);
  }

  // Now the member side, read PER MONTH. A stay window can straddle a month
  // boundary (this one is 30 Nov -> 1 Dec), and /api/availability returns one
  // month at a time, so a single fetch silently reports `undefined` for the
  // nights in the other month — which is not "indistinguishable from full", it
  // is no answer at all.
  const { occupied, payloads } = await memberOccupiedBeds(
    wandaContext,
    CLEAR_WINDOW.nights,
  );
  for (const night of CLEAR_WINDOW.nights) {
    expect(
      occupied[night],
      `held night ${night} must read as a FULL lodge to another member`,
    ).toBe(adminView.lodgeCapacity);
  }

  // And nothing in the payload names the mechanism.
  const text = JSON.stringify(payloads).toLowerCase();
  expect(text).not.toContain("exclusiv");
  expect(text).not.toContain("wholelodge");
  expect(text).not.toContain("whole_lodge");
  expect(text).not.toContain("held");
});

test("the owner sees their approved request under My requests", async () => {
  const page = await aliceContext.newPage();
  await page.goto("/bookings");
  await expect(
    page.getByRole("heading", { name: /my requests/i }),
  ).toBeVisible();
  await expect(page.getByText(/^approved$/i).first()).toBeVisible();
  await expect(
    page.getByRole("link", { name: /open booking/i }).first(),
  ).toBeVisible();
  // The bounded-history statement is part of the contract with the member, not
  // decoration: declined and withdrawn rows really are purged at 90 days.
  await expect(page.getByText(/removed after 90 days/i)).toBeVisible();
  await page.close();
});

test("the approved booking tells its owner what is still owing, and never that the lodge is held", async () => {
  const page = await aliceContext.newPage();
  await page.goto(`/bookings/${approvedBookingId}`);

  // The booking is CONFIRMED with an UNPAID Internet Banking receivable, so the
  // owner is told the amount and the reference. That is the whole point of
  // raising the invoice (#2263) — there is no tokenised payment link on this
  // path, so the reference is the only way the member can pay.
  await expect(
    page.getByText(/internet banking payment/i).first(),
  ).toBeVisible();
  await expect(page.getByText(/amount due/i).first()).toBeVisible();
  await expect(page.getByText(/reference/i).first()).toBeVisible();

  // And still nothing about exclusivity or occupancy (ADR-001 decision 6).
  // innerText, NOT textContent: textContent includes the text of inlined
  // <script> and <style> elements (the theme bootstrap and the CSS custom
  // properties), which no member ever reads and which trip a "$<digit>" price
  // sweep on minified JS. innerText is what is actually rendered.
  const content = await page.locator("body").innerText();
  expect(content).not.toMatch(/exclusiv/i);
  expect(content).not.toMatch(/whole[- ]lodge hold/i);

  await page.close();
});

test("a member cannot withdraw somebody else's OPEN request", async () => {
  // Wanda's full-window request is genuinely open and genuinely withdrawable —
  // the very next test has Wanda withdraw this exact row successfully. So the
  // refusal here can only be about WHO is asking, which is the property under
  // test. Aiming at an already-decided row would 409 for its status instead and
  // prove nothing about ownership.
  expect(wandaRequestId).toBeTruthy();
  const response = await nadiaContext.request.post(
    `/api/booking-requests/whole-lodge/${wandaRequestId}/withdraw`,
  );
  // EXACTLY 409. The WHERE names the owner, so somebody else's id behaves like
  // an id that does not exist — and the service has no 404 path at all, so
  // tolerating a 404 here would tolerate a status this code cannot produce.
  expect(response.status()).toBe(409);
});

test("a member can withdraw their own pending request, and the button is not offered twice", async () => {
  const page = await wandaContext.newPage();
  await page.goto("/bookings");

  const withdraw = page.getByRole("button", { name: /^withdraw$/i }).first();
  await expect(withdraw).toBeVisible();
  await withdraw.click();

  await expect(page.getByText(/^withdrawn$/i).first()).toBeVisible();
  // Withdraw is not offered twice.
  await expect(page.getByRole("button", { name: /^withdraw$/i })).toHaveCount(0);

  await page.close();
});

test("an anonymous caller cannot submit a whole-lodge request at all", async ({
  request,
}) => {
  const response = await request.post("/api/booking-requests/whole-lodge", {
    data: {
      ...REQUEST_BODY,
      checkIn: CLEAR_WINDOW.checkIn,
      checkOut: CLEAR_WINDOW.checkOut,
    },
  });
  // The public GENERAL front-door still may not ask for the whole lodge; this
  // door requires a session (ADR-001, dated 2026-07-30 entry).
  expect(response.status()).toBe(401);
});
