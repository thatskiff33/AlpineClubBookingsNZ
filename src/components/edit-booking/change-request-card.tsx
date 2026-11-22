"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ChangeRequestGuestEntry,
  changeRequestGuestsPayload,
} from "@/components/booking/change-request-guest-entry";
import { MEMBER_GUEST_FIND_ENDPOINTS } from "@/components/book/member-guest-find-panel";
import { useClubFormat } from "@/components/club-format-provider";
import type { BookingData, FamilyMember, NewGuest } from "@/components/edit-booking/types";
import type { AgeTierOption } from "@/lib/use-age-tier-options";
import type {
  ChangeRequestAddGuest,
  ChangeRequestEstimate,
  ChangeRequestStay,
} from "@/lib/booking-change-request-guests";
import { formatCents } from "@/lib/utils";
import { shiftDateOnly } from "@/components/edit-booking/stay-nights";

/**
 * Ask an admin to make a change this member is not allowed to make themselves.
 *
 * Moved out of `edit-booking-panel.tsx` (#2690). Whether it appears at all stays
 * in the panel: the condition reads the edit policy AND the text of the
 * quote/save errors, since a refusal naming a lock is what turns an ordinary
 * edit into a request.
 *
 * #4030: the card names WHO the member is asking to add. It used to be one
 * free-text box, so "can we add these three grandchildren" reached the officer
 * naming nobody, and once the stay finished the approval (#3750) had nothing it
 * could charge. Now the member adds each guest with the guest editor's fields
 * and nights inside the stay, sees what they are estimated to cost, and the
 * note stays as context. The server refuses a request with no structured change.
 */
export interface ChangeRequestGuestContext {
  /** The booking: its stay, who is already on it, and the member-guest finder's reach. */
  booking: Pick<BookingData, "id" | "checkIn" | "checkOut" | "guests" | "memberGuest" | "editPolicy">;
  ageTierOptions: AgeTierOption[];
  familyMembers: readonly FamilyMember[];
}

type EstimateState = {
  forPayload: string;
  estimate: ChangeRequestEstimate | null;
  error: string;
};

export function ChangeRequestCard({
  reason,
  submitting,
  error,
  success,
  hasEditorChanges,
  editorChanges,
  guestContext,
  onReasonChange,
  onSubmit,
}: {
  reason: string;
  submitting: boolean;
  error: string;
  success: string;
  /** The guest editor above carries a change the request will send. */
  hasEditorChanges: boolean;
  /** The exact modification payload submission merges with these card guests. */
  editorChanges: Record<string, unknown>;
  guestContext: ChangeRequestGuestContext;
  onReasonChange: (value: string) => void;
  /** Sends the request with these added guests; true when it was accepted. */
  onSubmit: (addGuests: ChangeRequestAddGuest[]) => Promise<boolean>;
}) {
  const format = useClubFormat();
  const [guests, setGuests] = useState<NewGuest[]>([]);
  const [estimateState, setEstimateState] = useState<EstimateState | null>(null);
  const { booking } = guestContext;
  const inProgress = booking.editPolicy.mode === "in-progress";
  // #4030 review S3: the last night the member can no longer book themselves
  // (the night before the edit window opens), so Date In never offers a night
  // the request would refuse as an ordinary edit.
  const lastLockedNight = booking.editPolicy.editableFrom
    ? shiftDateOnly(booking.editPolicy.editableFrom, -1)
    : booking.editPolicy.today;
  const bookingId = booking.id;
  const stay: ChangeRequestStay = { checkIn: booking.checkIn, checkOut: booking.checkOut };
  const payload = changeRequestGuestsPayload(guests, stay);
  const payloadJson = payload.length > 0 ? JSON.stringify({ addGuests: payload, editorChanges }) : null;

  // The estimate for this list AND editor proposal, 400ms after either changes.
  // Only a result keyed to the CURRENT proposal is shown, so a slow answer for an
  // older list can never sit beside a newer one.
  useEffect(() => {
    if (!payloadJson) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/bookings/${bookingId}/change-requests/quote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payloadJson,
          signal: controller.signal,
        });
        const data = await response.json().catch(() => ({}));
        if (controller.signal.aborted) return;
        setEstimateState({
          forPayload: payloadJson,
          estimate: response.ok ? (data.estimate as ChangeRequestEstimate) : null,
          error: response.ok ? "" : data.error || "Could not work out the price",
        });
      } catch {
        if (controller.signal.aborted) return;
        setEstimateState({ forPayload: payloadJson, estimate: null, error: "Could not work out the price" });
      }
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [bookingId, payloadJson]);

  const current = payloadJson && estimateState?.forPayload === payloadJson ? estimateState : null;
  const hasStructuredChange = hasEditorChanges || payload.length > 0;

  async function submit() {
    if (await onSubmit(payload)) setGuests([]);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle headingLevel={2}>Admin Request</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {inProgress ? (
          <p className="text-sm text-muted-foreground">
            A change to tonight or earlier needs the booking officer. Add anybody
            staying who is not on the booking, with the nights they are here.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            This change needs the booking officer&rsquo;s approval. Send it with a
            note and they will review it.
          </p>
        )}
        {/* #4030 review S4: guests are entered here only on a stay under way;
            before it starts, the guest editor above adds them directly. */}
        {inProgress ? (
        <ChangeRequestGuestEntry
          idPrefix="change-request-guest"
          guests={guests}
          onChange={setGuests}
          ageTierOptions={guestContext.ageTierOptions}
          stay={stay}
          existingMemberIds={booking.guests.flatMap((guest) => (guest.memberId ? [guest.memberId] : []))}
          familyMembers={guestContext.familyMembers}
          memberFind={
            booking.memberGuest?.enabled
              ? {
                  openSearchEnabled: booking.memberGuest.openSearchEnabled,
                  endpoints: MEMBER_GUEST_FIND_ENDPOINTS,
                }
              : null
          }
          disabled={submitting}
          stayStartMax={lastLockedNight}
        />
        ) : null}
        {payload.length > 0 ? (
          <ChangeRequestEstimateSummary
            state={current}
            formatMoney={(cents) => formatCents(cents, format)}
          />
        ) : null}
        <div className="space-y-1">
          <Label htmlFor="change-request-reason">Note for the booking officer (optional)</Label>
          <Textarea
            id="change-request-reason"
            value={reason}
            maxLength={2000}
            onChange={(event) => onReasonChange(event.target.value)}
          />
        </div>
        {!hasStructuredChange ? (
          <p className="text-xs text-muted-foreground">
            {inProgress
              ? "Add the guests (or change the dates above) to send a request."
              : "Make the change above to send a request."}{" "}
            A note on its own can&rsquo;t be applied to your booking.
          </p>
        ) : null}
        <Button
          type="button"
          variant="outline"
          onClick={submit}
          disabled={submitting || !hasStructuredChange}
        >
          {submitting ? "Sending..." : "Request Admin Review"}
        </Button>
        {error && (
          <div className="rounded-md bg-danger-3 p-3 text-sm text-danger-11">
            {error}
          </div>
        )}
        {success && (
          <div className="rounded-md bg-success-3 p-3 text-sm text-success-11">
            {success}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ChangeRequestEstimateSummary({
  state,
  formatMoney,
}: {
  state: EstimateState | null;
  formatMoney: (cents: number) => string;
}) {
  const estimate = state?.estimate;
  return (
    <div className="space-y-1 rounded-md border border-border bg-muted p-3 text-sm" aria-live="polite">
      {!state ? (
        <p className="text-muted-foreground">Working out the price...</p>
      ) : state.error ? (
        <p className="text-danger-11">{state.error}</p>
      ) : estimate?.outcome === "unpriced" ? (
        <p className="text-muted-foreground">{estimate.message}</p>
      ) : estimate?.outcome === "priced" &&
        estimate.guests.every((guest) => guest.priceCents === null) ? (
        // #4030 review M5: nobody in the list is priced here, so say so
        // rather than showing $0.00.
        <p className="text-muted-foreground">
          Members are priced at their membership rate when the officer approves.
        </p>
      ) : estimate?.outcome === "priced" ? (
        <>
          <p className="font-medium text-foreground">
            Estimated price for these guests: {formatMoney(estimate.totalCents)}
          </p>
          <p className="text-muted-foreground">
            At the stay&rsquo;s season rates. Adding guests carries no change fee.
            {estimate.excludesMemberGuests
              ? " Members are priced at their own membership rate, which is not in this figure."
              : ""}{" "}
            The booking officer confirms the amount when they approve the request,
            and you are emailed the change and anything to pay.
          </p>
        </>
      ) : null}
    </div>
  );
}
