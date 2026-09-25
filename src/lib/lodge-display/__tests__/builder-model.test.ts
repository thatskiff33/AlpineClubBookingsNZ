import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DisplayState } from "@/lib/lodge-display-state";
import {
  BUILDER_SKELETONS,
  builderAreas,
  builderBodyHtml,
  builderLayout,
  builderSlotContent,
  emptyBuilderModel,
  hasBuilderSignature,
  parseBuilderModel,
  type BuilderModel,
  type BuilderSkeleton,
} from "@/lib/lodge-display/builder-model";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

// buildLayoutRender / the save contract import `server-only`, which throws
// outside an RSC context; stub it (mirrors lodge-display-layout-render.test).
vi.mock("server-only", () => ({}));

let buildLayoutRender: (typeof import("@/lib/lodge-display/layout-render"))["buildLayoutRender"];
let validateLayoutForSave: (typeof import("@/lib/lodge-display/authoring-validation"))["validateLayoutForSave"];
let validateTemplateForSave: (typeof import("@/lib/lodge-display/authoring-validation"))["validateTemplateForSave"];

beforeEach(async () => {
  ({ buildLayoutRender } = await import("@/lib/lodge-display/layout-render"));
  ({ validateLayoutForSave, validateTemplateForSave } = await import(
    "@/lib/lodge-display/authoring-validation"
  ));
});

function state(overrides: Partial<DisplayState> = {}): DisplayState {
  return {
    lodge: { name: "Silverpeak Lodge" },
    club: { name: "Alpine Sports Club", logoUrl: null, logoDataUrl: null },
    generatedAt: "2026-04-13T00:00:00.000Z",
    window: { start: "2026-04-13", days: 3 },
    rooms: null,
    bookings: [],
    occupancy: [],
    chores: [],
    rules: null,
    notice: null,
    config: {},
    capabilities: { bedAllocation: false, chores: false },
    ...overrides,
  } as DisplayState;
}

/** A representative "filled" model per skeleton: modules, html, a conditional
 * zone, and a rotator with a gated child — exercises every model branch. */
function filledModel(skeleton: BuilderSkeleton): BuilderModel {
  if (skeleton === "side-rail") {
    return {
      skeleton,
      zones: [
        {
          key: "main",
          description: "Board",
          kind: "static",
          content: { type: "module", module: "arrivals-board", options: { days: 3 } },
        },
        {
          key: "rail-1",
          description: "Rules",
          kind: "static",
          content: { type: "module", module: "lodge-rules", options: {} },
        },
        {
          key: "rail-2",
          description: "Notice",
          kind: "conditional",
          condition: "content:notice",
          content: { type: "module", module: "notice-board", options: {} },
        },
      ],
    };
  }
  return {
    skeleton,
    zones: [
      {
        key: "zone-1",
        description: "Welcome",
        kind: "static",
        content: { type: "html", html: "<p>Kia ora</p>" },
      },
      {
        key: "zone-2",
        description: "Rotator",
        kind: "rotator",
        rotateSeconds: 12,
        children: [
          {
            key: "slot-1",
            description: "Occupancy",
            condition: null,
            content: { type: "module", module: "occupancy-grid", options: { variant: "board" } },
          },
          {
            key: "slot-2",
            description: "Notice",
            condition: "content:notice",
            content: { type: "module", module: "notice-board", options: {} },
          },
        ],
      },
    ],
  };
}

describe("builder generators — golden output + save-contract validity (ADR-004 §2/§9)", () => {
  it("columns emits the exact signed body for each zone count", () => {
    expect(builderBodyHtml(emptyBuilderModel("columns", 1))).toBe(
      '<div class="dlb-root dlb-cols dlb-cols-1"><div class="dlb-zone">{{area:zone-1}}</div></div>'
    );
    expect(builderBodyHtml(emptyBuilderModel("columns", 3))).toBe(
      '<div class="dlb-root dlb-cols dlb-cols-3">' +
        '<div class="dlb-zone">{{area:zone-1}}</div>' +
        '<div class="dlb-zone">{{area:zone-2}}</div>' +
        '<div class="dlb-zone">{{area:zone-3}}</div>' +
        "</div>"
    );
  });

  it("side-rail emits a main cell + stacked rail", () => {
    expect(builderBodyHtml(emptyBuilderModel("side-rail", 2))).toBe(
      '<div class="dlb-root dlb-rail">' +
        '<div class="dlb-main">{{area:main}}</div>' +
        '<div class="dlb-side">' +
        '<div class="dlb-zone">{{area:rail-1}}</div>' +
        '<div class="dlb-zone">{{area:rail-2}}</div>' +
        "</div></div>"
    );
  });

  for (const skeleton of BUILDER_SKELETONS) {
    for (let count = 1; count <= 3; count++) {
      it(`${skeleton} × ${count}: passes the layout + template save contract and renders`, () => {
        const model = filledModel(skeleton);
        const layout = builderLayout(model);
        const layoutVerdict = validateLayoutForSave({
          bodyHtml: layout.bodyHtml,
          defaultCss: layout.defaultCss,
          areas: layout.areas,
        });
        expect(layoutVerdict.ok).toBe(true);
        // The builder's own CSS must never trip the sanitiser (no warnings).
        expect(layoutVerdict.warnings).toEqual([]);

        const slotContent = builderSlotContent(model);
        const templateVerdict = validateTemplateForSave({
          layout: { bodyHtml: layout.bodyHtml, areas: layout.areas },
          slotContent,
          cssOverrides: "",
          footerHtml: "",
        });
        expect(templateVerdict.ok).toBe(true);

        // A builder-produced layout can never fail buildLayoutRender (§2).
        expect(() =>
          buildLayoutRender(
            {
              bodyHtml: layout.bodyHtml,
              defaultCss: layout.defaultCss,
              areas: layout.areas,
              slotContent,
              cssOverrides: "",
              footerHtml: "",
            },
            state(),
            CLUB_FORMAT_TEST
          )
        ).not.toThrow();
      });
    }
  }
});

describe("builder round-trip — parse(generate(model)) (ADR-004 §4)", () => {
  for (const skeleton of BUILDER_SKELETONS) {
    it(`${skeleton}: a builder layout re-opens byte-equal`, () => {
      const model = filledModel(skeleton);
      const layout = builderLayout(model);
      const slotContent = builderSlotContent(model);
      const result = parseBuilderModel({
        bodyHtml: layout.bodyHtml,
        defaultCss: layout.defaultCss,
        areas: layout.areas,
        slotContent,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The reconstructed model regenerates the identical stored shapes.
      expect(builderBodyHtml(result.model)).toBe(layout.bodyHtml);
      expect(builderAreas(result.model)).toEqual(layout.areas);
      expect(builderSlotContent(result.model)).toEqual(slotContent);
      expect(result.defaultCssCustomised).toBe(false);
    });
  }

  it("flags a customised default CSS but still opens", () => {
    const model = filledModel("columns");
    const layout = builderLayout(model);
    const result = parseBuilderModel({
      bodyHtml: layout.bodyHtml,
      defaultCss: layout.defaultCss + "\n.dlb-zone { color: red; }",
      areas: layout.areas,
      slotContent: builderSlotContent(model),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.defaultCssCustomised).toBe(true);
  });
});

describe("builder round-trip — negative: degrade to Advanced-only, never mutate (ADR-004 §4)", () => {
  it("a signature-less hand-authored body is Advanced-only", () => {
    const result = parseBuilderModel({
      bodyHtml: '<main class="board">{{area:main}}</main>',
      defaultCss: "",
      areas: [{ key: "main", description: "Main", kind: "static" }],
      slotContent: {},
    });
    expect(result).toEqual({ ok: false, reason: "no-signature" });
  });

  it("a #2047 built-in (eb- idiom, defaultContent) is Advanced-only", () => {
    const result = parseBuilderModel({
      bodyHtml:
        '<div class="eb-grid"><div class="eb-board">{{area:board}}</div>' +
        '<div class="eb-rail">{{area:notice}}</div></div>',
      defaultCss: "",
      areas: [
        { key: "board", description: "Board", kind: "static" },
        {
          key: "notice",
          description: "Notice",
          kind: "conditional",
          condition: "content:notice",
        },
      ],
      slotContent: {},
    });
    expect(result.ok).toBe(false);
  });

  it("a forged dlb-root signature on non-conforming HTML is Advanced-only", () => {
    // The signature is present, but the inner structure is hand-written, so the
    // exact round-trip fails and the builder refuses to open it.
    const result = parseBuilderModel({
      bodyHtml:
        '<div class="dlb-root dlb-cols dlb-cols-1"><section>{{area:zone-1}}</section></div>',
      defaultCss: "",
      areas: [{ key: "zone-1", description: "", kind: "static" }],
      slotContent: {},
    });
    expect(result).toEqual({ ok: false, reason: "not-round-trip" });
    expect(hasBuilderSignature('<div class="dlb-root dlb-cols dlb-cols-1"></div>')).toBe(true);
  });

  it("a builder body with a hand-added extra area is Advanced-only", () => {
    const model = emptyBuilderModel("rows", 2);
    const layout = builderLayout(model);
    // Advanced-mode edit: append a stray placeholder + area not in the skeleton.
    const tampered = layout.bodyHtml.replace(
      "</div>",
      "<div>{{area:extra}}</div></div>"
    );
    const result = parseBuilderModel({
      bodyHtml: tampered,
      defaultCss: layout.defaultCss,
      areas: [...(layout.areas as unknown[]), { key: "extra", description: "", kind: "static" }],
      slotContent: {},
    });
    expect(result.ok).toBe(false);
  });
});
