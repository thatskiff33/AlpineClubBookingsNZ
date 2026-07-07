import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  test,
} from "@playwright/test";
import { completeMemberDetailsGateIfShown } from "../helpers/booking";
import { loginPersona } from "../helpers/auth";
import { personas } from "../helpers/personas";
import {
  CROSS_LODGE_OFFER_MEMBER_ID,
  CROSS_LODGE_OFFER_NONMEMBER_ID,
  LODGE_A_ISOLATION_GUEST,
  LODGE_A_ISOLATION_GUEST_COUNT,
  TWO_LODGE_ISOLATION_WINDOW,
  WAITLISTER,
  WEST_RIDGE_ISOLATION_GUEST,
  WEST_RIDGE_ISOLATION_GUEST_COUNT,
  WEST_RIDGE_KIOSK,
  WEST_RIDGE_NAME,
} from "../helpers/fixtures";

// ADVISORY two-lodge coverage (#1568). Runs ONLY via
// playwright.two-lodge.config.ts against a stack prepared with a second active
// lodge (West Ridge Hut), the multiLodge module ON, and the two-lodge fixtures
// (e2e/setup/seed-two-lodge.ts). It is never part of the blocking single-lodge
// suite. See docs/END_TO_END_TEST_MATRIX.md and docs/multi-lodge/test-plan.md.
//
// The specs assert per-lodge isolation the single-lodge suite cannot reach:
//   a. /book shows the lodge step and availability is per lodge;
//   b. a booking at one lodge does not consume the other lodge's capacity;
//   c. a kiosk bound to West Ridge sees only West Ridge's roster;
//   d. a cross-lodge waitlist offer with a non-member guest confirms;
//   e. the #1609 member-guest cross-lodge confirm (expected-fail).
test.describe.configure({ mode: "serial" });

// Month index the availability API expects is 0-based (0 = January).
const SEPTEMBER = 8;
const ISOLATION_NIGHT = TWO_LODGE_ISOLATION_WINDOW.nights[0];

let bookerContext: BrowserContext;
let kioskContext: BrowserContext;
let wandaContext: BrowserContext;
let wandaRequest: APIRequestContext;

async function occupiedBeds(
  request: APIRequestContext,
  lodgeId: string,
  year: number,
  monthIndex: number,
  night: string,
): Promise<number> {
  const res = await request.get(
    `/api/availability?year=${year}&month=${monthIndex}&lodgeId=${encodeURIComponent(lodgeId)}`,
  );
  expect(res.ok(), `availability API (${res.status()})`).toBeTruthy();
  const body = (await res.json()) as { availability: Record<string, number> };
  return body.availability[night] ?? 0;
}

async function lodgeIds(
  request: APIRequestContext,
): Promise<{ defaultLodgeId: string; westRidgeId: string }> {
  const res = await request.get("/api/lodges");
  expect(res.ok(), `/api/lodges (${res.status()})`).toBeTruthy();
  const body = (await res.json()) as {
    lodges: Array<{ id: string; name: string }>;
  };
  const westRidge = body.lodges.find((l) => l.name === WEST_RIDGE_NAME);
  const other = body.lodges.find((l) => l.name !== WEST_RIDGE_NAME);
  expect(westRidge, "West Ridge Hut must be a bookable lodge").toBeTruthy();
  expect(other, "the default lodge must be a bookable lodge").toBeTruthy();
  return { defaultLodgeId: other!.id, westRidgeId: westRidge!.id };
}

// POST the waitlist confirm and return the parsed result WITHOUT throwing on a
// non-ok response, so an expected-fail cannot pass on a thrown error.
async function confirmOffer(
  request: APIRequestContext,
  bookingId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await request.post(`/api/bookings/${bookingId}/waitlist-confirm`);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status(), body };
}

test.beforeAll(async ({ browser }) => {
  // Three fresh logins, each completing first-time two-factor enrollment on a
  // freshly seeded database: well beyond the default hook budget.
  test.setTimeout(300_000);

  bookerContext = await browser.newContext();
  const bookerPage = await bookerContext.newPage();
  await loginPersona(bookerPage, personas.booker.email);
  await bookerPage.close();

  kioskContext = await browser.newContext();
  const kioskPage = await kioskContext.newPage();
  await loginPersona(kioskPage, WEST_RIDGE_KIOSK.email);
  await kioskPage.close();

  wandaContext = await browser.newContext();
  const wandaPage = await wandaContext.newPage();
  await loginPersona(wandaPage, WAITLISTER.email);
  await wandaPage.close();
  wandaRequest = wandaContext.request;
});

test.afterAll(async () => {
  await bookerContext?.close();
  await kioskContext?.close();
  await wandaContext?.close();
});

test("member /book shows the lodge step and availability is per lodge (3a)", async () => {
  const page = await bookerContext.newPage();
  await page.goto("/book");
  await completeMemberDetailsGateIfShown(page);

  // The lodge step only renders with two or more bookable lodges (ADR-002); its
  // presence proves multiLodge is on for this app instance.
  await expect(page.getByText("Select Your Dates")).toBeVisible();
  const lodgeSelect = page.getByLabel("Lodge");
  await expect(lodgeSelect).toBeVisible();

  // West Ridge is offered as an alternate lodge.
  await lodgeSelect.click();
  await expect(
    page.getByRole("option", { name: WEST_RIDGE_NAME }),
  ).toBeVisible();
  await page.getByRole("option", { name: WEST_RIDGE_NAME }).click();

  // Per-lodge availability isolation: the seeded same-night bookings give each
  // lodge a distinct, independent occupancy on ISOLATION_NIGHT.
  const { defaultLodgeId, westRidgeId } = await lodgeIds(page.request);
  const defaultOccupied = await occupiedBeds(
    page.request,
    defaultLodgeId,
    2026,
    SEPTEMBER,
    ISOLATION_NIGHT,
  );
  const westRidgeOccupied = await occupiedBeds(
    page.request,
    westRidgeId,
    2026,
    SEPTEMBER,
    ISOLATION_NIGHT,
  );
  expect(defaultOccupied).toBe(LODGE_A_ISOLATION_GUEST_COUNT);
  expect(westRidgeOccupied).toBe(WEST_RIDGE_ISOLATION_GUEST_COUNT);
  expect(defaultOccupied).not.toBe(westRidgeOccupied);
  await page.close();
});

test("a booking at one lodge does not consume the other lodge's capacity (3b)", async () => {
  // The West Ridge same-night booking (2 guests) must not appear in the default
  // lodge's occupancy, and vice versa — proven by each lodge reporting exactly
  // its own seeded booking's guest count on ISOLATION_NIGHT.
  const page = await bookerContext.newPage();
  const { defaultLodgeId, westRidgeId } = await lodgeIds(page.request);

  const defaultOccupied = await occupiedBeds(
    page.request,
    defaultLodgeId,
    2026,
    SEPTEMBER,
    ISOLATION_NIGHT,
  );
  const westRidgeOccupied = await occupiedBeds(
    page.request,
    westRidgeId,
    2026,
    SEPTEMBER,
    ISOLATION_NIGHT,
  );

  // If capacity leaked across lodges either count would include the other
  // lodge's guests; exact per-lodge counts prove it does not.
  expect(defaultOccupied).toBe(LODGE_A_ISOLATION_GUEST_COUNT);
  expect(westRidgeOccupied).toBe(WEST_RIDGE_ISOLATION_GUEST_COUNT);
  await page.close();
});

test("a kiosk bound to West Ridge sees only West Ridge's roster (3c)", async () => {
  const res = await kioskContext.request.get(
    `/api/lodge/guests/${ISOLATION_NIGHT}?scope=lodge-list`,
  );
  expect(res.ok(), `/api/lodge/guests (${res.status()})`).toBeTruthy();
  const body = (await res.json()) as {
    bookings: Array<{ guests: Array<{ firstName: string; lastName: string }> }>;
  };
  const names = body.bookings.flatMap((b) =>
    b.guests.map((g) => `${g.firstName} ${g.lastName}`),
  );

  // West Ridge's own same-night guest is on the roster...
  expect(names).toContain(
    `${WEST_RIDGE_ISOLATION_GUEST.firstName} ${WEST_RIDGE_ISOLATION_GUEST.lastName}`,
  );
  // ...but the default lodge's same-night guest is NOT (kiosk scoped to B).
  expect(names).not.toContain(
    `${LODGE_A_ISOLATION_GUEST.firstName} ${LODGE_A_ISOLATION_GUEST.lastName}`,
  );
});

test("a cross-lodge waitlist offer with a non-member guest confirms (3d)", async () => {
  // The stored offer price is deliberately stale, so the first confirm refreshes
  // it (OFFER_PRICE_CHANGED) in Phase 1 without consuming the offer — this
  // primes the price without hardcoding a West Ridge rate.
  const primed = await confirmOffer(wandaRequest, CROSS_LODGE_OFFER_NONMEMBER_ID);
  expect(primed.body.code, JSON.stringify(primed.body)).toBe(
    "OFFER_PRICE_CHANGED",
  );

  // Confirm again at the refreshed price. The offer's only guest is a
  // non-member (no memberId), so the Phase-2 member-night guard has no member to
  // conflict on and the cross-lodge create-and-cancel path succeeds.
  const confirmed = await confirmOffer(
    wandaRequest,
    CROSS_LODGE_OFFER_NONMEMBER_ID,
  );
  expect(confirmed.body.success, JSON.stringify(confirmed.body)).toBe(true);
  expect(confirmed.body.newBookingId).toBeTruthy();
});

test.describe("the #1609 member-guest cross-lodge confirm", () => {
  test.beforeAll(async () => {
    // Prime the stale price OUTSIDE the expected-fail so a price-drift response
    // can NEVER make the expected-fail pass spuriously. Phase 1 refreshes the
    // price and returns early (the offer stays WAITLIST_OFFERED); this confirm
    // never reaches the Phase-2 member-night guard.
    const primed = await confirmOffer(wandaRequest, CROSS_LODGE_OFFER_MEMBER_ID);
    expect(primed.body.code, JSON.stringify(primed.body)).toBe(
      "OFFER_PRICE_CHANGED",
    );
  });

  // #1609 (source-verified): the member is her own guest, so the Phase-2
  // member-night guard trips on the entry's OWN WAITLIST_OFFERED booking —
  // createConfirmedBooking is passed no excludeBookingId for that guard — and
  // the confirm fails today. Encoded as an expected-fail with exactly one
  // assertion. If it ever passes, Playwright reports it as unexpectedly passing,
  // which disproves #1609 (the guard was fixed or the composition changed).
  test("a member self-booked cross-lodge offer confirms", async () => {
    test.fail();
    const confirmed = await confirmOffer(wandaRequest, CROSS_LODGE_OFFER_MEMBER_ID);
    expect(confirmed.body.success).toBe(true);
  });
});
