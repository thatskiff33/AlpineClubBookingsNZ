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
import { LODGE_CAPACITY } from "@/lib/capacity";
import { PromoCodeInput, type PromoResult } from "@/components/promo-code-input";
import { TimePicker } from "@/components/time-picker";
import {
  getBookingErrorPaymentTargets,
  type BookingErrorPaymentTarget,
} from "@/lib/booking-error-payment-targets";
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

interface SubscriptionStatus {
  status: "PAID" | "UNPAID" | "OVERDUE" | "NOT_INVOICED" | "NOT_REQUIRED" | "UNKNOWN";
  seasonDisplay: string;
  invoiceUrl: string | null;
  invoiceNumber: string | null;
}

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

export default function BookPage() {
  const router = useRouter();
  const { data: session } = useSession();
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
  const [availableBeds, setAvailableBeds] = useState(LODGE_CAPACITY);
  const [appliedPromo, setAppliedPromo] = useState<PromoResult | null>(null);
  const [expectedArrivalTime, setExpectedArrivalTime] = useState<string | null>(null);
  const [useCredit, setUseCredit] = useState(false);
  const [familyMembers, setFamilyMembers] = useState<FamilyMember[]>([]);
  const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatus | null>(null);
  const [subscriptionLoading, setSubscriptionLoading] = useState(true);
  const [availablePromoCodes, setAvailablePromoCodes] = useState<{ code: string; description: string | null; type: string; percentOff: number | null; valueCents: number | null; freeNights: number | null }[]>([]);
  const [prefillPromoCode, setPrefillPromoCode] = useState<string | undefined>();
  const [guestProfileBlocks, setGuestProfileBlocks] = useState<GuestProfileRequiredMember[]>([]);

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
    if (guests.length >= availableBeds) return;
    if (fm.canBeBooked === false) return;
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

    // Fetch availability for selected range
    const res = await fetch(
      `/api/availability/check?checkIn=${ci.toISOString()}&checkOut=${co.toISOString()}`
    );
    if (res.ok) {
      const data = await res.json();
      setAvailableBeds(data.minAvailable);
    }

    // Check minimum stay policies
    const ciStr = ci.toISOString().split("T")[0];
    const coStr = co.toISOString().split("T")[0];
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

    if (guests.length > availableBeds) {
      setError(`Only ${availableBeds} beds available for your dates`);
      return;
    }

    setError("");
    setPriceLoading(true);

    // Fetch price quote
    const res = await fetch("/api/bookings/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checkIn: checkIn!.toISOString(),
        checkOut: checkOut!.toISOString(),
        guests: guests.map((g) => ({
          ageTier: g.ageTier,
          isMember: g.isMember,
          memberId: g.memberId,
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
    } else {
      const data = await res.json();
      handleBookingApiError(data, "Failed to calculate price");
    }
    setPriceLoading(false);
  }

  async function handleSubmit() {
    setSubmitting(true);
    setError("");
    setErrorPaymentTargets([]);
    setGuestProfileBlocks([]);
    setShowWaitlistPrompt(false);

    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checkIn: checkIn!.toISOString(),
        checkOut: checkOut!.toISOString(),
        guests,
        notes: notes || undefined,
        promoCode: appliedPromo?.code || undefined,
        expectedArrivalTime: expectedArrivalTime || undefined,
        applyCreditCents: appliedCreditCents > 0 ? appliedCreditCents : undefined,
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
    setJoiningWaitlist(true);
    setError("");
    setErrorPaymentTargets([]);
    setGuestProfileBlocks([]);

    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checkIn: checkIn!.toISOString(),
        checkOut: checkOut!.toISOString(),
        guests,
        notes: notes || undefined,
        promoCode: appliedPromo?.code || undefined,
        expectedArrivalTime: expectedArrivalTime || undefined,
        waitlist: true,
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
    setSavingDraft(true);
    setError("");
    setErrorPaymentTargets([]);
    setGuestProfileBlocks([]);

    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checkIn: checkIn!.toISOString(),
        checkOut: checkOut!.toISOString(),
        guests,
        notes: notes || undefined,
        promoCode: appliedPromo?.code || undefined,
        expectedArrivalTime: expectedArrivalTime || undefined,
        applyCreditCents: appliedCreditCents > 0 ? appliedCreditCents : undefined,
        draft: true,
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
    ? priceQuote.totalPriceCents - (appliedPromo?.discountCents ?? 0)
    : 0;
  const appliedCreditCents = useCredit
    ? Math.min(availableCreditCents, finalPriceBeforeCredit)
    : 0;
  const remainingToPay = finalPriceBeforeCredit - appliedCreditCents;

  const subscriptionUnpaid =
    subscriptionStatus &&
    (subscriptionStatus.status === "UNPAID" || subscriptionStatus.status === "OVERDUE");
  const showInviteFamilyGroupMembersLink =
    shouldShowInviteFamilyGroupMembersLink(familyMembers);

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
                            disabled={alreadyAdded || guests.length >= availableBeds || blocked}
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
              onGuestsChange={setGuests}
              maxGuests={availableBeds}
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
                {guests.map((g, i) => (
                  <div key={i} className="flex justify-between text-sm py-1">
                    <span>
                      {g.firstName} {g.lastName} ({g.ageTier}, {g.isMember ? "Member" : "Non-member"})
                    </span>
                    <span className="font-medium">
                      {formatCents(priceQuote.guests[i]?.priceCents || 0)}
                    </span>
                  </div>
                ))}
              </div>

              {appliedPromo && appliedPromo.discountCents > 0 ? (
                <>
                  <div className="border-t pt-4 flex justify-between text-sm">
                    <span>Subtotal</span>
                    <span>{formatCents(priceQuote.totalPriceCents)}</span>
                  </div>
                  <div className="flex justify-between text-sm text-green-600">
                    <span>Discount ({appliedPromo.code})</span>
                    <span>-{formatCents(appliedPromo.discountCents)}</span>
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
              <div className="space-y-2">
                <Label htmlFor="arrival-time">Expected Arrival Time (optional)</Label>
                <TimePicker
                  value={expectedArrivalTime}
                  onChange={setExpectedArrivalTime}
                />
              </div>
              {availablePromoCodes.length > 0 && !appliedPromo && (
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
                guests={guests}
                onPromoApplied={setAppliedPromo}
                appliedPromo={appliedPromo}
                prefillCode={prefillPromoCode}
              />
            </CardContent>
          </Card>

          {guests.some((g) => !g.isMember) && (
            <div className="rounded-md bg-yellow-50 p-4 text-sm text-yellow-800">
              <strong>Note:</strong> This booking includes non-member guests.
              {" Your booking may be held as PENDING until closer to check-in. Members have priority \u2014 your booking may be bumped if the lodge fills up."}
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
