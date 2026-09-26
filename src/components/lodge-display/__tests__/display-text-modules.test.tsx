// @vitest-environment jsdom

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { describe, expect, it } from "vitest";
import {
  renderWithClubFormat as render,
  screen,
} from "@/lib/__tests__/support/club-time-render";
import type { DisplayState } from "@/lib/lodge-display-state";
import { resolveDisplayText } from "@/lib/lodge-display/display-text";
import { ChoresBoard } from "@/components/lodge-display/modules/chores-board";
import { LodgeRules } from "@/components/lodge-display/modules/lodge-rules";
import { DISPLAY_MODULE_COMPONENTS } from "@/components/lodge-display/modules";

// Issue #31 (LTV-006): chores/rules modules and the display text-placeholder
// resolver. Chores render exactly the serialiser's privacy-reduced labels;
// rules render only the sanitised payload HTML; config placeholders resolve
// with a VISIBLE marker for unset keys.

function state(overrides: Partial<DisplayState>): DisplayState {
  return {
    lodge: { name: "Silverpeak Lodge" },
    club: { name: "Alpine Sports Club", logoUrl: null, logoDataUrl: null },
    generatedAt: "2026-04-13T00:00:00.000Z",
    window: { start: "2026-04-13", days: 3 },
    rooms: null,
    bookings: [],
    occupancy: [
      { date: "2026-04-13", arriving: 0, departing: 0, staying: 0 },
    ],
    chores: [],
    rules: null,
    notice: null,
    config: { "wifi-code": "alpine1234" },
    capabilities: { bedAllocation: false, chores: false },
    // #2286: no custodian in residence in the base fixture.
    custodian: null,
    ...overrides,
  };
}

describe("resolveDisplayText (AC3/AC4/AC5/AC6)", () => {
  it("resolves config keys, lodge name, and display date", () => {
    const s = state({});
    expect(resolveDisplayText("Wi-Fi: {{config:wifi-code}}", s, CLUB_FORMAT_TEST)).toBe(
      "Wi-Fi: alpine1234"
    );
    expect(resolveDisplayText("Welcome to {{lodge-name}}", s, CLUB_FORMAT_TEST)).toBe(
      "Welcome to Silverpeak Lodge"
    );
    expect(resolveDisplayText("{{display-date}}", s, CLUB_FORMAT_TEST)).toMatch(/Monday.*13.*April/);
  });

  it("renders a VISIBLE placeholder for an unset config key (AC4)", () => {
    expect(resolveDisplayText("Code: {{config:door-pin}}", state({}), CLUB_FORMAT_TEST)).toBe(
      "Code: ⟨config:door-pin?⟩"
    );
  });

  it("is whitespace/case tolerant and leaves unknown syntax alone", () => {
    const s = state({});
    expect(resolveDisplayText("{{ CONFIG:WIFI-CODE }}", s, CLUB_FORMAT_TEST)).toBe("alpine1234");
    expect(resolveDisplayText("{{something-else}}", s, CLUB_FORMAT_TEST)).toBe("{{something-else}}");
  });

  it("returns plain text — a config value cannot inject markup (renders as text nodes)", () => {
    const s = state({ config: { note: "<img src=x onerror=alert(1)>" } });
    render(<span>{resolveDisplayText("{{config:note}}", s, CLUB_FORMAT_TEST)}</span>);
    // React escaped it: the literal text is present, no img element exists.
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeDefined();
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("ChoresBoard (AC1/AC7)", () => {
  it("renders the serialiser's titles and reduced assignee labels verbatim", () => {
    render(
      <ChoresBoard
        state={state({
          chores: [
            { date: "2026-04-13", title: "Dishes", assigneeLabels: ["Jane S"] },
            {
              date: "2026-04-13",
              title: "Vacuum bunkroom",
              assigneeLabels: ["Organiser family"],
            },
          ],
        })}
      />
    );
    expect(screen.getByText("Dishes")).toBeDefined();
    expect(screen.getByText("Organiser family")).toBeDefined();
  });

  it("renders no card at all when there are no chores (issue #56)", () => {
    const { container } = render(<ChoresBoard state={state({})} />);
    expect(container.querySelector(".display-chores-board-empty")).not.toBeNull();
    expect(container.querySelector(".display-card")).toBeNull();
  });
});

describe("LodgeRules (AC2)", () => {
  it("renders sanitised payload documents", () => {
    render(
      <LodgeRules
        state={state({
          rules: [{ title: "House rules", html: "<p>No boots inside.</p>" }],
        })}
      />
    );
    expect(screen.getByText("House rules")).toBeDefined();
    expect(screen.getByText("No boots inside.")).toBeDefined();
  });

  it("renders an empty shell when no rules exist", () => {
    const { container } = render(<LodgeRules state={state({})} />);
    expect(container.querySelector(".display-lodge-rules-empty")).not.toBeNull();
  });
});

describe("module map", () => {
  it("now includes chores-board and lodge-rules", () => {
    const keys = Object.keys(DISPLAY_MODULE_COMPONENTS);
    expect(keys).toContain("chores-board");
    expect(keys).toContain("lodge-rules");
  });
});
