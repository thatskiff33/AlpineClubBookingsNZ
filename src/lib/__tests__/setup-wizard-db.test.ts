import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgeTier } from "@prisma/client";
import { captureHostTimeZone } from "@/lib/__tests__/helpers/timezone";
import { CLUB_TIME_ZONE_FALLBACK } from "@/lib/club-time-zone";
import {
  applyWizardConfigToDatabase,
  MAX_LODGE_CAPACITY,
  readWizardConfigState,
  type WizardConfigValues,
  type WizardDbClient,
} from "@/lib/setup-wizard-db";

function makeDelegate(
  findUniqueResult: Record<string, unknown> | null = null,
  findManyResult: Record<string, unknown>[] = [],
) {
  return {
    upsert: vi.fn().mockResolvedValue({}),
    findUnique: vi.fn().mockResolvedValue(findUniqueResult),
    findMany: vi.fn().mockResolvedValue(findManyResult),
  };
}

function makeDb(overrides?: {
  identity?: Record<string, unknown> | null;
  email?: Record<string, unknown> | null;
  lodge?: Record<string, unknown> | null;
  clubTime?: Record<string, unknown> | null;
  ageTierRows?: Record<string, unknown>[];
}): WizardDbClient {
  return {
    clubIdentitySettings: makeDelegate(overrides?.identity ?? null),
    emailMessageSetting: makeDelegate(overrides?.email ?? null),
    lodgeSettings: makeDelegate(overrides?.lodge ?? null),
    ageTierSetting: makeDelegate(null, overrides?.ageTierRows ?? []),
    clubTimeSettings: makeDelegate(overrides?.clubTime ?? null),
    // Batch form: resolve all operations together; reject (roll back) if any do.
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  } as unknown as WizardDbClient;
}

// The wizard's club-timezone prompt default comes from the environment when
// nothing is stored (CT-1, #2989), so every test here pins `process.env.TZ`
// rather than inheriting the host's or CI runner's zone. Restored by ASSIGNING
// the captured value back — never by deleting it (#2485).
const hostTimeZone = captureHostTimeZone();
const originalNextPublicTz = process.env.NEXT_PUBLIC_TZ;

beforeEach(() => {
  process.env.TZ = CLUB_TIME_ZONE_FALLBACK;
  delete process.env.NEXT_PUBLIC_TZ;
});

afterEach(() => {
  hostTimeZone.restore();
  if (originalNextPublicTz === undefined) {
    delete process.env.NEXT_PUBLIC_TZ;
  } else {
    process.env.NEXT_PUBLIC_TZ = originalNextPublicTz;
  }
});

const values: WizardConfigValues = {
  name: "Rimutaka Alpine Club",
  shortName: "RAC",
  supportEmail: "support@rac.example",
  contactEmail: "bookings@rac.example",
  publicUrl: "https://rac.example",
  emailFromName: "Rimutaka Alpine Club - Online Booking System",
  capacity: 24,
  timeZone: "Pacific/Auckland",
  ageTiers: [
    {
      tier: "INFANT" as AgeTier,
      minAge: 0,
      maxAge: 4,
      label: "Infant",
      subscriptionRequiredForBooking: false,
      familyGroupRequestCreateMemberAllowed: true,
      sortOrder: 0,
    },
    {
      tier: "ADULT" as AgeTier,
      minAge: 18,
      maxAge: null,
      label: "Adult",
      subscriptionRequiredForBooking: true,
      familyGroupRequestCreateMemberAllowed: false,
      sortOrder: 1,
    },
  ],
};

describe("setup-wizard-db", () => {
  it("writes identity, email, capacity, and age tiers to the DB (no file involved)", async () => {
    const db = makeDb();
    await applyWizardConfigToDatabase(values, db);

    const identity = db.clubIdentitySettings.upsert as ReturnType<typeof vi.fn>;
    expect(identity).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "default" },
        update: expect.objectContaining({ name: "Rimutaka Alpine Club", shortName: "RAC", updatedByMemberId: null }),
        create: expect.objectContaining({ id: "default", name: "Rimutaka Alpine Club" }),
      }),
    );

    const email = db.emailMessageSetting.upsert as ReturnType<typeof vi.fn>;
    expect(email).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          clubName: "Rimutaka Alpine Club",
          emailFromName: values.emailFromName,
          supportEmail: "support@rac.example",
          contactEmail: "bookings@rac.example",
          publicUrl: "https://rac.example",
          updatedByMemberId: null,
        }),
      }),
    );

    const lodge = db.lodgeSettings.upsert as ReturnType<typeof vi.fn>;
    expect(lodge).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "default" },
        update: expect.objectContaining({ capacity: 24, updatedByMemberId: null }),
      }),
    );

    const ageTier = db.ageTierSetting.upsert as ReturnType<typeof vi.fn>;
    expect(ageTier).toHaveBeenCalledTimes(2);
    expect(ageTier).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tier: "INFANT" },
        create: expect.objectContaining({ tier: "INFANT", minAge: 0, maxAge: 4, sortOrder: 0 }),
      }),
    );
    expect(ageTier).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tier: "ADULT" },
        update: expect.objectContaining({ maxAge: null, subscriptionRequiredForBooking: true }),
      }),
    );
    // Age tiers are written through the batch $transaction, not a bare loop.
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it("narrows every age-tier upsert's RETURNING, never naming the dropped xeroContactGroup* columns (#2130)", async () => {
    // Blue/green safety pin, WRITE half. Prisma emits an implicit RETURNING
    // over every scalar column of an upsert unless a `select` narrows it, so an
    // unnarrowed write would name AgeTierSetting.xeroContactGroupId /
    // xeroContactGroupName — columns the #2130 STEP 2 contract migration
    // 20260721130000_contract_drop_ismember_and_agetier_xero_columns has now
    // dropped. The pin stays: a bare upsert would now be a hard 42703 error,
    // and narrow selects remain the rule for this model.
    const db = makeDb();
    await applyWizardConfigToDatabase(values, db);
    const tierUpsert = db.ageTierSetting.upsert as ReturnType<typeof vi.fn>;
    expect(tierUpsert.mock.calls.length).toBeGreaterThan(0);
    for (const call of tierUpsert.mock.calls) {
      const select = (call[0] as { select?: Record<string, unknown> }).select;
      expect(select).toEqual({ tier: true });
      expect(select).not.toHaveProperty("xeroContactGroupId");
      expect(select).not.toHaveProperty("xeroContactGroupName");
    }
  });

  it("sets bookingsName on create only so an admin-customized value survives a re-run (W2a)", async () => {
    const db = makeDb();
    await applyWizardConfigToDatabase(values, db);
    const email = db.emailMessageSetting.upsert as ReturnType<typeof vi.fn>;
    const arg = email.mock.calls[0][0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(arg.create.bookingsName).toBe("Rimutaka Alpine Club - Bookings");
    expect(arg.update).not.toHaveProperty("bookingsName");
  });

  it("keeps familyGroupRequestCreateMemberAllowed create-only so an admin customization survives an overwrite", async () => {
    const db = makeDb();
    await applyWizardConfigToDatabase(values, db);
    const tierUpsert = db.ageTierSetting.upsert as ReturnType<typeof vi.fn>;
    for (const call of tierUpsert.mock.calls) {
      const arg = call[0] as {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      };
      expect(arg.create).toHaveProperty("familyGroupRequestCreateMemberAllowed");
      expect(arg.update).not.toHaveProperty(
        "familyGroupRequestCreateMemberAllowed",
      );
    }
  });

  it("writes all age tiers atomically — a mid-set failure persists none, and a re-run completes (W1)", async () => {
    const persisted: string[] = [];
    let call = 0;
    const ageTierUpsert = vi.fn((args: { where: { tier: string } }) => {
      call += 1;
      // Simulate the second tier write failing mid-batch.
      if (call === 2) return Promise.reject(new Error("age tier write failed"));
      return Promise.resolve({ tier: args.where.tier });
    });
    const db = {
      clubIdentitySettings: makeDelegate(),
      emailMessageSetting: makeDelegate(),
      lodgeSettings: makeDelegate(),
      ageTierSetting: {
        upsert: ageTierUpsert,
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
      },
      clubTimeSettings: makeDelegate(),
      // Batch semantics: commit (record) only if every op resolves; otherwise
      // reject and record nothing (rollback).
      $transaction: vi.fn(async (ops: Promise<{ tier: string }>[]) => {
        const results = await Promise.all(ops);
        for (const r of results) persisted.push(r.tier);
        return results;
      }),
    } as unknown as WizardDbClient;

    await expect(applyWizardConfigToDatabase(values, db)).rejects.toThrow(
      "age tier write failed",
    );
    expect(persisted).toEqual([]);
    expect(db.$transaction).toHaveBeenCalledTimes(1);

    // Re-run against a healthy DB completes and persists every tier.
    const healthy = makeDb();
    await expect(
      applyWizardConfigToDatabase(values, healthy),
    ).resolves.toBeUndefined();
    expect(healthy.ageTierSetting.upsert).toHaveBeenCalledTimes(2);
  });

  it("rejects a capacity above the admin cap without writing anything (W3)", async () => {
    const db = makeDb();
    await expect(
      applyWizardConfigToDatabase({ ...values, capacity: MAX_LODGE_CAPACITY + 1 }, db),
    ).rejects.toThrow(String(MAX_LODGE_CAPACITY));
    expect(db.clubIdentitySettings.upsert).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("rejects a non-positive capacity without writing", async () => {
    const db = makeDb();
    await expect(
      applyWizardConfigToDatabase({ ...values, capacity: 0 }, db),
    ).rejects.toThrow();
    expect(db.clubIdentitySettings.upsert).not.toHaveBeenCalled();
  });

  it("accepts a capacity at the cap boundary", async () => {
    const db = makeDb();
    await expect(
      applyWizardConfigToDatabase({ ...values, capacity: MAX_LODGE_CAPACITY }, db),
    ).resolves.toBeUndefined();
  });

  it("reports an unconfigured DB as empty state with null current values (cold install)", async () => {
    const state = await readWizardConfigState(makeDb());
    expect(state).toEqual({
      hasClubIdentity: false,
      hasEmailSettings: false,
      hasLodgeCapacity: false,
      ageTierCount: 0,
      existingClubName: null,
      current: {
        name: null,
        shortName: null,
        supportEmail: null,
        contactEmail: null,
        publicUrl: null,
        emailFromName: null,
        capacity: null,
        // Never null: a NOT NULL column cannot be prompted from nothing, so the
        // wizard offers the zone the deployment is effectively using.
        timeZone: CLUB_TIME_ZONE_FALLBACK,
        ageTiers: [],
      },
    });
  });

  it("detects an already-configured DB for the overwrite gate", async () => {
    const state = await readWizardConfigState(
      makeDb({
        identity: { name: "Existing Club", shortName: "EC" },
        email: { clubName: "Existing Club", supportEmail: "s@x.example" },
        lodge: { capacity: 30 },
        ageTierRows: [
          { tier: "INFANT", minAge: 0, maxAge: 4, label: "Infant", subscriptionRequiredForBooking: false },
          { tier: "CHILD", minAge: 5, maxAge: 12, label: "Child", subscriptionRequiredForBooking: false },
          { tier: "YOUTH", minAge: 13, maxAge: 17, label: "Youth", subscriptionRequiredForBooking: false },
          { tier: "ADULT", minAge: 18, maxAge: null, label: "Adult", subscriptionRequiredForBooking: true },
        ],
      }),
    );
    expect(state.hasClubIdentity).toBe(true);
    expect(state.hasEmailSettings).toBe(true);
    expect(state.hasLodgeCapacity).toBe(true);
    expect(state.ageTierCount).toBe(4);
    expect(state.existingClubName).toBe("Existing Club");
  });

  it("returns current DB values so overwrite prompts default to admin edits (W2c)", async () => {
    const state = await readWizardConfigState(
      makeDb({
        identity: { name: "Existing Club", shortName: "EC" },
        email: {
          clubName: "Existing Club",
          supportEmail: "s@x.example",
          contactEmail: "c@x.example",
          publicUrl: "https://x.example",
          emailFromName: "Existing Club - Bookings",
        },
        lodge: { capacity: 30 },
        ageTierRows: [
          {
            tier: "ADULT",
            minAge: 18,
            maxAge: null,
            label: "Grown-up",
            subscriptionRequiredForBooking: true,
          },
        ],
      }),
    );
    expect(state.current).toEqual({
      name: "Existing Club",
      shortName: "EC",
      supportEmail: "s@x.example",
      contactEmail: "c@x.example",
      publicUrl: "https://x.example",
      emailFromName: "Existing Club - Bookings",
      capacity: 30,
      timeZone: CLUB_TIME_ZONE_FALLBACK,
      ageTiers: [
        {
          tier: "ADULT",
          minAge: 18,
          maxAge: null,
          label: "Grown-up",
          subscriptionRequiredForBooking: true,
        },
      ],
    });
  });

  it("propagates a DB error so the CLI can treat it as unreachable", async () => {
    const db = makeDb();
    (db.ageTierSetting.findMany as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("connect ECONNREFUSED"),
    );
    await expect(readWizardConfigState(db)).rejects.toThrow("ECONNREFUSED");
  });
});

/**
 * The wizard's club timezone (CT-1, #2989).
 *
 * Two things have to hold. Setup must be incapable of finishing with an empty or
 * unusable timezone, because `ClubTimeSettings.timeZone` is NOT NULL and the
 * whole point of asking is that the club's civil time is explicit. And unlike the
 * boot backfill, the operator's answer must WIN over an existing row: they were
 * asked outright, so their answer beats whatever an earlier boot copied out of
 * `TZ`.
 */
describe("setup-wizard-db — club timezone", () => {
  it("writes the timezone to the ClubTimeSettings singleton, updating an existing row", async () => {
    const db = makeDb();
    await applyWizardConfigToDatabase(
      { ...values, timeZone: "Australia/Sydney" },
      db,
    );

    expect(db.clubTimeSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "default" },
        // The operator just answered the question, so UPDATE carries the value —
        // this is deliberately not the create-only shape the age-tier and
        // bookingsName writes use.
        update: { timeZone: "Australia/Sydney", updatedByMemberId: null },
        create: {
          id: "default",
          timeZone: "Australia/Sydney",
          updatedByMemberId: null,
        },
      }),
    );
  });

  it("stores the canonical spelling of what the operator typed", async () => {
    const db = makeDb();
    await applyWizardConfigToDatabase(
      { ...values, timeZone: "  australia/sydney  " },
      db,
    );

    const call = (db.clubTimeSettings.upsert as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { update: Record<string, unknown> };
    expect(call.update.timeZone).toBe("Australia/Sydney");
  });

  it.each([
    ["an empty string", ""],
    ["whitespace", "   "],
    ["an abbreviation", "NZT"],
    ["a fixed offset", "+12:00"],
    ["the fixed-offset namespace", "Etc/GMT-12"],
    ["a zone this runtime does not know", "Pacific/Atlantis"],
  ])("refuses %s and writes NOTHING at all", async (_label, timeZone) => {
    // Rejected BEFORE any write, like the capacity guard, so a bad answer leaves
    // the database exactly as it was rather than half-applied.
    const db = makeDb();

    await expect(
      applyWizardConfigToDatabase({ ...values, timeZone }, db),
    ).rejects.toThrow(/IANA/i);

    expect(db.clubTimeSettings.upsert).not.toHaveBeenCalled();
    expect(db.clubIdentitySettings.upsert).not.toHaveBeenCalled();
    expect(db.emailMessageSetting.upsert).not.toHaveBeenCalled();
    expect(db.lodgeSettings.upsert).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("names a usable example in the refusal, so the operator can act on it", async () => {
    const db = makeDb();
    await expect(
      applyWizardConfigToDatabase({ ...values, timeZone: "NZT" }, db),
    ).rejects.toThrow(/Pacific\/Auckland/);
  });

  it("reports the stored zone as the current value, whatever TZ says", async () => {
    process.env.TZ = "America/Denver";

    const state = await readWizardConfigState(
      makeDb({ clubTime: { timeZone: "Australia/Sydney" } }),
    );

    expect(state.current.timeZone).toBe("Australia/Sydney");
  });

  it("PREMISE: reports the environment's zone when nothing is stored", async () => {
    // Without this leg the assertion above cannot tell a real precedence from an
    // environment read that never happens.
    process.env.TZ = "America/Denver";

    const state = await readWizardConfigState(makeDb());

    expect(state.current.timeZone).toBe("America/Denver");
  });

  it.each([
    ["GB", "Europe/London"],
    ["NZ-CHAT", "Pacific/Chatham"],
    ["australia/sydney", "Australia/Sydney"],
  ])(
    "offers the place TZ=%s actually means (%s) as the prompt default",
    async (raw, expected) => {
      // The wizard's default has to be the zone the deployment is already using,
      // for the same reason the backfill has to record it (#2989 review): an
      // operator who presses Enter on a default they had every reason to trust
      // must not thereby move the club. `GB` is Europe/London, not New Zealand.
      process.env.TZ = raw;

      const state = await readWizardConfigState(makeDb());

      expect(state.current.timeZone).toBe(expected);
    },
  );

  it.each(["NZT", "UTC", "Etc/GMT-12"])(
    "falls back to the documented default when TZ=%s names no place",
    async (raw) => {
      // Nothing to preserve, so the documented New Zealand default is offered —
      // and unlike the backfill that is not a silent substitution: the value is
      // on screen and a person answers for it.
      process.env.TZ = raw;

      const state = await readWizardConfigState(makeDb());

      expect(state.current.timeZone).toBe(CLUB_TIME_ZONE_FALLBACK);
    },
  );

  it("still lets the stored row win over an environment alias", async () => {
    process.env.TZ = "GB";

    const state = await readWizardConfigState(
      makeDb({ clubTime: { timeZone: "Australia/Sydney" } }),
    );

    expect(state.current.timeZone).toBe("Australia/Sydney");
  });

  it("offers the canonical spelling of a stored alias", async () => {
    // A row written before the validator canonicalised, or by hand.
    process.env.TZ = "America/Denver";

    const state = await readWizardConfigState(
      makeDb({ clubTime: { timeZone: "australia/sydney" } }),
    );

    expect(state.current.timeZone).toBe("Australia/Sydney");
  });

  it("ignores a stored value that cannot be used and offers the environment's zone", async () => {
    // A row holding an unusable value is not an answer, so the prompt must offer
    // something real rather than echoing it back into a NOT NULL column.
    process.env.TZ = "GB";

    const state = await readWizardConfigState(
      makeDb({ clubTime: { timeZone: "Etc/GMT-12" } }),
    );

    expect(state.current.timeZone).toBe("Europe/London");
  });

  it("does NOT let a stored timezone alone count as 'already configured'", async () => {
    // The boot backfill creates that row unprompted on the first boot of an
    // empty install, so treating it as configuration would make a genuinely
    // fresh database demand an overwrite confirmation.
    const state = await readWizardConfigState(
      makeDb({ clubTime: { timeZone: "Australia/Sydney" } }),
    );

    expect(state.hasClubIdentity).toBe(false);
    expect(state.hasEmailSettings).toBe(false);
    expect(state.hasLodgeCapacity).toBe(false);
    expect(state.ageTierCount).toBe(0);
    expect(state.existingClubName).toBeNull();
  });

  it("propagates an un-migrated ClubTimeSettings table as 'cannot reach the database'", async () => {
    // A read that swallowed this would offer the environment's zone as the
    // prompt default while the club's real answer sat unread in a table the CLI
    // could not open.
    const db = makeDb();
    (db.clubTimeSettings.findUnique as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('relation "ClubTimeSettings" does not exist'),
    );

    await expect(readWizardConfigState(db)).rejects.toThrow(
      /ClubTimeSettings/,
    );
  });
});
