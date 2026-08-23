"use client";

import type { AgeTier } from "@prisma/client";
import { useState, useCallback, useMemo, useRef } from "react";
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
import { useAgeTierOptions } from "@/lib/use-age-tier-options";
// The create wizard's own prediction + column translation, imported rather than
// re-implemented (MG4 #2309). The first cut of this panel wrote its own copy of
// both and the two immediately disagreed about an admin add — see
// `predictMemberGuestConsent`'s note on `actorKind`.
import { predictMemberGuestConsent } from "@/app/(authenticated)/book/_components/member-guest-preview";
import type { MemberGuestCandidate } from "@/lib/member-guest-find";
import { BookingNoEmailsNotice } from "@/components/booking-no-emails-notice";
import { HostingCoverageOverridePrompt } from "@/components/hosting-coverage-override-prompt";
import {
  RequestOfficerApprovalCard,
  type ExceptionRequestSubmitResult,
} from "@/components/booking/request-officer-approval-card";
import {
  readExceptionOffer,
  type ExceptionOffer,
} from "@/lib/booking-exception-offer";
import { countNightsDateOnly, parseDateOnly } from "@/lib/date-only";
import { type PromoResult } from "@/components/promo-code-input";
import {
  hostingCoverageMutationSignature,
  readHostingCoverageOverridePrompt,
} from "@/lib/hosting-coverage-override-client";

import { AccountCreditCard } from "@/components/edit-booking/account-credit-card";
import { AdminOverrideCard } from "@/components/edit-booking/admin-override-card";
import { ChangeRequestCard } from "@/components/edit-booking/change-request-card";
import { EditDatesCard } from "@/components/edit-booking/edit-dates-card";
import { EditGuestsCard } from "@/components/edit-booking/edit-guests-card";
import { PriceSummaryCard } from "@/components/edit-booking/price-summary-card";
import { PromoCodeCard } from "@/components/edit-booking/promo-code-card";
import { ReviewJustificationField } from "@/components/edit-booking/review-justification-field";
import {
  exceptionProposalSignature,
  exceptionRequestPayloadFromModification,
} from "@/components/edit-booking/exception-request-payload";
import {
  eachNightKey,
  previousDateOnly,
  shiftDateKey,
} from "@/components/edit-booking/stay-nights";
import type {
  BookingData,
  FamilyMember,
  Guest,
  NewGuest,
  PartnerSharingCandidate,
} from "@/components/edit-booking/types";
import { useAvailablePromoCodes } from "@/components/edit-booking/hooks/use-available-promo-codes";
import { useBookingFamilyOptions } from "@/components/edit-booking/hooks/use-booking-family-options";
import { useGuestDateModes } from "@/components/edit-booking/hooks/use-guest-date-modes";
import {
  useHostingCoverageOverride,
  type HostingOverrideState,
} from "@/components/edit-booking/hooks/use-hosting-coverage-override";
import { useMemberGuestFinder } from "@/components/edit-booking/hooks/use-member-guest-finder";
import { useOtherLodgeRate } from "@/components/edit-booking/hooks/use-other-lodge-rate";
import {
  useDebouncedModificationQuote,
  useModificationQuoteState,
} from "@/components/edit-booking/hooks/use-modification-quote";
import {
  usePromoBeneficiaryReset,
  usePromoSelectionState,
} from "@/components/edit-booking/hooks/use-promo-selection";
import { useReviewJustificationLatch } from "@/components/edit-booking/hooks/use-review-justification-latch";

// #2104: mirror of requiresAdultSupervisionReview (src/lib/booking-review.ts).
// Inlined (not imported) to match the create wizard's client-side predicate
// (use-booking-wizard.ts:180-187) and keep server-leaning modules out of the
// client bundle. The server remains the enforcer; this only drives the UI.
function editTripsAdultSupervisionReview(
  guests: Array<{ ageTier: string }>,
): boolean {
  const hasAdult = guests.some((g) => g.ageTier === "ADULT");
  const hasMinor = guests.some(
    (g) => g.ageTier === "CHILD" || g.ageTier === "YOUTH" || g.ageTier === "INFANT",
  );
  return hasMinor && !hasAdult;
}

/**
 * The edit-booking panel's shell: the pending edit's state, the mutations, and
 * the composition of the concern cards.
 *
 * #2690 split this file by concern. What stayed here is what genuinely
 * orchestrates: the editable state several concerns share, the reset an admin
 * override performs across all of them, the save and its refusal handling, the
 * exception-request submission, and the admin notify dialog. The effect-driven
 * data and reset flows live in named hooks under `edit-booking/hooks/`, and each
 * card under `edit-booking/` renders one concern and decides nothing about the
 * others.
 */
export function EditBookingPanel({
  booking,
  canAdminOverride = false,
  replaceExceptionRequestId = null,
  onDone,
}: {
  booking: BookingData;
  /**
   * #2562: the open policy-exception request this edit is here to REPLACE, from
   * `/bookings/<id>?replaceRequest=<id>` — the link the member's request area
   * renders. Passed through as `supersedeRequestId`; the service does the guarded
   * claim, so a stale or foreign id loses it and creates nothing.
   */
  replaceExceptionRequestId?: string | null;
  // Issue #1668: admin override lifts the date-window locks for this booking.
  // (Whether the standard self-service path is available is expressed by the
  // booking.editPolicy fields the panel already reads.)
  canAdminOverride?: boolean;
  onDone: () => void;
}) {
  const router = useRouter();
  const ageTierOptions = useAgeTierOptions();

  // Editable state
  const [checkIn, setCheckIn] = useState(booking.checkIn);
  const [checkOut, setCheckOut] = useState(booking.checkOut);
  const [removedGuestIds, setRemovedGuestIds] = useState<Set<string>>(new Set());
  const [addedGuests, setAddedGuests] = useState<NewGuest[]>([]);
  // Seeded per-guest state, extracted so the admin-override toggle (#1668) can
  // restore the exact stored baseline — resetting to {} instead would let the
  // night grid's all-nights-on fallback silently collapse a guest's gaps.
  const seedExistingGuestRanges = () =>
    Object.fromEntries(
      booking.guests.map((guest) => [
        guest.id,
        {
          stayStart: guest.stayStart ?? booking.checkIn,
          stayEnd: guest.stayEnd ?? booking.checkOut,
        },
      ])
    );
  const seedExistingGuestNights = () =>
    Object.fromEntries(
      booking.guests.map((guest) => [
        guest.id,
        guest.nights && guest.nights.length > 0
          ? [...guest.nights].sort()
          : eachNightKey(
              guest.stayStart ?? booking.checkIn,
              guest.stayEnd ?? booking.checkOut
            ),
      ])
    );
  const [existingGuestRanges, setExistingGuestRanges] = useState<
    Record<string, { stayStart: string; stayEnd: string }>
  >(seedExistingGuestRanges);
  // Per existing-guest night set (keyed by guest id), seeded from stored nights
  // or the contiguous range so toggling the grid never wipes a guest's gaps.
  const [existingGuestNights, setExistingGuestNights] = useState<
    Record<string, string[]>
  >(seedExistingGuestNights);
  const [guestNameEdits, setGuestNameEdits] = useState<
    Record<string, { firstName: string; lastName: string }>
  >(() =>
    Object.fromEntries(
      booking.guests.map((guest) => [
        guest.id,
        { firstName: guest.firstName, lastName: guest.lastName },
      ])
    )
  );
  // MG4 (#2309): the server's neutral D-8 refusal for the last member-guest
  // add, kept separate from `quoteError` so it can be drawn beside the person it
  // is about instead of only in the panel's page-level error line.
  const [memberGuestAddError, setMemberGuestAddError] = useState<string | null>(
    null,
  );

  const { familyMembers, familyMembersLoaded, partnerCandidates } =
    useBookingFamilyOptions({
      bookingId: booking.id,
      viewerRole: booking.viewerRole,
    });
  const availablePromoCodes = useAvailablePromoCodes(booking.viewerRole);

  // #2266: account credit. `useCredit` is seeded from the stored election
  // (#2265) so re-opening a draft shows the saved choice; `creditTouched`
  // separates "the member changed their mind" from "the panel recomputed".
  const credit = booking.credit ?? null;
  const storedElectionCents = credit?.electionCents ?? 0;
  const [useCredit, setUseCredit] = useState(storedElectionCents > 0);
  const [creditTouched, setCreditTouched] = useState(false);

  // Issue #1668: admin date override. When enabled, the member-facing date
  // locks are bypassed and the admin chooses how pricing is handled. Every
  // override edit is date-only, audited, and confirmed if over capacity.
  // The override control renders only when the server says this viewer may
  // override (canAdminOverride) AND the serialised edit policy agrees (#1668).
  const adminOverrideAvailable =
    canAdminOverride && booking.editPolicy.adminOverrideAvailable !== false;
  const [overrideEnabled, setOverrideEnabled] = useState(false);
  const [overridePricingMode, setOverridePricingMode] = useState<
    "shift" | "recalculate" | null
  >(null);
  const [confirmOverCapacity, setConfirmOverCapacity] = useState(false);
  // Belt-and-braces (a stale quote): an apply 409 re-surfaces the confirm flow.
  const [saveOverCapacityNights, setSaveOverCapacityNights] = useState<
    { date: string; availableBeds: number }[] | null
  >(null);
  // Owner decision (#1668 review): every override save asks the admin whether
  // the member should receive the change-notification email.
  const [notifyDialogOpen, setNotifyDialogOpen] = useState(false);
  const originalNights = useMemo(
    () => eachNightKey(booking.checkIn, booking.checkOut).length,
    [booking.checkIn, booking.checkOut],
  );
  const shiftMode = overrideEnabled && overridePricingMode === "shift";

  // Quote state. Declared before the payload builder because the builder reads
  // the current quote (through `desiredElectionCents`); the debounced fetch that
  // writes it is armed further down, once the payload exists.
  const quoteState = useModificationQuoteState();
  const { quote, quoteLoading, quoteError } = quoteState;
  // Other Lodges epic: the reciprocal other-club rate election. Offered only when
  // the server shipped the partner-lodge registry, which it does for admins.
  const otherLodgeRate = useOtherLodgeRate(booking);
  /**
   * The per-person fees the pending edit would write, keyed by guest id.
   *
   * Straight off the quote — never recomputed here — so the fee shown beside a
   * name is the one the save will charge, for the same reason the totals are
   * read off the quote rather than added up on the client. Empty while no quote
   * has landed, and on an in-progress edit, where the guest rows keep showing
   * their stored fees.
   */
  const quotedGuestPriceCents = useMemo(
    () =>
      new Map(
        (quote?.guestPrices ?? []).map((entry) => [
          entry.guestId,
          entry.priceCents,
        ]),
      ),
    [quote],
  );
  const [settlementMethod, setSettlementMethod] = useState<"card" | "credit" | null>(null);
  /**
   * #2562 — the server-confirmed offer to ask a Booking Officer, or null.
   *
   * Set ONLY from a refusal the SERVER classified as reviewable, through the one
   * shared rule in `readExceptionOffer`, and set from BOTH refusal points on this
   * path: the quote (modify-quote answers 409 PAID_UP_ADULT_MEMBER_REQUIRED instead
   * of a quote) and the save (the modify paths hard-block a minimum-stay breach with
   * a 400 carrying the frozen review). A hard failure — a full lodge, invalid dates,
   * a consent or authority refusal — can never open it.
   *
   * STORED WITH THE PROPOSAL IT BELONGS TO (#2562 re-review). The signature is the
   * refused proposal's own identity, compared during render below, so an offer
   * cannot outlive the dates and party it was refused for. See
   * `exceptionProposalSignature`.
   */
  const [exceptionOfferState, setExceptionOfferState] = useState<{
    offer: ExceptionOffer;
    proposalSignature: string;
  } | null>(null);

  // #2337: the placeholder→member links this edit will apply, keyed by the
  // existing guest row id. `linkFinderGuestId` is the row currently choosing a
  // member through the reused member finder.
  const [linkedGuestMembers, setLinkedGuestMembers] = useState<
    Record<string, MemberGuestCandidate>
  >({});
  const [linkFinderGuestId, setLinkFinderGuestId] = useState<string | null>(null);
  // The link control is fenced to exactly the audience + booking class the save
  // path honours, and requires the member finder (the reused member search).
  // #2534: it is also hidden on an in-progress (mid-stay) edit, because the save
  // path REFUSES a placeholder→member link mid-stay (the in-progress pricing
  // path re-rates the original rows, not the link-modified ones, so an in-place
  // re-rate would silently no-op — see the modify-quote in-progress guard). The
  // officer is pointed to remove-and-re-add, which settles correctly mid-stay,
  // rather than being offered a control that only ever returns a quote-time
  // refusal. `booking.editPolicy.mode === "in-progress"` is the same signal
  // `isInProgressEdit` derives from below (declared after this line); using it
  // directly keeps the fence self-contained here.
  const memberLinkEnabled =
    Boolean(booking.memberWholeLodge) &&
    booking.viewerRole === "ADMIN" &&
    Boolean(booking.memberGuest?.enabled) &&
    !overrideEnabled &&
    booking.editPolicy.mode !== "in-progress";

  // Add guest form
  const [showAddForm, setShowAddForm] = useState(false);
  const [addFirstName, setAddFirstName] = useState("");
  const [addLastName, setAddLastName] = useState("");
  const [addAgeTier, setAddAgeTier] = useState<AgeTier>("ADULT");

  // Save state
  const [saving, setSaving] = useState(false);
  const saveInFlightRef = useRef(false);
  const [saveError, setSaveError] = useState("");
  // #2390: the coverage the SAVE came back with, when it differs from what the
  // preview showed. The preview reads the promotion's counters unlocked and the
  // save re-reads them under the row lock, so another booking can take the last
  // slot in between — and then the price the member gets is not the price the
  // panel explained. Holding the panel open with the server's own sentence
  // keeps the explanation at the moment of the edit, which is the whole point
  // of the owner decision; without it the member first learns from the email.
  const [savedPromoCoverage, setSavedPromoCoverage] = useState<string | null>(
    null,
  );
  const [requestReason, setRequestReason] = useState("");
  const [requestSubmitting, setRequestSubmitting] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [requestSuccess, setRequestSuccess] = useState("");

  const today = booking.editPolicy.today;
  const minEditableDate = booking.editPolicy.editableFrom ?? today;
  // Issue #1668: an active override lifts the check-in lock and the in-progress
  // clamps entirely (the edit is date-only), and hides the promo controls.
  const checkInLocked = overrideEnabled
    ? false
    : !booking.editPolicy.checkInEditable;
  const isInProgressEdit =
    !overrideEnabled && booking.editPolicy.mode === "in-progress";
  const promoLocked = isInProgressEdit || overrideEnabled;

  function handleCheckInChange(value: string) {
    setCheckIn(value);
    // Shift mode keeps the stay length fixed: deriving the other bound so the
    // preview and apply both see the same night count (parity is required).
    if (shiftMode && value) {
      setCheckOut(shiftDateKey(value, originalNights));
    }
  }

  function handleCheckOutChange(value: string) {
    setCheckOut(value);
    if (shiftMode && value) {
      setCheckIn(shiftDateKey(value, -originalNights));
    }
  }

  // Check if anything has changed
  const remainingGuests = useMemo(
    () => booking.guests.filter((g) => !removedGuestIds.has(g.id)),
    [booking.guests, removedGuestIds],
  );
  const canEditPerGuestDates =
    !isInProgressEdit && !overrideEnabled && totalGuestCountCandidate() > 1;
  function totalGuestCountCandidate() {
    return remainingGuests.length + addedGuests.length;
  }

  const {
    perGuestDatesEnabled,
    setPerGuestDatesEnabled,
    multiDateRangesEnabled,
    setMultiDateRangesEnabled,
  } = useGuestDateModes({
    guests: booking.guests,
    bookingCheckIn: booking.checkIn,
    bookingCheckOut: booking.checkOut,
    canEditPerGuestDates,
  });

  // State only. Its reset effect is armed further down, at the position that
  // effect has always occupied — see `usePromoSelectionState`'s note.
  const {
    promoAction,
    setPromoAction,
    appliedNewPromo,
    setAppliedNewPromo,
    prefillPromoCode,
    setPrefillPromoCode,
    retirePromoSelection,
  } = usePromoSelectionState();

  const getExistingGuestRange = useCallback((guest: Guest) => {
    return (
      existingGuestRanges[guest.id] ?? {
        stayStart: guest.stayStart ?? booking.checkIn,
        stayEnd: guest.stayEnd ?? booking.checkOut,
      }
    );
  }, [booking.checkIn, booking.checkOut, existingGuestRanges]);

  function updateExistingGuestRange(
    guestId: string,
    field: "stayStart" | "stayEnd",
    value: string
  ) {
    setExistingGuestRanges((prev) => ({
      ...prev,
      [guestId]: {
        stayStart: prev[guestId]?.stayStart ?? booking.checkIn,
        stayEnd: prev[guestId]?.stayEnd ?? booking.checkOut,
        [field]: value,
      },
    }));
  }

  function getGuestNameEdit(guest: Guest) {
    return (
      guestNameEdits[guest.id] ?? {
        firstName: guest.firstName,
        lastName: guest.lastName,
      }
    );
  }

  function updateGuestName(
    guestId: string,
    field: "firstName" | "lastName",
    value: string
  ) {
    setGuestNameEdits((prev) => ({
      ...prev,
      [guestId]: {
        firstName:
          prev[guestId]?.firstName ??
          booking.guests.find((guest) => guest.id === guestId)?.firstName ??
          "",
        lastName:
          prev[guestId]?.lastName ??
          booking.guests.find((guest) => guest.id === guestId)?.lastName ??
          "",
        [field]: value,
      },
    }));
  }

  function updateAddedGuestRange(
    key: string,
    field: "stayStart" | "stayEnd",
    value: string
  ) {
    setAddedGuests((prev) =>
      prev.map((guest) =>
        guest.key === key
          ? {
              ...guest,
              [field]: value,
            }
          : guest
      )
    );
  }

  const guestRangesChanged =
    perGuestDatesEnabled &&
    remainingGuests.some((guest) => {
      const range = getExistingGuestRange(guest);
      return (
        range.stayStart !== (guest.stayStart ?? booking.checkIn) ||
        range.stayEnd !== (guest.stayEnd ?? booking.checkOut)
      );
    });
  const nonMemberGuestNamesEditable =
    booking.canEditNonMemberGuestNames || booking.canFixNonMemberGuestNameTypos;
  const guestNameUpdates = useMemo(
    () =>
      nonMemberGuestNamesEditable
        ? booking.guests
            .filter((guest) => !guest.isMember && !removedGuestIds.has(guest.id))
            .map((guest) => {
              const edit = guestNameEdits[guest.id] ?? {
                firstName: guest.firstName,
                lastName: guest.lastName,
              };
              return {
                guestId: guest.id,
                firstName: edit.firstName.trim(),
                lastName: edit.lastName.trim(),
                changed:
                  edit.firstName.trim() !== guest.firstName ||
                  edit.lastName.trim() !== guest.lastName,
              };
            })
            .filter((update) => update.changed)
            .map((update) => ({
              guestId: update.guestId,
              firstName: update.firstName,
              lastName: update.lastName,
            }))
        : [],
    [
      nonMemberGuestNamesEditable,
      booking.guests,
      guestNameEdits,
      removedGuestIds,
    ]
  );
  const guestNamesChanged = guestNameUpdates.length > 0;
  // A night toggle in the grid (issue #713) is a change even when it leaves the
  // guest's overall envelope unchanged (e.g. switching off a middle night).
  const guestNightsChanged =
    multiDateRangesEnabled &&
    !isInProgressEdit &&
    remainingGuests.some((guest) => {
      const original =
        guest.nights && guest.nights.length > 0
          ? [...guest.nights].sort()
          : eachNightKey(
              guest.stayStart ?? booking.checkIn,
              guest.stayEnd ?? booking.checkOut
            );
      const current = existingGuestNights[guest.id] ?? original;
      return current.join(",") !== original.join(",");
    });
  // #2266: account-credit derivations. When the member TOUCHES the control,
  // the checkbox carries the create-flow semantics — "put my credit towards
  // this booking, up to its price" — so the newly elected amount is
  // min(balance, what is still uncovered). An UNTOUCHED stored election is
  // different (MED-3): it is the member's saved choice, stored RAW with the
  // clamp living at the pay-time consumer (#2265/#2319), so the panel may
  // follow only the booking-local PRICE (a reprice this very edit causes) and
  // NEVER the live balance — otherwise an unrelated guest-name fix while the
  // balance happened to be low would silently rewrite (or clear) the stored
  // value, contradicting the card's own "it will only apply if credit returns
  // before you pay" copy. The election is STORED on the booking (#2265) and
  // consumed at payment; nothing moves here.
  const quoteFinalPriceCents =
    quote?.newFinalPriceCents ?? booking.finalPriceCents;
  const availableCreditCents =
    quote?.availableCreditCents ?? credit?.availableCents ?? 0;
  const ledgerAppliedCreditCents = credit?.appliedCents ?? 0;
  const uncoveredPriceCents = Math.max(
    0,
    quoteFinalPriceCents - ledgerAppliedCreditCents,
  );
  const desiredElectionCents = useCredit
    ? creditTouched
      ? Math.min(availableCreditCents, uncoveredPriceCents)
      : Math.min(storedElectionCents, uncoveredPriceCents)
    : 0;
  // Send the election when the member changed it, or when a stored election
  // must follow a reprice (untouched but the price cap moved) — never invent
  // one, and never rewrite a stored value for a balance change.
  const includeCreditInPayload =
    Boolean(credit) &&
    !overrideEnabled &&
    desiredElectionCents !== storedElectionCents &&
    (creditTouched || storedElectionCents > 0);
  const creditChanged =
    Boolean(credit) &&
    !overrideEnabled &&
    creditTouched &&
    desiredElectionCents !== storedElectionCents;
  const creditCardVisible =
    Boolean(credit) &&
    !overrideEnabled &&
    (availableCreditCents > 0 ||
      storedElectionCents > 0 ||
      ledgerAppliedCreditCents > 0);

  const hasChanges =
    checkIn !== booking.checkIn ||
    checkOut !== booking.checkOut ||
    removedGuestIds.size > 0 ||
    addedGuests.length > 0 ||
    guestRangesChanged ||
    guestNightsChanged ||
    guestNamesChanged ||
    promoAction.type !== "keep" ||
    otherLodgeRate.changed ||
    creditChanged;

  const buildModificationPayload = useCallback(() => {
    // Issue #1668: an admin override is strictly date-only. Send only the dates,
    // the override flags, and the capacity confirm — never guest/promo inputs,
    // which the route/service reject anyway.
    if (overrideEnabled && overridePricingMode) {
      const overrideBody: Record<string, unknown> = {
        adminOverride: true,
        pricingMode: overridePricingMode,
      };
      if (checkIn !== booking.checkIn) overrideBody.checkIn = checkIn;
      if (checkOut !== booking.checkOut) overrideBody.checkOut = checkOut;
      if (confirmOverCapacity) overrideBody.confirmOverCapacity = true;
      return overrideBody;
    }

    const body: Record<string, unknown> = {};
    const gridMode = multiDateRangesEnabled && !isInProgressEdit;
    const rangeMode = perGuestDatesEnabled && !isInProgressEdit && !gridMode;
    let effectiveCheckIn = checkIn;
    let effectiveCheckOut = checkOut;
    let rangeAwareAddedGuests: Array<{
      firstName: string;
      lastName: string;
      ageTier: AgeTier;
      isMember: boolean;
      memberId?: string;
      stayStart?: string;
      stayEnd?: string;
      nights?: string[];
    }> = addedGuests.map((g) => ({
      firstName: g.firstName,
      lastName: g.lastName,
      ageTier: g.ageTier,
      isMember: g.isMember,
      memberId: g.memberId,
    }));

    if (gridMode) {
      // Multi date range mode (issue #713): send each guest's explicit night
      // set; the server reprices, re-allocates and recomputes the envelope.
      const existingRanges = remainingGuests.map((guest) => ({
        guestId: guest.id,
        nights:
          existingGuestNights[guest.id] ??
          eachNightKey(
            guest.stayStart ?? booking.checkIn,
            guest.stayEnd ?? booking.checkOut
          ),
      }));
      rangeAwareAddedGuests = addedGuests.map((g) => ({
        firstName: g.firstName,
        lastName: g.lastName,
        ageTier: g.ageTier,
        isMember: g.isMember,
        memberId: g.memberId,
        nights: g.nights ?? eachNightKey(checkIn, checkOut),
      }));
      const allNights = [
        ...existingRanges.flatMap((range) => range.nights),
        ...rangeAwareAddedGuests.flatMap((guest) => guest.nights ?? []),
      ].filter(Boolean);
      if (allNights.length > 0) {
        effectiveCheckIn = allNights.reduce((a, b) => (b < a ? b : a), allNights[0]);
        const lastNight = allNights.reduce((a, b) => (b > a ? b : a), allNights[0]);
        effectiveCheckOut = shiftDateKey(lastNight, 1);
      }
      body.guestStayRanges = existingRanges;
    } else if (rangeMode) {
      const existingRanges = remainingGuests.map((guest) => ({
        guestId: guest.id,
        ...getExistingGuestRange(guest),
      }));
      rangeAwareAddedGuests = addedGuests.map((g) => ({
        firstName: g.firstName,
        lastName: g.lastName,
        ageTier: g.ageTier,
        isMember: g.isMember,
        memberId: g.memberId,
        stayStart: g.stayStart ?? checkIn,
        stayEnd: g.stayEnd ?? checkOut,
      }));
      const rangeValues = [
        ...existingRanges.map((range) => ({
          stayStart: range.stayStart,
          stayEnd: range.stayEnd,
        })),
        ...rangeAwareAddedGuests.map((guest) => ({
          stayStart: guest.stayStart ?? checkIn,
          stayEnd: guest.stayEnd ?? checkOut,
        })),
      ].filter((range) => range.stayStart && range.stayEnd);

      if (rangeValues.length > 0) {
        const firstRange = rangeValues[0];
        effectiveCheckIn = rangeValues.reduce(
          (earliest, range) => (range.stayStart < earliest ? range.stayStart : earliest),
          firstRange.stayStart
        );
        effectiveCheckOut = rangeValues.reduce(
          (latest, range) => (range.stayEnd > latest ? range.stayEnd : latest),
          firstRange.stayEnd
        );
      }

      body.guestStayRanges = existingRanges;
    }

    if (effectiveCheckIn !== booking.checkIn) body.checkIn = effectiveCheckIn;
    if (effectiveCheckOut !== booking.checkOut) body.checkOut = effectiveCheckOut;
    if (addedGuests.length > 0) {
      body.addGuests = rangeAwareAddedGuests;
      // #1746: partner-sharer flags for admin-added partner guests still in
      // the proposal — capacity then runs through the reserved double slots.
      const partnerSharedGuests = addedGuests
        .filter((g) => g.memberId && g.partnerSharedWithMemberId)
        .map((g) => ({
          memberId: g.memberId as string,
          partnerMemberId: g.partnerSharedWithMemberId as string,
        }));
      if (partnerSharedGuests.length > 0) {
        body.partnerSharedGuests = partnerSharedGuests;
      }
    }
    if (removedGuestIds.size > 0) {
      body.removeGuestIds = Array.from(removedGuestIds);
    }
    if (guestNameUpdates.length > 0) {
      body.guestUpdates = guestNameUpdates;
    }
    // Other Lodges epic: the other-club rate election, sent only when this edit
    // actually proposes a change to it — an unchanged election must not travel,
    // or every ordinary edit would re-assert it and re-reprice those guests.
    Object.assign(body, otherLodgeRate.payloadFields());
    // #2337: the placeholder→member links, keyed to existing guest rows.
    const links = Object.entries(linkedGuestMembers).map(
      ([guestId, candidate]) => ({ guestId, memberId: candidate.memberId }),
    );
    if (links.length > 0) {
      body.linkGuestToMember = links;
    }
    if (promoAction.type === "remove") {
      body.removePromoCode = true;
    } else if (promoAction.type === "new") {
      body.promoCode = promoAction.code;
      // #2266 (MED-4): beneficiary selection for guest-targeted codes, carried
      // from the shared PromoCodeInput through quote and apply alike. The
      // input's indexes are positional over [remaining guests..., added
      // guests...]; convert EXISTING guests to their bookingGuestId so the
      // server binds people, not positions — a concurrent edit by another
      // session then refuses loudly instead of redeeming the discount for the
      // wrong guest. Only TO-BE-ADDED guests (no id yet) stay positional,
      // relative to this request's addGuests array.
      if (promoAction.guestIndexes?.length) {
        const promoGuestIds: string[] = [];
        const promoAddedGuestIndexes: number[] = [];
        for (const index of promoAction.guestIndexes) {
          if (index < remainingGuests.length) {
            const guest = remainingGuests[index];
            if (guest) promoGuestIds.push(guest.id);
          } else {
            promoAddedGuestIndexes.push(index - remainingGuests.length);
          }
        }
        if (promoGuestIds.length) body.promoGuestIds = promoGuestIds;
        if (promoAddedGuestIndexes.length) {
          body.promoAddedGuestIndexes = promoAddedGuestIndexes;
        }
      }
    }

    // #2266: the credit election (#2265) — stored on the booking, applied when
    // the member confirms. 0 clears a saved election.
    if (includeCreditInPayload) {
      body.applyCreditCents = desiredElectionCents;
    }

    return body;
  }, [
    addedGuests,
    booking.checkIn,
    booking.checkOut,
    checkIn,
    checkOut,
    getExistingGuestRange,
    guestNameUpdates,
    linkedGuestMembers,
    otherLodgeRate,
    isInProgressEdit,
    perGuestDatesEnabled,
    multiDateRangesEnabled,
    existingGuestNights,
    promoAction,
    remainingGuests,
    removedGuestIds,
    overrideEnabled,
    overridePricingMode,
    confirmOverCapacity,
    includeCreditInPayload,
    desiredElectionCents,
  ]);

  // Under an override the pricing-mode radio must be chosen before the quote
  // fires — otherwise a member-shaped quote would run and (for a fully-past
  // booking) error, confusing the admin.
  const overrideQuoteReady = !overrideEnabled || Boolean(overridePricingMode);
  const modificationPayloadJson =
    hasChanges && overrideQuoteReady
      ? JSON.stringify(buildModificationPayload())
      : null;
  /**
   * What an exception request would DROP from the pending edit, and whether any of
   * it moved the price (#2562 review).
   *
   * Computed from the SAME builder the quote and the request itself use, once per
   * render, so the card's disclosure list, its figure and the payload that is
   * actually posted cannot disagree. `omitsPricedChange` is what suppresses the
   * quote's `netChargeCents` — that number prices the whole payload, promo and
   * credit included, and the frozen proposal carries neither.
   */
  const exceptionOmissions = exceptionRequestPayloadFromModification(
    buildModificationPayload(),
  );
  /**
   * The offer, but ONLY while it still describes the proposal on screen.
   *
   * A mismatch means the member changed the dates, the party or a guest's nights
   * after the refusal, so the offer describes something they are no longer
   * proposing — and the figure beside it was priced on those old nights. Answering
   * null retires both in the same render the change lands in: no effect, no
   * cleared-too-late window, and no dependence on the debounced quote resolving
   * (which is what left the stale card up).
   */
  const exceptionOffer =
    exceptionOfferState &&
    // `exceptionProposalSignature` applied to the payload the omissions above were
    // derived from, so the render builds the modification payload once.
    exceptionOfferState.proposalSignature ===
      JSON.stringify(exceptionOmissions.payload)
      ? exceptionOfferState.offer
      : null;

  useDebouncedModificationQuote({
    bookingId: booking.id,
    modificationPayloadJson,
    setQuote: quoteState.setQuote,
    setQuoteLoading: quoteState.setQuoteLoading,
    setQuoteError: quoteState.setQuoteError,
    setMemberGuestAddError,
    setExceptionOfferState,
    setSaveOverCapacityNights,
    setSettlementMethod,
  });

  const {
    memberGuestFinderOpen,
    setMemberGuestFinderOpen,
    lastMemberGuestAttempt,
    setLastMemberGuestAttempt,
    memberGuestTriggerRef,
    closeMemberGuestFinder,
  } = useMemberGuestFinder(memberGuestAddError);

  usePromoBeneficiaryReset({
    promoAction,
    guests: booking.guests,
    removedGuestIds,
    addedGuests,
    retirePromoSelection,
  });

  function handleRemoveGuest(guestId: string) {
    setRemovedGuestIds((prev) => new Set([...prev, guestId]));
  }

  function handleUndoRemoveGuest(guestId: string) {
    setRemovedGuestIds((prev) => {
      const next = new Set(prev);
      next.delete(guestId);
      return next;
    });
  }

  // #2337: record that a placeholder row is now linked to a member. Clears the
  // settlement choice and the promo (a re-rate changes the total), exactly as
  // adding a member guest does — the quote is refetched from the serialised
  // payload, and neither is recomputed by that refetch.
  function handleLinkGuestToMember(guestId: string, candidate: MemberGuestCandidate) {
    setAppliedNewPromo(null);
    setPromoAction({ type: "keep" });
    setSettlementMethod(null);
    setLinkedGuestMembers((prev) => ({ ...prev, [guestId]: candidate }));
    setLinkFinderGuestId(null);
  }

  function handleUnlinkGuest(guestId: string) {
    setSettlementMethod(null);
    setLinkedGuestMembers((prev) => {
      const next = { ...prev };
      delete next[guestId];
      return next;
    });
  }

  function handleAddGuest() {
    if (!addFirstName.trim() || !addLastName.trim()) return;
    setAddedGuests((prev) => [
      ...prev,
      {
        key: crypto.randomUUID(),
        firstName: addFirstName.trim(),
        lastName: addLastName.trim(),
        ageTier: addAgeTier,
        isMember: false,
        ...(perGuestDatesEnabled && !isInProgressEdit
          ? { stayStart: checkIn, stayEnd: checkOut }
          : {}),
      },
    ]);
    setAddFirstName("");
    setAddLastName("");
    setShowAddForm(false);
  }

  function handleAddFamilyMember(familyMember: FamilyMember) {
    const alreadyAdded = booking.guests.some((guest) => guest.memberId === familyMember.id)
      || addedGuests.some((guest) => guest.memberId === familyMember.id);
    if (alreadyAdded) {
      return;
    }

    setAddedGuests((prev) => [
      ...prev,
      {
        key: crypto.randomUUID(),
        firstName: familyMember.firstName,
        lastName: familyMember.lastName,
        ageTier: familyMember.ageTier,
        isMember: true,
        memberId: familyMember.id,
        ...(perGuestDatesEnabled && !isInProgressEdit
          ? { stayStart: checkIn, stayEnd: checkOut }
          : {}),
      },
    ]);
  }

  function handleAddPartnerCandidate(candidate: PartnerSharingCandidate) {
    const alreadyAdded = booking.guests.some((guest) => guest.memberId === candidate.id)
      || addedGuests.some((guest) => guest.memberId === candidate.id);
    if (alreadyAdded) {
      return;
    }

    setAddedGuests((prev) => [
      ...prev,
      {
        key: crypto.randomUUID(),
        firstName: candidate.firstName,
        lastName: candidate.lastName,
        ageTier: "ADULT" as AgeTier,
        isMember: true,
        memberId: candidate.id,
        partnerSharedWithMemberId: candidate.partnerOfMemberId,
        ...(perGuestDatesEnabled && !isInProgressEdit
          ? { stayStart: checkIn, stayEnd: checkOut }
          : {}),
      },
    ]);
  }

  /**
   * Add a member the booker (or an officer) found through MG3's finder.
   *
   * THE INVALIDATION LIST IS THE FAMILY QUICK-ADD'S, and it has to be: a member
   * guest changes the party in exactly the same ways a family member does — it
   * prices at member rates, counts toward the group discount, and can collide on
   * person-nights — so it must reset exactly the same derived state. The panel's
   * quote is refetched from the serialised payload, so adding the guest is what
   * invalidates it; the promo and the settlement choice are cleared explicitly
   * because neither is recomputed by that refetch.
   *
   * The consent PREDICTION is computed here rather than on the server for the
   * same reason the create wizard computes it: nothing has been written, so
   * there is no row to read. It is undefined when the target is in the booking
   * owner's own family group — a parent CAN type their child's household address
   * into the finder, and a family-scope add is consent-free under D-6, so
   * promising "waiting for Mia to approve" over one would describe an email that
   * is never sent and a hold that does not exist.
   */
  function handleAddMemberGuest(candidate: MemberGuestCandidate) {
    const alreadyAdded =
      booking.guests.some((guest) => guest.memberId === candidate.memberId) ||
      addedGuests.some((guest) => guest.memberId === candidate.memberId);
    if (alreadyAdded) return;

    const memberGuest = booking.memberGuest;
    // THE SHARED PREDICATE, not a second copy of it (MG4 #2309). The panel's
    // first cut inlined the rule here and dropped the admin branch, so an
    // officer on an ask-first club read "Waiting for consent — the bed is held
    // until they answer" beside a card that said the member would be added
    // immediately. Undefined for a family-scope add and for an unknown family
    // list — see `predictMemberGuestConsent` for both. The list is the booking
    // OWNER's on both paths: a member fetches their own family, an officer
    // fetches the booking's `eligible-family`, which is the owner's.
    const consentPreview = memberGuest
      ? predictMemberGuestConsent({
          candidateMemberId: candidate.memberId,
          familyMemberIds: familyMembers.map((member) => member.id),
          familyMembersLoaded,
          approvalRequired: memberGuest.approvalRequired,
          actorKind: booking.viewerRole === "ADMIN" ? "ADMIN" : "MEMBER",
        })
      : undefined;

    setMemberGuestAddError(null);
    setAppliedNewPromo(null);
    setPromoAction({ type: "keep" });
    setSettlementMethod(null);
    setAddedGuests((prev) => [
      ...prev,
      {
        key: crypto.randomUUID(),
        firstName: candidate.firstName,
        lastName: candidate.lastName,
        ageTier: candidate.ageTier,
        isMember: true,
        memberId: candidate.memberId,
        ...(consentPreview
          ? { memberGuestConsentPreview: consentPreview }
          : {}),
        ...(perGuestDatesEnabled && !isInProgressEdit
          ? { stayStart: checkIn, stayEnd: checkOut }
          : {}),
      },
    ]);
  }

  function handleRemoveAddedGuest(key: string) {
    setAddedGuests((prev) => prev.filter((g) => g.key !== key));
  }

  // #2266: the shared PromoCodeInput validated (or cleared) a new code.
  function handleNewPromoApplied(result: PromoResult | null) {
    if (promoLocked) return;
    setAppliedNewPromo(result);
    setPrefillPromoCode(undefined);
    if (result?.code) {
      setPromoAction({
        type: "new",
        code: result.code,
        guestIndexes: result.selectedGuestIndexes,
      });
    } else {
      // Cleared: fall back to the stored promo (kept) or no promo at all.
      setPromoAction({ type: "keep" });
    }
  }

  /**
   * An admin override edit is date-only, so turning it ON discards every pending
   * guest, range, night, promo and credit edit — otherwise a stacked edit would
   * be silently dropped by the date-only payload and the cards would show
   * something the save does not send. Ranges and night sets go back to their
   * stored SEEDS (not {}), so a later grid edit still sees each guest's real
   * gaps. The reset spans every concern on the screen, which is why it lives
   * here rather than inside the override card.
   */
  function handleOverrideEnabledChange(enabled: boolean) {
    setOverrideEnabled(enabled);
    if (enabled) {
      setRemovedGuestIds(new Set());
      setAddedGuests([]);
      setGuestNameEdits({});
      setExistingGuestRanges(seedExistingGuestRanges());
      setExistingGuestNights(seedExistingGuestNights());
      setPromoAction({ type: "keep" });
      setAppliedNewPromo(null);
      setPrefillPromoCode(undefined);
      // #2266: credit is not part of a date-only override edit —
      // restore the stored election's state.
      setUseCredit(storedElectionCents > 0);
      setCreditTouched(false);
      setShowAddForm(false);
      // An override edit is date-only, and the other-club rate election is a
      // guest change — discarded here with the rest of them.
      otherLodgeRate.reset();
    } else {
      setOverridePricingMode(null);
      setConfirmOverCapacity(false);
      setSaveOverCapacityNights(null);
    }
  }

  function handleOverridePricingModeChange(mode: "shift" | "recalculate") {
    setOverridePricingMode(mode);
    setConfirmOverCapacity(false);
    setSaveOverCapacityNights(null);
  }

  function handleMultiDateRangesChange(enabled: boolean) {
    setMultiDateRangesEnabled(enabled);
    if (enabled) setPerGuestDatesEnabled(false);
  }

  function handleToggleGuestNight(rowIndex: number, nightKey: string) {
    const toggle = (current: string[]) =>
      current.includes(nightKey)
        ? current.filter((key) => key !== nightKey)
        : [...current, nightKey].sort();
    if (rowIndex < remainingGuests.length) {
      const guest = remainingGuests[rowIndex];
      setExistingGuestNights((prev) => {
        const base = prev[guest.id] ?? eachNightKey(checkIn, checkOut);
        const next = toggle(base);
        if (next.length === 0) return prev;
        return { ...prev, [guest.id]: next };
      });
    } else {
      const addedIndex = rowIndex - remainingGuests.length;
      setAddedGuests((prev) =>
        prev.map((g, i) => {
          if (i !== addedIndex) return g;
          const base = g.nights ?? eachNightKey(checkIn, checkOut);
          const next = toggle(base);
          if (next.length === 0) return g;
          return { ...g, nights: next };
        }),
      );
    }
  }

  // Issue #1696: an admin/booking-officer save goes through the notify dialog
  // first (on EVERY edit, not just overrides); the dialog's two actions call
  // handleSave with the admin's explicit email choice. viewerRole is the same
  // booking-management role the /modify route resolves as actorRole, so the
  // dialog shows exactly when the server will honour the choice. Member
  // self-edits keep the immediate always-notify save.
  const actingAsAdmin = booking.viewerRole === "ADMIN";
  // #2259: read only alongside the admin dialog path below, so a member editing
  // their own booking never renders anything derived from the switch.
  const noEmailsOn = actingAsAdmin && booking.noEmails === true;

  // #2104: does the post-edit guest set (remaining + added) leave minors with no
  // adult? The server (resolveModifyReviewUpdate) only demands a written reason
  // on the FIRST trip, so an already-flagged/reviewed booking never re-prompts.
  const postEditTripsReview = editTripsAdultSupervisionReview([
    ...remainingGuests.map((g) => ({ ageTier: g.ageTier })),
    ...addedGuests.map((g) => ({ ageTier: g.ageTier })),
  ]);
  const bookingAlreadyUnderReview =
    Boolean(booking.requiresAdminReview) && (booking.adminReviewStatus ?? null) !== null;

  const {
    memberReviewJustification,
    setMemberReviewJustification,
    reviewJustificationError,
    setReviewJustificationError,
    serverRequiresJustification,
    setServerRequiresJustification,
    reviewJustificationRef,
    scrollToError,
  } = useReviewJustificationLatch({ remainingGuests, addedGuests });

  // An admin acts through the notify dialog and auto-approves the review, so the
  // field is member-only. serverRequiresJustification covers client/server drift
  // (the reactive REVIEW_JUSTIFICATION_REQUIRED path).
  const showReviewJustification =
    (postEditTripsReview && !actingAsAdmin && !bookingAlreadyUnderReview) ||
    serverRequiresJustification;

  function buildSavePayload(notifyMemberChoice?: boolean) {
    const body = buildModificationPayload();
    if (showReviewJustification) {
      body.memberReviewJustification =
        memberReviewJustification.trim() || undefined;
    }
    if (settlementMethod) body.settlementMethod = settlementMethod;
    if (notifyMemberChoice !== undefined) body.notifyMember = notifyMemberChoice;
    return body;
  }

  const {
    setHostingOverrideState,
    hostingOverrideConfirmed,
    setHostingOverrideConfirmed,
    hostingOverrideReason,
    setHostingOverrideReason,
    activeHostingOverrideState,
  } = useHostingCoverageOverride(buildSavePayload);

  function handleSaveClick() {
    if (activeHostingOverrideState) {
      if (!hostingOverrideConfirmed || hostingOverrideReason.trim().length < 10) {
        setSaveError(
          "Confirm the affected bookings and give a private override reason of at least 10 characters.",
        );
        return;
      }
      void handleSave(
        activeHostingOverrideState.notifyMemberChoice,
        activeHostingOverrideState,
      );
      return;
    }
    if (actingAsAdmin) {
      setNotifyDialogOpen(true);
      return;
    }
    void handleSave();
  }

  /**
   * Send the exception request the current refusal opened the door to (#2562).
   *
   * The delta is the SAME payload the refused quote or save sent, narrowed by
   * `exceptionRequestPayloadFromModification` to the five fields a proposal is
   * made of. Narrowed rather than rebuilt, so the proposal an officer freezes is
   * the change that was actually refused; the fields a proposal cannot carry are
   * named to the member on the card before they submit.
   *
   * Throws an Error carrying the server's own sentence, plus its `code` where it
   * sent one, so the card can name the right next step for the two 409s whose
   * remedy is not "try again".
   */
  async function submitExceptionRequest(input: {
    memberMessage: string;
    supersedeRequestId: string | null;
  }): Promise<ExceptionRequestSubmitResult> {
    const { payload } = exceptionRequestPayloadFromModification(
      buildModificationPayload(),
    );
    const res = await fetch(`/api/bookings/${booking.id}/exception-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...payload,
        memberMessage: input.memberMessage,
        supersedeRequestId: input.supersedeRequestId ?? undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const failure = new Error(
        typeof data?.error === "string" && data.error
          ? data.error
          : "The request could not be sent. Try again.",
      ) as Error & { code?: string };
      if (typeof data?.code === "string") failure.code = data.code;
      throw failure;
    }
    return {
      id: String(data.id),
      proposal: data.proposal,
      capacityHeld: data.capacityHeld === true,
      // The frozen aggregate, for the receipt's capacity sentence: on this path
      // "nothing held" means "needs nothing" only under HOLD.
      capacityMode:
        data.aggregateCapacityMode === "HOLD" ||
        data.aggregateCapacityMode === "NO_HOLD"
          ? data.aggregateCapacityMode
          : null,
    };
  }

  async function handleSave(
    notifyMemberChoice?: boolean,
    overrideState: HostingOverrideState | null = null,
  ) {
    setSaveError("");
    // #2104: block submission with an inline error adjacent to the field (not the
    // bottom saveError slot) when a required justification is missing, and bring
    // the field into view.
    if (showReviewJustification && !memberReviewJustification.trim()) {
      setReviewJustificationError(
        "Please add a reason so an admin can review this booking.",
      );
      scrollToError(reviewJustificationRef);
      return;
    }
    if (quote?.settlementOptions?.requiresSettlementMethod && !settlementMethod) {
      setSaveError("Choose a refund or account credit before saving");
      return;
    }
    if (saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    setSaving(true);
    // A fresh save attempt retires the previous refusal's offer (#2562).
    setExceptionOfferState(null);

    try {
      const body = buildSavePayload(notifyMemberChoice);
      const refusedHostingProposalSignature =
        hostingCoverageMutationSignature(body);
      if (overrideState) {
        body.hostingCoverageOverride = {
          acknowledged: true,
          reason: hostingOverrideReason.trim(),
          strandedStateKey: overrideState.prompt.strandedStateKey,
        };
      }

      const res = await fetch(`/api/bookings/${booking.id}/modify`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) {
        const hostingPrompt = actingAsAdmin
          ? readHostingCoverageOverridePrompt(data)
          : null;
        if (hostingPrompt) {
          setHostingOverrideState({
            prompt: hostingPrompt,
            proposalSignature: refusedHostingProposalSignature,
            notifyMemberChoice,
          });
          setHostingOverrideConfirmed(false);
          setHostingOverrideReason("");
          setSaveError(
            "Review the affected bookings and nights, then explicitly confirm the private hosting override.",
          );
          return;
        }
        // The proposal this save attempt actually sent, for any offer its refusal
        // opens (#2562 re-review). Same rule as the quote path: the offer belongs to
        // the payload the server refused, and the render comparison retires it the
        // moment the member proposes something else.
        const refusedProposalSignature = exceptionProposalSignature(body);
        const recordExceptionOffer = (offer: ExceptionOffer | null) =>
          setExceptionOfferState(
            offer
              ? { offer, proposalSignature: refusedProposalSignature }
              : null,
          );
        // #2104: the server tripped the no-adult review rule but the local
        // predicate missed it (client/server drift). Reveal the justification
        // field, show the message adjacent to it, and bring it into view.
        if (data.code === "REVIEW_JUSTIFICATION_REQUIRED") {
          // The effect keyed on serverRequiresJustification scrolls/focuses the
          // field after it mounts on the next commit.
          setServerRequiresJustification(true);
          setReviewJustificationError(
            data.error ||
              "Please add a reason so an admin can review this booking.",
          );
          return;
        }
        // Belt-and-braces (#1668): a stale quote can miss an over-capacity
        // target the apply then rejects. Re-surface the confirm flow.
        if (data.code === "OVER_CAPACITY_CONFIRM_REQUIRED") {
          setSaveOverCapacityNights(
            Array.isArray(data.nightDetails) ? data.nightDetails : [],
          );
          setConfirmOverCapacity(false);
          setSaveError(
            data.error ??
              "These nights are over lodge capacity. Confirm the override to proceed.",
          );
          return;
        }
        // #2363: the save path now hard-blocks a member whose edited dates
        // break a minimum-stay rule, and the 400 carries the frozen review.
        // Surface the rule itself rather than the bare prose so the member can
        // see which nights and which policy stopped the change — the advisory
        // banner above may be stale, or absent entirely if the quote never ran.
        if (data.code === "MINIMUM_STAY_VIOLATION") {
          const violationMessages: string[] = Array.isArray(data.violations)
            ? (data.violations as Array<{ message?: unknown }>)
                .map((violation) => violation?.message)
                .filter((message): message is string => typeof message === "string")
            : [];
          setSaveError(
            violationMessages.length > 0
              ? `These dates do not meet the minimum-stay rules, so the change was not saved. ${violationMessages.join(" ")}`
              : data.error ||
                  "These dates do not meet the minimum-stay rules, so the change was not saved.",
          );
          // #2562: this refusal is exactly what the workflow exists for, so offer
          // the request — subject, as always, to the shared rule's own gates.
          recordExceptionOffer(readExceptionOffer(data));
          return;
        }
        setSaveError(data.error || "Failed to save changes");
        // Every other refusal goes through the same shared rule, which answers null
        // for all of them: the reviewable codes are an explicit allowlist and no
        // hard-stop code is on it.
        recordExceptionOffer(readExceptionOffer(data));
        return;
      }

      setSaveOverCapacityNights(null);
      setHostingOverrideState(null);
      setHostingOverrideConfirmed(false);
      setHostingOverrideReason("");

      // #2390: same shape as the stale-quote handling above, for the same
      // reason — the preview and the apply can disagree, and the member must
      // hear it here rather than from the invoice. Only when it differs from
      // the sentence they already read before pressing Save; an unchanged
      // notice is not news and should not hold the panel open.
      const savedCoverageMessage =
        typeof data?.promoCoverage?.message === "string"
          ? (data.promoCoverage.message as string)
          : null;
      if (
        savedCoverageMessage &&
        savedCoverageMessage !== (quote?.promoCoverage?.message ?? null)
      ) {
        setSavedPromoCoverage(savedCoverageMessage);
        router.refresh();
        return;
      }

      router.refresh();
      onDone();
    } catch {
      setSaveError("Failed to save changes");
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }

  async function handleSubmitChangeRequest() {
    setRequestError("");
    setRequestSuccess("");
    setRequestSubmitting(true);

    try {
      const body = buildModificationPayload();
      if (!hasChanges) {
        body.requestedEffectiveDate =
          previousDateOnly(booking.editPolicy.editableFrom) ?? today;
      }

      const res = await fetch(`/api/bookings/${booking.id}/change-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...body,
          reason: requestReason.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRequestError(data.error || "Failed to submit request");
        return;
      }

      setRequestReason("");
      setRequestSuccess("Request sent to admins");
    } catch {
      setRequestError("Failed to submit request");
    } finally {
      setRequestSubmitting(false);
    }
  }

  function isLockedChangeError(message: string) {
    return /locked|in-progress|check-in cannot be changed/i.test(message);
  }

  const totalGuestCount = totalGuestCountCandidate();
  const showChangeRequestPath =
    (booking.editPolicy.mode === "in-progress" && !hasChanges) ||
    (hasChanges &&
      (booking.editPolicy.mode === "future" ||
        booking.editPolicy.mode === "in-progress") &&
      (isLockedChangeError(quoteError) || isLockedChangeError(saveError)));
  const settlementRequired = quote?.settlementOptions?.requiresSettlementMethod ?? false;

  // Issue #1668: over-capacity under an admin override is a confirmable warning,
  // not a hard block. The signal can come from the quote (preview) or from a
  // stale-quote apply 409 (saveOverCapacityNights).
  const overCapacityConfirmActive =
    Boolean(quote?.overCapacityConfirmRequired) || Boolean(saveOverCapacityNights);
  const overCapacityNightList = (
    quote?.overCapacityConfirmRequired
      ? quote.nightDetails ?? []
      : saveOverCapacityNights ?? []
  ).filter((night) => night.availableBeds < 0);
  const capacityOk = quote
    ? overCapacityConfirmActive
      ? confirmOverCapacity
      : quote.capacityAvailable
    : false;
  const showQuoteSummary = Boolean(
    quote && (quote.capacityAvailable || (overCapacityConfirmActive && confirmOverCapacity)),
  );

  return (
    <div className="space-y-6">
      {/* Admin override (issue #1668) */}
      {adminOverrideAvailable && (
        <AdminOverrideCard
          overrideEnabled={overrideEnabled}
          overridePricingMode={overridePricingMode}
          onOverrideEnabledChange={handleOverrideEnabledChange}
          onPricingModeChange={handleOverridePricingModeChange}
        />
      )}

      {/* Dates */}
      <EditDatesCard
        checkIn={checkIn}
        checkOut={checkOut}
        bookingCheckIn={booking.checkIn}
        bookingCheckOut={booking.checkOut}
        today={today}
        minEditableDate={minEditableDate}
        overrideEnabled={overrideEnabled}
        checkInLocked={checkInLocked}
        isInProgressEdit={isInProgressEdit}
        shiftMode={shiftMode}
        originalNights={originalNights}
        onCheckInChange={handleCheckInChange}
        onCheckOutChange={handleCheckOutChange}
      />

      {/* Guests */}
      <EditGuestsCard
        booking={booking}
        ageTierOptions={ageTierOptions}
        memberGuestTriggerRef={memberGuestTriggerRef}
        mode={{
          overrideEnabled,
          isInProgressEdit,
          minEditableDate,
          checkIn,
          checkOut,
          nonMemberGuestNamesEditable,
          memberLinkEnabled,
        }}
        party={{
          remainingGuests,
          addedGuests,
          removedGuestIds,
          totalGuestCount,
        }}
        memberGuest={{
          finderOpen: memberGuestFinderOpen,
          addError: memberGuestAddError,
          lastAttempt: lastMemberGuestAttempt,
          onToggleFinder: () => setMemberGuestFinderOpen((open) => !open),
          onAdd: (candidate) => {
            setLastMemberGuestAttempt(candidate);
            handleAddMemberGuest(candidate);
            closeMemberGuestFinder();
          },
          onCancel: closeMemberGuestFinder,
        }}
        otherLodge={{
          available: otherLodgeRate.available,
          lodges: otherLodgeRate.lodges,
          enabled: otherLodgeRate.enabled,
          lodgeId: otherLodgeRate.lodgeId,
          flaggedGuestIds: otherLodgeRate.flaggedGuestIds,
          eligibleGuestIds: otherLodgeRate.eligibleGuestIds,
          guestTicksEnabled: otherLodgeRate.guestTicksEnabled,
          quotedGuestPriceCents,
          onEnabledChange: otherLodgeRate.onEnabledChange,
          onLodgeIdChange: otherLodgeRate.onLodgeIdChange,
          onGuestToggle: otherLodgeRate.onGuestToggle,
        }}
        memberLink={{
          linkFinderGuestId,
          linkedGuestMembers,
          onStartLink: setLinkFinderGuestId,
          onLink: handleLinkGuestToMember,
          onUnlink: handleUnlinkGuest,
          onCancelLink: () => setLinkFinderGuestId(null),
        }}
        quickAdd={{
          familyMembers,
          partnerCandidates,
          onAddFamilyMember: handleAddFamilyMember,
          onAddPartnerCandidate: handleAddPartnerCandidate,
        }}
        dateModes={{
          canEditPerGuestDates,
          perGuestDatesEnabled,
          multiDateRangesEnabled,
          existingGuestNights,
          onPerGuestDatesChange: setPerGuestDatesEnabled,
          onMultiDateRangesChange: handleMultiDateRangesChange,
          onToggleNight: handleToggleGuestNight,
          getExistingGuestRange,
          onUpdateExistingGuestRange: updateExistingGuestRange,
          onUpdateAddedGuestRange: updateAddedGuestRange,
        }}
        guestEdits={{
          getGuestNameEdit,
          onUpdateGuestName: updateGuestName,
          onRemoveGuest: handleRemoveGuest,
          onUndoRemoveGuest: handleUndoRemoveGuest,
          onRemoveAddedGuest: handleRemoveAddedGuest,
        }}
        addForm={{
          open: showAddForm,
          firstName: addFirstName,
          lastName: addLastName,
          ageTier: addAgeTier,
          onOpen: () => setShowAddForm(true),
          onFirstNameChange: setAddFirstName,
          onLastNameChange: setAddLastName,
          onAgeTierChange: setAddAgeTier,
          onAdd: handleAddGuest,
          onCancel: () => setShowAddForm(false),
        }}
      />

      {/* Promo Code */}
      {!promoLocked && (
        <PromoCodeCard
          promo={booking.promo}
          promoAdjustmentCents={booking.promoAdjustmentCents}
          promoAction={promoAction}
          availablePromoCodes={availablePromoCodes}
          appliedNewPromo={appliedNewPromo}
          prefillPromoCode={prefillPromoCode}
          checkIn={checkIn}
          checkOut={checkOut}
          remainingGuests={remainingGuests}
          addedGuests={addedGuests}
          perGuestDatesEnabled={perGuestDatesEnabled}
          isInProgressEdit={isInProgressEdit}
          getExistingGuestRange={getExistingGuestRange}
          quote={quote}
          forMemberId={
            booking.viewerRole === "ADMIN" ? booking.memberId : undefined
          }
          lodgeId={booking.lodgeId}
          onRemovePromo={() => setPromoAction({ type: "remove" })}
          onKeepPromo={() => setPromoAction({ type: "keep" })}
          onPrefillCode={setPrefillPromoCode}
          onPromoApplied={handleNewPromoApplied}
        />
      )}

      {creditCardVisible && (
        <AccountCreditCard
          actingAsAdmin={actingAsAdmin}
          ledgerAppliedCreditCents={ledgerAppliedCreditCents}
          availableCreditCents={availableCreditCents}
          uncoveredPriceCents={uncoveredPriceCents}
          useCredit={useCredit}
          desiredElectionCents={desiredElectionCents}
          creditChanged={creditChanged}
          storedElectionCents={storedElectionCents}
          onUseCreditChange={(checked) => {
            setUseCredit(checked);
            setCreditTouched(true);
          }}
        />
      )}

      {/* Price Summary */}
      {hasChanges && (
        <PriceSummaryCard
          quote={quote}
          quoteLoading={quoteLoading}
          quoteError={quoteError}
          bookingFinalPriceCents={booking.finalPriceCents}
          promo={booking.promo}
          promoAction={promoAction}
          overCapacityConfirmActive={overCapacityConfirmActive}
          overCapacityNightList={overCapacityNightList}
          confirmOverCapacity={confirmOverCapacity}
          showQuoteSummary={showQuoteSummary}
          ledgerAppliedCreditCents={ledgerAppliedCreditCents}
          useCredit={useCredit}
          desiredElectionCents={desiredElectionCents}
          actingAsAdmin={actingAsAdmin}
          settlementMethod={settlementMethod}
          onConfirmOverCapacityChange={setConfirmOverCapacity}
          onSettlementMethodChange={setSettlementMethod}
        />
      )}

      {showChangeRequestPath && (
        <ChangeRequestCard
          reason={requestReason}
          submitting={requestSubmitting}
          error={requestError}
          success={requestSuccess}
          submitDisabled={requestSubmitting || (!hasChanges && !requestReason.trim())}
          onReasonChange={setRequestReason}
          onSubmit={handleSubmitChangeRequest}
        />
      )}

      {/* #2104: required justification when the edit leaves minors with no adult.
          Rendered above the save footer; the inline error sits with the field
          (not the bottom saveError slot) so a member cannot miss it. */}
      {showReviewJustification && (
        <ReviewJustificationField
          value={memberReviewJustification}
          error={reviewJustificationError}
          fieldRef={reviewJustificationRef}
          onChange={setMemberReviewJustification}
          onClearError={() => setReviewJustificationError("")}
        />
      )}

      {/* #2390: the save came back saying the promotion reaches fewer people
          than the preview did — another booking took the last slot between the
          two reads. The change IS saved, so Save is replaced by an
          acknowledgement rather than offered again; the member reads why their
          total differs here, at the edit, instead of on the invoice. */}
      {savedPromoCoverage ? (
        <div className="space-y-3">
          <div
            className="rounded-md bg-warning-3 p-3 text-sm text-warning-11"
            role="status"
            data-testid="saved-promo-coverage-notice"
          >
            <p className="font-medium">Your change is saved</p>
            <p className="mt-1">{savedPromoCoverage}</p>
          </div>
          <div className="flex gap-3">
            <Button onClick={onDone}>Done</Button>
          </div>
        </div>
      ) : (
        <>
          <HostingCoverageOverridePrompt
            prompt={
              actingAsAdmin && activeHostingOverrideState
                ? activeHostingOverrideState.prompt
                : null
            }
            confirmed={hostingOverrideConfirmed}
            reason={hostingOverrideReason}
            disabled={saving}
            idPrefix={`edit-booking-${booking.id}-hosting-override`}
            onConfirmedChange={setHostingOverrideConfirmed}
            onReasonChange={setHostingOverrideReason}
          />
          {/* Action buttons */}
          <div className="flex gap-3">
            <Button variant="outline" onClick={onDone}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveClick}
              disabled={
                !hasChanges ||
                saving ||
                quoteLoading ||
                !quote ||
                !capacityOk ||
                (settlementRequired && !settlementMethod) ||
                (Boolean(activeHostingOverrideState) &&
                  (!hostingOverrideConfirmed ||
                    hostingOverrideReason.trim().length < 10))
              }
            >
              {saving
                ? "Saving..."
                : activeHostingOverrideState
                  ? "Confirm hosting override and save"
                  : "Save Changes"}
            </Button>
          </div>

          {saveError && (
            <div className="rounded-md bg-danger-3 p-3 text-sm text-danger-11">{saveError}</div>
          )}

          {/* #2562 — the exception-request door, drawn ONLY when the server's own
              refusal said every blocking failure is reviewable. It sits under Save
              because at this point saving cannot succeed: the member's next honest
              move is to change the proposal or to ask. */}
          {exceptionOffer ? (
            <RequestOfficerApprovalCard
              source="MODIFICATION"
              offer={exceptionOffer}
              replaceRequestId={replaceExceptionRequestId}
              onSubmit={submitExceptionRequest}
              proposal={{
                lodgeName: null,
                checkIn,
                checkOut,
                envelopeNightCount: countNightsDateOnly(
                  parseDateOnly(checkIn),
                  parseDateOnly(checkOut),
                ),
                base: {
                  checkIn: booking.checkIn,
                  checkOut: booking.checkOut,
                  guestCount: booking.guests.length,
                },
                // The server's own figure when it produced one, and ONLY when the
                // request carries everything that figure was priced on. A refusal
                // answered INSTEAD of a quote leaves this null; so does a quote
                // whose payload included a promo, a credit election or anything
                // else the proposal drops (#2562 review) — `netChargeCents` bakes
                // those in, so it is not the number an approval would produce. In
                // both cases the card falls back to saying how pricing actually
                // works rather than showing a figure nobody will ever charge.
                priceImpact:
                  quote && !exceptionOmissions.omitsPricedChange
                    ? {
                        label:
                          quote.netChargeCents >= 0
                            ? "Extra to pay if this is approved"
                            : "Refund due if this is approved",
                        amountCents: Math.abs(quote.netChargeCents),
                      }
                    : null,
                omittedChanges: exceptionOmissions.omittedChanges,
                guests: [
                  ...remainingGuests.map((guest) => ({
                    firstName: guest.firstName,
                    lastName: guest.lastName,
                    ageTierLabel:
                      ageTierOptions.find((option) => option.tier === guest.ageTier)
                        ?.label ?? guest.ageTier,
                    isMember: guest.isMember,
                    nights: existingGuestNights[guest.id] ?? [],
                    stay:
                      guest.stayStart && guest.stayEnd
                        ? { start: guest.stayStart, end: guest.stayEnd }
                        : null,
                  })),
                  ...addedGuests.map((guest) => ({
                    firstName: guest.firstName,
                    lastName: guest.lastName,
                    ageTierLabel:
                      ageTierOptions.find((option) => option.tier === guest.ageTier)
                        ?.label ?? guest.ageTier,
                    isMember: guest.isMember,
                    nights: guest.nights ?? [],
                    stay:
                      guest.stayStart && guest.stayEnd
                        ? { start: guest.stayStart, end: guest.stayEnd }
                        : null,
                  })),
                ],
              }}
            />
          ) : null}
        </>
      )}

      {/* Owner decision (#1668/#1696): the admin explicitly chooses, per edit,
          whether the member is emailed. Both choices save the booking; the
          choice itself is recorded in the audit log.

          #2259: with the booking's "No emails" switch on there is no choice to
          make — the mailer withholds the change notification either way — so
          the dialog states that and offers only the send-nothing action. */}
      <Dialog
        open={notifyDialogOpen}
        onOpenChange={(open) => !saving && setNotifyDialogOpen(open)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {noEmailsOn
                ? "Save this change?"
                : "Email the member about this change?"}
            </DialogTitle>
            <DialogDescription>
              {noEmailsOn
                ? "The booking will be updated."
                : "The booking will be updated either way. Choose whether the member receives the standard change-notification email — your choice is recorded in the audit log."}
            </DialogDescription>
          </DialogHeader>
          {noEmailsOn && <BookingNoEmailsNotice />}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => {
                setNotifyDialogOpen(false);
                // #2259 H1: with the switch on, send NO choice rather than
                // notifyMember:false. `false` makes the route skip the send, so
                // the mailer's gate never runs and no withheld row is recorded —
                // the banner would then omit the very change just made.
                void handleSave(noEmailsOn ? undefined : false);
              }}
            >
              {noEmailsOn ? "Save changes" : "Save without emailing"}
            </Button>
            {!noEmailsOn && (
              <Button
                disabled={saving}
                onClick={() => {
                  setNotifyDialogOpen(false);
                  void handleSave(true);
                }}
              >
                Save and email member
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
