import { describe, expect, it, vi } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

vi.mock("server-only", () => ({}));

import { buildConfigExport } from "@/lib/config-transfer/export";
import { buildImportPlan } from "@/lib/config-transfer/import";
import { readBundle } from "@/lib/config-transfer/bundle";
import { parseCsv } from "@/lib/config-transfer/csv";
import { lodgeFolderFiles } from "@/lib/config-transfer/categories/lodge-config";
import type { ReadDb } from "@/lib/config-transfer/import-types";

const LODGE_JSON = "lodge-config/lodges/main/lodge.json";
const ROOMS = "lodge-config/lodges/main/rooms.csv";
const BEDS = "lodge-config/lodges/main/beds.csv";
const SEASONS = "lodge-config/lodges/main/seasons.csv";
const RATES = "lodge-config/lodges/main/season-rates.csv";

function readJson(files: Map<string, Uint8Array>, path: string) {
  return JSON.parse(strFromU8(files.get(path)!)) as Record<string, unknown>;
}

function sourceDb(): ReadDb {
  return {
    lodge: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "lodge-main", slug: "main", name: "Main Lodge", active: true, travelNote: "Turn left",
          doorCode: "9999", isDefault: true,
          displayConfig: { "wifi-code": "alpine1234" },
          displayNameGranularity: "FULL_NAME",
          displayNotice: "Working bee Sunday",
          showGuestPhonesOnScreens: true,
        },
      ]),
    },
    lodgeRoom: {
      findMany: vi.fn().mockResolvedValue([
        { name: "Bunk A", sortOrder: 1, active: true, notes: null, lodge: { slug: "main" } },
      ]),
    },
    lodgeBed: {
      findMany: vi.fn().mockResolvedValue([
        { name: "A1", sortOrder: 1, active: true, bedType: "BUNK_TOP", bunkGroup: "A", room: { name: "Bunk A", lodge: { slug: "main" } } },
      ]),
    },
    season: {
      findMany: vi.fn().mockResolvedValue([
        {
          name: "Winter",
          type: "WINTER",
          startDate: new Date("2026-06-01T00:00:00.000Z"),
          endDate: new Date("2026-09-01T00:00:00.000Z"),
          active: true,
          // #2338: the per-season flat whole-lodge night rate rides in
          // seasons.csv so a restore does not lose it.
          flatWholeLodgeNightCents: 60000,
          lodge: { slug: "main" },
        },
      ]),
    },
    // Membership-type-keyed rates (#1930, E4); export joins the type key.
    membershipTypeSeasonRate: {
      findMany: vi.fn().mockResolvedValue([
        {
          ageTier: "ADULT",
          pricePerNightCents: 5000,
          membershipType: { key: "FULL" },
          season: { name: "Winter", lodge: { slug: "main" } },
        },
      ]),
    },
    membershipType: {
      findMany: vi.fn().mockResolvedValue([
        { id: "mt-full", key: "FULL", bookingBehavior: "MEMBER_RATE", ageGroupsApply: true },
        { id: "mt-nonmember", key: "NON_MEMBER", bookingBehavior: "NON_MEMBER_RATE", ageGroupsApply: true },
      ]),
    },
    lodgeInstruction: { findMany: vi.fn().mockResolvedValue([]) },
    choreTemplate: { findMany: vi.fn().mockResolvedValue([]) },
    // The club-wide display library (LTV-037) rides with lodge-config; an export
    // reads both tables even when empty.
    displayLayout: { findMany: vi.fn().mockResolvedValue([]) },
    displayTemplate: { findMany: vi.fn().mockResolvedValue([]) },
    bedAllocationSettings: {
      findUnique: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) =>
        where.id === "lodge-main"
          ? {
              id: "lodge-main",
              lodgeId: "lodge-main",
              autoAllocationEnabled: false,
              allocationPriorityOrder: ["REQUESTED_ROOM", "BOOKING_COHESION"],
              updatedByMemberId: null,
              updatedAt: null,
            }
          : null,
      ),
    },
  } as unknown as ReadDb;
}

function emptyTargetDb(): ReadDb {
  return {
    lodge: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn().mockResolvedValue(null) },
    lodgeRoom: { findMany: vi.fn().mockResolvedValue([]) },
    lodgeBed: { findMany: vi.fn().mockResolvedValue([]) },
    season: { findMany: vi.fn().mockResolvedValue([]) },
    membershipTypeSeasonRate: { findMany: vi.fn().mockResolvedValue([]) },
    // Rate rows key on the membership type; the parser resolves keys against these.
    membershipType: {
      findMany: vi.fn().mockResolvedValue([
        { id: "mt-full", key: "FULL", bookingBehavior: "MEMBER_RATE", ageGroupsApply: true },
        { id: "mt-nonmember", key: "NON_MEMBER", bookingBehavior: "NON_MEMBER_RATE", ageGroupsApply: true },
      ]),
    },
    lodgeInstruction: { findMany: vi.fn().mockResolvedValue([]) },
    choreTemplate: { findMany: vi.fn().mockResolvedValue([]) },
    displayLayout: { findMany: vi.fn().mockResolvedValue([]) },
    displayTemplate: { findMany: vi.fn().mockResolvedValue([]) },
    xeroToken: { findFirst: vi.fn().mockResolvedValue(null) },
  } as unknown as ReadDb;
}

async function exportLodges(includeDoorCodes: boolean) {
  return buildConfigExport({
    db: sourceDb(),
    categories: ["lodge-config"],
    includeDoorCodes,
    appVersion: "0.10.1",
    prismaMigration: null,
    generatedAt: "2026-07-08T00:00:00.000Z",
  });
}

describe("config-transfer lodge-config (per-lodge folders)", () => {
  it("publishes the complete eight-file per-lodge path contract", () => {
    expect(lodgeFolderFiles("main").bedAllocationSettings).toBe(
      "lodge-config/lodges/main/bed-allocation-settings.json",
    );
    expect(Object.keys(lodgeFolderFiles("main"))).toHaveLength(8);
  });

  it("exports a lodge folder with lodge.json + collection CSVs (lodge implied by folder)", async () => {
    const { zip } = await exportLodges(false);
    const { files } = readBundle(zip);

    const lodge = readJson(files, LODGE_JSON);
    expect(lodge.slug).toBe("main");
    expect(lodge.name).toBe("Main Lodge");
    expect(lodge.isDefault).toBe(true); // default-lodge marker travels (fork #15)
    expect("doorCode" in lodge).toBe(false); // opt-in only

    // Collection CSVs no longer carry a lodgeSlug column — the folder implies it.
    const rooms = parseCsv(strFromU8(files.get(ROOMS)!));
    expect(rooms.headers).not.toContain("lodgeSlug");
    expect(rooms.rows[0]).toMatchObject({ name: "Bunk A" });

    const beds = parseCsv(strFromU8(files.get(BEDS)!));
    expect(beds.headers).not.toContain("lodgeSlug");
    expect(beds.rows[0]).toMatchObject({ roomName: "Bunk A", name: "A1", bedType: "BUNK_TOP", bunkGroup: "A" });

    const seasons = parseCsv(strFromU8(files.get(SEASONS)!));
    // #2338: the flat whole-lodge rate rides in seasons.csv (integer cents).
    expect(seasons.headers).toContain("flatWholeLodgeNightCents");
    expect(seasons.rows[0]).toMatchObject({
      name: "Winter",
      startDate: "2026-06-01",
      flatWholeLodgeNightCents: "60000",
    });

    const rates = parseCsv(strFromU8(files.get(RATES)!));
    expect(rates.headers).toContain("membershipTypeKey");
    expect(rates.headers).not.toContain("isMember");
    expect(rates.rows[0]).toMatchObject({
      seasonName: "Winter",
      membershipTypeKey: "FULL",
      ageTier: "ADULT",
      pricePerNightCents: "5000",
    });

    // Full skeleton is emitted even when empty (header-only), so a lodge folder
    // captures the entire config shape and hand-authoring is discoverable.
    const instructions = parseCsv(strFromU8(files.get("lodge-config/lodges/main/instructions.csv")!));
    expect(instructions.headers).toEqual(["key", "contentHtml"]);
    expect(instructions.rows).toEqual([]);
    const chores = parseCsv(strFromU8(files.get("lodge-config/lodges/main/chore-templates.csv")!));
    expect(chores.rows).toEqual([]);
    // The club-wide (all-lodges) instructions base file is at the top level.
    expect(files.get("lodge-config/instructions.csv")).toBeDefined();
  });

  it("includes door code in lodge.json only when opted in", async () => {
    const { zip } = await exportLodges(true);
    const lodge = readJson(readBundle(zip).files, LODGE_JSON);
    expect(lodge.doorCode).toBe("9999");
  });

  it("plans all-create against an empty target and flags the default-lodge change", async () => {
    const { zip } = await exportLodges(false);
    const plan = await buildImportPlan(emptyTargetDb(), zip, { mode: "merge" });
    const cat = plan.categories.find((c) => c.category === "lodge-config")!;
    const actions = Object.fromEntries(cat.items.map((i) => [i.entity, i.action]));
    expect(actions["lodge"]).toBe("create");
    expect(actions["lodge-room"]).toBe("create");
    expect(actions["lodge-bed"]).toBe("create");
    expect(actions["season"]).toBe("create");
    expect(actions["season-rate"]).toBe("create");
    expect(plan.integrityWarnings).toEqual([]);
    // The bundle designates "main" as default and the target has none yet.
    expect(cat.warnings.join(" ")).toMatch(/default lodge will be set to "main"/i);
  });
});

describe("config-transfer lobby display (issue #50)", () => {
  it("exports display settings in lodge.json (templates dropped in LTV-024)", async () => {
    const { zip } = await exportLodges(false);
    const { files } = readBundle(zip);

    const lodge = readJson(files, LODGE_JSON);
    expect(lodge.displayConfig).toEqual({ "wifi-code": "alpine1234" });
    expect(lodge.displayNameGranularity).toBe("FULL_NAME");
    expect(lodge.displayNotice).toBe("Working bee Sunday");
    // Phone-display toggle travels with the descriptor (#137 / #37).
    expect(lodge.showGuestPhonesOnScreens).toBe(true);

    // The retired club-wide template file is no longer emitted (LTV-024).
    expect(files.get("lodge-config/display-templates.json")).toBeUndefined();
  });

  it("plans lodge display settings on the lodge entity against an empty target", async () => {
    const { zip } = await exportLodges(false);
    const plan = await buildImportPlan(emptyTargetDb(), zip, { mode: "merge" });
    const cat = plan.categories.find((c) => c.category === "lodge-config")!;
    expect(cat.errors).toEqual([]);
    // Display settings travel on the lodge descriptor, not a separate entity.
    expect(cat.items.find((i) => i.entity === "display-template")).toBeUndefined();
    expect(cat.items.find((i) => i.entity === "lodge")).toMatchObject({
      action: "create",
    });
  });

  it("rejects invalid display settings in lodge.json with explicit errors", async () => {
    const { zip } = await exportLodges(false);
    const unzipped = unzipSync(zip);
    unzipped[LODGE_JSON] = strToU8(
      JSON.stringify({
        slug: "main",
        name: "Main Lodge",
        active: true,
        displayNameGranularity: "SHOUT_EVERYTHING",
        displayConfig: { "Bad Key!": "x" },
        displayNotice: "x".repeat(2001),
      }),
    );
    const rezipped = zipSync(unzipped); // integrity is warn-only by design
    const plan = await buildImportPlan(emptyTargetDb(), rezipped, { mode: "merge" });
    const cat = plan.categories.find((c) => c.category === "lodge-config")!;
    const joined = cat.errors.join("\n");
    expect(joined).toMatch(/displayNameGranularity/);
    expect(joined).toMatch(/displayConfig key "Bad Key!"/);
    expect(joined).toMatch(/displayNotice/);
  });
});
