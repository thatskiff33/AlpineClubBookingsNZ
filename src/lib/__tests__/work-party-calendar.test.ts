import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #5148: when a work party's calendar entries are written, and from what.
 * The row writer (`replaceWorkPartyCalendarEvents`) is mocked; its own test is
 * `work-party-calendar-service.test.ts`.
 */
const h = vi.hoisted(() => {
  const order: string[] = [];
  const tx = { workPartyEvent: { findUnique: vi.fn() } };
  return {
    order,
    tx,
    replace: vi.fn<(...args: unknown[]) => Promise<number>>(async () => 3),
    replaceInTx: vi.fn<(...args: unknown[]) => Promise<number>>(async () => {
      order.push("replace");
      return 3;
    }),
    lock: vi.fn(async () => {
      order.push("lock");
    }),
    update: vi.fn(async () => {
      order.push("update");
      return { id: "wp-1", name: "Spring Working Bee" };
    }),
    transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    modules: { eventsCalendar: true },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/calendar-work-party-entries", () => ({
  lockWorkPartyCalendar: h.lock,
  replaceWorkPartyCalendarEvents: h.replace,
  replaceWorkPartyCalendarEventsInTransaction: h.replaceInTx,
}));
vi.mock("@/lib/work-party", () => ({
  updateWorkPartyEventAndPromo: h.update,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: h.transaction },
}));
vi.mock("@/lib/club-time/server", () => ({
  clubTimeZone: vi.fn(async () => "Pacific/Auckland"),
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: vi.fn(async () => h.modules),
}));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn() } }));

import {
  addWorkPartyToCalendar,
  syncCreatedWorkPartyCalendar,
  updateWorkPartyWithCalendar,
  WORK_PARTY_CALENDAR_SYNC_FAILED,
  workPartyCalendarDays,
  workPartyCalendarEntry,
} from "@/lib/work-party-calendar";

const workParty = {
  name: "Spring Working Bee",
  description: "Bring gloves",
  // Date-only columns: UTC midnight encodings of the first and LAST night.
  startDate: new Date("2026-10-30T00:00:00.000Z"),
  endDate: new Date("2026-11-02T00:00:00.000Z"),
  lodge: { name: "Main Lodge" },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  h.modules.eventsCalendar = true;
  h.tx.workPartyEvent.findUnique.mockResolvedValue(workParty);
});

describe("workPartyCalendarDays", () => {
  it("lists every night of the inclusive window, across a month boundary", () => {
    expect(workPartyCalendarDays(workParty)).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
  });

  it("is one day for a one-night work party", () => {
    expect(
      workPartyCalendarDays({
        startDate: workParty.startDate,
        endDate: workParty.startDate,
      }),
    ).toEqual(["2026-10-30"]);
  });
});

describe("workPartyCalendarEntry", () => {
  it("titles the entry, uses the lodge as location and the description as details", () => {
    expect(workPartyCalendarEntry(workParty)).toMatchObject({
      title: "Work party: Spring Working Bee",
      location: "Main Lodge",
      details: "Bring gloves",
    });
  });

  it("has no location for a club-wide work party", () => {
    expect(workPartyCalendarEntry({ ...workParty, lodge: null }).location).toBeNull();
  });
});

/** Run the resolver the writer was handed, as the writer would inside its tx. */
async function resolvedEntry(callIndex = 0) {
  const resolve = (h.replace.mock.calls[callIndex] as unknown[])[1] as (
    tx: unknown,
  ) => Promise<unknown>;
  return resolve(h.tx);
}

describe("syncCreatedWorkPartyCalendar", () => {
  it("adds the entries, built from the work party read inside the writer", async () => {
    await expect(syncCreatedWorkPartyCalendar("wp-1", "admin-1")).resolves.toBeNull();
    expect(h.replace).toHaveBeenCalledWith("wp-1", expect.any(Function), "admin-1");
    expect(h.tx.workPartyEvent.findUnique).not.toHaveBeenCalled();
    await expect(resolvedEntry()).resolves.toMatchObject({
      title: "Work party: Spring Working Bee",
      location: "Main Lodge",
      days: ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"],
    });
    expect(h.tx.workPartyEvent.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "wp-1" } }),
    );
  });

  it("adds nothing when the Events Calendar is off", async () => {
    h.modules.eventsCalendar = false;
    await expect(syncCreatedWorkPartyCalendar("wp-1", "admin-1")).resolves.toBeNull();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("reports a calendar failure instead of throwing", async () => {
    h.replace.mockRejectedValueOnce(new Error("db down"));
    await expect(syncCreatedWorkPartyCalendar("wp-1", "admin-1")).resolves.toBe(
      WORK_PARTY_CALENDAR_SYNC_FAILED,
    );
  });
});

describe("updateWorkPartyWithCalendar (the edit and its entries save in one transaction)", () => {
  const input = {
    name: "Spring Working Bee",
    description: "Bring gloves",
    startDate: workParty.startDate,
    endDate: workParty.endDate,
    discountPercent: 50,
    active: true,
    lodgeId: null,
  };

  /** Run the resolver the in-transaction writer was handed. */
  async function resolvedEditEntry() {
    const resolve = (h.replaceInTx.mock.calls[0] as unknown[])[2] as (
      tx: unknown,
    ) => Promise<unknown>;
    return resolve(h.tx);
  }

  it("locks, saves and rewrites the entries in one transaction, lock first", async () => {
    await expect(
      updateWorkPartyWithCalendar("wp-1", input, "admin-1"),
    ).resolves.toMatchObject({ id: "wp-1" });
    expect(h.transaction).toHaveBeenCalledTimes(1);
    expect(h.order).toEqual(["lock", "update", "replace"]);
    expect(h.lock).toHaveBeenCalledWith(h.tx, "wp-1");
    expect(h.update).toHaveBeenCalledWith(h.tx, "wp-1", input);
    expect(h.replaceInTx).toHaveBeenCalledWith(
      h.tx,
      "wp-1",
      expect.any(Function),
      "admin-1",
      "Pacific/Auckland",
      { onlyIfLinked: true },
    );
  });

  it("rewrites only a work party already on the calendar (no duplicate of a hand-typed one)", async () => {
    await updateWorkPartyWithCalendar("wp-1", input, "admin-1");
    expect(h.replace).not.toHaveBeenCalled();
    expect(h.replaceInTx.mock.calls[0]?.[5]).toEqual({ onlyIfLinked: true });
  });

  it("keeps linked entries in step even while the calendar module is off", async () => {
    h.modules.eventsCalendar = false;
    await updateWorkPartyWithCalendar("wp-1", input, "admin-1");
    expect(h.replaceInTx).toHaveBeenCalledTimes(1);
  });

  it("fails the save when the rewrite fails, so no stale entries survive a saved edit", async () => {
    h.replaceInTx.mockRejectedValueOnce(new Error("db down"));
    await expect(
      updateWorkPartyWithCalendar("wp-1", input, "admin-1"),
    ).rejects.toThrow("db down");
  });

  it("builds the entry from the work party as saved, read inside the transaction", async () => {
    await updateWorkPartyWithCalendar("wp-1", input, "admin-1");
    await expect(resolvedEditEntry()).resolves.toMatchObject({
      title: "Work party: Spring Working Bee",
      days: ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"],
    });
    h.tx.workPartyEvent.findUnique.mockResolvedValueOnce(null);
    await expect(resolvedEditEntry()).resolves.toBeNull();
  });
});

describe("addWorkPartyToCalendar", () => {
  it("add replaces the entries from the work party as it is now", async () => {
    await expect(addWorkPartyToCalendar("wp-1", "admin-1")).resolves.toBe(3);
    expect(h.replace).toHaveBeenCalledWith("wp-1", expect.any(Function), "admin-1");
  });
});
