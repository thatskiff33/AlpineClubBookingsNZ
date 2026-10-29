import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  test,
} from "./helpers/accessibility";

import { loginPersona, storageStatePath } from "./helpers/auth";
import {
  bookingCreateIsolation,
  postBookingCreate,
} from "./helpers/booking-create-client-ip";
import { E2E_ADMIN, LOCKED_OUT_MEMBER } from "./helpers/fixtures";
import { overrideModules, setModuleSettings } from "./helpers/modules";
import { cancelMemberBookingsOnDate } from "./helpers/reset";
import { stayWindowForAttempt } from "./helpers/stay-dates";
import {
  payWithCard,
  STRIPE_SKIP_REASON,
  stripeTestModeConfigured,
  TEST_CARDS,
} from "./helpers/stripe";

/**
 * #2779 — a subscription-locked member picks up and pays a booking an admin made
 * on their behalf.
 *
 * WHY THIS SPEC EXISTS. #2779 was filed as an enforcement gap: under the
 * platform-default HARD_BLOCK lockout, a member with an unpaid subscription
 * cannot confirm a FREE draft but CAN confirm a priced one by paying for it. The
 * owner ruled (11 Aug 2026) that the asymmetry is deliberate and load-bearing —
 * it is the only way the club can make a booking for a member whose subscription
 * is in arrears and have that member complete it themselves:
 *
 *   > We need a way where a locked out member due to subscription can have an
 *   > admin "book on behalf" booking made and then the member logs in and picks
 *   > up the pending booking and pays it.
 *
 * So the payment path staying ungated is a FEATURE (`INV-LOCKOUT-069`), and this
 * spec is the standing proof that the journey it enables actually completes.
 *
 * WHY IT CANNOT BE A UNIT TEST. Three things only the running app can show, and
 * each is a way the journey has failed for a real member without any unit test
 * going red:
 *
 *  1. THE MEMBER IS GENUINELY LOCKED OUT while paying. Unit tests mock the
 *     lockout mode and the subscription row. Here the club's real setting is
 *     saved through the real admin panel API, the member's subscription is
 *     really unpaid in the database, and the SAME member is refused their own
 *     booking seconds before the payment path admits them.
 *  2. THE PATH IS FINDABLE. A journey that works only if you already know the
 *     booking's URL is not a journey. The member's dashboard must surface the
 *     draft, say the club saved it, and lead to a working pay control.
 *  3. THE TWO GATES COMPOSE. Create-on-behalf, discovery, and pay each pass on
 *     their own today; nothing but a whole run proves that the booking one
 *     produced is the booking the next one admits.
 *
 * SELF-RESTORING. The lockout mode and the Xero module are club-wide settings
 * every other spec's bookings run through, so both are snapshotted in
 * `beforeAll` and put back in `afterAll` whatever happens. The Xero module has to
 * be ON for the lockout to bite at all — subscriptions are invoiced through Xero,
 * so `resolveSubscriptionLockoutMode` answers NO_BLOCK while the module is off.
 *
 * WINDOW: base index 28 — attempts land on 28 / 44 / 60.
 *
 * Base 10 was WRONG and is the kind of wrong that hides: it is already
 * `COMPLIANT_WINDOW_INDEX` in `member-policy-exception-requests.spec.ts`, and its
 * retry-1 index 26 is also reached by `multi-lodge/policy-exception-second-lodge.spec.ts`
 * (`stayWindow(25 + retry)`). One worker and `fullyParallel: false` keep the two
 * specs from ever running together, and they book different members, so nothing
 * failed — but this spec can leave a PAID/CONFIRMED booking on those nights when
 * Stripe test keys are configured, and #1703 / #2625 are both collisions that
 * were "harmless" until they were not.
 *
 * 28 / 44 / 60 is no longer a hand-checked claim: it is asserted by
 * `src/lib/__tests__/e2e-stay-window-disjointness.test.ts`, which parses every
 * spec's window calls (including the `n + retry * k` shapes), fails on any
 * collision with this band, and fails if this very comment stops matching the
 * code. Move the base index and that test tells you what is free.
 *
 * The MAX_MONTH_HOPS ceiling documented on `RETRY_WINDOW_STRIDE` does not bind
 * here: this spec never clicks the booking calendar — it creates every booking
 * over the API and opens pages by URL — so a far-out window costs no navigation.
 * `stayWindow` still throws loudly if index 60 ever falls outside the seeded
 * seasons.
 *
 * STRIPE: the final card charge is skipped unless real test-mode keys are
 * configured, exactly as `stripe-payment.spec.ts` does. Everything that #2779 is
 * ABOUT — the refusal, the on-behalf create, the discovery, and the payment path
 * ADMITTING this member and moving the booking to PAYMENT_PENDING — still RUNS
 * without a provider, and the admission is still proven without one. What a
 * provider changes is the SHAPE of the pay step's response, not whether the
 * member is let in: with keys the intent is minted and the route answers 200
 * with a `clientSecret`; without them (any fork's CI, where GitHub never hands
 * a `pull_request` run the repository secrets — #2820) the route's first
 * provider call — the Stripe customer lookup that precedes the intent mint — is
 * the only failure THIS fixture can still reach after admission, and it happens
 * AFTER the pay transaction has committed, so the route answers 500 with the
 * booking already moved to PAYMENT_PENDING. The fourth test asserts whichever of
 * those two shapes matches the environment it is running in, and asserts the
 * booking moved in both.
 */

test.describe.configure({ mode: "serial" });

const MEMBER_NAME = `${LOCKED_OUT_MEMBER.firstName} ${LOCKED_OUT_MEMBER.lastName}`;

let adminContext: BrowserContext;
let memberContext: BrowserContext;
let admin: APIRequestContext;
let member: APIRequestContext;
let memberId: string;

/** The in-season window this run books, chosen once so every step shares it. */
let WINDOW: { checkIn: string; checkOut: string };

/** The on-behalf draft the admin saves, picked up by the later tests. */
let draftBookingId = "";
let draftPriceCents = 0;

/** The club's settings as this spec found them, restored in `afterAll`. */
let moduleSnapshot: Record<string, boolean> | undefined;
let lockoutModeSnapshot: string | undefined;

async function readLockoutMode(): Promise<string> {
  const res = await admin.get("/api/admin/membership-lockout-settings");
  expect(
    res.ok(),
    `read subscription lockout settings (${res.status()}): ${await res.text()}`,
  ).toBeTruthy();
  const body = (await res.json()) as { settings: { mode: string } };
  return body.settings.mode;
}

async function setLockoutMode(mode: string): Promise<void> {
  // The route preserves every field it is not sent, so naming only the mode
  // cannot disturb the club's financial-year or Xero detection settings.
  const res = await admin.put("/api/admin/membership-lockout-settings", {
    data: { mode },
  });
  expect(
    res.ok(),
    `save subscription lockout mode ${mode} (${res.status()}): ${await res.text()}`,
  ).toBeTruthy();
}

/** The member as a guest on their own booking — the ordinary one-adult stay. */
function selfGuest() {
  return {
    firstName: LOCKED_OUT_MEMBER.firstName,
    lastName: LOCKED_OUT_MEMBER.lastName,
    ageTier: "ADULT",
    isMember: true,
    memberId,
  };
}

async function resolveMemberId(): Promise<string> {
  const res = await admin.get(
    `/api/admin/members?search=${encodeURIComponent(LOCKED_OUT_MEMBER.email)}&pageSize=5`,
  );
  expect(res.ok(), `resolve locked-out member (${res.status()})`).toBeTruthy();
  const body = (await res.json()) as {
    members?: Array<{ id: string; email: string }>;
  };
  const match = (body.members ?? []).find(
    (candidate) => candidate.email === LOCKED_OUT_MEMBER.email,
  );
  expect(
    match?.id,
    `${LOCKED_OUT_MEMBER.email} must be seeded (prisma/demo-seed.ts)`,
  ).toBeTruthy();
  return match!.id;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);

  adminContext = await browser.newContext({
    storageState: storageStatePath(E2E_ADMIN.email),
  });
  admin = adminContext.request;

  // The locked-out persona has no pre-generated storage state, so sign in
  // explicitly from a private rate-limit bucket (the suite's ~20 logins share
  // the runner IP otherwise; see e2e/helpers/auth.ts).
  memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await loginPersona(memberPage, LOCKED_OUT_MEMBER.email, "198.51.100.71");
  await memberPage.close();
  member = memberContext.request;

  memberId = await resolveMemberId();

  const window = stayWindowForAttempt(28, test.info().retry);
  WINDOW = { checkIn: window.checkIn, checkOut: window.checkOut };

  // Retry idempotency (#2302): a previous attempt may have left this member's
  // draft — which holds a member night — on this window. Clear it before the
  // refusal assertion, or the refusal could pass for the wrong reason.
  await cancelMemberBookingsOnDate(admin, {
    memberName: MEMBER_NAME,
    checkIn: WINDOW.checkIn,
  });

  // Subscriptions come from Xero, so the lockout is inert while the module is
  // off — which is how the rest of the suite runs.
  moduleSnapshot = await overrideModules(admin, { xeroIntegration: true });
  lockoutModeSnapshot = await readLockoutMode();
  await setLockoutMode("HARD_BLOCK");
});

test.afterAll(async () => {
  // Club settings FIRST: they gate every other spec's bookings, and a failure
  // below must not leave the club refusing them.
  try {
    if (lockoutModeSnapshot) await setLockoutMode(lockoutModeSnapshot);
  } finally {
    try {
      if (moduleSnapshot) await setModuleSettings(admin, moduleSnapshot);
    } finally {
      await cancelMemberBookingsOnDate(admin, {
        memberName: MEMBER_NAME,
        checkIn: WINDOW.checkIn,
      }).catch(() => undefined);
      await adminContext?.close();
      await memberContext?.close();
    }
  }
});

test("the member really is locked out: their own booking is refused", async () => {
  // The premise, asserted rather than assumed. Everything after this is only
  // interesting because this member cannot book for themselves right now.
  const res = await postBookingCreate(
    member,
    bookingCreateIsolation("locked-out-self-refusal", test.info().retry),
    {
      data: {
        checkIn: WINDOW.checkIn,
        checkOut: WINDOW.checkOut,
        guests: [selfGuest()],
      },
    },
  );

  expect(res.status()).toBe(403);
  const body = (await res.json()) as { code?: string; error?: string };
  // The exact code matters: a XERO_CONTACT_REQUIRED or profile refusal would be
  // a 403 too, and would make this spec prove nothing about the lockout.
  expect(body.code).toBe("SUBSCRIPTION_REQUIRED");
});

test("an admin can still book on their behalf, and save it for them to pay", async () => {
  const res = await postBookingCreate(
    admin,
    bookingCreateIsolation("locked-out-on-behalf-draft", test.info().retry),
    {
      data: {
        checkIn: WINDOW.checkIn,
        checkOut: WINDOW.checkOut,
        forMemberId: memberId,
        draft: true,
        guests: [selfGuest()],
      },
    },
  );

  expect(
    res.status(),
    `on-behalf draft create (${res.status()}): ${await res.text()}`,
  ).toBe(201);
  const booking = (await res.json()) as {
    id: string;
    status: string;
    finalPriceCents: number;
  };
  expect(booking.status).toBe("DRAFT");
  // A PRICED draft is the whole point: a $0 draft has no payment door and only
  // an admin can confirm it (INV-LOCKOUT-070).
  expect(booking.finalPriceCents).toBeGreaterThan(0);

  draftBookingId = booking.id;
  draftPriceCents = booking.finalPriceCents;
});

test("the member finds it on their dashboard and it carries a pay action", async () => {
  expect(draftBookingId, "the on-behalf draft must have been created").toBeTruthy();
  // The member's OWN draft list carries it, at the price the admin quoted —
  // read before the pay step, because paying moves it out of DRAFT.
  const drafts = await member.get("/api/bookings/drafts");
  expect(drafts.ok(), `GET /api/bookings/drafts (${drafts.status()})`).toBeTruthy();
  const mine = (
    (await drafts.json()) as {
      drafts: Array<{ id: string; finalPriceCents: number }>;
    }
  ).drafts.find((row) => row.id === draftBookingId);
  expect(mine?.finalPriceCents).toBe(draftPriceCents);

  const page = await memberContext.newPage();
  try {
    await page.goto("/dashboard");

    // Discovery. The member never started this booking, so it is labelled as the
    // club's and the control leads with payment rather than "Resume" (#2779).
    await expect(page.getByTestId("draft-saved-by-club").first()).toContainText(
      "Saved for you by the club",
    );
    await page
      .getByRole("link", { name: "Review & pay" })
      .first()
      .click();
    await page.waitForURL(new RegExp(`/bookings/${draftBookingId}`));

    // The pay door itself, on the page that takes the money. Asserted by ROLE
    // and LEVEL, not by text: a member who navigates by headings has to be able
    // to land on this card, and #2779 is the issue about this surface being
    // findable. `CardTitle` renders a bare <div> by default, so the card opts
    // in with `<CardTitle headingLevel={2}>` (#2796) — losing that silently
    // would leave the pay door invisible to assistive technology while still
    // reading fine. Asserting by role and level here is what makes the loss
    // visible rather than silent.
    await expect(
      page.getByRole("heading", { name: "Complete Booking", level: 2 }),
    ).toBeVisible();
    await expect(page.getByText("The club saved this booking for you")).toBeVisible();
    // And the deadline, because the nightly draft-cleanup job DELETES an expired
    // draft rather than cancelling it (INV-LOCKOUT-070).
    await expect(page.getByTestId("draft-expiry-notice")).toContainText("Pay by");
    // Visible AND enabled: "there is a pay button" is not the claim #2779
    // makes — the claim is that a member whose subscription is unpaid can
    // actually use it, so a disabled-by-lockout control must fail this test.
    await expect(
      page.getByRole("button", { name: "Confirm & Continue to Payment" }),
    ).toBeEnabled();
  } finally {
    await page.close();
  }
});

test("paying it is admitted while the subscription is still unpaid", async () => {
  // Requires genuine Stripe test-mode keys: create-payment-intent calls Stripe,
  // so on an unconfigured environment (e.g. a fork PR that gets no secrets) it
  // 500s. Skip on the same terms as stripe-payment.spec.ts and the card-charge
  // test below — the lockout/no-subscription-gate behaviour is already proven
  // without a provider by the refusal and on-behalf tests above.
  test.skip(!stripeTestModeConfigured(), STRIPE_SKIP_REASON);
  expect(draftBookingId, "the on-behalf draft must have been created").toBeTruthy();

  // THE ASSERTION #2779 IS ABOUT. Same member, same unpaid subscription, same
  // HARD_BLOCK club as the refusal above — and the payment path admits them,
  // because it holds no subscription gate at all (INV-LOCKOUT-069).
  const res = await member.post("/api/payments/create-payment-intent", {
    data: { bookingId: draftBookingId },
  });

  // WHY THIS BRANCHES, AND WHY BOTH BRANCHES PROVE THE SAME THING. The route
  // holds no subscription gate, so nothing about this member's arrears can
  // change its answer — but the answer's SHAPE depends on whether the club has
  // Stripe keys, because a priced booking's pay step ends in real Stripe calls:
  // a customer lookup, and then the intent mint. The route's own ordering is
  // what makes the unkeyed answer still probative: the pay transaction — the
  // status-guarded DRAFT → PAYMENT_PENDING move, the capacity preflight, the
  // credit election — runs and COMMITS first, and only then is the provider
  // called, because external calls stay outside database transactions. So with
  // keys the mint succeeds and we see 200 with a client secret; without keys
  // (every fork's CI — GitHub never gives a fork's `pull_request` run the
  // repository secrets, so `seed-stripe-credentials.ts` no-ops on the
  // placeholder and `getStripe()` throws — #2820) that first provider call is
  // the only failure THIS fixture can still reach after admission — a priced,
  // first-attempt draft with no credit election and no prior intent pointer —
  // and it fails after the member has already been admitted. Either way the
  // tail below reads the booking back, and that is what the #2779 decision
  // actually turns on (INV-LOCKOUT-069). The unkeyed pairing asserted here —
  // unconfigured provider ⇒ 500 with the generic body, DRAFT → PAYMENT_PENDING
  // already committed — is pinned as a unit test in
  // `src/lib/__tests__/payment-intent-routes.test.ts`, so a route change that
  // breaks it fails there first, readably, instead of turning fork CI red.
  if (stripeTestModeConfigured()) {
    expect(
      res.status(),
      `create-payment-intent for the locked-out owner (${res.status()}): ${await res.text()}`,
    ).toBe(200);
    const body = (await res.json()) as { clientSecret?: string };
    expect(body.clientSecret).toBeTruthy();
  } else {
    // Deliberately exact, not "not 403". Without provider keys the one failure
    // this fixture may accept is the route's first Stripe call, which happens
    // after the pay transaction has committed. Any REFUSAL shape — 403
    // SUBSCRIPTION_REQUIRED (the lockout gate having grown onto the payment
    // path, which is the whole regression #2779 exists to catch), a 400, a 409
    // — is a different failure that happens BEFORE admission, and must fail
    // this test loudly rather than be waved through as "no keys configured".
    //
    // A 200 is the other skew worth naming, and it is an environment problem
    // rather than a product one: `stripeTestModeConfigured()` reads THIS
    // process's env, while the app answers from the DB credential store seeded
    // at `scripts/e2e-stack.sh prepare`. Preparing a stack with real keys and
    // then running the suite from an env file without them puts the two out of
    // step, and the message below says so rather than leaving a bare 200 ≠ 500.
    expect(
      res.status(),
      `without Stripe test-mode keys the only failure this fixture can reach ` +
        `in create-payment-intent is the provider call, which happens after ` +
        `the pay transaction has already committed the DRAFT → PAYMENT_PENDING ` +
        `move; a refusal shape (403 SUBSCRIPTION_REQUIRED, 400, 409) here ` +
        `almost certainly means the member was turned away before admission, ` +
        `and the PAYMENT_PENDING assertion below is the arbiter; a 200 means ` +
        `the app's credential store holds keys this Playwright process cannot ` +
        `see — re-run \`scripts/e2e-stack.sh prepare\` from the same env file ` +
        `(${res.status()}): ${await res.text()}`,
    ).toBe(500);
  }

  // And the booking really moved: the draft is now awaiting the member's money
  // rather than sitting on its 72-hour deletion clock. Asserted in BOTH modes,
  // because in the unkeyed mode this is precisely what separates "the mint
  // failed after the member was admitted" from "the route broke before
  // admitting them" — anything that fails ahead of the pay transaction's commit
  // leaves the booking sitting in DRAFT, and fails here.
  const listed = await admin.get(
    `/api/admin/bookings?calendarMonth=${WINDOW.checkIn.slice(0, 7)}&status=DRAFT,PAYMENT_PENDING`,
  );
  expect(listed.ok(), `list bookings (${listed.status()})`).toBeTruthy();
  const bookings = (
    (await listed.json()) as {
      bookings: Array<{ id: string; status: string }>;
    }
  ).bookings;
  const picked = bookings.find((row) => row.id === draftBookingId);
  expect(picked?.status).toBe("PAYMENT_PENDING");
});

test("and the card charge confirms the booking", async () => {
  // The last mile. Skipped without genuine Stripe test-mode keys, on the same
  // terms as stripe-payment.spec.ts — the gate #2779 decided is already proven
  // above without a provider, and a spec that fails on an unconfigured
  // environment teaches nothing.
  test.skip(!stripeTestModeConfigured(), STRIPE_SKIP_REASON);
  expect(draftBookingId, "the on-behalf draft must have been created").toBeTruthy();

  const page = await memberContext.newPage();
  try {
    await page.goto(`/bookings/${draftBookingId}`);
    await expect(
      page.getByRole("heading", { name: "Complete Payment", level: 2 }),
    ).toBeVisible();

    await payWithCard(page, TEST_CARDS.success);

    // Stripe's confirmPayment resolves inline or via a redirect back to this
    // page; either way the booking ends up settled, so assert on the booking
    // rather than on which of the two paths Stripe chose (see
    // stripe-payment.spec.ts for the full reasoning).
    await expect(async () => {
      const res = await admin.get(
        `/api/admin/bookings?calendarMonth=${WINDOW.checkIn.slice(0, 7)}&status=PAID,CONFIRMED,PAYMENT_PENDING`,
      );
      expect(res.ok()).toBeTruthy();
      const rows = (
        (await res.json()) as { bookings: Array<{ id: string; status: string }> }
      ).bookings;
      expect(rows.find((row) => row.id === draftBookingId)?.status).toMatch(
        /^(PAID|CONFIRMED)$/,
      );
    }).toPass({ timeout: 60_000 });
  } finally {
    await page.close();
  }
});
