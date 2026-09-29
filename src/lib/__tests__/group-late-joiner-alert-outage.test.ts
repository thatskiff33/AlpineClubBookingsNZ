import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #3672 (delta review D1): the treasurer's mid-stay alert through a mail
 * outage. The claim, `sendToAdmins` and the sender are the real ones; only the
 * mailer, its EmailLog and the database are fakes. While SMTP is down every
 * send throws and leaves a FAILED row for the email retry cron. The claim must
 * be kept on that, so later reaper runs send nothing new and, once SMTP is
 * back, the retry cron's replay is each admin's one and only copy. Giving the
 * claim back on a queued failure sent a fresh copy on every run of the outage.
 */

type Row = { to: string; status: "SENT" | "FAILED" };

const h = vi.hoisted(() => ({
  smtpUp: false,
  emailLog: [] as Array<{ to: string; status: "SENT" | "FAILED" }>,
  cooldown: new Map<string, Date>(),
}));

vi.mock("@/lib/email/core", () => ({
  sendEmail: vi.fn(async ({ to }: { to: string }) => {
    if (!h.smtpUp) {
      h.emailLog.push({ to, status: "FAILED" });
      throw new Error("SMTP down");
    }
    h.emailLog.push({ to, status: "SENT" });
    return { status: "sent", emailLogId: null, messageId: null };
  }),
}));

type CooldownWhere = { key: string; lastAlertedAt?: Date | { lt: Date } };
function cooldownMatches(where: CooldownWhere): string[] {
  const at = h.cooldown.get(where.key);
  if (!at) return [];
  const filter = where.lastAlertedAt;
  if (filter === undefined) return [where.key];
  if (filter instanceof Date) return at.getTime() === filter.getTime() ? [where.key] : [];
  return at.getTime() < filter.lt.getTime() ? [where.key] : [];
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    alertCooldown: {
      updateMany: vi.fn(async ({ where, data }: { where: CooldownWhere; data: { lastAlertedAt: Date } }) => {
        const hits = cooldownMatches(where);
        for (const key of hits) h.cooldown.set(key, data.lastAlertedAt);
        return { count: hits.length };
      }),
      create: vi.fn(async ({ data }: { data: { key: string; lastAlertedAt: Date } }) => {
        if (h.cooldown.has(data.key)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        h.cooldown.set(data.key, data.lastAlertedAt);
        return data;
      }),
      deleteMany: vi.fn(async ({ where }: { where: CooldownWhere }) => {
        const hits = cooldownMatches(where);
        for (const key of hits) h.cooldown.delete(key);
        return { count: hits.length };
      }),
    },
    booking: {
      findMany: vi.fn(async () => [
        { id: "past-1", memberId: "m1", member: { firstName: "Pat", lastName: "Past" }, organisation: null },
      ]),
    },
    member: {
      findMany: vi.fn(async () =>
        ["a@club.test", "b@club.test"].map((email) => ({
          email,
          canLogin: true,
          accessRoles: [{ role: "FINANCE_ADMIN", roleDefinitionId: null, roleDefinition: null }],
          notificationPreference: null,
        }))
      ),
    },
  },
}));
vi.mock("@/lib/email", async () => ({
  ...(await vi.importActual<Record<string, unknown>>(
    "@/lib/email/admin-alerts-group-joiner-started-stay"
  )),
  sendGroupJoinPaySelfEmail: vi.fn(),
}));
vi.mock("@/lib/email-templates/admin-group-joiner-started-stay", () => ({
  adminGroupJoinerStartedStayTemplate: () => "<p>alert</p>",
}));
vi.mock("@/lib/email-theme", () => ({
  renderEmailHtml: async (render: () => string) => render(),
}));
vi.mock("@/lib/email-templates-club-time", () => ({ emailCalendarDay: () => "1 July 2026" }));
vi.mock("@/lib/notification-delivery-policies", () => ({
  shouldSendAdminSystemEmail: vi.fn(async () => ({ send: true, mode: "always" })),
}));
vi.mock("@/lib/email-admin-alert-escalation", () => ({
  recordAdminAlertDeliveryEscalation: vi.fn(async () => undefined),
}));
vi.mock("@/lib/club-time-zone-runtime", () => ({
  readClubTimeZoneOutsideRequest: vi.fn(async () => "Pacific/Auckland"),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { alertStartedStayJoinersOnce } from "@/lib/group-late-joiner";

const GROUP = {
  groupBookingId: "g1",
  organiserBookingId: "org-g1",
  organiser: { firstName: "Olive", lastName: "Organiser" },
  checkIn: new Date("2026-06-30T00:00:00.000Z"),
};
const HOUR = 3_600_000;
const START = new Date("2026-07-01T00:00:00.000Z").getTime();

/** One reaper run, `hours` after the first. */
function reaperRun(hours: number) {
  vi.setSystemTime(new Date(START + hours * HOUR));
  return alertStartedStayJoinersOnce(GROUP, ["past-1"]);
}

/** The email retry cron: re-send every FAILED row while SMTP is up. */
function emailRetryCron() {
  for (const row of h.emailLog as Row[]) {
    if (row.status === "FAILED" && h.smtpUp) row.status = "SENT";
  }
}

function copiesDelivered(to: string) {
  return h.emailLog.filter((row) => row.to === to && row.status === "SENT").length;
}

beforeEach(() => {
  h.smtpUp = false;
  h.emailLog.length = 0;
  h.cooldown.clear();
});
afterEach(() => {
  vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
});

describe("the mid-stay joiner alert through a mail outage (#3672)", () => {
  it("delivers exactly one copy per admin once the retry cron recovers it", async () => {
    // SMTP is down for three reaper runs: the first queues a copy per admin
    // for the retry cron and keeps the claim, so the other two send nothing.
    await expect(reaperRun(0)).resolves.toBe(true);
    await expect(reaperRun(1)).resolves.toBe(false);
    await expect(reaperRun(2)).resolves.toBe(false);
    expect(h.emailLog).toEqual([
      { to: "a@club.test", status: "FAILED" },
      { to: "b@club.test", status: "FAILED" },
    ]);

    // SMTP recovers: the retry cron replays the queued copies, and the next
    // reaper run still sends nothing new.
    h.smtpUp = true;
    emailRetryCron();
    await expect(reaperRun(3)).resolves.toBe(false);

    expect(copiesDelivered("a@club.test")).toBe(1);
    expect(copiesDelivered("b@club.test")).toBe(1);
    expect(h.emailLog).toHaveLength(2);
  });
});
