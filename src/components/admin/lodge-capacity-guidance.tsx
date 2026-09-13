"use client";

import {
  configuredCapacityExceedsActiveBeds,
  parseConfiguredLodgeCapacity,
  resolveEffectiveLodgeCapacity,
  resolvePartnerSharedHeadroom,
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
 * The prediction runs through the SAME rules the server resolves with
 * (`lodge-effective-capacity.ts`, `INV-CAP-003`, `INV-CAP-031`,
 * `INV-SSOT-001`) — the effective capacity, the partner-shared headroom and
 * the save bounds alike — so what this says can never drift from what the save
 * will do.
 *
 * **The surplus is not inert, and this must never imply that it is.** A
 * capacity above the active beds does not raise what can be BOOKED until beds
 * are activated, but it is also the ceiling the partner-shared double-bed
 * headroom is measured against (#1745), and that takes effect on save. A
 * lodge configured at its bed count gets no partner spots at all, so an
 * officer who reads "it does nothing yet" and lowers the figure to match the
 * beds would silently zero every partner-shared slot — spots the very same
 * screen displays on its Capacity card. Both branches below therefore name
 * the partner consequence whenever the lodge has shareable doubles.
 *
 * This is an officer-facing screen. Nothing here reaches a member, so the
 * rule that a member can never tell a held lodge from an ordinarily full one
 * is not engaged.
 *
 * Deliberately NOT a live region. The text changes on every keystroke, and a
 * figure typed digit by digit passes through values whose explanation is true
 * of the prefix and false of the figure — typing 30 against 24 beds passes
 * through 3, whose capping sentence would be announced in full. It is instead
 * associated with the field through `aria-describedby`, so it is announced on
 * focus, including for an officer who tabs back to a field they are not
 * editing and for a view-only officer who never types at all.
 */
export function LodgeCapacityGuidance({
  id,
  capacityInput,
  activeBedCount,
  activeDoubleBedCount,
}: {
  /** Referenced by the capacity field's `aria-describedby`. */
  id: string;
  /** The raw contents of the capacity field, exactly as typed. */
  capacityInput: string;
  /** Active beds in this lodge, or null while the figure is still loading. */
  activeBedCount: number | null;
  /** Active DOUBLE beds in this lodge — the shareable ones (#1745). */
  activeDoubleBedCount: number;
}) {
  const className = "rounded-md bg-warning-3 p-2 text-xs text-warning-11";

  // Bounds, whole-number-ness and emptiness all come from the one parser the
  // save and the API schema read, so this can never predict a save the server
  // would refuse — including the upper bound, which an officer typing a
  // stray extra zero would otherwise meet only as a bare "Invalid input".
  const typed = parseConfiguredLodgeCapacity(capacityInput);
  if (typed.kind === "invalid") {
    return (
      <p id={id} className={className}>
        {typed.message}
      </p>
    );
  }

  // activeBedCount is only > 0 when Bed Allocation is on with beds
  // (getLodgeCapacityStatus), so it is the authoritative signal here — the
  // separate module flag can lag on the page above.
  if (activeBedCount === null || typed.kind === "cleared") return null;

  const typedCapacity = typed.capacity;
  const input = { configuredCapacity: typedCapacity, activeBedCount };
  const previewed = resolveEffectiveLodgeCapacity(input);

  // Capacity below the installed beds caps the lodge (#1653); capacity above
  // them is allowed and does not raise what is bookable yet (#2724). Mutually
  // exclusive by construction.
  if (previewed.source === "capped_beds") {
    const stranded = activeBedCount - previewed.capacity;
    return (
      <p id={id} className={className}>
        This is below the {activeBedCount} active bed
        {activeBedCount === 1 ? "" : "s"} configured for this lodge, so it will
        cap the lodge at {previewed.capacity} — the extra {stranded} bed
        {stranded === 1 ? "" : "s"} stay available for allocation but cannot be
        booked into.
        {activeDoubleBedCount > 0 ? (
          <>
            {" "}
            A capacity below the bed count also leaves no room for partner
            spots, so while this cap is in place none of the {
              activeDoubleBedCount
            }{" "}
            shareable double bed{activeDoubleBedCount === 1 ? "" : "s"} can take
            a second occupant.
          </>
        ) : null}
      </p>
    );
  }

  if (!configuredCapacityExceedsActiveBeds(input)) return null;

  const toActivate = typedCapacity - activeBedCount;
  const partnerSpots = resolvePartnerSharedHeadroom({
    ...input,
    activeDoubleBedCount,
  });
  return (
    <p id={id} className={className}>
      This is above the {activeBedCount} active bed
      {activeBedCount === 1 ? "" : "s"} configured for this lodge. Capacity is
      the lower of the two, so saving {typedCapacity} is allowed but only{" "}
      {previewed.capacity} place{previewed.capacity === 1 ? "" : "s"} can be
      booked right now. Activating {toActivate} more bed
      {toActivate === 1 ? "" : "s"} raises the effective capacity, up to{" "}
      {typedCapacity}.
      {partnerSpots > 0 ? (
        <>
          {" "}
          The difference is not idle in the meantime: it is also the room this
          lodge has for partner spots, so saving {typedCapacity} allows up to{" "}
          {partnerSpots} partner spot{partnerSpots === 1 ? "" : "s"} on its
          shareable double beds straight away, and lowering the capacity to{" "}
          {activeBedCount} would leave none.
        </>
      ) : null}
    </p>
  );
}
