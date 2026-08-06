import { describe, expect, it, vi } from "vitest";
import {
  loadLodgeCapacityOverride,
  loadLodgeSettings,
  loadSchoolGroupSoftCap,
} from "@/lib/lodge-settings";
import { resolveAutoAllocationEnabled } from "@/lib/bed-allocation-lifecycle";

// Settings-singleton conversion (lodge-scoping contract, audited
// 2026-07-03): a lodge's settings row is keyed by its lodge id, the legacy
// "default" row keeps serving the lodge it was soft-linked to, and one
// lodge's values must never leak to another.

function settingsDb(rows: Record<string, Record<string, unknown>>) {
  return {
    lodgeSettings: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        (rows[where.id] as never) ?? null,
      ),
    },
  };
}

function bedSettingsDb(rows: Record<string, Record<string, unknown>>) {
  return {
    bedAllocationSettings: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        rows[where.id]
          ? ({
              id: where.id,
              allocationPriorityOrder: [
                "BOOKING_COHESION",
                "STAY_CONTINUITY",
                "REQUESTED_ROOM",
                "FAMILY_COHESION",
              ],
              ...rows[where.id],
            } as never)
          : null,
      ),
    },
  };
}

describe("loadLodgeCapacityOverride per-lodge resolution", () => {
  it("prefers the lodge's own settings row over the legacy row", async () => {
    const db = settingsDb({
      "lodge-b": { capacity: 20, lodgeId: "lodge-b" },
      default: { capacity: 30, lodgeId: "lodge-a" },
    });

    expect(await loadLodgeCapacityOverride(db as never, "lodge-b")).toBe(20);
  });

  it("keeps serving the soft-linked lodge from the legacy row", async () => {
    const db = settingsDb({
      default: { capacity: 30, lodgeId: "lodge-a" },
    });

    expect(await loadLodgeCapacityOverride(db as never, "lodge-a")).toBe(30);
  });

  it("never leaks another lodge's legacy override", async () => {
    const db = settingsDb({
      default: { capacity: 30, lodgeId: "lodge-a" },
    });

    expect(await loadLodgeCapacityOverride(db as never, "lodge-b")).toBeNull();
  });

  it("applies an unlinked legacy row to any lodge (pre-backfill tolerance)", async () => {
    const db = settingsDb({
      default: { capacity: 30, lodgeId: null },
    });

    expect(await loadLodgeCapacityOverride(db as never, "lodge-b")).toBe(30);
  });
});

describe("loadLodgeSettings lookahead stays club-wide", () => {
  it("returns the legacy row's lookahead with a per-lodge capacity", async () => {
    const db = settingsDb({
      "lodge-b": { capacity: 20, lodgeId: "lodge-b", hutLeaderLookaheadDays: 99 },
      default: { capacity: 30, lodgeId: "lodge-a", hutLeaderLookaheadDays: 21 },
    });

    const settings = await loadLodgeSettings(db as never, "lodge-b");
    expect(settings.capacity).toBe(20);
    // The club-wide knob comes from the legacy row, never the lodge row.
    expect(settings.hutLeaderLookaheadDays).toBe(21);
  });
});

describe("loadSchoolGroupSoftCap per-lodge resolution", () => {
  it("prefers the lodge's own soft cap", async () => {
    const db = settingsDb({
      "lodge-b": { capacity: null, lodgeId: "lodge-b", schoolGroupSoftCap: 40 },
      default: { capacity: null, lodgeId: "lodge-a", schoolGroupSoftCap: 25 },
    });
    expect(await loadSchoolGroupSoftCap(db as never, "lodge-b")).toBe(40);
  });

  it("falls back to the code default (25) when unset", async () => {
    const db = settingsDb({
      "lodge-b": { capacity: null, lodgeId: "lodge-b", schoolGroupSoftCap: null },
    });
    expect(await loadSchoolGroupSoftCap(db as never, "lodge-b")).toBe(25);
  });

  it("does not leak another lodge's legacy soft cap", async () => {
    const db = settingsDb({
      default: { capacity: null, lodgeId: "lodge-a", schoolGroupSoftCap: 40 },
    });
    // lodge-b has no row and the legacy row is lodge-a's: default 25.
    expect(await loadSchoolGroupSoftCap(db as never, "lodge-b")).toBe(25);
    // lodge-a keeps its soft-linked legacy value.
    expect(await loadSchoolGroupSoftCap(db as never, "lodge-a")).toBe(40);
  });
});

describe("resolveAutoAllocationEnabled per-lodge resolution", () => {
  it("prefers the lodge's own row", async () => {
    const db = bedSettingsDb({
      "lodge-b": { autoAllocationEnabled: false, lodgeId: "lodge-b" },
      default: { autoAllocationEnabled: true, lodgeId: "lodge-a" },
    });

    expect(await resolveAutoAllocationEnabled(db as never, "lodge-b")).toBe(false);
  });

  it("does not apply another lodge's legacy switch", async () => {
    const db = bedSettingsDb({
      default: { autoAllocationEnabled: false, lodgeId: "lodge-a" },
    });

    // lodge-b has no row and the legacy row belongs to lodge-a: default on.
    expect(await resolveAutoAllocationEnabled(db as never, "lodge-b")).toBe(true);
    // lodge-a keeps its soft-linked legacy value.
    expect(await resolveAutoAllocationEnabled(db as never, "lodge-a")).toBe(false);
  });

  it("defaults to enabled when no rows exist", async () => {
    expect(await resolveAutoAllocationEnabled(bedSettingsDb({}) as never, "lodge-b")).toBe(true);
  });
});
