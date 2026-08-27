/**
 * The emailed payment-link deadline, on the BODY-OVERRIDE branch (CT-4, #2870;
 * `INV-CONFIG-002`).
 *
 * ## The branch nothing covered
 *
 * A payment-link email carries its deadline twice over. The shipped HTML body
 * renders `expiresAt` through `emailClubDateTime` — the club's PERSISTED zone
 * (CT-5, #2869). The sending function ALSO puts the same value into
 * `templateData`, and that copy went through `formatNZDateTime` — the retired
 * `@/lib/nzst-date` adapter, whose zone was
 * `unvalidatedLegacyClubTimeZone(APP_TIME_ZONE)`, the CONTAINER's. #3123 deleted
 * that adapter; `ENVIRONMENT_SAYS` below spells its rendering out so this suite
 * can still name the wrong answer it refuses.
 *
 * Two renderings of one instant in two zones is only a latent defect while
 * nothing reads the second one. Something does: when a club has saved a body
 * override, `prepareEmailMessage` throws the built-in HTML away and rebuilds the
 * whole message from `templateData` (`email-message-renderer.ts`). The shipped
 * default body for BOTH payment-link templates already contains `{{expiresAt}}`
 * — so a club that opened the wording, changed a sentence and saved got its
 * payment deadline spelled in the host's zone, while an unedited club got the
 * club's. On a divergent deployment those name different times of day, and where
 * the club is behind the environment a different DAY.
 *
 * ## Why the suite is shaped this way
 *
 * The assertion that matters is an AGREEMENT, not two independent renderings:
 * the defect class is divergence, and two assertions each pinning one surface
 * can both pass while the pair disagrees. So every case here compares the
 * override-rendered body against `formatLinkExpiry` — the pay page's OWN
 * exported formatter, imported rather than reimplemented — for the same instant.
 *
 * The club's zone comes from `divergentClubZone`, which returns one whose answer
 * is proven to differ from both `APP_TIME_ZONE`'s and the host's. A literal
 * cannot promise that: `APP_TIME_ZONE` with no `TZ` IS `Pacific/Auckland`, so a
 * suite persisting Auckland cannot tell the persisted zone from the environment
 * however much it asserts. A premise failure here is a FAILURE, never a skip
 * (owner decision, #2870).
 *
 * The override this suite saves is the SHIPPED DEFAULT BODY, read from
 * `EMAIL_AUDIT_DEFAULTS` rather than written out here. That is deliberately the
 * most conservative override that exists — a club that saved the wording without
 * changing a word — because it makes the point that no unusual edit is needed to
 * reach the branch, and it keeps this suite honest if the shipped wording moves.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clubTimeSettingsFindUnique: vi.fn(),
  emailTemplateOverrideFindUnique: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clubTimeSettings: { findUnique: mocks.clubTimeSettingsFindUnique },
    emailTemplateOverride: {
      findUnique: mocks.emailTemplateOverrideFindUnique,
    },
  },
}));

const SETTINGS = {
  clubName: "Test Club",
  bookingsName: "Test Club Bookings",
  lodgeName: "Test Lodge",
  emailFromName: "Test Club",
  supportEmail: "support@example.test",
  contactEmail: "contact@example.test",
  publicUrl: "https://bookings.example.test",
  lodgeTravelNote: "",
  doorCode: null,
};

vi.mock("@/lib/email-message-settings", () => ({
  EMAIL_DEFAULT_FROM_NAME: "Test Club",
  applyEmailMessageSettingsToHtml: (html: string) => html,
  applyEmailMessageSettingsToSubject: (subject: string) => subject,
  buildEmailTemplateGlobalData: (settings: Record<string, string>) => ({
    CLUB_NAME: settings.clubName,
    CLUB_BOOKINGS_NAME: settings.bookingsName,
    CLUB_LODGE_NAME: settings.lodgeName,
    CLUB_EMAIL_FROM_NAME: settings.emailFromName,
    SUPPORT_EMAIL: settings.supportEmail,
    CONTACT_EMAIL: settings.contactEmail,
    BASE_URL: settings.publicUrl,
    CLUB_LODGE_TRAVEL_NOTE: settings.lodgeTravelNote,
  }),
  formatEmailFromAddressWithSettings: () => "Club <club@example.test>",
  loadEmailMessageSettings: async () => SETTINGS,
  loadEmailMessageSettingsForLodge: async () => SETTINGS,
}));

vi.mock("@/lib/email-theme", () => ({
  emailPalette: () => ({
    gold: "#e7b83f",
    charcoal: "#374151",
    deep: "#1f2937",
    mist: "#e5e7eb",
    snow: "#ffffff",
    ridge: "#6b7280",
  }),
  // The #2900 render gate. Both the sender and the body-override re-render
  // inside `prepareEmailMessage` await it, so a factory omitting it throws at
  // the first send rather than failing an assertion.
  ensureEmailPaletteReady: async () => ({ source: "club-theme" as const }),
  renderEmailHtml: async <T,>(build: () => T) => build(),
}));

// The sender's OUTPUT is what this suite is about, so `sendEmail` is captured
// rather than executed. `prepareEmailMessage` below is the real one.
vi.mock("@/lib/email/core", () => ({
  sendEmail: mocks.sendEmail,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { APP_TIME_ZONE } from "@/config/operational";
import { type ClubTimeZone } from "@/lib/club-time";
import { formatLinkExpiry } from "@/app/(public)/pay/[token]/pay-link-presentation";
import {
  bindClubTime,
  formatClubInstantDateTime,
  unvalidatedLegacyClubTimeZone,
} from "@/lib/club-time";
import { EMAIL_AUDIT_DEFAULTS } from "@/lib/email-message-audit-defaults";
import {
  __resetEmailClubTimeZoneForTests,
  primeEmailClubTimeZone,
} from "@/lib/email-templates-club-time";
import {
  prepareEmailMessage,
  type EmailTemplateData,
} from "@/lib/email-message-renderer";
import { paymentLinkExpiryForCheckIn } from "@/lib/payment-link-expiry";
import {
  sendBookingRequestApprovedEmail,
  sendSplitGuestPaymentLinkEmail,
} from "@/lib/email/booking-requests";

import { divergentClubZone } from "./helpers/club-time-zone";

/** A check-in comfortably after the repository's frozen `2026-07-01T00:00Z`. */
const CHECK_IN_DAY = "2026-08-01";
const CHECK_IN = new Date(`${CHECK_IN_DAY}T00:00:00.000Z`);
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");

/**
 * The club's zone, chosen so its day-end INSTANT differs from the one either
 * the environment or the host would have produced.
 *
 * The derivation is deliberately the instant and not the rendered sentence. The
 * first version of this file derived
 * `bindClubTime(zone).instantDateTime(paymentLinkExpiryForCheckIn(day, zone))`,
 * which is `"1 Aug 2026, 11:59 pm"` for EVERY zone on the planet — the end of a
 * club's day, read back in that same club's zone, cannot be anything else. The
 * chooser refused it rather than handing back a candidate, which is the vacuity
 * guard doing its job: a derivation that is constant in the zone discriminates
 * nothing. What this suite needs from the chooser is a zone whose OFFSET really
 * differs; the divergence of the rendered sentence then follows, and is asserted
 * outright in the premise case below rather than assumed.
 */
const CLUB = divergentClubZone((zone: ClubTimeZone) =>
  paymentLinkExpiryForCheckIn(CHECK_IN, zone).toISOString(),
);

const CLUB_ZONE = CLUB.zone;
/** The instant a link minted today for that check-in really carries. */
const EXPIRES_AT = paymentLinkExpiryForCheckIn(CHECK_IN, CLUB_ZONE);

/** What the `/pay` page shows for that row — the page's own formatter. */
const PAGE_SAYS = formatLinkExpiry(
  EXPIRES_AT.toISOString(),
  bindClubTime(CLUB_ZONE),
);

/**
 * What the retired `templateData` route would have said — the WRONG answer, kept
 * because every case below asserts the email does not contain it.
 *
 * SPELLED OUT RATHER THAN IMPORTED, since #3123 deleted `@/lib/nzst-date`. This
 * was `formatNZDateTime(EXPIRES_AT)`, and that function was exactly the two lines
 * below: the house date-time shape over `unvalidatedLegacyClubTimeZone(APP_TIME_ZONE)`.
 * The zone is UNVALIDATED on purpose — `APP_TIME_ZONE` is a raw `process.env.TZ`
 * passthrough, so it may legitimately be `UTC` or a legacy spelling that CT-1's
 * validator refuses, and this is the answer a wrong implementation gives rather
 * than a zone any club may choose.
 */
const ENVIRONMENT_SAYS = formatClubInstantDateTime(
  EXPIRES_AT,
  unvalidatedLegacyClubTimeZone(APP_TIME_ZONE),
);

const APPROVED = "booking-request-approved";
const SPLIT_GUEST = "split-guest-payment-link";

/** The shipped default body, saved verbatim as a club's override. */
function shippedDefaultBodyAsOverride(templateName: string) {
  const shipped = (
    EMAIL_AUDIT_DEFAULTS as Record<string, { defaultBody: string }>
  )[templateName];
  expect(
    shipped?.defaultBody,
    `No shipped default body for "${templateName}" — this suite reads the real one so it cannot drift from what clubs actually edit.`,
  ).toBeTruthy();
  return {
    templateName,
    subject: null,
    bodyText: shipped.defaultBody,
    updatedAt: new Date("2026-07-15T00:00:00.000Z"),
    updatedByMemberId: "admin_1",
  };
}

const SENDERS: ReadonlyArray<{
  templateName: string;
  label: string;
  send: () => Promise<unknown>;
}> = [
  {
    templateName: APPROVED,
    label: "the approval email that carries the /pay link",
    send: () =>
      sendBookingRequestApprovedEmail({
        bookingContext: "none",
        email: "tara@example.test",
        firstName: "Tara",
        token: "pay-token",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        guestCount: 2,
        priceCents: 12_000,
        bookingReference: "bk_1",
        expiresAt: EXPIRES_AT,
      }),
  },
  {
    templateName: SPLIT_GUEST,
    label: "the split-guest pay-link email",
    send: () =>
      sendSplitGuestPaymentLinkEmail({
        bookingContext: "none",
        email: "tara@example.test",
        firstName: "Tara",
        token: "pay-token",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        guestCount: 2,
        priceCents: 12_000,
        bookingReference: "bk_1",
        expiresAt: EXPIRES_AT,
      }),
  },
];

/**
 * Run the real sender, then push its real `templateData` through the real
 * override renderer — which is exactly the two-step a delivered override email
 * takes, with only the SES transport left out.
 */
async function renderOverrideBody(sender: (typeof SENDERS)[number]) {
  mocks.emailTemplateOverrideFindUnique.mockResolvedValue(
    shippedDefaultBodyAsOverride(sender.templateName),
  );
  await sender.send();
  expect(
    mocks.sendEmail,
    "The sender did not reach sendEmail, so there is no templateData to render.",
  ).toHaveBeenCalledTimes(1);
  const sent = mocks.sendEmail.mock.calls[0][0] as {
    templateName: string;
    subject: string;
    html: string;
    templateData: EmailTemplateData;
  };
  expect(sent.templateName).toBe(sender.templateName);
  const prepared = await prepareEmailMessage({
    templateName: sent.templateName,
    subject: sent.subject,
    html: sent.html,
    templateData: sent.templateData,
  });
  expect(
    prepared.bodyOverrideApplied,
    "The override did not apply, so this case is not exercising the branch it exists for.",
  ).toBe(true);
  return { prepared, templateData: sent.templateData };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetEmailClubTimeZoneForTests();
  mocks.clubTimeSettingsFindUnique.mockResolvedValue({ timeZone: CLUB_ZONE });
  mocks.emailTemplateOverrideFindUnique.mockResolvedValue(null);
  vi.stubEnv("NEXTAUTH_URL", "https://bookings.example.test");
});

describe("the emailed payment deadline is the club's, on the override branch too", () => {
  it("has a premise worth testing: the club's wording differs from the environment's", () => {
    // The chooser proves the INSTANTS differ; this proves the SENTENCES do,
    // which is what every case below compares. Without it the suite could pass
    // on a pair of zones whose offsets differ by a whole day.
    expect(
      PAGE_SAYS,
      `divergentClubZone chose ${CLUB_ZONE}, whose rendering of ${EXPIRES_AT.toISOString()} should differ from APP_TIME_ZONE's (${APP_TIME_ZONE}). If these are equal the suite below cannot see the defect it exists for.`,
    ).not.toBe(ENVIRONMENT_SAYS);
    expect(EXPIRES_AT.toISOString()).toBe(CLUB.expected);
    expect(EXPIRES_AT.toISOString()).not.toBe(CLUB.environmentAnswer);
    expect(EXPIRES_AT.toISOString()).not.toBe(CLUB.hostAnswer);
  });

  for (const sender of SENDERS) {
    describe(sender.label, () => {
      it("agrees with the /pay page when a body override is saved", async () => {
        await primeEmailClubTimeZone();
        const { prepared } = await renderOverrideBody(sender);

        // THE AGREEMENT, which is the assertion that matters. Pinning the
        // email and the page separately would let both pass while the pair
        // disagrees.
        expect(prepared.html).toContain(PAGE_SAYS);
        expect(prepared.html).not.toContain(ENVIRONMENT_SAYS);
      });

      it("puts the club's reading into templateData, not the container's", async () => {
        await primeEmailClubTimeZone();
        const { templateData } = await renderOverrideBody(sender);

        expect(templateData.expiresAt).toBe(PAGE_SAYS);
        expect(templateData.expiresAt).not.toBe(ENVIRONMENT_SAYS);
      });

      it("says the same thing with an override as without one", async () => {
        await primeEmailClubTimeZone();
        const { prepared: overridden } = await renderOverrideBody(sender);

        vi.clearAllMocks();
        mocks.clubTimeSettingsFindUnique.mockResolvedValue({
          timeZone: CLUB_ZONE,
        });
        mocks.emailTemplateOverrideFindUnique.mockResolvedValue(null);
        await sender.send();
        const sent = mocks.sendEmail.mock.calls[0][0] as {
          templateName: string;
          subject: string;
          html: string;
          templateData: EmailTemplateData;
        };
        const untouched = await prepareEmailMessage({
          templateName: sent.templateName,
          subject: sent.subject,
          html: sent.html,
          templateData: sent.templateData,
        });
        expect(untouched.bodyOverrideApplied).toBe(false);

        // The whole point: editing the wording must not move the deadline.
        expect(untouched.html).toContain(PAGE_SAYS);
        expect(overridden.html).toContain(PAGE_SAYS);
      });

      it("still carries the deadline at all — the token the override renders", () => {
        const shipped = (
          EMAIL_AUDIT_DEFAULTS as Record<string, { defaultBody: string }>
        )[sender.templateName];
        // If the shipped body ever stops naming `{{expiresAt}}`, the three
        // cases above would keep passing while asserting nothing about a
        // deadline nobody is shown. This is what stops that going quiet.
        expect(shipped.defaultBody).toContain("{{expiresAt}}");
      });
    });
  }
});
