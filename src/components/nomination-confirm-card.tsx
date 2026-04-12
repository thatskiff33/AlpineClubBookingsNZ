"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function NominationConfirmCard(props: {
  token: string;
  canConfirm: boolean;
  initialMessage?: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState(props.initialMessage ?? "");

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
      router.refresh();
    } catch {
      setError("Could not confirm nomination right now.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      {message && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          {message}
        </div>
      )}
      {error && (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {props.canConfirm && (
        <Button onClick={handleConfirm} disabled={loading}>
          {loading ? "Confirming..." : "Agree to Nominate"}
        </Button>
      )}
    </div>
  );
}
