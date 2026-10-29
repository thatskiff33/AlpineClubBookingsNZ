import { type BrowserContext, expect, test } from "../helpers/accessibility";
import { loginPersona } from "../helpers/auth";
import {
  CAPACITY_ISOLATION_GUEST_COUNT,
  CAPACITY_ISOLATION_WINDOW,
  CROSS_LODGE_OFFER_BOOKING_ID,
  CROSS_LODGE_OFFER_MEMBER_GUEST_BOOKING_ID,
  SECOND_LODGE,
  SECOND_LODGE_BED_COUNT,
  WAITLIST_FULL_WINDOW,
  WAITLISTER,
} from "../helpers/fixtures";

// Multi-lodge coverage (issue #1568), member-facing scenarios. Runs
// ONLY in the `multi-lodge` Playwright project against a two-lodge database
// (E2E_MULTI_LODGE=1 → e2e/setup/seed-second-lodge.ts). This is a coverage
// project, NOT a substitute for the manual staging matrix in
// docs/multi-lodge/test-plan.md.
//
// Wanda (WAITLISTER) drives all three: she is seeded PAID with a complete,
// confirmed profile and no lodge restriction, so the member-details gate never
// blocks her and she is eligible to book both lodges. One shared context (like
// waitlist.spec) keeps the TOTP-enrollment login to one, which is the flaky part.
test.describe.configure({ mode: "serial" });

type LodgeOption = { id: string; name: string };
type NightDetail = { date: string; occupiedBeds: number; availableBeds: number };
type Availability = { minAvailable: number; nightDetails: NightDetail[] };

let memberContext: BrowserContext;

// Resolve lodge ids from the member lodge endpoint the /book selector uses:
// lodge B is the seeded second lodge; lodge A is the club's original lodge.
async function resolveLodges(
  context: BrowserContext,
): Promise<{ lodgeA: LodgeOption; lodgeB: LodgeOption }> {
  const response = await context.request.get("/api/lodges");
  expect(response.ok(), "/api/lodges must succeed for a signed-in member").toBeTruthy();
  const body = (await response.json()) as { lodges: LodgeOption[] };
  const lodgeB = body.lodges.find((lodge) => lodge.name === SECOND_LODGE.name);
  const lodgeA = body.lodges.find((lodge) => lodge.name !== SECOND_LODGE.name);
  expect(
    lodgeA && lodgeB,
    `both lodges must be offered to the member: ${JSON.stringify(body.lodges)}`,
  ).toBeTruthy();
  return { lodgeA: lodgeA as LodgeOption, lodgeB: lodgeB as LodgeOption };
}

async function availabilityFor(
  context: BrowserContext,
  lodgeId: string,
  checkIn: string,
  checkOut: string,
): Promise<Availability> {
  const response = await context.request.get(
    `/api/availability/check?checkIn=${checkIn}&checkOut=${checkOut}&lodgeId=${encodeURIComponent(lodgeId)}`,
  );
  expect(
    response.ok(),
    `availability/check for lodge ${lodgeId} (${checkIn}..${checkOut})`,
  ).toBeTruthy();
  return (await response.json()) as Availability;
}

test.beforeAll(async ({ browser }) => {
  // A fresh login incl. first-time two-factor enrollment needs more than the
  // default hook budget on a loaded CI runner.
  test.setTimeout(240_000);
  memberContext = await browser.newContext();
  const page = await memberContext.newPage();
  await loginPersona(page, WAITLISTER.email);
  await page.close();
});

test.afterAll(async () => {
  await memberContext?.close();
});

test("(a) /book offers a lodge-selection step and availability is isolated per lodge", async () => {
  const page = await memberContext.newPage();
  await page.goto("/book");

  // With two eligible lodges the /book dates step renders the lodge selector
  // (ADR-002: it renders nothing for a single-lodge club).
  const trigger = page.locator("#lodge-select");
  await expect(trigger).toBeVisible();
  await trigger.click();
  const options = page.getByRole("option");
  await expect(options).toHaveCount(2);
  await expect(page.getByRole("option", { name: SECOND_LODGE.name })).toBeVisible();
  await page.getByRole("option", { name: SECOND_LODGE.name }).click();

  // Choosing a lodge lands on that lodge's date selection.
  await expect(page.getByText("Select Your Dates")).toBeVisible();
  await page.close();

  // Per-lodge availability isolation: lodge A's seeded-full window is full while
  // lodge B is wide open on the very same nights — no cross-lodge summation.
  const { lodgeA, lodgeB } = await resolveLodges(memberContext);
  const fullAtLodgeA = await availabilityFor(
    memberContext,
    lodgeA.id,
    WAITLIST_FULL_WINDOW.checkIn,
    WAITLIST_FULL_WINDOW.checkOut,
  );
  const openAtLodgeB = await availabilityFor(
    memberContext,
    lodgeB.id,
    WAITLIST_FULL_WINDOW.checkIn,
    WAITLIST_FULL_WINDOW.checkOut,
  );
  expect(
    fullAtLodgeA.minAvailable,
    "lodge A is full on its seeded-full window",
  ).toBeLessThanOrEqual(0);
  expect(
    openAtLodgeB.minAvailable,
    "lodge B is unaffected by lodge A being full",
  ).toBe(SECOND_LODGE_BED_COUNT);
});

test("(b) a capacity-holding booking at lodge B does not consume lodge A capacity", async () => {
  const { lodgeA, lodgeB } = await resolveLodges(memberContext);
  const atLodgeB = await availabilityFor(
    memberContext,
    lodgeB.id,
    CAPACITY_ISOLATION_WINDOW.checkIn,
    CAPACITY_ISOLATION_WINDOW.checkOut,
  );
  const atLodgeA = await availabilityFor(
    memberContext,
    lodgeA.id,
    CAPACITY_ISOLATION_WINDOW.checkIn,
    CAPACITY_ISOLATION_WINDOW.checkOut,
  );

  for (const night of CAPACITY_ISOLATION_WINDOW.nights) {
    const lodgeBNight = atLodgeB.nightDetails.find((n) => n.date === night);
    const lodgeANight = atLodgeA.nightDetails.find((n) => n.date === night);
    expect(
      lodgeBNight?.occupiedBeds,
      `lodge B occupancy on ${night} (the seeded PAID hold)`,
    ).toBe(CAPACITY_ISOLATION_GUEST_COUNT);
    expect(
      lodgeANight?.occupiedBeds,
      `lodge A occupancy on ${night} must be untouched by lodge B's booking`,
    ).toBe(0);
  }
});

test("(d) a cross-lodge waitlist offer confirms into a fresh lodge B booking", async () => {
  const page = await memberContext.newPage();
  await page.goto(`/bookings/${CROSS_LODGE_OFFER_BOOKING_ID}`);

  // The /bookings/[id] segment has a loading.tsx, so it is a React streaming
  // (Suspense) boundary: during the reveal the offer card exists twice for a
  // beat — once in a `hidden` streamed template and once live — which trips
  // strict mode on a bare text match (#21). Filter to the visible instance so
  // the assertion converges on the revealed card instead of the template.
  await expect(
    page.getByText("A Spot Has Opened Up!").filter({ visible: true }),
  ).toBeVisible();
  // The cross-lodge offer names lodge B on its accept CTA (substring match, so
  // the lodge name's parentheses need no escaping).
  const confirm = page.getByRole("button", {
    name: `Confirm at ${SECOND_LODGE.name}`,
  });
  await expect(confirm).toBeVisible();
  await confirm.click();

  // Accepting create-and-cancels the entry into a NEW booking at lodge B and
  // hard-navigates there (ADR-004): the URL leaves the offer id, the offer card
  // is gone, and payment is now owed at lodge B. The seeded offer price is
  // quoted from lodge B's own rates, so the confirm never trips
  // OFFER_PRICE_CHANGED.
  await page.waitForURL(
    (url) =>
      /\/bookings\/[^/]+$/.test(url.pathname) &&
      !url.pathname.endsWith(CROSS_LODGE_OFFER_BOOKING_ID),
    { timeout: 30_000 },
  );
  await expect(page.getByText("A Spot Has Opened Up!")).toHaveCount(0);
  // Scope to the content column so the #1818 SectionNav "Payment" anchor (which
  // precedes the content) can't be matched by this loose payment-owed check.
  await expect(
    page
      .getByTestId("booking-detail-content")
      .getByText(/payment/i)
      .first(),
  ).toBeVisible();
  await page.close();
});

test("(e) a member-guest cross-lodge offer confirms into a fresh lodge B booking (#1628 regression)", async () => {
  // Regression for #1628/#1609 (formerly the expected-fail tripwire): the
  // Phase-2 member-night guard now excludes the entry being replaced, so a
  // member-linked guest row on the still-live WAITLIST_OFFERED entry no longer
  // blocks its own confirm. Same success criterion as (d), driven through the
  // member-guest offer fixture.
  const page = await memberContext.newPage();
  await page.goto(`/bookings/${CROSS_LODGE_OFFER_MEMBER_GUEST_BOOKING_ID}`);

  // Filter to the visible card: the streaming template briefly duplicates it (#21).
  await expect(
    page.getByText("A Spot Has Opened Up!").filter({ visible: true }),
  ).toBeVisible();
  const confirm = page.getByRole("button", {
    name: `Confirm at ${SECOND_LODGE.name}`,
  });
  await expect(confirm).toBeVisible();
  await confirm.click();

  // Mirrors (d)'s success criterion: the confirm create-and-cancels the entry
  // into a NEW booking at lodge B and hard-navigates there.
  await page.waitForURL(
    (url) =>
      /\/bookings\/[^/]+$/.test(url.pathname) &&
      !url.pathname.endsWith(CROSS_LODGE_OFFER_MEMBER_GUEST_BOOKING_ID),
    { timeout: 30_000 },
  );
  await expect(page.getByText("A Spot Has Opened Up!")).toHaveCount(0);
  await page.close();
});
