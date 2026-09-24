"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldHint, useFieldHint } from "@/components/ui/field-hint";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { useClubTime } from "@/components/club-time-provider";
import { formatStayDate } from "@/lib/club-time";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  REOPENABLE_DISMISSAL_LIST_MAX,
  REOPENABLE_DISMISSAL_WINDOW_DAYS,
} from "@/lib/manual-refund-task-reopen-bounds";
import { formatCents } from "@/lib/utils";
import type { DismissedManualRefundTaskPayload } from "@/lib/manual-refund-task-queue-payload";

/*
  The reopen note is REQUIRED and is the only record of why a money decision was
  undone, so a width that silently truncates it is worse here than anywhere else
  this constant appears. Imported rather than copied (`INV-SSOT`): this was the
  FIFTH copy of the number and, unlike three of the others, carried no pointer
  back to the rule at all.
*/
import { MANUAL_PAYMENT_NOTE_MAX } from "@/lib/manual-payment-note";
import { useClubFormat } from "@/components/club-format-provider";

const NOTE_MAX_LENGTH = MANUAL_PAYMENT_NOTE_MAX;

/**
 * #3498 (owner decision D2): the money tasks an officer dismissed lately, and
 * the one action that puts one back.
 *
 * ## Why the card exists at all, and why it is only this
 *
 * Until #3498 every closure was terminal and the queue read `status: "OPEN"` and
 * nothing else, so a wrong dismissal was silent and permanent - no banner, no
 * row, no correction. D2 makes a dismissal undoable; a reopen action nothing
 * lists is not an action anybody can take, so the list is half of the decision
 * rather than a convenience on top of it.
 *
 * It shows what is needed to decide whether the closure was wrong and NOTHING
 * ELSE: the reason the task was raised with, the note the officer wrote when
 * they closed it, and when. No evidence block and no price boxes - those come
 * back with the row the moment it is on the queue again, on the screen that
 * prices it.
 *
 * ## A COMPLETED task is not here, and that is the point
 *
 * The route lists dismissals only, and only ones an officer closed. A completion
 * moved money down a settlement route against an anchor that enforces
 * exactly-once, and a machine-written dismissal records a refund Stripe already
 * made. Both reasons are argued in `manual-refund-task-reopen.ts`, which refuses
 * them server-side as well - this card not offering them is the courtesy, not
 * the control.
 */
/*
  THE SERVER'S OWN TYPE, imported rather than respelled beside it (`INV-SSOT`,
  #3498 fix round). The two spellings had already drifted on the field that
  matters most here: `bookingDeleted` is written unconditionally by the
  projection and was optional on this side, so a field lost in transit read as
  "not deleted" on a card whose only job is judging a closure.

  A TYPE-ONLY import, so nothing of the server module is pulled into the
  bundle; the payload module is a pure projection and imports no Prisma client.
*/
type DismissedManualRefundTask = DismissedManualRefundTaskPayload;
export type { DismissedManualRefundTask };

export function ManualRefundTaskReopenCard({
  dismissed,
  onReopened,
}: {
  dismissed: readonly DismissedManualRefundTask[];
  /** Reload the whole queue, so the reopened row appears on the OPEN card. */
  onReopened: () => Promise<void> | void;
}) {
  const format = useClubFormat();
  const [target, setTarget] = useState<DismissedManualRefundTask | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const noteHint = useFieldHint();
  const canEdit = useAdminAreaEditAccess("finance");
  /*
    `dismissedAt` is the task's `completedAt` - a real INSTANT, not a lodge
    night - so it projects through the club's PERSISTED timezone (CT-4, #2870;
    INV-CONFIG-002) rather than through the container's `TZ`. The stay dates
    below are CALENDAR DATES and need no zone at all, which is why they go
    through `formatClubDate`.
  */
  const clubTime = useClubTime();

  async function submit() {
    if (!target) return;
    setSubmitting(true);
    try {
      const response = await fetch(
        `/api/admin/payments/manual-refund-tasks/${target.id}/reopen`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmed: true, note: note.trim() || null }),
        },
      );
      const data = (await response.json().catch(() => null)) as
        | { error?: string; message?: string }
        | null;
      if (!response.ok) {
        toast.error(data?.error ?? "Could not put this item back on the queue.");
        return;
      }
      toast.success(data?.message ?? "Put back on the queue.");
      setTarget(null);
      setNote("");
      await onReopened();
    } catch {
      /*
        A rejected `fetch` also covers the case where the POST landed and only
        the answer was lost, so this deliberately does not claim nothing
        changed. Reloading is safe here in a way it is not on the settle card:
        this action moves no money, and the reload is exactly how the officer
        finds out which of the two happened.
      */
      toast.error(
        "We could not tell whether that went through. Reload the page and check whether it is back on the queue.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card data-testid="dismissed-manual-refund-tasks">
      <CardHeader>
        <CardTitle className="text-base">
          Closed with no adjustment, lately ({dismissed.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          These were looked at and closed without any money moving. If one was
          closed by mistake, put it back on the queue and it can be priced and
          settled like any other. Anything that was actually paid or credited is
          not here: that money has moved, and a correction to it belongs on the
          booking.
        </p>
        {/*
          #3498 fix round: SAY THE BOUND. The list is the last
          {REOPENABLE_DISMISSAL_WINDOW_DAYS} days and at most
          {REOPENABLE_DISMISSAL_LIST_MAX} rows, and an officer who dismissed
          something five weeks ago was finding nothing here and being told
          nothing about why - while the card beside this one publishes its own
          bound. It is deliberately phrased as a fact about the LIST: the reopen
          door refuses on status and on who closed the row, never on age, so
          nothing here may read as "too old to correct".
        */}
        <p className="text-xs text-muted-foreground">
          This list shows closures from the last{" "}
          {REOPENABLE_DISMISSAL_WINDOW_DAYS} days, up to{" "}
          {REOPENABLE_DISMISSAL_LIST_MAX}. An older one is not off limits - it
          is simply not listed here; ask the club administrator to find it.
        </p>
        <ul className="space-y-3">
          {dismissed.map((task) => (
            <li
              key={task.id}
              className="space-y-1 rounded-md border border-border px-3 py-2 text-sm"
              data-testid="dismissed-manual-refund-task"
            >
              {/*
                #3498 fix round: a null amount is SAID, not omitted. It is not
                an edge case here - every parked-edit closure has one, because
                a parked edit's amount is exactly what nobody could work out -
                and a row showing only a name reads as a row with nothing on
                it. The open queue answers the same null in the same words
                (`unknownAmountLabel`). Never a fabricated $0.00.
              */}
              <p className="font-medium">
                {task.memberName}
                {" · "}
                {task.amountCents === null
                  ? "no amount was recorded"
                  : formatCents(task.amountCents, format)}
              </p>
              <p className="text-xs text-muted-foreground">
                Stay {formatStayDate(task.checkIn)} to{" "}
                {formatStayDate(task.checkOut)}
                {task.bookingDeleted
                  ? " · this booking has since been deleted"
                  : ""}
              </p>
              <p className="text-xs text-muted-foreground">{task.reason}</p>
              <p className="text-xs text-muted-foreground">
                Closed
                {task.dismissedAt
                  ? ` on ${clubTime.instantDate(new Date(task.dismissedAt))}`
                  : ""}
                {task.note ? `: ${task.note}` : " with no note."}
              </p>
              <p className="text-xs text-muted-foreground">
                Booking {task.bookingId}
              </p>
              <ViewOnlyActionButton
                canEdit={canEdit}
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setTarget(task);
                  setNote("");
                }}
              >
                Put back on the queue
              </ViewOnlyActionButton>
            </li>
          ))}
        </ul>

        <Dialog
          open={target !== null}
          onOpenChange={(open) => {
            if (!open && !submitting) {
              setTarget(null);
              setNote("");
            }
          }}
        >
          <DialogContent>
            {target ? (
              <>
                <DialogHeader>
                  <DialogTitle>
                    Put this back on the queue for {target.memberName}?
                  </DialogTitle>
                  <DialogDescription>
                    It becomes an open money question again: it goes back on the
                    settlement queue, the member sees that the club is still
                    working the change out, and a further price change to this
                    booking is held until it is settled. Nothing is paid, charged
                    or credited by this.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-2">
                  <Label htmlFor="manual-refund-task-reopen-note">
                    Note (required)
                  </Label>
                  <Textarea
                    id="manual-refund-task-reopen-note"
                    value={note}
                    maxLength={NOTE_MAX_LENGTH}
                    onChange={(event) => setNote(event.target.value)}
                    {...noteHint.fieldProps}
                  />
                  <FieldHint {...noteHint.hintProps}>
                    e.g. closed by mistake while working a booking that raised
                    several rows
                  </FieldHint>
                </div>
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => setTarget(null)}
                    disabled={submitting}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={submit}
                    disabled={submitting || note.trim().length === 0}
                  >
                    Put back on the queue
                  </Button>
                </DialogFooter>
              </>
            ) : null}
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
