"use client";

/**
 * The expired-but-payable card on the public payment link: the server's
 * narrative and the "Email me a new link" button that re-issues the link.
 *
 * Split out of `page.tsx` when #4955 (the Stripe redirect return) carried that
 * route shell past its 500-line budget for the first time, which the file-size
 * ratchet will not carry with an allowance. This branch was the cleanest seam:
 * its send state and its POST are read by nothing else on the page. Nothing
 * changed meaning in the move. Its outcomes are announced (#4949): the sent
 * confirmation in a status region and a failure in a recovery alert, both mounted
 * before the request, and each takes focus where the button that asked went away.
 */
import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useClubIdentity } from "@/components/club-identity-provider";
import { FocusedActionError } from "@/components/focused-action-error";
import { StatusRegion } from "@/components/status-region";
import { NarrativeCard, type Narrative } from "./pay-link-presentation";

export function FreshLinkCard({ token, narrative }: { token: string; narrative: Narrative }) {
  const club = useClubIdentity();
  const [refreshState, setRefreshState] = useState<"idle" | "sending" | "sent">(
    "idle"
  );
  const [refreshError, setRefreshError] = useState<string | null>(null);

  async function requestFreshLink() {
    setRefreshState("sending");
    setRefreshError(null);
    try {
      const res = await fetch(`/api/pay/${encodeURIComponent(token)}/refresh`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Unable to send a new link right now.");
      }
      if (data.emailed === false) {
        // The link was re-issued but nothing was delivered — either the address
        // previously bounced or complained (#1885), or the club has this booking
        // set to receive no email (#2258). Never claim an email is on the way,
        // and never say WHICH: the wording stays neutral so it is honest in both
        // cases and never reveals the per-booking switch to the member.
        setRefreshState("idle");
        setRefreshError(
          `We weren't able to email the link. Please contact ${club.lodgeName} and we'll help you complete payment.`
        );
        return;
      }
      setRefreshState("sent");
    } catch (err) {
      setRefreshState("idle");
      setRefreshError(
        err instanceof Error ? err.message : "Unable to send a new link right now."
      );
    }
  }

  return (
    <NarrativeCard narrative={narrative} tone="info">
      <div className="space-y-2">
        {/* "Email me a new link" unmounts once the link is sent, so the
            confirmation that replaces it takes focus. */}
        <StatusRegion visible={refreshState === "sent"} outcomeKey={refreshState === "sent"}>
          {refreshState === "sent" ? (
            <div className="flex items-start gap-2 rounded-md border border-success-6 bg-success-3 px-3 py-2 text-sm text-success-11">
              <CheckCircle2 aria-hidden className="h-5 w-5 shrink-0" />
              <p>We&apos;ve emailed you a fresh payment link. Please check your inbox.</p>
            </div>
          ) : null}
        </StatusRegion>
        {refreshState === "sent" ? null : (
          <Button onClick={requestFreshLink} disabled={refreshState === "sending"}>
            {refreshState === "sending" ? "Sending..." : "Email me a new link"}
          </Button>
        )}
        <FocusedActionError id="payment-link-refresh-error" error={refreshError ?? ""} />
      </div>
    </NarrativeCard>
  );
}
