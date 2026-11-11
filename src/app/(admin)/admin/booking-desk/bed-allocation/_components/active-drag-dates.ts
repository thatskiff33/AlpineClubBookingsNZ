import type {
  BucketGuestGroup,
  DashboardAllocation,
  DragData,
} from "./types";

export function deriveActiveDragDates(input: {
  activeDrag: DragData | null;
  visibleAllocations: DashboardAllocation[];
  bucketGroups: BucketGuestGroup[];
}): string[] {
  const { activeDrag, visibleAllocations, bucketGroups } = input;
  if (!activeDrag) return [];

  if (activeDrag.type === "bucket-guest") {
    return [
      ...new Set(
        bucketGroups
          .find((group) => group.bookingGuestId === activeDrag.bookingGuestId)
          ?.stayDates ?? [],
      ),
    ].sort();
  }

  const allocation = visibleAllocations.find(
    (item) => item.id === activeDrag.allocationId,
  );
  if (!allocation) return [];

  // A dragged allocation is only the anchor. The admin chooses one night or
  // the person's authoritative booking rows in the confirmation dialog, so
  // the board must not imply a scope from whichever rows happen to be visible.
  return [allocation.stayDate];
}
