"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm-dialog";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { useClubTime } from "@/components/club-time-provider";

interface AdminCapacityHoldControlsProps {
  bookingId: string;
  /** Whether an admin capacity hold is currently set (#1764). */
  hasAdminCapacityHold: boolean;
  /** ISO timestamp of the hold, for display. */
  adminCapacityHoldAt: string | null;
  /** Name of the admin who placed the hold, when known. */
  heldByName: string | null;
  /**
   * Whether the booking holds capacity naturally (paid/confirmed/etc.). Once
   * true, Release hold is not offered — the beds belong to the stay.
   */
  holdsCapacityNaturally: boolean;
  /** Hold is only offered for PAYMENT_PENDING bookings (v1 scope, #1764). */
  canPlaceHold: boolean;
}

/**
 * Admin Hold / Admin Unhold controls for the Admin tools card (#1764):
 * reserve lodge capacity for an unpaid (PAYMENT_PENDING) booking without
 * changing its status, and release that hold again. An over-capacity hold
 * comes back as 409 CAPACITY_EXCEEDED and needs a second, explicit overbook
 * confirm — mirroring the force-confirm flow.
 */
/**
 * When the capacity hold was placed.
 *
 * A real INSTANT, projected through the club's PERSISTED timezone (CT-4, #2870;
 * INV-CONFIG-002) rather than the container's `TZ`. `instantDate` keeps the
 * medium "16 Apr 2026" shape this line has always shown; only the zone's
 * AUTHORITY moved. The zone reaches this browser as data through
 * `ClubTimeProvider` - never from the viewer's own clock.
 */
function useHoldStampFormatter() {
  const clubTime = useClubTime();
  return (value: string) => clubTime.instantDate(new Date(value));
}

export function AdminCapacityHoldControls({
  bookingId,
  hasAdminCapacityHold,
  adminCapacityHoldAt,
  heldByName,
  holdsCapacityNaturally,
  canPlaceHold,
}: AdminCapacityHoldControlsProps) {
  const formatHoldStamp = useHoldStampFormatter();
  const router = useRouter();
  // Hold/release write /api/admin/bookings/[id]/capacity-hold (bookings area).
  // A view-only bookings admin sees the controls disabled (#1997).
  const canEdit = useAdminAreaEditAccess("bookings");
  const { confirm, confirmDialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function callHoldRoute(allowOverbook: boolean): Promise<void> {
    const res = await fetch(`/api/admin/bookings/${bookingId}/capacity-hold`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(allowOverbook ? { allowOverbook: true } : {}),
    });

    if (res.ok) {
      toast.success(
        allowOverbook
          ? "Capacity held (overbooked)."
          : "Capacity held for this booking.",
      );
      router.refresh();
      return;
    }

    const data = await res.json().catch(() => ({}));
    if (data.error === "CAPACITY_EXCEEDED" && !allowOverbook) {
      const nights: string[] = Array.isArray(data.overbookDates)
        ? data.overbookDates
        : [];
      const confirmedOverbook = await confirm({
        title: "Hold beyond capacity?",
        description: `The lodge is full for ${
          nights.length > 0 ? nights.join(", ") : "part of this stay"
        }. Holding anyway will overbook those nights.`,
        confirmLabel: "Hold and overbook",
      });
      if (confirmedOverbook) {
        await callHoldRoute(true);
      }
      return;
    }

    const message = data.error || "Failed to hold capacity";
    setError(message);
    toast.error(message);
  }

  async function handleHold() {
    const confirmed = await confirm({
      title: "Hold capacity for this booking?",
      description:
        "The booking's beds will be reserved while the member arranges payment — other members can no longer book those nights. You can release the hold until the booking is paid or confirmed.",
      confirmLabel: "Hold capacity",
    });
    if (!confirmed) return;

    setBusy(true);
    setError("");
    try {
      await callHoldRoute(false);
    } catch {
      const message = "Failed to hold capacity";
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRelease() {
    const confirmed = await confirm({
      title: "Release the capacity hold?",
      description:
        "The reserved beds become bookable by other members again. The booking itself is unchanged and can still be paid.",
      confirmLabel: "Release hold",
    });
    if (!confirmed) return;

    setBusy(true);
    setError("");
    try {
      const res = await fetch(
        `/api/admin/bookings/${bookingId}/capacity-hold`,
        { method: "DELETE" },
      );
      if (res.ok) {
        toast.success("Capacity hold released.");
        router.refresh();
        return;
      }
      const data = await res.json().catch(() => ({}));
      const message = data.error || "Failed to release the capacity hold";
      setError(message);
      toast.error(message);
    } catch {
      const message = "Failed to release the capacity hold";
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  // Nothing to show: no hold in place and the booking is not holdable.
  if (!hasAdminCapacityHold && !canPlaceHold) {
    return null;
  }

  return (
    <div className="space-y-2">
      {confirmDialog}
      {hasAdminCapacityHold && (
        <div className="rounded-md border border-info-6 bg-info-3 px-3 py-2 text-sm text-info-11">
          <p className="font-medium">Capacity held by admin</p>
          <p>
            Beds reserved
            {heldByName ? ` by ${heldByName}` : ""}
            {adminCapacityHoldAt
              ? ` on ${formatHoldStamp(adminCapacityHoldAt)}`
              : ""}
            {holdsCapacityNaturally
              ? ". The booking now holds its beds through its own status."
              : " while the member arranges payment."}
          </p>
        </div>
      )}
      {error && (
        <div className="rounded-md bg-danger-3 p-3 text-sm text-danger-11">
          {error}
        </div>
      )}
      {!hasAdminCapacityHold && canPlaceHold && (
        <ViewOnlyActionButton
          canEdit={canEdit}
          variant="outline"
          onClick={handleHold}
          disabled={busy}
        >
          {busy ? "Holding..." : "Hold capacity"}
        </ViewOnlyActionButton>
      )}
      {hasAdminCapacityHold && !holdsCapacityNaturally && (
        <ViewOnlyActionButton
          canEdit={canEdit}
          variant="outline"
          onClick={handleRelease}
          disabled={busy}
        >
          {busy ? "Releasing..." : "Release hold"}
        </ViewOnlyActionButton>
      )}
    </div>
  );
}
