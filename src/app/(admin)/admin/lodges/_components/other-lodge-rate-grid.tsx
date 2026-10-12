"use client";

import { MoneyInput } from "@/components/ui/money-input";
import type { OtherLodgeRateField } from "@/lib/other-lodges";
import {
  RATE_AGE_GROUPS,
  RATE_FIELD_NAMES,
  RATE_FIELDS,
  rateFieldLabel,
} from "./other-lodge-form";

// The non-member rate grid in the other-lodge editor (#61): Winter and Summer
// rows by the four guideline age groups. Split out of `other-lodges-panel.tsx`
// to keep that component inside its size budget. Each cell is a `MoneyInput`
// holding the typed dollars; the form model parses them to cents on save.

const SEASONS = ["Winter", "Summer"] as const;

function fieldFor(
  season: (typeof SEASONS)[number],
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
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">
        Non-member rates per person per night (NZD, incl. GST)
      </legend>
      <p className="text-xs text-muted-foreground">
        Shown on the Alpine Central Server&apos;s public lodge search. Leave a
        rate blank if it is not known.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[28rem] text-sm">
          <thead>
            <tr>
              <th scope="col" className="sr-only">
                Season
              </th>
              {RATE_AGE_GROUPS.map((ageGroup) => (
                <th
                  key={ageGroup}
                  scope="col"
                  className="px-1 pb-1 text-left font-normal text-muted-foreground"
                >
                  {ageGroup}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SEASONS.map((season) => (
              <tr key={season}>
                <th scope="row" className="pr-2 text-left font-normal">
                  {season}
                </th>
                {RATE_AGE_GROUPS.map((ageGroup) => {
                  const field = fieldFor(season, ageGroup);
                  return (
                    <td key={field} className="px-1 py-1">
                      <MoneyInput
                        id={`other-lodge-${field}`}
                        aria-label={rateFieldLabel(field)}
                        value={rates[field]}
                        onValueChange={(value) => onRateChange(field, value)}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </fieldset>
  );
}
