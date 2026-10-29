import { type BrowserContext, expect, test } from "./helpers/accessibility";
import { loginPersona, storageStatePath } from "./helpers/auth";
import {
  bookingCreateIsolation,
  postBookingCreate,
} from "./helpers/booking-create-client-ip";
import {
  E2E_ADMIN,
  WAITLIST_FULL_WINDOW,
  WAITLIST_OFFER_BOOKING_ID,
  WAITLISTER,
} from "./helpers/fixtures";
import { cancelMemberBookingsOnDate } from "./helpers/reset";

// High row (docs/END_TO_END_TEST_MATRIX.md): "Waitlist, offer expiry,
// force-confirm, bump/cancel."
//
// Coverage and the deliberate gaps:
//  - Placement: Wanda books a seeded-full September window. The wizard's own
//    client capacity pre-check blocks a KNOWN-full night before its in-wizard
//    waitlist prompt (which only fires on a submit-time race), so placement is
//    driven through the same endpoint the wizard calls after a 409
//    (POST /api/bookings { waitlist: true }) — the faithful server path.
//  - Admin force-confirm: the only admin waitlist mutation, driven through the
//    /admin/waitlist UI (overbook branch, since the night is full).
//  - Member accept offer: a seeded, non-expired WAITLIST_OFFERED booking is
//    accepted through the member offer card.
//  - Offer creation + expiry run ONLY on the in-process scheduler
//    (src/lib/cron-waitlist.ts via instrumentation.node.ts; CRON_ENABLED is off
//    in staging and there is no HTTP waitlist-cron endpoint), so those are not
//    browser-reachable — the offer/expiry STATE is asserted via the admin UI on
//    the seeded (expired) offer instead.
//
// Wanda (not alice) drives this: she is seeded PAID with a complete, confirmed
// profile, so the booking API accepts her without the member-details gate.
//
// RETRY SHAPE (#2302). Only the first two tests are a single story (test 2
// force-confirms the booking test 1 creates), so ONLY THEY are `mode: "serial"`,
// and their shared `beforeAll` restores the pre-attempt database state. The last
// two read seeded fixtures and depend on nothing above them, so they stay
// independent tests: a failure in either retries that test alone and can never
// drag the placement pair back through a database it has already mutated. That
// pairing — narrow serial groups plus an idempotent group `beforeAll` — is the
// rule for this suite. Both create calls deliberately share this test attempt's
// registered booking-create IP, while a retry gets a different bucket; see
// e2e/helpers/reset.ts and docs/E2E_PLAYWRIGHT.md.

let memberContext: BrowserContext;
let adminContext: BrowserContext;

test.beforeAll(async ({ browser }) => {
  // One fresh login (WAITLISTER) incl. possible first-time two-factor
  // enrollment: needs more than the default 90s hook budget on a loaded runner.
  test.setTimeout(240_000);
  memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await loginPersona(memberPage, WAITLISTER.email);
  await memberPage.close();

  // Reuse the E2E admin session saved once in auth.setup.ts instead of a fresh
  // per-spec login (#1779).
  adminContext = await browser.newContext({
    storageState: storageStatePath(E2E_ADMIN.email),
  });
});

test.afterAll(async () => {
  await memberContext?.close();
  await adminContext?.close();
});

test.describe("placement then admin force-confirm", () => {
  // Serial: test 2 force-confirms the booking test 1 creates, so test 2 must
  // run after it and must be skipped when it fails.
  test.describe.configure({ mode: "serial" });

  // Playwright retries a serial group AS A WHOLE, and the suite seeds once per
  // run — so without this the retry of a failed attempt would find Wanda
  // already holding the seeded-full window and get
  // BOOKING_MEMBER_NIGHT_CONFLICT where the test asserts CAPACITY_EXCEEDED
  // (#2302: the exact signature observed in run 30478504882 and 30511205530).
  // Cancelling is enough: CANCELLED is outside
  // MEMBER_NIGHT_CONFLICT_BOOKING_STATUSES, and the window stays full from the
  // 22 seeded filler guests, which belong to LODGE_FILL_OWNER and are never
  // touched here. A clean first attempt cancels nothing.
  test.beforeAll(async () => {
    await cancelMemberBookingsOnDate(adminContext.request, {
      memberName: `${WAITLISTER.firstName} ${WAITLISTER.lastName}`,
      checkIn: WAITLIST_FULL_WINDOW.checkIn,
    });
  });

  test("a full lodge night is refused and the member can join the waitlist", async ({}, testInfo) => {
    const session = (await (
      await memberContext.request.get("/api/auth/session")
    ).json()) as { user?: { id?: string } };
    const memberId = session.user?.id;
    expect(memberId, "Wanda's session should expose her member id").toBeTruthy();

    const guest = {
      firstName: WAITLISTER.firstName,
      lastName: WAITLISTER.lastName,
      ageTier: "ADULT" as const,
      isMember: true,
      memberId,
      stayStart: WAITLIST_FULL_WINDOW.checkIn,
      stayEnd: WAITLIST_FULL_WINDOW.checkOut,
      nights: WAITLIST_FULL_WINDOW.nights,
    };

    // A plain booking on the seeded-full window is refused for capacity.
    const refused = await postBookingCreate(
      memberContext.request,
      bookingCreateIsolation("waitlist-placement", testInfo.retry),
      {
        data: {
          checkIn: WAITLIST_FULL_WINDOW.checkIn,
          checkOut: WAITLIST_FULL_WINDOW.checkOut,
          guests: [guest],
        },
      },
    );
    const refusedBody = (await refused.json().catch(() => ({}))) as {
      code?: string;
    };
    expect(
      refused.status(),
      `full night should 409: ${JSON.stringify(refusedBody)}`,
    ).toBe(409);
    // CAPACITY_EXCEEDED, not BOOKING_MEMBER_NIGHT_CONFLICT: the beforeAll above
    // guarantees Wanda holds nothing on this window, so the only reason this
    // booking can be refused is the seeded 22-guest fill (#2302).
    expect(
      refusedBody.code,
      "refusal must be about lodge capacity, not a leftover booking of Wanda's",
    ).toBe("CAPACITY_EXCEEDED");

    // Opting into the waitlist creates a WAITLISTED booking (the exact retry the
    // /book wizard performs after the 409).
    const waitlisted = await postBookingCreate(
      memberContext.request,
      bookingCreateIsolation("waitlist-placement", testInfo.retry),
      {
        data: {
          checkIn: WAITLIST_FULL_WINDOW.checkIn,
          checkOut: WAITLIST_FULL_WINDOW.checkOut,
          guests: [guest],
          waitlist: true,
        },
      },
    );
    const waitlistedBody = (await waitlisted.json().catch(() => ({}))) as {
      status?: string;
    };
    expect(
      waitlisted.status(),
      `waitlist opt-in: ${JSON.stringify(waitlistedBody)}`,
    ).toBe(201);
    expect(waitlistedBody.status).toBe("WAITLISTED");
  });

  test("an admin force-confirms the waitlisted booking off the waitlist", async () => {
    const adminPage = await adminContext.newPage();
    await adminPage.goto("/admin/waitlist");
    await expect(
      adminPage.getByRole("heading", { name: "Waitlist" }),
    ).toBeVisible();

    // Force-confirm the booking on the full window. Exactly one waitlist row can
    // carry this check-in — the beforeAll above cancelled any leftover from a
    // previous attempt, so this stays a single-match (strict-mode-safe) locator.
    const row = adminPage.locator("tr", {
      hasText: WAITLIST_FULL_WINDOW.checkIn,
    });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: /Force Confirm/ }).click();

    // The night is full, so force-confirm surfaces the overbook confirmation.
    await expect(
      adminPage.getByText(/This will overbook the lodge/),
    ).toBeVisible();
    await adminPage
      .getByRole("button", { name: /Confirm Anyway \(Overbook\)/ })
      .click();

    await expect(
      adminPage.getByText("Force-confirmed overbooked booking"),
    ).toBeVisible();
    await adminPage.close();
  });
});

test("a member accepts a waitlist offer and owes payment", async () => {
  const memberPage = await memberContext.newPage();
  await memberPage.goto(`/bookings/${WAITLIST_OFFER_BOOKING_ID}`);

  // `/bookings/[id]` has a loading.tsx, so it is a React streaming (Suspense)
  // boundary: during the reveal the offer card exists TWICE for a beat — once in
  // a `hidden` streamed template and once live — which trips strict mode on a
  // bare text match (#21; the #2302 failure in run 30478504882 was exactly this,
  // "resolved to 2 elements … unexpected value 'hidden'"). Filter to the visible
  // instance so the assertion converges on the revealed card, exactly as
  // e2e/multi-lodge/member-cross-lodge.spec.ts already does.
  const offerCard = memberPage.getByText("A Spot Has Opened Up!");
  await expect(offerCard.filter({ visible: true })).toBeVisible();
  await memberPage.getByRole("button", { name: "Confirm Booking" }).click();

  // Deterministic outcome: on success the card triggers a hard reload, so the
  // CTA can never stick on "Confirming…" and the page re-renders from the server
  // to its post-acceptance state — the booking moves off WAITLIST_OFFERED to
  // PAYMENT_PENDING, the "A Spot Has Opened Up!" offer card is gone, and payment
  // is owed (#1371 F28). Asserted against the freshly reloaded DOM. Counted on
  // the UNFILTERED locator on purpose: "gone" must mean gone from the DOM, not
  // merely hidden in a streamed template.
  await expect(offerCard).toHaveCount(0, { timeout: 30_000 });
  // Scope to the content column: the #1818 long-page SectionNav rail renders a
  // "Payment" anchor ahead of the content, so an unscoped getByText(/payment/i)
  // .first() would resolve to a (collapsed, hidden) nav link. The testid excludes
  // the rail while preserving the original loose "payment is owed" assertion.
  await expect(
    memberPage
      .getByTestId("booking-detail-content")
      .getByText(/payment/i)
      .first(),
  ).toBeVisible();
  await memberPage.close();
});

test("the admin waitlist surfaces offer and expiry state", async () => {
  const adminPage = await adminContext.newPage();
  await adminPage.goto("/admin/waitlist");
  await expect(adminPage.getByRole("heading", { name: "Waitlist" })).toBeVisible();

  // The seeded (expired) offer is shown as offered, with its expiry — the state
  // the in-process expiry cron would act on. Offer creation/expiry themselves
  // are not browser-reachable (see the file header).
  await expect(adminPage.getByText(/Waitlist Offered/i).first()).toBeVisible();
  await expect(adminPage.getByText(/Offer expires/i).first()).toBeVisible();
  await adminPage.close();
});
