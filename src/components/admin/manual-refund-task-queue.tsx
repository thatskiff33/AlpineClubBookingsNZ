"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
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
import { FocusedActionError } from "@/components/focused-action-error";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { formatCents } from "@/lib/utils";
import { useClubTime } from "@/components/club-time-provider";
import {
  calendarDateOfSerialisedDbDate,
  formatClubDate,
} from "@/lib/club-time";
import { unverifiedWriteMessage } from "@/lib/unverified-write-copy";

const NOTE_MAX_LENGTH = 500;

interface ManualRefundTask {
  id: string;
  bookingId: string;
  // #2797 (owner decision D2): NULL on an EDIT_FINANCIAL_REVIEW task whose
  // amount the club has not yet priced. Rendered as "Awaiting pricing", never
  // as $0.00 — a magic zero would read as "assessed at nothing".
  amountCents: number | null;
  reason: string;
  createdAt: string;
  memberName: string;
  checkIn: string;
  checkOut: string;
}

/**
 * #2797: how a task's amount reads in the queue. A priced task shows the money;
 * an unpriced EDIT_FINANCIAL_REVIEW task shows that it is waiting for the club
 * to price it, so nobody mistakes an unknown amount for a settled $0.00.
 */
function formatTaskAmount(amountCents: number | null): string {
  return amountCents === null ? "Awaiting pricing" : formatCents(amountCents);
}

/**
 * A refund the club never decided: a payment landed on a booking that had
 * already been cancelled — deleted or not — and Stripe handed it straight back
 * (#2750, widened to both populations by #2760).
 */
interface AutoRefundedNotice {
  id: string;
  bookingId: string;
  amountCents: number;
  reason: string;
  note: string | null;
  refundedAt: string | null;
  /**
   * #2760: the booking has since been deleted, as opposed to being cancelled and
   * still on file. It decides which group the row is shown in, because the two
   * need different follow-up. Optional so a cached client against a pre-#2760
   * route still renders (it falls into the cancelled group, which claims less).
   */
  bookingDeleted?: boolean;
  memberName: string;
  checkIn: string;
  checkOut: string;
}

/**
 * One row of the record. Extracted when #2760 gave the card two groups, so both
 * groups print identical rows and neither can drift into saying more than the
 * other about a money movement.
 *
 * NO "View booking" LINK, unlike the hand-back queue above, and the difference is
 * not an oversight (#2750 review, re-justified for #2760's second population).
 *
 * For a DELETED booking the detail page 404s for anybody who is not a Full Admin.
 * For a booking that is merely cancelled the page exists - but it is gated on
 * `bookings:view`, and this card is gated on `finance:view`, which a Finance
 * Viewer holds with no bookings access at all. So a link would be a dead end for
 * part of this card's audience either way, and widening who may open a deleted
 * booking is explicitly not on the table. The identifiers are printed as plain
 * text instead, which is what a Full Admin needs to look the booking up and what a
 * finance operator needs to quote it to somebody who can.
 */
/**
 * A lodge night as the calendar day it IS - no timezone, because a calendar day
 * has none (CT-4, #2870; INV-DATE-010). `checkIn`/`checkOut` are `@db.Date`
 * columns and cross the wire as UTC midnight; the kernel's calendar-date
 * formatter pins UTC over that encoding, so the projection is the identity.
 * What this replaces read the day through a zone - correct east of Greenwich, a
 * day early west of it.
 */
function formatStayDate(value: string): string {
  return formatClubDate(calendarDateOfSerialisedDbDate(value));
}

function AutomaticRefundNoticeRow({ notice }: { notice: AutoRefundedNotice }) {
  /**
   * `refundedAt` is the payment task's `completedAt` - a real INSTANT, not a
   * lodge night - so it projects through the club's PERSISTED timezone (CT-4,
   * #2870; INV-CONFIG-002). `instantDate` keeps the medium "16 Apr 2026" shape
   * this row has always shown; only the zone's AUTHORITY changed, from the
   * container's `TZ` to the club's recorded setting.
   */
  const clubTime = useClubTime();
  return (
    <li className="space-y-1 rounded-md border border-border px-3 py-2 text-sm">
      <p className="font-medium text-foreground">
        {notice.memberName} - {formatCents(notice.amountCents)} refunded
        {notice.refundedAt
          ? ` on ${clubTime.instantDate(new Date(notice.refundedAt))}`
          : ""}
      </p>
      <p className="text-muted-foreground">
        {formatStayDate(notice.checkIn)} to{" "}
        {formatStayDate(notice.checkOut)} - booking{" "}
        <span className="font-mono text-xs">{notice.bookingId}</span>
      </p>
      {/*
        Both sentences, not one. The reason names the situation that produced the
        payment; the note says that Stripe already handed the money back. An
        operator reading only the reason - which, on a deleted booking, asks them
        to decide whether to refund - would think the decision is still theirs.
      */}
      <p className="text-xs text-muted-foreground">{notice.reason}</p>
      {notice.note ? (
        <p className="text-xs text-muted-foreground">{notice.note}</p>
      ) : null}
    </li>
  );
}

/**
 * The read-only record of a refund nobody authorised (#2750, completed by #2760).
 *
 * Deliberately buttonless. There is no decision left on these rows - Stripe
 * returned the money before anybody saw the capture - and a control here would
 * imply otherwise. What it does carry is the one thing an operator needs if the
 * cancellation or deletion, not the payment, was the mistake: that the refund has
 * already gone out, so putting the booking back means charging the member again.
 *
 * A separate component from the queue above because it is a different claim
 * about the world, and mixing "you owe this member money" rows with "this money
 * has already gone back" rows in one list is how somebody pays a refund twice.
 *
 * A COMPLETE RECORD SINCE #2760, and the copy says that instead of the
 * qualification it used to carry. Until #2760 a row existed only where the
 * member's browser reached the confirm endpoint before the Stripe webhook did -
 * one of four orderings - so the card was a partial list and said so. The webhook
 * now writes the row itself whenever its fenced close finds nothing, for a
 * deleted AND a merely cancelled booking, so every automatic refund of a late
 * capture inside the window is here.
 *
 * TWO GROUPS, AND THAT IS WHY (#2760, implementor's call under the owner's
 * decision). Widening to every cancelled booking adds rows for what is usually
 * normal operation: cancel a booking somebody is part-way through paying for and
 * this is the expected outcome. Listed together, those rows would bury the case
 * that actually needs a person - a payment refunded on a booking the club
 * DELETED, where remaking the booking means charging the member again. The
 * deleted group is printed first and each group says what it means, so the
 * interesting case cannot be lost in the ordinary one. Grouping rather than
 * re-sorting keeps each group newest-first, which is the order the route answers
 * in and the order an operator reads "what happened lately" in.
 *
 * A THIRD, NEUTRAL GROUP FOR A ROW WHOSE POPULATION IS UNKNOWN (review of #2760).
 * `bookingDeleted` is optional on the wire so a cached pre-#2760 client bundle
 * still renders, and the first cut of the grouping treated absent as "not
 * deleted" on the grounds that the cancelled group claims less. It claims less
 * about the WORK and more about the BOOKING - "cancelled and is still on file" is
 * a positive statement, and if that row's booking was in fact deleted the heading
 * is wrong about the only case here that needs a person. So an unknown row gets a
 * heading that asserts nothing beyond what the card already says, and asks for a
 * reload. Unreachable against the current route, which always sends the field;
 * this is for the minutes after a deploy.
 */
function AutomaticRefundNoticesCard({
  notices,
}: {
  notices: AutoRefundedNotice[];
}) {
  // `=== true` / `=== false`, NOT truthiness, and the third bucket is why. A row
  // with `bookingDeleted` absent is a stale client bundle talking to the current
  // route (which always sends the field), and it is genuinely UNKNOWN - so it
  // belongs in neither group, because each group's heading makes a positive claim
  // about the booking's state. Filing an unknown row under "cancelled and is
  // still on file" claims LESS about the work and MORE about the world, and if
  // that booking was in fact deleted it hides the one case that needs a person.
  const deletedNotices = notices.filter(
    (notice) => notice.bookingDeleted === true,
  );
  const cancelledNotices = notices.filter(
    (notice) => notice.bookingDeleted === false,
  );
  const unknownNotices = notices.filter(
    (notice) => notice.bookingDeleted === undefined,
  );

  return (
    <Card data-testid="automatic-refund-notices">
      <CardHeader>
        <CardTitle className="text-base">
          Refunded automatically &mdash; nothing to pay back ({notices.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {/*
            #2773 dropped "for a booking change" from this sentence. Both
            late-capture handlers write these rows now - a payment for a change to
            a booking, and the booking's own payment - so naming only one of them
            told an operator the card was narrower than it is. Each row's own
            reason sentence still says which payment it was.
          */}
          A payment arrived after the booking had already been cancelled. Stripe
          returned the money to the member straight away, so there is nothing for
          you to pay back and nothing to close here. This card is here so somebody
          sees it happened.
        </p>
        {/*
          #2760 replaced the "this card does not catch every one" paragraph that
          #2750 shipped. It was true then: the row only existed on one of the four
          orderings, so an empty card was not evidence. The webhook now writes the
          row itself on every ordering and for both populations, so the card IS
          the list - and the audit log is named as the permanent record because
          this card is bounded to the last 30 days, not because it misses events.

          ONE CLAUSE OF EXCEPTION, NOT A PARAGRAPH, and it is there because the
          claim would otherwise be false (review of #2760). If an operator closed
          the hand-back task themselves before Stripe's refund landed, the row
          carries THEIR name and note, so it is on neither card - the writer will
          not put two rows on one capture. A footnote an operator reads in passing
          keeps the claim honest; the old partial-list paragraph told them to
          distrust the whole card, which is how a card stops being read.
          `INV-ADDPAY-037` carries the reasoning; keeping the carve-out rather
          than writing a second row is #2774 D1, the orchestrator's call on that
          issue's Recommended option, which the owner has not ruled on
          (`INV-ADDPAY-039`'s authority line). This copy describes what the code
          does either way - it makes no claim about who chose it.

          AND #2773 LIFTED THE OTHER QUALIFICATION: this used to say "of a late
          booking-change payment", because the sibling handler for a booking's OWN
          payment wrote no row at all. It does now, through the same writer, so the
          word came out. Do NOT widen this sentence further and do NOT narrow it
          back: an operator who reads an empty card as proof that no automatic
          refund happened is worse off than before the card existed, and one told
          to distrust a complete list stops reading it.
        */}
        <p className="text-sm text-muted-foreground">
          This is every automatic refund of a late payment from the last 30 days
          &mdash; unless somebody had already closed the hand-back task for it by
          hand, in which case their own record of it is in the
          booking&apos;s history instead. Older ones are not shown here:
          the permanent record is the booking&apos;s audit log (the{" "}
          <span className="font-mono text-xs">
            booking.payment.refunded_after_cancellation
          </span>{" "}
          entry) together with the payment alert email the club is sent at the
          time.
        </p>
        {deletedNotices.length > 0 ? (
          <section
            className="space-y-2"
            data-testid="automatic-refund-notices-deleted"
          >
            <h3 className="text-sm font-medium text-foreground">
              The booking was deleted ({deletedNotices.length})
            </h3>
            <p className="text-sm text-muted-foreground">
              Worth a look. If deleting the booking was the mistake rather than
              the payment, the booking has to be made again and the member charged
              again &mdash; the refund has already gone out.
            </p>
            <ul className="space-y-3">
              {deletedNotices.map((notice) => (
                <AutomaticRefundNoticeRow key={notice.id} notice={notice} />
              ))}
            </ul>
          </section>
        ) : null}
        {cancelledNotices.length > 0 ? (
          <section
            className="space-y-2"
            data-testid="automatic-refund-notices-cancelled"
          >
            <h3 className="text-sm font-medium text-foreground">
              The booking was cancelled and is still on file (
              {cancelledNotices.length})
            </h3>
            <p className="text-sm text-muted-foreground">
              Normally nothing to do. This is the expected outcome when a booking
              is cancelled while the member is part-way through paying for it, or
              for a change to it. If the cancellation was the mistake, the same
              applies as above: the money has gone back, so the booking has to be
              remade and charged again.
            </p>
            <ul className="space-y-3">
              {cancelledNotices.map((notice) => (
                <AutomaticRefundNoticeRow key={notice.id} notice={notice} />
              ))}
            </ul>
          </section>
        ) : null}
        {unknownNotices.length > 0 ? (
          <section
            className="space-y-2"
            data-testid="automatic-refund-notices-unknown"
          >
            <h3 className="text-sm font-medium text-foreground">
              Refunded automatically ({unknownNotices.length})
            </h3>
            <p className="text-sm text-muted-foreground">
              Reload the page to sort these into the two groups above. The money
              has already gone back either way, so there is nothing to pay back
              &mdash; but if the club deleted one of these bookings, remaking it
              means charging the member again.
            </p>
            <ul className="space-y-3">
              {unknownNotices.map((notice) => (
                <AutomaticRefundNoticeRow key={notice.id} notice={notice} />
              ))}
            </ul>
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * B5 (#2262): the cash hand-back queue.
 *
 * A cancelled booking that was settled in cash (or by an off-Xero bank
 * transfer) has no card charge to reverse and no Xero invoice to credit, so the
 * cancellation raises a durable task here instead of pretending money moved.
 * "Paid back" writes the refund allocation and the REFUNDED booking event —
 * that is the moment the ledger says the money went back — and "dismiss"
 * (which requires a note) closes it without moving anything.
 *
 * TWO CARDS SINCE #2750, and only the first is a queue. The second is the
 * operator surface for a refund nobody authorised: when a payment is captured
 * against a booking the club has already cancelled — a payment for a change to it,
 * or (since #2773) the booking's own payment — the Stripe
 * webhook has refunded it in full since #1350, and #2700 made that leave a
 * `ManualRefundTask` behind — which the webhook then closes itself, because
 * there is genuinely nothing left to pay back by hand. Closing it took it off
 * this screen, since the queue lists OPEN rows, so the one durable record of the
 * money movement was visible only to somebody who thought to query the table.
 *
 * #2760 finished that: the webhook now WRITES the DISMISSED row itself when its
 * close finds nothing, so the three orderings that used to leave no row leave one
 * — and it does so for a booking that is cancelled but not deleted as well, which
 * the confirm route's raise never covered at all. The second card is a complete
 * list of the last thirty days rather than one ordering's worth, and it groups the
 * two populations so the deleted case is not buried by the ordinary one.
 *
 * The decision #2750 recorded is that the automatic refund STAYS: money going
 * back to the member is the safe direction when nobody is watching. What it adds
 * is that the record is seen. That is why the second card carries no buttons —
 * there is no action, and offering one would imply the refund is still open to
 * decide. What an operator does with it is off-screen work: if the cancellation
 * or the DELETION was the mistake rather than the payment, the booking has to be
 * put back and the member charged again, and the card says so in those words.
 */
export function ManualRefundTaskQueue() {
  const canEdit = useAdminAreaEditAccess("finance");
  const [tasks, setTasks] = useState<ManualRefundTask[] | null>(null);
  const [autoRefunded, setAutoRefunded] = useState<AutoRefundedNotice[]>([]);
  /**
   * The load failed, as distinct from having found nothing (#2750 review).
   *
   * Blanking the cards on a failure is right — a stale list of money owed is
   * worse than none — but blanking them SILENTLY makes a 500 look exactly like
   * "nothing to pay back and no automatic refunds", and this card exists so that
   * an absence of rows can be trusted. One line says which it was.
   */
  const [loadFailed, setLoadFailed] = useState(false);
  /**
   * The route answered, but its automatic-refund read specifically failed, so it
   * sent an empty list it does not stand behind. Separate from `loadFailed`
   * because the hand-back queue beside it IS trustworthy in that case, and
   * telling the operator their work queue is broken when it is not would send
   * them looking for a problem that is not there.
   */
  const [autoRefundedUnavailable, setAutoRefundedUnavailable] = useState(false);
  const [target, setTarget] = useState<
    null | { task: ManualRefundTask; resolution: "completed" | "dismissed" }
  >(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  /**
   * #2668 review SF-5: the sentence for an outcome that was never read, held on
   * screen rather than thrown as a toast.
   *
   * The dialog stays open on a failure and the button re-arms in `finally`, so
   * a transient toast is very likely to be gone before the operator's next
   * press — and this is money. The notice sits inside the dialog, above the
   * button it disarms, until they act on it. Refusals the server reported keep
   * their toast: those say what actually happened.
   */
  const [unverified, setUnverified] = useState<string | null>(null);
  /**
   * Bumped with each unread outcome so the recovery alert takes focus again on a
   * repeat. Focus is not decoration here: this branch disables the button that
   * was just pressed, and a control disabled in the same turn cannot hold focus,
   * so without the alert taking it the operator would be dropped to `<body>`.
   */
  const [unverifiedAttention, setUnverifiedAttention] = useState(0);
  /*
    #2264: the worked example for the note used to be its placeholder, which
    reads as a value already typed and disappears on the first keystroke. It is
    helper text under the box now. It still switches on the resolution — the
    example for "paid back" is not the example for "dismissed" — but it says
    NOTHING about the note being required or optional: the Label above already
    carries that, and repeating it there would announce it twice.
  */
  const noteHint = useFieldHint();

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/payments/manual-refund-tasks");
      if (!response.ok) {
        setTasks([]);
        setAutoRefunded([]);
        setAutoRefundedUnavailable(false);
        setLoadFailed(true);
        return;
      }
      const data = (await response.json()) as {
        tasks: ManualRefundTask[];
        autoRefunded?: AutoRefundedNotice[];
        autoRefundedUnavailable?: boolean;
      };
      setTasks(data.tasks ?? []);
      setAutoRefunded(data.autoRefunded ?? []);
      setAutoRefundedUnavailable(Boolean(data.autoRefundedUnavailable));
      setLoadFailed(false);
    } catch {
      setTasks([]);
      setAutoRefunded([]);
      setAutoRefundedUnavailable(false);
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit() {
    if (!target) return;
    setSubmitting(true);
    setUnverified(null);
    try {
      const response = await fetch(
        `/api/admin/payments/manual-refund-tasks/${target.task.id}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            resolution: target.resolution,
            confirmed: true,
            note: note.trim() || null,
          }),
        },
      );
      const data = (await response.json().catch(() => null)) as
        | { error?: string; message?: string }
        | null;
      if (!response.ok) {
        toast.error(data?.error ?? "Could not close this refund task.");
        return;
      }
      toast.success(data?.message ?? "Done.");
      setTarget(null);
      setNote("");
      await load();
    } catch {
      /*
        #2668. This used to say "Nothing was changed." A rejected `fetch` also
        covers the case where the POST landed, the refund allocation and the
        REFUNDED booking event were written, and only the answer was lost — so
        "nothing was changed" can be a statement about the ledger that is
        exactly backwards. The queue is deliberately NOT reloaded from here: a
        failed read blanks the card (see `load`), which would take the evidence
        off screen at the moment it is needed.

        Review SF-5: held in the dialog rather than thrown as a toast, with the
        close button disarmed behind it. A toast fades; the next press does not
        wait for it, and on this queue that press is either a second refund
        allocation attempt or a dismissal of a task that may already be closed.
        The server does refuse a second close on an already-closed task, so the
        ledger is safe either way — but "check the queue first" is the
        instruction, and the dialog now holds still long enough to be read.
      */
      setUnverified(
        unverifiedWriteMessage(
          "this refund task was closed",
          "Reload the page and check the queue before trying again.",
        ),
      );
      setUnverifiedAttention((value) => value + 1);
    } finally {
      setSubmitting(false);
    }
  }

  /*
    The hand-back queue keeps its original behaviour exactly: it shows while the
    load is still in flight (`tasks === null`) and disappears once the load says
    there is nothing to pay back. The automatic-refund card is independent — one
    can be present without the other, and when both are empty AND the load
    succeeded this component still renders nothing at all. A failed load is the
    one case where "nothing" is not the answer: it renders the line below instead,
    because silence there is indistinguishable from a clean slate.
  */
  const showQueue = tasks === null || tasks.length > 0;
  if (
    !showQueue &&
    autoRefunded.length === 0 &&
    !loadFailed &&
    !autoRefundedUnavailable
  ) {
    return null;
  }

  return (
    <div className="space-y-6">
      {/*
        A failed read says so (#2750 review). Rendered above the cards because it
        is a statement about what is missing from them, and as its own line rather
        than as an empty card so it cannot be mistaken for a list with no rows.
      */}
      {loadFailed ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="manual-refund-task-load-error"
        >
          Refund tasks could not be loaded, so this page cannot say whether any
          are waiting or whether a payment was refunded automatically. Reload the
          page.
        </p>
      ) : null}
      {showQueue ? (
        <Card data-testid="manual-refund-task-queue">
          <CardHeader>
            <CardTitle className="text-base">
              Refunds to pay back by hand
              {tasks ? ` (${tasks.length})` : ""}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              These bookings were paid in cash or by a bank transfer that never
              reached Xero, and have since been cancelled. There is no card payment
              to reverse, so the club has to pay the member back directly. Mark a
              refund as paid back once the money has actually gone — that is when
              the ledger records it.
            </p>
            {tasks === null ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <ul className="space-y-3">
                {tasks.map((task) => (
                  <li
                    key={task.id}
                    className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border px-3 py-2"
                  >
                    <div className="space-y-1 text-sm">
                      <p className="font-medium text-foreground">
                        {task.memberName} — {formatTaskAmount(task.amountCents)}
                      </p>
                      <p className="text-muted-foreground">
                        {formatStayDate(task.checkIn)} to{" "}
                        {formatStayDate(task.checkOut)} ·{" "}
                        <Link
                          className="underline"
                          href={`/bookings/${task.bookingId}`}
                        >
                          View booking
                        </Link>
                      </p>
                      <p className="text-xs text-muted-foreground">{task.reason}</p>
                    </div>
                    <div className="flex gap-2">
                      <ViewOnlyActionButton
                        canEdit={canEdit}
                        type="button"
                        variant="outline"
                        onClick={() => {
                          setNote("");
                          setUnverified(null);
                          setTarget({ task, resolution: "completed" });
                        }}
                      >
                        Mark paid back
                      </ViewOnlyActionButton>
                      <ViewOnlyActionButton
                        canEdit={canEdit}
                        type="button"
                        variant="ghost"
                        onClick={() => {
                          setNote("");
                          setUnverified(null);
                          setTarget({ task, resolution: "dismissed" });
                        }}
                      >
                        Dismiss
                      </ViewOnlyActionButton>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>

          <Dialog
            open={target !== null}
            onOpenChange={(open) => {
              // The notice belongs to the attempt that produced it; a stale one
              // over the next task would read as that task's outcome.
              if (!open) {
                setTarget(null);
                setUnverified(null);
              }
            }}
          >
            <DialogContent>
              {target && (
                <>
                  <DialogHeader>
                    <DialogTitle>
                      {target.resolution === "completed"
                        ? `Record ${formatTaskAmount(target.task.amountCents)} as paid back to ${target.task.memberName}?`
                        : `Dismiss the refund for ${target.task.memberName}?`}
                    </DialogTitle>
                    <DialogDescription>
                      {target.resolution === "completed"
                        ? "Only do this once the money has actually gone back to the member. It writes the refund into the payment ledger and records a refund on the booking's history."
                        : "Dismissing closes the task without refunding anything — for a member who declined the refund, or money settled another way. Say which, so the record makes sense later."}
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-2">
                    <Label htmlFor="manual-refund-task-note">
                      Note{target.resolution === "dismissed" ? " (required)" : " (optional)"}
                    </Label>
                    <Textarea
                      id="manual-refund-task-note"
                      value={note}
                      maxLength={NOTE_MAX_LENGTH}
                      onChange={(event) => setNote(event.target.value)}
                      {...noteHint.fieldProps}
                    />
                    <FieldHint {...noteHint.hintProps}>
                      {target.resolution === "completed"
                        ? "e.g. cash handed back at the lodge"
                        : "e.g. member asked us to keep it as a donation"}
                    </FieldHint>
                  </div>
                  {/*
                    #2668 SF-5. The house recovery alert (`focused-action-error.tsx`,
                    #2597 / #2635): permanently mounted so the live region exists
                    before it has anything to say — one injected already-populated is
                    silently dropped by some screen-reader/browser pairings —
                    assertive, and it takes focus when the message arrives, which is
                    what keeps the operator from being dropped to `<body>` as the
                    button they just pressed is disabled behind it.
                  */}
                  <FocusedActionError
                    id="manual-refund-unverified-notice"
                    error={unverified ?? ""}
                    attentionKey={unverifiedAttention}
                  />
                  <DialogFooter className="gap-2 sm:gap-2">
                    {/*
                      After an unread outcome "Cancel" would itself be a claim —
                      there may be nothing left to cancel — so the way out is named
                      for what it does.
                    */}
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setTarget(null);
                        setUnverified(null);
                      }}
                      disabled={submitting}
                    >
                      {unverified ? "Close and check" : "Cancel"}
                    </Button>
                    <Button
                      onClick={submit}
                      disabled={
                        submitting ||
                        unverified !== null ||
                        (target.resolution === "dismissed" && note.trim().length === 0)
                      }
                    >
                      {target.resolution === "completed"
                        ? "Record as paid back"
                        : "Dismiss refund"}
                    </Button>
                  </DialogFooter>
                </>
              )}
            </DialogContent>
          </Dialog>
        </Card>
      ) : null}
      {/*
        The route answered but could not read this list. Said in one line instead
        of an empty card, for the same reason as above: an empty card asserts that
        no money was refunded automatically, and a query that failed has not
        earned the right to assert that.
      */}
      {autoRefundedUnavailable ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="automatic-refund-notices-unavailable"
        >
          The record of automatic refunds could not be loaded, so this page
          cannot say whether any payment was refunded automatically. The
          hand-back queue above is unaffected. Reload the page.
        </p>
      ) : null}
      {autoRefunded.length > 0 ? (
        <AutomaticRefundNoticesCard notices={autoRefunded} />
      ) : null}
    </div>
  );
}
