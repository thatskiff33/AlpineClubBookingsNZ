// @vitest-environment jsdom

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * #3123 — the quick-range presets are relative to the CLUB's day, and the club's
 * day reaches this control as data.
 *
 * ## What was wrong
 *
 * `date-range-presets.ts` defaulted its `today` argument to
 * `getTodayDateOnly()`, i.e. `APP_TIME_ZONE`. This control is the module's ONLY
 * caller and it is `"use client"`, so that constant was `NEXT_PUBLIC_TZ` as
 * baked into the bundle at build time — not the club's persisted zone
 * (`INV-CONFIG-002`), and not even the container's. Neither zone reader can be
 * imported into a browser bundle, so the day has to arrive through
 * `ClubTimeProvider`; the default was deleted rather than policed, so no future
 * caller can silently reacquire the environment's answer.
 *
 * ## DISCRIMINATION
 *
 * The environment zone is modelled as `America/Denver` (the `APP_TIME_ZONE`
 * constant this file used to pin there was deleted in #3567, and nothing reads
 * the environment's zone any more) and the provider is given a zone that model
 * does NOT claim, then MOVED between assertions. The frozen
 * instant is `2026-07-01T00:00:00.000Z`, which is **30 June** in Denver and
 * **1 July** in Auckland — so "This Month" is June for the environment's answer
 * and July for the club's, and the two can never be confused. A suite passing
 * the zone the environment already holds could not tell the persisted zone from
 * the environment zone (#3123 execution contract).
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ClubTimeProvider } from "@/components/club-time-provider";
import { DateRangeControls } from "@/components/admin/date-range-controls";
import { bookingFilterDateRangePresets } from "@/lib/date-range-presets";

const ENVIRONMENT_ZONE = "America/Denver";
/** 1 July at the frozen instant, so "This Month" is July. */
const CLUB_AHEAD = "Pacific/Auckland";
/** Also 1 July, and NOT the zone above — so a hard-coded Auckland still fails. */
const CLUB_FURTHER_AHEAD = "Pacific/Kiritimati";
/** Still 30 June, so "This Month" is June — the environment's own answer. */
const CLUB_BEHIND = "Pacific/Pago_Pago";

function renderControls(zone: string) {
  const onFromChange = vi.fn();
  const onToChange = vi.fn();
  render(
    <ClubTimeProvider zone={zone} locale={CLUB_FORMAT_TEST.locale}>
      <DateRangeControls
        presets={bookingFilterDateRangePresets}
        from=""
        to=""
        onFromChange={onFromChange}
        onToChange={onToChange}
      />
    </ClubTimeProvider>,
  );
  return { onFromChange, onToChange };
}

function chooseThisMonth() {
  fireEvent.change(screen.getByLabelText("Quick Range"), {
    target: { value: "this_month" },
  });
}

afterEach(() => {
  cleanup();
});

describe("PREMISE: the club and the container disagree about the month", () => {
  it("models the environment as a zone still on 30 June", () => {
    const now = new Date();
    expect(
      new Intl.DateTimeFormat("en-CA", { timeZone: ENVIRONMENT_ZONE }).format(now),
    ).toBe("2026-06-30");
    expect(
      new Intl.DateTimeFormat("en-CA", { timeZone: CLUB_AHEAD }).format(now),
    ).toBe("2026-07-01");
  });
});

describe('"This Month" is the club\'s month', () => {
  it("resolves to July for a club that has reached 1 July", () => {
    // BEFORE #3123 the preset read `APP_TIME_ZONE` from the CLIENT bundle and
    // filled in JUNE — the previous month — for a club whose day is 1 July.
    const { onFromChange, onToChange } = renderControls(CLUB_AHEAD);
    chooseThisMonth();
    expect(onFromChange).toHaveBeenCalledWith("2026-07-01");
    expect(onToChange).toHaveBeenCalledWith("2026-07-31");
  });

  it("resolves to June for a club whose own day is still 30 June", () => {
    const { onFromChange, onToChange } = renderControls(CLUB_BEHIND);
    chooseThisMonth();
    expect(onFromChange).toHaveBeenCalledWith("2026-06-01");
    expect(onToChange).toHaveBeenCalledWith("2026-06-30");
  });

  it("follows the provided zone when it MOVES — kills a hard-coded Pacific/Auckland", () => {
    const ahead = renderControls(CLUB_FURTHER_AHEAD);
    chooseThisMonth();
    expect(ahead.onFromChange).toHaveBeenCalledWith("2026-07-01");
    cleanup();
    const behind = renderControls(CLUB_BEHIND);
    chooseThisMonth();
    expect(behind.onFromChange).toHaveBeenCalledWith("2026-06-01");
  });
});

describe("the selected-preset LABEL is chosen against the club's day too", () => {
  function renderWithRange(zone: string, from: string, to: string) {
    render(
      <ClubTimeProvider zone={zone} locale={CLUB_FORMAT_TEST.locale}>
        <DateRangeControls
          presets={bookingFilterDateRangePresets}
          from={from}
          to={to}
          onFromChange={vi.fn()}
          onToChange={vi.fn()}
        />
      </ClubTimeProvider>,
    );
    return screen.getByLabelText("Quick Range") as HTMLSelectElement;
  }

  it("names July's range 'This Month' for one club and 'Next Month' for another, at the same instant", () => {
    expect(renderWithRange(CLUB_AHEAD, "2026-07-01", "2026-07-31").value).toBe(
      "this_month",
    );
    cleanup();
    // The same range and the same instant, a different club. This one has not
    // reached July, so July really is its NEXT month — a different label for
    // the same dates, which is the sharpest form this claim can take: the
    // control is reading the club, not the calendar.
    expect(renderWithRange(CLUB_BEHIND, "2026-07-01", "2026-07-31").value).toBe(
      "next_month",
    );
  });
});
