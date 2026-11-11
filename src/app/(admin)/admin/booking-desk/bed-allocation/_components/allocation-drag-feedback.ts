import type { Announcements } from "@dnd-kit/core";
import { deriveActiveDragDates } from "./active-drag-dates";
import type {
  BedOption,
  BucketGuestGroup,
  DashboardAllocation,
  DragData,
  DropData,
} from "./types";

export const BED_ALLOCATION_SCREEN_READER_INSTRUCTIONS = {
  draggable:
    "To pick up a guest, press space or enter. Use the arrow keys to choose a destination bed, then press space or enter to drop. Existing allocations open move options where you choose one night or every existing allocation night for this person on the booking. Original lodge nights are always kept. Press escape to cancel without making a change.",
};

function formatNightList(stayDates: string[]) {
  return stayDates.length === 1
    ? `original lodge night ${stayDates[0]}`
    : `original lodge nights ${stayDates.join(", ")}`;
}

type DropFeedback =
  | { outcome: "request"; description: string }
  | { outcome: "review"; description: string }
  | { outcome: "noop"; description: string }
  | { outcome: "refused"; description: string };

function planBedAllocationDropFeedback(input: {
  activeData: DragData | undefined;
  overData: DropData | undefined;
  visibleAllocations: DashboardAllocation[];
  bucketGroups: BucketGuestGroup[];
  beds: BedOption[];
  singleNightMode: boolean;
}): DropFeedback | null {
  const {
    activeData,
    overData,
    visibleAllocations,
    bucketGroups,
    beds,
    singleNightMode,
  } = input;
  if (!activeData || !overData) return null;

  if (overData.type === "bucket") {
    if (activeData.type !== "allocation") return null;
    const allocation = visibleAllocations.find(
      (item) => item.id === activeData.allocationId,
    );
    return allocation
      ? {
          outcome: "request",
          // Bucket removal deletes only the dragged allocation id. Moving is a
          // separate preview/confirm flow whose scope is never inferred here.
          description: `Remove ${allocation.guestName} from ${formatNightList([
            allocation.stayDate,
          ])}`,
        }
      : null;
  }

  const bed = beds.find((item) => item.id === overData.bedId);
  if (!bed) return null;

  if (activeData.type === "bucket-guest") {
    const group = bucketGroups.find(
      (item) => item.bookingGuestId === activeData.bookingGuestId,
    );
    if (!group) return null;
    if (singleNightMode && !group.stayDates.includes(overData.stayDate)) {
      return {
        outcome: "refused",
        description: `No allocation will be made for ${group.guestName}: ${overData.stayDate} is not a booked lodge night`,
      };
    }
    return {
      outcome: "request",
      description: singleNightMode
        ? `${group.guestName} to ${bed.label} for booked lodge night ${overData.stayDate}`
        : `${group.guestName} to ${bed.label} for all booked lodge nights`,
    };
  }

  const allocation = visibleAllocations.find(
    (item) => item.id === activeData.allocationId,
  );
  if (!allocation) return null;
  return {
    outcome: "review",
    description: `Open move options for ${allocation.guestName} to ${bed.label}; choose the exact scope before confirming and keep every original lodge night`,
  };
}

export function describeBedAllocationDrop(
  input: Parameters<typeof planBedAllocationDropFeedback>[0],
): string | null {
  return planBedAllocationDropFeedback(input)?.description ?? null;
}

export function createBedAllocationAnnouncements(input: {
  visibleAllocations: DashboardAllocation[];
  bucketGroups: BucketGuestGroup[];
  beds: BedOption[];
  singleNightMode: boolean;
}): Announcements {
  const planFeedback = (
    activeData: DragData | undefined,
    overData?: DropData,
  ) =>
    planBedAllocationDropFeedback({
      ...input,
      activeData,
      overData,
    });

  return {
    onDragStart({ active }) {
      const activeData = active.data.current as DragData | undefined;
      if (activeData?.type === "allocation") {
        const allocation = input.visibleAllocations.find(
          (item) => item.id === activeData.allocationId,
        );
        return allocation
          ? `Picked up ${allocation.guestName}. Choose a destination bed; ${formatNightList(
              deriveActiveDragDates({
                activeDrag: activeData,
                visibleAllocations: input.visibleAllocations,
                bucketGroups: input.bucketGroups,
              }),
            )} will be kept.`
          : undefined;
      }
      const group = input.bucketGroups.find(
        (item) =>
          activeData?.type === "bucket-guest" &&
          item.bookingGuestId === activeData.bookingGuestId,
      );
      return group ? `Picked up ${group.guestName}.` : undefined;
    },
    onDragOver({ active, over }) {
      return (
        planFeedback(
          active.data.current as DragData | undefined,
          over?.data.current as DropData | undefined,
        )?.description ?? undefined
      );
    },
    onDragEnd({ active, over }) {
      const feedback = planFeedback(
        active.data.current as DragData | undefined,
        over?.data.current as DropData | undefined,
      );
      if (!feedback) {
        return "Drop refused. No allocation request was sent.";
      }
      if (feedback.outcome === "noop") {
        return `${feedback.description}. No request was sent.`;
      }
      if (feedback.outcome === "refused") {
        return `Drop refused. ${feedback.description}. No request was sent.`;
      }
      if (feedback.outcome === "review") {
        return `${feedback.description}. No move has been sent.`;
      }
      return `Requested ${feedback.description}. Saving; success or failure will be reported after the server responds.`;
    },
    onDragCancel({ active }) {
      const activeData = active.data.current as DragData | undefined;
      const allocation =
        activeData?.type === "allocation"
          ? input.visibleAllocations.find(
              (item) => item.id === activeData.allocationId,
            )
          : undefined;
      const group =
        activeData?.type === "bucket-guest"
          ? input.bucketGroups.find(
              (item) => item.bookingGuestId === activeData.bookingGuestId,
            )
          : undefined;
      return `Cancelled ${allocation?.guestName ?? group?.guestName ?? "guest"} drag. No allocation changed.`;
    },
  };
}
