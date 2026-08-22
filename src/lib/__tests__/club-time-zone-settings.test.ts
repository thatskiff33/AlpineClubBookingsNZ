import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import { captureHostTimeZone } from "@/lib/__tests__/helpers/timezone";

/**
 * The canonical server-owned club-timezone reader (CT-1, #2989; INV-CONFIG-002).
 *
 * The rule under test is a PRECEDENCE: once the club has stored its timezone,
 * `TZ` / `NEXT_PUBLIC_TZ` are no longer a second opinion, so moving the
 * container's clock cannot move the club's civil time.
 *
 * A "the database wins over the environment" assertion is worth nothing on its
 * own, because it passes just as happily against a reader that never looks at the
 * environment at all. So every such assertion here is paired with its PREMISE:
 * the same file proves that with NO stored row the reader really does return the
 * environment's zone, and the mutation test below proves the environment is being
 * moved between the reads that do not move. Both legs, or neither means anything.
 *
 * `process.env.TZ` is restored by ASSIGNING the captured value back, never by
 * deleting it — Node only re-derives its cached zone on assignment (#2485), and
 * test files share a worker, so a deleted TZ leaks into whichever suite runs
 * next.
 */

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: { clubTimeSettings: { findUnique: vi.fn() } } as {
    clubTimeSettings?: { findUnique: Mock };
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import { CLUB_TIME_ZONE_FALLBACK } from "@/lib/club-time-zone";
import { readEnvironmentClubTimeZoneSeed } from "@/lib/club-time-zone-env";
import {
  CLUB_TIME_SETTINGS_ID,
  getClubTimeZone,
  loadPersistedClubTimeSettings,
  resolveClubTimeZoneWithSource,
} from "@/lib/club-time-zone-settings";

const hostTimeZone = captureHostTimeZone();
const originalNextPublicTz = process.env.NEXT_PUBLIC_TZ;

/** The delegate, re-attached by `beforeEach` after the missing-delegate test. */
const findUnique = mockPrisma.clubTimeSettings!.findUnique;

function persistedRow(timeZone: string) {
  return {
    timeZone,
    updatedByMemberId: "member_1",
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.clubTimeSettings = { findUnique };
  // NEXT_PUBLIC_TZ is the second half of the seed's precedence. Clear it so each
  // test's `process.env.TZ` is unambiguously "what the environment says", on a CI
  // runner as well as on a developer machine.
  delete process.env.NEXT_PUBLIC_TZ;
});

afterEach(() => {
  hostTimeZone.restore();
});

afterAll(() => {
  if (originalNextPublicTz === undefined) {
    delete process.env.NEXT_PUBLIC_TZ;
  } else {
    process.env.NEXT_PUBLIC_TZ = originalNextPublicTz;
  }
});

describe("getClubTimeZone — the stored zone is the authority", () => {
  it("returns the stored zone while the environment says something else", async () => {
    process.env.TZ = "America/Denver";
    findUnique.mockResolvedValue(persistedRow("Australia/Sydney"));

    await expect(getClubTimeZone()).resolves.toBe("Australia/Sydney");
    // Premise: the environment really did say something different.
    expect(readEnvironmentClubTimeZoneSeed()).toBe("America/Denver");
  });

  it("PREMISE: returns the environment's zone when nothing is stored", async () => {
    // Without this leg the assertion above cannot tell a real precedence rule
    // from a reader that never reads the environment.
    process.env.TZ = "America/Denver";
    findUnique.mockResolvedValue(null);

    await expect(getClubTimeZone()).resolves.toBe("America/Denver");
  });

  it("does not move when the container's timezone is moved three times over", async () => {
    // The mutation evidence for the precedence rule: the input the reader must
    // ignore is changed under it, repeatedly, and the answer has to hold still
    // while the seed demonstrably does not.
    findUnique.mockResolvedValue(persistedRow("Australia/Sydney"));

    for (const hostZone of ["America/Denver", "Europe/London", "Asia/Tokyo"]) {
      process.env.TZ = hostZone;
      expect(readEnvironmentClubTimeZoneSeed()).toBe(hostZone);
      await expect(getClubTimeZone()).resolves.toBe("Australia/Sydney");
    }
  });

  it("reads the singleton row by its fixed id", async () => {
    process.env.TZ = "Pacific/Auckland";
    findUnique.mockResolvedValue(persistedRow("Pacific/Auckland"));

    await getClubTimeZone();

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: CLUB_TIME_SETTINGS_ID } }),
    );
    expect(CLUB_TIME_SETTINGS_ID).toBe("default");
  });

  it("canonicalises a stored case variant", async () => {
    process.env.TZ = "America/Denver";
    findUnique.mockResolvedValue(persistedRow("australia/sydney"));

    await expect(getClubTimeZone()).resolves.toBe("Australia/Sydney");
  });
});

describe("getClubTimeZone — never throws, always answers", () => {
  it("falls back to the environment when the row is absent", async () => {
    process.env.TZ = "Europe/London";
    findUnique.mockResolvedValue(null);

    await expect(getClubTimeZone()).resolves.toBe("Europe/London");
  });

  it("falls back to the documented default when the environment says nothing usable", async () => {
    process.env.TZ = "NZT";
    findUnique.mockResolvedValue(null);

    await expect(getClubTimeZone()).resolves.toBe(CLUB_TIME_ZONE_FALLBACK);
  });

  it("falls back to the documented default when the environment says nothing at all", async () => {
    // The fresh-container case. Assigning before deleting is what keeps Node's
    // cached zone honest; `hostTimeZone.restore()` then puts the original back by
    // assignment.
    process.env.TZ = "Pacific/Auckland";
    delete process.env.TZ;
    findUnique.mockResolvedValue(null);

    expect(readEnvironmentClubTimeZoneSeed()).toBeNull();
    await expect(getClubTimeZone()).resolves.toBe(CLUB_TIME_ZONE_FALLBACK);
  });

  it("falls back instead of throwing when the database read fails", async () => {
    process.env.TZ = "Europe/London";
    findUnique.mockRejectedValue(new Error("connect ECONNREFUSED"));

    await expect(getClubTimeZone()).resolves.toBe("Europe/London");
    await expect(loadPersistedClubTimeSettings()).resolves.toBeNull();
  });

  it("falls back instead of throwing when the Prisma delegate does not exist", async () => {
    // A client generated before the ClubTimeSettings migration landed. A
    // configuration reader that threw here would turn a stale build into a blank
    // page rather than a wrong-but-serviceable zone.
    process.env.TZ = "Europe/London";
    delete mockPrisma.clubTimeSettings;

    await expect(getClubTimeZone()).resolves.toBe("Europe/London");
    await expect(loadPersistedClubTimeSettings()).resolves.toBeNull();
  });

  it("falls back to the default when a stored value does not validate", async () => {
    // Only database surgery or an ICU that dropped the zone can produce this.
    process.env.TZ = "NZT";
    findUnique.mockResolvedValue(persistedRow("Etc/GMT-12"));

    await expect(getClubTimeZone()).resolves.toBe(CLUB_TIME_ZONE_FALLBACK);
  });
});

describe("resolveClubTimeZoneWithSource", () => {
  it("reports 'persisted' and hands back the row", async () => {
    process.env.TZ = "America/Denver";
    findUnique.mockResolvedValue(persistedRow("Australia/Sydney"));

    const resolved = await resolveClubTimeZoneWithSource();

    expect(resolved.timeZone).toBe("Australia/Sydney");
    expect(resolved.source).toBe("persisted");
    expect(resolved.persisted).toMatchObject({
      timeZone: "Australia/Sydney",
      updatedByMemberId: "member_1",
    });
  });

  it("reports 'environment' when nothing is stored and TZ names a real zone", async () => {
    process.env.TZ = "Europe/London";
    findUnique.mockResolvedValue(null);

    const resolved = await resolveClubTimeZoneWithSource();

    expect(resolved.timeZone).toBe("Europe/London");
    expect(resolved.source).toBe("environment");
    expect(resolved.persisted).toBeNull();
  });

  it.each([
    ["GB", "Europe/London"],
    ["NZ-CHAT", "Pacific/Chatham"],
    ["EST5EDT", "America/New_York"],
  ])(
    "reports 'environment', not 'default', when TZ=%s is a legacy alias for %s",
    async (raw, expected) => {
      /*
        #2989 fix round, finding F1a. The VALUE came from `resolveClubTimeZone`,
        whose environment leg preserves; the SOURCE beside it asked the strict
        operator-input validator the same question and got the opposite answer.
        On any deployment whose `TZ` is one of the thirty-six legacy spellings
        the pair contradicted itself, and the maintenance panel — the one screen
        whose whole job is to explain provenance — rendered "Europe/London —
        Default: nothing has been recorded and the server says nothing either".
        Three false claims, and no hint that the next restart would record
        Europe/London.
      */
      process.env.TZ = raw;
      findUnique.mockResolvedValue(null);

      const resolved = await resolveClubTimeZoneWithSource();

      expect(resolved.timeZone).toBe(expected);
      expect(resolved.source).toBe("environment");
      expect(resolved.persisted).toBeNull();
    },
  );

  it("reports 'default' when neither the database nor the environment answers", async () => {
    process.env.TZ = "NZT";
    findUnique.mockResolvedValue(null);

    const resolved = await resolveClubTimeZoneWithSource();

    expect(resolved.timeZone).toBe(CLUB_TIME_ZONE_FALLBACK);
    expect(resolved.source).toBe("default");
    expect(resolved.persisted).toBeNull();
  });

  it("reports 'persisted-unusable', NOT 'environment', when a stored value cannot be used", async () => {
    // The setup and maintenance surfaces have to say WHERE the answer came from,
    // and "the row exists" is not the same as "the row is the answer" — but nor
    // is it the same as "no row" (#2989 review). A row holding an unusable value
    // is its own state: the club HAS recorded something, the boot backfill keys
    // on the row existing so it will never repair it, and telling the reader
    // "nothing is recorded yet, the app records it on the next restart" sends
    // them to wait for something that cannot happen. The one instruction that
    // works is "set it again", and only this source can produce that.
    process.env.TZ = "Europe/London";
    findUnique.mockResolvedValue(persistedRow("NZT"));

    const resolved = await resolveClubTimeZoneWithSource();

    // The app keeps answering — from the environment, then the default — so the
    // zone reported is the one in force even though the source is the bad row.
    expect(resolved.timeZone).toBe("Europe/London");
    expect(resolved.source).toBe("persisted-unusable");
    expect(resolved.persisted).toMatchObject({ timeZone: "NZT" });
  });

  it("distinguishes an unusable row from no row at all", async () => {
    // The premise for the assertion above: with the SAME environment, an absent
    // row reports `environment`. Without this leg the test could not tell a real
    // distinction from a constant.
    process.env.TZ = "Europe/London";

    findUnique.mockResolvedValue(persistedRow("Etc/GMT-12"));
    expect((await resolveClubTimeZoneWithSource()).source).toBe(
      "persisted-unusable",
    );

    findUnique.mockResolvedValue(null);
    expect((await resolveClubTimeZoneWithSource()).source).toBe("environment");
  });
});
