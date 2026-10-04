import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  test,
} from "@playwright/test";
import { loginPersona, storageStatePath } from "./helpers/auth";
import {
  completeMemberDetailsGateIfShown,
  selectCalendarDay,
} from "./helpers/booking";
import { E2E_ADMIN } from "./helpers/fixtures";
import { overrideModules, type ModuleSettings } from "./helpers/modules";
import { personas } from "./helpers/personas";
import { stayWindow } from "./helpers/stay-dates";

/*
  #3492 (epic #3813 C4) — a guest member's assigned promo code offered to the
  booker as an opt-in chip, end to end.

  MECHANICS:
    - Alice (the booker persona) and Pat Powell share the seeded Powell family
      group, so Pat is a FAMILY guest: the one kind of guest whose codes the
      lookup offers before the booking exists.
    - Pat has their own login, so the wizard will only add them once they have
      confirmed their details. The setup signs Pat in once and clears the
      details gate; no other spec uses Pat.
    - The admin assigns a FREE_NIGHTS code to Pat and turns on `promoCodes` and
      `multiPromoCodes`; both module switches are restored afterwards.
    - NO BOOKING IS CREATED. The walk stops at the review step, so the spec
      claims no capacity and leaves no member-night behind for a retry to trip
      over; window 15 is used by no other spec.
*/

test.describe.configure({ mode: "serial" });

const GUEST_CODE = "E2EGUESTNIGHTS";
const PAT = { email: "pat@demo.alpineclub.test", firstName: "Pat", lastName: "Powell" };
const REVIEW_WINDOW = stayWindow(15);

let adminContext: BrowserContext;
let adminRequest: APIRequestContext;
let aliceContext: BrowserContext;
let aliceRequest: APIRequestContext;
let previousModules: ModuleSettings | null = null;
let patMemberId = "";
let lodgeId = "";

test.beforeAll(async ({ browser }) => {
  adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await loginPersona(adminPage, E2E_ADMIN.email);
  adminRequest = adminPage.request;
  previousModules = await overrideModules(adminRequest, {
    promoCodes: true,
    multiPromoCodes: true,
  });

  const patContext = await browser.newContext();
  const patPage = await patContext.newPage();
  await loginPersona(patPage, PAT.email);
  await patPage.goto("/book");
  // Pat is seeded without a phone number or region, which the shared details-gate
  // helper does not fill (its usual personas have them). Fill them first if asked.
  const patDialog = patPage.getByRole("dialog");
  const countryCode = patDialog.getByLabel("Country code", { exact: true });
  if (await countryCode.isVisible({ timeout: 5_000 }).catch(() => false)) {
    if ((await countryCode.inputValue()) === "") await countryCode.fill("64");
    const area = patDialog.getByLabel("Area code", { exact: true });
    if ((await area.inputValue()) === "") await area.fill("27");
    const number = patDialog.getByLabel("Phone number", { exact: true });
    if ((await number.inputValue()) === "") await number.fill("1234567");
    const region = patDialog.getByLabel("Region", { exact: true }).first();
    if ((await region.inputValue()) === "") await region.fill("Waikato");
  }
  await completeMemberDetailsGateIfShown(patPage);
  await patContext.close();

  aliceContext = await browser.newContext({
    storageState: storageStatePath(personas.booker.email),
  });
  aliceRequest = aliceContext.request;

  const family = await aliceRequest.get("/api/members/family");
  expect(family.ok(), `GET /api/members/family (${family.status()})`).toBeTruthy();
  const familyBody = (await family.json()) as {
    familyMembers: Array<{ id: string; firstName: string; lastName: string }>;
  };
  patMemberId =
    familyBody.familyMembers.find(
      (member) => member.firstName === PAT.firstName && member.lastName === PAT.lastName,
    )?.id ?? "";
  expect(patMemberId, "Pat Powell is in Alice's seeded family group").not.toBe("");

  const lodges = await aliceRequest.get("/api/lodges");
  expect(lodges.ok()).toBeTruthy();
  lodgeId = ((await lodges.json()) as { lodges: Array<{ id: string }> }).lodges[0]!.id;

  const created = await adminRequest.post("/api/admin/promo-codes", {
    data: {
      code: GUEST_CODE,
      description: "Pat's committee nights (private note)",
      type: "FREE_NIGHTS",
      freeNightsPerIndividual: 2,
      assignedMemberIds: [patMemberId],
    },
  });
  // A retry against the same database finds the code already there.
  expect(
    created.ok() || created.status() === 409 || created.status() === 400,
    `POST /api/admin/promo-codes (${created.status()})`,
  ).toBeTruthy();
});

test.afterAll(async () => {
  if (previousModules) await overrideModules(adminRequest, previousModules);
  await aliceContext?.close();
  await adminContext?.close();
});

test("the lookup offers a family guest's code by position, with only code and benefit", async () => {
  const res = await aliceRequest.post("/api/promo-codes/guest-codes", {
    data: { lodgeId, guestMemberIds: [patMemberId, "e2e-no-such-member"] },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body).toEqual({
    multiPromoCodes: true,
    guests: [{ guestRef: "0", codes: [{ code: GUEST_CODE, benefit: "2 free nights per booking" }] }],
  });
  // Never the member id, never the officer's private description.
  expect(JSON.stringify(body)).not.toContain(patMemberId);
  expect(JSON.stringify(body)).not.toContain("private note");
});

test("a member cannot ask on another member's behalf", async () => {
  const res = await aliceRequest.post("/api/promo-codes/guest-codes", {
    data: { lodgeId, guestMemberIds: [patMemberId], forMemberId: patMemberId },
  });
  expect(res.status()).toBe(403);
});

test("the review step offers the guest's code as an opt-in chip that covers that guest only", async () => {
  const page = await aliceContext.newPage();
  await page.goto("/book");
  await completeMemberDetailsGateIfShown(page);
  await expect(page.getByText("Select Your Dates")).toBeVisible();
  await selectCalendarDay(page, REVIEW_WINDOW.checkIn);
  await selectCalendarDay(page, REVIEW_WINDOW.checkOut);

  await expect(
    page.getByRole("button", {
      name: `✓ ${personas.booker.firstName} ${personas.booker.lastName} (You)`,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: new RegExp(`^\\+ ${PAT.firstName} ${PAT.lastName}`) }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("Booking Summary")).toBeVisible();

  // Opt-in: offered under Pat's name, nothing applied yet.
  const chips = page.getByRole("group", { name: `${PAT.firstName} ${PAT.lastName}'s promo codes` });
  const chip = chips.getByRole("button", {
    name: new RegExp(`^Apply ${GUEST_CODE} .*applies to ${PAT.firstName} ${PAT.lastName} only$`),
  });
  await expect(chip).toBeVisible();
  await expect(page.getByRole("list", { name: /in the order they apply/ })).toHaveCount(0);

  // Keyboard: focus the chip and press Enter.
  await chip.focus();
  await page.keyboard.press("Enter");

  const applied = page.getByRole("list", { name: /in the order they apply/ });
  await expect(applied).toContainText(GUEST_CODE);
  await expect(applied).toContainText(`applies to ${PAT.firstName} ${PAT.lastName} only`);
  await expect(page.getByRole("status").filter({ hasText: `${GUEST_CODE} applied.` })).toHaveCount(1);
  await expect(page.getByText(`Promo adjustment (${GUEST_CODE})`)).toBeVisible();
  await page.close();
});
