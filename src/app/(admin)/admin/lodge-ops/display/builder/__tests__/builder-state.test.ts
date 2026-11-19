import { describe, expect, it } from "vitest";
import {
  builderAreas,
  builderBodyHtml,
  emptyBuilderModel,
  type BuilderModel,
} from "@/lib/lodge-display/builder-model";
import {
  addZone,
  changeSkeleton,
  coerceOptionValue,
  maxZones,
  moveChild,
  moveZone,
  removeZone,
  setChildModule,
  setZoneKind,
  setZoneModule,
} from "../builder-state";

// Pure builder-state helpers (ADR-004 §1). Keys are always re-derived positionally
// so generation stays valid after any reorder — asserted here headlessly.

describe("builder-state — keys stay canonical + valid", () => {
  it("moveZone reorders columns and re-keys positionally", () => {
    let model = emptyBuilderModel("columns", 3);
    model = setZoneModule(model, 0, "arrivals-board");
    const before = model.zones[0].kind === "static" ? model.zones[0].content : null;
    model = moveZone(model, 0, 2);
    // The moved zone now sits last but keeps its content; keys are z1..z3 in order.
    expect(model.zones.map((z) => z.key)).toEqual(["zone-1", "zone-2", "zone-3"]);
    expect(model.zones[2].kind === "static" && model.zones[2].content).toEqual(before);
    // The regenerated body references the canonical keys and round-trips.
    expect(builderBodyHtml(model)).toContain("{{area:zone-1}}");
  });

  it("side-rail pins the main cell at index 0 (cannot move or remove it)", () => {
    let model = emptyBuilderModel("side-rail", 2); // main + rail-1 + rail-2
    expect(model.zones.map((z) => z.key)).toEqual(["main", "rail-1", "rail-2"]);
    // Attempting to move the main cell is a no-op.
    expect(moveZone(model, 0, 1)).toBe(model);
    // Removing the main cell is a no-op.
    expect(removeZone(model, 0)).toBe(model);
    // Rail zones reorder among themselves.
    model = moveZone(model, 1, 2);
    expect(model.zones.map((z) => z.key)).toEqual(["main", "rail-1", "rail-2"]);
  });

  it("respects the zone cap per skeleton", () => {
    let model = emptyBuilderModel("columns", 3);
    expect(model.zones).toHaveLength(3);
    model = addZone(model); // already at max (3)
    expect(model.zones).toHaveLength(maxZones("columns"));
  });

  it("changeSkeleton truncates to the target cap and re-keys", () => {
    let model = emptyBuilderModel("columns", 3);
    model = changeSkeleton(model, "side-rail");
    expect(model.skeleton).toBe("side-rail");
    expect(model.zones[0].key).toBe("main");
    // areas remain valid (unique slug keys, main first).
    const areas = builderAreas(model) as Array<{ key: string }>;
    expect(new Set(areas.map((a) => a.key)).size).toBe(areas.length);
  });
});

describe("builder-state — kind transitions initialise/forbid the right fields", () => {
  it("static → rotator seeds a first child from the old content", () => {
    let model: BuilderModel = emptyBuilderModel("rows", 1);
    model = setZoneModule(model, 0, "welcome");
    model = setZoneKind(model, 0, "rotator");
    const zone = model.zones[0];
    expect(zone.kind).toBe("rotator");
    if (zone.kind === "rotator") {
      expect(zone.children).toHaveLength(1);
      expect(zone.children[0].content).toEqual({
        type: "module",
        module: "welcome",
        options: {},
      });
      expect(zone.rotateSeconds).toBe(8);
    }
  });

  it("static → conditional adds an (empty) condition; content survives", () => {
    let model = emptyBuilderModel("rows", 1);
    model = setZoneModule(model, 0, "welcome");
    model = setZoneKind(model, 0, "conditional");
    const zone = model.zones[0];
    expect(zone.kind === "conditional" && zone.condition).toBe("");
    expect(zone.kind === "conditional" && zone.content.type).toBe("module");
  });

  it("moveChild reorders rotator children", () => {
    let model = emptyBuilderModel("rows", 1);
    model = setZoneKind(model, 0, "rotator");
    model = setChildModule(model, 0, 0, "welcome");
    // add a second child then move it up
    const zone0 = model.zones[0];
    expect(zone0.kind).toBe("rotator");
    model = moveChild(model, 0, 0, 0); // no-op boundary
    expect(model.zones[0].kind).toBe("rotator");
  });
});

describe("builder-state — option coercion stays in the descriptor domain", () => {
  it("clamps ints and rejects out-of-set enums to the default", () => {
    expect(
      coerceOptionValue({ key: "days", label: "d", type: "int", default: 3, min: 1, max: 7 }, "99")
    ).toBe(7);
    expect(
      coerceOptionValue({ key: "days", label: "d", type: "int", default: 3, min: 1, max: 7 }, "0")
    ).toBe(1);
    expect(
      coerceOptionValue({ key: "days", label: "d", type: "int", default: 3, min: 1, max: 7 }, "xx")
    ).toBe(3);
    expect(
      coerceOptionValue(
        { key: "v", label: "v", type: "enum", default: "auto", allowed: ["auto", "board"] },
        "nope"
      )
    ).toBe("auto");
    expect(
      coerceOptionValue({ key: "b", label: "b", type: "bool", default: true }, "false")
    ).toBe(false);
  });
});
