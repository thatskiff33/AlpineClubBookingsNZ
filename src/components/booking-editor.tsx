"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EditBookingPanel } from "@/components/edit-booking-panel";
import { formatCents } from "@/lib/utils";
import { bookingStatusClass, bookingStatusLabel } from "@/lib/status-colors";

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

interface PromoInfo {
  code: string;
  type: string;
  description: string | null;
}

interface EditPolicyInfo {
  mode: "future" | "in-progress" | null;
  today: string;
  editableFrom: string | null;
  checkInEditable: boolean;
}

export interface BookingEditorData {
  id: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  status: string;
  guests: Guest[];
  bookingMemberId: string;
  viewerRole: string;
  totalPriceCents: number;
  discountCents: number;
  promoAdjustmentCents: number;
  finalPriceCents: number;
  promo: PromoInfo | null;
  hasNonMembers: boolean;
  nonMemberHoldUntil: string | null;
  canEditNonMemberGuestNames: boolean;
  editPolicy: EditPolicyInfo;
}


export function BookingEditor({
  booking,
  canModify,
}: {
  booking: BookingEditorData;
  canModify: boolean;
}) {
  const [editing, setEditing] = useState(false);

  if (editing && canModify) {
    return (
      <EditBookingPanel
        booking={{
          id: booking.id,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          guests: booking.guests,
          bookingMemberId: booking.bookingMemberId,
          viewerRole: booking.viewerRole,
          finalPriceCents: booking.finalPriceCents,
          totalPriceCents: booking.totalPriceCents,
          discountCents: booking.discountCents,
          promoAdjustmentCents: booking.promoAdjustmentCents,
          promo: booking.promo,
          canEditNonMemberGuestNames: booking.canEditNonMemberGuestNames,
          editPolicy: booking.editPolicy,
        }}
        onDone={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Stay Details */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <CardTitle>Stay Details</CardTitle>
              {canModify && (
                <Button variant="outline" onClick={() => setEditing(true)}>
                  Edit Booking
                </Button>
              )}
            </div>
            <Badge variant="secondary" className={bookingStatusClass(booking.status)}>
              {bookingStatusLabel(booking.status)}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-gray-500">Check-in</p>
              <p className="font-medium">
                {new Date(booking.checkIn + "T00:00:00").toLocaleDateString("en-NZ", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Check-out</p>
              <p className="font-medium">
                {new Date(booking.checkOut + "T00:00:00").toLocaleDateString("en-NZ", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Nights</p>
              <p className="font-medium">{booking.nights}</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Guests</p>
              <p className="font-medium">{booking.guests.length}</p>
            </div>
          </div>

          {booking.status === "PENDING" && booking.nonMemberHoldUntil && (
            <div className="rounded-md bg-yellow-50 p-3 text-sm text-yellow-800">
              This booking includes non-members. It will be auto-confirmed on{" "}
              {new Date(booking.nonMemberHoldUntil).toLocaleDateString("en-NZ")},
              subject to availability. Members have priority.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Guests */}
      <Card>
        <CardHeader>
          <CardTitle>Guests</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="divide-y">
            {booking.guests.map((guest) => (
              <div key={guest.id} className="flex items-center justify-between py-3">
                <div>
                  <p className="font-medium">
                    {guest.firstName} {guest.lastName}
                  </p>
                  <p className="text-sm text-gray-500">
                    {guest.ageTier} &middot; {guest.isMember ? "Member" : "Non-member"}
                  </p>
                  {(guest.stayStart && guest.stayStart !== booking.checkIn) ||
                  (guest.stayEnd && guest.stayEnd !== booking.checkOut) ? (
                    <p className="text-xs text-gray-500">
                      Stay: {guest.stayStart ?? booking.checkIn} to{" "}
                      {guest.stayEnd ?? booking.checkOut}
                    </p>
                  ) : null}
                </div>
                <p className="font-medium">{formatCents(guest.priceCents)}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Payment */}
      <Card>
        <CardHeader>
          <CardTitle>Payment</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex justify-between">
            <span>Subtotal</span>
            <span>{formatCents(booking.totalPriceCents)}</span>
          </div>
          {booking.promoAdjustmentCents !== 0 && (
            <div className={`flex justify-between ${booking.promoAdjustmentCents > 0 ? "text-orange-700" : "text-green-600"}`}>
              <span>
                Promo adjustment
                {booking.promo?.code && (
                  <span className="ml-1 text-xs">({booking.promo.code})</span>
                )}
              </span>
              <span>
                {booking.promoAdjustmentCents > 0 ? "+" : "-"}
                {formatCents(Math.abs(booking.promoAdjustmentCents))}
              </span>
            </div>
          )}
          <div className="flex justify-between border-t pt-2 font-bold">
            <span>Total</span>
            <span>{formatCents(booking.finalPriceCents)}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
