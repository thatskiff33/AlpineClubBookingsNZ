import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestFindMany: vi.fn(),
  requestUpdateMany: vi.fn(),
  bookingFindMany: vi.fn(),
  sendReminderEmail: vi.fn(),
  getSettings: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bookingRequest: {
      findMany: mocks.requestFindMany,
      updateMany: mocks.requestUpdateMany,
    },
    booking: {
      findMany: mocks.bookingFindMany,
    },
  },
}));

vi.mock("@/lib/email", () => ({
  sendWholeLodgeGuestNamesReminderEmail: mocks.sendReminderEmail,
}));

vi.mock("@/lib/booking-request", () => ({
  getBookingRequestSettings: mocks.getSettings,
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mocks.logAudit,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import {
  countBookingsWithUnnamedPlaceholderGuests,
  PLACEHOLDER_NAME_FINAL_ESCALATION_DAYS,
  sendPlaceholderGuestNameReminders,
} from "@/lib/placeholder-guest-name-reminders";

const DAY_MS = 24 * 60 * 60 * 1000;
// Midday NZ, so the UTC instant and the NZ calendar date agree (AGENTS.md).
const NOW = new Date("2026-08-01T00:00:00.000Z");
const TODAY = new Date("2026-08-01T00:00:00.000Z");

function dateOnly(daysFromToday: number): Date {
  return new Date(TODAY.getTime() + daysFromToday * DAY_MS);
}

function placeholderGuest(ordinal: number) {
  return {
    id: `g-${ordinal}`,
    firstName: "Guest",
    lastName: String(ordinal),
    isMember: false,
    memberId: null,
  };
}

function namedGuest(id: string, firstName: string, lastName: string) {
  return { id, firstName, lastName, isMember: false, memberId: null };
}

function wholeLodgeRequest(overrides: Record<string, unknown> = {}) {
  const { booking, ...requestOverrides } = overrides as {
    booking?: Record<string, unknown>;
  } & Record<string, unknown>;
  return {
    id: "req-wl-1",
    attendeeConfirmationLastSentAt: null,
    convertedBooking: {
      id: "booking-wl-1",
      memberId: "m-1",
      checkIn: dateOnly(10),
      checkOut: dateOnly(12),
      lodgeId: "lodge-1",
      member: { email: "member@example.org", firstName: "Mere" },
      guests: [placeholderGuest(1), placeholderGuest(2)],
      ...(booking ?? {}),
    },
    ...requestOverrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({
    attendeeConfirmationLeadDays: 14,
    attendeeConfirmationReminderDays: 3,
  });
  mocks.requestUpdateMany.mockResolvedValue({ count: 1 });
  mocks.sendReminderEmail.mockResolvedValue(undefined);
  mocks.requestFindMany.mockResolvedValue([]);
  mocks.bookingFindMany.mockResolvedValue([]);
});

describe("sendPlaceholderGuestNameReminders (#2550)", () => {
  it("sends the first reminder to the booking member with the unnamed count", async () => {
    mocks.requestFindMany.mockResolvedValue([wholeLodgeRequest()]);

    const result = await sendPlaceholderGuestNameReminders(NOW);

    expect(result).toEqual({ scanned: 1, sent: 1, skipped: 0, failed: 0 });
    expect(mocks.sendReminderEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendReminderEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-wl-1",
        recipientMemberId: "m-1",
        email: "member@example.org",
        firstName: "Mere",
        guestCount: 2,
        unnamedGuestCount: 2,
        stage: "first",
        lodgeId: "lodge-1",
      }),
    );
  });

  it("claims the cadence stamp before sending and bumps the version fence", async () => {
    mocks.requestFindMany.mockResolvedValue([wholeLodgeRequest()]);

    await sendPlaceholderGuestNameReminders(NOW);

    expect(mocks.requestUpdateMany).toHaveBeenCalledWith({
      where: { id: "req-wl-1", attendeeConfirmationLastSentAt: null },
      data: {
        attendeeConfirmationLastSentAt: NOW,
        version: { increment: 1 },
      },
    });
    const claimOrder = mocks.requestUpdateMany.mock.invocationCallOrder[0];
    const sendOrder = mocks.sendReminderEmail.mock.invocationCallOrder[0];
    expect(claimOrder).toBeLessThan(sendOrder);
  });

  it("sends nothing for a party the member has finished naming", async () => {
    mocks.requestFindMany.mockResolvedValue([
      wholeLodgeRequest({
        booking: {
          guests: [
            namedGuest("g-1", "Jane", "Smith"),
            namedGuest("g-2", "Guest", "Fisher"),
          ],
        },
      }),
    ]);

    const result = await sendPlaceholderGuestNameReminders(NOW);

    expect(result).toEqual({ scanned: 1, sent: 0, skipped: 1, failed: 0 });
    expect(mocks.requestUpdateMany).not.toHaveBeenCalled();
    expect(mocks.sendReminderEmail).not.toHaveBeenCalled();
  });

  it("still reminds for the remainder of a partially named party", async () => {
    mocks.requestFindMany.mockResolvedValue([
      wholeLodgeRequest({
        booking: {
          guests: [
            namedGuest("g-1", "Jane", "Smith"),
            placeholderGuest(2),
            placeholderGuest(3),
          ],
        },
      }),
    ]);

    const result = await sendPlaceholderGuestNameReminders(NOW);

    expect(result.sent).toBe(1);
    expect(mocks.sendReminderEmail).toHaveBeenCalledWith(
      expect.objectContaining({ guestCount: 3, unnamedGuestCount: 2 }),
    );
  });

  it("is idempotent inside the club's reminder interval", async () => {
    mocks.requestFindMany.mockResolvedValue([
      wholeLodgeRequest({
        attendeeConfirmationLastSentAt: new Date(NOW.getTime() - 1 * DAY_MS),
      }),
    ]);

    const result = await sendPlaceholderGuestNameReminders(NOW);

    expect(result).toEqual({ scanned: 1, sent: 0, skipped: 1, failed: 0 });
    expect(mocks.requestUpdateMany).not.toHaveBeenCalled();
    expect(mocks.sendReminderEmail).not.toHaveBeenCalled();
  });

  it("re-sends as a reminder once the interval has elapsed", async () => {
    mocks.requestFindMany.mockResolvedValue([
      wholeLodgeRequest({
        attendeeConfirmationLastSentAt: new Date(NOW.getTime() - 3 * DAY_MS),
      }),
    ]);

    const result = await sendPlaceholderGuestNameReminders(NOW);

    expect(result.sent).toBe(1);
    expect(mocks.sendReminderEmail).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "reminder" }),
    );
  });

  it("escalates to a daily FINAL reminder inside the last two days, beating the club interval", async () => {
    mocks.requestFindMany.mockResolvedValue([
      wholeLodgeRequest({
        // Only one day since the previous send: the ordinary 3-day interval
        // would suppress this, the final escalation does not.
        attendeeConfirmationLastSentAt: new Date(NOW.getTime() - 1 * DAY_MS),
        booking: {
          checkIn: dateOnly(PLACEHOLDER_NAME_FINAL_ESCALATION_DAYS),
          checkOut: dateOnly(PLACEHOLDER_NAME_FINAL_ESCALATION_DAYS + 2),
        },
      }),
    ]);

    const result = await sendPlaceholderGuestNameReminders(NOW);

    expect(result.sent).toBe(1);
    expect(mocks.sendReminderEmail).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "final" }),
    );
  });

  it("still nudges a party that is unnamed on the morning they arrive", async () => {
    mocks.requestFindMany.mockResolvedValue([
      wholeLodgeRequest({
        booking: { checkIn: dateOnly(0), checkOut: dateOnly(2) },
      }),
    ]);

    const result = await sendPlaceholderGuestNameReminders(NOW);

    expect(result.sent).toBe(1);
    expect(mocks.sendReminderEmail).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "final" }),
    );
    // The window really does include the arrival day, so the query cannot be
    // the one that quietly drops it.
    const [args] = mocks.requestFindMany.mock.calls[0] as [
      { where: { convertedBooking: { checkIn: { gte: Date; lte: Date } } } },
    ];
    expect(args.where.convertedBooking.checkIn.gte).toEqual(TODAY);
  });

  it("counts only the guests who will actually be at the lodge (D-12)", async () => {
    // The headcount the email publishes must describe who is operationally
    // present. A PENDING member guest holds a bed and nothing else, and a
    // DECLINED row that survived its removal attempt is not an occupant — so
    // the QUERY has to filter them out, and the query is the only place it can
    // happen. The NULL trap D-12's tests exist to catch is asserted directly:
    // the filter must be the explicit OR, never `{ not: "PENDING" }`, because
    // every placeholder and every ordinary guest carries a NULL consentStatus
    // and `<> 'PENDING'` is UNKNOWN for NULL.
    mocks.requestFindMany.mockResolvedValue([wholeLodgeRequest()]);

    await sendPlaceholderGuestNameReminders(NOW);

    const [args] = mocks.requestFindMany.mock.calls[0] as [
      {
        select: {
          convertedBooking: {
            select: { guests: { where: unknown } };
          };
        };
      },
    ];
    expect(args.select.convertedBooking.select.guests.where).toEqual({
      OR: [{ consentStatus: null }, { consentStatus: "CONFIRMED" }],
    });
  });

  it("keeps every NULL-consent placeholder in the unnamed count", async () => {
    // The behavioural half of the case above: the database returns the filtered
    // party (a CONFIRMED member guest plus two NULL-consent placeholders; the
    // PENDING row the booking also carries never comes back), so the published
    // headcount is 3 rather than 4 and every placeholder is still chased.
    mocks.requestFindMany.mockResolvedValue([
      wholeLodgeRequest({
        booking: {
          guests: [
            { ...namedGuest("g-m", "Ana", "Ngata"), isMember: true, memberId: "m-2" },
            placeholderGuest(1),
            placeholderGuest(2),
          ],
        },
      }),
    ]);

    const result = await sendPlaceholderGuestNameReminders(NOW);

    expect(result.sent).toBe(1);
    expect(mocks.sendReminderEmail).toHaveBeenCalledWith(
      expect.objectContaining({ guestCount: 3, unnamedGuestCount: 2 }),
    );
  });

  it("does nothing when a concurrent run already claimed the stamp", async () => {
    mocks.requestFindMany.mockResolvedValue([wholeLodgeRequest()]);
    mocks.requestUpdateMany.mockResolvedValue({ count: 0 });

    const result = await sendPlaceholderGuestNameReminders(NOW);

    expect(result).toEqual({ scanned: 1, sent: 0, skipped: 1, failed: 0 });
    expect(mocks.sendReminderEmail).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it("counts a failed send without aborting the sweep", async () => {
    mocks.requestFindMany.mockResolvedValue([
      wholeLodgeRequest(),
      wholeLodgeRequest({ id: "req-wl-2" }),
    ]);
    mocks.sendReminderEmail
      .mockRejectedValueOnce(new Error("SES unavailable"))
      .mockResolvedValueOnce(undefined);

    const result = await sendPlaceholderGuestNameReminders(NOW);

    expect(result).toEqual({ scanned: 2, sent: 1, skipped: 0, failed: 1 });
  });

  it("only scans converted MEMBER whole-lodge requests, never school ones", async () => {
    await sendPlaceholderGuestNameReminders(NOW);

    const [args] = mocks.requestFindMany.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    expect(args.where).toMatchObject({
      type: { not: "SCHOOL" },
      requestedByMemberId: { not: null },
      exclusivityRequested: true,
      convertedBookingId: { not: null },
    });
  });

  it("does nothing at all when the club has switched the lead window off", async () => {
    mocks.getSettings.mockResolvedValue({
      attendeeConfirmationLeadDays: 0,
      attendeeConfirmationReminderDays: 3,
    });

    const result = await sendPlaceholderGuestNameReminders(NOW);

    expect(result).toEqual({ scanned: 0, sent: 0, skipped: 0, failed: 0 });
    expect(mocks.requestFindMany).not.toHaveBeenCalled();
  });
});

describe("countBookingsWithUnnamedPlaceholderGuests (#2550)", () => {
  it("counts school and whole-lodge bookings alike, and ignores near-misses", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      { id: "booking-school", guests: [{ ...placeholderGuest(1), firstName: "School Child" }] },
      { id: "booking-whole-lodge", guests: [placeholderGuest(1)] },
      // Matched the coarse database pre-filter, but the detector rejects it.
      { id: "booking-real-guest", guests: [namedGuest("g-9", "Guest", "Fisher")] },
    ]);

    await expect(countBookingsWithUnnamedPlaceholderGuests(NOW)).resolves.toBe(
      2,
    );
  });

  it("scopes the window to the lead days, inclusive of the arrival day", async () => {
    await countBookingsWithUnnamedPlaceholderGuests(NOW);

    const [args] = mocks.bookingFindMany.mock.calls[0] as [
      { where: { checkIn: { gte: Date; lte: Date } } },
    ];
    expect(args.where.checkIn.gte).toEqual(TODAY);
    expect(args.where.checkIn.lte).toEqual(dateOnly(14));
  });

  it("returns zero without querying when the lead window is off", async () => {
    mocks.getSettings.mockResolvedValue({
      attendeeConfirmationLeadDays: 0,
      attendeeConfirmationReminderDays: 3,
    });

    await expect(countBookingsWithUnnamedPlaceholderGuests(NOW)).resolves.toBe(
      0,
    );
    expect(mocks.bookingFindMany).not.toHaveBeenCalled();
  });
});

/**
 * #2550 acceptance criterion: "the stay, check-in, booking-ready state, and
 * chore-roster generation are provably never blocked by unnamed placeholders".
 *
 * The proof is a source census rather than a behavioural assertion, because the
 * property is an ABSENCE: no behavioural test can show that a gate which does
 * not exist will not appear. Enumerating every importer of the two #2550
 * modules does — the day somebody wires the detector into a roster, check-in or
 * confirmation path, this fails and they have to come back to the owner
 * decision that says visibility only.
 */
describe("#2550 never blocks a stay", () => {
  const SRC_DIR = path.join(process.cwd(), "src");

  /** Non-test source files allowed to import the #2550 modules. */
  const ALLOWED_IMPORTERS = new Set([
    // The two generators own the prefixes the detector matches.
    "src/lib/booking-request.ts",
    "src/lib/school-booking-request.ts",
    // The reminder sweep itself, and the two surfaces it feeds.
    "src/lib/placeholder-guest-name-reminders.ts",
    "src/lib/general-cron-runner.ts",
    "src/lib/stuck-state-dashboard.ts",
    /*
     * #3412: the officer's queue previews the school guest list the save is
     * about to regenerate, so it builds the SAME placeholder names the school
     * generator does and reads the prefix from its one home rather than
     * repeating the string. It imports the PREFIX only — never the detector —
     * and the preview gates nothing: it decides which rate boxes to show and
     * which member link the regeneration would move. No stay, check-in,
     * confirmation or roster decision passes through it.
     */
    "src/components/admin/booking-requests/public-booking-requests-panel.tsx",
    /*
     * #3029 S2: the booking dietary write half asks whether a renamed guest is
     * the same person, and a generated placeholder being NAMED is — so an
     * officer's note on "School Child 3" survives the child being named. It
     * decides only whether a dietary note is kept; no stay, check-in,
     * confirmation or roster decision passes through it.
     */
    "src/lib/member-dietary-booking-writes.ts",
  ]);

  function walk(dir: string, files: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full, files);
      } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        files.push(full);
      }
    }
    return files;
  }

  function isTestFile(rel: string): boolean {
    return rel.includes("__tests__") || /\.(test|spec)\.tsx?$/.test(rel);
  }

  const importers = walk(SRC_DIR)
    .map((file) => ({
      rel: path.relative(process.cwd(), file).split(path.sep).join("/"),
      source: fs.readFileSync(file, "utf8"),
    }))
    .filter(
      ({ rel, source }) =>
        !isTestFile(rel) &&
        /@\/lib\/placeholder-guest-names?(-reminders)?"/.test(source),
    )
    .map(({ rel }) => rel)
    .sort();

  it("finds the importers it is meant to police", () => {
    // Safety net: a rename that made the scan match nothing would otherwise
    // turn the contract below into a vacuous pass.
    expect(importers.length).toBeGreaterThanOrEqual(4);
  });

  it("is imported only by the generators and the visibility surfaces", () => {
    expect(
      importers.filter((rel) => !ALLOWED_IMPORTERS.has(rel)),
    ).toEqual([]);
  });

  it("is not reachable from roster generation, check-in, or booking confirmation", () => {
    for (const gate of [
      "src/lib/admin-roster-service.ts",
      "src/lib/roster-status.ts",
      "src/lib/cron-checkin-reminders.ts",
      "src/lib/cron-confirm-pending.ts",
      "src/lib/booking-create.ts",
      "src/lib/kiosk-access.ts",
    ]) {
      expect(importers, `${gate} must not gate on placeholder names`).not.toContain(
        gate,
      );
    }
  });
});
