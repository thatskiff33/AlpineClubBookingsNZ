/**
 * #3819: "Who can be hut leader for school bookings" is resolved and written
 * per lodge through the ONE serving-row rule (own row, else the legacy
 * "default" row when unlinked or linked to this lodge, else the code defaults),
 * and every path that creates or claims a lodge's row carries forward what that
 * lodge resolved to before — its capacity, soft cap and ticks.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };

const store = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  lodges: [] as string[],
}));

vi.mock("@/lib/prisma", () => {
  const copy = (row: Row | undefined) => (row ? { ...row } : null);
  const lodgeSettings = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => copy(store.rows.get(where.id))),
    findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.filter((id) => store.rows.has(id)).map((id) => ({ id })),
    ),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const next = { ...store.rows.get(where.id)!, ...data } as Row;
      store.rows.set(where.id, next);
      return { ...next };
    }),
    create: vi.fn(async ({ data }: { data: Row }) => {
      store.rows.set(data.id, { ...data });
      return { ...data };
    }),
    createMany: vi.fn(async ({ data }: { data: Row[] }) => {
      for (const row of data) if (!store.rows.has(row.id)) store.rows.set(row.id, { ...row });
      return { count: data.length };
    }),
    upsert: vi.fn(
      async ({ where, create, update }: { where: { id: string }; create: Row; update: Record<string, unknown> }) => {
        const existing = store.rows.get(where.id);
        const next = existing ? { ...existing, ...update } : { ...create };
        store.rows.set(where.id, next as Row);
        return { updatedAt: new Date(), schoolGroupSoftCap: null, ...next };
      },
    ),
  };
  const lodge = {
    findMany: vi.fn(async ({ where }: { where: { id: { not: string } } }) =>
      store.lodges.filter((id) => id !== where.id.not).map((id) => ({ id })),
    ),
  };
  const client: Record<string, unknown> = { lodgeSettings, lodge };
  client.$transaction = vi.fn(async (arg: unknown) =>
    typeof arg === "function" ? (arg as (tx: unknown) => unknown)(client) : Promise.all(arg as Promise<unknown>[]),
  );
  return { prisma: client };
});

import { prisma } from "@/lib/prisma";
import {
  loadLodgeCapacityOverride,
  loadSchoolGroupSoftCap,
  loadSchoolHutLeaderKinds,
  saveSchoolHutLeaderKinds,
  updateLodgeSettings,
  writeImportedLodgeCapacity,
  writeImportedSchoolHutLeaderKinds,
} from "@/lib/lodge-settings";
import { DEFAULT_SCHOOL_HUT_LEADER_KINDS } from "@/lib/school-hut-leader-kinds";

const reader = () => prisma as never;
const TEACHERS_ONLY = {
  teacherOnBooking: true,
  custodian: false,
  memberOnBooking: false,
  memberStayingSeparately: false,
};
/** An unlinked legacy row serving every lodge without an own row. */
const UNLINKED_LEGACY: Row = {
  id: "default",
  lodgeId: null,
  capacity: 30,
  schoolGroupSoftCap: 18,
  hutLeaderLookaheadDays: 14,
  schoolHutLeaderTeacherOnBooking: true,
  schoolHutLeaderCustodian: false,
  schoolHutLeaderMemberOnBooking: true,
  schoolHutLeaderMemberStayingSeparately: true,
};
const LEGACY_KINDS = {
  teacherOnBooking: true,
  custodian: false,
  memberOnBooking: true,
  memberStayingSeparately: true,
};

function save(lodgeId: string) {
  return saveSchoolHutLeaderKinds({ lodgeId, kinds: TEACHERS_ONLY, updatedByMemberId: "admin-1" });
}

/** Everything a lodge reads from its settings, through the real resolvers. */
async function resolved(lodgeId: string) {
  return {
    capacity: await loadLodgeCapacityOverride(reader(), lodgeId),
    softCap: await loadSchoolGroupSoftCap(reader(), lodgeId),
    kinds: await loadSchoolHutLeaderKinds(reader(), lodgeId),
  };
}

beforeEach(() => {
  store.rows.clear();
  store.lodges = ["lodge-1", "lodge-2", "lodge-3"];
});

describe("loadSchoolHutLeaderKinds resolves per lodge (#3819)", () => {
  it("reads the lodge's own row first", async () => {
    store.rows.set("lodge-2", { id: "lodge-2", lodgeId: "lodge-2", schoolHutLeaderTeacherOnBooking: true, schoolHutLeaderCustodian: false });
    store.rows.set("default", { ...UNLINKED_LEGACY, schoolHutLeaderTeacherOnBooking: false });
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

describe("saveSchoolHutLeaderKinds writes the row its reader resolves (#3819)", () => {
  it("edits a lodge's own row, and returns the value it replaced", async () => {
    store.rows.set("lodge-2", { id: "lodge-2", lodgeId: "lodge-2", capacity: 12 });
    store.rows.set("default", { ...UNLINKED_LEGACY });
    const { previous, saved } = await save("lodge-2");
    expect(previous).toEqual(DEFAULT_SCHOOL_HUT_LEADER_KINDS);
    expect(saved).toEqual(TEACHERS_ONLY);
    expect(store.rows.get("lodge-2")).toMatchObject({ capacity: 12, schoolHutLeaderTeacherOnBooking: true });
    expect(store.rows.get("default")).toEqual(UNLINKED_LEGACY);
  });

  it("edits the legacy row when it is linked to this lodge", async () => {
    store.rows.set("default", { ...UNLINKED_LEGACY, lodgeId: "lodge-2" });
    const { previous } = await save("lodge-2");
    expect(previous).toEqual(LEGACY_KINDS);
    expect(store.rows.get("default")).toMatchObject({ capacity: 30, schoolHutLeaderCustodian: false, schoolHutLeaderTeacherOnBooking: true });
    expect(store.rows.has("lodge-2")).toBe(false);
  });

  it("never claims an unlinked legacy row: the lodge gets its own, carrying what it was served", async () => {
    store.rows.set("default", { ...UNLINKED_LEGACY });
    await save("lodge-2");
    expect(store.rows.get("default")).toEqual(UNLINKED_LEGACY);
    expect(await resolved("lodge-2")).toEqual({ capacity: 30, softCap: 18, kinds: TEACHERS_ONLY });
    // Another lodge still reads the legacy row, unchanged.
    expect(await resolved("lodge-3")).toEqual({ capacity: 30, softCap: 18, kinds: LEGACY_KINDS });
  });

  it("gives a lodge served by no row its own, copying nothing from another lodge's legacy row", async () => {
    store.rows.set("default", { id: "default", lodgeId: "lodge-1", capacity: 30 });
    await save("lodge-2");
    expect(store.rows.get("lodge-2")).not.toHaveProperty("capacity");
    expect(store.rows.get("default")).toEqual({ id: "default", lodgeId: "lodge-1", capacity: 30 });
  });
});

describe("every path that creates or claims a lodge row carries forward what it resolved (#3819 review)", () => {
  it("a config import's capacity, giving a lodge its own row, keeps the ticks it was served", async () => {
    store.rows.set("default", { ...UNLINKED_LEGACY });
    await writeImportedLodgeCapacity(prisma as never, {
      lodgeId: "lodge-2",
      capacity: 40,
      updatedByMemberId: "admin-1",
      lodgeCreatedByThisImport: false,
    });
    expect(await resolved("lodge-2")).toEqual({ capacity: 40, softCap: 18, kinds: LEGACY_KINDS });
  });

  it("a config import's ticks, giving a lodge its own row, keep the capacity it was served", async () => {
    store.rows.set("default", { ...UNLINKED_LEGACY });
    await writeImportedSchoolHutLeaderKinds(prisma as never, {
      lodgeId: "lodge-2",
      kinds: TEACHERS_ONLY,
      updatedByMemberId: "admin-1",
    });
    expect(await resolved("lodge-2")).toEqual({ capacity: 30, softCap: 18, kinds: TEACHERS_ONLY });
  });

  it("claiming the unlinked legacy row for one lodge leaves every other lodge reading what it read", async () => {
    store.rows.set("default", { ...UNLINKED_LEGACY });
    store.rows.set("lodge-3", { id: "lodge-3", lodgeId: "lodge-3", capacity: 9 });
    const before = { two: await resolved("lodge-2"), three: await resolved("lodge-3") };

    await updateLodgeSettings({
      capacity: 50,
      hutLeaderLookaheadDays: 14,
      schoolGroupSoftCap: 25,
      updatedByMemberId: "admin-1",
      lodgeId: "lodge-1",
    });

    expect(store.rows.get("default")).toMatchObject({ lodgeId: "lodge-1", capacity: 50 });
    expect(await resolved("lodge-2")).toEqual(before.two);
    expect(await resolved("lodge-3")).toEqual(before.three);
    expect((await resolved("lodge-1")).kinds).toEqual(LEGACY_KINDS);
  });
});
