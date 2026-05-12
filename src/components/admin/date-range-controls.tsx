"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  CUSTOM_DATE_RANGE_KEY,
  type DateRangePreset,
  findMatchingDateRangePreset,
  getDateRangeForPreset,
} from "@/lib/date-range-presets";

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
  const selectedPreset =
    findMatchingDateRangePreset(from, to, presets) ?? CUSTOM_DATE_RANGE_KEY;

  function handlePresetChange(value: string) {
    if (value === CUSTOM_DATE_RANGE_KEY) {
      return;
    }

    const preset = presets.find((option) => option.key === value);
    if (!preset) {
      return;
    }

    const range = getDateRangeForPreset(preset);
    onFromChange(range.from);
    onToChange(range.to);
  }

  return (
    <>
      <div className="space-y-1">
        <Label className="text-xs">{presetLabel}</Label>
        <select
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
