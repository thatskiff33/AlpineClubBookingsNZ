"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCents } from "@/lib/utils";

interface Guest {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: string;
  isMember: boolean;
  priceCents: number;
}

interface PromoInfo {
  code: string;
  type: string;
  description: string | null;
}

interface BookingData {
  id: string;
  checkIn: string;
  checkOut: string;
  guests: Guest[];
  finalPriceCents: number;
  totalPriceCents: number;
  discountCents: number;
  promo: PromoInfo | null;
}

interface NewGuest {
  key: string; // client-side key for React
  firstName: string;
  lastName: string;
  ageTier: "ADULT" | "YOUTH" | "CHILD";
  isMember: boolean;
}

interface ItemizedChange {
  label: string;
  amountCents: number;
}

interface QuoteResult {
  newTotalPriceCents: number;
  newDiscountCents: number;
  newFinalPriceCents: number;
  priceDiffCents: number;
  changeFeeCents: number;
  netChargeCents: number;
  capacityAvailable: boolean;
  promoStillValid: boolean;
  promoValidation: {
    valid: boolean;
    error?: string;
    code?: string;
    discountCents?: number;
  } | null;
  itemizedChanges: ItemizedChange[];
  nightDetails?: { date: string; availableBeds: number }[];
}

export function EditBookingPanel({
  booking,
  onDone,
}: {
  booking: BookingData;
  onDone: () => void;
}) {
  const router = useRouter();

  // Editable state
  const [checkIn, setCheckIn] = useState(booking.checkIn);
  const [checkOut, setCheckOut] = useState(booking.checkOut);
  const [removedGuestIds, setRemovedGuestIds] = useState<Set<string>>(new Set());
  const [addedGuests, setAddedGuests] = useState<NewGuest[]>([]);
  const [promoAction, setPromoAction] = useState<
    { type: "keep" } | { type: "remove" } | { type: "new"; code: string }
  >({ type: "keep" });
  const [newPromoInput, setNewPromoInput] = useState("");

  // Quote state
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState("");

  // Add guest form
  const [showAddForm, setShowAddForm] = useState(false);
  const [addFirstName, setAddFirstName] = useState("");
  const [addLastName, setAddLastName] = useState("");
  const [addAgeTier, setAddAgeTier] = useState<"ADULT" | "YOUTH" | "CHILD">("ADULT");
  const [addIsMember, setAddIsMember] = useState(false);

  // Save state
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const today = new Date().toISOString().split("T")[0];

  // Check if anything has changed
  const remainingGuests = booking.guests.filter((g) => !removedGuestIds.has(g.id));
  const hasChanges =
    checkIn !== booking.checkIn ||
    checkOut !== booking.checkOut ||
    removedGuestIds.size > 0 ||
    addedGuests.length > 0 ||
    promoAction.type !== "keep";

  // Debounced quote fetch
  const quoteTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const fetchQuote = useCallback(async () => {
    if (!hasChanges) {
      setQuote(null);
      return;
    }

    setQuoteError("");
    setQuoteLoading(true);

    try {
      const body: Record<string, unknown> = {};

      if (checkIn !== booking.checkIn) body.checkIn = checkIn;
      if (checkOut !== booking.checkOut) body.checkOut = checkOut;
      if (addedGuests.length > 0) {
        body.addGuests = addedGuests.map((g) => ({
          firstName: g.firstName,
          lastName: g.lastName,
          ageTier: g.ageTier,
          isMember: g.isMember,
        }));
      }
      if (removedGuestIds.size > 0) {
        body.removeGuestIds = Array.from(removedGuestIds);
      }
      if (promoAction.type === "remove") {
        body.removePromoCode = true;
      } else if (promoAction.type === "new") {
        body.promoCode = promoAction.code;
      }

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
    } catch {
      setQuoteError("Failed to get quote");
      setQuote(null);
    } finally {
      setQuoteLoading(false);
    }
  }, [booking.id, booking.checkIn, booking.checkOut, checkIn, checkOut, addedGuests, removedGuestIds, promoAction, hasChanges]);

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
        isMember: addIsMember,
      },
    ]);
    setAddFirstName("");
    setAddLastName("");
    setAddAgeTier("ADULT");
    setAddIsMember(false);
    setShowAddForm(false);
  }

  function handleRemoveAddedGuest(key: string) {
    setAddedGuests((prev) => prev.filter((g) => g.key !== key));
  }

  function handleApplyPromo() {
    if (!newPromoInput.trim()) return;
    setPromoAction({ type: "new", code: newPromoInput.trim() });
    setNewPromoInput("");
  }

  async function handleSave() {
    setSaveError("");
    setSaving(true);

    try {
      const body: Record<string, unknown> = {};

      if (checkIn !== booking.checkIn) body.checkIn = checkIn;
      if (checkOut !== booking.checkOut) body.checkOut = checkOut;
      if (addedGuests.length > 0) {
        body.addGuests = addedGuests.map((g) => ({
          firstName: g.firstName,
          lastName: g.lastName,
          ageTier: g.ageTier,
          isMember: g.isMember,
        }));
      }
      if (removedGuestIds.size > 0) {
        body.removeGuestIds = Array.from(removedGuestIds);
      }
      if (promoAction.type === "remove") {
        body.removePromoCode = true;
      } else if (promoAction.type === "new") {
        body.promoCode = promoAction.code;
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

  const totalGuestCount = remainingGuests.length + addedGuests.length;

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
                onChange={(e) => setCheckIn(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-checkout">Check-out</Label>
              <Input
                id="edit-checkout"
                type="date"
                value={checkOut}
                min={checkIn || today}
                onChange={(e) => setCheckOut(e.target.value)}
              />
            </div>
          </div>
          {checkIn !== booking.checkIn || checkOut !== booking.checkOut ? (
            <p className="text-sm text-gray-500 mt-2">
              Originally: {booking.checkIn} to {booking.checkOut}
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
              + Add Guest
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {/* Existing guests */}
          {booking.guests.map((guest) => {
            const isRemoved = removedGuestIds.has(guest.id);
            return (
              <div
                key={guest.id}
                className={`flex items-center justify-between py-2 ${
                  isRemoved ? "opacity-40 line-through" : ""
                }`}
              >
                <div>
                  <p className="font-medium">
                    {guest.firstName} {guest.lastName}
                  </p>
                  <p className="text-sm text-gray-500">
                    {guest.ageTier} &middot; {guest.isMember ? "Member" : "Non-member"}
                  </p>
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
                        Remove
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
                  {guest.ageTier} &middot; {guest.isMember ? "Member" : "Non-member"}
                </p>
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
                    onChange={(e) => setAddAgeTier(e.target.value as "ADULT" | "YOUTH" | "CHILD")}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                  >
                    <option value="ADULT">Adult (18+)</option>
                    <option value="YOUTH">Youth (10-17)</option>
                    <option value="CHILD">Child (under 10)</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="new-guest-member">Membership</Label>
                  <select
                    id="new-guest-member"
                    value={addIsMember ? "true" : "false"}
                    onChange={(e) => setAddIsMember(e.target.value === "true")}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                  >
                    <option value="true">Member</option>
                    <option value="false">Non-member</option>
                  </select>
                </div>
              </div>
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
      <Card>
        <CardHeader>
          <CardTitle>Promo Code</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {booking.promo && promoAction.type === "keep" && (
            <div className="flex items-center justify-between">
              <div>
                <span className="font-medium text-green-700">{booking.promo.code}</span>
                {booking.promo.description && (
                  <span className="text-sm text-gray-500 ml-2">{booking.promo.description}</span>
                )}
                <span className="text-sm text-green-600 ml-2">
                  (-{formatCents(booking.discountCents)})
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
                <span className="line-through">{booking.promo.code}</span>
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
                {quote?.promoValidation?.valid && quote.promoValidation.discountCents && (
                  <span className="text-sm text-green-600 ml-2">
                    (-{formatCents(quote.promoValidation.discountCents)})
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
                        Refund: {formatCents(Math.abs(quote.netChargeCents))}
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
            !quote.capacityAvailable
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
