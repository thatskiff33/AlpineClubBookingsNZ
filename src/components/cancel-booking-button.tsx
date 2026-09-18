"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
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
import { BookingNoEmailsNotice } from "@/components/booking-no-emails-notice";
import { HostingCoverageOverridePrompt } from "@/components/hosting-coverage-override-prompt";
import {
  hostingCoverageMutationSignature,
  readHostingCoverageOverridePrompt,
  type HostingCoverageOverridePromptData,
} from "@/lib/hosting-coverage-override-client";
import { formatCents } from "@/lib/utils";

interface CancelPreview {
  refundAmountCents: number;
  keptAmountCents: number;
  changeFeeCents: number;
  refundPercentage: number;
  creditRefundAmountCents: number;
  creditRefundPercentage: number;
  creditRestoredCents: number;
  totalPaidCents: number;
  hasPayment: boolean;
  /**
   * B5 (#2262): this booking was settled in cash / by an off-Xero bank transfer,
   * so there is no card payment to reverse and no account credit is minted —
   * the club hands the refund back directly. The figures are unchanged.
   */
  manualRefund?: boolean;
}

export function CancelBookingButton({
  bookingId,
  refundAppealDescription,
  onBehalfOfMember = false,
  canChooseMemberEmail = false,
  canOverrideHostingCoverage = false,
  noEmails = false,
}: {
  bookingId: string;
  refundAppealDescription?: string;
  // Issue #1303: when a Full Admin cancels a booking they don't own, this is an
  // explicit admin-on-behalf action (the only admin path to cancel a member's
  // booking). Re-frame the button label and confirm/success copy accordingly —
  // the cancel endpoint and settlement logic are unchanged.
  onBehalfOfMember?: boolean;
  // Issue #1705 (#1698 pattern): when true, Confirm Cancellation first asks
  // whether the member receives the cancellation email ("Cancel and email
  // member" / "Cancel without emailing"). Pass viewerRole === "ADMIN" for the
  // booking-management role (bookingManagementAuthorizationRole) — the same
  // role the cancel route resolves before honouring notifyMember — so the
  // dialog shows exactly when the server will honour the choice. A member
  // self-cancel keeps the immediate always-notify confirm.
  canChooseMemberEmail?: boolean;
  /** Exact booking-management authority for #2576's officer-only override. */
  canOverrideHostingCoverage?: boolean;
  /**
   * #2259 honesty rule: the booking's "No emails" switch. With it on, the
   * cancellation email is withheld by the mailer whatever the admin picks, so
   * the dialog stops offering the choice and states the position instead.
   *
   * Only ever read alongside {@link canChooseMemberEmail}, which is admin-only.
   * A member self-cancelling their own silenced booking sees the ordinary
   * always-notify confirm and learns nothing about the switch.
   */
  noEmails?: boolean;
}) {
  const [step, setStep] = useState<"idle" | "loading" | "preview" | "cancelling" | "success" | "error">("idle");
  const [preview, setPreview] = useState<CancelPreview | null>(null);
  const [result, setResult] = useState<{ refundAmountCents: number; refundMethod: string; creditAmountCents?: number; creditRestoredCents?: number } | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [refundMethod, setRefundMethod] = useState<"card" | "credit">("card");
  // Issue #1705: the admin's explicit email choice dialog, and the choice that
  // was made (null = no choice offered, i.e. always-notify member self-cancel).
  const [notifyDialogOpen, setNotifyDialogOpen] = useState(false);
  const [notifiedMember, setNotifiedMember] = useState<boolean | null>(null);
  const cancelInFlightRef = useRef(false);
  const [hostingOverrideState, setHostingOverrideState] = useState<{
    prompt: HostingCoverageOverridePromptData;
    proposalSignature: string;
    notifyMemberChoice: boolean | undefined;
  } | null>(null);
  const [hostingOverrideConfirmed, setHostingOverrideConfirmed] = useState(false);
  const [hostingOverrideReason, setHostingOverrideReason] = useState("");
  const router = useRouter();
  // #2259: the notify choice only exists on the admin path, so the suppression
  // is scoped to it too — a member self-cancel never evaluates the switch.
  const noEmailsSuppressesChoice = canChooseMemberEmail && noEmails;

  function buildCancelBody(notifyMemberChoice?: boolean) {
    const body: {
      refundMethod: "card" | "credit";
      notifyMember?: boolean;
    } = { refundMethod };
    if (notifyMemberChoice !== undefined) body.notifyMember = notifyMemberChoice;
    return body;
  }

  const hostingOverrideProposalStillCurrent = Boolean(
    hostingOverrideState &&
      hostingOverrideState.proposalSignature ===
        hostingCoverageMutationSignature(
          buildCancelBody(hostingOverrideState.notifyMemberChoice),
        ),
  );
  const activeHostingOverrideState = hostingOverrideProposalStillCurrent
    ? hostingOverrideState
    : null;
  useEffect(() => {
    if (hostingOverrideState && !hostingOverrideProposalStillCurrent) {
      setHostingOverrideState(null);
      setHostingOverrideConfirmed(false);
      setHostingOverrideReason("");
      setErrorMsg("");
    }
  }, [hostingOverrideProposalStillCurrent, hostingOverrideState]);

  function clearHostingOverridePrompt() {
    setHostingOverrideState(null);
    setHostingOverrideConfirmed(false);
    setHostingOverrideReason("");
    setErrorMsg("");
  }

  function resetCancellationIntent() {
    clearHostingOverridePrompt();
    setNotifyDialogOpen(false);
    setNotifiedMember(null);
    setPreview(null);
    setResult(null);
  }

  function keepBooking() {
    resetCancellationIntent();
    setStep("idle");
  }

  function renderWithHostingOverrideRegion(content: ReactNode) {
    const busy = step === "loading" || step === "cancelling";
    return (
      <div className="space-y-3">
        <HostingCoverageOverridePrompt
          prompt={
            canOverrideHostingCoverage && activeHostingOverrideState
              ? activeHostingOverrideState.prompt
              : null
          }
          confirmed={hostingOverrideConfirmed}
          reason={hostingOverrideReason}
          disabled={busy}
          busy={busy}
          idPrefix={`cancel-booking-${bookingId}-hosting-override`}
          onConfirmedChange={setHostingOverrideConfirmed}
          onReasonChange={setHostingOverrideReason}
        />
        {content}
      </div>
    );
  }

  async function handleShowPreview() {
    // A preview is a new cancellation proposal. Never let an earlier private
    // reason, acknowledgement or email choice ride into it invisibly.
    resetCancellationIntent();
    setStep("loading");
    try {
      const res = await fetch(`/api/bookings/${bookingId}/cancel-preview`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorMsg(data.error || "Failed to load cancellation details");
        setStep("error");
        return;
      }
      const data: CancelPreview = await res.json();
      setPreview(data);
      setRefundMethod("card");
      setStep("preview");
    } catch {
      setErrorMsg("Failed to load cancellation details");
      setStep("error");
    }
  }

  // Issue #1705 (#1698 pattern): an admin/booking-officer confirm goes through
  // the notify dialog first; the dialog's two actions call performCancel with
  // the explicit email choice. A member self-cancel calls performCancel with no
  // argument and always notifies (the server 403s the flag from non-admins).
  function handleConfirmCancel() {
    if (activeHostingOverrideState) {
      if (!hostingOverrideConfirmed || hostingOverrideReason.trim().length < 10) {
        setErrorMsg(
          "Confirm the affected bookings and give a private override reason of at least 10 characters.",
        );
        return;
      }
      void performCancel(
        activeHostingOverrideState.notifyMemberChoice,
        activeHostingOverrideState,
      );
      return;
    }
    if (canChooseMemberEmail) {
      setNotifyDialogOpen(true);
      return;
    }
    void performCancel();
  }

  async function performCancel(
    notifyMemberChoice?: boolean,
    overrideState: typeof hostingOverrideState = null,
  ) {
    if (cancelInFlightRef.current) return;
    cancelInFlightRef.current = true;
    setStep("cancelling");
    setNotifiedMember(notifyMemberChoice ?? null);
    try {
      const body = buildCancelBody(notifyMemberChoice) as ReturnType<
        typeof buildCancelBody
      > & {
        hostingCoverageOverride?: {
          acknowledged: true;
          reason: string;
          strandedStateKey: string;
        };
      };
      const refusedProposalSignature = hostingCoverageMutationSignature(body);
      if (overrideState) {
        body.hostingCoverageOverride = {
          acknowledged: true,
          reason: hostingOverrideReason.trim(),
          strandedStateKey: overrideState.prompt.strandedStateKey,
        };
      }
      const res = await fetch(`/api/bookings/${bookingId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        clearHostingOverridePrompt();
        setResult({
          refundAmountCents: data.refundAmountCents || 0,
          refundMethod: data.refundMethod || "card",
          creditAmountCents: data.creditAmountCents,
          creditRestoredCents: data.creditRestoredCents,
        });
        setStep("success");
        router.refresh();
      } else {
        const data = await res.json().catch(() => ({}));
        const hostingPrompt = canOverrideHostingCoverage
          ? readHostingCoverageOverridePrompt(data)
          : null;
        if (hostingPrompt) {
          setHostingOverrideState({
            prompt: hostingPrompt,
            proposalSignature: refusedProposalSignature,
            notifyMemberChoice,
          });
          setHostingOverrideConfirmed(false);
          setHostingOverrideReason("");
          setErrorMsg(
            "Review the affected bookings and nights, then explicitly confirm the private hosting override.",
          );
          setStep("preview");
          return;
        }
        clearHostingOverridePrompt();
        setErrorMsg(data.error || "Failed to cancel booking");
        setStep("error");
      }
    } catch {
      clearHostingOverridePrompt();
      setErrorMsg("Failed to cancel booking");
      setStep("error");
    } finally {
      cancelInFlightRef.current = false;
    }
  }

  if (step === "idle") {
    return renderWithHostingOverrideRegion(
      <Button variant="destructive" onClick={handleShowPreview}>
        {onBehalfOfMember ? "Cancel on behalf of member" : "Cancel Booking"}
      </Button>,
    );
  }

  if (step === "loading") {
    return renderWithHostingOverrideRegion(
      <div className="rounded-md border border-border bg-card p-4">
        <p className="text-sm text-muted-foreground">Loading cancellation details...</p>
      </div>,
    );
  }

  if (step === "success") {
    const refund = result?.refundAmountCents || 0;
    const isCredit = result?.refundMethod === "credit";
    // Issue #1705: when the admin chose "Cancel without emailing", the standard
    // email-promise copy would be untrue — state the recorded choice instead.
    //
    // #2259: the switch has to count here too. Since H1 the suppressed path
    // sends NO choice (so the mailer records the withhold), which leaves
    // `notifiedMember` null — and null used to mean "emails normally". Without
    // this disjunct the panel would promise a confirmation email for the one
    // booking guaranteed not to get one.
    const emailSuppressed = notifiedMember === false || noEmailsSuppressesChoice;
    return renderWithHostingOverrideRegion(
      <div className="rounded-md border border-success-6 bg-success-3 p-4 space-y-1">
        <p className="text-sm font-medium text-success-11">
          {onBehalfOfMember
            ? "Booking cancelled on behalf of the member"
            : "Booking cancelled successfully"}
        </p>
        {result?.creditRestoredCents && result.creditRestoredCents > 0 && (
          <p className="text-sm text-success-11">
            {formatCents(result.creditRestoredCents)} of previously applied credit has been returned to {onBehalfOfMember ? "the member's" : "your"} account.
          </p>
        )}
        {/* B5 (#2262): a manual (cash / off-Xero) settlement has no card to
            refund to and mints no account credit — the club hands the money
            back directly. The plan-forbidden sentence ("processed to your
            original payment method") must never render for this outcome. */}
        {refund > 0 && result?.refundMethod === "manual" ? (
          <p className="text-sm text-success-11">
            {onBehalfOfMember
              ? `The club will arrange the member's refund of ${formatCents(refund)} directly — they'll hear from the club about how it will be paid back.`
              : `The club will arrange your refund of ${formatCents(refund)} directly — you'll hear from them about how it will be paid back.`}
          </p>
        ) : refund > 0 && isCredit ? (
          <p className="text-sm text-success-11">
            A credit of {formatCents(refund)} has been added to {onBehalfOfMember ? "the member's" : "your"} account for future bookings.
          </p>
        ) : refund > 0 ? (
          <p className="text-sm text-success-11">
            {onBehalfOfMember
              ? `The refund of ${formatCents(refund)} has been processed to the member's original payment method.${emailSuppressed ? "" : " They will receive a confirmation email shortly."}`
              : `Your refund of ${formatCents(refund)} has been processed to your original payment method.${emailSuppressed ? "" : " You will receive a confirmation email shortly."}`}
          </p>
        ) : emailSuppressed ? null : (
          <p className="text-sm text-success-11">
            {onBehalfOfMember
              ? "The member will receive a confirmation email shortly."
              : "You will receive a confirmation email shortly."}
          </p>
        )}
        {/*
          #2259: with the switch on there was no choice to record — the send was
          attempted and withheld — so pointing at "your choice in the audit log"
          would send the officer looking for an entry that does not exist. This
          is the most consequential message in the flow: the member has just
          lost a booking and will hear nothing, so point at the list that names
          the withheld notice instead.
        */}
        {emailSuppressed && (
          <p className="text-sm text-success-11">
            {noEmailsSuppressesChoice
              ? "The member was not emailed: emails are off for this booking. The withheld cancellation notice is listed on the booking — tell the member yourself."
              : "The member was not emailed about this cancellation — your choice is recorded in the audit log."}
          </p>
        )}
      </div>,
    );
  }

  if (step === "error") {
    return renderWithHostingOverrideRegion(
      <div className="rounded-md border border-danger-6 bg-danger-3 p-4 space-y-2">
        <p className="text-sm text-danger-11">{errorMsg}</p>
        <Button variant="outline" size="sm" onClick={keepBooking}>
          Try Again
        </Button>
      </div>,
    );
  }

  // Preview step
  if (step === "preview" && preview) {
    // A credit-only booking can have card slices at 0 but still restore a
    // positive (tiered) applied-credit amount (#1164): treat that as a
    // refund-bearing cancel so the restored-credit row is not hidden behind
    // "No refund applies".
    const hasCardRefund =
      preview.refundAmountCents > 0 || preview.creditRefundAmountCents > 0;
    const hasRefund = hasCardRefund || preview.creditRestoredCents > 0;

    return renderWithHostingOverrideRegion(
      <div className="rounded-md border border-danger-6 bg-danger-3 p-4 space-y-3">
        <p className="text-sm font-medium text-danger-11">
          {onBehalfOfMember
            ? "Cancel on behalf of member"
            : "Cancellation Summary"}
        </p>

        {onBehalfOfMember && (
          <p className="text-sm text-danger-11">
            You are cancelling this booking on behalf of the member. Any refund
            or account credit is applied to the member&apos;s account
            {/*
              #2259: three cases, not two. With the switch on there is no
              choice to be offered at confirm time, so promising one here would
              be contradicted by the dialog a click later.
            */}
            {noEmailsSuppressesChoice
              ? ". Emails are off for this booking, so the member will not be told — that is yours to do."
              : canChooseMemberEmail
                ? " — you will choose whether the member is emailed when you confirm."
                : " and they are notified by email."}
          </p>
        )}

        {!preview.hasPayment ? (
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">
              No payment has been taken for this booking. No refund applies.
            </p>
            {preview.creditRestoredCents > 0 && (
              <p className="text-sm text-success-11">
                {formatCents(preview.creditRestoredCents)} of previously applied
                account credit will be returned to{" "}
                {onBehalfOfMember ? "the member's" : "your"} account.
              </p>
            )}
          </div>
        ) : !hasRefund ? (
          <p className="text-sm text-muted-foreground">
            No refund applies per cancellation policy.
          </p>
        ) : (
          <div className="space-y-3 text-sm">
            {/* Refund method selection — only meaningful when a card/bank slice
                can be refunded. A credit-only cancel (#1164) has no card slice,
                so the radios are hidden and only the restored-credit row shows. */}
            {preview.manualRefund && hasCardRefund && (
              <p className="text-sm text-muted-foreground">
                This booking was paid in cash or by bank transfer, so there is no
                card payment to reverse and no account credit is added. The club
                will arrange{" "}
                <span className="font-medium text-success-11">
                  {formatCents(preview.creditRefundAmountCents)}
                </span>{" "}
                back to {onBehalfOfMember ? "the member" : "you"} directly.
              </p>
            )}
            {!preview.manualRefund && hasCardRefund && (
              <div className="space-y-2">
                <p className="font-medium text-muted-foreground">Choose refund method:</p>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="refundMethod"
                    value="card"
                    checked={refundMethod === "card"}
                    onChange={() => setRefundMethod("card")}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium text-foreground">
                      Refund {formatCents(preview.refundAmountCents)} to original payment method
                    </span>
                    <span className="text-muted-foreground ml-1">({preview.refundPercentage}% refund)</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="refundMethod"
                    value="credit"
                    checked={refundMethod === "credit"}
                    onChange={() => setRefundMethod("credit")}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium text-success-11">
                      Hold {formatCents(preview.creditRefundAmountCents)} as account credit
                    </span>
                    <span className="text-muted-foreground ml-1">({preview.creditRefundPercentage}% refund)</span>
                    {preview.creditRefundAmountCents > preview.refundAmountCents && (
                      <span className="ml-1 text-xs text-success-11 font-medium">
                        +{formatCents(preview.creditRefundAmountCents - preview.refundAmountCents)} more
                      </span>
                    )}
                  </span>
                </label>
              </div>
            )}

            {/* Amount summary.
                B5 (#2262): a manual settlement's outcome uses the bank-
                transfer/credit TIER (that is what the executed cancel raises
                the hand-back task at), so the summary must show that figure —
                never the card-tier "Refund to card" row, which would disagree
                with the paragraph above and with what the club will actually
                hand back. */}
            <div className="border-t border-danger-6 pt-2 space-y-1">
              {hasCardRefund && preview.manualRefund && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    Refund arranged by the club:
                  </span>
                  <span className="font-medium text-success-11">
                    {formatCents(preview.creditRefundAmountCents)}
                  </span>
                </div>
              )}
              {preview.manualRefund &&
                preview.totalPaidCents - preview.creditRefundAmountCents > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      Amount kept ({preview.creditRefundPercentage}% refund):
                    </span>
                    <span className="font-medium text-muted-foreground">
                      {formatCents(
                        preview.totalPaidCents - preview.creditRefundAmountCents
                      )}
                    </span>
                  </div>
                )}
              {hasCardRefund && !preview.manualRefund && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    {refundMethod === "credit" ? "Credit to account:" : "Refund to card:"}
                  </span>
                  <span className="font-medium text-success-11">
                    {formatCents(
                      refundMethod === "credit"
                        ? preview.creditRefundAmountCents
                        : preview.refundAmountCents
                    )}
                  </span>
                </div>
              )}
              {preview.keptAmountCents > 0 &&
                refundMethod === "card" &&
                !preview.manualRefund && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      Amount kept ({preview.refundPercentage}% refund):
                    </span>
                    <span className="font-medium text-muted-foreground">{formatCents(preview.keptAmountCents)}</span>
                  </div>
                )}
              {refundAppealDescription ? (
                <p className="pt-2 text-xs text-muted-foreground">
                  {refundAppealDescription}
                </p>
              ) : null}
              {preview.changeFeeCents > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Change fees (non-refundable):</span>
                  <span className="font-medium text-muted-foreground">{formatCents(preview.changeFeeCents)}</span>
                </div>
              )}
              {preview.creditRestoredCents > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    Previously applied credit restored (per the cancellation policy):
                  </span>
                  <span className="font-medium text-success-11">{formatCents(preview.creditRestoredCents)}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {activeHostingOverrideState && errorMsg ? (
          <p className="text-sm text-danger-11" role="status">
            {errorMsg}
          </p>
        ) : null}

        <div className="flex items-center gap-3 pt-1">
          <Button
            variant="destructive"
            size="sm"
            onClick={handleConfirmCancel}
            disabled={
              Boolean(activeHostingOverrideState) &&
              (!hostingOverrideConfirmed ||
                hostingOverrideReason.trim().length < 10)
            }
          >
            {activeHostingOverrideState
              ? "Confirm hosting override and cancel"
              : "Confirm Cancellation"}
          </Button>
          <Button variant="outline" size="sm" onClick={keepBooking}>
            Keep Booking
          </Button>
        </div>

        {/* Owner decision (#1705, extending #1668/#1696): the admin explicitly
            chooses, per cancellation, whether the member is emailed. Both
            choices cancel the booking; the choice itself is recorded in the
            audit log.

            #2259: with the booking's "No emails" switch on there is no choice
            to make — the mailer withholds the cancellation email either way —
            so the dialog states that and offers only the send-nothing action.
            This is the case the acknowledgement dialog warns about by name. */}
        <Dialog open={notifyDialogOpen} onOpenChange={setNotifyDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {noEmailsSuppressesChoice
                  ? "Cancel this booking?"
                  : "Email the member about this cancellation?"}
              </DialogTitle>
              <DialogDescription>
                {noEmailsSuppressesChoice
                  ? "The booking will be cancelled and any refund or account credit applied as usual."
                  : "The booking will be cancelled either way, and any refund or account credit is applied regardless. Choose whether the member receives the standard cancellation email — your choice is recorded in the audit log."}
              </DialogDescription>
            </DialogHeader>
            {noEmailsSuppressesChoice && <BookingNoEmailsNotice />}
            <DialogFooter className="gap-2 sm:gap-2">
              <Button
                variant={noEmailsSuppressesChoice ? "destructive" : "outline"}
                onClick={() => {
                  setNotifyDialogOpen(false);
                  // #2259 H1: with the switch on, send NO choice rather than
                  // notifyMember:false. `false` makes the route skip the send,
                  // so the mailer's gate never runs and no withheld row is
                  // recorded — the banner would then be silent about the very
                  // cancellation the member most needs to be told about.
                  void performCancel(
                    noEmailsSuppressesChoice ? undefined : false,
                  );
                }}
              >
                {noEmailsSuppressesChoice
                  ? "Cancel booking"
                  : "Cancel without emailing"}
              </Button>
              {!noEmailsSuppressesChoice && (
                <Button
                  variant="destructive"
                  onClick={() => {
                    setNotifyDialogOpen(false);
                    void performCancel(true);
                  }}
                >
                  Cancel and email member
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>,
    );
  }

  // Cancelling state
  return renderWithHostingOverrideRegion(
    <div className="rounded-md border border-border bg-card p-4">
      <p className="text-sm text-muted-foreground">Cancelling booking...</p>
    </div>,
  );
}
