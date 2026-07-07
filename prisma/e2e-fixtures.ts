// Shared E2E fixture constants. Imported by BOTH the demo seed
// (prisma/demo-seed.ts) and the Playwright specs (via e2e/helpers/fixtures),
// so the
// deterministic data the seed writes and the data the specs assert on never
// drift apart. Keep this a pure constants module: no Playwright, no Prisma, no
// `server-only` imports.

const DEMO_DOMAIN = "demo.alpineclub.test";

const demoEmail = (local: string) => `${local}@${DEMO_DOMAIN}`;

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
// September 2026 (winter season) windows that no other spec touches. The
// booking/stripe specs book Mon–Wed windows only ~3–5 weeks out (late Jul/Aug).
export const WAITLIST_FULL_WINDOW = {
  checkIn: "2026-09-14",
  checkOut: "2026-09-16",
  nights: ["2026-09-14", "2026-09-15"],
};
// Guests on the fill booking. Lodge capacity is 20 (config/club.example.json);
// 22 guarantees zero availability even against a modest capacity override.
export const WAITLIST_FILL_GUEST_COUNT = 22;

// A ready-to-accept offer owned by alice on an empty window (capacity is free,
// so accepting confirms). Future expiry so it is not auto-reverted.
export const WAITLIST_OFFER_BOOKING_ID = "e2e-waitlist-offer";
export const WAITLIST_OFFER_WINDOW = {
  checkIn: "2026-09-21",
  checkOut: "2026-09-23",
  nights: ["2026-09-21", "2026-09-22"],
};

// --- Internet Banking fixture (e2e/internet-banking.spec.ts) -------------
// A card (Stripe) PAYMENT_PENDING booking owned by alice, far enough out to
// clear the internet-banking lead-time cutoff, so the spec can switch it to
// Internet Banking without needing Stripe.
export const IB_BOOKING_ID = "e2e-ib-pending";
export const IB_WINDOW = {
  checkIn: "2026-09-07",
  checkOut: "2026-09-09",
  nights: ["2026-09-07", "2026-09-08"],
};

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
export const PAID_CANCEL_BOOKING_ID = "e2e-paid-cancel";
export const PAID_CANCEL_WINDOW = {
  checkIn: "2026-12-15",
  checkOut: "2026-12-17",
  nights: ["2026-12-15", "2026-12-16"],
};

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

// --- Two-lodge fixtures (e2e/two-lodge/*, #1568) -------------------------
// These drive the ADVISORY two-lodge Playwright project only. They require the
// second demo lodge (DEMO_SECOND_LODGE=1 → West Ridge Hut + rooms + beds) PLUS
// the dedicated two-lodge e2e seed step (e2e/setup/seed-two-lodge.ts, which adds
// West Ridge seasons/rates, the West-Ridge kiosk grant, the per-lodge isolation
// bookings and the cross-lodge waitlist offers) and the multiLodge module ON.
// They are never seeded or asserted by the default single-lodge blocking suite.
export const WEST_RIDGE_SLUG = "west-ridge-hut";
export const WEST_RIDGE_NAME = "West Ridge Hut";

// A LODGE (kiosk) account bound to West Ridge via a single STAFF
// MemberLodgeAccess grant, so resolveKioskLodgeId scopes its roster/guest
// lookups to West Ridge only (scenario 3c). Loginable with the demo password.
export const WEST_RIDGE_KIOSK = {
  email: demoEmail("westridge-kiosk"),
  firstName: "Winnie",
  lastName: "Westkiosk",
} as const;

// Per-lodge isolation: one PAID (capacity-holding, operational) booking at the
// DEFAULT lodge and one at West Ridge on the SAME single night, each with a
// distinct guest count and a distinct guest name. Proves capacity and roster
// are per-lodge (scenarios 3a/3b/3c). A late-September (Winter 2026) night no
// other seeded booking touches. Owners are seeded as non-login members.
export const TWO_LODGE_ISOLATION_WINDOW = {
  checkIn: "2026-09-28",
  checkOut: "2026-09-29",
  nights: ["2026-09-28"],
};
export const LODGE_A_ISOLATION_GUEST_COUNT = 3;
export const WEST_RIDGE_ISOLATION_GUEST_COUNT = 2;
export const LODGE_A_ISOLATION_GUEST = {
  firstName: "Ana",
  lastName: "Alpha",
} as const;
export const WEST_RIDGE_ISOLATION_GUEST = {
  firstName: "Wade",
  lastName: "Westguest",
} as const;

// Cross-lodge waitlist offers (ADR-004): WAITLIST_OFFERED entries whose home
// lodge is the DEFAULT lodge, offered to West Ridge (waitlistOfferedLodgeId).
// The stored offer price is deliberately stale so the FIRST confirm always
// returns OFFER_PRICE_CHANGED and refreshes it to the pricing engine's figure;
// the spec primes it once before asserting, so it never hardcodes a West Ridge
// rate. Both are owned by Wanda (WAITLISTER: complete profile, PAID) on
// disjoint August (Winter 2026) windows West Ridge is otherwise empty for.
export const CROSS_LODGE_STALE_OFFER_PRICE_CENTS = 1;

// (3d) A composition that can pass today: the offer's only guest is a
// NON-member (no memberId), so the Phase-2 member-night guard has no member to
// conflict on and the cross-lodge confirm succeeds (#1609 does not bite).
export const CROSS_LODGE_OFFER_NONMEMBER_ID = "e2e-xlodge-offer-nonmember";
export const CROSS_LODGE_OFFER_NONMEMBER_GUEST = {
  firstName: "Gus",
  lastName: "Guestonly",
} as const;
export const CROSS_LODGE_OFFER_NONMEMBER_WINDOW = {
  checkIn: "2026-08-24",
  checkOut: "2026-08-26",
  nights: ["2026-08-24", "2026-08-25"],
};

// (3e) The #1609 scenario: a member self-booked entry (Wanda is her own guest,
// carrying her memberId). The Phase-2 member-night guard trips on this entry's
// own WAITLIST_OFFERED booking (createConfirmedBooking passes it no
// excludeBookingId), so the confirm is expected to FAIL today — encoded as a
// Playwright expected-fail. An unexpected pass disproves #1609.
export const CROSS_LODGE_OFFER_MEMBER_ID = "e2e-xlodge-offer-member";
export const CROSS_LODGE_OFFER_MEMBER_WINDOW = {
  checkIn: "2026-08-27",
  checkOut: "2026-08-29",
  nights: ["2026-08-27", "2026-08-28"],
};
