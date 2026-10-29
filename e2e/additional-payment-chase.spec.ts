import { expect, test } from "./helpers/accessibility";
import { storageStatePath } from "./helpers/auth";
import {
  ADDITIONAL_OWED_AMOUNT_CENTS,
  ADDITIONAL_OWED_BOOKING_ID,
  E2E_ADMIN,
  NOMINATOR_TWO,
} from "./helpers/fixtures";
import { clearMailbox, waitForEmail } from "./helpers/mailpit";

// docs/END_TO_END_TEST_MATRIX.md row "Outstanding additional payment (#2350)".
//
// When a change pushes a paid booking's price up, the difference becomes an
// additional payment the member has to make themselves. Before #2350 nothing
// chased them for it and no admin screen showed it, so it could sit there for
// good. This walks the loop an officer actually performs: find the booking from
// the owed filter, read what is outstanding, and chase the member — then prove
// the club cannot chase the same member twice inside the hour.
//
// The owing booking is SEEDED (prisma/demo-seed.ts, id ADDITIONAL_OWED_BOOKING_ID)
// rather than produced by an admin edit here: raising a real additional payment
// mints a Stripe PaymentIntent, and this journey must run whether or not Stripe
// test-mode keys are configured. Everything downstream of that state — the list
// markers, the panel, the re-send, its email and its cooldown — is the real
// application code.
//
// Serial: the second test spends the re-send cooldown the third asserts on.
test.describe.configure({ mode: "serial" });
// Each re-send is a full mail round-trip through mailpit; the default per-test
// timeout is tight for that on a loaded CI runner.
test.describe.configure({ timeout: 180_000 });

test.use({ storageState: storageStatePath(E2E_ADMIN.email) });

const AMOUNT_LABEL = `$${(ADDITIONAL_OWED_AMOUNT_CENTS / 100).toFixed(2)}`;

test("the bookings list marks an owing booking partly paid with the amount due", async ({
  page,
}) => {
  await page.goto("/admin/bookings?additionalOwed=owed");

  // The seeded booking is the only one in the whole database with an
  // uncollected addition (the demo paid booking's addition is SUCCEEDED), so
  // the filtered list is exactly this member's row.
  const row = page.getByRole("row").filter({
    hasText: `${NOMINATOR_TWO.firstName} ${NOMINATOR_TWO.lastName}`,
  });
  await expect(row).toHaveCount(1);

  // Settlement, not lifecycle: the money is short even though the stay is
  // confirmed…
  await expect(row.getByText("Partly paid")).toBeVisible();
  await expect(row.getByText(`${AMOUNT_LABEL} due`)).toBeVisible();
  // …so the booking's own status chip still reads Paid, untouched.
  await expect(row.getByText("Paid", { exact: true })).toBeVisible();
});

/*
  Retry-safe by construction. Sending the request writes a stamp that survives
  the test — there is no reseed between Playwright retries — so on a retry this
  booking has already been chased inside the cooldown, and asserting the fresh
  path would fail three times over (a wrong "Not yet", a 429 instead of a send,
  and a three-minute wait for an email that was never going to arrive). So the
  test reads the panel first and asserts whichever state it is actually in: the
  full send on a fresh database, the refusal on a retry. The first attempt is
  the one that proves the email; the retry still proves the cooldown holds.
*/
test("the booking page shows an admin what is outstanding and chases the member", async ({
  page,
}) => {
  await page.goto(`/bookings/${ADDITIONAL_OWED_BOOKING_ID}`);

  const panel = page.getByTestId("additional-payment-outstanding");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Awaiting payment")).toBeVisible();
  await expect(panel.getByText(AMOUNT_LABEL).first()).toBeVisible();

  const alreadyChased = (await panel.getByText("Not yet").count()) === 0;

  await clearMailbox();
  await panel
    .getByRole("button", { name: "Resend payment request email" })
    .click();

  if (alreadyChased) {
    await expect(
      panel.getByText(/already emailed to this member/i),
    ).toBeVisible();
    return;
  }

  await expect(
    page.getByText("Payment request emailed to the member."),
  ).toBeVisible();

  const email = await waitForEmail(NOMINATOR_TWO.email, "Payment Still Needed");
  expect(email.to).toContain(NOMINATOR_TWO.email);
});

test("a second chase inside the hour is refused rather than sent", async ({
  page,
}) => {
  await page.goto(`/bookings/${ADDITIONAL_OWED_BOOKING_ID}`);

  const panel = page.getByTestId("additional-payment-outstanding");
  // The previous test's send is now the cooldown record, so the panel reports
  // when the member was last emailed instead of "Not yet".
  await expect(panel.getByText("Not yet")).toHaveCount(0);

  await clearMailbox();
  await panel
    .getByRole("button", { name: "Resend payment request email" })
    .click();

  await expect(panel.getByText(/already emailed to this member/i)).toBeVisible();
  await expect(
    panel.getByText("Payment request emailed to the member."),
  ).toHaveCount(0);
});
