import {
  type APIRequestContext,
  type BrowserContext,
  type Page,
  expect,
  test,
} from "@playwright/test";

import { loginPersona, storageStatePath } from "./helpers/auth";
import { E2E_ADMIN, WAITLISTER } from "./helpers/fixtures";
import {
  bookSelfToReviewStep,
  completeMemberDetailsGateIfShown,
  selectCalendarDay,
} from "./helpers/booking";
import {
  type BookingCreateIsolation,
  bookingCreateIsolation,
  withBookingCreateClientIp,
} from "./helpers/booking-create-client-ip";
import {
  cancelMemberBookingsOnDate,
  cancelOpenExceptionRequests,
  deactivateMinimumStayPolicies,
} from "./helpers/reset";
import {
  oneNightCheckOut,
  stayWindowForAttempt,
  type StayWindow,
} from "./helpers/stay-dates";
import { must } from "../src/lib/indexed-access";

/**
 * #2562 — the MEMBER's own booking-policy exception journey, driven through the
 * member's screens rather than through the request APIs.
 *
 * This is the spec the #2526 matrix note deferred. Its predecessor
 * (`policy-exception-approval.spec.ts`) is deliberately about approval SEMANTICS
 * and creates its requests by API, because at the time there was no member screen
 * to create one from. Everything here is the opposite: the request is raised,
 * read, withdrawn and replaced by clicking, because the owner's decision on #2562
 * is explicit that a member must be able to run the whole lifecycle in the app,
 * and a request created by `fetch` proves nothing about whether they can.
 *
 * WHAT EACH TEST IS FOR, in the order they run (serial, and dependent — a
 * replacement needs something to replace):
 *
 *  1. A stay that MEETS the minimum still books normally. The regression guard the
 *     owner asked for: opening the exception door must not put a door in front of
 *     the ordinary journey.
 *  2. A HARD failure offers nothing. Re-booking a night the member already holds
 *     is refused for a reason no officer can waive, so the request action must be
 *     ABSENT — not disabled, absent.
 *  3. A reviewable refusal offers it, tells the truth about capacity, requires an
 *     explanation, and shows the FROZEN proposal after submission.
 *  4. The request area tracks it, and a second attempt is refused with the
 *     replace-it-instead next step rather than a bare 409.
 *  5. Replace: the member corrects the proposal, the old row reads Replaced, and
 *     exactly one request is live.
 *  6. Refusal: the member reads the officer's member-facing explanation, and the
 *     officer's INTERNAL note is absent from the member's page AND from their API
 *     payload. Both notes are typed into the officer's own screen, so this also
 *     exercises the labelling that makes the split safe.
 *  7. Approval: the request becomes a real booking and the member's row links to
 *     it.
 *  8. Mobile: the same section is readable and its actions reachable at 390x844.
 *  9. The MODIFICATION half: the same door on the edit panel, with that path's own
 *     capacity answer, then withdrawal from the request area.
 *
 * RETRY IDEMPOTENCY (#2302, docs/E2E_PLAYWRIGHT.md). Playwright retries a serial
 * group as a WHOLE against the database the failed attempt left behind. Every
 * attempt therefore takes its own stay windows (`stayWindowForAttempt`) and its
 * own policy name, and `beforeAll` clears this member's leftover bookings on both
 * windows plus every exception request they still have open — an open request is
 * refused as a duplicate, which is exactly how one transient failure becomes three
 * deterministic ones. Stay indexes 10 and 15 are this file's: neither is used by
 * any other spec at any attempt (the stride is 16, so 10 owns 10/26/42 and 15 owns
 * 15/31/47).
 *
 * `workers: 1` and `fullyParallel: false` (playwright.config.ts) are still
 * load-bearing because the member may hold only ONE open exception request at a
 * time. This file deliberately uses Wanda rather than Alice, however: the older
 * `policy-exception-approval.spec.ts` spends Alice's five-per-day request budget,
 * and composing both journeys on one member made the later spec depend on file
 * order. Wanda has the same paid, complete-profile eligibility and no other spec
 * spends her booking-policy exception budget.
 */

test.describe.configure({ mode: "serial" });

/**
 * The prefix every attempt's policy name starts with. `beforeAll` deactivates the
 * whole prefix and then creates `${POLICY_NAME_PREFIX} a<attempt>` — the two halves
 * docs/E2E_PLAYWRIGHT.md asks for, so a reset that somehow cannot clean still
 * cannot wedge the retry on 409 `POLICY_NAME_CONFLICT`.
 */
const POLICY_NAME_PREFIX = "E2E member exception UI minimum stay";
const MEMBER = WAITLISTER;
const MEMBER_NAME = `${MEMBER.firstName} ${MEMBER.lastName}`;

/**
 * Login-only IP retained from the original journey. Booking creates now use the
 * shared per-spec/per-attempt helper rather than applying this value to every
 * request made by the member context (#2599).
 */
const MEMBER_CLIENT_IP = "198.51.100.62";

/** The two-night window the member books normally, then edits down to one. */
const COMPLIANT_WINDOW_INDEX = 10;
/** The window every one-night (and therefore refused) request is raised on. */
const SHORT_STAY_WINDOW_INDEX = 15;

let adminContext: BrowserContext;
let memberContext: BrowserContext;
let admin: APIRequestContext;
let member: APIRequestContext;
/** The signed-in booker's canonical id, read through the wizard's family API. */
let memberSelfId: string;
let compliant: StayWindow;
let shortStay: StayWindow;
/** One night on the short window: check out the morning after the first night. */
let shortCheckOut: string;
/** One night on the compliant window, for the shorten-by-edit journey. */
let compliantShortenedCheckOut: string;

type MemberExceptionRow = {
  id: string;
  source: "NEW_BOOKING" | "MODIFICATION";
  status: string;
  bookingId: string | null;
  createdBookingId: string | null;
  decisionExplanation: string | null;
  capacityHeld: boolean;
  /**
   * The CREATED booking's own capacity answer, which is a different fact from
   * `capacityHeld` (#2562 review): `capacityHeld` is about the request's own
   * provisional reservation, this is about the booking an approval produced.
   * Null on every row that created no booking.
   */
  createdBookingHoldsCapacity: boolean | null;
  /**
   * Whether that created booking is still live and still owed (#2562 re-review) —
   * the fact that separates "holds no beds because nobody has paid it" from "holds
   * no beds because it was cancelled or reaped". Null where there is no booking.
   */
  createdBookingAwaitsPayment: boolean | null;
  canWithdraw: boolean;
  canReplace: boolean;
};

/** The member's own request list, read through their own endpoint. */
async function memberRequests(): Promise<MemberExceptionRow[]> {
  const listed = await member.get("/api/bookings/exception-requests");
  expect(listed.ok(), `member exception list (${listed.status()})`).toBeTruthy();
  return (await listed.json()) as MemberExceptionRow[];
}

/** The single open request, which the serial order makes unambiguous. */
async function openRequest(): Promise<MemberExceptionRow> {
  const rows = await memberRequests();
  const open = rows.filter((row) => row.canWithdraw);
  expect(
    open.length,
    `exactly one open request expected, got ${open.length}`,
  ).toBe(1);
  return must(open[0], "no open request to return");
}

/** Poll the member's own list until one request reaches a state. */
async function expectRequestStatus(requestId: string, status: string) {
  await expect
    .poll(
      async () =>
        (await memberRequests()).find((row) => row.id === requestId)?.status,
      { timeout: 60_000 },
    )
    .toBe(status);
}

/**
 * Pick a stay in the `/book` wizard and submit the guest step for a quote.
 *
 * Hard policy failures stop here; exception-eligible refusals continue to the
 * review step so the member can confirm the attempted booking.
 */
async function submitGuestStepForQuote(
  page: Page,
  checkIn: string,
  checkOut: string,
): Promise<void> {
  await page.goto("/book");
  await completeMemberDetailsGateIfShown(page);

  await expect(page.getByText("Select Your Dates")).toBeVisible();
  await selectCalendarDay(page, checkIn);
  await selectCalendarDay(page, checkOut);

  // The booker is pre-selected by default (#1680), so the guests step needs no
  // click beyond Continue — gating on the added-state button waits out the
  // family-list load.
  await expect(
    page.getByRole("button", {
      name: `✓ ${MEMBER.firstName} ${MEMBER.lastName} (You)`,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
}

/**
 * Pick a stay in the `/book` wizard and press confirm on a stay the policy
 * refuses, leaving the review step showing the exception-request offer the
 * server answered with.
 *
 * Both callers book the same short stay, so the offer card IS this journey's
 * authoritative outcome: the booking-create interception stays installed until
 * it is on screen rather than being torn down when the click resolves.
 */
async function bookThroughWizard(
  page: Page,
  checkIn: string,
  checkOut: string,
  isolation: BookingCreateIsolation,
): Promise<void> {
  await submitGuestStepForQuote(page, checkIn, checkOut);

  await expect(page.getByText("Booking Summary")).toBeVisible();
  await withBookingCreateClientIp(page, isolation, {
    trigger: () =>
      page
        .getByRole("button", { name: /Continue to Payment|Confirm Booking/ })
        .click(),
    waitForOutcome: () =>
      expect(page.getByTestId("request-officer-approval")).toBeVisible({
        timeout: 30_000,
      }),
  });
}

/** Submit the offered request with an explanation, and wait for the receipt. */
async function submitRequest(page: Page, explanation: string, label: RegExp) {
  const card = page.getByTestId("request-officer-approval");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByLabel(/Why are you asking/).fill(explanation);
  await card.getByRole("button", { name: label }).click();
  await expect(page.getByTestId("exception-request-sent")).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * Open the officer queue on the card for ONE request and reveal its decision
 * form.
 *
 * Scoped on the request id the card carries (#2562) rather than on "the first
 * card": the queue is one shared, age-ordered list across both stores, so the
 * first card is a different request the moment anything else is waiting.
 */
async function openOfficerDecisionForm(page: Page, requestId: string) {
  await page.goto("/admin/booking-requests?tab=exceptions");
  const card = page.locator(`[data-request-id="${requestId}"]`);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByRole("button", { name: "Decide this request" }).click();
  return card;
}

test.beforeAll(async ({ browser }) => {
  adminContext = await browser.newContext({
    storageState: storageStatePath(E2E_ADMIN.email),
  });
  memberContext = await browser.newContext();
  const memberLogin = await memberContext.newPage();
  await loginPersona(memberLogin, MEMBER.email, MEMBER_CLIENT_IP);
  await memberLogin.close();
  admin = adminContext.request;
  member = memberContext.request;

  // The duplicate-request probe below must replay the wizard's EXACT proposal.
  // A member guest with no memberId is a different (unlinked) proposal and gets
  // a different hash, so omitting this id would not exercise the active-slot
  // guard at all.
  const family = await member.get("/api/members/family");
  expect(family.ok(), `member family (${family.status()})`).toBeTruthy();
  const familyBody = (await family.json()) as {
    familyMembers?: Array<{ id?: string; relationship?: string }>;
  };
  const self = familyBody.familyMembers?.find(
    (candidate) => candidate.relationship === "self",
  );
  expect(self?.id, "signed-in member id from family endpoint").toBeTruthy();
  memberSelfId = self!.id!;
});

test.beforeAll(async ({}, testInfo) => {
  compliant = stayWindowForAttempt(COMPLIANT_WINDOW_INDEX, testInfo.retry);
  shortStay = stayWindowForAttempt(SHORT_STAY_WINDOW_INDEX, testInfo.retry);
  // A window's `nights` are its two occupied lodge nights, so the morning after
  // the first night is a one-night stay's checkout.
  shortCheckOut = oneNightCheckOut(shortStay);
  compliantShortenedCheckOut = oneNightCheckOut(compliant);

  // Clear this attempt's own leftovers BEFORE creating anything. An open request
  // blocks a new one outright, and a leftover booking on either window holds the
  // member-night this journey needs.
  await deactivateMinimumStayPolicies(admin, {
    namePrefix: POLICY_NAME_PREFIX,
  });
  await cancelOpenExceptionRequests(member);
  await cancelMemberBookingsOnDate(admin, {
    memberName: MEMBER_NAME,
    checkIn: [compliant.checkIn, shortStay.checkIn],
  });

  // A club-wide two-night minimum on every day. NO_HOLD deliberately: it is the
  // mode that reserves nothing, so the two windows cannot starve each other of
  // beds, and it makes the modification path's capacity sentence deterministic.
  const created = await admin.post("/api/admin/booking-policies/minimum-stay", {
    data: {
      name: `${POLICY_NAME_PREFIX} a${testInfo.retry}`,
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
    await cancelOpenExceptionRequests(member);
    await cancelMemberBookingsOnDate(admin, {
      memberName: MEMBER_NAME,
      checkIn: [compliant.checkIn, shortStay.checkIn],
    });
    await deactivateMinimumStayPolicies(admin, {
      namePrefix: POLICY_NAME_PREFIX,
    });
  }
  await adminContext?.close();
  await memberContext?.close();
});

test("a stay that meets the minimum still books normally, with no exception step", async ({}, testInfo) => {
  const page = await memberContext.newPage();
  await bookSelfToReviewStep(page, MEMBER, compliant);
  await withBookingCreateClientIp(
    page,
    bookingCreateIsolation("member-exception-compliant", testInfo.retry),
    {
      trigger: () =>
        page
          .getByRole("button", { name: /Continue to Payment|Confirm Booking/ })
          .click(),
      // The ordinary journey reaches payment, and that step showing is this
      // create's authoritative outcome, so the interception is held until then.
      waitForOutcome: () =>
        expect(page.getByText("Complete Payment").first()).toBeVisible({
          timeout: 30_000,
        }),
    },
  );

  // The exception card is nowhere near it: a member who broke no rule is never
  // asked to ask.
  await expect(page.getByTestId("request-officer-approval")).toBeHidden();
  await page.close();
});

test("a hard failure offers no exception request at all", async () => {
  // The member now holds the compliant window, so asking for it again is refused
  // by the one-booking-per-member-night rule — a hard stop no officer can waive.
  const page = await memberContext.newPage();
  await submitGuestStepForQuote(page, compliant.checkIn, compliant.checkOut);

  await expect(
    page.getByText(/already on another booking|already on other bookings/i).first(),
  ).toBeVisible({ timeout: 30_000 });
  // ABSENT, not disabled: a rendered-but-disabled card for a hard failure would
  // be the defect, so this asserts the card is not in the page at all.
  await expect(page.getByTestId("request-officer-approval")).toBeHidden();
  await page.close();
});

test("a minimum-stay refusal offers the request, tells the truth about beds, and needs an explanation", async ({}, testInfo) => {
  const page = await memberContext.newPage();
  await bookThroughWizard(
    page,
    shortStay.checkIn,
    shortCheckOut,
    bookingCreateIsolation("member-exception-minimum-refusal", testInfo.retry),
  );

  // `bookThroughWizard` holds the create's interception until this card is on
  // screen, so scope straight into it rather than waiting for it twice.
  const card = page.getByTestId("request-officer-approval");

  // The rule being asked about, named for a member rather than as an enum.
  await expect(card.getByText("Minimum length of stay")).toBeVisible();
  // The exact proposal, echoed from the member's own choices.
  await expect(card.getByText("What you are about to send")).toBeVisible();
  await expect(card.getByText("Guest nights")).toBeVisible();
  await expect(
    card.getByText(`${MEMBER.firstName} ${MEMBER.lastName}`).first(),
  ).toBeVisible();

  // Capacity honesty for THIS path: a new-booking request holds nothing, and the
  // words say so instead of promising a bed.
  await expect(card.getByText(/No beds are held by this request/)).toBeVisible();
  await expect(
    card.getByText(/Availability is checked again when a Booking Officer reviews it/),
  ).toBeVisible();
  // The two notices the owner's decision requires on every submission screen.
  await expect(
    card.getByText(/does not book anything and does not confirm anything/),
  ).toBeVisible();
  await expect(
    card.getByText(/Booking Officers allow exceptions at their discretion/),
  ).toBeVisible();
  // And the rule that a submitted proposal is replaced, never edited.
  await expect(
    card.getByText(/A request cannot be edited after you send it/),
  ).toBeVisible();

  // The explanation is mandatory, enforced before the request can be sent.
  await expect(
    card.getByRole("button", { name: "Request Booking Officer approval" }),
  ).toBeDisabled();

  await submitRequest(
    page,
    "Only free for the first night — happy to pay the full two-night rate.",
    /^Request Booking Officer approval$/,
  );

  // The receipt shows the proposal the SERVER froze, not the form's own copy of
  // it, and says plainly that nothing is booked.
  const sent = page.getByTestId("exception-request-sent");
  await expect(
    sent.getByText("Exactly what the Booking Officer will decide"),
  ).toBeVisible();
  await expect(
    sent.getByText(/It is not booked and it is not confirmed/),
  ).toBeVisible();
  await expect(sent.getByRole("link", { name: /Track it under/ })).toBeVisible();
  await page.close();
});

test("the request area tracks it, and a duplicate attempt is sent to replace it", async () => {
  const page = await memberContext.newPage();
  await page.goto("/bookings");

  await expect(
    page
      .locator("#booking-rule-requests")
      .getByRole("heading", { name: "My booking-rule requests" }),
  ).toBeVisible();

  const row = page.getByTestId("exception-request-row").first();
  await expect(row.getByText("With the Booking Officer")).toBeVisible();
  await expect(row.getByText(/has this and has not decided yet/)).toBeVisible();
  // The exact proposal and the member's own words, read back.
  await expect(row.getByText("What you asked for")).toBeVisible();
  await expect(row.getByText("What you told the officer")).toBeVisible();
  await expect(row.getByText(/Only free for the first night/)).toBeVisible();
  await expect(row.getByText("The rule you asked to be let past")).toBeVisible();
  // Honest capacity, again, on the tracking surface.
  await expect(row.getByText(/No beds are held/)).toBeVisible();
  // Both lifecycle actions are offered while it is open.
  await expect(row.getByRole("button", { name: "Withdraw" })).toBeVisible();
  await expect(
    row.getByRole("link", { name: "Replace with a corrected request" }),
  ).toBeVisible();
  await page.close();

  // A second request for the same thing is refused, and the refusal names the
  // remedy — replacing the one they already have — rather than dead-ending.
  const second = await member.post("/api/bookings/exception-requests", {
    data: {
      checkIn: shortStay.checkIn,
      checkOut: shortCheckOut,
      guests: [
        {
          firstName: MEMBER.firstName,
          lastName: MEMBER.lastName,
          ageTier: "ADULT",
          isMember: true,
          memberId: memberSelfId,
        },
      ],
      memberMessage: "Asking twice by mistake.",
    },
  });
  expect(second.status()).toBe(409);
  expect(((await second.json()) as { code?: string }).code).toBe(
    "OPEN_EXCEPTION_REQUEST",
  );
});

test("replacing a request supersedes the old one and leaves exactly one live", async ({}, testInfo) => {
  const before = await openRequest();

  const page = await memberContext.newPage();
  await page.goto("/bookings");
  await page
    .getByTestId("exception-request-row")
    .first()
    .getByRole("link", { name: "Replace with a corrected request" })
    .click();

  // The link lands back in the wizard that built the proposal, carrying the
  // request it replaces — a replacement is a NEW frozen proposal, never an edit
  // of the one an officer is already reading.
  await expect(page).toHaveURL(new RegExp(`replaceRequest=${before.id}`));
  await completeMemberDetailsGateIfShown(page);
  await expect(page.getByText("Select Your Dates")).toBeVisible();
  await selectCalendarDay(page, shortStay.checkIn);
  await selectCalendarDay(page, shortCheckOut);
  await expect(
    page.getByRole("button", {
      name: `✓ ${MEMBER.firstName} ${MEMBER.lastName} (You)`,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("Booking Summary")).toBeVisible();
  const card = page.getByTestId("request-officer-approval");
  await withBookingCreateClientIp(
    page,
    bookingCreateIsolation("member-exception-replacement", testInfo.retry),
    {
      trigger: () =>
        page
          .getByRole("button", { name: /Continue to Payment|Confirm Booking/ })
          .click(),
      // The replacement is refused the same way, so the offer card is this
      // create's authoritative outcome; hold the interception until it shows.
      waitForOutcome: () => expect(card).toBeVisible({ timeout: 30_000 }),
    },
  );

  // The card knows it is replacing something, and says so on its heading and its
  // button rather than looking like a second, parallel request.
  await expect(
    card.getByText("Replace your request to a Booking Officer"),
  ).toBeVisible();
  await submitRequest(
    page,
    "Correcting my earlier request — same night, and I can pay the two-night rate.",
    /^Replace my request$/,
  );
  await page.close();

  // Exactly one live request, and the old one reads as replaced rather than as
  // undecided.
  const replaced = (await memberRequests()).find((row) => row.id === before.id);
  expect(replaced?.status).toBe("superseded");
  const live = await openRequest();
  expect(live.id).not.toBe(before.id);

  const list = await memberContext.newPage();
  await list.goto("/bookings");
  await expect(list.getByText("Replaced by a newer request").first()).toBeVisible();
  await expect(list.getByText("With the Booking Officer").first()).toBeVisible();
  await list.close();
});

test("a refusal shows the officer's member-facing explanation and never their internal note", async () => {
  const target = await openRequest();
  const MEMBER_FACING =
    "Sorry — the committee agreed no single nights on that weekend this season.";
  const INTERNAL_ONLY = "INTERNAL ONLY: third ask this month, watch for a pattern.";

  // The officer decides on their OWN screen, typing both fields, so the labelling
  // that makes the split safe is exercised rather than asserted in the abstract.
  const officer = await adminContext.newPage();
  const card = await openOfficerDecisionForm(officer, target.id);

  // The officer is told who reads which field BEFORE they submit anything.
  await expect(
    card.getByText(
      /The member will see this\. It is shown on their own request list/,
    ),
  ).toBeVisible();
  await expect(
    card.getByText(/Only admins see this\. It is never shown to the member/),
  ).toBeVisible();

  await card.getByLabel(/Explanation for the member/).fill(MEMBER_FACING);
  await card.getByLabel("Internal note (optional)").fill(INTERNAL_ONLY);
  const refusalResponse = officer.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().endsWith(
        `/api/admin/booking-exception-requests/${target.id}`,
      ),
  );
  await card.getByRole("button", { name: "Refuse" }).click();
  const refusedDecision = await refusalResponse;
  expect(
    refusedDecision.ok(),
    `officer refusal (${refusedDecision.status()}): ${await refusedDecision.text()}`,
  ).toBeTruthy();
  await officer.close();

  await expectRequestStatus(target.id, "refused");

  const refused = (await memberRequests()).find((row) => row.id === target.id);
  expect(refused?.decisionExplanation).toBe(MEMBER_FACING);
  // The privacy boundary, on the payload itself: the internal note is not a field
  // the member DTO has, so it cannot arrive under any name.
  const payload = JSON.stringify(await memberRequests());
  expect(payload).not.toContain(INTERNAL_ONLY);
  expect(payload).not.toContain("internalNotes");

  const page = await memberContext.newPage();
  await page.goto("/bookings");
  await expect(page.getByText("Not approved").first()).toBeVisible();
  await expect(page.getByText("What the Booking Officer said").first()).toBeVisible();
  await expect(page.getByText(MEMBER_FACING)).toBeVisible();
  // And on the served page, which is the surface the member actually reads. The
  // raw HTML check catches a note that reached the client payload without being
  // rendered — invisible on screen, one devtools tab away from being read.
  expect(await page.content()).not.toContain(INTERNAL_ONLY);
  await page.close();
});

test("an approval becomes a real booking the member's row links to", async ({}, testInfo) => {
  // Ask again, from the wizard, so the approved request is one a member raised.
  const page = await memberContext.newPage();
  await bookThroughWizard(
    page,
    shortStay.checkIn,
    shortCheckOut,
    bookingCreateIsolation("member-exception-approval", testInfo.retry),
  );
  await submitRequest(
    page,
    "Asking once more now the committee has met — one night only.",
    /^Request Booking Officer approval$/,
  );
  await page.close();

  const target = await openRequest();

  const officer = await adminContext.newPage();
  const card = await openOfficerDecisionForm(officer, target.id);
  await card
    .getByLabel(/Explanation for the member/)
    .fill("Approved as a one-off — the lodge is quiet that week.");
  await card
    .getByText("I have read the proposal above and I am applying this exception.")
    .click();
  const approvalResponse = officer.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().endsWith(
        `/api/admin/booking-exception-requests/${target.id}`,
      ),
  );
  await card.getByRole("button", { name: "Approve and apply" }).click();
  const approvedDecision = await approvalResponse;
  expect(
    approvedDecision.ok(),
    `officer approval (${approvedDecision.status()}): ${await approvedDecision.text()}`,
  ).toBeTruthy();
  await officer.close();

  await expectRequestStatus(target.id, "approved");

  const approved = (await memberRequests()).find((row) => row.id === target.id);
  expect(
    approved?.createdBookingId,
    "an approved new-booking request must carry the booking it created",
  ).toBeTruthy();
  // Approval is not a status flip, and it is not a hold either. The request holds
  // nothing — and neither does the booking it created (#2562 review): the approval
  // lands it on PENDING or PAYMENT_PENDING, and neither holds capacity until it is
  // paid, so another member can still take those nights.
  expect(approved?.capacityHeld).toBe(false);
  expect(
    approved?.createdBookingHoldsCapacity,
    "an unpaid booking made by an approval holds no beds",
  ).toBe(false);
  // The second fact about the same booking (#2562 re-review): it holds nothing
  // BECAUSE it is unpaid, not because it is over — which is what makes "open it and
  // pay it" honest advice on this row rather than an instruction about a cancelled
  // booking.
  expect(
    approved?.createdBookingAwaitsPayment,
    "the booking an approval just made is still live and still owed",
  ).toBe(true);

  const list = await memberContext.newPage();
  await list.goto("/bookings");
  const row = list.getByTestId("exception-request-row").first();
  await expect(row.getByText("Approved and booked")).toBeVisible();
  // The honest sentence for this path (#2562 review). The booking exists; its beds
  // are NOT held until it is paid, and the row must say so rather than telling the
  // member their stay is secured.
  await expect(
    row.getByText(/not holding any beds yet/),
  ).toBeVisible();
  await expect(row.getByText(/until it is paid/)).toBeVisible();
  await expect(
    row.getByText(/The beds are on the booking this created/),
  ).toHaveCount(0);
  await expect(row.getByRole("link", { name: "Open the booking" })).toHaveAttribute(
    "href",
    new RegExp(`/bookings/${approved?.createdBookingId}`),
  );
  await list.close();
});

test("the request area works on a phone-sized viewport", async () => {
  const page = await memberContext.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/bookings");

  await expect(
    page.getByRole("heading", { name: "My booking-rule requests" }),
  ).toBeVisible();
  const row = page.getByTestId("exception-request-row").first();
  await expect(row.getByText("Approved and booked")).toBeVisible();
  await expect(row.getByRole("link", { name: "Open the booking" })).toBeVisible();

  // The page itself must not scroll sideways on a phone: the cards stack rather
  // than keeping their desktop side-by-side layout.
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(
    overflow,
    "My Bookings must not scroll horizontally at 390px",
  ).toBeLessThanOrEqual(1);
  await page.close();
});

test("the edit panel offers the same request, with the modification's own capacity answer", async () => {
  // The booking made in test 1, found through the same admin list the reset
  // helpers use rather than by scraping the member's own page.
  const listed = await admin.get(
    `/api/admin/bookings?calendarMonth=${compliant.checkIn.slice(0, 7)}` +
      `&status=PENDING,PAYMENT_PENDING,CONFIRMED,PAID`,
  );
  expect(listed.ok(), `admin bookings list (${listed.status()})`).toBeTruthy();
  const bookings = (
    (await listed.json()) as {
      bookings: Array<{
        id: string;
        memberName: string;
        checkIn: string;
        deletedAt: string | null;
      }>;
    }
  ).bookings.filter(
    (booking) =>
      booking.memberName === MEMBER_NAME &&
      booking.checkIn === compliant.checkIn &&
      !booking.deletedAt,
  );
  expect(
    bookings.length,
    "test 1's two-night booking must still exist for the edit journey",
  ).toBe(1);
  const bookingId = must(
    bookings[0],
    "test 1's two-night booking is missing",
  ).id;

  const page = await memberContext.newPage();
  await page.goto(`/bookings/${bookingId}`);
  await page.getByRole("button", { name: "Edit Booking" }).click();

  // Shorten the stay to one night, which the club-wide two-night minimum blocks.
  await page.getByLabel("Check-out").fill(compliantShortenedCheckOut);
  await page.getByRole("button", { name: /Save Changes/ }).click();

  const card = page.getByTestId("request-officer-approval");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText("Minimum length of stay")).toBeVisible();
  // The live booking this change moves FROM is stated, which the new-booking path
  // has nothing to show.
  await expect(card.getByText("Booking today")).toBeVisible();
  // The MODIFICATION path's own capacity sentence, from this request's real
  // reservation footprint rather than a generic promise about held beds.
  await expect(
    card.getByText(/No extra beds are held by this request/),
  ).toBeVisible();

  await submitRequest(
    page,
    "Plans changed — I can only make the first night now.",
    /^Request Booking Officer approval$/,
  );
  await page.close();

  const raised = await openRequest();
  expect(raised.source).toBe("MODIFICATION");
  expect(raised.bookingId).toBe(bookingId);
  // A pure shrink reserves nothing, so nothing is claimed to be held.
  expect(raised.capacityHeld).toBe(false);

  // And the member can withdraw it from their own area: one click to ask, one to
  // confirm, and nothing is booked or changed either way.
  const list = await memberContext.newPage();
  await list.goto("/bookings");
  const row = list
    .getByTestId("exception-request-row")
    .filter({ hasText: "A change to a booking" })
    .first();
  await row.getByRole("button", { name: "Withdraw" }).click();
  await expect(row.getByText(/Withdraw this request\?/)).toBeVisible();
  await row.getByRole("button", { name: "Yes, withdraw it" }).click();
  await expect(list.getByText("Withdrawn by you").first()).toBeVisible({
    timeout: 30_000,
  });
  await list.close();

  const withdrawn = (await memberRequests()).find((row) => row.id === raised.id);
  expect(withdrawn?.status).toBe("withdrawn");
  expect(withdrawn?.canWithdraw).toBe(false);
  expect(withdrawn?.canReplace).toBe(false);
});
