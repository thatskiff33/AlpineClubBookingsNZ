"use client";

import { useState } from "react";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FocusedActionError } from "@/components/focused-action-error";
import type { MembershipCancellationConfirmationDetails } from "@/lib/membership-cancellation-requests";

export function MembershipCancellationConfirmCard({
  token,
  details,
}: {
  token: string;
  details: MembershipCancellationConfirmationDetails;
}) {
  const [loadingDecision, setLoadingDecision] = useState<
    "confirm" | "decline" | null
  >(null);
  const [message, setMessage] = useState(details.message);
  const [error, setError] = useState("");
  const [canRespond, setCanRespond] = useState(details.canRespond);

  async function respond(decision: "confirm" | "decline") {
    setLoadingDecision(decision);
    setError("");

    try {
      const response = await fetch(
        "/api/member/membership-cancellation-requests/confirm",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, decision }),
        },
      );
      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Could not record your response.");
        return;
      }

      setMessage(data.message || "Your response has been recorded.");
      setCanRespond(false);
    } catch {
      setError("Could not record your response.");
    } finally {
      setLoadingDecision(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* #4949: mounted before the response, so the recorded outcome is announced. */}
      <div
        role="status"
        className={
          message
            ? "rounded-md border border-info-6 bg-info-3 px-4 py-3 text-sm text-info-11"
            : "sr-only"
        }
      >
        {message}
      </div>
      <FocusedActionError
        id="membership-cancellation-confirm-error"
        error={error}
        className="px-4 py-3"
      />
      {canRespond ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            disabled={loadingDecision !== null}
            onClick={() => respond("confirm")}
          >
            <Check className="mr-2 h-4 w-4" />
            {loadingDecision === "confirm" ? "Confirming..." : "Confirm Inclusion"}
          </Button>
          <Button
            disabled={loadingDecision !== null}
            onClick={() => respond("decline")}
            variant="outline"
          >
            <X className="mr-2 h-4 w-4" />
            {loadingDecision === "decline" ? "Declining..." : "Decline"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
