"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  MAX_CONFIGURED_LODGE_CAPACITY,
  MIN_CONFIGURED_LODGE_CAPACITY,
} from "@/lib/lodge-effective-capacity";

/*
  Add lodge's Capacity field (#3407, owner decision 14 Sep 2026: capacity is
  asked when a lodge is created). Kept beside the page so the page stays within
  its size budget; it renders no edit affordance of its own, only the input,
  and the page's Save stays under the page's view-only banner.

  `invalid` is set only after a refused save, and then the field points at the
  page's error (`errorId`) as well as its hint. `required` would be inert here,
  because Save is not a form submit, so the requirement is announced with
  `aria-required` and enforced by the page's own parse.
*/
export function AddLodgeCapacityField(props: {
  value: string;
  onChange: (value: string) => void;
  invalid: boolean;
  errorId: string;
}) {
  // With Bed Allocation on the typed figure caps the beds (`capped_beds`,
  // INV-CAP-003), so the hint says so. Tolerant: without an answer the hint
  // simply omits that sentence.
  const [bedAllocationOn, setBedAllocationOn] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/modules")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled) setBedAllocationOn(data?.settings?.bedAllocation === true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-2">
      <Label htmlFor="lodge-capacity">Capacity (maximum guests)</Label>
      <Input
        id="lodge-capacity"
        type="number"
        inputMode="numeric"
        min={MIN_CONFIGURED_LODGE_CAPACITY}
        max={MAX_CONFIGURED_LODGE_CAPACITY}
        step={1}
        aria-required="true"
        aria-invalid={props.invalid || undefined}
        aria-describedby={
          props.invalid
            ? `lodge-capacity-hint ${props.errorId}`
            : "lodge-capacity-hint"
        }
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
      <p id="lodge-capacity-hint" className="text-sm text-muted-foreground">
        How many guests the lodge can sleep. Bookings are refused above it, and
        a lodge without one cannot take a booking. You can change it later on
        the lodge&apos;s configuration page.
        {bedAllocationOn
          ? " With Bed Allocation on, this is the most the lodge may sleep: beds above it are not bookable."
          : null}
      </p>
    </div>
  );
}
