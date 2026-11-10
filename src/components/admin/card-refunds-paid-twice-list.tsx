"use client";

import { useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FocusedActionError } from "@/components/focused-action-error";
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
import { AdminViewOnlySectionBanner, ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { RefundListCard, useShownOnceItHadRows } from "@/components/admin/card-refund-list-card";
import { useClubFormat } from "@/components/club-format-provider";
import { useClubTime } from "@/components/club-time-provider";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { MANUAL_PAYMENT_NOTE_MAX } from "@/lib/manual-payment-note";
import { formatCents } from "@/lib/utils";

/** One card refund closed as paid another way that Stripe also refunded, as `listCardRefundsPaidTwice` (`card-refund-paid-twice.ts`) returns it. */
export interface CardRefundPaidTwicePanelRow {
  operationId: string;
  bookingId: string;
  bookingReference: string;
  closedAt: string;
  paidAnotherWayCents: number;
  refundedByCardCents: number;
}

/**
 * #3924 round 5 (concurrency F2): card refunds the treasurer closed as paid
 * another way that Stripe refunded to the card as well - its refund was made
 * before the close and reached the app after it. The member has that money
 * twice; recovering it is the treasurer's, outside the app.
 *
 * #3372 (owner, 9 Oct 2026: "Add a 'Resolved' button"): once it is sorted out
 * with the member, the treasurer marks the row Resolved with a note saying how.
 * The note is audited and the row leaves the list; nothing moves in the app or
 * in Xero. Gated `finance:edit` like the close, with its own section banner
 * (`describeReason={false}` on the row buttons). The Resolved carries the card
 * figure the dialog showed, and the server refuses a moved one (#3924 round 8),
 * so a Stripe refund the treasurer never saw is never marked resolved. A 409
 * shows in the dialog and refreshes the list; if the refresh drops the row the
 * dialog closes and says why, and if the card figure moved it says so. After a
 * success, or the row dropping (round 10), focus moves to the list's status
 * line, which says what happened.
 */
export function CardRefundsPaidTwiceList({ rows }: { rows: CardRefundPaidTwicePanelRow[] }) {
  const canEdit = useAdminAreaEditAccess("finance");
  const format = useClubFormat();
  const clubTime = useClubTime();
  const router = useRouter();
  const noteId = useId();
  const errorId = useId();
  const submitHintId = useId();
  const [targetId, setTargetId] = useState<string | null>(null);
  // Round 8 (concurrency): the card figure the dialog showed, sent with the
  // Resolved; a Stripe refund recorded since is refused with a 409.
  const [seenRefundedByCardCents, setSeenRefundedByCardCents] = useState<number | null>(null);
  const [cardChanged, setCardChanged] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorAttention, setErrorAttention] = useState(0);
  const [listNotice, setListNotice] = useState("");
  // Round 10: focus goes to the status line on any close that leaves a notice
  // - a success, or the row vanishing under the dialog.
  const listNoticeRef = useRef<HTMLParagraphElement>(null);
  const shown = useShownOnceItHadRows(rows.length);

  const target = targetId === null ? null : (rows.find((row) => row.operationId === targetId) ?? null);
  if (targetId !== null && target === null && !busy) {
    setTargetId(null);
    setListNotice("That card refund is no longer on this list, so its dialog was closed. The list is up to date.");
  }
  if (target !== null && seenRefundedByCardCents !== null && target.refundedByCardCents !== seenRefundedByCardCents) {
    setSeenRefundedByCardCents(target.refundedByCardCents);
    setCardChanged(
      `Stripe has now refunded ${formatCents(target.refundedByCardCents, format)} to the card. Check it is sorted out before marking it resolved.`,
    );
  }
  const noteMissing = note.trim() === "";
  const canSubmit = target !== null && !noteMissing && !busy;

  function open(row: CardRefundPaidTwicePanelRow) {
    setTargetId(row.operationId);
    setSeenRefundedByCardCents(row.refundedByCardCents);
    setCardChanged("");
    setNote("");
    setError("");
    setListNotice("");
  }

  function fail(message: string) {
    setError(message);
    setErrorAttention((count) => count + 1);
  }

  async function submit() {
    if (!target) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/payments/card-refunds/${target.operationId}/paid-twice-resolved`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          note,
          expectedRefundedByCardCents: seenRefundedByCardCents ?? target.refundedByCardCents,
          confirmed: true,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        fail(typeof data.error === "string" ? data.error : "Could not mark it resolved.");
        if (res.status === 409) router.refresh();
        return;
      }
      toast.success(`Marked resolved. Booking ${target.bookingReference} has left the list, and your note is in the audit log.`);
      setListNotice(`Booking ${target.bookingReference} was marked resolved.`);
      setTargetId(null);
      router.refresh();
    } catch {
      fail("Could not mark it resolved.");
    } finally {
      setBusy(false);
    }
  }

  if (!shown) return null;
  return (
    <RefundListCard title="Card refunds paid back twice">
      <div className="space-y-3">
        <AdminViewOnlySectionBanner canEdit={canEdit} />
        <p className="text-sm text-muted-foreground">
          Each of these card refunds was closed as paid another way, and then Stripe refunded the card as well,
          so the member was paid back twice. Contact the member to recover the extra money, and record what you
          agree in Xero. Then mark it Resolved, saying how it was sorted out.
        </p>
        <p
          ref={listNoticeRef}
          role="status"
          tabIndex={-1}
          className="text-sm text-muted-foreground outline-none empty:hidden"
        >
          {listNotice}
        </p>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No card refunds paid back twice are left to resolve.</p>
        ) : null}
        <ul className="space-y-2" aria-label="Card refunds paid back twice">
          {rows.map((row) => (
            <li
              key={row.operationId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted p-2"
            >
              <div>
                <div className="text-sm font-medium">
                  <Link href={`/admin/bookings/${row.bookingId}`} className="underline">
                    Booking {row.bookingReference}
                  </Link>
                  {" - "}
                  {formatCents(row.refundedByCardCents, format)} refunded to the card after{" "}
                  {formatCents(row.paidAnotherWayCents, format)} was paid back another way
                </div>
                <div className="text-xs text-muted-foreground">
                  Closed as paid another way {clubTime.instantDate(new Date(row.closedAt))}
                </div>
              </div>
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                variant="outline"
                size="sm"
                aria-label={`Mark booking ${row.bookingReference} resolved`}
                onClick={() => open(row)}
              >
                Resolved
              </ViewOnlyActionButton>
            </li>
          ))}
        </ul>

        <Dialog open={target !== null} onOpenChange={(next) => !busy && !next && setTargetId(null)}>
          <DialogContent
            className="max-h-[90vh] overflow-y-auto"
            onCloseAutoFocus={(event) => {
              if (listNotice === "") return;
              event.preventDefault();
              listNoticeRef.current?.focus();
            }}
          >
            <DialogHeader>
              <DialogTitle>Mark this card refund, paid back twice, as resolved?</DialogTitle>
              <DialogDescription>
                Only once it is sorted out with the member. It leaves this list, and your note is kept in the audit
                log. Nothing is refunded or charged, and nothing is sent to Xero: record what you agreed there yourself.
              </DialogDescription>
            </DialogHeader>
            <p className="text-sm font-medium text-foreground">
              {target
                ? `Booking ${target.bookingReference}: ${formatCents(target.refundedByCardCents, format)} refunded to the card after ${formatCents(target.paidAnotherWayCents, format)} was paid back another way.`
                : null}
            </p>
            {/* Always mounted, so a screen reader hears the change (round 8). */}
            <p role="status" className="text-sm font-medium text-warning-11 empty:hidden">
              {cardChanged}
            </p>
            <div className="space-y-1">
              <Label htmlFor={noteId}>How was it sorted out? (required)</Label>
              <Textarea
                id={noteId}
                value={note}
                required
                aria-required="true"
                maxLength={MANUAL_PAYMENT_NOTE_MAX}
                placeholder="For example: member paid the extra back by bank transfer on 12 Oct, reference REF123"
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
            <FocusedActionError id={errorId} error={error} attentionKey={errorAttention} />
            <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center sm:gap-2">
              {target !== null && noteMissing && !busy ? (
                <p id={submitHintId} className="text-xs text-muted-foreground sm:mr-auto">
                  Say how it was sorted out to mark it resolved.
                </p>
              ) : null}
              <Button variant="outline" disabled={busy} onClick={() => setTargetId(null)}>
                Cancel
              </Button>
              <Button
                disabled={!canSubmit}
                aria-describedby={target !== null && noteMissing && !busy ? submitHintId : undefined}
                onClick={() => void submit()}
              >
                {busy ? "Saving..." : "Mark resolved"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </RefundListCard>
  );
}
