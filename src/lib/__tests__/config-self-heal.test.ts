import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  The club-timezone step logs through the APP logger rather than the runner's
  injectable one (CT-1, #2989 review): `ConfigSelfHealStep` hands a step only the
  database, and what this step has to say — "the environment names no place, so I
  recorded nothing", "`GB` means Europe/London" — belongs in the deploy log
  whichever entrypoint ran it. Mocked here so those two lines can be asserted,
  and so nothing prints during the suite.
*/
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  },
}));
vi.mock("@/lib/logger", () => ({ default: mockLogger }));

import { clubConfig } from "@/config/club";
import { captureHostTimeZone } from "@/lib/__tests__/helpers/timezone";
import { CLUB_TIME_ZONE_FALLBACK } from "@/lib/club-time-zone";
import {
  ageTierSelfHealStep,
  clubFacebookUrlSelfHealStep,
  clubIdentitySelfHealStep,
  clubTimeZoneSelfHealStep,
  defineSelfHealStep,
  isUniqueConstraintError,
  lodgeCapacitySelfHealStep,
  runConfigSelfHeal,
  SELF_HEAL_STEPS,
  stepRequiresPrimaryClubConfig,
  type RegisteredSelfHealStep,
  type SelfHealDb,
} from "@/lib/config-self-heal";
import { clubTimeZoneSelfHealStepDefinition } from "@/lib/config-self-heal-steps";
import { CLUB_CONFIG_LODGE_CAPACITY } from "@/lib/lodge-capacity";

// The effective config Facebook link (the test config, club.example.json, sets
// one). The facebookUrl self-heal step backfills this into the null column.
const CONFIG_FACEBOOK_URL = clubConfig.socialLinks?.facebook ?? null;

// Silence the app logger in tests (runConfigSelfHeal logs per step).
const silentLog = { info: vi.fn(), warn: vi.fn() };

/**
 * Every step whose value is copied out of `config/club.json` — that is, exactly
 * the set the primary-config fallback guard covers.
 *
 * `SELF_HEAL_STEPS` is deliberately NOT the same list: since CT-1 (#2989) it also
 * holds `clubTimeZoneSelfHealStep`, whose value comes from the ENVIRONMENT and
 * which therefore runs whatever state `config/club.json` is in. The guard tests
 * below pass this list explicitly so they keep testing the guard, and the
 * partial-run behaviour of the real registry gets its own tests further down.
 */
const CLUB_CONFIG_STEPS: readonly RegisteredSelfHealStep[] = [
  clubIdentitySelfHealStep,
  clubFacebookUrlSelfHealStep,
  ageTierSelfHealStep,
  lodgeCapacitySelfHealStep,
];

/**
 * A stateful in-memory fake of the ClubIdentitySettings singleton delegate.
 * `findUnique` returns the stored row (or null); `upsert` is real create-or-
 * update (create when absent, else merge the `update` object — which is `{}` for
 * every create-if-absent step, so an existing row is left untouched);
 * `updateMany` merges `data` only when the row matches every column predicate in
 * `where` (used by the facebookUrl step's null-scoped, non-overwriting backfill).
 * The raced-INSERT (P2002) path is exercised for real by the dedicated
 * double-boot test below, which pins its own fake.
 */
function makeIdentityDb(seedRow?: Record<string, unknown>) {
  const rows = new Map<string, Record<string, unknown>>();
  if (seedRow) rows.set("default", { id: "default", ...seedRow });

  const db = {
    clubIdentitySettings: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return rows.get(where.id) ?? null;
      }),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { id: string };
          create: Record<string, unknown>;
          update?: Record<string, unknown>;
        }) => {
          const existing = rows.get(where.id);
          if (existing) {
            const merged = { ...existing, ...(update ?? {}) };
            rows.set(where.id, merged);
            return merged;
          }
          rows.set(where.id, { ...create });
          return rows.get(where.id);
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown> & { id: string };
          data: Record<string, unknown>;
        }) => {
          const existing = rows.get(where.id);
          if (!existing) return { count: 0 };
          for (const [key, value] of Object.entries(where)) {
            if (key === "id") continue;
            const current = existing[key] ?? null;
            if (current !== value) return { count: 0 };
          }
          rows.set(where.id, { ...existing, ...data });
          return { count: 1 };
        },
      ),
    },
  };

  return { rows, db: db as unknown as SelfHealDb };
}

describe("isUniqueConstraintError", () => {
  it("detects a structural P2002 error", () => {
    expect(isUniqueConstraintError({ code: "P2002" })).toBe(true);
    expect(
      isUniqueConstraintError(Object.assign(new Error("dup"), { code: "P2002" })),
    ).toBe(true);
  });

  it("rejects other errors", () => {
    expect(isUniqueConstraintError(new Error("boom"))).toBe(false);
    expect(isUniqueConstraintError({ code: "P2003" })).toBe(false);
    expect(isUniqueConstraintError(null)).toBe(false);
    expect(isUniqueConstraintError(undefined)).toBe(false);
  });
});

describe("runConfigSelfHeal — cold un-backfilled DB", () => {
  it("populates the identity row from the effective config on first run", async () => {
    const { rows, db } = makeIdentityDb();

    const summary = await runConfigSelfHeal({
      db,
      steps: [clubIdentitySelfHealStep, clubFacebookUrlSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    // Both identity fields AND the facebookUrl column heal on a cold DB.
    expect(summary.healed).toBe(2);
    expect(summary.alreadyPresent).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.results[0]).toMatchObject({
      name: "club-identity-settings",
      outcome: "healed",
    });
    expect(summary.results[1]).toMatchObject({
      name: "club-identity-facebook-url",
      outcome: "healed",
    });

    // The row now holds the EFFECTIVE config identity (mirrors the seed upsert).
    expect(rows.get("default")).toMatchObject({
      id: "default",
      name: clubConfig.name,
      shortName: clubConfig.shortName ?? null,
      hutLeaderLabel: clubConfig.hutLeaderLabel ?? null,
      facebookUrl: CONFIG_FACEBOOK_URL,
    });
  });

  it("is a no-op on the second run (idempotent)", async () => {
    const { rows, db } = makeIdentityDb();

    await runConfigSelfHeal({
      db,
      steps: [clubIdentitySelfHealStep, clubFacebookUrlSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });
    const upsertCallsAfterFirst = (
      db as unknown as { clubIdentitySettings: { upsert: { mock: { calls: unknown[] } } } }
    ).clubIdentitySettings.upsert.mock.calls.length;

    const second = await runConfigSelfHeal({
      db,
      steps: [clubIdentitySelfHealStep, clubFacebookUrlSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(second.healed).toBe(0);
    // Both steps now see a populated row/column and skip.
    expect(second.alreadyPresent).toBe(2);
    expect(second.failed).toBe(0);
    expect(rows.size).toBe(1);
    // No further write happened on the second run.
    expect(
      (
        db as unknown as {
          clubIdentitySettings: { upsert: { mock: { calls: unknown[] } } };
        }
      ).clubIdentitySettings.upsert.mock.calls.length,
    ).toBe(upsertCallsAfterFirst);
  });
});

describe("runConfigSelfHeal — never overwrites an admin edit", () => {
  it("leaves an existing admin-configured row untouched", async () => {
    const { rows, db } = makeIdentityDb({
      name: "Admin Renamed Club",
      shortName: "ARC",
      hutLeaderLabel: null, // an intentional null the admin left blank
      facebookUrl: "https://facebook.com/admin-set", // admin-configured link
    });

    const summary = await runConfigSelfHeal({
      db,
      steps: [clubIdentitySelfHealStep, clubFacebookUrlSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(summary.healed).toBe(0);
    // Both steps see a populated row/column and skip.
    expect(summary.alreadyPresent).toBe(2);
    expect(rows.get("default")).toMatchObject({
      name: "Admin Renamed Club",
      shortName: "ARC",
      hutLeaderLabel: null,
      facebookUrl: "https://facebook.com/admin-set",
    });
    // The write path must not be invoked when the row is present.
    expect(
      (
        db as unknown as {
          clubIdentitySettings: { upsert: { mock: { calls: unknown[] } } };
        }
      ).clubIdentitySettings.upsert,
    ).not.toHaveBeenCalled();
    // Nor the facebookUrl backfill.
    expect(
      (
        db as unknown as {
          clubIdentitySettings: { updateMany: { mock: { calls: unknown[] } } };
        }
      ).clubIdentitySettings.updateMany,
    ).not.toHaveBeenCalled();
  });
});

describe("runConfigSelfHeal — best-effort resilience", () => {
  it("records a failed step and never throws when the DB errors", async () => {
    const db = {
      clubIdentitySettings: {
        findUnique: vi.fn(async () => {
          throw new Error("connection refused");
        }),
        upsert: vi.fn(),
      },
    } as unknown as SelfHealDb;

    // Scope to the identity step so the assertion targets exactly one failure.
    const summary = await runConfigSelfHeal({
      db,
      steps: [clubIdentitySelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(summary.failed).toBe(1);
    expect(summary.healed).toBe(0);
    expect(summary.results[0]).toMatchObject({
      name: "club-identity-settings",
      outcome: "failed",
    });
    expect(summary.results[0].error).toContain("connection refused");
    expect(silentLog.warn).toHaveBeenCalled();
  });

  it("keeps running later steps after an earlier step fails", async () => {
    const failing: RegisteredSelfHealStep = {
      name: "boom",
      isPresent: vi.fn(async () => {
        throw new Error("boom");
      }),
      heal: vi.fn(),
    };
    const healed = { value: false };
    const ok: RegisteredSelfHealStep = {
      name: "ok",
      isPresent: vi.fn(async () => false),
      heal: vi.fn(async () => {
        healed.value = true;
      }),
    };

    const summary = await runConfigSelfHeal({
      db: {} as SelfHealDb,
      steps: [failing, ok],
      log: silentLog,
      provenance: "primary",
    });

    expect(summary.failed).toBe(1);
    expect(summary.healed).toBe(1);
    expect(healed.value).toBe(true);
  });
});

describe("runConfigSelfHeal — blue/green double-boot", () => {
  it("tolerates a concurrent writer (P2002) as already-present with exactly one row", async () => {
    // Both booters share one DB. `findUnique` is pinned to null so BOTH observe
    // an absent row in the racing window; the second `upsert` then hits the
    // unique constraint (P2002) that the fake raises once a row exists.
    const rows = new Map<string, Record<string, unknown>>();
    const db = {
      clubIdentitySettings: {
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(
          async ({
            where,
            create,
          }: {
            where: { id: string };
            create: Record<string, unknown>;
          }) => {
            if (rows.has(where.id)) {
              throw Object.assign(new Error("Unique constraint failed"), {
                code: "P2002",
              });
            }
            rows.set(where.id, { ...create });
            return rows.get(where.id);
          },
        ),
      },
    } as unknown as SelfHealDb;

    const first = await runConfigSelfHeal({
      db,
      steps: [clubIdentitySelfHealStep],
      log: silentLog,
      provenance: "primary",
    });
    const second = await runConfigSelfHeal({
      db,
      steps: [clubIdentitySelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(first.results[0].outcome).toBe("healed");
    expect(second.results[0].outcome).toBe("already-present");
    expect(second.failed).toBe(0);
    // Exactly one populated row despite two boots both seeing it absent.
    expect(rows.size).toBe(1);
  });
});

describe("runConfigSelfHeal — config-fallback guard (never freeze a fallback)", () => {
  it("skips every config/club.json step on a cold DB when provenance is safe-default (zero writes, skip result, warning)", async () => {
    const { rows, db } = makeIdentityDb();
    const log = { info: vi.fn(), warn: vi.fn() };

    const summary = await runConfigSelfHeal({
      db,
      steps: CLUB_CONFIG_STEPS,
      log,
      provenance: "safe-default",
    });

    expect(summary.skipped).toBe(true);
    expect(summary.provenance).toBe("safe-default");
    expect(summary.healed).toBe(0);
    expect(summary.alreadyPresent).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.results).toEqual([]);

    // Nothing touched the DB at all — not even a presence read.
    expect(rows.size).toBe(0);
    expect(
      (db as unknown as { clubIdentitySettings: { findUnique: ReturnType<typeof vi.fn> } })
        .clubIdentitySettings.findUnique,
    ).not.toHaveBeenCalled();
    expect(
      (db as unknown as { clubIdentitySettings: { upsert: ReturnType<typeof vi.fn> } })
        .clubIdentitySettings.upsert,
    ).not.toHaveBeenCalled();

    // A loud, greppable warning names the provenance.
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatchObject({
      scope: "config-self-heal",
      provenance: "safe-default",
    });
    expect(log.warn.mock.calls[0][1]).toMatch(/self-heal skipped/i);
  });

  it("skips every config/club.json step when booting on the example config (never persists the example identity)", async () => {
    const { rows, db } = makeIdentityDb();

    const summary = await runConfigSelfHeal({
      db,
      steps: CLUB_CONFIG_STEPS,
      log: silentLog,
      provenance: "example",
    });

    expect(summary.skipped).toBe(true);
    expect(summary.provenance).toBe("example");
    expect(summary.healed).toBe(0);
    expect(rows.size).toBe(0);
    expect(
      (db as unknown as { clubIdentitySettings: { upsert: ReturnType<typeof vi.fn> } })
        .clubIdentitySettings.upsert,
    ).not.toHaveBeenCalled();
  });

  it("heals on a later boot once config/club.json is fixed (skipped boot leaves the DB cold, next primary boot backfills)", async () => {
    const { rows, db } = makeIdentityDb();

    // Boot 1: a bad/absent primary resolved to safe-default → skipped, DB cold.
    const skippedRun = await runConfigSelfHeal({
      db,
      steps: CLUB_CONFIG_STEPS,
      log: silentLog,
      provenance: "safe-default",
    });
    expect(skippedRun.skipped).toBe(true);
    expect(rows.size).toBe(0);

    // Boot 2: operator fixed config/club.json → provenance "primary" → heals.
    const healedRun = await runConfigSelfHeal({
      db,
      steps: [clubIdentitySelfHealStep, clubFacebookUrlSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });
    expect(healedRun.skipped).toBe(false);
    expect(healedRun.healed).toBe(2);
    expect(rows.get("default")).toMatchObject({
      id: "default",
      name: clubConfig.name,
      shortName: clubConfig.shortName ?? null,
      hutLeaderLabel: clubConfig.hutLeaderLabel ?? null,
      facebookUrl: CONFIG_FACEBOOK_URL,
    });
  });
});

/**
 * A stateful in-memory fake of the `AgeTierSetting` delegate for the age-tier
 * self-heal step (#1983), modelling the ATOMIC multi-row write for real.
 *
 * - `findFirst` reports whether ANY row exists (the table-empty presence
 *   check). `pinPresenceAbsent` forces it to report empty even once rows exist,
 *   so both racers in a blue/green double-boot observe the empty window.
 * - `upsert` returns a LAZY operation (mirroring Prisma's un-executed
 *   `PrismaPromise`): it is NOT applied until the enclosing `$transaction` runs
 *   it. When run it is create-if-absent keyed on the unique `tier`; if the tier
 *   already exists it throws a real P2002-shaped error — the exact shape a raced
 *   INSERT surfaces under the unique constraint (concurrent blue/green boot).
 * - `$transaction([...])` runs the queued ops in order and is ALL-OR-NOTHING:
 *   any thrown error (an injected transient failure via `fail.tier`, or a raced
 *   P2002) restores every row to the pre-transaction snapshot and rethrows — so
 *   the production step's atomicity + clean-retry guarantee is exercised for
 *   real rather than asserted by fiat.
 *
 * `fail.tier` injects a mid-write transient (non-P2002) failure: the op for that
 * tier throws, modelling a DB blip partway through the batch. Set it back to
 * null to let a later run succeed (the clean-retry pin).
 */
function makeAgeTierDb(
  seedRows: Array<{ tier: string }> = [],
  options: { pinPresenceAbsent?: boolean } = {},
) {
  const rows = new Map<string, Record<string, unknown>>();
  for (const r of seedRows) rows.set(r.tier, { ...r });
  const fail: { tier: string | null } = { tier: null };

  const db = {
    ageTierSetting: {
      findFirst: vi.fn(async () => {
        if (options.pinPresenceAbsent) return null;
        const first = rows.values().next();
        return first.done ? null : first.value;
      }),
      upsert: vi.fn(
        ({
          where,
          create,
        }: {
          where: { tier: string };
          create: Record<string, unknown>;
        }) => ({
          // Lazy op — applied only when `$transaction` runs it, exactly as a
          // Prisma `PrismaPromise` is deferred until the transaction executes.
          __run: () => {
            if (fail.tier === where.tier) {
              throw new Error(`transient DB error writing tier ${where.tier}`);
            }
            if (rows.has(where.tier)) {
              // The tier was created between our table-empty snapshot and this
              // insert (concurrent booter) — a raced INSERT under unique(tier)
              // surfaces as P2002.
              throw Object.assign(
                new Error("Unique constraint failed on the fields: (`tier`)"),
                { code: "P2002" },
              );
            }
            rows.set(where.tier, { ...create });
            return { tier: where.tier };
          },
        }),
      ),
    },
    $transaction: vi.fn(async (ops: Array<{ __run: () => unknown }>) => {
      // Snapshot the table, then apply the queued ops. Any failure rolls the
      // WHOLE batch back to the snapshot (atomic all-or-nothing) and rethrows.
      const snapshot = new Map(
        [...rows].map(([k, v]) => [k, { ...v }] as const),
      );
      const results: unknown[] = [];
      try {
        for (const op of ops) results.push(op.__run());
        return results;
      } catch (err) {
        rows.clear();
        for (const [k, v] of snapshot) rows.set(k, v);
        throw err;
      }
    }),
  };

  return { rows, fail, db: db as unknown as SelfHealDb };
}

describe("ageTierSelfHealStep — empty table heals from effective config", () => {
  it("populates all configured tiers on a cold table", async () => {
    const { rows, db } = makeAgeTierDb();

    const summary = await runConfigSelfHeal({
      db,
      steps: [ageTierSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(summary.healed).toBe(1);
    expect(summary.results[0]).toMatchObject({
      name: "age-tier-settings",
      outcome: "healed",
    });

    // One row per effective-config tier, mirroring the seed create-if-missing.
    expect(rows.size).toBe(clubConfig.ageTiers.length);
    for (const tier of clubConfig.ageTiers) {
      expect(rows.get(tier.id)).toMatchObject({
        tier: tier.id,
        minAge: tier.minAge,
        maxAge: tier.maxAge,
        label: tier.label,
        subscriptionRequiredForBooking: tier.subscriptionRequiredForBooking,
        familyGroupRequestCreateMemberAllowed:
          tier.familyGroupRequestCreateMemberAllowed,
      });
    }
  });

  it("is idempotent across a double-boot (second boot is a no-op)", async () => {
    const { rows, db } = makeAgeTierDb();

    await runConfigSelfHeal({
      db,
      steps: [ageTierSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });
    const sizeAfterFirst = rows.size;

    const second = await runConfigSelfHeal({
      db,
      steps: [ageTierSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(second.alreadyPresent).toBe(1);
    expect(second.healed).toBe(0);
    expect(rows.size).toBe(sizeAfterFirst);
  });
});

describe("ageTierSelfHealStep — never overwrites admin-edited tiers", () => {
  it("skips the write entirely when ANY row already exists", async () => {
    // An admin pruned the table to a single custom tier. The whole-table
    // presence gate must leave it untouched — no new default rows inserted.
    const { rows, db } = makeAgeTierDb([{ tier: "ADULT" }]);

    const summary = await runConfigSelfHeal({
      db,
      steps: [ageTierSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(summary.alreadyPresent).toBe(1);
    expect(summary.healed).toBe(0);
    expect(rows.size).toBe(1);
    expect(
      (db as unknown as { ageTierSetting: { upsert: ReturnType<typeof vi.fn> } })
        .ageTierSetting.upsert,
    ).not.toHaveBeenCalled();
  });
});

describe("ageTierSelfHealStep — blue/green double-boot race (atomic write)", () => {
  it("two boots both seeing the table empty yield exactly one full 4-row set; the second is already-present", async () => {
    // Both booters share one table and observe it empty in the racing window
    // (pinPresenceAbsent forces `findFirst` to report empty for both). The first
    // transaction inserts the full set; the second transaction's first upsert
    // then collides on unique(tier) → P2002 → the whole batch rolls back → the
    // runner records already-present. Never a partial or duplicated set.
    const { rows, db } = makeAgeTierDb([], { pinPresenceAbsent: true });

    const first = await runConfigSelfHeal({
      db,
      steps: [ageTierSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });
    const second = await runConfigSelfHeal({
      db,
      steps: [ageTierSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(first.results[0].outcome).toBe("healed");
    expect(second.results[0].outcome).toBe("already-present");
    expect(second.failed).toBe(0);
    // Exactly one full set despite both boots seeing the table empty.
    expect(rows.size).toBe(clubConfig.ageTiers.length);
  });
});

describe("ageTierSelfHealStep — mid-write transient failure (clean retry)", () => {
  it("a failure partway through leaves the table EMPTY (atomic rollback), and the next boot heals every tier", async () => {
    const { rows, fail, db } = makeAgeTierDb();
    // Fail on the third-written tier: under a non-atomic per-row loop this would
    // leave a partial set (the first two tiers) that wedges the table forever.
    const midTier = clubConfig.ageTiers[2].id;
    fail.tier = midTier;

    const failed = await runConfigSelfHeal({
      db,
      steps: [ageTierSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(failed.failed).toBe(1);
    expect(failed.results[0]).toMatchObject({
      name: "age-tier-settings",
      outcome: "failed",
    });
    // Atomic rollback: NO partial set. The table is left completely empty so the
    // table-empty presence check retries cleanly on the next boot.
    expect(rows.size).toBe(0);

    // Next boot with the transient blip cleared heals the full set.
    fail.tier = null;
    const healed = await runConfigSelfHeal({
      db,
      steps: [ageTierSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(healed.healed).toBe(1);
    expect(healed.results[0].outcome).toBe("healed");
    expect(rows.size).toBe(clubConfig.ageTiers.length);
  });
});

describe("ageTierSelfHealStep — config-fallback guard", () => {
  it("skips healing on a non-primary provenance (never freezes example/safe-default tiers)", async () => {
    const { rows, db } = makeAgeTierDb();

    const summary = await runConfigSelfHeal({
      db,
      steps: [ageTierSelfHealStep],
      log: silentLog,
      provenance: "example",
    });

    expect(summary.skipped).toBe(true);
    expect(rows.size).toBe(0);
    expect(
      (db as unknown as { ageTierSetting: { findFirst: ReturnType<typeof vi.fn> } })
        .ageTierSetting.findFirst,
    ).not.toHaveBeenCalled();
  });
});

function makeLodgeSettingsDb(seedRow?: { capacity: number | null } & Record<string, unknown>) {
  const rows = new Map<string, Record<string, unknown>>();
  if (seedRow) rows.set("default", { id: "default", ...seedRow });

  const db = {
    lodgeSettings: {
      findUnique: vi.fn(
        async ({
          where,
          select,
        }: {
          where: { id: string };
          select?: Record<string, boolean>;
        }) => {
          const row = rows.get(where.id);
          if (!row) return null;
          if (select) {
            return Object.fromEntries(
              Object.keys(select).map((k) => [k, row[k] ?? null]),
            );
          }
          return row;
        },
      ),
      // Real Prisma semantics: an existing row runs the (no-op `update: {}`)
      // branch and is left untouched — it does NOT raise P2002. Create-if-absent
      // only.
      upsert: vi.fn(
        async ({
          where,
          create,
        }: {
          where: { id: string };
          create: Record<string, unknown>;
        }) => {
          if (!rows.has(where.id)) {
            rows.set(where.id, { ...create });
          }
          return { id: where.id };
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; capacity: null };
          data: { capacity: number };
        }) => {
          const row = rows.get(where.id);
          // Atomic guard: only fill when capacity is still null.
          if (row && where.capacity === null && row.capacity == null) {
            row.capacity = data.capacity;
            return { count: 1 };
          }
          return { count: 0 };
        },
      ),
    },
  };

  return { rows, db: db as unknown as SelfHealDb };
}

describe("lodgeCapacitySelfHealStep — backfills the default lodge capacity (#1982)", () => {
  it("creates the default LodgeSettings row with the config bed total on a cold DB", async () => {
    const { rows, db } = makeLodgeSettingsDb();

    const summary = await runConfigSelfHeal({
      db,
      log: silentLog,
      provenance: "primary",
      steps: [lodgeCapacitySelfHealStep],
    });

    expect(summary.healed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(rows.get("default")).toMatchObject({
      id: "default",
      capacity: CLUB_CONFIG_LODGE_CAPACITY,
    });
  });

  it("fills a null capacity on an existing row without touching other columns", async () => {
    const { rows, db } = makeLodgeSettingsDb({
      capacity: null,
      hutLeaderLookaheadDays: 21,
    });

    const summary = await runConfigSelfHeal({
      db,
      log: silentLog,
      provenance: "primary",
      steps: [lodgeCapacitySelfHealStep],
    });

    expect(summary.healed).toBe(1);
    expect(rows.get("default")).toMatchObject({
      capacity: CLUB_CONFIG_LODGE_CAPACITY,
      hutLeaderLookaheadDays: 21,
    });
    // The row already existed, so no create was attempted destructively.
  });

  it("never overwrites an admin-set capacity", async () => {
    const { rows, db } = makeLodgeSettingsDb({ capacity: 7 });

    const summary = await runConfigSelfHeal({
      db,
      log: silentLog,
      provenance: "primary",
      steps: [lodgeCapacitySelfHealStep],
    });

    expect(summary.healed).toBe(0);
    expect(summary.alreadyPresent).toBe(1);
    expect(rows.get("default")).toMatchObject({ capacity: 7 });
    // Present column → write path (upsert/updateMany) is never invoked.
    expect(
      (db as unknown as { lodgeSettings: { upsert: ReturnType<typeof vi.fn> } })
        .lodgeSettings.upsert,
    ).not.toHaveBeenCalled();
    expect(
      (db as unknown as { lodgeSettings: { updateMany: ReturnType<typeof vi.fn> } })
        .lodgeSettings.updateMany,
    ).not.toHaveBeenCalled();
  });

  it("is idempotent and double-boot safe (second run already-present, one value)", async () => {
    const { rows, db } = makeLodgeSettingsDb();

    const first = await runConfigSelfHeal({
      db,
      log: silentLog,
      provenance: "primary",
      steps: [lodgeCapacitySelfHealStep],
    });
    const second = await runConfigSelfHeal({
      db,
      log: silentLog,
      provenance: "primary",
      steps: [lodgeCapacitySelfHealStep],
    });

    expect(first.results[0].outcome).toBe("healed");
    expect(second.results[0].outcome).toBe("already-present");
    expect(second.failed).toBe(0);
    expect(rows.get("default")).toMatchObject({ capacity: CLUB_CONFIG_LODGE_CAPACITY });
  });

  it("is skipped entirely on a non-primary config (provenance guard, no writes)", async () => {
    const { rows, db } = makeLodgeSettingsDb();

    const summary = await runConfigSelfHeal({
      db,
      log: silentLog,
      provenance: "safe-default",
      steps: [lodgeCapacitySelfHealStep],
    });

    expect(summary.skipped).toBe(true);
    expect(rows.size).toBe(0);
    expect(
      (db as unknown as { lodgeSettings: { findUnique: ReturnType<typeof vi.fn> } })
        .lodgeSettings.findUnique,
    ).not.toHaveBeenCalled();
  });
});

/**
 * A fuller LodgeSettings fake that also exposes the delegates
 * `getDefaultLodgeCapacity` reaches through (clubModuleSettings, lodge,
 * lodgeBed), so the E1 gate can be exercised end-to-end: the capacity step now
 * skips healing when the default lodge already resolves > 0 via active beds.
 */
function makeCapacityStepDb(opts: {
  capacity?: number | null;
  seedRow?: boolean;
  bedAllocation?: boolean;
  activeBeds?: number;
  // When false, no `lodge` delegate → the default lodge id is unresolvable, so
  // resolveDefaultLodgeIdSafe returns null and a heal creates an UNLINKED row.
  resolvableLodge?: boolean;
  defaultLodgeId?: string;
}) {
  const {
    capacity = null,
    seedRow = false,
    bedAllocation = false,
    activeBeds = 0,
    resolvableLodge = false,
    defaultLodgeId = "lodge-default",
  } = opts;

  const rows = new Map<string, Record<string, unknown>>();
  if (seedRow) rows.set("default", { id: "default", capacity });

  const lodgeSettings = {
    findUnique: vi.fn(
      async ({
        where,
        select,
      }: {
        where: { id: string };
        select?: Record<string, boolean>;
      }) => {
        const row = rows.get(where.id);
        if (!row) return null;
        if (select) {
          return Object.fromEntries(
            Object.keys(select).map((k) => [k, row[k] ?? null]),
          );
        }
        return row;
      },
    ),
    upsert: vi.fn(
      async ({
        where,
        create,
      }: {
        where: { id: string };
        create: Record<string, unknown>;
      }) => {
        if (!rows.has(where.id)) rows.set(where.id, { ...create });
        return { id: where.id };
      },
    ),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown> & { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = rows.get(where.id);
        if (!row) return { count: 0 };
        // Match every non-id column predicate (null-scoped fills).
        for (const [key, value] of Object.entries(where)) {
          if (key === "id") continue;
          if ((row[key] ?? null) !== value) return { count: 0 };
        }
        rows.set(where.id, { ...row, ...data });
        return { count: 1 };
      },
    ),
  };

  const db = {
    lodgeSettings,
    clubModuleSettings: {
      findUnique: vi.fn(async () => ({ bedAllocation })),
    },
    lodgeBed: {
      count: vi.fn(async () => activeBeds),
    },
    ...(resolvableLodge
      ? {
          lodge: {
            findFirst: vi.fn(async () => ({ id: defaultLodgeId })),
          },
        }
      : {}),
  };

  return { rows, db: db as unknown as SelfHealDb };
}

describe("lodgeCapacitySelfHealStep — E1 gate (never cap a Bed-Allocation-ON lodge)", () => {
  it("does NOT write when Bed Allocation is ON with active beds and capacity is null (no silent cap)", async () => {
    // Default lodge: Bed Allocation ON, active beds, deliberately-null capacity
    // ("no ceiling — use the bed count"). The pre-fix heal wrote the config bed
    // total as a capping override, reducing resolution to min(beds, total).
    const { rows, db } = makeCapacityStepDb({
      seedRow: true,
      capacity: null,
      bedAllocation: true,
      activeBeds: 8,
    });

    const summary = await runConfigSelfHeal({
      db,
      log: silentLog,
      provenance: "primary",
      steps: [lodgeCapacitySelfHealStep],
    });

    expect(summary.healed).toBe(0);
    expect(summary.alreadyPresent).toBe(1);
    // Capacity stays null → resolution stays at the live bed count, uncapped.
    expect(rows.get("default")).toMatchObject({ capacity: null });
    expect(
      (db as unknown as { lodgeSettings: { upsert: ReturnType<typeof vi.fn> } })
        .lodgeSettings.upsert,
    ).not.toHaveBeenCalled();
    expect(
      (db as unknown as { lodgeSettings: { updateMany: ReturnType<typeof vi.fn> } })
        .lodgeSettings.updateMany,
    ).not.toHaveBeenCalled();
  });

  it("DOES heal when Bed Allocation is OFF and capacity is null (tokoroa outage case)", async () => {
    const { rows, db } = makeCapacityStepDb({
      seedRow: true,
      capacity: null,
      bedAllocation: false,
    });

    const summary = await runConfigSelfHeal({
      db,
      log: silentLog,
      provenance: "primary",
      steps: [lodgeCapacitySelfHealStep],
    });

    expect(summary.healed).toBe(1);
    expect(rows.get("default")).toMatchObject({
      capacity: CLUB_CONFIG_LODGE_CAPACITY,
    });
  });

  it("DOES heal when Bed Allocation is ON but there are zero active beds", async () => {
    const { rows, db } = makeCapacityStepDb({
      seedRow: true,
      capacity: null,
      bedAllocation: true,
      activeBeds: 0,
    });

    const summary = await runConfigSelfHeal({
      db,
      log: silentLog,
      provenance: "primary",
      steps: [lodgeCapacitySelfHealStep],
    });

    expect(summary.healed).toBe(1);
    expect(rows.get("default")).toMatchObject({
      capacity: CLUB_CONFIG_LODGE_CAPACITY,
    });
  });
});

describe("lodgeCapacitySelfHealStep — C1 link healed row to the default lodge", () => {
  it("links the created row to the default lodge so its capacity cannot leak to other lodges", async () => {
    // Cold DB, Bed Allocation off, default lodge resolvable → heal + link.
    const { rows, db } = makeCapacityStepDb({
      seedRow: false,
      bedAllocation: false,
      resolvableLodge: true,
      defaultLodgeId: "lodge-abc",
    });

    const summary = await runConfigSelfHeal({
      db,
      log: silentLog,
      provenance: "primary",
      steps: [lodgeCapacitySelfHealStep],
    });

    expect(summary.healed).toBe(1);
    expect(rows.get("default")).toMatchObject({
      capacity: CLUB_CONFIG_LODGE_CAPACITY,
      lodgeId: "lodge-abc",
    });
  });

  it("leaves the created row UNLINKED (documented residual) when the default lodge is unresolvable", async () => {
    const { rows, db } = makeCapacityStepDb({
      seedRow: false,
      bedAllocation: false,
      resolvableLodge: false,
    });

    const summary = await runConfigSelfHeal({
      db,
      log: silentLog,
      provenance: "primary",
      steps: [lodgeCapacitySelfHealStep],
    });

    expect(summary.healed).toBe(1);
    expect(rows.get("default")).toMatchObject({
      capacity: CLUB_CONFIG_LODGE_CAPACITY,
      lodgeId: null,
    });
  });
});

describe("lodgeCapacitySelfHealStep — E3 log honesty on a 0-bed config", () => {
  it("reports already-present (not a phantom 'healed') and writes nothing when the config bed total is 0", async () => {
    vi.resetModules();
    vi.doMock("@/config/club", () => ({
      clubConfig: {
        name: "No Beds Club",
        shortName: null,
        hutLeaderLabel: null,
        socialLinks: {},
        beds: [], // 0-bed config → CLUB_CONFIG_LODGE_CAPACITY === 0
      },
      clubConfigSource: "primary",
    }));
    try {
      const { lodgeCapacitySelfHealStep: step, runConfigSelfHeal: run } =
        await import("@/lib/config-self-heal");
      const { rows, db } = makeLodgeSettingsDb({ capacity: null });

      const summary = await run({
        db,
        steps: [step],
        log: silentLog,
        provenance: "primary",
      });

      expect(summary.healed).toBe(0);
      expect(summary.alreadyPresent).toBe(1);
      expect(summary.results[0]).toMatchObject({
        name: "lodge-capacity",
        outcome: "already-present",
      });
      // No write, and capacity stays null (0-bed config has nothing to persist).
      expect(rows.get("default")).toMatchObject({ capacity: null });
      const settings = db as unknown as {
        lodgeSettings: {
          upsert: ReturnType<typeof vi.fn>;
          updateMany: ReturnType<typeof vi.fn>;
        };
      };
      expect(settings.lodgeSettings.upsert).not.toHaveBeenCalled();
      expect(settings.lodgeSettings.updateMany).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("@/config/club");
      vi.resetModules();
    }
  });
});


describe("registry", () => {
  it("registers the identity step first and the facebookUrl step alongside it", () => {
    expect(SELF_HEAL_STEPS[0]).toBe(clubIdentitySelfHealStep);
    expect(SELF_HEAL_STEPS[0].name).toBe("club-identity-settings");
    expect(SELF_HEAL_STEPS).toContain(clubFacebookUrlSelfHealStep);
    expect(clubFacebookUrlSelfHealStep.name).toBe("club-identity-facebook-url");
  });

  it("registers the age-tier step", () => {
    expect(SELF_HEAL_STEPS).toContain(ageTierSelfHealStep);
    expect(ageTierSelfHealStep.name).toBe("age-tier-settings");
  });

  it("registers the lodge-capacity step and pins the registry size", () => {
    expect(SELF_HEAL_STEPS).toContain(lodgeCapacitySelfHealStep);
    expect(lodgeCapacitySelfHealStep.name).toBe("lodge-capacity");
    // A future step must consciously extend this pin.
    expect(SELF_HEAL_STEPS).toHaveLength(5);
  });

  it("registers the club-time-zone step (CT-1, #2989)", () => {
    expect(SELF_HEAL_STEPS).toContain(clubTimeZoneSelfHealStep);
    expect(clubTimeZoneSelfHealStep.name).toBe("club-time-zone");
  });

  it("exempts ONLY the club-time-zone step from the primary-config guard", () => {
    // The exemption is the dangerous part of this change, so it is pinned by
    // name: if a future step is written with requiresPrimaryClubConfig: false by
    // copy-paste, this fails and its author has to justify it.
    const exempt = SELF_HEAL_STEPS.filter(
      (step) => !stepRequiresPrimaryClubConfig(step),
    ).map((step) => step.name);
    expect(exempt).toEqual(["club-time-zone"]);
    for (const step of CLUB_CONFIG_STEPS) {
      expect(stepRequiresPrimaryClubConfig(step)).toBe(true);
    }
  });

  it("defineSelfHealStep binds currentValue + write into heal, and guards by default", async () => {
    const written: string[] = [];
    const step = defineSelfHealStep<string>({
      name: "demo",
      isPresent: async () => false,
      currentValue: () => "value-from-config",
      write: async (_db, value) => {
        written.push(value);
      },
    });

    await step.heal({} as SelfHealDb);

    expect(written).toEqual(["value-from-config"]);
    // A step that says nothing about the guard is guarded — the safe default,
    // and what keeps every pre-CT-1 step's behaviour byte-identical.
    expect(step.requiresPrimaryClubConfig).toBe(true);
    expect(stepRequiresPrimaryClubConfig(step)).toBe(true);
  });

  it("treats a hand-rolled step with no flag as guarded", () => {
    // The runner reads the flag through one helper precisely so that "absent"
    // and "true" can never be handled differently.
    const raw: RegisteredSelfHealStep = {
      name: "hand-rolled",
      isPresent: async () => true,
      heal: async () => {},
    };
    expect(stepRequiresPrimaryClubConfig(raw)).toBe(true);
  });
});

describe("facebookUrl self-heal step (C5 #1984)", () => {
  it("backfills the null column on a row the identity step already created (migration completion)", async () => {
    // The C1 identity step created this row BEFORE the facebookUrl column existed,
    // so its null facebookUrl is 'column never populated', not admin intent.
    const { rows, db } = makeIdentityDb({
      name: "Existing Club",
      shortName: "EC",
      hutLeaderLabel: "Warden",
      // no facebookUrl column value (predates the migration)
    });

    const summary = await runConfigSelfHeal({
      db,
      steps: [clubFacebookUrlSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(summary.healed).toBe(1);
    expect(rows.get("default")).toMatchObject({
      name: "Existing Club", // identity fields untouched
      facebookUrl: CONFIG_FACEBOOK_URL, // column backfilled from config
    });
  });

  it("never overwrites an admin-set facebookUrl", async () => {
    const { rows, db } = makeIdentityDb({
      name: "Existing Club",
      facebookUrl: "https://facebook.com/admin-choice",
    });

    const summary = await runConfigSelfHeal({
      db,
      steps: [clubFacebookUrlSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(summary.healed).toBe(0);
    expect(summary.alreadyPresent).toBe(1);
    expect(rows.get("default")).toMatchObject({
      facebookUrl: "https://facebook.com/admin-choice",
    });
    // Neither the create-if-absent upsert nor the null-scoped backfill fired.
    expect(
      (db as unknown as { clubIdentitySettings: { updateMany: ReturnType<typeof vi.fn> } })
        .clubIdentitySettings.updateMany,
    ).not.toHaveBeenCalled();
  });

  it("produces the same final row regardless of step order (order-independent)", async () => {
    const forward = makeIdentityDb();
    await runConfigSelfHeal({
      db: forward.db,
      steps: [clubIdentitySelfHealStep, clubFacebookUrlSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    const reversed = makeIdentityDb();
    await runConfigSelfHeal({
      db: reversed.db,
      steps: [clubFacebookUrlSelfHealStep, clubIdentitySelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    const expected = {
      id: "default",
      name: clubConfig.name,
      shortName: clubConfig.shortName ?? null,
      hutLeaderLabel: clubConfig.hutLeaderLabel ?? null,
      facebookUrl: CONFIG_FACEBOOK_URL,
    };
    expect(forward.rows.get("default")).toMatchObject(expected);
    expect(reversed.rows.get("default")).toMatchObject(expected);
  });

  it("does not clobber a facebookUrl written between its presence read and its backfill (mid-race)", async () => {
    // The row exists with a NULL column, so isPresent proceeds to write. A
    // concurrent admin edit / booter then sets the column in the window AFTER the
    // presence read but BEFORE the null-scoped backfill — modelled by mutating the
    // row inside the create-if-absent upsert, which runs first in the step's write
    // (immediately before updateMany). The atomic `where: { facebookUrl: null }`
    // predicate must then match nothing, so the raced value survives.
    const { rows, db } = makeIdentityDb({
      name: "Existing Club",
      facebookUrl: null,
    });
    const RACED_VALUE = "https://facebook.com/won-the-race";
    const settings = db as unknown as {
      clubIdentitySettings: {
        upsert: ReturnType<typeof vi.fn>;
        updateMany: ReturnType<typeof vi.fn>;
      };
    };
    const originalUpsert =
      settings.clubIdentitySettings.upsert.getMockImplementation()! as (
        args: unknown,
      ) => Promise<unknown>;
    settings.clubIdentitySettings.upsert.mockImplementation(
      async (args: unknown) => {
        // A concurrent writer lands the admin value inside the race window.
        rows.set("default", { ...rows.get("default"), facebookUrl: RACED_VALUE });
        return originalUpsert(args);
      },
    );

    const summary = await runConfigSelfHeal({
      db,
      steps: [clubFacebookUrlSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    // The step believed it wrote (its presence read saw null), but the null-scoped
    // backfill matched no row (count: 0), so the raced value is NOT overwritten.
    expect(summary.failed).toBe(0);
    expect(rows.get("default")).toMatchObject({ facebookUrl: RACED_VALUE });
    await expect(
      settings.clubIdentitySettings.updateMany.mock.results[0]?.value,
    ).resolves.toMatchObject({ count: 0 });
  });

  it("no-ops (present, zero writes) when the effective config has no facebook link", async () => {
    // The step must be inert when config/club.json carries no socialLinks.facebook
    // — there is nothing to backfill. Drive it against a fresh module instance whose
    // clubConfig has an empty socialLinks (the shared test config DOES set a link).
    vi.resetModules();
    vi.doMock("@/config/club", () => ({
      clubConfig: {
        name: "No Social Club",
        shortName: null,
        hutLeaderLabel: null,
        socialLinks: {},
        // The fresh module import transitively initialises lodge-capacity.ts,
        // whose module-level bed total reduces over `beds`.
        beds: [],
      },
      clubConfigSource: "primary",
    }));
    try {
      const { clubFacebookUrlSelfHealStep: step, runConfigSelfHeal: run } =
        await import("@/lib/config-self-heal");
      const { rows, db } = makeIdentityDb(); // cold DB

      const summary = await run({
        db,
        steps: [step],
        log: silentLog,
        provenance: "primary",
      });

      // Present/no-op: isPresent short-circuits on the null config value before any
      // DB access, so nothing is read or written.
      expect(summary.healed).toBe(0);
      expect(summary.alreadyPresent).toBe(1);
      expect(rows.size).toBe(0);
      const settings = db as unknown as {
        clubIdentitySettings: {
          findUnique: ReturnType<typeof vi.fn>;
          upsert: ReturnType<typeof vi.fn>;
          updateMany: ReturnType<typeof vi.fn>;
        };
      };
      expect(settings.clubIdentitySettings.findUnique).not.toHaveBeenCalled();
      expect(settings.clubIdentitySettings.upsert).not.toHaveBeenCalled();
      expect(settings.clubIdentitySettings.updateMany).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("@/config/club");
      vi.resetModules();
    }
  });
});

/**
 * A stateful in-memory fake of the `ClubTimeSettings` singleton delegate, with
 * the same real create-or-update semantics as `makeIdentityDb` above:
 * `upsert` creates when the row is absent and otherwise MERGES the `update`
 * object — which is `{}` for a create-if-absent step, so an existing row must
 * come out untouched. Modelling it this way rather than asserting on the
 * arguments is what lets the never-overwrite test below drive the write against
 * an existing row and check the ROW, not the call.
 */
function makeClubTimeDb(seedRow?: Record<string, unknown>) {
  const rows = new Map<string, Record<string, unknown>>();
  if (seedRow) rows.set("default", { id: "default", ...seedRow });

  const db = {
    clubTimeSettings: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return rows.get(where.id) ?? null;
      }),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { id: string };
          create: Record<string, unknown>;
          update?: Record<string, unknown>;
        }) => {
          const existing = rows.get(where.id);
          if (existing) {
            const merged = { ...existing, ...(update ?? {}) };
            rows.set(where.id, merged);
            return merged;
          }
          rows.set(where.id, { ...create });
          return rows.get(where.id);
        },
      ),
    },
  };

  return { rows, db: db as unknown as SelfHealDb };
}

/**
 * Every delegate the WHOLE default registry reaches, so a run over
 * `SELF_HEAL_STEPS` can be asserted on both halves at once: which steps touched
 * the database and which did not.
 */
function makeWholeRegistryDb() {
  const identity = makeIdentityDb();
  const clubTime = makeClubTimeDb();
  const lodgeRows = new Map<string, Record<string, unknown>>();

  const ageTierSetting = {
    findFirst: vi.fn(async () => null),
    upsert: vi.fn(async () => ({ tier: "ADULT" })),
  };
  const lodgeSettings = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      return lodgeRows.get(where.id) ?? null;
    }),
    upsert: vi.fn(async () => ({ id: "default" })),
    updateMany: vi.fn(async () => ({ count: 0 })),
  };

  const identityDelegate = (
    identity.db as unknown as {
      clubIdentitySettings: {
        findUnique: ReturnType<typeof vi.fn>;
        upsert: ReturnType<typeof vi.fn>;
        updateMany: ReturnType<typeof vi.fn>;
      };
    }
  ).clubIdentitySettings;
  const clubTimeDelegate = (
    clubTime.db as unknown as {
      clubTimeSettings: {
        findUnique: ReturnType<typeof vi.fn>;
        upsert: ReturnType<typeof vi.fn>;
      };
    }
  ).clubTimeSettings;

  const db = {
    clubIdentitySettings: identityDelegate,
    clubTimeSettings: clubTimeDelegate,
    ageTierSetting,
    lodgeSettings,
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };

  return {
    clubTimeRows: clubTime.rows,
    identityRows: identity.rows,
    identity: identityDelegate,
    clubTime: clubTimeDelegate,
    ageTierSetting,
    lodgeSettings,
    db: db as unknown as SelfHealDb,
  };
}

/**
 * The club-timezone backfill (CT-1, #2989) — the ONLY thing standing between an
 * existing deployment and a silent change of civil time on upgrade.
 *
 * A production upgrade runs `prisma migrate deploy` and nothing else: the seed
 * does not run, and SQL cannot read `process.env.TZ`. So this step is the whole
 * of the upgrade path, and the two properties that matter are that it copies the
 * environment's zone when nothing is stored, and that it can NEVER overwrite a
 * zone that already is.
 *
 * `process.env.TZ` is restored by assignment, never by deleting it (#2485).
 */
describe("clubTimeZoneSelfHealStep — the upgrade keeps the zone already in use (CT-1, #2989)", () => {
  const hostTimeZone = captureHostTimeZone();
  const originalNextPublicTz = process.env.NEXT_PUBLIC_TZ;

  beforeEach(() => {
    // The step's own logging is asserted below, so each case starts clean.
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
  });

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
      // Assign before deleting: only an assignment invalidates Node's cached
      // zone (#2485). `hostTimeZone.restore()` puts the original back the same
      // way.
      process.env.TZ = CLUB_TIME_ZONE_FALLBACK;
      delete process.env.TZ;
    } else {
      process.env.TZ = zone;
    }
    // NEXT_PUBLIC_TZ is the second half of the seed's precedence; clear it so
    // `TZ` is unambiguously what the environment says, on CI as well as here.
    delete process.env.NEXT_PUBLIC_TZ;
  }

  it("backfills the environment's zone into an absent row", async () => {
    pinEnvironmentZone("Australia/Sydney");
    const { rows, db } = makeClubTimeDb();

    const summary = await runConfigSelfHeal({
      db,
      steps: [clubTimeZoneSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(summary.healed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.results[0]).toMatchObject({
      name: "club-time-zone",
      outcome: "healed",
    });
    expect(rows.get("default")).toEqual({
      id: "default",
      timeZone: "Australia/Sydney",
      // A boot has no actor.
      updatedByMemberId: null,
    });
  });

  it("reads the environment at heal time, not at import", async () => {
    // If the seed were captured in a module constant, every boot of a
    // long-running image would persist whatever zone the FIRST import saw.
    pinEnvironmentZone("Europe/London");
    const london = makeClubTimeDb();
    await runConfigSelfHeal({
      db: london.db,
      steps: [clubTimeZoneSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    pinEnvironmentZone("Asia/Tokyo");
    const tokyo = makeClubTimeDb();
    await runConfigSelfHeal({
      db: tokyo.db,
      steps: [clubTimeZoneSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(london.rows.get("default")).toMatchObject({
      timeZone: "Europe/London",
    });
    expect(tokyo.rows.get("default")).toMatchObject({ timeZone: "Asia/Tokyo" });
  });

  it("persists the documented default when the environment is not set at all", async () => {
    // The "truly unset legacy install" the issue's fallback exists for. A NOT
    // NULL VarChar(64) column must still end up holding a real zone.
    pinEnvironmentZone(null);
    const { rows, db } = makeClubTimeDb();

    const summary = await runConfigSelfHeal({
      db,
      steps: [clubTimeZoneSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(summary.healed).toBe(1);
    expect(rows.get("default")).toMatchObject({
      timeZone: CLUB_TIME_ZONE_FALLBACK,
    });
    // Nothing to warn about: an unset environment is a normal fresh install.
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it.each([
    // The 36 aliases that resolve to a real location. `GB` is the common one on
    // a Debian host; `NZ-CHAT` is the one that would move a club by 45 minutes.
    ["GB", "Europe/London"],
    ["NZ-CHAT", "Pacific/Chatham"],
    ["EST5EDT", "America/New_York"],
  ])(
    "records the place TZ=%s actually names (%s) rather than the New Zealand default",
    async (raw, expected) => {
      // THE FINDING. Before this, the backfill ran the operator-input validator
      // over a value whose only job was to be preserved, so all three of these
      // were refused and `Pacific/Auckland` was written instead — once, silently,
      // never revisited, with /admin/setup then reporting the step COMPLETE while
      // naming a zone the club had never been in.
      pinEnvironmentZone(raw);
      const { rows, db } = makeClubTimeDb();

      const summary = await runConfigSelfHeal({
        db,
        steps: [clubTimeZoneSelfHealStep],
        log: silentLog,
        provenance: "primary",
      });

      expect(summary.healed).toBe(1);
      expect(rows.get("default")).toEqual({
        id: "default",
        timeZone: expected,
        updatedByMemberId: null,
      });
      expect(rows.get("default")).not.toMatchObject({
        timeZone: CLUB_TIME_ZONE_FALLBACK,
      });
    },
  );

  it("says in the deploy log which place it read out of the environment", async () => {
    // This is the only self-heal step that can substitute a different value for
    // its source, so the interpretation has to be visible to whoever reads the
    // boot log.
    pinEnvironmentZone("GB");
    const { db } = makeClubTimeDb();

    await runConfigSelfHeal({
      db,
      steps: [clubTimeZoneSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        step: "club-time-zone",
        environmentTimeZone: "GB",
        clubTimeZone: "Europe/London",
      }),
      expect.stringContaining("Europe/London"),
    );
  });

  it("logs nothing extra when the environment already names the zone canonically", async () => {
    pinEnvironmentZone("Australia/Sydney");
    const { db } = makeClubTimeDb();

    await runConfigSelfHeal({
      db,
      steps: [clubTimeZoneSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(mockLogger.info).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it.each(["UTC", "Etc/GMT-12", "SystemV/EST5", "NZT"])(
    "records the default when TZ=%s names no place, and warns that it did",
    async (raw) => {
      // Owner decision, 23 Aug 2026 (#2989). There is no place whose civil time
      // is UTC, so nothing could be preserved — but recording nothing left the
      // setting empty and blocked setup, so the documented default is written
      // instead. What must NOT happen is that it is written quietly: this club
      // may just have been moved up to thirteen hours, and from CT-2 onward the
      // recorded value drives every displayed time.
      pinEnvironmentZone(raw);
      const { rows, db } = makeClubTimeDb();

      const summary = await runConfigSelfHeal({
        db,
        steps: [clubTimeZoneSelfHealStep],
        log: silentLog,
        provenance: "primary",
      });

      expect(rows.get("default")).toEqual({
        id: "default",
        timeZone: CLUB_TIME_ZONE_FALLBACK,
        updatedByMemberId: null,
      });
      expect(summary.healed).toBe(1);
      expect(summary.failed).toBe(0);
      expect(summary.results[0]).toMatchObject({
        name: "club-time-zone",
        outcome: "healed",
      });
      // The warning names BOTH the value that could not be used and the value
      // written in its place — either alone leaves the reader unable to tell
      // what their site is now doing.
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          step: "club-time-zone",
          environmentTimeZone: raw,
          clubTimeZone: CLUB_TIME_ZONE_FALLBACK,
        }),
        expect.stringContaining(raw),
      );
      const message = String(mockLogger.warn.mock.calls[0]?.[1]);
      expect(message).toContain(CLUB_TIME_ZONE_FALLBACK);
      expect(message).toMatch(/by default/i);
      expect(message).toContain("/admin/club-time");
    },
  );

  it("does NOT warn when the environment names a place, however oddly it spells it", async () => {
    // The premise for the assertion above: the warning is about DEFAULTING, not
    // about the environment being unusual. Without this leg a reader could not
    // tell a real discriminator from a step that warns on every boot it writes.
    pinEnvironmentZone("GB");
    const { rows, db } = makeClubTimeDb();

    await runConfigSelfHeal({
      db,
      steps: [clubTimeZoneSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(rows.get("default")).toMatchObject({ timeZone: "Europe/London" });
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("does NOT warn a club that has already chosen its timezone, whatever TZ says", async () => {
    // The presence check runs FIRST and answers from the row alone, so the
    // defaulting warning can only ever mean "this value was just invented".
    // A configured club seeing it on every boot would be both alarming and
    // untrue.
    pinEnvironmentZone("UTC");
    const { rows, db } = makeClubTimeDb({ timeZone: "Australia/Sydney" });

    const summary = await runConfigSelfHeal({
      db,
      steps: [clubTimeZoneSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(summary.alreadyPresent).toBe(1);
    expect(rows.get("default")).toMatchObject({ timeZone: "Australia/Sydney" });
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it("leaves an existing row alone whatever the environment says", async () => {
    // One assertion over every environment shape: preserved, unusable, unset.
    for (const raw of ["GB", "UTC", "Pacific/Auckland", null]) {
      pinEnvironmentZone(raw);
      const { rows, db } = makeClubTimeDb({
        timeZone: "Australia/Sydney",
        updatedByMemberId: "member_1",
      });

      await runConfigSelfHeal({
        db,
        steps: [clubTimeZoneSelfHealStep],
        log: silentLog,
        provenance: "primary",
      });

      expect(rows.get("default")).toMatchObject({
        timeZone: "Australia/Sydney",
        updatedByMemberId: "member_1",
      });
    }
  });

  it("records the default when the write is forced under an unusable TZ", async () => {
    // Driving `heal` directly bypasses the presence check, so this is the write
    // path on its own: it records the documented default rather than nothing,
    // which is the decision, and it never leaves a NOT NULL column unwritten.
    pinEnvironmentZone("UTC");
    const { rows, db } = makeClubTimeDb();

    await clubTimeZoneSelfHealStep.heal(db);

    expect(rows.get("default")).toMatchObject({
      timeZone: CLUB_TIME_ZONE_FALLBACK,
    });
  });

  it("still writes nothing if a future refactor hands the write an empty value", async () => {
    // Belt and braces for the NOT NULL column. `currentValue` cannot produce
    // this today — every branch returns a validated zone — so the guard is
    // exercised directly rather than left as an untested claim.
    const { rows, db } = makeClubTimeDb();

    await clubTimeZoneSelfHealStepDefinition.write(db, "");

    expect(rows.size).toBe(0);
  });

  it("canonicalises a lower-case environment value before storing it", async () => {
    pinEnvironmentZone("australia/sydney");
    const { rows, db } = makeClubTimeDb();

    await runConfigSelfHeal({
      db,
      steps: [clubTimeZoneSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(rows.get("default")).toMatchObject({ timeZone: "Australia/Sydney" });
  });

  it("NEVER overwrites an existing row — a Sydney club survives a Pacific/Auckland boot", async () => {
    // The single most important property in this file. The club chose Sydney;
    // the container says New Zealand; the club stays in Sydney, for ever, on
    // every boot.
    pinEnvironmentZone("Pacific/Auckland");
    const { rows, db } = makeClubTimeDb({ timeZone: "Australia/Sydney" });

    const summary = await runConfigSelfHeal({
      db,
      steps: [clubTimeZoneSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(summary.healed).toBe(0);
    expect(summary.alreadyPresent).toBe(1);
    expect(rows.get("default")).toMatchObject({ timeZone: "Australia/Sydney" });
    expect(
      (db as unknown as { clubTimeSettings: { upsert: ReturnType<typeof vi.fn> } })
        .clubTimeSettings.upsert,
    ).not.toHaveBeenCalled();
  });

  it("still cannot overwrite when the write itself is forced against an existing row", async () => {
    // Belt and braces: the presence check is one guard, `update: {}` is the
    // other. Driving `heal` directly bypasses the first, so this proves the
    // write on its own is incapable of changing an existing row — the property
    // that survives a future refactor of the presence check.
    pinEnvironmentZone("Pacific/Auckland");
    const { rows, db } = makeClubTimeDb({
      timeZone: "Australia/Sydney",
      updatedByMemberId: "member_1",
    });

    await clubTimeZoneSelfHealStep.heal(db);

    expect(rows.get("default")).toMatchObject({
      timeZone: "Australia/Sydney",
      updatedByMemberId: "member_1",
    });
  });

  it("is idempotent: a second boot is already-present", async () => {
    pinEnvironmentZone("Australia/Sydney");
    const { rows, db } = makeClubTimeDb();

    const first = await runConfigSelfHeal({
      db,
      steps: [clubTimeZoneSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });
    const second = await runConfigSelfHeal({
      db,
      steps: [clubTimeZoneSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(first.results[0].outcome).toBe("healed");
    expect(second.results[0].outcome).toBe("already-present");
    expect(second.failed).toBe(0);
    expect(rows.get("default")).toMatchObject({ timeZone: "Australia/Sydney" });
  });

  it("treats a raced blue/green insert (P2002) as already-present, not failed", async () => {
    // Both slots boot at once, both see no row, one inserts first.
    pinEnvironmentZone("Australia/Sydney");
    const db = {
      clubTimeSettings: {
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => {
          throw Object.assign(new Error("Unique constraint failed"), {
            code: "P2002",
          });
        }),
      },
    } as unknown as SelfHealDb;

    const summary = await runConfigSelfHeal({
      db,
      steps: [clubTimeZoneSelfHealStep],
      log: silentLog,
      provenance: "primary",
    });

    expect(summary.failed).toBe(0);
    expect(summary.healed).toBe(0);
    expect(summary.alreadyPresent).toBe(1);
    expect(summary.results[0]).toMatchObject({
      name: "club-time-zone",
      outcome: "already-present",
    });
  });

  it.each(["safe-default", "example"] as const)(
    "runs on a %s config provenance while every config/club.json step does NOT",
    async (provenance) => {
      // BOTH halves, in one assertion set, because either half alone is
      // misleading. The timezone step must run — its value comes from the
      // environment, and since #1987 an absent config/club.json is normal for a
      // DB-first install, so gating it would strand exactly those installs on
      // the generic default for ever. The four club.json steps must NOT run,
      // because freezing "Example Mountain Club" into a DB-first row is the
      // outage class epic #1943 exists to prevent.
      pinEnvironmentZone("Australia/Sydney");
      const harness = makeWholeRegistryDb();
      const log = { info: vi.fn(), warn: vi.fn() };

      const summary = await runConfigSelfHeal({
        db: harness.db,
        log,
        provenance,
      });

      // Half one: the environment-sourced step ran and wrote.
      expect(summary.results).toEqual([
        { name: "club-time-zone", outcome: "healed" },
      ]);
      expect(summary.healed).toBe(1);
      expect(harness.clubTimeRows.get("default")).toMatchObject({
        timeZone: "Australia/Sydney",
      });

      // Half two: nothing from config/club.json was read OR written — not even a
      // presence probe.
      expect(summary.skipped).toBe(true);
      expect(summary.provenance).toBe(provenance);
      expect(harness.identityRows.size).toBe(0);
      expect(harness.identity.findUnique).not.toHaveBeenCalled();
      expect(harness.identity.upsert).not.toHaveBeenCalled();
      expect(harness.ageTierSetting.findFirst).not.toHaveBeenCalled();
      expect(harness.ageTierSetting.upsert).not.toHaveBeenCalled();
      expect(harness.lodgeSettings.findUnique).not.toHaveBeenCalled();
      expect(harness.lodgeSettings.upsert).not.toHaveBeenCalled();

      // And the warning says which steps were skipped and which still ran, so a
      // deploy log cannot be read as "nothing happened".
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn.mock.calls[0][0]).toMatchObject({
        scope: "config-self-heal",
        provenance,
        ranSteps: ["club-time-zone"],
      });
      const message = String(log.warn.mock.calls[0][1]);
      expect(message).toMatch(/self-heal skipped/i);
      expect(message).toContain("club-identity-settings");
      expect(message).toContain("club-time-zone");
    },
  );

  it("runs the whole registry on a primary config, timezone step included", async () => {
    // The control for the test above: on a healthy primary boot every step gets
    // its turn, so the partial-run branch is not quietly the only branch.
    pinEnvironmentZone("Australia/Sydney");
    const harness = makeWholeRegistryDb();

    const summary = await runConfigSelfHeal({
      db: harness.db,
      log: silentLog,
      provenance: "primary",
    });

    expect(summary.skipped).toBe(false);
    expect(summary.results.map((result) => result.name)).toEqual(
      SELF_HEAL_STEPS.map((step) => step.name),
    );
    expect(harness.clubTimeRows.get("default")).toMatchObject({
      timeZone: "Australia/Sydney",
    });
    expect(harness.identity.findUnique).toHaveBeenCalled();
  });
});
