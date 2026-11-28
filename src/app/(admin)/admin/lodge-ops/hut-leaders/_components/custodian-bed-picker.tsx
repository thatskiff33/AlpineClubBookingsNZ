"use client";

import { useEffect, useId, useState } from "react";
import { BedDouble } from "lucide-react";
import { useClubIdentity } from "@/components/club-identity-provider";
import { Label } from "@/components/ui/label";

interface BedOption {
  bedId: string;
  bedName: string;
  bedType: string;
  roomId: string;
  roomName: string;
  available: boolean;
  allocatedNights: string[];
  custodianHeldNights: string[];
  heldByThisAssignment: boolean;
}

interface RoomGroup {
  roomId: string;
  roomName: string;
  beds: BedOption[];
}

interface CustodianBedPickerProps {
  lodgeId: string | null;
  startDate: string;
  endDate: string;
  /** null = "No bed — role only", the default. */
  value: string | null;
  onChange: (bedId: string | null) => void;
  /** Set when editing an existing assignment, so its own hold is excluded. */
  assignmentId?: string;
  // Tri-state (#2065): `undefined` while the session resolves. `!canEdit`
  // disables, so this must never default to true.
  canEdit: boolean | undefined;
}

// "BUNK_TOP" -> "bunk top". The bed types are descriptive labels, not a closed
// enum this component needs to know: anything new reads sensibly without a code
// change here.
function formatBedType(bedType: string) {
  return bedType.toLowerCase().replace(/_/g, " ");
}

/**
 * Optional bed picker for a hut-leader assignment (#2286).
 *
 * Holding a bed turns the assignment into a *custodian occupancy*: that bed
 * leaves the bookable pool for every night the assignment covers, with no
 * booking anywhere. "No bed — role only" is the default and is exactly the
 * behaviour that existed before this feature.
 *
 * Unavailable beds are listed with the nights that block them rather than
 * hidden: an admin who cannot see why a bed is missing has no way to free it.
 */
export function CustodianBedPicker({
  lodgeId,
  startDate,
  endDate,
  value,
  onChange,
  assignmentId,
  canEdit,
}: CustodianBedPickerProps) {
  // Admin copy uses the club's own word for the role (#2286 review M8) — only
  // the lobby TV is pinned to the fixed word "Custodian".
  const { hutLeaderLabel } = useClubIdentity();
  // The picker renders once in the create form AND once per table row being
  // edited, so a fixed element id would duplicate across the page and break the
  // label association.
  const selectId = useId();
  const [rooms, setRooms] = useState<RoomGroup[] | null>(null);
  const [loading, setLoading] = useState(false);
  // The bed-allocation module being off is not an error — the picker simply
  // does not apply, so the whole section stays out of the way.
  const [unavailable, setUnavailable] = useState(false);
  // Anything else that went wrong. Distinct from `unavailable` on purpose (#2286
  // review L6): a 500 or a dropped connection used to render an EMPTY bed list
  // that was indistinguishable from "this lodge has no beds", so an admin could
  // conclude there was nothing to hold when the truth was that the lookup
  // failed. Say so, and offer the retry.
  const [failed, setFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!startDate || !endDate || startDate > endDate) {
      setRooms(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    const params = new URLSearchParams({ startDate, endDate });
    if (lodgeId) params.set("lodgeId", lodgeId);
    if (assignmentId) params.set("assignmentId", assignmentId);
    void fetch(`/api/admin/hut-leaders/available-beds?${params.toString()}`)
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) {
          setUnavailable(true);
          setRooms(null);
          return;
        }
        if (!res.ok) {
          setFailed(true);
          setRooms(null);
          return;
        }
        const data = (await res.json()) as { rooms?: RoomGroup[] };
        setUnavailable(false);
        // Never trust the shape: this picker renders inside the assignment form,
        // so a malformed or unexpected response must degrade to "no beds
        // offered" rather than take the whole Hut Leaders page down.
        setRooms(Array.isArray(data?.rooms) ? data.rooms : []);
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
        setRooms(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lodgeId, startDate, endDate, assignmentId, reloadToken]);

  if (unavailable) return null;

  return (
    <div className="space-y-2">
      <Label
        htmlFor={selectId}
        className="flex items-center gap-1.5 text-sm font-semibold text-foreground"
      >
        <BedDouble aria-hidden className="h-4 w-4" />
        Hold a bed (optional)
      </Label>
      <p className="text-xs text-muted-foreground">
        Leave this as &ldquo;No bed&rdquo; for a role-only assignment. Choosing a
        bed takes it out of the bookable pool for{" "}
        <span className="font-medium">every night from {startDate} to {endDate}</span>{" "}
        — including the night of {endDate} itself. If these dates came from the
        automatic assignment (which ends on a guest&rsquo;s <em>departure</em>{" "}
        day), trim the end date by one day first or the bed is held for one night
        longer than anyone is here.
      </p>
      <select
        id={selectId}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        value={value ?? ""}
        disabled={!canEdit || loading}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">No bed — role only</option>
        {(rooms ?? []).map((room) => (
          <optgroup key={room.roomId} label={room.roomName}>
            {room.beds.map((bed) => (
              <option
                key={bed.bedId}
                value={bed.bedId}
                disabled={!bed.available && !bed.heldByThisAssignment}
              >
                {/*
                  The bed TYPE is part of the choice (#2286 review L6): a DOUBLE
                  taken out of the pool removes a two-person bed, and "Bunk 3"
                  alone never says which kind of bed this is.
                */}
                {bed.bedName} ({formatBedType(bed.bedType)})
                {bed.available || bed.heldByThisAssignment
                  ? ""
                  : bed.custodianHeldNights.length > 0
                    ? ` — held by another ${hutLeaderLabel.toLowerCase()} on ${bed.custodianHeldNights.join(", ")}`
                    : ` — guests allocated on ${bed.allocatedNights.join(", ")}`}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {loading ? (
        <p className="text-xs text-muted-foreground">Checking beds…</p>
      ) : null}
      {failed && !loading ? (
        <p
          className="flex flex-wrap items-center gap-2 text-xs text-danger"
          role="status"
        >
          The bed list could not be loaded, so no bed is being offered — this is
          NOT &ldquo;there are no beds&rdquo;.
          <button
            type="button"
            className="underline"
            onClick={() => setReloadToken((token) => token + 1)}
          >
            Try again
          </button>
        </p>
      ) : null}
      {rooms !== null && rooms.length === 0 && !loading && !failed ? (
        <p className="text-xs text-muted-foreground">
          This lodge has no active beds set up, so there is nothing to hold.
        </p>
      ) : null}
    </div>
  );
}
