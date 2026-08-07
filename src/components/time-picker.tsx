"use client";

import { ARRIVAL_TIME_MINUTES } from "@/lib/arrival-time";

interface TimePickerProps {
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  /*
    #2621. This rendered a bare `<select>` with no `id`, so it had no accessible
    name — and the breakage was invisible in review because BOTH booking flows
    already wrote `<Label htmlFor="arrival-time">` above it. The label markup
    looked correct and pointed at nothing, in every call site, so a screen reader
    announced an unlabelled combo box reading "Not sure". Forwarding `id` is what
    makes those existing labels real; it is not a new convention.
  */
  id?: string;
  describedById?: string;
}

function generateTimeOptions(): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [];
  for (let h = 6; h <= 23; h++) {
    // Minutes come from the shared rule rather than a local `[0, 30]`, so the
    // options this offers and the values the API accepts cannot drift apart
    // (#2621 — they had, in the API's favour, for six minute values).
    for (const minutes of ARRIVAL_TIME_MINUTES) {
      if (h === 23 && minutes === "30") continue;
      const value = `${String(h).padStart(2, "0")}:${minutes}`;
      const suffix = h >= 12 ? "PM" : "AM";
      const displayHour = h === 0 ? 12 : h > 12 ? h - 12 : h;
      const label = `${displayHour}:${minutes} ${suffix}`;
      options.push({ value, label });
    }
  }
  return options;
}

const TIME_OPTIONS = generateTimeOptions();

export function TimePicker({
  value,
  onChange,
  disabled,
  id,
  describedById,
}: TimePickerProps) {
  return (
    <select
      id={id}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      disabled={disabled}
      aria-describedby={describedById}
      className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
    >
      <option value="">Not sure</option>
      {TIME_OPTIONS.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
