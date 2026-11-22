import { describe, expect, it } from "vitest";
import type { DisplayState } from "@/lib/lodge-display-state";

// Issue hoppers99/AlpineClubBookingsNZ#29 (LTV-004, ADR-002) + LTV-024: the template registry and condition
// engine — built-in resolution (DB overrides retired with the v2 rebuild),
// load-time rejection of unknown modules/conditions (never a partially-broken
// template), pure condition evaluation, and eligibility filtering for rotation.

function stateWith(overrides: Partial<DisplayState>): DisplayState {
  return {
    lodge: { name: "Silverpeak Lodge" },
    club: { name: "Alpine Sports Club", logoUrl: null, logoDataUrl: null },
    generatedAt: "2026-04-13T00:00:00.000Z",
    window: { start: "2026-04-13", days: 3 },
    rooms: null,
    bookings: [],
    occupancy: [
      { date: "2026-04-13", arriving: 0, departing: 0, staying: 0 },
      { date: "2026-04-14", arriving: 0, departing: 0, staying: 0 },
      { date: "2026-04-15", arriving: 0, departing: 0, staying: 0 },
    ],
    chores: [],
    rules: null,
    notice: null,
    config: {},
    capabilities: { bedAllocation: false, chores: false },
    // #2286: no custodian in residence in the base fixture.
    custodian: null,
    ...overrides,
  };
}

const WHOLE_LODGE_ROW = {
  key: "row-1-0",
  label: "Harakeke College",
  wholeLodge: true,
  roomId: null,
  guests: null,
  guestCount: 14,
  stayStart: "2026-04-13",
  stayEnd: "2026-04-15",
  // #2735: the row's own nights — the expanded envelope for this contiguous
  // stay. `occupancy:whole-lodge-today` asks this rather than re-deriving a
  // night from the envelope, so a row whose nights have a gap in them no
  // longer claims the lodge on the gap night.
  nights: ["2026-04-13", "2026-04-14"],
  // #2621: no expected arrival time in this fixture.
  arrivalTime: null,
} as const;

describe("condition engine (namespaced registry — ADR-003 §3)", () => {
  it("evaluates the core + occupancy + content conditions", async () => {
    const { evaluateDisplayCondition } = await import(
      "@/lib/lodge-display/conditions"
    );

    const empty = stateWith({});
    expect(evaluateDisplayCondition("always", empty)).toBe(true);
    expect(evaluateDisplayCondition("occupancy:empty-today", empty)).toBe(true);
    expect(evaluateDisplayCondition("occupancy:arrivals-today", empty)).toBe(false);
    expect(evaluateDisplayCondition("occupancy:departures-today", empty)).toBe(false);
    expect(evaluateDisplayCondition("occupancy:whole-lodge-today", empty)).toBe(false);
    expect(evaluateDisplayCondition("occupancy:whole-lodge-in-window", empty)).toBe(false);
    expect(evaluateDisplayCondition("content:notice", empty)).toBe(false);
    expect(evaluateDisplayCondition("content:instructions", empty)).toBe(false);

    const busy = stateWith({
      bookings: [{ ...WHOLE_LODGE_ROW }],
      occupancy: [
        { date: "2026-04-13", arriving: 14, departing: 0, staying: 14 },
        { date: "2026-04-14", arriving: 0, departing: 0, staying: 14 },
        { date: "2026-04-15", arriving: 0, departing: 14, staying: 14 },
      ],
      notice: "Working bee Sunday",
      rules: [{ title: "House rules", html: "<p>Boots off</p>" }],
    });
    // Today (window.start = 2026-04-13) is a NIGHT of the whole-lodge booking.
    expect(evaluateDisplayCondition("occupancy:whole-lodge-today", busy)).toBe(true);
    expect(evaluateDisplayCondition("occupancy:whole-lodge-in-window", busy)).toBe(true);
    expect(evaluateDisplayCondition("occupancy:arrivals-today", busy)).toBe(true);
    expect(evaluateDisplayCondition("occupancy:empty-today", busy)).toBe(false);
    expect(evaluateDisplayCondition("content:notice", busy)).toBe(true);
    expect(evaluateDisplayCondition("content:instructions", busy)).toBe(true);
  });

  it("distinguishes whole-lodge TODAY from whole-lodge IN WINDOW on the departure day", async () => {
    const { evaluateDisplayCondition } = await import(
      "@/lib/lodge-display/conditions"
    );
    // The booking's only night is 2026-04-14; today (window.start) is its
    // departure day, so it is in the window but not occupying tonight.
    const departingToday = stateWith({
      bookings: [
        {
          ...WHOLE_LODGE_ROW,
          stayStart: "2026-04-12",
          stayEnd: "2026-04-13",
          nights: ["2026-04-12"],
        },
      ],
      occupancy: [
        { date: "2026-04-13", arriving: 0, departing: 14, staying: 14 },
        { date: "2026-04-14", arriving: 0, departing: 0, staying: 0 },
        { date: "2026-04-15", arriving: 0, departing: 0, staying: 0 },
      ],
    });
    expect(evaluateDisplayCondition("occupancy:whole-lodge-in-window", departingToday)).toBe(true);
    expect(evaluateDisplayCondition("occupancy:whole-lodge-today", departingToday)).toBe(false);
    expect(evaluateDisplayCondition("occupancy:departures-today", departingToday)).toBe(true);
  });

  it("does not claim the lodge tonight on a whole-lodge hold's GAP night (#2735)", async () => {
    const { evaluateDisplayCondition } = await import(
      "@/lib/lodge-display/conditions"
    );
    // `wholeLodge` is not only the explicit hold flag — the sole-occupancy
    // heuristic sets it too, and that never requires contiguity. This group is
    // alone on the 13th and the 15th and holds nothing on the 14th, so on the
    // 14th the lodge is NOT booked out tonight even though the envelope spans
    // it. The envelope rule this replaced answered true here.
    const gapNight = {
      ...WHOLE_LODGE_ROW,
      stayStart: "2026-04-13",
      stayEnd: "2026-04-16",
      nights: ["2026-04-13", "2026-04-15"],
    };
    const occupancy = [
      { date: "2026-04-14", arriving: 0, departing: 14, staying: 14 },
      { date: "2026-04-15", arriving: 14, departing: 0, staying: 14 },
      { date: "2026-04-16", arriving: 0, departing: 14, staying: 14 },
    ];
    const onGap = stateWith({
      window: { start: "2026-04-14", days: 3 },
      bookings: [gapNight],
      occupancy,
    });
    expect(evaluateDisplayCondition("occupancy:whole-lodge-today", onGap)).toBe(false);
    // Still in the window, so the rotating blockout stays eligible.
    expect(evaluateDisplayCondition("occupancy:whole-lodge-in-window", onGap)).toBe(true);

    // …and true on both nights they really do hold.
    for (const start of ["2026-04-13", "2026-04-15"]) {
      const held = stateWith({
        window: { start, days: 3 },
        bookings: [gapNight],
        occupancy: [{ date: start, arriving: 0, departing: 0, staying: 14 }],
      });
      expect(evaluateDisplayCondition("occupancy:whole-lodge-today", held)).toBe(true);
    }
  });

  it("survives a payload row with no night set at all (deploy skew, #2735)", async () => {
    const { evaluateDisplayCondition } = await import(
      "@/lib/lodge-display/conditions"
    );
    // A lobby TV can poll an instance still serving the previous deploy's
    // payload shape. The condition engine must fall back to the envelope, not
    // throw — a throw here blanks the whole screen.
    const withoutNights: Record<string, unknown> = { ...WHOLE_LODGE_ROW };
    delete withoutNights.nights;
    const stale = stateWith({
      bookings: [withoutNights as unknown as DisplayState["bookings"][number]],
    });
    expect(() =>
      evaluateDisplayCondition("occupancy:whole-lodge-today", stale)
    ).not.toThrow();
    expect(evaluateDisplayCondition("occupancy:whole-lodge-today", stale)).toBe(true);
  });

  it("gates capability + chores:today conditions on the payload's module flags", async () => {
    const { evaluateDisplayCondition } = await import(
      "@/lib/lodge-display/conditions"
    );

    const off = stateWith({});
    expect(evaluateDisplayCondition("bed-allocation:enabled", off)).toBe(false);
    expect(evaluateDisplayCondition("chores:enabled", off)).toBe(false);
    expect(evaluateDisplayCondition("chores:today", off)).toBe(false);

    const on = stateWith({
      capabilities: { bedAllocation: true, chores: true },
      chores: [
        { date: "2026-04-13", title: "Dishes", assigneeLabels: ["Jane S"] },
      ],
    });
    expect(evaluateDisplayCondition("bed-allocation:enabled", on)).toBe(true);
    expect(evaluateDisplayCondition("chores:enabled", on)).toBe(true);
    expect(evaluateDisplayCondition("chores:today", on)).toBe(true);

    // Chores enabled but none dated today → chores:today is false.
    const enabledNoneToday = stateWith({
      capabilities: { bedAllocation: false, chores: true },
      chores: [
        { date: "2026-04-20", title: "Dishes", assigneeLabels: ["Jane S"] },
      ],
    });
    expect(evaluateDisplayCondition("chores:today", enabledNoneToday)).toBe(false);
  });

  it("exposes the full registry with families + descriptions and rejects unknown names", async () => {
    const { listDisplayConditions, isDisplayConditionName } = await import(
      "@/lib/lodge-display/conditions"
    );
    const byName = new Map(listDisplayConditions().map((c) => [c.name, c]));

    // Every ADR-003 §3 agreed condition is present with a non-empty description.
    for (const name of [
      "always",
      "occupancy:whole-lodge-today",
      "occupancy:whole-lodge-in-window",
      "occupancy:empty-today",
      "occupancy:arrivals-today",
      "occupancy:departures-today",
      "content:notice",
      "content:instructions",
      "bed-allocation:enabled",
      "chores:enabled",
      "chores:today",
    ]) {
      expect(byName.get(name)?.description.length ?? 0).toBeGreaterThan(0);
      expect(isDisplayConditionName(name)).toBe(true);
    }

    // Capability conditions inherit the module label from MODULE_DEFINITIONS.
    expect(byName.get("bed-allocation:enabled")?.family).toBe("capability");
    expect(byName.get("bed-allocation:enabled")?.description).toContain(
      "Bed allocation"
    );
    expect(byName.get("chores:enabled")?.description).toContain("Chores and roster");

    // The closed registry rejects free-form / reserved names.
    expect(isDisplayConditionName("skifield:available")).toBe(false);
    expect(isDisplayConditionName("if(true)")).toBe(false);
    expect(isDisplayConditionName("notice-set")).toBe(false);
  });
});

describe("template validation (AC6/AC7)", () => {
  it("rejects unknown modules and unknown conditions with descriptive errors", async () => {
    const { validateDisplayTemplateDefinition } = await import(
      "@/lib/lodge-display/template-registry"
    );

    expect(() =>
      validateDisplayTemplateDefinition({
        key: "bad-module",
        name: "Bad",
        regions: [{ key: "main", panels: [{ module: "crypto-miner" }] }],
      })
    ).toThrow(/unknown module "crypto-miner"/);

    expect(() =>
      validateDisplayTemplateDefinition({
        key: "bad-condition",
        name: "Bad",
        regions: [
          { key: "main", panels: [{ module: "welcome", condition: "if(true)" }] },
        ],
      })
    ).toThrow(/unknown condition "if\(true\)"/);
  });

  it("rejects non-scalar options, duplicate regions, and empty structures", async () => {
    const { validateDisplayTemplateDefinition } = await import(
      "@/lib/lodge-display/template-registry"
    );

    expect(() =>
      validateDisplayTemplateDefinition({
        key: "bad-options",
        name: "Bad",
        regions: [
          {
            key: "main",
            panels: [{ module: "welcome", options: { nested: { evil: true } } }],
          },
        ],
      })
    ).toThrow(/must be a scalar/);

    expect(() =>
      validateDisplayTemplateDefinition({
        key: "dupe-regions",
        name: "Bad",
        regions: [
          { key: "main", panels: [{ module: "welcome" }] },
          { key: "main", panels: [{ module: "welcome" }] },
        ],
      })
    ).toThrow(/duplicate region key/);

    expect(() =>
      validateDisplayTemplateDefinition({
        key: "no-regions",
        name: "Bad",
        regions: [],
      })
    ).toThrow(/at least one region/);
  });

  it("accepts the stack layout and rejects unknown layouts (issue hoppers99/AlpineClubBookingsNZ#56)", async () => {
    const { validateDisplayTemplateDefinition } = await import(
      "@/lib/lodge-display/template-registry"
    );

    expect(() =>
      validateDisplayTemplateDefinition({
        key: "stacked",
        name: "Stacked",
        regions: [
          {
            key: "side",
            layout: "stack",
            panels: [{ module: "chores-board" }, { module: "lodge-rules" }],
          },
        ],
      })
    ).not.toThrow();

    expect(() =>
      validateDisplayTemplateDefinition({
        key: "bad-layout",
        name: "Bad",
        regions: [
          { key: "side", layout: "carousel", panels: [{ module: "welcome" }] },
        ],
      })
    ).toThrow(/layout must be "rotate" or "stack"/);
  });
});

describe("registry resolution (AC1/AC2/AC3)", () => {
  it("ships the three validated starter templates", async () => {
    const { listBuiltInDisplayTemplates } = await import(
      "@/lib/lodge-display/template-registry"
    );
    const keys = listBuiltInDisplayTemplates().map((t) => t.key);
    expect(keys).toEqual(["everyday-board", "whole-lodge", "singles-house"]);
    for (const template of listBuiltInDisplayTemplates()) {
      expect(template.regions.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("resolves a built-in by key", async () => {
    const { resolveDisplayTemplate } = await import(
      "@/lib/lodge-display/template-resolution"
    );
    const resolved = resolveDisplayTemplate("everyday-board");
    expect(resolved?.definition.name).toBe("Everyday board");
  });

  it("returns null for an unknown key", async () => {
    const { resolveDisplayTemplate } = await import(
      "@/lib/lodge-display/template-resolution"
    );
    expect(resolveDisplayTemplate("nope")).toBeNull();
  });

  it("resolves a device to its templateKey built-in, else the club default", async () => {
    const { resolveDisplayTemplateForDevice } = await import(
      "@/lib/lodge-display/template-resolution"
    );
    expect(
      resolveDisplayTemplateForDevice({ templateKey: "whole-lodge" }).definition
        .key
    ).toBe("whole-lodge");
    // Unknown or unset key falls back to the everyday-board default.
    expect(
      resolveDisplayTemplateForDevice({ templateKey: null }).definition.key
    ).toBe("everyday-board");
    expect(
      resolveDisplayTemplateForDevice({ templateKey: "gone" }).definition.key
    ).toBe("everyday-board");
  });
});

describe("rotation eligibility (AC4/AC5)", () => {
  it("skips panels whose condition fails and keeps eligible ones in order", async () => {
    const { eligibleDisplayPanels, listBuiltInDisplayTemplates } = await import(
      "@/lib/lodge-display/template-registry"
    );
    const wholeLodgeTemplate = listBuiltInDisplayTemplates().find(
      (t) => t.key === "whole-lodge"
    )!;
    const main = wholeLodgeTemplate.regions.find((r) => r.key === "main")!;

    // No whole-lodge booking → the blockout panel is skipped; welcome remains.
    const quiet = eligibleDisplayPanels(main, stateWith({}));
    expect(quiet.map((p) => p.module)).toEqual(["welcome"]);

    // Whole-lodge booking present → both panels rotate.
    const blockout = eligibleDisplayPanels(
      main,
      stateWith({
        bookings: [
          {
            key: "row-1-0",
            label: "Harakeke College",
            wholeLodge: true,
            roomId: null,
            guests: null,
            guestCount: 14,
            stayStart: "2026-04-13",
            stayEnd: "2026-04-15",
            nights: ["2026-04-13", "2026-04-14"],
            // #2621: no expected arrival time in this fixture.
            arrivalTime: null,
          },
        ],
      })
    );
    expect(blockout.map((p) => p.module)).toEqual(["occupancy-grid", "welcome"]);
  });
});
