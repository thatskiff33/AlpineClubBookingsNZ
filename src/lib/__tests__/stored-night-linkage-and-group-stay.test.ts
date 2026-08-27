import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3123 — two more places a STORED LODGE NIGHT was projected through
 * `APP_TIME_ZONE`, and one of them decides whether a group still accepts joins.
 *
 * `linkModificationToOutstandingChangeRequest` matches the days an admin just
 * applied against the `yyyy-MM-dd` strings a member typed into a change
 * request. Both sides describe the same calendar day, but only one of them was
 * being projected: for any club behind Greenwich the applied day came back one
 * early and an approved date request could never link, so the approve → apply
 * audit trail silently stayed open.
 *
 * `hasGroupStayFullyEnded` compares a stored `checkOut` against the club's
 * today. It used to derive that day from the container's zone; it now takes it
 * as data, which is the only shape available to a pure predicate called from
 * inside write paths.
 *
 * DISCRIMINATION. `APP_TIME_ZONE` is `America/Denver` — behind Greenwich, and
 * not this codebase's own fallback. Both subjects are pure, so no persisted row
 * is involved here.
 */
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "America/Denver",
  APP_LOCALE: "en-NZ",
}));

const { mockUpdateMany, mockFindMany } = vi.hoisted(() => ({
  mockUpdateMany: vi.fn(),
  mockFindMany: vi.fn(),
}));

import { APP_TIME_ZONE } from "@/config/operational";
import { linkModificationToOutstandingChangeRequest } from "@/lib/booking-change-request-linkage";
import { hasGroupStayFullyEnded } from "@/lib/group-booking";

const storedNight = (day: string) => new Date(`${day}T00:00:00.000Z`);

const db = {
  bookingChangeRequest: {
    findMany: mockFindMany,
    updateMany: mockUpdateMany,
  },
} as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PREMISE", () => {
  it("runs behind Greenwich, where the projection loses a day", () => {
    expect(APP_TIME_ZONE).toBe("America/Denver");
    expect(
      new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(
        storedNight("2026-08-01"),
      ),
    ).toBe("2026-07-31");
  });
});

describe("an approved date request links to the move that fulfils it (#3123)", () => {
  it("matches the member's own `yyyy-MM-dd` against the day the column holds", async () => {
    mockFindMany.mockResolvedValue([
      {
        id: "request-1",
        requestedChanges: {
          requested: { checkIn: "2026-08-01", checkOut: "2026-08-04" },
        },
      },
    ]);
    mockUpdateMany.mockResolvedValue({ count: 1 });

    // Before the fix both applied days projected to 31 July and 3 August, so
    // neither matched what the member asked for and this returned null — the
    // request stayed unlinked, for ever, on every club west of UTC.
    await expect(
      linkModificationToOutstandingChangeRequest(db, {
        bookingId: "booking-1",
        modificationId: "mod-1",
        appliedCheckIn: storedNight("2026-08-01"),
        appliedCheckOut: storedNight("2026-08-04"),
      }),
    ).resolves.toBe("request-1");
  });

  it("still refuses a request the move does NOT fulfil", async () => {
    // The guard the whole function exists for: a wrong link is worse than no
    // link, and decoding rather than projecting must not loosen it.
    mockFindMany.mockResolvedValue([
      {
        id: "request-2",
        requestedChanges: {
          requested: { checkIn: "2026-08-02", checkOut: "2026-08-04" },
        },
      },
    ]);
    mockUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      linkModificationToOutstandingChangeRequest(db, {
        bookingId: "booking-1",
        modificationId: "mod-1",
        appliedCheckIn: storedNight("2026-08-01"),
        appliedCheckOut: storedNight("2026-08-04"),
      }),
    ).resolves.toBeNull();
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("matches identically however the process is oriented", async () => {
    // A stored calendar day takes no zone, so the host cannot move this.
    const original = process.env.TZ;
    try {
      for (const zone of ["UTC", "Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
        process.env.TZ = zone;
        mockFindMany.mockResolvedValue([
          {
            id: "request-3",
            requestedChanges: {
              requested: { checkIn: "2026-08-01", checkOut: "2026-08-04" },
            },
          },
        ]);
        mockUpdateMany.mockResolvedValue({ count: 1 });
        await expect(
          linkModificationToOutstandingChangeRequest(db, {
            bookingId: "booking-1",
            modificationId: "mod-1",
            appliedCheckIn: storedNight("2026-08-01"),
            appliedCheckOut: storedNight("2026-08-04"),
          }),
        ).resolves.toBe("request-3");
      }
    } finally {
      process.env.TZ = original ?? "";
    }
  });
});

describe("hasGroupStayFullyEnded takes the club's day as data (#3123)", () => {
  it("a stay checking out TOMORROW has not ended", () => {
    expect(
      hasGroupStayFullyEnded(
        { checkOut: storedNight("2026-08-02") },
        storedNight("2026-08-01"),
      ),
    ).toBe(false);
  });

  it("a stay checking out TODAY has fully ended — the boundary is unchanged", () => {
    expect(
      hasGroupStayFullyEnded(
        { checkOut: storedNight("2026-08-01") },
        storedNight("2026-08-01"),
      ),
    ).toBe(true);
  });

  it("follows the day it is given, so a club day behind the container's wins", () => {
    // The case the old default got wrong: the container says 1 August, the club
    // (behind it) is still on 31 July, and a group checking out on 1 August is
    // therefore still open for joins.
    expect(
      hasGroupStayFullyEnded(
        { checkOut: storedNight("2026-08-01") },
        storedNight("2026-07-31"),
      ),
    ).toBe(false);
  });
});
