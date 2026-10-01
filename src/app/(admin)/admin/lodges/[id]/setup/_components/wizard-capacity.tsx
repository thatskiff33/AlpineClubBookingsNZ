"use client";

import { useEffect, useState } from "react";
import { CardDescription, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ADMIN_FORBIDDEN_SAVE_REASON } from "@/components/admin/view-only-action";
import { apiErrorMessageFromResponse } from "@/lib/api-error-message";
import {
  MAX_CONFIGURED_LODGE_CAPACITY,
  MIN_CONFIGURED_LODGE_CAPACITY,
  NEW_LODGE_CAPACITY_REQUIRED_MESSAGE,
  parseConfiguredLodgeCapacity,
} from "@/lib/lodge-effective-capacity";

/*
  The lodge setup wizard's capacity half (#3407, owner decision 14 Sep 2026):
  "A capacity step is added to the setup wizard for the case where bed
  allocation is off, so the wizard cannot say 'ready' about a lodge that cannot
  take a booking."

  Kept beside the wizard rather than in it so the page stays a list of steps.
  The step's Save button stays in the page, under the page's own view-only
  banner (`docs/ARCHITECTURE.md` -> "Admin/member layer"); nothing here renders
  an edit affordance of its own.
*/

function settingsUrl(lodgeId: string) {
  return `/api/admin/lodge-settings?lodgeId=${encodeURIComponent(lodgeId)}`;
}

export function useWizardCapacity(options: {
  lodgeId: string;
  onFinishStep: boolean;
  setError: (message: string) => void;
  setSaving: (saving: boolean) => void;
  goNext: () => void;
}) {
  const { lodgeId, onFinishStep, setError, setSaving, goNext } = options;
  // The configured capacity as saved, and as typed. Seeded from the lodge's
  // settings, which Add lodge now writes.
  const [capacityInput, setCapacityInput] = useState("");
  const [savedCapacityInput, setSavedCapacityInput] = useState("");
  // Whether the server says this lodge can take a booking at all. Null until
  // Finish has asked: the configured figure alone cannot answer it with Bed
  // Allocation on, where active beds count too.
  const [setUpForBookings, setSetUpForBookings] = useState<boolean | null>(
    null,
  );
  // The figure the lodge really resolves to, so "ready" states it; and whether
  // the readiness read failed, which is "could not check", never "not set up".
  const [resolvedCapacity, setResolvedCapacity] = useState<number | null>(null);
  const [readinessCheckFailed, setReadinessCheckFailed] = useState(false);

  // Tolerant: a failed read leaves the field blank to be filled in, and must
  // not take the rest of the wizard down with it.
  useEffect(() => {
    let cancelled = false;
    fetch(settingsUrl(lodgeId))
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || typeof data?.capacity !== "number") return;
        setCapacityInput(String(data.capacity));
        setSavedCapacityInput(String(data.capacity));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [lodgeId]);

  // Re-asked every time Finish is reached, because a Back to Capacity or Rooms
  // can change the answer.
  useEffect(() => {
    if (!onFinishStep) return;
    let cancelled = false;
    setSetUpForBookings(null);
    setResolvedCapacity(null);
    setReadinessCheckFailed(false);
    fetch(settingsUrl(lodgeId), { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (typeof data?.setUpForBookings !== "boolean") {
          setReadinessCheckFailed(true);
          return;
        }
        setSetUpForBookings(data.setUpForBookings);
        if (typeof data.resolvedCapacity === "number") {
          setResolvedCapacity(data.resolvedCapacity);
        }
      })
      .catch(() => {
        if (!cancelled) setReadinessCheckFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [onFinishStep, lodgeId]);

  async function saveCapacity() {
    const typed = parseConfiguredLodgeCapacity(capacityInput);
    if (typed.kind !== "valid") {
      setError(NEW_LODGE_CAPACITY_REQUIRED_MESSAGE);
      return;
    }
    // Dirty-gated (docs/ARCHITECTURE.md, Admin/member layer): the route audits
    // every save, so an unchanged figure is not re-sent.
    if (String(typed.capacity) === savedCapacityInput) {
      goNext();
      return;
    }
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/admin/lodge-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capacity: typed.capacity, lodgeId }),
      });
      if (res.status === 403) {
        setError(ADMIN_FORBIDDEN_SAVE_REASON);
        return;
      }
      if (!res.ok) {
        throw new Error(
          await apiErrorMessageFromResponse(res, "Failed to save capacity"),
        );
      }
      setSavedCapacityInput(String(typed.capacity));
      setCapacityInput(String(typed.capacity));
      goNext();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save capacity");
    } finally {
      setSaving(false);
    }
  }

  const parsedSaved = parseConfiguredLodgeCapacity(savedCapacityInput);
  return {
    capacityInput,
    setCapacityInput,
    saveCapacity,
    setUpForBookings,
    resolvedCapacity,
    readinessCheckFailed,
    savedCapacity: parsedSaved.kind === "valid" ? parsedSaved.capacity : null,
  };
}

export function WizardCapacityField(props: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2 max-w-xs">
      <Label htmlFor="wizard-capacity">Capacity (maximum guests)</Label>
      <Input
        id="wizard-capacity"
        aria-describedby="wizard-capacity-hint"
        type="number"
        inputMode="numeric"
        min={MIN_CONFIGURED_LODGE_CAPACITY}
        max={MAX_CONFIGURED_LODGE_CAPACITY}
        step={1}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        disabled={props.disabled}
      />
      <p id="wizard-capacity-hint" className="text-sm text-muted-foreground">
        How many guests the lodge can sleep. Bookings are refused above it, and
        a lodge without one cannot take a booking.
      </p>
    </div>
  );
}

/**
 * The Rooms step's line about capacity. With Bed Allocation on, beds set the
 * capacity only up to the figure typed on Add lodge, which caps them
 * (`capped_beds`, INV-CAP-003); saying "beds set the capacity" alone would be
 * untrue once more beds are seeded than that figure.
 */
export function wizardRoomsCapacityLine(savedCapacity: number | null): string {
  return savedCapacity === null
    ? "Active beds set the lodge's booking capacity."
    : `Active beds set the lodge's booking capacity, up to the ${savedCapacity} guests entered for it: beds above that figure are not bookable.`;
}

/**
 * The Finish card's heading: "ready" only when the server says the lodge can
 * take a booking, and nothing either way until it has answered.
 */
export function WizardFinishHeading(props: {
  lodgeName: string;
  setUpForBookings: boolean | null;
  resolvedCapacity: number | null;
  readinessCheckFailed: boolean;
  bedAllocationOn: boolean;
}) {
  const { lodgeName, setUpForBookings, resolvedCapacity, bedAllocationOn } = props;
  if (props.readinessCheckFailed) {
    return (
      <>
        <CardTitle>Setup steps finished</CardTitle>
        <CardDescription>
          Whether {lodgeName} can take bookings could not be checked just now.
          Its configuration page shows its capacity, and anything skipped here
          can be finished there.
        </CardDescription>
      </>
    );
  }
  return (
    <>
      <CardTitle>
        {setUpForBookings === false
          ? "Not ready for bookings yet"
          : setUpForBookings === true
            ? "All set"
            : "Setup steps finished"}
      </CardTitle>
      <CardDescription>
        {setUpForBookings === false ? (
          <>
            {lodgeName} is not set up for bookings yet: it has no capacity, so
            no booking can be made there.{" "}
            {bedAllocationOn
              ? "Create its rooms and beds, or set a capacity on the configuration page."
              : "Go back to the Capacity step and enter how many guests it can take."}
          </>
        ) : (
          <>
            {setUpForBookings === true
              ? resolvedCapacity !== null
                ? `${lodgeName} is ready: it can take up to ${resolvedCapacity} guests. `
                : `${lodgeName} is ready. `
              : null}
            The configuration page shows what exists at this lodge and links
            into every editor — anything skipped here can be finished there.
          </>
        )}
      </CardDescription>
    </>
  );
}
