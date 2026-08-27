"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatClubDate, requireCalendarDate } from "@/lib/club-time";
import { formatCents } from "@/lib/utils";

/*
  #2263 — the admin-side additions for whole-lodge requests, kept as small
  standalone pieces mounted inside the shared booking-requests panel rather than
  woven into its 1600 lines. The queue stays ONE queue (owner decision D4:
  exclusivity display gets built once, badges tell the two apart), and the
  composition boundary stays clean enough that a future separate queue is cheap.

  EVERYTHING IN THIS FILE IS ADMIN-ONLY. The availability strip below is the
  single largest concentration of occupancy data in the feature — how full each
  night is, which nights are already exclusively held, and which bookings clash.
  A member is never shown any of it: to them a held night and a full night are
  the same words (ADR-001 decision 6). It is fetched from an /api/admin route
  behind requireAdmin and rendered only here.
*/

type ConflictBooking = {
  id: string;
  memberName: string;
  checkIn: string;
  checkOut: string;
  guestCount: number;
  status: string;
  overridden?: boolean;
};

type HoldConflictsResponse = {
  lodgeCapacity: number;
  nights: Array<{
    date: string;
    availableBeds: number;
    occupiedBeds: number;
    wholeLodgeHeld: boolean;
  }>;
  conflicts: ConflictBooking[];
};

/**
 * The two queue badges. "Member" marks a request that came from a signed-in
 * account (rather than the public or school front-doors); "Whole lodge
 * requested" marks the exclusivity ask — and deliberately renders for SCHOOL
 * rows too, closing a display gap that predates this feature: the school door
 * could always ask for exclusivity, and the queue never said so.
 */
export function WholeLodgeRequestBadges({
  memberOrigin,
  exclusivityRequested,
  requesterName,
}: {
  memberOrigin: boolean;
  exclusivityRequested: boolean;
  requesterName?: string | null;
}) {
  return (
    <>
      {memberOrigin ? (
        <Badge
          variant="outline"
          className="border-cat1-6 bg-cat1-3 text-cat1-11"
          title={
            requesterName
              ? `Submitted by ${requesterName} from their member account`
              : "Submitted from a member account"
          }
        >
          Member
        </Badge>
      ) : null}
      {exclusivityRequested ? (
        <Badge
          variant="outline"
          className="border-cat2-6 bg-cat2-3 text-cat2-11"
          title="The requester asked for sole occupancy of the lodge"
        >
          Whole lodge requested
        </Badge>
      ) : null}
    </>
  );
}

/**
 * A lodge night as the calendar day it IS (CT-4, #2870; INV-DATE-010).
 *
 * WHAT THIS REPLACES WAS WRONG TWICE OVER. `new Date(`${d}T00:00:00`)` has no
 * `Z`, so it parsed as midnight in the ADMIN's browser zone; that instant was
 * then projected through `APP_TIME_ZONE` to be printed. For an admin west of the
 * club the two errors did not cancel and the night came out a day early. A
 * calendar day needs no zone at all, so both steps are gone.
 */
function formatNight(value: string): string {
  return formatClubDate(requireCalendarDate(value));
}

/**
 * Collapsed-by-default availability + conflict preview for a whole-lodge
 * request. Advisory only: ADR-001 decision 1 grants the hold regardless of what
 * is already on those nights, and the officer resolves any overlap by hand. This
 * exists so the officer sees the clash BEFORE pressing Approve rather than in
 * the callout after it.
 */
export function WholeLodgeAvailabilityStrip({
  requestId,
}: {
  requestId: string;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<HoldConflictsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next || data || loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/admin/booking-requests/${requestId}/hold-conflicts`,
      );
      if (!response.ok) throw new Error("Could not load availability");
      setData((await response.json()) as HoldConflictsResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load availability");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-md border border-border p-3">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => void toggle()}
        aria-expanded={open}
      >
        {open ? "Hide" : "Show"} availability for these nights
      </Button>

      {open ? (
        <div className="mt-3 space-y-3 text-sm">
          {loading ? <p className="text-muted-foreground">Loading…</p> : null}
          {error ? (
            <p role="alert" className="text-danger">
              {error}
            </p>
          ) : null}

          {data ? (
            <>
              <div className="flex flex-wrap gap-2">
                {data.nights.map((night) => (
                  <span
                    key={night.date}
                    className={
                      night.wholeLodgeHeld
                        ? "rounded-md border border-cat2-6 bg-cat2-3 px-2 py-1 text-xs text-cat2-11"
                        : night.availableBeds === 0
                          ? "rounded-md border border-warning-6 bg-warning-3 px-2 py-1 text-xs text-warning-11"
                          : "rounded-md border border-border bg-muted px-2 py-1 text-xs text-muted-foreground"
                    }
                  >
                    {formatNight(night.date)} ·{" "}
                    {night.wholeLodgeHeld
                      ? "held"
                      : `${night.occupiedBeds}/${data.lodgeCapacity} beds`}
                  </span>
                ))}
              </div>

              {data.conflicts.length > 0 ? (
                <div
                  role="status"
                  className="rounded-md border border-warning-6 bg-warning-3 p-3 text-xs text-warning-11"
                >
                  <p className="font-medium">
                    {data.conflicts.length === 1
                      ? "1 booking already overlaps these nights"
                      : `${data.conflicts.length} bookings already overlap these nights`}
                  </p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {data.conflicts.map((conflict) => (
                      <li key={conflict.id}>
                        {conflict.memberName} ·{" "}
                        {formatNight(conflict.checkIn)}–
                        {formatNight(conflict.checkOut)} ·{" "}
                        {conflict.guestCount}{" "}
                        {conflict.guestCount === 1 ? "guest" : "guests"} ·{" "}
                        {conflict.status}
                        {conflict.overridden
                          ? " (overridden, not yet holding — it will settle onto these nights later)"
                          : ""}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1">
                    Approving still grants the whole-lodge hold — it never
                    displaces an existing booking. Sort these out with the people
                    involved.
                  </p>
                </div>
              ) : (
                <p className="text-muted-foreground">
                  Nothing else is booked on these nights.
                </p>
              )}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The two approval inputs for a member whole-lodge request.
 *
 * `pricedHeadcount` is the number the officer actually books and prices after
 * talking to the member — the member's own figure is explicitly an estimate.
 *
 * `priceOverrideCents` is the MANDATORY fallback when no active season covers
 * the requested dates. The member-request path has no quote or officer-price op
 * to fall back on (both are refused at the service layer), so without this field
 * an out-of-season whole-lodge request would be a dead end: the approval would
 * 409 with "set a price before approving" and there would be nowhere to set one.
 *
 * `pricingMode` (#2338, owner decision 1 Aug 2026) is the officer's per-approval
 * choice between per-guest pricing (the default — nothing changes silently) and
 * the club's flat whole-lodge rate. It is offered ONLY when
 * `flatWholeLodgeTotalCents` is non-null, i.e. a flat rate covers every night of
 * the stay; the manual price override above still wins over both.
 */
export function MemberWholeLodgeApprovalFields({
  requestId,
  submittedHeadcount,
  headcount,
  onHeadcountChange,
  priceDollars,
  onPriceChange,
  flatWholeLodgeTotalCents,
  nights,
  pricingMode,
  onPricingModeChange,
  disabled,
}: {
  requestId: string;
  submittedHeadcount: number;
  headcount: string;
  onHeadcountChange: (value: string) => void;
  priceDollars: string;
  onPriceChange: (value: string) => void;
  // The flat whole-lodge total for this stay, or null when no flat rate covers
  // it (the toggle is then not offered and pricing stays per guest).
  flatWholeLodgeTotalCents: number | null;
  nights: number;
  pricingMode: "per-guest" | "whole-lodge";
  onPricingModeChange: (mode: "per-guest" | "whole-lodge") => void;
  disabled?: boolean;
}) {
  const flatRateOffered = flatWholeLodgeTotalCents != null;
  return (
    <div className="space-y-3">
      {flatRateOffered ? (
        <fieldset
          className="space-y-2 rounded-md border border-border p-3"
          disabled={disabled}
        >
          <legend className="px-1 text-sm font-medium">
            How to price this whole-lodge booking
          </legend>
          <p className="text-xs text-muted-foreground">
            This season has a flat whole-lodge rate. Choose how to charge for the
            stay. Whatever you pick, a total price override below still wins.
          </p>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name={`whole-lodge-pricing-${requestId}`}
              className="mt-1"
              checked={pricingMode !== "whole-lodge"}
              disabled={disabled}
              onChange={() => onPricingModeChange("per-guest")}
            />
            <span>
              <span className="font-medium">Price per guest</span> — each guest at
              the season rate, as usual.
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name={`whole-lodge-pricing-${requestId}`}
              className="mt-1"
              checked={pricingMode === "whole-lodge"}
              disabled={disabled}
              onChange={() => onPricingModeChange("whole-lodge")}
            />
            <span>
              <span className="font-medium">Price as whole lodge</span> —{" "}
              {formatCents(flatWholeLodgeTotalCents)} for the whole building
              {nights > 0
                ? ` (${nights} ${nights === 1 ? "night" : "nights"} at the season flat rate${nights === 1 ? "" : ", each night at its own season's rate"})`
                : ""}
              . Headcount does not affect this price.
            </span>
          </label>
        </fieldset>
      ) : null}

      <div className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2">
      <div className="space-y-1">
        <Label htmlFor={`whole-lodge-headcount-${requestId}`}>
          Headcount to book and price
        </Label>
        <Input
          id={`whole-lodge-headcount-${requestId}`}
          type="number"
          min="1"
          className="w-32"
          value={headcount}
          disabled={disabled}
          onChange={(event) => onHeadcountChange(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          The member estimated {submittedHeadcount}. Confirm the real number with
          them before approving — this is what gets charged.
        </p>
      </div>

      <div className="space-y-1">
        <Label htmlFor={`whole-lodge-price-${requestId}`}>
          Total price override (optional)
        </Label>
        <Input
          id={`whole-lodge-price-${requestId}`}
          type="number"
          min="0"
          step="0.01"
          className="w-40"
          value={priceDollars}
          disabled={disabled}
          onChange={(event) => onPriceChange(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {flatRateOffered
            ? "Leave blank to price at the pricing method chosen above. Required when no season covers these dates — there is no separate pricing step on this path. A value here overrides both per-guest and whole-lodge pricing."
            : "Leave blank to price at the season rates. Required when no season covers these dates — there is no separate pricing step on this path."}
        </p>
      </div>
      </div>
    </div>
  );
}
