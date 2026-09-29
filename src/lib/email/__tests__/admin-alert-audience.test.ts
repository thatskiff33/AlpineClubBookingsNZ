import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2548: who actually receives an admin alert. Before this change the resolver
 * queried the legacy scalar `Member.role === "ADMIN"`, so Booking Officers,
 * Membership Officers, Treasurers and every definition-backed CUSTOM role
 * silently received nothing at all. The audience now comes from the access-role
 * permission matrix, area by area.
 */

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  sendEmail: vi.fn(),
  shouldSendAdminSystemEmail: vi.fn(),
  recordEscalation: vi.fn(),
  // #2761 fix: the last-resort recipient is the club's OWN support address, read
  // through the same `EmailMessageSetting` row every outbound email reads.
  emailMessageSettingFindUnique: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findMany: mocks.findMany },
    emailMessageSetting: {
      findUnique: (...args: unknown[]) =>
        mocks.emailMessageSettingFindUnique(...args),
    },
  },
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));
vi.mock("@/lib/notification-delivery-policies", () => ({
  shouldSendAdminSystemEmail: mocks.shouldSendAdminSystemEmail,
}));
vi.mock("@/lib/email-admin-alert-escalation", () => ({
  recordAdminAlertDeliveryEscalation: mocks.recordEscalation,
}));
vi.mock("@/lib/email/core", () => ({ sendEmail: mocks.sendEmail }));

import {
  getAdminEmails,
  sendToAdmins,
  sendUnmuteableAdminAlert,
} from "@/lib/email/admin-alerts-shared";
import {
  ADMIN_NOTIFICATION_PREFERENCE_KEYS,
  type AdminNotificationPreferenceKey,
} from "@/lib/admin-notification-preferences";
import { ADMIN_CAPABLE_MEMBER_WHERE } from "@/lib/access-role-definitions";
import { CLUB_SUPPORT_EMAIL } from "@/config/club-identity";

/**
 * A club that has actually configured its support mailbox. Deliberately NOT the
 * safe default (`support@example.org`), which is the documentation-domain literal
 * `CLUB_SUPPORT_EMAIL` resolves to — the whole point of the assertions below.
 */
const CONFIGURED_CLUB_SUPPORT_EMAIL = "club.office@realclub.test";

type Candidate = {
  email: string;
  canLogin?: boolean;
  accessRoles: Array<Record<string, unknown>>;
  notificationPreference?: Record<string, boolean> | null;
};

function enumRole(email: string, role: string, extra: Partial<Candidate> = {}) {
  return {
    email,
    canLogin: true,
    accessRoles: [{ role, roleDefinitionId: null, roleDefinition: null }],
    notificationPreference: null,
    ...extra,
  } satisfies Candidate;
}

/** A club-defined role: no enum value at all, only a definition row. */
function definitionRole(
  email: string,
  levels: Partial<Record<string, "NONE" | "VIEW" | "EDIT">>,
  extra: Partial<Candidate> = {},
) {
  return {
    email,
    canLogin: true,
    accessRoles: [
      {
        role: null,
        roleDefinitionId: "ardef_custom",
        roleDefinition: {
          id: "ardef_custom",
          overviewLevel: "NONE",
          bookingsLevel: "NONE",
          membershipLevel: "NONE",
          financeLevel: "NONE",
          lodgeLevel: "NONE",
          contentLevel: "NONE",
          supportLevel: "NONE",
          ...levels,
        },
      },
    ],
    notificationPreference: null,
    ...extra,
  } satisfies Candidate;
}

async function recipientsFor(
  preferenceKey: AdminNotificationPreferenceKey,
  candidates: Candidate[],
) {
  mocks.findMany.mockResolvedValue(candidates);
  mocks.sendEmail.mockClear();
  await sendToAdmins({
    subject: "Alert",
    html: "<p>alert</p>",
    templateName: `template-${preferenceKey}`,
    preferenceKey,
  });
  return mocks.sendEmail.mock.calls.map((call) => call[0].to as string).sort();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.shouldSendAdminSystemEmail.mockResolvedValue({ send: true, mode: "on" });
  mocks.sendEmail.mockResolvedValue({ status: "sent" });
});

describe("admin alert audience is area-aware (#2548)", () => {
  const team: Candidate[] = [
    enumRole("full.admin@club.test", "ADMIN"),
    enumRole("booking.officer@club.test", "ADMIN_BOOKINGS"),
    enumRole("membership.officer@club.test", "ADMIN_MEMBERSHIP"),
    enumRole("treasurer@club.test", "FINANCE_ADMIN"),
    enumRole("readonly@club.test", "ADMIN_READONLY"),
    enumRole("content@club.test", "ADMIN_CONTENT"),
  ];

  it("sends booking-change requests to Full Admins and Booking Officers", async () => {
    expect(await recipientsFor("adminBookingChangeRequest", team)).toEqual([
      "booking.officer@club.test",
      "full.admin@club.test",
    ]);
  });

  it("keeps finance alerts to Full Admins and the Treasurer", async () => {
    expect(await recipientsFor("adminPaymentFailure", team)).toEqual([
      "full.admin@club.test",
      "treasurer@club.test",
    ]);
    expect(await recipientsFor("adminXeroSyncError", team)).toEqual([
      "full.admin@club.test",
      "treasurer@club.test",
    ]);
    expect(await recipientsFor("adminRefundRequest", team)).toEqual([
      "full.admin@club.test",
      "treasurer@club.test",
    ]);
  });

  it("keeps membership alerts to Full Admins and the Membership Officer", async () => {
    expect(await recipientsFor("adminFamilyGroupRequest", team)).toEqual([
      "full.admin@club.test",
      "membership.officer@club.test",
    ]);
    expect(await recipientsFor("adminMemberDeleteRequest", team)).toEqual([
      "full.admin@club.test",
      "membership.officer@club.test",
    ]);
  });

  it("keeps the cross-area digest and support alerts to Full Admins", async () => {
    expect(await recipientsFor("adminDailyDigest", team)).toEqual([
      "full.admin@club.test",
    ]);
    expect(await recipientsFor("adminIssueReport", team)).toEqual([
      "full.admin@club.test",
    ]);
  });

  it("still sends the Full Admin every one of the fifteen categories", async () => {
    for (const key of ADMIN_NOTIFICATION_PREFERENCE_KEYS) {
      expect(
        await recipientsFor(key, [enumRole("full.admin@club.test", "ADMIN")]),
        `Full Admin missed ${key}`,
      ).toEqual(["full.admin@club.test"]);
    }
  });

  it("reaches a definition-backed custom role, which used to get nothing", async () => {
    const custom = definitionRole("custom.officer@club.test", {
      overviewLevel: "VIEW",
      bookingsLevel: "EDIT",
    });
    expect(await recipientsFor("adminBookingChangeRequest", [custom])).toEqual([
      "custom.officer@club.test",
    ]);
    expect(await recipientsFor("adminPaymentFailure", [custom])).toEqual([]);
  });

  it("never mails a login-disabled or role-less account", async () => {
    const candidates: Candidate[] = [
      enumRole("no.login@club.test", "ADMIN", { canLogin: false }),
      enumRole("plain.member@club.test", "USER"),
      definitionRole(
        "ex.officer@club.test",
        { bookingsLevel: "EDIT" },
        { canLogin: false },
      ),
    ];
    expect(await recipientsFor("adminBookingChangeRequest", candidates)).toEqual([]);
    expect(await recipientsFor("adminNewBooking", candidates)).toEqual([]);
  });

  it("queries only active, login-capable holders of a privileged access role", async () => {
    await recipientsFor("adminNewBooking", []);
    // Every ordinary member carries a USER assignment row, so the candidate
    // filter must exclude them or an alert would load the whole club.
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: ADMIN_CAPABLE_MEMBER_WHERE }),
    );
    expect(ADMIN_CAPABLE_MEMBER_WHERE.accessRoles.some.OR[0]).toEqual({
      role: { notIn: ["USER", "ORG"] },
    });
    // The joined role definition must be selected, or custom roles resolve to
    // nothing and drop out of every audience again.
    const select = mocks.findMany.mock.calls[0]?.[0].select;
    expect(select.accessRoles.select.roleDefinition).toBeTruthy();
  });
});

describe("stored preferences still gate delivery (#2548)", () => {
  it("honours an opt-out inside the officer's own area", async () => {
    const officer = enumRole("booking.officer@club.test", "ADMIN_BOOKINGS", {
      notificationPreference: { adminBookingChangeRequest: false },
    });
    expect(await recipientsFor("adminBookingChangeRequest", [officer])).toEqual([]);
    expect(await recipientsFor("adminNewBooking", [officer])).toEqual([
      "booking.officer@club.test",
    ]);
  });

  it("ignores an out-of-area stored true rather than widening the audience", async () => {
    // Non-null database columns default to true, so an officer who ever saved a
    // personal email preference already stores `true` for all fifteen.
    const officer = enumRole("booking.officer@club.test", "ADMIN_BOOKINGS", {
      notificationPreference: Object.fromEntries(
        ADMIN_NOTIFICATION_PREFERENCE_KEYS.map((key) => [key, true]),
      ),
    });
    expect(await recipientsFor("adminRefundRequest", [officer])).toEqual([]);
    expect(await recipientsFor("adminXeroSyncError", [officer])).toEqual([]);
  });

  it("respects an upstream delivery policy that mutes the template club-wide", async () => {
    mocks.shouldSendAdminSystemEmail.mockResolvedValue({
      send: false,
      mode: "off",
      reason: "muted",
    });
    mocks.findMany.mockResolvedValue([enumRole("full.admin@club.test", "ADMIN")]);
    await sendToAdmins({
      subject: "Alert",
      html: "<p>alert</p>",
      templateName: "admin-booking-change-request",
      preferenceKey: "adminBookingChangeRequest",
    });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
});

/**
 * #3672 (delta review D1): `sendToAdmins` says what happened to each
 * recipient, so a caller holding a once-only claim can tell "an admin has it,
 * or the email retry cron will send it" from "nobody can receive it".
 */
describe("sendToAdmins reports each recipient's fate (#3672)", () => {
  const treasurers = [
    enumRole("a@club.test", "FINANCE_ADMIN"),
    enumRole("b@club.test", "FINANCE_ADMIN"),
    enumRole("c@club.test", "FINANCE_ADMIN"),
  ];

  beforeEach(() => {
    mocks.recordEscalation.mockResolvedValue(undefined);
  });

  function send(templateName = "admin-group-joiner-started-stay") {
    return sendToAdmins({
      subject: "Alert",
      html: "<p>alert</p>",
      templateName,
      preferenceKey: "adminPaymentFailure",
    });
  }

  it("counts sent, queued for the retry cron, and not delivered separately", async () => {
    mocks.findMany.mockResolvedValue(treasurers);
    mocks.sendEmail
      .mockResolvedValueOnce({ status: "sent" })
      .mockRejectedValueOnce(new Error("SMTP down"))
      .mockResolvedValueOnce({ status: "suppressed" });

    await expect(send()).resolves.toEqual({
      deliveryAllowed: true,
      recipients: 3,
      sent: 1,
      queuedForRetry: 1,
      notDelivered: 1,
    });
  });

  it("counts an environment fault as queued and a confirmed non-production copy as not delivered", async () => {
    mocks.findMany.mockResolvedValue(treasurers.slice(0, 2));
    mocks.sendEmail
      .mockResolvedValueOnce({ status: "withheld_for_environment", reason: "environment_unknown" })
      .mockResolvedValueOnce({
        status: "withheld_for_environment",
        reason: "environment_non_production",
      });

    await expect(send()).resolves.toEqual({
      deliveryAllowed: true,
      recipients: 2,
      sent: 0,
      queuedForRetry: 1,
      notDelivered: 1,
    });
  });

  // A template whose EmailLog keeps no body is never replayed by the cron.
  it("counts a failure nothing replays as not delivered", async () => {
    mocks.findMany.mockResolvedValue(treasurers.slice(0, 1));
    mocks.sendEmail.mockRejectedValueOnce(new Error("SMTP down"));

    await expect(send("admin-email-failure")).resolves.toEqual({
      deliveryAllowed: true,
      recipients: 1,
      sent: 0,
      queuedForRetry: 0,
      notDelivered: 1,
    });
  });

  it("says when the delivery policy skipped it and when nobody is opted in", async () => {
    mocks.shouldSendAdminSystemEmail.mockResolvedValueOnce({ send: false, mode: "disabled" });
    await expect(send()).resolves.toEqual({
      deliveryAllowed: false,
      recipients: 0,
      sent: 0,
      queuedForRetry: 0,
      notDelivered: 0,
    });

    mocks.findMany.mockResolvedValue([
      enumRole("a@club.test", "FINANCE_ADMIN", {
        notificationPreference: { adminPaymentFailure: false },
      }),
    ]);
    await expect(send()).resolves.toEqual({
      deliveryAllowed: true,
      recipients: 0,
      sent: 0,
      queuedForRetry: 0,
      notDelivered: 0,
    });
  });
});


/**
 * #2761 — the alert nobody may mute.
 *
 * An automatic money movement should not be silenceable and its recipient set must
 * not be able to be silently empty (owner decision 10 Aug 2026). Two mute vectors
 * existed: the per-member notification checkbox, and the club-wide delivery mode.
 * This path reads neither, and it falls back rather than sending to nobody.
 *
 * MUTATION PROOF. Read the notification preference here and "sends to the area's
 * editors even when every one of them has muted the category" fails. Drop the
 * Support & System fallback and "falls back to Support & System editors" fails;
 * drop the club-address fallback and "never resolves an empty recipient set"
 * fails; resolve that last rung from the `CLUB_SUPPORT_EMAIL` bootstrap constant
 * instead of the club's stored setting and "sends the last resort to the club's
 * CONFIGURED address" fails. Consult the delivery policy and "does not consult the
 * club-wide delivery policy" fails. Stop escalating and "escalates when not one
 * recipient received it" fails.
 */
describe("unmuteable admin alerts (#2761)", () => {
  beforeEach(() => {
    // The real escalation writer is async, and the send path attaches a `.catch`
    // to it so a failed audit entry cannot take the alert down with it.
    mocks.recordEscalation.mockResolvedValue(undefined);
    // A club that HAS configured its support address, so the last-resort rung is
    // distinguishable from the frozen unconfigured-club literal.
    mocks.emailMessageSettingFindUnique.mockResolvedValue({
      supportEmail: CONFIGURED_CLUB_SUPPORT_EMAIL,
    });
  });

  async function sendAlert(candidates: Candidate[]) {
    mocks.findMany.mockResolvedValue(candidates);
    await sendUnmuteableAdminAlert({
      subject: "Payment refunded automatically — booking already deleted: X",
      html: "<p>alert</p>",
      templateName: "admin-late-capture-auto-refund",
      requirement: { area: "finance", level: "edit" },
    });
    return mocks.sendEmail.mock.calls.map((call) => call[0].to as string).sort();
  }

  const mutedTeam: Candidate[] = [
    // Every finance editor has switched payment-failure alerts OFF. Under
    // `sendToAdmins` that silences the mail; here it must not.
    enumRole("full.admin@club.test", "ADMIN", {
      notificationPreference: { adminPaymentFailure: false },
    }),
    enumRole("treasurer@club.test", "FINANCE_ADMIN", {
      notificationPreference: { adminPaymentFailure: false },
    }),
    enumRole("booking.officer@club.test", "ADMIN_BOOKINGS"),
  ];

  it("sends to the area's editors even when every one of them has muted the category", async () => {
    expect(await sendAlert(mutedTeam)).toEqual([
      "full.admin@club.test",
      "treasurer@club.test",
    ]);
  });

  it("still respects the permission matrix, which is an audience rule and not a mute", async () => {
    // A Booking Officer cannot action a refund and is not told about one. Making
    // the alert unmuteable does not widen who sees the club's money.
    expect(await sendAlert(mutedTeam)).not.toContain(
      "booking.officer@club.test",
    );
  });

  it("falls back to Support & System editors when nobody can edit finance", async () => {
    // A club can genuinely reach this: the one member holding finance edit was
    // deactivated, or a custom role set lost the area.
    const emails = await sendAlert([
      definitionRole("deputy@club.test", { supportLevel: "EDIT" }),
    ]);

    expect(emails).toEqual(["deputy@club.test"]);
    expect(mocks.logger.warn).toHaveBeenCalled();
  });

  it("never resolves an empty recipient set, even with no admins at all", async () => {
    // "No recipients" is not a state this alert can reach.
    expect(await sendAlert([])).toEqual([CONFIGURED_CLUB_SUPPORT_EMAIL]);
  });

  it("sends the last resort to the club's CONFIGURED address, not the unconfigured-club literal", async () => {
    /*
      The bug this pins (found in review of #2761): the fallback used to be the
      constant `CLUB_SUPPORT_EMAIL`, which is `SAFE_DEFAULT_CONFIG.supportEmail` —
      the frozen documentation-domain literal `support@example.org`, NOT the address
      the club typed into /admin/email-messages. SES accepts that address and
      bounces it asynchronously, so `sendEmail` reports "sent", the undeliverable
      escalation below never fires, and the alert vanishes in exactly the state the
      fallback exists for. Asserting a CONFIGURED address distinct from the literal
      is what makes reverting to the constant fail.
    */
    expect(CONFIGURED_CLUB_SUPPORT_EMAIL).not.toBe(CLUB_SUPPORT_EMAIL);
    expect(await sendAlert([])).toEqual([CONFIGURED_CLUB_SUPPORT_EMAIL]);
    expect(mocks.emailMessageSettingFindUnique).toHaveBeenCalled();
  });

  it("still mails exactly one recipient when the stored support address is unreadable", async () => {
    /*
      The fallback runs in a state where things are already going wrong, so a
      settings read that fails must not turn "nobody holds finance edit" into "no
      mail at all". The loader degrades to the config-derived default rather than
      throwing, and the guarantee under test is the count: never zero.
    */
    mocks.emailMessageSettingFindUnique.mockRejectedValueOnce(
      new Error("settings table unreachable"),
    );

    const emails = await sendAlert([]);
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatch(/@/);
  });

  it("does not consult the club-wide delivery policy", async () => {
    /*
      Every template sent this way is delivery-locked, so the notification-rules
      route refuses to change its mode — but `shouldSendAdminSystemEmail` reads
      whatever row is in the table regardless of the lock, so consulting it would
      leave one more way to mute an automatic money movement. The fail-closed
      withhold alert in email/core.ts takes the same direct route.
    */
    mocks.shouldSendAdminSystemEmail.mockResolvedValue({
      send: false,
      mode: "disabled",
      reason: "disabled",
    });

    expect(await sendAlert([enumRole("full.admin@club.test", "ADMIN")])).toEqual(
      ["full.admin@club.test"],
    );
    expect(mocks.shouldSendAdminSystemEmail).not.toHaveBeenCalled();
  });

  it("escalates when not one recipient received it", async () => {
    // Suppressed or failed for everybody is the state where the club believes it
    // was told and was not.
    mocks.sendEmail.mockResolvedValue({ status: "suppressed" });

    await sendAlert([enumRole("full.admin@club.test", "ADMIN")]);

    expect(mocks.recordEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        templateName: "admin-late-capture-auto-refund",
        preferenceKey: "none (delivery-locked)",
      }),
    );
  });

  it("does not escalate when somebody was reached", async () => {
    await sendAlert([enumRole("full.admin@club.test", "ADMIN")]);

    expect(mocks.recordEscalation).not.toHaveBeenCalled();
  });

  it("one recipient's failure does not stop the others", async () => {
    mocks.sendEmail
      .mockRejectedValueOnce(new Error("smtp down"))
      .mockResolvedValue({ status: "sent" });

    const emails = await sendAlert([
      enumRole("full.admin@club.test", "ADMIN"),
      enumRole("treasurer@club.test", "FINANCE_ADMIN"),
    ]);

    expect(emails).toHaveLength(2);
    expect(mocks.recordEscalation).not.toHaveBeenCalled();
  });
});

describe("getAdminEmails system-failure audience (#2548)", () => {
  it("resolves Support & System editors, which always includes Full Admins", async () => {
    mocks.findMany.mockResolvedValue([
      enumRole("full.admin@club.test", "ADMIN"),
      enumRole("booking.officer@club.test", "ADMIN_BOOKINGS"),
      enumRole("treasurer@club.test", "FINANCE_ADMIN"),
      definitionRole("deputy@club.test", { supportLevel: "EDIT" }),
    ]);
    expect(await getAdminEmails()).toEqual([
      "full.admin@club.test",
      "deputy@club.test",
    ]);
  });
});
