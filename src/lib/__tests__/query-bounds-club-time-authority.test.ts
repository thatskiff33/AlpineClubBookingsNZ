import { describe, expect, it, vi } from "vitest";

/**
 * #3123 — the two admin query builders whose date filters used to be derived
 * from `APP_TIME_ZONE`, and the one that also had to know what day it is.
 *
 * THE COLUMN KIND DECIDES THE SHAPE, and these two files hit both kinds:
 *
 *  - `AuditLog.createdAt` is a bare `DateTime @default(now())` and
 *    `Booking.updatedAt` a bare `DateTime @updatedAt` — real INSTANT columns.
 *    A day filter over one of those is a pair of genuine instant boundaries in
 *    the club's zone, and a UTC-midnight `@db.Date` encoding would be the wrong
 *    shape (`INV-DATE-026`, in the other direction).
 *  - `Booking.checkIn` is `DateTime @db.Date`, so its bound IS the UTC-midnight
 *    encoding, and no zone appears in it at all.
 *
 * DISCRIMINATION. `APP_TIME_ZONE` is pinned to `Pacific/Auckland` — the answer
 * the replaced `date-only` adapters gave, AND this codebase's own fallback, so
 * it is the one value a half-done fix could still pass under. The zone the
 * builders are HANDED is `America/Denver`, which disagrees with it by 18 hours,
 * so no bound below can be right by coincidence. Both subjects are pure and take
 * the zone as data, so there is no persisted row to mock here; that the value
 * reaches them from `ClubTimeSettings` is the route's and the page's job, and is
 * asserted where those resolve it.
 *
 * Bounds are asserted at the exact millisecond. A status code or a row count
 * cannot tell 1 August at UTC midnight from 1 August at Denver midnight, and
 * those two are precisely the pair this migration is about.
 */
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "Pacific/Auckland",
  APP_LOCALE: "en-NZ",
}));

import { APP_TIME_ZONE } from "@/config/operational";
import {
  adminBookingsQuerySchema,
  appliedBookingViewFilters,
  buildAdminBookingsWhere,
  type AdminBookingsClubDay,
} from "@/lib/admin-bookings-service";
import { parseAdminAuditLogQuery } from "@/lib/audit-admin-query";
import {
  dateOnlyInstantOf,
  requireCalendarDate,
  requireClubTimeZone,
} from "@/lib/club-time";

const DENVER = requireClubTimeZone("America/Denver");
const KIRITIMATI = requireClubTimeZone("Pacific/Kiritimati"); // UTC+14
const PAGO = requireClubTimeZone("Pacific/Pago_Pago"); // UTC-11

const clubDay = (zone = DENVER, day = "2026-07-01"): AdminBookingsClubDay => ({
  zone,
  today: dateOnlyInstantOf(requireCalendarDate(day)),
});

function auditWindow(
  from: string | undefined,
  to: string | undefined,
  zone = DENVER,
) {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const parsed = parseAdminAuditLogQuery(params, zone);
  if (!parsed.success) throw new Error("query did not parse");
  const clauses = (parsed.data.where.AND ?? []) as { createdAt?: unknown }[];
  const dateClause = clauses.find((clause) => "createdAt" in clause);
  return dateClause?.createdAt as { gte?: Date; lt?: Date } | undefined;
}

describe("PREMISE: the container and the supplied zone disagree", () => {
  it("pins the environment to the value a half-done fix would still pass under", () => {
    expect(APP_TIME_ZONE).toBe("Pacific/Auckland");
    // 18 hours apart, so every boundary below differs by 18 hours between them.
    expect(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Pacific/Auckland",
      }).format(new Date("2026-08-01T00:00:00.000Z")),
    ).toBe("2026-08-01");
    expect(
      new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(
        new Date("2026-08-01T00:00:00.000Z"),
      ),
    ).toBe("2026-07-31");
  });
});

describe("audit-admin-query bounds createdAt on the CLUB's day (#3123)", () => {
  it("starts the window at club-local midnight, not the container's", () => {
    // 1 August 00:00 in Denver is 2026-08-01T06:00Z. Under the old adapter it
    // was 2026-07-31T12:00Z — Auckland's midnight — which silently swept in six
    // hours of the previous club day.
    expect(auditWindow("2026-08-01", undefined)?.gte).toEqual(
      new Date("2026-08-01T06:00:00.000Z"),
    );
  });

  it("ends it HALF-OPEN at the next club midnight", () => {
    // `lt`, not `lte` against a millisecond-inclusive end: Postgres keeps
    // microseconds, so an inclusive bound can drop a row written in the last
    // millisecond of the day.
    const window = auditWindow(undefined, "2026-08-01");
    expect(window?.lt).toEqual(new Date("2026-08-02T06:00:00.000Z"));
    expect(window).not.toHaveProperty("lte");
  });

  it("MOVES with the zone it is given — kills a hard-coded club zone", () => {
    // The leg a literal "Pacific/Auckland" cannot pass.
    expect(auditWindow("2026-08-01", undefined, KIRITIMATI)?.gte).toEqual(
      new Date("2026-07-31T10:00:00.000Z"),
    );
    expect(auditWindow("2026-08-01", undefined, PAGO)?.gte).toEqual(
      new Date("2026-08-01T11:00:00.000Z"),
    );
  });

  it("refuses a syntactically-valid day that is not a real date", () => {
    // `9999-99-99` passes the schema's regex. The decode names the problem
    // rather than handing Prisma an Invalid Date.
    expect(() => auditWindow("9999-99-99", undefined)).toThrow();
  });
});

describe("admin-bookings-service bounds two different column kinds (#3123)", () => {
  it("bounds updatedAt — a real instant column — on club-local midnights", () => {
    const where = buildAdminBookingsWhere(
      adminBookingsQuerySchema.parse({
        updatedFrom: "2026-08-01",
        updatedTo: "2026-08-01",
      }),
      clubDay(),
    );
    expect(where.updatedAt).toEqual({
      gte: new Date("2026-08-01T06:00:00.000Z"),
      lt: new Date("2026-08-02T06:00:00.000Z"),
    });
  });

  it("bounds checkIn — a `@db.Date` column — on UTC midnight, with NO zone in it", () => {
    // The other half of the same file, and the reason a blanket sweep would
    // have broken it: `?upcoming=` seeds the check-in window from the club's
    // today, and that bound must be the UTC-midnight encoding the column
    // round-trips, never a club-local midnight (which Prisma narrows to the
    // PREVIOUS day for a club behind Greenwich).
    const where = buildAdminBookingsWhere(
      adminBookingsQuerySchema.parse({ upcoming: "7" }),
      clubDay(),
    );
    expect(where.checkIn).toEqual({
      gte: new Date("2026-07-01T00:00:00.000Z"),
      lte: new Date("2026-07-08T00:00:00.000Z"),
    });
  });

  it("the checkIn bound does NOT move when only the zone moves", () => {
    // A stored calendar day takes no zone. Same `today`, three zones, one
    // answer — the assertion a future sweep would fail.
    const rendered = [DENVER, KIRITIMATI, PAGO].map((zone) =>
      JSON.stringify(
        buildAdminBookingsWhere(
          adminBookingsQuerySchema.parse({ upcoming: "7" }),
          clubDay(zone),
        ).checkIn,
      ),
    );
    expect(new Set(rendered).size).toBe(1);
  });

  it("the updatedAt bound DOES move with the zone — kills a hard-coded one", () => {
    const rendered = [DENVER, KIRITIMATI, PAGO].map((zone) =>
      JSON.stringify(
        buildAdminBookingsWhere(
          adminBookingsQuerySchema.parse({ updatedFrom: "2026-08-01" }),
          clubDay(zone),
        ).updatedAt,
      ),
    );
    expect(new Set(rendered).size).toBe(3);
  });

  it("the published filters describe the SAME day the where clause used", () => {
    // `appliedBookingViewFilters` exists only to say what `buildBookingWhere`
    // did. Before #3123 each read the clock for itself, so across club midnight
    // the diagnostics panel could report a window the list was not using. They
    // now take one resolved value, and this pins that they agree.
    const day = clubDay();
    const query = adminBookingsQuerySchema.parse({ upcoming: "7" });
    const applied = appliedBookingViewFilters(query, day);
    const where = buildAdminBookingsWhere(query, day) as {
      checkIn?: { gte?: Date; lte?: Date };
    };
    expect(applied.filters?.checkInFrom).toBe("2026-07-01");
    expect(applied.filters?.checkInTo).toBe("2026-07-08");
    expect(where.checkIn?.gte).toEqual(new Date("2026-07-01T00:00:00.000Z"));
    expect(where.checkIn?.lte).toEqual(new Date("2026-07-08T00:00:00.000Z"));
  });

  it("and follows the club's day when THAT moves, not the container's", () => {
    const applied = appliedBookingViewFilters(
      adminBookingsQuerySchema.parse({ upcoming: "7" }),
      clubDay(DENVER, "2026-06-30"),
    );
    expect(applied.filters?.checkInFrom).toBe("2026-06-30");
    expect(applied.filters?.checkInTo).toBe("2026-07-07");
  });
});
