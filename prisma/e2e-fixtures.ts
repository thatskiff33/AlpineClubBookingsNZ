// Shared E2E fixture constants. Imported by BOTH the demo seed
// (prisma/demo-seed.ts) and the Playwright specs (via e2e/helpers/fixtures),
// so the
// deterministic data the seed writes and the data the specs assert on never
// drift apart. Keep this a pure constants module: no Playwright, no Prisma, no
// `server-only` imports.

const DEMO_DOMAIN = "demo.alpineclub.test";

const demoEmail = (local: string) => `${local}@${DEMO_DOMAIN}`;

// ---------------------------------------------------------------------------
// Relative date engine (issue #2117)
// ---------------------------------------------------------------------------
// Every date-based fixture below is computed as an OFFSET from "today" so
// seeded bookings, seasons, and the windows the specs assert on NEVER EXPIRE.
// A fixed calendar date silently rotted CI red the day wall-clock reached it:
// a seeded PAYMENT_PENDING booking dated 2026-07-20 crossed the NZ
// in-progress boundary at NZ midnight and modify-quote began refusing it, so
// double-bed-sharing S3 failed on every overnight-NZ run.
//
// "Today" is the New Zealand civil date (APP_TIME_ZONE = Pacific/Auckland) —
// the SAME clock the app's date-only booking-edit policy uses — so a seeded
// "future" booking reads as future to the app on every run date. This mirrors
// src/lib/date-only.ts (todayDateOnlyForTimeZone / addDaysDateOnly) but is
// re-implemented inline to keep this a dependency-free constants module: it is
// imported by the demo seed inside the Docker image build, where the `@/…`
// path alias and the e2e/ directory are unavailable.
const NZ_TIME_ZONE = "Pacific/Auckland";

// en-CA renders YYYY-MM-DD; formatting `new Date()` in the NZ zone yields the
// NZ civil date regardless of the CI runner's own clock/timezone.
function todayDateOnlyNz(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: NZ_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Pure YYYY-MM-DD ± whole days (UTC-anchored, so no DST edge can shift it).
//
// EXPORTED because `e2e/helpers/stay-dates.ts` needs the identical arithmetic to
// walk Mondays and past bands off `E2E_TODAY_NZ`. It used to hold its own copy
// built on a LOCAL-TIME `Date`, which is the CI runner's clock (UTC) rather than
// the club's — see the note on `E2E_TODAY_NZ` below.
export function shiftDateOnly(dateOnly: string, days: number): string {
  const dt = new Date(`${dateOnly}T00:00:00.000Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// Frozen at module load: one "today" per process. The demo seed and the
// Playwright specs run minutes apart in the same CI job, so they resolve the
// same NZ date; a run straddling NZ midnight would differ by a day, which the
// generous >=30-day future / <=-25-day past margins below absorb without
// changing any fixture's meaning (future stays future, past stays past).
//
// THIS IS THE E2E SUITE'S ONE CLOCK READ, the way `src/lib/club-time/clock.ts`
// is the application's (`INV-CONFIG-002`, `INV-DATE-019`: ask the CLUB's
// calendar for "today", never the host's). The Playwright process runs on the CI
// runner, whose zone is UTC, while the app container runs `TZ=Pacific/Auckland`
// (`docker-compose.yml`). So for the last ~12 hours of every UTC day the runner
// and the app disagree about what day it is — and on the last day of a month
// they disagree about the MONTH. `e2e/admin-retroactive-booking.spec.ts` told
// the booking calendar it was already showing August while the app had opened on
// September, and failed on `main` at 2026-08-31T14:30Z having passed on the same
// commit that morning. Every civil date a spec derives goes through
// `relDateOnly` (or `E2E_TODAY_NZ` itself); `e2e-club-day-census.test.ts` is
// the guard that keeps a hand-rolled `new Date()` from coming back.
export const E2E_TODAY_NZ = todayDateOnlyNz();

// A date `offsetDays` from today (negative = past), as YYYY-MM-DD.
export function relDateOnly(offsetDays: number): string {
  return shiftDateOnly(E2E_TODAY_NZ, offsetDays);
}

// A stay window `nights` nights long starting `offsetDays` from today.
function relWindow(
  offsetDays: number,
  nights: number,
): { checkIn: string; checkOut: string; nights: string[] } {
  const checkIn = relDateOnly(offsetDays);
  const nightList = Array.from({ length: nights }, (_, i) =>
    shiftDateOnly(checkIn, i),
  );
  return {
    checkIn,
    checkOut: shiftDateOnly(checkIn, nights),
    nights: nightList,
  };
}

// The Monday on or after `minOffsetDays` from today, as a 2-night Mon–Wed
// window. The capacity-filling / reserved fixtures (IB, waitlist) MUST stay
// Monday-aligned: e2e/helpers/stay-dates.ts reserves their check-in Mondays so
// the weekly-drifting stayWindow() booking windows never collide with them.
function relMondayWindow(minOffsetDays: number): {
  checkIn: string;
  checkOut: string;
  nights: string[];
} {
  const seed = relDateOnly(minOffsetDays);
  // getUTCDay(): Sunday=0 … Monday=1. Advance to the next Monday (0 hops if
  // already Monday).
  const dow = new Date(`${seed}T00:00:00.000Z`).getUTCDay();
  const checkIn = shiftDateOnly(seed, (8 - dow) % 7);
  return {
    checkIn,
    checkOut: shiftDateOnly(checkIn, 2),
    nights: [checkIn, shiftDateOnly(checkIn, 1)],
  };
}

// ---------------------------------------------------------------------------
// Seeded booking seasons (issue #2117) — relative so they always bracket the
// fixtures and the specs' booking horizon. ONE definition, consumed by BOTH
// e2e/setup/relativize-seasons.ts (which re-dates the base seed's Season rows on
// the E2E database) and e2e/helpers/stay-dates.ts (which classifies a window's
// winter/summer rate column), so the DB seasons and the specs' season math can
// never drift. The production first-run seed (prisma/seed.ts) keeps its fixed
// real-world season dates — only the demo/E2E DB is relativized. Winter is a
// broad band covering every past+future fixture and the stayWindow() /
// deriveHoldingWindows() horizon; a ~30-day gap then Summer preserves the
// two-season structure that e2e/book-on-behalf-nonmember.spec.ts asserts
// winter-vs-summer rates against. ISO YYYY-MM-DD sorts lexicographically, so
// plain string comparison is a correct date compare.
export const SEEDED_SEASONS = [
  { key: "winter", start: relDateOnly(-90), end: relDateOnly(239) },
  { key: "summer", start: relDateOnly(270), end: relDateOnly(599) },
] as const;

// ---------------------------------------------------------------------------
// Demo-seed single-lodge booking windows (issue #2117). Every seeded booking's
// nights are relative so none ever crosses the NZ in-progress/past boundary.
// PAST-tense bookings (COMPLETED, settled, expired DRAFT) sit >=25 days back —
// deliberately DEEPER than the -7..-15 past window
// e2e/admin-retroactive-booking.spec.ts sweeps, so that spec never collides.
// FUTURE-tense bookings sit >=30 days out so no edit policy reads them as
// in-progress. Windows a spec reads by owner/date (Carol, Heidi, Ken, Alice's
// draft) are named so the spec imports the SAME window the seed wrote.
export const DEMO_BOOKING_WINDOWS = {
  aliceDraft: relWindow(-25, 2), // DRAFT, expiry already passed
  bobPending: relWindow(30, 2), // PENDING
  carolPaymentPending: relWindow(35, 3), // PAYMENT_PENDING (double-bed-sharing S1/S3)
  daveConfirmed: relWindow(-40, 3), // CONFIRMED (+ allocations, chores, modification, hut-leader)
  erinPaid: relWindow(-34, 3), // PAID
  frankBumped: relWindow(-31, 2), // BUMPED
  graceCancelled: relWindow(-28, 3), // CANCELLED
  heidiCompleted: relWindow(-45, 3), // COMPLETED (double-bed-sharing S3)
  waitlist: relWindow(40, 2), // WAITLISTED + WAITLIST_OFFERED (shared window)
  kenReview: relWindow(45, 2), // AWAITING_REVIEW (bed-allocation.spec)
  larsFailed: relWindow(33, 2), // PENDING (failed payment)
  mallorySplit: relWindow(-37, 2), // CONFIRMED split parent/child
  rosterEdit: relWindow(150, 1), // two PAID bookings for staged roster editing (#2586)
  // #2622: one PAID booking arriving the morning the rosterEdit stay leaves, so
  // day 151 is a MIXED TURNOVER day (five departing + two arriving) and day 152
  // is an ALL-DEPARTING day. Both are chore-roster days under the operational
  // rule and neither existed before; keep them adjacent to rosterEdit so the
  // three roster fixtures stay in one isolated future block.
  rosterTurnover: relWindow(151, 1),
} as const;

// --- Role-boundary personas (e2e/admin-roles.spec.ts) --------------------
// Each holds exactly one bundled access role (plus the baseline USER) so the
// admin-permission matrix (src/lib/admin-permissions.ts) governs which areas
// render. Seeded by prisma/demo-seed.ts via ensureMemberAccessRoles.
export const ROLE_PERSONAS = {
  ADMIN_READONLY: {
    email: demoEmail("readonly-admin"),
    firstName: "Reed",
    lastName: "Readonly",
  },
  ADMIN_BOOKINGS: {
    email: demoEmail("booking-officer"),
    firstName: "Bianca",
    lastName: "Bookings",
  },
  ADMIN_MEMBERSHIP: {
    email: demoEmail("membership-officer"),
    firstName: "Morgan",
    lastName: "Membership",
  },
  ADMIN_CONTENT: {
    email: demoEmail("content-manager"),
    firstName: "Cleo",
    lastName: "Content",
  },
  FINANCE_USER: {
    email: demoEmail("finance-viewer"),
    firstName: "Fenn",
    lastName: "Finance",
  },
  FINANCE_ADMIN: {
    email: demoEmail("treasurer"),
    firstName: "Tina",
    lastName: "Treasurer",
  },
  LODGE: {
    email: demoEmail("lodge-user"),
    firstName: "Logan",
    lastName: "Lodge",
  },
} as const;

// A full ADMIN with a known password (the base seed admin forces a password
// change and uses an unknown password, so it cannot drive E2E logins). Used to
// approve membership applications and toggle modules from within specs.
export const E2E_ADMIN = {
  email: demoEmail("e2e-admin"),
  firstName: "E2E",
  lastName: "Admin",
} as const;

// Dual-hat committee member: USER + ADMIN access-role tokens, complete
// confirmed profile, PAID subscription. Books their own stay through the
// member /book wizard under full member rules — the wizard must NOT redirect
// them to /admin/book (e2e/dual-hat-booking.spec.ts, issue #1442).
export const DUAL_HAT_ADMIN = {
  email: demoEmail("dana-dualhat"),
  firstName: "Dana",
  lastName: "Dualhat",
} as const;

// The subscription-locked member (#2779). Seeded exactly like WAITLISTER — a
// COMPLETE, self-confirmed profile so no onboarding modal blocks their pages —
// except that their current-season subscription is UNPAID, so the club's
// default HARD_BLOCK lockout refuses them their own bookings.
//
// They also carry a `xeroContactId`. Without one, the create route refuses a
// self-booking with XERO_CONTACT_REQUIRED *before* it ever reaches the
// subscription gate, and the spec's control assertion ("this member really is
// locked out, for the subscription reason") would be testing the wrong refusal.
//
// Nobody else logs in as them or asserts on their bookings, so
// e2e/locked-out-pickup-and-pay.spec.ts can turn the club's lockout mode and
// the Xero module on for its own run without perturbing the serial suite.
export const LOCKED_OUT_MEMBER = {
  email: demoEmail("lyle-lockedout"),
  firstName: "Lyle",
  lastName: "Lockedout",
} as const;

// Second paid-up, nomination-eligible member (alice is the first). Needed so
// the public membership-application POST has two valid nominators.
export const NOMINATOR_TWO = {
  email: demoEmail("nadia"),
  firstName: "Nadia",
  lastName: "Nominator",
} as const;

// Un-enrolled member the email-code two-factor spec drives forced enrollment on
// (e2e/two-factor-email.spec.ts). Distinct from the TOTP enrollee (bob) so the
// two 2FA specs never collide. Seeded with no two-factor state, so global
// enforcement forces enrollment and the spec picks the EMAIL method. Outbound
// mail is captured by the staging mailpit container, and the spec reads the
// emailed code back over its HTTP API.
export const EMAIL_2FA_ENROLLEE = {
  email: demoEmail("evan"),
  firstName: "Evan",
  lastName: "Email",
} as const;

// Owner of the capacity-filling booking for the waitlist spec (non-login).
export const LODGE_FILL_OWNER = {
  email: demoEmail("lodge-fill"),
  firstName: "Fully",
  lastName: "Booked",
} as const;

// Complete-profile driver for the member-facing page journeys. Unlike alice
// (deliberately left unconfirmed so booking.spec exercises the member-details
// gate, #1124), this persona is seeded PAID with a COMPLETE, self-confirmed
// profile, so the onboarding "Confirm member details" modal never blocks its
// pages and the booking API accepts its bookings without the profile gate. It
// owns the waitlist + Internet Banking bookings and is the first nominator.
export const WAITLISTER = {
  email: demoEmail("wanda-waitlist"),
  firstName: "Wanda",
  lastName: "Waitlist",
} as const;

// --- Waitlist fixtures (e2e/waitlist.spec.ts) ----------------------------
// Monday–Wednesday windows ~9–11 weeks out (issue #2117: relative so they never
// expire), in the winter season, that no other spec touches. Monday-aligned so
// stayWindow() reserves and dodges their check-ins (RESERVED_WINDOW_CHECKINS in
// e2e/helpers/stay-dates.ts). Consecutive Mondays keep them mutually disjoint.
export const WAITLIST_FULL_WINDOW = relMondayWindow(63);
// Guests on the fill booking. Lodge capacity is 20 (config/club.example.json);
// 22 guarantees zero availability even against a modest capacity override.
export const WAITLIST_FILL_GUEST_COUNT = 22;

// A ready-to-accept offer owned by alice on an empty window (capacity is free,
// so accepting confirms). Future expiry so it is not auto-reverted.
export const WAITLIST_OFFER_BOOKING_ID = "e2e-waitlist-offer";
export const WAITLIST_OFFER_WINDOW = relMondayWindow(70);

// --- Internet Banking fixture (e2e/internet-banking.spec.ts) -------------
// A card (Stripe) PAYMENT_PENDING booking owned by alice, far enough out to
// clear the internet-banking lead-time cutoff, so the spec can switch it to
// Internet Banking without needing Stripe. Monday-aligned + reserved, one
// Monday ahead of the waitlist windows (issue #2117: relative so it never
// expires).
export const IB_BOOKING_ID = "e2e-ib-pending";
export const IB_WINDOW = relMondayWindow(56);

// --- Cancellation-with-refund fixture (e2e/booking-cancel-refund.spec.ts) --
// A future-dated PAID booking owned by Nadia (NOMINATOR_TWO) on a December
// (Summer 2026-27 season) window that no other seeded booking or spec touches,
// so the cancel spec can cancel it for a positive account-credit refund. The
// seeded payment is a single SUCCEEDED Stripe charge with NO additional- or
// setup-intent fields, so the credit-method cancel writes the account credit
// with zero external (Stripe) calls (src/lib/booking-cancel.ts credit branch).
// Nadia — not Wanda (heavily used by waitlist/IB) or Alice (kept unconfirmed
// for booking.spec's #1124 gate) — owns it: no other spec asserts Nadia's
// bookings or account credit (she only drives a nomination in
// membership-application.spec), so crediting her account cannot perturb the
// serial suite.
// Deep in the Summer season (issue #2117: relative so it never expires), well
// past every winter fixture and the stayWindow() horizon, so no other spec or
// seeded booking touches its window.
export const PAID_CANCEL_BOOKING_ID = "e2e-paid-cancel";
export const PAID_CANCEL_WINDOW = relWindow(300, 2);

// --- Outstanding additional payment fixture (#2350) ----------------------
// A future-dated PAID booking owned by Nadia whose price was pushed up after it
// was paid, leaving an uncollected additional payment — the exact state
// e2e/additional-payment-chase.spec.ts exercises. Seeded directly rather than
// produced by an admin edit, because raising a real one mints a Stripe
// PaymentIntent and the additional-payment specs must run whether or not
// Stripe test keys are configured.
//
// Deeper into the Summer season than PAID_CANCEL_WINDOW so the two never
// overlap (a member-night conflict would block neither, but keeping seeded
// windows disjoint is the house rule), and far past every other fixture, so no
// other spec sees this booking. It is the ONLY seeded booking with an
// uncollected addition — the demo PAID booking's addition is SUCCEEDED — so the
// admin list filtered to "still owing" shows exactly this one row.
//
// The addition is raised at seed time, i.e. today, so it is younger than the
// three-day reminder threshold: the reminder cron cannot email about it during
// a run and steal the cooldown the spec's manual re-send depends on.
export const ADDITIONAL_OWED_BOOKING_ID = "e2e-additional-owed";
export const ADDITIONAL_OWED_WINDOW = relWindow(320, 2);
export const ADDITIONAL_OWED_AMOUNT_CENTS = 21_000;

// --- Membership application fixture (e2e/membership-application.spec.ts) --
// A PENDING_NOMINATORS application whose two nomination tokens have KNOWN raw
// values (their SHA-256 is stored, matching src/lib/action-tokens.ts), so the
// spec can drive /nominations/<token> without needing the (unconfigured) email
// that would normally carry the link. Raw tokens must match the app's action
// token format: /^[a-f0-9]{64}$/.
export const MEMBERSHIP_APPLICATION_ID = "e2e-membership-app";
export const MEMBERSHIP_APPLICANT = {
  email: demoEmail("nova.newmember"),
  firstName: "Nova",
  lastName: "Newmember",
  dateOfBirth: "1992-04-18",
};
export const NOMINATION_TOKEN_ONE = "a1".repeat(32); // nominator = alice
export const NOMINATION_TOKEN_TWO = "b2".repeat(32); // nominator = Nadia

// Applicant used by the light public-submit assertion (distinct email so it
// never collides with the seeded application or an existing login).
export const PUBLIC_APPLICANT_EMAIL = demoEmail("penny.public");

// --- Application-approval mapping fixture (E10, #1936) ---------------------
// A second application seeded directly in PENDING_ADMIN whose applicant
// matches an existing NON-LOGIN member with the same email (a lapsed-rejoiner
// shape). The spec drives the map-to-existing flow in the admin UI: the
// exact-email suggestion, the field-diff preview (the member is seeded with
// no DOB/phone so the diff has changed rows), the joining-fee SKIP default,
// and the approve that maps + promotes instead of creating a duplicate.
// Non-login target → no live privileged roles, so the #1026 mapping email
// gate never fires for this fixture.
export const MAPPING_APPLICATION_ID = "e2e-mapping-app";
export const MAPPING_TARGET_MEMBER_ID = "e2e-mapping-target";
export const MAPPING_APPLICANT = {
  email: demoEmail("rex.rejoiner"),
  firstName: "Rex",
  lastName: "Rejoiner",
  dateOfBirth: "1988-09-12",
} as const;

// --- Multi-lodge fixtures (e2e/multi-lodge/*, gated on E2E_MULTI_LODGE) ----
// A SECOND active lodge ("lodge B") plus the rooms, season, kiosk binding, and
// bookings the multi-lodge Playwright project asserts on. Seeded ONLY
// by e2e/setup/seed-second-lodge.ts when E2E_MULTI_LODGE=1, run AFTER the base
// seed (so lodge A's seasons exist to mirror). The default single-lodge suite
// never runs that script, so it never sees a second lodge and its behaviour is
// byte-identical. Windows sit in Winter 2026 (base seed: 2026-06-01..09-30) in
// August, where lodge A has no seeded booking, so per-lodge availability
// assertions read a clean lodge A.
export const SECOND_LODGE = {
  id: "e2e-lodge-b",
  name: "Second Lodge (E2E)",
  slug: "second-lodge-e2e",
} as const;

// Lodge B's active bed count. Deliberately different from lodge A's config
// total so a cross-lodge capacity-summation bug would be obvious, and small so
// the capacity-isolation window's numbers are easy to assert.
export const SECOND_LODGE_BED_COUNT = 8;

// Roster-isolation fixture (scenario c): one CONFIRMED arrival at EACH lodge on
// the same night. A kiosk bound to lodge B must see lodge B's guest and never
// lodge A's. Distinct guest names so the assertion is unambiguous.
export const ROSTER_ISOLATION_WINDOW = relWindow(90, 2);
export const ROSTER_GUEST_LODGE_A = {
  firstName: "Alpharoster",
  lastName: "Lodgea",
} as const;
export const ROSTER_GUEST_LODGE_B = {
  firstName: "Bravoroster",
  lastName: "Lodgeb",
} as const;

// Capacity-isolation fixture (scenario b): a PAID (capacity-holding, #737)
// booking at lodge B. Lodge B's availability drops by its guest count on these
// nights while lodge A stays at zero occupancy for the same window — proving no
// cross-lodge summation.
export const CAPACITY_ISOLATION_WINDOW = relWindow(97, 2);
export const CAPACITY_ISOLATION_GUEST_COUNT = 3;

// Cross-lodge waitlist offer (scenario d, ADR-004): Wanda (WAITLISTER) holds a
// WAITLIST_OFFERED entry that stays at lodge A, but whose active offer is for
// lodge B. Lodge B has capacity on the window, so accepting create-and-cancels
// into a fresh lodge-B booking. The offered price is computed at seed time from
// lodge B's own rates (quoteWaitlistEntryAtLodge) so the confirm-time re-quote
// matches and never trips OFFER_PRICE_CHANGED.
export const CROSS_LODGE_OFFER_BOOKING_ID = "e2e-cross-lodge-offer";
export const CROSS_LODGE_OFFER_WINDOW = relWindow(104, 2);

// #1628/#1609 regression (scenario e): the same cross-lodge offer shape but
// with the guest row member-linked (Wanda herself). The Phase-2 member-night
// guard now excludes the entry being replaced, so this confirm must succeed
// exactly like (d). The window must be disjoint from EVERY booking that lists
// Wanda as a member-linked guest — the guard is cross-lodge and per-member by
// design. (A past tripwire collided with Wanda's IB_WINDOW booking, double-
// blocking the expected-fail spec.) Issue #2117: relative, ~16 weeks out, well
// clear of the reserved IB/waitlist Mondays (~8–10 weeks) and inside the winter
// season, so it stays disjoint from every other fixture on any run date.
export const CROSS_LODGE_OFFER_MEMBER_GUEST_BOOKING_ID =
  "e2e-cross-lodge-offer-member-guest";
export const CROSS_LODGE_OFFER_MEMBER_GUEST_WINDOW = relWindow(111, 2);
