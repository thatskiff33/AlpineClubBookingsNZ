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
import { DISPUTED_HAND_BACK_REDUCTION_FAILED, disputedHandBackReductionSummary } from "@/lib/manual-refund-task-copy";

/**
 * #4516 (owner decision, 15 Nov 2026, comment 6893252570): a disputed card payment's hand-back whose disputes were
 * lost for part of what is still owed can be reduced by exactly that. The row offers it only when the server's own
 * rule does (`disputeReduction` in the payload); the confirmation states what the refund was, what it is reduced by
 * and what is still owed, and the request names the amount shown, so a second click or a stale screen reduces
 * nothing twice (the server refuses it).
 */
export function ManualRefundTaskDisputeReduction({
  task,
  canEdit,
  onReduced,
}: {
  task: { id: string; amountCents: number | null; disputeReduction?: { reducedByCents: number; stillOwedCents: number } | null };
  /** The finance area's edit access, as `ViewOnlyActionButton` takes it (unknown while it loads). */
  canEdit: boolean | undefined;
  onReduced: () => Promise<void> | void;
}) {
  const format = useClubFormat();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const reduction = task.disputeReduction;
  if (!reduction || task.amountCents === null) return null;
  const wasCents = task.amountCents;
  const reducedByCents = reduction.reducedByCents;
  const summary = disputedHandBackReductionSummary({ wasCents, ...reduction }, format);

  async function reduce() {
    setBusy(true);
    try {
      const response = await fetchWithRecentAuth(`/api/admin/payments/manual-refund-tasks/${task.id}/reduce-by-lost-dispute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true, expectedAmountCents: wasCents, expectedReducedByCents: reducedByCents }),
      });
      const data = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
      if (!response.ok) {
        toast.error(data?.error ?? DISPUTED_HAND_BACK_REDUCTION_FAILED);
      } else {
        toast.success(data?.message ?? "Refund reduced.");
        setOpen(false);
      }
    } catch {
      // A lost answer may hide a reduction that landed: the reload shows which, and the server never reduces twice.
      toast.error("Could not reach the server. Reload to see whether the refund was reduced.");
    } finally {
      setBusy(false);
      await onReduced();
    }
  }

  return (
    <>
      <ViewOnlyActionButton canEdit={canEdit} type="button" variant="ghost" onClick={() => setOpen(true)}>
        Reduce by lost dispute
      </ViewOnlyActionButton>
      <Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reduce this refund by the lost dispute?</DialogTitle>
            <DialogDescription data-testid="manual-refund-task-reduction-summary">{summary}</DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            The task stays open for the rest, which the club still owes. Mark it paid once that money has gone back.
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button type="button" onClick={() => void reduce()} disabled={busy}>Reduce the refund</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
