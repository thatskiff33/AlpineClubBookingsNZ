import {
  type APIRequestContext,
  type APIResponse,
  type BrowserContext,
  type Page,
  expect,
  test,
} from "../helpers/accessibility";
import { loginPersona } from "../helpers/auth";
import {
  bookingCreateIsolation,
  postBookingCreate,
} from "../helpers/booking-create-client-ip";
import {
  E2E_ADMIN,
  NOMINATOR_TWO,
  ROLE_PERSONAS,
  WAITLISTER,
} from "../helpers/fixtures";
import { stayWindow } from "../helpers/stay-dates";
import { overrideModules, type ModuleSettings } from "../helpers/modules";
import { clearMailbox, waitForEmail } from "../helpers/mailpit";

/*
  #2309 (epic #2305, MG4) — adding a member guest while EDITING a booking, and
  the officer doing the same thing on somebody else's booking.

  Matrix row (docs/END_TO_END_TEST_MATRIX.md): "Booking guests on the edit and
  admin paths".

  WHY THIS FILE IS IN THE MULTI-LODGE PROJECT rather than beside the other two
  member-guest specs. The edit path reaches capacity, pricing and the guest
  plan through the modification service, and every one of those is lodge-scoped.
  Running it in the matrix means the section, the add and the notification are
  proved on a club that has more than one lodge — which is where a booking's own
  lodge silently becoming "the default lodge" would show up.

  WHAT IT PROVES, in order:
    1. A member who has ALREADY made a booking can add a cross-family member
       guest from the edit panel — the whole point of MG4, since before it the
       only way was to cancel and rebook.
    2. The Guests card header carries the signed-off TWO-BUTTON shape (owner
       sign-off, 1 Aug 2026) — "+ Add Member Guest" then
       "+ Add Non-Member Guest" — mirroring the wizard, and the pre-save preview
       is honest: the new row says the person will be emailed and asked, and
       their bed held, BEFORE anything is saved.
    3. Saving actually asks them — the consent request lands in Mailpit.
    4. An OFFICER adding on the same booking gets the other rule: the member is
       added immediately and TOLD, not asked, and the mail says so.

  MECHANICS, mirroring member-guest-consent.spec.ts because the constraints are
  the same:
    - Wanda (WAITLISTER) books; Nadia (NOMINATOR_TWO) is the cross-family
      target. Both are seeded PAID with complete, self-confirmed profiles — a
      cross-family add refuses an unpaid or incomplete target under D-8 — and
      both hold logins, so the mail goes to them directly.
    - Bianca (ROLE_PERSONAS.ADMIN_BOOKINGS) is the Booking Officer. She is the
      persona #1376 exists for, which is exactly why she is the one used here:
      the admin section must work for her through the exact-email box even if
      her role carries no membership access.
    - A WINDOW PER ATTEMPT. Attempt 1 leaves a real PENDING row holding Nadia's
      person-night (D-4), so a retry on the same nights would be refused by the
      member-night guard and collapsed to D-8's neutral 403 — failing on the
      fixture rather than on the behaviour. Indices 0-9 belong to other specs,
      11-12 to the whole-lodge spec and 13-18 to the consent spec; 19-24 are
      this file's, three attempts x two tests.
*/

test.describe.configure({ mode: "serial" });

function memberEditWindow(retry: number) {
  return stayWindow(19 + retry * 2);
}
function adminEditWindow(retry: number) {
  return stayWindow(20 + retry * 2);
}

let adminContext: BrowserContext;
let adminRequest: APIRequestContext;
let previousModules: ModuleSettings | null = null;

let wandaContext: BrowserContext;
let wandaPage: Page;
let officerContext: BrowserContext;
let officerPage: Page;

let wandaId: string;

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

/** A booking with the booker alone on it — the state MG4's edit path acts on. */
function soloBookingOptions(window: {
  checkIn: string;
  checkOut: string;
}) {
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
      ],
    },
  };
}

async function soloBookingIdFromResponse(res: APIResponse): Promise<string> {
  expect(res.status(), `POST /api/bookings (${res.status()})`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/**
 * Open the edit panel and find the member guest by exact email.
 *
 * Exact email rather than name search on purpose: it is the shipped default
 * (open search is off unless a club turns it on), so this drives the
 * configuration every club actually runs.
 */
async function findMemberGuest(page: Page, email: string) {
  const content = mainContent(page);
  await content.getByRole("button", { name: "Edit Booking" }).click();

  // THE SIGNED-OFF HEADER SHAPE, asserted rather than assumed: two buttons,
  // member-guest first, replacing the generic "+ Add Guest" the panel used to
  // carry. Both are checked so a regression to one button fails here rather
  // than surfacing as a confusing "element not found" three lines down.
  await expect(
    page.getByRole("button", { name: "+ Add Member Guest" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "+ Add Non-Member Guest" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "+ Add Guest" })).toHaveCount(0);

  await page.getByRole("button", { name: "+ Add Member Guest" }).click();
  const panel = page.getByTestId("member-guest-find-panel");
  await expect(panel).toBeVisible();
  await panel.getByRole("combobox").fill(email);
  await panel.getByRole("button", { name: "Find" }).click();
  await panel.getByRole("button", { name: "Add to booking" }).click();
}

test.beforeAll(async ({ browser }) => {
  adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await loginPersona(adminPage, E2E_ADMIN.email, "10.62.0.1");
  adminRequest = adminPage.request;
  previousModules = await overrideModules(adminRequest, { memberGuests: true });

  wandaId = await resolveMemberId(adminRequest, WAITLISTER.email);

  wandaContext = await browser.newContext();
  wandaPage = await wandaContext.newPage();
  await loginPersona(wandaPage, WAITLISTER.email, "10.62.0.2");

  officerContext = await browser.newContext();
  officerPage = await officerContext.newPage();
  await loginPersona(
    officerPage,
    ROLE_PERSONAS.ADMIN_BOOKINGS.email,
    "10.62.0.3",
  );
});

test.afterAll(async () => {
  if (previousModules) {
    await overrideModules(adminRequest, {
      memberGuests: previousModules.memberGuests ?? false,
    });
  }
  await adminContext?.close();
  await wandaContext?.close();
  await officerContext?.close();
});

test("a member adds a member guest from the edit panel, and the target is asked", async ({}, testInfo) => {
  // CLEARED BEFORE THE SEND, not just before the wait: this file is retried up
  // to twice and the mailbox is not emptied between attempts, so a regression
  // to zero sends would otherwise "pass" on attempt 2 against attempt 1's
  // leftover message.
  await clearMailbox();
  const bookingId = await soloBookingIdFromResponse(
    await postBookingCreate(
      wandaPage.request,
      bookingCreateIsolation("multi-lodge-member-edit", testInfo.retry),
      soloBookingOptions(memberEditWindow(testInfo.retry)),
    ),
  );

  await wandaPage.goto(`/bookings/${bookingId}`);
  await findMemberGuest(wandaPage, NOMINATOR_TWO.email);

  // THE PRE-SAVE PROMISE, asserted before anything is written. This is what
  // MG4 added to the edit path that the create path already had: the booker is
  // told what saving will do to the person they just picked.
  await expect(
    wandaPage.getByText(
      `${NOMINATOR_TWO.firstName} will be emailed when you save this change, and their bed is held until they answer.`,
    ),
  ).toBeVisible();
  // The WIZARD-audience badge, which carries the target's name — "Waiting for
  // consent" is the member/admin label for a PERSISTED row and never renders on
  // an unsaved one (`describeMemberGuestConsentBadge`, WIZARD column).
  await expect(
    wandaPage.getByText(`Waiting for ${NOMINATOR_TWO.firstName} to approve`),
  ).toBeVisible();

  await wandaPage.getByRole("button", { name: "Save Changes" }).click();

  // ...and saving actually asks them. The subject is the shared composer's, so
  // a wording change that broke the ask would break this too.
  await waitForEmail(
    NOMINATOR_TWO.email,
    `Can ${WAITLISTER.firstName} ${WAITLISTER.lastName} add you to this booking?`,
  );

  await wandaPage.goto(`/bookings/${bookingId}`);
  const content = mainContent(wandaPage);
  await expect(
    content.locator("p.font-medium").filter({
      hasText: `${NOMINATOR_TWO.firstName} ${NOMINATOR_TWO.lastName}`,
    }),
  ).not.toHaveCount(0);
});

test("an officer adding on somebody's booking tells the member instead of asking them", async ({}, testInfo) => {
  // MG4-D-a, end to end: the SAME surface, the other rule. An officer's add is
  // consent-free and immediate, and the member is told — which is the half a
  // reader is most likely to assume is optional.
  await clearMailbox();
  const bookingId = await soloBookingIdFromResponse(
    await postBookingCreate(
      wandaPage.request,
      bookingCreateIsolation("multi-lodge-officer-edit", testInfo.retry),
      soloBookingOptions(adminEditWindow(testInfo.retry)),
    ),
  );

  await officerPage.goto(`/bookings/${bookingId}`);
  await officerPage
    .getByTestId("booking-detail-content")
    .getByRole("button", { name: "Edit Booking" })
    .click();
  await officerPage.getByRole("button", { name: "+ Add Member Guest" }).click();

  // The admin sentence lives INSIDE the opened finder (owner sign-off, 1 Aug
  // 2026 — with no block there is nothing to hang it under), and it states both
  // halves: immediate, and the member is told.
  await expect(
    officerPage.getByTestId("edit-member-guest-intent"),
  ).toHaveText("This member will be added immediately and told by email.");

  const panel = officerPage.getByTestId("member-guest-find-panel");
  await panel.getByRole("combobox").fill(NOMINATOR_TWO.email);
  await panel.getByRole("button", { name: "Find" }).click();
  await panel.getByRole("button", { name: "Add to booking" }).click();
  await officerPage.getByRole("button", { name: "Save Changes" }).click();

  // An admin save opens the #1668/#1696 notify dialog before anything is
  // written. Declining the courtesy change-notification here is deliberate:
  // D-16 says the member-guest ADDED notice is not that tick, so the notice
  // below must arrive even though the officer chose to send nothing else.
  await officerPage
    .getByRole("button", { name: "Save without emailing" })
    .click();

  // Told, not asked: the added-notice subject, never the consent request's.
  await waitForEmail(
    NOMINATOR_TWO.email,
    "You have been added to a lodge booking",
  );
});
