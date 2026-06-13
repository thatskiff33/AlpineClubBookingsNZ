"use client";

import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  type BedOption,
  type DashboardAllocation,
  allocationDraggableId,
} from "./types";

interface AllocationChipProps {
  allocation: DashboardAllocation;
  bedOptions: BedOption[];
  onReassignBed: (bedId: string) => void;
  onRemove: () => void;
  pending: boolean;
}

export function AllocationChip({
  allocation,
  bedOptions,
  onReassignBed,
  onRemove,
  pending,
}: AllocationChipProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: allocationDraggableId(allocation.id),
      data: { type: "allocation", allocationId: allocation.id },
    });

  const otherBeds = bedOptions.filter((bed) => bed.id !== allocation.bedId);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn(
        "flex items-start gap-1 rounded-md border bg-white p-1.5 text-xs shadow-sm",
        isDragging && "opacity-50",
        pending && "opacity-60",
      )}
    >
      <button
        type="button"
        aria-label={`Drag ${allocation.guestName} to another bed or night`}
        className="cursor-grab touch-none rounded p-0.5 text-muted-foreground hover:bg-accent active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{allocation.guestName}</div>
        <div className="truncate font-mono text-[10px] text-muted-foreground">
          {allocation.bookingId}
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          <Badge
            variant={allocation.source === "MANUAL" ? "warning" : "secondary"}
            className="px-1 py-0 text-[10px]"
          >
            {allocation.source}
          </Badge>
          <Badge
            variant={allocation.approvedAt ? "success" : "outline"}
            className="px-1 py-0 text-[10px]"
          >
            {allocation.approvedAt ? "Approved" : "Draft"}
          </Badge>
        </div>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5 shrink-0"
            aria-label={`Manage allocation for ${allocation.guestName}`}
            disabled={pending}
          >
            <X className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Move to bed</DropdownMenuLabel>
          {otherBeds.map((bed) => (
            <DropdownMenuItem key={bed.id} onSelect={() => onReassignBed(bed.id)}>
              {bed.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onRemove} className="text-destructive">
            Remove allocation
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
