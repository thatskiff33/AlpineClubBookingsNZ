"use client";

import { useState } from "react";
import { toast } from "sonner";

import { fetchWithRecentAuth } from "@/components/confirm-its-you";
import { useClubFormat } from "@/components/club-format-provider";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { notifyAdminQueueChanged } from "@/lib/admin-queue-events";
import { MANUAL_PAYMENT_NOTE_MAX } from "@/lib/manual-payment-note";
import { formatCents } from "@/lib/utils";

/**
 * #5005 child D (owner decision O1, 11 Nov 2026): the second way to settle a cancelled imported booking's refund.
 * Beside "Mark paid back", the officer may give the same amount as account credit. The row offers it only when the
 * server's own rule does (`importedRefundCredit` in the payload), and the request names the amount shown, so a
 * stale screen or a second click credits nothing twice (the server refuses it).
 */
export function ManualRefundTaskImportedCredit({
  task,
  canEdit,
  onCredited,
}: {
  task: { id: string; amountCents: number | null; memberName: string; importedRefundCredit?: boolean };
  /** The finance area's edit access, as `ViewOnlyActionButton` takes it (unknown while it loads). */
  canEdit: boolean | undefined;
  onCredited: () => Promise<void> | void;
}) {
  const format = useClubFormat();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  if (task.importedRefundCredit !== true || task.amountCents === null) return null;
  const amountCents = task.amountCents;
  const amount = formatCents(amountCents, format);

  async function give() {
    setBusy(true);
    try {
      const response = await fetchWithRecentAuth(`/api/admin/payments/manual-refund-tasks/${task.id}/account-credit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true, expectedAmountCents: amountCents, note: note.trim() || null }),
      });
      const data = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
      if (!response.ok) {
        toast.error(data?.error ?? "Could not give this refund as account credit.");
      } else {
        toast.success(data?.message ?? "Given as account credit.");
        setOpen(false);
        setNote("");
        notifyAdminQueueChanged();
      }
    } catch {
      // A lost answer may hide a credit that landed: the reload shows which, and the server never credits twice.
      toast.error("Could not reach the server. Reload to see whether the refund was given as credit.");
    } finally {
      setBusy(false);
      await onCredited();
    }
  }

  return (
    <>
      <ViewOnlyActionButton canEdit={canEdit} type="button" variant="outline" onClick={() => setOpen(true)}>
        Give as account credit
      </ViewOnlyActionButton>
      <Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{`Give ${amount} to ${task.memberName} as account credit?`}</DialogTitle>
            <DialogDescription>
              Use this instead of a bank transfer. The amount is added to the member&apos;s account and used towards their
              next booking; nothing is paid to their bank. The member is emailed, and on a club with Xero a credit note is
              raised against their contact. It cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="manual-refund-task-credit-note">Note (optional)</Label>
            <Textarea
              id="manual-refund-task-credit-note"
              value={note}
              maxLength={MANUAL_PAYMENT_NOTE_MAX}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button type="button" onClick={() => void give()} disabled={busy}>Give as account credit</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
