import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmailLogStatus } from "@prisma/client";
import type { EmailComplaintReplayAlert } from "@/lib/admin-alert-once-replayable";

/*
  #5469: what one bounce or complaint report does, through the SES adapter and
  the one rule (`email/delivery-feedback.ts`, INV-INT-043).
  - A bounce marks only the email the report names: by the stored server id,
    or, for a row with no stored id, by the Message-ID header the app sent
    (owner decision, option A, 27 Nov 2026).
  - A complaint marks nothing and alerts officers once per report (D3, D6).
  - A "not spam" report changes nothing (D5).
  - The suppression record, not a status rewrite, stops anything pending.

  The store below stands in for the tables the rule writes. Its filters honour
  every field they are given, the address included, so a rule that went back
  to matching on the address would mark the other rows here and fail; like
  Prisma, it treats an `undefined` filter as no filter, and it honours
  `orderBy: { createdAt: "desc" }`. The stored, replayable once-ever alert is
  faked as its contract says (`admin-alert-once-replayable.ts`): the alert is
  stored as owed first; the claim is kept when an admin got it, held for the
  day when nobody could, and left unclaimed when the send threw, for the sweep.
*/

type Row = {
  id: string;
  to: string;
  templateName: string;
  status: EmailLogStatus;
  messageId: string | null;
  providerMessageId: string | null;
  errorMessage: string | null;
  attempts: number;
  lastAttemptAt: Date;
  sentAt: Date | null;
  createdAt: Date;
  htmlBody: string | null;
  bookingRetryHtmlBody: string | null;
};

type Suppression = {
  id: string;
  email: string;
  reason: string;
  eventCount: number;
  suppressedAt: Date | null;
  clearedAt: Date | null;
  lastEventType: string;
  lastSesMessageId: string | null;
  [key: string]: unknown;
};

type OwedAlert = EmailComplaintReplayAlert;

const store = vi.hoisted(() => ({
  rows: [] as Row[],
  suppressions: [] as Suppression[],
  members: [] as Array<{ email: string; firstName: string; lastName: string }>,
  claims: new Map<string, "kept" | "deferred">(),
  owed: new Map<string, OwedAlert>(),
}));

function matches(row: Record<string, unknown>, where: Record<string, unknown>) {
  return Object.entries(where).every(([key, condition]) => {
    if (condition === undefined) return true;
    const value = row[key];
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      const filter = condition as { in?: unknown[]; not?: unknown; equals?: string; mode?: string };
      if ("in" in filter) return (filter.in ?? []).includes(value);
      if ("not" in filter) return value !== filter.not;
      if ("equals" in filter) return String(value).toLowerCase() === String(filter.equals).toLowerCase();
    }
    return value === condition;
  });
}

const mocks = vi.hoisted(() => ({
  emailLog: { updateMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
  emailSuppression: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  member: { findMany: vi.fn(), count: vi.fn() },
  sendToAdmins: vi.fn(),
  getAdminAlertEmails: vi.fn(),
  shouldSendAdminSystemEmail: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { emailLog: mocks.emailLog, emailSuppression: mocks.emailSuppression, member: mocks.member },
}));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/admin-alert-once-replayable", () => ({
  sendReplayableAdminAlertOnceEver: async ({ key, alert }: { key: string; alert: OwedAlert }) => {
    if (store.claims.has(key)) return false;
    store.owed.set(key, alert);
    return sendOwed(key);
  },
}));
vi.mock("@/lib/email/admin-alerts-shared", () => ({
  sendToAdmins: mocks.sendToAdmins,
  getAdminAlertEmails: mocks.getAdminAlertEmails,
}));
vi.mock("@/lib/notification-delivery-policies", () => ({ shouldSendAdminSystemEmail: mocks.shouldSendAdminSystemEmail }));
vi.mock("@/lib/email-theme", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  renderEmailHtml: async () => "<html>alert</html>",
}));
vi.mock("@/lib/email-templates-club-time", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  emailClubDateTime: (value: Date) => `at ${value.toISOString()}`,
}));
vi.mock("@/lib/app-url", () => ({ getAppBaseUrl: () => "https://club.example.test" }));

import { ingestSesSnsEmailFeedback } from "@/lib/email/ses-feedback";
import { sendAdminEmailComplaintAlert } from "@/lib/email/admin-alerts-email-complaint";
import { getActiveEmailSuppression } from "@/lib/email-suppression";
import { isToldKeyedEmailState, keyedEmailRowState } from "@/lib/email/keyed-email-state";

/** One attempt at an owed alert, under its claim, as the replayable helper and the sweep make it. */
async function sendOwed(key: string): Promise<boolean> {
  const alert = store.owed.get(key)!;
  try {
    const result = await sendAdminEmailComplaintAlert(alert);
    if (result.sent + result.queuedForRetry > 0) {
      store.claims.set(key, "kept");
      store.owed.delete(key);
      return true;
    }
    store.claims.set(key, "deferred");
    return false;
  } catch {
    return false; // claim given back; the owed alert stays for the sweep
  }
}

/** The payments cron's sweep: re-send each owed alert no claim holds. */
async function sweep() {
  for (const key of [...store.owed.keys()]) if (!store.claims.has(key)) await sendOwed(key);
}

const MEMBER = "member@example.test";
const SECOND = "second@example.test";
const OTHER = "someone-else@example.test";
const SENT_AT = new Date("2026-06-20T00:00:00.000Z");

function row(overrides: Partial<Row> & Pick<Row, "id">): Row {
  return {
    to: MEMBER,
    templateName: "booking-confirmed",
    status: EmailLogStatus.SENT,
    messageId: null,
    providerMessageId: null,
    errorMessage: null,
    attempts: 1,
    lastAttemptAt: SENT_AT,
    sentAt: SENT_AT,
    createdAt: SENT_AT,
    htmlBody: null,
    bookingRetryHtmlBody: null,
    ...overrides,
  };
}

function seedRows() {
  store.rows = [
    // Sent by this release: SES's id stored.
    row({ id: "named", messageId: "<named-1@club.example.test>", providerMessageId: "0100-aaa1-000000" }),
    // Sent before #5469 (or by the previous release): no stored id.
    row({ id: "legacy", messageId: "<legacy-1@club.example.test>" }),
    // The member's waitlist offer email, delivered.
    row({ id: "offer", templateName: "waitlist-offer", messageId: "<offer-1@club.example.test>", providerMessageId: "0100-bbb2-000000" }),
    // A send that failed and waits for the retry job.
    row({ id: "pending", status: EmailLogStatus.FAILED, sentAt: null, htmlBody: "<p>retry me</p>", errorMessage: "SMTP timeout" }),
    // Another address's email.
    row({ id: "other", to: OTHER, messageId: "<other-1@club.example.test>", providerMessageId: "0100-ccc3-000000" }),
  ];
}

const byId = (id: string) => store.rows.find((entry) => entry.id === id)!;
const statuses = () => Object.fromEntries(store.rows.map((entry) => [entry.id, entry.status]));
const UNCHANGED = {
  named: EmailLogStatus.SENT,
  legacy: EmailLogStatus.SENT,
  offer: EmailLogStatus.SENT,
  pending: EmailLogStatus.FAILED,
  other: EmailLogStatus.SENT,
};
const alertData = (call = 0) => mocks.sendToAdmins.mock.calls[call]?.[0].templateData;

/** SES's `mail` object: its own id, and the original headers only when the identity includes them. */
const mail = (messageId: string | undefined, headerMessageId?: string) => ({
  messageId,
  destination: [MEMBER],
  ...(headerMessageId ? { headers: [{ name: "Message-ID", value: headerMessageId }] } : {}),
});

const hardBounce = (m: Record<string, unknown>) => ({
  notificationType: "Bounce",
  mail: m,
  bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: MEMBER }], feedbackId: "fb-bounce-1" },
});
const transientBounce = (m: Record<string, unknown>) => ({
  notificationType: "Bounce",
  mail: m,
  bounce: { bounceType: "Transient", bounceSubType: "MailboxFull", bouncedRecipients: [{ emailAddress: MEMBER }], feedbackId: "fb-bounce-2" },
});
const complaint = (
  m: Record<string, unknown>,
  { feedbackId = "fb-complaint-1", type = "abuse" as string | null, recipients = [MEMBER] } = {},
) => ({
  notificationType: "Complaint",
  mail: m,
  complaint: {
    ...(type === null ? {} : { complaintFeedbackType: type }), // null: the report gives no type
    complainedRecipients: recipients.map((emailAddress) => ({ emailAddress })),
    feedbackId,
  },
});

const DELIVERED = { deliveryAllowed: true, recipients: 1, sent: 1, queuedForRetry: 0, notDelivered: 0, failedBeforeLogged: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  seedRows();
  store.suppressions = [];
  store.members = [{ email: "Member@Example.test", firstName: "Sam", lastName: "Member" }];
  store.claims = new Map();
  store.owed = new Map();
  mocks.sendToAdmins.mockResolvedValue(DELIVERED);
  mocks.getAdminAlertEmails.mockResolvedValue(["officer@club.example.test"]);
  mocks.shouldSendAdminSystemEmail.mockResolvedValue({ send: true, mode: "always" });

  mocks.emailLog.updateMany.mockImplementation(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
    const hit = store.rows.filter((entry) => matches(entry, where));
    for (const entry of hit) Object.assign(entry, data);
    return { count: hit.length };
  });
  mocks.emailLog.findFirst.mockImplementation(
    async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: { createdAt?: "asc" | "desc" } }) => {
      const hits = store.rows.filter((entry) => matches(entry, where));
      if (orderBy?.createdAt) {
        const sign = orderBy.createdAt === "desc" ? -1 : 1;
        hits.sort((a, b) => sign * (a.createdAt.getTime() - b.createdAt.getTime()));
      }
      return hits[0] ?? null;
    },
  );
  mocks.emailLog.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    store.rows.find((entry) => entry.id === where.id) ?? null,
  );
  mocks.member.findMany.mockImplementation(async ({ where, take }: { where: Record<string, unknown>; take?: number }) =>
    store.members.filter((entry) => matches(entry, where)).slice(0, take),
  );
  mocks.member.count.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    store.members.filter((entry) => matches(entry, where)).length,
  );
  mocks.emailSuppression.findUnique.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    store.suppressions.find((entry) => matches(entry, where)) ?? null,
  );
  mocks.emailSuppression.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    store.suppressions.find((entry) => matches(entry, where)) ?? null,
  );
  mocks.emailSuppression.create.mockImplementation(async ({ data }: { data: Suppression }) => {
    const created = { ...data, id: `sup-${store.suppressions.length + 1}` };
    store.suppressions.push(created);
    return created;
  });
  mocks.emailSuppression.update.mockImplementation(async ({ where, data }: { where: { email: string }; data: Partial<Suppression> }) => {
    const existing = store.suppressions.find((entry) => entry.email === where.email)!;
    Object.assign(existing, data);
    return existing;
  });
});

describe("a bounce marks only the email it names (#5469)", () => {
  it("MUTATION: matches the stored server id with no original headers in the report", async () => {
    const result = await ingestSesSnsEmailFeedback(hardBounce(mail("0100-AAA1-000000")));

    expect(result).toMatchObject({ handled: true, notificationType: "bounce", emailLogsMarked: 1 });
    expect(statuses()).toEqual({ ...UNCHANGED, named: EmailLogStatus.BOUNCED });
    expect(byId("named").errorMessage).toBe("Permanent bounce reported by AWS SES");
    expect(byId("pending").errorMessage).toBe("SMTP timeout");
  });

  it("MUTATION: falls back to the Message-ID header for a row with no stored id", async () => {
    await ingestSesSnsEmailFeedback(hardBounce(mail("0100-dddd-000000", "<legacy-1@club.example.test>")));

    expect(statuses()).toEqual({ ...UNCHANGED, legacy: EmailLogStatus.BOUNCED });
  });

  it("MUTATION: a row with a stored id is found by that id, not by its header", async () => {
    await ingestSesSnsEmailFeedback(hardBounce(mail("0100-eeee-000000", "<named-1@club.example.test>")));

    expect(statuses()).toEqual(UNCHANGED);
  });

  it("MUTATION: the header fallback reads the common headers, with or without angle brackets", async () => {
    await ingestSesSnsEmailFeedback(
      hardBounce({ messageId: "0100-dddd-000000", commonHeaders: { messageId: " legacy-1@club.example.test" } }),
    );

    expect(statuses()).toEqual({ ...UNCHANGED, legacy: EmailLogStatus.BOUNCED });
  });

  it("MUTATION: a bracketed header id finds a row stored without brackets", async () => {
    byId("legacy").messageId = "legacy-1@club.example.test";

    await ingestSesSnsEmailFeedback(hardBounce(mail("0100-dddd-000000", "<legacy-1@club.example.test>")));

    expect(statuses()).toEqual({ ...UNCHANGED, legacy: EmailLogStatus.BOUNCED });
  });

  it("a temporary bounce follows the same rule as a hard bounce, and does not block on the first", async () => {
    await ingestSesSnsEmailFeedback(transientBounce(mail("0100-aaa1-000000")));

    expect(statuses()).toEqual({ ...UNCHANGED, named: EmailLogStatus.BOUNCED });
    expect(byId("named").errorMessage).toBe("Temporary bounce reported by AWS SES");
    await expect(getActiveEmailSuppression(MEMBER)).resolves.toBeNull();
  });

  it.each([
    ["names no message at all", { destination: [MEMBER] }],
    ["carries only blank ids", { messageId: "  ", destination: [MEMBER], headers: [{ name: "Message-ID", value: " <> " }] }],
    ["names a message no row stores", mail("0100-ffff-000000")],
  ])("MUTATION: a bounce that %s marks nothing and still suppresses", async (_label, m) => {
    const result = await ingestSesSnsEmailFeedback(hardBounce(m));

    expect(result).toMatchObject({ handled: true, emailLogsMarked: 0, suppressionsActive: 1 });
    expect(statuses()).toEqual(UNCHANGED);
    await expect(getActiveEmailSuppression(MEMBER)).resolves.toMatchObject({ reason: "BOUNCE" });
  });

  it("a pending row to the address is not rewritten, and the suppression the senders check stops it", async () => {
    await ingestSesSnsEmailFeedback(hardBounce(mail("0100-aaa1-000000")));

    expect(byId("pending")).toMatchObject({ status: EmailLogStatus.FAILED, htmlBody: "<p>retry me</p>" });
    // `getActiveEmailSuppression` is what the email core and the retry job ask
    // before every send; the retry job then skips the row and writes it
    // BOUNCED (`cron-email-retry.test.ts`, F26), and the email core refuses a
    // new send (`phase6a-notifications.test.ts`).
    await expect(getActiveEmailSuppression(MEMBER)).resolves.toMatchObject({
      email: MEMBER,
      reason: "BOUNCE",
      suppressedAt: expect.any(Date),
      clearedAt: null,
    });
  });

  it("MUTATION: handling the same bounce twice changes nothing the second time", async () => {
    const notification = transientBounce(mail("0100-aaa1-000000"));
    const first = await ingestSesSnsEmailFeedback(notification);
    const rowsAfterFirst = structuredClone(store.rows);
    const suppressionsAfterFirst = structuredClone(store.suppressions);

    const second = await ingestSesSnsEmailFeedback(notification);

    expect(first).toMatchObject({ emailLogsMarked: 1 });
    expect(second).toMatchObject({ emailLogsMarked: 0 });
    expect(store.rows).toEqual(rowsAfterFirst);
    expect(store.suppressions).toEqual(suppressionsAfterFirst);
    expect(store.suppressions[0]).toMatchObject({ eventCount: 1, suppressedAt: null });
  });

  it("the newest of two rows with one header id is the one a complaint names", async () => {
    store.rows.push(row({ id: "legacy-newer", messageId: "<legacy-1@club.example.test>", templateName: "waitlist-offer", createdAt: new Date("2026-06-25T00:00:00.000Z"), sentAt: new Date("2026-06-25T00:00:00.000Z") }));

    await ingestSesSnsEmailFeedback(complaint(mail("0100-dddd-000000", "<legacy-1@club.example.test>")));

    expect(alertData().emailNote).toBe("Waitlist Offer, sent at 2026-06-25T00:00:00.000Z");
  });
});

describe("a complaint marks nothing and alerts officers once per report (#5469, D3, D4, D6)", () => {
  it("MUTATION: keeps the email recorded as sent, suppresses the address, and alerts once across a redelivery", async () => {
    const notification = complaint(mail("0100-aaa1-000000"));

    const first = await ingestSesSnsEmailFeedback(notification);
    const second = await ingestSesSnsEmailFeedback(notification);

    expect(first).toMatchObject({ handled: true, notificationType: "complaint", emailLogsMarked: 0, suppressionsActive: 1 });
    expect(second).toMatchObject({ emailLogsMarked: 0 });
    expect(statuses()).toEqual(UNCHANGED);
    await expect(getActiveEmailSuppression(MEMBER)).resolves.toMatchObject({ reason: "COMPLAINT" });
    expect(mocks.sendToAdmins).toHaveBeenCalledTimes(1);
    expect(mocks.sendToAdmins).toHaveBeenCalledWith(
      expect.objectContaining({
        templateName: "admin-email-complaint",
        preferenceKey: "adminIssueReport",
        subject: `Complaint about a club email: ${MEMBER}`,
        templateData: expect.objectContaining({
          recipientEmail: MEMBER,
          complaintType: "Marked as spam or abuse",
          memberNames: "Sam Member",
          emailNote: `Booking Confirmed, sent at ${SENT_AT.toISOString()}`,
          blockNote: expect.stringContaining("none of its own emails"),
          deliverabilityUrl: expect.stringMatching(/^https:\/\/club\.example\.test\/admin\/.*email-deliverability$/),
        }),
      }),
    );
  });

  it("MUTATION: the once-only key holds the suppression row and the report, never the address", async () => {
    mocks.sendToAdmins.mockRejectedValueOnce(new Error("transport down"));

    await ingestSesSnsEmailFeedback(complaint(mail("0100-aaa1-000000")));

    expect([...store.owed.keys()]).toEqual(["email-complaint:sup-1:fb-complaint-1"]);
    expect(JSON.stringify([...store.owed.entries()])).not.toContain("@");
  });

  it("names the email by its header for a row with no stored id", async () => {
    await ingestSesSnsEmailFeedback(complaint(mail("0100-dddd-000000", "<legacy-1@club.example.test>")));

    expect(statuses()).toEqual(UNCHANGED);
    expect(alertData().emailNote).toBe(`Booking Confirmed, sent at ${SENT_AT.toISOString()}`);
  });

  it("says when the report matches no email and the address belongs to no member", async () => {
    store.members = [];

    await ingestSesSnsEmailFeedback(complaint(mail("0100-ffff-000000")));

    expect(alertData()).toMatchObject({
      memberNames: "None: no member record uses this address",
      emailNote: "The app could not tell which email the complaint was about.",
    });
  });

  it("MUTATION: names five members and counts the rest", async () => {
    store.members = ["Ada", "Ben", "Cal", "Dee", "Eve", "Fay", "Gus"].map((firstName) => ({ email: MEMBER, firstName, lastName: "Member" }));

    await ingestSesSnsEmailFeedback(complaint(mail("0100-aaa1-000000")));

    expect(alertData().memberNames).toBe("Ada Member, Ben Member, Cal Member, Dee Member, Eve Member and 2 more");
  });

  it.each([
    ["fraud", "Reported as fraud or phishing"],
    ["virus", "Reported as carrying a virus"],
    ["auth-failure", "Reported as failing email authentication checks"],
    ["other", "Another kind of complaint"],
    ["something-new", "Not given by the mail service"],
    [null, "Not given by the mail service"],
  ])("MUTATION: a complaint of type %s blocks and alerts, with its type in plain words", async (type, label) => {
    await ingestSesSnsEmailFeedback(complaint(mail("0100-aaa1-000000"), { type }));

    await expect(getActiveEmailSuppression(MEMBER)).resolves.toMatchObject({ reason: "COMPLAINT" });
    expect(alertData().complaintType).toBe(label);
  });

  it("MUTATION: a complaint naming several addresses blocks each and alerts once for each", async () => {
    await ingestSesSnsEmailFeedback(complaint(mail("0100-aaa1-000000"), { recipients: [MEMBER, SECOND] }));

    await expect(getActiveEmailSuppression(MEMBER)).resolves.toMatchObject({ reason: "COMPLAINT" });
    await expect(getActiveEmailSuppression(SECOND)).resolves.toMatchObject({ reason: "COMPLAINT" });
    expect(mocks.sendToAdmins.mock.calls.map((call) => call[0].templateData.recipientEmail)).toEqual([MEMBER, SECOND]);
  });

  it("MUTATION: an alert whose send failed is not lost: the sweep sends it once, and a redelivery adds nothing", async () => {
    mocks.sendToAdmins.mockRejectedValueOnce(new Error("mail transport down"));
    const notification = complaint(mail("0100-aaa1-000000"));

    await expect(ingestSesSnsEmailFeedback(notification)).resolves.toMatchObject({ handled: true });
    await expect(getActiveEmailSuppression(MEMBER)).resolves.toMatchObject({ reason: "COMPLAINT" });
    expect(store.owed.size).toBe(1);

    await sweep();
    await ingestSesSnsEmailFeedback(notification);
    await sweep();

    expect(mocks.sendToAdmins).toHaveBeenCalledTimes(2);
    expect(store.claims.get("email-complaint:sup-1:fb-complaint-1")).toBe("kept");
    expect(store.owed.size).toBe(0);
  });

  it.each([
    ["the template is muted", () => mocks.shouldSendAdminSystemEmail.mockResolvedValue({ send: false, mode: "disabled" })],
    ["nobody receives Reported issues", () => mocks.getAdminAlertEmails.mockResolvedValue([])],
  ])("MUTATION: raises nothing, and stores nothing, when %s", async (_label, arrange) => {
    arrange();

    await ingestSesSnsEmailFeedback(complaint(mail("0100-aaa1-000000")));

    expect(store.owed.size).toBe(0);
    expect(mocks.sendToAdmins).not.toHaveBeenCalled();
    await expect(getActiveEmailSuppression(MEMBER)).resolves.toMatchObject({ reason: "COMPLAINT" });
  });

  it("MUTATION: sends no alert when the address is not blocked", async () => {
    mocks.emailSuppression.findFirst.mockResolvedValue(null);

    await ingestSesSnsEmailFeedback(complaint(mail("0100-aaa1-000000")));

    expect(mocks.sendToAdmins).not.toHaveBeenCalled();
  });

  it("MUTATION: a stored alert is not sent once the block has been lifted", async () => {
    mocks.sendToAdmins.mockRejectedValueOnce(new Error("mail transport down"));
    await ingestSesSnsEmailFeedback(complaint(mail("0100-aaa1-000000")));
    store.suppressions[0]!.clearedAt = new Date("2026-07-01T00:00:00.000Z");

    await sweep();

    expect(mocks.sendToAdmins).toHaveBeenCalledTimes(1); // the failed first attempt only
  });

  it("two complaint reports are two alerts (D6)", async () => {
    await ingestSesSnsEmailFeedback(complaint(mail("0100-aaa1-000000"), { feedbackId: "fb-complaint-1" }));
    await ingestSesSnsEmailFeedback(complaint(mail("0100-bbb2-000000"), { feedbackId: "fb-complaint-2" }));

    expect(mocks.sendToAdmins).toHaveBeenCalledTimes(2);
  });
});

describe("a 'not spam' report changes nothing (#5469, D5)", () => {
  it("MUTATION: blocks nothing, marks nothing and alerts nobody", async () => {
    const result = await ingestSesSnsEmailFeedback(complaint(mail("0100-aaa1-000000"), { type: "not-spam" }));

    expect(result).toMatchObject({ handled: true, notificationType: "complaint", emailLogsMarked: 0, suppressionsActive: 0 });
    expect(statuses()).toEqual(UNCHANGED);
    expect(store.suppressions).toEqual([]);
    expect(mocks.sendToAdmins).not.toHaveBeenCalled();
  });
});

describe("whether a waitlisted member was told (#5469)", () => {
  const offerState = () => keyedEmailRowState(byId("offer"));

  it("a bounced offer email reads as not told", async () => {
    await ingestSesSnsEmailFeedback(hardBounce(mail("0100-bbb2-000000")));

    expect(offerState()).toBe("undeliverable");
    expect(isToldKeyedEmailState(offerState())).toBe(false);
  });

  it("an offer email the member marked as spam reads as told, and officers get the complaint alert", async () => {
    await ingestSesSnsEmailFeedback(complaint(mail("0100-bbb2-000000")));

    expect(offerState()).toBe("sent");
    expect(isToldKeyedEmailState(offerState())).toBe(true);
    expect(alertData().emailNote).toBe(`Waitlist Offer, sent at ${SENT_AT.toISOString()}`);
  });

  it.each([
    ["a complaint", (m: Record<string, unknown>) => complaint(m)],
    ["a temporary bounce", transientBounce],
    ["a hard bounce", hardBounce],
  ])("reads as told after %s on another email", async (_label, notification) => {
    await ingestSesSnsEmailFeedback(notification(mail("0100-aaa1-000000")));

    expect(offerState()).toBe("sent");
    expect(isToldKeyedEmailState(offerState())).toBe(true);
  });
});
