"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { BoardCell } from "./board-cell";
import {
  type BedOption,
  type DashboardAllocation,
  type DashboardRoom,
} from "./types";

interface RoomTableProps {
  room: DashboardRoom;
  nights: string[];
  allocationByBedAndDate: Map<string, DashboardAllocation>;
  bedOptions: BedOption[];
  onReassignBed: (allocation: DashboardAllocation, bedId: string) => void;
  onRemove: (allocation: DashboardAllocation) => void;
  pendingAllocationIds: Set<string>;
  highlightedBookingId: string;
}

export function RoomTable({
  room,
  nights,
  allocationByBedAndDate,
  bedOptions,
  onReassignBed,
  onRemove,
  pendingAllocationIds,
  highlightedBookingId,
}: RoomTableProps) {
  const activeBeds = room.beds.filter((bed) => bed.active);

  if (activeBeds.length === 0) {
    return null;
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <Table className="min-w-max">
        <TableHeader>
          <TableRow>
            <TableHead className="sticky left-0 z-10 min-w-[140px] bg-background">
              {room.name}
            </TableHead>
            {nights.map((night) => (
              <TableHead key={night} className="min-w-[140px] text-center font-mono text-xs">
                {night}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {activeBeds.map((bed) => (
            <TableRow key={bed.id}>
              <TableCell className="sticky left-0 z-10 bg-background font-medium">
                {bed.name}
              </TableCell>
              {nights.map((night) => {
                const allocation = allocationByBedAndDate.get(`${bed.id}:${night}`);
                return (
                  <BoardCell
                    key={night}
                    bedId={bed.id}
                    roomId={room.id}
                    stayDate={night}
                    allocation={allocation}
                    bedOptions={bedOptions}
                    onReassignBed={onReassignBed}
                    onRemove={onRemove}
                    pending={
                      allocation ? pendingAllocationIds.has(allocation.id) : false
                    }
                    highlighted={allocation?.bookingId === highlightedBookingId}
                  />
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
