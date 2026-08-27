"use client";

import type { AgeTier } from "@prisma/client";
import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookingCalendar } from "@/components/booking-calendar";
import { GuestForm, type GuestData } from "@/components/guest-form";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useClubIdentity } from "@/components/club-identity-provider";
import { LodgeSelect, useLodgeOptions } from "@/components/lodge-select";
import { LodgeOptionsUnavailableNotice } from "@/components/admin/lodge-options-status";
import { PromoCodeInput, type PromoResult } from "@/components/promo-code-input";
import { TimePicker } from "@/components/time-picker";
import { MemberPicker } from "@/components/admin/member-picker";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  NonMemberContactForm,
  type NonMemberOwner,
} from "@/components/admin/non-member-contact-form";
import { useClubTime } from "@/components/club-time-provider";
import {
  countClubNights,
  formatClubDate,
  formatClubWeekdayDate,
  parseCalendarDate,
} from "@/lib/club-time";

import { CreditCard, Landmark } from "lucide-react";

type BookingPaymentMethod = "stripe" | "internet_banking";

/**
 * A lodge night held in state as a `yyyy-MM-dd` string (#2474) — a CALENDAR
 * DATE, which takes no timezone at all (CT-4, #2870). The old spelling parsed
 * it to a UTC-midnight `Date` and handed that to the INSTANT formatter, which
 * projected it through `APP_TIME_ZONE`; for a club behind UTC that named the
 * night before. An empty or malformed value renders as itself rather than
 * throwing while the operator is still choosing dates.
 */
function formatLodgeNight(value: string | null): string {
  const day = value === null ? null : parseCalendarDate(value);
  return day ? formatClubDate(day) : (value ?? "");
}

/** {@link formatLodgeNight}, weekday-bearing — "Thu, 16 Apr 2026". */
function formatLodgeNightWithWeekday(value: string | null): string {
  const day = value === null ? null : parseCalendarDate(value);
  return day ? formatClubWeekdayDate(day) : (value ?? "");
}

/**
 * Whole lodge nights between the two chosen days. `countClubNights` is calendar
 * arithmetic rather than a millisecond division, which `CLUB_TIME_KERNEL.md`
 * bans because a night across a DST transition is 23 or 25 hours.
 */
function countStayNights(checkIn: string | null, checkOut: string | null): number {
  const from = checkIn === null ? null : parseCalendarDate(checkIn);
  const to = checkOut === null ? null : parseCalendarDate(checkOut);
  return from && to ? countClubNights(from, to) : 0;
}

interface FamilyMember {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  relationship: "self" | "partner" | "dependent";
}

interface PriceQuote {
  guests: {
    ageTier: string;
    isMember: boolean;
    nights: number;
    priceCents: number;
  }[];
  totalPriceCents: number;
  availableCreditCents?: number;
}

interface SelectedMember {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  ageTier: string;
  // Set when the owner is an inline-created non-login NON_MEMBER (#1935): the
  // notify dialog defaults to "don't notify" and reworded, and a placeholder
  // (no-email) owner is never emailed at all.
  isNonMember?: boolean;
  isPlaceholderEmail?: boolean;
}

export default function AdminBookPage() {
  const clubTime = useClubTime();
  const router = useRouter();
  // Booking on behalf writes POST /api/bookings, which admits only a
  // bookings-manage (bookings:edit) actor. A view-only bookings admin can walk
  // the wizard but cannot create/confirm the booking (#1997).
  const canEditBookings = useAdminAreaEditAccess("bookings");
  const { lodgeCapacity } = useClubIdentity();
  const [selectedMember, setSelectedMember] = useState<SelectedMember | null>(null);
  // Book for an existing member, or inline-create a non-login non-member owner
  // (#1935). Only meaningful before an owner is selected.
  const [ownerMode, setOwnerMode] = useState<"member" | "nonMember">("member");
  const [step, setStep] = useState<"member" | "dates" | "guests" | "review">("member");
  // Lodge being booked (multi-lodge phase 8). Admin scope lists every active
  // lodge — booking on behalf is the audited path that bypasses member
  // booking restrictions. Hidden with fewer than two lodges (ADR-002).
  const {
    lodges,
    loading: lodgesLoading,
    failed: lodgesFailed,
    forbidden: lodgesForbidden,
    reload: reloadLodges,
  } = useLodgeOptions("admin");
  const [lodgeId, setLodgeId] = useState<string | null>(null);
  const activeLodgeIdRef = useRef<string | null>(lodgeId);
  const dateSelectionSequenceRef = useRef(0);
  const dateSelectionAbortRef = useRef<AbortController | null>(null);
  const quoteSequenceRef = useRef(0);
  const quoteAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    activeLodgeIdRef.current = lodgeId;
  }, [lodgeId]);
  useEffect(
    () => () => {
      dateSelectionAbortRef.current?.abort();
      quoteAbortRef.current?.abort();
    },
    [],
  );
  // #2701: the lodge this booking will be written against, named on screen
  // before anything is written. Null means the page cannot say — and the create
  // is refused server-side rather than defaulted, so it is never a silent
  // choice.
  const selectedLodge = lodges.find((lodge) => lodge.id === lodgeId) ?? null;
  // Lodge nights are NZ date-only `yyyy-MM-dd` strings end-to-end (#2474).
  const [checkIn, setCheckIn] = useState<string | null>(null);
  const [checkOut, setCheckOut] = useState<string | null>(null);
  const [guests, setGuests] = useState<GuestData[]>([]);
  const [notes, setNotes] = useState("");
  const [memberReviewJustification, setMemberReviewJustification] = useState("");
  const [priceQuote, setPriceQuote] = useState<PriceQuote | null>(null);
  const [priceLoading, setPriceLoading] = useState(false);
  const [error, setError] = useState("");
  // The admin-audience `reason` a XERO_LOCK_DATE_CHECK_FAILED 503 carries
  // (#2105) — drives the "Go to Xero setup" link on a reconnect-required cause.
  const [errorReason, setErrorReason] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [availableBeds, setAvailableBeds] = useState(lodgeCapacity);
  // Server-resolved capacity of the SELECTED lodge (per-night occupied +
  // available from /api/availability/check). The club-identity figure is only
  // a pre-selection fallback — a capped or secondary lodge resolves lower, and
  // the create route hard-400s a party above the resolved value (#1767).
  const [resolvedCapacity, setResolvedCapacity] = useState(lodgeCapacity);
  const [appliedPromo, setAppliedPromo] = useState<PromoResult | null>(null);
  const [expectedArrivalTime, setExpectedArrivalTime] = useState<string | null>(null);
  const [useCredit, setUseCredit] = useState(false);
  const [familyMembers, setFamilyMembers] = useState<FamilyMember[]>([]);
  const [internetBankingEnabled, setInternetBankingEnabled] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<BookingPaymentMethod>("stripe");
  // Retroactive booking (#1695): record a stay that already happened.
  const [allowPastDates, setAllowPastDates] = useState(false);
  // Per-create member-email choice dialog (shown for every on-behalf confirm).
  const [notifyDialogOpen, setNotifyDialogOpen] = useState(false);
  // Over-capacity warn-and-confirm nights returned by the server, plus the
  // email choice to preserve across the confirm resubmit.
  const [overCapacityNights, setOverCapacityNights] = useState<
    { date: string; availableBeds: number }[] | null
  >(null);
  const [pendingNotifyMember, setPendingNotifyMember] = useState(true);
  // Adult-member hosting warn-and-confirm (#2364, epic decision D-R4). The
  // server refuses an ON-BEHALF create that trips the club's hosting rule until
  // the admin states a reason, which is then stored against the booking's
  // APPROVED hosting review — that refusal is the whole point (an admin must
  // not accept a hosting exception by accident), so this panel is the half that
  // makes it answerable. `pendingHostingAction` remembers whether it was the
  // confirm or the draft that was refused, because the check runs BEFORE the
  // draft/confirmed fork and so blocks both.
  const [hostingConfirmMessage, setHostingConfirmMessage] = useState<string | null>(
    null,
  );
  const [pendingHostingAction, setPendingHostingAction] = useState<
    "confirm" | "draft"
  >("confirm");
  const [adultMemberHostingReason, setAdultMemberHostingReason] = useState("");

  // A retroactive booking is one whose check-in is genuinely in the past, with
  // the flag on. Drives the guest-cap relaxation and the POST body. Compared as
  // date-only strings (#2474): a lexicographic compare of `yyyy-MM-dd` values is
  // a chronological one.
  //
  // CT-4 (#2870) changed WHOSE today. It was the BROWSER's calendar day
  // (`new Date()` read with host-local getters), so an admin in London booking
  // at 21:00 their time — already tomorrow at the lodge — was told a stay
  // starting today was retroactive, and the retroactive rules applied to a
  // booking that is not one. "Today" for a club rule comes from club time
  // (rule 4; INV-CONFIG-002), and the server decides the same way.
  const todayStr = clubTime.today();
  const isRetroactive =
    allowPastDates && checkIn !== null && checkIn < todayStr;

  // Fetch family members for the selected member
  useEffect(() => {
    if (!selectedMember) {
      return;
    }

    let cancelled = false;

    // Bookings-scoped on-behalf picker gated on bookings:edit (not
    // membership:view), so a Booking Officer without membership:view still
    // gets the selected member's family and correct member pricing (#1376).
    fetch(`/api/admin/bookings/eligible-family?forMemberId=${selectedMember.id}`)
      .then((res) => (res.ok ? res.json() : { familyMembers: [] }))
      .then((data) => {
        if (!cancelled) {
          setFamilyMembers(data.familyMembers || []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFamilyMembers([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedMember]);

  function invalidatePendingDateSelection(
    nextLodgeId = activeLodgeIdRef.current,
  ) {
    activeLodgeIdRef.current = nextLodgeId;
    dateSelectionSequenceRef.current += 1;
    const pendingRequest = dateSelectionAbortRef.current;
    dateSelectionAbortRef.current = null;
    pendingRequest?.abort();
  }

  function invalidatePendingQuote() {
    quoteSequenceRef.current += 1;
    quoteAbortRef.current?.abort();
    quoteAbortRef.current = null;
    setPriceLoading(false);
  }

  function handleMemberSelect(member: SelectedMember) {
    invalidatePendingDateSelection();
    invalidatePendingQuote();
    setSelectedMember(member);
    setFamilyMembers([]);
    setStep("dates");
    // Reset wizard state
    setCheckIn(null);
    setCheckOut(null);
    setGuests([]);
    setNotes("");
    setPriceQuote(null);
    setAppliedPromo(null);
    setExpectedArrivalTime(null);
    setUseCredit(false);
    setError("");
    setAllowPastDates(false);
    setOverCapacityNights(null);
    setAvailableBeds(lodgeCapacity);
    setResolvedCapacity(lodgeCapacity);
  }

  // An inline-created / picked non-login non-member owner (#1935) proceeds
  // through the identical dates/guests/quote/create flow as a member owner.
  function handleNonMemberSelected(owner: NonMemberOwner) {
    handleMemberSelect({
      id: owner.id,
      firstName: owner.firstName,
      lastName: owner.lastName,
      email: owner.email,
      ageTier: "ADULT",
      isNonMember: true,
      isPlaceholderEmail: owner.isPlaceholderEmail,
    });
  }

  function handleMemberClear() {
    invalidatePendingDateSelection();
    invalidatePendingQuote();
    setSelectedMember(null);
    setStep("member");
    setCheckIn(null);
    setCheckOut(null);
    setGuests([]);
    setNotes("");
    setPriceQuote(null);
    setAppliedPromo(null);
    setExpectedArrivalTime(null);
    setUseCredit(false);
    setError("");
    setFamilyMembers([]);
    setAllowPastDates(false);
    setOverCapacityNights(null);
    setAvailableBeds(lodgeCapacity);
    setResolvedCapacity(lodgeCapacity);
  }

  function addFamilyMemberAsGuest(fm: FamilyMember) {
    if (guests.some((g) => g.memberId === fm.id)) return;
    // Admin creates may exceed the live availability (over-capacity is
    // warn-and-confirm at submit, #1695/#1767), so cap by the selected
    // lodge's resolved capacity — the create route's hard party-size limit.
    if (guests.length >= resolvedCapacity) return;
    setGuests([
      ...guests,
      {
        firstName: fm.firstName,
        lastName: fm.lastName,
        ageTier: fm.ageTier,
        isMember: true,
        memberId: fm.id,
      },
    ]);
  }

  function handleLodgeChange(nextLodgeId: string | null) {
    if (nextLodgeId === lodgeId) return;
    const hadLodge = lodgeId !== null;
    // Invalidate a pending Lodge A availability request synchronously. Waiting
    // for React's next effect leaves a small window where its response can
    // advance Lodge B's wizard or install Lodge A's capacity under Lodge B's
    // selector.
    invalidatePendingDateSelection(nextLodgeId);
    invalidatePendingQuote();
    setLodgeId(nextLodgeId);
    if (!hadLodge) return;
    // Availability, pricing, and promos are all per lodge: switching lodges
    // restarts from date selection.
    if (step === "guests" || step === "review") setStep("dates");
    setCheckIn(null);
    setCheckOut(null);
    setPriceQuote(null);
    setAppliedPromo(null);
    setUseCredit(false);
    setError("");
    setAllowPastDates(false);
    setOverCapacityNights(null);
    setAvailableBeds(lodgeCapacity);
    // The next date selection re-resolves the new lodge's capacity.
    setResolvedCapacity(lodgeCapacity);
  }

  async function handleDateSelect(ci: string, co: string) {
    const requestedLodgeId = lodgeId;
    const sequence = (dateSelectionSequenceRef.current += 1);
    dateSelectionAbortRef.current?.abort();
    const controller = new AbortController();
    dateSelectionAbortRef.current = controller;
    const ownsCurrentLodge = () =>
      sequence === dateSelectionSequenceRef.current &&
      activeLodgeIdRef.current === requestedLodgeId;
    setCheckIn(ci);
    setCheckOut(co);
    setError("");
    // A prior 409 confirm panel belongs to the previous dates/party; a stale
    // one must not offer a pre-authorised overbook of the new selection.
    setOverCapacityNights(null);
    const ciStr = ci;
    const coStr = co;

    try {
      const res = await fetch(
        `/api/availability/check?checkIn=${ciStr}&checkOut=${coStr}${
          requestedLodgeId
            ? `&lodgeId=${encodeURIComponent(requestedLodgeId)}`
            : ""
        }`,
        { signal: controller.signal },
      );
      if (!ownsCurrentLodge()) return;
      if (res.ok) {
        const data = await res.json();
        if (!ownsCurrentLodge()) return;
        setAvailableBeds(data.minAvailable);
        const night = Array.isArray(data.nightDetails)
          ? data.nightDetails[0]
          : null;
        if (
          night &&
          typeof night.occupiedBeds === "number" &&
          typeof night.availableBeds === "number"
        ) {
          setResolvedCapacity(night.occupiedBeds + night.availableBeds);
        }
      }

      if (!ownsCurrentLodge()) return;
      // Admin bypasses minimum stay — skip policy check
      setStep("guests");
    } catch (requestError) {
      if (
        requestError instanceof DOMException &&
        requestError.name === "AbortError"
      ) {
        return;
      }
      throw requestError;
    } finally {
      if (dateSelectionAbortRef.current === controller) {
        dateSelectionAbortRef.current = null;
      }
    }
  }

  async function handleGuestsDone() {
    if (guests.length === 0) {
      setError("Add at least one guest");
      return;
    }

    for (const g of guests) {
      if (!g.firstName.trim() || !g.lastName.trim()) {
        setError("All guests must have first and last names");
        return;
      }
    }

    // Admin creates can exceed live availability — over-capacity becomes a
    // warn-and-confirm at submit, not a hard block here (#1695/#1767). The
    // warning banner above the guest list flags the shortfall. A confirm
    // panel from a previous 409 belongs to the previous party — clear it.
    setOverCapacityNights(null);
    // Same for the hosting reason (#2364): it was written about the previous
    // party's uncovered nights, and this party's may be entirely different.
    setHostingConfirmMessage(null);
    setAdultMemberHostingReason("");
    setError("");
    const requestedLodgeId = lodgeId;
    if (!requestedLodgeId || !checkIn || !checkOut || !selectedMember) {
      /*
        #2887 review (F4): name only the controls that are actually on screen.
        With a failed or forbidden lodge list the selector is not rendered, so
        "Choose a lodge" pointed at nothing and read as operator error.
      */
      setError(
        requestedLodgeId
          ? "Choose dates and a booking owner before continuing"
          : "The lodge list could not be loaded, so this booking cannot say which lodge it is for. Retry above, then choose dates and a booking owner.",
      );
      return;
    }
    const requestedMemberId = selectedMember.id;
    const sequence = ++quoteSequenceRef.current;
    quoteAbortRef.current?.abort();
    const controller = new AbortController();
    quoteAbortRef.current = controller;
    const ownsQuote = () =>
      sequence === quoteSequenceRef.current &&
      activeLodgeIdRef.current === requestedLodgeId;
    setPriceLoading(true);
    const checkInStr = checkIn!;
    const checkOutStr = checkOut!;

    try {
      const res = await fetch("/api/bookings/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          checkIn: checkInStr,
          checkOut: checkOutStr,
          lodgeId: requestedLodgeId,
          guests: guests.map((g) => ({
            ageTier: g.ageTier,
            isMember: g.isMember,
            memberId: g.memberId,
          })),
          forMemberId: requestedMemberId,
        }),
      });
      const data = await res.json();
      if (!ownsQuote()) return;
      if (res.ok) {
        setPriceQuote(data);
        setStep("review");
      } else {
        setError(data.error || "Failed to calculate price");
      }
    } catch (quoteError) {
      if (quoteError instanceof DOMException && quoteError.name === "AbortError") return;
      if (ownsQuote()) setError("Failed to calculate price");
    } finally {
      if (ownsQuote()) setPriceLoading(false);
      if (quoteAbortRef.current === controller) quoteAbortRef.current = null;
    }
  }

  const requiresAdminReviewLocal = (() => {
    if (guests.length === 0) return false;
    const hasAdult = guests.some((g) => g.ageTier === "ADULT");
    const hasMinor = guests.some(
      (g) => g.ageTier === "YOUTH" || g.ageTier === "CHILD" || g.ageTier === "INFANT",
    );
    return hasMinor && !hasAdult;
  })();

  // Internet Banking is an optional module; only offer it when it's on.
  useEffect(() => {
    fetch("/api/payments/options")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) =>
        setInternetBankingEnabled(
          Boolean(data?.methods?.internetBanking?.enabled)
        )
      )
      .catch(() => setInternetBankingEnabled(false));
  }, []);

  // Every on-behalf confirm asks whether the member is emailed before it posts
  // (#1695 / #1685 pattern). The "Confirm Booking" button opens the dialog.
  function handleConfirmClick() {
    setError("");
    setOverCapacityNights(null);
    // A walk-in placeholder owner (#1935) has no deliverable address, so there
    // is no email choice to make — create without emailing (the server also
    // suppresses any owner email to a placeholder address).
    if (selectedMember?.isPlaceholderEmail) {
      void submitBooking({ notifyMember: false });
      return;
    }
    setNotifyDialogOpen(true);
  }

  async function submitBooking(opts: {
    notifyMember: boolean;
    confirmOverCapacity?: boolean;
    hostingReason?: string;
  }) {
    setSubmitting(true);
    setError("");
    setErrorReason(null);
    const checkInStr = checkIn!;
    const checkOutStr = checkOut!;

    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checkIn: checkInStr,
        checkOut: checkOutStr,
        guests,
        notes: notes || undefined,
        promoCode: appliedPromo?.code || undefined,
        promoGuestIndexes: appliedPromo?.selectedGuestIndexes,
        expectedArrivalTime: expectedArrivalTime || undefined,
        applyCreditCents: appliedCreditCents > 0 ? appliedCreditCents : undefined,
        lodgeId,
        forMemberId: selectedMember!.id,
        paymentMethod:
          showPaymentMethodChoice && paymentMethod === "internet_banking"
            ? "internet_banking"
            : "stripe",
        memberReviewJustification: requiresAdminReviewLocal
          ? memberReviewJustification.trim() || undefined
          : undefined,
        notifyMember: opts.notifyMember,
        // allowPastDates only when the check-in is genuinely in the past; the
        // server rejects the flag with a future check-in.
        ...(isRetroactive ? { allowPastDates: true } : {}),
        ...(opts.confirmOverCapacity ? { confirmOverCapacity: true } : {}),
        ...(opts.hostingReason
          ? { adultMemberHostingReason: opts.hostingReason }
          : {}),
      }),
    });

    if (res.ok) {
      const data = await res.json();
      router.push(`/bookings/${data.id}`);
      return;
    }

    const data = await res.json();
    // Over-capacity warn-and-confirm: show the shortfall and let the admin
    // resubmit with confirmOverCapacity, preserving the email choice.
    if (data.code === "OVER_CAPACITY_CONFIRM_REQUIRED") {
      setOverCapacityNights(
        Array.isArray(data.nightDetails) ? data.nightDetails : [],
      );
      setPendingNotifyMember(opts.notifyMember);
      setSubmitting(false);
      return;
    }
    // Adult-member hosting (#2364 D-R4): the same warn-and-confirm shape, but
    // what the admin supplies is a REASON rather than a tick — it is stored
    // against the booking as the record of who accepted the hazard and why.
    if (data.code === "ADULT_MEMBER_HOSTING_CONFIRM_REQUIRED") {
      setHostingConfirmMessage(
        typeof data.details === "string" && data.details
          ? data.details
          : typeof data.error === "string"
            ? data.error
            : "This booking has non-member guests on nights when no adult member is staying.",
      );
      setPendingHostingAction("confirm");
      setPendingNotifyMember(opts.notifyMember);
      setSubmitting(false);
      return;
    }
    // XERO_PERIOD_LOCKED / XERO_LOCK_DATE_CHECK_FAILED and every other error
    // surface verbatim in the existing banner. A reconnect-required lock-date
    // check failure additionally offers a link to the Xero setup page (#2105).
    setError(data.error || "Failed to create booking");
    setErrorReason(typeof data.reason === "string" ? data.reason : null);
    setSubmitting(false);
  }

  async function handleSaveAsDraft(opts: { hostingReason?: string } = {}) {
    setSavingDraft(true);
    setError("");
    const checkInStr = checkIn!;
    const checkOutStr = checkOut!;

    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checkIn: checkInStr,
        checkOut: checkOutStr,
        guests,
        notes: notes || undefined,
        promoCode: appliedPromo?.code || undefined,
        promoGuestIndexes: appliedPromo?.selectedGuestIndexes,
        expectedArrivalTime: expectedArrivalTime || undefined,
        applyCreditCents: appliedCreditCents > 0 ? appliedCreditCents : undefined,
        lodgeId,
        draft: true,
        forMemberId: selectedMember!.id,
        memberReviewJustification: requiresAdminReviewLocal
          ? memberReviewJustification.trim() || undefined
          : undefined,
        ...(opts.hostingReason
          ? { adultMemberHostingReason: opts.hostingReason }
          : {}),
      }),
    });

    if (res.ok) {
      const data = await res.json();
      router.push(`/bookings/${data.id}`);
      return;
    }

    const data = await res.json();
    // The hosting check runs before the draft/confirmed fork, so a draft trips
    // it on exactly the same parties a confirm does (#2364).
    if (data.code === "ADULT_MEMBER_HOSTING_CONFIRM_REQUIRED") {
      setHostingConfirmMessage(
        typeof data.details === "string" && data.details
          ? data.details
          : typeof data.error === "string"
            ? data.error
            : "This booking has non-member guests on nights when no adult member is staying.",
      );
      setPendingHostingAction("draft");
      setSavingDraft(false);
      return;
    }
    setError(data.error || "Failed to save draft");
    setSavingDraft(false);
  }

  // Whole date-only nights between the two lodge dates — see `countStayNights`.
  const nights = countStayNights(checkIn, checkOut);

  function formatCents(cents: number) {
    return `$${(cents / 100).toFixed(2)}`;
  }

  function formatSignedCents(cents: number) {
    const prefix = cents > 0 ? "+" : "-";
    return `${prefix}${formatCents(Math.abs(cents))}`;
  }

  const availableCreditCents = priceQuote?.availableCreditCents ?? 0;
  const finalPriceBeforeCredit = priceQuote
    ? (appliedPromo?.finalPriceCents ?? priceQuote.totalPriceCents)
    : 0;
  const appliedCreditCents = useCredit
    ? Math.min(availableCreditCents, finalPriceBeforeCredit)
    : 0;
  const remainingToPay = finalPriceBeforeCredit - appliedCreditCents;
  const showPaymentMethodChoice = internetBankingEnabled && remainingToPay > 0;

  /*
    #2160: the view-only explanation lives here, once, at the top of the page —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before
    its content appears; a region injected already-populated is silently dropped
    by some screen-reader/browser pairings. It sits OUTSIDE the `space-y-6`
    stack so the empty wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEditBookings} className="mb-6">
      Your admin role can view booking tools but cannot create bookings on
      behalf of members.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div className="max-w-3xl">
      {/*
        #2160: on THIS page the heading comes first, so that a screen-reader
        user knows which area they are on before the banner tells them they
        have view-only access to it. `mb-6` replaces the `space-y-6` gap the h1
        had as the stack's first child, so spacing is unchanged in both states:
        the `mb-6` lives on the banner's inner div, which only renders for a
        view-only admin, and the permanently-mounted `role="status"` wrapper an
        edit-capable admin gets has no height and no margin.

        This ordering is NOT the house rule, and is applied only here and on
        `/admin/roster`. Everywhere else the banner is the FIRST child of the
        outermost wrapper, in EVERY render branch, and has to stay there: that
        is what keeps the `role="status"` wrapper in the same DOM position when
        a fetch settles. On a section with a loading or error branch, putting a
        heading above the banner in the loaded branch only makes React
        reconcile child 0 from the live region into the heading and mount a
        fresh, already-populated region below it — precisely the defect the
        mount-order rule in
        `src/components/admin/__tests__/view-only-banner-contract.test.ts`
        exists to prevent.

        This page renders in a single branch, so the reorder is free. Plenty of
        other surfaces are single-branch too and could take it; they have not,
        because doing so would make the banner's position depend on whether a
        section happens to have a loading branch — a property you can not see
        at the render site, and the wrong thing to make a reader check. "Banner
        first, always" stays the shape everywhere else. See
        `docs/ARCHITECTURE.md` for the whole rule.
      */}
      <h1 className="mb-6 text-3xl font-bold">Book on Behalf of Member</h1>
      {viewOnlyBanner}
      <div className="space-y-6">

      {/* Owner selection — pick an existing member, or inline-create a
          non-login non-member owner (#1935). The toggle only shows before an
          owner is chosen; once chosen the MemberPicker's selected card (with a
          "Change" button) is reused for both kinds. */}
      {!selectedMember && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant={ownerMode === "member" ? "default" : "outline"}
            size="sm"
            onClick={() => setOwnerMode("member")}
          >
            Existing member
          </Button>
          <Button
            type="button"
            variant={ownerMode === "nonMember" ? "default" : "outline"}
            size="sm"
            onClick={() => setOwnerMode("nonMember")}
          >
            Non-member booking
          </Button>
        </div>
      )}

      {selectedMember || ownerMode === "member" ? (
        <MemberPicker
          selected={selectedMember}
          onSelect={handleMemberSelect}
          onClear={handleMemberClear}
        />
      ) : (
        <NonMemberContactForm onSelected={handleNonMemberSelected} />
      )}

      {error && (
        <div className="rounded-md bg-danger-3 p-3 text-sm text-danger-11">
          <p>{error}</p>
          {errorReason === "reconnect_required" && (
            <p className="mt-1">
              <Link href="/admin/xero/setup" className="font-medium underline">
                Go to Xero setup
              </Link>
            </p>
          )}
        </div>
      )}

      {/* Step indicator — only show after member selected */}
      {selectedMember && (
        <div className="flex items-center gap-2 text-sm">
          <span className={step === "dates" ? "app-step-active" : "text-muted-foreground"}>
            1. Select Dates
          </span>
          <span className="text-muted-foreground">&rarr;</span>
          <span className={step === "guests" ? "app-step-active" : "text-muted-foreground"}>
            2. Add Guests
          </span>
          <span className="text-muted-foreground">&rarr;</span>
          <span className={step === "review" ? "app-step-active" : "text-muted-foreground"}>
            3. Review & Confirm
          </span>
        </div>
      )}

      {/* Step 1: Dates */}
      {step === "dates" && selectedMember && (
        <Card>
          <CardHeader>
            <CardTitle>Select Dates</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/*
              #2701, owner decision 1: the admin is TOLD the lodge list failed,
              rather than being shown a silently-defaulted lodge, and the lodge
              is named on screen before anything is written.

              The wording here used to say they "may CONTINUE" with a failed
              list. They may not, and have not since this branch: the quote and
              the create both hard-refuse without a resolved lodge (see
              `startQuote` above). The notice explains the outage; it does not
              offer a way past it.
            */}
            <LodgeOptionsUnavailableNotice
              failed={lodgesFailed}
              forbidden={lodgesForbidden}
              onRetry={reloadLodges}
              what="the lodge this booking is for"
              className="mb-4"
            />
            <div className="max-w-xs">
              <LodgeSelect
                lodges={lodges}
                value={lodgeId}
                onChange={handleLodgeChange}
                loading={lodgesLoading}
              />
            </div>
            {/*
              Always shown, never only in a multi-lodge club: an admin creating a
              booking for somebody else must be able to read back which lodge it
              lands at, and the state where that is unknown is exactly the state
              where the screen used to look normal (#2701).
            */}
            <p className="text-sm" data-testid="admin-book-lodge">
              <span className="text-muted-foreground">Booking at:</span>{" "}
              <span className="font-medium">
                {selectedLodge?.name ?? "not yet known — choose a lodge before booking"}
              </span>
            </p>
            <div className="rounded-md border border-border bg-muted p-3">
              <label className="flex items-start gap-2 text-sm text-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={allowPastDates}
                  onChange={(e) => {
                    setAllowPastDates(e.target.checked);
                    setOverCapacityNights(null);
                    // Unticking must not strand an already-selected past range
                    // that only the server would reject at submit.
                    if (!e.target.checked && checkIn && checkIn < todayStr) {
                      setCheckIn(null);
                      setCheckOut(null);
                    }
                  }}
                  className="mt-0.5 rounded border-border"
                />
                <span>
                  <span className="font-medium">
                    Record a past stay (retroactive booking)
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Someone already stayed — record the booking after the fact.
                    Allowed up to 365 days back.
                  </span>
                </span>
              </label>
            </div>
            <BookingCalendar
              onDateSelect={handleDateSelect}
              selectedCheckIn={checkIn}
              selectedCheckOut={checkOut}
              lodgeId={lodgeId}
              allowPastDates={allowPastDates}
              allowFullDates
            />
          </CardContent>
        </Card>
      )}

      {/* Step 2: Guests */}
      {step === "guests" && selectedMember && (
        <Card>
          <CardHeader>
            <CardTitle>
              Add Guests
              {checkIn && checkOut && (
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {formatLodgeNight(checkIn)} -{" "}
                  {formatLodgeNight(checkOut)} ({nights} night
                  {nights !== 1 ? "s" : ""})
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {guests.length > availableBeds && (
              <div className="rounded-md bg-warning-3 p-3 text-sm text-warning-11">
                This booking exceeds the {availableBeds} bed
                {availableBeds === 1 ? "" : "s"} available for these dates.
                You can still create it — you will confirm the over-capacity
                override at the final step.
              </div>
            )}
            {familyMembers.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground">
                  Quick add {selectedMember.firstName}&apos;s family members
                </p>
                <div className="flex flex-wrap gap-2">
                  {familyMembers.map((fm) => {
                    const alreadyAdded = guests.some((g) => g.memberId === fm.id);
                    const label =
                      fm.relationship === "self"
                        ? `${fm.firstName} ${fm.lastName}`
                        : `${fm.firstName} ${fm.lastName} (${fm.ageTier})`;
                    return (
                      <Button
                        key={fm.id}
                        type="button"
                        variant={
                          alreadyAdded
                            ? "secondary"
                            : fm.relationship === "self"
                              ? "default"
                              : "outline"
                        }
                        size="sm"
                        disabled={
                          alreadyAdded || guests.length >= resolvedCapacity
                        }
                        onClick={() => addFamilyMemberAsGuest(fm)}
                      >
                        {alreadyAdded ? "\u2713 " : "+ "}
                        {label}
                      </Button>
                    );
                  })}
                </div>
              </div>
            )}
            {/*
              NO "+ Add Member Guest" HERE, and it is a real limitation rather
              than an oversight (MG4 #2309, declared and documented in
              `docs/guides/book.md` Step 2).

              The officer's member finder is BOOKING-SCOPED —
              `/api/admin/bookings/[id]/member-guest-candidates` — because that
              is what lets the lookup be gated and audited against a booking
              that exists. This is a creation wizard: there is no booking id to
              scope it to. The alternatives were both worse. Pointing the panel
              at the MEMBER routes would apply the club's member-facing privacy
              gate and the member rate limits to an officer, which is exactly
              what owner decision D-20 rules out. Minting a second,
              booking-less admin find endpoint would be a new unaudited-by-
              booking lookup surface over the whole membership roll, added on a
              stacked branch, to save one step.

              The server side is NOT the constraint: `POST /api/bookings`
              already accepts a cross-family member link on an authorised
              on-behalf create. So the workaround is complete rather than
              partial — create the booking, then add the member guest from its
              edit panel, which writes the same consent record and sends the
              same email. Wiring a picker here belongs in its own issue with the
              endpoint question answered first.
            */}
            <GuestForm
              guests={guests}
              onGuestsChange={setGuests}
              maxGuests={resolvedCapacity}
            />
            <div className="flex justify-between pt-4">
              <Button
                variant="outline"
                onClick={() => {
                  invalidatePendingQuote();
                  setStep("dates");
                }}
              >
                Back
              </Button>
              <Button
                onClick={handleGuestsDone}
                disabled={priceLoading || guests.length === 0}
              >
                {priceLoading ? "Calculating price..." : "Continue"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 3: Review */}
      {step === "review" && priceQuote && selectedMember && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Booking Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground">Check-in:</span>{" "}
                  <span className="font-medium">
                    {formatLodgeNightWithWeekday(checkIn)}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Check-out:</span>{" "}
                  <span className="font-medium">
                    {formatLodgeNightWithWeekday(checkOut)}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Nights:</span>{" "}
                  <span className="font-medium">{nights}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Guests:</span>{" "}
                  <span className="font-medium">{guests.length}</span>
                </div>
              </div>

              <div className="border-t pt-4">
                <h4 className="font-medium mb-2">Guests</h4>
                {guests.map((g, i) => (
                  <div key={i} className="flex justify-between text-sm py-1">
                    <span>
                      {g.firstName} {g.lastName} ({g.ageTier},{" "}
                      {g.isMember ? "Member" : "Non-member"})
                    </span>
                    <span className="font-medium">
                      {formatCents(priceQuote.guests[i]?.priceCents || 0)}
                    </span>
                  </div>
                ))}
              </div>

              {appliedPromo && appliedPromo.promoAdjustmentCents !== 0 ? (
                <>
                  <div className="border-t pt-4 flex justify-between text-sm">
                    <span>Subtotal</span>
                    <span>{formatCents(priceQuote.totalPriceCents)}</span>
                  </div>
                  <div className={`flex justify-between text-sm ${appliedPromo.promoAdjustmentCents > 0 ? "text-warning-11" : "text-success-11"}`}>
                    <span>Promo adjustment ({appliedPromo.code})</span>
                    <span>{formatSignedCents(appliedPromo.promoAdjustmentCents)}</span>
                  </div>
                  {appliedCreditCents > 0 && (
                    <div className="flex justify-between text-sm text-success-11">
                      <span>Account credit</span>
                      <span>-{formatCents(appliedCreditCents)}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-bold text-lg">
                    <span>
                      {appliedCreditCents > 0 ? "Remaining to pay" : "Total"}
                    </span>
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
                      <div className="flex justify-between text-sm text-success-11">
                        <span>Account credit</span>
                        <span>-{formatCents(appliedCreditCents)}</span>
                      </div>
                    </>
                  )}
                  <div
                    className={`${appliedCreditCents === 0 ? "border-t pt-4 " : ""}flex justify-between font-bold text-lg`}
                  >
                    <span>
                      {appliedCreditCents > 0 ? "Remaining to pay" : "Total"}
                    </span>
                    <span>{formatCents(remainingToPay)}</span>
                  </div>
                </>
              )}

              {availableCreditCents > 0 && (
                <div className="rounded-md bg-success-3 border border-success-6 p-4 mt-2">
                  <p className="text-sm text-success-11 mb-2">
                    {selectedMember.firstName} has{" "}
                    <strong>{formatCents(availableCreditCents)}</strong> in account
                    credit
                  </p>
                  <label className="flex items-center gap-2 text-sm text-success-11 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={useCredit}
                      onChange={(e) => setUseCredit(e.target.checked)}
                      className="rounded border-success-6"
                    />
                    Apply credit to this booking
                  </label>
                  {useCredit && remainingToPay === 0 && (
                    <p className="mt-2 text-sm font-medium text-success-11">
                      Credit covers entire booking — no card payment needed
                    </p>
                  )}
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
                <div className="space-y-2 rounded-md border border-warning-6 bg-warning-3 p-4">
                  <Label htmlFor="review-justification" className="text-warning-11">
                    Reason for booking without an adult (optional, stored with the booking)
                  </Label>
                  <p className="text-sm text-warning-11">
                    This booking has minors but no adult. Because you are an admin it
                    will be auto-approved, but capturing the reason here documents the
                    decision in the audit trail.
                  </p>
                  <Textarea
                    id="review-justification"
                    value={memberReviewJustification}
                    onChange={(e) => setMemberReviewJustification(e.target.value)}
                    rows={3}
                    maxLength={1000}
                    placeholder="Why is an adult not on this booking?"
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="arrival-time">Expected Arrival Time (optional)</Label>
                {/* #2621: `id` matches the `htmlFor` above, which pointed at
                    nothing — the label neither named nor focused the control. */}
                <TimePicker
                  id="arrival-time"
                  value={expectedArrivalTime}
                  onChange={setExpectedArrivalTime}
                />
              </div>
              <PromoCodeInput
                checkIn={checkIn!}
                checkOut={checkOut!}
                guests={guests}
                onPromoApplied={setAppliedPromo}
                appliedPromo={appliedPromo}
                forMemberId={selectedMember.id}
                lodgeId={lodgeId}
              />
            </CardContent>
          </Card>

          {guests.some((g) => !g.isMember) && (
            <div className="rounded-md bg-warning-3 p-4 text-sm text-warning-11">
              <strong>Note:</strong> This booking includes non-member guests. It may
              be held as PENDING until closer to check-in.
            </div>
          )}

          {showPaymentMethodChoice && (
            <Card>
              <CardContent className="space-y-3 pt-6">
                <p className="text-sm font-medium text-foreground">Payment method</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => setPaymentMethod("stripe")}
                    className={`flex min-h-16 items-start gap-3 rounded-md border p-3 text-left text-sm ${
                      paymentMethod === "stripe"
                        ? "border-info-7 bg-info-3 text-info-11"
                        : "border-border bg-card text-muted-foreground hover:border-muted-foreground"
                    }`}
                  >
                    <CreditCard className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      <span className="block font-medium">Card</span>
                      <span className="block text-xs opacity-80">
                        The member pays by card to secure the booking.
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPaymentMethod("internet_banking")}
                    className={`flex min-h-16 items-start gap-3 rounded-md border p-3 text-left text-sm ${
                      paymentMethod === "internet_banking"
                        ? "border-info-7 bg-info-3 text-info-11"
                        : "border-border bg-card text-muted-foreground hover:border-muted-foreground"
                    }`}
                  >
                    <Landmark className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      <span className="block font-medium">Internet Banking</span>
                      <span className="block text-xs opacity-80">
                        Email the member a Xero invoice to pay by bank transfer.
                      </span>
                    </span>
                  </button>
                </div>
              </CardContent>
            </Card>
          )}

          {isRetroactive && (
            <div className="rounded-md bg-muted border border-border p-3 text-sm text-muted-foreground">
              Recording a past stay ({formatLodgeNight(checkIn)}). The
              member email is optional (you choose on confirm); drafts are not
              available for retroactive bookings.
            </div>
          )}

          {overCapacityNights && (
            <div className="rounded-md border border-warning-6 bg-warning-3 p-4 text-sm text-warning-11">
              <p className="font-medium">Some nights are over lodge capacity</p>
              <ul className="mt-2 list-disc pl-5">
                {overCapacityNights.map((n) => (
                  <li key={n.date}>
                    {n.date}: {Math.abs(n.availableBeds)} over capacity
                  </li>
                ))}
              </ul>
              <ViewOnlyActionButton
                canEdit={canEditBookings}
                describeReason={false}
                className="mt-3"
                variant="destructive"
                disabled={submitting}
                onClick={() =>
                  void submitBooking({
                    notifyMember: pendingNotifyMember,
                    confirmOverCapacity: true,
                  })
                }
              >
                Confirm over-capacity and create
              </ViewOnlyActionButton>
            </div>
          )}

          {hostingConfirmMessage && (
            <div className="rounded-md border border-warning-6 bg-warning-3 p-4 text-sm text-warning-11">
              <p className="font-medium">
                No adult member is staying with these guests
              </p>
              <p className="mt-2">{hostingConfirmMessage}</p>
              <p className="mt-2">
                You can still make this booking. Say why it is alright — your
                reason and your name are recorded against the booking, so the
                club can see later who accepted it.
              </p>
              <Label
                htmlFor="adult-member-hosting-reason"
                className="mt-3 block"
              >
                Reason
              </Label>
              <Textarea
                id="adult-member-hosting-reason"
                className="mt-1 bg-card"
                rows={3}
                maxLength={500}
                value={adultMemberHostingReason}
                onChange={(e) => setAdultMemberHostingReason(e.target.value)}
                placeholder="e.g. Long-standing family friends of the club, known to the committee"
              />
              <ViewOnlyActionButton
                canEdit={canEditBookings}
                describeReason={false}
                className="mt-3"
                disabled={
                  submitting ||
                  savingDraft ||
                  adultMemberHostingReason.trim().length === 0
                }
                onClick={() => {
                  const reason = adultMemberHostingReason.trim();
                  if (!reason) return;
                  if (pendingHostingAction === "draft") {
                    void handleSaveAsDraft({ hostingReason: reason });
                    return;
                  }
                  void submitBooking({
                    notifyMember: pendingNotifyMember,
                    hostingReason: reason,
                  });
                }}
              >
                {pendingHostingAction === "draft"
                  ? "Record the reason and save the draft"
                  : "Record the reason and create"}
              </ViewOnlyActionButton>
            </div>
          )}

          {/* #2779 — what "Save as Draft" actually means for the owner, stated
              where the officer chooses it. Two facts an officer cannot see from
              the button: the member pays for the draft themselves (this is the
              supported way to get a booking to a member whose unpaid
              subscription blocks them from booking), and the draft is DELETED
              72 hours after it is saved.

              SPLIT BY OWNER TYPE, because the member sentence is FALSE for the
              other one. This same wizard books a non-login non-member owner
              (#1935), who has no account, can never open a dashboard, and is not
              emailed about a draft — so "Save as Draft" for them produces a
              booking nobody can pay, which `draft-cleanup` then DELETES after 72
              hours. The officer walks away believing a bed is held. The button
              is left enabled (a draft for such an owner is still a legitimate
              hold an ADMIN comes back and confirms); what changes is that the
              screen stops promising a pick-up that cannot happen. */}
          <div className="rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground">
            {selectedMember?.isNonMember ? (
              <p data-testid="save-as-draft-nonmember-note">
                <strong>Save as Draft</strong> will not reach this owner. They
                are a non-member with no account, so they cannot sign in, open
                the booking or pay it, and nothing is emailed about a draft.
                Drafts are removed <strong>72 hours</strong> after they are
                saved, so a draft nobody confirms simply disappears — and the
                beds are not held. Use <strong>Confirm Booking</strong> instead,
                or save the draft only if you are coming back to confirm it
                yourself within three days.
              </p>
            ) : (
              <p data-testid="save-as-draft-member-note">
                <strong>Save as Draft</strong> leaves the booking for the member
                to pay for themselves. It appears on their dashboard as{" "}
                &ldquo;Saved for you by the club&rdquo;, and paying it confirms
                the booking — which still works if an unpaid subscription is
                blocking them from making their own bookings. Drafts are removed{" "}
                <strong>72 hours</strong> after they are saved, so tell the
                member it is waiting. A $0 booking has nothing to pay: confirm
                that one here instead.
              </p>
            )}
          </div>

          <div className="flex justify-between">
            <Button
              variant="outline"
              onClick={() => {
                invalidatePendingQuote();
                setStep("guests");
              }}
            >
              Back
            </Button>
            <div className="flex gap-3">
              <ViewOnlyActionButton
                canEdit={canEditBookings}
                describeReason={false}
                variant="outline"
                onClick={() => void handleSaveAsDraft()}
                disabled={
                  savingDraft ||
                  submitting ||
                  isRetroactive ||
                  guests.length > availableBeds
                }
                title={
                  isRetroactive
                    ? "Retroactive bookings can't be saved as a draft"
                    : guests.length > availableBeds
                      ? "Over-capacity bookings can't be saved as a draft — confirm the over-capacity booking instead"
                      : undefined
                }
              >
                {savingDraft ? "Saving draft..." : "Save as Draft"}
              </ViewOnlyActionButton>
              <ViewOnlyActionButton
                canEdit={canEditBookings}
                describeReason={false}
                onClick={handleConfirmClick}
                disabled={submitting || savingDraft}
                size="lg"
              >
                {submitting ? "Creating booking..." : "Confirm Booking"}
              </ViewOnlyActionButton>
            </div>
          </div>
        </div>
      )}

      {/* Per-create member-email choice (#1695 / #1685 pattern). Shown for every
          on-behalf confirm; both choices create the booking. */}
      <Dialog
        open={notifyDialogOpen}
        onOpenChange={(open) => !submitting && setNotifyDialogOpen(open)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {selectedMember?.isNonMember
                ? "Email this non-member about the booking?"
                : "Email the member about this booking?"}
            </DialogTitle>
            <DialogDescription>
              {selectedMember?.isNonMember ? (
                <>
                  This owner is a non-member with no account. The booking will be
                  created either way; by default they are <strong>not</strong>{" "}
                  emailed. Choose to send the standard confirmation / hold email
                  to {selectedMember?.firstName ?? "them"} only if you want to —
                  your choice is recorded in the audit log. A Xero invoice email
                  (Internet Banking) is still sent regardless of this choice.
                </>
              ) : (
                <>
                  The booking will be created either way. Choose whether{" "}
                  {selectedMember?.firstName ?? "the member"} receives the
                  standard confirmation / hold email — your choice is recorded in
                  the audit log. A Xero invoice email (Internet Banking) is still
                  sent regardless of this choice.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant={selectedMember?.isNonMember ? "default" : "outline"}
              disabled={submitting}
              onClick={() => {
                setNotifyDialogOpen(false);
                void submitBooking({ notifyMember: false });
              }}
            >
              Create without emailing
            </Button>
            <Button
              variant={selectedMember?.isNonMember ? "outline" : "default"}
              disabled={submitting}
              onClick={() => {
                setNotifyDialogOpen(false);
                void submitBooking({ notifyMember: true });
              }}
            >
              {selectedMember?.isNonMember
                ? "Create and email them"
                : "Create and email member"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
    </div>
  );
}
