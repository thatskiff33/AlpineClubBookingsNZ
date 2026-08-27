"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  CUSTOM_DATE_RANGE_KEY,
  type DateRangePreset,
  findMatchingDateRangePreset,
  getDateRangeForPreset,
} from "@/lib/date-range-presets";
import { useClubTime } from "@/components/club-time-provider";
import { dateOnlyInstantOf } from "@/lib/club-time";

interface DateRangeControlsProps {
  presets: readonly DateRangePreset[];
  from: string;
  to: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  presetLabel?: string;
  fromLabel?: string;
  toLabel?: string;
  idPrefix?: string;
}

export function DateRangeControls({
  presets,
  from,
  to,
  onFromChange,
  onToChange,
  presetLabel = "Quick Range",
  fromLabel = "From",
  toLabel = "To",
  idPrefix = "date-range",
}: DateRangeControlsProps) {
  /**
   * The club's day, delivered to the browser as data (#3123). Every preset in
   * this control is relative to "today", and until now that came from
   * `NEXT_PUBLIC_TZ` as baked into the bundle — the VIEWER's build, not the
   * club's persisted zone (`INV-CONFIG-002`). Encoded as the UTC-midnight
   * `Date` the preset arithmetic works in.
   *
   * `useClubTime()` throws when no provider is above it; all five consumers of
   * this control sit under `(admin)`, whose layout mounts `AppProviders`, and
   * `club-time-provider-mount-census.test.tsx` is what keeps that true.
   */
  const clubToday = dateOnlyInstantOf(useClubTime().today());

  const selectedPreset =
    findMatchingDateRangePreset(from, to, presets, clubToday) ??
    CUSTOM_DATE_RANGE_KEY;

  function handlePresetChange(value: string) {
    if (value === CUSTOM_DATE_RANGE_KEY) {
      return;
    }

    const preset = presets.find((option) => option.key === value);
    if (!preset) {
      return;
    }

    const range = getDateRangeForPreset(preset, clubToday);
    onFromChange(range.from);
    onToChange(range.to);
  }

  return (
    <>
      <div className="space-y-1">
        <Label className="text-xs" htmlFor={`${idPrefix}-preset`}>
          {presetLabel}
        </Label>
        <select
          id={`${idPrefix}-preset`}
          value={selectedPreset}
          onChange={(event: React.ChangeEvent<HTMLSelectElement>) =>
            handlePresetChange(event.target.value)
          }
          className="flex h-9 min-w-40 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
        >
          {presets.map((preset) => (
            <option key={preset.key} value={preset.key}>
              {preset.label}
            </option>
          ))}
          <option value={CUSTOM_DATE_RANGE_KEY}>Custom</option>
        </select>
      </div>
      <div className="space-y-1">
        <Label className="text-xs" htmlFor={`${idPrefix}-from`}>
          {fromLabel}
        </Label>
        <Input
          id={`${idPrefix}-from`}
          type="date"
          value={from}
          onChange={(event) => onFromChange(event.target.value)}
          className="w-40"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs" htmlFor={`${idPrefix}-to`}>
          {toLabel}
        </Label>
        <Input
          id={`${idPrefix}-to`}
          type="date"
          value={to}
          onChange={(event) => onToChange(event.target.value)}
          className="w-40"
        />
      </div>
    </>
  );
}
