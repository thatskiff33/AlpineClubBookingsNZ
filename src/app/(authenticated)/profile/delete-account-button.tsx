"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { AlertTriangle } from "lucide-react";

/** The member's open deletion request, its date already in club time. */
export interface PendingDeletionRequest {
  requestedOn: string;
}

/**
 * F-COMP-04: Request Account Deletion button with confirmation modal.
 *
 * #4956: while the member has an open request (read by the profile page through
 * `OPEN_DELETION_REQUEST_STATUSES`), a lasting notice replaces the button, so a
 * reload never offers the irreversible-action dialog again.
 */
export function DeleteAccountButton({
  pendingRequest = null,
}: {
  pendingRequest?: PendingDeletionRequest | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/member/request-deletion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason || undefined }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error || "Failed to submit request.");
        return;
      }
      setSubmitted(true);
      setOpen(false);
      // The server-read notice (with the request's date) takes over.
      router.refresh();
    } catch {
      setError("Failed to submit request. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (pendingRequest) {
    return (
      <p
        role="status"
        className="text-sm text-info-11 bg-info-3 border border-info-6 rounded-md px-3 py-2"
      >
        You asked for your account to be deleted on {pendingRequest.requestedOn}.
        An admin will review it and contact you by email.
      </p>
    );
  }

  if (submitted) {
    return (
      <p
        role="status"
        className="text-sm text-success-11 bg-success-3 border border-success-6 rounded-md px-3 py-2"
      >
        Your deletion request has been submitted. An admin will review it and
        contact you by email.
      </p>
    );
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="text-danger-11 border-danger-6 hover:bg-danger-3 hover:text-danger-11"
        onClick={() => setOpen(true)}
      >
        <AlertTriangle className="h-4 w-4 mr-2" />
        Request Account Deletion
      </Button>

      <Dialog open={open} onOpenChange={(v) => !submitting && setOpen(v)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-danger-11">Request Account Deletion</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  Please read carefully before proceeding. This action is{" "}
                  <strong>irreversible</strong>.
                </p>
                <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                  <li>All future bookings will be cancelled with applicable refunds</li>
                  <li>
                    Your personal details (name, email, phone, date of birth) will
                    be removed
                  </li>
                  <li>Your account will be deactivated and you cannot log in</li>
                  <li>
                    Booking history, payments, and audit records are retained for
                    financial and legal purposes with your details anonymised
                  </li>
                </ul>
                <p>
                  An admin will review your request and confirm by email before
                  deletion is processed.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="deletion-reason">
              Reason (optional)
            </Label>
            <Textarea
              id="deletion-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why are you requesting deletion? (optional)"
              maxLength={500}
              rows={3}
            />
          </div>
          {error && <p className="text-sm text-danger-11">{error}</p>}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleSubmit}
              disabled={submitting}
            >
              {submitting ? "Submitting..." : "Submit Deletion Request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
