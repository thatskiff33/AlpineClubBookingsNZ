import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2307 (epic #2305, MG2) — what does and does NOT withhold the covered
 * member-guest emails.
 *
 * OWNER DECISION D-16, stated as two halves that must BOTH hold:
 *
 *  1. A member who has muted a notification category is still asked. Being asked
 *     for consent is not a mutable preference — a muted member would never be
 *     asked, and would then silently expire off the booking N days later without
 *     ever knowing they had been put on it. So no preference row is consulted:
 *     the `notificationPreference` delegate below REJECTS if anything touches it,
 *     which makes the absence of that read a property of the code rather than an
 *     observation about it.
 *  2. The per-booking "No emails" switch DOES withhold them, and every withheld
 *     send lands on the booking's withheld list (#2258/#2259) so an officer can
 *     see what the member was never told.
 *
 * And the third property, which is the one a mistake here would hide: the gate
 * FAILS CLOSED. An unreadable switch withholds rather than sends, because sending
 * a message that was meant to be held back is the unrecoverable direction.
 *
 * This suite drives the REAL `sendEmail` — the gate, the EmailLog writes and the
 * transport are the thing under test, so only the layers around them are mocked.
 */

const mocks = vi.hoisted(() => ({
  getAdminEmails: vi.fn(),
  emailLogCreate: vi.fn(),
  emailLogUpdate: vi.fn(),
  bookingFindUnique: vi.fn(),
  memberFindUnique: vi.fn(),
  notificationPreferenceFindUnique: vi.fn(),
  getActiveEmailSuppression: vi.fn(),
  sendMail: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  settingsStub: {
    clubName: "Alpine Sports Club",
    bookingsName: "Alpine Sports Club - Bookings",
    lodgeName: "Silverpeak Lodge",
    emailFromName: "Alpine Sports Club - Online Booking System",
    supportEmail: "support@example.org",
    contactEmail: "support@example.org",
    publicUrl: "https://bookings.example.org",
    lodgeTravelNote: "Please allow adequate travel time.",
    doorCode: null as string | null,
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    environmentSafetySettings: { findUnique: vi.fn().mockResolvedValue(null) },
    emailLog: { create: mocks.emailLogCreate, update: mocks.emailLogUpdate },
    booking: { findUnique: mocks.bookingFindUnique },
    member: { findUnique: mocks.memberFindUnique },
    // Present so a stray preference read would be a REJECTED promise rather
    // than a TypeError that could be mistaken for something else.
    notificationPreference: {
      findUnique: mocks.notificationPreferenceFindUnique,
    },
  },
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));
vi.mock("@/lib/email-sender", () => ({
  EMAIL_FROM: "club@club.test",
  SUPPORT_EMAIL: "support@club.test",
}));
vi.mock("@/lib/email-message-renderer", () => ({
  prepareEmailMessage: async ({
    subject,
    html,
  }: {
    subject: string;
    html: string;
  }) => ({
    subject,
    html,
    settings: mocks.settingsStub,
    bodyOverrideApplied: false,
  }),
}));
vi.mock("@/lib/email-message-settings", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/email-message-settings")
  >();
  return {
    ...actual,
    loadEmailMessageSettingsForLodge: vi.fn(async () => mocks.settingsStub),
  };
});
vi.mock("@/lib/email-suppression", () => ({
  getActiveEmailSuppression: mocks.getActiveEmailSuppression,
  normalizeEmailAddress: (value: string) => value.trim().toLowerCase(),
}));
vi.mock("@/lib/email/admin-alerts-shared", () => ({
  getAdminEmails: mocks.getAdminEmails,
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

import {
  ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES,
  isBookingSuppressibleTemplate,
} from "@/lib/booking-email-suppression";
import { parseDateOnly } from "@/lib/date-only";
import { __resetFailClosedAlertThrottle } from "@/lib/email/core";
import { declareEnvironmentRole } from "@/lib/__tests__/helpers/environment-role";
import {
  sendMemberGuestAddedEmail,
  sendMemberGuestConsentExpiredEmail,
  sendMemberGuestConsentOutcomeEmail,
  sendMemberGuestConsentRequestEmail,
  sendMemberGuestRequestWithdrawnEmail,
} from "@/lib/email/member-guest";

const CHECK_IN = parseDateOnly("2026-08-08");
const CHECK_OUT = parseDateOnly("2026-08-10");
const NIGHTS = [parseDateOnly("2026-08-08"), parseDateOnly("2026-08-09")];
const PARTY = [
  { firstName: "Dave", lastName: "Ngata" },
  { firstName: "Priya", lastName: "Kaur" },
];

/**
 * The covered senders, each already bound to the same booking. Driven as a table so
 * every assertion below is exhaustive over the set rather than over whichever
 * one somebody remembered.
 */
const SENDERS: Array<{ templateName: string; send: () => Promise<unknown> }> = [
  {
    templateName: "member-guest-consent-request",
    send: () =>
      sendMemberGuestConsentRequestEmail({
        bookingId: "bkg_1",
        recipient: { kind: "member", memberId: "member_1" },
        email: "priya@example.nz",
        firstName: "Priya",
        bookerName: "Dave Ngata",
        audience: { kind: "TARGET" },
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        guestNights: NIGHTS,
        consentExpiresAt: parseDateOnly("2026-08-07"),
        consentUrl: "http://localhost:3000/bookings/bkg_1#consent",
        party: PARTY,
      }),
  },
  {
    templateName: "member-guest-added",
    send: () =>
      sendMemberGuestAddedEmail({
        bookingId: "bkg_1",
        recipient: { kind: "member", memberId: "member_1" },
        email: "hana@example.nz",
        firstName: "Hana",
        bookerName: "Dave Ngata",
        context: "NOTIFY_ONLY",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        guestNights: NIGHTS,
        party: PARTY,
        selfRemoval: {
          actorMemberId: "mem_guest",
          guestMemberId: "mem_guest",
          bookingOwnerMemberId: "mem_owner",
          bookingStatus: "PAID",
          bookingCheckIn: CHECK_IN,
          bookingGuestCount: 2,
          isQuotePriced: false,
          today: parseDateOnly("2026-08-01"),
        },
      }),
  },
  {
    templateName: "member-guest-consent-outcome",
    send: () =>
      sendMemberGuestConsentOutcomeEmail({
        bookingId: "bkg_1",
        recipient: { kind: "member", memberId: "owner_1" },
        email: "dave@example.nz",
        firstName: "Dave",
        guest: { firstName: "Priya", lastName: "Kaur" },
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        outcome: { kind: "DECLINED", creditCents: 4800 },
      }),
  },
  {
    templateName: "member-guest-consent-expired",
    send: () =>
      sendMemberGuestConsentExpiredEmail({
        bookingId: "bkg_1",
        recipient: { kind: "member", memberId: "member_1" },
        email: "priya@example.nz",
        firstName: "Priya",
        bookerName: "Dave Ngata",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
      }),
  },
  {
    templateName: "member-guest-request-withdrawn",
    send: () =>
      sendMemberGuestRequestWithdrawnEmail({
        bookingId: "bkg_1",
        recipient: { kind: "member", memberId: "removed_1" },
        email: "priya@example.nz",
        firstName: "Priya",
        bookerName: "Dave Ngata",
        context: "TAKEN_OFF",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
      }),
  },
];

const TEMPLATE_NAMES = SENDERS.map((sender) => sender.templateName);

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.emailLogCreate.mockResolvedValue({ id: "log_1" });
  mocks.emailLogUpdate.mockResolvedValue({});
  mocks.getActiveEmailSuppression.mockResolvedValue(null);
  mocks.sendMail.mockResolvedValue({ messageId: "msg_1" });
  mocks.bookingFindUnique.mockImplementation(
    async (args: {
      select?: {
        noEmails?: boolean;
        guests?: { where?: { memberId?: string } };
      };
    }) => {
      if (args.select?.noEmails) return { noEmails: false };
      return {
        memberId: "owner_1",
        deletedAt: null,
        guests:
          args.select?.guests?.where?.memberId === "member_1"
            ? [{ id: "guest_1" }]
            : [],
      };
    },
  );
  mocks.memberFindUnique.mockImplementation(
    async (args: { where: { id: string } }) => ({
      email:
        args.where.id === "owner_1"
          ? "dave@example.nz"
          : args.where.id === "admin_1"
            ? "admin@example.nz"
          : args.where.id === "delegate_1"
            ? "delegate@example.nz"
            : "priya@example.nz",
      inheritEmailFromId: null,
      inheritEmailFrom: null,
      role: "USER",
      financeAccessLevel: "NONE",
      active: true,
      archivedAt: null,
      canLogin: true,
      accessRoles:
        args.where.id === "admin_1"
          ? [
              {
                role: "ADMIN_READONLY",
                roleDefinitionId: null,
                roleDefinition: null,
              },
            ]
          : [],
    }),
  );
  mocks.getAdminEmails.mockResolvedValue([]);
  // Half 1 of D-16, enforced rather than described: nothing in this path may
  // read a notification preference.
  mocks.notificationPreferenceFindUnique.mockRejectedValue(
    new Error(
      "D-16: consent-adjacent mail must not consult notification preferences",
    ),
  );
  __resetFailClosedAlertThrottle();
  vi.stubEnv("NODE_ENV", "production");
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

describe("registry classification the switch depends on (#2307)", () => {
  it.each(TEMPLATE_NAMES)(
    "registers %s as suppressible and always booking-scoped",
    (templateName) => {
      // isBookingSuppressibleTemplate keys on the registry's audience and only
      // ever withholds "member" — so an admin-audience consent email would
      // silently escape the switch entirely.
      expect(isBookingSuppressibleTemplate(templateName)).toBe(true);
      // And the retry cron refuses to replay a pre-#2258 NULL-bookingId row for
      // these, rather than replaying blind into a silenced booking.
      expect(ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES.has(templateName)).toBe(true);
    },
  );
});

describe('the per-booking "No emails" switch withholds every covered sender (#2307, D-16 + D10)', () => {
  it.each(TEMPLATE_NAMES.map((name, index) => [name, index] as const))(
    "withholds %s and records it on the booking's withheld list",
    async (templateName, index) => {
      mocks.bookingFindUnique.mockResolvedValue({ noEmails: true });

      const outcome = await SENDERS[index].send();

      expect(outcome).toEqual({
        status: "withheld_for_booking",
        emailLogId: "log_1",
        bookingId: "bkg_1",
        reason: "booking_no_emails",
      });
      expect(mocks.sendMail).not.toHaveBeenCalled();
      // The withheld row is what #2259's banner reads, so it has to exist, be
      // attributed to the booking, and retain no body.
      expect(mocks.emailLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            templateName,
            bookingId: "bkg_1",
          }),
        }),
      );
      expect(mocks.emailLogUpdate).toHaveBeenCalledWith({
        where: { id: "log_1" },
        data: expect.objectContaining({
          status: "SKIPPED_NO_EMAILS",
          htmlBody: null,
        }),
      });
    },
  );

  it.each(TEMPLATE_NAMES.map((name, index) => [name, index] as const))(
    "withholds %s when the switch cannot be READ, rather than sending",
    async (_templateName, index) => {
      mocks.bookingFindUnique.mockRejectedValue(new Error("database is down"));

      const outcome = await SENDERS[index].send();

      // Fail CLOSED. The opposite of the SES bounce check next door, and
      // deliberately so: an unreadable switch means we do not know whether the
      // club asked for silence, and sending anyway cannot be undone.
      expect(outcome).toEqual({
        status: "withheld_for_booking",
        emailLogId: "log_1",
        bookingId: "bkg_1",
        reason: "booking_flag_unreadable",
      });
      expect(mocks.sendMail).not.toHaveBeenCalled();
      // FAILED, not SKIPPED_NO_EMAILS: the fault is transient, so the retry cron
      // re-evaluates the switch later instead of the row being terminal.
      expect(mocks.emailLogUpdate).toHaveBeenCalledWith({
        where: { id: "log_1" },
        data: expect.objectContaining({ status: "FAILED" }),
      });
    },
  );
});

describe("a muted member is still asked (#2307, D-16)", () => {
  it.each(TEMPLATE_NAMES.map((name, index) => [name, index] as const))(
    "sends %s without consulting any notification preference",
    async (templateName, index) => {
      const outcome = await SENDERS[index].send();

      expect(outcome).toMatchObject({ status: "sent" });
      expect(mocks.sendMail).toHaveBeenCalledTimes(1);
      // Half 1 of D-16. The rejecting delegate above means a preference read
      // would have surfaced as a failure too; this says why it never happens.
      expect(mocks.notificationPreferenceFindUnique).not.toHaveBeenCalled();
      expect(mocks.emailLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ templateName, bookingId: "bkg_1" }),
        }),
      );
    },
  );

  it("attributes every send to the booking even when nothing is withheld", async () => {
    // #2258: booking attribution is written on EVERY booking-scoped message, not
    // only withheld ones — the retry cron re-reads the switch from this column
    // before it replays a FAILED row.
    for (const sender of SENDERS) {
      mocks.emailLogCreate.mockClear();
      await sender.send();
      expect(mocks.emailLogCreate.mock.calls[0][0].data.bookingId).toBe("bkg_1");
    }
  });

  it("keeps the target's #consent action and the delegate's bearer route through the real mail core", async () => {
    await SENDERS[0].send();
    const targetHtml = mocks.sendMail.mock.calls[0][0].html as string;
    expect(targetHtml).toContain(
      'href="http://localhost:3000/bookings/bkg_1#consent"',
    );
    expect(mocks.emailLogCreate.mock.calls[0][0].data).toMatchObject({
      bookingRecipientMemberId: "member_1",
      bookingBodyOverrideApplied: false,
      bookingDetailLinkIncluded: true,
    });

    mocks.sendMail.mockClear();
    mocks.emailLogCreate.mockClear();
    await sendMemberGuestConsentRequestEmail({
      bookingId: "bkg_1",
      recipient: { kind: "member", memberId: "delegate_1" },
      email: "delegate@example.nz",
      firstName: "Aroha",
      bookerName: "Dave Ngata",
      audience: {
        kind: "DELEGATE",
        guest: { firstName: "Priya", lastName: "Kaur" },
      },
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      guestNights: NIGHTS,
      consentExpiresAt: parseDateOnly("2026-08-07"),
      consentUrl: "http://localhost:3000/bookings/consent/guest_1",
      party: PARTY,
    });

    const delegateHtml = mocks.sendMail.mock.calls[0][0].html as string;
    expect(delegateHtml).toContain(
      'href="http://localhost:3000/bookings/consent/guest_1"',
    );
    expect(delegateHtml).not.toContain("/bookings/bkg_1");
    expect(mocks.emailLogCreate.mock.calls[0][0].data).toMatchObject({
      bookingRecipientMemberId: "delegate_1",
      bookingBodyOverrideApplied: false,
      bookingDetailLinkIncluded: false,
    });
  });

  it.each([
    ["removed member", "removed_1", "priya@example.nz"],
    ["family delegate", "delegate_1", "delegate@example.nz"],
  ])(
    "does not expose the withdrawn booking to an ordinary %s",
    async (_label, memberId, email) => {
      await sendMemberGuestRequestWithdrawnEmail({
        bookingId: "bkg_1",
        recipient: { kind: "member", memberId },
        email,
        firstName: "Priya",
        bookerName: "Dave Ngata",
        context: "TAKEN_OFF",
        audience:
          memberId === "delegate_1"
            ? {
                kind: "DELEGATE",
                guest: { firstName: "Priya", lastName: "Kaur" },
              }
            : { kind: "TARGET" },
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
      });

      const html = mocks.sendMail.mock.calls[0][0].html as string;
      expect(html).not.toContain("/bookings/bkg_1");
      expect(mocks.emailLogCreate.mock.calls[0][0].data).toMatchObject({
        bookingRecipientMemberId: memberId,
        bookingDetailLinkIncluded: false,
      });
    },
  );

  it("includes the canonical detail link for a withdrawal recipient with independent bookings-view authority", async () => {
    await sendMemberGuestRequestWithdrawnEmail({
      bookingId: "bkg_1",
      recipient: { kind: "member", memberId: "admin_1" },
      email: "admin@example.nz",
      firstName: "Alex",
      bookerName: "Dave Ngata",
      context: "TAKEN_OFF",
      audience: {
        kind: "DELEGATE",
        guest: { firstName: "Priya", lastName: "Kaur" },
      },
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
    });

    const html = mocks.sendMail.mock.calls[0][0].html as string;
    expect(html).toContain('/bookings/bkg_1');
    expect(mocks.emailLogCreate.mock.calls[0][0].data).toMatchObject({
      bookingRecipientMemberId: "admin_1",
      bookingDetailLinkIncluded: true,
    });
  });
});
