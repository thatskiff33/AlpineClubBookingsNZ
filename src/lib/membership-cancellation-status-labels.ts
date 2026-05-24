// Member-facing labels for membership cancellation participant and request
// statuses. Admin views use their own copy with operator-oriented wording
// (e.g. "Ready for review" instead of "Included"); see
// src/app/(admin)/admin/membership-cancellations/page.tsx.

export function participantStatusLabel(status: string): string {
  switch (status) {
    case "PENDING_CONFIRMATION":
      return "Waiting for confirmation";
    case "REQUESTED":
      return "Included";
    case "DECLINED":
      return "Declined";
    case "APPROVED":
      return "Approved";
    case "REJECTED":
      return "Rejected";
    case "CANCELLED":
      return "Cancelled";
    case "REJOINED":
      return "Rejoined";
    default:
      return status.replaceAll("_", " ").toLowerCase();
  }
}

export function requestStatusLabel(status: string): string {
  switch (status) {
    case "REQUESTED":
      return "Submitted";
    case "APPROVED":
      return "Approved";
    case "REJECTED":
      return "Rejected";
    case "WITHDRAWN":
      return "Withdrawn";
    case "COMPLETED":
      return "Completed";
    default:
      return status.replaceAll("_", " ").toLowerCase();
  }
}
