"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FocusedActionError } from "@/components/focused-action-error";
import { unverifiedWriteMessage } from "@/lib/unverified-write-copy";

interface ConfirmDraftButtonProps {
  bookingId: string;
}

export function ConfirmDraftButton({ bookingId }: ConfirmDraftButtonProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [errorAttention, setErrorAttention] = useState(0);

  async function handleConfirm() {
    setConfirming(true);
    setError("");

    try {
      const res = await fetch(`/api/bookings/${bookingId}/confirm-draft`, {
        method: "POST",
      });
      const data = (await res.json()) as { error?: string };

      if (res.ok) {
        router.refresh();
        return;
      }
      setError(data.error || "Failed to confirm booking");
      setErrorAttention((value) => value + 1);
    } catch {
      // #2668: one wording, built in one place. This sentence used to be typed
      // out here by hand — byte-identical to the others by luck rather than by
      // construction, and the first surface a future rewording would miss.
      setError(
        unverifiedWriteMessage(
          "this draft was confirmed",
          "Reload the booking and check its status before trying again.",
        ),
      );
      setErrorAttention((value) => value + 1);
    } finally {
      setConfirming(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle headingLevel={2}>Confirm Booking</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          This is a saved draft with no charge. Click below to confirm your booking.
        </p>
        <FocusedActionError
          id="confirm-draft-error"
          error={error}
          attentionKey={errorAttention}
        />
        <Button onClick={handleConfirm} disabled={confirming}>
          {confirming ? "Confirming..." : "Confirm Booking"}
        </Button>
      </CardContent>
    </Card>
  );
}
