"use client";

import { useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import { GuestChip } from "./guest-chip";
import {
  BUCKET_DROPPABLE_ID,
  type BedOption,
  type BucketGuestGroup,
  type DashboardBookingSummary,
} from "./types";

interface BucketBoardProps {
  bookings: DashboardBookingSummary[];
  groupsByBooking: Map<string, BucketGuestGroup[]>;
  bedOptions: BedOption[];
  selectedBeds: Record<string, string>;
  onSelectBed: (bookingGuestId: string, bedId: string) => void;
  onAllocate: (group: BucketGuestGroup) => void;
  pendingGuestIds: Set<string>;
  highlightedBookingId: string;
}

export function BucketBoard({
  bookings,
  groupsByBooking,
  bedOptions,
  selectedBeds,
  onSelectBed,
  onAllocate,
  pendingGuestIds,
  highlightedBookingId,
}: BucketBoardProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: BUCKET_DROPPABLE_ID,
    data: { type: "bucket" },
  });

  const bookingsWithGroups = bookings.filter(
    (booking) => (groupsByBooking.get(booking.id)?.length ?? 0) > 0,
  );

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "space-y-3 rounded-md border border-dashed p-3 transition-colors",
        isOver && "border-blue-300 bg-blue-50",
      )}
    >
      {bookingsWithGroups.length === 0 ? (
        <div className="p-4 text-center text-sm text-muted-foreground">
          No bookings awaiting allocation in this range.
          {isOver ? " Drop here to unallocate a bed." : ""}
        </div>
      ) : (
        bookingsWithGroups.map((booking) => {
          const groups = groupsByBooking.get(booking.id) ?? [];
          return (
            <div
              key={booking.id}
              className={cn(
                "rounded-md border bg-slate-50 p-2",
                booking.id === highlightedBookingId && "border-amber-300 bg-amber-50",
              )}
            >
              <div className="mb-2 flex flex-wrap items-baseline gap-2 px-1">
                <span className="text-sm font-semibold">{booking.memberName}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {booking.id}
                </span>
                <span className="text-xs text-muted-foreground">
                  {booking.checkIn} – {booking.checkOut}
                </span>
                {booking.requestedRoom &&
                  (booking.requestedRoom.active ? (
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
                      Requested: {booking.requestedRoom.name}
                    </span>
                  ) : (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                      Requested room no longer active: {booking.requestedRoom.name}
                    </span>
                  ))}
              </div>
              <div className="space-y-2">
                {groups.map((group) => (
                  <GuestChip
                    key={group.bookingGuestId}
                    group={group}
                    bedOptions={bedOptions}
                    selectedBedId={selectedBeds[group.bookingGuestId] ?? ""}
                    onSelectBed={(bedId) => onSelectBed(group.bookingGuestId, bedId)}
                    onAllocate={() => onAllocate(group)}
                    pending={pendingGuestIds.has(group.bookingGuestId)}
                    highlighted={booking.id === highlightedBookingId}
                  />
                ))}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
