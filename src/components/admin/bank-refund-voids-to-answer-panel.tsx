"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { Landmark } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FocusedActionError } from "@/components/focused-action-error";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { useClubFormat } from "@/components/club-format-provider";
import { useClubTime } from "@/components/club-time-provider";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { MANUAL_PAYMENT_NOTE_MAX } from "@/lib/manual-payment-note";
import { formatCents } from "@/lib/utils";

/** One voided note a person looks at, as `listBankRefundVoidsToAnswerRows` returns it (serialised). */
export interface BankRefundVoidToAnswerRow {
  linkId: string;
  bookingId: string;
  bookingReference: string;
  creditNoteNumber: string | null;
  amountCents: number | null;
  /** What is left of it to pick: less than the amount once some refunds are picked; null when the amount cannot be read. */
  remainingCents: number | null;
  /** When the app found the note voided - not Xero's own void time. */
  foundVoidedAt: string;
  /** Why it is here: unmatched (a reason), or `deferred` too long. */
  reason: string;
  /** The payment's live bank refunds a person may pick as one the note recorded; `matchesNote` when it is exactly what is left. */
  pickableLines: ReadonlyArray<{ lineId: string; amountCents: number; matchesNote: boolean; recordedAt: string | null }>;
  /** Bank refunds not offered because their own live notes in Xero still record part of them. */
  partlyCoveredLines: ReadonlyArray<{ lineId: string; amountCents: number; coveredCents: number; recordedAt: string | null }>;
}

/**
 * Final review (security low 3): why an unmatched note has no bank refund to
 * pick, in one line. A card refund's record has its own fuller line below.
 */
const NOTHING_TO_PICK_REASONS: Record<string, string> = {
  "no-line": "No bank refund on this payment is left that this note could have recorded.",
  ambiguous: "No bank refund on this payment is left that this note could have recorded.",
  "partly-picked": "The rest of its amount matches no bank refund left on this payment.",
  "detail-short": "The payment's records no longer hold a refund it could have recorded, so there is nothing to take back.",
  "coverage-unknown": "A credit note resolved by hand in Xero has no amount the app can read, so the app cannot tell what Xero still records.",
  "amount-unknown": "Its amount cannot be read, and no bank refund on this payment is left to pick.",
  "card-refund":
    "It recorded a card refund made through Stripe, which stays recorded: there is no bank refund to take back. The app never raises its credit note again, not even after a later refund of the same payment, so raise one by hand in Xero if that refund should still show there. If Stripe failed that refund later and the app sent it again, this note may also have stood for the refund sent in its place: check whether that refund has a credit note of its own in Xero for its full amount, and if not, raise one by hand for what is missing.",
};

type Target = { row: BankRefundVoidToAnswerRow; mode: "pick" | "answer" };

/**
 * #4162 (owner decisions 17 and 18 Oct 2026, `INV-ADDPAY-042`): voided
 * bank-transfer refund notes the nightly follow-up could not match to one
 * refund. A person picks the bank refund the note recorded, and the app runs
 * the same undo as for a matched note: the refund comes out of the payment's
 * records and "Refund to re-confirm" goes on Money to settle. A note that
 * recorded a card refund's record has nothing to pick: its note is re-raised
 * from the Xero repair tool, then the answer is recorded here. Voids deferred
 * for more than a week are listed too, so they cannot hide.
 *
 * `finance:view` to see, `finance:edit` to act; the banner states the
 * view-only reason once. While the follow-up is report-only every item is
 * read-only and the panel says actions turn on with the switch.
 */
export function BankRefundVoidsToAnswerPanel({
  rows,
  writesEnabled,
}: {
  rows: readonly BankRefundVoidToAnswerRow[];
  writesEnabled: boolean;
}) {
  const canEdit = useAdminAreaEditAccess("finance");
  const format = useClubFormat();
  const clubTime = useClubTime();
  const router = useRouter();
  const noteId = useId();
  const errorId = useId();
  const choiceName = useId();
  const [target, setTarget] = useState<Target | null>(null);
  const [pickedLineId, setPickedLineId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorAttention, setErrorAttention] = useState(0);
  const [listNotice, setListNotice] = useState("");

  const current = target === null ? null : (rows.find((row) => row.linkId === target.row.linkId) ?? null);
  if (target !== null && current === null && !busy) {
    setTarget(null);
    setListNotice("That voided refund note no longer needs anything here, so its dialog was closed. The list is up to date.");
  }
  if (rows.length === 0 && listNotice === "") return null;

  const amountOf = (cents: number | null) => (cents === null ? "an amount the app cannot read" : formatCents(cents, format));
  const foundOn = (row: BankRefundVoidToAnswerRow) => clubTime.instantDate(new Date(row.foundVoidedAt));

  function open(row: BankRefundVoidToAnswerRow, mode: Target["mode"]) {
    setTarget({ row, mode });
    setPickedLineId(null);
    setNote("");
    setError("");
    setListNotice("");
  }

  async function submit() {
    if (!target) return;
    setBusy(true);
    setError("");
    try {
      const pick = target.mode === "pick";
      const res = await fetch(`/api/admin/payments/bank-refund-voids/${target.row.linkId}/${pick ? "pick" : "answered"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pick ? { lineId: pickedLineId, confirmed: true } : { note, confirmed: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Could not record that.");
        setErrorAttention((count) => count + 1);
        if (res.status === 409) router.refresh();
        return;
      }
      toast.success(
        pick
          ? "Done. The refund was taken back out of the payment's records and is on Money to settle to re-confirm."
          : "Answer recorded. Nothing in the club's records moved.",
      );
      setListNotice(`The voided refund note on booking ${target.row.bookingReference} was dealt with.`);
      setTarget(null);
      router.refresh();
    } catch {
      setError("Could not record that.");
      setErrorAttention((count) => count + 1);
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = target !== null && !busy && (target.mode === "pick" ? pickedLineId !== null : note.trim() !== "");

  return (
    <Card id="bank-refund-voids">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Landmark className="h-5 w-5 text-muted-foreground" />
          Voided bank refund notes to answer
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <AdminViewOnlySectionBanner canEdit={canEdit} />
        <p className="text-sm text-muted-foreground">
          Xero voided the credit note that recorded each of these bank refunds, and the app could not tell which refund
          it was for. Pick the refund the note recorded: the app takes it back out of the payment&apos;s records and puts
          it on Money to settle, where you answer whether the money went to the member.
        </p>
        {writesEnabled ? null : (
          <p className="text-sm font-medium text-warning-11" data-testid="bank-refund-voids-report-only">
            These are shown for information only. Actions here turn on when the club switches the voided-refund
            follow-up on; until then nothing is changed.
          </p>
        )}
        <p role="status" className="text-sm text-muted-foreground empty:hidden">
          {listNotice}
        </p>
        <ul className="space-y-2" aria-label="Voided bank refund notes to answer">
          {rows.map((row) => {
            const deferred = row.reason === "deferred";
            const pickable = row.pickableLines.length > 0;
            return (
              <li key={row.linkId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted p-2">
                <div>
                  <div className="text-sm font-medium">
                    <Link href={`/admin/bookings/${row.bookingId}`} className="underline">
                      Booking {row.bookingReference}
                    </Link>
                    {" - "}
                    {amountOf(row.amountCents)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Credit note {row.creditNoteNumber ?? "(no number)"} found voided {foundOn(row)}
                  </div>
                  {deferred ? (
                    <div className="text-xs text-muted-foreground">
                      Waiting for another credit note on this payment to finish in Xero for over a week. Check the
                      payment&apos;s Xero operations.
                    </div>
                  ) : row.reason === "paid-another-way" ? (
                    <div className="text-xs text-muted-foreground">
                      It recorded a card refund the club paid back another way. That refund stays recorded: raise its
                      credit note again from the Xero repair tool, then record the answer here.
                    </div>
                  ) : !pickable ? (
                    <div className="text-xs text-muted-foreground">
                      {NOTHING_TO_PICK_REASONS[row.reason] ?? "No bank refund on this payment is left to pick for it."} Check
                      the payment in Xero, then record what you found.
                    </div>
                  ) : row.amountCents === null ? (
                    <div className="text-xs text-muted-foreground">
                      Its amount cannot be read, so you can pick one refund for it.
                    </div>
                  ) : row.remainingCents !== null && row.remainingCents < row.amountCents ? (
                    <div className="text-xs text-muted-foreground">
                      Some of the refunds it recorded are picked; {formatCents(row.remainingCents, format)} is still to pick.
                    </div>
                  ) : null}
                  {row.partlyCoveredLines.map((line) => (
                    <div key={line.lineId} className="text-xs text-muted-foreground">
                      {formatCents(line.coveredCents, format)} of the {formatCents(line.amountCents, format)} refund
                      {line.recordedAt ? ` marked paid back ${clubTime.instantDate(new Date(line.recordedAt))}` : ""} still has a
                      live note in Xero, so it is not offered here. If the voided note recorded the rest of it, check Xero and
                      record the answer.
                    </div>
                  ))}
                </div>
                {deferred || !writesEnabled ? null : (
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    describeReason={false}
                    variant="outline"
                    size="sm"
                    aria-label={`${pickable ? "Pick the refund for" : "Answer"} the voided refund note on booking ${row.bookingReference}`}
                    onClick={() => open(row, pickable ? "pick" : "answer")}
                  >
                    {pickable ? "Pick the refund" : "Record the answer"}
                  </ViewOnlyActionButton>
                )}
              </li>
            );
          })}
        </ul>

        <Dialog open={target !== null} onOpenChange={(next) => !busy && !next && setTarget(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {target?.mode === "pick" ? "Which bank refund did this note record?" : "What did you do about this note?"}
              </DialogTitle>
              <DialogDescription>
                {target
                  ? `Booking ${target.row.bookingReference}: Xero credit note ${target.row.creditNoteNumber ?? "(no number)"} for ${amountOf(target.row.amountCents)} was found voided ${foundOn(target.row)}.`
                  : null}
              </DialogDescription>
            </DialogHeader>
            {target?.mode === "pick" ? (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">The payment&apos;s bank refunds</legend>
                {target.row.pickableLines.map((line) => (
                  <label key={line.lineId} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name={choiceName}
                      className="size-4"
                      checked={pickedLineId === line.lineId}
                      onChange={() => setPickedLineId(line.lineId)}
                    />
                    <span>
                      {formatCents(line.amountCents, format)}
                      {line.recordedAt ? `, marked paid back ${clubTime.instantDate(new Date(line.recordedAt))}` : ""}
                      {line.matchesNote ? (
                        <span className="font-medium">
                          {target.row.remainingCents !== target.row.amountCents
                            ? " - matches what is left of the note"
                            : " - matches the note's amount"}
                        </span>
                      ) : null}
                    </span>
                  </label>
                ))}
                <p className="text-xs text-muted-foreground">
                  The refund you pick is taken back out of the payment&apos;s records and goes on Money to settle to
                  re-confirm. Nothing is sent to the member or raised in Xero.{" "}
                  {target.row.amountCents === null
                    ? "The note's amount cannot be read, so it takes one pick only."
                    : "If the note recorded more than one refund, pick them one at a time; it stays on this list until the picks add up to its amount."}
                </p>
              </fieldset>
            ) : (
              <div className="space-y-1">
                <Label htmlFor={noteId}>What did you find, and what did you do? (required)</Label>
                <Textarea
                  id={noteId}
                  value={note}
                  required
                  aria-required="true"
                  maxLength={MANUAL_PAYMENT_NOTE_MAX}
                  placeholder={
                    target?.row.reason === "paid-another-way"
                      ? "For example: re-raised the card refund's credit note from the Xero repair tool"
                      : "For example: what you checked in Xero, and what you found"
                  }
                  onChange={(event) => setNote(event.target.value)}
                />
              </div>
            )}
            <FocusedActionError id={errorId} error={error} attentionKey={errorAttention} />
            <DialogFooter className="gap-2 sm:gap-2">
              <Button variant="outline" disabled={busy} onClick={() => setTarget(null)}>
                Cancel
              </Button>
              <Button disabled={!canSubmit} onClick={() => void submit()}>
                {busy ? "Recording..." : target?.mode === "pick" ? "Take this refund back" : "Record the answer"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
