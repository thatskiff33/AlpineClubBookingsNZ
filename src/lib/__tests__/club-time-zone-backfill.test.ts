import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  },
}));

/*
  A whole-client stand-in for the readiness-snapshot suite at the bottom of this
  file. `getSetupDatabaseSnapshot` reads two dozen tables and the only one under
  test here is `ClubTimeSettings`, so every other delegate answers with the empty
  shape its caller already tolerates (a `count` of 0, an empty `findMany`, a null
  `findUnique`) and the club-time delegate is a real spy the tests drive.
*/
const { clubTimeFindUnique, mockPrisma } = vi.hoisted(() => {
  const clubTimeFindUnique = vi.fn();
  const emptyDelegate = new Proxy(
    {},
    {
      get: (_target, method: string) => {
        if (method === "count") return async () => 0;
        if (method === "findMany") return async () => [];
        return async () => null;
      },
    },
  );
  const mockPrisma = new Proxy(
    {},
    {
      get: (_target, model: string) =>
        model === "clubTimeSettings"
          ? { findUnique: clubTimeFindUnique }
          : emptyDelegate,
    },
  );
  return { clubTimeFindUnique, mockPrisma };
});

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/lodge-capacity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/lodge-capacity")>()),
  getDefaultLodgeCapacity: vi.fn(async () => 12),
}));
vi.mock("@/lib/stripe-config", () => ({
  getStripeSetupState: vi.fn(async () => ({
    secretKeySet: false,
    publishableKeySet: false,
    webhookSecretSet: false,
    needsReentry: false,
  })),
}));
vi.mock("@/lib/xero-token-store", () => ({
  getXeroTokenReadability: vi.fn(async () => "readable"),
}));

import { captureHostTimeZone } from "@/lib/__tests__/helpers/timezone";
import {
  CLUB_TIME_ZONE_FALLBACK,
  isValidClubTimeZone,
} from "@/lib/club-time-zone";
import { decideClubTimeZoneBackfill } from "@/lib/config-self-heal-steps";
import { getSetupDatabaseSnapshot } from "@/lib/setup-readiness-db";

/**
 * The ONE decision behind every create-if-absent write of the club timezone
 * (CT-1, #2989 review).
 *
 * Two writers record this row without anybody being asked: the boot backfill
 * (`clubTimeZoneSelfHealStep`) and `prisma/seed.ts`. Both must answer
 * identically — that is the #1984 parity standard, and `prisma/seed.ts` states
 * it in prose — so both call `decideClubTimeZoneBackfill` and the answer is
 * tested here once.
 *
 * What it is answering: **what timezone is this deployment already using?** Not
 * "what would we accept from an operator", which is the question the admin panel
 * asks and a different question with a different validator. Getting those two
 * confused is the defect this function exists to prevent — it wrote
 * `Pacific/Auckland` over 36 kinds of perfectly good `TZ` value, once, silently,
 * and never revisited it.
 *
 * `process.env.TZ` is restored by ASSIGNMENT, never by deleting it (#2485).
 * Nothing here formats a date, so the frozen clock is not involved.
 */
describe("decideClubTimeZoneBackfill", () => {
  const hostTimeZone = captureHostTimeZone();
  const originalNextPublicTz = process.env.NEXT_PUBLIC_TZ;

  afterEach(() => {
    hostTimeZone.restore();
    if (originalNextPublicTz === undefined) {
      delete process.env.NEXT_PUBLIC_TZ;
    } else {
      process.env.NEXT_PUBLIC_TZ = originalNextPublicTz;
    }
  });

  function pinEnvironmentZone(zone: string | null) {
    if (zone === null) {
      // Only an assignment invalidates Node's cached zone (#2485).
      process.env.TZ = CLUB_TIME_ZONE_FALLBACK;
      delete process.env.TZ;
    } else {
      process.env.TZ = zone;
    }
    delete process.env.NEXT_PUBLIC_TZ;
  }

  it.each([
    ["GB", "Europe/London"],
    ["NZ", "Pacific/Auckland"],
    ["NZ-CHAT", "Pacific/Chatham"],
    ["Japan", "Asia/Tokyo"],
    ["australia/sydney", "Australia/Sydney"],
    ["Pacific/Auckland", "Pacific/Auckland"],
  ])("records the place TZ=%s names (%s), and reports the raw value", (raw, expected) => {
    pinEnvironmentZone(raw);

    const decision = decideClubTimeZoneBackfill();

    expect(decision).toEqual({ kind: "preserved", timeZone: expected, raw });
  });

  it.each(["EST5EDT", "PST8PDT", "US/Pacific", "W-SU", "Navajo"])(
    "records a real place for the alias TZ=%s",
    (raw) => {
      // Property-only: which location ICU calls canonical for these is version
      // dependent (`club-time-zone.test.ts` pins the civil time instead), so
      // what matters here is that SOMETHING usable is recorded rather than the
      // New Zealand default.
      pinEnvironmentZone(raw);

      const decision = decideClubTimeZoneBackfill();

      expect(decision.kind).toBe("preserved");
      expect(isValidClubTimeZone(decision.timeZone)).toBe(true);
      expect(decision.timeZone).not.toBe(CLUB_TIME_ZONE_FALLBACK);
    },
  );

  it("records the documented New Zealand default when the environment says nothing", () => {
    // The "truly unset legacy install" the issue's fallback is for. Nobody is
    // being moved, so this is `absent` and no caller says anything about it.
    pinEnvironmentZone(null);

    expect(decideClubTimeZoneBackfill()).toEqual({
      kind: "absent",
      timeZone: CLUB_TIME_ZONE_FALLBACK,
      raw: null,
    });
  });

  it.each([
    "UTC",
    "GMT",
    "Zulu",
    "Universal",
    "Etc/UTC",
    "Etc/GMT-12",
    "SystemV/EST5",
    "NZT",
    "Pacific/Atlantis",
  ])("records the default and says it DEFAULTED when TZ=%s names no place", (raw) => {
    // Owner decision, 23 Aug 2026 (#2989). There is no place whose civil time is
    // UTC, so nothing can be preserved — but leaving the setting empty blocked
    // setup, and the issue's own requirements cannot both be met for this input.
    // So a zone is recorded, and `defaulted` is what obliges every caller to say
    // so: this club may have just been handed a zone thirteen hours from its own.
    pinEnvironmentZone(raw);

    expect(decideClubTimeZoneBackfill()).toEqual({
      kind: "defaulted",
      timeZone: CLUB_TIME_ZONE_FALLBACK,
      raw,
    });
  });

  it("keeps 'defaulted' distinct from 'absent' even though both write the same zone", () => {
    // The whole point of the discriminator. If these two collapsed to one answer
    // the boot log, the seed log and the setup checklist would all fall silent on
    // the one input where the club is being moved — which is what "defaulting is
    // not the same as being silent" means in code rather than in prose.
    pinEnvironmentZone(null);
    const unset = decideClubTimeZoneBackfill();
    pinEnvironmentZone("UTC");
    const utc = decideClubTimeZoneBackfill();

    expect(unset.timeZone).toBe(utc.timeZone);
    expect(unset.kind).not.toBe(utc.kind);
    expect(unset.raw).toBeNull();
    expect(utc.raw).toBe("UTC");
  });

  it("reads NEXT_PUBLIC_TZ when TZ is unset, and prefers TZ when both are set", () => {
    pinEnvironmentZone(null);
    process.env.NEXT_PUBLIC_TZ = "GB";
    expect(decideClubTimeZoneBackfill()).toEqual({
      kind: "preserved",
      timeZone: "Europe/London",
      raw: "GB",
    });

    process.env.TZ = "Australia/Sydney";
    expect(decideClubTimeZoneBackfill()).toEqual({
      kind: "preserved",
      timeZone: "Australia/Sydney",
      raw: "Australia/Sydney",
    });
  });

  it("reads the environment at CALL time, not at import", () => {
    // A constant captured at import would make every boot of a long-running
    // image record whatever zone the first import happened to see.
    pinEnvironmentZone("Europe/London");
    const first = decideClubTimeZoneBackfill();
    pinEnvironmentZone("Asia/Tokyo");
    const second = decideClubTimeZoneBackfill();

    expect(first).toMatchObject({ timeZone: "Europe/London" });
    expect(second).toMatchObject({ timeZone: "Asia/Tokyo" });
  });

  it("never hands a writer a value the app would then refuse to read", () => {
    // The row is written by one validator and read by another, so a value the
    // decision produced and the reader rejected would be stored once and
    // reported as broken for ever.
    for (const raw of [
      null,
      "GB",
      "NZ-CHAT",
      "EST5EDT",
      "US/Pacific",
      "Pacific/Auckland",
      "australia/sydney",
      "UTC",
      "Etc/GMT-12",
      "NZT",
    ]) {
      pinEnvironmentZone(raw);
      const decision = decideClubTimeZoneBackfill();
      expect(isValidClubTimeZone(decision.timeZone)).toBe(true);
      expect(decision.timeZone.length).toBeLessThanOrEqual(64);
    }
  });
});

/**
 * `prisma/seed.ts` writes the same row, so it must make the same decision.
 *
 * This is a SOURCE contract rather than a behavioural test, and that is a
 * limitation with a reason: `prisma/seed.ts` calls `main()` at import, so
 * importing it from a test would try to open a database connection. What can be
 * checked cheaply is the shape — that the seed defers to the shared decision
 * rather than re-deriving one, and that its write is inside the branch that has
 * a zone to write. The DECISION itself is tested for real above, and both
 * callers share it, which is what makes the shape check worth anything.
 *
 * Being a disk scan it has no import edge to `prisma/seed.ts`, so `vitest
 * related` cannot select it from a diff to that file — CI-caught by design, the
 * same trade-off `docs/TESTING.md` records for the other contract scanners.
 */
describe("prisma/seed.ts club-timezone block", () => {
  const seedSource = readFileSync(
    path.resolve(process.cwd(), "prisma/seed.ts"),
    "utf8",
  );
  const blockStart = seedSource.indexOf("const clubTimeZoneBackfill");
  /*
    END-ANCHORED, NOT LENGTH-ANCHORED (#2870 group F1).

    This used to slice a fixed 1400 characters from `blockStart`. That silently
    stopped covering the block the moment the seed grew — CT-4's season-year work
    added the club-season derivation here, which pushed the `/admin/club-time`
    link 2224 characters out, and the assertion below then failed for a reason
    that had nothing to do with the contract it exists to check. A window sized
    by a magic number is a guard that expires without saying so.

    The block ends where the next concern begins, so it now tracks the section
    rather than a byte count. `blockEnd` is asserted below: if that marker ever
    moves, this fails and names the reason instead of quietly re-widening.
  */
  const blockEnd = seedSource.indexOf("// DB-only lodge capacity parity", blockStart);
  const block = seedSource.slice(blockStart, blockEnd);

  it("defers to the shared decision instead of re-deriving one", () => {
    expect(blockStart).toBeGreaterThan(-1);
    // The end marker, so a moved section fails here rather than shrinking the
    // window the other assertions rely on.
    expect(blockEnd).toBeGreaterThan(blockStart);
    expect(seedSource).toContain(
      'import { decideClubTimeZoneBackfill } from "../src/lib/config-self-heal-steps"',
    );
    expect(block).toContain("decideClubTimeZoneBackfill()");
    // The refuted shape. `resolveClubTimeZone(null, seed)` is what ran the
    // operator-input validator over a value whose only job was to be preserved.
    expect(seedSource).not.toContain("resolveClubTimeZone");
    expect(seedSource).not.toContain("readEnvironmentClubTimeZoneSeed");
  });

  it("always writes the row, and says out loud when the zone was defaulted", () => {
    // Owner decision, 23 Aug 2026: a zone is always recorded, so there is no
    // "did not seed" branch left to check. What has to be checked instead is
    // that the seed did not answer the question by treating `defaulted` like
    // any other outcome — a silent seed on `TZ=UTC` is the failure this decision
    // explicitly guards against.
    const write = block.indexOf("prisma.clubTimeSettings.upsert(");
    const defaulted = block.indexOf('clubTimeZoneBackfill.kind === "defaulted"');

    expect(write).toBeGreaterThan(-1);
    expect(defaulted).toBeGreaterThan(write);
    expect(block).toContain("BY DEFAULT");
    expect(block).toContain("/admin/club-time");
    // The refuted shape: nothing may gate the write itself any more.
    expect(block).not.toContain("if (clubTimeZoneBackfill.record)");
    expect(seedSource).not.toContain("NOT seeded");
  });

  it("uses the shared singleton id rather than its own literal", () => {
    // Four writers address this row and a drift between their ids fails
    // SILENTLY — `create` passes `id` explicitly, so a mis-keyed writer creates
    // a second row and the reader still finds nothing.
    expect(seedSource).toContain(
      'import { CLUB_TIME_SETTINGS_ID } from "../src/lib/club-time-zone"',
    );
    expect(block).toContain("where: { id: CLUB_TIME_SETTINGS_ID }");
    expect(block).toContain("id: CLUB_TIME_SETTINGS_ID,");
    expect(block).not.toContain('"default"');
  });
});

/**
 * The setup snapshot's read of the same row (CT-1, #2989 review, finding 3).
 *
 * `getSetupDatabaseSnapshot` runs two dozen reads in one `Promise.all`, so an
 * unguarded rejection from any of them rejects the whole snapshot — and
 * `/admin/setup` has no fallback for that: it renders a 500 for every step
 * rather than one unread setting. `ClubTimeSettings` is the newest table in the
 * schema and therefore the likeliest to be missing on a database the migration
 * has not reached, which is exactly the moment an operator opens that page.
 *
 * The failure is REPORTED rather than swallowed to null, because the two states
 * carry different remedies: "no row yet" is answered by the next start, and a
 * missing table is answered by running the migration.
 */
describe("getSetupDatabaseSnapshot — the club-timezone read is defensive", () => {
  beforeEach(() => {
    clubTimeFindUnique.mockReset();
  });

  it("reports the stored zone when the row is there", () => {
    clubTimeFindUnique.mockResolvedValue({ timeZone: "Australia/Sydney" });

    return expect(getSetupDatabaseSnapshot()).resolves.toMatchObject({
      clubTimeZone: "Australia/Sydney",
      clubTimeZoneUnreadable: false,
    });
  });

  it("reports 'not stored yet' when the row is absent", () => {
    clubTimeFindUnique.mockResolvedValue(null);

    return expect(getSetupDatabaseSnapshot()).resolves.toMatchObject({
      clubTimeZone: null,
      clubTimeZoneUnreadable: false,
    });
  });

  it("survives an un-migrated table and says the read failed", async () => {
    clubTimeFindUnique.mockRejectedValue(
      new Error('relation "ClubTimeSettings" does not exist'),
    );

    // The whole point: this resolves rather than rejecting.
    const snapshot = await getSetupDatabaseSnapshot();

    expect(snapshot.clubTimeZoneUnreadable).toBe(true);
    expect(snapshot.clubTimeZone).toBeNull();
    // And the rest of the snapshot is still there, so every other step on
    // /admin/setup still reports.
    expect(snapshot.adminCount).toBe(0);
    expect(snapshot.defaultLodgeCapacity).toBe(12);
  });
});
