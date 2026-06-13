"use client";

import type { AgeTier } from "@prisma/client";
import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCents } from "@/lib/utils";
import { getAgeTierLabel, useAgeTierOptions } from "@/lib/use-age-tier-options";

interface Guest {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: string;
  isMember: boolean;
  memberId?: string | null;
  stayStart?: string | null;
  stayEnd?: string | null;
  priceCents: number;
}

interface FamilyMember {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  relationship: "self" | "partner" | "dependent";
}

interface PromoInfo {
  code: string;
  type: string;
  description: string | null;
  // Set when this discount came from a work party (working bee) event's
  // internal promo rather than a manually entered code.
  workPartyEventName?: string | null;
}

interface BookingData {
  id: string;
  checkIn: string;
  checkOut: string;
  guests: Guest[];
  bookingMemberId: string;
  viewerRole: string;
  finalPriceCents: number;
  totalPriceCents: number;
  discountCents: number;
  promoAdjustmentCents: number;
  promo: PromoInfo | null;
  canEditNonMemberGuestNames: boolean;
  editPolicy: {
    mode: "future" | "in-progress" | null;
    today: string;
    editableFrom: string | null;
    checkInEditable: boolean;
  };
}

interface NewGuest {
  key: string; // client-side key for React
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string;
  stayStart?: string;
  stayEnd?: string;
}

interface ItemizedChange {
  label: string;
  amountCents: number;
}

interface SettlementOptions {
  basisAmountCents: number;
  cardRefundAmountCents: number;
  cardRefundPercentage: number;
  accountCreditAmountCents: number;
  accountCreditPercentage: number;
  daysUntilCheckIn: number;
  requiresSettlementMethod: boolean;
}

interface QuoteResult {
  newTotalPriceCents: number;
  newDiscountCents: number;
  newPromoAdjustmentCents: number;
  newFinalPriceCents: number;
  priceDiffCents: number;
  changeFeeCents: number;
  netChargeCents: number;
  settlementOptions: SettlementOptions | null;
  capacityAvailable: boolean;
  promoStillValid: boolean;
  promoValidation: {
    valid: boolean;
    error?: string;
    code?: string;
    discountCents?: number;
    promoAdjustmentCents?: number;
  } | null;
  itemizedChanges: ItemizedChange[];
  nightDetails?: { date: string; availableBeds: number }[];
}

function previousDateOnly(dateString: string | null) {
  if (!dateString) return null;
  const date = new Date(`${dateString}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function shiftDateOnly(dateString: string, days: number) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return dateString;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatSignedCents(cents: number) {
  const prefix = cents > 0 ? "+" : "-";
  return `${prefix}${formatCents(Math.abs(cents))}`;
}

export function EditBookingPanel({
  booking,
  onDone,
}: {
  booking: BookingData;
  onDone: () => void;
}) {
  const router = useRouter();
  const ageTierOptions = useAgeTierOptions();

  // Editable state
  const [checkIn, setCheckIn] = useState(booking.checkIn);
  const [checkOut, setCheckOut] = useState(booking.checkOut);
  const [removedGuestIds, setRemovedGuestIds] = useState<Set<string>>(new Set());
  const [addedGuests, setAddedGuests] = useState<NewGuest[]>([]);
  const [perGuestDatesEnabled, setPerGuestDatesEnabled] = useState(
    booking.guests.some(
      (guest) =>
        (guest.stayStart && guest.stayStart !== booking.checkIn) ||
        (guest.stayEnd && guest.stayEnd !== booking.checkOut)
    )
  );
  const [existingGuestRanges, setExistingGuestRanges] = useState<
    Record<string, { stayStart: string; stayEnd: string }>
  >(() =>
    Object.fromEntries(
      booking.guests.map((guest) => [
        guest.id,
        {
          stayStart: guest.stayStart ?? booking.checkIn,
          stayEnd: guest.stayEnd ?? booking.checkOut,
        },
      ])
    )
  );
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
  const [familyMembers, setFamilyMembers] = useState<FamilyMember[]>([]);
  const [promoAction, setPromoAction] = useState<
    { type: "keep" } | { type: "remove" } | { type: "new"; code: string }
  >({ type: "keep" });
  const [newPromoInput, setNewPromoInput] = useState("");

  // Quote state
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState("");
  const [settlementMethod, setSettlementMethod] = useState<"card" | "credit" | null>(null);

  // Add guest form
  const [showAddForm, setShowAddForm] = useState(false);
  const [addFirstName, setAddFirstName] = useState("");
  const [addLastName, setAddLastName] = useState("");
  const [addAgeTier, setAddAgeTier] = useState<AgeTier>("ADULT");

  // Save state
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [requestReason, setRequestReason] = useState("");
  const [requestSubmitting, setRequestSubmitting] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [requestSuccess, setRequestSuccess] = useState("");

  const today = booking.editPolicy.today;
  const minEditableDate = booking.editPolicy.editableFrom ?? today;
  const checkInLocked = !booking.editPolicy.checkInEditable;
  const isInProgressEdit = booking.editPolicy.mode === "in-progress";
  const promoLocked = isInProgressEdit;

  useEffect(() => {
    let cancelled = false;
    const familyUrl =
      booking.viewerRole === "ADMIN"
        ? `/api/admin/members/${booking.bookingMemberId}/family`
        : "/api/members/family";

    fetch(familyUrl)
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
  }, [booking.bookingMemberId, booking.viewerRole]);

  // Check if anything has changed
  const remainingGuests = booking.guests.filter((g) => !removedGuestIds.has(g.id));
  const canEditPerGuestDates = !isInProgressEdit && totalGuestCountCandidate() > 1;
  function totalGuestCountCandidate() {
    return remainingGuests.length + addedGuests.length;
  }

  useEffect(() => {
    if (!canEditPerGuestDates && perGuestDatesEnabled) {
      setPerGuestDatesEnabled(false);
    }
  }, [canEditPerGuestDates, perGuestDatesEnabled]);

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
  const guestNameUpdates = useMemo(
    () =>
      booking.canEditNonMemberGuestNames
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
      booking.canEditNonMemberGuestNames,
      booking.guests,
      guestNameEdits,
      removedGuestIds,
    ]
  );
  const guestNamesChanged = guestNameUpdates.length > 0;
  const hasChanges =
    checkIn !== booking.checkIn ||
    checkOut !== booking.checkOut ||
    removedGuestIds.size > 0 ||
    addedGuests.length > 0 ||
    guestRangesChanged ||
    guestNamesChanged ||
    promoAction.type !== "keep";

  // Debounced quote fetch
  const quoteTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const buildModificationPayload = useCallback(() => {
    const body: Record<string, unknown> = {};
    const rangeMode = perGuestDatesEnabled && !isInProgressEdit;
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
    }> = addedGuests.map((g) => ({
      firstName: g.firstName,
      lastName: g.lastName,
      ageTier: g.ageTier,
      isMember: g.isMember,
      memberId: g.memberId,
    }));

    if (rangeMode) {
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
    }
    if (removedGuestIds.size > 0) {
      body.removeGuestIds = Array.from(removedGuestIds);
    }
    if (guestNameUpdates.length > 0) {
      body.guestUpdates = guestNameUpdates;
    }
    if (promoAction.type === "remove") {
      body.removePromoCode = true;
    } else if (promoAction.type === "new") {
      body.promoCode = promoAction.code;
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
    isInProgressEdit,
    perGuestDatesEnabled,
    promoAction,
    remainingGuests,
    removedGuestIds,
  ]);

  const fetchQuote = useCallback(async () => {
    if (!hasChanges) {
      setQuote(null);
      return;
    }

    setQuoteError("");
    setQuoteLoading(true);

    try {
      const body = buildModificationPayload();

      const res = await fetch(`/api/bookings/${booking.id}/modify-quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) {
        setQuoteError(data.error || "Failed to get quote");
        setQuote(null);
        return;
      }
      setQuote(data);
      if (!data.settlementOptions?.requiresSettlementMethod) {
        setSettlementMethod(null);
      }
    } catch {
      setQuoteError("Failed to get quote");
      setQuote(null);
    } finally {
      setQuoteLoading(false);
    }
  }, [booking.id, buildModificationPayload, hasChanges]);

  // Auto-fetch quote when changes happen (debounced)
  useEffect(() => {
    if (quoteTimeoutRef.current) clearTimeout(quoteTimeoutRef.current);
    if (!hasChanges) {
      setQuote(null);
      return;
    }
    quoteTimeoutRef.current = setTimeout(fetchQuote, 500);
    return () => {
      if (quoteTimeoutRef.current) clearTimeout(quoteTimeoutRef.current);
    };
  }, [fetchQuote, hasChanges]);

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

  function handleRemoveAddedGuest(key: string) {
    setAddedGuests((prev) => prev.filter((g) => g.key !== key));
  }

  function handleApplyPromo() {
    if (promoLocked) return;
    if (!newPromoInput.trim()) return;
    setPromoAction({ type: "new", code: newPromoInput.trim() });
    setNewPromoInput("");
  }

  async function handleSave() {
    setSaveError("");
    if (quote?.settlementOptions?.requiresSettlementMethod && !settlementMethod) {
      setSaveError("Choose a refund or account credit before saving");
      return;
    }
    setSaving(true);

    try {
      const body = buildModificationPayload();
      if (settlementMethod) {
        body.settlementMethod = settlementMethod;
      }

      const res = await fetch(`/api/bookings/${booking.id}/modify`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) {
        setSaveError(data.error || "Failed to save changes");
        return;
      }

      router.refresh();
      onDone();
    } catch {
      setSaveError("Failed to save changes");
    } finally {
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

  return (
    <div className="space-y-6">
      {/* Dates */}
      <Card>
        <CardHeader>
          <CardTitle>Dates</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="edit-checkin">Check-in</Label>
              <Input
                id="edit-checkin"
                type="date"
                value={checkIn}
                min={today}
                disabled={checkInLocked}
                onChange={(e) => setCheckIn(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-checkout">Check-out</Label>
              <Input
                id="edit-checkout"
                type="date"
                value={checkOut}
                min={booking.editPolicy.mode === "in-progress" ? minEditableDate : checkIn || today}
                onChange={(e) => setCheckOut(e.target.value)}
              />
            </div>
          </div>
          {checkIn !== booking.checkIn || checkOut !== booking.checkOut ? (
            <p className="text-sm text-gray-500 mt-2">
              Originally: {booking.checkIn} to {booking.checkOut}
            </p>
          ) : null}
          {isInProgressEdit ? (
            <p className="mt-2 text-sm text-amber-800">
              Self-service edits for this in-progress stay can only affect
              nights from {minEditableDate} onward. NZ today and earlier stay
              locked for admin review.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* Guests */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Guests ({totalGuestCount})</CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowAddForm(true)}
              disabled={showAddForm}
            >
              {isInProgressEdit ? "+ Add Future Guest" : "+ Add Guest"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {isInProgressEdit ? (
            <p className="text-sm text-gray-500">
              Added guests start on {minEditableDate}. Removing an existing
              guest keeps their past and NZ today occupancy and removes only
              future nights.
            </p>
          ) : null}
          {familyMembers.length > 0 && (
            <div className="space-y-2 rounded-md border border-dashed p-3">
              <p className="text-sm font-medium text-muted-foreground">Quick add family members</p>
              <div className="flex flex-wrap gap-2">
                {familyMembers.map((familyMember) => {
                  const alreadyAdded = booking.guests.some((guest) => guest.memberId === familyMember.id)
                    || addedGuests.some((guest) => guest.memberId === familyMember.id);
                  const label = familyMember.relationship === "self"
                    ? `${familyMember.firstName} ${familyMember.lastName}`
                    : `${familyMember.firstName} ${familyMember.lastName} (${getAgeTierLabel(ageTierOptions, familyMember.ageTier)})`;

                  return (
                    <Button
                      key={familyMember.id}
                      type="button"
                      variant={alreadyAdded ? "secondary" : familyMember.relationship === "self" ? "default" : "outline"}
                      size="sm"
                      disabled={alreadyAdded}
                      onClick={() => handleAddFamilyMember(familyMember)}
                    >
                      {alreadyAdded ? "\u2713 " : "+ "}
                      {label}
                    </Button>
                  );
                })}
              </div>
            </div>
          )}

          {canEditPerGuestDates ? (
            <label className="flex items-center gap-2 rounded-md border p-3 text-sm">
              <input
                type="checkbox"
                checked={perGuestDatesEnabled}
                onChange={(e) => setPerGuestDatesEnabled(e.target.checked)}
                className="h-4 w-4"
              />
              <span className="font-medium">Per guest booking dates</span>
            </label>
          ) : null}

          {/* Existing guests */}
          {booking.guests.map((guest) => {
            const isRemoved = removedGuestIds.has(guest.id);
            const canEditGuestName =
              booking.canEditNonMemberGuestNames && !guest.isMember && !isRemoved;
            const nameEdit = getGuestNameEdit(guest);
            return (
              <div
                key={guest.id}
                className={`flex items-center justify-between py-2 ${
                  isRemoved ? "opacity-40 line-through" : ""
                }`}
              >
                <div>
                  {canEditGuestName ? (
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label htmlFor={`guest-${guest.id}-first`} className="text-xs">
                          First Name
                        </Label>
                        <Input
                          id={`guest-${guest.id}-first`}
                          value={nameEdit.firstName}
                          onChange={(e) =>
                            updateGuestName(guest.id, "firstName", e.target.value)
                          }
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`guest-${guest.id}-last`} className="text-xs">
                          Last Name
                        </Label>
                        <Input
                          id={`guest-${guest.id}-last`}
                          value={nameEdit.lastName}
                          onChange={(e) =>
                            updateGuestName(guest.id, "lastName", e.target.value)
                          }
                        />
                      </div>
                    </div>
                  ) : (
                    <p className="font-medium">
                      {guest.firstName} {guest.lastName}
                    </p>
                  )}
                  <p className="text-sm text-gray-500">
                    {getAgeTierLabel(ageTierOptions, guest.ageTier)} &middot; {guest.isMember ? "Member" : "Non-member"}
                  </p>
                  {(guest.stayStart && guest.stayStart !== booking.checkIn) ||
                  (guest.stayEnd && guest.stayEnd !== booking.checkOut) ? (
                    <p className="text-xs text-gray-500">
                      Stay: {guest.stayStart ?? booking.checkIn} to{" "}
                      {guest.stayEnd ?? booking.checkOut}
                    </p>
                  ) : null}
                  {perGuestDatesEnabled && !isRemoved ? (
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label htmlFor={`guest-${guest.id}-stay-start`} className="text-xs">
                          Date In
                        </Label>
                        <Input
                          id={`guest-${guest.id}-stay-start`}
                          type="date"
                          value={getExistingGuestRange(guest).stayStart}
                          min={checkIn}
                          max={shiftDateOnly(getExistingGuestRange(guest).stayEnd, -1)}
                          onChange={(e) =>
                            updateExistingGuestRange(guest.id, "stayStart", e.target.value)
                          }
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`guest-${guest.id}-stay-end`} className="text-xs">
                          Date Out
                        </Label>
                        <Input
                          id={`guest-${guest.id}-stay-end`}
                          type="date"
                          value={getExistingGuestRange(guest).stayEnd}
                          min={shiftDateOnly(getExistingGuestRange(guest).stayStart, 1)}
                          max={checkOut}
                          onChange={(e) =>
                            updateExistingGuestRange(guest.id, "stayEnd", e.target.value)
                          }
                        />
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm">{formatCents(guest.priceCents)}</span>
                  {isRemoved ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleUndoRemoveGuest(guest.id)}
                    >
                      Undo
                    </Button>
                  ) : (
                    remainingGuests.length + addedGuests.length > 1 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-500 hover:text-red-700"
                        onClick={() => handleRemoveGuest(guest.id)}
                      >
                        {isInProgressEdit ? "Remove Future" : "Remove"}
                      </Button>
                    )
                  )}
                </div>
              </div>
            );
          })}

          {/* Newly added guests */}
          {addedGuests.map((guest) => (
            <div key={guest.key} className="flex items-center justify-between py-2 bg-green-50 rounded px-2">
              <div>
                <p className="font-medium">
                  {guest.firstName} {guest.lastName}
                  <span className="ml-2 text-xs text-green-700 font-normal">NEW</span>
                </p>
                <p className="text-sm text-gray-500">
                  {getAgeTierLabel(ageTierOptions, guest.ageTier)} &middot; {guest.isMember ? "Member" : "Non-member"}
                </p>
                {perGuestDatesEnabled ? (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label htmlFor={`added-${guest.key}-stay-start`} className="text-xs">
                        Date In
                      </Label>
                      <Input
                        id={`added-${guest.key}-stay-start`}
                        type="date"
                        value={guest.stayStart ?? checkIn}
                        min={checkIn}
                        max={shiftDateOnly(guest.stayEnd ?? checkOut, -1)}
                        onChange={(e) =>
                          updateAddedGuestRange(guest.key, "stayStart", e.target.value)
                        }
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`added-${guest.key}-stay-end`} className="text-xs">
                        Date Out
                      </Label>
                      <Input
                        id={`added-${guest.key}-stay-end`}
                        type="date"
                        value={guest.stayEnd ?? checkOut}
                        min={shiftDateOnly(guest.stayStart ?? checkIn, 1)}
                        max={checkOut}
                        onChange={(e) =>
                          updateAddedGuestRange(guest.key, "stayEnd", e.target.value)
                        }
                      />
                    </div>
                  </div>
                ) : null}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-red-500 hover:text-red-700"
                onClick={() => handleRemoveAddedGuest(guest.key)}
              >
                Remove
              </Button>
            </div>
          ))}

          {/* Add guest inline form */}
          {showAddForm && (
            <div className="border rounded-md p-3 mt-2 space-y-3 bg-gray-50">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="new-guest-first">First Name</Label>
                  <Input
                    id="new-guest-first"
                    value={addFirstName}
                    onChange={(e) => setAddFirstName(e.target.value)}
                    placeholder="First name"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="new-guest-last">Last Name</Label>
                  <Input
                    id="new-guest-last"
                    value={addLastName}
                    onChange={(e) => setAddLastName(e.target.value)}
                    placeholder="Last name"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="new-guest-age">Age Category</Label>
                  <select
                    id="new-guest-age"
                    value={addAgeTier}
                    onChange={(e) => setAddAgeTier(e.target.value as AgeTier)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                  >
                    {ageTierOptions.map((option) => (
                      <option key={option.tier} value={option.tier}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="text-sm text-gray-500">
                Typed-in guests are always treated as non-members and charged at non-member rates.
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={handleAddGuest}
                  disabled={!addFirstName.trim() || !addLastName.trim()}
                >
                  Add
                </Button>
                <Button variant="outline" size="sm" onClick={() => setShowAddForm(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Promo Code */}
      {!promoLocked && (
      <Card>
        <CardHeader>
          <CardTitle>Promo Code</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {booking.promo && promoAction.type === "keep" && (
            <div className="flex items-center justify-between">
              <div>
                <span className="font-medium text-green-700">
                  {booking.promo.workPartyEventName
                    ? `Working bee: ${booking.promo.workPartyEventName}`
                    : booking.promo.code}
                </span>
                {booking.promo.description && !booking.promo.workPartyEventName && (
                  <span className="text-sm text-gray-500 ml-2">{booking.promo.description}</span>
                )}
                <span className={`text-sm ml-2 ${booking.promoAdjustmentCents > 0 ? "text-orange-700" : "text-green-600"}`}>
                  ({formatSignedCents(booking.promoAdjustmentCents)})
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-red-500 hover:text-red-700"
                onClick={() => setPromoAction({ type: "remove" })}
              >
                Remove
              </Button>
            </div>
          )}

          {promoAction.type === "remove" && booking.promo && (
            <div className="flex items-center justify-between text-gray-400">
              <div>
                <span className="line-through">
                  {booking.promo.workPartyEventName
                    ? `Working bee: ${booking.promo.workPartyEventName}`
                    : booking.promo.code}
                </span>
                <span className="text-sm ml-2">(will be removed - available for reuse)</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPromoAction({ type: "keep" })}
              >
                Undo
              </Button>
            </div>
          )}

          {promoAction.type === "new" && (
            <div className="flex items-center justify-between">
              <div>
                <span className="font-medium text-green-700">{promoAction.code.toUpperCase()}</span>
                {quote?.promoValidation?.valid && quote.promoValidation.promoAdjustmentCents !== undefined && (
                  <span className={`text-sm ml-2 ${(quote.promoValidation.promoAdjustmentCents ?? 0) > 0 ? "text-orange-700" : "text-green-600"}`}>
                    ({formatSignedCents(quote.promoValidation.promoAdjustmentCents ?? 0)})
                  </span>
                )}
                {quote?.promoValidation && !quote.promoValidation.valid && (
                  <span className="text-sm text-red-600 ml-2">
                    {quote.promoValidation.error}
                  </span>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-red-500 hover:text-red-700"
                onClick={() => setPromoAction(booking.promo ? { type: "keep" } : { type: "remove" })}
              >
                Remove
              </Button>
            </div>
          )}

          {(promoAction.type === "remove" || (!booking.promo && promoAction.type === "keep")) && (
            <div className="flex gap-2">
              <Input
                placeholder="Enter promo code"
                value={newPromoInput}
                onChange={(e) => setNewPromoInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleApplyPromo()}
              />
              <Button
                variant="outline"
                onClick={handleApplyPromo}
                disabled={!newPromoInput.trim()}
              >
                Apply
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
      )}

      {/* Price Summary */}
      {hasChanges && (
        <Card>
          <CardHeader>
            <CardTitle>Price Summary</CardTitle>
          </CardHeader>
          <CardContent>
            {quoteLoading && (
              <p className="text-sm text-gray-500">Calculating price changes...</p>
            )}

            {quoteError && (
              <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{quoteError}</div>
            )}

            {quote && !quote.capacityAvailable && (
              <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
                <p className="font-medium">Not enough beds available</p>
                {quote.nightDetails && (
                  <ul className="mt-1 list-disc pl-4">
                    {quote.nightDetails
                      .filter((n) => n.availableBeds < 0)
                      .map((n) => (
                        <li key={n.date}>
                          {n.date}: {Math.abs(n.availableBeds)} bed(s) short
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            )}

            {quote && quote.capacityAvailable && (
              <div className="space-y-3">
                {/* Itemized changes */}
                <div className="space-y-1">
                  {quote.itemizedChanges.map((item, i) => (
                    <div key={i} className="flex justify-between text-sm">
                      <span className="text-gray-600">{item.label}</span>
                      <span
                        className={`font-medium ${
                          item.amountCents > 0
                            ? "text-red-600"
                            : item.amountCents < 0
                              ? "text-green-600"
                              : ""
                        }`}
                      >
                        {item.amountCents > 0 ? "+" : ""}
                        {formatCents(item.amountCents)}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Totals */}
                <div className="border-t pt-2 space-y-1">
                  <div className="flex justify-between text-sm">
                    <span>Current price</span>
                    <span>{formatCents(booking.finalPriceCents)}</span>
                  </div>
                  <div className="flex justify-between font-medium">
                    <span>New price</span>
                    <span>{formatCents(quote.newFinalPriceCents)}</span>
                  </div>
                </div>

                {/* Net charge/refund */}
                {quote.netChargeCents !== 0 && (
                  <div
                    className={`rounded-md p-3 text-sm ${
                      quote.netChargeCents > 0
                        ? "bg-red-50 text-red-700"
                        : "bg-green-50 text-green-700"
                    }`}
                  >
                    {quote.netChargeCents > 0 ? (
                      <p className="font-medium">
                        Additional charge: {formatCents(quote.netChargeCents)}
                      </p>
                    ) : (
                      <p className="font-medium">
                        Booking reduction: {formatCents(Math.abs(quote.netChargeCents))}
                      </p>
                    )}
                  </div>
                )}

                {quote.netChargeCents < 0 && quote.settlementOptions && (
                  <div className="space-y-2 rounded-md border p-3 text-sm">
                    <p className="font-medium">Return method</p>
                    {quote.settlementOptions.requiresSettlementMethod ? (
                      <div className="space-y-2">
                        <label className="flex cursor-pointer items-start gap-2">
                          <input
                            type="radio"
                            name="settlementMethod"
                            value="card"
                            checked={settlementMethod === "card"}
                            onChange={() => setSettlementMethod("card")}
                            className="mt-1"
                          />
                          <span>
                            Refund to original card:{" "}
                            <span className="font-medium">
                              {formatCents(quote.settlementOptions.cardRefundAmountCents)}
                            </span>{" "}
                            <span className="text-gray-500">
                              ({quote.settlementOptions.cardRefundPercentage}%)
                            </span>
                          </span>
                        </label>
                        <label className="flex cursor-pointer items-start gap-2">
                          <input
                            type="radio"
                            name="settlementMethod"
                            value="credit"
                            checked={settlementMethod === "credit"}
                            onChange={() => setSettlementMethod("credit")}
                            className="mt-1"
                          />
                          <span>
                            Hold as account credit:{" "}
                            <span className="font-medium">
                              {formatCents(quote.settlementOptions.accountCreditAmountCents)}
                            </span>{" "}
                            <span className="text-gray-500">
                              ({quote.settlementOptions.accountCreditPercentage}%)
                            </span>
                          </span>
                        </label>
                      </div>
                    ) : (
                      <p className="text-gray-600">
                        No refund or account credit is available for this reduction under the current policy.
                      </p>
                    )}
                  </div>
                )}

                {!quote.promoStillValid && promoAction.type === "keep" && booking.promo && (
                  <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-700">
                    Your promo code &apos;{booking.promo.code}&apos; is no longer valid and will be removed.
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {showChangeRequestPath && (
        <Card>
          <CardHeader>
            <CardTitle>Admin Request</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="change-request-reason">Requested change</Label>
              <Textarea
                id="change-request-reason"
                value={requestReason}
                maxLength={2000}
                onChange={(event) => setRequestReason(event.target.value)}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={handleSubmitChangeRequest}
              disabled={requestSubmitting || (!hasChanges && !requestReason.trim())}
            >
              {requestSubmitting ? "Sending..." : "Request Admin Review"}
            </Button>
            {requestError && (
              <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
                {requestError}
              </div>
            )}
            {requestSuccess && (
              <div className="rounded-md bg-green-50 p-3 text-sm text-green-700">
                {requestSuccess}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Action buttons */}
      <div className="flex gap-3">
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          disabled={
            !hasChanges ||
            saving ||
            quoteLoading ||
            !quote ||
            !quote.capacityAvailable ||
            (settlementRequired && !settlementMethod)
          }
        >
          {saving ? "Saving..." : "Save Changes"}
        </Button>
      </div>

      {saveError && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{saveError}</div>
      )}
    </div>
  );
}
