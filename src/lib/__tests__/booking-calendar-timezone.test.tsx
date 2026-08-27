// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ lodgeCapacity: 20 }),
}));

import { BookingCalendar } from "@/components/booking-calendar";
import { captureHostTimeZone } from "@/lib/__tests__/helpers/timezone";

// #2474 — a lodge night is an abstract calendar day, and its identity (the value
// SUBMITTED and the club-pinned label DISPLAYED) must be the same for a booker in
// ANY browser timezone. The old encoding built `new Date(year, month, day)` —
// midnight where the BROWSER sits — so a booker east of New Zealand submitted, or
// was shown, the previous night; the #2264 sweep patched the display half while
// the fragile encoding lived on. This pins the whole identity across a zone
// behind NZ, at NZ, and ahead of NZ, on the night NZ daylight saving begins.
//
// Frozen test clock = 2026-07-01 (midday NZ), so September 2026 is future in
// every browser zone. 27 Sep 2026 is the NZ DST-start night (clocks jump
// 02:00 → 03:00), the DST-transition night the matrix calls for.
const DST_NIGHT = "2026-09-27";
const NEXT_NIGHT = "2026-09-28";

const hostTimeZone = captureHostTimeZone();

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // Restore the host zone properly (the #2485 hazard: a bare
  // `delete process.env.TZ` does not invalidate Node's cached zone, whether
  // or not the host originally had one set).
  hostTimeZone.restore();
});

function stubEmptyAvailability() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ availability: {}, seasons: {} }),
    })),
  );
}

function findDayButton(daySeptember: number): HTMLElement | undefined {
  // Key off the VISIBLE day-number span (the first `aria-hidden` child), NOT the
  // aria-label — the label is exactly what this suite asserts, so the finder must
  // not depend on it (or a regressed label would silently pick a different cell).
  return screen.getAllByRole("button").find((el) => {
    const dayNumber = el.querySelector('span[aria-hidden="true"]');
    return dayNumber?.textContent === String(daySeptember);
  });
}

async function selectDstNightInZone(tz: string) {
  process.env.TZ = tz;
  stubEmptyAvailability();
  const onDateSelect = vi.fn<(ci: string, co: string) => void>();
  render(<BookingCalendar onDateSelect={onDateSelect} />);
  await waitFor(() =>
    expect(screen.getByText(/Select check-in date/)).toBeTruthy(),
  );

  // The initial month follows the CLUB's day since CT-4 (#2870) - it used to
  // follow the browser's own clock - so step forward to the "September 2026"
  // heading rather than assuming a click count. Either way the count is not the
  // thing under test here; the day IDENTITY is.
  for (let i = 0; i < 6 && !screen.queryByText("September 2026"); i++) {
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
  }
  await waitFor(() => expect(screen.getByText("September 2026")).toBeTruthy());

  const btn27 = await waitFor(() => {
    const found = findDayButton(27);
    if (!found) throw new Error("27 September button not found");
    return found;
  });
  const label = btn27.getAttribute("aria-label") ?? "";

  fireEvent.click(btn27);
  const btn28 = findDayButton(28);
  if (!btn28) throw new Error("28 September button not found");
  fireEvent.click(btn28);

  await waitFor(() => expect(onDateSelect).toHaveBeenCalledTimes(1));
  return { emitted: onDateSelect.mock.calls[0], label };
}

describe("BookingCalendar lodge-night identity across browser zones (#2474)", () => {
  it("submits and displays the same DST-transition night in a zone behind, at, and ahead of NZ", async () => {
    // Pacific/Auckland (at NZ), America/Los_Angeles (UTC-behind), and
    // Pacific/Kiritimati (UTC+14, ahead of NZ — where the old local-midnight
    // encoding rolled a night backwards).
    const auckland = await selectDstNightInZone("Pacific/Auckland");
    cleanup();
    vi.unstubAllGlobals();
    const losAngeles = await selectDstNightInZone("America/Los_Angeles");
    cleanup();
    vi.unstubAllGlobals();
    const kiritimati = await selectDstNightInZone("Pacific/Kiritimati");

    // The SUBMITTED value names the picked night, identically in every zone.
    expect(auckland.emitted).toEqual([DST_NIGHT, NEXT_NIGHT]);
    expect(losAngeles.emitted).toEqual([DST_NIGHT, NEXT_NIGHT]);
    expect(kiritimati.emitted).toEqual([DST_NIGHT, NEXT_NIGHT]);

    // The club-pinned DISPLAY label is identical in every zone too, and names the
    // 27th — not a neighbouring day. (Cross-zone equality is what reddens if the
    // encoding regresses to a local-midnight `Date`, independent of what the
    // club/runner zone happens to be.)
    expect(losAngeles.label).toBe(auckland.label);
    expect(kiritimati.label).toBe(auckland.label);
    expect(auckland.label).toContain("27 September 2026");
  });
});
