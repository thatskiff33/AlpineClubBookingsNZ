"use client";

import { useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";

/**
 * Removing an Other lodges row the central server does not list and nothing
 * here refers to (#58). The panel renders the button itself — its view-only
 * reason is the panel's to vouch for — and this hook does the rest: ask first,
 * post to the route (which checks both conditions again), then report through
 * the panel's own message and refresh. `confirmDialog` is rendered once.
 */
export function useRemoveUnlistedLodge({
  onRemoved,
  onError,
}: {
  onRemoved: () => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const { confirm, confirmDialog } = useConfirm();
  const [removingId, setRemovingId] = useState<string | null>(null);

  async function remove(lodge: { id: string; name: string }) {
    const confirmed = await confirm({
      title: `Remove ${lodge.name}?`,
      description:
        "The Alpine Central Server does not list this lodge, and no booking or booking request here refers to it. Removing it takes it off this list and the booking-request form. This cannot be undone.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!confirmed) return;
    setRemovingId(lodge.id);
    try {
      const response = await fetch(`/api/admin/other-lodges/${lodge.id}/remove`, {
        method: "POST",
      });
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        onError(data?.error ?? "Failed to remove the lodge");
        return;
      }
      await onRemoved();
    } catch {
      onError("Failed to remove the lodge");
    } finally {
      setRemovingId(null);
    }
  }

  return { remove, removingId, confirmDialog };
}
