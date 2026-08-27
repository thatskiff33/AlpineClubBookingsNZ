/**
 * `storedDateOnly` — the shared normalisation six modules had each written out
 * (CT-4, #2870; epic #2988).
 *
 * ## What has to hold, and why each of these is a real failure mode
 *
 * The helper is hoisted from six byte-identical file-local clones, so the first
 * job of this suite is to pin the behaviour those call sites already depend on:
 * it is the IDENTITY for a value that is already a `@db.Date` encoding, which is
 * what lets a caller normalise a mixture of freshly-read rows and values it built
 * itself and then compare them.
 *
 * The second job is the zone. `normalizeDateOnlyForTimeZone`, which every one of
 * those clones replaced, projected the stored value through `APP_TIME_ZONE`
 * FIRST — the identity for a club ahead of Greenwich and the PREVIOUS day for one
 * behind it. That regression cannot be seen on this deployment at all, because
 * `APP_TIME_ZONE` defaults to `Pacific/Auckland` and projecting UTC midnight into
 * a zone ahead of Greenwich lands on club midday, the same day. So the host is
 * moved instead: under `America/Los_Angeles` a spelling that read the host, or
 * that projected through it, comes back a day early and the case fails.
 *
 * `docs/CLUB_TIME_KERNEL.md` and this module's own docblock carry the rule
 * attribution: the decode is `INV-DATE-019`'s first exact boundary plus
 * `INV-DATE-026`, and the re-encode is `INV-DATE-026`'s corollary. `INV-DATE-010`
 * is deliberately NOT cited for either direction.
 */
import { describe, expect, it } from "vitest";

import { storedDateOnly } from "@/lib/stored-calendar-day";
import { withTimeZone } from "@/lib/__tests__/helpers/timezone";

/** The UTC-midnight encoding of a calendar day, the way Prisma hands one back. */
const stored = (day: string) => new Date(`${day}T00:00:00.000Z`);

describe("a stored calendar day survives the round trip", () => {
  it("returns the same instant for a value that is already the encoding", () => {
    for (const day of [
      "2026-07-01",
      "2026-01-01",
      "2026-12-31",
      "2028-02-29",
      "2026-04-05",
      "2026-09-27",
    ]) {
      expect(storedDateOnly(stored(day)).toISOString(), day).toBe(
        `${day}T00:00:00.000Z`,
      );
    }
  });

  it("is idempotent, which is what lets a caller normalise twice safely", () => {
    // `booking-modification-stay-ranges` says so in its docblock and relies on
    // it: a caller that has already decoded its rows hands in values this leaves
    // alone.
    const once = storedDateOnly(stored("2026-07-01"));
    expect(storedDateOnly(once)).toEqual(once);
    expect(storedDateOnly(storedDateOnly(once))).toEqual(once);
  });

  it("floors a value carrying a time of day to the day it is on in UTC", () => {
    /*
      The other half of "normalisation": a `@db.Date` column cannot hold a time,
      but a value built in application code can, and the comparison the six call
      sites make needs both sides at the same instant. Reading in UTC is
      `INV-DATE-019`'s first exact boundary — the column encodes a calendar day,
      not a moment.
    */
    expect(storedDateOnly(new Date("2026-07-01T13:45:12.345Z")).toISOString()).toBe(
      "2026-07-01T00:00:00.000Z",
    );
    expect(storedDateOnly(new Date("2026-07-01T23:59:59.999Z")).toISOString()).toBe(
      "2026-07-01T00:00:00.000Z",
    );
  });
});

describe("no zone can reach it — which is the whole point of the hoist", () => {
  it("the two host zones really differ, before anything is compared", () => {
    // A host-zone pair that resolves to one zone passes vacuously. That is how a
    // guard in this repository stayed green while its own defect was restored.
    const seen = new Set(
      ["UTC", "America/Los_Angeles"].map((zone) =>
        withTimeZone(zone, () => Intl.DateTimeFormat().resolvedOptions().timeZone),
      ),
    );
    expect(seen.size).toBe(2);
  });

  it("gives the same answer under a behind-UTC host", () => {
    /*
      DISCRIMINATING WHERE THE SHIPPED CONFIG CANNOT BE. Under
      `America/Los_Angeles` the spelling this replaced —
      `parseDateOnly(formatDateOnlyForTimeZone(value))`, i.e. project then
      re-encode — returns 30 June for a stored 1 July. The `answersIn` pair fails
      if any part of the chain consults a clock.
    */
    const answersIn = (hostZone: string) =>
      withTimeZone(hostZone, () =>
        ["2026-07-01", "2026-01-01", "2026-03-08"].map((day) =>
          storedDateOnly(stored(day)).toISOString(),
        ),
      );
    expect(answersIn("UTC")).toEqual(answersIn("America/Los_Angeles"));
    expect(answersIn("America/Los_Angeles")).toEqual([
      "2026-07-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "2026-03-08T00:00:00.000Z",
    ]);
  });

  it("differs from the projecting spelling it replaced, under that host", () => {
    /*
      The regression written out, so this suite is about a defect rather than about
      an implementation. A behind-UTC reading of the UTC-midnight encoding IS the
      previous day; that is the class, and it is why the six clones exist.
    */
    const projected = withTimeZone("America/Los_Angeles", () =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Los_Angeles",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(stored("2026-07-01")),
    );
    expect(projected, "the projecting spelling lands a day early").toBe("2026-06-30");
    expect(storedDateOnly(stored("2026-07-01")).toISOString().slice(0, 10)).toBe(
      "2026-07-01",
    );
  });
});

describe("what it refuses, rather than answering plausibly", () => {
  it("throws for an Invalid Date instead of producing a wrong day", () => {
    // A failed parse upstream must not become a real, plausible night. The six
    // clones behaved identically; this pins it so the hoist cannot loosen it.
    expect(() => storedDateOnly(new Date(NaN))).toThrow();
  });

  it("throws for a value outside the four-digit calendar-date range", () => {
    // `calendarDateOfDateOnlyInstant`'s documented refusal: a `@db.Date` holding
    // something other than a club calendar day looks like this from here.
    expect(() => storedDateOnly(new Date("-000001-01-01T00:00:00.000Z"))).toThrow();
  });
});
