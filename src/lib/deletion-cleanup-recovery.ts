// The partial-cleanup answer of `POST /api/admin/deletion-requests/[id]`,
// moved verbatim from that route to keep it under its size ceiling (#5145).

export function deletionCleanupRecovery(input: {
  cancelledBookings: number;
  cancellationPending: boolean;
  retryBookingId: string | null;
  cancellationStatusUnconfirmed?: boolean;
  cancellationPostProcessingUnconfirmed?: boolean;
  reviewBookingId?: string | null;
  blocker?: {
    code: string;
    message: string;
    remedy: string;
  };
}) {
  return {
    code: "DELETION_CLEANUP_PARTIAL",
    error:
      "Account deletion cleanup is incomplete. The member was not anonymised and no approval receipt was sent. Retry only the remaining cleanup.",
    cancelledBookings: input.cancelledBookings,
    cancellationPending: input.cancellationPending,
    retryBookingId: input.retryBookingId,
    ...(input.cancellationStatusUnconfirmed
      ? { cancellationStatusUnconfirmed: true }
      : {}),
    ...(input.cancellationPostProcessingUnconfirmed
      ? { cancellationPostProcessingUnconfirmed: true }
      : {}),
    ...(input.reviewBookingId
      ? { reviewBookingId: input.reviewBookingId }
      : {}),
    ...(input.blocker ? { blocker: input.blocker } : {}),
    remainingCleanupPending: true,
    memberAnonymised: false,
    memberDataAnonymised: false,
    approvalReceiptSent: false,
  };
}
