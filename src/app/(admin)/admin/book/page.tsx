"use client";

import type { AgeTier } from "@prisma/client";
import { useState, useEffect } from "react";
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
import { PromoCodeInput, type PromoResult } from "@/components/promo-code-input";
import { TimePicker } from "@/components/time-picker";
import { MemberPicker } from "@/components/admin/member-picker";
import { formatLocalDateOnly } from "@/lib/date-only";
import { CreditCard, Landmark } from "lucide-react";

type BookingPaymentMethod = "stripe" | "internet_banking";

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
}

export default function AdminBookPage() {
  const router = useRouter();
  const { lodgeCapacity } = useClubIdentity();
  const [selectedMember, setSelectedMember] = useState<SelectedMember | null>(null);
  const [step, setStep] = useState<"member" | "dates" | "guests" | "review">("member");
  // Lodge being booked (multi-lodge phase 8). Admin scope lists every active
  // lodge — booking on behalf is the audited path that bypasses member
  // booking restrictions. Hidden with fewer than two lodges (ADR-002).
  const { lodges, loading: lodgesLoading } = useLodgeOptions("admin");
  const [lodgeId, setLodgeId] = useState<string | null>(null);
  const [checkIn, setCheckIn] = useState<Date | null>(null);
  const [checkOut, setCheckOut] = useState<Date | null>(null);
  const [guests, setGuests] = useState<GuestData[]>([]);
  const [notes, setNotes] = useState("");
  const [memberReviewJustification, setMemberReviewJustification] = useState("");
  const [priceQuote, setPriceQuote] = useState<PriceQuote | null>(null);
  const [priceLoading, setPriceLoading] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [availableBeds, setAvailableBeds] = useState(lodgeCapacity);
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

  // A retroactive booking is one whose check-in is genuinely in the past (local
  // date), with the flag on. Drives the guest-cap relaxation and the POST body.
  const localToday = new Date();
  localToday.setHours(0, 0, 0, 0);
  const isRetroactive =
    allowPastDates && checkIn !== null && checkIn < localToday;

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

  function handleMemberSelect(member: SelectedMember) {
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
  }

  function handleMemberClear() {
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
  }

  function addFamilyMemberAsGuest(fm: FamilyMember) {
    if (guests.some((g) => g.memberId === fm.id)) return;
    // Retroactive bookings may exceed the live availability (over-capacity is
    // warn-and-confirm at submit), so cap by lodge capacity instead.
    if (!isRetroactive && guests.length >= availableBeds) return;
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
  }

  async function handleDateSelect(ci: Date, co: Date) {
    setCheckIn(ci);
    setCheckOut(co);
    setError("");
    const ciStr = formatLocalDateOnly(ci);
    const coStr = formatLocalDateOnly(co);

    const res = await fetch(
      `/api/availability/check?checkIn=${ciStr}&checkOut=${coStr}${
        lodgeId ? `&lodgeId=${encodeURIComponent(lodgeId)}` : ""
      }`
    );
    if (res.ok) {
      const data = await res.json();
      setAvailableBeds(data.minAvailable);
    }

    // Admin bypasses minimum stay — skip policy check
    setStep("guests");
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

    // Retroactive bookings can exceed live availability — over-capacity becomes
    // a warn-and-confirm at submit, not a hard block here (#1695).
    if (!isRetroactive && guests.length > availableBeds) {
      setError(`Only ${availableBeds} beds available for your dates`);
      return;
    }

    setError("");
    setPriceLoading(true);
    const checkInStr = formatLocalDateOnly(checkIn!);
    const checkOutStr = formatLocalDateOnly(checkOut!);

    const res = await fetch("/api/bookings/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checkIn: checkInStr,
        checkOut: checkOutStr,
        lodgeId: lodgeId ?? undefined,
        guests: guests.map((g) => ({
          ageTier: g.ageTier,
          isMember: g.isMember,
          memberId: g.memberId,
        })),
        forMemberId: selectedMember!.id,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      setPriceQuote(data);
      setStep("review");
    } else {
      const data = await res.json();
      setError(data.error || "Failed to calculate price");
    }
    setPriceLoading(false);
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
    setNotifyDialogOpen(true);
  }

  async function submitBooking(opts: {
    notifyMember: boolean;
    confirmOverCapacity?: boolean;
  }) {
    setSubmitting(true);
    setError("");
    const checkInStr = formatLocalDateOnly(checkIn!);
    const checkOutStr = formatLocalDateOnly(checkOut!);

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
        lodgeId: lodgeId ?? undefined,
        forMemberId: selectedMember!.id,
        // A retroactive booking with a balance can never use the card path
        // (#1709); force internet banking. A fully-covered ($0) retroactive
        // booking falls through to "stripe" and settles to PAID immediately.
        paymentMethod: retroactiveNeedsInternetBanking
          ? "internet_banking"
          : showPaymentMethodChoice && paymentMethod === "internet_banking"
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
    // XERO_PERIOD_LOCKED / XERO_LOCK_DATE_CHECK_FAILED and every other error
    // surface verbatim in the existing banner.
    setError(data.error || "Failed to create booking");
    setSubmitting(false);
  }

  async function handleSaveAsDraft() {
    setSavingDraft(true);
    setError("");
    const checkInStr = formatLocalDateOnly(checkIn!);
    const checkOutStr = formatLocalDateOnly(checkOut!);

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
        lodgeId: lodgeId ?? undefined,
        draft: true,
        forMemberId: selectedMember!.id,
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
      setError(data.error || "Failed to save draft");
      setSavingDraft(false);
    }
  }

  const nights =
    checkIn && checkOut
      ? Math.ceil((checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60 * 24))
      : 0;

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
  // Retroactive bookings can't use the card PAYMENT_PENDING path (#1709): a
  // finished stay has no arrival to gate a card hold on, so any outstanding
  // balance must settle via internet banking, account credit (reduced to $0),
  // or a $0/comp booking. With a balance and no Internet Banking module there
  // is no valid settlement, so Confirm is blocked with an explanation.
  const retroactiveBalanceOwed = isRetroactive && remainingToPay > 0;
  const retroactiveNeedsInternetBanking =
    retroactiveBalanceOwed && internetBankingEnabled;
  const retroactiveNoSettlement =
    retroactiveBalanceOwed && !internetBankingEnabled;

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-3xl font-bold">Book on Behalf of Member</h1>

      {/* Member picker — always visible */}
      <MemberPicker
        selected={selectedMember}
        onSelect={handleMemberSelect}
        onClear={handleMemberClear}
      />

      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          <p>{error}</p>
        </div>
      )}

      {/* Step indicator — only show after member selected */}
      {selectedMember && (
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
      )}

      {/* Step 1: Dates */}
      {step === "dates" && selectedMember && (
        <Card>
          <CardHeader>
            <CardTitle>Select Dates</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="max-w-xs">
              <LodgeSelect
                lodges={lodges}
                value={lodgeId}
                onChange={handleLodgeChange}
                loading={lodgesLoading}
              />
            </div>
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <label className="flex items-start gap-2 text-sm text-slate-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allowPastDates}
                  onChange={(e) => {
                    setAllowPastDates(e.target.checked);
                    setOverCapacityNights(null);
                    // Unticking must not strand an already-selected past range
                    // that only the server would reject at submit.
                    if (!e.target.checked && checkIn && checkIn < localToday) {
                      setCheckIn(null);
                      setCheckOut(null);
                    }
                  }}
                  className="mt-0.5 rounded border-slate-300"
                />
                <span>
                  <span className="font-medium">
                    Record a past stay (retroactive booking)
                  </span>
                  <span className="block text-xs text-slate-600">
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
                <span className="ml-2 text-sm font-normal text-gray-500">
                  {checkIn.toLocaleDateString("en-NZ")} -{" "}
                  {checkOut.toLocaleDateString("en-NZ")} ({nights} night
                  {nights !== 1 ? "s" : ""})
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {isRetroactive && guests.length > availableBeds && (
              <div className="rounded-md bg-orange-50 p-3 text-sm text-orange-800">
                This retroactive booking exceeds the {availableBeds} bed
                {availableBeds === 1 ? "" : "s"} available for these past dates.
                You can still create it \u2014 you will confirm the over-capacity
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
                          alreadyAdded ||
                          (!isRetroactive && guests.length >= availableBeds)
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
            <GuestForm
              guests={guests}
              onGuestsChange={setGuests}
              maxGuests={isRetroactive ? lodgeCapacity : availableBeds}
            />
            <div className="flex justify-between pt-4">
              <Button variant="outline" onClick={() => setStep("dates")}>
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
                  <span className="text-gray-500">Check-in:</span>{" "}
                  <span className="font-medium">
                    {checkIn!.toLocaleDateString("en-NZ", {
                      weekday: "short",
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500">Check-out:</span>{" "}
                  <span className="font-medium">
                    {checkOut!.toLocaleDateString("en-NZ", {
                      weekday: "short",
                      day: "numeric",
                      month: "short",
                      year: "numeric",
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
                  <div className={`flex justify-between text-sm ${appliedPromo.promoAdjustmentCents > 0 ? "text-orange-700" : "text-green-600"}`}>
                    <span>Promo adjustment ({appliedPromo.code})</span>
                    <span>{formatSignedCents(appliedPromo.promoAdjustmentCents)}</span>
                  </div>
                  {appliedCreditCents > 0 && (
                    <div className="flex justify-between text-sm text-green-600">
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
                      <div className="flex justify-between text-sm text-green-600">
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
                <div className="rounded-md bg-green-50 border border-green-200 p-4 mt-2">
                  <p className="text-sm text-green-800 mb-2">
                    {selectedMember.firstName} has{" "}
                    <strong>{formatCents(availableCreditCents)}</strong> in account
                    credit
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
                    Reason for booking without an adult (optional, stored with the booking)
                  </Label>
                  <p className="text-sm text-amber-900">
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
                <TimePicker value={expectedArrivalTime} onChange={setExpectedArrivalTime} />
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
            <div className="rounded-md bg-yellow-50 p-4 text-sm text-yellow-800">
              <strong>Note:</strong> This booking includes non-member guests. It may
              be held as PENDING until closer to check-in.
            </div>
          )}

          {showPaymentMethodChoice && (
            <Card>
              <CardContent className="space-y-3 pt-6">
                <p className="text-sm font-medium text-slate-900">Payment method</p>
                {isRetroactive ? (
                  // Card is not an option for a past stay (#1709): a finished
                  // stay has no arrival to gate a card hold on. Internet Banking
                  // (or account credit / $0 comp) is the only settlement.
                  <div className="space-y-2">
                    <div className="flex min-h-16 items-start gap-3 rounded-md border border-blue-500 bg-blue-50 p-3 text-left text-sm text-blue-950">
                      <Landmark className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>
                        <span className="block font-medium">Internet Banking</span>
                        <span className="block text-xs opacity-80">
                          Email the member a Xero invoice to pay by bank transfer.
                        </span>
                      </span>
                    </div>
                    <p className="text-xs text-slate-600">
                      Card payment isn&apos;t available for a past stay. Record it
                      with internet banking, apply account credit, or make it a
                      $0/comp booking.
                    </p>
                  </div>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => setPaymentMethod("stripe")}
                      className={`flex min-h-16 items-start gap-3 rounded-md border p-3 text-left text-sm ${
                        paymentMethod === "stripe"
                          ? "border-blue-500 bg-blue-50 text-blue-950"
                          : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
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
                          ? "border-blue-500 bg-blue-50 text-blue-950"
                          : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
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
                )}
              </CardContent>
            </Card>
          )}

          {retroactiveNoSettlement && (
            <div className="rounded-md border border-orange-200 bg-orange-50 p-4 text-sm text-orange-900">
              <p className="font-medium">
                Card payment isn&apos;t available for a past stay
              </p>
              <p className="mt-1">
                A retroactive booking with an outstanding balance (
                {formatCents(remainingToPay)}) can&apos;t be paid by card. Apply
                account credit to cover it in full, or turn on Internet Banking
                (Admin &gt; Setup &gt; Modules) to invoice the member.
              </p>
            </div>
          )}

          {isRetroactive && (
            <div className="rounded-md bg-slate-50 border border-slate-200 p-3 text-sm text-slate-700">
              Recording a past stay ({checkIn!.toLocaleDateString("en-NZ")}). The
              member email is optional (you choose on confirm); drafts are not
              available for retroactive bookings.
            </div>
          )}

          {overCapacityNights && (
            <div className="rounded-md border border-orange-200 bg-orange-50 p-4 text-sm text-orange-900">
              <p className="font-medium">Some nights are over lodge capacity</p>
              <ul className="mt-2 list-disc pl-5">
                {overCapacityNights.map((n) => (
                  <li key={n.date}>
                    {n.date}: {Math.abs(n.availableBeds)} over capacity
                  </li>
                ))}
              </ul>
              <Button
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
              </Button>
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
                disabled={savingDraft || submitting || isRetroactive}
                title={
                  isRetroactive
                    ? "Retroactive bookings can't be saved as a draft"
                    : undefined
                }
              >
                {savingDraft ? "Saving draft..." : "Save as Draft"}
              </Button>
              <Button
                onClick={handleConfirmClick}
                disabled={submitting || savingDraft || retroactiveNoSettlement}
                size="lg"
                title={
                  retroactiveNoSettlement
                    ? "A retroactive booking with a balance needs account credit or Internet Banking — card can't settle a past stay"
                    : undefined
                }
              >
                {submitting ? "Creating booking..." : "Confirm Booking"}
              </Button>
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
            <DialogTitle>Email the member about this booking?</DialogTitle>
            <DialogDescription>
              The booking will be created either way. Choose whether{" "}
              {selectedMember?.firstName ?? "the member"} receives the standard
              confirmation / hold email — your choice is recorded in the audit
              log. A Xero invoice email (Internet Banking) is still sent
              regardless of this choice.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              disabled={submitting}
              onClick={() => {
                setNotifyDialogOpen(false);
                void submitBooking({ notifyMember: false });
              }}
            >
              Create without emailing
            </Button>
            <Button
              disabled={submitting}
              onClick={() => {
                setNotifyDialogOpen(false);
                void submitBooking({ notifyMember: true });
              }}
            >
              Create and email member
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
