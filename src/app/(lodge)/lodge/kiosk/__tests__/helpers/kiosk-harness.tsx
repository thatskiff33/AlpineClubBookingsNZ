import { act, render } from "@testing-library/react";

import { ClubTimeProvider } from "@/components/club-time-provider";
import { LodgePinSessionProvider } from "@/components/lodge-pin-session";

import KioskPage from "../../page";
import {
  buildWeekDateKeys,
  type KioskWeekDaySummary,
} from "../../_components/kiosk-week-view";

/**
 * The bits of kiosk test scaffolding all three suites in this directory need.
 *
 * They each grew their own copy of the same four things, and by the third file
 * that is a third place to update when the page's provider set changes — which
 * is exactly what happened when #3228 added one. The `vi.mock` factories stay in
 * each file, because `vi.mock` is hoisted per module and cannot be shared; the
 * plain helpers do not have that constraint.
 *
 * Not a `.test.tsx` file, so the runner does not collect it and the source
 * censuses (which skip `__tests__`) do not scan it.
 */

/** The club this kiosk belongs to. Delivered the way the application does it. */
export const CLUB_ZONE = "Pacific/Auckland";

/**
 * The kiosk, inside the providers the real route puts around it.
 *
 * `LodgePinSessionProvider` is `src/app/(lodge)/layout.tsx`'s, and it is not
 * optional: the page reads the context and throws without it. That is
 * deliberate — a page that quietly loses PIN-session renewal is the defect
 * #3228's review found, so the failure is loud.
 *
 * `initialPinSessionActive` mirrors what the server tells the layout by reading
 * the cookie. It defaults to false because that is a wall tablet's resting
 * state; a suite that starts from a PIN already typed passes true.
 */
export function renderKiosk(
  options: { initialPinSessionActive?: boolean } = {},
) {
  return render(
    <ClubTimeProvider zone={CLUB_ZONE}>
      <LodgePinSessionProvider
        initialActive={options.initialPinSessionActive === true}
      >
        <KioskPage />
      </LodgePinSessionProvider>
    </ClubTimeProvider>,
  );
}

/** A full, all-accessible week of summaries for the week route's answer. */
export function weekDays(start: string): KioskWeekDaySummary[] {
  return buildWeekDateKeys(start).map((date) => ({
    date,
    accessible: true,
    guestCount: 1,
    arrivingCount: 1,
    departingCount: 0,
    rosterStatus: "needs-roster" as const,
  }));
}

/**
 * Drains the page's chained fetches without `waitFor`.
 *
 * `setInterval` is faked in the suites that use this, and `waitFor` polls on a
 * real interval — so under a faked one it can only be woken by a DOM mutation,
 * which is the near-miss shape that reports green. `setTimeout` stays real, so
 * awaiting a macrotask inside `act` flushes both the microtask queue and React's
 * effects.
 */
export async function settleKiosk(rounds = 6): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
