/**
 * What actually reaches Postgres when a `Date` is bound against a `@db.Date`
 * column, and against a plain `DateTime` one (#2838).
 *
 * WHY THIS EXISTS. Every date-boundary suite in this repository — the club-day
 * ones added by #2838, and the older windows they sit beside — models the
 * adapter's narrowing in a local helper (`boundDay`: "its UTC date, time
 * discarded") and reasons from there. That model is the load-bearing premise of
 * INV-DATE-013: it is the single step that turns "the value is twelve hours
 * early" into "the query asks about the wrong DAY". Nothing in the tree
 * exercised it. A change to how `@prisma/adapter-pg` binds a date would move
 * production behaviour with the whole suite green, because every one of those
 * files would go on asserting against its own copy of the assumption.
 *
 * HOW. The real generated Prisma Client, the real query compiler and the real
 * `PrismaPg` adapter, over a `pg.Pool` whose `query` is replaced by a recorder.
 * Nothing connects to anything: the pool is given an unreachable address and is
 * never asked for a connection. What is asserted is the `values` array the
 * adapter hands the driver — one hop before the wire.
 *
 * This is deliberately NOT a re-implementation of `mapArg`. Asserting that
 * `formatDate` calls `getUTCDate()` would only restate the mechanism; driving
 * the client is what makes the assertion fail if a future version stops doing
 * it, for whatever reason.
 */
import pg from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getTodayDateOnly, startOfDateOnlyForTimeZone } from "@/lib/date-only";

/**
 * The club's zone, named rather than left to the two helpers' `APP_TIME_ZONE`
 * default, which #3123 deletes. New Zealand is what this file's one zone-bearing
 * assertion is written against: club midnight on 2 July 2026 is
 * `2026-07-01T12:00:00.000Z` only at UTC+12. The `getTodayDateOnly` assertion
 * takes it too, and is indifferent to it — the date-only encoding is UTC midnight
 * for every club.
 */
const CLUB_ZONE = "Pacific/Auckland";

type CapturedQuery = { text: string; values: unknown[] };

const captured: CapturedQuery[] = [];

/**
 * A real `pg.Pool` — `PrismaPg` treats an argument as an external pool only when
 * it passes `instanceof pg.Pool`, and the factory attaches an `error` listener
 * to it — with its `query` swapped for a recorder. The connection string points
 * at a port nothing listens on, and no path here ever asks the pool to connect.
 */
const pool = new pg.Pool({
  connectionString: "postgresql://unused:unused@127.0.0.1:1/unused",
});
pool.query = (async (config: unknown) => {
  captured.push(config as CapturedQuery);
  return { fields: [], rows: [], rowCount: 0, command: "SELECT" };
}) as typeof pool.query;

const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => {
  captured.length = 0;
});

/**
 * The WHERE parameters of the one statement the client emitted.
 *
 * The compiler appends its own `LIMIT`/`OFFSET` placeholders after the filter's,
 * so the filter parameters are the leading `count` of them. The SQL text is
 * asserted alongside, which is what anchors "leading" to the right operands
 * rather than to a position that could silently change meaning.
 */
function whereValues(count: number, sqlContains: string): unknown[] {
  expect(
    captured.length,
    "Expected exactly one statement. If the client now emits more (a " +
      "transaction wrapper, a preamble), select the one carrying the filter " +
      "rather than relaxing this.",
  ).toBe(1);
  expect(captured[0].text).toContain(sqlContains);
  return captured[0].values.slice(0, count);
}

describe("a @db.Date column is bound as a calendar DAY (#2838, INV-DATE-013)", () => {
  it("throws the time away and sends the value's UTC date", async () => {
    // 12:00Z on 1 July is midnight on 2 July in NZST — the exact instant the old
    // `new Date()` + `setHours(0, 0, 0, 0)` produced under the server's
    // `TZ=Pacific/Auckland` pin, and the one INV-DATE-013 says lands a day early.
    await prisma.booking.findMany({
      where: { checkIn: { gte: new Date("2026-07-01T12:00:00.000Z") } },
    });

    expect(
      whereValues(1, '"checkIn" >= $1'),
      "INV-DATE-013: `Booking.checkIn` is `@db.Date`, and the adapter narrows a " +
        "bound Date to its UTC calendar date (`formatDate` in `mapArg`). If this " +
        "is no longer a bare `yyyy-MM-dd`, every club-day boundary suite in this " +
        "repository is reasoning from a model of the adapter that no longer holds.",
    ).toEqual(["2026-07-01"]);
  });

  it("THE DEFECT: the old and new values for the SAME club day bind as different days", async () => {
    // Club day 2 July 2026, spelled both ways.
    const clubDay = "2026-07-02";
    const localMidnightUnderNzPin = new Date("2026-07-01T12:00:00.000Z");
    const dateOnly = new Date(`${clubDay}T00:00:00.000Z`);
    // Both name midnight at the start of the same NZ day; only the encoding
    // differs. (`getTodayDateOnly()` produces the second shape — UTC midnight.)
    expect(getTodayDateOnly(CLUB_ZONE).toISOString()).toMatch(/T00:00:00\.000Z$/);

    await prisma.booking.findMany({ where: { checkIn: { gte: localMidnightUnderNzPin } } });
    const old = whereValues(1, '"checkIn" >= $1');

    captured.length = 0;
    await prisma.booking.findMany({ where: { checkIn: { gte: dateOnly } } });
    const fixed = whereValues(1, '"checkIn" >= $1');

    expect(old).toEqual(["2026-07-01"]);
    expect(fixed).toEqual([clubDay]);
    expect(
      old,
      "INV-DATE-013: this inequality IS #2838. Two spellings of the same NZ " +
        "midnight reach Postgres as different calendar days, so a window built " +
        "on the local-midnight one runs a day behind — all day, every day.",
    ).not.toEqual(fixed);
  });

  it("binds a two-ended window as the two days the dashboard means", async () => {
    // The dashboard's staying-guest read, in the shape it actually compiles to:
    // `checkIn <= tomorrow AND checkOut >= today`, both `@db.Date`.
    const today = new Date("2026-07-02T00:00:00.000Z");
    const tomorrow = new Date("2026-07-03T00:00:00.000Z");

    await prisma.booking.findFirst({
      where: { checkIn: { lte: tomorrow }, checkOut: { gte: today } },
      select: { id: true },
    });

    expect(whereValues(2, '"checkIn" <= $1')).toEqual(["2026-07-03", "2026-07-02"]);
  });
});

describe("a plain DateTime column keeps the whole instant (#2838, INV-DATE-013)", () => {
  it("sends the time as well as the date", async () => {
    // `Booking.draftExpiresAt` is a real moment, so it is NOT narrowed. This is
    // the other half of the rule the dashboard states: handing this column a
    // date-only value would bind UTC midnight, which is club MIDDAY, and hide a
    // draft expiring that morning.
    const startOfClubDay = startOfDateOnlyForTimeZone("2026-07-02", CLUB_ZONE);
    expect(startOfClubDay.toISOString()).toBe("2026-07-01T12:00:00.000Z");

    await prisma.booking.findMany({
      where: { draftExpiresAt: { gt: startOfClubDay } },
    });

    expect(
      whereValues(1, '"draftExpiresAt" > $1'),
      "INV-DATE-013: a `DateTime` column must keep its time. If this were " +
        "narrowed to a day, the two encodings the dashboard keeps apart would " +
        "have collapsed into one and the distinction it documents would be dead " +
        "code.",
    ).toEqual(["2026-07-01 12:00:00"]);
  });

  it("THE SAME INSTANT, one statement, two columns, two different values", async () => {
    // The cleanest statement of the whole rule, and the reason #2868 could not
    // be fixed by choosing a better single value: ONE `Date` is bound to a
    // `@db.Date` column and a `DateTime` column in a SINGLE query, and the
    // adapter sends two different things for it. The narrowing is driven by the
    // COLUMN, not by the value — so a window shared across both kinds of column
    // is wrong for one of them no matter which instant it holds.
    const clubMidnightUnderNzPin = new Date("2026-06-30T12:00:00.000Z");

    await prisma.booking.findMany({
      where: {
        checkIn: { gte: clubMidnightUnderNzPin },
        draftExpiresAt: { gte: clubMidnightUnderNzPin },
      },
    });

    expect(
      whereValues(2, '"checkIn" >= $1'),
      "INV-DATE-013: one bound value, two columns, two encodings. If these ever " +
        "agree, the distinction every date-boundary suite in this repository " +
        "rests on has stopped existing.",
    ).toEqual(["2026-06-30", "2026-06-30 12:00:00"]);
  });

  it("would sit at club MIDDAY if given a date-only value", async () => {
    // The mistake in the other direction, made executable rather than described.
    await prisma.booking.findMany({
      where: { draftExpiresAt: { gt: new Date("2026-07-02T00:00:00.000Z") } },
    });

    // 00:00Z on 2 July is midday on 2 July in NZ — twelve hours past the start
    // of the club day the value was meant to name.
    expect(whereValues(1, '"draftExpiresAt" > $1')).toEqual(["2026-07-02 00:00:00"]);
  });
});

describe("the columns #2872 narrowed bind as calendar DAYS (CT-3, epic #2988)", () => {
  /*
    WHY THESE ARE HERE AND NOT LEFT TO THE THREE ABOVE. #2838 pinned the adapter's
    behaviour on `Booking.checkIn`, which has been `@db.Date` since it was
    created. #2872 narrowed eleven columns that were bare `DateTime` — three of
    them on `Member`, the rest across four other tables — and the whole reason
    that change is risky is that a bound value which used to reach Postgres whole
    now reaches it as a DAY. So the probe follows the migration: each newly
    narrowed column is driven through the real client, the real compiler and the
    real adapter, and what the driver would receive is asserted.

    The issue asks for "representative" migrated fields rather than all eleven.
    These are the representatives, chosen for what each one proves: a `Member`
    column (the hot table, and the one an age-tier cutoff filters on), a
    `PromoCode` window edge (money), a family-request date of birth, and a
    deadline that a reader still compares against a clock. One more case covers
    the twelfth CANDIDATE, `MembershipNominationSettings.gateEffectiveFrom`,
    which #2872 deliberately did NOT narrow — an exclusion is only real if
    something fails when it is quietly undone.
  */

  it("narrows a Member date-of-birth bound to its UTC day", async () => {
    await prisma.member.findMany({
      where: { dateOfBirth: { lt: new Date("2008-04-02T00:00:00.000Z") } },
    });

    expect(
      whereValues(1, '"dateOfBirth" < $1'),
      "INV-DATE-026: `Member.dateOfBirth` is `@db.Date` since #2872, and this " +
        "file is that rule's executable form. If this comes back with a time on " +
        "it the migration has not been applied to the schema the client was " +
        "generated from, and every bound below is asking a different question " +
        "than it reads as.",
    ).toEqual(["2008-04-02"]);
  });

  it("THE REGRESSION #2872 HAD TO FIX: a host-local-midnight bound binds the PREVIOUS day", async () => {
    // The age-up cron built its cutoff with `new Date(year, month, day)` —
    // HOST-local midnight. Under the Dockerfile's `TZ=Pacific/Auckland` pin that
    // is 11:00 or 12:00 UTC on the day BEFORE. While `dateOfBirth` was a plain
    // `DateTime` the whole instant was bound and the comparison was right; the
    // moment the column became `@db.Date` the adapter started throwing the time
    // away, so the bound moved back a day and the member born on exactly the
    // season-start anniversary fell out of the candidate set — one season late
    // for their own age-up, which is a price and a hosting right.
    //
    // The instant is written out rather than constructed locally, so this asserts
    // the same thing in every runner zone (docs/TESTING.md rule 6).
    const localMidnightUnderNzPin = new Date("2008-04-01T11:00:00.000Z");

    await prisma.member.findMany({
      where: { dateOfBirth: { lt: localMidnightUnderNzPin } },
    });

    expect(
      whereValues(1, '"dateOfBirth" < $1'),
      "INV-DATE-013: this is the defect, made executable. If these two ever " +
        "agree, the reason cron-age-up.ts binds a calendar day has stopped " +
        "existing and the comment there is lying to the next reader.",
    ).toEqual(["2008-04-01"]);
  });

  it("binds the shape the applications path actually produces — new Date(yyyy-MM-dd)", async () => {
    // The membership-application route validates a bare `yyyy-MM-dd` with zod and
    // `nomination.ts` wraps it in `new Date(...)` before Prisma ever sees it, so
    // a `Date` is the only shape this column is ever written with. That call
    // takes ECMAScript's DATE-ONLY branch, which is UTC midnight, and the adapter
    // must narrow it back to the day it names. If it ever stopped doing so, a
    // membership application would store the wrong birthday with nothing in the
    // type system to notice.
    await prisma.memberApplication.findMany({
      where: { applicantDateOfBirth: new Date("2001-01-01") },
    });
    expect(whereValues(1, '"applicantDateOfBirth" =')).toEqual(["2001-01-01"]);

    // And the same value once it has been through JSON and back. `mapArg` turns
    // a string into a `Date` first and then formats it for the column, so the two
    // shapes must land on the same day.
    captured.length = 0;
    await prisma.memberApplication.findMany({
      where: { applicantDateOfBirth: "2001-01-01T00:00:00.000Z" },
    });
    expect(whereValues(1, '"applicantDateOfBirth" =')).toEqual(["2001-01-01"]);
  });

  it("REFUSES a bare yyyy-MM-dd string, which is why every writer wraps it", async () => {
    // Worth pinning rather than assuming, because it is what makes the wrap above
    // something other than ceremony: the client rejects the bare day outright
    // instead of guessing at it, so a future writer that skipped `new Date` would
    // fail loudly at the call rather than quietly a day out.
    await expect(
      prisma.memberApplication.findMany({
        where: { applicantDateOfBirth: "2001-01-01" },
      }),
    ).rejects.toThrow(/ISO-8601 DateTime/);
  });

  it("narrows a promo window edge, a family-request date of birth and a join deadline", async () => {
    // Three columns on three tables in one pass. `PromoCode.bookingStartFrom`
    // gates on a booking's `checkIn`, which is itself `@db.Date`: the two are now
    // the same kind of value, which is the point of narrowing it.
    await prisma.promoCode.findMany({
      where: { bookingStartFrom: { lte: new Date("2026-06-01T00:00:00.000Z") } },
    });
    expect(whereValues(1, '"bookingStartFrom" <= $1')).toEqual(["2026-06-01"]);

    captured.length = 0;
    await prisma.familyGroupJoinRequest.findMany({
      where: { childDateOfBirth: { gte: new Date("2019-01-15T00:00:00.000Z") } },
    });
    expect(whereValues(1, '"childDateOfBirth" >= $1')).toEqual(["2019-01-15"]);

    captured.length = 0;
    await prisma.groupBooking.findMany({
      where: { joinDeadline: { gt: new Date("2026-08-30T00:00:00.000Z") } },
    });
    expect(whereValues(1, '"joinDeadline" > $1')).toEqual(["2026-08-30"]);
  });

  it("THE COLUMN #2872 LEFT ALONE: the nomination-gate cutoff still binds a whole instant", async () => {
    /*
      `MembershipNominationSettings.gateEffectiveFrom` was the twelfth candidate
      and is deliberately excluded, because it is MIXED: the admin panel writes a
      calendar day, but the settings route stamps `new Date()` the first time the
      gate is enabled with the cutoff box left empty, which the panel's own help
      text presents as ordinary use. Narrowing a column with a clock writer would
      truncate that instant — and on a club that had already used the feature
      that way, the migration's fail-closed preflight would RAISE and stop the
      deploy.

      An exclusion nobody can trip over is one that quietly comes back, so it is
      pinned here rather than only written down. This asserts what the adapter
      sends today; adding `@db.Date` to that column turns it into a bare
      `2026-06-15` and fails.
    */
    await prisma.membershipNominationSettings.findMany({
      where: { gateEffectiveFrom: { gte: new Date("2026-06-15T21:00:00.000Z") } },
    });

    expect(
      whereValues(1, '"gateEffectiveFrom" >= $1'),
      "INV-DATE-019: `gateEffectiveFrom` has a clock writer, so it is a plain " +
        "`DateTime` on purpose (#2872). If this comes back as a bare day the " +
        "column has been narrowed, and the 21:00 an admin's first enable writes " +
        "no longer survives.",
    ).toEqual(["2026-06-15 21:00:00"]);
  });

  it("still keeps the whole instant on the neighbouring columns of the SAME tables", async () => {
    // The other half of the claim, and the one a careless migration breaks: the
    // narrowing was supposed to reach eleven columns and no more. `Member.createdAt`
    // and `PromoCode.archivedAt` sit beside two of them and are real moments, so
    // both are driven — on their own tables. (An earlier version of this case
    // named `PromoCode.archivedAt` in the comment and queried only `Member`.)
    await prisma.member.findMany({
      where: {
        dateOfBirth: { lt: new Date("2008-04-02T00:00:00.000Z") },
        createdAt: { gte: new Date("2026-07-01T12:00:00.000Z") },
      },
    });

    expect(
      whereValues(2, '"dateOfBirth" < $1'),
      "One statement, two columns of two different kinds, two encodings. If " +
        "these agree, either an instant has been narrowed or a calendar day has " +
        "not been — and INV-DATE-019 or INV-DATE-026 is broken either way.",
    ).toEqual(["2008-04-02", "2026-07-01 12:00:00"]);

    captured.length = 0;
    await prisma.promoCode.findMany({
      where: {
        validUntil: { gte: new Date("2026-09-30T00:00:00.000Z") },
        archivedAt: { gte: new Date("2026-07-01T12:00:00.000Z") },
      },
    });

    expect(
      whereValues(2, '"validUntil" >= $1'),
      "`PromoCode.archivedAt` is the moment an operator archived the code, and " +
        "it sits beside four narrowed window edges on the same table. Narrowing " +
        "it would move an archival to midnight, and west of UTC to the previous " +
        "day.",
    ).toEqual(["2026-09-30", "2026-07-01 12:00:00"]);
  });
});
