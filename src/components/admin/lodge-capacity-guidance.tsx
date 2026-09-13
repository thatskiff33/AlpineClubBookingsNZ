"use client";

import {
  configuredCapacityExceedsActiveBeds,
  resolveEffectiveLodgeCapacity,
} from "@/lib/lodge-effective-capacity";

/**
 * What the capacity an officer is typing will actually mean (#2724).
 *
 * The lodge configuration screen's capacity field accepts a value above the
 * beds installed so far — an admin who is about to install more beds has a
 * legitimate reason to set it — and it accepts a value below them, which caps
 * the lodge. Neither is a validation error, so neither blocks the save; what
 * the officer is owed is the consequence, in figures.
 *
 * The prediction runs through the SAME rule the server resolves with
 * (`lodge-effective-capacity.ts`, `INV-CAP-003`, `INV-SSOT-001`), so what this
 * says can never drift from what the save will do.
 *
 * This is an officer-facing screen. Nothing here reaches a member, so the
 * rule that a member can never tell a held lodge from an ordinarily full one
 * is not engaged.
 */
export function LodgeCapacityGuidance({
  capacityInput,
  activeBedCount,
}: {
  /** The raw contents of the capacity field, exactly as typed. */
  capacityInput: string;
  /** Active beds in this lodge, or null while the figure is still loading. */
  activeBedCount: number | null;
}) {
  // A value the save would refuse gets no prediction. The check this replaced
  // accepted any finite number, so "0" was explained as capping the lodge at
  // zero — something `saveCapacityOverride` would never have done.
  const trimmed = capacityInput.trim();
  const parsed = Number(trimmed);
  const typedCapacity =
    trimmed !== "" && Number.isInteger(parsed) && parsed > 0 ? parsed : null;

  // activeBedCount is only > 0 when Bed Allocation is on with beds
  // (getLodgeCapacityStatus), so it is the authoritative signal here — the
  // separate module flag can lag on the page above.
  if (activeBedCount === null || typedCapacity === null) return null;

  const input = {
    configuredCapacity: typedCapacity,
    activeBedCount,
  };
  const previewed = resolveEffectiveLodgeCapacity(input);

  // Capacity below the installed beds caps the lodge (#1653); capacity above
  // them is allowed and simply does not bind yet (#2724). Mutually exclusive
  // by construction.
  if (previewed.source === "capped_beds") {
    const stranded = activeBedCount - previewed.capacity;
    return (
      <p
        className="rounded-md bg-warning-3 p-2 text-xs text-warning-11"
        role="status"
      >
        This is below the {activeBedCount} active bed
        {activeBedCount === 1 ? "" : "s"} configured for this lodge, so it will
        cap the lodge at {previewed.capacity} — the extra {stranded} bed
        {stranded === 1 ? "" : "s"} stay available for allocation but cannot be
        booked into.
      </p>
    );
  }

  if (!configuredCapacityExceedsActiveBeds(input)) return null;

  const toActivate = typedCapacity - activeBedCount;
  return (
    <p
      className="rounded-md bg-warning-3 p-2 text-xs text-warning-11"
      role="status"
    >
      This is above the {activeBedCount} active bed
      {activeBedCount === 1 ? "" : "s"} configured for this lodge. Capacity is
      the lower of the two, so saving {typedCapacity} is allowed but only{" "}
      {previewed.capacity} place{previewed.capacity === 1 ? "" : "s"} can be
      booked right now. Activating {toActivate} more bed
      {toActivate === 1 ? "" : "s"} raises the effective capacity, up to{" "}
      {typedCapacity}.
    </p>
  );
}
