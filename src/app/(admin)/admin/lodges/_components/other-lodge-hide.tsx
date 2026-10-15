"use client";

import { useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";

/** What the panel shows, by the list, after a Hide. */
export type HideMessage = { kind: "ok" | "err"; text: string };

/**
 * Hiding an Other lodges row the central server does not list (#58). The panel
 * renders the button itself — its view-only reason is the panel's to vouch for
 * — and this hook does the rest: ask first, post to the route (which checks the
 * rule again), then reload the list whatever the answer (a refusal means the
 * list is out of date) and report through its OWN message, shown and announced
 * by the list, never inside the edit dialog. One hide at a time.
 */
export function useHideUnlistedLodge({
  reload,
  afterHide,
}: {
  reload: () => void | Promise<void>;
  /** Where focus goes once the row is gone (the list's heading). */
  afterHide: () => void;
}) {
  const { confirm, confirmDialog } = useConfirm();
  const [hidingId, setHidingId] = useState<string | null>(null);
  const [message, setMessage] = useState<HideMessage | null>(null);

  async function hide(lodge: { id: string; name: string }) {
    if (hidingId !== null) return;
    const confirmed = await confirm({
      title: `Hide ${lodge.name}?`,
      description:
        "The Alpine Central Server does not list this lodge. Hiding it takes it off this list, the booking-request form and the visiting-club rate picker. Bookings and booking requests that already name it keep it. This cannot be undone.",
      confirmLabel: "Hide",
      destructive: true,
    });
    if (!confirmed) return;
    setHidingId(lodge.id);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/other-lodges/${lodge.id}/hide`, {
        method: "POST",
      });
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      setMessage(
        response.ok
          ? { kind: "ok", text: `${lodge.name} is hidden.` }
          : { kind: "err", text: data?.error ?? "Failed to hide the lodge" },
      );
      await reload();
      if (response.ok) afterHide();
    } catch {
      setMessage({ kind: "err", text: "Failed to hide the lodge" });
    } finally {
      setHidingId(null);
    }
  }

  return { hide, hidingId, message, confirmDialog };
}
