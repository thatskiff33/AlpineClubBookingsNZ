import {
  type APIRequestContext,
  type APIResponse,
  type BrowserContext,
  type Page,
  expect,
  test,
} from "./helpers/accessibility";
import { loginPersona } from "./helpers/auth";
import {
  bookingCreateIsolation,
  postBookingCreate,
} from "./helpers/booking-create-client-ip";
import { E2E_ADMIN, NOMINATOR_TWO, WAITLISTER } from "./helpers/fixtures";
import { stayWindow } from "./helpers/stay-dates";
import { overrideModules, type ModuleSettings } from "./helpers/modules";
import { clearMailbox, waitForEmail } from "./helpers/mailpit";

/*
  #2307 (epic #2305) — the member-guest consent journey, browser end to end.

  Matrix rows (docs/END_TO_END_TEST_MATRIX.md): the two Playwright rows the
  MG2 server half recorded as landing with the visible surfaces —
    - approve: a cross-family add persists PENDING, the target answers Yes on
      the booking page's consent card, and the guest list then shows the
      Consented badge;
    - decline on an unpaid booking: the target answers No, the held place is
      released, and the booker's guest list no longer names them.
  Plus the delegate-route privacy edge worth proving against real rows: a
  signed-in member who is NOT the target's family delegate — including the
  BOOKER, who knows more about this booking than anyone — gets one neutral
  "nothing here" page from /bookings/consent/<guestId>, with no booking facts
  on it, indistinguishable from a made-up id.

  MECHANICS:
    - Wanda (WAITLISTER) books; Nadia (NOMINATOR_TWO) is the cross-family
      target. Both are seeded PAID with complete, self-confirmed profiles —
      required, because a cross-family add refuses an unpaid or incomplete
      target (D-8) — and both hold logins, so the consent-request email goes
      to Nadia directly and she answers for herself on the booking page.
    - Windows 13 and 14: 0–9 are the other specs', 11–12 the whole-lodge
      spec's. Fresh windows keep Nadia clear of the person-night guard.
    - The memberGuests module is switched on for this file and the previous
      module settings restored afterwards.
    - RETRY-SAFE by construction: every attempt books its OWN stay windows
      (see approveWindow/declineWindow). CI retries this file up to twice, and
      a retry reusing attempt one's nights would be refused — the PENDING row
      attempt one created still holds Nadia's person-night, and that refusal
      is collapsed to D-8's neutral 403, so the retry would fail on the
      fixture rather than on the behaviour under test.
*/

test.describe.configure({ mode: "serial" });

// A WINDOW PER ATTEMPT, not a fixed pair. Attempt 1 leaves real rows behind —
// a PENDING member guest holds a bed and a person-night (D-4) until the nightly
// sweep expires it — so a retry booking the same nights for the same target
// hits the member-night guard and gets D-8's neutral 403, failing on the
// fixture rather than on the behaviour. Indices 0-9 belong to the other specs
// and 11-12 to the whole-lodge spec; 13-18 are this file's, three attempts x
// two tests.
function approveWindow(retry: number) {
  return stayWindow(13 + retry * 2);
}
function declineWindow(retry: number) {
  return stayWindow(14 + retry * 2);
}

let adminContext: BrowserContext;
let adminRequest: APIRequestContext;
let previousModules: ModuleSettings | null = null;

let wandaContext: BrowserContext;
let wandaPage: Page;
let nadiaContext: BrowserContext;
let nadiaPage: Page;

let wandaId: string;
let nadiaId: string;

/**
 * The booking page's own content region, rooted at the layout's
 * `#main-content` landmark.
 *
 * The `booking-detail-content` testid alone is NOT enough here. On the running
 * app this page's markup is reachable TWICE in the DOM — CI reported every
 * assertion as a strict-mode violation resolving to two identical elements,
 * one addressable under `#main-content` and one not — so a testid-only locator
 * is ambiguous no matter how exact the text match is. Rooting at the landmark
 * the layout actually renders `{children}` inside (`(authenticated)/layout.tsx`)
 * selects the real page and excludes whatever the second copy belongs to
 * (the member layout also mounts the help, issue-report and onboarding widgets
 * outside that landmark). Recorded here rather than worked around silently: if
 * that duplication is ever found to be a defect, this is the note that says
 * where it was first seen.
 */
function mainContent(page: Page) {
  return page.locator("#main-content").getByTestId("booking-detail-content");
}

async function resolveMemberId(
  request: APIRequestContext,
  email: string,
): Promise<string> {
  const res = await request.get(
    `/api/admin/members?search=${encodeURIComponent(email)}`,
  );
  expect(res.ok(), `GET /api/admin/members (${res.status()})`).toBeTruthy();
  const body = (await res.json()) as {
    members?: Array<{ id: string; email: string }>;
  };
  const match = (body.members ?? []).find((member) => member.email === email);
  expect(match?.id, `${email} should be an admin-visible member`).toBeTruthy();
  return match!.id;
}

type CreatedBooking = {
  id: string;
  guests: Array<{ id: string; memberId: string | null; consentStatus: string | null }>;
};

function memberGuestBookingOptions(
  window: { checkIn: string; checkOut: string },
) {
  return {
    data: {
      checkIn: window.checkIn,
      checkOut: window.checkOut,
      guests: [
        {
          firstName: WAITLISTER.firstName,
          lastName: WAITLISTER.lastName,
          ageTier: "ADULT",
          isMember: true,
          memberId: wandaId,
        },
        {
          firstName: NOMINATOR_TWO.firstName,
          lastName: NOMINATOR_TWO.lastName,
          ageTier: "ADULT",
          isMember: true,
          memberId: nadiaId,
        },
      ],
    },
  };
}

async function createdBookingFromResponse(
  res: APIResponse,
): Promise<CreatedBooking> {
  expect(res.status(), `POST /api/bookings (${res.status()})`).toBe(201);
  return (await res.json()) as CreatedBooking;
}

function pendingGuestOf(booking: CreatedBooking) {
  const guest = booking.guests.find((row) => row.memberId === nadiaId);
  expect(guest, "the cross-family target must be on the created booking").toBeTruthy();
  // The whole feature under test: a module-on cross-family add persists an
  // unanswered consent request, never a silently-confirmed guest.
  expect(guest!.consentStatus).toBe("PENDING");
  return guest!;
}

test.beforeAll(async ({ browser }) => {
  adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await loginPersona(adminPage, E2E_ADMIN.email, "10.60.0.1");
  adminRequest = adminPage.request;
  previousModules = await overrideModules(adminRequest, { memberGuests: true });

  wandaId = await resolveMemberId(adminRequest, WAITLISTER.email);
  nadiaId = await resolveMemberId(adminRequest, NOMINATOR_TWO.email);

  wandaContext = await browser.newContext();
  wandaPage = await wandaContext.newPage();
  await loginPersona(wandaPage, WAITLISTER.email, "10.60.0.2");

  nadiaContext = await browser.newContext();
  nadiaPage = await nadiaContext.newPage();
  await loginPersona(nadiaPage, NOMINATOR_TWO.email, "10.60.0.3");
});

test.afterAll(async () => {
  if (previousModules) {
    await overrideModules(adminRequest, {
      memberGuests: previousModules.memberGuests ?? false,
    });
  }
  await adminContext?.close();
  await wandaContext?.close();
  await nadiaContext?.close();
});

// Captured by the approve test for the delegate-privacy probe below: a REAL,
// by-then-settled guest row id.
let approvedGuestId: string | null = null;

test("the target approves on the booking page's consent card and the badge flips to Consented", async ({}, testInfo) => {
  // CLEAR BEFORE THE SEND, not just before the wait. The subject and the
  // recipient below are constants, this file is retried up to twice, and the
  // mailbox is not emptied between attempts — so without this, a regression to
  // ZERO sends would still "pass" on attempt 2 by matching attempt 1's leftover
  // message. The helper's own docblock asks for exactly this, and the two other
  // specs that read mail do it the same way.
  await clearMailbox();
  const booking = await createdBookingFromResponse(
    await postBookingCreate(
      wandaPage.request,
      bookingCreateIsolation("member-guest-consent-approve", testInfo.retry),
      memberGuestBookingOptions(approveWindow(testInfo.retry)),
    ),
  );
  approvedGuestId = pendingGuestOf(booking).id;

  // D-16: the ask is emailed to the target directly (she holds a login).
  await waitForEmail(
    NOMINATOR_TWO.email,
    `Can ${WAITLISTER.firstName} ${WAITLISTER.lastName} add you to this booking?`,
  );

  // D-11: the pending target opens the WHOLE booking page, card inside it.
  await nadiaPage.goto(`/bookings/${booking.id}#consent`);
  const content = mainContent(nadiaPage);
  // Scoped to the card's own anchor — the one the request email deep-links to
  // — and matched EXACTLY. Both matter: the page is long and mostly
  // conditional, and a substring match on a heading also matches every
  // ancestor whose text is just that heading, which is a strict-mode failure
  // rather than a real ambiguity.
  const card = content.locator("#consent");
  await expect(
    card.getByText(
      `${WAITLISTER.firstName} ${WAITLISTER.lastName} has added you to this booking`,
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    card.getByText("Waiting for your answer", { exact: true }),
  ).toBeVisible();
  // MG2-D-a's party listing, with the viewer's own row marked.
  await expect(
    card.getByText(
      `${NOMINATOR_TWO.firstName} ${NOMINATOR_TWO.lastName} — that's you`,
    ),
  ).toBeVisible();
  // `exact` again because the lapse sentence below also contains "answer by".
  await expect(card.getByText("Answer by", { exact: true })).toBeVisible();

  await card.getByRole("button", { name: "Yes, add me" }).click();
  await expect(
    content.getByText("You're on this booking", { exact: true }),
  ).toBeVisible();
  await expect(content.getByText(/your place is confirmed/)).toBeVisible();

  // Reload: the question is gone and the guest list carries the ticked badge.
  await nadiaPage.goto(`/bookings/${booking.id}`);
  const reloaded = mainContent(nadiaPage);
  await expect(reloaded.getByText("Consented", { exact: true })).toBeVisible();
  await expect(
    reloaded.getByRole("button", { name: "Yes, add me" }),
  ).toHaveCount(0);
});

test("the target declines on an unpaid booking and the booker's guest list no longer names them", async ({}, testInfo) => {
  const booking = await createdBookingFromResponse(
    await postBookingCreate(
      wandaPage.request,
      bookingCreateIsolation("member-guest-consent-decline", testInfo.retry),
      memberGuestBookingOptions(declineWindow(testInfo.retry)),
    ),
  );
  const guest = pendingGuestOf(booking);

  // The TARGET following the delegate link is sent to her own surface — the
  // booking page's #consent card — never left on the delegate panel.
  await nadiaPage.goto(`/bookings/consent/${guest.id}`);
  await expect(nadiaPage).toHaveURL(new RegExp(`/bookings/${booking.id}`));

  const content = mainContent(nadiaPage);
  await content.locator("#consent").getByRole("button", { name: "No thanks" }).click();
  await expect(
    content.getByText("You've said no", { exact: true }),
  ).toBeVisible();
  await expect(
    content.getByText(/The bed that was held for you has been released/),
  ).toBeVisible();
  await expect(
    content.getByRole("link", { name: "Back to my bookings" }),
  ).toBeVisible();

  // The booker's view: the GUEST LIST no longer includes the member who said
  // no. Scoped to the rows the editor renders the party in, deliberately — a
  // page-wide name search also matches the booking's own history, which
  // legitimately records that the guest was removed. The point of this
  // assertion is that the place was released, not that her name is scrubbed
  // from the record.
  await wandaPage.goto(`/bookings/${booking.id}`);
  const wandaView = mainContent(wandaPage);
  await expect(
    wandaView.getByText("Stay Details", { exact: true }),
  ).toBeVisible();
  const guestRows = wandaView.locator("p.font-medium");
  await expect(
    guestRows.filter({
      hasText: `${NOMINATOR_TWO.firstName} ${NOMINATOR_TWO.lastName}`,
    }),
  ).toHaveCount(0);
  // …and the booker herself is still on it, so the locator above is proved to
  // find guest rows at all rather than passing because it matches nothing.
  await expect(
    guestRows.filter({
      hasText: `${WAITLISTER.firstName} ${WAITLISTER.lastName}`,
    }),
  ).not.toHaveCount(0);
});

test("the delegate page tells a non-delegate — even the booker — nothing, indistinguishably from a made-up id", async () => {
  // A REAL guest row's id (the approve test's, now settled — authorization is
  // checked before status, so settled-vs-pending must not change the answer),
  // probed by the booker: entitled to the booking page, NOT to the delegate
  // panel, because she is no adult in the target's family group.
  //
  // ASSERTED, NOT `if`-GUARDED. This file runs serially, so the approve test has
  // already captured the id; if it somehow has not, the probe below would never
  // run and the suite would report a pass having proved nothing about the
  // privacy property. A security assertion that can silently not happen is worse
  // than one that fails, so a missing id is a failure here.
  expect(
    approvedGuestId,
    "the approve test must have captured a real guest row id for this probe",
  ).toBeTruthy();

  await wandaPage.goto(`/bookings/consent/${approvedGuestId}`);
  const panel = wandaPage.locator("#main-content");
  await expect(
    panel.getByText("There is nothing here for you to answer", {
      exact: true,
    }),
  ).toBeVisible();
  // No booking fact leaks onto the neutral page.
  await expect(panel.getByText(/has added/)).toHaveCount(0);
  await expect(panel.getByText("Booked by")).toHaveCount(0);

  // A fabricated id renders the SAME neutral page — the route is no oracle.
  await wandaPage.goto("/bookings/consent/does-not-exist");
  const fabricated = wandaPage.locator("#main-content");
  await expect(
    fabricated.getByText("There is nothing here for you to answer", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(fabricated.getByText("Booked by")).toHaveCount(0);
});
