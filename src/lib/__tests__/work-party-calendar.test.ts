import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fork #118: when a work party's calendar entries are written, and from what.
 * The row writer (`replaceWorkPartyCalendarEvents`) is mocked; its own test is
 * `work-party-calendar-service.test.ts`.
 */
const h = vi.hoisted(() => ({
  replace: vi.fn<(...args: unknown[]) => Promise<number>>(async () => 3),
  modules: { eventsCalendar: true },
  tx: { workPartyEvent: { findUnique: vi.fn() } },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/calendar-work-party-entries", () => ({
  replaceWorkPartyCalendarEvents: h.replace,
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: vi.fn(async () => h.modules),
}));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn() } }));

import {
  addWorkPartyToCalendar,
  syncCreatedWorkPartyCalendar,
  syncUpdatedWorkPartyCalendar,
  WORK_PARTY_CALENDAR_SYNC_FAILED,
  WORK_PARTY_CALENDAR_UPDATE_FAILED,
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

describe("syncUpdatedWorkPartyCalendar", () => {
  it("regenerates only a work party already on the calendar (no duplicate of a hand-typed one)", async () => {
    await syncUpdatedWorkPartyCalendar("wp-1", "admin-1");
    expect(h.replace).toHaveBeenCalledWith("wp-1", expect.any(Function), "admin-1", {
      onlyIfLinked: true,
    });
  });

  it("keeps linked entries in step even while the calendar module is off", async () => {
    h.modules.eventsCalendar = false;
    await syncUpdatedWorkPartyCalendar("wp-1", "admin-1");
    expect(h.replace).toHaveBeenCalledTimes(1);
  });

  it("reports a failed update with its own advice", async () => {
    h.replace.mockRejectedValueOnce(new Error("db down"));
    await expect(syncUpdatedWorkPartyCalendar("wp-1", "admin-1")).resolves.toBe(
      WORK_PARTY_CALENDAR_UPDATE_FAILED,
    );
  });

  it("builds no entry for a work party deleted meanwhile", async () => {
    h.tx.workPartyEvent.findUnique.mockResolvedValueOnce(null);
    await syncUpdatedWorkPartyCalendar("wp-1", "admin-1");
    await expect(resolvedEntry()).resolves.toBeNull();
  });
});

describe("addWorkPartyToCalendar", () => {
  it("add replaces the entries from the work party as it is now", async () => {
    await expect(addWorkPartyToCalendar("wp-1", "admin-1")).resolves.toBe(3);
    expect(h.replace).toHaveBeenCalledWith("wp-1", expect.any(Function), "admin-1");
  });
});
