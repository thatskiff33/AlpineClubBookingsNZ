import { describe, expect, it, vi } from "vitest";
import { strToU8 } from "fflate";

vi.mock("server-only", () => ({}));

import { lodgeConfigImporter } from "@/lib/config-transfer/categories/lodge-config";
import { xeroConfigImporter } from "@/lib/config-transfer/categories/xero-config";
import type { TxDb } from "@/lib/config-transfer/import-types";

// Config-transfer season-rate + Xero HUT_FEE re-key (#1930, E4): apply writes the
// membership-type-keyed rows. The old-bundle IMPORT compat for the legacy
// boolean `isMember` key (and the pre-#1931 ENTRANCE_FEE category name) closed
// one release after E13 (#2131): such a bundle is now rejected with a clear
// validation error at plan time, never silently mapped.

const MEMBERSHIP_TYPES = [
  { id: "mt-full", key: "FULL", bookingBehavior: "MEMBER_RATE", ageGroupsApply: true },
  { id: "mt-nonmember", key: "NON_MEMBER", bookingBehavior: "NON_MEMBER_RATE", ageGroupsApply: true },
  { id: "mt-school", key: "SCHOOL_GROUP", bookingBehavior: "MEMBER_RATE", ageGroupsApply: false },
  { id: "mt-associate", key: "ASSOCIATE", bookingBehavior: "NON_MEMBER_RATE", ageGroupsApply: true },
  { id: "mt-blocked", key: "SOCIAL", bookingBehavior: "BLOCK_BOOKING", ageGroupsApply: true },
];

/**
 * A permissive in-memory tx: named delegates model the reads the apply needs;
 * any other delegate/method is a no-op so the apply's unrelated passes (rooms,
 * beds, instructions, default-lodge marker, …) don't throw. Captures the
 * membership-type-keyed creates we assert on.
 */
function makeTx(captures: {
  rateCreates: Record<string, unknown>[];
  itemCreates: Record<string, unknown>[];
  // Optional: the FULL create args (not just `data`), so a test can assert the
  // explicit `select` narrowing the implicit RETURNING (#2130 runtime-prep).
  itemCreateArgs?: Record<string, unknown>[];
  // Optional: the installation's membership types, for a test about a type
  // whose own row an officer has edited.
  membershipTypes?: typeof MEMBERSHIP_TYPES;
}): TxDb {
  const noopDelegate = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    create: async () => ({ id: "x" }),
    update: async () => ({}),
    updateMany: async () => ({ count: 0 }),
    deleteMany: async () => ({ count: 0 }),
    upsert: async () => ({ id: "x" }),
  };
  const specific: Record<string, unknown> = {
    lodge: {
      ...noopDelegate,
      findMany: async () => [
        {
          id: "lodge-1", slug: "main", name: "Main Lodge", active: true, travelNote: null,
          doorCode: null, isDefault: true, displayConfig: null,
          displayNameGranularity: null, displayNotice: null, showGuestPhonesOnScreens: false,
        },
      ],
      findFirst: async () => ({ slug: "main" }),
      findUnique: async () => ({ isDefault: true }),
    },
    season: {
      ...noopDelegate,
      findMany: async () => [
        {
          id: "season-1", lodgeId: "lodge-1", name: "Winter", type: "WINTER",
          startDate: new Date("2026-06-01T00:00:00.000Z"),
          endDate: new Date("2026-09-01T00:00:00.000Z"), active: true,
        },
      ],
    },
    membershipTypeSeasonRate: {
      ...noopDelegate,
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        captures.rateCreates.push(data);
        return { id: "r-new" };
      },
    },
    xeroItemCodeMapping: {
      ...noopDelegate,
      findMany: async () => [],
      create: async (args: { data: Record<string, unknown> }) => {
        captures.itemCreates.push(args.data);
        captures.itemCreateArgs?.push(args as Record<string, unknown>);
        return { id: "i-new" };
      },
    },
    membershipType: {
      ...noopDelegate,
      findMany: async () => captures.membershipTypes ?? MEMBERSHIP_TYPES,
    },
  };
  return new Proxy({} as Record<string, unknown>, {
    get: (_t, prop) => specific[prop as string] ?? noopDelegate,
  }) as unknown as TxDb;
}

function applyCtx(files: Map<string, Uint8Array>, tx: TxDb) {
  return {
    tx,
    files,
    manifest: {} as never,
    mode: "merge" as const,
    resolutions: new Map<string, string>(),
    actorMemberId: "admin-1",
    imageRemap: new Map<string, string>(),
    notes: { doorCodesWritten: [] as string[] },
  };
}

function lodgeFiles(ratesCsv: string): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    ["lodge-config/lodges/main/lodge.json", strToU8(JSON.stringify({ slug: "main", name: "Main Lodge" }))],
    ["lodge-config/lodges/main/seasons.csv", strToU8("name,type,startDate,endDate,active\nWinter,WINTER,2026-06-01,2026-09-01,true\n")],
    ["lodge-config/lodges/main/season-rates.csv", strToU8(ratesCsv)],
  ]);
}

describe("config-transfer season-rate re-key apply (#1930, E4)", () => {
  it("writes membership-type-keyed rows from the NEW-shape bundle", async () => {
    const captures = { rateCreates: [] as Record<string, unknown>[], itemCreates: [] as Record<string, unknown>[] };
    const files = lodgeFiles(
      "seasonName,membershipTypeKey,ageTier,pricePerNightCents\n" +
      "Winter,FULL,ADULT,5000\n" +
      "Winter,NON_MEMBER,ADULT,7000\n",
    );
    await lodgeConfigImporter.apply(applyCtx(files, makeTx(captures)) as never);

    expect(captures.rateCreates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ seasonId: "season-1", membershipTypeId: "mt-full", ageTier: "ADULT", pricePerNightCents: 5000 }),
        expect.objectContaining({ seasonId: "season-1", membershipTypeId: "mt-nonmember", ageTier: "ADULT", pricePerNightCents: 7000 }),
      ]),
    );
  });

  it("rejects an OLD isMember season-rate bundle with a clear error (#2131, compat closed)", async () => {
    const captures = { rateCreates: [] as Record<string, unknown>[], itemCreates: [] as Record<string, unknown>[] };
    const files = lodgeFiles(
      "seasonName,ageTier,isMember,pricePerNightCents\n" +
      "Winter,ADULT,true,5000\n" +
      "Winter,ADULT,false,7000\n",
    );
    const plan = await lodgeConfigImporter.plan(planCtx(files, makeTx(captures)) as never);

    expect(plan.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("legacy 'isMember' season-rate shape is no longer imported"),
      ]),
    );
    // The rejected legacy rows contribute no season-rate plan items (no silent
    // partial import).
    expect(plan.items.filter((i) => i.entity === "season-rate")).toHaveLength(0);
  });
});

function planCtx(files: Map<string, Uint8Array>, db: TxDb) {
  return {
    db,
    files,
    manifest: {} as never,
    mode: "merge" as const,
    resolutions: new Map<string, string>(),
  };
}

describe("config-transfer D2 + shape import validation (#1930, E4 review F9)", () => {
  it("season-rates: rejects rows targeting NON_MEMBER_RATE/BLOCK types as blocking errors", async () => {
    const captures = { rateCreates: [] as Record<string, unknown>[], itemCreates: [] as Record<string, unknown>[] };
    const files = lodgeFiles(
      "seasonName,membershipTypeKey,ageTier,pricePerNightCents\n" +
      "Winter,ASSOCIATE,ADULT,5000\n" +
      "Winter,SOCIAL,ADULT,5000\n" +
      "Winter,FULL,ADULT,5000\n",
    );
    const plan = await lodgeConfigImporter.plan(planCtx(files, makeTx(captures)) as never);

    expect(plan.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('membership type "ASSOCIATE" does not carry its own hut rates'),
        expect.stringContaining('membership type "SOCIAL" does not carry its own hut rates'),
      ]),
    );
    // Invalid rows are excluded from the plan; the valid FULL row still plans.
    const rateItems = plan.items.filter((item) => item.entity === "season-rate");
    expect(rateItems).toHaveLength(1);
    expect(rateItems[0].key).toContain("FULL");
  });

  it("season-rates: validates row shape against ageGroupsApply", async () => {
    const captures = { rateCreates: [] as Record<string, unknown>[], itemCreates: [] as Record<string, unknown>[] };
    const files = lodgeFiles(
      "seasonName,membershipTypeKey,ageTier,pricePerNightCents\n" +
      // Flat type must not carry a per-tier row...
      "Winter,SCHOOL_GROUP,ADULT,5000\n" +
      // ...and an age-keyed type must not carry a blank-tier (flat) row.
      "Winter,FULL,,5000\n" +
      // Correct shapes still plan.
      "Winter,SCHOOL_GROUP,,4000\n" +
      "Winter,FULL,ADULT,6000\n",
    );
    const plan = await lodgeConfigImporter.plan(planCtx(files, makeTx(captures)) as never);

    expect(plan.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"SCHOOL_GROUP" prices from a single flat rate'),
        expect.stringContaining('"FULL" uses per-age-tier rates'),
      ]),
    );
    const rateItems = plan.items.filter((item) => item.entity === "season-rate");
    expect(rateItems.map((item) => item.key)).toEqual([
      "main/Winter/SCHOOL_GROUP/",
      "main/Winter/FULL/ADULT",
    ]);
  });

  it("accepts rows for a key-resolved built-in whose booking behaviour was edited", async () => {
    /*
      A bundle exported from an install whose officer had re-answered `FULL`'s
      booking behaviour must still round-trip. `FULL` is resolved BY KEY for an
      unplaceable member and for every other-lodge guest, so the source install
      legitimately holds those rate rows and those hut-fee item codes — and if
      the importer asked the behaviour question alone it would reject them as
      "does not carry its own hut rates", silently dropping real pricing on the
      way in (#2933).
    */
    const membershipTypes = MEMBERSHIP_TYPES.map((type) =>
      type.key === "FULL" ? { ...type, bookingBehavior: "NON_MEMBER_RATE" } : type,
    );
    const rateCaptures = {
      rateCreates: [] as Record<string, unknown>[],
      itemCreates: [] as Record<string, unknown>[],
      membershipTypes,
    };
    const ratePlan = await lodgeConfigImporter.plan(
      planCtx(
        lodgeFiles(
          "seasonName,membershipTypeKey,ageTier,pricePerNightCents\n" +
          "Winter,FULL,ADULT,5000\n",
        ),
        makeTx(rateCaptures),
      ) as never,
    );
    expect(ratePlan.errors).toEqual([]);
    expect(
      ratePlan.items.filter((item) => item.entity === "season-rate"),
    ).toHaveLength(1);

    const itemCaptures = {
      rateCreates: [] as Record<string, unknown>[],
      itemCreates: [] as Record<string, unknown>[],
      membershipTypes,
    };
    const itemPlan = await xeroConfigImporter.plan(
      planCtx(
        new Map<string, Uint8Array>([
          ["xero-config/item-code-mappings.csv", strToU8(
            "category,membershipTypeKey,ageTier,seasonType,entranceFeeCategory,itemCode,amountCents\n" +
            "HUT_FEE,FULL,ADULT,WINTER,,HUT-OK,\n",
          )],
        ]),
        makeTx(itemCaptures),
      ) as never,
    );
    expect(itemPlan.errors).toEqual([]);
    expect(
      itemPlan.items
        .filter((item) => item.entity === "xero-item-code-mapping")
        .map((item) => item.key),
    ).toEqual(["HUT_FEE/FULL/ADULT/WINTER/-"]);
  });

  it("xero HUT_FEE: rejects non-rate-bearing types and shape mismatches as blocking errors", async () => {
    const captures = { rateCreates: [] as Record<string, unknown>[], itemCreates: [] as Record<string, unknown>[] };
    const files = new Map<string, Uint8Array>([
      ["xero-config/item-code-mappings.csv", strToU8(
        "category,membershipTypeKey,ageTier,seasonType,entranceFeeCategory,itemCode,amountCents\n" +
        "HUT_FEE,ASSOCIATE,ADULT,WINTER,,HUT-BAD,\n" +
        "HUT_FEE,SCHOOL_GROUP,ADULT,WINTER,,HUT-BAD-SHAPE,\n" +
        "HUT_FEE,FULL,,WINTER,,HUT-BAD-FLAT,\n" +
        "HUT_FEE,FULL,ADULT,WINTER,,HUT-OK,\n" +
        "HUT_FEE,SCHOOL_GROUP,,WINTER,,HUT-OK-FLAT,\n" +
        "JOINING_FEE,,,,ADULT,ENT-OK,5000\n",
      )],
    ]);
    const plan = await xeroConfigImporter.plan(planCtx(files, makeTx(captures)) as never);

    expect(plan.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('membership type "ASSOCIATE" does not carry its own hut fees'),
        expect.stringContaining('"SCHOOL_GROUP" prices from a single flat rate'),
        expect.stringContaining('"FULL" uses per-age-tier rates'),
      ]),
    );
    // Valid rows still plan; invalid ones are excluded. A current JOINING_FEE
    // item-code row (which carries an entranceFeeCategory, never a membership
    // type) plans under the current natural key.
    const itemKeys = plan.items
      .filter((item) => item.entity === "xero-item-code-mapping")
      .map((item) => item.key);
    expect(itemKeys).toEqual(
      expect.arrayContaining([
        "HUT_FEE/FULL/ADULT/WINTER/-",
        "HUT_FEE/SCHOOL_GROUP/-/WINTER/-",
        "JOINING_FEE/-/-/-/ADULT",
      ]),
    );
    expect(itemKeys).toHaveLength(3);
  });
});

describe("config-transfer Xero HUT_FEE re-key import rejection (#2131)", () => {
  it("rejects an OLD isMember HUT_FEE bundle with a clear error (compat closed)", async () => {
    const captures = { rateCreates: [] as Record<string, unknown>[], itemCreates: [] as Record<string, unknown>[] };
    const files = new Map<string, Uint8Array>([
      ["xero-config/item-code-mappings.csv", strToU8(
        "category,ageTier,seasonType,isMember,entranceFeeCategory,itemCode,amountCents\n" +
        "HUT_FEE,ADULT,WINTER,true,,HUT-MEM,\n" +
        "HUT_FEE,ADULT,WINTER,false,,HUT-NON,\n",
      )],
    ]);
    const plan = await xeroConfigImporter.plan(planCtx(files, makeTx(captures)) as never);

    expect(plan.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("legacy 'isMember' HUT_FEE key is no longer imported"),
      ]),
    );
    // No item-code rows are planned from the rejected legacy bundle.
    expect(plan.items.filter((i) => i.entity === "xero-item-code-mapping")).toHaveLength(0);
  });

  it("applies a CURRENT-format HUT_FEE bundle: membership-type-keyed, never the frozen legacy shape", async () => {
    const captures = { rateCreates: [] as Record<string, unknown>[], itemCreates: [] as Record<string, unknown>[] };
    // The exporter's real current header (ITEM_FIELDS, xero-config.ts).
    const files = new Map<string, Uint8Array>([
      ["xero-config/item-code-mappings.csv", strToU8(
        "category,membershipTypeKey,ageTier,seasonType,entranceFeeCategory,itemCode,amountCents\n" +
        "HUT_FEE,FULL,ADULT,WINTER,,HUT-MEM,\n" +
        "HUT_FEE,NON_MEMBER,ADULT,WINTER,,HUT-NON,\n",
      )],
    ]);
    await xeroConfigImporter.apply(applyCtx(files, makeTx(captures)) as never);

    expect(captures.itemCreates).toHaveLength(2);
    expect(captures.itemCreates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ membershipTypeId: "mt-full", ageTier: "ADULT", seasonType: "WINTER", itemCode: "HUT-MEM" }),
        expect.objectContaining({ membershipTypeId: "mt-nonmember", ageTier: "ADULT", seasonType: "WINTER", itemCode: "HUT-NON" }),
      ]),
    );
    // Never the frozen legacy shape: every created row is membership-type-keyed
    // and writes no isMember. A keyless row would be skipped by loadXeroBatch,
    // so it would re-create on every import and resolve to no item code.
    for (const created of captures.itemCreates) {
      expect(created.membershipTypeId).toBeTruthy();
      expect(created.isMember ?? null).toBeNull();
    }
  });

  it("rejects a keyless HUT_FEE row rather than writing a frozen-legacy-shaped mapping", async () => {
    const captures = { rateCreates: [] as Record<string, unknown>[], itemCreates: [] as Record<string, unknown>[] };
    const files = new Map<string, Uint8Array>([
      ["xero-config/item-code-mappings.csv", strToU8(
        "category,membershipTypeKey,ageTier,seasonType,entranceFeeCategory,itemCode,amountCents\n" +
        "HUT_FEE,,ADULT,WINTER,,HUT-KEYLESS,\n",
      )],
    ]);
    const plan = await xeroConfigImporter.plan(planCtx(files, makeTx(captures)) as never);

    expect(plan.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("a HUT_FEE item-code row must name a membership type"),
      ]),
    );
    expect(plan.items.filter((i) => i.entity === "xero-item-code-mapping")).toHaveLength(0);
  });

  it("rejects a legacy ENTRANCE_FEE item-code row with an actionable, version-free remedy", async () => {
    const captures = { rateCreates: [] as Record<string, unknown>[], itemCreates: [] as Record<string, unknown>[] };
    const files = new Map<string, Uint8Array>([
      ["xero-config/item-code-mappings.csv", strToU8(
        "category,membershipTypeKey,ageTier,seasonType,entranceFeeCategory,itemCode,amountCents\n" +
        "ENTRANCE_FEE,,,,ADULT,ENT-OLD,5000\n",
      )],
    ]);
    const plan = await xeroConfigImporter.plan(planCtx(files, makeTx(captures)) as never);

    expect(plan.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('legacy "ENTRANCE_FEE" item-code rows are no longer imported'),
      ]),
    );
    // The remedy copy is pinned but deliberately version-free: a hardcoded
    // release number goes stale in shipped code if the PR slips a release. The
    // precise "v0.12.2 was the last release that could import…" statement lives
    // in CHANGELOG.md and the config-transfer docs, which are edited at each cut.
    expect(plan.errors.join(" ")).toContain(
      "re-export this bundle from an install running the current release",
    );
    expect(plan.items.filter((i) => i.entity === "xero-item-code-mapping")).toHaveLength(0);
  });

  it("narrows the create's RETURNING, never naming the doomed isMember column (#2130 runtime-prep)", async () => {
    // Blue/green safety pin, WRITE half. Prisma emits an implicit RETURNING
    // over every scalar column of a create unless a `select` narrows it, so
    // this config-transfer import would keep naming
    // XeroItemCodeMapping.isMember once the contract migration drops it.
    // `applyRow` discards the result, so `{ id: true }` is the safe narrowing.
    const captures = {
      rateCreates: [] as Record<string, unknown>[],
      itemCreates: [] as Record<string, unknown>[],
      itemCreateArgs: [] as Record<string, unknown>[],
    };
    const files = new Map<string, Uint8Array>([
      // Current-format bundle. The legacy `isMember`-keyed header this pin
      // originally used is rejected outright since #2131, so it would never
      // reach the create at all — the doomed column this guards is the DB
      // column XeroItemCodeMapping.isMember, not a CSV field.
      ["xero-config/item-code-mappings.csv", strToU8(
        "category,membershipTypeKey,ageTier,seasonType,entranceFeeCategory,itemCode,amountCents\n" +
        "HUT_FEE,FULL,ADULT,WINTER,,HUT-MEM,\n",
      )],
    ]);
    await xeroConfigImporter.apply(applyCtx(files, makeTx(captures)) as never);

    expect(captures.itemCreateArgs.length).toBeGreaterThan(0);
    for (const args of captures.itemCreateArgs) {
      expect(args.select).toEqual({ id: true });
      expect(args.select).not.toHaveProperty("isMember");
    }
  });
});
