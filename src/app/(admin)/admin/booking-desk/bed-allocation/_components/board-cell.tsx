"use client";

import { useDroppable } from "@dnd-kit/core";
import { BellRing, CheckCircle2, Focus, XCircle } from "lucide-react";
import { useClubIdentity } from "@/components/club-identity-provider";
import { cn } from "@/lib/utils";
import { AllocationChip } from "./allocation-chip";
import {
  type AllocationLockReason,
  type BedOption,
  type BedOptionGroup,
  type DashboardAllocation,
  type DashboardCustodianHold,
  cellDroppableId,
} from "./types";

// Custodian band (#2286), owner decision 29 Jul: a hatched NEUTRAL pattern plus
// a labelled pill — deliberately distinct from the whole-lodge-hold banner, and
// never colour-alone. The hatching is a repeating-linear-gradient of 1px
// `currentColor` stripes separated by 6px gaps — NO opacity is involved (the
// app-shell theme contract bans endpoint-crossing alpha on text surfaces); it
// reads light because the stripes are thin and sparse, and it inherits the
// cell's own `text-muted-foreground`, so light and dark both work with no
// second palette entry.
const CUSTODIAN_BAND_STYLE: React.CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(135deg, currentColor 0, currentColor 1px, transparent 1px, transparent 7px)",
};

export const BED_ALLOCATION_COLUMN_WIDTH_REM = 11;
export const BED_ALLOCATION_COLUMN_WIDTH_CLASS =
  "w-[11rem] min-w-[11rem] max-w-[11rem]";

// The label column (room name header / bed name cells) needs more room than a
// date column: bed names like "Bunk Bed Lower Right" truncated illegibly at
// the shared 11rem width (#2150). Kept as its own fixed-width constant (never
// w-auto) so use-synced-scroll's scrollLeft sync — which assumes every room
// table renders the exact same total width — still lines every column up
// across rooms.
export const BED_ALLOCATION_LABEL_COLUMN_WIDTH_REM = 14;
export const BED_ALLOCATION_LABEL_COLUMN_WIDTH_CLASS =
  "w-[14rem] min-w-[14rem] max-w-[14rem]";

interface BoardCellProps {
  bedId: string;
  roomId: string;
  stayDate: string;
  // #1701: a shared DOUBLE bed-night holds up to two occupants (primary first).
  allocations: DashboardAllocation[];
  bedOptions: BedOption[];
  bedOptionGroups?: BedOptionGroup[];
  onReassignBed: (
    allocation: DashboardAllocation,
    bedId: string,
    focusOrigin?: HTMLElement | null,
  ) => void;
  onRemove: (allocation: DashboardAllocation) => void;
  onAssignRange: (allocation: DashboardAllocation) => void;
  // #2251 decision 3: the outcome of the last range operation on THIS bed —
  // written nights tint green, refused nights red, until dismissed. Redundantly
  // labelled so it is never colour-only.
  rangeTone?: "written" | "refused";
  // #2286: set when a custodian holds THIS bed on THIS night. The cell becomes
  // a non-droppable hatched band; the server refuses any drop regardless, so
  // this is the visible half of an enforcement that does not depend on it.
  custodianHold?: DashboardCustodianHold;
  pendingAllocationIds: Set<string>;
  highlightedBookingId: string;
  activeDragLane?: boolean;
  // Tri-state (#2065): `undefined` while the client session resolves; the
  // `!canEdit` idiom treats that as disabled, so no truthy default here.
  canEdit: boolean | undefined;
  // #2701: set while the board is club-wide. The cell stops being a drop
  // target for the same reason a custodian-held night does — the write cannot
  // succeed — and the chip's own actions are disabled with the reason shown.
  lockReason?: AllocationLockReason;
}

export function BoardCell({
  bedId,
  roomId,
  stayDate,
  allocations,
  bedOptions,
  bedOptionGroups = [],
  onReassignBed,
  onRemove,
  onAssignRange,
  rangeTone,
  custodianHold,
  pendingAllocationIds,
  highlightedBookingId,
  activeDragLane,
  canEdit,
  lockReason,
}: BoardCellProps) {
  // Admin copy uses the club's own word for the role (#2286 review M8).
  const { hutLeaderLabel } = useClubIdentity();
  const { setNodeRef, isOver } = useDroppable({
    id: cellDroppableId(bedId, stayDate),
    data: { type: "cell", bedId, roomId, stayDate },
    // #2286: a custodian-held bed-night is not a drop target at all, so the
    // drag never even highlights it. The server 409s the write in any case —
    // this only spares the admin a pointless refusal. #2701 adds the club-wide
    // board on the same footing.
    disabled: !canEdit || Boolean(custodianHold) || lockReason !== undefined,
  });

  const highlighted = allocations.some(
    (allocation) => allocation.bookingId === highlightedBookingId,
  );

  // #2286: a custodian-held night draws its band as an OVERLAY inside the one
  // cell body, rather than returning a second, separate <td> (#2286 review M9).
  // The early return this replaced dropped every other signal the cell carries —
  // the range-assign green/red tint, the ?bookingId= focus outline, the
  // partner-shares marker — so a refused range assignment on a held bed-night
  // showed nothing at all, and a deep link to a booking sitting on a held bed
  // could not be found. All the signals below now hold on custodian cells too.
  const custodianTooltip = custodianHold
    ? `Held by ${custodianHold.memberName}'s ${hutLeaderLabel.toLowerCase()} assignment, ${custodianHold.startDate} to ${custodianHold.endDate}`
    : null;

  return (
    <td
      ref={setNodeRef}
      data-stay-date={stayDate}
      data-active-drag-lane={activeDragLane ? "true" : undefined}
      data-custodian-hold={custodianHold ? "true" : undefined}
      title={custodianTooltip ?? undefined}
      className={cn(
        BED_ALLOCATION_COLUMN_WIDTH_CLASS,
        "overflow-hidden border p-1 align-top",
        custodianHold && "text-muted-foreground",
        activeDragLane && !custodianHold && "bg-accent",
        rangeTone === "written" && "bg-success-muted ring-2 ring-inset ring-success/40",
        rangeTone === "refused" && "bg-danger-muted ring-2 ring-inset ring-danger/40",
        highlighted &&
          !isOver &&
          "border-2 border-dashed border-warning bg-warning-muted",
        isOver && "bg-info-muted ring-2 ring-info",
      )}
    >
      {highlighted ? (
        <span className="mb-1 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-warning">
          <Focus aria-hidden className="h-3 w-3" />
          Focused
        </span>
      ) : null}
      {rangeTone ? (
        <span
          className={cn(
            "mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide",
            rangeTone === "written" ? "text-success" : "text-danger",
          )}
        >
          {rangeTone === "written" ? (
            <CheckCircle2 aria-hidden className="h-3 w-3" />
          ) : (
            <XCircle aria-hidden className="h-3 w-3" />
          )}
          {rangeTone === "written" ? "Assigned" : "Refused"}
        </span>
      ) : null}
      {custodianHold ? (
        <div
          className="mb-1 flex h-12 flex-col items-center justify-center rounded-md border border-dashed"
          style={CUSTODIAN_BAND_STYLE}
        >
          {/* The pill carries the meaning. The hatching is a second,
              redundant signal — never the only one (owner decision 29 Jul).
              The role word is the club's own (#2286 review M8): only the lobby
              TV is pinned to the fixed word "Custodian". */}
          <span className="inline-flex items-center gap-1 rounded-full bg-background px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
            <BellRing aria-hidden className="h-3 w-3" />
            {hutLeaderLabel}
          </span>
          <span className="sr-only">{custodianTooltip}</span>
        </div>
      ) : null}
      {allocations.length > 0 ? (
        <div className="flex flex-col gap-1">
          {allocations.map((allocation) => (
            <div key={allocation.id}>
              {allocation.isSecondOccupant ? (
                <span className="mb-0.5 block text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                  Shares bed · partner
                </span>
              ) : null}
              <AllocationChip
                allocation={allocation}
                bedOptions={bedOptions}
                bedOptionGroups={bedOptionGroups}
                onReassignBed={(targetBedId, focusOrigin) =>
                  onReassignBed(allocation, targetBedId, focusOrigin)
                }
                onRemove={() => onRemove(allocation)}
                onAssignRange={() => onAssignRange(allocation)}
                pending={pendingAllocationIds.has(allocation.id)}
                canEdit={canEdit}
                lockReason={lockReason}
              />
            </div>
          ))}
        </div>
      ) : custodianHold ? null : (
        <div
          className={cn(
            "flex h-12 items-center justify-center rounded-md border border-dashed border-transparent text-[10px] text-muted-foreground",
            isOver && "border-info/60 text-info",
          )}
        >
          {isOver ? "Drop here" : ""}
        </div>
      )}
    </td>
  );
}
