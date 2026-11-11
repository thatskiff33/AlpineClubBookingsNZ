"use client";

import { useEffect, useRef } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { BedTypeIndicator } from "@/components/admin/bed-type-indicator";
import {
  BED_ALLOCATION_COLUMN_WIDTH_CLASS,
  BED_ALLOCATION_COLUMN_WIDTH_REM,
  BED_ALLOCATION_LABEL_COLUMN_WIDTH_CLASS,
  BED_ALLOCATION_LABEL_COLUMN_WIDTH_REM,
  BoardCell,
} from "./board-cell";
import {
  type AllocationLockReason,
  type BedOption,
  type BedOptionGroup,
  type DashboardAllocation,
  type DashboardCustodianHold,
  type DashboardRoom,
} from "./types";

// Accessible label for a bed's type icon: a *paired* bunk (its group holds two
// beds) reads as "Bunk A · top"; a half-pair whose partner was deleted must not
// imply a partner, so it falls back to the indicator's own type label.
function bedTypeAccessibleLabel(
  bed: DashboardRoom["beds"][number],
  pairedBunkGroups: Set<string>,
): string | undefined {
  if (!bed.bunkGroup || !pairedBunkGroups.has(bed.bunkGroup)) return undefined;
  if (bed.bedType === "BUNK_TOP") return `${bed.bunkGroup} · top`;
  if (bed.bedType === "BUNK_BOTTOM") return `${bed.bunkGroup} · bottom`;
  return undefined;
}

interface RoomTableProps {
  room: DashboardRoom;
  nights: string[];
  // #1701: a DOUBLE bed-night may hold two occupants (declared partners), so a
  // cell maps to an array (primary first) rather than a single allocation.
  allocationByBedAndDate: Map<string, DashboardAllocation[]>;
  bedOptions: BedOption[];
  bedOptionGroups?: BedOptionGroup[];
  onReassignBed: (
    allocation: DashboardAllocation,
    bedId: string,
    focusOrigin?: HTMLElement | null,
  ) => void;
  onRemove: (allocation: DashboardAllocation) => void;
  onAssignRange: (allocation: DashboardAllocation) => void;
  // #2251 decision 3: green/red tinting of the nights the last range operation
  // wrote and refused, on the bed it targeted, until the admin dismisses it.
  rangeTint?: { bedId: string; written: Set<string>; refused: Set<string> };
  // #2286: `bedId:YYYY-MM-DD` -> the custodian hold covering that bed-night.
  custodianHoldByBedAndDate?: Map<string, DashboardCustodianHold>;
  pendingAllocationIds: Set<string>;
  highlightedBookingId: string;
  activeDragDates?: Set<string>;
  registerScroller?: (element: HTMLDivElement) => () => void;
  // Tri-state (#2065): `undefined` while the client session resolves. The
  // `!canEdit` idiom below treats that as disabled (the neutral resolving
  // state), so it must never default to `true`.
  canEdit: boolean | undefined;
  // #2701: set while the board is club-wide, disabling every cell as a drop
  // target and every chip's move/remove/range action.
  lockReason?: AllocationLockReason;
}

export function RoomTable({
  room,
  nights,
  allocationByBedAndDate,
  bedOptions,
  bedOptionGroups = [],
  onReassignBed,
  onRemove,
  onAssignRange,
  rangeTint,
  custodianHoldByBedAndDate,
  pendingAllocationIds,
  highlightedBookingId,
  activeDragDates = new Set(),
  registerScroller,
  canEdit,
  lockReason,
}: RoomTableProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const activeBeds = room.beds.filter((bed) => bed.active);

  useEffect(() => {
    const element = scrollerRef.current;
    if (!element || !registerScroller) return undefined;
    return registerScroller(element);
  }, [registerScroller]);

  if (activeBeds.length === 0) {
    return null;
  }

  // Group membership is a property of the whole room (including any inactive
  // bed), so a bunk only reads as "paired" when its group holds two beds. A
  // half-pair left after a partner delete falls back to a plain type label.
  const bunkGroupCounts = new Map<string, number>();
  for (const bed of room.beds) {
    if (bed.bunkGroup) {
      bunkGroupCounts.set(
        bed.bunkGroup,
        (bunkGroupCounts.get(bed.bunkGroup) ?? 0) + 1,
      );
    }
  }
  const pairedBunkGroups = new Set(
    [...bunkGroupCounts.entries()]
      .filter(([, count]) => count >= 2)
      .map(([group]) => group),
  );

  return (
    <div ref={scrollerRef} className="overflow-x-auto rounded-md border">
      <Table
        className="table-fixed"
        style={{
          width: `${BED_ALLOCATION_LABEL_COLUMN_WIDTH_REM + nights.length * BED_ALLOCATION_COLUMN_WIDTH_REM}rem`,
        }}
      >
        <colgroup>
          <col className={BED_ALLOCATION_LABEL_COLUMN_WIDTH_CLASS} />
          {Array.from({ length: nights.length }, (_, index) => (
            <col key={index} className={BED_ALLOCATION_COLUMN_WIDTH_CLASS} />
          ))}
        </colgroup>
        <TableHeader>
          <TableRow>
            <TableHead
              className={`${BED_ALLOCATION_LABEL_COLUMN_WIDTH_CLASS} sticky left-0 z-10 bg-background`}
            >
              <span className="block truncate" title={room.name}>
                {room.name}
              </span>
            </TableHead>
            {nights.map((night) => (
              <TableHead
                key={night}
                className={`${BED_ALLOCATION_COLUMN_WIDTH_CLASS} text-center font-mono text-xs`}
              >
                <span className="block truncate">{night}</span>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {activeBeds.map((bed) => (
            <TableRow key={bed.id}>
              <TableCell
                className={`${BED_ALLOCATION_LABEL_COLUMN_WIDTH_CLASS} sticky left-0 z-10 bg-background font-medium`}
              >
                <span className="flex items-start gap-1.5">
                  <BedTypeIndicator
                    bedType={bed.bedType}
                    labelOverride={bedTypeAccessibleLabel(bed, pairedBunkGroups)}
                    className="mt-0.5 shrink-0 text-muted-foreground"
                  />
                  <span
                    className="line-clamp-2 min-w-0 whitespace-normal"
                    title={bed.name}
                  >
                    {bed.name}
                  </span>
                </span>
              </TableCell>
              {nights.map((night) => {
                const allocations =
                  allocationByBedAndDate.get(`${bed.id}:${night}`) ?? [];
                return (
                  <BoardCell
                    key={night}
                    bedId={bed.id}
                    roomId={room.id}
                    stayDate={night}
                    allocations={allocations}
                    bedOptions={bedOptions}
                    bedOptionGroups={bedOptionGroups}
                    onReassignBed={onReassignBed}
                    onRemove={onRemove}
                    onAssignRange={onAssignRange}
                    rangeTone={
                      rangeTint && rangeTint.bedId === bed.id
                        ? rangeTint.written.has(night)
                          ? "written"
                          : rangeTint.refused.has(night)
                            ? "refused"
                            : undefined
                        : undefined
                    }
                    custodianHold={custodianHoldByBedAndDate?.get(
                      `${bed.id}:${night}`,
                    )}
                    pendingAllocationIds={pendingAllocationIds}
                    highlightedBookingId={highlightedBookingId}
                    activeDragLane={activeDragDates.has(night)}
                    canEdit={canEdit}
                    lockReason={lockReason}
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
