"use client";

import { MoneyInput } from "@/components/ui/money-input";
import { OTHER_LODGE_BOUNDS, type OtherLodgeRateField } from "@/lib/other-lodges";
import {
  RATE_AGE_GROUPS,
  RATE_FIELD_NAMES,
  RATE_FIELDS,
  RATE_SEASONS,
} from "./other-lodge-form";

// The non-member rates in the other-lodge editor (#61): a block per season, a
// cell per guideline age group. Split out of `other-lodges-panel.tsx` to keep
// that component inside its size budget. Each cell is a `MoneyInput` holding
// the typed dollars; the form model parses them to cents on save. The cells
// wrap two to a row on a phone and sit four across from `sm`, so the dialog
// never scrolls sideways (a fixed four-column table did, on a 375px screen).

function fieldFor(
  season: (typeof RATE_SEASONS)[number],
  ageGroup: (typeof RATE_AGE_GROUPS)[number],
): OtherLodgeRateField {
  const field = RATE_FIELD_NAMES.find(
    (f) => RATE_FIELDS[f].season === season && RATE_FIELDS[f].ageGroup === ageGroup,
  );
  // RATE_FIELDS is a Record over every rate field and names each (season, age
  // group) pair once, so a miss is a programming error, not a data case.
  if (!field) throw new Error(`No rate field for ${season} ${ageGroup}`);
  return field;
}

export function OtherLodgeRateGrid({
  rates,
  onRateChange,
}: {
  rates: Record<OtherLodgeRateField, string>;
  onRateChange: (field: OtherLodgeRateField, value: string) => void;
}) {
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">
        Non-member rates per person per night (NZD, incl. GST)
      </legend>
      <p className="text-xs text-muted-foreground">
        Shown on the Alpine Central Server&apos;s public lodge search. Leave a
        rate blank if it is not known.
      </p>
      {RATE_SEASONS.map((season) => (
        <div key={season} role="group" aria-label={`${season} rates`} className="space-y-1">
          <p aria-hidden="true" className="text-sm">
            {season}
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {RATE_AGE_GROUPS.map((ageGroup) => {
              const field = fieldFor(season, ageGroup);
              return (
                <div key={field} className="space-y-1">
                  {/* The visible label is the age group; the season is in it
                      for screen readers only, since "18+" alone is ambiguous
                      twice over in this dialog. It must be IN the label, not
                      an aria-label: `MoneyInput` names its step buttons from
                      the field's <label>, so this is what makes them read
                      "Increase Winter rate, 18+ by one dollar". */}
                  <label
                    htmlFor={`other-lodge-${field}`}
                    className="block text-xs text-muted-foreground"
                  >
                    <span className="sr-only">{RATE_FIELDS[field].season} rate, </span>
                    {ageGroup}
                  </label>
                  <MoneyInput
                    id={`other-lodge-${field}`}
                    minCents={0}
                    maxCents={OTHER_LODGE_BOUNDS.rateCentsMax}
                    value={rates[field]}
                    onValueChange={(value) => onRateChange(field, value)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </fieldset>
  );
}
