"use client";

import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  type BedOption,
  type BucketGuestGroup,
  bucketDraggableId,
} from "./types";

interface GuestChipProps {
  group: BucketGuestGroup;
  bedOptions: BedOption[];
  selectedBedId: string;
  onSelectBed: (bedId: string) => void;
  onAllocate: () => void;
  pending: boolean;
  highlighted?: boolean;
}

export function GuestChip({
  group,
  bedOptions,
  selectedBedId,
  onSelectBed,
  onAllocate,
  pending,
  highlighted,
}: GuestChipProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: bucketDraggableId(group.bookingGuestId),
      data: { type: "bucket-guest", bookingGuestId: group.bookingGuestId },
    });

  const nightsLabel =
    group.stayDates.length === 1
      ? group.stayDates[0]
      : `${group.stayDates[0]} – ${group.stayDates[group.stayDates.length - 1]} (${group.stayDates.length} nights)`;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn(
        "flex flex-col gap-2 rounded-md border bg-white p-2 shadow-sm sm:flex-row sm:items-center sm:justify-between",
        isDragging && "opacity-50",
        highlighted && "border-amber-300 bg-amber-50",
      )}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          aria-label={`Drag ${group.guestName} to a bed`}
          className="mt-0.5 cursor-grab touch-none rounded p-1 text-muted-foreground hover:bg-accent active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <div>
          <div className="text-sm font-medium">{group.guestName}</div>
          <div className="text-xs text-muted-foreground">
            {group.guestAgeTier} · {group.memberName}
          </div>
          <div className="font-mono text-xs text-muted-foreground">
            {nightsLabel}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Select value={selectedBedId || "none"} onValueChange={onSelectBed}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Select bed" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Select bed</SelectItem>
            {bedOptions.map((bed) => (
              <SelectItem key={bed.id} value={bed.id}>
                {bed.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          onClick={onAllocate}
          disabled={pending || !selectedBedId || selectedBedId === "none"}
        >
          Allocate
        </Button>
        {group.stayDates.length > 1 ? (
          <Badge variant="outline">{group.stayDates.length} nights</Badge>
        ) : null}
      </div>
    </div>
  );
}
