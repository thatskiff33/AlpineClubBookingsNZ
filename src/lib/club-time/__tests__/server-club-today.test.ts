/**
 * `clubTodayDateOnlyInstant` — the club's today, as a `@db.Date` bound
 * (CT-4, #2870; epic #2988).
 *
 * ## What this suite is for, and why it is discriminating
 *
 * The helper replaces `dateOnlyInstantOf((await clubTime()).today())` at fifteen
 * route sites, every one of which uses the result as a Prisma `@db.Date` bound or
 * column write. Two things can go wrong with it and only one of them is visible
 * to an ordinary assertion:
 *
 * - the ENCODING could stop being UTC midnight, which `INV-DATE-026`'s corollary
 *   says silently becomes the previous day once the adapter narrows it;
 * - the ZONE could come from somewhere other than `ClubTimeSettings` — the host,
 *   or `APP_TIME_ZONE` — which is `INV-CONFIG-002`.
 *
 * The second is the one this repository keeps failing to catch, because the
 * shared test harness pins `CLUB_TIME_TEST_ZONE` equal to `APP_TIME_ZONE`'s
 * fallback and 46 of 49 client suites measured on #2870 group D therefore cannot
 * tell the persisted zone from the environment. So the persisted zone here is
 * mocked to **`Pacific/Pago_Pago` (UTC-11)**, which on the frozen clock lands on
 * a DIFFERENT CALENDAR DAY from both `Pacific/Auckland` (`APP_TIME_ZONE`'s
 * fallback) and `UTC` (what the CI runner's host resolves). A helper that read
 * either of those instead of the setting fails here rather than passing quietly.
 *
 * The frozen clock is `2026-07-01T00:00:00.000Z`, so: Auckland reads 1 July
 * 12:00, UTC reads 1 July 00:00, and Pago Pago reads **30 June** 13:00. That
 * 11-hour margin is deliberate — a one-hour fixture would be a premise nobody
 * could see breaking.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { APP_TIME_ZONE } from "@/config/operational";
import { withTimeZoneAsync } from "@/lib/__tests__/helpers/timezone";

/** UTC-11. Behind both the club default and the runner's host. */
const PERSISTED_ZONE = "Pacific/Pago_Pago";

const getClubTimeZone = vi.fn(async () => PERSISTED_ZONE);

vi.mock("@/lib/club-time-zone-settings", () => ({
  getClubTimeZone: () => getClubTimeZone(),
}));

const { clubTime, clubTodayDateOnlyInstant } = await import("../server");

describe("the premise this suite rests on", () => {
  it("pins a persisted zone that is neither APP_TIME_ZONE nor the host's", () => {
    /*
      ASSERTED, NOT ASSUMED. If `APP_TIME_ZONE` were overridden to Pago Pago — or
      to anything sharing its calendar day at the frozen instant — every
      assertion below would pass while proving nothing about where the zone came
      from. That failure mode is exactly what #2870's group D measured across 46
      suites, so it is refused out loud rather than left to chance.
    */
    expect(
      APP_TIME_ZONE,
      "APP_TIME_ZONE is being overridden (TZ / NEXT_PUBLIC_TZ). This suite proves " +
        "the club's PERSISTED zone decides the day, which needs the environment " +
        "zone to differ from the persisted one. This is an environment problem, " +
        "not the defect these tests describe.",
    ).toBe("Pacific/Auckland");
    expect(PERSISTED_ZONE).not.toBe(APP_TIME_ZONE);
  });

  it("the three zones really disagree about what day it is", () => {
    const dayIn = (timeZone: string) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
    expect(dayIn("Pacific/Auckland")).toBe("2026-07-01");
    expect(dayIn("UTC")).toBe("2026-07-01");
    expect(dayIn(PERSISTED_ZONE)).toBe("2026-06-30");
  });
});

describe("clubTodayDateOnlyInstant", () => {
  beforeEach(() => {
    getClubTimeZone.mockClear();
    getClubTimeZone.mockResolvedValue(PERSISTED_ZONE);
  });

  it("encodes the CLUB's day, not the host's and not APP_TIME_ZONE's", async () => {
    // The whole point: 30 June, from the persisted setting. Auckland and UTC both
    // say 1 July at this instant, so either would be visible here.
    await expect(clubTodayDateOnlyInstant()).resolves.toEqual(
      new Date("2026-06-30T00:00:00.000Z"),
    );
  });

  it("is exactly UTC midnight, which is the only bound a @db.Date accepts", async () => {
    /*
      `INV-DATE-026`'s corollary: the Prisma adapter narrows whatever instant it is
      handed to its UTC calendar date, so an encoding at club midnight — or at the
      club's current wall time — becomes the PREVIOUS day with nothing to warn
      you. The four zero fields are the assertion; the ISO string alone would pass
      for a value carrying milliseconds.
    */
    const encoded = await clubTodayDateOnlyInstant();
    expect(encoded.getUTCHours()).toBe(0);
    expect(encoded.getUTCMinutes()).toBe(0);
    expect(encoded.getUTCSeconds()).toBe(0);
    expect(encoded.getUTCMilliseconds()).toBe(0);
    expect(encoded.toISOString()).toBe("2026-06-30T00:00:00.000Z");
  });

  it("agrees with the two-call spelling it replaces", async () => {
    // Byte-for-byte, because fifteen call sites are being moved onto it and a
    // difference would be a behaviour change disguised as a refactor.
    const bound = await clubTime();
    expect((await clubTodayDateOnlyInstant()).toISOString()).toBe(
      new Date(`${bound.today()}T00:00:00.000Z`).toISOString(),
    );
  });

  it("follows the setting when it changes, rather than a value pinned at import", async () => {
    /*
      A module-level `const` resolved once at import is the defect `intl.ts`'s
      docblock records for formatters, and it would be invisible on a deployment
      whose environment agrees with its setting. React `cache()` memoises per
      render pass and degrades to no memo outside one, so a second read here must
      see the new value.
    */
    getClubTimeZone.mockResolvedValue("Pacific/Kiritimati");
    await expect(clubTodayDateOnlyInstant()).resolves.toEqual(
      new Date("2026-07-01T00:00:00.000Z"),
    );
    getClubTimeZone.mockResolvedValue(PERSISTED_ZONE);
    await expect(clubTodayDateOnlyInstant()).resolves.toEqual(
      new Date("2026-06-30T00:00:00.000Z"),
    );
  });

  it("is unaffected by the host machine's timezone", async () => {
    // The host is the OTHER competing authority. Two hosts, one answer.
    const answersIn = (hostZone: string) =>
      withTimeZoneAsync(hostZone, async () =>
        (await clubTodayDateOnlyInstant()).toISOString(),
      );
    expect(await answersIn("UTC")).toBe("2026-06-30T00:00:00.000Z");
    expect(await answersIn("America/Los_Angeles")).toBe("2026-06-30T00:00:00.000Z");
  });

  it("falls back to the documented default for an unusable persisted value", async () => {
    /*
      The same judgement `clubTimeZone` makes and for the same reason: a runtime
      whose ICU has forgotten a zone the club chose years ago must not take the
      application down. The fallback is `Pacific/Auckland`, which reads 1 July.
    */
    getClubTimeZone.mockResolvedValue("Not/AZone");
    await expect(clubTodayDateOnlyInstant()).resolves.toEqual(
      new Date("2026-07-01T00:00:00.000Z"),
    );
  });
});
