// Demo-seed personas (prisma/demo-seed.ts). Passwords come from the seed's
// DEMO_SEED_PASSWORD default; override E2E_DEMO_PASSWORD if the seed was run
// with a custom one.
import { EMAIL_2FA_ENROLLEE, PASSKEY_ENROLLEE } from "./fixtures";

export const DEMO_PASSWORD = process.env.E2E_DEMO_PASSWORD ?? "demo1234";

export type Persona = {
  email: string;
  firstName: string;
  lastName: string;
};

export const personas = {
  // Alice has a PAID subscription, so she can book at member rates. The
  // booking and Stripe payment specs all book as Alice on disjoint stay
  // windows (see stay-dates.ts).
  booker: {
    email: "alice@demo.alpineclub.test",
    firstName: "Alice",
    lastName: "Anderson",
  },
  // Bob starts un-enrolled in two-factor auth on a fresh demo seed, so the
  // two-factor spec can drive real enrollment. His UNPAID subscription does
  // not matter for login.
  enrollee: {
    email: "bob@demo.alpineclub.test",
    firstName: "Bob",
    lastName: "Brown",
  },
  // Evan is a second un-enrolled member (distinct from Bob) so the email-code
  // two-factor spec drives its own forced enrollment without colliding with the
  // TOTP spec. Defined in prisma/e2e-fixtures.ts so the seed and this spec never
  // drift.
  emailEnrollee: {
    email: EMAIL_2FA_ENROLLEE.email,
    firstName: EMAIL_2FA_ENROLLEE.firstName,
    lastName: EMAIL_2FA_ENROLLEE.lastName,
  },
  // Pip is a third never-enrolled member, finance VIEWER like Bob, for the
  // passkey spec (#5160). Bob must stay unused by any other sign-in: the TOTP
  // spec asserts he has never enrolled, whatever order the specs run in.
  passkeyEnrollee: {
    email: PASSKEY_ENROLLEE.email,
    firstName: PASSKEY_ENROLLEE.firstName,
    lastName: PASSKEY_ENROLLEE.lastName,
  },
} satisfies Record<string, Persona>;
