import { type BrowserContext, expect, test } from "../helpers/accessibility";
import { loginPersona } from "../helpers/auth";
import {
  ROLE_PERSONAS,
  ROSTER_GUEST_LODGE_A,
  ROSTER_GUEST_LODGE_B,
  ROSTER_ISOLATION_WINDOW,
  SECOND_LODGE,
} from "../helpers/fixtures";

// Multi-lodge coverage (issue #1568), scenario (c): a kiosk bound to
// lodge B must serve only lodge B's roster and never lodge A's. Runs ONLY in
// the `multi-lodge` project against a two-lodge database (E2E_MULTI_LODGE=1).
// NOT a substitute for the manual staging matrix (docs/multi-lodge/test-plan.md).
//
// The demo LODGE (kiosk) persona is bound to lodge B by a STAFF MemberLodgeAccess
// grant in seed-second-lodge.ts. The seed also creates one PAID arrival at EACH
// lodge on the same night, so a leak would be unmistakable. The kiosk's data is
// driven through the same endpoints the kiosk page reads (/api/lodge/access and
// /api/lodge/guests) — the faithful server path, deterministic and free of the
// kiosk UI's week/day navigation.
test.describe.configure({ mode: "serial" });

type KioskAccess = { tier: string; lodgeName?: string | null; misconfigured?: boolean };
type LodgeGuests = { bookings: Array<{ guests: Array<{ firstName: string; lastName: string }> }> };

let kioskContext: BrowserContext;

test.beforeAll(async ({ browser }) => {
  // A fresh login incl. first-time two-factor enrollment needs more than the
  // default hook budget on a loaded CI runner.
  test.setTimeout(240_000);
  kioskContext = await browser.newContext();
  const page = await kioskContext.newPage();
  await loginPersona(page, ROLE_PERSONAS.LODGE.email);
  await page.close();
});

test.afterAll(async () => {
  await kioskContext?.close();
});

test("(c) a kiosk bound to lodge B sees lodge B's roster and never lodge A's", async () => {
  const date = ROSTER_ISOLATION_WINDOW.checkIn;

  // The kiosk session resolves to exactly one property — lodge B.
  const accessResponse = await kioskContext.request.get(`/api/lodge/access?date=${date}`);
  expect(accessResponse.ok(), "kiosk access must load").toBeTruthy();
  const access = (await accessResponse.json()) as KioskAccess;
  expect(access.misconfigured ?? false, "kiosk must be bound to exactly one lodge").toBe(false);
  expect(access.tier).toBe("lodge");
  expect(access.lodgeName).toBe(SECOND_LODGE.name);

  // The lodge list for that date shows lodge B's arriving guest, never lodge A's.
  // #2631: one operational-day scope, so no scope parameter.
  const guestsResponse = await kioskContext.request.get(
    `/api/lodge/guests/${date}`,
  );
  expect(guestsResponse.ok(), "kiosk guest list must load").toBeTruthy();
  const guests = (await guestsResponse.json()) as LodgeGuests;
  const names = guests.bookings.flatMap((booking) =>
    booking.guests.map((guest) => `${guest.firstName} ${guest.lastName}`),
  );

  expect(
    names,
    `lodge B kiosk roster for ${date}: ${JSON.stringify(names)}`,
  ).toContain(`${ROSTER_GUEST_LODGE_B.firstName} ${ROSTER_GUEST_LODGE_B.lastName}`);
  expect(names).not.toContain(
    `${ROSTER_GUEST_LODGE_A.firstName} ${ROSTER_GUEST_LODGE_A.lastName}`,
  );
});
