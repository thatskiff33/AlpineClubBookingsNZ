"use client";

import { useCallback, useState } from "react";

/**
 * #4946: the club's current cancellation schedule rows for the lodge and
 * check-in the policy check answered, shown on the review step before the
 * member commits.
 *
 * The rows are stored WITH that selection and read back only while it is still
 * the one on screen, so a schedule for earlier dates or another lodge is never
 * shown, even for the render before a clear lands. Kept out of
 * `use-booking-wizard.ts` so the wizard only records and clears it.
 */
type ScheduleForSelection = {
  lodgeId: string;
  checkIn: string;
  rows: string[];
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function useSelectionCancellationSchedule(
  lodgeId: string | null,
  checkIn: string | null,
) {
  const [state, setState] = useState<ScheduleForSelection | null>(null);

  // `rows` is the policy-check response's `cancellationSchedule` field as
  // received; anything but an array of strings is treated as "unknown".
  const recordCancellationSchedule = useCallback(
    (forLodgeId: string, forCheckIn: string, rows: unknown) => {
      setState(
        isStringArray(rows)
          ? { lodgeId: forLodgeId, checkIn: forCheckIn, rows }
          : null,
      );
    },
    [],
  );
  const clearCancellationSchedule = useCallback(() => setState(null), []);

  const cancellationSchedule =
    state && state.lodgeId === lodgeId && state.checkIn === checkIn
      ? state.rows
      : null;

  return {
    cancellationSchedule,
    recordCancellationSchedule,
    clearCancellationSchedule,
  };
}
