"use client";

import { useState } from "react";
import { useActionFocusReturn } from "@/hooks/use-scroll-to-feedback";

/**
 * The "Request Admin Review" submission, as the edit panel holds it: the
 * member's reason, the request in flight, and what the server said.
 *
 * The button is disabled while the request runs, which drops its focus to the
 * page; a refusal leaves it in place, so focus is handed back (#5442).
 */
export function useChangeRequestSubmission(bookingId: string) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const focusReturn = useActionFocusReturn();

  /** Send the proposal `buildBody` makes; resolves whether it was taken. */
  async function submit(buildBody: () => object): Promise<boolean> {
    setError("");
    setSuccess("");
    focusReturn.capture();
    setSubmitting(true);

    try {
      const res = await fetch(`/api/bookings/${bookingId}/change-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...buildBody(),
          reason: reason.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to submit request");
        return false;
      }

      setReason("");
      setSuccess("Request sent to admins");
      return true;
    } catch {
      setError("Failed to submit request");
      return false;
    } finally {
      setSubmitting(false);
      focusReturn.release();
    }
  }

  return { reason, setReason, submitting, error, success, submit };
}
