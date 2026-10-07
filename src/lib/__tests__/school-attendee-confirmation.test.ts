import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestFindMany: vi.fn(),
  requestFindUnique: vi.fn(),
  requestUpdate: vi.fn(),
  requestCount: vi.fn(),
  guestUpdate: vi.fn(),
  transaction: vi.fn(),
  sendConfirmationEmail: vi.fn(),
  getSettings: vi.fn(),
  logAudit: vi.fn(),
  issueActionToken: vi.fn(),
  hashActionToken: vi.fn(),
}));

const txClient = {
  bookingGuest: { update: mocks.guestUpdate },
  bookingRequest: { update: mocks.requestUpdate },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bookingRequest: {
      findMany: mocks.requestFindMany,
      findUnique: mocks.requestFindUnique,
      update: mocks.requestUpdate,
      count: mocks.requestCount,
    },
    $transaction: (cb: (tx: typeof txClient) => Promise<unknown>) =>
      mocks.transaction(cb),
  },
}));

vi.mock("@/lib/email", () => ({
  sendSchoolAttendeeConfirmationEmail: mocks.sendConfirmationEmail,
}));

vi.mock("@/lib/booking-request", () => ({
  getBookingRequestSettings: mocks.getSettings,
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mocks.logAudit,
}));

vi.mock("@/lib/action-tokens", () => ({
  issueActionToken: mocks.issueActionToken,
  hashActionToken: mocks.hashActionToken,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import {
  applySchoolAttendeeConfirmation,
  countUnconfirmedSchoolAttendeeLists,
  getSchoolAttendeeConfirmation,
  resendSchoolAttendeeConfirmation,
  SchoolAttendeeConfirmationError,
  sendSchoolAttendeeConfirmationPrompts,
} from "@/lib/school-attendee-confirmation";

const NOW = new Date("2026-08-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_IN = new Date(NOW.getTime() + 10 * DAY_MS);

function schoolRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    type: "SCHOOL",
    contactFirstName: "Tina",
    contactLastName: "Teacher",
    contactEmail: "teacher@school.example",
    schoolName: "Ruapehu Primary",
    attendeesConfirmedAt: null,
    attendeeConfirmationTokenHash: null,
    attendeeConfirmationTokenExpiresAt: null,
    attendeeConfirmationLastSentAt: null,
    convertedBookingId: "booking-1",
    convertedBooking: {
      id: "booking-1",
      status: "CONFIRMED",
      deletedAt: null,
      checkIn: CHECK_IN,
      checkOut: new Date(CHECK_IN.getTime() + 2 * DAY_MS),
      finalPriceCents: 90000,
      payment: null,
      guests: [
        {
          id: "g1",
          firstName: "School Child",
          lastName: "1",
          ageTier: "CHILD",
          isMember: false,
          memberId: null,
        },
        {
          id: "g2",
          firstName: "Terry",
          lastName: "Teacher",
          ageTier: "ADULT",
          isMember: true,
          memberId: "m-teacher",
        },
      ],
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({
    attendeeConfirmationLeadDays: 14,
    attendeeConfirmationReminderDays: 3,
  });
  mocks.issueActionToken.mockReturnValue({
    token: "raw-token",
    tokenHash: "hashed-token",
  });
  mocks.hashActionToken.mockImplementation((token: string) => `hash:${token}`);
  mocks.requestUpdate.mockResolvedValue({});
  mocks.guestUpdate.mockResolvedValue({});
  mocks.sendConfirmationEmail.mockResolvedValue(undefined);
  mocks.transaction.mockImplementation(
    async (cb: (tx: typeof txClient) => Promise<unknown>) => cb(txClient),
  );
});

describe("sendSchoolAttendeeConfirmationPrompts", () => {
  it("sends the first prompt with a rotated token valid until check-in", async () => {
    mocks.requestFindMany.mockResolvedValue([schoolRequest()]);

    const result = await sendSchoolAttendeeConfirmationPrompts(NOW);

    expect(result).toEqual({ scanned: 1, sent: 1, failed: 0 });
    // Token rotated before the send; the link stays valid until check-in.
    expect(mocks.requestUpdate).toHaveBeenCalledWith({
      where: { id: "req-1" },
      data: {
        attendeeConfirmationTokenHash: "hashed-token",
        attendeeConfirmationTokenExpiresAt: CHECK_IN,
        version: { increment: 1 },
      },
    });
    expect(mocks.sendConfirmationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "teacher@school.example",
        token: "raw-token",
        guestCount: 2,
        isReminder: false,
      }),
    );
    expect(mocks.requestUpdate).toHaveBeenCalledWith({
      where: { id: "req-1" },
      data: { attendeeConfirmationLastSentAt: NOW, version: { increment: 1 } },
    });
  });

  it("re-prompts as a reminder once the cadence window has elapsed", async () => {
    mocks.requestFindMany.mockResolvedValue([
      schoolRequest({
        attendeeConfirmationLastSentAt: new Date(NOW.getTime() - 3 * DAY_MS),
      }),
    ]);

    const result = await sendSchoolAttendeeConfirmationPrompts(NOW);

    expect(result.sent).toBe(1);
    expect(mocks.sendConfirmationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ isReminder: true }),
    );
  });

  it("is idempotent inside a cadence window: reruns send nothing", async () => {
    mocks.requestFindMany.mockResolvedValue([
      schoolRequest({
        attendeeConfirmationLastSentAt: new Date(NOW.getTime() - 1 * DAY_MS),
      }),
    ]);

    const result = await sendSchoolAttendeeConfirmationPrompts(NOW);

    expect(result).toEqual({ scanned: 1, sent: 0, failed: 0 });
    expect(mocks.sendConfirmationEmail).not.toHaveBeenCalled();
    expect(mocks.requestUpdate).not.toHaveBeenCalled();
  });

  it("does nothing when the prompts are disabled (lead days 0)", async () => {
    mocks.getSettings.mockResolvedValue({
      attendeeConfirmationLeadDays: 0,
      attendeeConfirmationReminderDays: 3,
    });

    const result = await sendSchoolAttendeeConfirmationPrompts(NOW);

    expect(result).toEqual({ scanned: 0, sent: 0, failed: 0 });
    expect(mocks.requestFindMany).not.toHaveBeenCalled();
  });

  it("keeps lastSentAt unchanged when the email fails, so the next run retries", async () => {
    mocks.requestFindMany.mockResolvedValue([schoolRequest()]);
    mocks.sendConfirmationEmail.mockRejectedValueOnce(new Error("SES down"));

    const result = await sendSchoolAttendeeConfirmationPrompts(NOW);

    expect(result).toEqual({ scanned: 1, sent: 0, failed: 1 });
    expect(mocks.requestUpdate).toHaveBeenCalledTimes(1); // token rotation only
    expect(mocks.requestUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: { attendeeConfirmationLastSentAt: NOW, version: { increment: 1 } },
      }),
    );
  });
});

describe("getSchoolAttendeeConfirmation", () => {
  it("returns ready with the guest list for a live token", async () => {
    mocks.requestFindUnique.mockResolvedValue(
      schoolRequest({
        attendeeConfirmationTokenExpiresAt: CHECK_IN,
      }),
    );

    const details = await getSchoolAttendeeConfirmation("raw-token", NOW);

    expect(mocks.requestFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { attendeeConfirmationTokenHash: "hash:raw-token" },
      }),
    );
    expect(details.status).toBe("ready");
    expect(details.booking?.guests).toHaveLength(2);
    expect(details.booking?.guests[1].isMember).toBe(true);
  });

  it("reports invalid for an unknown token", async () => {
    mocks.requestFindUnique.mockResolvedValue(null);
    const details = await getSchoolAttendeeConfirmation("raw-token", NOW);
    expect(details.status).toBe("invalid");
  });

  it("reports confirmed once the school has confirmed", async () => {
    mocks.requestFindUnique.mockResolvedValue(
      schoolRequest({ attendeesConfirmedAt: NOW }),
    );
    const details = await getSchoolAttendeeConfirmation("raw-token", NOW);
    expect(details.status).toBe("confirmed");
  });

  it("reports expired past the token expiry", async () => {
    mocks.requestFindUnique.mockResolvedValue(
      schoolRequest({
        attendeeConfirmationTokenExpiresAt: new Date(NOW.getTime() - 1),
      }),
    );
    const details = await getSchoolAttendeeConfirmation("raw-token", NOW);
    expect(details.status).toBe("expired");
  });

  it("reports closed for a cancelled booking", async () => {
    const request = schoolRequest();
    (request.convertedBooking as { status: string }).status = "CANCELLED";
    mocks.requestFindUnique.mockResolvedValue(request);
    const details = await getSchoolAttendeeConfirmation("raw-token", NOW);
    expect(details.status).toBe("closed");
  });
});

describe("applySchoolAttendeeConfirmation", () => {
  beforeEach(() => {
    mocks.requestFindUnique.mockResolvedValue(
      schoolRequest({ attendeeConfirmationTokenExpiresAt: CHECK_IN }),
    );
  });

  it("renames placeholder attendees and records the explicit confirmation", async () => {
    const result = await applySchoolAttendeeConfirmation({
      token: "raw-token",
      guestUpdates: [
        { guestId: "g1", firstName: "Aroha", lastName: "Ngata" },
      ],
      confirm: true,
      now: NOW,
    });

    expect(result).toEqual({ confirmed: true, updatedGuestIds: ["g1"] });
    expect(mocks.guestUpdate).toHaveBeenCalledWith({
      where: { id: "g1" },
      data: { firstName: "Aroha", lastName: "Ngata" },
    });
    expect(mocks.requestUpdate).toHaveBeenCalledWith({
      where: { id: "req-1" },
      data: { attendeesConfirmedAt: NOW, version: { increment: 1 } },
    });
  });

  it("saves names without confirming when confirm is not set", async () => {
    const result = await applySchoolAttendeeConfirmation({
      token: "raw-token",
      guestUpdates: [
        { guestId: "g1", firstName: "Aroha", lastName: "Ngata" },
      ],
      now: NOW,
    });

    expect(result.confirmed).toBe(false);
    expect(mocks.requestUpdate).not.toHaveBeenCalled();
  });

  it("rejects renaming a member guest", async () => {
    await expect(
      applySchoolAttendeeConfirmation({
        token: "raw-token",
        guestUpdates: [
          { guestId: "g2", firstName: "New", lastName: "Name" },
        ],
        now: NOW,
      }),
    ).rejects.toThrow(/Member guest names cannot be edited/);
    expect(mocks.guestUpdate).not.toHaveBeenCalled();
  });

  it("a named child renamed to somebody else loses the previous child's dietary note; a placeholder or a spelling fix keeps it (INV-MOD-059)", async () => {
    const request = schoolRequest({ attendeeConfirmationTokenExpiresAt: CHECK_IN });
    const guests = (request.convertedBooking as { guests: Array<Record<string, unknown>> }).guests;
    guests.push(
      { id: "g3", firstName: "Alice", lastName: "Smith", ageTier: "CHILD", isMember: false, memberId: null },
      { id: "g4", firstName: "Jonh", lastName: "Walker", ageTier: "CHILD", isMember: false, memberId: null },
    );
    mocks.requestFindUnique.mockResolvedValue(request);

    await applySchoolAttendeeConfirmation({
      token: "raw-token",
      guestUpdates: [
        { guestId: "g1", firstName: "Aroha", lastName: "Ngata" },
        { guestId: "g3", firstName: "Bob", lastName: "Jones" },
        { guestId: "g4", firstName: "John", lastName: "Walker" },
      ],
      now: NOW,
    });

    const dataFor = (id: string) =>
      mocks.guestUpdate.mock.calls
        .map((call) => call[0] as { where: { id: string }; data: Record<string, unknown> })
        .find((args) => args.where.id === id)?.data;
    expect(dataFor("g3"), "Alice's note must not stay on Bob's row").toEqual({
      firstName: "Bob",
      lastName: "Jones",
      dietaryRequirements: null,
    });
    expect(dataFor("g1")).not.toHaveProperty("dietaryRequirements");
    expect(dataFor("g4")).not.toHaveProperty("dietaryRequirements");
  });

  it("rejects an already-confirmed list", async () => {
    mocks.requestFindUnique.mockResolvedValue(
      schoolRequest({ attendeesConfirmedAt: NOW }),
    );
    await expect(
      applySchoolAttendeeConfirmation({ token: "raw-token", confirm: true, now: NOW }),
    ).rejects.toBeInstanceOf(SchoolAttendeeConfirmationError);
  });
});

describe("countUnconfirmedSchoolAttendeeLists", () => {
  it("counts requests inside the lead window", async () => {
    mocks.requestCount.mockResolvedValue(2);
    await expect(countUnconfirmedSchoolAttendeeLists(NOW)).resolves.toBe(2);
  });

  it("returns zero when prompts are disabled", async () => {
    mocks.getSettings.mockResolvedValue({
      attendeeConfirmationLeadDays: 0,
      attendeeConfirmationReminderDays: 3,
    });
    await expect(countUnconfirmedSchoolAttendeeLists(NOW)).resolves.toBe(0);
    expect(mocks.requestCount).not.toHaveBeenCalled();
  });
});

describe("resendSchoolAttendeeConfirmation (#1153)", () => {
  it("rotates the token and sends immediately, valid until check-in", async () => {
    mocks.requestFindUnique.mockResolvedValue(schoolRequest());

    const result = await resendSchoolAttendeeConfirmation({
      bookingRequestId: "req-1",
      adminMemberId: "admin-1",
      now: NOW,
    });

    expect(result).toEqual({ sentTo: "teacher@school.example" });
    expect(mocks.requestUpdate).toHaveBeenCalledWith({
      where: { id: "req-1" },
      data: {
        attendeeConfirmationTokenHash: "hashed-token",
        attendeeConfirmationTokenExpiresAt: CHECK_IN,
        version: { increment: 1 },
      },
    });
    expect(mocks.sendConfirmationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ token: "raw-token", isReminder: false }),
    );
    expect(mocks.requestUpdate).toHaveBeenCalledWith({
      where: { id: "req-1" },
      data: { attendeeConfirmationLastSentAt: NOW, version: { increment: 1 } },
    });
  });

  it("uses a short expiry after check-in so late roster fixes stay possible", async () => {
    const request = schoolRequest();
    (request.convertedBooking as { checkIn: Date }).checkIn = new Date(
      NOW.getTime() - 1 * DAY_MS,
    );
    mocks.requestFindUnique.mockResolvedValue(request);

    await resendSchoolAttendeeConfirmation({
      bookingRequestId: "req-1",
      adminMemberId: "admin-1",
      now: NOW,
    });

    expect(mocks.requestUpdate).toHaveBeenCalledWith({
      where: { id: "req-1" },
      data: {
        attendeeConfirmationTokenHash: "hashed-token",
        attendeeConfirmationTokenExpiresAt: new Date(
          NOW.getTime() + 3 * DAY_MS,
        ),
        version: { increment: 1 },
      },
    });
  });

  it("refuses once the list is confirmed", async () => {
    mocks.requestFindUnique.mockResolvedValue(
      schoolRequest({ attendeesConfirmedAt: NOW }),
    );
    await expect(
      resendSchoolAttendeeConfirmation({
        bookingRequestId: "req-1",
        adminMemberId: "admin-1",
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(SchoolAttendeeConfirmationError);
    expect(mocks.sendConfirmationEmail).not.toHaveBeenCalled();
  });

  it("refuses non-school or unconverted requests", async () => {
    mocks.requestFindUnique.mockResolvedValue(
      schoolRequest({ type: "GENERAL" }),
    );
    await expect(
      resendSchoolAttendeeConfirmation({
        bookingRequestId: "req-1",
        adminMemberId: "admin-1",
        now: NOW,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

// F32 (#1888): checkIn is @db.Date (the NZ calendar date at UTC midnight).
// Comparing it against the raw `now` instant shifts the boundary by a day for
// the first ~13h of each NZ day under the TZ=Pacific/Auckland server pin. These
// tests pin the boundary to the NZ calendar date at UTC midnight and assert the
// raw-instant value (which would shift) is not used.
describe("school attendee @db.Date boundaries (F32, #1888)", () => {
  // 2026-08-01T20:00Z is NZ 2026-08-02 08:00 (NZST +12): the UTC calendar day
  // (Aug 1) trails the NZ calendar day (Aug 2), which is exactly the window
  // where a raw `new Date()` comparison mis-dates a @db.Date column.
  const NOW_MORNING_NZ = new Date("2026-08-01T20:00:00.000Z");
  // leadDays defaults to 14 in beforeEach.
  const NZ_TODAY_ISO = "2026-08-02T00:00:00.000Z";
  const NZ_WINDOW_END_ISO = "2026-08-16T00:00:00.000Z"; // today + 14 days

  it("sendSchoolAttendeeConfirmationPrompts filters checkIn on the NZ calendar date, not the instant", async () => {
    mocks.requestFindMany.mockResolvedValue([]);

    await sendSchoolAttendeeConfirmationPrompts(NOW_MORNING_NZ);

    const where = mocks.requestFindMany.mock.calls[0][0].where;
    const checkIn = where.convertedBooking.checkIn;
    expect(checkIn.gt.toISOString()).toBe(NZ_TODAY_ISO);
    expect(checkIn.lte.toISOString()).toBe(NZ_WINDOW_END_ISO);
    // The raw-instant version would have used NOW itself; the fix must not.
    expect(checkIn.gt.getTime()).not.toBe(NOW_MORNING_NZ.getTime());
  });

  it("countUnconfirmedSchoolAttendeeLists uses the same NZ-calendar-date window", async () => {
    mocks.requestCount.mockResolvedValue(0);

    await countUnconfirmedSchoolAttendeeLists(NOW_MORNING_NZ);

    const where = mocks.requestCount.mock.calls[0][0].where;
    const checkIn = where.convertedBooking.checkIn;
    expect(checkIn.gt.toISOString()).toBe(NZ_TODAY_ISO);
    expect(checkIn.lte.toISOString()).toBe(NZ_WINDOW_END_ISO);
    expect(checkIn.gt.getTime()).not.toBe(NOW_MORNING_NZ.getTime());
  });

  it("resend treats a check-in on today's NZ date as arrived, not still-future", async () => {
    // checkIn stored as the NZ 'today' date at UTC midnight. Against the raw
    // instant NOW_MORNING_NZ (Aug 1 20:00Z) it looks future (Aug 2 00:00Z is
    // later), so the raw path would set the expiry to check-in. Keyed off the
    // NZ calendar date it is at/after check-in, so the short 3-day window wins.
    const request = schoolRequest();
    (request.convertedBooking as { checkIn: Date }).checkIn = new Date(
      NZ_TODAY_ISO,
    );
    mocks.requestFindUnique.mockResolvedValue(request);

    await resendSchoolAttendeeConfirmation({
      bookingRequestId: "req-1",
      adminMemberId: "admin-1",
      now: NOW_MORNING_NZ,
    });

    const expiresAt = mocks.requestUpdate.mock.calls[0][0].data
      .attendeeConfirmationTokenExpiresAt as Date;
    // Short window measured from the instant, not the check-in date.
    expect(expiresAt.getTime()).toBe(
      NOW_MORNING_NZ.getTime() + 3 * DAY_MS,
    );
    expect(expiresAt.toISOString()).not.toBe(NZ_TODAY_ISO);
  });
});
