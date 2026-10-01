import { beforeEach, describe, expect, it, vi } from "vitest";

/*
  #3407 review: setup readiness warns about EVERY active lodge that resolves as
  not set up for bookings, not only the default one.

  The snapshot half is driven through the real `getSetupDatabaseSnapshot` and
  the REAL resolver (`getLodgeCapacityStatus`), over a whole-client stand-in in
  which every other delegate answers with the empty shape its caller tolerates
  (the pattern `club-time-zone-backfill.test.ts` uses). Only the lodge list and
  each lodge's settings row are arranged, so a lodge is "not set up" here for
  exactly the reason it would be in production: no capacity and no beds.
*/
const { state, mockPrisma } = vi.hoisted(() => {
  const state = {
    lodges: [] as Array<{ id: string; name: string }>,
    capacities: {} as Record<string, number | null>,
    lodgeListFails: false,
  };
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
  const lodge = {
    findMany: async () => {
      if (state.lodgeListFails) throw new Error("lodge list unreadable");
      return state.lodges;
    },
    findFirst: async () => null,
    findUnique: async () => null,
  };
  const lodgeSettings = {
    findUnique: async (args: { where: { id: string } }) =>
      args.where.id in state.capacities
        ? { capacity: state.capacities[args.where.id], lodgeId: args.where.id }
        : null,
  };
  const mockPrisma = new Proxy(
    {},
    {
      get: (_target, model: string) =>
        model === "lodge"
          ? lodge
          : model === "lodgeSettings"
            ? lodgeSettings
            : emptyDelegate,
    },
  );
  return { state, mockPrisma };
});

vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
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

import { getSetupDatabaseSnapshot } from "@/lib/setup-readiness-db";

beforeEach(() => {
  state.lodges = [];
  state.capacities = {};
  state.lodgeListFails = false;
});

describe("getSetupDatabaseSnapshot — every active lodge that cannot take a booking (#3407)", () => {
  it("names each lodge that resolves as not set up, and none that is", async () => {
    state.lodges = [
      { id: "lodge-a", name: "Alpha Lodge" },
      { id: "lodge-b", name: "Beta Lodge" },
      { id: "lodge-c", name: "Gamma Lodge" },
    ];
    // Alpha configured; Beta cleared to no capacity; Gamma never given a row.
    state.capacities = { "lodge-a": 18, "lodge-b": null };

    const snapshot = await getSetupDatabaseSnapshot();

    expect(snapshot.lodgesNotSetUpForBookings).toEqual(["Beta Lodge", "Gamma Lodge"]);
  });

  it("is an empty list when every active lodge is set up", async () => {
    state.lodges = [{ id: "lodge-a", name: "Alpha Lodge" }];
    state.capacities = { "lodge-a": 18 };

    const snapshot = await getSetupDatabaseSnapshot();

    expect(snapshot.lodgesNotSetUpForBookings).toEqual([]);
  });

  it("omits the signal, rather than failing the snapshot, when the lodge list cannot be read", async () => {
    state.lodgeListFails = true;

    const snapshot = await getSetupDatabaseSnapshot();

    expect(snapshot.lodgesNotSetUpForBookings).toBeUndefined();
  });
});
