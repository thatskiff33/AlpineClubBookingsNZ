"use client";

import { useState } from "react";
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

/**
 * F-COMP-04: Request Account Deletion button with confirmation modal.
 */
export function DeleteAccountButton() {
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
    } catch {
      setError("Failed to submit request. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-md px-3 py-2">
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
        className="text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
        onClick={() => setOpen(true)}
      >
        <AlertTriangle className="h-4 w-4 mr-2" />
        Request Account Deletion
      </Button>

      <Dialog open={open} onOpenChange={(v) => !submitting && setOpen(v)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-red-700">Request Account Deletion</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  Please read carefully before proceeding. This action is{" "}
                  <strong>irreversible</strong>.
                </p>
                <ul className="list-disc list-inside space-y-1 text-slate-600">
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
          {error && <p className="text-sm text-red-600">{error}</p>}
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
