"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FocusedActionError } from "@/components/focused-action-error";
import { StatusRegion } from "@/components/status-region";

export function NominationConfirmCard(props: {
  token: string;
  canConfirm: boolean;
  initialMessage?: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState(props.initialMessage ?? "");
  // #4949: once the confirmation is recorded the page re-renders without the
  // button that had focus, so the recorded outcome takes it.
  const [confirmedCount, setConfirmedCount] = useState(0);

  async function handleConfirm() {
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/applications/nominate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: props.token }),
      });
      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Could not confirm nomination right now.");
        return;
      }

      setMessage(
        data.movedToAdmin
          ? "Your confirmation has been recorded. Both nominators are now complete and the application has moved to committee review."
          : "Your confirmation has been recorded."
      );
      setConfirmedCount((count) => count + 1);
      router.refresh();
    } catch {
      setError("Could not confirm nomination right now.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      {/* #4949: mounted before the request, so the outcome is announced. */}
      <StatusRegion
        visible={Boolean(message)}
        visibleClassName="rounded-md border border-success-6 bg-success-3 px-4 py-3 text-sm text-success-11"
        outcomeKey={confirmedCount}
      >
        {message}
      </StatusRegion>
      <FocusedActionError id="nomination-confirm-error" error={error} className="px-4 py-3" />
      {props.canConfirm && (
        <Button onClick={handleConfirm} disabled={loading}>
          {loading ? "Confirming..." : "Agree to Nominate"}
        </Button>
      )}
    </div>
  );
}
