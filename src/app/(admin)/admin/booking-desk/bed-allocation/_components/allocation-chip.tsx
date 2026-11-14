"use client";

import { useRef } from "react";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { CircleDashed, GripVertical, Lock, X } from "lucide-react";
import { AgeTierBadge } from "@/components/admin/family-groups/age-tier-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ADMIN_VIEW_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { getBookingAccent } from "./booking-accent";
import {
  type AllocationLockReason,
  type BedOption,
  type BedOptionGroup,
  type DashboardAllocation,
  allocationDraggableId,
} from "./types";

interface AllocationChipProps {
  allocation: DashboardAllocation;
  bedOptions: BedOption[];
  bedOptionGroups?: BedOptionGroup[];
  onReassignBed: (bedId: string, focusOrigin?: HTMLElement | null) => void;
  onRemove: () => void;
  // #2251 entry point 2: open the range dialog prefilled with this placement's
  // guest and bed, to extend it across the rest of the stay.
  onAssignRange: () => void;
  pending: boolean;
  // Tri-state (#2065): `undefined` while the client session resolves; the
  // `!canEdit` idiom treats that as disabled, so no truthy default here.
  canEdit: boolean | undefined;
  // #2701: set while the board is club-wide. Every item in the manage menu —
  // Move to bed, Assign range…, and Remove allocation — needs a concrete
  // lodge, and "Remove allocation" would otherwise be a clickable silent no-op
  // (owner decision 6).
  lockReason?: AllocationLockReason;
}

export function AllocationChip({
  allocation,
  bedOptions,
  bedOptionGroups = [],
  onReassignBed,
  onRemove,
  onAssignRange,
  pending,
  canEdit,
  lockReason,
}: AllocationChipProps) {
  const manageTriggerRef = useRef<HTMLButtonElement>(null);
  const locked = lockReason !== undefined;
  // The view-only reason wins when both apply: it is the restriction the admin
  // cannot resolve from this screen, and its own banner is already on the page.
  const disabledReason =
    canEdit === false ? ADMIN_VIEW_ONLY_ACTION_REASON : lockReason;
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: allocationDraggableId(allocation.id),
      data: { type: "allocation", allocationId: allocation.id },
      disabled: !canEdit || locked,
    });

  const optionGroups =
    bedOptionGroups.length > 0
      ? bedOptionGroups
      : bedOptions.reduce<BedOptionGroup[]>((groups, bed) => {
          const existing = groups.find((group) => group.roomId === bed.roomId);
          if (existing) {
            existing.beds.push(bed);
          } else {
            groups.push({
              roomId: bed.roomId,
              roomName: bed.roomName,
              beds: [bed],
            });
          }
          return groups;
        }, []);

  // Keep the anchor's current bed selectable. A one-night preview can be a
  // no-op, while person scope can still consolidate other existing nights to
  // this bed; only the authoritative dialog can distinguish those outcomes.
  const moveBedGroups = optionGroups.filter((group) => group.beds.length > 0);

  // Issue #1251: a bed on a capacity-holding booking (booked/confirmed) holds
  // the night; a bed on a provisional booking (generic PENDING / PAYMENT_PENDING
  // / WAITLIST_OFFERED) does NOT. Holding is no longer a pure function of status
  // (an accepted-but-unpaid quote is PENDING but holds, #1254), so the server
  // precomputes the flag via bookingHoldsCapacity(). The signal is NOT
  // colour-only — border style, icon, and label all differ — so it survives in
  // either theme and for colour-blind staff.
  // #2145 — why the dashed provisional outlines below use an ALPHA of the muted
  // token, and why that is not a WCAG 1.4.11 (non-text contrast) failure.
  // `--muted-foreground` is now a DERIVED tone, softer than `--foreground`, so
  // every alpha composite over it got fainter: this chip's outline measured
  // 4.26:1 in dark mode before #2145 and 2.76:1 after, at the old `/50`. The
  // alphas were raised to `/70` here and `/80` on the badge to claw that back,
  // but they still do not clear 3:1 on every palette, and they do not need to:
  // "provisional" is redundantly encoded by the border STYLE (dashed vs solid),
  // by the icon (Unlock vs Lock), and by the full-strength "Provisional" label
  // and its title text. The outline reinforces a signal that is already carried
  // by non-colour means alongside AA-passing text, which is exactly the
  // "decorative / redundant" carve-out in 1.4.11 — it is not the sole means of
  // conveying the state, and no interaction depends on perceiving it.
  // Do NOT read the opaque token's measured ratios in `docs/ARCHITECTURE.md`
  // ("`--muted-foreground` is a DERIVED tone") onto these alpha variants; that
  // guarantee is stated for the opaque tone only. Re-measure if the alpha
  // changes or the signal stops being redundantly encoded.
  const holdsCapacity = allocation.holdsCapacity;
  const accent = getBookingAccent(allocation.bookingId);
  const bookingTitle = `Booking ${allocation.bookingId}`;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      title={bookingTitle}
      className={cn(
        "relative flex w-full max-w-full items-start gap-1 overflow-hidden rounded-md border p-1.5 pl-2.5 text-xs shadow-sm ring-1 ring-inset",
        accent.ringClassName,
        holdsCapacity
          ? "border-border bg-card text-card-foreground"
          : "border-dashed border-muted-foreground/70 bg-muted text-foreground",
        isDragging && "opacity-50",
        pending && "opacity-60",
      )}
    >
      <span
        aria-hidden="true"
        className={cn("absolute inset-y-0 left-0 w-1", accent.stripClassName)}
      />
      <button
        type="button"
        aria-label={`Drag ${allocation.guestName} to another bed; original lodge night ${allocation.stayDate} will be kept`}
        disabled={!canEdit || locked}
        title={disabledReason}
        className="cursor-grab touch-none rounded p-0.5 text-muted-foreground hover:bg-accent active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1">
          <span
            className="min-w-0 flex-1 truncate font-medium"
            title={allocation.guestName}
          >
            {allocation.guestName}
          </span>
          <span className="shrink-0">
            <AgeTierBadge tier={allocation.guestAgeTier} />
          </span>
        </div>
        <div className="truncate font-mono text-[10px] text-muted-foreground">
          {allocation.bookingId}
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          <Badge
            variant="outline"
            className={cn(
              "gap-1 px-1 py-0 text-[10px]",
              holdsCapacity
                ? "border-transparent bg-secondary font-semibold text-secondary-foreground"
                : "border-dashed border-muted-foreground/80 text-muted-foreground",
            )}
            title={
              holdsCapacity
                ? "Held — this booking holds the bed for the night."
                : "Provisional — this booking does not hold the night; the bed can still be booked by someone else."
            }
          >
            {holdsCapacity ? (
              <Lock className="h-2.5 w-2.5" aria-hidden />
            ) : (
              <CircleDashed className="h-2.5 w-2.5" aria-hidden />
            )}
            {holdsCapacity ? "Held" : "Provisional"}
          </Badge>
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
            ref={manageTriggerRef}
            size="icon"
            variant="ghost"
            className="h-5 w-5 shrink-0"
            aria-label={`Manage allocation for ${allocation.guestName}`}
            data-bed-allocation-focus-id={allocation.id}
            title={disabledReason}
            disabled={pending || canEdit === undefined || locked}
          >
            <X className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          collisionPadding={8}
          className="bed-allocation-move-menu max-h-[min(60vh,20rem)] overflow-y-auto"
        >
          <DropdownMenuLabel>Move to bed</DropdownMenuLabel>
          {moveBedGroups.map((group) => (
            <DropdownMenuSub key={group.roomId}>
              <DropdownMenuSubTrigger
                aria-label={`Move ${allocation.guestName} to a bed in ${group.roomName}`}
                disabled={canEdit === undefined}
              >
                {group.roomName}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                collisionPadding={8}
                className="bed-allocation-move-submenu max-h-[min(60vh,18rem)] overflow-y-auto"
              >
                {group.beds.map((bed) => (
                  <DropdownMenuItem
                    key={bed.id}
                    aria-label={`Move ${allocation.guestName} to ${bed.label}`}
                    onSelect={() =>
                      onReassignBed(bed.id, manageTriggerRef.current)
                    }
                    disabled={canEdit === undefined}
                  >
                    {bed.bedName}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={onAssignRange}
            aria-label={`Assign a range of nights for ${allocation.guestName}`}
            disabled={!canEdit}
          >
            Assign range…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onRemove} className="text-destructive">
            Remove allocation
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
