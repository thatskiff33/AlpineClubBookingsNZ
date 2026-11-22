import { expect, test, type APIRequestContext, type Page } from "./helpers/accessibility";
import { loginPersona, storageStatePath } from "./helpers/auth";
import {
  E2E_ADMIN,
  MAPPING_APPLICANT,
  MAPPING_APPLICATION_ID,
  MAPPING_TARGET_MEMBER_ID,
  MEMBERSHIP_APPLICANT,
  MEMBERSHIP_APPLICATION_ID,
  NOMINATION_TOKEN_ONE,
  NOMINATION_TOKEN_TWO,
  NOMINATOR_TWO,
  PUBLIC_APPLICANT_EMAIL,
  WAITLISTER,
} from "./helpers/fixtures";
import { personas } from "./helpers/personas";

// High row (docs/END_TO_END_TEST_MATRIX.md): "Application, nomination reminders,
// admin refresh/replacement, approval, ..." — the public application →
// nominator confirmations → admin approval → member-exists journey.
//
// The nominator confirmation links are token URLs delivered by email, which is
// unconfigured in this stack. Since src/lib/action-tokens hashes tokens with a
// plain SHA-256 (no secret), the demo seed stores a PENDING_NOMINATORS
// application whose two nomination tokens have KNOWN raw values
// (e2e/helpers/fixtures.ts), so the two confirmation pages are driven for real
// without needing the email. The seeded nominators (Wanda, Nadia) both have
// complete, confirmed profiles so the onboarding modal never blocks their
// /nominations pages. The public submit is asserted separately against a fresh
// applicant (its own tokens are unrecoverable, by design).
//
// Only the three tests that hand state on (nominator one, nominator two, the
// approval) are serial, so a retry of one of them never re-runs the public
// submit, and the submit's own retry never drags them back through a database
// they already changed (docs/E2E_PLAYWRIGHT.md, "Flake invariants", 1).

// A retry, or a second run against the same seeded stack, would otherwise
// submit an applicant whose application is already pending and be refused.
// So each attempt applies as its own applicant. Three attempts stay within the
// endpoint's limit of three submissions an hour from one address.
const RUN = Date.now();

test("the public membership application endpoint accepts a valid submission", async ({
  request,
}, testInfo) => {
  const applicantEmail = PUBLIC_APPLICANT_EMAIL.replace("@", `.${RUN}-${testInfo.retry}@`);
  const res = await request.post("/api/applications", {
    data: {
      applicantFirstName: "Penny",
      applicantLastName: "Public",
      applicantEmail,
      applicantDateOfBirth: "1990-02-02",
      nominator1Email: personas.booker.email, // alice — PAID, eligible
      nominator2Email: NOMINATOR_TWO.email, // nadia — PAID, eligible
    },
  });
  const body = await res.json().catch(() => ({}));
  expect(res.status(), JSON.stringify(body)).toBe(201);
  expect(body.status).toBe("PENDING_NOMINATORS");
});

/**
 * The confirmation shows its message at once, then `router.refresh()` re-renders
 * the page from the server, which drops the button and re-streams the page's
 * <title>. Closing the context in between audits a page with no title for a
 * moment (axe `document-title`). Wait for the server's re-render (no button)
 * and then for the title, so the closing audit sees the settled page.
 */
async function expectConfirmationSettled(page: Page) {
  await expect(page.getByRole("button", { name: /Agree to Nominate|Confirming/ })).toHaveCount(0);
  await expect(page).toHaveTitle(/\S/);
}

/*
 * RETRIES MOVE FORWARD, NEVER BACK (#5407 items 30 and 38). A retry re-runs
 * this whole group against the database the failed attempt left, and these
 * steps only ever advance the seeded application: a nomination once confirmed
 * stays confirmed, an approval stays approved. So on a retry each step first
 * looks at where the application already is and accepts a state at or past its
 * own outcome; the first attempt always takes the strict path and drives the
 * action itself. No reset is needed, and none could restore the tokens'
 * one-time confirmations without a test-only endpoint.
 */
const ALREADY_CONFIRMED = "You have already confirmed this nomination.";

/** On a retry, whether this nominator's confirmation is already recorded (the button is then gone). */
async function nominationAlreadyConfirmed(page: Page, retry: number): Promise<boolean> {
  if (retry === 0) return false;
  const agree = page.getByRole("button", { name: "Agree to Nominate" });
  const already = page.getByText(ALREADY_CONFIRMED);
  await expect(agree.or(already).first()).toBeVisible();
  return already.isVisible();
}

/** The seeded application's status, read through the admin queue. */
async function applicationStatus(request: APIRequestContext, id: string): Promise<string | null> {
  for (const status of ["PENDING_NOMINATORS", "PENDING_ADMIN", "APPROVED", "REJECTED"]) {
    const res = await request.get(`/api/admin/member-applications?status=${status}&pageSize=100`);
    expect(res.ok(), `GET /api/admin/member-applications?status=${status} (${res.status()})`).toBeTruthy();
    const body = (await res.json()) as { applications?: Array<{ id: string }> };
    if ((body.applications ?? []).some((application) => application.id === id)) return status;
  }
  return null;
}

test.describe("nomination confirmations then approval", () => {
  test.describe.configure({ mode: "serial" });

  test("nominator one agrees to the seeded nomination", async ({ browser }, testInfo) => {
    // Confirmation requires being signed in as the specific nominator
    // (confirmNomination checks the id). Nominator1 is Wanda (complete profile →
    // no onboarding modal).
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginPersona(page, WAITLISTER.email);

    await page.goto(`/nominations/${NOMINATION_TOKEN_ONE}`);
    // The applicant name renders in a CardTitle (a div, not a heading role).
    await expect(
      page.getByText(new RegExp(`Nominate ${MEMBERSHIP_APPLICANT.firstName}`)),
    ).toBeVisible();
    if (!(await nominationAlreadyConfirmed(page, testInfo.retry))) {
      await page.getByRole("button", { name: "Agree to Nominate" }).click();
      await expect(page.getByText(/confirmation has been recorded/i)).toBeVisible();
      await expectConfirmationSettled(page);
    }

    await context.close();
  });

  test("nominator two agrees and the application moves to committee", async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginPersona(page, NOMINATOR_TWO.email);

    await page.goto(`/nominations/${NOMINATION_TOKEN_TWO}`);
    if (await nominationAlreadyConfirmed(page, testInfo.retry)) {
      // Both nominators are in: the server-rendered status reads "With
      // committee", or "Approved" if the next step also ran before the retry.
      await expect(page.getByText(/^(With committee|Approved)$/)).toBeVisible();
    } else {
      await page.getByRole("button", { name: "Agree to Nominate" }).click();
      // The second confirmation completes both nominators → committee review.
      await expect(page.getByText(/moved to committee review/i)).toBeVisible();
      // Only the refreshed server render changes the status label, so this
      // proves the refresh has landed, not just the client's message.
      await expect(page.getByText("With committee", { exact: true })).toBeVisible();
      await expectConfirmationSettled(page);
    }

    await context.close();
  });

  test("an admin approves the application and the applicant becomes a member", async ({
    browser,
  }, testInfo) => {
    // Reuse the E2E admin session saved once in auth.setup.ts instead of a fresh
    // per-spec login (#1779). This test drives the admin API directly, so it
    // needs the session cookies but no page.
    const context = await browser.newContext({
      storageState: storageStatePath(E2E_ADMIN.email),
    });

    const alreadyApproved =
      testInfo.retry > 0 &&
      (await applicationStatus(context.request, MEMBERSHIP_APPLICATION_ID)) === "APPROVED";

    // Approve via the review endpoint. Xero is absent, so skip the entrance-fee
    // invoice (a CREATE would only queue an outbox row that never sends).
    if (!alreadyApproved) {
      const approve = await context.request.put(
        `/api/admin/member-applications/${MEMBERSHIP_APPLICATION_ID}`,
        {
          data: {
            decision: "APPROVE",
            entranceFeeInvoiceDecision: {
              action: "SKIP",
              reason: "E2E: Xero not connected",
            },
          },
        },
      );
      const approveBody = await approve.json().catch(() => ({}));
      expect(approve.status(), JSON.stringify(approveBody)).toBe(200);
      expect(approveBody.status).toBe("APPROVED");
    }

    // The approved applicant now exists as a member (admin member search finds
    // the new login by email).
    const members = await context.request.get(
      `/api/admin/members?search=${encodeURIComponent(MEMBERSHIP_APPLICANT.email)}`,
    );
    expect(members.ok(), `GET /api/admin/members (${members.status()})`).toBeTruthy();
    const membersText = await members.text();
    expect(
      membersText.includes(MEMBERSHIP_APPLICANT.email),
      "approved applicant should exist as a member",
    ).toBeTruthy();

    await context.close();
  });
});

/** The mapped member was updated in place: still exactly ONE member holds the email. */
async function expectMappedInPlace(request: APIRequestContext) {
  const members = await request.get(
    `/api/admin/members?q=${encodeURIComponent(MAPPING_APPLICANT.email)}`,
  );
  expect(members.ok(), `GET /api/admin/members (${members.status()})`).toBeTruthy();
  const membersBody = await members.json();
  const matches = (membersBody.members ?? []).filter(
    (member: { email: string }) => member.email === MAPPING_APPLICANT.email,
  );
  expect(matches, "exactly one member holds the applicant email").toHaveLength(1);
  expect(matches[0].id).toBe(MAPPING_TARGET_MEMBER_ID);
}

test("an admin maps a rejoining applicant onto their existing member record (E10 diff preview + approve)", async ({
  browser,
}, testInfo) => {
  // The seed stores a PENDING_ADMIN application (Rex Rejoiner) alongside an
  // existing non-login member with the same email — the lapsed-rejoiner shape.
  // Drive the real admin UI: choose Map to existing, preview the field diff,
  // check the joining-fee SKIP default, approve, then assert the existing
  // member was updated in place and no duplicate was created.
  const context = await browser.newContext({
    storageState: storageStatePath(E2E_ADMIN.email),
  });
  // A retry after the approval landed (see "Retries move forward" above): the
  // card is gone from the pending queue, so check the end state and stop.
  if (
    testInfo.retry > 0 &&
    (await applicationStatus(context.request, MAPPING_APPLICATION_ID)) === "APPROVED"
  ) {
    await expectMappedInPlace(context.request);
    await context.close();
    return;
  }

  const page = await context.newPage();
  await page.goto("/admin/member-applications");

  // Scope everything to the mapping application's card (default filter is
  // "Pending admin", which also lists other seeded applications).
  const applicantName = `${MAPPING_APPLICANT.firstName} ${MAPPING_APPLICANT.lastName}`;
  const card = page
    .locator("div.rounded-xl.border")
    .filter({ hasText: applicantName });
  await expect(card).toHaveCount(1);

  // Switch the applicant to Map-to-existing and pick the existing member via
  // the live search (the exact-email candidate). The radio is a React-controlled
  // <input type="radio">; both check() (which verifies `checked` immediately
  // after the click, racing React 18's deferred re-render) and label->control
  // forwarding proved flaky in CI. Use a plain click() on the input (fires the
  // controlled onChange without an immediate-state assertion) and prove the
  // switch functionally via the MAP-mode-only live-search input, which is a
  // web-first assertion that auto-retries until the re-render lands.
  const mapToExisting = card.getByRole("radio", { name: "Map to existing" });
  await mapToExisting.click();
  // Functional proof the mode actually switched to MAP: the member live-search
  // only renders when the person is set to Map to existing. #2264 gave that
  // box a real accessible name, so it is selected by role rather than by its
  // placeholder — the name is distinct from the "Replacement member" box the
  // applications page renders, which shares the same placeholder text.
  //
  // The full name is person-scoped ("… to map to, for Ada Lovelace
  // (applicant)"). This locator passes no `exact`, and `getByRole` name
  // matching is substring and case-insensitive by default, so the shared
  // prefix below still matches. Do NOT add `exact: true` here without
  // spelling out the person suffix as well.
  const mappingSearch = card.getByRole("textbox", {
    name: "Search for an existing member to map to",
  });
  await expect(mappingSearch).toBeVisible();
  await mappingSearch.fill(MAPPING_APPLICANT.email);
  await card.getByRole("button", { name: "Search", exact: true }).click();
  await card.getByRole("button", { name: "Use" }).first().click();
  await expect(card.getByText(`Mapped to ${applicantName}`)).toBeVisible();

  // Preview: the diff table shows what the overwrite will change (the member
  // was seeded without a DOB or phone), and the promotion note appears.
  await card.getByRole("button", { name: "Preview mapping" }).click();
  await expect(
    card.getByText("Preview ready — no blocking issues."),
  ).toBeVisible();
  await expect(card.getByRole("cell", { name: "Date of birth" })).toBeVisible();
  await expect(
    card.getByRole("cell", { name: MAPPING_APPLICANT.dateOfBirth }),
  ).toBeVisible();
  await expect(
    card.getByText(/promoted to a login account/i),
  ).toBeVisible();

  // Joining fee defaults to SKIP for a mapped applicant.
  await expect(card.locator("select")).toHaveValue("SKIP");
  await expect(card.locator("textarea").last()).toHaveValue(
    "Mapped to existing member",
  );

  // Approve (the second check). The notify-choice dialog always shows; skip
  // the email so the run never depends on outbound mail.
  const putResponse = page.waitForResponse(
    (res) =>
      res.url().includes(`/api/admin/member-applications/${MAPPING_APPLICATION_ID}`) &&
      res.request().method() === "PUT",
  );
  await card.getByRole("button", { name: "Approve", exact: true }).click();
  await page
    .getByRole("button", { name: "Approve without emailing" })
    .click();
  const putBody = await (await putResponse).json();
  expect(putBody.status).toBe("APPROVED");
  expect(putBody.mappedMemberIds).toEqual([MAPPING_TARGET_MEMBER_ID]);
  expect(putBody.createdMemberIds).toEqual([]);
  await expect(page.getByText(/Application approved\./)).toBeVisible();

  // The existing member was updated in place — and there is still exactly ONE
  // member for this email (no duplicate record was created).
  await expectMappedInPlace(context.request);

  await context.close();
});
