"use client";

import type { Dispatch, SetStateAction } from "react";
import Link from "next/link";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DATE_FIELD_NAMES,
  DATE_FIELDS,
  READ_ONLY_FIELD_CLASS,
  SEASON_DATES_HINT,
  type OtherLodgeFormState,
} from "./other-lodge-form";
import { OtherLodgeRateGrid } from "./other-lodge-rate-grid";

// The other-lodge editor's season dates and non-member rates, split out of
// `other-lodges-panel.tsx` to keep that component inside its size budget, with
// the "from the Fees page" switch (#77). The switch is shown for this club's
// own lodge only (the list sends it for no other); while it is on, the dates
// and rates are read-only, because the save fills them from Admin → Fees, and
// each of them is described by the switch's note, so a screen reader says why.

const FEES_HINT_ID = "other-lodge-ratesFromFees-hint";
const SEASON_HINT_ID = "other-lodge-season-hint";

export function OtherLodgeSeasonRates({
  form,
  setForm,
  feesProblem,
}: {
  form: OtherLodgeFormState;
  setForm: Dispatch<SetStateAction<OtherLodgeFormState>>;
  /** Why the Fees page cannot fill this lodge now, from the list (#77). */
  feesProblem?: string;
}) {
  const fromFees = form.ratesFromFees === true;
  return (
    <div className="space-y-4">
      {form.ratesFromFees !== undefined && (
        <div className="space-y-1">
          <label htmlFor="other-lodge-ratesFromFees" className="flex items-center gap-2 text-sm font-medium">
            <Checkbox
              id="other-lodge-ratesFromFees"
              aria-describedby={FEES_HINT_ID}
              checked={fromFees}
              onCheckedChange={(checked) => setForm((prev) => ({ ...prev, ratesFromFees: checked === true }))}
            />
            Rates and season dates from the Fees page
          </label>
          <div id={FEES_HINT_ID} className="space-y-1 text-xs text-muted-foreground">
            {fromFees ? (
              <p>
                Filled when you save, and kept up to date after that, from the Non-Member rates and the seasons
                on{" "}
                <Link href="/admin/fees" target="_blank" rel="noopener noreferrer" className="underline">
                  Fees<span className="sr-only"> (opens in a new tab)</span>
                </Link>
                . Each age group takes your age tier of that built-in name (Infant, Child, Youth or Adult), whatever
                you have labelled it. The values below are the ones last saved. Turn this off to type them here.
              </p>
            ) : (
              <p>Off: type the rates and season dates below. Turn this on to fill them from the Fees page instead.</p>
            )}
            {fromFees && feesProblem && <p className="text-destructive">{feesProblem}</p>}
          </div>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {DATE_FIELD_NAMES.map((field) => (
          <div key={field} className="space-y-2">
            <Label htmlFor={`other-lodge-${field}`}>{DATE_FIELDS[field]}</Label>
            <Input
              id={`other-lodge-${field}`}
              type="date"
              aria-describedby={fromFees ? `${SEASON_HINT_ID} ${FEES_HINT_ID}` : SEASON_HINT_ID}
              readOnly={fromFees}
              className={READ_ONLY_FIELD_CLASS}
              value={form.dates[field]}
              onChange={(event) => setForm((prev) => ({ ...prev, dates: { ...prev.dates, [field]: event.target.value } }))}
            />
          </div>
        ))}
        <p id={SEASON_HINT_ID} className="text-xs text-muted-foreground sm:col-span-2">
          {fromFees ? "Seasons repeat every year: only the day and month are used. The end date is the season's last day." : SEASON_DATES_HINT}
        </p>
      </div>
      <OtherLodgeRateGrid
        rates={form.rates}
        readOnly={fromFees}
        describedBy={fromFees ? FEES_HINT_ID : undefined}
        onRateChange={(field, value) => setForm((prev) => ({ ...prev, rates: { ...prev.rates, [field]: value } }))}
      />
    </div>
  );
}
