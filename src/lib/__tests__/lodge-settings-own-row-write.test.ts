/**
 * #3407: a lodge is now born with its OWN settings row (`createNewLodgeSettings`),
 * and a later capacity edit must land on that row — the one
 * `loadLodgeCapacityOverride` reads first — whatever state the legacy "default"
 * row is in. Before #3407 `updateLodgeSettings` chose its target from the legacy
 * row alone, so with an unlinked or absent legacy row it wrote the legacy row
 * and the resolver went on reading the own row: the save "succeeded" and the
 * lodge's capacity did not move.
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
      // #3819: claiming an unlinked legacy row first gives the OTHER lodges it
      // serves their own rows; this club has no other lodge.
      lodge: { findMany: vi.fn(async () => []) },
      $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
    },
  };
});

import { prisma } from "@/lib/prisma";
import {
  createNewLodgeSettings,
  loadLodgeCapacityOverride,
  updateLodgeSettings,
} from "@/lib/lodge-settings";

const reader = () => prisma as never;

beforeEach(() => {
  store.rows.clear();
});

describe("updateLodgeSettings targets a lodge's own row once it has one (#3407)", () => {
  it.each([
    ["unlinked", { id: "default", capacity: 30, lodgeId: null, hutLeaderLookaheadDays: 14 }],
    ["absent", null],
  ])("with the legacy row %s, an edit moves the capacity the resolver reads", async (_label, legacy) => {
    if (legacy) store.rows.set("default", legacy as Row);
    await createNewLodgeSettings(prisma, {
      lodgeId: "lodge-b",
      capacity: 12,
      updatedByMemberId: "admin-1",
    });
    expect(await loadLodgeCapacityOverride(reader(), "lodge-b")).toBe(12);

    await updateLodgeSettings({
      capacity: 20,
      hutLeaderLookaheadDays: 14,
      updatedByMemberId: "admin-1",
      lodgeId: "lodge-b",
    });

    expect(await loadLodgeCapacityOverride(reader(), "lodge-b")).toBe(20);
    expect(store.rows.get("lodge-b")?.capacity).toBe(20);
    // The legacy row's capacity — which, unlinked, serves every lodge without
    // a row of its own — is left exactly as it was.
    expect(store.rows.get("default")?.capacity ?? null).toBe(
      legacy ? 30 : null,
    );
    // An unlinked legacy row is not claimed by the lodge being edited.
    expect(store.rows.get("default")?.lodgeId ?? null).toBeNull();
  });

  it("keeps the pre-#3407 behaviour for a lodge with no row of its own", async () => {
    store.rows.set("default", {
      id: "default",
      capacity: 30,
      lodgeId: null,
      hutLeaderLookaheadDays: 14,
    });

    await updateLodgeSettings({
      capacity: 25,
      hutLeaderLookaheadDays: 14,
      updatedByMemberId: "admin-1",
      lodgeId: "lodge-a",
    });

    // The unlinked legacy row is claimed by the lodge being edited, as before.
    expect(store.rows.get("default")).toMatchObject({
      capacity: 25,
      lodgeId: "lodge-a",
    });
    expect(store.rows.has("lodge-a")).toBe(false);
  });
});

describe("createNewLodgeSettings (#3407)", () => {
  it("writes the lodge's own row, never the legacy one", async () => {
    store.rows.set("default", { id: "default", capacity: 30, lodgeId: null });

    await createNewLodgeSettings(prisma, {
      lodgeId: "lodge-b",
      capacity: 12,
      updatedByMemberId: "admin-1",
    });

    expect(store.rows.get("lodge-b")).toEqual({
      id: "lodge-b",
      lodgeId: "lodge-b",
      capacity: 12,
      updatedByMemberId: "admin-1",
    });
    expect(store.rows.get("default")).toEqual({
      id: "default",
      capacity: 30,
      lodgeId: null,
    });
  });
});
