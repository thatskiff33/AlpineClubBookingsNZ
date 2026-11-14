"use client";

import { useRef, useState } from "react";
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
import { FocusedActionError } from "@/components/focused-action-error";
import { StatusRegion } from "@/components/status-region";
import { AlertTriangle } from "lucide-react";
import { focusAndKeepInView } from "@/hooks/use-scroll-to-feedback";

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
  const statusRef = useRef<HTMLDivElement>(null);

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
      // Brings the server-read state in line for the rest of the page.
      router.refresh();
    } catch {
      setError("Failed to submit request. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // #4956: an open request read by the server, and none made in this view. A
  // static, server-read notice, not a live region: it is shown on load, so
  // there is nothing to announce. "May", not "will": an admin can reject without
  // emailing the member (`notifyMember: false`), and this notice now outlives
  // the page view.
  //
  // `!submitted` is what keeps the confirmation below the only live region.
  // After a submission here, `router.refresh()` brings `pendingRequest` in; if
  // that swapped the confirmation for this notice, the status region would be
  // replaced under the member's focus, and a changed or second `role="status"`
  // could be read a second time. The confirmation instead stays as it is, with
  // its text unchanged and its focus kept, and the dated notice takes over from
  // the next server render (a reload, or a return to the page).
  if (pendingRequest && !submitted) {
    return (
      <p className="text-sm text-info-11 bg-info-3 border border-info-6 rounded-md px-3 py-2">
        You asked for your account to be deleted on {pendingRequest.requestedOn}.
        An admin will review it and may contact you by email.
      </p>
    );
  }

  // #4949: the confirmation fills a status region mounted with the button, so
  // it is announced rather than inserted already filled. The button it replaces
  // is gone by the time the dialog closes, so focus goes to the confirmation
  // instead of Radix's restore dropping it on the page.
  return (
    <>
      <StatusRegion
        ref={statusRef}
        visible={submitted}
        visibleClassName="text-sm text-success-11 bg-success-3 border border-success-6 rounded-md px-3 py-2"
      >
        {submitted
          ? "Your deletion request has been submitted. An admin will review it and may contact you by email."
          : null}
      </StatusRegion>
      {submitted ? null : (
        <Button
          variant="outline"
          size="sm"
          className="text-danger-11 border-danger-6 hover:bg-danger-3 hover:text-danger-11"
          onClick={() => setOpen(true)}
        >
          <AlertTriangle className="h-4 w-4 mr-2" />
          Request Account Deletion
        </Button>
      )}

      <Dialog open={open} onOpenChange={(v) => !submitting && setOpen(v)}>
        <DialogContent
          onCloseAutoFocus={(event) => {
            if (!submitted) return;
            event.preventDefault();
            focusAndKeepInView(statusRef.current);
          }}
        >
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
          <FocusedActionError id="delete-account-error" error={error ?? ""} />
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
