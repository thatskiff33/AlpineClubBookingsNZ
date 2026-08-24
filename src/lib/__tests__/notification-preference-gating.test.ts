import { describe, it, expect, vi, beforeEach } from "vitest";
import { declareEnvironmentRole } from "@/lib/__tests__/helpers/environment-role";

// #1285: preference-gating tests. These prove that the OPTIONAL categories are
// honored before the send path. `bookingReminder` is gated in its cron caller
// via the canonical `shouldSendEmail` helper; `choreRoster` is resolved via the
// Option C hybrid `shouldSendChoreRoster` helper (guest's own row wins, else the
// inheriting primary's row, else the documented "no preference → send" default).
// The MUST-SEND transactional categories (bookingConfirmation / bookingBumped /
// bookingCancelled) always send regardless of the member's stored preference.
// Mirrors the mock harness of `phase6b-notifications.test.ts`.

const { mockPrisma, mockTransporter } = vi.hoisted(() => {
  const mockTransporter = {
    sendMail: vi.fn().mockResolvedValue({ messageId: "msg-1" }),
  };
  const mockPrisma = {
    environmentSafetySettings: { findUnique: vi.fn().mockResolvedValue(null) },
    emailLog: {
      create: vi.fn().mockResolvedValue({ id: "log-1" }),
      update: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
    emailSuppression: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    booking: {
      findMany: vi.fn().mockResolvedValue([]),
      // #2258: "No emails" switch off — unchanged behaviour.
      findUnique: vi.fn().mockResolvedValue({ noEmails: false }),
    },
    notificationPreference: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    notificationDeliveryPolicy: {
      findUnique: vi.fn().mockResolvedValue(null),
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

type PrefOverrides = Partial<{
  bookingConfirmation: boolean;
  bookingReminder: boolean;
  bookingBumped: boolean;
  bookingCancelled: boolean;
  choreRoster: boolean;
  marketingEmails: boolean;
}>;

function prefRecord(overrides: PrefOverrides = {}) {
  return {
    bookingConfirmation: true,
    bookingReminder: true,
    bookingBumped: true,
    bookingCancelled: true,
    choreRoster: true,
    marketingEmails: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  // clearAllMocks resets call history but keeps implementations; re-assert the
  // default resolved values so per-test overrides never leak between cases.
  mockTransporter.sendMail.mockResolvedValue({ messageId: "msg-1" });
  mockPrisma.emailLog.create.mockResolvedValue({ id: "log-1" });
  mockPrisma.emailLog.update.mockResolvedValue({});
  mockPrisma.emailLog.findFirst.mockResolvedValue(null);
  mockPrisma.emailSuppression.findFirst.mockResolvedValue(null);
  mockPrisma.booking.findMany.mockResolvedValue([]);
  mockPrisma.notificationPreference.findUnique.mockResolvedValue(null);
});

// ============================================================================
// choreRoster — optional/operational, resolved via the Option C hybrid helper
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

describe("#1285 shouldSendChoreRoster resolves the effective preference (Option C hybrid)", () => {
  it("uses the guest's OWN preference row when present — opted out → suppress", async () => {
    mockPrisma.notificationPreference.findUnique.mockResolvedValue(
      prefRecord({ choreRoster: false }),
    );

    const { shouldSendChoreRoster } = await import("../email/core");
    await expect(
      shouldSendChoreRoster("guest-1", "primary-1"),
    ).resolves.toBe(false);

    // The guest's own row wins, so the inheriting primary is never consulted.
    expect(mockPrisma.notificationPreference.findUnique).toHaveBeenCalledTimes(1);
    expect(mockPrisma.notificationPreference.findUnique).toHaveBeenCalledWith({
      where: { memberId: "guest-1" },
    });
  });

  it("uses the guest's OWN preference row when present — opted in → send", async () => {
    mockPrisma.notificationPreference.findUnique.mockResolvedValue(
      prefRecord({ choreRoster: true }),
    );

    const { shouldSendChoreRoster } = await import("../email/core");
    await expect(
      shouldSendChoreRoster("guest-1", "primary-1"),
    ).resolves.toBe(true);
  });

  it("falls back to the inheriting primary — dependent has no own row, primary opted out → suppress", async () => {
    mockPrisma.notificationPreference.findUnique.mockImplementation(
      ({ where }: { where: { memberId: string } }) => {
        if (where.memberId === "primary-1") {
          return Promise.resolve(prefRecord({ choreRoster: false }));
        }
        return Promise.resolve(null); // dependent-1 has no own row
      },
    );

    const { shouldSendChoreRoster } = await import("../email/core");
    await expect(
      shouldSendChoreRoster("dependent-1", "primary-1"),
    ).resolves.toBe(false);

    expect(mockPrisma.notificationPreference.findUnique).toHaveBeenCalledWith({
      where: { memberId: "dependent-1" },
    });
    expect(mockPrisma.notificationPreference.findUnique).toHaveBeenCalledWith({
      where: { memberId: "primary-1" },
    });
  });

  it("falls back to the inheriting primary — dependent has no own row, primary opted in → send", async () => {
    mockPrisma.notificationPreference.findUnique.mockImplementation(
      ({ where }: { where: { memberId: string } }) => {
        if (where.memberId === "primary-1") {
          return Promise.resolve(prefRecord({ choreRoster: true }));
        }
        return Promise.resolve(null);
      },
    );

    const { shouldSendChoreRoster } = await import("../email/core");
    await expect(
      shouldSendChoreRoster("dependent-1", "primary-1"),
    ).resolves.toBe(true);
  });

  it("defaults to send when neither the guest nor the primary has a row", async () => {
    mockPrisma.notificationPreference.findUnique.mockResolvedValue(null);

    const { shouldSendChoreRoster } = await import("../email/core");
    await expect(
      shouldSendChoreRoster("dependent-1", "primary-1"),
    ).resolves.toBe(true);
  });

  it("defaults to send when the guest has no row and does not inherit an email", async () => {
    mockPrisma.notificationPreference.findUnique.mockResolvedValue(null);

    const { shouldSendChoreRoster } = await import("../email/core");
    await expect(shouldSendChoreRoster("member-1", null)).resolves.toBe(true);
  });

  it("sends to a non-member guest (no memberId) without consulting preferences", async () => {
    const { shouldSendChoreRoster } = await import("../email/core");
    await expect(shouldSendChoreRoster(null, null)).resolves.toBe(true);
    expect(mockPrisma.notificationPreference.findUnique).not.toHaveBeenCalled();
  });
});

// ============================================================================
// bookingReminder — optional check-in reminder, honored on the send path
// ============================================================================

describe("#1285 check-in reminders honor the bookingReminder preference", () => {
  const bookingFixture = {
    id: "booking-1",
    checkIn: new Date("2026-04-10T00:00:00.000Z"),
    checkOut: new Date("2026-04-12T00:00:00.000Z"),
    status: "CONFIRMED",
    member: {
      id: "member-1",
      email: "mia@example.com",
      firstName: "Mia",
    },
    guests: [],
    choreAssignments: [],
  };

  it("does NOT call the email transport when the member opted out", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([bookingFixture]);
    mockPrisma.notificationPreference.findUnique.mockResolvedValue(
      prefRecord({ bookingReminder: false }),
    );

    const { sendCheckinReminders } = await import("../cron-checkin-reminders");
    const result = await sendCheckinReminders();

    expect(mockPrisma.notificationPreference.findUnique).toHaveBeenCalledWith({
      where: { memberId: "member-1" },
    });
    expect(mockPrisma.emailLog.create).not.toHaveBeenCalled();
    expect(mockTransporter.sendMail).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, skipped: 1 });
  });

  it("sends when the member keeps the reminder switched on", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([bookingFixture]);
    mockPrisma.notificationPreference.findUnique.mockResolvedValue(
      prefRecord({ bookingReminder: true }),
    );

    const { sendCheckinReminders } = await import("../cron-checkin-reminders");
    const result = await sendCheckinReminders();

    expect(mockTransporter.sendMail).toHaveBeenCalledTimes(1);
    expect(result.sent).toBe(1);
  });
});

// ============================================================================
// Must-send transactional categories always send, regardless of preference
// ============================================================================

describe("#1285 must-send transactional mail is never suppressible", () => {
  it("sends a cancellation notice even when bookingCancelled is switched off", async () => {
    mockPrisma.notificationPreference.findUnique.mockResolvedValue(
      prefRecord({ bookingCancelled: false }),
    );

    const { sendBookingCancelledEmail } = await import("../email");
    await sendBookingCancelledEmail(
      { bookingId: "bk_test", recipientMemberId: "member_1" },
      "mia@example.com",
      "Mia",
      new Date("2026-04-10T00:00:00.000Z"),
      new Date("2026-04-12T00:00:00.000Z"),
      0,
    );

    // The cancellation sender must never consult notification preferences and
    // must always reach the transport.
    expect(mockPrisma.notificationPreference.findUnique).not.toHaveBeenCalled();
    expect(mockTransporter.sendMail).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// D-12 (#2307): the check-in reminder never NAMES an unconsented member guest
// ============================================================================
//
// Owner decision D-12: a member guest whose consent is still PENDING holds a bed
// (D-4) but is not operationally present. This email lists guests by name, so a
// pending row here means the club tells the booker the add is settled and tells
// the named member's name to somebody, neither of which has been agreed. The
// guest names come straight off the booking include, so the include is where the
// exclusion has to live.
//
// This suite drives the real email chain (the same harness the preference tests
// above use), so the assertion is on what the member would actually receive.
describe("#2307 check-in reminders exclude unconsented member guests (D-12)", () => {
  // Applies the guest `where` the production query sends, the way Prisma would.
  // A mock that ignored it would pass with the filter deleted.
  function seedBooking(
    guests: Array<{
      firstName: string;
      lastName: string;
      consentStatus: string | null;
    }>,
  ) {
    mockPrisma.booking.findMany.mockImplementation(
      async (args: {
        include: {
          guests: true | { where?: { OR?: Array<{ consentStatus: string | null }> } };
        };
      }) => {
        const where =
          args.include.guests === true ? undefined : args.include.guests.where;
        return [
          {
            id: "booking-1",
            checkIn: new Date("2026-04-10T00:00:00.000Z"),
            checkOut: new Date("2026-04-12T00:00:00.000Z"),
            status: "CONFIRMED",
            lodgeId: null,
            member: {
              id: "member-1",
              email: "mia@example.com",
              firstName: "Mia",
            },
            guests: guests.filter(
              (guest) =>
                !where?.OR ||
                where.OR.some(
                  (branch) => branch.consentStatus === guest.consentStatus,
                ),
            ),
            choreAssignments: [],
          },
        ];
      },
    );
  }

  it("names null- and CONFIRMED-consent guests and never the PENDING one", async () => {
    seedBooking([
      // Null consent is the ordinary guest — every non-member, every family add,
      // every legacy row — and is exactly what the `{ not: "PENDING" }` trap
      // would have deleted from every reminder the club sends.
      { firstName: "Nula", lastName: "Ordinary", consentStatus: null },
      { firstName: "Connie", lastName: "Agreed", consentStatus: "CONFIRMED" },
      { firstName: "Penny", lastName: "Awaiting", consentStatus: "PENDING" },
    ]);
    mockPrisma.notificationPreference.findUnique.mockResolvedValue(
      prefRecord({ bookingReminder: true }),
    );

    const { sendCheckinReminders } = await import("../cron-checkin-reminders");
    const result = await sendCheckinReminders();

    expect(result.sent).toBe(1);
    const html = mockTransporter.sendMail.mock.calls[0][0].html as string;
    expect(html).toContain("Nula Ordinary");
    expect(html).toContain("Connie Agreed");
    expect(html).not.toContain("Penny");
    expect(html).not.toContain("Awaiting");
    // The headcount in the same email agrees with the list beside it.
    expect(html).toContain(">2<");
  });

  it("sends the operational-presence predicate in the guest include", async () => {
    seedBooking([]);
    mockPrisma.notificationPreference.findUnique.mockResolvedValue(
      prefRecord({ bookingReminder: true }),
    );

    const { sendCheckinReminders } = await import("../cron-checkin-reminders");
    await sendCheckinReminders();

    const args = mockPrisma.booking.findMany.mock.calls[0][0] as {
      include: { guests: { where?: { OR?: unknown } } };
    };
    expect(args.include.guests.where?.OR).toEqual([
      { consentStatus: null },
      { consentStatus: "CONFIRMED" },
    ]);
  });
});
