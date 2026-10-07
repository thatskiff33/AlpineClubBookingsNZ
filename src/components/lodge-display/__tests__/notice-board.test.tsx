// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@/lib/__tests__/support/club-time-render";
import type { DisplayState } from "@/lib/lodge-display-state";
import { NoticeBoard } from "@/components/lodge-display/modules/notice-board";
import { DISPLAY_MODULE_COMPONENTS } from "@/components/lodge-display/modules";
import { evaluateDisplayCondition } from "@/lib/lodge-display/conditions";

// Issue #36 (LTV-011): the committee notice board — text-node-only rendering
// (a notice can never inject markup), config placeholder resolution inside
// the notice, empty-notice skippability via the content:notice condition.

function state(overrides: Partial<DisplayState>): DisplayState {
  return {
    lodge: { name: "Silverpeak Lodge" },
    club: { name: "Alpine Sports Club", logoUrl: null, logoDataUrl: null },
    generatedAt: "2026-04-13T00:00:00.000Z",
    window: { start: "2026-04-13", days: 3 },
    rooms: null,
    bookings: [],
    occupancy: [{ date: "2026-04-13", arriving: 0, departing: 0, staying: 0 }],
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

describe("NoticeBoard (issue #36)", () => {
  it("renders paragraphs with resolved placeholders (AC2/AC5 path)", () => {
    render(
      <NoticeBoard
        state={state({
          notice:
            "Working bee this Sunday.\nWi-Fi is {{config:wifi-code}} — see the kiosk.",
        })}
      />
    );
    expect(screen.getByText("Committee notice")).toBeDefined();
    expect(screen.getByText("Working bee this Sunday.")).toBeDefined();
    expect(screen.getByText(/Wi-Fi is alpine1234/)).toBeDefined();
  });

  it("renders markup in a notice as inert text — never HTML (AC2)", () => {
    const { container } = render(
      <NoticeBoard
        state={state({ notice: '<img src=x onerror=alert(1)> Meeting at 5' })}
      />
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("renders nothing visible for an empty notice (AC3)", () => {
    const { container } = render(<NoticeBoard state={state({})} />);
    expect(container.querySelector(".display-notice-empty")).not.toBeNull();
    expect(container.textContent).toBe("");
  });

  it("is registered in the module map and skippable via content:notice (AC3)", () => {
    expect(DISPLAY_MODULE_COMPONENTS["notice-board"]).toBeDefined();
    expect(evaluateDisplayCondition("content:notice", state({}))).toBe(false);
    expect(
      evaluateDisplayCondition("content:notice", state({ notice: "Hello" }))
    ).toBe(true);
  });
});
