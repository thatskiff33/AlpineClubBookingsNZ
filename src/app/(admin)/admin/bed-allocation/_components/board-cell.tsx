"use client";

import { useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import { AllocationChip } from "./allocation-chip";
import {
  type BedOption,
  type DashboardAllocation,
  cellDroppableId,
} from "./types";

interface BoardCellProps {
  bedId: string;
  roomId: string;
  stayDate: string;
  allocation: DashboardAllocation | undefined;
  bedOptions: BedOption[];
  onReassignBed: (allocation: DashboardAllocation, bedId: string) => void;
  onRemove: (allocation: DashboardAllocation) => void;
  pending: boolean;
  highlighted?: boolean;
}

export function BoardCell({
  bedId,
  roomId,
  stayDate,
  allocation,
  bedOptions,
  onReassignBed,
  onRemove,
  pending,
  highlighted,
}: BoardCellProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: cellDroppableId(bedId, stayDate),
    data: { type: "cell", bedId, roomId, stayDate },
  });

  return (
    <td
      ref={setNodeRef}
      className={cn(
        "min-w-[140px] border p-1 align-top",
        isOver && "bg-blue-50 ring-2 ring-blue-300",
        highlighted && !isOver && "bg-amber-50",
      )}
    >
      {allocation ? (
        <AllocationChip
          allocation={allocation}
          bedOptions={bedOptions}
          onReassignBed={(targetBedId) => onReassignBed(allocation, targetBedId)}
          onRemove={() => onRemove(allocation)}
          pending={pending}
        />
      ) : (
        <div className="flex h-12 items-center justify-center rounded-md border border-dashed border-transparent text-[10px] text-muted-foreground/50">
          {isOver ? "Drop here" : ""}
        </div>
      )}
    </td>
  );
}
