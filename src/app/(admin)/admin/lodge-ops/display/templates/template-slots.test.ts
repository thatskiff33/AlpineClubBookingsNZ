import { describe, expect, it } from "vitest";
import {
  buildSlots,
  buildSlotContentPayload,
  reseedSlotFromDefault,
  seedSlot,
  type AreaDefinition,
  type SlotDraft,
} from "./template-slots";

// Slot seeding/reseeding for the Template authoring editor (issue #111). These
// are the pure helpers behind "pre-populate a new template's slots with the real
// default, editable from there" and the per-slot "Reset to default" control.

// The everyday-board areas as the layouts API serves them post-#111: each
// static/conditional area now declares its default module.
const everydayAreas: AreaDefinition[] = [
  {
    key: "board",
    description: "The arrivals / bar board.",
    kind: "static",
    defaultContent: { module: "arrivals-board", options: { days: 3 } },
  },
  {
    key: "chores",
    description: "Today's chores card.",
    kind: "static",
    defaultContent: { module: "chores-board" },
  },
  {
    key: "notice",
    description: "Committee notice.",
    kind: "conditional",
    defaultContent: { module: "notice-board" },
  },
];

// A rotator layout (whole-lodge shape): its children carry no defaultContent.
const rotatorAreas: AreaDefinition[] = [
  {
    key: "main",
    description: "Rotating statement.",
    kind: "rotator",
    children: [
      { key: "welcome", description: "Welcome panel." },
      { key: "notice", description: "Committee notice." },
    ],
  },
];

describe("buildSlots — seeding a new template from layout defaults (issue #111)", () => {
  it("seeds each static/conditional slot from the area's defaultContent, not empty", () => {
    const slots = buildSlots(everydayAreas);
    expect(slots.map((s) => s.slotKey)).toEqual(["board", "chores", "notice"]);

    const board = slots.find((s) => s.slotKey === "board")!;
    expect(board.mode).toBe("module");
    expect(board.moduleName).toBe("arrivals-board");
    expect(board.options).toEqual([{ key: "days", value: "3" }]);
    expect(board.html).toBe("");

    const chores = slots.find((s) => s.slotKey === "chores")!;
    expect(chores.mode).toBe("module");
    expect(chores.moduleName).toBe("chores-board");

    // No slot seeds to an empty HTML box — the pre-#111 bug this fixes.
    for (const slot of slots) {
      expect(slot).not.toMatchObject({ mode: "html", moduleName: "", html: "" });
    }
  });

  it("retains the area default on each slot so the editor can offer a reset", () => {
    const slots = buildSlots(everydayAreas);
    expect(slots.find((s) => s.slotKey === "board")!.defaultContent).toEqual({
      module: "arrivals-board",
      options: { days: 3 },
    });
  });

  it("round-trips a default-seeded template back to the original slotContent", () => {
    // A new template saved unchanged reproduces the built-in's slot bindings.
    const slots = buildSlots(everydayAreas);
    expect(buildSlotContentPayload(slots)).toEqual({
      board: { module: "arrivals-board", options: { days: "3" } },
      chores: { module: "chores-board" },
      notice: { module: "notice-board" },
    });
  });

  it("prefers stored template slotContent over the layout default", () => {
    const slots = buildSlots(everydayAreas, {
      board: { html: "<p>Custom</p>" },
    });
    const board = slots.find((s) => s.slotKey === "board")!;
    expect(board.mode).toBe("html");
    expect(board.html).toBe("<p>Custom</p>");
    // The default is still retained so the author can reset back to it.
    expect(board.defaultContent).toEqual({
      module: "arrivals-board",
      options: { days: 3 },
    });
  });

  it("seeds rotator children empty and gives them no default (out of scope for #111)", () => {
    const slots = buildSlots(rotatorAreas);
    expect(slots.map((s) => s.slotKey)).toEqual(["main/welcome", "main/notice"]);
    for (const slot of slots) {
      expect(slot.mode).toBe("html");
      expect(slot.moduleName).toBe("");
      expect(slot.html).toBe("");
      expect(slot.defaultContent).toBeUndefined();
    }
  });
});

describe("reseedSlotFromDefault — the per-slot reset control (issue #111)", () => {
  function editedSlot(defaultContent: SlotDraft["defaultContent"]): SlotDraft {
    // A slot the author has typed HTML into, that still remembers its default.
    return {
      slotKey: "board",
      label: "board",
      description: "",
      mode: "html",
      html: "<p>hand-edited</p>",
      moduleName: "",
      options: [],
      defaultContent,
    };
  }

  it("restores a slot's editor fields to its layout default", () => {
    const reset = reseedSlotFromDefault(
      editedSlot({ module: "arrivals-board", options: { days: 3 } })
    );
    expect(reset).toMatchObject({
      slotKey: "board",
      mode: "module",
      moduleName: "arrivals-board",
      html: "",
      options: [{ key: "days", value: "3" }],
    });
    // Identity fields and the remembered default are preserved.
    expect(reset.defaultContent).toEqual({
      module: "arrivals-board",
      options: { days: 3 },
    });
  });

  it("matches what seedSlot produces from the same default", () => {
    const dflt = { module: "chores-board" as const };
    const reset = reseedSlotFromDefault(editedSlot(dflt));
    const { mode, html, moduleName, options } = reset;
    expect({ mode, html, moduleName, options }).toEqual(seedSlot(dflt));
  });

  it("resets to an empty HTML box when the slot has no default", () => {
    const reset = reseedSlotFromDefault(editedSlot(undefined));
    expect(reset).toMatchObject({
      mode: "html",
      html: "",
      moduleName: "",
      options: [],
    });
  });
});
