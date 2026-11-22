"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { fetchWithRecentAuth } from "@/components/confirm-its-you";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { BookingNoEmailsNotice } from "@/components/booking-no-emails-notice";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { useClubFormat } from "@/components/club-format-provider";
import { formatCents } from "@/lib/pricing";
import {
  workPartyAskAbsorbedSentence,
  workPartyAskPartlyAbsorbedSentence,
  workPartyCreditBackCents,
} from "@/lib/edit-money-back";
import { unverifiedWriteMessage } from "@/lib/unverified-write-copy";
import { apiErrorCodeFromBody, apiErrorMessageFromBody } from "@/lib/api-error-message";
import {
  WORK_PARTY_CORRECTION_FIGURES_CHANGED_MESSAGE,
  WORK_PARTY_FIGURES_CHANGED_CODE,
} from "@/lib/work-party-figures-changed";
import { OptionCard, OptionCardGroup } from "@/components/ui/option-card";
import { BookingWorkPartyRemoveControls } from "@/components/admin/booking-work-party-remove-controls";
import type { BookingModificationSettlementMethod } from "@/lib/booking-modify-validation";
import type { WorkPartyCorrectionFigures } from "@/lib/work-party-booking-correction";
import type { WorkPartySettlementOptions } from "@/lib/work-party-settlement-options";

type WorkPartyOption = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  discountPercent: number;
  lodgeName: string | null;
  eligible: boolean;
  reason: string | null;
};

/**
 * "Add booking to work party" (fork triyder/AlpineClubBookingsNZ#119), on the admin tools card of a
 * booking. For a member who forgot to tick "I am attending a working bee": the
 * officer picks the work party, sees what the booking will cost and how much
 * comes back (a dry run of the real change), and confirms. On a paid booking
 * the officer chooses club credit or a refund, as on an ordinary edit: to the
 * card, or by bank transfer for Internet Banking (triyder/AlpineClubBookingsNZ#129, upstream owner
 * decision 15 Nov 2026); the choice re-runs the dry run. An organiser-paid joiner's money goes back to
 * the organiser. The figures shown are the figures saved — the route refuses
 * if they, or the choice, moved.
 * Bookings edit; a bookings-view admin sees the button disabled. A booking
 * already on a work party is offered "Remove from work party" instead (fork triyder/AlpineClubBookingsNZ#130).
 */
export function BookingWorkPartyControls({
  bookingId,
  noEmails = false,
  currentWorkParty = null,
}: {
  bookingId: string;
  /** The booking's "No emails" switch: when on, the member is not emailed. */
  noEmails?: boolean;
  /** The work party the booking is on, or null. */
  currentWorkParty?: { id: string; name: string } | null;
}) {
  if (currentWorkParty) {
    return (
      <BookingWorkPartyRemoveControls bookingId={bookingId} workParty={currentWorkParty} noEmails={noEmails} />
    );
  }
  return <BookingWorkPartyAddControls bookingId={bookingId} noEmails={noEmails} />;
}

function BookingWorkPartyAddControls({
  bookingId,
  noEmails,
}: {
  bookingId: string;
  noEmails: boolean;
}) {
  const canEdit = useAdminAreaEditAccess("bookings");
  const format = useClubFormat();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [options, setOptions] = useState<WorkPartyOption[] | null>(null);
  const [current, setCurrent] = useState<{ name: string } | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [figures, setFigures] = useState<WorkPartyCorrectionFigures | null>(null);
  const [settlementOptions, setSettlementOptions] = useState<WorkPartySettlementOptions | null>(null);
  // Undefined until the officer chooses: the server's default (club credit).
  const [settlementMethod, setSettlementMethod] = useState<BookingModificationSettlementMethod | undefined>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const money = (cents: number) => formatCents(cents, format);

  async function openDialog() {
    setOpen(true);
    setError("");
    setFigures(null);
    setSettlementOptions(null);
    setSettlementMethod(undefined);
    setOptions(null);
    setCurrent(null);
    setSelectedId("");
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/bookings/${bookingId}/work-party`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(apiErrorMessageFromBody(data, "Could not load the work parties for this booking."));
        return;
      }
      setOptions(data.workParties ?? []);
      setCurrent(data.currentWorkParty ?? null);
      const firstEligible = (data.workParties ?? []).find((o: WorkPartyOption) => o.eligible);
      setSelectedId(firstEligible?.id ?? "");
    } catch {
      setError("Could not load the work parties for this booking. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  /**
   * `notify` is the officer's email choice, offered only while the booking's
   * "No emails" switch is off. With it on there is no choice, and the field is
   * not sent: the mailer withholds the change email and records that (#2259).
   */
  async function send(
    mode: "preview" | "apply",
    notify?: boolean,
    method: BookingModificationSettlementMethod | undefined = settlementMethod,
  ) {
    if (!selectedId) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetchWithRecentAuth(`/api/admin/bookings/${bookingId}/work-party`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "preview"
            ? { mode, workPartyEventId: selectedId, settlementMethod: method }
            : {
                mode,
                workPartyEventId: selectedId,
                settlementMethod: method,
                // Silenced: undefined, so the field is dropped and the mailer
                // withholds and records the send (#2259 H1).
                notifyMember: noEmails ? undefined : notify,
                expectedFigures: figures,
              },
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && apiErrorCodeFromBody(data) === WORK_PARTY_FIGURES_CHANGED_CODE) {
        // The choice may have changed with the figures (#5149 review M1).
        setFigures(data.figures);
        setSettlementOptions(data.settlementOptions ?? null);
        setError(apiErrorMessageFromBody(data, WORK_PARTY_CORRECTION_FIGURES_CHANGED_MESSAGE));
        return;
      }
      if (!res.ok) {
        // A refusal leaves nothing the officer saw valid to confirm: drop the old figures.
        setFigures(null);
        setError(apiErrorMessageFromBody(data, "The booking could not be added to the work party."));
        return;
      }
      if (mode === "preview") {
        setFigures(data.figures);
        setSettlementOptions(data.settlementOptions ?? null);
        return;
      }
      setOpen(false);
      toast.success("Booking added to the work party.");
      if (data.followUpFailed) {
        toast.warning(
          "Saved, but a follow-up step (email or accounting) did not complete. Check the booking.",
        );
      }
      router.refresh();
    } catch {
      // fetch also rejects after a commit, so this cannot say nothing moved.
      setError(
        mode === "preview"
          ? "Could not check the new total. Check your connection and try again."
          : unverifiedWriteMessage(
              "the booking was added to the work party",
              "Reload the booking and check its price and history before trying again.",
            ),
      );
    } finally {
      setBusy(false);
    }
  }

  const selected = options?.find((o) => o.id === selectedId) ?? null;
  const chosenMethod = settlementMethod ?? settlementOptions?.methods[0] ?? "credit";

  /** A new choice clears the figures and re-runs the dry run with it. */
  function chooseSettlement(method: BookingModificationSettlementMethod) {
    if (busy || method === chosenMethod) return;
    setSettlementMethod(method);
    setFigures(null);
    void send("preview", undefined, method);
  }

  return (
    <div className="space-y-1">
      <ViewOnlyActionButton
        canEdit={canEdit}
        variant="outline"
        size="sm"
        onClick={openDialog}
      >
        Add to work party
      </ViewOnlyActionButton>
      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add booking to a work party</DialogTitle>
            <DialogDescription>
              For a member who forgot to tick &ldquo;I am attending a working
              bee&rdquo;. The booking is repriced with the work party&apos;s
              discount, and anything already paid above the new total goes back
              as account credit or, if you choose, as a refund the way it was
              paid: to the card, or by bank transfer. A group organiser&apos;s
              payment goes back to the organiser.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {loading && <p className="text-muted-foreground">Loading…</p>}
            {current && (
              <p>This booking is already on &ldquo;{current.name}&rdquo;.</p>
            )}
            {!loading && !current && options && options.length === 0 && (
              <p className="text-muted-foreground">
                No active work party overlaps this booking&apos;s nights.
              </p>
            )}
            {!loading && !current && options && options.length > 0 && (
              <div className="space-y-1">
                <Label htmlFor={`work-party-${bookingId}`}>Work party</Label>
                <Select
                  value={selectedId}
                  disabled={busy}
                  onValueChange={(value) => {
                    setSelectedId(value);
                    setFigures(null);
                    setSettlementOptions(null);
                    setSettlementMethod(undefined);
                    setError("");
                  }}
                >
                  <SelectTrigger
                    id={`work-party-${bookingId}`}
                    className="w-full"
                    aria-describedby={`work-party-reasons-${bookingId}`}
                  >
                    <SelectValue placeholder="Choose a work party…" />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((o) => (
                      <SelectItem key={o.id} value={o.id} disabled={!o.eligible}>
                        {o.name} ({o.startDate} – {o.endDate}, {o.discountPercent}% off)
                        {o.lodgeName ? ` — ${o.lodgeName}` : ""}
                        {o.eligible ? "" : " — not available"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div id={`work-party-reasons-${bookingId}`}>
                  {options
                    .filter((o) => !o.eligible && o.reason)
                    .map((o) => (
                      <p key={o.id} className="text-xs text-muted-foreground">
                        {o.name}: {o.reason}
                      </p>
                    ))}
                </div>
              </div>
            )}
            {selected && settlementOptions && (
              <WorkPartySettlementChoice
                options={settlementOptions}
                chosenMethod={chosenMethod}
                busy={busy}
                onChoose={chooseSettlement}
              />
            )}
            {figures && selected && (
              <div
                className="space-y-1 rounded-md border p-3"
                data-testid="work-party-figures"
                aria-live="polite"
              >
                <p>
                  New total: <strong>{money(figures.newFinalPriceCents)}</strong>{" "}
                  (was {money(figures.previousFinalPriceCents)})
                </p>
                <WorkPartyMoneyBackLines figures={figures} options={settlementOptions} money={money} />
                {figures.additionalAmountCents > 0 && (
                  <p>
                    Still to pay: <strong>{money(figures.additionalAmountCents)}</strong>
                  </p>
                )}
                {noEmails && <BookingNoEmailsNotice />}
              </div>
            )}
            {error && (
              <p role="alert" className="font-medium text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            {figures ? (
              !noEmails ? (
                <>
                  <Button
                    variant="outline"
                    onClick={() => send("apply", false)}
                    disabled={busy || !selectedId}
                  >
                    Add without emailing
                  </Button>
                  <Button onClick={() => send("apply", true)} disabled={busy || !selectedId}>
                    {busy ? "Saving…" : "Add and email member"}
                  </Button>
                </>
              ) : (
                <Button onClick={() => send("apply")} disabled={busy || !selectedId}>
                  {busy ? "Saving…" : "Add to work party"}
                </Button>
              )
            ) : (
              <Button
                onClick={() => send("preview")}
                disabled={busy || !selectedId || Boolean(current)}
              >
                {busy ? "Checking…" : "Show the new total"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * How the discount comes back (triyder/AlpineClubBookingsNZ#129): a plain line for an organiser-paid
 * joiner, whose money has the organiser's one disposition (triyder/AlpineClubBookingsNZ#129 decision 5);
 * otherwise a choice only where there is one, as on an ordinary edit — club
 * credit or a refund, named for where it goes (the card, or a bank transfer
 * for Internet Banking; upstream owner decision, 15 Nov 2026).
 */
function WorkPartySettlementChoice({
  options,
  chosenMethod,
  busy,
  onChoose,
}: {
  options: WorkPartySettlementOptions;
  chosenMethod: BookingModificationSettlementMethod;
  busy: boolean;
  onChoose: (method: BookingModificationSettlementMethod) => void;
}) {
  if (options.paidByOrganiser) {
    return (
      <p data-testid="work-party-organiser-disposition">
        The group organiser paid for this booking, so any money back
        goes to the organiser, the way they paid: to their card, or by
        bank transfer.
      </p>
    );
  }
  if (options.methods.length < 2) return null;
  const refundsByBank = options.refundTo === "bank";
  return (
    <OptionCardGroup label="How the discount comes back">
      <OptionCard
        title="Club credit"
        selected={chosenMethod === "credit"}
        onSelect={() => onChoose("credit")}
        disabled={busy}
      >
        Held on the member&apos;s account for a later booking.
      </OptionCard>
      <OptionCard
        title={refundsByBank ? "Refund to bank account" : "Refund to card"}
        selected={chosenMethod === "card"}
        onSelect={() => onChoose("card")}
        disabled={busy}
      >
        {refundsByBank
          ? "Paid by Internet Banking, so the club sends it back by bank transfer."
          : "Back to the card the booking was paid with."}
      </OptionCard>
    </OptionCardGroup>
  );
}

/** The money coming back, in the figures: a refund, and every cent of credit. */
function WorkPartyMoneyBackLines({
  figures,
  options,
  money,
}: {
  figures: WorkPartyCorrectionFigures;
  options: WorkPartySettlementOptions | null;
  money: (cents: number) => string;
}) {
  // An unpaid ask took the whole reduction (#5149 B-L1): nothing comes back.
  const askOffsetCents = options?.unpaidAskOffsetCents ?? 0;
  if (askOffsetCents > 0 && options?.methods.length === 0) {
    return <p data-testid="work-party-ask-absorbed">{workPartyAskAbsorbedSentence(money(askOffsetCents))}</p>;
  }
  // Every cent coming back as credit: paid money credited, a paid booking's
  // applied credit given back, and an unpaid one's applied credit freed (triyder/AlpineClubBookingsNZ#129).
  const creditBackCents = workPartyCreditBackCents(figures);
  return (
    <>
      {figures.refundAmountCents > 0 && (
        <p>
          {options?.paidByOrganiser
            ? "Returned to the group organiser: "
            : options?.refundTo === "bank"
              ? "To be refunded by bank transfer: "
              : "Refunded to card: "}
          <strong>{money(figures.refundAmountCents)}</strong>
        </p>
      )}
      {(figures.refundAmountCents === 0 || creditBackCents > 0) && (
        <p>
          Account credit to the member: <strong>{money(creditBackCents)}</strong>
        </p>
      )}
      {askOffsetCents > 0 && (
        <p data-testid="work-party-ask-partly-absorbed">{workPartyAskPartlyAbsorbedSentence(money(askOffsetCents))}</p>
      )}
    </>
  );
}
