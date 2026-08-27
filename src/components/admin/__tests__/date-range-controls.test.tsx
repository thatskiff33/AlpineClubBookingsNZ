// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  fireEvent,
  render,
  screen,
} from "@/lib/__tests__/support/club-time-render";
import { describe, expect, it, vi } from "vitest";
import { DateRangeControls } from "@/components/admin/date-range-controls";
import { reportsDateRangePresets } from "@/lib/date-range-presets";

/**
 * #3123: this control now takes the club's day from `ClubTimeProvider`, and
 * `useClubTime()` throws without one — deliberately, so a tree that forgot to
 * mount it fails loudly. Rendering through `club-time-render` supplies the
 * house default zone, which is what `APP_TIME_ZONE` also resolves to under test,
 * so the two assertions below keep their exact previous meaning.
 *
 * THAT DEFAULT PROVES NOTHING ABOUT ZONE AUTHORITY, and this file does not claim
 * to: it is about the label wiring and the select. The authority claim needs a
 * zone the environment does NOT hold, and lives in
 * `date-range-controls-club-time.test.tsx`.
 */
describe("DateRangeControls", () => {
  it("associates the shared Quick Range label with its select", () => {
    render(
      <DateRangeControls
        presets={reportsDateRangePresets}
        from="2026-04-01"
        to="2026-04-30"
        onFromChange={vi.fn()}
        onToChange={vi.fn()}
        idPrefix="reports-range"
      />,
    );

    expect(screen.getByLabelText("Quick Range")).toBe(
      screen.getByRole("combobox", { name: "Quick Range" }),
    );
    expect(screen.getByLabelText("Quick Range")).toHaveAttribute(
      "id",
      "reports-range-preset",
    );
  });

  it("applies Next Month through the shared select", () => {
    // The suite-wide frozen instant is 2026-07-01T00:00:00.000Z, which is 1 July
    // in the club zone this renders under — so "Next Month" is August. It used
    // to pin its own instant to reach the same assertion through the deleted
    // environment default; the day now comes from the provider, so the frozen
    // clock is enough and no local pin is needed.
    const onFromChange = vi.fn();
    const onToChange = vi.fn();

    render(
      <DateRangeControls
        presets={reportsDateRangePresets}
        from="2026-04-01"
        to="2026-04-30"
        onFromChange={onFromChange}
        onToChange={onToChange}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Quick Range" }), {
      target: { value: "next_month" },
    });

    expect(onFromChange).toHaveBeenCalledWith("2026-08-01");
    expect(onToChange).toHaveBeenCalledWith("2026-08-31");
  });
});
