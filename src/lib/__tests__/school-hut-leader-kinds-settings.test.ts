/**
 * #3819: "Who can be hut leader for school bookings" is resolved and written
 * per lodge exactly like the soft cap: the lodge's own row, else the legacy
 * "default" row when it is unlinked or linked to this lodge, else the code
 * defaults — and a write never claims an unlinked legacy row, which goes on
 * serving every other lodge.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };

const store = vi.hoisted(() => ({ rows: new Map<string, Row>() }));

vi.mock("@/lib/prisma", () => {
  const lodgeSettings = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const row = store.rows.get(where.id);
      return row ? { ...row } : null;
    }),
    upsert: vi.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: { id: string };
        create: Row;
        update: Record<string, unknown>;
      }) => {
        const existing = store.rows.get(where.id);
        const next = existing ? { ...existing, ...update } : { ...create };
        store.rows.set(where.id, next as Row);
        return { updatedAt: new Date(), schoolGroupSoftCap: null, ...next };
      },
    ),
    create: vi.fn(async ({ data }: { data: Row }) => {
      store.rows.set(data.id, { ...data });
      return { id: data.id };
    }),
  };
  return {
    prisma: {
      lodgeSettings,
      $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
    },
  };
});

import { prisma } from "@/lib/prisma";
import {
  loadLodgeCapacityOverride,
  loadSchoolHutLeaderKinds,
  updateSchoolHutLeaderKinds,
} from "@/lib/lodge-settings";
import { DEFAULT_SCHOOL_HUT_LEADER_KINDS } from "@/lib/school-hut-leader-kinds";

const reader = () => prisma as never;
const TEACHERS_ONLY = {
  teacherOnBooking: true,
  custodian: false,
  memberOnBooking: false,
  memberStayingSeparately: false,
};

function save(lodgeId: string) {
  return updateSchoolHutLeaderKinds({ lodgeId, kinds: TEACHERS_ONLY, updatedByMemberId: "admin-1" });
}

beforeEach(() => {
  store.rows.clear();
});

describe("loadSchoolHutLeaderKinds resolves per lodge (#3819)", () => {
  it("reads the lodge's own row first", async () => {
    store.rows.set("lodge-2", { id: "lodge-2", lodgeId: "lodge-2", schoolHutLeaderTeacherOnBooking: true, schoolHutLeaderCustodian: false });
    store.rows.set("default", { id: "default", lodgeId: null, schoolHutLeaderTeacherOnBooking: false });
    expect(await loadSchoolHutLeaderKinds(reader(), "lodge-2")).toMatchObject({
      teacherOnBooking: true,
      custodian: false,
    });
  });

  it.each([
    ["unlinked", null],
    ["linked to this lodge", "lodge-2"],
  ])("falls back to the legacy row when it is %s", async (_label, link) => {
    store.rows.set("default", { id: "default", lodgeId: link, schoolHutLeaderTeacherOnBooking: true });
    expect((await loadSchoolHutLeaderKinds(reader(), "lodge-2")).teacherOnBooking).toBe(true);
  });

  it("never reads another lodge's legacy row, and defaults with no row at all", async () => {
    store.rows.set("default", { id: "default", lodgeId: "lodge-1", schoolHutLeaderTeacherOnBooking: true });
    expect(await loadSchoolHutLeaderKinds(reader(), "lodge-2")).toEqual(DEFAULT_SCHOOL_HUT_LEADER_KINDS);
    store.rows.clear();
    expect(await loadSchoolHutLeaderKinds(reader(), "lodge-2")).toEqual(DEFAULT_SCHOOL_HUT_LEADER_KINDS);
  });
});

describe("updateSchoolHutLeaderKinds writes the row its reader resolves (#3819)", () => {
  it("edits a lodge's own row", async () => {
    store.rows.set("lodge-2", { id: "lodge-2", lodgeId: "lodge-2", capacity: 12 });
    store.rows.set("default", { id: "default", lodgeId: null, capacity: 30 });
    expect(await save("lodge-2")).toEqual(TEACHERS_ONLY);
    expect(store.rows.get("lodge-2")).toMatchObject({ capacity: 12, schoolHutLeaderTeacherOnBooking: true });
    expect(store.rows.get("default")).not.toHaveProperty("schoolHutLeaderTeacherOnBooking");
  });

  it("edits the legacy row when it is linked to this lodge", async () => {
    store.rows.set("default", { id: "default", lodgeId: "lodge-2", capacity: 30 });
    await save("lodge-2");
    expect(store.rows.get("default")).toMatchObject({ capacity: 30, schoolHutLeaderCustodian: false });
    expect(store.rows.has("lodge-2")).toBe(false);
  });

  it("never claims an unlinked legacy row: the lodge gets its own, carrying the capacity it was served", async () => {
    store.rows.set("default", { id: "default", lodgeId: null, capacity: 30, schoolGroupSoftCap: 18 });
    await save("lodge-2");
    expect(store.rows.get("default")).toEqual({ id: "default", lodgeId: null, capacity: 30, schoolGroupSoftCap: 18 });
    expect(store.rows.get("lodge-2")).toMatchObject({
      lodgeId: "lodge-2",
      capacity: 30,
      schoolGroupSoftCap: 18,
      schoolHutLeaderTeacherOnBooking: true,
    });
    // Its capacity did not move, and another lodge still reads the legacy row.
    expect(await loadLodgeCapacityOverride(reader(), "lodge-2")).toBe(30);
    expect((await loadSchoolHutLeaderKinds(reader(), "lodge-3")).teacherOnBooking).toBe(false);
  });

  it("gives a lodge served by no row its own, copying nothing from another lodge's legacy row", async () => {
    store.rows.set("default", { id: "default", lodgeId: "lodge-1", capacity: 30 });
    await save("lodge-2");
    expect(store.rows.get("lodge-2")).not.toHaveProperty("capacity");
    expect(store.rows.get("default")).toEqual({ id: "default", lodgeId: "lodge-1", capacity: 30 });
  });
});
