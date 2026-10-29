import { type APIRequestContext, expect, test } from "./helpers/accessibility";
import { storageStatePath } from "./helpers/auth";
import {
  CHANGE_REQUEST_FINISHED_BOOKING_ID,
  CHANGE_REQUEST_FINISHED_WINDOW,
  CHANGE_REQUEST_FREE_TEXT_ID,
  CHANGE_REQUEST_OWNER_EMAIL,
  E2E_ADMIN,
} from "./helpers/fixtures";
import { waitForEmail } from "./helpers/mailpit";
import { must } from "../src/lib/indexed-access";

// docs/END_TO_END_TEST_MATRIX.md row "Officer enters the guests a free-text
// change request described (#4030)".
//
// A member whose stay had started used to be able to send only a note ("can we
// add our two grandchildren"), which named nobody, so once the stay finished
// approving it could not add or charge anyone. The officer now enters the
// guests the member described on the request's card, checks the figures worked
// out for exactly that list, and approves — which records the guests on the
// request as entered on the member's behalf and applies them to the finished
// stay with the amount due raised.
//
// SEEDED, not created here (prisma/demo-seed.ts, CHANGE_REQUEST_FINISHED_*): a
// COMPLETED internet-banking stay sixty days back with one REQUESTED request in
// the old free-text shape. No route can create such a request — the member's
// own route now refuses a note alone, and refuses a finished stay — so the
// fixture is the only way in.
//
// RETRY-SAFE BY BRANCHING (docs/E2E_PLAYWRIGHT.md, flake invariant 1). Approving
// consumes the request, and the suite seeds once per run, so a retry — or a
// second run against the same database — finds it already APPROVED. The test
// reads the request first and asserts whichever state it is really in: the full
// journey on a fresh database; on a retry, the outcome the first attempt left
// (APPROVED, the officer's entry on the request, the guests on the booking).
// A failure BEFORE Approve leaves the request REQUESTED and the card's draft is
// unsaved, so the retry simply runs the journey again.

test.use({ storageState: storageStatePath(E2E_ADMIN.email) });
test.describe.configure({ timeout: 120_000 });

const GUESTS = [
  { firstName: "Ari", lastName: "Grandchild", ageTier: "CHILD" },
  { firstName: "Bo", lastName: "Grandchild", ageTier: "YOUTH" },
] as const;

type StoredRequest = {
  status: string;
  requestedChanges: {
    requested?: {
      addGuests?: Array<{ firstName: string; stayStart?: string; stayEnd?: string }>;
      officerEntry?: { onMemberBehalf?: boolean; officerMemberId?: string };
    };
  };
  linkedModificationId: string | null;
};

async function readRequest(request: APIRequestContext): Promise<StoredRequest> {
  const response = await request.get(
    `/api/admin/booking-change-requests/${CHANGE_REQUEST_FREE_TEXT_ID}`,
  );
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as StoredRequest;
}

test("an officer enters the guests a free-text request described, checks the figures and approves", async ({
  page,
}) => {
  const before = await readRequest(page.request);
  expect(["REQUESTED", "APPROVED"]).toContain(before.status);

  // The amount the figures said the member would be asked for — only known on
  // the attempt that approved.
  let amountAsked: string | null = null;
  if (before.status === "REQUESTED") {
    await page.goto(
      `/admin/booking-requests?tab=changes&requestId=${CHANGE_REQUEST_FREE_TEXT_ID}`,
    );
    const card = page.getByTestId(`change-request-${CHANGE_REQUEST_FREE_TEXT_ID}`);
    await expect(card).toBeVisible();
    // The member's own words, and the officer's entry offered for a request
    // that names nobody.
    await expect(card.getByText(/our two grandchildren/)).toBeVisible();
    await expect(card.getByText("Guests the member asked to add")).toBeVisible();

    await card
      .getByLabel(/Explanation for the member/)
      .fill("We have added your grandchildren to the stay.");

    for (const guest of GUESTS) {
      await card.getByLabel("First name").fill(guest.firstName);
      await card.getByLabel("Last name").fill(guest.lastName);
      await card.getByLabel("Age").selectOption(guest.ageTier);
      await card.getByRole("button", { name: "Add guest" }).click();
      await expect(card.getByText(`${guest.firstName} ${guest.lastName}`)).toBeVisible();
    }
    // Bo stayed the second night only: the row's own Date In, inside the stay.
    const secondNight = must(
      CHANGE_REQUEST_FINISHED_WINDOW.nights[1],
      "the seeded finished stay has a second night",
    );
    const dateIns = card.getByLabel("Date In");
    await expect(dateIns).toHaveCount(GUESTS.length);
    await expect(dateIns.nth(1)).toHaveAttribute("min", CHANGE_REQUEST_FINISHED_WINDOW.checkIn);
    await dateIns.nth(1).fill(secondNight);

    // Approve and apply stays off until the figures for THIS list are shown.
    const approve = card.getByRole("button", { name: "Approve and apply" });
    await expect(approve).toBeDisabled();
    await card.getByRole("button", { name: "Check the figures" }).click();
    const figures = card.getByRole("list", { name: "What approving will do" });
    await expect(figures).toBeVisible();
    // Adding guests carries no change fee; the extra is asked of the member.
    await expect(figures.getByText("Change fee: $0.00")).toBeVisible();
    const asked = figures.getByText(/The member will be asked for \$\d/);
    await expect(asked).toBeVisible();
    amountAsked = must(
      (await asked.textContent())?.match(/asked for (\$[\d,]+\.\d{2})/)?.[1],
      "the figures name the amount the member will be asked for",
    );
    await expect(approve).toBeEnabled();

    await approve.click();
    await expect(
      page.getByText(/Guests recorded on the member's behalf, and the request approved and applied/),
    ).toBeVisible();
  }

  // The stored outcome, on the first attempt and on a retry alike.
  const after = await readRequest(page.request);
  expect(after.status).toBe("APPROVED");
  expect(after.linkedModificationId).toBeTruthy();
  const requested = after.requestedChanges.requested;
  expect(requested?.officerEntry?.onMemberBehalf).toBe(true);
  expect(requested?.addGuests?.map((guest) => guest.firstName)).toEqual(
    GUESTS.map((guest) => guest.firstName),
  );
  expect(requested?.addGuests?.[1]?.stayStart).toBe(
    must(CHANGE_REQUEST_FINISHED_WINDOW.nights[1], "the seeded finished stay has a second night"),
  );

  // The booking now carries both guests, and its history the change that
  // raised the amount due.
  await page.goto(`/bookings/${CHANGE_REQUEST_FINISHED_BOOKING_ID}`);
  const content = page.getByTestId("booking-detail-content");
  await expect(content.getByRole("heading", { name: "Booking Details" })).toBeVisible();
  for (const guest of GUESTS) {
    // Exact, so the request's own summary line ("add Ari Grandchild, …") is
    // not what satisfies it: this is the guest row. Visible-filtered, because
    // the booking route streams (flake invariant 2): for a beat the row exists
    // twice, once in a hidden template.
    await expect(
      content
        .getByText(`${guest.firstName} ${guest.lastName}`, { exact: true })
        .filter({ visible: true }),
    ).toHaveCount(1);
  }
  const modification = content
    .getByText("Booking Modified", { exact: true })
    .filter({ visible: true });
  await expect(modification).toHaveCount(1);
  if (amountAsked) {
    // The payment due: exactly the figure the officer was shown before approving.
    await expect(
      content.getByText(`+${amountAsked}`, { exact: true }).filter({ visible: true }),
    ).toHaveCount(1);
  }

  // The member is told through the usual change email (the internet-banking
  // amount due is in it). Nothing else in the suite changes this member's
  // bookings, so no other "Booking Modified" email can reach them.
  const email = await waitForEmail(CHANGE_REQUEST_OWNER_EMAIL, "Booking Modified");
  expect(email.to).toContain(CHANGE_REQUEST_OWNER_EMAIL);
});
