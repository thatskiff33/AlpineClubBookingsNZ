/**
 * The nightly prune's rule has two forms in `audit-prune-predicate.ts`: the
 * `where` PostgreSQL runs, and `pruneDeletesUnclassifiedAuditLog`, which the
 * older-entry expiry census (#5265) asks about rows that have no expiry yet.
 * This file runs both over every boundary and fails when either moves alone
 * (INV-SSOT-001). `audit-expiry-backfill.realdb.test.ts` proves the census's
 * count against the real prune on PostgreSQL.
 */
import { describe, expect, it, vi } from "vitest";
import { matchesWhere } from "@/lib/__tests__/support/prisma-where";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { getAuditRetentionExpiresAt } from "@/lib/audit";
import {
  buildAuditLogPruneWhere,
  pruneDeletesUnclassifiedAuditLog,
} from "@/lib/audit-prune-predicate";
import { getAuditLogRetentionCutoffs } from "@/lib/audit-retention";

const MS = 1;
const DAY = 86_400_000;

function clockAt(now: Date) {
  return { now, ...getAuditLogRetentionCutoffs(now) };
}

type Row = Parameters<typeof pruneDeletesUnclassifiedAuditLog>[0] & {
  retentionClass: string | null;
  archivedAt: Date | null;
};

function bothForms(row: Row, now: Date, archiveActive = false) {
  const clock = clockAt(now);
  return {
    where: matchesWhere(row, buildAuditLogPruneWhere(clock, { archiveActive })),
    pure: pruneDeletesUnclassifiedAuditLog(row, clock),
  };
}

const NOW = new Date("2026-07-01T00:00:00.000Z");
const CLOCK = clockAt(NOW);

function unclassified(overrides: Partial<Row> = {}): Row {
  return {
    retentionClass: null,
    archivedAt: null,
    severity: null,
    createdAt: new Date("2015-01-01T00:00:00.000Z"),
    expiresAt: new Date("2022-01-01T00:00:00.000Z"),
    incidentPreserved: false,
    ...overrides,
  };
}

describe("pruneDeletesUnclassifiedAuditLog", () => {
  it("deletes on an expiry strictly before the prune's clock, not at it", () => {
    const at = (expiresAt: Date | null) =>
      pruneDeletesUnclassifiedAuditLog(unclassified({ expiresAt }), CLOCK);

    expect(at(new Date(NOW.getTime() - MS))).toBe(true);
    expect(at(new Date(NOW))).toBe(false);
    expect(at(new Date(NOW.getTime() + MS))).toBe(false);
    expect(at(null)).toBe(false);
  });

  it("holds an incident-preserved row until it is recorded strictly before the ten-year cut-off", () => {
    const at = (createdAt: Date, incidentPreserved = true) =>
      pruneDeletesUnclassifiedAuditLog(unclassified({ createdAt, incidentPreserved }), CLOCK);
    const floor = CLOCK.incidentPreserved;

    expect(floor.toISOString()).toBe("2016-07-01T00:00:00.000Z");
    expect(at(new Date(floor.getTime() - MS))).toBe(true);
    expect(at(new Date(floor))).toBe(false);
    expect(at(new Date(floor.getTime() + MS))).toBe(false);
    // The floor binds preserved rows only.
    expect(at(new Date(floor), false)).toBe(true);
  });

  it("holds a critical-severity row until it is recorded strictly before the seven-year cut-off", () => {
    const at = (createdAt: Date, severity: string | null = "critical") =>
      pruneDeletesUnclassifiedAuditLog(unclassified({ createdAt, severity }), CLOCK);
    const cutoff = CLOCK.criticalMain;

    expect(cutoff.toISOString()).toBe("2019-07-01T00:00:00.000Z");
    expect(at(new Date(cutoff.getTime() - MS))).toBe(true);
    expect(at(new Date(cutoff))).toBe(false);
    // Any other severity, or none, goes on its expiry alone (#3524).
    expect(at(new Date(cutoff), "warning")).toBe(true);
    expect(at(new Date(cutoff), null)).toBe(true);
  });

  it("keeps a critical-severity row one more night when the clock is 29 February", () => {
    // The writer's seven years rolls 29 Feb forward to 1 Mar; the prune's
    // cut-off clamps 29 Feb back to 28 Feb. On a 29 February clock a critical
    // row recorded late on 28 February seven years before has an expiry that
    // has passed, yet is still inside the cut-off.
    const now = new Date("2028-02-29T12:00:00.000Z");
    const createdAt = new Date("2021-02-28T18:00:00.000Z");
    const expiresAt = getAuditRetentionExpiresAt("critical", createdAt);
    const row = unclassified({ createdAt, expiresAt, severity: "critical" });

    expect(expiresAt < now).toBe(true);
    expect(bothForms(row, now)).toEqual({ where: false, pure: false });
    // The night after, it goes.
    expect(bothForms(row, new Date(now.getTime() + DAY))).toEqual({ where: true, pure: true });
    // The same row with no severity goes on its expiry.
    expect(bothForms({ ...row, severity: null }, now)).toEqual({ where: true, pure: true });
  });
});

describe("the two forms of the prune's unclassified rule", () => {
  // Every instant that can change an answer, one millisecond either side of it,
  // on an ordinary clock and on a leap-day one.
  const clocks = [NOW, new Date("2028-02-29T12:00:00.000Z")];
  const around = (instant: Date) => [-DAY, -MS, 0, MS, DAY].map((offset) => new Date(instant.getTime() + offset));

  it.each(clocks.map((now) => [now.toISOString(), now] as const))(
    "agree on every unclassified row at %s, with and without an archive",
    (_label, now) => {
      const clock = clockAt(now);
      const createdAts = [...around(clock.criticalMain), ...around(clock.incidentPreserved)];
      const expiresAts = [...around(now), null];
      // An unknown stored class reads as no class (#3940).
      const classes = [null, "legacy_unknown"];
      const severities = [null, "info", "warning", "critical"];
      let compared = 0;
      const deleted = new Set<boolean>();

      for (const retentionClass of classes) {
        for (const severity of severities) {
          for (const incidentPreserved of [false, true]) {
            for (const createdAt of createdAts) {
              for (const expiresAt of expiresAts) {
                const row = unclassified({ retentionClass, severity, incidentPreserved, createdAt, expiresAt });
                for (const archiveActive of [false, true]) {
                  const { where, pure } = bothForms(row, now, archiveActive);
                  expect(pure, JSON.stringify({ row, archiveActive })).toBe(where);
                  deleted.add(pure);
                  compared += 1;
                }
              }
            }
          }
        }
      }

      expect(compared).toBe(2 * 4 * 2 * 10 * 6 * 2);
      // Both answers occur, so agreement is not vacuous.
      expect([...deleted].sort()).toEqual([false, true]);
    },
  );

  it("agree on the writer's own seven-year expiry for rows recorded either side of each cut-off", () => {
    for (const now of clocks) {
      const clock = clockAt(now);
      for (const createdAt of [...around(clock.criticalMain), ...around(clock.incidentPreserved)]) {
        for (const severity of [null, "critical"]) {
          for (const incidentPreserved of [false, true]) {
            const row = unclassified({
              createdAt,
              expiresAt: getAuditRetentionExpiresAt("critical", createdAt),
              severity,
              incidentPreserved,
            });
            const { where, pure } = bothForms(row, now);
            expect(pure, JSON.stringify({ row, now })).toBe(where);
          }
        }
      }
    }
  });
});
