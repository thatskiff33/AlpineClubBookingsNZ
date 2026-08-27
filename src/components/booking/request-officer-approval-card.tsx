"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MEMBER_MESSAGE_MAX_LENGTH } from "@/lib/booking-exception-requests";
import type { ExceptionOffer } from "@/lib/booking-exception-offer";
import type { PolicyExceptionCapacityMode } from "@/lib/booking-policy-exceptions";
import {
  MEMBER_EXCEPTION_DISCRETIONARY_NOTICE,
  MEMBER_EXCEPTION_NOT_APPROVED_YET_NOTICE,
  MEMBER_EXCEPTION_REPLACE_NOTICE,
  memberExceptionCapacityWording,
  memberExceptionRuleLabel,
  memberExceptionSubmitCapacityWording,
  type MemberExceptionProposal,
  type MemberExceptionRequestSource,
} from "@/lib/member-exception-requests";
import { countNightsDateOnly, parseDateOnly } from "@/lib/date-only";
import { formatClubDate, requireCalendarDate } from "@/lib/club-time";
import { formatCents } from "@/lib/utils";

/**
 * "Request Booking Officer approval" — the member's submission screen (#2562).
 *
 * ONE component for both wizards. The new-booking wizard and the edit-booking
 * panel differ in what they are proposing and in what capacity their request
 * holds, and in nothing else that matters here: the rules being asked about, the
 * mandatory explanation, the two honesty notices and the replace rule are
 * identical, and writing them twice is how the two screens end up promising
 * different things.
 *
 * The caller decides WHETHER to render this, by passing the offer that
 * `readExceptionOffer` returned from the server's refusal. This component never
 * re-derives eligibility, never evaluates a policy and never computes a price.
 *
 * HOW IT SHOWS "THE EXACT PROPOSAL", in two stages, because the honest answer
 * changes at the moment of submission:
 *
 *  - BEFORE: the member's own choices, echoed back — lodge, dates, each guest and
 *    the stay they picked for them, and the price the SERVER last quoted. This is
 *    the member's input, not a recomputation of it; the server remains the only
 *    thing that evaluates policy or price.
 *  - AFTER: the proposal the server actually FROZE, returned by the create call
 *    and rendered verbatim. That matters because the freeze is not the raw
 *    payload — the envelope expands to cover every guest night, exactly as the
 *    canonical create will — so a proposal an officer decides can be wider than
 *    the dates the member typed. Showing the frozen article immediately, while
 *    withdraw and replace are still open, is what stops a member tracking a
 *    request they did not think they made.
 */

/**
 * One guest exactly as the member chose them, for the pre-submit echo.
 *
 * The three ways a member can express a guest's stay are kept DISTINCT rather than
 * flattened, because the card must echo the choice they actually made: a picked
 * night set, a picked date range, or the default of the whole stay. Flattening
 * them would either invent dates the member never picked or report "0 nights" for
 * a guest who is on the whole trip.
 */
export interface ExceptionRequestProposalGuest {
  firstName: string;
  lastName: string;
  /** The club's own label for the tier, resolved by the caller. */
  ageTierLabel: string;
  isMember: boolean;
  /** The nights the member explicitly picked, when they picked a night set. */
  nights: string[];
  /** The range the member picked, when they picked a range instead. */
  stay: { start: string; end: string } | null;
}

/**
 * The price impact of the proposal, as the SERVER quoted it.
 *
 * Optional on purpose. Several refusals happen BEFORE the server produces a quote
 * — #2543's paid-up-adult 409 is answered instead of a modify quote — and inventing
 * a figure to fill the gap would put a number on screen that no pricing pass ever
 * produced. When it is absent the card says how pricing actually works instead.
 */
export interface ExceptionRequestPriceImpact {
  /** What the number means, e.g. "Total for this stay" or "Extra to pay". */
  label: string;
  amountCents: number;
}

export interface ExceptionRequestProposalView {
  /** The lodge's own name where the caller knows it; falls back to a neutral line. */
  lodgeName: string | null;
  /** YYYY-MM-DD NZ lodge nights. */
  checkIn: string;
  checkOut: string;
  /** Nights in the stay envelope — a plain date span, not a policy calculation. */
  envelopeNightCount: number;
  guests: ExceptionRequestProposalGuest[];
  /**
   * What the live booking looks like today, on a modification. Null for a new
   * booking, which has no base to change from.
   */
  base: {
    checkIn: string;
    checkOut: string;
    guestCount: number;
  } | null;
  priceImpact: ExceptionRequestPriceImpact | null;
  /**
   * Parts of the member's pending change that an exception request CANNOT carry,
   * in plain English (#2562).
   *
   * A policy-exception proposal is a party and a set of nights. A modification the
   * member was refused can also carry things that are not part of a party — a guest
   * name correction, a promo code, an account-credit election, a placeholder-to-
   * member link. Those are not in the frozen proposal, so an approval will not
   * apply them, and a member who is not told that would reasonably assume the whole
   * edit was submitted. Empty on the new-booking path, which has no such extras.
   */
  omittedChanges: string[];
}

/** What the create call answers with — the frozen article. */
export interface ExceptionRequestSubmitResult {
  id: string;
  proposal: MemberExceptionProposal;
  capacityHeld: boolean;
  /**
   * The request's own frozen HOLD-if-any-HOLD aggregate, for the receipt's
   * capacity sentence. Needed because `capacityHeld: false` has two causes and
   * only one of them means "this change needs no extra beds" — see
   * `memberExceptionCapacityWording`.
   */
  capacityMode: PolicyExceptionCapacityMode | null;
}

export interface RequestOfficerApprovalCardProps {
  source: MemberExceptionRequestSource;
  /** The server-confirmed offer. The caller renders nothing when this is null. */
  offer: ExceptionOffer;
  proposal: ExceptionRequestProposalView;
  /**
   * The open request this submission REPLACES, when the member arrived here to
   * correct one. Passed straight through as `supersedeRequestId`, which the
   * service claims REQUESTED -> SUPERSEDED before creating the replacement, so a
   * lost claim creates nothing at all.
   */
  replaceRequestId?: string | null;
  /** Submit. Resolves to the created request, or throws with a message. */
  onSubmit: (input: {
    memberMessage: string;
    supersedeRequestId: string | null;
  }) => Promise<ExceptionRequestSubmitResult>;
  /** Where the member goes to track it — the request area anchor. */
  requestAreaHref?: string;
}

/**
 * A date-only lodge night rendered as the calendar day it IS - shifted by NO
 * zone, the viewer's or the club's (CT-4, #2870; INV-DATE-010).
 *
 * WHAT THIS REPLACES pinned the value to UTC midnight and then read it back
 * through `APP_TIME_ZONE`. That round trip is the identity only while the club
 * is east of Greenwich; for a club west of it every lodge night printed a day
 * early. A calendar day has no zone, so the kernel's formatter takes none.
 */
function formatNight(value: string) {
  return formatClubDate(requireCalendarDate(value));
}

/**
 * How many nights one guest's stated stay covers, and how to say it.
 *
 * Plain date-only arithmetic over the member's own selection — NOT a policy or
 * pricing calculation, and not a reimplementation of the server's proposal
 * builder. The server still decides what is frozen; if its envelope expansion
 * widens anything, the frozen proposal shown after submission says so.
 */
function describeGuestStay(
  guest: ExceptionRequestProposalGuest,
  envelopeNightCount: number,
): { nightCount: number; label: string } {
  if (guest.nights.length > 0) {
    return {
      nightCount: guest.nights.length,
      label: `${guest.nights.length} ${
        guest.nights.length === 1 ? "night" : "nights"
      } (${guest.nights.map(formatNight).join(", ")})`,
    };
  }
  if (guest.stay) {
    const nightCount = countNightsDateOnly(
      parseDateOnly(guest.stay.start),
      parseDateOnly(guest.stay.end),
    );
    return {
      nightCount,
      label: `${formatNight(guest.stay.start)} to ${formatNight(guest.stay.end)}`,
    };
  }
  return { nightCount: envelopeNightCount, label: "the whole stay" };
}

export function RequestOfficerApprovalCard({
  source,
  offer,
  proposal,
  replaceRequestId = null,
  onSubmit,
  requestAreaHref = "/bookings#booking-rule-requests",
}: RequestOfficerApprovalCardProps) {
  const [memberMessage, setMemberMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<ExceptionRequestSubmitResult | null>(
    null,
  );

  const trimmed = memberMessage.trim();
  // The member's own selection arithmetic, not a policy calculation.
  const guestStays = proposal.guests.map((guest) =>
    describeGuestStay(guest, proposal.envelopeNightCount),
  );
  const guestNights = guestStays.reduce(
    (sum, stay) => sum + stay.nightCount,
    0,
  );
  const capacityWording = memberExceptionSubmitCapacityWording({
    source,
    capacityMode: offer.capacityMode,
  });

  async function handleSubmit() {
    if (!trimmed) {
      setError("Tell the Booking Officer why you are asking. This is required.");
      setErrorCode(null);
      return;
    }
    setSubmitting(true);
    setError(null);
    setErrorCode(null);
    try {
      const created = await onSubmit({
        memberMessage: trimmed,
        supersedeRequestId: replaceRequestId,
      });
      setSubmitted(created);
    } catch (err) {
      // The caller throws with the server's own sentence; a `code` on the error
      // lets the two 409s that have different next steps say so.
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: unknown }).code ?? "")
          : "";
      setError(
        err instanceof Error && err.message
          ? err.message
          : "The request could not be sent. Try again.",
      );
      setErrorCode(code || null);
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    const frozen = submitted.proposal;
    return (
      <div
        className="space-y-3 rounded-md border border-success-6 bg-success-3 p-4 text-sm text-success-11"
        data-testid="exception-request-sent"
      >
        <p className="text-base font-semibold">Request sent</p>
        <p>
          A Booking Officer has it now. It is not booked and it is not confirmed —
          they decide the exact proposal below, and they may say no.
        </p>
        <div className="rounded-md border border-border bg-background p-3 text-foreground">
          <p className="font-medium">Exactly what the Booking Officer will decide</p>
          {frozen.checkIn && frozen.checkOut ? (
            <p className="mt-1 text-muted-foreground">
              {formatNight(frozen.checkIn)} to {formatNight(frozen.checkOut)} ·{" "}
              {frozen.guestNights} guest nights across {frozen.guests.length}{" "}
              {frozen.guests.length === 1 ? "guest" : "guests"}
            </p>
          ) : null}
          {frozen.guests.length > 0 ? (
            <ul className="mt-2 space-y-1 text-muted-foreground">
              {frozen.guests.map((guest, index) => (
                <li key={`${guest.firstName}-${guest.lastName}-${index}`}>
                  {guest.firstName} {guest.lastName}
                  {guest.isMember ? " (member)" : ""}
                  {guest.nights.length > 0
                    ? ` · ${guest.nights.length} ${guest.nights.length === 1 ? "night" : "nights"} (${guest.nights
                        .map(formatNight)
                        .join(", ")})`
                    : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <p>
          {/* The FROZEN request's own capacity answer, from the write rather than
              from the policy's intent. */}
          {memberExceptionCapacityWording({
            source,
            status: "pending",
            capacityHeld: submitted.capacityHeld,
            // The FROZEN mode, so a NO_HOLD change that needs beds is not told it
            // needs none. Falls back to the offer's aggregate, which is the same
            // server-computed value the refusal carried.
            capacityMode: submitted.capacityMode ?? offer.capacityMode,
          })}
        </p>
        <p>
          <Link href={requestAreaHref} className="underline">
            Track it under &ldquo;My booking-rule requests&rdquo;
          </Link>{" "}
          — you can withdraw it or replace it from there while it is still open.
        </p>
      </div>
    );
  }

  return (
    <div
      className="space-y-4 rounded-md border border-info-6 bg-info-3 p-4 text-sm text-info-11"
      data-testid="request-officer-approval"
    >
      <div className="space-y-1">
        <p className="text-base font-semibold">
          {replaceRequestId
            ? "Replace your request to a Booking Officer"
            : "Ask a Booking Officer to allow this"}
        </p>
        <p>{offer.message}</p>
      </div>

      {/* Every covered rule, all at once. The owner's decision is explicit that
          several failures must be explained together rather than revealed one at a
          time, and the frozen evidence carries them all. */}
      <div className="rounded-md border border-border bg-background p-3 text-foreground">
        <p className="font-medium">
          {offer.violations.length === 1
            ? "The rule you are asking to be let past"
            : "The rules you are asking to be let past"}
        </p>
        <ul className="mt-2 space-y-2">
          {offer.violations.map((violation, index) => (
            <li key={`${violation.reasonCode}-${index}`}>
              <span className="font-medium">
                {memberExceptionRuleLabel(violation.reasonCode)}
              </span>
              {violation.message ? (
                <span className="block text-muted-foreground">
                  {violation.message}
                </span>
              ) : null}
              {violation.affectedNights.length > 0 ? (
                <span className="block text-muted-foreground">
                  Nights affected:{" "}
                  {violation.affectedNights.map(formatNight).join(", ")}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-md border border-border bg-background p-3 text-foreground">
        <p className="font-medium">What you are about to send</p>
        <dl className="mt-2 space-y-1">
          <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
            <dt className="text-muted-foreground sm:w-40">Lodge</dt>
            <dd>{proposal.lodgeName ?? "Your club's lodge"}</dd>
          </div>
          <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
            <dt className="text-muted-foreground sm:w-40">Nights</dt>
            <dd>
              {formatNight(proposal.checkIn)} to {formatNight(proposal.checkOut)}
            </dd>
          </div>
          {proposal.base ? (
            <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
              <dt className="text-muted-foreground sm:w-40">Booking today</dt>
              <dd>
                {formatNight(proposal.base.checkIn)} to{" "}
                {formatNight(proposal.base.checkOut)} · {proposal.base.guestCount}{" "}
                {proposal.base.guestCount === 1 ? "guest" : "guests"}
              </dd>
            </div>
          ) : null}
          <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
            <dt className="text-muted-foreground sm:w-40">Guest nights</dt>
            <dd>
              {guestNights} across {proposal.guests.length}{" "}
              {proposal.guests.length === 1 ? "guest" : "guests"}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
            <dt className="text-muted-foreground sm:w-40">Price</dt>
            <dd>
              {proposal.priceImpact ? (
                <>
                  {proposal.priceImpact.label}:{" "}
                  {formatCents(proposal.priceImpact.amountCents)}{" "}
                  <span className="text-muted-foreground">
                    (the club&apos;s quote for this proposal as it stands; it is
                    worked out again if a Booking Officer approves it, and nothing
                    is charged while the request waits)
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">
                  Worked out at the club&apos;s normal rates for the party and
                  nights above if a Booking Officer approves this. Nothing is
                  charged while the request waits.
                </span>
              )}
            </dd>
          </div>
        </dl>
        <ul className="mt-3 space-y-1">
          {proposal.guests.map((guest, index) => (
            <li key={`${guest.firstName}-${guest.lastName}-${index}`}>
              {guest.firstName} {guest.lastName} — {guest.ageTierLabel}
              {guest.isMember ? ", member" : ""}
              <span className="text-muted-foreground">
                {" "}
                · {guestStays[index].label}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {proposal.omittedChanges.length > 0 ? (
        <p className="rounded-md border border-warning-6 bg-warning-3 p-3 text-warning-11">
          A request covers the dates and the party, and nothing else — so these
          parts of your change are NOT included and will not be applied if this is
          approved: {proposal.omittedChanges.join(", ")}. Make those changes
          separately once this is decided.
        </p>
      ) : null}

      {/* The honest capacity sentence for this path, then the two notices the
          owner's decision requires on every submission screen. */}
      <p className="rounded-md border border-warning-6 bg-warning-3 p-3 text-warning-11">
        {capacityWording}
      </p>
      <p>{MEMBER_EXCEPTION_NOT_APPROVED_YET_NOTICE}</p>
      <p>{MEMBER_EXCEPTION_DISCRETIONARY_NOTICE}</p>
      <p className="text-muted-foreground">{MEMBER_EXCEPTION_REPLACE_NOTICE}</p>

      <div className="space-y-1">
        <Label htmlFor="exception-request-message">
          Why are you asking? (required)
        </Label>
        <Textarea
          id="exception-request-message"
          value={memberMessage}
          onChange={(event) => setMemberMessage(event.target.value)}
          maxLength={MEMBER_MESSAGE_MAX_LENGTH}
          rows={4}
          placeholder="Anything that helps a Booking Officer decide — why these nights, who is coming, what you have already tried."
        />
        <p className="text-xs text-muted-foreground">
          {trimmed.length} of {MEMBER_MESSAGE_MAX_LENGTH} characters used.
        </p>
      </div>

      {error ? (
        <div role="alert" className="space-y-2 text-danger-11">
          <p>{error}</p>
          {/* Each of the two conflicts has a different next step, and neither is
              "try again" — so say what to do rather than leaving a dead end. */}
          {errorCode === "OPEN_EXCEPTION_REQUEST" ? (
            <p>
              <Link href={requestAreaHref} className="underline">
                Open &ldquo;My booking-rule requests&rdquo;
              </Link>{" "}
              and replace the request you already have — a Booking Officer only
              ever holds one open request from you for this.
            </p>
          ) : null}
          {errorCode === "LOST_SUPERSEDE_CLAIM" ? (
            <p>
              <Link href={requestAreaHref} className="underline">
                Open &ldquo;My booking-rule requests&rdquo;
              </Link>{" "}
              to see what happened to the one you were replacing — it has already
              been decided, withdrawn or replaced, so nothing new was sent.
            </p>
          ) : null}
        </div>
      ) : null}

      <Button
        type="button"
        onClick={() => void handleSubmit()}
        disabled={submitting || trimmed.length === 0}
      >
        {submitting
          ? "Sending..."
          : replaceRequestId
            ? "Replace my request"
            : "Request Booking Officer approval"}
      </Button>
    </div>
  );
}
