import { describe, it, expect, vi, beforeEach } from "vitest";
// New resolution (C6 #1985): the retried "from" is built from the DB-first email
// settings default from-name (EMAIL_DEFAULT_FROM_NAME) and the bootstrap envelope
// sender (EMAIL_FROM), not the severed club-identity constants.
import { EMAIL_FROM } from "@/lib/email-sender";
import { EMAIL_DEFAULT_FROM_NAME } from "@/lib/email-message-settings";
import { FALLBACK_LODGE_CAPACITY as LODGE_CAPACITY } from "@/lib/lodge-capacity";
import { declareEnvironmentRole } from "@/lib/__tests__/helpers/environment-role";
import { addDaysDateOnly, getTodayDateOnly } from "@/lib/date-only";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/*
 * The zone the capacity-warning fixtures are built in (#3123).
 * `cron-capacity-warnings.ts:29` takes its window from
 * `clubToday(await readClubTimeZoneOutsideRequest())`; this suite mocks no
 * `ClubTimeSettings` row, so that reader falls back to the environment seed,
 * `Pacific/Auckland` under test. Zone AUTHORITY is not this file's subject, so
 * it names the agreeing zone rather than a divergent one.
 */
const CLUB_ZONE = "Pacific/Auckland";

// The cron resolves each lodge's own capacity; pin it to the club config
// total so the fixtures keep their original arithmetic.
vi.mock("@/lib/lodge-capacity", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/lodge-capacity");
  return {
    ...actual,
    getLodgeCapacity: vi.fn(async () => actual.FALLBACK_LODGE_CAPACITY),
  };
});

/**
 * #2548: admin alert audiences resolve from the access-role permission matrix,
 * so a candidate row must carry the access-role assignments the resolver
 * selects. These fixtures are Full Admins, as these tests always assumed.
 */
function adminRecipient(
  email: string,
  notificationPreference: Record<string, boolean> | null = null,
) {
  return {
    email,
    canLogin: true,
    accessRoles: [
      { role: "ADMIN", roleDefinitionId: null, roleDefinition: null },
    ],
    notificationPreference,
  };
}

// Use vi.hoisted so the mock objects are available at hoist time
const { mockPrisma, mockTransporter } = vi.hoisted(() => {
  const mockTransporter = {
    sendMail: vi.fn().mockResolvedValue({ messageId: "msg-456" }),
  };
  const mockPrisma = {
    environmentSafetySettings: { findUnique: vi.fn().mockResolvedValue(null) },
    // Per-lodge capacity warnings (lodge-scoping contract): one active
    // lodge in these fixtures, preserving the original single-lodge
    // expectations.
    lodge: {
      findMany: vi.fn().mockResolvedValue([{ id: "lodge-1", name: "Lodge" }]),
    },
    emailLog: {
      create: vi.fn().mockResolvedValue({ id: "log-1" }),
      update: vi.fn().mockResolvedValue({}),
      // Pre-send retry claim (F33, #1885): claim succeeds by default.
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
    emailSuppression: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    member: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    booking: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // #2286: the capacity-warnings cron INCLUDES custodian bed holds (its job
    // is fullness). None in these fixtures, so the <=5-beds thresholds below
    // are unchanged.
    hutLeaderAssignment: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    notificationPreference: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({
        bookingConfirmation: true,
        bookingReminder: true,
        bookingBumped: true,
        bookingCancelled: true,
        choreRoster: true,
        marketingEmails: false,
      }),
      upsert: vi.fn().mockResolvedValue({
        bookingConfirmation: true,
        bookingReminder: true,
        bookingBumped: true,
        bookingCancelled: true,
        choreRoster: true,
        marketingEmails: false,
      }),
    },
    notificationDeliveryPolicy: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({}),
    },
    // #49: the digest reads the STORED central-server version (no network).
    // Not connected by default, so no version entry rides these digests.
    serverNzSettings: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    integrationCredential: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    // #5407 item 37: the sync error alert's hourly claim. Free by default
    // (nothing held, the create wins).
    alertCooldown: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
  return { mockPrisma, mockTransporter };
});

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => mockTransporter,
  },
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

async function flushAsyncEmailSends() {
  await new Promise((resolve) => setImmediate(resolve));
}

// ============================================================================
// N-08: shouldSendEmail helper
// ============================================================================

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

describe("N-08: shouldSendEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  // Only the check-in reminder and the chore roster ask (the bulk categories'
  // defaults are bulk-audience.ts's, INV-PRIV-026). Both default on.
  it.each(["bookingReminder", "choreRoster"] as const)(
    "returns true for %s when no preference record exists (defaults)",
    async (category) => {
      mockPrisma.notificationPreference.findUnique.mockResolvedValue(null);
      const { shouldSendEmail } = await import("../email");
      expect(await shouldSendEmail("member-1", category)).toBe(true);
    },
  );

  it.each(["bookingReminder", "choreRoster"] as const)(
    "honours a stored %s opt-out and leaves the other category alone",
    async (category) => {
      mockPrisma.notificationPreference.findUnique.mockResolvedValue({
        bookingReminder: category !== "bookingReminder",
        choreRoster: category !== "choreRoster",
      });
      const { shouldSendEmail } = await import("../email");
      expect(await shouldSendEmail("member-1", category)).toBe(false);
      const other = category === "bookingReminder" ? "choreRoster" : "bookingReminder";
      expect(await shouldSendEmail("member-1", other)).toBe(true);
    },
  );
});

describe("sendEmail logging safeguards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("does not persist retry HTML for admin-email-failure alerts", async () => {
    const { sendEmail } = await import("../email");

    await sendEmail({
      bookingContext: "none",
      to: "admin@example.com",
      subject: "Email delivery permanently failed",
      html: "<p>Alert body</p>",
      templateName: "admin-email-failure",
    });

    expect(mockPrisma.emailLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        templateName: "admin-email-failure",
        htmlBody: null,
      }),
    });
  });
});

// ============================================================================
// N-03: Capacity warnings cron
// ============================================================================

describe("N-03: checkCapacityWarnings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockPrisma.notificationDeliveryPolicy.findUnique.mockResolvedValue(null);
    mockPrisma.member.findMany.mockResolvedValue([
      adminRecipient("support@example.org"),
    ]);
    mockPrisma.emailLog.create.mockResolvedValue({ id: "log-1" });
    mockPrisma.emailLog.update.mockResolvedValue({});
  });

  it("alerts when days have <= 5 beds remaining", async () => {
    // #3107: the cron derives its own window from the CLUB day encoded at UTC
    // midnight. This was `new Date()` + `setHours(0,0,0,0)` - HOST-LOCAL
    // midnight, a value no `@db.Date` column can hold and one whose UTC instant
    // moves with the machine running the suite. Building the fixture in the same
    // zone the cron reads lines it up with the nights it actually asks about, on
    // any host.
    const today = getTodayDateOnly(CLUB_ZONE);
    // `addDaysDateOnly` steps whole UTC days. `setDate` steps the LOCAL date and
    // carries the local time of day with it, so on a host with a transition in
    // range it moves the UTC instant by 23 or 25 hours off the day boundary.
    const dayAfter = addDaysDateOnly(today, 2);

    // Create a booking with 25 guests (only 4 beds remaining)
    mockPrisma.booking.findMany.mockResolvedValue([
      {
        id: "booking-1",
        checkIn: today,
        checkOut: dayAfter,
        status: "CONFIRMED",
        guests: Array.from({ length: 25 }, (_, i) => ({ id: `g-${i}` })),
      },
    ]);

    const { checkCapacityWarnings } = await import("../cron-capacity-warnings");
    const result = await checkCapacityWarnings();
    await flushAsyncEmailSends();

    expect(result.alertedDays).toBeGreaterThan(0);
    expect(mockPrisma.emailLog.create).toHaveBeenCalled();
  }, 15000);

  // #2286: the capacity-warnings cron INCLUDES custodian bed holds. Its whole
  // job is to warn when a lodge is nearly full, and a bed held for a season by
  // a custodian is genuinely unavailable — excluding it would under-fire the
  // warning by the custodian count every night, all season.
  it("counts a custodian bed hold toward fullness, so the warning fires at TRUE fullness", async () => {
    // #3107: the cron derives its own window from the CLUB day encoded at UTC
    // midnight. This was `new Date()` + `setHours(0,0,0,0)` - HOST-LOCAL
    // midnight, a value no `@db.Date` column can hold and one whose UTC instant
    // moves with the machine running the suite. Building the fixture in the same
    // zone the cron reads lines it up with the nights it actually asks about, on
    // any host.
    const today = getTodayDateOnly(CLUB_ZONE);
    const dayAfter = addDaysDateOnly(today, 2);

    // One bed above the threshold: LODGE_CAPACITY - 6 booked guests leaves 6
    // free, and the cron only warns at <= 5.
    mockPrisma.booking.findMany.mockResolvedValue([
      {
        id: "booking-1",
        checkIn: today,
        checkOut: dayAfter,
        status: "CONFIRMED",
        guests: Array.from({ length: LODGE_CAPACITY - 6 }, (_, i) => ({
          id: `g-${i}`,
        })),
      },
    ]);

    const { checkCapacityWarnings } = await import("../cron-capacity-warnings");
    const quiet = await checkCapacityWarnings();
    expect(quiet.alertedDays).toBe(0);

    // Add ONE custodian holding a bed across those nights: 5 free, exactly the
    // threshold. The cron must now fire — the bed really is unavailable.
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([
      {
        id: "assignment-1",
        memberId: "member-1",
        lodgeId: "lodge-1",
        bedId: "bed-1",
        startDate: today,
        endDate: dayAfter,
        member: { firstName: "Sam", lastName: "Ranger", ageTier: "ADULT" },
        bed: {
          id: "bed-1",
          name: "A1",
          roomId: "room-1",
          room: { id: "room-1", name: "Kea" },
        },
      },
    ]);

    const loud = await checkCapacityWarnings();
    expect(loud.alertedDays).toBeGreaterThan(0);
  }, 15000);

  it("does not alert when all days have > 5 beds remaining", async () => {
    // No bookings = 29 beds available
    mockPrisma.booking.findMany.mockResolvedValue([]);

    const { checkCapacityWarnings } = await import("../cron-capacity-warnings");
    const result = await checkCapacityWarnings();

    expect(result.alertedDays).toBe(0);
    expect(mockPrisma.emailLog.create).not.toHaveBeenCalled();
  });
});

// ============================================================================
// N-05: Xero sync error alert
// ============================================================================

describe("N-05: notifyXeroSyncError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockPrisma.member.findMany.mockResolvedValue([
      adminRecipient("support@example.org"),
    ]);
    mockPrisma.emailLog.create.mockResolvedValue({ id: "log-1" });
    mockPrisma.emailLog.update.mockResolvedValue({});
    mockPrisma.emailLog.findFirst.mockResolvedValue(null);
    mockPrisma.alertCooldown.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.alertCooldown.create.mockResolvedValue({});
  });

  it("sends alert on first error", async () => {
    const { notifyXeroSyncError } = await import("../xero-error-alert");
    await notifyXeroSyncError({
      errorType: "API Error",
      operation: "createInvoice",
      errorMessage: "Rate limit exceeded",
    });
    await flushAsyncEmailSends();

    expect(mockPrisma.emailLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        templateName: "admin-xero-sync-error",
      }),
    });
  });

  it("redacts sensitive values in Xero error alert emails", async () => {
    const { notifyXeroSyncError } = await import("../xero-error-alert");
    await notifyXeroSyncError({
      errorType: "API Error",
      operation: "createInvoice",
      errorMessage:
        "Xero failed with access_token=live-access and pi_123_secret_liveSecret",
    });
    await flushAsyncEmailSends();

    const htmlBody = String(mockPrisma.emailLog.create.mock.calls[0][0].data.htmlBody);
    expect(htmlBody).toContain("access_token=[REDACTED]");
    expect(htmlBody).toContain("[REDACTED]");
    expect(htmlBody).not.toContain("live-access");
    expect(htmlBody).not.toContain("pi_123_secret_liveSecret");
  });

  it("suppresses duplicate alerts within 1 hour", async () => {
    // #5407 item 37: an alert in the last hour holds the AlertCooldown claim,
    // so the window update matches nothing and the create hits the unique key.
    mockPrisma.alertCooldown.create.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );

    const { notifyXeroSyncError } = await import("../xero-error-alert");
    await notifyXeroSyncError({
      errorType: "API Error",
      operation: "createInvoice",
      errorMessage: "Rate limit exceeded",
    });

    // Should not create a new email log (alert suppressed)
    expect(mockPrisma.emailLog.create).not.toHaveBeenCalled();
  });
});

// ============================================================================
// N-11: Email retry with backoff
// ============================================================================

describe("N-11: retryFailedEmails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("retries failed emails and marks them as SENT on success", async () => {
    mockPrisma.emailLog.findMany.mockResolvedValue([
      {
        id: "log-fail-1",
        to: "user@example.com",
        subject: "Test Subject",
        htmlBody: "<p>Test body</p>",
        bookingRetryHtmlBody: null,
        attempts: 1,
        status: "FAILED",
      },
    ]);
    mockPrisma.emailLog.update.mockResolvedValue({});

    const { retryFailedEmails } = await import("../cron-email-retry");
    const result = await retryFailedEmails();

    expect(result.retried).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    // The attempts increment moved into the pre-send claim (F33, #1885).
    expect(mockPrisma.emailLog.updateMany).toHaveBeenCalledWith({
      where: {
        id: "log-fail-1",
        status: "FAILED",
        attempts: 1,
        htmlBody: "<p>Test body</p>",
        bookingRetryHtmlBody: null,
      },
      data: expect.objectContaining({
        status: "QUEUED",
        attempts: 2,
        lastAttemptAt: expect.any(Date),
      }),
    });
    expect(mockPrisma.emailLog.update).toHaveBeenCalledWith({
      where: { id: "log-fail-1" },
      data: expect.objectContaining({
        status: "SENT",
      }),
    });
    expect(mockTransporter.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: `"${EMAIL_DEFAULT_FROM_NAME}" <${EMAIL_FROM}>`,
      })
    );
  });

  it("increments attempt count on retry failure", async () => {
    mockPrisma.emailLog.findMany.mockResolvedValue([
      {
        id: "log-fail-2",
        to: "user@example.com",
        subject: "Test",
        htmlBody: "<p>Test</p>",
        attempts: 2,
        status: "FAILED",
      },
    ]);
    mockTransporter.sendMail.mockRejectedValueOnce(new Error("SMTP error"));
    mockPrisma.emailLog.update.mockResolvedValue({});

    const origEnv = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";

    const { retryFailedEmails } = await import("../cron-email-retry");
    const result = await retryFailedEmails();

    expect(result.retried).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(1);
    expect(mockPrisma.emailLog.update).toHaveBeenCalledWith({
      where: { id: "log-fail-2" },
      data: expect.objectContaining({
        attempts: 3,
        errorMessage: "SMTP error",
      }),
    });

    (process.env as Record<string, string>).NODE_ENV = origEnv!;
  });

  it("does not alert on failed admin-email-failure retries", async () => {
    mockPrisma.emailLog.findMany.mockResolvedValue([
      {
        id: "log-fail-3",
        to: "secretary@example.org",
        subject: "Email delivery permanently failed",
        templateName: "admin-email-failure",
        htmlBody: "<p>Alert</p>",
        attempts: 2,
        status: "FAILED",
      },
    ]);
    mockTransporter.sendMail.mockRejectedValueOnce(new Error("SMTP error"));
    mockPrisma.emailLog.update.mockResolvedValue({});

    const origEnv = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";

    const { retryFailedEmails } = await import("../cron-email-retry");
    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 1, succeeded: 0, failed: 1 });
    expect(mockPrisma.emailLog.update).toHaveBeenCalledWith({
      where: { id: "log-fail-3" },
      data: expect.objectContaining({
        attempts: 3,
        errorMessage: "SMTP error",
      }),
    });
    expect(mockPrisma.member.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.emailLog.create).not.toHaveBeenCalled();

    (process.env as Record<string, string>).NODE_ENV = origEnv!;
  });

  it("queries only emails with a retained legacy or booking retry body", async () => {
    mockPrisma.emailLog.findMany.mockResolvedValue([]);

    const { retryFailedEmails } = await import("../cron-email-retry");
    const result = await retryFailedEmails();

    expect(result.retried).toBe(0);
    // #2362 keeps retry-time booking HTML in a separately isolated column so
    // an old-color worker cannot replay it. Either retained-body column makes a
    // row eligible for the current worker; rows with neither remain excluded.
    expect(mockPrisma.emailLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { htmlBody: { not: null } },
            { bookingRetryHtmlBody: { not: null } },
          ],
          attempts: { lt: 3 },
        }),
      })
    );
  });

  it("returns empty results when no failed emails", async () => {
    mockPrisma.emailLog.findMany.mockResolvedValue([]);

    const { retryFailedEmails } = await import("../cron-email-retry");
    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 0, succeeded: 0, failed: 0 });
  });
});

describe("exhausted email failure review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("keeps reviewed exhausted failures out of the active recovery queue", async () => {
    mockPrisma.emailLog.findMany.mockResolvedValue([
      {
        id: "active-failure",
        to: "member@example.com",
        subject: "Booking confirmation",
        templateName: "booking-confirmation",
        attempts: 3,
        lastAttemptAt: new Date("2026-05-15T01:00:00.000Z"),
        errorMessage: "SMTP rejected",
        createdAt: new Date("2026-05-15T00:00:00.000Z"),
      },
      {
        id: "reviewed-failure",
        to: "admin@example.com",
        subject: "Email delivery permanently failed",
        templateName: "admin-email-failure",
        attempts: 3,
        lastAttemptAt: new Date("2026-05-14T01:00:00.000Z"),
        errorMessage: "SMTP rejected",
        createdAt: new Date("2026-05-14T00:00:00.000Z"),
      },
    ]);
    mockPrisma.emailLog.count.mockResolvedValue(2);
    mockPrisma.auditLog.findMany.mockResolvedValue([
      {
        action: "email.failure.reviewed",
        targetId: "reviewed-failure",
        actorMemberId: "admin_1",
        memberId: "admin_1",
        createdAt: new Date("2026-05-15T02:00:00.000Z"),
        metadata: { reason: "Old alert reviewed" },
      },
    ]);

    const { getExhaustedEmailFailureReviewQueue } = await import("../email-failure-review");
    const queue = await getExhaustedEmailFailureReviewQueue();

    expect(queue.summary).toMatchObject({
      activeCount: 1,
      reviewedCount: 1,
      scannedCount: 2,
      maxAttempts: 3,
    });
    expect(queue.failures.map((failure) => failure.id)).toEqual(["active-failure"]);
    expect(queue.recentlyReviewed[0]).toMatchObject({
      id: "reviewed-failure",
      reviewedById: "admin_1",
      reviewNote: "Old alert reviewed",
    });
  });

  it("archives exhausted failures by writing an audit record without changing EmailLog status", async () => {
    mockPrisma.emailLog.findUnique.mockResolvedValue({
      id: "log_1",
      to: "member@example.com",
      subject: "Booking confirmation",
      templateName: "booking-confirmation",
      status: "FAILED",
      attempts: 3,
      errorMessage: "SMTP rejected",
    });

    const { markExhaustedEmailFailureReviewed } = await import("../email-failure-review");
    await expect(
      markExhaustedEmailFailureReviewed("log_1", {
        reviewedByMemberId: "admin_1",
        reason: "Confirmed recipient was already contacted manually",
      })
    ).resolves.toEqual({
      id: "log_1",
      reviewed: true,
      reason: "Confirmed recipient was already contacted manually",
    });

    expect(mockPrisma.emailLog.update).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "email.failure.reviewed",
        targetId: "log_1",
        actorMemberId: "admin_1",
        category: "communication",
      }),
    });
  });
});

// ============================================================================
// N-13: Admin daily digest
// ============================================================================

/** One row of the digest's `emailLog.groupBy` (#5407 item 12). */
function digestGroup(templateName: string, subject: string, to: string, copies = 1) {
  return { templateName, subject, to, _count: { _all: copies } };
}

/** The EmailLog rows the real senders wrote in this test. */
function writtenEmailRows() {
  return mockPrisma.emailLog.create.mock.calls.map(
    (call) => call[0].data as { templateName: string; subject: string; to: string },
  );
}

/**
 * Answer the digest's `groupBy` from the rows the real senders wrote, grouped
 * on the keys the digest asks for, so the test exercises the real subjects
 * and recipients rather than hand-built groups.
 */
function groupWrittenRowsForDigest() {
  const written = writtenEmailRows();
  mockPrisma.emailLog.groupBy.mockImplementation(
    async ({ by }: { by: Array<"templateName" | "subject" | "to"> }) => {
      const groups = new Map<string, ReturnType<typeof digestGroup>>();
      for (const row of written) {
        const key = JSON.stringify(by.map((field) => row[field]));
        const group = groups.get(key);
        if (group) group._count._all++;
        else groups.set(key, digestGroup(row.templateName, row.subject, row.to));
      }
      return [...groups.values()];
    },
  );
}

function newBookingAlert(memberName: string) {
  return {
    memberName,
    checkIn: new Date("2026-08-01"),
    checkOut: new Date("2026-08-03"),
    guestCount: 2,
    totalCents: 24_000,
    status: "PENDING",
  };
}

describe("N-13: sendAdminDigest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockPrisma.member.findMany.mockResolvedValue([
      adminRecipient("support@example.org"),
    ]);
    mockPrisma.emailLog.create.mockResolvedValue({ id: "log-1" });
    mockPrisma.emailLog.update.mockResolvedValue({});
    mockPrisma.notificationDeliveryPolicy.findUnique.mockResolvedValue(null);
  });

  it("sends digest with alert counts from past 24h", async () => {
    mockPrisma.emailLog.groupBy.mockResolvedValue([
      digestGroup("admin-new-booking", "New booking: Alice", "support@example.org"),
      digestGroup("admin-new-booking", "New booking: Bob", "support@example.org"),
      digestGroup("admin-new-booking", "New booking: Carol", "support@example.org"),
      digestGroup("admin-payment-failure", "Payment failed: xyz", "support@example.org"),
      digestGroup("admin-xero-repeated-failure", "Repeated Xero Failure: booking:1", "support@example.org"),
    ]);

    const { sendAdminDigest } = await import("../cron-admin-digest");
    const result = await sendAdminDigest();
    await flushAsyncEmailSends();

    expect(result.totalAlerts).toBe(5);
    expect(result.sent).toBe(true);
    expect(mockPrisma.emailLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        templateName: "admin-daily-digest",
      }),
    });
  });

  // #5407 item 12: the read groups per officer, and still counts only copies
  // somebody received (SENT, or QUEUED mid-send) in the last 24 hours.
  it("groups by template, subject and recipient over SENT and QUEUED rows", async () => {
    mockPrisma.emailLog.groupBy.mockResolvedValue([]);

    const { sendAdminDigest } = await import("../cron-admin-digest");
    await sendAdminDigest();

    expect(mockPrisma.emailLog.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.emailLog.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["templateName", "subject", "to"],
        where: expect.objectContaining({
          status: { in: ["SENT", "QUEUED"] },
          createdAt: { gte: expect.any(Date) },
        }),
        _count: { _all: true },
      }),
    );
  });

  // #5403: the confirm-pending cron sends the bumped alert again, so its line
  // in the digest counts real events instead of always reading zero. #5407
  // item 12: the groups are built from the rows the real sender writes, so
  // two bumps for one owner must stay two.
  it("counts two bumps for the same owner as two", async () => {
    const { sendAdminBookingBumpedAlert } = await import("../email");
    const bump = {
      bumpedMemberName: "Jane Doe",
      lodgeName: null,
      guestCount: 2,
      reason: "These dates filled up before the provisional guests were confirmed.",
    };
    await sendAdminBookingBumpedAlert({ ...bump, bookingReference: "CKAAAA11", checkIn: new Date("2026-08-01"), checkOut: new Date("2026-08-03") });
    await sendAdminBookingBumpedAlert({ ...bump, bookingReference: "CKBBBB22", checkIn: new Date("2026-08-10"), checkOut: new Date("2026-08-12") });
    await flushAsyncEmailSends();
    expect(
      writtenEmailRows().filter((row) => row.templateName === "admin-booking-bumped"),
    ).toHaveLength(2);
    groupWrittenRowsForDigest();

    const { sendAdminDigest } = await import("../cron-admin-digest");
    const result = await sendAdminDigest();
    await flushAsyncEmailSends();

    expect(result.totalAlerts).toBe(2);
    const digestHtml = mockTransporter.sendMail.mock.calls
      .map((call) => call[0] as { html: string })
      .find((mail) => mail.html.includes("Admin Daily Digest"))?.html;
    // The row's own Count cell, the one straight after its label.
    expect(digestHtml).toMatch(/Bookings Bumped<\/td>\s*<td[^>]*>2<\/td>/);
  });

  // #5407 item 12: the payment-failure subject never changes, so the old
  // distinct-subject read counted two failures as one.
  it("counts two payment failures sent to two officers as two", async () => {
    mockPrisma.member.findMany.mockResolvedValue([
      adminRecipient("treasurer@example.org"),
      adminRecipient("support@example.org"),
    ]);
    const { sendAdminPaymentFailureAlert } = await import("../email");
    const failure = {
      memberName: "Jane Doe",
      checkIn: new Date("2026-08-01"),
      checkOut: new Date("2026-08-03"),
      amountCents: 12_000,
      errorMessage: "card_declined",
    };
    await sendAdminPaymentFailureAlert({ ...failure, paymentIntentId: "pi_one" }, CLUB_FORMAT_TEST);
    await sendAdminPaymentFailureAlert({ ...failure, memberName: "Sam Roe", paymentIntentId: "pi_two" }, CLUB_FORMAT_TEST);
    await flushAsyncEmailSends();
    const failures = writtenEmailRows().filter(
      (row) => row.templateName === "admin-payment-failure",
    );
    expect(failures).toHaveLength(4);
    expect(new Set(failures.map((row) => row.subject)).size).toBe(1);
    groupWrittenRowsForDigest();

    const { sendAdminDigest } = await import("../cron-admin-digest");
    const result = await sendAdminDigest();

    expect(result.totalAlerts).toBe(2);
  });

  it("counts one alert sent to three officers as one", async () => {
    mockPrisma.member.findMany.mockResolvedValue([
      adminRecipient("one@example.org"),
      adminRecipient("two@example.org"),
      adminRecipient("three@example.org"),
    ]);
    const { sendAdminNewBookingAlert } = await import("../email");
    await sendAdminNewBookingAlert(newBookingAlert("Jane Doe"), CLUB_FORMAT_TEST);
    await flushAsyncEmailSends();
    expect(
      writtenEmailRows().filter((row) => row.templateName === "admin-new-booking"),
    ).toHaveLength(3);
    groupWrittenRowsForDigest();

    const { sendAdminDigest } = await import("../cron-admin-digest");
    const result = await sendAdminDigest();

    expect(result.totalAlerts).toBe(1);
  });

  it("counts two new-booking alerts with the same subject as two", async () => {
    const { sendAdminNewBookingAlert } = await import("../email");
    await sendAdminNewBookingAlert(newBookingAlert("Jane Doe"), CLUB_FORMAT_TEST);
    await sendAdminNewBookingAlert(
      { ...newBookingAlert("Jane Doe"), checkIn: new Date("2026-09-05"), checkOut: new Date("2026-09-07") },
      CLUB_FORMAT_TEST,
    );
    await flushAsyncEmailSends();
    const rows = writtenEmailRows().filter(
      (row) => row.templateName === "admin-new-booking",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.subject).toBe(rows[1]!.subject);
    groupWrittenRowsForDigest();

    const { sendAdminDigest } = await import("../cron-admin-digest");
    const result = await sendAdminDigest();

    expect(result.totalAlerts).toBe(2);
  });

  it("counts an uneven audience by the officer who received the most", async () => {
    // Alert A reached officers X and Y; alert B, same subject, reached X only.
    mockPrisma.emailLog.groupBy.mockResolvedValue([
      digestGroup("admin-payment-failure", "Payment Failed", "x@example.org", 2),
      digestGroup("admin-payment-failure", "Payment Failed", "y@example.org", 1),
    ]);

    const { sendAdminDigest } = await import("../cron-admin-digest");
    const result = await sendAdminDigest();

    expect(result.totalAlerts).toBe(2);
  });

  it("does not send digest when no alerts occurred by default", async () => {
    mockPrisma.emailLog.groupBy.mockResolvedValue([]);

    const { sendAdminDigest } = await import("../cron-admin-digest");
    const result = await sendAdminDigest();
    await flushAsyncEmailSends();

    expect(result.totalAlerts).toBe(0);
    expect(result.sent).toBe(false);
    expect(result.skippedReason).toBe("no_content");
    expect(mockPrisma.emailLog.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          templateName: "admin-daily-digest",
        }),
      })
    );
  });

  it("sends zero-alert digest when policy is always", async () => {
    mockPrisma.emailLog.groupBy.mockResolvedValue([]);
    mockPrisma.notificationDeliveryPolicy.findUnique.mockResolvedValue({
      templateName: "admin-daily-digest",
      mode: "ALWAYS",
    });

    const { sendAdminDigest } = await import("../cron-admin-digest");
    const result = await sendAdminDigest();
    await flushAsyncEmailSends();

    expect(result.totalAlerts).toBe(0);
    expect(result.sent).toBe(true);
  });

  it("does not send digest when policy is disabled", async () => {
    mockPrisma.emailLog.groupBy.mockResolvedValue([
      digestGroup("admin-new-booking", "New booking: Alice", "support@example.org"),
    ]);
    mockPrisma.notificationDeliveryPolicy.findUnique.mockResolvedValue({
      templateName: "admin-daily-digest",
      mode: "DISABLED",
    });

    const { sendAdminDigest } = await import("../cron-admin-digest");
    const result = await sendAdminDigest();
    await flushAsyncEmailSends();

    expect(result.totalAlerts).toBe(1);
    expect(result.sent).toBe(false);
    expect(result.skippedReason).toBe("disabled");
    expect(mockPrisma.emailLog.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          templateName: "admin-daily-digest",
        }),
      }),
    );
  });
});

// ============================================================================
// Email template tests - Phase 6b
// ============================================================================

describe("Email templates - Phase 6b", () => {
  it("adminXeroSyncErrorTemplate escapes HTML in error message", async () => {
    const { adminXeroSyncErrorTemplate } = await import("@/lib/email-templates/admin-finance");
    const html = adminXeroSyncErrorTemplate({
      errorType: "<script>xss</script>",
      operation: "createInvoice",
      errorMessage: "Something <b>bad</b> happened",
      timestamp: new Date("2026-04-06T10:00:00Z"),
    });

    expect(html).not.toContain("<script>xss</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;bad&lt;/b&gt;");
  });

  it("adminCapacityWarningTemplate renders day table", async () => {
    const { adminCapacityWarningTemplate } = await import("@/lib/email-templates/admin-booking");
    const html = adminCapacityWarningTemplate([
      { date: new Date("2026-04-10"), occupiedBeds: 26, availableBeds: 3 },
      { date: new Date("2026-04-11"), occupiedBeds: 28, availableBeds: 1 },
    ]);

    expect(html).toContain("Capacity Warning");
    expect(html).toContain(`26/${LODGE_CAPACITY}`);
    expect(html).toContain(`28/${LODGE_CAPACITY}`);
  });

  it("adminDailyDigestTemplate shows alert counts", async () => {
    const { adminDailyDigestTemplate } = await import("@/lib/email-templates/admin-ops");
    const html = adminDailyDigestTemplate({
      newBookings: 5,
      paymentFailures: 1,
      capacityWarnings: 0,
      bookingsBumped: 2,
      pendingDeadlines: 0,
      xeroErrors: 0,
      totalAlerts: 8,
    });

    expect(html).toContain("Admin Daily Digest");
    expect(html).toContain("New Bookings");
    expect(html).toContain("Payment Failures");
    expect(html).toContain("Bookings Bumped");
    expect(html).toContain("8");
    // Capacity warnings and xero errors should not show (0 count)
    expect(html).not.toContain("Capacity Warnings");
    expect(html).not.toContain("Xero Errors");
  });

  it("adminDailyDigestTemplate shows no-alerts message when all zero", async () => {
    const { adminDailyDigestTemplate } = await import("@/lib/email-templates/admin-ops");
    const html = adminDailyDigestTemplate({
      newBookings: 0,
      paymentFailures: 0,
      capacityWarnings: 0,
      bookingsBumped: 0,
      pendingDeadlines: 0,
      xeroErrors: 0,
      totalAlerts: 0,
    });

    expect(html).toContain("No alerts were triggered");
  });

  it("adminXeroRepeatedFailureTemplate escapes HTML and renders links", async () => {
    const { adminXeroRepeatedFailureTemplate } = await import("@/lib/email-templates/admin-finance");
    const html = adminXeroRepeatedFailureTemplate({
      correlationKey: "booking:<script>",
      failureCount: 3,
      windowHours: 24,
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: "pay_123",
      localUrl: "/admin/xero/records/Payment/pay_123",
      xeroObjectUrl: "https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=inv-123",
      latestErrorMessage: "Something <b>bad</b> happened",
      timestamp: new Date("2026-04-13T10:00:00Z"),
    });

    expect(html).toContain("Repeated Xero Failures");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;bad&lt;/b&gt;");
    expect(html).toContain("/admin/xero/records/Payment/pay_123");
  });

  it("adminXeroReconciliationReportTemplate renders summary counts", async () => {
    const { adminXeroReconciliationReportTemplate } = await import("@/lib/email-templates/admin-xero-reports");
    const html = adminXeroReconciliationReportTemplate({
      generatedAt: new Date("2026-04-13T10:00:00Z"),
      lookbackHours: 24,
      stalePendingMinutes: 30,
      summary: {
        missingMemberContactLinks: 1,
        missingPaymentInvoiceLinks: 2,
        missingPaymentRefundCreditNoteLinks: 0,
        missingSubscriptionInvoiceLinks: 1,
        mismatchedCanonicalLinks: 1,
        staleCanonicalLinks: 2,
        duplicateActiveCanonicalLinks: 1,
        overCoveredStripeRefundPayments: 0,
        stalePendingOperations: 3,
        recentFailedOperations: 4,
        recentPartialOperations: 1,
        unsupportedPartialOperations: 1,
        repeatedFailureCorrelations: 2,
        failedInboundEvents: 0,
        issueCategoryCount: 11,
        issueTotalCount: 19,
      },
      issueSections: [
        {
          id: "unsupported-partials",
          title: "Unsupported partial Xero repairs",
          severity: "critical",
          count: 1,
          whatWentWrong: "Xero accepted part of an operation.",
          howToFix: "Open the linked record activity and inspect the payloads.",
          items: [
            {
              label: "Member mem_1",
              localModel: "Member",
              localId: "mem_1",
              localUrl: "/admin/xero/records/Member/mem_1",
              xeroObjectType: "CONTACT",
              xeroObjectId: "contact_1",
              xeroObjectNumber: null,
              xeroObjectUrl: "https://go.xero.com/Contacts/View/contact_1",
              operationId: "op_partial_gap",
              operationStatus: "PARTIAL",
              operationType: "CONTACT CREATE",
              correlationKey: null,
              detail: "This partial <script>alert(1)</script> operation does not have a repair handler yet.",
              latestErrorMessage: null,
              createdAt: new Date("2026-04-13T10:05:00Z"),
            },
          ],
        },
        {
          id: "repeated-failures",
          title: "Repeated Xero operation failures",
          severity: "critical",
          count: 1,
          whatWentWrong: "The same correlation key keeps failing.",
          howToFix: "Open the booking record and retry after checking the record.",
          items: [
            {
              label: "Payment pay_1",
              localModel: "Payment",
              localId: "pay_1",
              localUrl: "/admin/xero/records/Payment/pay_1",
              xeroObjectType: "INVOICE",
              xeroObjectId: "inv_1",
              xeroObjectNumber: "INV-001",
              xeroObjectUrl: "https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=inv_1",
              operationId: "op_failed_1",
              operationStatus: "FAILED",
              operationType: "INVOICE CREATE",
              correlationKey: "payment:pay_1:invoice:v1",
              detail: "3 failures for this correlation key.",
              latestErrorMessage: "Rate limit exceeded",
              createdAt: new Date("2026-04-13T10:10:00Z"),
            },
          ],
        },
      ],
      repeatedFailures: [
        {
          correlationKey: "payment:pay_1:invoice:v1",
          failureCount: 3,
          entityType: "INVOICE",
          operationType: "CREATE",
          localModel: "Payment",
          localId: "pay_1",
          localUrl: "/admin/xero/records/Payment/pay_1",
          latestErrorMessage: "Rate limit exceeded",
        },
      ],
      unsupportedPartials: [
        {
          operationId: "op_partial_gap",
          entityType: "CONTACT",
          operationType: "CREATE",
          localModel: "Member",
          localId: "mem_1",
          localUrl: "/admin/xero/records/Member/mem_1",
          reason: "This partial Xero operation does not have a repair handler yet.",
          createdAt: new Date("2026-04-13T10:05:00Z"),
        },
      ],
    });

    expect(html).toContain("Xero Reconciliation Report");
    expect(html).toContain("Missing member contact links");
    expect(html).toContain("Mismatched canonical links");
    expect(html).toContain("Unsupported partial operations");
    expect(html).toContain("Action needed");
    expect(html).toContain("What went wrong");
    expect(html).toContain("How to fix");
    expect(html).toContain("19");
    expect(html).toContain("payment:pay_1:invoice:v1");
    expect(html).toContain("op_partial_gap");
    expect(html).toMatch(/https?:\/\/[^"]+\/admin\/xero\/records\/Member\/mem_1/);
    expect(html).toContain("https://go.xero.com/Contacts/View/contact_1");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("adminXeroReconciliationReportTemplate lists unsettled refund credit notes only when the report counts them (#3548)", async () => {
    const { adminXeroReconciliationReportTemplate } = await import("@/lib/email-templates/admin-xero-reports");
    const summary = {
      missingMemberContactLinks: 0, missingPaymentInvoiceLinks: 0, missingPaymentRefundCreditNoteLinks: 0,
      missingSubscriptionInvoiceLinks: 0, mismatchedCanonicalLinks: 0, staleCanonicalLinks: 0,
      duplicateActiveCanonicalLinks: 0, overCoveredStripeRefundPayments: 0, stalePendingOperations: 0,
      recentFailedOperations: 0, recentPartialOperations: 0, unsupportedPartialOperations: 0,
      repeatedFailureCorrelations: 0, failedInboundEvents: 0, issueCategoryCount: 1, issueTotalCount: 3,
    };
    const base = { generatedAt: new Date("2026-04-13T10:00:00Z"), lookbackHours: 24, stalePendingMinutes: 30, repeatedFailures: [], unsupportedPartials: [] };
    const withCount = adminXeroReconciliationReportTemplate({ ...base, summary: { ...summary, unsettledRefundCreditNotes: 3 } } as never);
    expect(withCount).toContain("Refund credit notes left unsettled");
    const without = adminXeroReconciliationReportTemplate({ ...base, summary } as never);
    expect(without).not.toContain("Refund credit notes left unsettled");
  });
});
