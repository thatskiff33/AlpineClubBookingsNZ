"use client";

import type { AgeTier } from "@prisma/client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { BookingCalendar } from "@/components/booking-calendar";
import { GuestForm, type GuestData } from "@/components/guest-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useClubIdentity } from "@/components/club-identity-provider";
import { PromoCodeInput, type PromoResult } from "@/components/promo-code-input";
import { TimePicker } from "@/components/time-picker";
import { CreditCard, Landmark } from "lucide-react";
import {
  getBookingErrorPaymentTargets,
  type BookingErrorPaymentTarget,
} from "@/lib/booking-error-payment-targets";
import { formatLocalDateOnly } from "@/lib/date-only";
import Link from "next/link";
import {
  getFamilyMemberBookingActionLabel,
  getFamilyMemberBookingBlockMessage,
  shouldShowInviteFamilyGroupMembersLink,
} from "@/lib/family-booking";
import { buildProfilePathWithReturnTo } from "@/lib/internal-return-path";

interface FamilyMember {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  relationship: "self" | "partner" | "dependent";
  canLogin?: boolean;
  canBeBooked?: boolean;
  missingFields?: string[];
  needsOwnLoginConfirmation?: boolean;
  canCurrentUserConfirmDetails?: boolean;
  pendingRequestStatus?: string | null;
  pendingRequests?: Array<{
    id: string;
    type: string;
    status: string;
    familyGroupId: string;
  }>;
  pendingRequestFamilyGroupIds?: string[];
  bookableFamilyGroupIds?: string[];
  action?:
    | "complete_details"
    | "own_login_required"
    | "pending_admin_approval"
    | "contact_admin"
    | null;
}

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

interface RoomOption {
  id: string;
  name: string;
  bedCount: number;
}

interface PriceQuote {
  guests: {
    ageTier: string;
    isMember: boolean;
    nights: number;
    priceCents: number;
    perNightCents?: number[];
    nightDates?: string[];
  }[];
  totalPriceCents: number;
  availableCreditCents?: number;
}

interface AvailabilityNightDetail {
  date: string;
  availableBeds: number;
}

interface WorkPartyEvent {
  id: string;
  name: string;
  description: string | null;
  startDate: string;
  endDate: string;
  discountPercent: number;
}

interface SubscriptionStatus {
  status: "PAID" | "UNPAID" | "OVERDUE" | "NOT_INVOICED" | "NOT_REQUIRED" | "UNKNOWN";
  seasonDisplay: string;
  invoiceUrl: string | null;
  invoiceNumber: string | null;
}

type BookingPaymentMethod = "stripe" | "internet_banking";

const UNKNOWN_SUBSCRIPTION_STATUS: SubscriptionStatus = {
  status: "UNKNOWN",
  seasonDisplay: "",
  invoiceUrl: null,
  invoiceNumber: null,
};

const PROFILE_RETURN_TO_BOOK = buildProfilePathWithReturnTo("/book");
const PROFILE_FAMILY_GROUP_RETURN_TO_BOOK = buildProfilePathWithReturnTo(
  "/book",
  "family-group",
);

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

export default function BookPage() {
  const router = useRouter();
  const { data: session } = useSession();
  const { lodgeCapacity } = useClubIdentity();
  const [step, setStep] = useState<"dates" | "guests" | "review">("dates");
  const [checkIn, setCheckIn] = useState<Date | null>(null);
  const [checkOut, setCheckOut] = useState<Date | null>(null);
  const [guests, setGuests] = useState<GuestData[]>([]);
  const [notes, setNotes] = useState("");
  const [priceQuote, setPriceQuote] = useState<PriceQuote | null>(null);
  const [priceLoading, setPriceLoading] = useState(false);
  const [error, setError] = useState("");
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
  const [familyMembers, setFamilyMembers] = useState<FamilyMember[]>([]);
  const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatus | null>(null);
  const [subscriptionLoading, setSubscriptionLoading] = useState(true);
  const [availablePromoCodes, setAvailablePromoCodes] = useState<{ code: string; description: string | null; type: string; percentOff: number | null; valueCents: number | null; freeNightsPerIndividual: number | null; lifetimeFreeNightsCap: number | null; fixedNightlyPriceCents: number | null; fixedNightlyMode: string | null }[]>([]);
  const [prefillPromoCode, setPrefillPromoCode] = useState<string | undefined>();
  const [activeWorkPartyEvents, setActiveWorkPartyEvents] = useState<WorkPartyEvent[]>([]);
  const [attendingWorkParty, setAttendingWorkParty] = useState(false);
  const [selectedWorkPartyEventId, setSelectedWorkPartyEventId] = useState<string | null>(null);
  const [workPartyError, setWorkPartyError] = useState("");
  const [workPartyClearedNotice, setWorkPartyClearedNotice] = useState<string | null>(null);
  const [guestProfileBlocks, setGuestProfileBlocks] = useState<GuestProfileRequiredMember[]>([]);
  const [memberReviewJustification, setMemberReviewJustification] = useState("");
  const requiresAdminReviewLocal = (() => {
    if (guests.length === 0) return false;
    const hasAdult = guests.some((g) => g.ageTier === "ADULT");
    const hasMinor = guests.some(
      (g) => g.ageTier === "YOUTH" || g.ageTier === "CHILD" || g.ageTier === "INFANT",
    );
    return hasMinor && !hasAdult;
  })();

  function getBookingDateStrings() {
    if (!checkIn || !checkOut) {
      return null;
    }

    return {
      checkIn: formatLocalDateOnly(checkIn),
      checkOut: formatLocalDateOnly(checkOut),
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
    setGuests((current) =>
      enabled ? withDefaultGuestStayRanges(current) : clearGuestStayRanges(current)
    );
  }

  function handleMultiDateRangesEnabledChange(enabled: boolean) {
    setMultiDateRangesEnabled(enabled);
    setAppliedPromo(null);
    setPriceQuote(null);
    setUseCredit(false);
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
      return `The lodge does not have enough beds on ${fullNights[0]}`;
    }

    return `The lodge does not have enough beds on ${fullNights.length} nights`;
  }

  useEffect(() => {
    if (guests.length <= 1 && perGuestDatesEnabled) {
      setPerGuestDatesEnabled(false);
      setGuests((current) => clearGuestStayRanges(current));
    }
  }, [guests.length, perGuestDatesEnabled]);

  // Redirect admins to the admin booking page — admins must book on behalf of members
  useEffect(() => {
    if (session?.user?.role === "ADMIN") {
      router.replace("/admin/book");
    }
  }, [session, router]);

  useEffect(() => {
    fetch("/api/members/family")
      .then((res) => res.ok ? res.json() : { familyMembers: [] })
      .then((data) => setFamilyMembers(data.familyMembers || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/payments/options")
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        setInternetBankingEnabled(
          Boolean(data?.methods?.internetBanking?.enabled)
        );
      })
      .catch(() => setInternetBankingEnabled(false));
  }, []);

  useEffect(() => {
    fetch("/api/bookings/rooms")
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        setRoomRequestEnabled(Boolean(data?.enabled));
        setRoomOptions(data?.rooms ?? []);
      })
      .catch(() => {
        setRoomRequestEnabled(false);
        setRoomOptions([]);
      });
  }, []);

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
  }

  function handleBookingApiError(data: Record<string, unknown>, fallback: string) {
    if (data.code === "GUEST_PROFILE_REQUIRED") {
      handleGuestProfileRequired(data as {
        error?: string;
        members?: GuestProfileRequiredMember[];
      });
      return;
    }

    setGuestProfileBlocks([]);
    setError(typeof data.error === "string" ? data.error : fallback);
    setErrorPaymentTargets(getBookingErrorPaymentTargets(data));
  }

  async function handleDateSelect(ci: Date, co: Date) {
    setCheckIn(ci);
    setCheckOut(co);
    setError("");
    setGuestProfileBlocks([]);
    setAppliedPromo(null);
    setPriceQuote(null);
    setUseCredit(false);
    setPerGuestDatesEnabled(false);
    setGuests((current) => clearGuestStayRanges(current));
    setActiveWorkPartyEvents([]);
    setWorkPartyError("");
    setWorkPartyClearedNotice(null);
    const ciStr = formatLocalDateOnly(ci);
    const coStr = formatLocalDateOnly(co);

    // Fetch availability for selected range
    const res = await fetch(
      `/api/availability/check?checkIn=${ciStr}&checkOut=${coStr}`
    );
    if (res.ok) {
      const data = await res.json();
      setAvailableBeds(data.minAvailable);
      setAvailabilityNightDetails(data.nightDetails || []);
    } else {
      setAvailabilityNightDetails([]);
    }

    // Check minimum stay policies
    const policyRes = await fetch(`/api/booking-policies/check?checkIn=${ciStr}&checkOut=${coStr}`);
    if (policyRes.ok) {
      const policyData = await policyRes.json();
      if (!policyData.valid) {
        setError(policyData.message);
        return;
      }
    }

    setStep("guests");
  }

  async function handleGuestsDone() {
    setGuestProfileBlocks([]);
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
    setPriceLoading(true);

    // Fetch price quote
    const checkInStr = formatLocalDateOnly(checkIn!);
    const checkOutStr = formatLocalDateOnly(checkOut!);
    const res = await fetch("/api/bookings/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checkIn: checkInStr,
        checkOut: checkOutStr,
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

    if (res.ok) {
      const data = await res.json();
      setPriceQuote(data);
      setStep("review");

      // Fetch available promo codes for the member
      fetch("/api/promo-codes/available")
        .then((r) => r.ok ? r.json() : [])
        .then((codes) => setAvailablePromoCodes(codes))
        .catch(() => {});

      // Fetch active working bee events that overlap these dates
      fetch(`/api/work-parties/active?checkIn=${checkInStr}&checkOut=${checkOutStr}`)
        .then((r) => r.ok ? r.json() : { events: [] })
        .then((data) => {
          const events: WorkPartyEvent[] = data.events || [];
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
        .catch(() => setActiveWorkPartyEvents([]));
    } else {
      const data = await res.json();
      handleBookingApiError(data, "Failed to calculate price");
    }
    setPriceLoading(false);
  }

  async function handleSubmit() {
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
    setShowWaitlistPrompt(false);
    const checkInStr = formatLocalDateOnly(checkIn!);
    const checkOutStr = formatLocalDateOnly(checkOut!);

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
        paymentMethod:
          paymentMethod === "internet_banking" ? paymentMethod : undefined,
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
      if (data.code === "CAPACITY_EXCEEDED" && data.canWaitlist) {
        setShowWaitlistPrompt(true);
        setWaitlistFullNights(data.fullNights || []);
        setError("");
      } else {
        handleBookingApiError(data, "Failed to create booking");
      }
      setSubmitting(false);
    }
  }

  async function handleJoinWaitlist() {
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
    const checkInStr = formatLocalDateOnly(checkIn!);
    const checkOutStr = formatLocalDateOnly(checkOut!);

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
        waitlist: true,
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
    const checkInStr = formatLocalDateOnly(checkIn!);
    const checkOutStr = formatLocalDateOnly(checkOut!);

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
        draft: true,
        memberReviewJustification: requiresAdminReviewLocal
          ? memberReviewJustification.trim() || undefined
          : undefined,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      router.push(`/bookings/${data.id}`);
    } else {
      const data = await res.json();
      handleBookingApiError(data, "Failed to save draft");
      setSavingDraft(false);
    }
  }

  const nights = checkIn && checkOut
    ? Math.ceil((checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  function formatCents(cents: number) {
    return `$${(cents / 100).toFixed(2)}`;
  }

  function formatSignedCents(cents: number) {
    const prefix = cents > 0 ? "+" : "-";
    return `${prefix}${formatCents(Math.abs(cents))}`;
  }

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
    if (!selectedWorkPartyEventId || !checkIn || !checkOut || !priceQuote) {
      return;
    }

    let cancelled = false;
    setWorkPartyError("");

    fetch("/api/promo-codes/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workPartyEventId: selectedWorkPartyEventId,
        checkIn: formatLocalDateOnly(checkIn),
        checkOut: formatLocalDateOnly(checkOut),
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
  }, [selectedWorkPartyEventId, checkIn, checkOut, priceQuote, JSON.stringify(reviewGuestPayload)]);

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-3xl font-bold">Book a Stay</h1>

      {/* Subscription warning banner */}
      {!subscriptionLoading && subscriptionUnpaid && (
        <div className="rounded-md bg-amber-50 border border-amber-200 p-4 text-sm text-amber-800">
          <p>
            <strong>Subscription unpaid:</strong> Your subscription for the{" "}
            {subscriptionStatus!.seasonDisplay} season is unpaid.{" "}
            {subscriptionInvoiceUrl ? (
              <>Use the payment link below to pay it before booking.</>
            ) : (
              <>
                Please{" "}
                <Link
                  href={PROFILE_RETURN_TO_BOOK}
                  className="underline font-medium"
                >
                  contact the club
                </Link>{" "}
                before booking.
              </>
            )}
          </p>
          {subscriptionInvoiceUrl ? (
            <Button asChild className="mt-3">
              <a
                href={subscriptionInvoiceUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Pay Your Subscription
              </a>
            </Button>
          ) : subscriptionInvoiceNumber ? (
            <p className="mt-2">
              Invoice reference: <strong>{subscriptionInvoiceNumber}</strong> — check your email from Xero for the payment link.
            </p>
          ) : null}
        </div>
      )}

      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          <p>{error}</p>
          {guestProfileBlocks.length > 0 && (
            <div className="mt-3 space-y-3">
              {guestProfileBlocks.map((block) => {
                const actionLabel = getGuestProfileActionLabel(block);
                return (
                  <div
                    key={block.memberId}
                    className="rounded-md border border-red-200 bg-white/70 p-3"
                  >
                    <p className="font-medium text-red-800">{block.name}</p>
                    <p className="mt-1">{getGuestProfileBlockMessage(block)}</p>
                    {block.missingFields.length > 0 && (
                      <p className="mt-1 text-red-600">
                        Missing: {block.missingFields.join(", ")}
                      </p>
                    )}
                    {actionLabel && (
                      block.action === "complete_details" && block.canCurrentUserResolve ? (
                        <Link
                          href={PROFILE_FAMILY_GROUP_RETURN_TO_BOOK}
                          className="mt-2 inline-flex text-sm font-medium text-red-800 underline underline-offset-4"
                        >
                          {actionLabel}
                        </Link>
                      ) : (
                        <p className="mt-2 font-medium text-red-800">{actionLabel}</p>
                      )
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {errorPaymentTargets.length > 0 && (
            <div className="mt-3 space-y-2">
              {errorPaymentTargets.map((target) => (
                <div key={`${target.name}-${target.invoiceNumber ?? target.invoiceUrl ?? "none"}`}>
                  {target.invoiceUrl ? (
                    <a
                      href={target.invoiceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="app-button-brand"
                    >
                      {target.name === "Your subscription"
                        ? "Pay Your Subscription"
                        : `Pay ${target.name}'s Subscription`}
                    </a>
                  ) : target.invoiceNumber ? (
                    <p className="text-sm">
                      {target.name}: invoice reference{" "}
                      <strong>{target.invoiceNumber}</strong> — check your email from Xero for the payment link.
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {showWaitlistPrompt && (
        <Card className="border-purple-200 bg-purple-50">
          <CardContent className="pt-6 space-y-4">
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-purple-100 p-2 mt-0.5">
                <svg className="h-5 w-5 text-purple-600" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                </svg>
              </div>
              <div>
                <h3 className="font-semibold text-purple-900">Lodge is fully booked</h3>
                <p className="text-sm text-purple-700 mt-1">
                  The lodge is at capacity on{" "}
                  {waitlistFullNights.length === 1
                    ? waitlistFullNights[0]
                    : `${waitlistFullNights.length} nights`}
                  . You can join the waitlist and we&apos;ll email you when a spot opens up.
                </p>
              </div>
            </div>
            <div className="flex gap-3 justify-end">
              <Button
                variant="outline"
                onClick={() => setShowWaitlistPrompt(false)}
                disabled={joiningWaitlist}
              >
                Cancel
              </Button>
              <Button
                onClick={handleJoinWaitlist}
                disabled={joiningWaitlist}
                className="bg-purple-600 hover:bg-purple-700"
              >
                {joiningWaitlist ? "Joining waitlist..." : "Join Waitlist"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step indicator */}
      <div className="flex items-center gap-2 text-sm">
        <span className={step === "dates" ? "app-step-active" : "text-gray-400"}>
          1. Select Dates
        </span>
        <span className="text-gray-300">&rarr;</span>
        <span className={step === "guests" ? "app-step-active" : "text-gray-400"}>
          2. Add Guests
        </span>
        <span className="text-gray-300">&rarr;</span>
        <span className={step === "review" ? "app-step-active" : "text-gray-400"}>
          3. Review & Confirm
        </span>
      </div>

      {/* Step 1: Dates */}
      {step === "dates" && (
        <Card>
          <CardHeader>
            <CardTitle>Select Your Dates</CardTitle>
          </CardHeader>
          <CardContent>
            {subscriptionUnpaid ? (
              <p className="text-sm text-amber-700 py-8 text-center">
                Booking is disabled until your subscription is paid.
              </p>
            ) : (
              <BookingCalendar
                onDateSelect={handleDateSelect}
                selectedCheckIn={checkIn}
                selectedCheckOut={checkOut}
              />
            )}
          </CardContent>
        </Card>
      )}

      {/* Step 2: Guests */}
      {step === "guests" && (
        <Card>
          <CardHeader>
            <CardTitle>
              Add Guests
              {checkIn && checkOut && (
                <span className="ml-2 text-sm font-normal text-gray-500">
                  {checkIn.toLocaleDateString("en-NZ")} - {checkOut.toLocaleDateString("en-NZ")} ({nights} night{nights !== 1 ? "s" : ""})
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {familyMembers.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground">Quick add family members</p>
                <div className="grid gap-2">
                  {familyMembers.map((fm) => {
                    const alreadyAdded = guests.some((g) => g.memberId === fm.id);
                    const blocked = fm.canBeBooked === false;
                    const label = fm.relationship === "self"
                      ? `${fm.firstName} ${fm.lastName} (You)`
                      : `${fm.firstName} ${fm.lastName} (${fm.ageTier})`;
                    const blockMessage = getFamilyMemberBookingBlockMessage(fm);
                    const actionLabel = getFamilyMemberBookingActionLabel(fm);
                    return (
                      <div
                        key={fm.id}
                        className={blocked ? "rounded-md border border-amber-200 bg-amber-50 p-3" : ""}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            type="button"
                            variant={alreadyAdded ? "secondary" : fm.relationship === "self" ? "default" : "outline"}
                            size="sm"
                            disabled={alreadyAdded || guests.length >= lodgeCapacity || blocked}
                            onClick={() => addFamilyMemberAsGuest(fm)}
                          >
                            {alreadyAdded ? "\u2713 " : "+ "}
                            {label}
                          </Button>
                          {blocked && actionLabel && (
                            actionLabel === "Complete details" ? (
                              <Button asChild variant="outline" size="sm">
                                <Link href={PROFILE_FAMILY_GROUP_RETURN_TO_BOOK}>
                                  {actionLabel}
                                </Link>
                              </Button>
                            ) : (
                              <span className="text-xs font-medium text-amber-800">
                                {actionLabel}
                              </span>
                            )
                          )}
                        </div>
                        {blocked && blockMessage && (
                          <p className="mt-2 text-sm text-amber-800">{blockMessage}</p>
                        )}
                        {blocked && fm.missingFields && fm.missingFields.length > 0 && (
                          <p className="mt-1 text-xs text-amber-700">
                            Missing: {fm.missingFields.join(", ")}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {showInviteFamilyGroupMembersLink && (
              <div className="rounded-lg border border-dashed border-indigo-200 bg-indigo-50/50 p-4">
                <p className="text-sm text-slate-600">
                  No other family group members are available to quick add yet.{" "}
                  <Link
                    href={PROFILE_FAMILY_GROUP_RETURN_TO_BOOK}
                    className="font-medium text-indigo-700 underline underline-offset-4 hover:text-indigo-800"
                  >
                    Invite family group members
                  </Link>
                  .
                </p>
              </div>
            )}
            <GuestForm
              guests={guests}
              onGuestsChange={handleGuestsChange}
              maxGuests={lodgeCapacity}
              bookingCheckIn={checkIn ? formatLocalDateOnly(checkIn) : undefined}
              bookingCheckOut={checkOut ? formatLocalDateOnly(checkOut) : undefined}
              perGuestDatesEnabled={perGuestDatesEnabled}
              onPerGuestDatesEnabledChange={handlePerGuestDatesEnabledChange}
              multiDateRangesEnabled={multiDateRangesEnabled}
              onMultiDateRangesEnabledChange={handleMultiDateRangesEnabledChange}
              nightlyPriceForGuest={(guestIndex, nightKey) => {
                const g = priceQuote?.guests[guestIndex];
                if (!g?.perNightCents || !g?.nightDates) return null;
                const idx = g.nightDates.findIndex(
                  (d) => d.slice(0, 10) === nightKey,
                );
                return idx >= 0 ? g.perNightCents[idx] : null;
              }}
            />
            <div className="flex justify-between pt-4">
              <Button variant="outline" onClick={() => setStep("dates")}>
                Back
              </Button>
              <Button onClick={handleGuestsDone} disabled={priceLoading || guests.length === 0}>
                {priceLoading ? "Calculating price..." : "Continue"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 3: Review */}
      {step === "review" && priceQuote && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Booking Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-gray-500">Check-in:</span>{" "}
                  <span className="font-medium">
                    {checkIn!.toLocaleDateString("en-NZ", {
                      weekday: "short", day: "numeric", month: "short", year: "numeric",
                    })}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500">Check-out:</span>{" "}
                  <span className="font-medium">
                    {checkOut!.toLocaleDateString("en-NZ", {
                      weekday: "short", day: "numeric", month: "short", year: "numeric",
                    })}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500">Nights:</span>{" "}
                  <span className="font-medium">{nights}</span>
                </div>
                <div>
                  <span className="text-gray-500">Guests:</span>{" "}
                  <span className="font-medium">{guests.length}</span>
                </div>
              </div>

              <div className="border-t pt-4">
                <h4 className="font-medium mb-2">Guests</h4>
                {reviewGuestPayload.map((g, i) => {
                  const stayStart = g.stayStart ?? bookingDateStrings?.checkIn;
                  const stayEnd = g.stayEnd ?? bookingDateStrings?.checkOut;
                  const guestNights = priceQuote.guests[i]?.nights ?? 0;

                  return (
                    <div key={i} className="flex justify-between gap-3 text-sm py-1">
                      <span>
                        {g.firstName} {g.lastName} ({g.ageTier}, {g.isMember ? "Member" : "Non-member"})
                        {perGuestDatesEnabled && stayStart && stayEnd && (
                          <span className="block text-xs text-gray-500">
                            Date In {stayStart} - Date Out {stayEnd} ({guestNights} night{guestNights === 1 ? "" : "s"})
                          </span>
                        )}
                      </span>
                      <span className="font-medium">
                        {formatCents(priceQuote.guests[i]?.priceCents || 0)}
                      </span>
                    </div>
                  );
                })}
              </div>

              {appliedPromo && appliedPromo.promoAdjustmentCents !== 0 ? (
                <>
                  <div className="border-t pt-4 flex justify-between text-sm">
                    <span>Subtotal</span>
                    <span>{formatCents(priceQuote.totalPriceCents)}</span>
                  </div>
                  <div className={`flex justify-between text-sm ${appliedPromo.promoAdjustmentCents > 0 ? "text-orange-700" : "text-green-600"}`}>
                    <span>
                      {appliedPromo.workPartyEvent
                        ? `Working bee discount (${appliedPromo.workPartyEvent.name})`
                        : `Promo adjustment (${appliedPromo.code})`}
                    </span>
                    <span>{formatSignedCents(appliedPromo.promoAdjustmentCents)}</span>
                  </div>
                  {appliedCreditCents > 0 && (
                    <div className="flex justify-between text-sm text-green-600">
                      <span>Account credit</span>
                      <span>-{formatCents(appliedCreditCents)}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-bold text-lg">
                    <span>{appliedCreditCents > 0 ? "Remaining to pay" : "Total"}</span>
                    <span>{formatCents(remainingToPay)}</span>
                  </div>
                </>
              ) : (
                <>
                  {appliedCreditCents > 0 && (
                    <>
                      <div className="border-t pt-4 flex justify-between text-sm">
                        <span>Subtotal</span>
                        <span>{formatCents(priceQuote.totalPriceCents)}</span>
                      </div>
                      <div className="flex justify-between text-sm text-green-600">
                        <span>Account credit</span>
                        <span>-{formatCents(appliedCreditCents)}</span>
                      </div>
                    </>
                  )}
                  <div className={`${appliedCreditCents === 0 ? "border-t pt-4 " : ""}flex justify-between font-bold text-lg`}>
                    <span>{appliedCreditCents > 0 ? "Remaining to pay" : "Total"}</span>
                    <span>{formatCents(remainingToPay)}</span>
                  </div>
                </>
              )}

              {availableCreditCents > 0 && (
                <div className="rounded-md bg-green-50 border border-green-200 p-4 mt-2">
                  <p className="text-sm text-green-800 mb-2">
                    You have <strong>{formatCents(availableCreditCents)}</strong> in account credit
                  </p>
                  <label className="flex items-center gap-2 text-sm text-green-800 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={useCredit}
                      onChange={(e) => setUseCredit(e.target.checked)}
                      className="rounded border-green-300"
                    />
                    Apply credit to this booking
                  </label>
                  {useCredit && remainingToPay === 0 && (
                    <p className="mt-2 text-sm font-medium text-green-700">
                      Credit covers entire booking — no card payment needed
                    </p>
                  )}
                </div>
              )}

              {showPaymentMethodChoice && (
                <div className="space-y-3 rounded-md border border-slate-200 p-4">
                  <p className="text-sm font-medium text-slate-900">Payment method</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => setPaymentMethod("stripe")}
                      className={`flex min-h-20 items-start gap-3 rounded-md border p-3 text-left text-sm ${
                        paymentMethod === "stripe"
                          ? "border-blue-500 bg-blue-50 text-blue-950"
                          : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                      }`}
                    >
                      <CreditCard className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>
                        <span className="block font-medium">Card</span>
                        <span className="block text-xs opacity-80">
                          Pay now and secure the booking immediately.
                        </span>
                      </span>
                    </button>
                    {internetBankingEnabled && (
                      <button
                        type="button"
                        onClick={() => setPaymentMethod("internet_banking")}
                        className={`flex min-h-20 items-start gap-3 rounded-md border p-3 text-left text-sm ${
                          paymentMethod === "internet_banking"
                            ? "border-blue-500 bg-blue-50 text-blue-950"
                            : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                        }`}
                      >
                        <Landmark className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>
                          <span className="block font-medium">Internet Banking</span>
                          <span className="block text-xs opacity-80">
                            Receive a Xero invoice by email.
                          </span>
                        </span>
                      </button>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="notes">Notes (optional)</Label>
                <Input
                  id="notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Any special requirements..."
                />
              </div>
              {requiresAdminReviewLocal && (
                <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-4">
                  <Label htmlFor="review-justification" className="text-amber-900">
                    Reason for booking without an adult guest (required)
                  </Label>
                  <p className="text-sm text-amber-900">
                    This booking includes minors but no adult. Please explain why so an
                    admin can review. The booking will be held until an admin approves it,
                    and payment cannot be taken until then.
                  </p>
                  <Textarea
                    id="review-justification"
                    value={memberReviewJustification}
                    onChange={(e) => setMemberReviewJustification(e.target.value)}
                    rows={3}
                    maxLength={1000}
                    placeholder="Explain why an adult is not on the booking..."
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="arrival-time">Expected Arrival Time (optional)</Label>
                <TimePicker
                  value={expectedArrivalTime}
                  onChange={setExpectedArrivalTime}
                />
              </div>
              {roomRequestEnabled && roomOptions.length > 0 && (
                <div className="space-y-2">
                  <Label htmlFor="requested-room">Preferred room (optional)</Label>
                  <Select
                    value={requestedRoomId ?? "none"}
                    onValueChange={(value) =>
                      setRequestedRoomId(value === "none" ? null : value)
                    }
                  >
                    <SelectTrigger id="requested-room">
                      <SelectValue placeholder="No preference" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No preference</SelectItem>
                      {roomOptions.map((room) => (
                        <SelectItem key={room.id} value={room.id}>
                          {room.name} ({room.bedCount} {room.bedCount === 1 ? "bed" : "beds"})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    We&apos;ll try to allocate your group to this room, but it
                    isn&apos;t guaranteed if it&apos;s full.
                  </p>
                </div>
              )}
              {activeWorkPartyEvents.length > 0 && (
                <div className="space-y-3 rounded-md border p-4">
                  <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
                    <input
                      type="checkbox"
                      checked={attendingWorkParty}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setAttendingWorkParty(checked);
                        setWorkPartyError("");
                        setWorkPartyClearedNotice(null);
                        if (!checked) {
                          setSelectedWorkPartyEventId(null);
                          setAppliedPromo((current) =>
                            current?.workPartyEvent ? null : current
                          );
                        } else if (activeWorkPartyEvents.length === 1) {
                          setSelectedWorkPartyEventId(activeWorkPartyEvents[0].id);
                        }
                      }}
                      className="rounded border-input"
                      disabled={Boolean(appliedPromo && !appliedPromo.workPartyEvent)}
                    />
                    I am attending a working bee
                  </label>
                  {appliedPromo && !appliedPromo.workPartyEvent && (
                    <p className="text-sm text-muted-foreground">
                      Remove your promo code to select a working bee event — a
                      booking can only use one discount.
                    </p>
                  )}
                  {attendingWorkParty && (
                    <div className="space-y-2">
                      {activeWorkPartyEvents.length > 1 && (
                        <select
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                          value={selectedWorkPartyEventId ?? ""}
                          onChange={(e) =>
                            setSelectedWorkPartyEventId(e.target.value || null)
                          }
                        >
                          <option value="">Select an event…</option>
                          {activeWorkPartyEvents.map((event) => (
                            <option key={event.id} value={event.id}>
                              {event.name} ({event.startDate} – {event.endDate})
                            </option>
                          ))}
                        </select>
                      )}
                      {selectedWorkPartyEventId && (
                        (() => {
                          const event = activeWorkPartyEvents.find(
                            (e) => e.id === selectedWorkPartyEventId
                          );
                          if (!event) return null;
                          return (
                            <p className="text-sm text-muted-foreground">
                              {event.discountPercent}% discount on nights
                              between {event.startDate} and {event.endDate}
                              {event.description ? ` — ${event.description}` : ""}.
                            </p>
                          );
                        })()
                      )}
                      {workPartyError && (
                        <p className="text-sm text-red-600">{workPartyError}</p>
                      )}
                    </div>
                  )}
                </div>
              )}
              {workPartyClearedNotice && (
                <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
                  &ldquo;{workPartyClearedNotice}&rdquo; no longer overlaps your
                  selected dates, so the working bee discount has been
                  cleared.
                </div>
              )}
              {availablePromoCodes.length > 0 && !appliedPromo && !attendingWorkParty && (
                <div className="app-callout-brand p-4">
                  <p className="mb-2 text-sm font-medium text-brand-charcoal">
                    You have promo codes available:
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {availablePromoCodes.map((pc) => (
                      <button
                        key={pc.code}
                        type="button"
                        onClick={() => setPrefillPromoCode(pc.code)}
                        className="app-chip-brand font-mono"
                      >
                        {pc.code}
                        {pc.description && (
                          <span className="font-sans font-normal text-brand-charcoal/75">
                            — {pc.description}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <PromoCodeInput
                checkIn={checkIn!}
                checkOut={checkOut!}
                guests={reviewGuestPayload}
                onPromoApplied={setAppliedPromo}
                appliedPromo={appliedPromo}
                prefillCode={prefillPromoCode}
                disabled={attendingWorkParty}
                disabledReason="A promo code cannot be combined with a working bee discount. Untick 'I am attending a working bee' to enter a code instead."
              />
            </CardContent>
          </Card>

          {guests.some((g) => !g.isMember) && (
            <div className="space-y-3">
              <div className="rounded-md bg-yellow-50 p-4 text-sm text-yellow-800">
                <strong>Note:</strong> This booking includes non-member guests.
                {guests.some((g) => g.isMember)
                  ? " By default your own place is booked and paid for now to hold it, while your non-member guests are held provisionally as a linked booking \u2014 no beds are reserved for them until they are confirmed and paid for closer to check-in. Members have priority if the lodge fills up."
                  : " Your booking is held provisionally until closer to check-in. Members have priority \u2014 no beds are reserved until your booking is confirmed and paid."}
              </div>
              {guests.some((g) => g.isMember) && (
                <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={cancelIfGuestsBumped}
                    onChange={(e) => setCancelIfGuestsBumped(e.target.checked)}
                  />
                  <span>
                    <strong>Only book if my guests can come.</strong> Tick this
                    and we&apos;ll keep your whole party together as a single
                    provisional booking instead of booking your place now:{" "}
                    <strong>no beds are held and nothing is charged up front</strong>
                    , and we only confirm and take payment once your guests are
                    confirmed closer to your stay.
                  </span>
                </label>
              )}
            </div>
          )}

          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStep("guests")}>
              Back
            </Button>
            <div className="flex gap-3">
              <Button
                variant="outline"
                onClick={handleSaveAsDraft}
                disabled={savingDraft || submitting}
              >
                {savingDraft ? "Saving draft..." : "Save as Draft"}
              </Button>
              <Button onClick={handleSubmit} disabled={submitting || savingDraft} size="lg">
                {submitting ? "Creating booking..." : "Confirm Booking"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
