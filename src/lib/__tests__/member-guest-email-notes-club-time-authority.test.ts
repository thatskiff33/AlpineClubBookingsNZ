/**
 * #3123 — the member-guest email notes render a lodge night in NO zone and a
 * consent deadline in the CLUB's persisted zone.
 *
 * Nine dates were composed here through `formatNZDate`, which reads
 * `APP_TIME_ZONE` — the container's clock. Seven of them are `@db.Date`
 * calendar days and two are real instants, so a blanket sweep onto the club's
 * zone would have fixed two and broken seven. This suite pins the split.
 *
 * ## Why the container zone is moved, and why it is `America/Denver`
 *
 * `APP_TIME_ZONE` is `process.env.TZ || NEXT_PUBLIC_TZ || "Pacific/Auckland"`,
 * read ONCE at module load, so it is set before the graph is imported and the
 * modules are re-imported after. `NEXT_PUBLIC_TZ` rather than `TZ`, so the
 * HOST's own clock stays wherever the runner put it — the same choice, for the
 * same reason, as `email-date-kind-override-zone.test.ts`, which this suite
 * follows in shape.
 *
 * Denver is BEHIND Greenwich, which is the side on which the defect shows: on
 * this repository's own machine `APP_TIME_ZONE` is `Pacific/Auckland`, and
 * Auckland's projection of a UTC-midnight stored day is that same day, so a
 * suite that left the container alone would watch the old code be right by
 * coincidence and call it a pass.
 *
 * ## THE PRISMA MOCK MUST CARRY `clubTimeSettings`
 *
 * The persisted-zone read is fail-soft three ways — no delegate, a throwing
 * query, no row — and every one of them degrades silently to the environment.
 * A mock without that delegate therefore passes for exactly the reason this
 * file exists to rule out. `primeEmailClubTimeZone()` is awaited before each
 * assertion because `emailClubDate` never waits: it serves a TTL cache and
 * falls back to the environment seed while that cache is cold.
 *
 * ## Two persisted zones, doing two different jobs
 *
 * - `Pacific/Auckland` is the discriminating case for the INSTANT. The fixture
 *   deadline is 23:30 UTC, which is still 1 August in Denver and already
 *   2 August in Auckland, so an environment-zone read dies here.
 * - `Pacific/Honolulu` is the discriminating case for the CALENDAR DAY. It is
 *   west of Greenwich, so both wrong authorities — the container's zone and the
 *   club's persisted zone — read a stored UTC-midnight night as the previous
 *   day. It kills a projection through either one.
 *
 * Neither configuration catches both, which is why both are here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const CONTAINER_ZONE = "America/Denver";
process.env.NEXT_PUBLIC_TZ = CONTAINER_ZONE;
delete process.env.TZ;

const mocks = vi.hoisted(() => ({
  clubTimeSettingsFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    // NOT OPTIONAL. See the header: without it the zone read fails soft to the
    // environment and every assertion below passes for the wrong reason.
    clubTimeSettings: { findUnique: mocks.clubTimeSettingsFindUnique },
  },
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.resetModules();

const { APP_TIME_ZONE } = await import("@/config/operational");
const { __resetEmailClubTimeZoneForTests, primeEmailClubTimeZone } =
  await import("@/lib/email-templates-club-time");
const { composeGuestNightsLabel, composeMemberGuestConsentOutcome } =
  await import("@/lib/member-guest-email-notes");

/** Stored `@db.Date` guest nights: exact UTC midnight, which is the encoding. */
const NIGHT_1 = new Date("2026-08-01T00:00:00.000Z");
const NIGHT_2 = new Date("2026-08-02T00:00:00.000Z");
const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");

/** A real moment: 17:30 on 1 Aug in Denver, 11:30 on 2 Aug in Auckland. */
const EXPIRED_AT = new Date("2026-08-01T23:30:00.000Z");

const GUEST = { firstName: "Dave", lastName: "Ngata" };

/**
 * The house medium day shape, written out by hand rather than imported, so an
 * assertion cannot be the implementation restated. Pointed at `UTC` it is the
 * oracle for "the stored day, unprojected"; pointed at a real zone it says what
 * a path consulting that zone would have produced.
 */
const houseDay = (zone: string) =>
  new Intl.DateTimeFormat("en-NZ", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: zone,
  });

const storedDay = (value: Date) => houseDay("UTC").format(value);
const projectedDay = (value: Date, zone: string) =>
  houseDay(zone).format(value);

/** The lapse sentence: one stay window and one deadline, in the same string. */
function lapseSentence(): string {
  return composeMemberGuestConsentOutcome({
    guest: GUEST,
    lodgeName: "Test Lodge",
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    outcome: {
      kind: "EXPIRED_REMOVED",
      expiredAt: EXPIRED_AT,
      creditCents: 4800,
    },
  }).sentence;
}

async function withPersistedZone(zone: string): Promise<void> {
  __resetEmailClubTimeZoneForTests();
  mocks.clubTimeSettingsFindUnique.mockResolvedValue({ timeZone: zone });
  await primeEmailClubTimeZone();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the premise every assertion below rests on", () => {
  it("the container really is pinned behind Greenwich", () => {
    // A premise failure here is a FAILURE and never a skip (#2870).
    expect(APP_TIME_ZONE).toBe(CONTAINER_ZONE);
  });

  it("the three readings of the fixtures really do disagree", () => {
    // The stored night, and what each wrong authority would have made of it.
    expect(storedDay(NIGHT_1)).toBe("1 Aug 2026");
    expect(projectedDay(NIGHT_1, CONTAINER_ZONE)).toBe("31 Jul 2026");
    expect(projectedDay(NIGHT_1, "Pacific/Honolulu")).toBe("31 Jul 2026");
    // The instant, in the container's zone and in an eastern club's.
    expect(projectedDay(EXPIRED_AT, CONTAINER_ZONE)).toBe("1 Aug 2026");
    expect(projectedDay(EXPIRED_AT, "Pacific/Auckland")).toBe("2 Aug 2026");
  });
});

describe("a guest night is a stored calendar day and takes no zone", () => {
  for (const zone of ["Pacific/Auckland", "Pacific/Honolulu"]) {
    it(`lists the stored nights unprojected with the club on ${zone}`, async () => {
      await withPersistedZone(zone);

      const label = composeGuestNightsLabel([NIGHT_1, NIGHT_2]);

      expect(label).toBe("1 Aug 2026, 2 Aug 2026 (2 nights)");
      expect(label).not.toContain("31 Jul 2026");
    });
  }

  it("collapses a long contiguous run to stored ends, still unprojected", async () => {
    await withPersistedZone("Pacific/Honolulu");

    const nights = [
      NIGHT_1,
      NIGHT_2,
      new Date("2026-08-03T00:00:00.000Z"),
      new Date("2026-08-04T00:00:00.000Z"),
    ];

    expect(composeGuestNightsLabel(nights)).toBe(
      "1 Aug 2026 to 4 Aug 2026 (4 nights)"
    );
  });

  it("refuses a real timestamp handed in as a guest night", async () => {
    await withPersistedZone("Pacific/Auckland");

    expect(() =>
      composeGuestNightsLabel([new Date("2026-08-01T11:30:00.000Z")])
    ).toThrow(/takes a stored calendar day, not a moment/);
  });

  it("renders the stay window unprojected in the outcome sentence", async () => {
    await withPersistedZone("Pacific/Honolulu");

    const { sentence } = composeMemberGuestConsentOutcome({
      guest: GUEST,
      lodgeName: "Test Lodge",
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      outcome: { kind: "APPROVED" },
    });

    expect(sentence).toContain("Test Lodge, 1 Aug 2026 - 3 Aug 2026");
    expect(sentence).not.toContain("31 Jul 2026");
  });
});

describe("a consent deadline is an instant and is read in the club's zone", () => {
  it("names the club's day, not the container's", async () => {
    await withPersistedZone("Pacific/Auckland");

    const { sentence } = composeMemberGuestConsentOutcome({
      guest: GUEST,
      lodgeName: "Test Lodge",
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      outcome: {
        kind: "EXPIRED_REMOVED",
        expiredAt: EXPIRED_AT,
        creditCents: 4800,
      },
    });

    expect(sentence).toContain("lapsed on 2 Aug 2026");
    // What the retired environment read would have said.
    expect(sentence).not.toContain("lapsed on 1 Aug 2026");
  });

  it("says the same on the still-on-booking branch", async () => {
    await withPersistedZone("Pacific/Auckland");

    const { sentence } = composeMemberGuestConsentOutcome({
      guest: GUEST,
      lodgeName: "Test Lodge",
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      outcome: {
        kind: "EXPIRED_STILL_ON_BOOKING",
        expiredAt: EXPIRED_AT,
        blocker: "LAST_GUEST",
      },
    });

    expect(sentence).toContain("lapsed on 2 Aug 2026");
    expect(sentence).not.toContain("lapsed on 1 Aug 2026");
  });

  it("moves with the persisted zone, which kills a hard-coded one", async () => {
    await withPersistedZone("Pacific/Auckland");
    const east = lapseSentence();

    await withPersistedZone("Pacific/Honolulu");
    const west = lapseSentence();

    expect(east).toContain("lapsed on 2 Aug 2026");
    expect(west).toContain("lapsed on 1 Aug 2026");
    expect(east).not.toBe(west);
  });

  it("keeps the stay window fixed while the deadline moves in the SAME sentence", async () => {
    await withPersistedZone("Pacific/Auckland");
    const east = lapseSentence();

    await withPersistedZone("Pacific/Honolulu");
    const west = lapseSentence();

    // One sentence, two kinds of date, and only one of them may move.
    for (const sentence of [east, west]) {
      expect(sentence).toContain("Test Lodge, 1 Aug 2026 - 3 Aug 2026");
      expect(sentence).not.toContain("31 Jul 2026");
    }
  });
});
