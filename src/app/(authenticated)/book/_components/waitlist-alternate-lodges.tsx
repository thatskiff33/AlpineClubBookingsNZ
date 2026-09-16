"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { type LodgeOption } from "@/components/lodge-select";

/**
 * "Happy to stay at another lodge if a spot opens there first?" (ADR-004), in
 * ONE place, on both paths that can put a member on the waitlist (#2930).
 *
 * IT USED TO LIVE INSIDE THE REFUSAL PROMPT and nowhere else, which was fine
 * while that prompt was the only door to the waitlist. #2930 made Join Waitlist
 * the review step's primary action whenever the advisory says the stay cannot be
 * confirmed, and that button never raises the prompt — so the checkboxes were
 * not on screen, `waitlistAlternateLodgeIds` stayed empty, and no alternates
 * were sent. Which member got the option then depended on whether the
 * availability check had resolved in time: a member the advisory caught went
 * straight to the waitlist without it, a member it missed hit the 409 and saw
 * it. An option that arbitrary is worse than one that is absent.
 *
 * Rendered by the route shell rather than by either step, because the lodge list
 * and the opt-in state live in the wizard hook and the steps are presentational.
 *
 * Returns null when there is no second eligible lodge to offer, so both call
 * sites can render it unconditionally.
 */
export function WaitlistAlternateLodges({
  lodges,
  lodgeId,
  waitlistAlternateLodgeIds,
  setWaitlistAlternateLodgeIds,
  disabled,
}: {
  lodges: LodgeOption[];
  lodgeId: string | null;
  waitlistAlternateLodgeIds: string[];
  setWaitlistAlternateLodgeIds: (
    update: (current: string[]) => string[],
  ) => void;
  disabled: boolean;
}) {
  const alternates = lodges.filter((lodge) => lodge.id !== lodgeId);
  if (lodges.length <= 1 || alternates.length === 0) return null;

  return (
    <div className="rounded-md border border-cat1-6 bg-card p-4 space-y-2">
      <p className="text-sm font-medium text-cat1-11">
        Happy to stay at another lodge if a spot opens there first?
      </p>
      {alternates.map((lodge) => (
        <label
          key={lodge.id}
          className="flex items-center gap-2 text-sm text-cat1-11 cursor-pointer"
        >
          <Checkbox
            checked={waitlistAlternateLodgeIds.includes(lodge.id)}
            onCheckedChange={(checked) =>
              setWaitlistAlternateLodgeIds((current) =>
                checked
                  ? [...current, lodge.id]
                  : current.filter((id) => id !== lodge.id),
              )
            }
            className="border-cat1-6"
            disabled={disabled}
          />
          Also waitlist me for {lodge.name}
        </label>
      ))}
      <p className="text-xs text-cat1-11">
        Prices can differ between lodges. If a spot opens at one of these,
        we&apos;ll email you that lodge&apos;s price for your stay &mdash;
        nothing is booked until you confirm it.
      </p>
    </div>
  );
}
