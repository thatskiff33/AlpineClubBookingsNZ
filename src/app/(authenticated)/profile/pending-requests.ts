import { prisma } from "@/lib/prisma";
import { systemClubClock, type BoundClubTime } from "@/lib/club-time";
import { OPEN_DELETION_REQUEST_STATUSES } from "@/lib/deletion-request-decision";
import type { PendingEmailChange } from "./change-email-form";
import type { PendingDeletionRequest } from "./delete-account-button";

/**
 * #4956: requests the member started that wait on someone else (an officer, or
 * the member clicking a link) stay on the profile, read from the server, until
 * they resolve. Both reads are the member's own rows: the profile only ever
 * renders the signed-in member, never a family or delegated view.
 *
 * Admins cannot self-delete, so their deletion read is skipped. "Open" is the
 * shared `OPEN_DELETION_REQUEST_STATUSES` list (INV-SSOT), "now" is the club
 * clock, and dates are formatted through the club-time kernel (INV-CONFIG-002).
 *
 * An email-change link is "live" here when `expiresAt` is after now. The confirm
 * route refuses it when `expiresAt` is before now, so the two differ only at the
 * exact expiry instant. The request route deletes older tokens, so the newest
 * live row is the link in the member's latest email.
 */
export async function loadProfilePendingRequests(args: {
  memberId: string;
  isAdmin: boolean;
  club: BoundClubTime;
}): Promise<{
  pendingDeletionRequest: PendingDeletionRequest | null;
  pendingEmailChange: PendingEmailChange | null;
}> {
  const { memberId, isAdmin, club } = args;
  const [openDeletionRequest, pendingEmailChangeToken] = await Promise.all([
    isAdmin
      ? null
      : prisma.deletionRequest.findFirst({
          where: { memberId, status: { in: OPEN_DELETION_REQUEST_STATUSES } },
          select: { createdAt: true },
          orderBy: { createdAt: "desc" },
        }),
    prisma.emailChangeToken.findFirst({
      where: { memberId, expiresAt: { gt: systemClubClock.nowInstant() } },
      select: { newEmail: true, expiresAt: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  return {
    pendingDeletionRequest: openDeletionRequest
      ? { requestedOn: club.instantDate(openDeletionRequest.createdAt) }
      : null,
    pendingEmailChange: pendingEmailChangeToken
      ? {
          newEmail: pendingEmailChangeToken.newEmail,
          expiresOn: club.instantDateTime(pendingEmailChangeToken.expiresAt),
        }
      : null,
  };
}
