import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmailLogStatus } from "@prisma/client";

/*
  #5469 (owner decision, option A, 27 Nov 2026): a bounce or complaint marks as
  bounced only the email whose message id the notification names. Every other
  row to the address keeps its status, and the suppression record, not a status
  rewrite, is what stops anything still pending.

  The store below is an in-memory stand-in for the two tables the handler
  writes. Its `updateMany` honours every filter it is given, the address
  included, so a handler that went back to matching on the address would mark
  the other rows here and fail; and, like Prisma, it treats an `undefined`
  filter as no filter at all.
*/

type Row = {
  id: string;
  to: string;
  templateName: string;
  status: EmailLogStatus;
  messageId: string | null;
  errorMessage: string | null;
  attempts: number;
  lastAttemptAt: Date;
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

const store = vi.hoisted(() => ({
  rows: [] as Row[],
  suppressions: [] as Suppression[],
}));

function matches(row: Record<string, unknown>, where: Record<string, unknown>) {
  return Object.entries(where).every(([key, condition]) => {
    if (condition === undefined) return true;
    const value = row[key];
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      const filter = condition as { in?: unknown[]; not?: unknown };
      if ("in" in filter) return (filter.in ?? []).includes(value);
      if ("not" in filter) return value !== filter.not;
    }
    return value === condition;
  });
}

const prismaMock = vi.hoisted(() => ({
  emailLog: {
    updateMany: vi.fn(),
  },
  emailSuppression: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ingestSesSnsEmailFeedback } from "@/lib/email/ses-feedback";
import { getActiveEmailSuppression } from "@/lib/email-suppression";
import { isToldKeyedEmailState, keyedEmailRowState } from "@/lib/email/keyed-email-state";

const MEMBER = "member@example.test";
const OTHER = "someone-else@example.test";
const SENT_AT = new Date("2026-06-20T00:00:00.000Z");

function row(overrides: Partial<Row> & Pick<Row, "id">): Row {
  return {
    to: MEMBER,
    templateName: "booking-update",
    status: EmailLogStatus.SENT,
    messageId: null,
    errorMessage: null,
    attempts: 1,
    lastAttemptAt: SENT_AT,
    htmlBody: null,
    bookingRetryHtmlBody: null,
    ...overrides,
  };
}

function seedRows() {
  store.rows = [
    // The email the notification is about.
    row({ id: "named", messageId: "<named-1@club.example.test>" }),
    // The member's waitlist offer email, delivered earlier.
    row({ id: "offer", templateName: "waitlist-offer", messageId: "<offer-1@club.example.test>" }),
    // A send that failed and waits for the retry job: no message id yet.
    row({ id: "pending", status: EmailLogStatus.FAILED, htmlBody: "<p>retry me</p>", errorMessage: "SMTP timeout" }),
    // Another address's email.
    row({ id: "other", to: OTHER, messageId: "<other-1@club.example.test>" }),
  ];
}

const byId = (id: string) => store.rows.find((entry) => entry.id === id)!;
const statuses = () => Object.fromEntries(store.rows.map((entry) => [entry.id, entry.status]));

// What SES sends with the original headers included: its own id in
// `mail.messageId`, and the Message-ID we sent among the headers.
function namedMail(extra: Record<string, unknown> = {}) {
  return {
    messageId: "0100018c-ses-assigned-000000",
    destination: [MEMBER],
    headers: [
      { name: "From", value: "Club <club@example.test>" },
      { name: "Message-ID", value: "<named-1@club.example.test>" },
    ],
    ...extra,
  };
}

const hardBounce = (mail: Record<string, unknown>) => ({
  notificationType: "Bounce",
  mail,
  bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: MEMBER }] },
});
const transientBounce = (mail: Record<string, unknown>) => ({
  notificationType: "Bounce",
  mail,
  bounce: { bounceType: "Transient", bounceSubType: "MailboxFull", bouncedRecipients: [{ emailAddress: MEMBER }] },
});
const complaint = (mail: Record<string, unknown>) => ({
  notificationType: "Complaint",
  mail,
  complaint: { complaintFeedbackType: "abuse", complainedRecipients: [{ emailAddress: MEMBER }] },
});

beforeEach(() => {
  vi.clearAllMocks();
  seedRows();
  store.suppressions = [];

  prismaMock.emailLog.updateMany.mockImplementation(
    async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
      const hit = store.rows.filter((entry) => matches(entry, where));
      for (const entry of hit) Object.assign(entry, data);
      return { count: hit.length };
    },
  );
  prismaMock.emailSuppression.findUnique.mockImplementation(
    async ({ where }: { where: { email: string } }) =>
      store.suppressions.find((entry) => entry.email === where.email) ?? null,
  );
  prismaMock.emailSuppression.findFirst.mockImplementation(
    async ({ where }: { where: Record<string, unknown> }) =>
      store.suppressions.find((entry) => matches(entry, where)) ?? null,
  );
  prismaMock.emailSuppression.create.mockImplementation(
    async ({ data }: { data: Suppression }) => {
      const created = { ...data, id: `sup-${store.suppressions.length + 1}` };
      store.suppressions.push(created);
      return created;
    },
  );
  prismaMock.emailSuppression.update.mockImplementation(
    async ({ where, data }: { where: { email: string }; data: Partial<Suppression> }) => {
      const existing = store.suppressions.find((entry) => entry.email === where.email)!;
      Object.assign(existing, data);
      return existing;
    },
  );
});

describe("SES feedback marks only the email it names (#5469)", () => {
  it("MUTATION: marks the named row bounced and leaves every other row as it was", async () => {
    const result = await ingestSesSnsEmailFeedback(hardBounce(namedMail()));

    expect(result).toMatchObject({ handled: true, emailLogsMarked: 1 });
    expect(statuses()).toEqual({
      named: EmailLogStatus.BOUNCED,
      offer: EmailLogStatus.SENT,
      pending: EmailLogStatus.FAILED,
      other: EmailLogStatus.SENT,
    });
    expect(byId("named").errorMessage).toBe("SES bounce received via SNS");
    expect(byId("pending").errorMessage).toBe("SMTP timeout");
  });

  it("MUTATION: finds the row by the common headers' Message-ID, with or without angle brackets", async () => {
    await ingestSesSnsEmailFeedback(
      hardBounce({ messageId: "0100018c-ses-assigned-000000", commonHeaders: { messageId: " named-1@club.example.test" } }),
    );

    expect(statuses()).toMatchObject({ named: EmailLogStatus.BOUNCED, offer: EmailLogStatus.SENT });
  });

  it.each([
    ["a temporary bounce", transientBounce],
    ["a complaint", complaint],
  ])("MUTATION: %s follows the same rule as a hard bounce", async (_label, notification) => {
    await ingestSesSnsEmailFeedback(notification(namedMail()));

    expect(statuses()).toEqual({
      named: EmailLogStatus.BOUNCED,
      offer: EmailLogStatus.SENT,
      pending: EmailLogStatus.FAILED,
      other: EmailLogStatus.SENT,
    });
  });

  it("a pending row to the address is not rewritten, and the suppression the senders check stops it", async () => {
    await ingestSesSnsEmailFeedback(hardBounce(namedMail()));

    // The row keeps its status and its body.
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

  it.each([
    ["names no message at all", { destination: [MEMBER] }],
    ["carries only blank ids", { messageId: "  ", destination: [MEMBER], headers: [{ name: "Message-ID", value: " <> " }] }],
    // SES's own id with no original headers: the stored Message-ID is not in it.
    ["names a message no row stores", { messageId: "0100018c-ses-assigned-000000", destination: [MEMBER] }],
  ])("MUTATION: a notification that %s marks nothing and still suppresses", async (_label, mail) => {
    const result = await ingestSesSnsEmailFeedback(complaint(mail));

    expect(result).toMatchObject({ handled: true, emailLogsMarked: 0, suppressionsActive: 1 });
    expect(statuses()).toEqual({
      named: EmailLogStatus.SENT,
      offer: EmailLogStatus.SENT,
      pending: EmailLogStatus.FAILED,
      other: EmailLogStatus.SENT,
    });
    await expect(getActiveEmailSuppression(MEMBER)).resolves.toMatchObject({ reason: "COMPLAINT" });
  });

  it("MUTATION: handling the same notification twice changes nothing the second time", async () => {
    const notification = transientBounce(namedMail());
    const first = await ingestSesSnsEmailFeedback(notification);
    const rowsAfterFirst = structuredClone(store.rows);
    const suppressionsAfterFirst = structuredClone(store.suppressions);

    const second = await ingestSesSnsEmailFeedback(notification);

    expect(first).toMatchObject({ emailLogsMarked: 1 });
    expect(second).toMatchObject({ emailLogsMarked: 0 });
    expect(store.rows).toEqual(rowsAfterFirst);
    expect(store.suppressions).toEqual(suppressionsAfterFirst);
    // One temporary bounce, however often SNS delivers it: not yet suppressed.
    expect(store.suppressions[0]).toMatchObject({ eventCount: 1, suppressedAt: null });
  });

  it.each([
    ["a complaint", complaint],
    ["a temporary bounce", transientBounce],
  ])("a member who received the offer email still reads as told after %s on another email", async (_label, notification) => {
    await ingestSesSnsEmailFeedback(notification(namedMail()));

    const offer = byId("offer");
    const state = keyedEmailRowState(offer);
    expect(state).toBe("sent");
    expect(isToldKeyedEmailState(state)).toBe(true);
  });
});
