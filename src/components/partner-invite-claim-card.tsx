"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FocusedActionError } from "@/components/focused-action-error";

export function PartnerInviteClaimCard(props: {
  token: string;
  groupName: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [joined, setJoined] = useState(false);

  async function handleClaim() {
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/members/family/partner-invite/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: props.token }),
      });
      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Could not accept this invitation right now.");
        return;
      }

      // Keep the local success state; do NOT router.refresh() — re-resolving the
      // now-claimed token would flip the page into its "already used" shell.
      setJoined(true);
      setMessage(data.message || `You have joined ${props.groupName}.`);
    } catch {
      setError("Could not accept this invitation right now.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      {/* #4949: mounted before the request, so the outcome is announced. */}
      <div
        role="status"
        className={
          message
            ? "rounded-md border border-success-6 bg-success-3 px-4 py-3 text-sm text-success-11"
            : "sr-only"
        }
      >
        {message}
      </div>
      <FocusedActionError id="partner-invite-claim-error" error={error} className="px-4 py-3" />
      {joined ? (
        <Button onClick={() => router.push("/profile")}>Go to your profile</Button>
      ) : (
        <Button onClick={handleClaim} disabled={loading}>
          {loading ? "Joining..." : `Join ${props.groupName}`}
        </Button>
      )}
    </div>
  );
}
