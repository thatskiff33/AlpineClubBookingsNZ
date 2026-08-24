"use client";

import { useState, useEffect, useLayoutEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { type GuestData } from "@/components/guest-form";
import { useClubIdentity } from "@/components/club-identity-provider";
import { useLodgeOptions } from "@/components/lodge-select";
import { deriveSettledLodgeOptionScope } from "@/lib/lodge-option-scope";
import { BOOKING_LODGE_UNRESOLVED_MEMBER_MESSAGE } from "@/lib/booking-lodge-scope";
import {
  renderClientBookingMessage,
  type BookingMessageClubTokens,
  type BookingMessageKey,
} from "@/lib/booking-message-definitions";
import { type PromoResult } from "@/components/promo-code-input";
import {
  getBookingErrorPaymentTargets,
  type BookingErrorPaymentTarget,
} from "@/lib/booking-error-payment-targets";
import { countClubNights, parseCalendarDate } from "@/lib/club-time";
import { buildBookingMemberNightConflictSummary } from "@/lib/booking-member-night-conflict-messages";
import { shouldShowInviteFamilyGroupMembersLink } from "@/lib/family-booking";
import { hasAccessRole, hasAdminAccess } from "@/lib/access-roles";
import { isPaymentOwedBookingStatus } from "@/lib/booking-status";
import { MEMBER_ONBOARDING_CONFIRMED_EVENT } from "@/lib/member-onboarding-events";
import {
  GUEST_MEMBER_NOT_ALLOWED_CODE,
  MEMBER_GUEST_NOT_ADDABLE_CODE,
} from "@/lib/booking-guests";
import { MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE } from "@/lib/member-guest-refusal";
import type { MemberGuestCandidate } from "@/lib/member-guest-find";
import { predictMemberGuestConsent } from "../_components/member-guest-preview";
import {
  readExceptionOffer,
  type ExceptionOffer,
} from "@/lib/booking-exception-offer";
import type { ExceptionRequestSubmitResult } from "@/components/booking/request-officer-approval-card";
import {
  type AvailablePromoCode,
  type BookingPaymentMethod,
  type BookingWizardStep,
  type CreatedBooking,
  type FamilyMember,
  type GroupPaymentMode,
  type PriceQuote,
  type RoomOption,
  type WorkPartyEvent,
} from "../_components/types";

interface GuestProfileRequiredMember {
  memberId: string;
  name: string;
  canCurrentUserResolve: boolean;
  needsOwnLoginConfirmation: boolean;
  missingFields: string[];
  action:
    | "complete_details"
    | "own_login_required"
    | "pending_admin_approval"
    | "contact_admin";
}

interface BookingMemberNightConflict {
  memberId: string;
  memberName: string;
  conflictingNights: string[];
  // #2250: the conflict card's copy picks its next step from these
  // server-computed, viewer-aware flags rather than guessing in the browser.
  isOwnBooking: boolean;
  canOpenBooking: boolean;
  canSelfRemove: boolean;
  // The server has sent this since #2250 and the shared copy helpers read it to
  // address the viewer as "you"; declaring it keeps this mirror honest.
  isSelfGuest: boolean;
  // #2250: the server sends these only to a viewer it marked `canOpenBooking`,
  // so a member whose family member turns out to be on a stranger's booking
  // never receives that stranger's name, stay dates, or ids. Optional here for
  // the same reason — mirrors `BookingMemberNightConflict` in
  // `@/lib/booking-member-night-conflicts`.
  bookingId?: string;
  bookingStatus?: string;
  bookingOwnerName?: string;
  bookingCheckIn?: string;
  bookingCheckOut?: string;
  guestId?: string;
}

interface AvailabilityNightDetail {
  date: string;
  availableBeds: number;
}

interface SubscriptionStatus {
  status: "PAID" | "UNPAID" | "OVERDUE" | "NOT_INVOICED" | "NOT_REQUIRED" | "UNKNOWN";
  seasonDisplay: string;
  invoiceUrl: string | null;
  invoiceNumber: string | null;
}

type BookingMessageMap = Record<string, string>;

/**
 * What the server says the "+ Add Member Guest" surface should look like
 * (MG3 #2308, `GET /api/members/guest-candidates`).
 *
 * DECORATION ONLY. Both find routes re-read the module flag and the settings
 * singleton for themselves, so a browser that flips `openSearchEnabled` in its
 * own memory still gets a 404 from the route it then calls. This decides what is
 * DRAWN, never what is ALLOWED.
 */
interface MemberGuestConfig {
  enabled: boolean;
  openSearchEnabled: boolean;
  approvalRequired: boolean;
  pendingHoldExpiryDays: number;
}

const MEMBER_GUEST_CONFIG_OFF: MemberGuestConfig = {
  enabled: false,
  openSearchEnabled: false,
  approvalRequired: true,
  pendingHoldExpiryDays: 7,
};

const UNKNOWN_SUBSCRIPTION_STATUS: SubscriptionStatus = {
  status: "UNKNOWN",
  seasonDisplay: "",
  invoiceUrl: null,
  invoiceNumber: null,
};

function clearGuestStayRanges(guestList: GuestData[]): GuestData[] {
  return guestList.map((guest) => {
    const nextGuest = { ...guest };
    delete nextGuest.stayStart;
    delete nextGuest.stayEnd;
    return nextGuest;
  });
}

function clearGuestNights(guestList: GuestData[]): GuestData[] {
  return guestList.map((guest) => {
    const nextGuest = { ...guest };
    delete nextGuest.nights;
    return nextGuest;
  });
}

// Booking wizard state machine (#1209). Extracted verbatim from the /book page
// shell: the same 51 useState, 9 useEffect (identical bodies, deps, and order),
// and handlers. The page renders the _components step views with this hook's
// return. The BookErrorPaymentTarget type is referenced via state below.
export function useBookingWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  /**
   * #2562 — the server-confirmed offer to ask a Booking Officer, or null.
   *
   * Set ONLY from a refusal the SERVER classified as reviewable, through the one
   * shared rule in `readExceptionOffer`. The wizard never decides eligibility for
   * itself, so a hard failure (a full lodge, invalid dates, a consent or authority
   * refusal, a tampered payload) can never draw the action.
   *
   * STORED WITH THE PROPOSAL IT BELONGS TO, and that is the point of the wrapper
   * (#2562 review). An offer describes ONE refused proposal: this lodge, these
   * nights, this party. The member can go Back, extend a one-night stay to two,
   * and return to Review — and the old offer would still have been drawn there,
   * naming the old rule and the old affected nights above a booking they could now
   * make instantly. Clicking it answered 400 "this proposal does not trip any
   * reviewable booking-policy exception", a dead end with no remedy branch; the
   * quieter variant was worse, because a DIFFERENT short stay kept the previous
   * refusal's wording over the new payload. The signature is compared during
   * render rather than cleared by an effect, so there is no frame in which the
   * stale card is on screen at all.
   */
  const [exceptionOfferState, setExceptionOfferState] = useState<{
    offer: ExceptionOffer;
    proposalSignature: string;
  } | null>(null);
  /**
   * The identity of the proposal an offer belongs to: the lodge, the nights and
   * the exact guest payload the create call would send.
   *
   * Built from `buildGuestPayload()` on purpose — the same function the create and
   * the request both use — so "the proposal changed" means what the server would
   * see change, not what a component re-rendered.
   */
  function exceptionProposalSignature(): string {
    return JSON.stringify({
      lodgeId: lodgeId ?? null,
      checkIn,
      checkOut,
      guests: buildGuestPayload(),
    });
  }
  /**
   * Record an offer against the proposal that was live when the server refused it,
   * or clear it. Callers keep the plain `ExceptionOffer | null` contract they had.
   */
  function setExceptionOffer(offer: ExceptionOffer | null) {
    setExceptionOfferState(
      offer ? { offer, proposalSignature: exceptionProposalSignature() } : null,
    );
  }
  /**
   * The open request this visit is here to REPLACE, from
   * `/book?replaceRequest=<id>` — the link the member's request area renders. Read
   * once from the URL and passed through to the create call as
   * `supersedeRequestId`; the service does the guarded claim, so a stale or
   * foreign id simply loses the claim and creates nothing.
   */
  const replaceExceptionRequestId =
    searchParams?.get("replaceRequest")?.trim() || null;
  const { lodgeCapacity } = useClubIdentity();
  const [step, setStep] = useState<BookingWizardStep>("dates");
  // Lodge being booked (multi-lodge phase 8). /api/lodges only returns
  // lodges this member may book; LodgeSelect renders nothing (and reports
  // the sole lodge) while fewer than two come back (ADR-002), so
  // single-lodge clubs see no change.
  const {
    lodges,
    loading: lodgesLoading,
    failed: lodgesFailed,
    forbidden: lodgesForbidden,
    reload: reloadLodges,
  } = useLodgeOptions("member");
  const [lodgeId, setLodgeId] = useState<string | null>(null);
  const lodgeScope = deriveSettledLodgeOptionScope({
    lodges,
    selectedLodgeId: lodgeId,
    loading: lodgesLoading,
    failed: lodgesFailed,
    forbidden: lodgesForbidden,
  });
  const scopedLodgeId = lodgeScope.kind === "lodge" ? lodgeScope.lodgeId : null;
  const activeScopedLodgeIdRef = useRef<string | null>(scopedLodgeId);
  /*
    #2887: ownership follows the COMMIT, never the render. Writing this ref in
    the render body marked a lodge current for a render React then threw away
    (concurrent retry / StrictMode double-render), which both drops a response
    that is still valid for what is on screen and admits one from a scope that
    never committed. A LAYOUT effect keeps the property the render write was
    reaching for — the ref moves in the same synchronous commit that changes the
    recovered scope, so no PASSIVE-effect gap exists in which a late response
    can still regard a removed/failed lodge as current. React 19's server
    renderer makes layout effects a no-op with no warning.
  */
  useLayoutEffect(() => {
    activeScopedLodgeIdRef.current = scopedLodgeId;
  }, [scopedLodgeId]);
  const dateSelectionSequenceRef = useRef(0);
  const dateSelectionAbortRef = useRef<AbortController | null>(null);
  const workPartySequenceRef = useRef(0);
  const workPartyAbortRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      dateSelectionAbortRef.current?.abort();
      workPartyAbortRef.current?.abort();
    },
    [],
  );
  // Set when the booking is created on the card-payment path; drives step 4.
  const [createdBooking, setCreatedBooking] = useState<CreatedBooking | null>(
    null,
  );
  // Lodge nights are carried as NZ date-only `yyyy-MM-dd` strings end-to-end
  // (#2474), never a local-midnight `Date`.
  const [checkIn, setCheckIn] = useState<string | null>(null);
  const [checkOut, setCheckOut] = useState<string | null>(null);
  const [guests, setGuests] = useState<GuestData[]>([]);
  const [notes, setNotes] = useState("");
  const [priceQuote, setPriceQuote] = useState<PriceQuote | null>(null);
  const [priceLoading, setPriceLoading] = useState(false);
  const [error, setError] = useState("");
  /**
   * #2701: the member tried to book and no lodge could be determined. Drives
   * the retry affordance beside the refusal — without it the member is told to
   * "try again in a moment" with nothing to try again WITH, since the lodge
   * selector is not rendered in this state.
   */
  const [lodgeUnresolved, setLodgeUnresolved] = useState(false);
  function retryLodgeOptions() {
    setStep("dates");
    setLodgeId(null);
    setLodgeUnresolved(false);
    setError("");
    reloadLodges();
  }

  function returnToUnresolvedLodge() {
    dateSelectionSequenceRef.current += 1;
    dateSelectionAbortRef.current?.abort();
    setStep("dates");
    setError(BOOKING_LODGE_UNRESOLVED_MEMBER_MESSAGE);
    setLodgeUnresolved(true);
  }
  const [errorPaymentTargets, setErrorPaymentTargets] = useState<
    BookingErrorPaymentTarget[]
  >([]);
  const [subscriptionInvoiceUrl, setSubscriptionInvoiceUrl] = useState<string | null>(null);
  const [subscriptionInvoiceNumber, setSubscriptionInvoiceNumber] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [showWaitlistPrompt, setShowWaitlistPrompt] = useState(false);
  const [waitlistFullNights, setWaitlistFullNights] = useState<string[]>([]);
  const [joiningWaitlist, setJoiningWaitlist] = useState(false);
  // Cross-lodge waitlist opt-in (ADR-004): other eligible lodges the member
  // would also accept. Only offered when a second eligible lodge exists.
  const [waitlistAlternateLodgeIds, setWaitlistAlternateLodgeIds] = useState<string[]>([]);
  const [availableBeds, setAvailableBeds] = useState(lodgeCapacity);
  const [availabilityNightDetails, setAvailabilityNightDetails] = useState<AvailabilityNightDetail[]>([]);
  const [perGuestDatesEnabled, setPerGuestDatesEnabled] = useState(false);
  // Issue #713 — per-guest non-contiguous night grid.
  const [multiDateRangesEnabled, setMultiDateRangesEnabled] = useState(false);
  const [appliedPromo, setAppliedPromo] = useState<PromoResult | null>(null);
  const [expectedArrivalTime, setExpectedArrivalTime] = useState<string | null>(null);
  const [requestedRoomId, setRequestedRoomId] = useState<string | null>(null);
  // "Only book if my guests can come" — opt into whole-booking cancellation
  // instead of the default partial bump for non-member guests.
  const [cancelIfGuestsBumped, setCancelIfGuestsBumped] = useState(false);
  const [roomOptions, setRoomOptions] = useState<RoomOption[]>([]);
  const [roomRequestEnabled, setRoomRequestEnabled] = useState(false);
  const [useCredit, setUseCredit] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<BookingPaymentMethod>("stripe");
  const [internetBankingEnabled, setInternetBankingEnabled] = useState(false);
  // Group trip: capture the intent up front and auto-open the group right
  // after the booking is created, instead of leaving the feature to be
  // discovered on the booking page after payment.
  const [groupBookingsEnabled, setGroupBookingsEnabled] = useState(false);
  const [groupTrip, setGroupTrip] = useState(false);
  const [groupPaymentMode, setGroupPaymentMode] = useState<GroupPaymentMode>(
    "EACH_PAYS_OWN",
  );
  const [internetBankingUnavailableReason, setInternetBankingUnavailableReason] = useState<string | null>(null);
  const [internetBankingHoldSummary, setInternetBankingHoldSummary] = useState<string | null>(null);
  const [bookingMessages, setBookingMessages] = useState<BookingMessageMap>({});
  // #2919 review: what these bodies' merge tokens resolve to. Without them an
  // operator's {{CLUB_LODGE_NAME}} reached the member as literal braces.
  const [bookingMessageTokens, setBookingMessageTokens] =
    useState<BookingMessageClubTokens | null>(null);
  const [familyMembers, setFamilyMembers] = useState<FamilyMember[]>([]);
  // Whether `/api/members/family` has answered at all — see the note in the
  // fetch below and in `predictMemberGuestConsent`.
  const [familyMembersLoaded, setFamilyMembersLoaded] = useState(false);
  const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatus | null>(null);
  const [subscriptionLoading, setSubscriptionLoading] = useState(true);
  const [availablePromoCodes, setAvailablePromoCodes] = useState<AvailablePromoCode[]>([]);
  const [prefillPromoCode, setPrefillPromoCode] = useState<string | undefined>();
  // Promo codes module: the available-codes route 404s when the module is off,
  // so hide the code entry rather than show an input that can't validate.
  const [promoCodesEnabled, setPromoCodesEnabled] = useState(true);
  const [activeWorkPartyEvents, setActiveWorkPartyEvents] = useState<WorkPartyEvent[]>([]);
  const [attendingWorkParty, setAttendingWorkParty] = useState(false);
  const [selectedWorkPartyEventId, setSelectedWorkPartyEventId] = useState<string | null>(null);
  const [workPartyError, setWorkPartyError] = useState("");
  const [workPartyClearedNotice, setWorkPartyClearedNotice] = useState<string | null>(null);
  const [guestProfileBlocks, setGuestProfileBlocks] = useState<GuestProfileRequiredMember[]>([]);
  const [memberNightConflicts, setMemberNightConflicts] = useState<BookingMemberNightConflict[]>([]);
  const [removingConflictGuestId, setRemovingConflictGuestId] = useState<string | null>(null);
  // "+ Add Member Guest" (MG3 #2308). Defaults to OFF so the button never
  // flashes into view on a club that does not use the feature before the fetch
  // resolves.
  const [memberGuestConfig, setMemberGuestConfig] =
    useState<MemberGuestConfig>(MEMBER_GUEST_CONFIG_OFF);
  const [memberGuestAddError, setMemberGuestAddError] = useState<string | null>(null);
  const [memberReviewJustification, setMemberReviewJustification] = useState("");
  const requiresAdminReviewLocal = (() => {
    if (guests.length === 0) return false;
    const hasAdult = guests.some((g) => g.ageTier === "ADULT");
    const hasMinor = guests.some(
      (g) => g.ageTier === "YOUTH" || g.ageTier === "CHILD" || g.ageTier === "INFANT",
    );
    return hasMinor && !hasAdult;
  })();

  // Display label for capacity copy: the lodge's name once a second lodge
  // exists, the generic phrase otherwise (ADR-002 presentation rule).
  const selectedLodge = lodges.find((lodge) => lodge.id === lodgeId) ?? null;
  const lodgeLabel =
    lodges.length > 1 && selectedLodge ? selectedLodge.name : "The lodge";

  function handleLodgeChange(nextLodgeId: string | null) {
    if (nextLodgeId === lodgeId) return;
    const hadLodge = lodgeId !== null;
    // Fence pending Lodge A responses immediately, before React commits the
    // Lodge B render and its effect updates the same ref.
    activeScopedLodgeIdRef.current = nextLodgeId;
    dateSelectionSequenceRef.current += 1;
    dateSelectionAbortRef.current?.abort();
    workPartySequenceRef.current += 1;
    workPartyAbortRef.current?.abort();
    setLodgeId(nextLodgeId);
    if (!hadLodge) return;
    // Availability, pricing, policies, promos, and rooms are all per lodge:
    // switching lodges restarts the flow from date selection.
    setStep("dates");
    setCheckIn(null);
    setCheckOut(null);
    setError("");
    setGuestProfileBlocks([]);
    setAppliedPromo(null);
    setPriceQuote(null);
    setPriceLoading(false);
    setUseCredit(false);
    setRequestedRoomId(null);
    setAvailabilityNightDetails([]);
    setShowWaitlistPrompt(false);
    setActiveWorkPartyEvents([]);
    setSelectedWorkPartyEventId(null);
    setAttendingWorkParty(false);
    setWorkPartyError("");
    setWorkPartyClearedNotice(null);
  }

  function getBookingDateStrings() {
    if (!checkIn || !checkOut) {
      return null;
    }

    return {
      checkIn,
      checkOut,
    };
  }

  function withDefaultGuestStayRanges(guestList: GuestData[]): GuestData[] {
    const dateStrings = getBookingDateStrings();
    if (!dateStrings) {
      return guestList;
    }

    return guestList.map((guest) => ({
      ...guest,
      stayStart: guest.stayStart || dateStrings.checkIn,
      stayEnd: guest.stayEnd || dateStrings.checkOut,
    }));
  }

  function buildGuestPayload(): GuestData[] {
    if (multiDateRangesEnabled) {
      // Send the explicit night set per guest (issue #713); drop the contiguous
      // range so the server prices/holds only the selected nights. A guest with
      // no toggles (nights undefined) stays the whole range.
      return clearGuestStayRanges(guests);
    }
    if (!perGuestDatesEnabled) {
      return clearGuestNights(clearGuestStayRanges(guests));
    }

    return clearGuestNights(withDefaultGuestStayRanges(guests));
  }

  function handlePerGuestDatesEnabledChange(enabled: boolean) {
    setPerGuestDatesEnabled(enabled);
    setAppliedPromo(null);
    setPriceQuote(null);
    setUseCredit(false);
    setMemberNightConflicts([]);
    setGuests((current) =>
      enabled ? withDefaultGuestStayRanges(current) : clearGuestStayRanges(current)
    );
  }

  function handleMultiDateRangesEnabledChange(enabled: boolean) {
    setMultiDateRangesEnabled(enabled);
    setAppliedPromo(null);
    setPriceQuote(null);
    setUseCredit(false);
    setMemberNightConflicts([]);
    if (enabled) {
      // Multiple date ranges supersedes the simple per-guest date inputs.
      setPerGuestDatesEnabled(false);
      setGuests((current) => clearGuestStayRanges(current));
    } else {
      setGuests((current) => clearGuestNights(current));
    }
  }

  function handleGuestsChange(nextGuests: GuestData[]) {
    setGuests(nextGuests);
    setAppliedPromo(null);
    setPriceQuote(null);
    setUseCredit(false);
    setMemberNightConflicts([]);
  }

  function validateGuestStayRanges(guestList: GuestData[]): string | null {
    if (multiDateRangesEnabled || !perGuestDatesEnabled) {
      return null;
    }

    const dateStrings = getBookingDateStrings();
    if (!dateStrings) {
      return "Select booking dates first.";
    }

    for (const [index, guest] of guestList.entries()) {
      const label = `Guest ${index + 1}`;
      if (!guest.stayStart || !guest.stayEnd) {
        return `${label}: select Date In and Date Out.`;
      }
      if (guest.stayEnd <= guest.stayStart) {
        return `${label}: Date Out must be after Date In.`;
      }
      if (guest.stayStart < dateStrings.checkIn || guest.stayEnd > dateStrings.checkOut) {
        return `${label}: guest dates must stay within the booking dates.`;
      }
    }

    return null;
  }

  function getCapacityExceededNights(guestList: GuestData[]): string[] {
    const dateStrings = getBookingDateStrings();
    if (!dateStrings) {
      return [];
    }
    if (availabilityNightDetails.length === 0) {
      return guestList.length > availableBeds ? [dateStrings.checkIn] : [];
    }

    return availabilityNightDetails
      .filter((night) => {
        const activeGuests = guestList.filter((guest) => {
          const stayStart = guest.stayStart ?? dateStrings.checkIn;
          const stayEnd = guest.stayEnd ?? dateStrings.checkOut;
          return stayStart <= night.date && night.date < stayEnd;
        }).length;
        return activeGuests > night.availableBeds;
      })
      .map((night) => night.date);
  }

  function formatCapacityExceededMessage(fullNights: string[]) {
    if (fullNights.length === 1) {
      return `${lodgeLabel} does not have enough beds on ${fullNights[0]}`;
    }

    return `${lodgeLabel} does not have enough beds on ${fullNights.length} nights`;
  }

  useEffect(() => {
    if (guests.length <= 1 && perGuestDatesEnabled) {
      setPerGuestDatesEnabled(false);
      setGuests((current) => clearGuestStayRanges(current));
    }
  }, [guests.length, perGuestDatesEnabled]);

  // Redirect only admin-only accounts (no USER token) to the admin booking
  // page. Dual-hat admins (USER + ADMIN) book themselves and family here
  // under full member rules — the create API applies no admin bypasses to
  // self-bookings (#1442).
  useEffect(() => {
    if (
      session?.user &&
      hasAdminAccess(session.user) &&
      !hasAccessRole(session.user, "USER")
    ) {
      router.replace("/admin/book");
    }
  }, [session, router]);

  const familyLoadSeqRef = useRef(0);
  useEffect(() => {
    const loadFamilyMembers = () => {
      // Monotonic request sequence: a slow mount fetch (self blocked) must not
      // clobber a newer onboarding-confirmed refetch (self bookable) if it
      // resolves out of order — that would revert the list and render the
      // seeded ✓ button alongside the amber blocked warning.
      const seq = (familyLoadSeqRef.current += 1);
      fetch("/api/members/family")
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (seq !== familyLoadSeqRef.current) return;
          // MG3 (#2308): a FAILED load is distinguished from an EMPTY one, and
          // only the success sets `familyMembersLoaded`. The consent prediction
          // below decides "is this person my own family?" from this list, so an
          // empty list that really means "we could not ask" would predict
          // "Waiting for Mia to approve" over the booker's own child. See
          // `predictMemberGuestConsent`.
          if (!data) return;
          setFamilyMembers(data.familyMembers || []);
          setFamilyMembersLoaded(true);
        })
        .catch(() => {});
    };
    loadFamilyMembers();
    // The confirm-details wizard overlays this page on a member's first visit;
    // completing it flips canBeBookedAsMember, so the cached list must refetch
    // or the member's own quick-add button stays disabled until a reload.
    window.addEventListener(MEMBER_ONBOARDING_CONFIRMED_EVENT, loadFamilyMembers);
    return () =>
      window.removeEventListener(MEMBER_ONBOARDING_CONFIRMED_EVENT, loadFamilyMembers);
  }, []);

  // Pre-select the booker by default (#1680). The signed-in member is the
  // `relationship === "self"` entry; seed them as a guest when the family list
  // first arrives so the common case (booking yourself) needs no manual
  // quick-add. It stays opt-out — the guest can still X themselves out.
  //
  // Seeding is a one-shot opportunity, consumed on the first family-data
  // arrival that carries a real decision, so it fires only "while the wizard is
  // fresh":
  //   (a) party non-empty (existing guests / resumed draft) → consume without
  //       seeding; the wizard is not fresh, so self is never injected later —
  //       not even if the user empties the party mid-session.
  //   (b) party empty + self bookable → seed and consume.
  //   (c) party empty + self blocked (canBeBooked === false) → do NOT consume,
  //       so the onboarding-confirmed refetch that flips them bookable (with the
  //       party still empty) seeds them then (spec's explicit exception).
  // Once consumed, the family refetch on MEMBER_ONBOARDING_CONFIRMED_EVENT can
  // never re-add self after an explicit removal.
  //
  // The seed mirrors addFamilyMemberAsGuest's eligibility path and linked-member
  // guest shape inline rather than calling it, so the effect depends only on
  // stable values. Seeding only fires while the party is empty, so there is
  // never a per-guest stay range or a live quote/promo/credit to invalidate;
  // the resets below match that helper for parity and are no-ops here.
  const selfSeededRef = useRef(false);
  useEffect(() => {
    if (selfSeededRef.current) return;
    const self = familyMembers.find((fm) => fm.relationship === "self");
    if (!self) return; // family list has not arrived yet

    // Case (c): a blocked self with an empty party keeps the opportunity open
    // for a later bookable-flip refetch.
    if (self.canBeBooked === false && guests.length === 0) return;

    // Consume the one-shot opportunity now — seeding must never fire later.
    selfSeededRef.current = true;

    // Only a fresh, bookable, within-capacity party gets self injected. Case (a)
    // (a non-empty party) falls through here having spent the opportunity.
    if (guests.length > 0) return;
    if (guests.length >= lodgeCapacity) return;
    setGuests([
      {
        firstName: self.firstName,
        lastName: self.lastName,
        ageTier: self.ageTier,
        isMember: true,
        memberId: self.id,
      },
    ]);
    setAppliedPromo(null);
    setPriceQuote(null);
    setUseCredit(false);
    setMemberNightConflicts([]);
  }, [familyMembers, guests, lodgeCapacity]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (checkIn) {
      params.set("checkIn", checkIn);
    }
    const query = params.toString();
    fetch(`/api/payments/options${query ? `?${query}` : ""}`)
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        const internetBanking = data?.methods?.internetBanking;
        setInternetBankingEnabled(
          Boolean(internetBanking?.enabled)
        );
        setInternetBankingUnavailableReason(
          typeof internetBanking?.unavailableReason === "string"
            ? internetBanking.unavailableReason
            : null,
        );
        setInternetBankingHoldSummary(
          typeof internetBanking?.holdPolicy?.summary === "string"
            ? internetBanking.holdPolicy.summary
            : null,
        );
        setGroupBookingsEnabled(Boolean(data?.groupBookingsEnabled));
      })
      .catch(() => {
        setInternetBankingEnabled(false);
        setInternetBankingUnavailableReason(null);
        setInternetBankingHoldSummary(null);
      });
  }, [checkIn]);

  useEffect(() => {
    fetch("/api/booking-messages")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        setBookingMessages(data?.messages ?? {});
        setBookingMessageTokens(data?.tokens ?? null);
      })
      .catch(() => {
        setBookingMessages({});
        setBookingMessageTokens(null);
      });
  }, []);

  // MG3 (#2308): the member-guest surface's server-computed shape. Failing
  // closed on any error is the right direction — a club whose settings could not
  // be read shows no finder rather than one that 404s when used.
  useEffect(() => {
    fetch("/api/members/guest-candidates")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data?.enabled) {
          setMemberGuestConfig(MEMBER_GUEST_CONFIG_OFF);
          return;
        }
        setMemberGuestConfig({
          enabled: true,
          openSearchEnabled: Boolean(data.openSearchEnabled),
          approvalRequired: data.approvalRequired !== false,
          pendingHoldExpiryDays:
            typeof data.pendingHoldExpiryDays === "number"
              ? data.pendingHoldExpiryDays
              : MEMBER_GUEST_CONFIG_OFF.pendingHoldExpiryDays,
        });
      })
      .catch(() => setMemberGuestConfig(MEMBER_GUEST_CONFIG_OFF));
  }, []);

  // "Preferred room (optional)" must only ever offer rooms from the lodge this
  // wizard is booking. `booking-create.ts:167` refuses any other choice outright
  // ("Requested room belongs to a different lodge"), so offering one can only
  // produce a create the member is not allowed to make — the create-side sibling
  // of the defect #2664 fixed in the requested-room editor.
  //
  // Two things together made a cross-lodge list reachable and, worse, sticky:
  //
  //  - `lodgeId` starts null, and the no-`lodgeId` mode of `/api/bookings/rooms`
  //    lists every ACTIVE ROOM the member's booking restrictions do not exclude
  //    (the `else` branch of the scoping block in `rooms/route.ts` — no line
  //    numbers, they rot). When #2664 was filed, what was NOT in that filter was
  //    the lodge's own `active` flag: an unrestricted member got rooms from every
  //    lodge, archived ones included, so this was never merely "the lodges you
  //    may book". #2727 has since added the `Lodge.active` filter to that branch
  //    and `INV-INT-016` now pins it, so the mode no longer offers an archived
  //    lodge's rooms — but it is still CROSS-LODGE, which is the part that makes
  //    it wrong here. The first request of every mount asked it, before
  //    `LodgeSelect` had normalised a selection.
  //  - The effect had no cancellation guard. Whichever response landed last won,
  //    so a slow cross-lodge reply arriving after the lodge-scoped reply that
  //    superseded it left other lodges' rooms in `roomOptions` for the rest of
  //    the session — nothing refetches until the member switches lodge again.
  //
  // The fix is to stop asking the cross-lodge question from here at all, so a
  // null `lodgeId` never means "any lodge". `LodgeSelect` normalises even a
  // single-lodge club to a concrete id — its effect runs before the early return
  // that makes it render nothing (`lodge-select.tsx:44-54`) — and it lives on the
  // dates step, which is where this wizard opens. And the `cancelled` guard, the
  // same one the subscription effect below already uses, means a superseded reply
  // can no longer overwrite the current lodge's list. A switch between two lodges
  // also sends the member back to the dates step with `requestedRoomId` cleared
  // (`handleLodgeChange`), so the previous lodge's options are never on screen
  // while the replacement is in flight.
  useEffect(() => {
    if (!scopedLodgeId) {
      // Two different states reach here, and the answer is the same for both.
      //
      // Usually it is "not resolved yet" — the mount window before the lodge list
      // lands. But it can also be permanent: `/api/lodges` filters `active: true`,
      // so an outage, or a club whose only Lodge row is inactive, yields an empty
      // list, and `LodgeSelect` then leaves the selection null (`lodge-select.ts
      // :45-46` calls nothing when the sole id and the current value are both
      // null). Every other lodge-dependent read in this wizard passes `lodgeId ??
      // undefined` and lets the server resolve its default lodge — but there is no
      // such mode here, because the no-`lodgeId` mode is cross-lodge rather than
      // default-lodge.
      //
      // So this offers nothing rather than everything, and that is a deliberate,
      // disclosed behaviour change: before this fix the wizard answered the empty
      // state with the cross-lodge list, which happened to be right for a
      // one-lodge club and wrong for every other. A client that cannot know which
      // lodge the server will stamp on the booking must not guess at an optional
      // preference; the picker is simply absent until a lodge is known.
      setRoomRequestEnabled(false);
      setRoomOptions([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/bookings/rooms?lodgeId=${encodeURIComponent(scopedLodgeId)}`)
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (cancelled) return;
        setRoomRequestEnabled(Boolean(data?.enabled));
        setRoomOptions(data?.rooms ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setRoomRequestEnabled(false);
        setRoomOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [scopedLodgeId]);

  // Fetch subscription status for the current season
  useEffect(() => {
    let cancelled = false;

    fetch("/api/member/subscription-status")
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (cancelled) {
          return;
        }
        if (data) {
          setSubscriptionStatus(data);
          setSubscriptionInvoiceUrl(data.invoiceUrl ?? null);
          setSubscriptionInvoiceNumber(data.invoiceNumber ?? null);
        } else {
          setSubscriptionStatus(UNKNOWN_SUBSCRIPTION_STATUS);
          setSubscriptionInvoiceUrl(null);
          setSubscriptionInvoiceNumber(null);
        }
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setSubscriptionStatus(UNKNOWN_SUBSCRIPTION_STATUS);
        setSubscriptionInvoiceUrl(null);
        setSubscriptionInvoiceNumber(null);
      })
      .finally(() => {
        if (!cancelled) {
          setSubscriptionLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  function addFamilyMemberAsGuest(fm: FamilyMember) {
    if (guests.some((g) => g.memberId === fm.id)) return;
    if (guests.length >= lodgeCapacity) return;
    if (fm.canBeBooked === false) return;
    const dateStrings = getBookingDateStrings();
    setAppliedPromo(null);
    setPriceQuote(null);
    setUseCredit(false);
    setMemberNightConflicts([]);
    setGuests([
      ...guests,
      {
        firstName: fm.firstName,
        lastName: fm.lastName,
        ageTier: fm.ageTier,
        isMember: true,
        memberId: fm.id,
        ...(perGuestDatesEnabled && dateStrings
          ? { stayStart: dateStrings.checkIn, stayEnd: dateStrings.checkOut }
          : {}),
      },
    ]);
  }

  /**
   * Add a member the booker found through MG3's finder (#2308).
   *
   * THE INVALIDATION LIST IS COPIED FROM THE FAMILY PATH ABOVE, LIVE, NOT FROM A
   * PLAN'S SNAPSHOT OF IT. `addFamilyMemberAsGuest` resets the promo, the price
   * quote, the credit election and the member-night conflicts, because every one
   * of them is computed for a party that has just changed; a member guest changes
   * the party in exactly the same ways — it prices at member rates and counts
   * toward the group discount — so it must reset exactly the same things. If that
   * list ever grows, both functions have to grow together, which is why they sit
   * next to each other.
   *
   * The three guards are the family path's three guards: already added, at
   * capacity, and — the difference — no `canBeBooked` check, because the finder
   * deliberately never evaluates eligibility. Whether this member CAN be added is
   * the server's answer, given at quote/create time in D-8's neutral form, and
   * asking here would be the client-side eligibility oracle the whole design
   * avoids.
   */
  function addMemberGuest(candidate: MemberGuestCandidate) {
    if (guests.some((g) => g.memberId === candidate.memberId)) return;
    if (guests.length >= lodgeCapacity) return;
    const dateStrings = getBookingDateStrings();
    setMemberGuestAddError(null);
    setAppliedPromo(null);
    setPriceQuote(null);
    setUseCredit(false);
    setMemberNightConflicts([]);
    setGuests([
      ...guests,
      {
        firstName: candidate.firstName,
        lastName: candidate.lastName,
        ageTier: candidate.ageTier,
        isMember: true,
        memberId: candidate.memberId,
        // Display only — a prediction of what confirming will do, never a
        // consent record. Undefined for a family-scope add, which the finder
        // can perfectly well produce (D-9 resolves any active member by email,
        // the booker's own household included) and which needs no consent at
        // all. See `predictMemberGuestConsent`.
        memberGuestConsentPreview: predictMemberGuestConsent({
          candidateMemberId: candidate.memberId,
          familyMemberIds: familyMembers.map((fm) => fm.id),
          familyMembersLoaded,
          approvalRequired: memberGuestConfig.approvalRequired,
          // `/book` is the MEMBER wizard — an officer booking on behalf uses
          // `/admin/book`, which composes `GuestForm` itself and never reaches
          // this hook. Stated rather than defaulted (MG4 #2309).
          actorKind: "MEMBER",
        }),
        ...(perGuestDatesEnabled && dateStrings
          ? { stayStart: dateStrings.checkIn, stayEnd: dateStrings.checkOut }
          : {}),
      },
    ]);
  }

  function handleGuestProfileRequired(data: {
    error?: string;
    members?: GuestProfileRequiredMember[];
  }) {
    setError(
      data.error ||
        "Some member guests need their details completed or confirmed before booking."
    );
    setGuestProfileBlocks(data.members || []);
    setErrorPaymentTargets([]);
    setMemberNightConflicts([]);
  }

  function handleMemberNightConflict(data: {
    error?: string;
    conflicts?: BookingMemberNightConflict[];
  }) {
    // #2250 — the banner carries the SUMMARY only. `data.error` is the
    // self-contained 409 sentence (summary + next step), and the wizard renders
    // a per-conflict card underneath that already states the nights, the
    // booking, the buttons, and this viewer's next step — so using it verbatim
    // printed the same sentence twice on the single-conflict screen.
    const conflicts = data.conflicts ?? [];
    setError(
      conflicts.length > 0
        ? buildBookingMemberNightConflictSummary(conflicts)
        : data.error ||
          "Someone in this party is already booked on one or more of these nights."
    );
    setMemberNightConflicts(conflicts);
    setGuestProfileBlocks([]);
    setErrorPaymentTargets([]);
  }

  function handleBookingApiError(data: Record<string, unknown>, fallback: string) {
    // MG3 (#2308) / D-8. The server collapses every cross-family refusal to one
    // neutral sentence, and the wizard's job here is to NOT dress it up: the two
    // detailed branches below are exactly the leaks D-8 forbids for a
    // cross-family target — `GUEST_PROFILE_REQUIRED` renders the member's name,
    // which profile fields are blank and whether they hold a login, and
    // `BOOKING_MEMBER_NIGHT_CONFLICT` renders their booked nights. The server
    // decides which code a request gets, from MG1's family-boundary computation;
    // the client renders whatever it is given and never re-derives the choice.
    // Family-scope adds keep both detailed branches unchanged.
    if (data.code === MEMBER_GUEST_NOT_ADDABLE_CODE) {
      const message =
        typeof data.error === "string"
          ? data.error
          : MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE;
      setMemberGuestAddError(message);
      // WHERE THIS RENDERS, and why the step is consulted (correctness review of
      // MG3 #2308, HIGH-1). On the guests step the refusal belongs in the find
      // panel, beside the person the booker was adding (mockup panel 13), and
      // the page banner is cleared so the same sentence is not shown twice.
      //
      // Everywhere else the panel does not exist: `GuestsStep` — the ONLY
      // renderer of `memberGuestAddError` — is mounted on the guests step alone,
      // while three of the four callers of this function (create, join-waitlist
      // and save-draft) run from the REVIEW step. Clearing the banner there
      // produced a completely silent failure: the Confirm button simply stopped
      // working, and each further click spent another unit of cross-family
      // throttle budget until a 429 became the booker's first feedback of any
      // kind. It is also reachable without a race — `/api/bookings/quote` does
      // not run the unpaid-subscription check, so a member guest with an unpaid
      // subscription quotes cleanly and is refused only at Confirm.
      //
      // Setting `memberGuestAddError` as well is still right: the guests step
      // re-opens the panel on it, so stepping back shows the refusal in context.
      setError(step === "guests" ? "" : message);
      setGuestProfileBlocks([]);
      setMemberNightConflicts([]);
      setErrorPaymentTargets([]);
      return;
    }
    if (data.code === GUEST_MEMBER_NOT_ALLOWED_CODE) {
      // MEDIUM-4. The club turned the member-guest module off between this page
      // loading and the booker submitting (or a client sent a member id it was
      // never offered). The server's refusal is `"Invalid guest member
      // reference"` — deliberately byte-for-byte what it was before the feature
      // existed, which MG2 pins by test — so it is a developer-facing string
      // that must not be shown to a member. The code is what lets the wizard say
      // something a person can act on without the server changing its wording.
      setMemberGuestAddError(null);
      setError(
        "One of the members on this booking can't be added any more. Refresh the page and try again — if it keeps happening, ask the club.",
      );
      setGuestProfileBlocks([]);
      setMemberNightConflicts([]);
      setErrorPaymentTargets([]);
      return;
    }
    setMemberGuestAddError(null);
    if (data.code === "GUEST_PROFILE_REQUIRED") {
      handleGuestProfileRequired(data as {
        error?: string;
        members?: GuestProfileRequiredMember[];
      });
      return;
    }
    if (data.code === "BOOKING_MEMBER_NIGHT_CONFLICT") {
      handleMemberNightConflict(data as {
        error?: string;
        conflicts?: BookingMemberNightConflict[];
      });
      return;
    }

    setGuestProfileBlocks([]);
    setMemberNightConflicts([]);
    setError(typeof data.error === "string" ? data.error : fallback);
    setErrorPaymentTargets(getBookingErrorPaymentTargets(data));
  }

  async function handleRemoveConflictGuest(conflict: BookingMemberNightConflict) {
    // #2250: the ids arrive only for a viewer the server marked
    // `canOpenBooking`, which `canSelfRemove` implies — and the button that
    // calls this is gated on `canSelfRemove`. So this narrows the optional
    // fields rather than adding a rule.
    if (!conflict.bookingId || !conflict.guestId) return;
    setRemovingConflictGuestId(conflict.guestId);
    try {
      const res = await fetch(
        `/api/bookings/${conflict.bookingId}/guests/${conflict.guestId}`,
        { method: "DELETE" },
      );
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(
          typeof data.error === "string"
            ? data.error
            : "Failed to remove you from that booking.",
        );
        return;
      }

      const nextConflicts = memberNightConflicts.filter(
        (item) =>
          item.bookingId !== conflict.bookingId || item.guestId !== conflict.guestId,
      );
      setMemberNightConflicts(nextConflicts);
      setError(
        nextConflicts.length > 0
          ? buildBookingMemberNightConflictSummary(nextConflicts)
          : "",
      );

      if (nextConflicts.length === 0 && step !== "review") {
        void handleGuestsDone();
      }
    } catch {
      setError("Failed to remove you from that booking.");
    } finally {
      setRemovingConflictGuestId(null);
    }
  }

  async function handleDateSelect(ci: string, co: string) {
    if (!scopedLodgeId) {
      returnToUnresolvedLodge();
      return;
    }
    const requestedLodgeId = scopedLodgeId;
    const sequence = ++dateSelectionSequenceRef.current;
    dateSelectionAbortRef.current?.abort();
    const controller = new AbortController();
    dateSelectionAbortRef.current = controller;
    const ownsSelection = () =>
      sequence === dateSelectionSequenceRef.current &&
      activeScopedLodgeIdRef.current === requestedLodgeId;
    const lostSelectionOwnership = () => {
      if (ownsSelection()) return false;
      if (activeScopedLodgeIdRef.current === null) returnToUnresolvedLodge();
      return true;
    };
    setCheckIn(ci);
    setCheckOut(co);
    setError("");
    setGuestProfileBlocks([]);
    setMemberNightConflicts([]);
    setAppliedPromo(null);
    setPriceQuote(null);
    setUseCredit(false);
    setPerGuestDatesEnabled(false);
    setGuests((current) => clearGuestStayRanges(current));
    setActiveWorkPartyEvents([]);
    setWorkPartyError("");
    setWorkPartyClearedNotice(null);
    const ciStr = ci;
    const coStr = co;
    const lodgeParam = `&lodgeId=${encodeURIComponent(requestedLodgeId)}`;

    try {
      // One sequence and one abort signal own both dependent reads. A second
      // date pick at the same lodge invalidates the first just as decisively as
      // a lodge switch.
      const res = await fetch(
        `/api/availability/check?checkIn=${ciStr}&checkOut=${coStr}${lodgeParam}`,
        { signal: controller.signal },
      );
      if (lostSelectionOwnership()) return;
      if (res.ok) {
        const data = await res.json();
        if (lostSelectionOwnership()) return;
        setAvailableBeds(data.minAvailable);
        setAvailabilityNightDetails(data.nightDetails || []);
      } else {
        setAvailabilityNightDetails([]);
      }

      const policyRes = await fetch(
        `/api/booking-policies/check?checkIn=${ciStr}&checkOut=${coStr}${lodgeParam}`,
        { signal: controller.signal },
      );
      if (lostSelectionOwnership()) return;
      if (policyRes.ok) {
        const policyData = await policyRes.json();
        if (lostSelectionOwnership()) return;
        if (!policyData.valid) {
        // #2562: the date precheck must not strand a member before they can
        // describe the party that the officer would review. Reuse the ONE
        // fail-closed exception-door reader against the server's frozen review:
        // a recognisably reviewable minimum-stay result may proceed to Guests,
        // while a missing, mixed or malformed review remains a hard stop here.
        // This does NOT open the request door. The action is still set only from
        // the authoritative POST /api/bookings refusal after the member reviews
        // and confirms the exact proposal.
          const reviewable = readExceptionOffer({
            code: "MINIMUM_STAY_VIOLATION",
            error: policyData.message,
            exceptionReview: policyData.exceptionReview,
          });
          if (!reviewable) {
            setError(policyData.message);
            return;
          }
        }
      }
      if (ownsSelection()) setStep("guests");
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === "AbortError") return;
      if (!lostSelectionOwnership()) {
        setError("Failed to check availability. Please try again.");
      }
    } finally {
      if (dateSelectionAbortRef.current === controller) {
        dateSelectionAbortRef.current = null;
      }
    }
  }

  async function handleGuestsDone() {
    if (!scopedLodgeId) {
      returnToUnresolvedLodge();
      return;
    }
    const requestedLodgeId = scopedLodgeId;
    setGuestProfileBlocks([]);
    setMemberNightConflicts([]);
    if (guests.length === 0) {
      setError("Add at least one guest");
      return;
    }

    // Validate guest names
    for (const g of guests) {
      if (!g.firstName.trim() || !g.lastName.trim()) {
        setError("All guests must have first and last names");
        return;
      }
    }

    const guestPayload = buildGuestPayload();
    const stayRangeError = validateGuestStayRanges(guestPayload);
    if (stayRangeError) {
      setError(stayRangeError);
      return;
    }

    const fullNights = getCapacityExceededNights(guestPayload);
    if (fullNights.length > 0) {
      setError(formatCapacityExceededMessage(fullNights));
      return;
    }

    setError("");
    setMemberNightConflicts([]);
    setPriceLoading(true);

    // Fetch price quote
    const checkInStr = checkIn!;
    const checkOutStr = checkOut!;
    const res = await fetch("/api/bookings/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checkIn: checkInStr,
        checkOut: checkOutStr,
        lodgeId: requestedLodgeId,
        guests: guestPayload.map((g) => ({
          ageTier: g.ageTier,
          isMember: g.isMember,
          memberId: g.memberId,
          stayStart: g.stayStart,
          stayEnd: g.stayEnd,
          nights: g.nights,
        })),
      }),
    });
    if (activeScopedLodgeIdRef.current !== requestedLodgeId) {
      setPriceLoading(false);
      if (activeScopedLodgeIdRef.current === null) returnToUnresolvedLodge();
      return;
    }

    if (res.ok) {
      const data = await res.json();
      if (activeScopedLodgeIdRef.current !== requestedLodgeId) {
        setPriceLoading(false);
        if (activeScopedLodgeIdRef.current === null) returnToUnresolvedLodge();
        return;
      }
      setPriceQuote(data);
      setStep("review");

      // Fetch available promo codes for the member
      fetch("/api/promo-codes/available")
        .then((r) => {
          setPromoCodesEnabled(r.status !== 404);
          return r.ok ? r.json() : [];
        })
        .then((codes) => setAvailablePromoCodes(codes))
        .catch(() => {});

      // Fetch active working bee events that overlap these dates; events
      // bound to another lodge are filtered out server-side.
      const workPartySequence = ++workPartySequenceRef.current;
      workPartyAbortRef.current?.abort();
      const workPartyController = new AbortController();
      workPartyAbortRef.current = workPartyController;
      const ownsWorkPartyRequest = () =>
        workPartySequence === workPartySequenceRef.current &&
        activeScopedLodgeIdRef.current === requestedLodgeId;
      fetch(
        `/api/work-parties/active?checkIn=${checkInStr}&checkOut=${checkOutStr}${
          `&lodgeId=${encodeURIComponent(requestedLodgeId)}`
        }`,
        { signal: workPartyController.signal },
      )
        .then((r) => r.ok ? r.json() : { events: [] })
        .then((data) => {
          const events: WorkPartyEvent[] = data.events || [];
          if (!ownsWorkPartyRequest()) return;
          setActiveWorkPartyEvents(events);
          if (
            selectedWorkPartyEventId &&
            !events.some((e) => e.id === selectedWorkPartyEventId)
          ) {
            const previous = activeWorkPartyEvents.find(
              (e) => e.id === selectedWorkPartyEventId
            );
            setSelectedWorkPartyEventId(null);
            setAttendingWorkParty(false);
            if (previous) {
              setWorkPartyClearedNotice(previous.name);
            }
            setAppliedPromo((current) =>
              current?.workPartyEvent ? null : current
            );
          }
        })
        .catch((requestError) => {
          if (requestError instanceof DOMException && requestError.name === "AbortError") return;
          if (ownsWorkPartyRequest()) setActiveWorkPartyEvents([]);
        })
        .finally(() => {
          if (workPartyAbortRef.current === workPartyController) {
            workPartyAbortRef.current = null;
          }
        });
    } else {
      const data = await res.json();
      handleBookingApiError(data, "Failed to calculate price");
    }
    setPriceLoading(false);
  }

  async function handleSubmit() {
    /*
     * #2701, owner decision 1: A MEMBER CANNOT COMPLETE A BOOKING WHOSE LODGE
     * IS UNKNOWN. Nobody pays for a stay at a lodge they were never shown.
     *
     * This is the member half of a defect that reached money. `/api/lodges`
     * failing leaves `useLodgeOptions` with an empty list; `LodgeSelect`
     * normalises the selection to `null` and renders nothing at all (ADR-002),
     * so there is no selector on screen to look wrong; the review step's
     * "Lodge:" line was suppressed by the very same emptiness; and this
     * function then posted `lodgeId: undefined`, which the server resolved to
     * the club's default lodge. A member of a three-lodge club could confirm
     * and pay with nothing anywhere naming a lodge.
     *
     * The server now refuses that post outright, so this guard is not what
     * makes it safe — it is what makes it EXPLAINED. Reaching the server's
     * refusal would show a member a validation error about a field they were
     * never offered.
     *
     * Deliberately checked at submit rather than by disabling the button: the
     * member should be told what is wrong and given something to do about it,
     * not handed a dead control with no reason attached.
     */
    if (!scopedLodgeId) {
      setError(BOOKING_LODGE_UNRESOLVED_MEMBER_MESSAGE);
      setLodgeUnresolved(true);
      return;
    }
    if (requiresAdminReviewLocal && !memberReviewJustification.trim()) {
      setError("Please add a reason for booking without an adult guest. This goes to an admin for review.");
      return;
    }
    const guestPayload = buildGuestPayload();
    const stayRangeError = validateGuestStayRanges(guestPayload);
    if (stayRangeError) {
      setError(stayRangeError);
      return;
    }
    setSubmitting(true);
    setError("");
    setErrorPaymentTargets([]);
    setGuestProfileBlocks([]);
    setMemberNightConflicts([]);
    setShowWaitlistPrompt(false);
    // A fresh attempt retires the previous refusal's offer: the payload may have
    // changed, so the rules the server would freeze may have too (#2562).
    setExceptionOffer(null);
    const checkInStr = checkIn!;
    const checkOutStr = checkOut!;

    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checkIn: checkInStr,
        checkOut: checkOutStr,
        lodgeId: scopedLodgeId,
        guests: guestPayload,
        notes: notes || undefined,
        promoCode: appliedPromo?.code || undefined,
        promoGuestIndexes: appliedPromo?.selectedGuestIndexes,
        workPartyEventId: attendingWorkParty ? selectedWorkPartyEventId ?? undefined : undefined,
        expectedArrivalTime: expectedArrivalTime || undefined,
        requestedRoomId: requestedRoomId || undefined,
        cancelIfGuestsBumped:
          guests.some((g) => !g.isMember) && cancelIfGuestsBumped
            ? true
            : undefined,
        applyCreditCents: appliedCreditCents > 0 ? appliedCreditCents : undefined,
        paymentMethod:
          paymentMethod === "internet_banking" ? paymentMethod : undefined,
        memberReviewJustification: requiresAdminReviewLocal
          ? memberReviewJustification.trim()
          : undefined,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      if (groupTrip && groupBookingsEnabled) {
        // Best-effort: open the group so the share link is waiting on the
        // booking page. Bookings that aren't committed yet (e.g. non-member
        // holds in PENDING, or admin review) can't anchor a group, so tell
        // the member instead of silently dropping their choice; never block
        // the redirect.
        let groupOpened = false;
        try {
          const groupRes = await fetch("/api/group-bookings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              organiserBookingId: data.id,
              paymentMode: groupPaymentMode,
            }),
          });
          groupOpened = groupRes.ok;
        } catch {
          // fall through to the toast
        }
        if (!groupOpened) {
          toast.info(
            "Your group trip couldn't be opened yet. You can open it from your booking page once the booking is confirmed.",
          );
        }
      }
      // Card path: stay in the wizard and take payment as step 4 (#1084).
      // Everything else keeps the existing redirects: internet banking gets
      // its invoice instructions, holds/review/zero-due have nothing to pay.
      if (
        showPaymentMethodChoice &&
        paymentMethod === "stripe" &&
        isPaymentOwedBookingStatus(data.status)
      ) {
        setCreatedBooking({
          id: data.id,
          status: data.status,
          amountCents: remainingToPay,
          returnUrl: `${window.location.origin}/bookings/${data.id}`,
        });
        setStep("pay");
        setSubmitting(false);
        window.scrollTo({ top: 0 });
        return;
      }
      // Land on the payment card when payment is the next step; the hash is a
      // harmless no-op when the card isn't rendered (holds, review, zero due).
      router.push(
        showPaymentMethodChoice
          ? `/bookings/${data.id}#payment`
          : `/bookings/${data.id}`,
      );
    } else {
      const data = await res.json();
      if (data.code === "CAPACITY_EXCEEDED" && data.canWaitlist) {
        setShowWaitlistPrompt(true);
        setWaitlistFullNights(data.fullNights || []);
        setWaitlistAlternateLodgeIds([]);
        setError("");
      } else {
        handleBookingApiError(data, "Failed to create booking");
        // #2562: the ONE shared rule decides whether this refusal may offer to ask
        // a Booking Officer. It reads the server's own classification and answers
        // null for everything else, so no hard failure can open the door.
        setExceptionOffer(readExceptionOffer(data));
      }
      setSubmitting(false);
    }
  }

  async function handleJoinWaitlist() {
    if (!scopedLodgeId) {
      setStep("dates");
      setError(BOOKING_LODGE_UNRESOLVED_MEMBER_MESSAGE);
      setLodgeUnresolved(true);
      return;
    }
    if (requiresAdminReviewLocal && !memberReviewJustification.trim()) {
      setError("Please add a reason for booking without an adult guest before joining the waitlist.");
      return;
    }
    const guestPayload = buildGuestPayload();
    const stayRangeError = validateGuestStayRanges(guestPayload);
    if (stayRangeError) {
      setError(stayRangeError);
      return;
    }
    setJoiningWaitlist(true);
    setError("");
    setErrorPaymentTargets([]);
    setGuestProfileBlocks([]);
    setMemberNightConflicts([]);
    // Cleared but never SET on this path (#2562): an exception request creates or
    // changes a real booking, so offering it as the answer to a refused
    // waitlist join would answer a different question than the member asked.
    setExceptionOffer(null);
    const checkInStr = checkIn!;
    const checkOutStr = checkOut!;

    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checkIn: checkInStr,
        checkOut: checkOutStr,
        guests: guestPayload,
        notes: notes || undefined,
        promoCode: appliedPromo?.code || undefined,
        promoGuestIndexes: appliedPromo?.selectedGuestIndexes,
        workPartyEventId: attendingWorkParty ? selectedWorkPartyEventId ?? undefined : undefined,
        expectedArrivalTime: expectedArrivalTime || undefined,
        requestedRoomId: requestedRoomId || undefined,
        cancelIfGuestsBumped:
          guests.some((g) => !g.isMember) && cancelIfGuestsBumped
            ? true
            : undefined,
        lodgeId: scopedLodgeId,
        waitlist: true,
        alternateLodgeIds:
          waitlistAlternateLodgeIds.length > 0
            ? waitlistAlternateLodgeIds
            : undefined,
        memberReviewJustification: requiresAdminReviewLocal
          ? memberReviewJustification.trim()
          : undefined,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      router.push(`/bookings/${data.id}`);
    } else {
      const data = await res.json();
      handleBookingApiError(data, "Failed to join waitlist");
      setJoiningWaitlist(false);
    }
  }

  async function handleSaveAsDraft() {
    if (!scopedLodgeId) {
      setStep("dates");
      setError(BOOKING_LODGE_UNRESOLVED_MEMBER_MESSAGE);
      setLodgeUnresolved(true);
      return;
    }
    const guestPayload = buildGuestPayload();
    const stayRangeError = validateGuestStayRanges(guestPayload);
    if (stayRangeError) {
      setError(stayRangeError);
      return;
    }
    setSavingDraft(true);
    setError("");
    setErrorPaymentTargets([]);
    setGuestProfileBlocks([]);
    setMemberNightConflicts([]);
    setExceptionOffer(null);
    const checkInStr = checkIn!;
    const checkOutStr = checkOut!;

    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checkIn: checkInStr,
        checkOut: checkOutStr,
        guests: guestPayload,
        notes: notes || undefined,
        promoCode: appliedPromo?.code || undefined,
        promoGuestIndexes: appliedPromo?.selectedGuestIndexes,
        workPartyEventId: attendingWorkParty ? selectedWorkPartyEventId ?? undefined : undefined,
        expectedArrivalTime: expectedArrivalTime || undefined,
        requestedRoomId: requestedRoomId || undefined,
        cancelIfGuestsBumped:
          guests.some((g) => !g.isMember) && cancelIfGuestsBumped
            ? true
            : undefined,
        applyCreditCents: appliedCreditCents > 0 ? appliedCreditCents : undefined,
        lodgeId: scopedLodgeId,
        draft: true,
        memberReviewJustification: requiresAdminReviewLocal
          ? memberReviewJustification.trim() || undefined
          : undefined,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      if (groupTrip && groupBookingsEnabled) {
        // Drafts can't anchor a group; tell the member where the option went.
        toast.info("You can open the group trip after confirming your booking.");
      }
      router.push(`/bookings/${data.id}`);
    } else {
      const data = await res.json();
      handleBookingApiError(data, "Failed to save draft");
      // Same reviewable-refusal door as the confirm path: a draft is refused by
      // the same policy gates, and the member's remedy is the same request.
      setExceptionOffer(readExceptionOffer(data));
      setSavingDraft(false);
    }
  }

  /**
   * Send the exception request the current refusal opened the door to (#2562).
   *
   * Deliberately reuses `buildGuestPayload()` — the EXACT payload the refused
   * create call sent — so the proposal an officer freezes is the proposal that was
   * refused, not a second construction of it that could differ. The dates come
   * from the same state the create used.
   *
   * Throws an Error carrying the server's own sentence, plus its `code` where it
   * sent one, so the card can name the right next step for the two 409s whose
   * remedy is not "try again".
   */
  async function submitExceptionRequest(input: {
    memberMessage: string;
    supersedeRequestId: string | null;
  }): Promise<ExceptionRequestSubmitResult> {
    if (!scopedLodgeId) {
      setStep("dates");
      setError(BOOKING_LODGE_UNRESOLVED_MEMBER_MESSAGE);
      setLodgeUnresolved(true);
      throw new Error(BOOKING_LODGE_UNRESOLVED_MEMBER_MESSAGE);
    }
    const res = await fetch("/api/bookings/exception-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lodgeId: scopedLodgeId,
        checkIn: checkIn!,
        checkOut: checkOut!,
        guests: buildGuestPayload(),
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
      // The frozen aggregate, for the receipt's capacity sentence. Read from the
      // create response rather than from the refusal, so the receipt describes the
      // request that was actually written.
      capacityMode:
        data.aggregateCapacityMode === "HOLD" ||
        data.aggregateCapacityMode === "NO_HOLD"
          ? data.aggregateCapacityMode
          : null,
    };
  }

  // Whole nights between the two lodge dates, counted as CALENDAR days and so
  // needing no timezone at all (#2474; CT-4, #2870) — DST-immune by
  // construction, because there is no clock in the calculation to be moved.
  // `parseCalendarDate` rather than `requireCalendarDate`: these two dates are
  // user-driven and may be half-entered, and a throw on every render would
  // replace the booking form with an error boundary.
  const parsedCheckIn = checkIn ? parseCalendarDate(checkIn) : null;
  const parsedCheckOut = checkOut ? parseCalendarDate(checkOut) : null;
  const nights =
    parsedCheckIn && parsedCheckOut
      ? countClubNights(parsedCheckIn, parsedCheckOut)
      : 0;

  function getGuestProfileBlockMessage(block: GuestProfileRequiredMember) {
    if (block.action === "own_login_required") {
      return `${block.name} has their own login and needs to sign in and confirm their details before they can be booked as a member.`;
    }

    if (block.action === "pending_admin_approval") {
      return "This family change is awaiting admin approval. You can add them as a non-member guest until approved.";
    }

    if (block.canCurrentUserResolve) {
      return `Complete ${block.name}'s details before booking them as a member.`;
    }

    return `${block.name}'s member details need to be completed or confirmed before they can be booked as a member.`;
  }

  function getGuestProfileActionLabel(block: GuestProfileRequiredMember) {
    if (block.action === "complete_details" && block.canCurrentUserResolve) {
      return "Complete details";
    }
    if (block.action === "own_login_required") {
      return "Ask them to sign in and confirm";
    }
    if (block.action === "pending_admin_approval") {
      return "Pending admin approval";
    }
    if (block.action === "contact_admin") {
      return "Contact admin";
    }
    return null;
  }

  const availableCreditCents = priceQuote?.availableCreditCents ?? 0;
  const finalPriceBeforeCredit = priceQuote
    ? (appliedPromo?.finalPriceCents ?? priceQuote.totalPriceCents)
    : 0;
  const appliedCreditCents = useCredit
    ? Math.min(availableCreditCents, finalPriceBeforeCredit)
    : 0;
  const remainingToPay = finalPriceBeforeCredit - appliedCreditCents;
  const bookingDateStrings = getBookingDateStrings();
  const reviewGuestPayload = priceQuote ? buildGuestPayload() : guests;
  /**
   * The offer, but ONLY while it still describes the proposal on screen.
   *
   * A mismatch means the member changed the lodge, the dates or the party after
   * the refusal, so the offer describes something they are no longer proposing.
   * Answering null retires it in the same render the change lands in — no effect,
   * no cleared-too-late window, and no dependence on a component remembering to
   * clear it. The edit panel keys its own offer the same way (#2562 re-review): its
   * debounced quote effect only clears on a RESOLVED quote, so relying on that left
   * a refused proposal's rule and price on screen over changed nights.
   */
  const exceptionOffer =
    exceptionOfferState &&
    exceptionOfferState.proposalSignature === exceptionProposalSignature()
      ? exceptionOfferState.offer
      : null;
  // #2919 review: these three bodies are templates — every token is insertable
  // into them — so they render through the shared client renderer with the lodge
  // the member is actually booking, not the club's default one.
  const renderPaymentMessage = (key: BookingMessageKey, fallback: string) =>
    renderClientBookingMessage({
      template: bookingMessages[key],
      fallback,
      clubTokens: bookingMessageTokens,
      lodgeName: selectedLodge?.name ?? null,
    });
  const cardPaymentDescription = renderPaymentMessage(
    "booking.payment.card.description",
    "Pay now and secure the booking immediately."
  );
  const internetBankingPaymentDescription = renderPaymentMessage(
    "booking.payment.internetBanking.description",
    "Receive a Xero invoice by email and make payment via internet banking. Once the payment is reconciled and sync'd back to the booking system, your booking will be confirmed. Until then your booking is not held and someone else could take your space by booking and paying with Card."
  );
  const internetBankingUnavailableCopy =
    internetBankingUnavailableReason ??
    renderPaymentMessage(
      "booking.payment.internetBanking.unavailable",
      "Internet Banking is not available for this check-in date. Please pay by card to secure the booking immediately."
    );

  const subscriptionUnpaid =
    subscriptionStatus &&
    (subscriptionStatus.status === "UNPAID" || subscriptionStatus.status === "OVERDUE");
  const showInviteFamilyGroupMembersLink =
    shouldShowInviteFamilyGroupMembersLink(familyMembers);
  const showPaymentMethodChoice =
    remainingToPay > 0 && !requiresAdminReviewLocal;

  useEffect(() => {
    if (
      paymentMethod === "internet_banking" &&
      (!internetBankingEnabled || remainingToPay <= 0 || requiresAdminReviewLocal)
    ) {
      setPaymentMethod("stripe");
    }
  }, [
    internetBankingEnabled,
    paymentMethod,
    remainingToPay,
    requiresAdminReviewLocal,
  ]);

  // Apply or refresh the working bee discount preview when a work party
  // event is selected (or the booking changes while one is selected).
  useEffect(() => {
    if (
      !scopedLodgeId ||
      !selectedWorkPartyEventId ||
      !checkIn ||
      !checkOut ||
      !priceQuote
    ) {
      return;
    }

    let cancelled = false;
    const requestedLodgeId = scopedLodgeId;
    setWorkPartyError("");

    fetch("/api/promo-codes/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lodgeId: requestedLodgeId,
        workPartyEventId: selectedWorkPartyEventId,
        checkIn,
        checkOut,
        guests: reviewGuestPayload.map((g) => ({
          ageTier: g.ageTier,
          isMember: g.isMember,
          ...(g.memberId ? { memberId: g.memberId } : {}),
          ...(g.stayStart ? { stayStart: g.stayStart } : {}),
          ...(g.stayEnd ? { stayEnd: g.stayEnd } : {}),
        })),
      }),
    })
      .then(async (res) => {
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || data.valid === false) {
          setAppliedPromo(null);
          setWorkPartyError(data.error || "This working bee event could not be applied");
          return;
        }
        setAppliedPromo({
          code: data.code,
          description: data.description,
          type: data.type,
          discountCents: data.discountCents,
          promoAdjustmentCents: data.promoAdjustmentCents,
          totalPriceCents: data.totalPriceCents,
          finalPriceCents: data.finalPriceCents,
          workPartyEvent: data.workPartyEvent,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setAppliedPromo(null);
          setWorkPartyError("Failed to apply the working bee discount");
        }
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedLodgeId, selectedWorkPartyEventId, checkIn, checkOut, priceQuote, JSON.stringify(reviewGuestPayload)]);

  const wizardSteps: Array<{ id: BookingWizardStep; label: string }> = [
    { id: "dates", label: "Select Dates" },
    { id: "guests", label: "Add Guests" },
    { id: "review", label: "Review & Confirm" },
    { id: "pay", label: requiresAdminReviewLocal ? "Admin Review" : "Pay" },
  ];
  const activeStepIndex = wizardSteps.findIndex((item) => item.id === step);

  return {
    step,
    setStep,
    createdBooking,
    checkIn,
    checkOut,
    guests,
    notes,
    setNotes,
    priceQuote,
    priceLoading,
    error,
    errorPaymentTargets,
    subscriptionInvoiceUrl,
    subscriptionInvoiceNumber,
    submitting,
    savingDraft,
    showWaitlistPrompt,
    setShowWaitlistPrompt,
    waitlistFullNights,
    joiningWaitlist,
    perGuestDatesEnabled,
    handlePerGuestDatesEnabledChange,
    multiDateRangesEnabled,
    handleMultiDateRangesEnabledChange,
    appliedPromo,
    setAppliedPromo,
    expectedArrivalTime,
    setExpectedArrivalTime,
    requestedRoomId,
    setRequestedRoomId,
    cancelIfGuestsBumped,
    setCancelIfGuestsBumped,
    roomOptions,
    roomRequestEnabled,
    useCredit,
    setUseCredit,
    paymentMethod,
    setPaymentMethod,
    internetBankingEnabled,
    groupBookingsEnabled,
    groupTrip,
    setGroupTrip,
    groupPaymentMode,
    setGroupPaymentMode,
    internetBankingUnavailableReason,
    internetBankingHoldSummary,
    familyMembers,
    subscriptionStatus,
    subscriptionLoading,
    availablePromoCodes,
    promoCodesEnabled,
    prefillPromoCode,
    setPrefillPromoCode,
    activeWorkPartyEvents,
    attendingWorkParty,
    setAttendingWorkParty,
    selectedWorkPartyEventId,
    setSelectedWorkPartyEventId,
    workPartyError,
    setWorkPartyError,
    workPartyClearedNotice,
    setWorkPartyClearedNotice,
    guestProfileBlocks,
    memberNightConflicts,
    removingConflictGuestId,
    memberReviewJustification,
    setMemberReviewJustification,
    requiresAdminReviewLocal,
    handleGuestsChange,
    addFamilyMemberAsGuest,
    addMemberGuest,
    memberGuestConfig,
    memberGuestAddError,
    handleRemoveConflictGuest,
    handleDateSelect,
    handleGuestsDone,
    handleSubmit,
    handleJoinWaitlist,
    handleSaveAsDraft,
    // #2562 — the member-facing exception-request surface.
    exceptionOffer,
    replaceExceptionRequestId,
    submitExceptionRequest,
    getGuestProfileBlockMessage,
    getGuestProfileActionLabel,
    nights,
    availableCreditCents,
    appliedCreditCents,
    remainingToPay,
    bookingDateStrings,
    reviewGuestPayload,
    cardPaymentDescription,
    internetBankingPaymentDescription,
    internetBankingUnavailableCopy,
    subscriptionUnpaid,
    showInviteFamilyGroupMembersLink,
    showPaymentMethodChoice,
    wizardSteps,
    activeStepIndex,
    lodgeCapacity,
    lodges,
    lodgeId,
    lodgeScope,
    scopedLodgeId,
    lodgesLoading,
    // #2701: the member half of the unnamed-lodge refusal.
    lodgesFailed,
    lodgesForbidden,
    lodgeUnresolved,
    retryLodgeOptions,
    handleLodgeChange,
    selectedLodge,
    lodgeLabel,
    waitlistAlternateLodgeIds,
    setWaitlistAlternateLodgeIds,
  };
}
