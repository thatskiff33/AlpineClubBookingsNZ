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
import { CancelBookingSuccessPanel, type CancelResult } from "@/components/cancel-booking-success-panel";
import { FocusedActionError } from "@/components/focused-action-error";
import { focusAndKeepInView } from "@/hooks/use-scroll-to-feedback";
import { HostingCoverageOverridePrompt } from "@/components/hosting-coverage-override-prompt";
import {
  hostingCoverageMutationSignature,
  readHostingCoverageOverridePrompt,
  type HostingCoverageOverridePromptData,
} from "@/lib/hosting-coverage-override-client";
import { formatCents } from "@/lib/utils";
import { useClubFormat } from "@/components/club-format-provider";
import { CardRefundShortfallRows, CardRefundShortfallSentence, cardShortfallOptionLabel, ForcedRefundNote, NoRefundablePaymentNote } from "@/components/cancel-booking-payment-notes";
import type { CancelCardRefundSplit } from "@/lib/cancel-card-refund-shortfall";

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
  /**
   * The refund method the cancel will use whatever is chosen — "credit" for an
   * internet banking payment, decided in `cancel-refund-method.ts` and returned
   * by the preview. When set, the dialog shows only that option.
   */
  refundMethodForced?: Parameters<typeof ForcedRefundNote>[0]["forced"] | null; // #3949: or organiser_by_hand
  /**
   * #3643 DECISION 2: Xero shows a payment the app cannot hand back as credit,
   * so an officer's cancel treats the booking as unpaid and the treasurer
   * settles that payment by hand.
   */
  paymentSettledByHand?: boolean;
  /** #3653: the organiser's cancellation of the group already refunds this booking; the cancel's own sentence. */
  groupCancellationRefundNote?: string;
  cardShortfall?: CancelCardRefundSplit; // #4119: the card refund plan carries less than refundAmountCents
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
  const format = useClubFormat();
  const [step, setStep] = useState<"idle" | "loading" | "preview" | "cancelling" | "success" | "error">("idle");
  const [preview, setPreview] = useState<CancelPreview | null>(null);
  const [result, setResult] = useState<CancelResult | null>(null);
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

  // #4949: every step renders inside one frame, so the status region below is
  // mounted before it is filled and focus has somewhere to go when a step's
  // own controls unmount. Each step's focus target, moved after the step
  // commits (a passive effect, so a closing notify dialog has already let go):
  // the status region while loading or cancelling, the heading of the preview
  // or success panel, the trigger again on the way back to idle. The error step
  // is focused by its `FocusedActionError` itself.
  const idPrefix = `cancel-booking-${bookingId}`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const previewHeadingRef = useRef<HTMLParagraphElement>(null);
  const successHeadingRef = useRef<HTMLParagraphElement>(null);
  const focusedStepRef = useRef(step);
  useEffect(() => {
    if (focusedStepRef.current === step) return;
    focusedStepRef.current = step;
    const target = {
      idle: triggerRef,
      loading: statusRef,
      cancelling: statusRef,
      preview: previewHeadingRef,
      success: successHeadingRef,
      error: null,
    }[step];
    if (target) focusAndKeepInView(target.current);
  }, [step]);

  function renderWithHostingOverrideRegion(content: ReactNode) {
    const busy = step === "loading" || step === "cancelling";
    const statusText =
      step === "loading"
        ? "Loading cancellation details..."
        : step === "cancelling"
          ? "Cancelling booking..."
          : "";
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
          idPrefix={`${idPrefix}-hosting-override`}
          onConfirmedChange={setHostingOverrideConfirmed}
          onReasonChange={setHostingOverrideReason}
        />
        <div
          ref={statusRef}
          id={`${idPrefix}-status`}
          role="status"
          tabIndex={-1}
          className={
            statusText
              ? "rounded-md border border-border bg-card p-4 outline-none"
              : "sr-only"
          }
        >
          {statusText ? (
            <p className="text-sm text-muted-foreground">{statusText}</p>
          ) : null}
        </div>
        <FocusedActionError
          id={`${idPrefix}-error`}
          error={step === "error" ? errorMsg : ""}
          action={
            <Button variant="outline" size="sm" onClick={keepBooking}>
              Try Again
            </Button>
          }
          className="p-4"
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
      setRefundMethod(data.refundMethodForced === "credit" ? "credit" : "card");
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
          organiserRefund: data.organiserRefund,
          ownCardRefund: data.ownCardRefund,
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
      <Button ref={triggerRef} variant="destructive" onClick={handleShowPreview}>
        {onBehalfOfMember ? "Cancel on behalf of member" : "Cancel Booking"}
      </Button>,
    );
  }

  if (step === "success") {
    return renderWithHostingOverrideRegion(
      <CancelBookingSuccessPanel
        idPrefix={idPrefix}
        headingRef={successHeadingRef}
        result={result}
        onBehalfOfMember={onBehalfOfMember}
        notifiedMember={notifiedMember}
        noEmailsSuppressesChoice={noEmailsSuppressesChoice}
        format={format}
      />,
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
    const cardShortfall = hasCardRefund && !preview.manualRefund && refundMethod === "card" ? preview.cardShortfall : undefined; // #4119

    return renderWithHostingOverrideRegion(
      <div className="rounded-md border border-danger-6 bg-danger-3 p-4 space-y-3">
        <p
          ref={previewHeadingRef}
          tabIndex={-1}
          className="text-sm font-medium text-danger-11 outline-none"
        >
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
            <NoRefundablePaymentNote settledByHand={preview.paymentSettledByHand} />
            {preview.creditRestoredCents > 0 && (
              <p className="text-sm text-success-11">
                {formatCents(preview.creditRestoredCents, format)} of previously applied
                account credit will be returned to{" "}
                {onBehalfOfMember ? "the member's" : "your"} account.
              </p>
            )}
          </div>
        ) : !hasRefund ? (
          <p className="text-sm text-muted-foreground">
            {preview.groupCancellationRefundNote ?? "No refund applies per cancellation policy."}
          </p>
        ) : (
          <div className="space-y-3 text-sm">
            {preview.groupCancellationRefundNote && (
              <p className="text-sm text-muted-foreground">{preview.groupCancellationRefundNote}</p>
            )}
            {/* Refund method selection — only meaningful when a card/bank slice
                can be refunded. A credit-only cancel (#1164) has no card slice,
                so the radios are hidden and only the restored-credit row shows. */}
            {preview.manualRefund && hasCardRefund && (
              <p className="text-sm text-muted-foreground">
                This booking was paid in cash or by bank transfer, so there is no
                card payment to reverse and no account credit is added. The club
                will arrange{" "}
                <span className="font-medium text-success-11">
                  {formatCents(preview.creditRefundAmountCents, format)}
                </span>{" "}
                back to {onBehalfOfMember ? "the member" : "you"} directly.
              </p>
            )}
            {!preview.manualRefund && hasCardRefund && preview.refundMethodForced && (
              <ForcedRefundNote preview={preview} forced={preview.refundMethodForced} format={format} />
            )}
            {!preview.manualRefund && hasCardRefund && !preview.refundMethodForced && (
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
                      {preview.cardShortfall ? cardShortfallOptionLabel(preview.cardShortfall, format) : `Refund ${formatCents(preview.refundAmountCents, format)} to original payment method`}
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
                      Hold {formatCents(preview.creditRefundAmountCents, format)} as account credit
                    </span>
                    <span className="text-muted-foreground ml-1">({preview.creditRefundPercentage}% refund)</span>
                    {preview.creditRefundAmountCents > preview.refundAmountCents && (
                      <span className="ml-1 text-xs text-success-11 font-medium">
                        +{formatCents(preview.creditRefundAmountCents - preview.refundAmountCents, format)} more
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
                    {formatCents(preview.creditRefundAmountCents, format)}
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
                        preview.totalPaidCents - preview.creditRefundAmountCents,
                        format
                      )}
                    </span>
                  </div>
                )}
              {cardShortfall ? <CardRefundShortfallRows split={cardShortfall} format={format} /> : hasCardRefund && !preview.manualRefund && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    {refundMethod === "credit" ? "Credit to account:" : "Refund to card:"}
                  </span>
                  <span className="font-medium text-success-11">
                    {formatCents(
                      refundMethod === "credit"
                        ? preview.creditRefundAmountCents
                        : preview.refundAmountCents,
                        format
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
                    <span className="font-medium text-muted-foreground">{formatCents(preview.keptAmountCents, format)}</span>
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
                  <span className="font-medium text-muted-foreground">{formatCents(preview.changeFeeCents, format)}</span>
                </div>
              )}
              {preview.creditRestoredCents > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    Previously applied credit restored (per the cancellation policy):
                  </span>
                  <span className="font-medium text-success-11">{formatCents(preview.creditRestoredCents, format)}</span>
                </div>
              )}
            </div>
            {cardShortfall && <CardRefundShortfallSentence split={cardShortfall} format={format} onBehalfOfMember={onBehalfOfMember} />}
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

  // Loading, cancelling and error: the frame's status region or recovery alert
  // carries the step.
  return renderWithHostingOverrideRegion(null);
}
