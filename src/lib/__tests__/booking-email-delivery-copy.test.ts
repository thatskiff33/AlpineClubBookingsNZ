import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  emailLogCreate: vi.fn(),
  emailLogFindMany: vi.fn(),
  emailLogUpdate: vi.fn(),
  emailLogUpdateMany: vi.fn(),
  emailTemplateOverrideFindUnique: vi.fn(),
  getActiveEmailSuppression: vi.fn(),
  memberFindMany: vi.fn(),
  memberFindUnique: vi.fn(),
  resolveEmailDeliveryConfig: vi.fn(),
  sendAdminEmail: vi.fn(),
  sendMail: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    environmentSafetySettings: { findUnique: vi.fn().mockResolvedValue(null) },
    booking: { findUnique: mocks.bookingFindUnique },
    emailLog: {
      create: mocks.emailLogCreate,
      findMany: mocks.emailLogFindMany,
      update: mocks.emailLogUpdate,
      updateMany: mocks.emailLogUpdateMany,
    },
    emailTemplateOverride: {
      findUnique: mocks.emailTemplateOverrideFindUnique,
    },
    member: {
      findMany: mocks.memberFindMany,
      findUnique: mocks.memberFindUnique,
    },
  },
}));

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
  loadEmailMessageSettings: async () => ({
    clubName: "Test Club",
    bookingsName: "Test Club Bookings",
    lodgeName: "Test Lodge",
    emailFromName: "Test Club",
    supportEmail: "support@example.test",
    contactEmail: "contact@example.test",
    publicUrl: "https://bookings.example.test",
    lodgeTravelNote: "",
    doorCode: null,
  }),
  loadEmailMessageSettingsForLodge: async () => ({
    clubName: "Test Club",
    bookingsName: "Test Club Bookings",
    lodgeName: "Test Lodge",
    emailFromName: "Test Club",
    supportEmail: "support@example.test",
    contactEmail: "contact@example.test",
    publicUrl: "https://bookings.example.test",
    lodgeTravelNote: "",
    doorCode: null,
  }),
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
  // The #2900 render gate. This suite pins the palette above, so the gate has
  // nothing to load and is a pass-through — but it must still be PRESENT: both
  // `sendEmail` and the body-override re-render inside `prepareEmailMessage`
  // await it, and a mock missing it throws at the first send rather than
  // failing an assertion.
  ensureEmailPaletteReady: async () => ({ source: "club-theme" as const }),
  renderEmailHtml: async <T,>(build: () => T) => build(),
}));

vi.mock("@/lib/email-suppression", () => ({
  getActiveEmailSuppression: mocks.getActiveEmailSuppression,
  normalizeEmailAddress: (value: string) => value.trim().toLowerCase(),
}));

vi.mock("@/lib/email/internal", () => ({
  getEmailTransporter: () => ({
    transporter: { sendMail: mocks.sendMail },
    modeLabel: "test",
  }),
  shouldPersistEmailHtml: () => true,
  // #3035: `sendEmail` names which transport carried a delivered message
  // through this helper, so a factory that omits it dies at import.
  logDeliveredTransport: () => {},
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({ sendMail: mocks.sendMail }),
  },
}));

vi.mock("@/lib/email-delivery", () => ({
  resolveEmailDeliveryConfig: mocks.resolveEmailDeliveryConfig,
  // #3035: the delivery policy reads the DECLARED transport kind through this
  // same canonical parser, so a partial mock of the module has to name it or the
  // whole file dies at import.
  resolveEmailTransportKind: () => "live-provider",
}));

vi.mock("@/lib/email-sender", () => ({
  EMAIL_FROM: "club@example.test",
  SUPPORT_EMAIL: "support@example.test",
  formatEmailFromAddress: (from: string) => from,
}));

vi.mock("@/lib/email", () => ({
  sendEmail: mocks.sendAdminEmail,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { retryFailedEmails } from "@/lib/cron-email-retry";
import { prepareEmailMessage } from "@/lib/email-message-renderer";
import { sendEmail } from "@/lib/email/core";
import { declareEnvironmentRole } from "@/lib/__tests__/helpers/environment-role";

const BOOKING_ID = "bk_detail_42";
const CURRENT_ORIGIN = "https://bookings.example.test";
const CURRENT_DETAIL =
  `${CURRENT_ORIGIN}/bookings/${BOOKING_ID}?tab=guests#consent`;
const LEGACY_DETAIL =
  `https://legacy-bookings.example.test/bookings/${BOOKING_ID}?from=old#summary`;
const RELATIVE_DETAIL =
  `/bookings/${BOOKING_ID}?mode=compact#payment`;
const CONSENT_ACTION =
  `${CURRENT_ORIGIN}/bookings/consent/bearer-secret` +
  `?return=%2Fbookings%2F${BOOKING_ID}&mode=answer#respond`;
const CONSENT_ACTION_HTML = CONSENT_ACTION.replaceAll("&", "&amp;");
const ENCODED_CONSENT_ACTIONS = [
  `${CURRENT_ORIGIN}/bookings/%63onsent/current-secret?mode=answer#respond`,
  "https://legacy-bookings.example.test/bookings/%43ONSENT/legacy-secret?mode=answer#respond",
  "/bookings/%63ONSENT/relative-secret?mode=answer#respond",
];
const UNRELATED_ABSOLUTE =
  `https://help.example.test/guide?next=/bookings/${BOOKING_ID}#faq`;
const UNRELATED_RELATIVE =
  `/help?next=/bookings/${BOOKING_ID}#faq`;
const OVERRIDE_SOURCE = [
  "Booking update",
  "",
  "Current detail: {{BASE_URL}}/bookings/{{bookingId}}?tab=guests#consent",
  "Legacy detail: https://legacy-bookings.example.test/bookings/{{bookingId}}?from=old#summary",
  "Relative detail: /bookings/{{bookingId}}?mode=compact#payment",
  "Consent action: {{BASE_URL}}/bookings/consent/bearer-secret?return=%2Fbookings%2F{{bookingId}}&mode=answer#respond",
  "Encoded current consent: {{BASE_URL}}/bookings/%63onsent/current-secret?mode=answer#respond",
  "Encoded legacy consent: https://legacy-bookings.example.test/bookings/%43ONSENT/legacy-secret?mode=answer#respond",
  "Encoded relative consent: /bookings/%63ONSENT/relative-secret?mode=answer#respond",
  "Unrelated absolute: https://help.example.test/guide?next=/bookings/{{bookingId}}#faq",
  "Unrelated relative: /help?next=/bookings/{{bookingId}}#faq",
  "Keep this operational sentence unchanged.",
].join("\n");

const storedOverride = {
  templateName: "booking-modified",
  subject: null,
  bodyText: OVERRIDE_SOURCE,
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedByMemberId: "admin_1",
};

let bookingOwnerId = "member_1";
let memberMailbox = "member@example.test";

function memberRecord() {
  return {
    email: memberMailbox,
    inheritEmailFromId: null,
    inheritEmailFrom: null,
    role: "USER",
    financeAccessLevel: "NONE",
    active: true,
    archivedAt: null,
    canLogin: true,
    accessRoles: [],
  };
}

function sendBookingModified(
  recipient:
    | { kind: "member"; memberId: string }
    | { kind: "non-login-public-contact" },
) {
  return sendEmail({
    to: "member@example.test",
    subject: "Built-in subject",
    html: "<p>Built-in body</p>",
    templateName: "booking-modified",
    templateData: { bookingId: BOOKING_ID },
    bookingContext: { bookingId: BOOKING_ID, recipient },
  });
}

async function prepareOverride(bookingUrl: string) {
  return prepareEmailMessage({
    templateName: "booking-modified",
    subject: "Built-in subject",
    html: "<p>Built-in body</p>",
    templateData: { bookingId: BOOKING_ID, bookingUrl },
  });
}

function expectDetailTextRemoved(html: string) {
  expect(html).not.toContain(CURRENT_DETAIL);
  expect(html).not.toContain(LEGACY_DETAIL);
  expect(html).not.toContain(RELATIVE_DETAIL);
}

function expectBearerAndUnrelatedTextPreserved(html: string) {
  expect(html).toContain(CONSENT_ACTION_HTML);
  for (const action of ENCODED_CONSENT_ACTIONS) {
    expect(html).toContain(action);
  }
  expect(html).toContain(UNRELATED_ABSOLUTE);
  expect(html).toContain(UNRELATED_RELATIVE);
  expect(html).toContain("Keep this operational sentence unchanged.");
}

function expectBearerTextPreserved(text: string) {
  expect(text).toContain(CONSENT_ACTION);
  for (const action of ENCODED_CONSENT_ACTIONS) {
    expect(text).toContain(action);
  }
}

function failedRowFromInitialSend() {
  const logged = mocks.emailLogCreate.mock.calls[0][0].data;
  return {
    id: "email_1",
    ...logged,
    status: "FAILED",
    attempts: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXTAUTH_URL", CURRENT_ORIGIN);

  bookingOwnerId = "member_1";
  memberMailbox = "member@example.test";

  mocks.bookingFindUnique.mockImplementation(
    async (args: { select?: { noEmails?: boolean } }) =>
      args.select?.noEmails
        ? { noEmails: false }
        : { memberId: bookingOwnerId, deletedAt: null, guests: [] },
  );
  mocks.memberFindUnique.mockImplementation(async () => memberRecord());
  mocks.memberFindMany.mockResolvedValue([]);
  mocks.emailTemplateOverrideFindUnique.mockResolvedValue(storedOverride);
  mocks.emailLogCreate.mockResolvedValue({ id: "email_1" });
  mocks.emailLogFindMany.mockResolvedValue([]);
  mocks.emailLogUpdate.mockResolvedValue({});
  mocks.emailLogUpdateMany.mockResolvedValue({ count: 1 });
  mocks.getActiveEmailSuppression.mockResolvedValue(null);
  mocks.resolveEmailDeliveryConfig.mockReturnValue({
    ok: true,
    transportOptions: { host: "smtp.example.test" },
    issues: [],
  });
  mocks.sendMail.mockResolvedValue({ messageId: "message_1" });
});

/*
  #3035 (ENV-SAFETY 2): this suite exercises a real SEND, so it has to say which
  installation it is pretending to be. `resolveEnvironmentRole()` answers from the
  APP_ENVIRONMENT_ROLE declaration AND the EnvironmentSafetySettings row, and both
  are absent by default in the unit suite — a missing Prisma delegate is an
  UNREADABLE override, not "no override", so the role resolves UNKNOWN and the
  delivery boundary withholds every message. Declaring production plus a
  no-override delegate is what makes these tests exercise live behaviour.
  See src/lib/__tests__/helpers/environment-role.ts.
*/
beforeEach(() => {
  declareEnvironmentRole("production");
});

describe("booking override delivery-copy URL sanitation", () => {
  it("keeps mixed-line bearer actions when the optional booking CTA is unavailable", async () => {
    const paymentAction = `${CURRENT_ORIGIN}/pay/bearer-payment`;
    const respondAction = `${CURRENT_ORIGIN}/booking-requests/respond/bearer-response`;
    const mixedOverride = {
      ...storedOverride,
      subject: "Action required — View this booking: {{bookingUrl}}",
      bodyText: [
        "Booking actions",
        "",
        `Pay now: ${paymentAction} | View this booking: {{bookingUrl}}`,
        `Respond: ${respondAction} • Open booking details: {{bookingUrl}}`,
        `Consent: ${CONSENT_ACTION}<br><a href="{{bookingUrl}}">View booking</a>`,
        "Manage your booking:",
        "{{bookingUrl}}",
        "Keep this operational sentence unchanged.",
      ].join("\n"),
    };
    mocks.emailTemplateOverrideFindUnique.mockResolvedValue(mixedOverride);

    await expect(
      sendBookingModified({ kind: "non-login-public-contact" }),
    ).resolves.toMatchObject({ status: "sent" });

    const delivery = mocks.sendMail.mock.calls[0][0];
    expect(delivery.subject).toBe("Action required");
    expect(delivery.html).toContain(paymentAction);
    expect(delivery.html).toContain(respondAction);
    expect(delivery.html).toContain(CONSENT_ACTION_HTML);
    expect(delivery.html).toContain("Keep this operational sentence unchanged.");
    expect(delivery.html).not.toContain("View this booking");
    expect(delivery.html).not.toContain("Open booking details");
    expect(delivery.html).not.toContain("View booking");
    expect(delivery.html).not.toContain("Manage your booking");
    expect(delivery.html).not.toContain('href=&quot;&quot;');
  });

  it("removes visible detail URLs on an initial public send while preserving bearer and unrelated copy", async () => {
    const sourceSnapshot = { ...storedOverride };
    const prepared = await prepareOverride("");

    // The production override renderer is the shape that exposed the bug:
    // escaped visible URL text, with no anchor for the old sanitizer to find.
    expect(prepared.bodyOverrideApplied).toBe(true);
    expect(prepared.html).toContain(CURRENT_DETAIL);
    expect(prepared.html).not.toContain(`href="${CURRENT_DETAIL}"`);

    await expect(
      sendBookingModified({ kind: "non-login-public-contact" }),
    ).resolves.toMatchObject({ status: "sent" });

    const delivery = mocks.sendMail.mock.calls[0][0];
    expectDetailTextRemoved(delivery.html);
    expectDetailTextRemoved(delivery.text);
    expectBearerAndUnrelatedTextPreserved(delivery.html);
    expectBearerTextPreserved(delivery.text);
    expect(delivery.text).toContain(UNRELATED_ABSOLUTE);

    const logged = mocks.emailLogCreate.mock.calls[0][0].data;
    expect(logged).toMatchObject({
      htmlBody: null,
      bookingBodyOverrideApplied: true,
      bookingDetailLinkIncluded: false,
      bookingRetryHtmlBody: delivery.html,
    });
    expect(storedOverride).toEqual(sourceSnapshot);
  });

  it("keeps an authorized rendered override byte-for-byte unchanged", async () => {
    const sourceSnapshot = { ...storedOverride };
    const canonicalBookingUrl = `${CURRENT_ORIGIN}/bookings/${BOOKING_ID}`;
    const prepared = await prepareOverride(canonicalBookingUrl);

    await expect(
      sendBookingModified({ kind: "member", memberId: "member_1" }),
    ).resolves.toMatchObject({ status: "sent" });

    const delivery = mocks.sendMail.mock.calls[0][0];
    expect(delivery.html).toBe(prepared.html);
    expect(delivery.html).toContain(CURRENT_DETAIL);
    expect(delivery.html).toContain(LEGACY_DETAIL);
    expect(delivery.html).toContain(RELATIVE_DETAIL);
    expect(mocks.emailLogCreate.mock.calls[0][0].data.bookingRetryHtmlBody).toBe(
      prepared.html,
    );
    expect(storedOverride).toEqual(sourceSnapshot);
  });

  it.each(["mailbox", "booking authority"] as const)(
    "removes rendered detail URL text on retry after %s is revoked",
    async (revocation) => {
      const sourceSnapshot = { ...storedOverride };
      const canonicalBookingUrl = `${CURRENT_ORIGIN}/bookings/${BOOKING_ID}`;
      const prepared = await prepareOverride(canonicalBookingUrl);
      mocks.sendMail.mockRejectedValueOnce(new Error("smtp unavailable"));

      await expect(
        sendBookingModified({ kind: "member", memberId: "member_1" }),
      ).rejects.toThrow("smtp unavailable");

      const initialDelivery = mocks.sendMail.mock.calls[0][0];
      expect(initialDelivery.html).toBe(prepared.html);
      expect(initialDelivery.html).toContain(CURRENT_DETAIL);

      const failedRow = failedRowFromInitialSend();
      expect(failedRow).toMatchObject({
        htmlBody: null,
        bookingBodyOverrideApplied: true,
        bookingDetailLinkIncluded: false,
        bookingRetryHtmlBody: prepared.html,
      });
      mocks.emailLogFindMany.mockResolvedValue([failedRow]);
      if (revocation === "mailbox") {
        memberMailbox = "new-mailbox@example.test";
      } else {
        bookingOwnerId = "different_owner";
      }

      await expect(retryFailedEmails()).resolves.toEqual({
        retried: 1,
        succeeded: 1,
        failed: 0,
      });

      const retryDelivery = mocks.sendMail.mock.calls[1][0];
      expectDetailTextRemoved(retryDelivery.html);
      expectDetailTextRemoved(retryDelivery.text);
      expectBearerAndUnrelatedTextPreserved(retryDelivery.html);
      expectBearerTextPreserved(retryDelivery.text);
      expect(retryDelivery.text).toContain(UNRELATED_ABSOLUTE);
      expect(mocks.emailLogUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: "FAILED",
            htmlBody: null,
            bookingRetryHtmlBody: prepared.html,
          }),
          data: expect.objectContaining({
            status: "QUEUED",
            bookingRetryHtmlBody: retryDelivery.html,
            bookingDetailLinkIncluded: false,
          }),
        }),
      );
      expect(storedOverride).toEqual(sourceSnapshot);
    },
  );
});
