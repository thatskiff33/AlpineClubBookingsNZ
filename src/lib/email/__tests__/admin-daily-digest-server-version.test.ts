import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #49: the Daily digest's "central server version" entry and its TWO
 * audiences. The owner's decision is that the entry goes to the digest's own
 * readers AND to Lodge Operations editors, and that a Lodge-only recipient
 * must receive only the entry - never the cross-area alert counts (INV-PRIV
 * masking). That is the property under test: what each recipient is sent, in
 * the HTML's input and in `templateData`, which an admin override renders from.
 */

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  sendEmail: vi.fn(),
  shouldSendAdminSystemEmail: vi.fn(),
  recordEscalation: vi.fn(),
  template: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { member: { findMany: mocks.findMany } },
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));
vi.mock("@/lib/notification-delivery-policies", () => ({
  shouldSendAdminSystemEmail: mocks.shouldSendAdminSystemEmail,
}));
vi.mock("@/lib/email-admin-alert-escalation", () => ({
  recordAdminAlertDeliveryEscalation: mocks.recordEscalation,
}));
vi.mock("@/lib/email/core", () => ({ sendEmail: mocks.sendEmail }));
// The palette is read from the database; the render itself is pinned by the
// email-render-equivalence gate. Here the template's INPUT is the evidence.
vi.mock("@/lib/email-theme", () => ({
  renderEmailHtml: async (build: () => string) => build(),
}));
vi.mock("@/lib/email-templates/admin-ops", () => ({
  adminDailyDigestTemplate: mocks.template,
  adminIssueReportTemplate: vi.fn(),
  adminMaintenanceReportTemplate: vi.fn(),
}));

import { sendAdminDailyDigestAlert } from "@/lib/email/admin-alerts-ops";

const COUNTS = {
  newBookings: 2,
  paymentFailures: 0,
  capacityWarnings: 1,
  bookingsBumped: 0,
  pendingDeadlines: 0,
  xeroErrors: 0,
  totalAlerts: 3,
};
const COUNT_KEYS = Object.keys(COUNTS);
const VERSION = { expected: "2.0", server: "2.1" };

function enumRole(email: string, role: string) {
  return {
    email,
    canLogin: true,
    accessRoles: [{ role, roleDefinitionId: null, roleDefinition: null }],
    notificationPreference: null,
  };
}

/** A club-defined role holding Lodge Operations at edit and nothing else. */
function lodgeOnly(email: string) {
  return {
    email,
    canLogin: true,
    accessRoles: [
      {
        role: null,
        roleDefinitionId: "ardef_lodge",
        roleDefinition: {
          id: "ardef_lodge",
          overviewLevel: "NONE",
          bookingsLevel: "NONE",
          membershipLevel: "NONE",
          financeLevel: "NONE",
          lodgeLevel: "EDIT",
          contentLevel: "NONE",
          supportLevel: "NONE",
        },
      },
    ],
    notificationPreference: null,
  };
}

const TEAM = [
  enumRole("full.admin@club.test", "ADMIN"),
  lodgeOnly("hut.warden@club.test"),
  enumRole("treasurer@club.test", "FINANCE_ADMIN"),
];

function sendsTo(email: string) {
  return mocks.sendEmail.mock.calls
    .map((call) => call[0] as { to: string; templateName: string; templateData: Record<string, unknown>; html: string })
    .filter((call) => call.to === email);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMany.mockResolvedValue(TEAM);
  mocks.shouldSendAdminSystemEmail.mockResolvedValue({ send: true, mode: "content_only" });
  mocks.sendEmail.mockResolvedValue({ status: "sent" });
  mocks.template.mockImplementation((input: unknown) => JSON.stringify(input));
});

describe("sendAdminDailyDigestAlert without a version entry", () => {
  it("sends the digest to its own audience only and never resolves the lodge audience", async () => {
    await sendAdminDailyDigestAlert({ sections: COUNTS, serverVersion: null });

    expect(sendsTo("full.admin@club.test")).toHaveLength(1);
    expect(sendsTo("hut.warden@club.test")).toHaveLength(0);
    expect(sendsTo("treasurer@club.test")).toHaveLength(0);
    // One audience read: the entry is absent, so nobody else is looked up.
    expect(mocks.findMany).toHaveBeenCalledTimes(1);

    const [digest] = sendsTo("full.admin@club.test");
    expect(digest.templateName).toBe("admin-daily-digest");
    expect(mocks.template).toHaveBeenCalledWith(COUNTS);
    // The composed note is supplied EMPTY on an ordinary day, so a club's
    // override says nothing; the raw numbers are empty too.
    expect(digest.templateData).toMatchObject({
      count: 3,
      s: "s",
      serverVersionNote: "",
      serverVersionExpected: "",
      serverVersionActual: "",
    });
  });
});

describe("sendAdminDailyDigestAlert with a version entry", () => {
  it("gives a digest reader ONE email carrying the counts and the entry", async () => {
    await sendAdminDailyDigestAlert({ sections: COUNTS, serverVersion: VERSION });

    const sends = sendsTo("full.admin@club.test");
    expect(sends).toHaveLength(1);
    expect(mocks.template).toHaveBeenCalledWith({ ...COUNTS, serverVersion: VERSION });
    expect(sends[0].templateData).toMatchObject({
      ...COUNTS,
      serverVersionExpected: "2.0",
      serverVersionActual: "2.1",
    });
    expect(sends[0].templateData.serverVersionNote).toMatch(/built for server version 2\.0 and the server reports 2\.1/);
  });

  it("gives a Lodge-only editor the entry ALONE: no count key in the render input or templateData", async () => {
    await sendAdminDailyDigestAlert({ sections: COUNTS, serverVersion: VERSION });

    const sends = sendsTo("hut.warden@club.test");
    expect(sends).toHaveLength(1);
    const [send] = sends;
    // Same template name, so the club's delivery rules and override apply.
    expect(send.templateName).toBe("admin-daily-digest");
    // The render was given the entry and nothing else - not even a zero.
    expect(mocks.template).toHaveBeenCalledWith({ serverVersion: VERSION });
    const rendered = JSON.parse(send.html) as Record<string, unknown>;
    for (const key of COUNT_KEYS) expect(rendered).not.toHaveProperty(key);
    // And the override data carries exactly the three version tokens.
    expect(Object.keys(send.templateData).sort()).toEqual([
      "serverVersionActual",
      "serverVersionExpected",
      "serverVersionNote",
    ]);
    expect(send.templateData).not.toHaveProperty("totalAlerts");
    expect(send.templateData).not.toHaveProperty("count");
  });

  it("sends nothing to an officer who holds neither audience", async () => {
    await sendAdminDailyDigestAlert({ sections: COUNTS, serverVersion: VERSION });
    expect(sendsTo("treasurer@club.test")).toHaveLength(0);
  });

  it("sends a member in both audiences exactly one email, the full one", async () => {
    // A Booking Officer holds lodge:edit but not overview:edit, so they are
    // lodge-only; a Full Admin holds both and must not be mailed twice.
    mocks.findMany.mockResolvedValue([
      enumRole("full.admin@club.test", "ADMIN"),
      enumRole("booking.officer@club.test", "ADMIN_BOOKINGS"),
    ]);

    await sendAdminDailyDigestAlert({ sections: COUNTS, serverVersion: VERSION });

    expect(sendsTo("full.admin@club.test")).toHaveLength(1);
    expect(sendsTo("full.admin@club.test")[0].templateData).toHaveProperty("totalAlerts", 3);
    expect(sendsTo("booking.officer@club.test")).toHaveLength(1);
    expect(sendsTo("booking.officer@club.test")[0].templateData).not.toHaveProperty("totalAlerts");
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
  });

  it("respects a Lodge editor who switched the category off", async () => {
    mocks.findMany.mockResolvedValue([
      { ...lodgeOnly("hut.warden@club.test"), notificationPreference: { adminServerVersion: false } },
    ]);
    await sendAdminDailyDigestAlert({ sections: COUNTS, serverVersion: VERSION });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("sends nothing at all when the club has muted the digest", async () => {
    mocks.shouldSendAdminSystemEmail.mockResolvedValue({ send: false, mode: "disabled", reason: "disabled" });
    await sendAdminDailyDigestAlert({ sections: COUNTS, serverVersion: VERSION });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
});
